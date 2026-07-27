import { EDGE, type GameMap } from '../map';
import type { Building, BuildingRole } from '../mapgen';
import type { Rng } from '../rng';
import { churchAcross, churchDeep, churchFrame, churchTile } from './church';
import {
  Furnisher,
  inMass,
  interiorOf,
  keepClear,
  localIndex,
  resetInterior,
  sealedTiles,
  structuresOf,
  type Interior,
} from './kernel';
import { aOf, dOf, frameOf, planRooms, tileX, tileY, type Frame } from './rooms';
import {
  FURN_TAG,
  furnStream,
  FURNITURE_KEYS,
  PLAN_BY_ROLE,
  structKey,
  type FurnitureKey,
  type Room,
  type RoomKind,
  type RoomPlan,
} from './types';

// ═══ INTERIORS — THE FURNISHING PASS (I7) ═══════════════════════════════════
//
// docs/plans/2026-07-26-interiors-design.md §4.3's four role tables, run
// against §4.2's commit rule (the kernel's `Furnisher`), on §6.1's per-structure
// sub-streams. This is the pass I9 calls from `generateMap`; nothing here reads
// the shared rng, only the one `base` integer drawn there.
//
// THE ORDER OF OPERATIONS is the kernel's, and it is not interchangeable:
//   interiorOf → resetInterior → planRooms → keepClear → Furnisher → tables.
//
// TWO DISCIPLINES EVERY TABLE BELOW OBEYS, and a violation of either is a
// determinism bug that will not show up as a test failure until someone edits
// an unrelated building:
//
//  1. EVERY rng draw a table makes is taken UP FRONT, in a fixed order, before
//     any geometry is inspected. A table's draw count must not depend on
//     whether the room was big enough for the thing it was about to place — the
//     same rule planShop and enfiladePlan already follow. The one exception is
//     the shop's crate field, which is the LAST entry of the last table and
//     draws per tile (see there).
//  2. REJECTION CONSUMES NO RNG. `Furnisher.place` is a pure function of
//     geometry: candidates are generated (which is where the draws are) and
//     then accepted or refused. Never re-roll on refusal.

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Partition and furnish every structure on the map.
 *
 * `base` is the single draw §6.1 takes on the shared stream inside
 * `generateMap`; every per-structure stream is derived from it and the
 * structure's GEOMETRY (D9), never its array index — so the bourg can reorder
 * its emissions without every interior in the game changing.
 */
export function furnishInteriors(map: GameMap, buildings: readonly Building[], base: number): void {
  for (const struct of structuresOf(map, buildings)) {
    const lead = struct.buildings[0];
    const role = lead.role ?? 'house';
    if (PLAN_BY_ROLE[role] === 'none') continue;
    const it = interiorOf(map, struct);
    if (it === null) continue;
    // D9, keyed one notch harder than the doc writes it: the MASS bbox, not
    // `buildings[0]`'s rect. A group's leader is `buildings[0]` in MapPlan
    // order, so keying on the leader would make a church's interior depend on
    // whether the nave or the tower was emitted first — which is exactly the
    // index-sensitivity D9 exists to kill. The mass bbox is read off the map
    // and cannot depend on emission order at all.
    const key = structKey({ x: it.x0, y: it.y0, w: it.w, h: it.h });

    stripFurniture(map, it);
    resetInterior(map, it);
    const plan = planRooms(map, it, lead.role, furnStream(base, key, FURN_TAG.partition));
    if (plan === null) continue;
    const keep = keepClear(map, it, plan.spine);
    const c = new Ctx(map, it, plan, new Furnisher(map, it, keep), furnStream(base, key, FURN_TAG.furniture), base, key);

    const table = PLAN_BY_ROLE[role];
    if (table === 'house') furnishHouse(c, role);
    else if (table === 'shop') furnishShop(c);
    else if (table === 'barn') furnishBarn(c);
    else if (table === 'church') furnishChurch(c);

    if (import.meta.env.DEV) verify(map, it, role);
  }
}

