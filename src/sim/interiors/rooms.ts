import type { GameMap } from '../map';
import type { BuildingRole } from '../mapgen';
import type { Rng } from '../rng';
import { planChurch } from './church';
import { inMass, wallRun, type Interior } from './kernel';
import { PLAN_BY_ROLE, type Room, type RoomKind, type RoomPlan } from './types';

// ═══ INTERIORS — ROOM PARTITIONERS (I4 house/farmhouse/townhouse, I5 shop/barn)
//
// docs/plans/2026-07-26-interiors-design.md §3.2-§3.5, against the contract in
// ./types.ts and the primitives in ./kernel.ts. A partitioner runs AFTER
// `resetInterior` and writes its walls straight into the map; the RoomPlan it
// returns is transient (D8 — rooms are never persisted) and feeds two
// consumers only: the keep-clear mask's spine seed, and I7's furniture tables.
//
// Three rules hold for every plan, every role:
//  - AT MOST THREE WALL LINES per structure. More and a 7x8 house is a maze:
//    every interior wall is a full-height LOS block, so a diced interior turns
//    room-clearing from a fight into a slog and starves the AI of garrison
//    tiles with a line out of a window. Asserted below, not merely intended.
//    A line broken into several spans (a cross wall interrupted by the hall) is
//    ONE line — that is what the cap is about.
//  - Door position is deterministic, no rng (kernel's wallRun). Variety comes
//    from split POSITIONS; variety in door positions buys nothing and costs a
//    stream.
//  - INTERIORS NEVER MOVES A STAIR. The stamper's tile is read, never written.
//    Everything a stair needs — reachability, a fightable landing — comes from
//    the keep-clear mask, not from the plan.

const MAX_WALL_LINES = 3;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ── the local frame ─────────────────────────────────────────────────────────
//
// §3.1's axes: `across` (extent A) runs parallel to the frontage wall — the
// wall the primary door sits in — and `deep` (extent D) runs perpendicular,
// with deep 0 the frontage row. Every plan below is written once in (a, d) and
// mapped onto the four possible frontages by crossWall/longWall.
export interface Frame {
  side: 'n' | 's' | 'e' | 'w'; // the outward normal of the frontage wall
  A: number;
  D: number;
  doorA: number; // across index of the primary door's interior tile
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  seed: { x: number; y: number }; // circulation seed for wallRun's door rule
}

export function frameOf(map: GameMap, it: Interior): Frame {
  const d = it.doors[0];
  const x0 = it.x0;
  const y0 = it.y0;
  const x1 = it.x0 + it.w;
  const y1 = it.y0 + it.h;
  // A mass whose envelope the stamper left doorless (never true of a stamped
  // building — resolveDoors throws first) still has to yield a deterministic
  // plan: assume a south frontage seeded on the mass's first tile.
  const side = d ? d.side : 's';
  const seed = d ? { x: d.x, y: d.y } : { x: it.tiles[0] % map.w, y: (it.tiles[0] / map.w) | 0 };
  const horizontalFrontage = side === 'n' || side === 's';
  const A = horizontalFrontage ? x1 - x0 : y1 - y0;
  const D = horizontalFrontage ? y1 - y0 : x1 - x0;
  const doorA = d ? (horizontalFrontage ? d.x - x0 : d.y - y0) : A >> 1;
  return { side, A, D, doorA, x0, y0, x1, y1, seed };
}

export const tileX = (f: Frame, a: number, d: number): number =>
  f.side === 'n' || f.side === 's' ? f.x0 + a : f.side === 'w' ? f.x0 + d : f.x1 - 1 - d;
export const tileY = (f: Frame, a: number, d: number): number =>
  f.side === 'n' ? f.y0 + d : f.side === 's' ? f.y1 - 1 - d : f.y0 + a;
export const aOf = (f: Frame, x: number, y: number): number => (f.side === 'n' || f.side === 's' ? x - f.x0 : y - f.y0);
export const dOf = (f: Frame, x: number, y: number): number =>
  f.side === 'n' ? y - f.y0 : f.side === 's' ? f.y1 - 1 - y : f.side === 'w' ? x - f.x0 : f.x1 - 1 - x;

