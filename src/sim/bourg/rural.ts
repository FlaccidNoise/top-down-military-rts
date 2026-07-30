import type { GameMap } from '../map';
import type { Building, DoorEdge, Rect, Vec } from '../mapgen';
import type { Rng } from '../rng';
import type { Face, Footprints } from './footprints';
import type { Landmarks } from './landmarks';
import type { Parcels } from './parcels';
import { TAG, type Skeleton } from './streets';

// Stage 11 — rural fabric (T9). Two entry points, because half of this has to
// happen before the GameMap exists and half of it after:
//
//   addRuralFabric(sk, land, pc, fp)   pure. Outlying farm compounds (appended
//                                      to fp so T8 walls their yards), space-
//                                      colonisation farm lanes carved into
//                                      sk.road, and the bocage hedge MASK.
//   paintRural(map, ...)               terrain only: hedges from that mask,
//                                      woods stands, orchards, plowed fields.
//
// Splitting it there is what keeps the sub-stream plan honest. Everything that
// draws from tag 11 lives in addRuralFabric; paintRural draws from tags 12 and
// 13 only, so no new tag is needed and none is renumbered (§2.1).
//
// The town/country line everywhere below is R_env expanded by 6 — the same line
// T6 uses for the parcel zone, which is what §2.2 stage 11 means by replacing
// `nearVillage`. Inside it the town owns the ground; outside it, this module
// does, and the two never write the same tile.

export interface Rural {
  hedge: Uint8Array; // 1 = bocage boundary; applied to grass by paintRural
  lanes: number; // farm-track tiles carved into sk.road
  farms: Vec[]; // yard centre of each outlying compound
  gaps: number; // bocage parcel boundaries, one gate punched in each
  owner: Int32Array; // site index per tile (-1 = no owner); built by bocage, consumed by paintRural
  landUse: Uint8Array; // per-site: 0=pasture, 1=crop, 2=orchard
}

const LANE_D = 5; // space-colonisation step
const LANE_KILL = 7; // an attractor within this of a node is satisfied
const LANE_ATTRACT = 45; // …and one further than this influences nothing
const LANE_MAX_NODES = 140;

// Woods-stand outline (paintRural `stand`). STAND_EDGE is where the solid
// canopy stops and the dithered treeline starts, as a fraction of the local
// radius: at the old 0.55 the fuzzy band was 45 % of the stand and swallowed any
// shape put inside it, which is most of why every stand read as a soft circle.
// STAND_BASE then pays for the tighter band — a crisper edge paints MORE, and
// 0.838 is the value that holds the mean canopy at the 1.94·rad² per stand that
// WOODS was swept against (profile.ts): measured over seeds 1-40 at 320x240 the
// woods kind reads 58.10 % mean / 58.80 % median against 57.63 / 58.60 before,
// and open 1.16 % against 1.17 %. Neither constant is a taste value; move one
// and the kind's canopy fraction moves with it.
const STAND_BASE = 0.838;
const STAND_EDGE = 0.8;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ── the town/country line ────────────────────────────────────────────────────
// Exported because T11's elevation flat zone must be the SAME region: if the
// dome pass and the rural passes disagree about where town ends, a hill runs
// under the outermost gardens' walls, which is the seam §2.2 stage 13 exists to
// prevent.
export function zoneOf(sk: Skeleton): (x: number, y: number) => boolean {
  const x0 = sk.env.x - 6;
  const y0 = sk.env.y - 6;
  const x1 = sk.env.x + sk.env.w + 5;
  const y1 = sk.env.y + sk.env.h + 5;
  const f = sk.faubourg;
  return (x, y) =>
    (x >= x0 && x <= x1 && y >= y0 && y <= y1) || (f !== null && Math.abs(x - f.x) <= 22 && Math.abs(y - f.y) <= 22);
}

// ── M7: prune orphan road fragments ─────────────────────────────────────────
//
// 8-connected flood-fill from the arterial — any road tile not in the main
// connected component is deleted. Runs AFTER bocage (hedge may have severed
// lane tips) and BEFORE connectOrphanBuildings, so orphan buildings connect to
// a clean network.
function pruneOrphanPaths(
  sk: Skeleton,
  _fp: Footprints,
  _inZone: (x: number, y: number) => boolean,
): void {
  const { w, h } = sk;
  // seed: first arterial column where both roadY is valid AND road is set
  let seed = -1;
  for (let x = 0; x < w; x++) {
    const y = sk.roadY[x];
    if (y >= 0 && y < h && sk.road[y * w + x] === 1) {
      seed = y * w + x;
      break;
    }
  }
  if (seed < 0) return;

  const seen = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0;
  let toe = 0;
  seen[seed] = 1;
  q[toe++] = seed;
  while (head < toe) {
    const cur = q[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !sk.road[ni]) continue;
        seen[ni] = 1;
        q[toe++] = ni;
      }
  }
  for (let i = 0; i < w * h; i++) {
    if (sk.road[i] && !seen[i]) sk.road[i] = 0;
  }
}

// ── M4: clean orphan hedge stubs ────────────────────────────────────────────
//
// 8-connected components of fewer than K tiles are deleted UNLESS they touch a
// road, claimed parcel, building (or dilated-1), water, or the town zone.
// Content cleanup — zero draws.
function cleanHedgeStubs(
  sk: Skeleton,
  pc: Parcels,
  fp: Footprints,
  hedge: Uint8Array,
  inZone: (x: number, y: number) => boolean,
): void {
  const { w, h } = sk;
  const K = 4;

  // Chebyshev-1 dilation of fp.occ — a hedge tile within 1 of any building is
  // treated as touching a building.
  const nearBldg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!fp.occ[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) nearBldg[ny * w + nx] = 1;
      }
  }

  const visited = new Uint8Array(w * h);
  const q = new Int32Array(w * h);

  for (let i = 0; i < w * h; i++) {
    if (!hedge[i] || visited[i]) continue;

    let head = 0;
    let toe = 0;
    visited[i] = 1;
    q[toe++] = i;
    while (head < toe) {
      const cur = q[head++];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni] || !hedge[ni]) continue;
          visited[ni] = 1;
          q[toe++] = ni;
        }
    }

    if (toe >= K) continue;

    // small component — check if it touches any protected feature
    let touches = false;
    for (let j = 0; j < toe && !touches; j++) {
      const ci = q[j];
      const cx = ci % w;
      const cy = (ci / w) | 0;
      for (let dy = -1; dy <= 1 && !touches; dy++)
        for (let dx = -1; dx <= 1 && !touches; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (sk.road[ni] || pc.claimed[ni] || nearBldg[ni] || sk.water[ni] || inZone(nx, ny))
            touches = true;
        }
    }

    if (!touches) {
      for (let j = 0; j < toe; j++) hedge[q[j]] = 0;
    }
  }
}

