import { EDGE, type EdgeType, type GameMap } from '../map';
import type { Building, Rect } from '../mapgen';
import type { Rng } from '../rng';
import { inMass, putH, putV, type Interior } from './kernel';
import type { Room, RoomKind, RoomPlan } from './types';

// ═══ INTERIORS — THE CHURCH PARTITIONER (I6) ════════════════════════════════
//
// docs/plans/2026-07-26-interiors-design.md §3.6, against the contract in
// ./types.ts and the primitives in ./kernel.ts. Runs after `resetInterior`, like
// every other partitioner, and writes its walls straight into the map.
//
// The church is the one structure the ≤3-wall-line cap does not apply to, and
// it is why `Plan` (rooms.ts) is deliberately not used here: an arcade, a
// chancel wall, a sacristy corner and the tower wall are five lines minimum and
// the cap's whole point — "a diced house is a maze" — is an argument about
// 7x8 houses, not about a 30x9 church whose lines are 20 tiles apart. The three
// invariants that DO hold are enforced the same way: nothing sealed (the
// kernel's BFS), the stair is never moved, and every room is reachable.
//
// Its own local frame, not rooms.ts' `Frame`. `frameOf` takes the frontage from
// `it.doors[0]`, which for a church group is whichever of the nave / tower /
// apse doors has the lowest tile index — on bourg seed 3 that is the TOWER's
// door, and a frame hung off it makes "across" the church's long axis. The
// church has a better axis available for free: the LITURGICAL one, tower (west)
// → apse (east). Every number in §3.6 is stated in it.
//
//   deep   = west → east, the nave's long axis. The chancel is at the east end.
//   across = perpendicular. Arcades run along deep at across offsets from the
//            nave's low-coordinate flank.

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const ARCADE_AISLE = 2; // §3.6: an arcade produces a 2-tile side aisle
const ARCADE_PERIOD = 3; // WALL at every 3rd position, NONE elsewhere — piers and gaps
const MIN_AISLED = 9; // nave across-extent that earns one arcade
const MIN_TWIN_AISLED = 13; // …and the extent that earns the second
const MIN_SACRISTY_A = 7; // chancel across-extent that earns a sacristy
const SACRISTY_A = 3; // the sacristy is 3 tiles across, 2-3 deep

const rectOf = (b: Building): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });
const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/**
 * The liturgical frame of a church group, plus every line §3.6 derives from it.
 *
 * Exported because I7's furniture table needs the same geometry: the pews are
 * laid inside the central vessel this computes, hugging the arcade this places,
 * and the altar sits east of this chancel line. Recomputing it there from the
 * room tiles would be a second source of truth for the one piece of geometry
 * where the two slices must agree exactly.
 */
export interface ChurchFrame {
  axis: 'x' | 'y'; // which world axis the liturgical (west→east) axis runs on
  dir: 1 | -1; // +1 when east is the increasing world coordinate
  nave: Rect;
  tower: Rect | null;
  apse: Rect | null;
  a0: number; // nave across range [a0, a1), world coordinates on the across axis
  a1: number;
  d0: number; // nave deep range [d0, d1), world coordinates on the deep axis
  d1: number;
  arcadeLo: number; // across grid line of the low-side arcade, -1 when absent
  arcadeHi: number; // …and of the high-side one
  v0: number; // the central vessel's across range [v0, v1) — inside the arcades
  v1: number;
  aisle0: number; // the central aisle's across range [aisle0, aisle1)
  aisle1: number;
  chancel: number; // deep grid line of the chancel wall
  arch0: number; // the chancel arch's across range [arch0, arch1) — EDGE.NONE
  arch1: number;
  sacristy: Rect | null;
}

// World tile of a (deep, across) pair.
export const churchTile = (f: ChurchFrame, d: number, a: number): { x: number; y: number } =>
  f.axis === 'x' ? { x: d, y: a } : { x: a, y: d };
export const churchDeep = (f: ChurchFrame, x: number, y: number): number => (f.axis === 'x' ? x : y);
export const churchAcross = (f: ChurchFrame, x: number, y: number): number => (f.axis === 'x' ? y : x);
/** Is this deep coordinate east of the chancel wall? */
export const isChancel = (f: ChurchFrame, d: number): boolean => (f.dir === 1 ? d >= f.chancel : d < f.chancel);

/**
 * Build the frame and take EVERY rng draw, in a fixed order, before any
 * geometry test — so a church's draw count never depends on whether it was big
 * enough for an aisle or a sacristy. Same discipline as planShop's two draws.
 */