// The tile half of D10's "this pass owns the interior and clears it first".
// `resetInterior` owns the EDGES; without this a second run over the same map
// re-partitions around the FIRST run's furniture, and a wall that moved can
// then seal a tile the old furniture is standing on. Production calls the pass
// once, so this is not a bug being papered over — it is what makes the pass
// idempotent, which is the property that lets the dev assertion below be
// trusted and lets a tool re-furnish a map to compare two bases.
function stripFurniture(map: GameMap, it: Interior): void {
  for (const t of it.tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    if (FURNITURE.has(map.terrainKeyAt(x, y))) map.setTerrain(x, y, 'floor');
  }
}

const FURNITURE = new Set<string>(FURNITURE_KEYS);

// §4.2's post-pass assertion, dev builds only (it is ~one BFS per exterior door
// per structure, which is a real cost on a 65-building bourg and buys nothing
// in a shipped build that already passed it in CI). A throw here is always a
// bug in this file: the commit rule is supposed to make it unreachable.
function verify(map: GameMap, it: Interior, role: BuildingRole): void {
  const sealed = sealedTiles(map, it);
  if (sealed.length > 0)
    throw new Error(
      `interiors: furnishing ${role} #${it.id} sealed ${sealed.length} tile(s), first at ${sealed[0] % map.w},${(sealed[0] / map.w) | 0}`,
    );
  for (const t of it.stairs)
    if (!map.terrainAt(t % map.w, (t / map.w) | 0).passable)
      throw new Error(`interiors: furnishing ${role} #${it.id} blocked the stair at ${t % map.w},${(t / map.w) | 0}`);
  for (const b of it.struct.buildings) {
    const cx = b.x + (b.w >> 1);
    const cy = b.y + (b.h >> 1);
    if (inMass(it, cx, cy) && !map.terrainAt(cx, cy).passable)
      throw new Error(`interiors: furnishing ${role} #${it.id} blocked the centre tile ${cx},${cy} that validate probes`);
  }
}

// ── the shared working context ──────────────────────────────────────────────

type Side = 'n' | 's' | 'e' | 'w';
const SIDES: readonly Side[] = ['n', 's', 'e', 'w'];
const SX: Record<Side, number> = { n: 0, s: 0, w: -1, e: 1 };
const SY: Record<Side, number> = { n: -1, s: 1, w: 0, e: 0 };

class Ctx {
  constructor(
    readonly map: GameMap,
    readonly it: Interior,
    readonly plan: RoomPlan,
    readonly f: Furnisher,
    readonly s3: Rng,
    readonly base: number,
    readonly key: number,
  ) {}

  x(t: number): number {
    return t % this.map.w;
  }
  y(t: number): number {
    return (t / this.map.w) | 0;
  }
  tile(x: number, y: number): number {
    return y * this.map.w + x;
  }
  rooms(kind: RoomKind): Room[] {
    return this.plan.rooms.filter((r) => r.kind === kind);
  }
  first(kind: RoomKind): Room | null {
    return this.plan.rooms.find((r) => r.kind === kind) ?? null;
  }
  /** The room holding a stair — types.ts §C's DERIVED landing, never a kind. */
  landing(): Room | null {
    if (this.it.stairs.length === 0) return null;
    const stair = new Set(this.it.stairs);
    return this.plan.rooms.find((r) => r.tiles.some((t) => stair.has(t))) ?? null;
  }
  /** A tile a candidate group may use: in the mass, out of K, still bare floor. */
  free(t: number): boolean {
    const x = this.x(t);
    const y = this.y(t);
    if (!inMass(this.it, x, y)) return false;
    if (this.f.keep[localIndex(this.it, x, y)] === 1) return false;
    return this.map.terrainKeyAt(x, y) === 'floor';
  }
  /** The edge on one side of a tile. */
  edge(x: number, y: number, s: Side): number {
    return s === 'n' ? this.map.hEdge(x, y) : s === 's' ? this.map.hEdge(x, y + 1) : s === 'w' ? this.map.vEdge(x, y) : this.map.vEdge(x + 1, y);
  }
  /**
   * An unbroken exterior-or-party WALL on this side: the edge is a WALL and the
   * tile behind it is not ours. A WINDOW is a different edge value, so "no
   * window" comes free — which is what every "windowless wall" rule in §4.3
   * means.
   */
  solid(x: number, y: number, s: Side): boolean {
    return this.edge(x, y, s) === EDGE.WALL && !inMass(this.it, x + SX[s], y + SY[s]);
  }
  /** …and the tile behind it belongs to a DIFFERENT structure: a party wall. */
  party(x: number, y: number, s: Side): boolean {
    return this.solid(x, y, s) && this.map.buildingIdAt(x + SX[s], y + SY[s]) >= 0;
  }
  /** How far the solid wall on side `s` runs, counting this tile. */
  runLen(x: number, y: number, s: Side): number {
    const [dx, dy] = s === 'n' || s === 's' ? [1, 0] : [0, 1];
    let n = 1;
    for (let k = 1; this.solid(x + dx * k, y + dy * k, s) && inMass(this.it, x + dx * k, y + dy * k); k++) n++;
    for (let k = 1; this.solid(x - dx * k, y - dy * k, s) && inMass(this.it, x - dx * k, y - dy * k); k++) n++;
    return n;
  }
  /** Place one group, or refuse it. Returns the tiles that landed. */
  put(tiles: readonly number[], key: FurnitureKey): number[] {
    return this.f.place(tiles, key) ? [...tiles] : [];
  }
  /** Try candidates in order; the first that lands wins. */
  putFirst(cands: readonly (readonly number[])[], key: FurnitureKey): number[] {
    for (const g of cands) {
      const got = this.put(g, key);
      if (got.length > 0) return got;
    }
    return [];
  }
}