// ── M3: connect orphan buildings to the road network ────────────────────────
//
// 4-connected flood-fill from all road tiles (avoiding water) builds a
// reachability mask. Every building with a door that is NOT in the mask gets a
// straight L-shaped path carved to the nearest reached tile. No random draws —
// larger-component-first heuristic (same as growFarmLanes).
function connectOrphanBuildings(
  sk: Skeleton,
  fp: Footprints,
  _r: Rng,
  inZone: (x: number, y: number) => boolean,
): void {
  const { w, h } = sk;

  // reachability mask: 4-connected from every road tile, avoiding water
  const reached = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0;
  let toe = 0;
  for (let i = 0; i < w * h; i++) {
    if (sk.road[i] && !sk.water[i]) {
      reached[i] = 1;
      q[toe++] = i;
    }
  }
  while (head < toe) {
    const cur = q[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (reached[ni] || sk.water[ni]) continue;
      reached[ni] = 1;
      q[toe++] = ni;
    }
  }

  for (const b of fp.buildings) {
    if (!b.doors || b.doors.length === 0) continue;
    const door = b.doors[0];
    const di = door.y * w + door.x;
    if (reached[di]) continue;

    // nearest reached tile by Chebyshev distance, ties on index
    let bestI = -1;
    let bestDist = Infinity;
    for (let i = 0; i < w * h; i++) {
      if (!reached[i]) continue;
      const d = Math.max(Math.abs((i % w) - door.x), Math.abs(((i / w) | 0) - door.y));
      if (d < bestDist) {
        bestDist = d;
        bestI = i;
      }
    }
    if (bestI < 0) continue;

    const tx = bestI % w;
    const ty = (bestI / w) | 0;

    const tryOrder = (hFirst: boolean): boolean => {
      const tiles: number[] = [];
      let px = door.x;
      let py = door.y;
      if (hFirst) {
        while (px !== tx) {
          px += Math.sign(tx - px);
          const ni = py * w + px;
          if (fp.occ[ni] || sk.water[ni] || inZone(px, py)) return false;
          tiles.push(ni);
        }
        while (py !== ty) {
          py += Math.sign(ty - py);
          const ni = py * w + px;
          if (fp.occ[ni] || sk.water[ni] || inZone(px, py)) return false;
          tiles.push(ni);
        }
      } else {
        while (py !== ty) {
          py += Math.sign(ty - py);
          const ni = py * w + px;
          if (fp.occ[ni] || sk.water[ni] || inZone(px, py)) return false;
          tiles.push(ni);
        }
        while (px !== tx) {
          px += Math.sign(tx - px);
          const ni = py * w + px;
          if (fp.occ[ni] || sk.water[ni] || inZone(px, py)) return false;
          tiles.push(ni);
        }
      }
      for (const i of tiles) sk.road[i] = 1;
      return true;
    };

    const hFirst = Math.abs(tx - door.x) >= Math.abs(ty - door.y);
    if (tryOrder(hFirst)) continue;
    tryOrder(!hFirst);
  }
}

export function addRuralFabric(sk: Skeleton, land: Landmarks, pc: Parcels, fp: Footprints): Rural {
  const { w, h } = sk;
  const r11 = sk.S(TAG.RURAL);
  const inZone = zoneOf(sk);

  const farms = placeFarms(sk, land, pc, fp, r11, inZone);
  const lanes = growFarmLanes(sk, fp, r11, inZone, farms);
  const { hedge, gaps, owner, sites } = bocage(sk, land, pc, fp, r11, inZone);

  pruneOrphanPaths(sk, fp, inZone);
  cleanHedgeStubs(sk, pc, fp, hedge, inZone);
  connectOrphanBuildings(sk, fp, r11, inZone);

  // R-F1: per-site land-use assignment in scan order
  const landUse = new Uint8Array(sites);
  {
    const [cropPct, orchPct] = sk.profile.fieldMix;
    const rLandUse = sk.S(TAG.ORCHARD);
    for (let i = 0; i < sites; i++) {
      const k = rLandUse.int(100);
      landUse[i] = k < cropPct ? 1 : k < cropPct + orchPct ? 2 : 0;
    }
  }
  return { hedge, lanes, farms, gaps, owner, landUse };
}

// ── outlying farm compounds ──────────────────────────────────────────────────
//
// The doc's stage-11 attractor list opens with "compound yard tiles", so the
// compounds have to exist before the lanes can grow to them. They are also
// where the bocage gets its scale: a hedgerow grid with nothing standing in it
// reads as wallpaper.
//
// Two masses round a yard rather than the three of an in-town cour: an isolated
// Norman farm IS a logis and a grange, and the third side is the field.
// Door edge on one face of a rect, mid-span.
const doorOn = (rect: Rect, side: Face, width: 1 | 2 = 1, skipStart = 0, skipEnd = 0): DoorEdge => {
  if (side === 'n') {
    const x = Math.max(rect.x, Math.min(rect.x + rect.w - width, rect.x + ((rect.w >> 1) + skipStart - skipEnd)));
    return { x, y: rect.y, side, width };
  }
  if (side === 's') {
    const x = Math.max(rect.x, Math.min(rect.x + rect.w - width, rect.x + ((rect.w >> 1) + skipStart - skipEnd)));
    return { x, y: rect.y + rect.h - 1, side, width };
  }
  if (side === 'e') {
    const y = Math.max(rect.y, Math.min(rect.y + rect.h - width, rect.y + ((rect.h >> 1) + skipStart - skipEnd)));
    return { x: rect.x + rect.w - 1, y, side, width };
  }
  const y = Math.max(rect.y, Math.min(rect.y + rect.h - width, rect.y + ((rect.h >> 1) + skipStart - skipEnd)));
  return { x: rect.x, y, side, width };
};