// The wall separating deep index d-1 from deep index d, over across [a0, a1).
function crossWall(map: GameMap, it: Interior, f: Frame, d: number, a0: number, a1: number, doors: boolean): void {
  if (d < 1 || d > f.D - 1) throw new Error(`interiors crossWall: deep ${d} outside [1,${f.D - 1}]`);
  const o = { doors };
  if (f.side === 'n') wallRun(map, it, 'h', f.y0 + d, f.x0 + a0, f.x0 + a1, it.top, f.seed, o);
  else if (f.side === 's') wallRun(map, it, 'h', f.y1 - d, f.x0 + a0, f.x0 + a1, it.top, f.seed, o);
  else if (f.side === 'w') wallRun(map, it, 'v', f.x0 + d, f.y0 + a0, f.y0 + a1, it.top, f.seed, o);
  else wallRun(map, it, 'v', f.x1 - d, f.y0 + a0, f.y0 + a1, it.top, f.seed, o);
}

// The wall separating across index a-1 from across index a, over deep [d0, d1).
function longWall(map: GameMap, it: Interior, f: Frame, a: number, d0: number, d1: number, doors: boolean): void {
  if (a < 1 || a > f.A - 1) throw new Error(`interiors longWall: across ${a} outside [1,${f.A - 1}]`);
  const o = { doors };
  if (f.side === 'n') wallRun(map, it, 'v', f.x0 + a, f.y0 + d0, f.y0 + d1, it.top, f.seed, o);
  else if (f.side === 's') wallRun(map, it, 'v', f.x0 + a, f.y1 - d1, f.y1 - d0, it.top, f.seed, o);
  else if (f.side === 'w') wallRun(map, it, 'h', f.y0 + a, f.x0 + d0, f.x0 + d1, it.top, f.seed, o);
  else wallRun(map, it, 'h', f.y0 + a, f.x1 - d1, f.x1 - d0, it.top, f.seed, o);
}

// ── plan builder ────────────────────────────────────────────────────────────
//
// Collects rooms, enforces the wall-line cap, and drops rooms whose local-frame
// rect contains no tile of the mass (an L's bbox has corners belonging to
// nobody).
class Plan {
  readonly rooms: Room[] = [];
  spine: number[] = [];
  private readonly lines = new Set<string>();

  constructor(
    private readonly map: GameMap,
    private readonly it: Interior,
    readonly f: Frame,
  ) {}

  room(kind: RoomKind, a0: number, a1: number, d0: number, d1: number): Room | null {
    const tiles: number[] = [];
    for (const t of this.it.tiles) {
      const x = t % this.map.w;
      const y = (t / this.map.w) | 0;
      const a = aOf(this.f, x, y);
      const d = dOf(this.f, x, y);
      if (a >= a0 && a < a1 && d >= d0 && d < d1) tiles.push(t);
    }
    if (tiles.length === 0) return null;
    const r: Room = { kind, tiles };
    this.rooms.push(r);
    return r;
  }

  cross(d: number, a0: number, a1: number, doors = true): void {
    this.line(`c${d}`);
    crossWall(this.map, this.it, this.f, d, a0, a1, doors);
  }

  long(a: number, d0: number, d1: number, doors = true): void {
    this.line(`l${a}`);
    longWall(this.map, this.it, this.f, a, d0, d1, doors);
  }

  private line(id: string): void {
    this.lines.add(id);
    if (this.lines.size > MAX_WALL_LINES)
      throw new Error(`interiors: ${this.lines.size} wall lines in one structure, cap is ${MAX_WALL_LINES}`);
  }

  done(): RoomPlan {
    return { rooms: this.rooms, spine: this.spine };
  }
}

// ═══ I4 · house / farmhouse / townhouse (§3.2, §3.3) ════════════════════════

// The passage plan needs one across index for the passage and >= 3 for the
// block beside it; the depth split needs a >= 3 front room and a >= 2 back one.
// §3.2 states the SELECTOR (A in 5..6) rather than the plan's own limits, which
// is why the townhouse variant can use it on a wider frontage.
const canPassage = (f: Frame): boolean => f.A >= 4 && f.D >= 5;
const canSideEntry = (f: Frame): boolean => f.A >= 3 && f.D >= 4;

/**
 * §3.2's hall / passage / enfilade plans, plus §3.3's three townhouse variants.
 *
 * `townhouse` selects §3.3: the plan is drawn on S(1) with weights
 * 0.45 passage / 0.35 enfilade / 0.20 side-entry so a terrace run does not read
 * as five copies of one house, instead of being selected by frontage width.
 * The roll happens unconditionally and a variant whose preconditions the
 * geometry fails falls through to enfilade — never a re-roll, which would make
 * the draw count depend on geometry.
 */
