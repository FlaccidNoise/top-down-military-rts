import type { TerrainKey } from '../data';
import type { Building, BuildingRole, Rect } from '../mapgen';
import { mulberry32, type Rng } from '../rng';

// ═══ INTERIORS — THE INTERFACE FREEZE (I2) ══════════════════════════════════
//
// docs/plans/2026-07-26-interiors-design.md, task I2. Everything downstream —
// I3's kernel, I4/I5/I6's partitioners, I7's furnishing, I8's roles, and Lane
// B's five render passes — builds on what is written here. This file holds the
// CONTRACT: types, code tables, and the precise statement of four algorithms.
// It holds no algorithm bodies (the two rng helpers at the bottom are the
// exception, and only because two slices hashing differently is the single
// most expensive divergence available to us).
//
// The four things every later slice must not re-invent:
//   §A furniture code table — the sim→render interface for interiors
//   §B the unit of work, and who owns which edge (D10)
//   §C rooms: the kind list, the plan, and which role gets which plan
//   §D the keep-clear mask K, and the non-sealing commit rule
//   §E role inference for legacy kinds (§3.7)
//
// Two facts that constrain all of it, restated because they are easy to forget:
//
//  - D1: terrain is ONE 2-D layer shared by every storey, and so are the walls.
//    `GameMap.tiles`/`hEdges`/`vEdges` have no level axis and `los`/`canStep`/
//    `astar` never take one. The room plan and the furniture plan are authored
//    once and are true on floors 0..n-1. "Bedrooms upstairs" is the same shell
//    read differently, which is why heavy furniture is authored wall-hugging.
//  - D2: furnishing is a post-pass inside `generateMap`, gated on
//    `opts.interiors` (default false), after the hill-dome loop and before
//    `validate`. Flag off ⇒ zero rng draws and zero writes ⇒ every pinned
//    fingerprint holds by construction rather than by care.

// ── §A · Furniture code table (design §2.1, D3-D6) ──────────────────────────
//
// The terrain key IS the sim→render interface for interiors: it lets the
// renderer draw a pew without re-deriving room semantics. Written ONLY by the
// furnishing pass, ONLY over 'floor' tiles, and only when `map.hasFurniture`.
// The numbers live in src/sim/data.ts (I1) — this is what they mean.
//
//   key        | passable | cover | coverBehind | move | is
//   -----------+----------+-------+-------------+------+---------------------
//   furn_heavy | no       | —     | 0.40        | —    | table, counter, pew
//              |          |       |             |      | block, dresser,
//              |          |       |             |      | manger, workbench
//   furn_light | yes      | 0.25  | —           | 2.2  | chairs, crates,
//              |          |       |             |      | straw, barrels
//   hearth     | no       | —     | 0.50        | —    | chimney breast
//   altar      | no       | —     | 0.50        | —    | altar / vestment stone
//
// Why these and not others:
//  - Impassable is what makes an aisle an aisle. `astar` routes round it, so a
//    double pew block with a 2-tile gap IS a central aisle and a counter with
//    one offset gap IS a choke on the shop door. A soft cost gradient is not.
//  - `coverBehind`, never `cover`, on the heavy pieces: nobody stands on a
//    table, so `cover` there would be dead data. `coverBehind` is "fire over
//    the counter" — granted only within 2 m of the target, directional, and
//    defeated by flanking past the end of the run.
//  - `opacity: 0` on all four. You can see across a room over a table, and
//    opaque furniture would make interiors unreadable in a game whose whole
//    indoor mechanic is LOS through doors and windows.
//  - NO `featureHeight` (D6). `los()` skips a feature once the eye-line clears
//    `elev + featureHeight`; at furniture height (0.8-1.1 m, under EYE_H 1.6)
//    that branch fires on every ground-level shot and deletes the cover.
//    RECORDED GAP: the substrate therefore cannot express "the tower shoots
//    over the pews". Fixing it needs a level-aware coverBehind.
//  - All four are `noVehicle` (I1's TerrainDef flag, which replaced the three
//    hand-kept key blacklists in canStep / reachField / findVehicleSpot).
//
// What comes free, with no sim change at all: `sim.coverAt` maxes a tile's own
// `cover` with its four neighbours' `coverBehind`, so beside a counter it
// returns 0.40 and on a crate 0.25 — which lights up `inCover`,
// `findCoverSpot`, `dangerSamples`' route scoring and the UI move-preview dots
// together. A route through a furnished building starts scoring measurably
// safer than a route across the street. That is a real balance change on every
// map once the flag is on, and it is the change we want.

