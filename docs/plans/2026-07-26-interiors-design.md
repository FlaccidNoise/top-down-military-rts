# Interiors — procedural rooms and furnishing for every building role

Design owner: lead technical designer. Date: 2026-07-26.
Composes with `docs/plans/2026-07-26-town-gen-design.md` (the bourg pipeline) and the
substrate audit. All line references verified against the working tree at `9c1ec62`.

Target: a new `src/sim/interiors/` module, four appended `TERRAIN` keys, and five
additive render passes. Applies to **every** building on **every** kind — bourg,
town, woods, open, river, bridge — behind one flag that keeps the pinned
fingerprints byte-identical.

---

## 0. Decisions up front

| # | Decision | Why |
|---|---|---|
| **D1** | **Terrain is a single 2-D layer shared by every storey, and so are the walls. There is no per-level interior.** `GameMap.tiles`, `hEdges`, `vEdges` have no level axis (`map.ts:15-17`); `terrainAt`/`canStep`/`los()` never take one; `astar`'s `stepCost` reads `map.terrainAt(nx,ny).moveCost` regardless of `cl` (`path.ts:121`). So the room plan and the furniture plan are authored once and are true on floors 0..n-1. | This is the hardest constraint in the document and it is non-negotiable without a new `GameMap` array plus level-aware `los()`/`astar`/`canStep` — an invasive change to three hot paths for cosmetic gain. Consequence: "bedrooms upstairs" is expressed by *reading the same shell differently*, not by a second plan. The hearth is the honest case — a chimney breast genuinely runs through both floors — and heavy furniture is authored wall-hugging so it reads as dresser/wardrobe/bed on either floor. See §3.6. |
| **D2** | **Furnishing is a post-pass inside `generateMap`, gated on a new fifth parameter `opts.interiors` (default `false`), placed *after* the hill-dome loop (`mapgen.ts:283-299`) and *before* `validate`.** | Three things fall out at once. (a) With the flag off, **zero** rng draws and zero writes → `8105059f` / `d2a77805` (`tests/mapgen.test.ts:37-38`) and every other pinned test hold by construction, not by care. (b) After the domes means after the last existing draw, so even with the flag *on* the pre-existing arrays are bit-identical — only furniture tiles and interior edges differ (§6.3). (c) The dome pass skips `k === 'floor'` (`mapgen.ts:294`); furnishing after it means the domes still see every interior tile as `floor` and skip it. Running furnishing earlier would silently let domes lift furniture tiles. |
| **D3** | **Four new terrain keys, appended after `water`: `furn_heavy`, `furn_light`, `hearth`, `altar`.** | Tile indices are positional (`map.ts:9, 54-56`); appending is the documented rule (`docs/decisions/INDEX.md:12`, audit §1.2). The terrain key *is* the sim→render interface for interiors: it lets the renderer draw a pew without re-deriving room semantics, which is exactly the coupling the roof layer already suffers from. `TERRAIN_NAME: Record<TerrainKey, string>` (`tooltip.ts:302`) is exhaustive, so `tsc --noEmit` forces the tooltip copy — a free compile-time catch. |
| **D4** | **`furn_heavy`, `hearth`, `altar` are impassable; `furn_light` is passable at `moveCost 2.2`.** | Impassable is what makes an aisle an aisle. `astar` routes around it (`path.ts:113-118`), so pew blocks and counters generate real lanes and real chokes rather than a soft cost gradient. `furn_light` is the soft version: clambering over crates is slower than a hedgerow (1.8) and gives on-tile cover, so the two together give hard and soft lane-shaping from one mechanism. |
| **D5** | **Furniture cover is `coverBehind`, not `cover`.** `furn_heavy` 0.4, `hearth`/`altar` 0.5, `furn_light` `cover: 0.25`. | `los()` sources cover from three places only: the *target tile's* `TerrainDef.cover` (`map.ts:151`), a `WINDOW` crossed within 2 m of the target (`map.ts:273`), and `coverBehind` crossed within 2 m of the target (`map.ts:265-268, 274`). Nobody stands on a table, so `cover` on `furn_heavy` would be dead data; `coverBehind` is exactly "fire over the counter" — directional, so flanking round the end of the counter defeats it. It also lights up `sim.coverAt()` (`sim.ts:2910-2916`, which maxes the 4 neighbours' `coverBehind`) with **zero sim changes**, which means AI cover-seeking, the danger model, and the UI move-preview dots all understand furniture for free (§5.1). |
| **D6** | **No `featureHeight` on any furniture key.** | The skip branch fires when `lineZ >= elev + featureHeight` (`map.ts:260`). Eye height is 1.6 m (`map.ts:12`), so any furniture-realistic height (0.8-1.1 m) would make the branch fire on *every* ground-level shot and delete the cover entirely — hedge only works because its `featureHeight` is 2. Recorded gap: **the substrate cannot express "the tower shoots over the pews"**, because the `coverBehind` grant is evaluated within 2 m of the target where the ray has already descended to ~1.6 m regardless of the shooter's level. Fixing it means a level-aware `coverBehind`, which is out of scope. |
| **D7** | **Furniture placement is guaranteed non-sealing by a two-part mechanism: an a-priori keep-clear mask, and a per-group BFS commit test.** No group is written unless a BFS from the primary door still reaches *every* remaining passable interior tile. | The brief's requirement is "never blocks the only path between a door and the rest of the building"; the commit test proves the strictly stronger property (nothing is ever cut off), at ~120 ops per candidate × ≤14 candidates × 65 buildings ≈ 0.2 ms. The mask is what delivers the *tactical* guarantees (window nooks, door aprons, stair landings) that a connectivity test alone would not. §4.1-4.2. |
| **D8** | **Room ids are not persisted.** Rooms exist only during generation; downstream sees walls and terrain. | A `GameMap.roomId` array is a new field and a second source of truth, and nothing downstream needs it: `los()` and `astar` work off edges, the renderer works off `buildingId` + terrain. The one plausible consumer — per-room floor material — is served by `Building.role` plus a hearth-proximity test (R1, §7). |
| **D9** | **Per-building rng sub-streams are keyed on the building's *geometry*, never on its array index.** `key = (x*73856093) ^ (y*19349663) ^ (w*83492791) ^ h`. | This is N8's lesson from the roof layer applied before the mistake is made: all roof art hashes on `hash(i, salt)`, so inserting one building at the front of the list reshuffles every roof. Geometry-keyed streams mean the bourg's emission order can change in week three without every interior in the game changing. It also makes the pass order-insensitive, which is a one-line test (§6.4). |
| **D10** | **The interiors pass owns interior edges and clears them first.** Step 0 of furnishing a building sets every edge whose two flanking tiles are both `floor` **with the same `buildingId`** to `EDGE.NONE`, top 0, then writes its own plan. | Makes the pass idempotent and independent of whichever stamper ran: legacy `addBuilding`'s `w >= 8` partition at `doorX` (`mapgen.ts:338-340`) and T3 `stampStructure`'s step-6 AABB partitions are both simply overwritten. It also gives the church its tower door: nave and tower share a `groupId` → same `buildingId` → the town design's post-pass left that span `EDGE.NONE` (D4/D5 there), and interiors rewrites it to `WALL` + one `DOOR`. **Party walls between different `buildingId`s are never touched**, so terraces keep their D5 party walls. |
| **D11** | **Every building with interior area ≥ 20 gets a second exterior door on the opposite side.** | "Front + back doors give assault entry choice" is a stated requirement, and on the bourg it is the highest-value composition point in the whole programme: T8's rear-garden network stops being a bypass and becomes an *entry* network. Legacy `addBuilding` emits exactly one door (`mapgen.ts:330-337`); for the bourg, interiors only adds one when `b.doors.length === 1`. |
| **D12** | **Vehicle exclusion moves from a key blacklist to a `TerrainDef.noVehicle` flag.** `canStep` (`map.ts:114-117`) and `findVehicleSpot` (`sim.ts:936-947`) both hard-code `k === 'floor' \|\| 'woods' \|\| 'hedge'`. | Semantics-identical for the existing seven keys (mechanically verifiable), strictly fewer ops in `canStep` (the `TerrainDef` is already fetched on the line above), and new keys are covered automatically. Without it, `findVehicleSpot` can select a passable `furn_light` tile inside a building and the vehicle order is then silently dropped when `astar` finds no vehicle route — the exact failure `floor` is already blacklisted to prevent. |

