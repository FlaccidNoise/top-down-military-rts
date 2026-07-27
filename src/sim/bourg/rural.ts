import type { GameMap } from '../map';
import type { Building, Rect, Vec } from '../mapgen';
import type { Rng } from '../rng';
import type { Footprints } from './footprints';
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
}

const LANE_D = 5; // space-colonisation step
const LANE_KILL = 7; // an attractor within this of a node is satisfied
const LANE_ATTRACT = 45; // …and one further than this influences nothing
const LANE_MAX_NODES = 140;
const CELL = 22; // bocage jittered-grid cell

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

export function addRuralFabric(sk: Skeleton, land: Landmarks, pc: Parcels, fp: Footprints): Rural {
  const { w, h } = sk;
  const r11 = sk.S(TAG.RURAL);
  const inZone = zoneOf(sk);

  const farms = placeFarms(sk, land, pc, fp, r11, inZone);
  const lanes = growFarmLanes(sk, fp, r11, inZone, farms);
  const { hedge, gaps } = bocage(sk, land, pc, fp, r11, inZone);
  return { hedge, lanes, farms, gaps };
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
  const want = 2 + r.int(2);
  const clearOf = (x0: number, y0: number, x1: number, y1: number): boolean => {
    if (x0 < 2 || y0 < 2 || x1 >= w - 2 || y1 >= h - 2) return false;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (sk.road[i] || land.resv[i] || pc.claimed[i] || fp.occ[i] || inZone(x, y)) return false;
      }
    return true;
  };
  for (let n = 0; n < want; n++) {
    for (let tries = 0; tries < 40; tries++) {
      const fw = 11 + r.int(3);
      const logisH = 5 + r.int(2);
      const grangeH = 5 + r.int(2);
      const yardH = 5 + r.int(3);
      const fh = logisH + yardH + grangeH;
      const fx = 6 + r.int(Math.max(1, w - fw - 12));
      const fy = 6 + r.int(Math.max(1, h - fh - 12));
      if (!clearOf(fx - 2, fy - 2, fx + fw + 1, fy + fh + 1)) continue;
      const logis: Rect = { x: fx, y: fy, w: 7 + r.int(2), h: logisH };
      const grange: Rect = { x: fx, y: fy + logisH + yardH, w: 8 + r.int(4), h: grangeH };
      const yard: Rect = { x: fx, y: fy + logisH, w: fw, h: yardH };
      emitRural(fp, sk, { ...logis, role: 'farmhouse', frontage: 's', doors: [{ x: logis.x + (logis.w >> 1), y: logis.y + logis.h - 1, side: 's', width: 1 }] });
      emitRural(fp, sk, {
        ...grange,
        role: 'barn',
        frontage: 'n',
        doors: [{ x: grange.x + (grange.w >> 1), y: grange.y, side: 'n', width: 2 }],
      });
      fp.compounds.push({ rect: yard, open: 'e', gateWidth: 2 });
      out.push({ x: yard.x + (yard.w >> 1), y: yard.y + (yard.h >> 1) });
      break;
    }
  }
  return out;
}

