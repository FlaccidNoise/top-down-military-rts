import type { Rect, Vec } from '../mapgen';
import { mulberry32, type Rng } from '../rng';
import type { KindProfile } from './profile';

// Bourg street skeleton — stages 1, 2, 3 and 5 of
// docs/plans/2026-07-26-town-gen-design.md (T4). Pure geometry: this module
// writes a `road` bitmap and a Seg list and touches no GameMap. Stamping is
// T11's job, landmark reservation (stage 4) is T5's, and it runs BETWEEN the
// skeleton and the growth loop — hence the two entry points, buildSkeleton()
// and growMinorStreets(resv), rather than one call.
//
// D10: rotation-free. Every carrier of frontage is an axis-aligned rectilinear
// polyline; curvature comes from jogs and tangent streets, never from angle. A
// staircase of edge walls along a diagonal is a real trap — astar's
// no-corner-cutting rule (path.ts:107-114) makes the steps impassable while
// los()'s traversal sees straight through the gap.

// ── §2.1 RNG stream plan ─────────────────────────────────────────────────────
// Stage tags are FIXED CONSTANTS, never renumbered: the whole point of D2 is
// that retuning one stage cannot move another, and a renumber breaks that
// retroactively for every seed.
export const TAG = {
  ENVELOPE: 1,
  REGIONAL: 2,
  SKELETON: 3,
  LANDMARK: 4,
  MINOR: 5,
  PARCEL: 8,
  FOOTPRINT: 9,
  ENCLOSURE: 10,
  RURAL: 11,
  ORCHARD: 12,
  WOODS: 13,
  ELEV: 14,
} as const;

// mulberry32 is a 32-bit counter (rng.ts:8-22): two streams seeded 1 apart are
// correlated for their first few outputs, so the tag is spaced by the
// golden-ratio odd constant rather than added. Never `base + tag`.
export function subStream(base: number, tag: number): Rng {
  return mulberry32((base ^ Math.imul(tag, 0x9e3779b1)) >>> 0);
}

export type Archetype = 'carrefour' | 'bourgRue' | 'enclos' | 'faubourg';

export interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  axis: 'h' | 'v';
  width: 1 | 2 | 3;
  rank: 0 | 1 | 2 | 3;
  t: number;
}

// One street as the growth loop sees it: the centreline tiles in order, so a
// branch root is an index rather than an arclength walk over vertices, and a
// jogged street is one object rather than three.
export interface Street {
  tiles: Vec[];
  width: 1 | 2 | 3;
  rank: 0 | 1 | 2 | 3;
  t: number;
  cursor: number; // tile index at which the next branch attempt may root
  mouths: number[]; // tile indices where a branch has already been taken
}

export interface Skeleton {
  w: number;
  h: number;
  base: number;
  profile: KindProfile; // every later stage reads its own fields off this
  archetype: Archetype;
  env: Rect; // R_env — the town envelope, [x, x+w) x [y, y+h)
  place: Vec; // the carrefour: always a road tile on the Grande Rue
  roadY: Int32Array; // arterial centreline per column (authoritative outside R_env)
  road: Uint8Array; // 1 = carved road
  segs: Seg[];
  streets: Street[];
  grandeRue: Seg[]; // rank-0 pieces of the Grande Rue, west→east
  faubourg: Vec | null; // secondary cluster centre ('faubourg' archetype only)
  S(tag: number): Rng;
  densQ8(x: number, y: number): number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// A jog that actually moves. At the clamp bound the rolled direction is
// flipped, because a jog of zero leaves two consecutive straight runs collinear
// and merges them into one 90-tile MG lane — the exact thing §1.4's cap exists
// to prevent, and invisible in the Seg list because both pieces are still <= 45.
//
// The magnitude is 2-3 for a 3-wide street, not the doc's 1-3. A ONE-tile jog
// of a 3-wide road leaves two of its three rows continuous, and §5.2's
// "longest straight run of 3-wide road <= 45" then fails as soon as anything
// refills the third row — measured on seed 20, where two minor streets rooted
// at the jog took a 45-tile run to 48. The doc's own cap and its own jog range
// are incompatible at width 3; the cap wins, it is the playability constraint.
const JOG = (r: Rng, width: number): number => (width >= 3 ? 2 + r.int(2) : 1 + r.int(3));
const jogged = (cur: number, dir: number, jog: number, lo: number, hi: number): number => {
  const a = clamp(cur + dir * jog, lo, hi);
  return a !== cur ? a : clamp(cur - dir * jog, lo, hi);
};

// §1.2 density scalar in Q8: 256 at the place, falling off with CHEBYSHEV
// distance (no sqrt, no hypot). 0.60 ≈ 154, 0.35 ≈ 90.
export const DENS_CORE = 154;
export const DENS_FRINGE = 90;

// §1.1 archetype weights, as integers out of 100 — a float comparator here
// would be the one place in the pipeline where a rounding difference flips a
// whole town. The weights themselves are per-kind (KindProfile.archetypeW).
function pickArchetype(r: Rng, weights: [Archetype, number][]): Archetype {
  let k = r.int(100);
  for (const [name, weight] of weights) {
    if (k < weight) return name;
    k -= weight;
  }
  return 'carrefour';
}

// ── polyline plumbing ────────────────────────────────────────────────────────

// Rectilinear vertex list → the tiles of its centreline, in order, no repeats.
export function tilesFromVerts(verts: Vec[]): Vec[] {
  const out: Vec[] = [];
  if (verts.length === 0) return out;
  out.push({ x: verts[0].x, y: verts[0].y });
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1];
    const b = verts[i];
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    if (dx !== 0 && dy !== 0) throw new Error(`streets: diagonal polyline piece ${a.x},${a.y} → ${b.x},${b.y}`);
    let x = a.x;
    let y = a.y;
    while (x !== b.x || y !== b.y) {
      x += dx;
      y += dy;
      out.push({ x, y });
    }
  }
  return out;
}

