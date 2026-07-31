import type { Building, BuildingRole, DoorEdge, Rect, Vec } from '../mapgen';
import type { Rng } from '../rng';
import { RESV, type Landmarks } from './landmarks';
import type { Interior, Parcels, Plot } from './parcels';
import { DENS_CORE, DENS_FRINGE, TAG, type Skeleton } from './streets';

// Stage 9 — footprint synthesis (docs/plans/2026-07-26-town-gen-design.md, T7).
//
// Pure geometry: reads T6's parcels and T5's landmarks, writes no GameMap. The
// output is a Building[] in stamp order plus the parcel work T8 needs to build
// the enclosure network — the tail behind each house, the venelle beside it,
// and the walled yards.
//
// The no-overlap invariant is STRUCTURAL, not checked-and-hoped: every mass is
// clamped inside exactly one parcel, and T6 guarantees plots and interiors are
// pairwise disjoint and clear of road and reservation. `occ` exists so a
// regression shows up here rather than fifty tiles later inside stampStructure,
// which throws on an overlap it cannot repair.

export type Face = 'n' | 's' | 'e' | 'w';

// The tail of a built plot: the back garden, from the rear wall of the house to
// the plot's rear boundary, at full plot width. Rear wings and étables stand
// INSIDE it — T8 walls the perimeter and skips every edge a building already owns.
export interface Garden {
  rect: Rect;
  plotIndex: number;
  runIndex: number;
  indexInRun: number;
  rear: Face; // the face of `rect` that is the plot's rear boundary
  front: Face; // the face toward the street
}

// A 1-2 tile gap between two units, running street → tail. Gated at the mouth
// (§1.3): infantry-permeable, vehicle-proof, invisible until you are in it.
export interface Venelle {
  rect: Rect;
  mouth: Face; // the face onto the street
}

// A walled yard — a farm cour or the civic forecourt. Buildings stand on three
// sides; `open` is the fourth, which T8 closes with a 2 m wall and one gate.
export interface Compound {
  rect: Rect;
  open: Face;
  gateWidth: 1 | 2;
}

export interface Footprints {
  buildings: Building[];
  gardens: Garden[];
  venelles: Venelle[];
  compounds: Compound[];
  occ: Uint8Array; // 1 = a building mass claims this tile
  church: Vec | null; // centre of the nave — T10's 'church' objective anchor
  terraceRuns: number;
}

// A plot with fewer than this many tiles between its frontage line and its rear
// boundary carries no building. The floor is the shallowest house that still
// leaves a tail: without at least one tile of garden behind it, two back-to-back
// plots put their rear walls in contact and each one's rear door opens onto the
// other's mass (B_SHARED — stampStructure throws rather than guess).
const MIN_AVAIL = 4;
const MIN_BODY = 3;
const MIN_WIDTH = 4;
// §5.2's "<= 90 buildings — the bound catches a runaway parcelizer", enforced
// where it belongs rather than asserted after the fact, and per-kind
// (KindProfile.maxBuildings). Measured bourg yield over seeds 1-20 at 320x240
// is 40-83 before T9's outlying farms add up to six more, so the cap binds on
// the densest seeds only, and it sheds block-interior sheds before it sheds
// frontage.
//
// A rank-0 frontage stays terraced well past the 0.35 density line: the Grande
// Rue IS the village in a 'bourgRue', and a high street that dissolves into
// detached cottages 39 tiles from the church is not one. 64 in Q8 is ~62 tiles
// out — past the far edge of the widest envelope, so in practice every plot on
// the Grande Rue inside the parcel zone.
const DENS_TERRACE = 64;

const clampTo = (v: number, lo: number, hi: number): number => (hi <= lo ? lo : Math.max(lo, Math.min(hi, v)));