// `satisfies` is a compile-time proof that these four names are real terrain
// keys: renaming one in data.ts and forgetting this file fails `tsc`.
export const FURNITURE_KEYS = ['furn_heavy', 'furn_light', 'hearth', 'altar'] as const satisfies readonly TerrainKey[];
export type FurnitureKey = (typeof FURNITURE_KEYS)[number];

// ── §B · The unit of work, and edge ownership (D10) ─────────────────────────
//
// The unit is a STRUCTURE, not a Building. A church is three Buildings (nave,
// tower, apse) sharing one `groupId` and therefore ONE `map.buildingId`; if
// each were furnished independently they would each try to own the span
// between them. Grouping rule, exactly:
//
//   two Buildings are in the same Structure iff both carry `groupId` and the
//   two values are equal. A Building without `groupId` is its own Structure.
//   Order within `buildings` is MapPlan.buildings order, so `buildings[0]` is
//   the group leader (the bourg sets `gid` to the leader's own index before the
//   first emit, so a groupId can never collide with another building's id).
//
// The MASS is read off the MAP, never rebuilt from rects:
//
//   id   = map.buildingId at the centre tile of buildings[0]
//   mass = { tiles t inside bbox(all rects of all buildings in the group)
//            : map.buildingId[t] === id }
//
// This is index-independent (D9's rule applied to geometry as well as rng), it
// picks up every rect of every mass in the group for free, and it excludes an
// abutting neighbour's tiles even where the two rects touch — which a
// rect-union mask does not.
//
// EDGE OWNERSHIP (D10). Step 0 of working a structure is:
//
//   for every grid edge whose two flanking tiles BOTH have
//   `map.buildingId >= 0` and EQUAL:  set EDGE.NONE, top 0.
//
//   Then write the structure's own plan.
//
// Consequences, all of them intended:
//  - the pass is idempotent and independent of whichever stamper ran. T3
//    `stampStructure`'s depth-2 AABB partitions are simply overwritten, as the
//    retired rect walker's mid-span partition was.
//  - the church gets its tower door: nave and tower share a buildingId, so the
//    town design's post-pass left that span EDGE.NONE, and interiors rewrites
//    it to WALL (top = max of the two storey heights) + exactly one DOOR.
//  - PARTY WALLS BETWEEN DIFFERENT buildingIds ARE NEVER TOUCHED, so a terrace
//    keeps the party walls the town design gave it.
//  - exterior walls, windows and doors are never touched either: one of their
//    flanking tiles is not a building tile at all.
//
// DEVIATION from the design doc's wording, which says "both flanking tiles are
// `floor` with the same buildingId". Terrain is the wrong test: the moment the
// pass writes its first furniture tile that tile stops being `floor`, so a
// re-run would clear a different edge set. buildingId is set on exactly the
// tiles that were made `floor` by the stampers and on nothing else (the V5 halt
// platform is `road` with no buildingId), so at reset time the two predicates
// select the same edges — and only the buildingId one stays true afterwards.
//
// Bounds discipline for every edge write: `setHEdge`/`setVEdge` do NO bounds
// test, so a `setVEdge(w + 1, y)` silently lands on `vEdge(0, y + 1)` — a
// corruption on the far side of the map. Valid domains are
// `hEdge x ∈ [0,w) y ∈ [0,h]` and `vEdge x ∈ [0,w] y ∈ [0,h)`. I3's `wallRun`
// asserts them, following `stampStructure`'s `putH`/`putV`.