// Centreline tiles → maximal axis-aligned segments. Grouping by axis rather
// than carrying the vertex list through truncation is what lets the growth
// loop cut a proposal anywhere and still emit clean Segs.
export function segsFromTiles(tiles: Vec[], width: 1 | 2 | 3, rank: 0 | 1 | 2 | 3, t: number): Seg[] {
  const out: Seg[] = [];
  if (tiles.length < 2) return out;
  let sx = tiles[0].x;
  let sy = tiles[0].y;
  let axis: 'h' | 'v' = tiles[1].y === tiles[0].y ? 'h' : 'v';
  for (let i = 1; i < tiles.length; i++) {
    const a: 'h' | 'v' = tiles[i].y === tiles[i - 1].y ? 'h' : 'v';
    if (a !== axis) {
      out.push({ ax: sx, ay: sy, bx: tiles[i - 1].x, by: tiles[i - 1].y, axis, width, rank, t });
      sx = tiles[i - 1].x;
      sy = tiles[i - 1].y;
      axis = a;
    }
  }
  const last = tiles[tiles.length - 1];
  out.push({ ax: sx, ay: sy, bx: last.x, by: last.y, axis, width, rank, t });
  return out;
}

// Width is carved CENTRED, matching both legacy conventions: the 3-wide
// arterial spans roadY-1..roadY+1 (mapgen.ts:149) and the 2-wide cross lane
// spans laneX..laneX+1 (mapgen.ts:165).
// `block` (stage 4's reservations) clips the carve. Only the flanks of the
// band are ever clipped — the centreline is checked free before a street is
// accepted — so connectivity is unaffected, and the notch is exactly where the
// enclosure wall goes. Without it a 2-wide street hugging the churchyard's
// CHAMFER puts road inside the enclosure, which is both a broken reservation
// and a hole in the wall T8 is about to build.
export function carveSeg(road: Uint8Array, w: number, h: number, s: Seg, block?: Uint8Array): void {
  const half = (s.width - 1) >> 1;
  const lo0 = s.axis === 'h' ? Math.min(s.ax, s.bx) : Math.min(s.ay, s.by);
  const hi0 = s.axis === 'h' ? Math.max(s.ax, s.bx) : Math.max(s.ay, s.by);
  for (let k = -half; k < s.width - half; k++)
    for (let p = lo0; p <= hi0; p++) {
      const x = s.axis === 'h' ? p : s.ax + k;
      const y = s.axis === 'h' ? s.ay + k : p;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (block && block[y * w + x]) continue;
      road[y * w + x] = 1;
    }
}

// The legacy arterial is a per-column centreline that steps ±1 (mapgen.ts:57-63),
// i.e. consecutive tiles are DIAGONAL neighbours. Re-expressed here as a
// rectilinear staircase — same wander, but a legal polyline that frontage
// extraction can walk the flanks of. (Legal to change shape at all only
// because 'bourg' is a new kind; every other kind still runs the original.)
function arterialVerts(roadY: Int32Array, x0: number, x1: number): Vec[] {
  const out: Vec[] = [{ x: x0, y: roadY[x0] }];
  let cur = roadY[x0];
  for (let x = x0 + 1; x <= x1; x++) {
    if (roadY[x] === cur) continue;
    out.push({ x, y: cur }, { x, y: roadY[x] });
    cur = roadY[x];
  }
  out.push({ x: x1, y: cur });
  return out;
}