// §1.2's frontage continuity, in Q8. 0.95 in the core, falling through the mid
// band to 0.15 at the envelope edge, continuous at both band boundaries.
//
// DEVIATION from the doc's literal "0.95 at the place → 0.15 at the envelope
// edge": the mid band (dens 0.35-0.60, i.e. 14-39 tiles out — measured, that is
// two thirds of every plot on a 320x240 map) is held at 0.55-0.85 rather than
// interpolated straight down. A linear ramp puts the median plot at 0.45 and
// the whole town comes out as scattered cottages, not a bourg. The gradient
// that matters visually is the one at the EDGE, and it is intact.
export function buildChanceQ8(dq: number): number {
  if (dq > DENS_CORE) return 243;
  if (dq > DENS_FRINGE) return 115 + (((dq - DENS_FRINGE) * 103) / (DENS_CORE - DENS_FRINGE) | 0);
  return 38 + ((dq * 77) / DENS_FRINGE | 0);
}

const opposite = (f: Face): Face => (f === 'n' ? 's' : f === 's' ? 'n' : f === 'e' ? 'w' : 'e');

// The street side of a plot. T6's `side` is the direction from the street INTO
// the block, so the road sits at (fx, fy - side) for axis 'h' — getting this
// sign wrong puts every door on the garden.
const frontFace = (p: Plot): Face => (p.axis === 'h' ? (p.side < 0 ? 's' : 'n') : (p.side < 0 ? 'e' : 'w'));

// Plot-local coordinates: `a` runs along the frontage from the run-start end,
// `k` runs into the block from the frontage line. Never re-derive plot geometry
// by hand — this and plotRect() are the only two places that know the sign.
function localRect(p: Plot, a0: number, k0: number, aw: number, kd: number): Rect {
  if (p.axis === 'h')
    return { x: p.fx + a0, y: p.side < 0 ? p.fy - (k0 + kd - 1) : p.fy + k0, w: aw, h: kd };
  return { x: p.side < 0 ? p.fx - (k0 + kd - 1) : p.fx + k0, y: p.fy + a0, w: kd, h: aw };
}

const inRects = (rects: Rect[], x: number, y: number): boolean =>
  rects.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);

// A door on `face`, as close along that face to `prefer` as a real boundary
// position allows. Two rules, both of them load-bearing inside stampStructure:
// the tile outside must not be part of THIS structure (a door on the joint of
// an L is not on the boundary at all — B_NONE, and the stamper throws), and it
// must not be part of an EARLIER one (B_SHARED — a door opening onto an
// abutting mass, which the stamper also throws rather than silently punch a
// hole between two buildings). `blocked` is the second test; it reads `occ`.
function faceDoor(
  parts: Rect[],
  face: Face,
  prefer: number,
  blocked: (x: number, y: number) => boolean,
  width: 1 | 2 = 1,
): DoorEdge | null {
  const horizontal = face === 'n' || face === 's';
  let bx = 0;
  let by = 0;
  let bd = Infinity;
  const fits = (x: number, y: number): boolean => {
    for (let k = 0; k < width; k++) {
      const tx = horizontal ? x + k : x;
      const ty = horizontal ? y : y + k;
      const ox = face === 'e' ? tx + 1 : face === 'w' ? tx - 1 : tx;
      const oy = face === 's' ? ty + 1 : face === 'n' ? ty - 1 : ty;
      if (!inRects(parts, tx, ty) || inRects(parts, ox, oy) || blocked(ox, oy)) return false;
    }
    return true;
  };
  for (const p of parts)
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        if (!fits(x, y)) continue;
        const d = Math.abs((horizontal ? x : y) - prefer);
        if (d < bd || (d === bd && (x < bx || (x === bx && y < by)))) {
          bd = d;
          bx = x;
          by = y;
        }
      }
  return bd === Infinity ? null : { x: bx, y: by, side: face, width };
}

// stampStructure falls back to its own mid-span scan when `doors` is absent, so
// an unplaceable door is a missing entry, never a thrown one.
function doorList(
  parts: Rect[],
  face: Face,
  prefer: number,
  blocked: (x: number, y: number) => boolean,
  width: 1 | 2 = 1,
): DoorEdge[] | undefined {
  const d = faceDoor(parts, face, prefer, blocked, width);
  if (d) return [d];
  if (width === 2) return doorList(parts, face, prefer, blocked, 1);
  return undefined;
}