// Same contract as T7's own emitter: claim the tiles in `occ` so nothing later
// can overlap, and fail loudly rather than let stampStructure discover it.
function emitRural(fp: Footprints, sk: Skeleton, b: Building): void {
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (fp.occ[y * sk.w + x]) throw new Error(`rural: ${b.role} overlaps an earlier mass at ${x},${y}`);
      fp.occ[y * sk.w + x] = 1;
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
    if (!inZone(ax, ay)) attractors.push({ x: ax, y: ay });
  }
  const alive = new Uint8Array(attractors.length).fill(1);
  const free = (x: number, y: number): boolean =>
    x >= 2 && y >= 2 && x < w - 2 && y < h - 2 && !inZone(x, y) && !fp.occ[y * w + x];

  let carved = 0;
  const carve = (a: Vec, b: Vec): boolean => {
    // larger component first: the track leaves the road on its long axis and
    // turns once, which is what a cart track looks like from above
    const horizontalFirst = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const path: Vec[] = [];
    let x = a.x;
    let y = a.y;
    const stepTo = (tx: number, ty: number): void => {
      while (x !== tx || y !== ty) {
        x += Math.sign(tx - x);
        y += Math.sign(ty - y);
        path.push({ x, y });
      }
    };
    if (horizontalFirst) {
      stepTo(b.x, y);
      stepTo(b.x, b.y);
    } else {
      stepTo(x, b.y);
      stepTo(b.x, b.y);
    }
    for (const p of path) if (!free(p.x, p.y)) return false;
    for (const p of path) {
      if (!sk.road[p.y * w + p.x]) carved++;
      sk.road[p.y * w + p.x] = 1;
    }
    return true;
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
// One site per 22x22 cell; each fringe tile takes the nearest site among the 9
// neighbouring cells by SQUARED INTEGER distance with an index tiebreak; a tile
// is hedge if any 4-neighbour belongs to a different site. One O(9N) integer
// pass — no Delaunay, no float predicates, no cocircular degeneracy.
function bocage(
  sk: Skeleton,
  land: Landmarks,
  pc: Parcels,
  fp: Footprints,
  r: Rng,
  inZone: (x: number, y: number) => boolean,
): { hedge: Uint8Array; gaps: number } {
  const { w, h } = sk;
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const sx = new Int32Array(cols * rows);
  const sy = new Int32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      sx[cy * cols + cx] = Math.min(w - 1, cx * CELL + 3 + r.int(16));
      sy[cy * cols + cx] = Math.min(h - 1, cy * CELL + 3 + r.int(16));
    }

  const owner = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (inZone(x, y)) continue;
      const cx = (x / CELL) | 0;
      const cy = (y / CELL) | 0;
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
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (owner[n] >= 0 && owner[n] !== me) {
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
  return { hedge, gaps: pairs.size };
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
  const plantable = (x: number, y: number): boolean => {
    const i = y * w + x;
    return !sk.road[i] && !land.resv[i] && !pc.claimed[i] && !near[i] && map.terrainKeyAt(x, y) === 'grass';
  };

  for (let i = 0; i < rural.hedge.length; i++)
    if (rural.hedge[i] && plantable(i % w, (i / w) | 0)) map.setTerrain(i % w, (i / w) | 0, 'hedge');

  // woods stands (tag 13); the first, east of the place, is objectives[1]
  const r13 = sk.S(TAG.WOODS);
  const woodsStands: Vec[] = [];
  const stand = (cx0: number, cy0: number, rad: number): void => {
    for (let y = Math.max(1, cy0 - rad); y <= Math.min(h - 2, cy0 + rad); y++)
      for (let x = Math.max(1, cx0 - rad); x <= Math.min(w - 2, cx0 + rad); x++) {
        const d2 = (x - cx0) * (x - cx0) + (y - cy0) * (y - cy0);
        const rr = rad * (0.55 + r13.next() * 0.45);
        if (d2 < rr * rr && !inZone(x, y) && plantable(x, y)) map.setTerrain(x, y, 'woods');
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
  for (let i = 0, n = 2 + r13.int(3) + Math.max(0, Math.round((w * h) / 19200) - 1); i < n; i++) {
    const px = 10 + r13.int(w - 20);
    const py = 8 + r13.int(h - 16);
    if (inZone(px, py)) continue;
    stand(px, py, 6 + r13.int(5));
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
      for (let x = ox + (((y - oy) >> 1) % 2); x < ox + ow; x += 2) if (plantable(x, y)) map.setTerrain(x, y, 'woods');
  }
  for (let i = 0, n = 4 + r12.int(4); i < n; i++) {
    const fw = 12 + r12.int(14);
    const fh = 8 + r12.int(10);
    const fx = 2 + r12.int(Math.max(1, w - fw - 4));
    const fy = 2 + r12.int(Math.max(1, h - fh - 4));
    for (let y = fy; y < fy + fh; y++)
      for (let x = fx; x < fx + fw; x++) if (plantable(x, y)) map.setTerrain(x, y, 'field');
  }

  return woodsStands;
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