export function planHouse(map: GameMap, it: Interior, s1: Rng, townhouse = false): RoomPlan {
  const f = frameOf(map, it);
  if (townhouse) {
    const r = s1.next();
    if (r < 0.45 && canPassage(f)) return passagePlan(map, it, f, s1);
    if (r >= 0.8 && canSideEntry(f)) return sideEntryPlan(map, it, f);
    return enfiladePlan(map, it, f, s1);
  }
  if (f.A >= 7 && f.D >= 5) return hallPlan(map, it, f, s1);
  if (f.A >= 5 && f.A <= 6 && canPassage(f)) return passagePlan(map, it, f, s1);
  return enfiladePlan(map, it, f, s1);
}

// The standard Normandy longère / two-up-two-down: a 2-tile hall spine from the
// front door to the back wall, four rooms flanking it, and ONE cross line
// broken by the hall — three wall lines exactly, which is the cap. Upstairs is
// the same shell (D1): the hall becomes the landing and the four rooms become
// bedrooms, which is how "bedrooms up" is expressed honestly on a single
// terrain layer.
function hallPlan(map: GameMap, it: Interior, f: Frame, s1: Rng): RoomPlan {
  const p = new Plan(map, it, f);
  const { A, D } = f;
  const hc = clamp(f.doorA - 1, 1, A - 3);
  const dk = clamp(2 + s1.int(D - 3), 2, D - 2);

  p.long(hc, 0, D);
  p.long(hc + 2, 0, D);
  p.cross(dk, 0, hc);
  p.cross(dk, hc + 2, A);

  const hall = p.room('hall', hc, hc + 2, 0, D);
  p.spine = hall ? hall.tiles.slice() : [];
  // The two front rooms hold the street windows and are parlors. Of the two
  // back rooms the one in the WIDER block is the kitchen — it is the one with
  // an unbroken wall run long enough for a hearth. The other is the scullery,
  // which the design treats as a parlor for furnishing (types.ts §C). Ties to
  // the low across index, so the choice never depends on iteration order.
  const kitchenLeft = hc >= A - hc - 2;
  p.room('parlor', 0, hc, 0, dk);
  p.room('parlor', hc + 2, A, 0, dk);
  p.room(kitchenLeft ? 'kitchen' : 'parlor', 0, hc, dk, D);
  p.room(kitchenLeft ? 'parlor' : 'kitchen', hc + 2, A, dk, D);
  return p.done();
}

// The narrow terrace frontage: a 1-tile passage hugging the party-wall side.
// Single file, orthogonal transits only, and one defender at its head covers
// the whole run — this is the assault choke the design is after.
function passagePlan(map: GameMap, it: Interior, f: Frame, s1: Rng): RoomPlan {
  const p = new Plan(map, it, f);
  const { A, D } = f;
  const pa = partySide(map, it, f);
  const wallA = pa === 0 ? 1 : A - 1;
  const blockA0 = pa === 0 ? 1 : 0;
  const blockA1 = pa === 0 ? A : A - 1;
  const df = clamp(3 + s1.int(2), 2, D - 2);

  // ONE wall line, written as two spans so each of the rooms behind it gets its
  // own door onto the passage (wallRun places one door per contiguous run).
  p.long(wallA, 0, df);
  p.long(wallA, df, D);
  p.cross(df, blockA0, blockA1);

  const passage = p.room('passage', pa, pa + 1, 0, D);
  p.spine = passage ? passage.tiles.slice() : [];
  p.room('parlor', blockA0, blockA1, 0, df);
  p.room('kitchen', blockA0, blockA1, df, D);
  return p.done();
}

// §3.2's fallback and §3.3's middle variant: one cross split, two rooms.
function enfiladePlan(map: GameMap, it: Interior, f: Frame, s1: Rng): RoomPlan {
  const p = new Plan(map, it, f);
  const { A, D } = f;
  // Drawn even when the split is unusable, so a plan's draw count never depends
  // on the mass's size. `max(1, …)` because rng.int(0) still burns a draw.
  const k = clamp(2 + s1.int(Math.max(1, D - 3)), 2, Math.max(2, D - 2));
  if (D < 4) {
    p.room('kitchen', 0, A, 0, D); // a one-room cottage IS the kitchen
    return p.done();
  }
  p.cross(k, 0, A);
  p.room('parlor', 0, A, 0, k);
  p.room('kitchen', 0, A, k, D);
  return p.done();
}

// §3.3's third variant: the door is on the frontage but the passage runs ACROSS
// the back, joining the rear door (D11's, once I8 adds it) to the stair and
// leaving one full-width front room.
function sideEntryPlan(map: GameMap, it: Interior, f: Frame): RoomPlan {
  const p = new Plan(map, it, f);
  const { A, D } = f;
  p.cross(D - 1, 0, A);
  p.room('parlor', 0, A, 0, D - 1);
  const passage = p.room('passage', 0, A, D - 1, D);
  p.spine = passage ? passage.tiles.slice() : [];
  return p.done();
}