// ── stages 1-3 ───────────────────────────────────────────────────────────────

export function buildSkeleton(base: number, w: number, h: number, profile: KindProfile): Skeleton {
  const S = (tag: number): Rng => subStream(base, tag);
  const road = new Uint8Array(w * h);
  const segs: Seg[] = [];
  const streets: Street[] = [];

  // Stage 1a — archetype and envelope dims. Drawn BEFORE the arterial because
  // placeY reads roadY: the literal order is archetype+dims, arterial, place.
  const r1 = S(TAG.ENVELOPE);
  const archetype = pickArchetype(r1, profile.archetypeW);
  const placeXRaw = Math.round(w * r1.range(0.42, 0.6));
  const envW = Math.min(profile.envW[0] + r1.int(profile.envW[1]), w - 12);
  const envH = Math.min(profile.envH[0] + r1.int(profile.envH[1]), h - 12);

  // Stage 2 — the regional arterial, the legacy drifting walk (mapgen.ts:57-63)
  // on its own sub-stream. The drift clamp is tightened from [10, h-11] to the
  // middle 40% of the map: R_env is centred on the place and must fit around
  // it, and an arterial that has wandered to y=10 puts the whole town on one
  // side of its own high street.
  const r2 = S(TAG.REGIONAL);
  const roadY = new Int32Array(w);
  const driftLo = Math.max(10, Math.round(h * 0.3));
  const driftHi = Math.min(h - 11, Math.round(h * 0.7));
  let ry = clamp(Math.round(h * r2.range(0.4, 0.6)), driftLo, driftHi);
  for (let x = 0; x < w; x++) {
    roadY[x] = ry;
    if (r2.next() < 0.18) ry = clamp(ry + (r2.next() < 0.5 ? -1 : 1), driftLo, driftHi);
  }

  // Stage 1b — the place, then R_env centred on it.
  const placeX = clamp(placeXRaw, 6, w - 7);
  const placeY = roadY[placeX];
  const env: Rect = {
    x: clamp(placeX - (envW >> 1), 6, w - 6 - envW),
    y: clamp(placeY - (envH >> 1), 6, h - 6 - envH),
    w: envW,
    h: envH,
  };
  const ex0 = env.x;
  const ex1 = env.x + env.w - 1;
  const ey0 = env.y;
  const ey1 = env.y + env.h - 1;
  const place: Vec = { x: clamp(placeX, ex0 + 8, ex1 - 8), y: placeY };
  const densQ8 = (x: number, y: number): number => {
    const d = Math.max(Math.abs(x - place.x), Math.abs(y - place.y));
    return (65536 / (256 + profile.densFalloff * d)) | 0;
  };

  const addStreet = (tiles: Vec[], width: 1 | 2 | 3, rank: 0 | 1 | 2 | 3, t: number): Street | null => {
    if (tiles.length < 2) return null;
    const made = segsFromTiles(tiles, width, rank, t);
    for (const s of made) carveSeg(road, w, h, s);
    segs.push(...made);
    const st: Street = { tiles, width, rank, t, cursor: 0, mouths: [] };
    streets.push(st);
    return st;
  };

  // Stage 3 — the Grande Rue: a rectilinear polyline of width 3, grown OUTWARD
  // from the place so the place always sits inside a straight run (the doc's
  // left-to-right loop would leave placeY wrong the moment the polyline jogged
  // west of placeX, and would let a jog land in the middle of the widening).
  const r3 = S(TAG.SKELETON);
  const gyLo = Math.max(ey0 + 8, 4);
  const gyHi = Math.min(ey1 - 8, h - 5);
  // `run` is a TILE COUNT, so a piece spans [x, x + run - 1]: §1.4's cap is
  // "no straight run longer than 45 tiles", and x → x + 45 is forty-SIX tiles.
  const run0 = 25 + r3.int(21);
  const verts: Vec[] = [
    { x: clamp(place.x - (run0 >> 1), ex0, ex1), y: place.y },
    { x: clamp(place.x - (run0 >> 1) + run0 - 1, ex0, ex1), y: place.y },
  ];
  // east, then west; each iteration is one jog piece plus one straight run,
  // and every straight run is capped at 45 tiles by construction (§1.4).
  let cx = verts[1].x;
  let cy = place.y;
  while (cx < ex1) {
    const jog = JOG(r3, 3);
    const dir = r3.next() < 0.5 ? -1 : 1;
    cy = jogged(cy, dir, jog, gyLo, gyHi);
    verts.push({ x: cx, y: cy });
    cx = Math.min(ex1, cx + 24 + r3.int(21));
    verts.push({ x: cx, y: cy });
  }
  cx = verts[0].x;
  cy = place.y;
  while (cx > ex0) {
    const jog = JOG(r3, 3);
    const dir = r3.next() < 0.5 ? -1 : 1;
    cy = jogged(cy, dir, jog, gyLo, gyHi);
    verts.unshift({ x: cx, y: cy });
    cx = Math.max(ex0, cx - (24 + r3.int(21)));
    verts.unshift({ x: cx, y: cy });
  }
  const grandeRueTiles = tilesFromVerts(verts);
  const grandeRue = segsFromTiles(grandeRueTiles, 3, 0, 0);
  addStreet(grandeRueTiles, 3, 0, 0);

  // Stage 2b — the arterial outside R_env, plus the handoff jog at each
  // envelope crossing: the road arrives off the fields still wandering and
  // straightens as it enters town, which is what a real approach does.
  const wJog = grandeRueTiles[0];
  const eJog = grandeRueTiles[grandeRueTiles.length - 1];
  for (const span of [
    [0, ex0],
    [ex1, w - 1],
  ]) {
    const aSegs = segsFromTiles(tilesFromVerts(arterialVerts(roadY, span[0], span[1])), 3, 0, 0);
    for (const s of aSegs) carveSeg(road, w, h, s);
    segs.push(...aSegs);
  }
  for (const [jx, jy] of [
    [ex0, roadY[ex0]],
    [ex1, roadY[ex1]],
  ] as [number, number][]) {
    const gy = jx === ex0 ? wJog.y : eJog.y;
    if (gy === jy) continue;
    const s: Seg = { ax: jx, ay: jy, bx: jx, by: gy, axis: 'v', width: 3, rank: 0, t: 0 };
    carveSeg(road, w, h, s);
    segs.push(s);
  }

  // Stage 3b — the cross route. 'bourgRue' has none (a linear village is one
  // street and its spurs); 'enclos' offsets it so the main route passes on one
  // side of the churchyard rather than through the junction.
  if (archetype !== 'bourgRue') {
    const offset = archetype === 'enclos' ? (r3.next() < 0.5 ? -1 : 1) * (12 + r3.int(9)) : 0;
    const crossX = clamp(place.x + offset, ex0 + 6, ex1 - 6);
    const width: 1 | 2 | 3 = r3.next() < 0.5 ? 2 : 3;
    const gxLo = Math.max(ex0 + 4, 4);
    const gxHi = Math.min(ex1 - 4, w - 5);
    // grown outward from the crossing, exactly as the Grande Rue is: that is
    // what keeps a jog from landing in the middle of the place, without the
    // "skip the jog near the place" rule that silently merged two runs
    const crun0 = 25 + r3.int(21);
    const cverts: Vec[] = [
      { x: crossX, y: clamp(place.y - (crun0 >> 1), 0, h - 1) },
      { x: crossX, y: clamp(place.y - (crun0 >> 1) + crun0 - 1, 0, h - 1) },
    ];
    let vx = crossX;
    let vy = cverts[1].y;
    while (vy < h - 1) {
      vx = jogged(vx, r3.next() < 0.5 ? -1 : 1, JOG(r3, width), gxLo, gxHi);
      cverts.push({ x: vx, y: vy });
      vy = Math.min(h - 1, vy + 24 + r3.int(21));
      cverts.push({ x: vx, y: vy });
    }
    vx = crossX;
    vy = cverts[0].y;
    while (vy > 0) {
      vx = jogged(vx, r3.next() < 0.5 ? -1 : 1, JOG(r3, width), gxLo, gxHi);
      cverts.unshift({ x: vx, y: vy });
      vy = Math.max(0, vy - (24 + r3.int(21)));
      cverts.unshift({ x: vx, y: vy });
    }
    addStreet(tilesFromVerts(cverts), width, 0, 0);
  }

  // Stage 3c — 'carrefour'/'faubourg' converging approaches. Outside R_env the
  // route is a drifting staircase at a rough diagonal; at the envelope it
  // doglegs to axis-aligned for its final leg, so the convergence reads
  // multi-angled from above and is rectilinear where it carries frontage.
  // It joins the Grande Rue 7-15 tiles OFF the place rather than exactly at
  // it — an approach collinear with the cross route would just be the cross
  // route, and Sainte-Mère-Église's arms meet the place at offset mouths.
  if (archetype === 'carrefour' || archetype === 'faubourg') {
    for (let i = 0, n = 1 + r3.int(2); i < n; i++) {
      const north = r3.next() < 0.5;
      const joinX = clamp(place.x + (r3.next() < 0.5 ? -1 : 1) * (7 + r3.int(9)), ex0 + 4, ex1 - 4);
      const gy = grandeRueYAt(grandeRue, joinX) ?? place.y;
      const envEdgeY = north ? ey0 : ey1;
      const averts: Vec[] = [{ x: joinX, y: gy }, { x: joinX, y: envEdgeY }];
      // staircase out to the map edge
      let sx = joinX;
      let sy = envEdgeY;
      const targetX = clamp(joinX + (r3.next() < 0.5 ? -1 : 1) * (30 + r3.int(40)), 3, w - 4);
      const targetY = north ? 1 : h - 2;
      let guard = 0;
      while ((sx !== targetX || sy !== targetY) && guard++ < 24) {
        const stepY = Math.sign(targetY - sy) * Math.min(Math.abs(targetY - sy), 5 + r3.int(8));
        if (stepY !== 0) {
          sy += stepY;
          averts.push({ x: sx, y: sy });
        }
        const stepX = Math.sign(targetX - sx) * Math.min(Math.abs(targetX - sx), 5 + r3.int(8));
        if (stepX !== 0) {
          sx += stepX;
          averts.push({ x: sx, y: sy });
        }
        if (stepX === 0 && stepY === 0) break;
      }
      addStreet(tilesFromVerts(averts), 2, 1, 1);
    }
  }

  // Stage 3d — 'bourgRue' spurs: 1-3 short perpendicular stubs, the whole
  // secondary network of a linear village.
  if (archetype === 'bourgRue') {
    for (let i = 0, n = 1 + r3.int(3); i < n; i++) {
      const sx = clamp(place.x + (r3.int(2) === 0 ? -1 : 1) * (10 + r3.int(30)), ex0 + 4, ex1 - 4);
      const gy = grandeRueYAt(grandeRue, sx) ?? place.y;
      const dir = r3.next() < 0.5 ? -1 : 1;
      const len = 12 + r3.int(14);
      const ey = clamp(gy + dir * len, 4, h - 5);
      addStreet(tilesFromVerts([{ x: sx, y: gy }, { x: sx, y: ey }]), 2, 1, 1);
    }
  }

  // Stage 3e — 'faubourg': a detached secondary cluster 60-90 tiles along the
  // arterial, extending what mapgen.ts:153-161 already does for w >= 240. Its
  // dens is fringe-grade by construction (it is 60+ tiles from the place), so
  // the parcelizer gives it a loose hamlet rather than a second high street.
  let faubourg: Vec | null = null;
  if (archetype === 'faubourg') {
    const dir = place.x < w >> 1 ? 1 : -1;
    const fx = clamp(place.x + dir * (60 + r3.int(31)), 12, w - 13);
    const fy = roadY[fx];
    const half = 12 + r3.int(6);
    addStreet(
      tilesFromVerts([
        { x: fx, y: clamp(fy - half, 3, h - 4) },
        { x: fx, y: clamp(fy + half, 3, h - 4) },
      ]),
      2,
      1,
      1,
    );
    faubourg = { x: fx, y: fy };
  }

  return {
    w,
    h,
    base,
    profile,
    archetype,
    env,
    place,
    roadY,
    road,
    segs,
    streets,
    grandeRue,
    faubourg,
    S,
    densQ8,
  };
}