const bbox = (rects: Rect[]): { x0: number; y0: number; x1: number; y1: number } => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w - 1 > x1) x1 = r.x + r.w - 1;
    if (r.y + r.h - 1 > y1) y1 = r.y + r.h - 1;
  }
  return { x0, y0, x1, y1 };
};

function placeFarms(
  sk: Skeleton,
  land: Landmarks,
  pc: Parcels,
  fp: Footprints,
  r: Rng,
  inZone: (x: number, y: number) => boolean,
): Vec[] {
  const { w, h } = sk;
  const out: Vec[] = [];
  const want = sk.profile.farms[0] + r.int(sk.profile.farms[1]);
  const clearOf = (x0: number, y0: number, x1: number, y1: number): boolean => {
    if (x0 < 2 || y0 < 2 || x1 >= w - 2 || y1 >= h - 2) return false;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (sk.road[i] || land.resv[i] || pc.claimed[i] || fp.occ[i] || sk.water[i] || inZone(x, y)) return false;
      }
    return true;
  };
  for (let n = 0; n < want; n++) {
    for (let tries = 0; tries < 40; tries++) {
      // DRAW ORDER per attempt — every roll unconditional, fixed stream position
      const rot = r.int(4);                               // 1
      const fw = 11 + r.int(3);                           // 2
      const logisH = 4 + r.int(3);                        // 3  range 4-6
      const grangeH = 4 + r.int(4);                       // 4  range 4-7
      const yardH = 4 + r.int(5);                         // 5  range 4-8
      const compoundH = rot <= 1 ? logisH + yardH + grangeH : fw;
      const fx = 6 + r.int(Math.max(1, w - fw - 12));     // 6
      const fy = 6 + r.int(Math.max(1, h - compoundH - 12)); // 7
      const logisW = 6 + r.int(4);                        // 8  range 6-9
      const grangeW = 7 + r.int(6);                       // 9  range 7-12
      const L_WING_ROLL = r.next();                       // 10 p0.35
      const wingW = 3 + r.int(2);                         // 11
      const wingD = 3 + r.int(2);                         // 12
      const ETABLE_ROLL = r.next();                       // 13 p0.25
      const etW = 4 + r.int(2);                           // 14
      const etH = 3 + r.int(2);                           // 15

      // R-V1: four orientations
      const vertical = rot <= 1;
      let logis: Rect, grange: Rect, yard: Rect;
      let logisFrontage: Face, grangeFrontage: Face;
      if (rot === 0) {
        // N→S: logis top, yard middle, grange bottom
        logis = { x: fx, y: fy, w: logisW, h: logisH };
        yard = { x: fx, y: fy + logisH, w: fw, h: yardH };
        grange = { x: fx, y: fy + logisH + yardH, w: grangeW, h: grangeH };
        logisFrontage = 's';
        grangeFrontage = 'n';
      } else if (rot === 1) {
        // S→N: grange top, yard middle, logis bottom
        grange = { x: fx, y: fy, w: grangeW, h: grangeH };
        yard = { x: fx, y: fy + grangeH, w: fw, h: yardH };
        logis = { x: fx, y: fy + grangeH + yardH, w: logisW, h: logisH };
        logisFrontage = 'n';
        grangeFrontage = 's';
      } else if (rot === 2) {
        // E→W: logis left, yard middle, grange right
        logis = { x: fx, y: fy, w: logisH, h: logisW };
        yard = { x: fx + logisH, y: fy, w: yardH, h: fw };
        grange = { x: fx + logisH + yardH, y: fy, w: grangeH, h: grangeW };
        logisFrontage = 'e';
        grangeFrontage = 'w';
      } else {
        // rot === 3, W→E: grange left, yard middle, logis right
        grange = { x: fx, y: fy, w: grangeH, h: grangeW };
        yard = { x: fx + grangeH, y: fy, w: yardH, h: fw };
        logis = { x: fx + grangeH + yardH, y: fy, w: logisH, h: logisW };
        logisFrontage = 'w';
        grangeFrontage = 'e';
      }

      // R-V2: nearest arterial tile sets yard open face
      const ycx = yard.x + (yard.w >> 1);
      const ycy = yard.y + (yard.h >> 1);
      let yardOpen: Face = 'e';
      {
        let bestDist = Infinity;
        let bestAx = -1;
        let bestAy = -1;
        for (let ax = fx; ax < fx + fw; ax++) {
          const ay = sk.roadY[ax];
          const d = Math.max(Math.abs(ax - ycx), Math.abs(ay - ycy));
          if (d < bestDist) {
            bestDist = d;
            bestAx = ax;
            bestAy = ay;
          }
        }
        if (bestAx >= 0) {
          const dx = bestAx - ycx;
          const dy = bestAy - ycy;
          yardOpen = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
        }
      }

      // R-V3: L-shaped logis wing into yard
      const wingPresent = L_WING_ROLL < 0.35 && logisW >= wingW + 2 && wingD < yardH;
      const wingOnHigh = (fx & 1) !== 0;
      const logisParts: Rect[] = [logis];
      let wingRect: Rect | null = null;
      if (wingPresent) {
        wingRect = wingOnHigh
          ? (rot === 0
            ? { x: fx + logisW - wingW, y: fy + logisH, w: wingW, h: wingD }
            : rot === 1
            ? { x: fx + logisW - wingW, y: fy + grangeH + yardH - wingD, w: wingW, h: wingD }
            : rot === 2
            ? { x: fx + logisH, y: fy + logisW - wingW, w: wingD, h: wingW }
            : { x: fx + grangeH + yardH - wingD, y: fy + logisW - wingW, w: wingD, h: wingW })
          : (rot === 0
            ? { x: fx, y: fy + logisH, w: wingW, h: wingD }
            : rot === 1
            ? { x: fx, y: fy + grangeH + yardH - wingD, w: wingW, h: wingD }
            : rot === 2
            ? { x: fx + logisH, y: fy, w: wingD, h: wingW }
            : { x: fx + grangeH + yardH - wingD, y: fy, w: wingD, h: wingW });
        logisParts.push(wingRect);
      }

      // R-V4: 3-mass étable on the remaining yard face
      let etable: Rect | null = null;
      if (ETABLE_ROLL < 0.25) {
        const etCandidate: Rect =
          rot === 0 ? { x: fx, y: fy + logisH, w: etW, h: yardH }
          : rot === 1 ? { x: fx + fw - etW, y: fy + grangeH, w: etW, h: yardH }
          : rot === 2 ? { x: fx + logisH, y: fy, w: yardH, h: etW }
          : { x: fx + grangeH, y: fy + fw - etW, w: yardH, h: etW };
        // skip if wing and étable would overlap (same side or tight yard width)
        const overlaps = wingRect !== null &&
          wingRect.x < etCandidate.x + etCandidate.w && wingRect.x + wingRect.w > etCandidate.x &&
          wingRect.y < etCandidate.y + etCandidate.h && wingRect.y + wingRect.h > etCandidate.y;
        if (!overlaps) etable = etCandidate;
      }

      // clearOf on bounding rect of all masses
      const masses = [logis, yard, grange, ...logisParts.slice(1)];
      if (etable) masses.push(etable);
      const { x0, y0, x1, y1 } = bbox(masses);
      if (!clearOf(x0 - 2, y0 - 2, x1 + 2, y1 + 2)) continue;

      // R-H7 · compound slope gate: reject when height range over the
      // dilated rect exceeds 2 m. Reuses the same 40-try loop draws.
      let hMin = 255, hMax = 0;
      for (let hy = Math.max(0, y0 - 2); hy <= Math.min(h - 1, y1 + 2); hy++)
        for (let hx = Math.max(0, x0 - 2); hx <= Math.min(w - 1, x1 + 2); hx++) {
          const v = sk.height[hy * w + hx];
          if (v < hMin) hMin = v;
          if (v > hMax) hMax = v;
        }
      if (hMax - hMin > 2) continue;

      // door position on logis: yard-facing edge, centred in the non-wing portion
      const logisDoor: DoorEdge = (() => {
        if (vertical) {
          const avail0 = fx + (wingPresent && !wingOnHigh ? wingW : 0);
          const avail1 = fx + logisW - 1 - (wingPresent && wingOnHigh ? wingW : 0);
          const mx = avail0 + ((avail1 - avail0 + 1) >> 1);
          return logisFrontage === 's'
            ? { x: mx, y: logis.y + logis.h - 1, side: 's', width: 1 as const }
            : { x: mx, y: logis.y, side: 'n', width: 1 as const };
        }
        const avail0 = fy + (wingPresent && !wingOnHigh ? wingW : 0);
        const avail1 = fy + logis.h - 1 - (wingPresent && wingOnHigh ? wingW : 0);
        const my = avail0 + ((avail1 - avail0 + 1) >> 1);
        return logisFrontage === 'e'
          ? { x: logis.x + logis.w - 1, y: my, side: 'e', width: 1 as const }
          : { x: logis.x, y: my, side: 'w', width: 1 as const };
      })();

      emitRural(fp, sk, {
        ...logis,
        role: 'farmhouse',
        frontage: logisFrontage,
        parts: logisParts.length > 1 ? logisParts : undefined,
        doors: [logisDoor],
      });
      // grange door: offset away from étable if present to avoid shared corner
      const grangeDoor = etable
        ? (vertical
          ? (rot === 0
            ? doorOn(grange, grangeFrontage, 2, etW, 0)
            : doorOn(grange, grangeFrontage, 2, 0, etW))
          : (rot === 2
            ? doorOn(grange, grangeFrontage, 2, etW, 0)
            : doorOn(grange, grangeFrontage, 2, 0, etW)))
        : doorOn(grange, grangeFrontage, 2);
      emitRural(fp, sk, {
        ...grange,
        role: 'barn',
        frontage: grangeFrontage,
        doors: [grangeDoor],
      });
      if (etable) {
        const etFrontage: Face = rot === 0 ? 'e' : rot === 1 ? 'w' : rot === 2 ? 's' : 'n';
        const d = doorOn(etable, etFrontage, 1);
        const ox = d.side === 'e' ? d.x + 1 : d.side === 'w' ? d.x - 1 : d.x;
        const oy = d.side === 's' ? d.y + 1 : d.side === 'n' ? d.y - 1 : d.y;
        // door must not open onto another building (logis/grange may extend past yard edge)
        if (ox >= 0 && oy >= 0 && ox < w && oy < h && !fp.occ[oy * w + ox]) {
          emitRural(fp, sk, {
            ...etable,
            role: 'barn',
            frontage: etFrontage,
            doors: [d],
          });
        }
      }
      fp.compounds.push({ rect: yard, open: yardOpen, gateWidth: 2 });
      out.push({ x: ycx, y: ycy });
      break;
    }
  }
  return out;
}