---

## 1. What the substrate gives us, and what it does not

Read this before arguing with any number in §2.

**Cover is a per-tile scalar consumed in exactly three places** (`map.ts:151, 265-274`):

| Field | Who reads it | Effect |
|---|---|---|
| `cover` | `los()` on the **target tile only** (`map.ts:151`); `sim.coverAt` (`sim.ts:2914`) | flat hit-chance reduction for a man standing in it |
| `coverBehind` | `los()` when the ray crosses the tile **within 2 m of the target** (`map.ts:265-268, 274`); `sim.coverAt` over the 4 neighbours (`sim.ts:2915-2918`) | directional parapet cover — hugging the far side |
| `opacity` | accumulates per crossed tile; `>= 1` blocks (`map.ts:263-264`) | concealment / hard sight block |
| `moveCost` | `astar` step cost (`path.ts:121`), soldier speed divisor (`sim.ts:2404`) | routing preference **and** exposure time |
| `passable` | `canStep` (`map.ts:113`), `astar` goal test (`path.ts:25`) | hard block |
| `featureHeight` | `los()` shoot-over skip (`map.ts:260`) | useless below eye height 1.6 m — see D6 |

**Walls give no cover at all.** `los()` never sources cover from an edge; a `WALL` is a binary block below its stamped top (`map.ts:210-213, 219-222`). This is why stall partitions in a barn (§3.5) are honestly described as *concealment*, and why furniture — not walls — is the only way to put cover inside a building.

**A soldier indoors gets nothing from the floor.** `floor` is `cover: 0` (`data.ts:15`). Today, a garrisoned house grants cover only through the walls that block LOS. Adding furniture is the first time an interior has had graduated cover, and it is what turns "shoot at the house" into "clear the house".

**Three fragile couplings this pass must not break:**

1. `validate` probes **every building's centre tile** for foot reachability (`mapgen.ts:375`) and `astar` returns `null` immediately when the goal is impassable (`path.ts:25`). A table on the centre tile rejects the whole map. The centre tile is in the keep-clear mask, unconditionally, for every kind.
2. The renderer distinguishes internal from external doors by comparing `floorAt` on both sides of the edge (`terrain.ts:826-835, 811`). A furniture tile flanking an exterior door would make the door-wear trail vanish. The 2-tile door apron in the keep-clear mask is what keeps that test correct — it is load-bearing, not decoration.
3. `nudgeSpawn` (`sim.ts:703-717`) and `findSpot` (`sim.ts:1528-1542`) already test `.passable`, so impassable furniture is handled. `findVehicleSpot` (`sim.ts:936-947`) does **not** — hence D12.

---

## 2. The terrain contract

### 2.1 The four keys — appended after `water` in `src/sim/data.ts:11-19`

```ts
furn_heavy: { color: '#6a533a', moveCost: 1,   cover: 0,    opacity: 0, coverBehind: 0.40, passable: false, noVehicle: true },
furn_light: { color: '#7d6647', moveCost: 2.2, cover: 0.25, opacity: 0,                    passable: true,  noVehicle: true },
hearth:     { color: '#514740', moveCost: 1,   cover: 0,    opacity: 0, coverBehind: 0.50, passable: false, noVehicle: true },
altar:      { color: '#8d8577', moveCost: 1,   cover: 0,    opacity: 0, coverBehind: 0.50, passable: false, noVehicle: true },
```

New `TerrainDef` field: `noVehicle?: boolean` (D12). Existing keys gain `noVehicle: true` on
`woods`, `hedge`, `floor`; nothing else changes.

**Justification, value by value:**

- **`furn_heavy` — table, counter, pew block, dresser/wardrobe, manger, workbench.**
  `passable: false` (D4) is the whole tactical point: `astar`'s 8-neighbour expansion
  (`path.ts:102-118`) routes round it, so a double pew block with a 2-tile gap *is* a
  central aisle, and a counter with one offset gap *is* a choke on the shop door.
  `coverBehind: 0.40` places it between `woods` (`cover 0.3`) and `hedge`
  (`coverBehind 0.5`) — a deal table is better than standing in a wood and worse than a
  Norman earth bank, which is right. It is granted only within 2 m of the target
  (`map.ts:274`), so it is the reward for hugging the furniture, and it evaporates the
  moment the shooter gets an angle past the end of the run. `opacity: 0` because you can
  see across a room over a table, and because opaque furniture would make interiors
  unreadable in a game whose entire indoor mechanic is LOS through doors and windows.