// Which side of a terrace unit the party wall is on: the across extreme with
// the LONGER shared span against a DIFFERENT buildingId. Ties to across 0,
// which is always the low-x or low-y side (T8's `indexInRun` is not on the
// frozen Building contract, so the doc's first tie-break is unavailable).
function partySide(map: GameMap, it: Interior, f: Frame): number {
  const span = (a: number, dir: number): number => {
    let n = 0;
    for (let d = 0; d < f.D; d++) {
      const x = tileX(f, a, d);
      const y = tileY(f, a, d);
      if (!inMass(it, x, y)) continue;
      const horizontalFrontage = f.side === 'n' || f.side === 's';
      const other = map.buildingIdAt(horizontalFrontage ? x + dir : x, horizontalFrontage ? y : y + dir);
      if (other >= 0 && other !== it.id) n++;
    }
    return n;
  };
  return span(0, -1) >= span(f.A - 1, 1) ? 0 : f.A - 1;
}

// ═══ I5 · shop (§3.4) ═══════════════════════════════════════════════════════

/**
 * Storefront across the frontage, then a back room and a store behind it.
 *
 * The store is the building's dead end and its best hiding place: exactly one
 * door, off the back room. The counter that makes the storefront a choke on the
 * shop door is I7's furniture table — this only guarantees it has the depth to
 * stand a counter in.
 */
export function planShop(map: GameMap, it: Interior, s1: Rng): RoomPlan {
  const f = frameOf(map, it);
  const p = new Plan(map, it, f);
  const { A, D } = f;
  // Both draws happen unconditionally, in this order, so the shop's stream
  // shape does not depend on its dimensions.
  const dS = clamp(3 + s1.int(2), 2, Math.max(2, D - 2));
  const ak = clamp(3 + s1.int(Math.max(1, A - 5)), 3, Math.max(3, A - 3));

  if (D < 5) {
    p.room('storefront', 0, A, 0, D);
    return p.done();
  }
  p.cross(dS, 0, A);
  p.room('storefront', 0, A, 0, dS);
  if (A < 6) {
    p.room('backroom', 0, A, dS, D);
    return p.done();
  }
  p.long(ak, dS, D);
  // The larger child is the back room (it holds the stair); the smaller is the
  // store. Ties to the low across index.
  const backLow = ak >= A - ak;
  p.room(backLow ? 'backroom' : 'store', 0, ak, dS, D);
  p.room(backLow ? 'store' : 'backroom', ak, A, dS, D);
  return p.done();
}

// ═══ I5 · barn (§3.5) ═══════════════════════════════════════════════════════

const TACK = 3; // the tack room is 3x3
const STALL_LO = 0.2; // the stall line covers the middle ~60% of the wall
const STALL_HI = 0.8;

/**
 * A barn is a volume, not a plan. Two interventions only.
 *
 * The stall line is 1-long WALL stubs off the longer interior wall. Walls grant
 * no cover at all (los() never sources cover from an edge), so these are
 * honestly CONCEALMENT: they break enfilade down the wall and give a defender
 * somewhere to be that is not the open bay. They are stubs, not partitions — no
 * stub separates two rooms — so they sit outside the three-wall-line cap, and
 * the connectivity BFS is what proves they seal nothing.
 */
export function planBarn(map: GameMap, it: Interior, _s1: Rng): RoomPlan {
  const f = frameOf(map, it);
  const p = new Plan(map, it, f);
  stallLine(map, it, f);
  const tack = tackRoom(map, it, f, p);
  const bay = p.room('bay', 0, f.A, 0, f.D);
  if (bay && tack) {
    const inTack = new Set(tack.tiles);
    bay.tiles = bay.tiles.filter((t) => !inTack.has(t));
  }
  return p.done();
}

function stallLine(map: GameMap, it: Interior, f: Frame): void {
  const alongX = it.w >= it.h;
  const runLen = alongX ? it.w : it.h;
  const door = f.seed;
  // Of the two walls on the longer axis, the one FARTHER from the way in —
  // stalls at the back, not across the entrance. Ties to the low row/column.
  const loEnd = alongX ? it.y0 : it.x0;
  const hiEnd = (alongX ? it.y0 + it.h : it.x0 + it.w) - 1;
  const perp = alongX ? door.y : door.x;
  const row = Math.abs(perp - loEnd) >= Math.abs(perp - hiEnd) ? loEnd : hiEnd;
  const base = alongX ? it.x0 : it.y0;
  const from = base + Math.floor(runLen * STALL_LO);
  const to = base + Math.ceil(runLen * STALL_HI);
  // Both cases read `(axis, k, row, row+1)`: for 'v' the fixed coordinate is
  // the x grid line and the span is the single row y=row; for 'h' it is the y
  // grid line and the span is the single column x=row. A stub that lands on the
  // envelope has one flank outside the mass and wallRun drops it.
  for (let k = from; k < to; k += 2)
    wallRun(map, it, alongX ? 'v' : 'h', k, row, row + 1, it.top, null, { doors: false });
}