// Same contract as T7's own emitter: claim the tiles in `occ` so nothing later
// can overlap, and fail loudly rather than let stampStructure discover it.
function emitRural(fp: Footprints, sk: Skeleton, b: Building): void {
  const rects = b.parts || [b];
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        if (fp.occ[y * sk.w + x]) throw new Error(`rural: ${b.role} overlaps an earlier mass at ${x},${y}`);
        fp.occ[y * sk.w + x] = 1;
      }
  }
  fp.buildings.push(b);
}

// ── farm lanes ───────────────────────────────────────────────────────────────
//
// Space colonisation, integer-only and rectilinear. Nodes are seeded on the
// arterial every 30 tiles; attractors are the farm yards plus a scattered set
// over open country. Each growth step rasterises as an L-shaped DOGLEG, larger
// component first — never a diagonal, because astar's no-corner-cutting rule
// (path.ts:107-114) makes a diagonal staircase impassable while los() sees
// straight through it (D10).
//
// Dendritic dead-ending is wrong for a bourg core and exactly right for farm
// tracks, which is why this algorithm is used HERE and the streets are grown by
// Parish & Müller instead.
function growFarmLanes(
  sk: Skeleton,
  fp: Footprints,
  r: Rng,
  inZone: (x: number, y: number) => boolean,
  farms: Vec[],
): number {
  const { w, h } = sk;
  const nodes: Vec[] = [];
  for (let x = 15; x < w - 15; x += 30) if (!inZone(x, sk.roadY[x])) nodes.push({ x, y: sk.roadY[x] });
  if (nodes.length === 0) return 0;

  const attractors: Vec[] = farms.map((f) => ({ x: f.x, y: f.y }));
  for (let i = 0, n = Math.max(6, ((w * h) / 2200) | 0); i < n; i++) {
    const ax = 6 + r.int(w - 12);
    const ay = 6 + r.int(h - 12);
    if (!inZone(ax, ay) && !sk.water[ay * w + ax]) attractors.push({ x: ax, y: ay });
  }
  const alive = new Uint8Array(attractors.length).fill(1);
  // A cart track stops at the bank: carved into sk.road, it would become a
  // second bridge deck at the stamp and break the arterial's monopoly on the
  // crossing (§2.5). The attractor filter above is the same rule said early —
  // a point in the river can never be reached, so it would pull a node into
  // the bank for the whole growth budget. Both draws happen either way, so
  // neither test moves the stream on a dry kind.
  const free = (x: number, y: number): boolean =>
    x >= 2 && y >= 2 && x < w - 2 && y < h - 2 && !inZone(x, y) && !fp.occ[y * w + x] && !sk.water[y * w + x];

  let carved = 0;
  const carve = (a: Vec, b: Vec): boolean => {
    // larger component first: the track leaves the road on its long axis and
    // turns once, which is what a cart track looks like from above
    const makePath = (hFirst: boolean): Vec[] => {
      const path: Vec[] = [];
      let px = a.x;
      let py = a.y;
      if (hFirst) {
        while (px !== b.x) { px += Math.sign(b.x - px); path.push({ x: px, y: py }); }
        while (py !== b.y) { py += Math.sign(b.y - py); path.push({ x: px, y: py }); }
      } else {
        while (py !== b.y) { py += Math.sign(b.y - py); path.push({ x: px, y: py }); }
        while (px !== b.x) { px += Math.sign(b.x - px); path.push({ x: px, y: py }); }
      }
      return path;
    };

    // R-H7 · slope gate: reject a dogleg whose total ascent exceeds 8 m.
    // Try the other component order first — both orders are pure functions
    // of the endpoints (zero extra draws).
    const horizontalFirst = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const tryOrder = (hFirst: boolean): boolean => {
      const path = makePath(hFirst);
      let ascent = 0;
      let prevH = sk.height[a.y * w + a.x];
      for (const p of path) {
        const h = sk.height[p.y * w + p.x];
        if (h > prevH) ascent += h - prevH;
        prevH = h;
      }
      if (ascent > 8) return false;
      for (const p of path) if (!free(p.x, p.y)) return false;
      for (const p of path) {
        if (!sk.road[p.y * w + p.x]) carved++;
        sk.road[p.y * w + p.x] = 1;
      }
      return true;
    };
    if (tryOrder(horizontalFirst)) return true;
    if (tryOrder(!horizontalFirst)) return true;
    return false;
  };

  for (let iter = 0; iter < 80 && nodes.length < LANE_MAX_NODES; iter++) {
    // influence: every live attractor pulls on its nearest node, ties on index
    const sumX = new Int32Array(nodes.length);
    const sumY = new Int32Array(nodes.length);
    const pull = new Int32Array(nodes.length);
    let live = 0;
    for (let ai = 0; ai < attractors.length; ai++) {
      if (!alive[ai]) continue;
      live++;
      const a = attractors[ai];
      let best = -1;
      let bestD2 = LANE_ATTRACT * LANE_ATTRACT + 1;
      for (let ni = 0; ni < nodes.length; ni++) {
        const dx = a.x - nodes[ni].x;
        const dy = a.y - nodes[ni].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = ni;
        }
      }
      if (best < 0) continue;
      sumX[best] += a.x - nodes[best].x;
      sumY[best] += a.y - nodes[best].y;
      pull[best]++;
    }
    if (live === 0) break;

    let grew = false;
    const upTo = nodes.length;
    for (let ni = 0; ni < upTo && nodes.length < LANE_MAX_NODES; ni++) {
      if (pull[ni] === 0) continue;
      const ax = Math.abs(sumX[ni]);
      const ay = Math.abs(sumY[ni]);
      const tot = ax + ay;
      if (tot === 0) continue;
      // integer round-half-up of D * component / total: no float comparator
      // anywhere in the growth loop
      const dx = ax === 0 ? 0 : Math.sign(sumX[ni]) * Math.max(1, ((LANE_D * ax * 2 + tot) / (2 * tot)) | 0);
      const dy = ay === 0 ? 0 : Math.sign(sumY[ni]) * Math.max(1, ((LANE_D * ay * 2 + tot) / (2 * tot)) | 0);
      const child: Vec = { x: clamp(nodes[ni].x + dx, 2, w - 3), y: clamp(nodes[ni].y + dy, 2, h - 3) };
      if (child.x === nodes[ni].x && child.y === nodes[ni].y) continue;
      if (!carve(nodes[ni], child)) continue;
      nodes.push(child);
      grew = true;
    }
    if (!grew) break;

    for (let ai = 0; ai < attractors.length; ai++) {
      if (!alive[ai]) continue;
      for (const n of nodes) {
        const dx = attractors[ai].x - n.x;
        const dy = attractors[ai].y - n.y;
        if (dx * dx + dy * dy <= LANE_KILL * LANE_KILL) {
          alive[ai] = 0;
          break;
        }
      }
    }
  }
  return carved;
}