// The preferred face first, then the rest. A caller that gets `undefined` back
// MUST NOT emit the structure: stampStructure's own fallback scan does not know
// about `occ`, so it will happily site a door on a span that abuts the
// neighbour and then throw at stamp time, which is a dead map rather than a
// missing shed.
function anyDoor(
  parts: Rect[],
  first: Face,
  prefer: number,
  blocked: (x: number, y: number) => boolean,
  width: 1 | 2 = 1,
): DoorEdge[] | undefined {
  for (const f of [first, 's', 'n', 'e', 'w'] as Face[]) {
    const d = doorList(parts, f, prefer, blocked, width);
    if (d) return d;
  }
  return undefined;
}

// What a terrace unit does for a living, off ONE draw on the plot stream. p 0.35
// it is a trade rather than a dwelling, and two fifths of those trades are named
// ones whose interior is not a generic fit-out (interiors §4.3: a bakery has an
// oven, a forge has an anvil, a grocer has neither).
//
// The split is thresholds on the SAME draw the shop/townhouse choice already
// took, so it adds no draw anywhere and no downstream stream moves. `stories`
// reads role only for church/civic/halle, so the map arrays do not move either
// — this changes what a building IS, not where it is.
const tradeRole = (r: number): BuildingRole =>
  r < 0.07 ? 'bakery' : r < 0.14 ? 'forge' : r < 0.35 ? 'shop' : 'townhouse';