- **`furn_light` — chairs, crates, straw, benches, barrels.** `passable` with
  `moveCost 2.2`: slower than `hedge` (1.8), so `astar` prefers the clear aisle by a real
  margin but will cut through under pressure, and `sim.ts:2404` makes the crossing cost
  real exposure time. `cover: 0.25` (on-tile, just under `woods`' 0.3) because a man
  *among* crates genuinely is partly covered — and because `sim.coverAt` reads on-tile
  `cover` directly (`sim.ts:2914`), a crate field reads as cover to the AI without any
  new code. No `coverBehind`: a chair is not a parapet.
- **`hearth`** — impassable masonry, `coverBehind: 0.50` (stone beats wood). One tile,
  always on an exterior or party wall. This is also D1's escape hatch: a chimney breast
  is the one piece of interior geometry that is *genuinely* identical on both floors.
- **`altar`** — mechanically identical to `hearth`; a separate key because the renderer
  must be able to draw an altar without re-deriving "this is the chancel of a church",
  and because `TERRAIN_NAME` gives it a tooltip. One extra `Uint8` index is the cheapest
  possible way to carry that semantic.

### 2.2 Map-level gate

`GameMap` gains `hasFurniture = false`, a plain mutable field set by the furnishing pass —
the same pattern as `maxStories` (`map.ts:25`), which gates the entire slab-LOS path
(`map.ts:156`), and as `TerrainLayer`'s `hasElev`/`hasStairs` (`terrain.ts:1073-1074`).
Every behaviour change in `src/sim/sim.ts` (§5.2) is guarded on it, so an unfurnished map
executes zero new instructions and is provably byte-identical.

### 2.3 Signature change

```ts
export function generateMap(
  seed: number, w = 160, h = 120, kind: MapKind = 'open',
  opts: { interiors?: boolean } = {},
): MapPlan
```

Production call sites opt in: `bridge.ts:135` and `scenario.ts:31`. Every pinned test
calls the 1-4 argument form and is untouched. The obvious objection — *the tested config
is not the shipped config* — is answered in §6.2: the furnished config gets its own inline
fingerprints and the full connectivity battery re-run with the flag on.

---

## 3. Room partitioning

### 3.1 Primitives

Interior tile set `M` = the building's `floor` tiles (for a bourg `parts` mass, the union
of its rects — the mask `stampStructure` already builds, T3 step 1).

```ts
wallRun(axis: 'h'|'v', fixed: number, from: number, to: number, doorAt: number, top: number)
```
writes `EDGE.WALL` with `hEdgeTops`/`vEdgeTops` = `top` across `[from, to)`, and
`EDGE.DOOR` with top 0 at `doorAt` — mirroring `addBuilding`'s top rule
(`mapgen.ts:342-346`). `top = stories * FLOOR_H`; where two masses of a group meet
(nave/tower) it is `max` of the two, per the town design's post-pass rule.

**Bounds discipline.** `setHEdge`/`setVEdge` do no bounds test (`map.ts:77-83`); a
`setVEdge(w+1, y)` silently lands on `vEdge(0, y+1)`. Valid domains: `hEdge x∈[0,w) y∈[0,h]`,
`vEdge x∈[0,w] y∈[0,h)`. `wallRun` asserts them in dev builds.

**Rules that hold for every split, every role:**

- Both children must be ≥ 2 tiles on the split axis. A 1-tile room is only ever produced
  deliberately, as a named `passage` or `aisle`.
- **At most three wall runs per building.** More than that and a 7×8 house is a maze: every
  interior wall is a full-height LOS block, so a diced interior turns room-clearing from a
  fight into a slog, and it starves the AI of garrison tiles with a line out of a window.
- Door position is **deterministic, no rng**: the run position that is not the first or
  last of the run and minimises Manhattan distance to the circulation seed (primary door
  tile, or the hall spine), ties to the lower index. Variety comes from split *positions*;
  variety in door positions buys nothing and costs a stream.
- Split positions draw from the building's `S(1)` partition sub-stream (§6.1).

Local axes: `F` = the side of the primary door; `across` = the dimension parallel to the
frontage wall (extent `A`), `deep` = perpendicular (extent `D`).

### 3.2 `house` / `farmhouse`

**Hall plan** (`A >= 7 && D >= 5`) — the standard Normandy longère/two-up-two-down:

- Hall = a 2-tile strip along `deep`, from the front door to the back wall, at across-index
  `hc = clamp(doorAcross - 1, 1, A - 3)`. Two full-depth wall runs at `hc` and `hc+2`, one
  door each. The hall is the circulation spine and is entirely keep-clear.
- Each flanking block is split once along `deep` at `dk = 2 + S(1).int(D - 3)` (clamped so
  both children ≥ 2). Result: 4 rooms + hall.
- Roles: the two front rooms are **parlor** (street-facing, they hold the good windows);
  of the two back rooms, the one whose block is wider is the **kitchen** (it needs an
  unbroken wall run for the hearth), the other is scullery (treated as parlor for
  furnishing).
- **Stair**: for a bourg building the stair is placed by `stampStructure` step 8 (the
  farthest interior tile from the primary door with all four neighbours in the mask); for a
  legacy building it is already at an interior corner (`mapgen.ts:347-367`). Interiors
  **never moves a stair.** It reads the stair tile, marks its room `landing`, and the
  connectivity kernel (§4.2) guarantees a door chain from the front door to it.
- Upstairs is the same shell (D1): hall becomes the landing, the four rooms become bedrooms.
  This satisfies "bedrooms up" honestly — the rooms exist on floor 1, they are the same
  rooms, and the stair is the only way between them.

**Passage plan** (`A <= 6 && A >= 5`) — the narrow terrace frontage:

- 1-tile passage along `deep` hugging the party-wall side (the side with the longer shared
  span with a different `buildingId`; ties to `indexInRun & 1` from T8's `Plot`, else the
  low-x/low-y side). One full-depth wall run bounding it, with two doors.
- Rooms: front room depth `3 + S(1).int(2)`, back room the remainder. Stair at the rear
  of the passage.
- The passage is the assault choke — single file, orthogonal transits only
  (`path.ts:107-114`), and one defender at its head covers the whole run.

**Enfilade plan** (`A <= 4`, or `D <= 4`): one cross split at
`k = 2 + S(1).int(max(1, span - 3))`, one door. Two rooms. Front room = parlor, back = kitchen.

### 3.3 `townhouse` (terrace variants)