// Rotate into a candidate list with a pre-drawn index. Modulo rather than a
// re-draw: the draw is taken before the candidates are known (discipline 1), so
// it has to survive a shorter list than it was drawn for.
const pick = <T>(list: readonly T[], r: number): T | null => (list.length === 0 ? null : list[r % list.length]);

const bboxOf = (c: Ctx, room: Room): { x0: number; y0: number; w: number; h: number } => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of room.tiles) {
    x0 = Math.min(x0, c.x(t));
    y0 = Math.min(y0, c.y(t));
    x1 = Math.max(x1, c.x(t));
    y1 = Math.max(y1, c.y(t));
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

const adjacent = (c: Ctx, t: number, to: readonly number[]): boolean =>
  to.some((u) => Math.abs(c.x(t) - c.x(u)) + Math.abs(c.y(t) - c.y(u)) === 1);

// Free tiles of a room, orthogonally adjacent to `to`, ascending.
const neighboursOf = (c: Ctx, room: Room, to: readonly number[]): number[] =>
  room.tiles.filter((t) => c.free(t) && adjacent(c, t, to));

// ── §4.3 · house / farmhouse / townhouse ────────────────────────────────────

function furnishHouse(c: Ctx, role: BuildingRole): void {
  // discipline 1: every draw, up front, in this order, forever.
  const dHearth = c.s3.int(3);
  const dTable = c.s3.int(2);
  const dChairs = 1 + c.s3.int(2);
  const dDresser = c.s3.int(3);
  const dSeat = c.s3.int(3);
  const dStair = c.s3.int(3);
  const dBarrels = 2 + c.s3.int(2);

  const kitchen = c.first('kitchen') ?? c.first('parlor') ?? c.first('bay');
  const parlors = c.rooms('parlor');
  const parlor = parlors[0] ?? kitchen;

  // 1 · the hearth. The longest unbroken windowless exterior-or-party wall run,
  // preferring a gable (short-axis) wall. A townhouse forces a party wall where
  // it has one — historically right, and it puts the chimney where roofs.ts'
  // terrace parapet wants it.
  let hearth: number[] = [];
  if (kitchen) {
    const wants = role === 'townhouse';
    const cands = hearthSpots(c, kitchen, wants);
    const spot = pick(cands, dHearth);
    if (spot !== null) hearth = c.put([spot], 'hearth');
  }

  // 2 · the table, and 3 · its chairs. Free-standing in a room with the space
  // for it, against a wall otherwise; never orthogonally adjacent to the
  // hearth, because a deal table in the fire is not furniture, it is kindling.
  let table: number[] = [];
  if (kitchen) {
    const box = bboxOf(c, kitchen);
    table = c.putFirst(tableSpots(c, kitchen, dTable === 1, box.w >= 4 && box.h >= 4, hearth), 'furn_heavy');
    for (const t of neighboursOf(c, kitchen, table).slice(0, dChairs)) c.put([t], 'furn_light');
  }

  // 4 · the parlor dresser — 1x2 against a windowless wall. Authored
  // wall-hugging on purpose (D1): upstairs this same tile is the wardrobe or
  // the bed, because the terrain layer is shared by every storey.
  if (parlor) {
    const pairs = wallPairs(c, parlor);
    const dresser = pick(pairs, dDresser);
    if (dresser !== null) c.put(dresser, 'furn_heavy');
    // 5 · a seat.
    const seat = pick(parlor.tiles.filter((t) => c.free(t)), dSeat);
    if (seat !== null) c.put([seat], 'furn_light');
  }

  // 6 · the stair-head piece: heavy furniture DIAGONAL from the stair, which is
  // exactly the tile K leaves open (K takes the stair and its four orthogonal
  // neighbours). It gives the defender coverBehind 0.4 onto the only way up,
  // and it is the single most tactically valuable tile in a house.
  const landing = c.landing();
  if (landing) {
    const stairs = c.it.stairs;
    const cands = landing.tiles.filter(
      (t) => c.free(t) && stairs.some((s) => Math.abs(c.x(t) - c.x(s)) === 1 && Math.abs(c.y(t) - c.y(s)) === 1),
    );
    const head = pick(cands, dStair);
    if (head !== null) c.put([head], 'furn_heavy');
  }

  // 7 · a farmhouse's larder barrels, in the scullery — which the plans label a
  // parlor (types.ts §C), so it is the LAST one.
  if (role === 'farmhouse') {
    const scullery = parlors[parlors.length - 1] ?? parlor;
    if (scullery) for (const t of scullery.tiles.filter((t) => c.free(t)).slice(0, dBarrels)) c.put([t], 'furn_light');
  }
}

// Candidate hearth tiles, best first: longest wall run, gable walls preferred,
// ties to the low tile index. Only the top three are offered, per §4.3.
function hearthSpots(c: Ctx, room: Room, wantParty: boolean): number[] {
  const gableSide = (s: Side): boolean => (c.it.w >= c.it.h ? s === 'w' || s === 'e' : s === 'n' || s === 's');
  const scored: { t: number; score: number }[] = [];
  for (const t of room.tiles) {
    if (!c.free(t)) continue;
    const x = c.x(t);
    const y = c.y(t);
    let best = -1;
    for (const s of SIDES) {
      if (!c.solid(x, y, s)) continue;
      if (wantParty && !c.party(x, y, s)) continue;
      const score = c.runLen(x, y, s) * 4 + (gableSide(s) ? 2 : 0) + (c.party(x, y, s) ? 1 : 0);
      if (score > best) best = score;
    }
    if (best >= 0) scored.push({ t, score: best });
  }
  // A townhouse with no party wall at all still needs a hearth.
  if (scored.length === 0 && wantParty) return hearthSpots(c, room, false);
  scored.sort((a, b) => b.score - a.score || a.t - b.t);
  return scored.slice(0, 3).map((s) => s.t);
}

// Table candidates, best shape first. `big` picks 2x2 over 1x2; `open` prefers
// free-standing groups, otherwise wall-hugging ones.
function tableSpots(c: Ctx, room: Room, big: boolean, open: boolean, avoid: readonly number[]): number[][] {
  const shapes: [number, number][][] = big
    ? [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ],
        [
          [0, 0],
          [1, 0],
        ],
        [
          [0, 0],
          [0, 1],
        ],
      ]
    : [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [0, 0],
          [0, 1],
        ],
      ];
  const inRoom = new Set(room.tiles);
  const nearHearth = (t: number): boolean => avoid.length > 0 && adjacent(c, t, avoid);
  const freeStanding: number[][] = [];
  const hugging: number[][] = [];
  for (const anchor of room.tiles)
    for (const shape of shapes) {
      const g: number[] = [];
      let ok = true;
      let touchesWall = false;
      for (const [dx, dy] of shape) {
        const t = c.tile(c.x(anchor) + dx, c.y(anchor) + dy);
        if (!inRoom.has(t) || !c.free(t) || nearHearth(t)) {
          ok = false;
          break;
        }
        if (SIDES.some((s) => c.solid(c.x(t), c.y(t), s))) touchesWall = true;
        g.push(t);
      }
      if (!ok) continue;
      (touchesWall ? hugging : freeStanding).push(g);
    }
  return open ? [...freeStanding, ...hugging] : [...hugging, ...freeStanding];
}