// ── bocage ───────────────────────────────────────────────────────────────────
//
// Jittered-grid Voronoi, replacing mapgen.ts:195-214's parallel drifting lines.
// One site per cell of KindProfile.bocageCell (22 for the bourg); each fringe
// tile takes the nearest site among the 9 neighbouring cells by SQUARED INTEGER
// distance with an index tiebreak; a tile is hedge if any 4-neighbour belongs to
// a different site. One O(9N) integer pass — no Delaunay, no float predicates,
// no cocircular degeneracy.
function bocage(
  sk: Skeleton,
  land: Landmarks,
  pc: Parcels,
  fp: Footprints,
  r: Rng,
  inZone: (x: number, y: number) => boolean,
): { hedge: Uint8Array; gaps: number; owner: Int32Array; sites: number } {
  const { w, h } = sk;
  const cell = sk.profile.bocageCell;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const sx = new Int32Array(cols * rows);
  const sy = new Int32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      sx[cy * cols + cx] = Math.min(w - 1, cx * cell + 3 + r.int(cell - 12));
      sy[cy * cols + cx] = Math.min(h - 1, cy * cell + 3 + r.int(cell - 12));
    }

  const owner = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Water owns no parcel, which does two things at once: no hedge is ever
      // proposed on the river, and the two banks stop belonging to the same
      // site — so the bocage grid ends at the water instead of ignoring it.
      if (inZone(x, y) || sk.water[y * w + x]) continue;
      const cx = (x / cell) | 0;
      const cy = (y / cell) | 0;
      let best = -1;
      let bestD2 = Infinity;
      for (let jy = cy - 1; jy <= cy + 1; jy++)
        for (let jx = cx - 1; jx <= cx + 1; jx++) {
          if (jx < 0 || jy < 0 || jx >= cols || jy >= rows) continue;
          const s = jy * cols + jx;
          const dx = x - sx[s];
          const dy = y - sy[s];
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && s < best)) {
            bestD2 = d2;
            best = s;
          }
        }
      owner[y * w + x] = best;
    }

  const hedge = new Uint8Array(w * h);
  // pair key → the boundary tiles between those two parcels, in scan order
  const pairs = new Map<number, number[]>();
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const me = owner[i];
      if (me < 0) continue;
      if (sk.road[i] || land.resv[i] || pc.claimed[i] || fp.occ[i]) continue;
      let other = -1;
      // R-G1: single-wide — only east and south edges carry the hedge
      for (const n of [i + 1, i + w]) {
        if (n < owner.length && owner[n] >= 0 && owner[n] !== me) {
          other = owner[n];
          break;
        }
      }
      if (other < 0) continue;
      hedge[i] = 1;
      const key = me < other ? me * 100000 + other : other * 100000 + me;
      let list = pairs.get(key);
      if (!list) {
        list = [];
        pairs.set(key, list);
      }
      list.push(i);
    }

  // one gate per shared edge: 2-3 consecutive boundary tiles removed at a
  // jittered position. Keys are iterated in insertion order, which is scan
  // order over the map — deterministic without a sort.
  for (const list of pairs.values()) {
    if (list.length < 6) continue;
    const at = list[2 + r.int(Math.max(1, list.length - 4))];
    const ax = at % w;
    const ay = (at / w) | 0;
    for (const i of list) {
      const dx = Math.abs((i % w) - ax);
      const dy = Math.abs(((i / w) | 0) - ay);
      if (Math.max(dx, dy) <= 1) hedge[i] = 0;
    }
  }
  const sites = cols * rows;
  return { hedge, gaps: pairs.size, owner, sites };
}