export interface Structure {
  buildings: Building[]; // >= 1, MapPlan order; [0] is the group leader
  id: number; // the shared map.buildingId of every tile of the mass
  rects: Rect[]; // union of partsOf() over `buildings` — the bbox source only
}

// ── §C · Rooms (D8: transient, never persisted) ─────────────────────────────
//
// Rooms exist only during generation. There is NO `GameMap.roomId` array: it
// would be a second source of truth, `los()` and `astar` work off edges, and
// the renderer works off buildingId + terrain. The one plausible consumer,
// per-room floor material, is served by `Building.role` plus a
// hearth-proximity test (Lane B, R1).
//
// `scullery` is deliberately absent: the design treats it as a parlor for
// furnishing, so a second name would buy nothing.
//
// `landing` is deliberately absent too, and this is a CLARIFICATION of the
// design doc, which says the stair's room is "marked landing". In the hall plan
// the stair sits in the hall, which is already the spine — a room cannot have
// two kinds. The landing is therefore a DERIVED predicate, not a kind:
//
//   the landing room = the room whose tiles contain a `map.stairs` tile
//
// Interiors NEVER MOVES A STAIR. It reads the tile the stamper placed
// (`stampStructure`'s farthest-from-door interior tile) and plans around it.

export type RoomKind =
  | 'hall' // house/farmhouse: the 2-wide circulation spine, front door to back wall
  | 'passage' // townhouse: the 1-wide spine hugging a party wall — the assault choke
  | 'parlor' // street-facing living room; also the scullery
  | 'kitchen' // holds the hearth
  | 'storefront' // shop, frontage side; holds the counter
  | 'backroom' // shop, behind the counter; holds the stair
  | 'store' // shop dead end; crate field; the best hiding place on the map
  | 'bay' // barn: the open volume
  | 'tackroom' // barn: the 3x3 corner room
  | 'nave' // church: the central vessel
  | 'aisle' // church: a side aisle behind an arcade
  | 'chancel' // church: east of the chancel arch; holds the altar
  | 'sacristy' // church: the chancel-corner room — the flanking prize
  | 'tower'; // church: the tower room; one door, one stair column, four levels

export interface Room {
  kind: RoomKind;
  tiles: number[]; // map tile indices (y * map.w + x), ascending
}

// What a partitioner returns. `spine` is an EXPLICIT tile list rather than a
// set of RoomKinds because the church's central aisle is not a room — it is the
// clear gap between two pew columns inside the nave — and the keep-clear mask
// has to protect it all the same.
export interface RoomPlan {
  rooms: Room[];
  spine: number[]; // circulation: hall tiles, passage tiles, church central aisle
}

// Which partitioner + furniture table a role gets. Exhaustive over
// BuildingRole, so a new role cannot ship without an answer here.
//
//  'house'  → §3.2 hall / passage / enfilade, by frontage width and depth
//  'shop'   → §3.4 storefront / back room / store
//  'barn'   → §3.5 a volume, not a plan: stall stubs + optional tack room
//  'church' → §3.6 arcades, chancel + arch, sacristy, tower door
//  'none'   → not partitioned and not furnished
//
// Two roles are 'none', and both are DECISIONS THIS FREEZE MAKES because the
// design doc predates them:
//  - `halle` is a roof on posts. `stampStructure` returns after stamping four
//    corner posts, so there is no envelope to partition, the keep-clear and
//    non-sealing invariants are vacuous, and market stalls in an open passage
//    are a route hazard, not a room. A market-stall pass is a later task.
//  - `halt` is V5's 28-tile station shed, the newest and least-tested structure
//    on the map. Barn mangers in a booking hall are the wrong flavour and the
//    conservative freeze costs nothing. A bench row is later polish.
export const PLAN_BY_ROLE: Record<BuildingRole, 'house' | 'shop' | 'barn' | 'church' | 'none'> = {
  house: 'house',
  farmhouse: 'house',
  townhouse: 'house', // §3.3's three variants are selected inside the house partitioner
  civic: 'house', // a mairie is a hall and rooms
  shop: 'shop',
  barn: 'barn',
  church: 'church',
  church_tower: 'church', // planned as part of the group, not on its own
  church_apse: 'church',
  halle: 'none',
  halt: 'none',
};