export function churchFrame(it: Interior, s1: Rng): ChurchFrame {
  const chancelOff = 4 + s1.int(3); // §3.6: chancel wall at deep D - (4 + int(3))
  const archW = 2 + s1.int(2); // the chancel arch is 2-3 wide
  const sacD = 2 + s1.int(2); // the sacristy is 2-3 deep

  const bs = it.struct.buildings;
  const tower = bs.find((b) => b.role === 'church_tower') ?? null;
  const apse = bs.find((b) => b.role === 'church_apse') ?? null;
  let lead = bs.find((b) => b.role === 'church') ?? null;
  if (!lead) {
    // A hand-built group, or a lone tower/apse: the biggest mass that is not
    // the tower or the apse is the nave; failing that, the leader itself.
    let bestArea = -1;
    for (const b of bs) {
      if (b === tower || b === apse) continue;
      if (b.w * b.h > bestArea) {
        bestArea = b.w * b.h;
        lead = b;
      }
    }
    lead ??= bs[0];
  }
  const nave = rectOf(lead);
  const ref = tower ?? apse;
  let axis: 'x' | 'y';
  let dir: 1 | -1;
  if (ref && ref !== lead) {
    const dx = nave.x + nave.w / 2 - (ref.x + ref.w / 2);
    const dy = nave.y + nave.h / 2 - (ref.y + ref.h / 2);
    axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    const delta = axis === 'x' ? dx : dy;
    // the tower stands at the WEST end and the apse at the EAST one, so the
    // same offset reads with opposite sign depending on which one we have
    dir = ((tower && ref === tower ? delta : -delta) >= 0 ? 1 : -1) as 1 | -1;
  } else {
    axis = nave.w >= nave.h ? 'x' : 'y';
    dir = 1;
  }

  const a0 = axis === 'x' ? nave.y : nave.x;
  const a1 = a0 + (axis === 'x' ? nave.h : nave.w);
  const d0 = axis === 'x' ? nave.x : nave.y;
  const d1 = d0 + (axis === 'x' ? nave.w : nave.h);
  const A = a1 - a0;
  const D = d1 - d0;

  // ── arcades ───────────────────────────────────────────────────────────────
  // §3.6 writes "at across-index 2 (and at A-3 when A >= 13)". The second line
  // is MIRRORED to a1 - ARCADE_AISLE rather than taken literally: the sentence
  // ends "producing 2-tile side aisles", and A-3 produces a 3-tile one. Both
  // firing at A >= 9 was rejected — it leaves a 5-wide central vessel, which is
  // 1 clear tile each side + a 2-wide aisle + one tile of pews.
  const arcadeLo = A >= MIN_AISLED ? a0 + ARCADE_AISLE : -1;
  const arcadeHi = A >= MIN_TWIN_AISLED ? a1 - ARCADE_AISLE : -1;
  const v0 = arcadeLo >= 0 ? arcadeLo : a0;
  const v1 = arcadeHi >= 0 ? arcadeHi : a1;
  const vesselW = v1 - v0;

  // ── the central aisle ─────────────────────────────────────────────────────
  // §4.3's pew geometry, computed here because the chancel arch is centred on
  // it and because the keep-clear mask has to protect it as the spine.
  const aisleW = Math.min(vesselW, 2 + (vesselW >= 8 ? 1 : 0));
  const aisle0 = v0 + ((vesselW - aisleW) >> 1);
  const aisle1 = aisle0 + aisleW;

  // ── the chancel wall ──────────────────────────────────────────────────────
  const k = clamp(D - chancelOff, 2, Math.max(2, D - 2));
  const chancel = dir === 1 ? d0 + k : d1 - k;
  const aw = Math.min(archW, A);
  const arch0 = clamp(aisle0 + ((aisle1 - aisle0 - aw) >> 1), a0, a1 - aw);
  const arch1 = arch0 + aw;

  // ── the sacristy ──────────────────────────────────────────────────────────
  // A 3 x (2..3) room in the chancel corner, hard against the chancel wall.
  // §3.6 asks for "a chancel corner"; this picks the deterministic one — the
  // flank away from a single arcade, so the aisle keeps its own east end.
  //
  // It MUST NOT overlap the arch across-wise: the sacristy's west side is the
  // chancel wall, and `enclose` would write WALL back over the arch positions
  // it shares, narrowing the arch to whatever was left. On a 7-wide nave with a
  // 3-wide arch that is exactly what happens, so the other flank is tried and
  // the sacristy is dropped when both overlap.
  const chancelD = D - k; // depth of the chancel, west wall to the nave's east end
  let sacristy: Rect | null = null;
  if (A >= MIN_SACRISTY_A && chancelD >= sacD + 2) {
    const near = arcadeLo >= 0 && arcadeHi < 0 ? a1 - SACRISTY_A : a0;
    const far = near === a0 ? a1 - SACRISTY_A : a0;
    const clears = (s: number): boolean => s + SACRISTY_A <= arch0 || s >= arch1;
    const sa0 = clears(near) ? near : clears(far) ? far : -1;
    const sd0 = dir === 1 ? chancel : chancel - sacD;
    if (sa0 >= 0)
      sacristy =
        axis === 'x' ? { x: sd0, y: sa0, w: sacD, h: SACRISTY_A } : { x: sa0, y: sd0, w: SACRISTY_A, h: sacD };
  }

  return { axis, dir, nave, tower, apse, a0, a1, d0, d1, arcadeLo, arcadeHi, v0, v1, aisle0, aisle1, chancel, arch0, arch1, sacristy };
}