// ── terrain painting ─────────────────────────────────────────────────────────
//
// Runs on the fresh GameMap BEFORE roads are painted and before the buildings
// are stamped, mirroring mapgen's own order: each pass writes only over 'grass'
// so the earlier passes win, roads overwrite everything, and stampStructure
// overwrites again with 'floor'.
export function paintRural(
  map: GameMap,
  sk: Skeleton,
  land: Landmarks,
  pc: Parcels,
  fp: Footprints,
  rural: Rural,
): Vec[] {
  const { w, h } = sk;
  const inZone = zoneOf(sk);
  // dilate the footprints by one so nothing grows against a door
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (fp.occ[y * w + x])
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] = 1;
          }
  const tiles = map.tiles;
  const plantable = (x: number, y: number): boolean => {
    const i = y * w + x;
    return !sk.road[i] && !land.resv[i] && !pc.claimed[i] && !near[i] && tiles[i] === 0; // grass=0
  };

  // Hedge stamp: direct tiles[] write (hedge=4) avoids setTerrain + modulo/division.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (rural.hedge[i] && !sk.road[i] && !land.resv[i] && !pc.claimed[i] && !near[i] && tiles[i] === 0)
        tiles[i] = 4;
    }
  }

  // woods stands (tag 13); the first, east of the place, is objectives[1]
  const r13 = sk.S(TAG.WOODS);
  const woodsStands: Vec[] = [];
  const stand = (cx0: number, cy0: number, rad: number): void => {
    // The stand's outline: STAND_BASE plus two low-order harmonics of the polar
    // angle, so a stand lobes instead of being a disc. The four coefficients are
    // drawn ONCE, before the tile loop — a per-tile draw is isotropic and
    // averages straight back to the circle this used to be — and each pair is an
    // amplitude AND a phase, which is what lets the harmonics be built from
    // de Moivre polynomials in the unit vector. That matters: Math.atan2 and
    // Math.cos are not correctly-rounded across engines, and this pipeline is
    // byte-deterministic (mapgen.ts). Only +-*/ and Math.sqrt are used, and all
    // four are exact per IEEE-754.
    const a2 = (r13.next() - 0.5) * 0.68;
    const b2 = (r13.next() - 0.5) * 0.68;
    const a3 = (r13.next() - 0.5) * 0.48;
    const b3 = (r13.next() - 0.5) * 0.48;
    // |a·cos kθ + b·sin kθ| ≤ √(a²+b²), so this is the outline's true reach and
    // the loop box is sized to it. Sizing the box to `rad` instead would clip
    // every lobe flat against the same square, which is a worse artefact than
    // the circle.
    const reach = Math.ceil(rad * (STAND_BASE + Math.sqrt(a2 * a2 + b2 * b2) + Math.sqrt(a3 * a3 + b3 * b3)));
    for (let y = Math.max(1, cy0 - reach); y <= Math.min(h - 2, cy0 + reach); y++)
      for (let x = Math.max(1, cx0 - reach); x <= Math.min(w - 2, cx0 + reach); x++) {
        const dx = x - cx0;
        const dy = y - cy0;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach * reach) continue; // corners of the box: rejected before any draw
        const d = Math.sqrt(d2) || 1; // centre tile: (u,v) = (0,0), radius = the base
        const u = dx / d;
        const v = dy / d;
        const c2 = u * u - v * v; // cos 2θ
        const s2 = 2 * u * v; // sin 2θ
        // …and (u·c2 − v·s2, v·c2 + u·s2) is (cos 3θ, sin 3θ).
        const f = STAND_BASE + a2 * c2 + b2 * s2 + a3 * (u * c2 - v * s2) + b3 * (v * c2 + u * s2);
        const rr = rad * f * (STAND_EDGE + r13.next() * (1 - STAND_EDGE));
        if (d2 < rr * rr && !inZone(x, y) && plantable(x, y)) tiles[y * w + x] = 2;
      }
  };
  // objectives[1] and a red squad's spawn ride on this anchor (scenario.ts:48,
  // 52), so it is nudged off anything a squad cannot stand on before the stand
  // is painted around it — a road tile is standable but gets no trees, and a
  // footprint tile becomes 'floor' the moment the buildings are stamped.
  const east = nudgeClear(sk, fp, {
    x: clamp(sk.place.x + 38 + r13.int(20), 20, w - 14),
    y: clamp(sk.place.y - 18 + r13.int(37), 12, h - 12),
  });
  stand(east.x, east.y, 9 + r13.int(4));
  woodsStands.push(east);
  const { stands, standRadius } = sk.profile;
  for (let i = 0, n = stands[0] + r13.int(stands[1]) + Math.max(0, Math.round((w * h) / 19200) - 1); i < n; i++) {
    const px = 10 + r13.int(w - 20);
    const py = 8 + r13.int(h - 16);
    if (inZone(px, py)) continue;
    stand(px, py, standRadius[0] + r13.int(standRadius[1]));
    // a stand centred on something impassable is no anchor: downstream
    // consumers order squads to it and an unreachable post is never settled
    if (map.terrainAt(px, py).passable) woodsStands.push({ x: px, y: py });
  }

  // orchards and plowed fields (tag 12), on whatever ground the town left over
  const r12 = sk.S(TAG.ORCHARD);
  for (let i = 0, n = 2 + r12.int(3); i < n; i++) {
    const ow = 8 + r12.int(7);
    const oh = 6 + r12.int(5);
    const ox = clamp(sk.place.x - 40 + r12.int(80), 2, w - ow - 2);
    const oy = clamp(sk.place.y - 34 + r12.int(68), 2, h - oh - 2);
    for (let y = oy; y < oy + oh; y += 2)
      for (let x = ox + (((y - oy) >> 1) % 2); x < ox + ow; x += 2) if (plantable(x, y)) tiles[y * w + x] = 2;
  }
  // R-F2: fields painted from the bocage owner map (every tile inside a crop-assigned parcel).
  // Direct tiles[] write (field=5) avoids setTerrain + modulo/division.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const ownerIdx = rural.owner[i];
      if (ownerIdx < 0) continue;
      if (rural.landUse[ownerIdx] !== 1) continue; // 1 = crop
      // inZone: env ± 6/5 margin + faubourg radius.
      if (
        (x >= sk.env.x - 6 && x <= sk.env.x + sk.env.w + 5 && y >= sk.env.y - 6 && y <= sk.env.y + sk.env.h + 5) ||
        (sk.faubourg !== null && Math.abs(x - sk.faubourg.x) <= 22 && Math.abs(y - sk.faubourg.y) <= 22)
      ) continue;
      if (!sk.road[i] && !land.resv[i] && !pc.claimed[i] && !near[i] && tiles[i] === 0) // plantable + grass=0 check
        tiles[i] = 5;
    }
  }

  // A clearing centre is an anchor like a stand centre is (§2.4), so it joins
  // the same list — appended, never prepended: woodsStands[0] is objectives[1]
  // and a red squad's spawn (scenario.ts), and that stays the east stand.
  woodsStands.push(...carveClearings(map, sk, fp, inZone));
  return woodsStands;
}