// ── §D · The keep-clear mask K, and the commit rule (§4.1-4.2) ──────────────
//
// K is deterministic and draws NO rng. A candidate furniture group intersecting
// K is rejected outright. Indexed in the same local frame as the structure's
// mass mask; 1 = keep clear.
//
// Seeds, and why each one is load-bearing:
//
//  1. EXTERIOR DOORS — both interior tiles flanking the door, PLUS one tile
//     further in along the inward normal (a 2-tile apron; the second tile is
//     skipped when it falls outside the mass). Assault entry must be usable —
//     and `terrain.ts drawDoorTrails` decides internal-vs-external by comparing
//     `terrainKeyAt === 'floor'` on both flanks, so a furniture tile on the
//     inside of an exterior door makes the two flanks agree and DELETES the
//     door-wear trail. The apron is correctness, not decoration.
//  2. INTERIOR DOORS — one interior tile each side. A door you cannot walk
//     through is a wall; and the same `floorAt` comparison run the other way
//     grows an outdoor wear trail on an indoor door.
//  3. WINDOW NOOKS — the interior tile flanking every exterior WINDOW. This is
//     the brief's hard requirement: 1-tile standing room behind every window,
//     so every ground-floor room with a street-facing window is a firing
//     position.
//  4. STAIRS — every `map.stairs` tile in the mass and its four orthogonal
//     neighbours that are also in the mass. `validate` requires stair
//     reachability, and the landing is the choke: it must be fightable.
//  5. THE BUILDING CENTRE — `(b.x + (b.w >> 1), b.y + (b.h >> 1))` for EVERY
//     building of the structure, unconditionally, on every kind. `validate`
//     probes exactly this tile and `astar` returns null immediately when the
//     goal is impassable, so one table there rejects the whole map. Always
//     inside the mass: parts[0] is a rect and this is its centre.
//  6. THE SPINE — every tile of `RoomPlan.spine`. Circulation is the plan.
//
// THE COMMIT RULE. Furniture is emitted as GROUPS (a table is one group of 1-4
// tiles, a pew block one group of N, a crate field one group per crate).
// Candidates are generated in a fixed per-role order; for each candidate g:
//
//   if g ∩ K ≠ ∅                                      → reject
//   if g ∩ committed ≠ ∅                              → reject
//   BFS from the primary door's interior tile over
//     mass \ (impassable ∪ g), 8-connected, mirroring
//     path.ts's no-corner-cutting rule EXACTLY
//   if reached ≠ mass \ (impassable ∪ g)              → reject   // sealed
//   else                                              → commit
//
// Rejection consumes NO extra rng: the draws happen when the candidate is
// GENERATED, and accept/reject is a pure function of geometry. The stream is
// therefore identical whether a candidate lands or not — do not "re-roll on
// reject", it desynchronises every later building.
//
// This is strictly stronger than the brief ("never blocks the only path between
// a door and the rest of the building"): nothing is ever cut off from anything.
// Cost is |mass| per candidate, ≤ 14 candidates per building, ~120 tiles.
//
// The PRIMARY DOOR is recovered from the MAP, not from `Building.doors`:
// legacy kinds emit no `doors` at all, and the map is what both stampers
// actually wrote. An exterior door is an `EDGE.DOOR` with exactly one flanking
// tile in the mass. Order them by (interior tile index) ascending; the primary
// is the first. When a structure has none — impossible for a stamped building,
// since `resolveDoors` throws rather than emit a doorless mass — skip it.