/**
 * §3.6, in order: the arcades, the chancel wall and its arch, the sacristy, and
 * the tower door.
 *
 * Every wall carries `it.top`, which for a church group is the MAXIMUM storey
 * count over the mass — 4 * FLOOR_H = 12, the tower's height, on the nave's own
 * partitions too. That is what the kernel gives every structure and it is
 * behaviourally identical here: `los()` blocks while the eye-line is below the
 * top, and the nave is 2 storeys, so no eye inside this mass is ever above 7.6 m.
 * A per-edge top would be a new kernel field bought with nothing.
 */
export function planChurch(map: GameMap, it: Interior, s1: Rng): RoomPlan {
  const f = churchFrame(it, s1);
  const top = it.top;

  // A wall running ALONG the deep axis, at across grid line `aLine`.
  const putDeep = (aLine: number, d: number, e: EdgeType): void =>
    f.axis === 'x' ? putH(map, d, aLine, e, top) : putV(map, aLine, d, e, top);
  const deepFlanks = (aLine: number, d: number): boolean =>
    f.axis === 'x'
      ? inMass(it, d, aLine - 1) && inMass(it, d, aLine)
      : inMass(it, aLine - 1, d) && inMass(it, aLine, d);
  // A wall running ALONG the across axis, at deep grid line `dLine`.
  const putAcross = (dLine: number, a: number, e: EdgeType): void =>
    f.axis === 'x' ? putV(map, dLine, a, e, top) : putH(map, a, dLine, e, top);
  const acrossFlanks = (dLine: number, a: number): boolean =>
    f.axis === 'x'
      ? inMass(it, dLine - 1, a) && inMass(it, dLine, a)
      : inMass(it, a, dLine - 1) && inMass(it, a, dLine);

  // ── arcades: piers and gaps, never doors ─────────────────────────────────
  // §3.6 is explicit that these are not EDGE.DOORs: `canStep` allows only
  // orthogonal transits through a DOOR (path.ts's diagonal rule), which would
  // turn a side aisle into a row of one-way turnstiles. WALL at every third
  // position and NONE between gives free movement and partial LOS blocking,
  // which is what an arcade does in a real fight.
  const aisleFrom = f.dir === 1 ? f.d0 : f.chancel;
  const aisleTo = f.dir === 1 ? f.chancel : f.d1;
  for (const aLine of [f.arcadeLo, f.arcadeHi]) {
    if (aLine < 0) continue;
    for (let d = aisleFrom; d < aisleTo; d++) {
      const pier = f.dir === 1 ? d - f.d0 : f.d1 - 1 - d;
      if (pier % ARCADE_PERIOD !== 0) continue;
      if (!deepFlanks(aLine, d)) continue;
      putDeep(aLine, d, EDGE.WALL);
    }
  }

  // ── the chancel wall, broken by the arch ─────────────────────────────────
  for (let a = f.a0; a < f.a1; a++) {
    if (a >= f.arch0 && a < f.arch1) continue; // the arch: a contiguous NONE span
    if (!acrossFlanks(f.chancel, a)) continue;
    putAcross(f.chancel, a, EDGE.WALL);
  }

  // ── the sacristy, then the tower ─────────────────────────────────────────
  // Seeds: the sacristy's door is wanted on the CHANCEL side, so its seed is
  // the chancel's own centre; the tower door is wanted on the church's axis, so
  // its seed is the west end of the central aisle.
  if (f.sacristy) {
    const cd = f.dir === 1 ? (f.chancel + f.d1) >> 1 : (f.d0 + f.chancel) >> 1;
    enclose(map, it, f.sacristy, churchTile(f, cd, (f.v0 + f.v1 - 1) >> 1), top);
  }
  if (f.tower) {
    const west = f.dir === 1 ? f.d0 : f.d1 - 1;
    enclose(map, it, rectOf(f.tower), churchTile(f, west, (f.aisle0 + f.aisle1 - 1) >> 1), top);
  }

  return { rooms: churchRooms(map, it, f), spine: spineTiles(map, it, f) };
}