export function buildFootprints(sk: Skeleton, land: Landmarks, pc: Parcels): Footprints {
  const { w, h } = sk;
  const { maxBuildings } = sk.profile;
  const r9 = sk.S(TAG.FOOTPRINT);
  const occ = new Uint8Array(w * h);
  const buildings: Building[] = [];
  const gardens: Garden[] = [];
  const venelles: Venelle[] = [];
  const compounds: Compound[] = [];

  // groupId is the index of the group's FIRST mass, so it can never collide
  // with another building's call index (stamp.ts uses `b.groupId ?? id`): the
  // leader's own index is its groupId, and no later building reuses it.
  const emit = (b: Building): number => {
    const idx = buildings.length;
    for (const p of b.parts ?? [b]) {
      if (p.x < 1 || p.y < 1 || p.x + p.w > w - 1 || p.y + p.h > h - 1)
        throw new Error(`footprints: ${b.role ?? 'house'} at ${p.x},${p.y} ${p.w}x${p.h} is off the ${w}x${h} grid`);
      for (let y = p.y; y < p.y + p.h; y++)
        for (let x = p.x; x < p.x + p.w; x++) {
          if (occ[y * w + x]) throw new Error(`footprints: ${b.role ?? 'house'} overlaps an earlier mass at ${x},${y}`);
          occ[y * w + x] = 1;
        }
    }
    buildings.push(b);
    return idx;
  };

  // the outside tile of a candidate door: free means in bounds and unclaimed by
  // any mass emitted so far
  const blocked = (x: number, y: number): boolean => x < 0 || y < 0 || x >= w || y >= h || occ[y * w + x] !== 0;

  const church = placeChurch(sk, land, r9, emit, blocked, () => buildings.length);
  placeMarket(land, r9, emit, blocked);
  placeCivic(sk, land, r9, emit, blocked, compounds);

  // ── plot frontage ────────────────────────────────────────────────────────
  // Contiguous flush units in one run share a terraceRun; a skipped plot, a
  // venelle or an inset breaks the chain, which is exactly where the roof range
  // should break too (N2).
  let terraceRuns = 0;
  let chain = -1;
  let chainRun = -1;
  let chainIdx = -2;

  pc.plots.forEach((p, plotIndex) => {
    if (buildings.length >= maxBuildings) return;
    const avail = p.d - p.setback;
    if (avail < MIN_AVAIL || p.w < MIN_WIDTH) return;

    // R-H7 · plot slope gate: skip the building when height range over
    // the plot rect exceeds 3 m. The plot stays as garden/orchard only.
    // Reuses the existing per-plot skip path; no extra draws.
    {
      const pr = localRect(p, 0, 0, p.w, p.d);
      let phMin = 255, phMax = 0;
      for (let py = Math.max(0, pr.y); py < Math.min(h, pr.y + pr.h); py++)
        for (let px = Math.max(0, pr.x); px < Math.min(w, pr.x + pr.w); px++) {
          const v = sk.height[py * w + px];
          if (v < phMin) phMin = v;
          if (v > phMax) phMax = v;
        }
      if (phMax - phMin > 3) {
        gardens.push({ rect: pr, plotIndex, runIndex: p.runIndex, indexInRun: p.indexInRun, rear: opposite(frontFace(p)), front: frontFace(p) });
        return;
      }
    }

    const core = p.densQ8 > DENS_CORE;
    const mid = !core && p.densQ8 > DENS_FRINGE;
    // A terrace is not a density band, it is a HIGH STREET. dens > 0.60 is only
    // the 14 tiles nearest the place (measured: 4 plots a seed at 320x240), and
    // a bourg whose party-wall frontage stops 14 tiles from the church is not a
    // bourg. Every plot on a rank-0 run down to the fringe threshold is terraced
    // — that is the Grande Rue, and it is the only frontage in the town that
    // reads as continuous from above.
    const rank = pc.runs[p.runIndex].rank;
    const terrace = core || (rank === 0 && p.densQ8 > DENS_TERRACE) || (rank === 1 && mid);
    // A terraced plot is never skipped by the continuity roll. The gaps in a
    // high street come from GEOMETRY — a strip with under five tiles of ground
    // behind it, a run that ends at a junction — and with 1-3 plots to a rank-0
    // run (measured) a 14% skip rate caps every terrace at three units and
    // §5.2's ">= 4 sharing a terraceRun" can never fire. The density gradient
    // §1.2 is written to protect lives in the FRINGE, which is untouched.
    if (!terrace && r9.int(256) >= buildChanceQ8(p.densQ8)) return;

    const front = frontFace(p);
    const rear = opposite(front);

    // width: a terrace unit fills its plot (party walls, margin 0); anything
    // else is inset where the plot can spare it. The inset is 2, never 1: a
    // 1-tile inset next to a flush terrace neighbour is a 1-tile sliver gap
    // (C2 — reads as neither terraced nor detached). A plot too narrow for
    // gap + body + two insets flush-fills instead and joins the terrace chain
    // (party wall), so no detached house ever ends up 0 or 1 tiles from its
    // neighbour.
    let gap = 0;
    if (!terrace && mid && r9.int(256) >= p.densQ8) gap = 2 + r9.int(1);
    const inset = terrace ? 0 : p.w >= 9 ? 2 : 0;
    let a0 = gap + inset;
    let aw = p.w - a0 - inset;
    // A plot too narrow for gap + body + insets flushes instead (joins the
    // terrace chain, party wall). A w<9 plot has no right-hand inset, so a
    // gap there would push its right wall onto the neighbour — an abutting
    // pair with mismatched runs. Never a 1-tile sliver, never a 0-gap pair
    // without a shared run.
    if (aw < MIN_WIDTH || (gap > 0 && inset === 0)) {
      a0 = 0;
      aw = p.w;
      gap = 0;
    }
    if (aw < MIN_WIDTH) return;
    const flush = gap === 0 && inset === 0;

    const bd = clampTo(core ? 6 + r9.int(5) : mid ? 5 + r9.int(5) : 5 + r9.int(3), MIN_BODY, avail - 2);
    const tail = avail - bd;
    const alongAxis = front === 'n' || front === 's';

    // Burgage RE-subdivision. T6 picks each strip's width by "core with
    // probability dens" (the doc's rule), so a rank-0 run 20 tiles out gets
    // 9-16-tile plots and a 26-tile run holds two of them — which caps every
    // terrace at two units no matter what the continuity roll does. A burgage
    // that wide was historically subdivided; splitting it here into 5-8 tile
    // units under one continuous frontage is both the correct move and the only
    // one that produces §5.2's four-unit range.
    const units = terrace ? (aw >= 19 ? 4 : aw >= 14 ? 3 : aw >= 9 ? 2 : 1) : 1;

    // One wing per PLOT, flush to the plot boundary that indexInRun & 1 selects,
    // so wings pair across the party wall with the neighbouring plot's. Per-unit
    // wings would put two of them on the same internal boundary and overlap.
    const wantWing = tail >= 6 && aw >= 6 && r9.next() < (terrace ? 0.3 : core || mid ? 0 : 0.55);
    const wingHigh = (p.indexInRun & 1) !== 0;
    const wingW = Math.min(3 + r9.int(2), aw - 2);
    const wingD = Math.min(terrace ? 4 + r9.int(4) : 3 + r9.int(2), tail - 3);
    // p 0.15: the rear door lines up with the front one — a porte-cochère, a
    // straight infantry-only passage through the house body, invisible from the
    // street. Rolled per plot so all its units agree.
    const porte = terrace && r9.next() < 0.15;
    const rearJitter = r9.int(3) - 1;

    if (flush && p.runIndex === chainRun && p.indexInRun === chainIdx + 1) {
      chainIdx = p.indexInRun;
    } else if (flush) {
      chain = terraceRuns++;
      chainRun = p.runIndex;
      chainIdx = p.indexInRun;
    } else {
      chainRun = -1;
      chainIdx = -2;
    }

    let consumed = 0;
    let deepest = p.setback + bd;
    for (let u = 0; u < units; u++) {
      const uw = u === units - 1 ? aw - consumed : (aw / units) | 0;
      const ua0 = a0 + consumed;
      consumed += uw;
      if (uw < MIN_WIDTH) continue;
      const body = localRect(p, ua0, p.setback, uw, bd);
      const parts: Rect[] = [body];
      if (wantWing && wingW >= 3 && wingD >= 3 && u === (wingHigh ? units - 1 : 0) && uw >= wingW + 2) {
        parts.push(localRect(p, wingHigh ? ua0 + uw - wingW : ua0, p.setback + bd, wingW, wingD));
        deepest = Math.max(deepest, p.setback + bd + wingD);
      }

      const prefer = alongAxis ? body.x + (body.w >> 1) : body.y + (body.h >> 1);
      const fd = faceDoor(parts, front, prefer, blocked);
      if (!fd) continue; // no boundary face onto the street: not a house
      const doors: DoorEdge[] = [fd];
      // Every unit gets a rear door: §1.4's flanking network is the whole point
      // of the back gardens, and a garden you can only reach from the street is
      // scenery.
      const rd = faceDoor(parts, rear, porte ? prefer : prefer + rearJitter, blocked);
      if (rd) doors.push(rd);
      emit({
        x: body.x,
        y: body.y,
        w: body.w,
        h: body.h,
        role: terrace ? tradeRole(r9.next()) : mid ? 'townhouse' : 'farmhouse',
        parts: parts.length > 1 ? parts : undefined,
        doors,
        frontage: front,
        terraceRun: flush ? chain : undefined,
      });
    }

    // Fringe étable across the yard, at the rear of the plot. `deepest` is the
    // real back of the house INCLUDING its L wing — measuring the gap from the
    // body alone puts the étable's front wall against the wing, and its door
    // then opens onto the same structure it is three tiles behind.
    if (!core && !mid && tail >= 8 && aw >= 5) {
      const eh = 3 + r9.int(2);
      const ew = Math.min(aw, 4 + r9.int(3));
      if (avail - eh - deepest >= 3) {
        const et = localRect(p, a0, p.setback + avail - eh, ew, eh);
        const ed = anyDoor([et], rear, alongAxis ? et.x + (et.w >> 1) : et.y + (et.h >> 1), blocked);
        if (ed) emit({ x: et.x, y: et.y, w: et.w, h: et.h, role: 'barn', doors: ed, frontage: rear });
      }
    }

    if (tail >= 1)
      gardens.push({
        rect: localRect(p, 0, p.setback + bd, p.w, tail),
        plotIndex,
        runIndex: p.runIndex,
        indexInRun: p.indexInRun,
        rear,
        front,
      });
    if (gap > 0) venelles.push({ rect: localRect(p, 0, 0, gap, p.setback + bd), mouth: front });
  });

  // T6's interior parcels are clipped to the block, not to the map: on a 60x40
  // map a countryside component reaches x=0 and a parcel with it. Nothing may be
  // built on the outermost ring — setHEdge/setVEdge do no bounds test
  // (map.ts:77-83) and a wall one tile off the grid lands on the far side of it.
  for (const it of pc.interiors) {
    if (buildings.length >= maxBuildings) break;
    // Interiors get the same continuity roll as frontage. Without it the
    // recursive AABB split of a big block hands back a dozen 9x9 parcels and
    // each one grows a two-mass yard: a grid of identical sheds, which is
    // §1.2's "reads as generated" failure in its purest form. Gated on dens,
    // the back-land near the place stays worked and the edge of town keeps its
    // orchards and paddocks.
    if (r9.int(256) >= buildChanceQ8(it.densQ8)) continue;
    const x0 = Math.max(1, it.rect.x);
    const y0 = Math.max(1, it.rect.y);
    const x1 = Math.min(w - 1, it.rect.x + it.rect.w);
    const y1 = Math.min(h - 1, it.rect.y + it.rect.h);
    if (x1 - x0 < 5 || y1 - y0 < 5) continue;
    fillInterior({ ...it, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }, r9, emit, blocked, compounds);
  }

  return { buildings, gardens, venelles, compounds, occ, church, terraceRuns };
}