Same as `house`, but the plan is selected by frontage width alone, and three variants are
drawn on `S(1)` with the weights below so a terrace run does not read as five copies:

| p | Variant |
|---|---|
| 0.45 | passage plan (above) |
| 0.35 | enfilade — front shop-less room / rear kitchen, one door, stair in the rear corner |
| 0.20 | **side-entry**: the primary door is on the frontage but the passage runs *across* the back, joining the rear door to the stair, leaving one full-width front room |

The hearth is always on a **party wall** for a townhouse — historically correct, and it
puts the chimney where `roofs.ts`' terrace parapet (N2) wants it.

### 3.4 `shop`

- **Storefront**: the frontage-side room, depth `dS = 3 + S(1).int(2)`, full width. One
  cross wall run at `dS` with one door.
- **Back room + store**: the remainder split along `across` at
  `ak = 3 + S(1).int(max(1, A - 5))` when `A >= 6`; larger child = back room (holds the
  stair), smaller = store. When `A < 6`, no split: one back room, the store is skipped.
- Store gets exactly one door, off the back room. It is the building's dead end and its
  best hiding place.

### 3.5 `barn`

A barn is a volume, not a plan. Two interventions only:

- **Stall line**: along the longer interior wall, `EDGE.WALL` stubs of length 1
  perpendicular to that wall, every 2 tiles, over the middle ~60 % of the run. These give
  **concealment, not cover** — walls grant no cover (§1) — but they break enfilade down the
  wall and give a cleared-out defender somewhere to be that is not the open bay.
- **Tack room**: if both interior dimensions ≥ 7, a 3×3 room in the corner farthest from
  the primary door, one door. Otherwise skipped.

Barns get a 2-wide primary door where the bourg's `DoorEdge.width` allows it. Two adjacent
`EDGE.DOOR`s still block vehicles (`canStep` vehicle mode requires `EDGE.NONE`,
`map.ts:123`), so a barn is infantry-permeable and tank-proof, like every other door.

### 3.6 `church` (roles `church`, `church_tower`, `church_apse`)

Depends on T7 emitting the three-rect group; interiors runs after `stampStructure`'s
shared-span post-pass and rewrites the spans it needs (D10).

- **Aisles.** If the nave's across-extent `A >= 9`, an **arcade** at across-index 2 (and at
  `A-3` when `A >= 13`), producing 2-tile side aisles. An arcade is
  `EDGE.WALL` at every 3rd position along the run and `EDGE.NONE` elsewhere — piers with
  openings. Not `EDGE.DOOR`: doors are orthogonal-transit-only (`path.ts:107-114`), which
  would make the aisle a series of one-way turnstiles. Piers-and-gaps gives free movement
  and *partial* LOS blocking, which is exactly what an arcade does in a real fight.
- **Chancel.** Cross wall run at `deep = D - (4 + S(1).int(3))`. The **chancel arch** is a
  contiguous `EDGE.NONE` span of width `2 + S(1).int(2)` centred on the central aisle; the
  rest of the run is `EDGE.WALL`. The arch is the last firing line before the altar.
- **Sacristy.** If the chancel's across-extent ≥ 7, a 3×(2..3) room in a chancel corner
  with a single door. The flanking prize and the hiding hole.
- **Tower room.** The `church_tower` mask's shared span with the nave becomes
  `EDGE.WALL` (top = `max(navetop, towertop)` = 12) with exactly **one** `EDGE.DOOR`. The
  tower's single stair column serves all four levels (`path.ts:132-155` connects any
  adjacent pair), so the tower is: one door, one stair, four floors, and a 10.6 m eye at
  the top. That is the set-piece the town design's §1.4 promised, and interiors is what
  makes it a room-clearing problem instead of an open shaft.
  **Requirement on T3/T7**: the church group's stair tile must be inside the tower mask.
  Interiors never moves a stair, so if `stampStructure`'s farthest-from-door rule puts it
  in the apse, the tower is not clearable and the test in §6.5 fails. T7 must pass an
  explicit stair hint for the church group.

### 3.7 Role inference for legacy kinds

Legacy `Building` has no `role` (`mapgen.ts:13-18`). Interiors infers one deterministically
and **writes it back onto `Building.role`** — safe: the field is outside the fingerprint
(`tests/mapgen.test.ts:9`) and `expect(a.buildings).toEqual(b.buildings)`
(`tests/mapgen.test.ts:26`) only requires determinism.

```
barn       : the SMALLER of any pair whose rect gap is <= 4 m   (mapgen's farm loop pushes
             house then barn, and the barn is always smaller: house 30-48 tiles vs barn
             20-35 — mapgen.ts:171-172). This is exactly roofs.ts:1181-1192's smallOfPair.
farmhouse  : the larger of such a pair
shop       : the two buildings with area >= 40 nearest objectives[0], ordered by
             (dist^2, index)
house      : everything else
church     : never (legacy generation has none)
```

Bonus: writing the role back lets Lane B **delete** `roofs.ts`' geometric `smallOfPair`
guess for maps that carry roles, which is half of N2's fix arriving for free.

---

## 4. Furnishing

### 4.1 The keep-clear mask `K` (deterministic, no rng)

Built before any furniture is considered. A candidate group intersecting `K` is rejected
outright.

| Seed | Why |
|---|---|
| Both interior tiles flanking every **exterior door**, plus one tile further in (a 2-tile apron) | assault entry must be usable; and `terrain.ts:826-835` decides internal-vs-external doors by `floorAt` on both flanks — a furniture tile there deletes the door-wear trail (§1, coupling 2) |
| One interior tile each side of every **interior door** | a door you cannot walk through is a wall |
| The interior tile flanking every exterior **window** — the *firing nook* | the brief's hard requirement: 1-tile standing room behind every window |
| Every **stair** tile and its 4 neighbours | `validate` requires stair reachability (`mapgen.ts:377-378`); the landing is the choke and must be fightable |
| The **building centre** tile `(b.x + (b.w>>1), b.y + (b.h>>1))` | `validate` probes it and `astar` fails instantly on an impassable goal (§1, coupling 1). Non-negotiable on every kind |
| Every **hall / passage / central-aisle** spine tile | circulation is the plan |

### 4.2 The commit rule — the non-sealing guarantee

Furniture is emitted as *groups* (a table is one group of 1-4 tiles, a pew block one group
of N tiles, a crate field one group per crate). Candidates are generated in a fixed
per-role order; for each candidate `g`:

```
if g ∩ K ≠ ∅                                   → reject
if g ∩ blocked ≠ ∅                             → reject
BFS from the primary door's interior tile over M \ (blocked ∪ g),
    8-connected, mirroring path.ts:107-118's no-corner-cutting rule exactly
if reached ≠ M \ (blocked ∪ g)                 → reject      // something got sealed off
else                                            → commit, blocked ∪= g
```

Rejection consumes no extra rng — the draws happen when the candidate is *generated*, and
the accept/reject decision is a pure function of geometry. So the stream is identical
whether a candidate lands or not.

This is strictly stronger than the brief's requirement: not merely "the door reaches the
rest of the building", but "no passable interior tile is ever cut off from any other".
Cost: `|M|` per candidate, ≤ 14 candidates per building, ~120 tiles → ~0.2 ms across 65
buildings.

Post-pass assertion (dev builds, and the §6.5 test in CI): for every building, BFS from
each exterior door reaches every passable interior tile, every stair tile, and at least one
nook tile of every room that has a window.

### 4.3 Per-role furniture tables

Order is fixed; each line is one or more candidate groups.

**house / farmhouse / townhouse**

| # | Group | Rule |
|---|---|---|
| 1 | `hearth` ×1 | kitchen; on the longest unbroken exterior-or-party `WALL` run with no window, preferring a gable (short-axis) wall; `S(3)` picks among the top 3 candidate tiles. Townhouse forces a party wall. |
| 2 | `furn_heavy` table, 1×2 or 2×2 | kitchen; free-standing if the room is ≥ 4×4, else against the wall opposite the hearth; never orthogonally adjacent to the hearth |
| 3 | `furn_light` ×1-2 | orthogonally adjacent to the table (chairs) |
| 4 | `furn_heavy` dresser, 1×2 | parlor; against a windowless wall segment. **Upstairs this tile is the wardrobe or the bed** (D1) — which is why it is authored wall-hugging |
| 5 | `furn_light` ×1 | parlor seat |
| 6 | `furn_heavy` ×1 — the **stair-head piece** | landing room, adjacent to the room's door, diagonal from the stair. Gives the defender `coverBehind 0.4` onto the only way up. This is the single most tactically valuable tile in a house |
| 7 | farmhouse only: `furn_light` ×2-3 | larder / scullery — barrels |

**shop**

| # | Group | Rule |
|---|---|---|
| 1 | `furn_heavy` **counter** run | storefront, parallel to the frontage at `deep` index `min(2, dS - 2)`, spanning the storefront's across-extent **minus one 1-tile gap**. Gap index = `clamp(doorAcross + 2 + S(3).int(2), 1, A-2)`, forced ≠ `doorAcross`. Skipped entirely if `dS < 3`. This is "counters covering shop doorways": an attacker through the front door faces the counter at 2 m, must step *around* the offset gap to get past it, and eats a defender with 0.4 cover the whole way |
| 2 | `furn_heavy` shelving 1×N | storefront, against the windowless side wall |
| 3 | `furn_heavy` table + `furn_light` ×1 | back room |
| 4 | `furn_light` crate field | store; fill 35-50 % of the room's non-`K` tiles by a fixed scan with an `S(3)` skip probability. Passable, so it can never seal — but at `moveCost 2.2` it doubles the time to clear |

**church**

| # | Group | Rule |
|---|---|---|
| 1 | `altar` ×1-2 | chancel, centred, 1 tile off the east wall |
| 2 | `furn_heavy` **pew blocks** | nave central vessel: leave 1 clear tile against each bounding wall/arcade (those are the window nooks and the side alleys), then two pew columns separated by a central aisle of width `2 + (A_central >= 8 ? 1 : 0)`. Rows run from `deep` 2 to `chancel - 2`, broken by a 1-tile **cross-lane** every `4 + S(3).int(2)` rows |
| 3 | `furn_light` ×1 | tower room corner (bell-rope frame); never on the stair or its neighbours |
| 4 | `furn_heavy` ×1 | sacristy (vestment press) |

The nave section therefore reads, across: `[1 clear][pews][2-3 aisle][pews][1 clear]`, with
cross-lanes along. A squad can advance up either side alley in cover from the pews they are
hugging, shift laterally on a cross-lane, and the central aisle is the killing ground the
chancel and the tower door both cover. That is the pew geometry the brief asked for and it
falls straight out of `coverBehind` being directional.

**barn**

| # | Group | Rule |
|---|---|---|
| 1 | `furn_heavy` manger ×1 | head of every other stall |
| 2 | `furn_heavy` workbench 1×2 + `furn_light` ×1 | tack room |
| 3 | `furn_light` clusters ×2-4, 1-3 tiles each | open bays; each ≥ 2 tiles from any door, positions from `S(3)` |

---

## 5. Tactical wiring

### 5.1 What works with no code change at all

- `sim.coverAt` maxes the tile's own `cover` with the four neighbours' `coverBehind`
  (`sim.ts:2910-2918`). Beside a counter it returns 0.40, beside a hearth 0.50, on a crate
  0.25. Therefore, for free:
  - `sim.inCover` (`sim.ts:2924-2926`) — already true indoors via the `=== 'floor'` clause,
    now *graduated* on the furniture tiles themselves;
  - `findCoverSpot` (`sim.ts:2928-2943`) — the suppressed-medic cover seek;
  - `dangerSamples` (`orders.ts:100`, `coverAt < 0.1` → +0.05 danger) — a route through a
    furnished building now scores measurably safer than a route across the street, so the
    compliance ladder (`orders.ts:130-139`) starts pushing squads through buildings.
    This is a real balance change on every map once the flag is on, and it is the change we
    want: it is how a town fight is supposed to work.
  - The UI move-preview dot colours, which read the same predicate.
- `ai.ts runDefend` (`ai.ts:294-313`) orders `ambush` at the post; `orderTeam` auto-picks
  the **top floor** for defend/ambush (`sim.ts:1332-1334`, `gl = st >= 2 ? st - 1 : 0`).
  Unchanged, and correct: the garrison goes upstairs, and now upstairs has furniture.
- `los()` costs nothing extra: `opacity: 0` on all four keys means the accumulator branch
  runs exactly as it does over `floor`.

### 5.2 The one thing that does need changing

`moveSoldiersTo` → `findSpot` (`sim.ts:1528-1542`) returns the **first** passable unused
tile in ring order. No cover awareness whatsoever. This is what actually places a
garrisoning squad, so today a squad ordered to ambush inside a church lands wherever the
ring scan happens to hit.