// A 3x3 room in the corner farthest from the primary door, one door. Skipped
// unless both interior dimensions are >= 7 and all nine tiles are in the mass.
function tackRoom(map: GameMap, it: Interior, f: Frame, p: Plan): Room | null {
  if (it.w < 7 || it.h < 7) return null;
  const door = f.seed;
  const corners: [number, number][] = [
    [it.x0, it.y0],
    [it.x0 + it.w - TACK, it.y0],
    [it.x0, it.y0 + it.h - TACK],
    [it.x0 + it.w - TACK, it.y0 + it.h - TACK],
  ];
  let best = -1;
  let bestD2 = -1;
  for (let i = 0; i < corners.length; i++) {
    const [cx, cy] = corners[i];
    const d2 = (cx + 1 - door.x) * (cx + 1 - door.x) + (cy + 1 - door.y) * (cy + 1 - door.y);
    if (d2 <= bestD2) continue;
    let full = true;
    for (let y = cy; y < cy + TACK && full; y++) for (let x = cx; x < cx + TACK; x++) if (!inMass(it, x, y)) full = false;
    if (!full) continue;
    bestD2 = d2;
    best = i;
  }
  if (best < 0) return null;
  const [cx, cy] = corners[best];
  const vFixed = cx === it.x0 ? cx + TACK : cx; // the leg of the L parallel to y
  const hFixed = cy === it.y0 ? cy + TACK : cy; // the leg parallel to x
  const vD = Math.abs(vFixed - door.x) + Math.abs(cy + 1 - door.y);
  const hD = Math.abs(cx + 1 - door.x) + Math.abs(hFixed - door.y);
  const doorOnV = vD <= hD; // one door only, on the leg nearer the way in
  wallRun(map, it, 'v', vFixed, cy, cy + TACK, it.top, f.seed, { doors: doorOnV });
  wallRun(map, it, 'h', hFixed, cx, cx + TACK, it.top, f.seed, { doors: !doorOnV });
  const tiles: number[] = [];
  for (const t of it.tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    if (x >= cx && x < cx + TACK && y >= cy && y < cy + TACK) tiles.push(t);
  }
  const room: Room = { kind: 'tackroom', tiles };
  p.rooms.push(room);
  return room;
}

// ═══ I5 · halle ═════════════════════════════════════════════════════════════

/**
 * A halle is a roof on four corner posts, so there is nothing to partition: no
 * envelope, no doors, no windows, twenty open edges.
 *
 * The whole mass is ONE volume, and the aisles that make it a covered market
 * rather than a floor are a FURNISHING decision (I7's stall rows), not a wall.
 * Drawing no rng is the point — a plan with no choices in it has none to make.
 */
export function planHalle(it: Interior): RoomPlan {
  return { rooms: [{ kind: 'bay', tiles: it.tiles.slice() }], spine: [] };
}

// ═══ dispatch ═══════════════════════════════════════════════════════════════

/**
 * Partition one structure by its role. Returns null only for 'none' (halt),
 * which is never partitioned and never furnished.
 *
 * The four trade roles share §3.4's partitioner: a mairie, a baker, a smith and
 * a grocer are one shell — frontage room, back room, store — furnished four
 * different ways by I7.
 *
 * The caller must have run `resetInterior` first — every plan here assumes it
 * owns a clean interior. `role` follows the Building contract, where absent
 * means 'house'.
 */
export function planRooms(map: GameMap, it: Interior, role: BuildingRole | undefined, s1: Rng): RoomPlan | null {
  const kind = PLAN_BY_ROLE[role ?? 'house'];
  if (kind === 'house') return planHouse(map, it, s1, role === 'townhouse');
  if (kind === 'shop' || kind === 'civic' || kind === 'bakery' || kind === 'forge') return planShop(map, it, s1);
  if (kind === 'barn') return planBarn(map, it, s1);
  if (kind === 'church') return planChurch(map, it, s1);
  if (kind === 'halle') return planHalle(it);
  return null;
}