// ── the church group ─────────────────────────────────────────────────────────
//
// Three masses under one groupId: nave, tower at the WEST end (liturgical
// orientation — the apse faces east), apse at the east. Dimensioned against the
// churchyard's actual reserved tiles rather than against the doc's fixed
// 9x22/5x5/5x4, because the reservation shrinks to 16 on a tight quadrant and
// the place widening can have paved into its chamfer notches.
function placeChurch(
  sk: Skeleton,
  land: Landmarks,
  r: Rng,
  emit: (b: Building) => number,
  blocked: (x: number, y: number) => boolean,
  nextIndex: () => number,
): Vec | null {
  const cy = land.churchyard;
  if (!cy) return null;
  const { w } = sk;
  const reserved = (x: number, y: number): boolean => land.resv[y * w + x] === RESV.CHURCHYARD;

  const naveW = Math.max(5, Math.min(9, (cy.h * 2) / 5) | 0);
  const y0 = cy.y + ((cy.h - naveW) >> 1);
  // the maximal run of columns whose whole nave band is reserved churchyard
  let best = -1;
  let bestLen = 0;
  let start = -1;
  for (let x = cy.x; x <= cy.x + cy.w; x++) {
    let ok = x < cy.x + cy.w;
    for (let y = y0; ok && y < y0 + naveW; y++) if (!reserved(x, y)) ok = false;
    if (ok) {
      if (start < 0) start = x;
      continue;
    }
    if (start >= 0 && x - start > bestLen) {
      bestLen = x - start;
      best = start;
    }
    start = -1;
  }
  if (best < 0 || bestLen < 14) return null;

  const span = Math.min(bestLen - 2, 32);
  const x0 = best + ((bestLen - span) >> 1);
  const towerW = 5;
  const apseW = span >= 20 ? 4 : 0;
  const nave: Rect = { x: x0 + towerW, y: y0, w: span - towerW - apseW, h: naveW };
  // the group id is fixed BEFORE the first emit so all three masses carry the
  // leader's index; stampStructure walls any span between differing ids, and a
  // wall down the middle of a church is not a church
  const gid = nextIndex();
  const naveFace: Face = cy.y + cy.h / 2 > sk.place.y ? 'n' : 's';
  const naveDoor = anyDoor([nave], naveFace, nave.x + (nave.w >> 1), blocked);
  emit({
    ...nave,
    role: 'church',
    groupId: gid,
    doors: naveDoor,
    frontage: naveFace,
  });
  emit({ x: x0, y: y0 + ((naveW - towerW) >> 1), w: towerW, h: towerW, role: 'church_tower', groupId: gid });
  if (apseW > 0) {
    const apseH = Math.max(3, naveW - 4);
    emit({ x: nave.x + nave.w, y: y0 + ((naveW - apseH) >> 1), w: apseW, h: apseH, role: 'church_apse', groupId: gid });
  }
  r.next(); // one draw whether or not the apse fitted, so the stage stays stable
  return { x: nave.x + (nave.w >> 1), y: nave.y + (nave.h >> 1) };
}