Change: score-then-take-max, ties to the first in the existing iteration order.

```ts
// score is identically 0 unless the map is furnished AND the tile is inside a building,
// so an unfurnished map takes the first-in-ring tile exactly as before.
private garrisonScore(x: number, y: number): number {
  if (!this.map.hasFurniture || this.map.buildingIdAt(x, y) < 0) return 0;
  const nook = /* any flanking edge is EDGE.WINDOW */ ? 2 : 0;
  const cov  = this.coverAt(x + 0.5, y + 0.5) >= 0.4 ? 1 : 0;
  return nook + cov;
}
```

**Why this guard is airtight:** `hasFurniture` is false on every map produced without
`opts.interiors`, so `garrisonScore` returns 0 for every candidate, so max-with-first-wins
returns exactly the tile the current code returns. Not "probably identical" — identical by
construction, and §6.5 asserts it against a golden list of 50 `findSpot` calls.

Deliberately *not* scored on generic terrain cover: doing so would change formation spots on
open ground on every map, which is a large, unrelated behaviour change hiding inside an
interiors task.

### 5.3 Requirements this delivers

| Requirement | Mechanism |
|---|---|
| every ground-floor room with a street-facing window is a usable firing position | window nooks are in `K` (§4.1) and asserted per-room in §6.5 |
| front + back doors give assault entry choice | D11; on the bourg, the rear door opens onto T8's garden network |
| stairs are the choke | stair + 4 neighbours in `K`; the landing room carries the stair-head `furn_heavy`; the defender upstairs sees the stairhead because stair tiles skip the slab test (`map.ts:241`) |
| church tower room is the prize | one door, one stair column serving 4 levels, 10.6 m eye; §6.5 asserts west spawn → tower stair at `l=0` → `l=3` |
| defend/ambush auto-garrison prefers furnished cover | §5.1 for free + the single `findSpot` change in §5.2 |

---

## 6. Determinism, fingerprints, tests

### 6.1 RNG stream plan

Follows the town design's D2 pattern exactly.

```ts
// mapgen.ts, AFTER the hill-dome loop (mapgen.ts:283-299), BEFORE validate:
if (opts.interiors) {
  const furnBase = rng.int(0x7fffffff);          // exactly ONE draw on the shared stream
  furnishInteriors(map, buildings, furnBase);
}
```

- Flag off → zero draws, zero writes. Every pinned fingerprint holds by construction.
- Flag on → the one draw is the *last* draw of `tryGenerate`; nothing downstream consumes
  it, so the pre-existing arrays are bit-identical to the unfurnished map.
- Per building: `S(tag) = mulberry32((furnBase ^ Math.imul(key, 0x9e3779b1) ^ Math.imul(tag, 0x85ebca6b)) >>> 0)`
  with `key = ((b.x * 73856093) ^ (b.y * 19349663) ^ (b.w * 83492791) ^ b.h) >>> 0` (D9 —
  geometry-keyed, never index-keyed).
- Tags, fixed constants, never renumbered: `1` partition, `2` doors/role, `3` furniture,
  `4` render-facing variant bits.
- `mulberry32` is a 32-bit counter (`rng.ts:8-22`); two streams seeded 1 apart correlate for
  the first few outputs. Never `base + tag`. `rng.int(0)` still burns a draw
  (`rng.ts:21`) — never write `S(t).int(n)` where `n` can be 0 (every `int()` above is
  wrapped in a `max(1, …)`).

### 6.2 Fingerprint strategy

**Must stay green, must not be re-snapshotted** (all call the ≤4-arg form, so all are
mechanically untouched):

- `tests/mapgen.test.ts:37-38` — `8105059f` / `d2a77805`. The drift tripwire.
- `tests/mapgen.test.ts:41-102` — seeds 1-30 connectivity, first-3-buildings, hedge steps,
  orchard count.
- `tests/mapgen.test.ts:104-194` — bridge/river geometry, bridge-last, 60×40 floor.
- `tests/mapgen.test.ts:153-161` — `'town'` density.
- `tests/sim.test.ts:192` (`generateMap(1)`, path into `buildings[0]` at `+2,+2`) and
  `tests/vehicles.test.ts:63` (`generateMap(34)`, vehicles cannot enter `buildings[0]`).
- `tests/perf.test.ts:47, 88, 164, 249` — the ≥56-tile 2-storey rule.
- `tests/patches.test.ts`, `tests/props.test.ts` — all `'town'`, ≤4 args.

**New inline fingerprints** (same FNV-1a helper, same seven arrays):

- `generateMap(1 | 2, 160, 120, 'open', { interiors: true })` — the shipped config gets its
  own drift tripwire, which is the answer to "you only fingerprint the unshipped path".
- `generateMap(1 | 2, 320, 240, 'bourg', { interiors: true })` — frozen alongside T14.

**The delta invariant** (the cheapest and strongest test in this document). For the same
seed, `interiors:false` vs `interiors:true`:

- `elev`, `stories`, `buildingId`, `stairs`, `bridges` — **byte-identical**;
- `buildings[i].{x,y,w,h}`, `objectives`, `spawns`, `woodsStands` — **deep-equal**;
- `tiles` — differ only where the new value is one of the four furniture keys and the old
  value was `floor`;
- `hEdges`/`vEdges` — differ only at (a) edges whose two flanking tiles are both `floor`
  with the same `buildingId`, and (b) at most one added `EDGE.DOOR` per building on an
  exterior wall.

This proves the pass is purely additive, and it is why `scripts/lib/stage.mjs:79` needs **no
change**: `deriveTargets` re-runs `generateMap` standalone to derive crop coordinates from
objectives and building centres, and none of those move.

**Art baselines.** Existing sweep crops keep the ≤4-arg call and are expected to be
unchanged; even with the flag flipped they would mostly be unchanged, because roofs occlude
interiors below `FADE_SCALE = 26` px/m (`roofs.ts:24`). Add **one new crop set** at 32 px/m
over a house, a shop, and the church nave. The decision to flip the sweep globally is
deferred until the interior art has landed and been signed off.

### 6.3 Connectivity tests (`tests/interiors.test.ts`)

Seeds 1-30, kinds `open`/`town`/`woods` at 160×120 and 320×240, plus `bourg` at 320×240,
all with `interiors: true`:

1. **Door→stairs.** For every building with `stories >= 2`: BFS on the interior at level 0
   from each exterior door's interior tile reaches the stair tile.