// y of the Grande Rue at column x, or null when x is off its span. Used by the
// approach routes (join point) and by T5 (the widening must not straddle a jog).
export function grandeRueYAt(grandeRue: Seg[], x: number): number | null {
  for (const s of grandeRue) {
    if (s.axis !== 'h') continue;
    if (x >= Math.min(s.ax, s.bx) && x <= Math.max(s.ax, s.bx)) return s.ay;
  }
  return null;
}

// The straight run of the Grande Rue containing column x — the place widening
// is clipped to it.
export function grandeRueRunAt(grandeRue: Seg[], x: number): Seg | null {
  for (const s of grandeRue) {
    if (s.axis !== 'h') continue;
    if (x >= Math.min(s.ax, s.bx) && x <= Math.max(s.ax, s.bx)) return s;
  }
  return null;
}

// ── stage 5 — minor streets ──────────────────────────────────────────────────

// §2.2 stage 5: the growth loop's hard cap is KindProfile.maxStreets, and
// KindProfile.minStreets is its floor. The doc caps the loop and says nothing
// about a minimum, but the branch schedule (one attempt per 18-32 tiles, p
// 0.55) can legitimately produce a 71x80 'bourgRue' envelope with THREE streets
// in it — measured on seed 5 — which yields 12 plots and cannot reach §5.2's
// ">= 40 buildings". So the growth schedule gets a bounded reroll, the same
// shape as stage 10's gate reroll and stage 12's attempt reroll: up to two
// extra rounds that re-root the rank-0/1 streets and take every branch offered.
// Still one sub-stream, still deterministic, still capped.
const GROWTH_ROUNDS = 3;
const SNAP_RADIUS = 4; // the single most important number in localConstraints
const PARALLEL_SPACING = 8; // reject a proposal running alongside an existing road
const PARALLEL_TOLERANCE = 12; // …for this many consecutive tiles
const MIN_SPUR = 8; // §2.2: every dead-end spur shorter than this is pruned