/**
 * Wall off `r` from the rest of the mass and cut exactly ONE door into it.
 *
 * Orientation-free on purpose: it serves both the tower (§3.6's "the tower
 * mask's shared span with the nave becomes EDGE.WALL with exactly one
 * EDGE.DOOR") and the sacristy ("a 3x(2..3) room in a chancel corner with a
 * single door"), and neither has a fixed relationship to the world axes. Only
 * edges with BOTH flanks in the mass are written, so the exterior envelope,
 * its windows and its doors are never touched (D10) — a tower with its own
 * west door keeps it.
 *
 * The door is the boundary position nearest `seed` in Manhattan distance
 * between edge midpoints, ties to horizontal-before-vertical then low y then
 * low x. Deterministic, no rng, exactly as §3.1's door rule.
 */
function enclose(map: GameMap, it: Interior, r: Rect, seed: { x: number; y: number }, top: number): boolean {
  const cands: { x: number; y: number; h: boolean; d: number }[] = [];
  for (let y = r.y; y <= r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      if (inRect(r, x, y - 1) === inRect(r, x, y)) continue;
      if (!inMass(it, x, y - 1) || !inMass(it, x, y)) continue;
      putH(map, x, y, EDGE.WALL, top);
      cands.push({ x, y, h: true, d: Math.abs(2 * x - 2 * seed.x) + Math.abs(2 * y - 1 - 2 * seed.y) });
    }
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x <= r.x + r.w; x++) {
      if (inRect(r, x - 1, y) === inRect(r, x, y)) continue;
      if (!inMass(it, x - 1, y) || !inMass(it, x, y)) continue;
      putV(map, x, y, EDGE.WALL, top);
      cands.push({ x, y, h: false, d: Math.abs(2 * x - 1 - 2 * seed.x) + Math.abs(2 * y - 2 * seed.y) });
    }
  if (cands.length === 0) return false;
  let best = cands[0];
  for (const c of cands)
    if (c.d < best.d || (c.d === best.d && (c.h !== best.h ? c.h : c.y !== best.y ? c.y < best.y : c.x < best.x))) best = c;
  if (best.h) putH(map, best.x, best.y, EDGE.DOOR, 0);
  else putV(map, best.x, best.y, EDGE.DOOR, 0);
  return true;
}

// The central aisle, west of the chancel wall only. It stops there on purpose:
// the spine is keep-clear, and the altar has to stand somewhere.
function spineTiles(map: GameMap, it: Interior, f: ChurchFrame): number[] {
  const out: number[] = [];
  for (const t of it.tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    const a = churchAcross(f, x, y);
    const d = churchDeep(f, x, y);
    if (a < f.aisle0 || a >= f.aisle1) continue;
    if (d < f.d0 || d >= f.d1 || isChancel(f, d)) continue;
    out.push(t);
  }
  return out;
}

// Every tile of the mass gets exactly one room, the same contract the house,
// shop and barn plans hold to.
function churchRooms(map: GameMap, it: Interior, f: ChurchFrame): Room[] {
  const byKind = new Map<RoomKind, number[]>();
  const push = (kind: RoomKind, t: number): void => {
    const list = byKind.get(kind);
    if (list) list.push(t);
    else byKind.set(kind, [t]);
  };
  for (const t of it.tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    if (f.tower && inRect(f.tower, x, y)) {
      push('tower', t);
      continue;
    }
    if (f.sacristy && inRect(f.sacristy, x, y)) {
      push('sacristy', t);
      continue;
    }
    if (f.apse && inRect(f.apse, x, y)) {
      push('chancel', t);
      continue;
    }
    const d = churchDeep(f, x, y);
    if (isChancel(f, d)) {
      push('chancel', t);
      continue;
    }
    const a = churchAcross(f, x, y);
    push((f.arcadeLo >= 0 && a < f.arcadeLo) || (f.arcadeHi >= 0 && a >= f.arcadeHi) ? 'aisle' : 'nave', t);
  }
  // Fixed order so the plan reads the same whichever way the church faces.
  const order: RoomKind[] = ['nave', 'aisle', 'chancel', 'sacristy', 'tower'];
  return order.filter((k) => byKind.has(k)).map((kind) => ({ kind, tiles: byKind.get(kind) as number[] }));
}