// ── clearings ────────────────────────────────────────────────────────────────
//
// §2.4's woods sub-stage (tag 16). Ellipses of open ground carved back OUT of
// the painted stands, which is the only order that works: a clearing reserved
// before the stands would just be planted over, and the stands are what makes
// the kind, so they take the whole map first and this gives some of it back.
//
// It runs LAST in paintRural for the same reason one step down — the orchard
// pass paints 'woods' in rows and the field pass paints over leftover grass, so
// a clearing opened before them comes back with trees standing in it.
//
// The carve only ever converts a 'woods' tile, so there is nothing it can take
// from another stage: roads are not painted until stampBourg, footprints were
// never plantable, and a hedge is a different key. It can open ground up and
// never close it — which is also why validate's vehicle gate cannot be broken
// here, only helped ('woods' is noVehicle, grass is not).
//
// DEVIATION from §2.4, which says "ellipses of grass/field". Grass only. The
// clearing IS the kill zone the kind is built around, and 'field' carries
// cover 0.05 against grass's 0 (data.ts) — a coin flip between them would make
// the tactical claim true of some clearings and not others for no gain.
function carveClearings(
  map: GameMap,
  sk: Skeleton,
  fp: Footprints,
  inZone: (x: number, y: number) => boolean,
): Vec[] {
  const { w, h } = sk;
  const tiles = map.tiles;
  const [count, countSpan] = sk.profile.clearings;
  if (count + countSpan === 0) return [];
  const r16 = sk.S(TAG.CLEARING);
  const n = count + r16.int(countSpan);
  const out: Vec[] = [];
  if (n === 0) return out;

  // How much canopy a candidate centre would actually open: the wood inside the
  // box a minimum clearing covers. Both placements below maximise it, which is
  // what makes the sub-stage do anything at all — two fifths of a woods map is
  // already open ground (measured: canopy 0.58 of a 320x240 map), so a
  // uniformly-placed clearing lands on a stretch that needed no clearing about
  // half the time, and a clearing you cannot tell from the country round it is
  // not a clearing.
  //
  // It is also self-avoiding for free: carving one drops the canopy score there
  // to zero, so the next pick walks away from it without a spacing rule.
  const canopy = (cx: number, cy: number): number => {
    let trees = 0;
    for (let y = Math.max(0, cy - 6); y <= Math.min(h - 1, cy + 6); y++)
      for (let x = Math.max(0, cx - 6); x <= Math.min(w - 1, cx + 6); x++)
        if (map.terrainKeyAt(x, y) === 'woods') trees++;
    return trees;
  };
  // Radii 6-9 by 6-8, so every clearing is 12-19 tiles across on BOTH axes:
  // §2.4's floor exactly, and about a rifle section's frontage. Deliberately no
  // wider — at 24 across a clearing stops reading as a hole in a wood and
  // starts reading as a field with trees round it, and the wood at the far
  // treeline is what makes it a kill zone rather than an approach.
  const carve = (cx: number, cy: number): void => {
    const rx = 6 + r16.int(4);
    const ry = 6 + r16.int(3);
    for (let y = Math.max(1, cy - ry); y <= Math.min(h - 2, cy + ry); y++)
      for (let x = Math.max(1, cx - rx); x <= Math.min(w - 2, cx + rx); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx * ry * ry + dy * dy * rx * rx > rx * rx * ry * ry) continue;
        if (tiles[y * w + x] === 2) tiles[y * w + x] = 0; // woods=2 → grass=0
      }
    // Same rule the stands keep: an anchor nothing can stand on is no anchor.
    // The carve leaves grass behind, so this only rejects a centre that was
    // never woods to begin with — a hedge line, say.
    if (map.terrainAt(cx, cy).passable) out.push({ x: cx, y: cy });
  };
  // Draws its full quota whatever it rejects, so the stream position does not
  // depend on how the map came out — the same discipline the landmark rolls
  // keep.
  const pick = (tries: number, at: () => Vec | null): Vec | null => {
    let best: Vec | null = null;
    let bestScore = -1;
    for (let t = 0; t < tries; t++) {
      const v = at();
      if (!v) continue;
      const s = canopy(v.x, v.y);
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    }
    return best;
  };

  // The guaranteed one, astride the arterial. This is the rule that makes the
  // sub-stage tactical rather than decorative: the arterial is the only vehicle
  // route across a woods map (every stand is noVehicle), so a route that never
  // opens out is 320 tiles of blind lane with no ground to fight over. One
  // clearing on it is the kill zone the attack has to cross.
  //
  // SCANNED, not sampled, and the only placement here that is: the whole point
  // is a guarantee, and sampling twelve columns for the woodiest left 7 seeds
  // in 200 with a clearing that had no wood round it to be a clearing IN. The
  // scan is a per-column canopy count within 6 tiles of the road plus a 13-wide
  // sliding sum, so it costs one pass over a thirteenth of the map, not a box
  // read per candidate. Ties take the westmost column — a scan order, not a
  // rule; the variety is in where the wood is.
  const colWood = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let trees = 0;
    for (let y = Math.max(0, sk.roadY[x] - 6), y1 = Math.min(h - 1, sk.roadY[x] + 6); y <= y1; y++)
      if (map.terrainKeyAt(x, y) === 'woods') trees++;
    colWood[x] = trees;
  }
  let ax = -1;
  let axScore = -1;
  for (let x = 18; x < w - 18; x++) {
    if (inZone(x, sk.roadY[x])) continue;
    let s = 0;
    for (let k = x - 6; k <= x + 6; k++) s += colWood[k];
    if (s > axScore) {
      axScore = s;
      ax = x;
    }
  }
  if (ax >= 0) carve(ax, sk.roadY[ax]);

  for (let i = 1; i < n; i++) {
    const v = pick(16, () => {
      // 16 in from every edge: the largest ellipse is 9 by 8, and a clearing
      // the map border has bitten a piece out of is not a clearing — it is the
      // edge of the map, which is off-limits ground anyway
      const x = 16 + r16.int(Math.max(1, w - 32));
      const y = 16 + r16.int(Math.max(1, h - 32));
      return inZone(x, y) || fp.occ[y * w + x] ? null : { x, y };
    });
    if (v) carve(v.x, v.y);
  }
  return out;
}

// Walk Chebyshev rings out to 8 for a tile clear of every footprint and every
// road, in a fixed scan order. Returns the original point when nothing near it
// qualifies — the caller's own passability check is the backstop.
function nudgeClear(sk: Skeleton, fp: Footprints, v: Vec): Vec {
  const { w, h } = sk;
  for (let r = 0; r <= 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = v.x + dx;
        const y = v.y + dy;
        if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
        const i = y * w + x;
        if (!fp.occ[i] && !sk.road[i]) return { x, y };
      }
  return v;
}