2. **Furniture never seals a room** (the invariant). For every building: BFS from the
   primary door over passable interior tiles reaches *every* passable interior tile of that
   building. Also: no building has zero passable interior tiles, and every building's
   centre tile is passable.
3. **Window nooks.** Rooms are recomputed *by the test*, independently of the generator, as
   connected components of interior tiles under the interior-wall edges. Every room with at
   least one exterior `WINDOW` has at least one passable flanking tile, reachable from the
   primary door. (Recomputing rather than reusing the generator's room list is the point —
   otherwise the test proves only that the generator agrees with itself.)
4. **Two doors.** Every building with interior area ≥ 20 has ≥ 2 exterior `EDGE.DOOR`s on
   ≥ 2 distinct sides.
5. **Vehicle-proof.** For every furniture tile, `canStep(..., 'vehicle')` into it is false;
   `findVehicleSpot` never returns a tile with `buildingIdAt >= 0`.
6. **Church** (bourg): exactly one stair tile inside the tower mask; the nave has a
   continuous clear central lane ≥ 2 tiles wide from the west end to the chancel arch;
   `astar` from `spawns.west` to the tower stair at `l=0` succeeds and from there to `l=3`
   succeeds. This is also the first test the project has of 3+ storeys, which the audit
   flags as "representable and completely untested".
7. **`validate` still passes** with the flag on for all 30 seeds × all kinds — i.e. the
   furnishing pass never rejects a map that would otherwise have been accepted. Reject-rate
   delta reported; hard-assert 0.

### 6.4 Determinism tests

- Two `generateMap(s, …, { interiors: true })` calls → identical `tiles`, `hEdges`,
  `vEdges`, `elev`, `stories`, `buildingId`, `stairs`, `buildings`.
- **Order invariance** (makes D9 real): furnish a hand-built `Building[]`, then furnish a
  shuffled copy of the same array, and assert each building's tile set and edge writes are
  identical. This is the test that lets the bourg reorder its emission without every
  interior in the game changing.
- **Zero-draw proof**: instrument `Rng.next` and assert the draw count for
  `generateMap(1)` is unchanged from the pre-interiors build.

### 6.5 Other tests

- `findSpot` parity: on an unfurnished map, 50 recorded `findSpot(x, y, used)` calls return
  the same tiles before and after the §5.2 change.
- `canStep`/`findVehicleSpot` parity for D12: over 200 random (tile, mode) pairs on seeds
  1-10, the `noVehicle`-flag implementation agrees with the key-blacklist implementation.
- Perf (`tests/perf.test.ts`): furnishing adds < 1.5 ms at 160×120 `open` and < 4 ms at
  320×240 `bourg` (65 buildings). Budget check against the town design's ~19 ms/attempt →
  ~23 ms.

---

## 7. Render tasks (Lane B) — the complete list

The `drawTile` dispatch (`terrain.ts:868`) has a catch-all `else` that draws plank floor,
so **new furniture keys render as floorboards until R2 lands** — Lane A can ship first with
no visual corruption. Everything below is drawn inside `TerrainLayer`'s baked chunks,
i.e. under the roof, so it is revealed by the existing roof fade
(`roofs.ts:1155-1176`, `interiorVisibleAt` at `roofs.ts:1196-1201`) with no new gating.

- **R1 · Per-room floor materials.** Extend the `drawTile` floor branch
  (`terrain.ts:1002-1013`). Material is `Building.role`-derived, not room-derived (D8):
  church → stone flags, shop → quarry tile, barn/farmhouse → packed earth and straw,
  house/townhouse/civic → planks (unchanged). Plus one genuinely per-room accent that needs
  no new data: **flagstone within Chebyshev 2 of a `hearth` tile** — the kitchen reads
  differently from the parlor off the terrain grid alone. `TerrainLayer` is constructed as
  `new TerrainLayer(sim.map)` (`renderer.ts:208`) where `sim` is in scope, so pass
  `sim.buildings` and build a `roleByBuildingId: Uint8Array` once in the ctor.
- **R2 · Furniture sprites.** Baked per (key, variant, zoom band) like `canopySprite`, muted
  palette, single sun from `light.ts` `SUN`. Top-down: table = a plank rectangle with a
  drop shadow; counter = a run with a bullnose edge; pew = a bench with a back; crate =
  stacked boxes; wardrobe/dresser = a dark slab with a highlight edge; altar = pale stone
  with a cloth. Run axis derived from neighbours of the same key (no new data).
- **R3 · Hearth glow and rugs.** Rug = a render-only stamp, hash-gated, on floor tiles
  adjacent to a `furn_heavy` in a `house`/`townhouse` building. Hearth glow **cannot go in a
  baked chunk** (it flickers): draw it in the frame loop gated on
  `roofs.interiorVisibleAt(x, y)`, exactly as `terrain.drawStairs` already is
  (`renderer.ts:183`).
- **R4 · Interior wall styling.** `drawEdge` (`terrain.ts:1041-1063`) currently paints every
  `EDGE.WALL` identically. Add a branch for edges whose two flanking tiles are both `floor`
  — the test `terrain.ts:826-835` already performs — drawing lath-and-plaster (lighter,
  thinner) rather than exterior masonry, plus pier blobs where an arcade's `WALL` stubs sit
  between `NONE` gaps.
- **R5 · Chimney over the hearth.** `roofs.ts` places chimneys by hash today
  (`roofs.ts:350`). When the building has a `hearth` tile, put the primary chimney over it.
  One lookup, and it is the difference between a house and a house that makes sense.

---

## 8. Task breakdown

Lanes match the town design's split, so the same two implementers absorb them.
**File ownership adds no row to that table and collides with nothing**: Lane A adds
`src/sim/data.ts`, `src/sim/map.ts`, `src/sim/sim.ts`, `src/sim/interiors/*`,
`src/ui/tooltip.ts`; Lane B's files are already Lane B's.

**I2 is the interiors interface freeze**, mirroring T2. Lane B starts there.

### Lane A — sim