// Adjacent free pairs whose two tiles share a solid wall on the same side —
// a dresser stands flat against a wall, not across a corner.
function wallPairs(c: Ctx, room: Room): number[][] {
  const inRoom = new Set(room.tiles);
  const out: number[][] = [];
  for (const t of room.tiles) {
    if (!c.free(t)) continue;
    const x = c.x(t);
    const y = c.y(t);
    for (const s of SIDES) {
      if (!c.solid(x, y, s)) continue;
      const [dx, dy] = s === 'n' || s === 's' ? [1, 0] : [0, 1];
      const u = c.tile(x + dx, y + dy);
      if (!inRoom.has(u) || !c.free(u) || !c.solid(x + dx, y + dy, s)) continue;
      out.push([t, u]);
    }
  }
  return out;
}

// ── §4.3 · shop ─────────────────────────────────────────────────────────────

function furnishShop(c: Ctx): void {
  const dGap = c.s3.int(2);
  const dShelf = c.s3.int(3);
  const dTable = c.s3.int(2);
  const dChair = c.s3.int(3);
  const dFill = c.s3.next();

  const f = frameOf(c.map, c.it);
  const front = c.first('storefront');
  const back = c.first('backroom');
  const store = c.first('store');

  // 1 · the counter. THE reason a shop is a different fight from a house: an
  // attacker through the front door faces it at 2 m, has to walk round an
  // offset 1-tile gap to get past, and eats a defender with coverBehind 0.40
  // the whole way. Skipped when the storefront is too shallow to stand one in.
  if (front) {
    const dS = Math.max(...front.tiles.map((t) => dOf(f, c.x(t), c.y(t)))) + 1;
    if (dS >= 3) {
      const dc = Math.min(2, dS - 2);
      // The gap is OFFSET from the door on purpose — that is the whole counter:
      // an attacker cannot walk straight through, he has to step sideways
      // along the front of it. `clamp` can land it back on the door on a narrow
      // frontage, so try either neighbour before giving up (on a 4-wide shop
      // there is nowhere else, and the door apron keeps that tile clear anyway).
      const lo = 1;
      const hi = Math.max(1, f.A - 2);
      let gap = clamp(f.doorA + 2 + dGap, lo, hi);
      if (gap === f.doorA) gap = gap - 1 >= lo ? gap - 1 : gap + 1 <= hi ? gap + 1 : gap;
      // Written as maximal contiguous free runs rather than one all-or-nothing
      // group: a window nook or a door apron in the line would otherwise delete
      // the whole counter, and those tiles are protected for a reason.
      let run: number[] = [];
      for (let a = 0; a <= f.A; a++) {
        const t = a < f.A ? c.tile(tileX(f, a, dc), tileY(f, a, dc)) : -1;
        if (a < f.A && a !== gap && c.free(t)) {
          run.push(t);
          continue;
        }
        if (run.length > 0) c.put(run, 'furn_heavy');
        run = [];
      }
    }
    // 2 · shelving against the windowless side wall.
    const shelf = sideShelf(c, f, front, dShelf);
    if (shelf.length > 0) c.put(shelf, 'furn_heavy');
  }

  // 3 · the back room's table and chair.
  if (back) {
    const table = c.putFirst(tableSpots(c, back, dTable === 1, true, []), 'furn_heavy');
    const chair = pick(neighboursOf(c, back, table), dChair);
    if (chair !== null) c.put([chair], 'furn_light');
  }

  // 4 · the store's crate field. `furn_light` is PASSABLE, so this can never
  // seal anything — but at moveCost 2.2 it doubles the time to clear the one
  // room in the building with no second way out.
  //
  // The one place a table draws per candidate rather than up front (discipline
  // 1's stated exception): it is the last entry of the last table, so nothing
  // downstream can be shifted by a store that turned out bigger than expected.
  if (store) {
    const fill = 0.35 + dFill * 0.15;
    for (const t of store.tiles) {
      if (!c.free(t)) continue;
      if (c.s3.next() >= fill) continue;
      c.put([t], 'furn_light');
    }
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// A 1xN run of shelving down whichever across-extreme of the storefront carries
// no window. Up to three tiles, from the frontage end.
function sideShelf(c: Ctx, f: Frame, front: Room, r: number): number[] {
  const byA = (a: number): number[] =>
    front.tiles.filter((t) => aOf(f, c.x(t), c.y(t)) === a).sort((p, q) => dOf(f, c.x(p), c.y(p)) - dOf(f, c.x(q), c.y(q)));
  const windows = (a: number): number =>
    byA(a).filter((t) => SIDES.some((s) => c.edge(c.x(t), c.y(t), s) === EDGE.WINDOW)).length;
  const sides = [0, f.A - 1].filter((a) => a >= 0 && a < f.A);
  if (sides.length === 0) return [];
  sides.sort((p, q) => windows(p) - windows(q) || p - q);
  const col = byA(sides[0]).filter((t) => c.free(t));
  if (col.length === 0) return [];
  const start = r % col.length;
  return col.slice(start, start + 3);
}

// ── §4.3 · church ───────────────────────────────────────────────────────────

function furnishChurch(c: Ctx): void {
  const dAltar = c.s3.int(2);
  const dLane = 4 + c.s3.int(2);
  const dBell = c.s3.int(4);
  const dPress = c.s3.int(3);

  // The same frame the partitioner used. Re-derived from a FRESH stream with
  // the same seed rather than threaded through the RoomPlan: `furnStream` is
  // pure, so the three draws replay identically, and the alternative is a
  // second source of truth for the one piece of geometry I6 and I7 must agree
  // on exactly.
  const f = churchFrame(c.it, furnStream(c.base, c.key, FURN_TAG.partition));

  // 1 · the altar, centred one tile off the east wall of the chancel (which is
  // the apse's east wall when there is an apse).
  const chancel = c.first('chancel');
  if (chancel) {
    const deepest = chancel.tiles.reduce(
      (best, t) => {
        const d = churchDeep(f, c.x(t), c.y(t));
        return f.dir === 1 ? Math.max(best, d) : Math.min(best, d);
      },
      f.dir === 1 ? -Infinity : Infinity,
    );
    const row = chancel.tiles.filter((t) => churchDeep(f, c.x(t), c.y(t)) === deepest - f.dir);
    if (row.length > 0) {
      const across = row.map((t) => churchAcross(f, c.x(t), c.y(t))).sort((a, b) => a - b);
      const mid = (across[0] + across[across.length - 1] - dAltar) >> 1;
      const at = (back: number, shift: number, n: number): number[] => {
        const g: number[] = [];
        for (let k = 0; k < n; k++) {
          const p = churchTile(f, deepest - back * f.dir, mid + shift + k);
          g.push(c.tile(p.x, p.y));
        }
        return g;
      };
      // The centred tile 1 back from the east wall is the first choice and it
      // is very often refused: the apse's own CENTRE tile lands there, and the
      // centre of every building of the structure is unconditionally
      // keep-clear because `validate` probes it and `astar` fails instantly on
      // an impassable goal. So shuffle one across, then one further west,
      // before giving up the pair and settling for a single stone.
      const wide: number[][] = [];
      const narrow: number[][] = [];
      for (let back = 1; back <= 2; back++)
        for (const shift of [0, -1, 1]) {
          if (dAltar > 0) wide.push(at(back, shift, dAltar + 1));
          narrow.push(at(back, shift, 1));
        }
      c.putFirst([...wide, ...narrow], 'altar');
    }
  }

  // 2 · the pews. Across the central vessel the nave reads
  // [1 clear][pews][2-3 aisle][pews][1 clear]: the clear tiles are the window
  // nooks and the side alleys, the aisle is the killing ground the chancel arch
  // and the tower door both cover, and the pews themselves are what a squad
  // hugs for coverBehind 0.40 while it works up the side. Rows are broken by a
  // 1-tile cross-lane every 4-5 so a squad can shift laterally.
  //
  // One group per contiguous run in a row: a run that would seal (it cannot —
  // both alleys and the aisle stay open) or that overlaps K is refused on its
  // own, and the rest of the row still lands.
  const west = f.dir === 1 ? f.d0 : f.d1 - 1;
  const rows = Math.abs(f.chancel - west);
  for (let i = 2; i < rows - 1; i++) {
    if (i % dLane === dLane - 1) continue; // the cross-lane
    const d = west + i * f.dir;
    let run: number[] = [];
    for (let a = f.v0 + 1; a <= f.v1 - 1; a++) {
      const p = churchTile(f, d, a);
      const t = c.tile(p.x, p.y);
      const usable = a < f.v1 - 1 && (a < f.aisle0 || a >= f.aisle1) && c.free(t);
      if (usable) {
        run.push(t);
        continue;
      }
      if (run.length > 0) c.put(run, 'furn_heavy');
      run = [];
    }
    if (run.length > 0) c.put(run, 'furn_heavy');
  }

  // 3 · the bell-rope frame, in a tower corner. K already holds the stair and
  // its four neighbours, so `free` keeps this off them.
  const tower = c.first('tower');
  if (tower) {
    const corners = tower.tiles.filter((t) => c.free(t) && SIDES.filter((s) => c.solid(c.x(t), c.y(t), s)).length >= 2);
    const bell = pick(corners.length > 0 ? corners : tower.tiles.filter((t) => c.free(t)), dBell);
    if (bell !== null) c.put([bell], 'furn_light');
  }

  // 4 · the vestment press.
  const sacristy = c.first('sacristy');
  if (sacristy) {
    const press = pick(sacristy.tiles.filter((t) => c.free(t)), dPress);
    if (press !== null) c.put([press], 'furn_heavy');
  }
}

// ── §4.3 · barn ─────────────────────────────────────────────────────────────

function furnishBarn(c: Ctx): void {
  const dManger = c.s3.int(2);
  const dBench = c.s3.int(2);
  const dClusters = 2 + c.s3.int(3);
  const dSize = [0, 1, 2, 3].map(() => 1 + c.s3.int(3));
  const dOffset = c.s3.int(4);

  const bay = c.first('bay');
  const tack = c.first('tackroom');

  // 1 · a manger at the head of every other stall. A stall head is a bay tile
  // that has the exterior wall on one side and one of planBarn's 1-long WALL
  // stubs on a side perpendicular to it — read off the map rather than
  // recomputed, so the two passes cannot disagree about where the stalls are.
  if (bay) {
    const heads = bay.tiles.filter((t) => {
      const x = c.x(t);
      const y = c.y(t);
      const wall = SIDES.find((s) => c.solid(x, y, s));
      if (wall === undefined) return false;
      const perp: Side[] = wall === 'n' || wall === 's' ? ['w', 'e'] : ['n', 's'];
      return perp.some((s) => c.edge(x, y, s) === EDGE.WALL && inMass(c.it, x + SX[s], y + SY[s]));
    });
    for (let i = dManger; i < heads.length; i += 2) if (c.free(heads[i])) c.put([heads[i]], 'furn_heavy');
  }

  // 2 · the tack room's workbench and its stool.
  if (tack) {
    const bench = c.putFirst(tableSpots(c, tack, false, false, []), 'furn_heavy');
    const stool = pick(neighboursOf(c, tack, bench), dBench);
    if (stool !== null) c.put([stool], 'furn_light');
  }

  // 3 · straw and barrels in the open bays, never within 2 tiles of a door —
  // a barn's doorway is a cart entry and the one thing that must stay a lane.
  if (bay) {
    const clear = bay.tiles.filter(
      (t) => c.free(t) && c.it.doors.every((d) => Math.max(Math.abs(c.x(t) - d.x), Math.abs(c.y(t) - d.y)) >= 2),
    );
    if (clear.length > 0) {
      const stride = Math.max(1, Math.floor(clear.length / dClusters));
      for (let k = 0; k < dClusters; k++) {
        const anchor = clear[(dOffset + k * stride) % clear.length];
        if (!c.free(anchor)) continue;
        const g = [anchor];
        for (const s of SIDES) {
          if (g.length >= dSize[k % dSize.length]) break;
          const t = c.tile(c.x(anchor) + SX[s], c.y(anchor) + SY[s]);
          if (c.free(t) && !g.includes(t)) g.push(t);
        }
        c.put(g, 'furn_light');
      }
    }
  }
}