// ── §E · Role inference for legacy kinds (§3.7) ─────────────────────────────
//
// Legacy `Building` carries no `role`. Interiors infers one deterministically
// and WRITES IT BACK onto `Building.role`. That is safe: the field is outside
// the map-array fingerprint and `tests/mapgen.test.ts` only requires
// determinism of the buildings list. It runs ONLY on buildings whose `role` is
// undefined — a bourg building keeps the role its generator gave it.
//
// The rules, in this order, over `MapPlan.buildings`:
//
//   barn      : the SMALLER of any pair whose rect gap ≤ 4 m
//   farmhouse : the LARGER of such a pair
//   shop      : among the buildings still unlabelled, the two with area ≥ 40
//               nearest objectives[0], ordered by (d2, index), where d2 is
//               measured from the building's centre tile
//   house     : everything else
//   church    : never — legacy generation has none
//
// Two things to know before trusting it:
//
//  - The pair rule is `roofs.ts`' `smallOfPair` reproduced EXACTLY (gap
//    computed per axis, `hypot(gx, gy) <= 4`, strict area comparison so equal
//    areas label neither). Including its error mode: mapgen's farm loop emits a
//    house of 30-48 tiles and a barn of 20-35, so a 6x5 house next to a 7x5
//    barn is labelled the wrong way round. The true pairing is not recoverable
//    from the emitted data, and agreeing with the roof material is worth more
//    than being right 3 % more often. Once roles are written back, Lane B can
//    DELETE roofs.ts' geometric guess for maps that carry them.
//  - "among the buildings still unlabelled" is a CLARIFICATION of the design
//    doc, which does not say. Without it an outlying farmhouse could be
//    relabelled a shop; with it the cascade is a partition.

// ── §F · rng sub-streams (§6.1, D9) ─────────────────────────────────────────
//
// One draw on the shared stream inside `generateMap`, as the LAST draw of the
// attempt, feeds every per-structure stream:
//
//   if (opts.interiors) furnishInteriors(map, buildings, rng.int(0x7fffffff));
//
// Per-structure streams are keyed on the leader's GEOMETRY, never on its array
// index. This is N8's lesson from the roof layer applied before the mistake is
// made: all roof art hashes on `hash(i, salt)`, so inserting one building at
// the front of the list reshuffles every roof. Geometry keys mean the bourg's
// emission order can change without every interior in the game changing, and
// they make the pass order-insensitive — which is a one-line test.
//
// `mulberry32` is a 32-bit counter: two streams seeded 1 apart correlate for
// their first few outputs, so never `base + tag`. `rng.int(0)` still burns a
// draw, so never `S(t).int(n)` where n can be 0 — wrap every count in
// `Math.max(1, …)`.

export const FURN_TAG = {
  partition: 1,
  doors: 2, // second exterior door (D11) + role inference
  furniture: 3,
  art: 4, // render-facing variant bits
} as const;

// Math.imul, not `*`: the design doc writes `x * 73856093`, whose product
// overflows 2^31 for any x > 29 and is only well defined because `^` coerces
// through ToInt32. imul is the same intent with no double in the middle. It
// changes the numbers, which is free — nothing has been generated with the
// other spelling — so do not "correct" it back.
export const structKey = (b: { x: number; y: number; w: number; h: number }): number =>
  (Math.imul(b.x, 73856093) ^ Math.imul(b.y, 19349663) ^ Math.imul(b.w, 83492791) ^ b.h) >>> 0;

export const furnStream = (base: number, key: number, tag: number): Rng =>
  mulberry32((base ^ Math.imul(key, 0x9e3779b1) ^ Math.imul(tag, 0x85ebca6b)) >>> 0);