| # | Task | Files | Spec | Size | Depends on |
|---|---|---|---|---|---|
| **I1** | Terrain contract | `src/sim/data.ts`, `src/sim/map.ts`, `src/sim/sim.ts`, `src/ui/tooltip.ts` | Append the four keys of §2.1 after `water`; add `TerrainDef.noVehicle` and convert `canStep` (`map.ts:114-117`) and `findVehicleSpot` (`sim.ts:936-947`) to it (D12); add `GameMap.hasFurniture`; add four `TERRAIN_NAME` entries. Ship the parity test of §6.5. Zero behaviour change, all tests green. | **S** | T2 (serialises `mapgen.ts` edits) |
| **I2** | **INTERFACE FREEZE** | `src/sim/interiors/types.ts` (doc comment) | Publish, as a doc comment readable from the sim side: the furniture code table (§2.1), the `RoomKind` list, the role-inference rules (§3.7), the `K` mask contents (§4.1), and the D10 edge-ownership rule. `tsc --noEmit` green, zero behaviour change. **Both lanes start from this commit.** | **S** | I1 |
| **I3** | Kernel: interior reset, `wallRun`, connectivity BFS | `src/sim/interiors/kernel.ts` | D10's interior reset; `wallRun` with dev bounds assertions on the `setHEdge`/`setVEdge` domains; the 8-connected BFS mirroring `path.ts:107-118`'s corner rule; the keep-clear mask builder; the commit-rule harness of §4.2. Unit-tested standalone against hand-built masks (rect, L, U, terrace pair, church group) before any generator calls it — this is where a bug corrupts the far side of the map silently. | **M** | I2 |
| **I4** | House / farmhouse / townhouse partitioners | `src/sim/interiors/rooms.ts` | §3.2 hall / passage / enfilade plans, §3.3's three townhouse variants, the ≤3-wall-run cap, the deterministic door rule, stair-room detection (never move a stair). | **L** | I3 |
| **I5** | Shop + barn partitioners | `src/sim/interiors/rooms.ts` | §3.4 storefront/back/store, §3.5 stall stubs and tack room. | **M** | I3 |
| **I6** | Church partitioner | `src/sim/interiors/church.ts` | §3.6: arcades as pier-and-gap `WALL`/`NONE` runs, chancel + arch, sacristy, tower door. **Includes the T7 change** that hints the church group's stair into the tower mask. | **L** | I3, **T7** |
| **I7** | Furnishing pass | `src/sim/interiors/furnish.ts` | §4.3's four role tables against the §4.2 commit rule, the §6.1 sub-stream helper, and the dev-build post-pass assertions of §4.2. | **L** | I4, I5 |
| **I8** | Rear doors + legacy role inference | `src/sim/interiors/roles.ts` | D11's second door (position: opposite side, ≥ 2 from any corner, overwriting a window if needed); §3.7's inference written back onto `Building.role`. | **M** | I3 |
| **I9** | Wire into `generateMap` | `src/sim/mapgen.ts`, `src/strategic/bridge.ts`, `src/sim/scenario.ts` | The `opts.interiors` parameter, the single post-dome draw of §6.1, the call before `validate`; opt in at `bridge.ts:135` and `scenario.ts:31`. **Verify in the same commit that `generateMap(1)`/`(2)` still fingerprint `8105059f`/`d2a77805`.** | **M** | I7, I8; **T11** for the bourg branch |
| **I10** | Garrison preference in `findSpot` | `src/sim/sim.ts` | §5.2's `garrisonScore` + max-with-first-wins, guarded on `map.hasFurniture`, plus the golden-list parity test. | **S** | I1 |
| **I11** | `tests/interiors.test.ts` | new | Everything in §6.3 and §6.4, including the church multi-storey clearance test and the delta invariant of §6.2. | **M** | I9 |
| **I12** | Fingerprints, perf, decision log | `tests/mapgen.test.ts`, `tests/perf.test.ts`, `docs/decisions/INDEX.md` | The four new inline fingerprints of §6.2, the perf assertions of §6.5, and a decision-log entry recording D1-D12 and the rejected alternatives (per-level terrain array, room-id map array, `cover` instead of `coverBehind`, passable heavy furniture, `featureHeight` on furniture, furnishing before the dome pass). | **S** | I11; bourg fingerprints after **T14** |

### Lane B — render (starts at the I2 freeze)

| # | Task | Files | Spec | Size | Depends on |
|---|---|---|---|---|---|
| **I13** | Furniture sprites + `drawTile` branches (R2) | `src/render/terrain.ts` | Four keys, baked per (key, variant, band), muted palette, one-sun shading, run-axis from neighbours. Developable against a hand-authored `GameMap` fixture before Lane A emits anything. | **L** | I2 |
| **I14** | Per-building floor materials (R1) | `src/render/terrain.ts`, `src/render/renderer.ts` | Role-derived floor material + the hearth flagstone apron; `roleByBuildingId` built in the `TerrainLayer` ctor from `sim.buildings`. | **M** | I2 |
| **I15** | Hearth glow + rugs (R3) | `src/render/terrain.ts`, `src/render/renderer.ts` | Baked rug stamps; flickering hearth glow in the frame loop gated on `roofs.interiorVisibleAt`, following the `drawStairs` pattern at `renderer.ts:183`. | **M** | I13 |
| **I16** | Interior wall + arcade pier styling (R4) | `src/render/terrain.ts` | `drawEdge` branch for floor-on-both-sides edges; pier blobs on arcade `WALL` stubs. | **S** | I2 |
| **I17** | Chimney over the hearth (R5) | `src/render/roofs.ts` | Primary chimney positioned on the building's `hearth` tile when it has one. | **S** | I2 |

### Ordering

```
T2 ─► I1 ─► I2 ─┬─► Lane A: I3 ─┬─► I4 ─┐
                │               ├─► I5 ─┼─► I7 ─► I9 ─► I11 ─► I12
                │               ├─► I8 ─┘        ▲
                │               └─► I6 (needs T7)┘   (I9 also needs T11)
                │               I10 (independent, needs only I1)
                └─► Lane B: I13 ─► I15
                            I14
                            I16
                            I17
```

Lane B is fully parallel after I2 and internally independent except I13 → I15. Lane A is a
chain, which is inherent; I1/I2/I10 are carved out so they can land and be reviewed alone.

### Cuts, in order, if schedule pressure appears

1. R3's rugs (keep the hearth glow — it is the one thing that makes a revealed interior
   feel lit).
2. The barn stall line and tack room (I5 halves).
3. The townhouse side-entry variant (I4, drop to two variants).
4. The sacristy (I6).

**Do not cut**: the keep-clear mask (§4.1) or the commit rule (§4.2) — they are the
correctness of the whole pass; the counter (it is the entire reason a shop is a different
fight from a house); or the church pews and tower door (they are the set-piece the bourg
was designed around).