// ── the market island ────────────────────────────────────────────────────────
//
// §1.3's highest ratio of recognisability to code: a terraced island dropped
// off-centre in the widened place, splitting it into two lanes. p 0.35 it is a
// halle instead — a roof on posts, which stampStructure gives four corner walls
// and an open interior.
function placeMarket(land: Landmarks, r: Rng, emit: (b: Building) => number, blocked: (x: number, y: number) => boolean): void {
  const m = land.market;
  if (!m) return;
  const horizontal = m.w >= m.h;
  if (r.next() < 0.35) {
    emit({ x: m.x, y: m.y, w: m.w, h: m.h, role: 'halle' });
    return;
  }
  const span = horizontal ? m.w : m.h;
  const units = Math.max(2, Math.min(2 + r.int(3), (span / 3) | 0));
  const run = -1 - r.int(1); // a negative terraceRun id: the island's own range, never a street run
  let pos = 0;
  for (let i = 0; i < units; i++) {
    const uw = i === units - 1 ? span - pos : ((span - pos) / (units - i)) | 0;
    if (uw < 3) break;
    const rect: Rect = horizontal
      ? { x: m.x + pos, y: m.y, w: uw, h: m.h }
      : { x: m.x, y: m.y + pos, w: m.w, h: uw };
    const face: Face = horizontal ? (i & 1 ? 'n' : 's') : i & 1 ? 'w' : 'e';
    emit({
      ...rect,
      role: 'shop',
      doors: anyDoor([rect], face, horizontal ? rect.x + (rect.w >> 1) : rect.y + (rect.h >> 1), blocked),
      frontage: face,
      terraceRun: run,
    });
    pos += uw;
  }
}