export interface GrowthInput {
  resv: Uint8Array; // stage-4 reservations; 0 = free
}

/**
 * Parish & Müller's growth loop, stripped of the L-system framing and of all
 * angles (§2.2 stage 5). Runs AFTER landmark reservation so streets route
 * around the landmarks — that routing-around is what produces the
 * characteristic tangent-street ring, and for the 'enclos' archetype it is the
 * whole skeleton.
 *
 * The priority queue keys on (t, insertionIndex) and never on t alone: a bare
 * float key with ties is a non-deterministic ordering the moment two segments
 * are pushed in the same generation.
 *
 * Dead-end pruning is done as pre-carve REJECTION rather than as the doc's
 * post-pass: a proposal whose truncated length falls under MIN_SPUR is simply
 * not carved. Same end state, no un-carving, and `road` is never transiently
 * wrong for the next proposal's localConstraints scan.
 */
export function growMinorStreets(sk: Skeleton, input: GrowthInput): void {
  const { w, h, road, segs, streets } = sk;
  const { minStreets, maxStreets } = sk.profile;
  const { resv } = input;
  const r5 = sk.S(TAG.MINOR);
  const ex0 = sk.env.x;
  const ex1 = sk.env.x + sk.env.w - 1;
  const ey0 = sk.env.y;
  const ey1 = sk.env.y + sk.env.h - 1;
  const inPlay = (x: number, y: number): boolean => x >= 3 && y >= 3 && x < w - 3 && y < h - 3;

  // (t, insertionIndex) total order, popped min-first. At <= 24 streets a
  // linear scan is cheaper than a heap and is obviously deterministic.
  interface Entry {
    st: Street;
    seq: number;
  }
  const pq: Entry[] = [];
  let seq = 0;
  for (const st of streets) pq.push({ st, seq: seq++ });
  const pop = (): Entry | null => {
    let bi = -1;
    for (let i = 0; i < pq.length; i++) {
      if (bi < 0 || pq[i].st.t < pq[bi].st.t || (pq[i].st.t === pq[bi].st.t && pq[i].seq < pq[bi].seq)) bi = i;
    }
    return bi < 0 ? null : pq.splice(bi, 1)[0];
  };

  let branches = 0;
  let round = 0;

  const accept = (tiles: Vec[], width: 1 | 2 | 3, rank: 0 | 1 | 2 | 3, t: number): Street | null => {
    if (tiles.length < MIN_SPUR) return null;
    const made = segsFromTiles(tiles, width, rank, t);
    for (const s of made) carveSeg(road, w, h, s, resv);
    segs.push(...made);
    const st: Street = { tiles, width, rank, t, cursor: 0, mouths: [] };
    streets.push(st);
    pq.push({ st, seq: seq++ });
    return st;
  };

  for (; round < GROWTH_ROUNDS; round++) {
    if (round > 0) {
      if (streets.length >= minStreets) break;
      for (const st of streets) if (st.rank <= 1) {
        st.cursor = 0;
        pq.push({ st, seq: seq++ });
      }
    }
    growRound();
  }

  function growRound(): void {
  while (streets.length < maxStreets) {
    const e = pop();
    if (!e) break;
    const parent = e.st;
    if (parent.rank >= 3) continue;
    const root = parent.cursor + 18 + r5.int(15);
    if (root >= parent.tiles.length - 6) continue; // no room left on this street
    parent.cursor = root;
    // the parent goes back in the queue one generation later, so a long street
    // keeps branching without starving the streets behind it
    pq.push({ st: parent, seq: seq++ });
    // Two street mouths within 8 tiles of each other is not a plan, and it is
    // also what breaks §5.2's MG-lane cap: two width-2 streets leaving the
    // Grande Rue one tile apart carve a third road row alongside it and splice
    // two of its straight runs together. Reachable because a retry round
    // re-roots a street's cursor at 0, so round 1 can land on round 0's mouth.
    if (parent.mouths.some((m) => Math.abs(m - root) < 8)) continue;
    // the draw happens either way so the stream position never depends on the
    // round; only the decision changes
    if (r5.next() >= 0.55 && round === 0) continue; // p_branch

    const rp = parent.tiles[root];
    const prev = parent.tiles[root - 1];
    const vertical = prev.y === rp.y; // parent runs horizontally → proposal is vertical
    // higher-dens side with p 0.65, else the other; an exact tie (a root on the
    // Grande Rue, where both flanks are equidistant from the place) alternates
    // on the branch counter rather than on a coin, so the two sides stay even
    const dA = vertical ? sk.densQ8(rp.x, rp.y - 1) : sk.densQ8(rp.x - 1, rp.y);
    const dB = vertical ? sk.densQ8(rp.x, rp.y + 1) : sk.densQ8(rp.x + 1, rp.y);
    let dir = dA > dB ? -1 : dB > dA ? 1 : branches & 1 ? -1 : 1;
    if (r5.next() >= 0.65) dir = -dir;
    branches++;
    const len = 20 + r5.int(36);
    const width: 1 | 2 | 3 = Math.max(1, parent.width - 1) as 1 | 2 | 3;
    const rank = (parent.rank + 1) as 1 | 2 | 3;

    // proposal polyline: rank-1/2 streets get their own jog schedule — a side
    // street running 40 tiles dead straight is the other thing that reads as
    // generated
    const pverts: Vec[] = [{ x: rp.x, y: rp.y }];
    let px = rp.x;
    let py = rp.y;
    let travelled = 0;
    let nextJog = 15 + r5.int(46);
    while (travelled < len) {
      const step = Math.min(len - travelled, nextJog);
      if (vertical) py = clamp(py + dir * step, 3, h - 4);
      else px = clamp(px + dir * step, 3, w - 4);
      pverts.push({ x: px, y: py });
      travelled += step;
      if (travelled >= len) break;
      const off = (r5.next() < 0.5 ? -1 : 1) * JOG(r5, width);
      if (vertical) px = clamp(px + off, 3, w - 4);
      else py = clamp(py + off, 3, h - 4);
      pverts.push({ x: px, y: py });
      nextJog = 15 + r5.int(46);
    }

    const raw = tilesFromVerts(pverts);

    // ── localConstraints ────────────────────────────────────────────────
    // The scan starts at the first tile clear of ROAD, not at a fixed offset
    // from the parent's centreline: a branch rooted inside the stage-4 place
    // widening is 5-8 tiles deep in pavement, and a fixed skip of 3 makes it
    // report an instant T-junction with the place and die. Measured on seed 5,
    // that killed most of the Grande Rue's branch attempts and left a 71x80
    // 'bourgRue' envelope with three streets in it.
    let skip = 1;
    while (skip < 16 && skip < raw.length && road[raw[skip].y * w + raw[skip].x]) skip++;
    if (skip >= 16 || skip >= raw.length) continue;
    let cut = raw.length;
    let hitRoad = false;
    let hitResv = -1;
    for (let i = skip; i < raw.length; i++) {
      const p = raw[i];
      if (!inPlay(p.x, p.y)) {
        cut = i;
        break;
      }
      const idx = p.y * w + p.x;
      if (resv[idx]) {
        hitResv = i;
        cut = i; // truncate AT the reservation boundary
        break;
      }
      if (road[idx]) {
        cut = i; // T-junction: the last carved tile abuts the existing road
        hitRoad = true;
        break;
      }
    }
    let tiles = raw.slice(0, cut);

    // endpoint within SNAP_RADIUS of a road → extend up to that far to touch.
    // Without this, side streets dead-end three tiles short of the street they
    // should have met and the whole network reads as noise instead of a plan.
    if (!hitRoad && hitResv < 0 && tiles.length >= 2) {
      const end = tiles[tiles.length - 1];
      const back = tiles[tiles.length - 2];
      const sxu = Math.sign(end.x - back.x);
      const syu = Math.sign(end.y - back.y);
      for (let k = 1; k <= SNAP_RADIUS; k++) {
        const nx = end.x + sxu * k;
        const ny = end.y + syu * k;
        if (!inPlay(nx, ny) || resv[ny * w + nx]) break;
        if (road[ny * w + nx]) {
          for (let j = 1; j < k; j++) tiles.push({ x: end.x + sxu * j, y: end.y + syu * j });
          hitRoad = true;
          break;
        }
      }
    }

    // MIN_SPUR measures the NEW length: a spur that is eight tiles of existing
    // pavement plus two of its own is a dead-end stub, not a street
    if (tiles.length - skip < MIN_SPUR) continue;
    if (parallelReject(road, w, h, tiles, vertical, skip)) continue;
    const carved = accept(tiles, width, rank, parent.t + 1);
    if (!carved) continue;
    parent.mouths.push(root);

    // A proposal stopped by a reservation gets its continuation pushed as a
    // TANGENT street hugging the reservation boundary. That is the mechanism
    // behind the characteristic ring of streets around a churchyard, and for
    // 'enclos' it is the archetype's entire signature — no special case.
    if (hitResv > 0 && streets.length < maxStreets) {
      // the LAST FREE tile, not the reserved one: the tangent has to run along
      // the boundary and share a tile with the street that stopped there, or it
      // is an isolated line of road inside the reservation
      const stop = raw[hitResv - 1];
      const tan = tangentAlong(resv, w, h, stop, vertical, dir, ex0, ex1, ey0, ey1);
      if (tan) accept(tan, width, Math.min(3, rank + 1) as 1 | 2 | 3, parent.t + 1);
    }
  }
  }
}