// ── the civic set ────────────────────────────────────────────────────────────
//
// Mairie/école at the back of the reserved forecourt, the front of it left open
// as a walled court with a gate onto the place (T8 builds the wall).
function placeCivic(
  sk: Skeleton,
  land: Landmarks,
  r: Rng,
  emit: (b: Building) => number,
  blocked: (x: number, y: number) => boolean,
  compounds: Compound[],
): void {
  const f = land.forecourt;
  if (!f || f.w < 6 || f.h < 6) return;
  const northOfPlace = f.y + f.h / 2 < sk.place.y;
  const bh = 4 + r.int(2);
  // the building sits AWAY from the place; the court is between it and the street
  const by = northOfPlace ? f.y : f.y + f.h - bh;
  const rect: Rect = { x: f.x + 1, y: by, w: f.w - 2, h: bh };
  const face: Face = northOfPlace ? 's' : 'n';
  emit({
    ...rect,
    role: 'civic',
    doors: anyDoor([rect], face, rect.x + (rect.w >> 1), blocked, 2),
    frontage: face,
  });
  compounds.push({
    rect: { x: f.x, y: northOfPlace ? f.y + bh : f.y, w: f.w, h: f.h - bh },
    open: face,
    gateWidth: 2,
  });
}

// ── farm cours and outbuildings on non-frontage interiors ────────────────────
//
// §1.3's cour: masses on three sides of a yard, all doors facing in, the fourth
// side a 2 m wall with a cart gate. A natural strongpoint, and the reason the
// depth-≤3 AABB split of stage 8 exists at all. Smaller parcels degrade to a
// two-mass yard and then to a single barn rather than being left empty — a
// 9x9 hole in the middle of a block is the "generated" tell in reverse.
function fillInterior(
  it: Interior,
  r: Rng,
  emit: (b: Building) => number,
  blocked: (x: number, y: number) => boolean,
  compounds: Compound[],
): void {
  const R = it.rect;
  // Inset only where the parcel can spare it. Interiors run 5x5 to 20x15 with a
  // 9x9 median (measured over seeds 1-20): a fixed 1-tile inset drops the median
  // parcel out of the two-mass yard case and leaves a single shed in a hole. An
  // interior tile is already guaranteed clear of every plot, so abutting the
  // parcel edge costs nothing but a shared wall with whatever is next door.
  const pad = Math.min(R.w, R.h) >= 11 ? 1 : 0;
  const x0 = R.x + pad;
  const y0 = R.y + pad;
  const iw = R.w - 2 * pad;
  const ih = R.h - 2 * pad;
  if (iw < 4 || ih < 3) return;
  const long = iw >= ih;
  const L = long ? iw : ih;
  const C = long ? ih : iw;
  // u runs along the long axis, v across it
  const put = (u: number, v: number, uw: number, vh: number): Rect =>
    long ? { x: x0 + u, y: y0 + v, w: uw, h: vh } : { x: x0 + v, y: y0 + u, w: vh, h: uw };
  const face = (d: '+u' | '-u' | '+v' | '-v'): Face =>
    long
      ? d === '+u' ? 'e' : d === '-u' ? 'w' : d === '+v' ? 's' : 'n'
      : d === '+u' ? 's' : d === '-u' ? 'n' : d === '+v' ? 'e' : 'w';

  const logisH = 4 + r.int(2);
  const grangeH = 5 + r.int(2);
  if (L >= 16 && C - logisH - grangeH >= 4) {
    const etW = 4 + r.int(2);
    const logis = put(1, 0, Math.min(L - 2, 7 + r.int(3)), logisH);
    const grange = put(1, C - grangeH, Math.min(L - 2, 9 + r.int(4)), grangeH);
    const etable = put(0, logisH, etW, C - logisH - grangeH);
    putMass(emit, logis, 'farmhouse', face('+v'), centre(logis, long), blocked, 1);
    putMass(emit, grange, 'barn', face('-v'), centre(grange, long), blocked, 2);
    putMass(emit, etable, 'barn', face('+u'), across(etable, long), blocked, 1);
    compounds.push({ rect: put(etW, logisH, L - etW, C - logisH - grangeH), open: face('+u'), gateWidth: 2 });
    return;
  }
  const aH = 3 + r.int(2);
  const bH = 3 + r.int(2);
  if (L >= 9 && C - aH - bH >= 2) {
    const a = put(0, 0, Math.min(L, 6 + r.int(3)), aH);
    const bw = Math.min(L, 5 + r.int(3));
    const b = put(L - bw, C - bH, bw, bH);
    putMass(emit, a, 'barn', face('+v'), centre(a, long), blocked, 1);
    putMass(emit, b, 'barn', face('-v'), centre(b, long), blocked, 1);
    compounds.push({ rect: put(0, aH, L, C - aH - bH), open: face('+u'), gateWidth: 2 });
    return;
  }
  if (L >= 6 && C >= 4) {
    // one tile of yard on the door side: a shed filling its parcel edge to edge
    // has its door against whatever abuts the parcel
    const s = put(0, 0, Math.min(L, 5 + r.int(4)), Math.min(C - 1, 4 + r.int(2)));
    putMass(emit, s, 'barn', face('+v'), centre(s, long), blocked, 1);
  }
}

const centre = (r: Rect, long: boolean): number => (long ? r.x + (r.w >> 1) : r.y + (r.h >> 1));
const across = (r: Rect, long: boolean): number => (long ? r.y + (r.h >> 1) : r.x + (r.w >> 1));

// Emit a single-rect mass, or nothing at all if no face can carry a door.
function putMass(
  emit: (b: Building) => number,
  rect: Rect,
  role: BuildingRole,
  frontage: Face,
  prefer: number,
  blocked: (x: number, y: number) => boolean,
  width: 1 | 2,
): void {
  const doors = anyDoor([rect], frontage, prefer, blocked, width);
  if (doors) emit({ ...rect, role, doors, frontage });
}