// A proposal running alongside an existing parallel road at spacing < 8 for
// more than PARALLEL_TOLERANCE consecutive tiles is rejected: two streets one
// plot apart is not a town, it is a grid artefact. The first 8 tiles are
// exempt — the parent street is by definition parallel-adjacent there.
function parallelReject(road: Uint8Array, w: number, h: number, tiles: Vec[], vertical: boolean, skip: number): boolean {
  if (tiles.length - skip < PARALLEL_TOLERANCE) return false;
  for (const side of [-1, 1]) {
    let run = 0;
    for (let i = skip + 8; i < tiles.length; i++) {
      const p = tiles[i];
      let near = false;
      for (let k = 1; k < PARALLEL_SPACING && !near; k++) {
        const nx = vertical ? p.x + side * k : p.x;
        const ny = vertical ? p.y : p.y + side * k;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        if (road[ny * w + nx]) near = true;
      }
      run = near ? run + 1 : 0;
      if (run >= PARALLEL_TOLERANCE) return true;
    }
  }
  return false;
}

// The tangent street at a reservation boundary: from the tile where the
// proposal stopped, run PERPENDICULAR to it along the reservation's edge for
// as far as the reservation extends, plus one tile of overshoot at each end so
// the tangent meets whatever is beyond it.
function tangentAlong(
  resv: Uint8Array,
  w: number,
  h: number,
  stop: Vec,
  vertical: boolean,
  dir: number,
  ex0: number,
  ex1: number,
  ey0: number,
  ey1: number,
): Vec[] | null {
  const rx = stop.x;
  const ry = stop.y;
  // the tile one step further in the proposal's direction must be reserved
  // (that is the boundary we are hugging) AND the tangent's own tile must not
  // be, or the chamfer staircase puts the tangent's centreline inside the
  // enclosure and the clipped carve leaves it in two disconnected pieces
  const probe = (a: number): boolean => {
    const px = vertical ? a : rx + dir;
    const py = vertical ? ry + dir : a;
    const ox = vertical ? a : rx;
    const oy = vertical ? ry : a;
    if (px < 0 || py < 0 || px >= w || py >= h) return false;
    return resv[py * w + px] !== 0 && resv[oy * w + ox] === 0;
  };
  const at = vertical ? stop.x : stop.y;
  if (!probe(at)) return null;
  let lo = at;
  let hi = at;
  while (probe(lo - 1)) lo--;
  while (probe(hi + 1)) hi++;
  const loLim = vertical ? ex0 + 2 : ey0 + 2;
  const hiLim = vertical ? ex1 - 2 : ey1 - 2;
  lo = Math.max(lo - 1, loLim);
  hi = Math.min(hi + 1, hiLim);
  if (hi - lo < MIN_SPUR) return null;
  return vertical
    ? tilesFromVerts([{ x: lo, y: stop.y }, { x: hi, y: stop.y }])
    : tilesFromVerts([{ x: stop.x, y: lo }, { x: stop.x, y: hi }]);
}
