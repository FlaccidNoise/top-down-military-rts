# Bourg pipeline — organic Normandy town generator

Design owner: lead technical designer. Date: 2026-07-26. Target: `src/sim/mapgen.ts`
gains a new `MapKind = 'bourg'`, plus additive render dressing.

All line references verified against the working tree at `da5037d`.

---

## 0. Decisions up front (read this if you read nothing else)

| # | Decision | Why |
|---|---|---|
| D1 | **New `MapKind` `'bourg'`, fully guarded branch.** `'town'` is left byte-identical. | The `'open'`/`'road'` 160×120 draw sequence is the fingerprint (`tests/mapgen.test.ts:36-39`); `'town'` is pinned by the density test (`tests/mapgen.test.ts:153-161`) and by every `scripts/sweep.mjs` art baseline. A new kind costs one `CELL_MINUTES` entry and breaks nothing. |
| D2 | **The bourg branch runs on derived sub-streams, not the shared stream.** One `rng.int(0x7fffffff)` draw inside the guard seeds a base; each stage derives `mulberry32(base ^ TAG_n)`. | Makes each stage's draw count independent of every other stage. Without this, tuning stage 5's branch probability reshuffles stages 6-13 and every seed's town changes. This is the single highest-leverage structural choice in the doc. |
| D3 | **Validation is rewritten from 36 A\* to 3 flood fills, as a prerequisite, for all kinds.** | Measured: `validate` is 47.3 ms of the 52.2 ms `'town'` cost; `tryGenerate` is 0.8 ms. Cost is linear in building count (`mapgen.ts:375`), and a bourg has ~65 buildings, not 22. Without this the bourg costs ~150 ms/attempt. The substitution is semantics-preserving and draws no rng, so fingerprints hold. |
| D4 | **Composite buildings: one `Building` per roof mass, grouped by `groupId`, never one `Building` with a merged bbox.** | A terrace of 5 houses must read as 5 roofs. The audit confirms abutting rects merge correctly *only if* the shared span is explicitly rewritten after stamping, and that `buildingId` must be forced shared or `floormenu.ts:38-47` and `patches.ts:29-47` split. `parts?: Rect[]` exists for genuinely single-mass L/T shapes (rear wing under one roof plane). |
| D5 | **Party walls between neighbours are `EDGE.WALL`, party walls inside a group are `EDGE.NONE`.** | Verified by the audit's probe: the second stamp overwrites the first, leaving `[WALL, WINDOW, WALL, WALL, WINDOW]`. A `WINDOW` on a party wall is a free LOS hole into the neighbour's house. Both cases require an explicit post-pass; they just write different values. |
| D6 | **Gates are `EDGE.DOOR` in a wall run.** | `canStep` (`map.ts:123-124`) passes foot through `DOOR` and blocks vehicles on anything but `NONE`. That is exactly "infantry-permeable, vehicle-proof" with zero new sim surface — the same trick hedgerows used in mapgen v2. |
| D7 | **Free-standing walls carry `hEdgeTops`/`vEdgeTops` of 1 or 2 m, and 1 m walls give no cover.** | `los()` blocks only when `z < edgeTop` (`map.ts:210-213, 219-222`); eye height is 1.6 m (`map.ts:12`). A 2 m wall blocks standing LOS both ways; a 1 m wall does not. **Neither grants `cover`** — `los()` sources cover from `TerrainDef.cover`, `WINDOW`, and `coverBehind` only (`map.ts:151, 273-274`). Low-wall cover would need a new `edgeCover` array; explicitly out of scope, recorded as a known gap. |
| D8 | **No new terrain key.** | `TERRAIN_KEYS = Object.keys(TERRAIN)` and tile indices are positional (`map.ts:9, 54-56`). The place is carved as `road`, which is what `drawPaving`'s `pavable` test already requires (`terrain.ts:673-681`). Adding `cobble` would buy a move-cost knob at the price of the whole index contract. |
| D9 | **Objectives are extended, and tagged.** `MapPlan.objectiveKinds?: ObjectiveKind[]`. | `GARRISON_RADIUS = 45` (`bridge.ts:86`) drops any building centre farther than 45 m from every objective. A 110-tile-wide bourg with one central objective leaves its whole edge ungarrisoned. Greedy coverage fill solves it deterministically; the tag array stops tooling from index-guessing. |
| D10 | **Rotation-free means the frontage-bearing network is rectilinear polylines with jogs.** Curvature comes from topology (jogs, tangent streets, chamfers), never from angle. | Axis-aligned edge walls cannot form continuous frontage along a diagonal street, and a staircase of edges is a real trap: `astar`'s no-corner-cutting rule (`path.ts:107-114`) makes the steps impassable while `los()`'s Amanatides–Woo traversal sees straight through the gap. |

---

## 1. Morphology model

### 1.1 Archetypes

One roll per map, weighted. All four share the same parcel/footprint machinery; they
differ only in the Stage-3 skeleton and the Stage-4 landmark placement.

| Archetype | w | Skeleton | Signature |
|---|---|---|---|
| `carrefour` | 0.35 | Grande Rue + 2–3 converging routes meeting at one junction | Sainte-Mère-Église. Densest frontage on the two arms nearest the place. Non-90° convergence faked with a dogleg: the route arrives diagonally *outside* the envelope, then jogs axis-aligned for its final ~25 tiles. |
| `bourg-rue` | 0.35 | One Grande Rue, 1–3 short spurs | Linear village. No plaza — only a street widening at the church. Gardens behind, fields beyond. |
| `enclos` | 0.20 | Ring of streets tangent to the churchyard; main route passes on one side only | Church-nucleus. The oval plot ring around the churchyard is the town. |
| `faubourg` | 0.10 | Dense core + detached secondary cluster 60–90 tiles along the arterial | Extends what `mapgen.ts:153-161` already does for `w >= 240`. |

### 1.2 The density scalar

Everything downstream is driven by one integer-safe field, computed once:

```
dens(x,y) = 256 / (256 + 12 * cheb((x,y), place))     // Q8 fixed point, 0..256
```

Chebyshev, not Euclidean — no `sqrt`, no `hypot` (the line `mapgen.ts:10-11` already holds).
`dens` governs, in order of visual importance:

1. **frontage continuity** — probability a plot gets a building at all (0.95 at the place → 0.15 at the envelope edge)
2. **setback** — 0 tiles in the core (front wall *is* the street edge), 2–4 in the fringe
3. **plot width** — 5–9 tiles core (burgage: a real English burgage frontage is 28–32 ft ≈ 8.5–9.7 m), 9–16 fringe
4. **storeys** — the ≥56-tile 2-storey rule stays (it is pinned by `tests/perf.test.ts:88, 249`), but core plots are dimensioned to clear it and fringe plots to fall under it
5. **role** — shop/townhouse in the core, house/farmhouse at the edge

There is no hard boundary anywhere in this model. The one thing that reads as "generated"
faster than anything else is a solid ring of terrace that stops dead; the density gradient
is the fix, and it matches the record (Norman town centres kept gardens penetrating even
hypercentral areas — a "nebular" townscape, not a solid block).

### 1.3 Morphological elements, and what each is made of in this substrate

| Element | Substrate realisation |
|---|---|
| **Grande Rue** | 3-tile `road`, rectilinear polyline, straight runs of 25–45 tiles between 1–3-tile perpendicular jogs. The straight runs are the MG lanes. |
| **Place / market** | Grande Rue widened to 11–17 tiles over a 26–42-tile run centred on the carrefour, asymmetrically. Carved as `road` so G7 paving fires. Not a square — a widening. Historically correct and mechanically simpler. |
| **Market infill island** | p 0.6: a 2–4-unit terraced island block dropped inside the widened area, off-centre, leaving 3–5-tile lanes either side. Splits the place into two lanes. Highest ratio of recognisability to code in the whole document. |
| **Churchyard (`enclos`)** | 24–34-tile square reserved *before* minor streets grow, offset `±4` from the carrefour (never centred). Corners chamfered by a 3–5-step staircase of tiles. Enclosed by a 2 m stone wall (edge walls, top 2) with 2 gates (`EDGE.DOOR`): one onto the place, one onto a side street. |
| **Church** | Three grouped rects: nave `9×22` (`stories 2`), tower `5×5` at the west end (`stories 4`), apse `5×4` at the east. Shared spans cleared to `EDGE.NONE`. `map.maxStories = 4`. |
| **Terrace** | Adjacent `Building`s abutting on a shared span, rewritten to `EDGE.WALL` (top `stories*3`), all doors on the street side, one rear door each. |
| **Venelle** | 1–2-tile gap between terrace units, gated at the street mouth with `EDGE.DOOR` in the flanking garden walls → infantry-only, vehicle-proof. |
| **Porte-cochère** | p 0.15 in the core: a 1-tile passage punched through a house body (two `DOOR` edges through the mask). Invisible from the street, infantry-only. |
| **Back garden** | Every core plot's tail. Bounded by 1 m walls (see-over) on plot boundaries and a 2 m wall at the rear, one gate per 2–3 plots. This is the flanking network. |
| **Back lane (`venelle de derrière`)** | Inserted along the ridge of any block whose depth field exceeds 26 tiles. 1-tile `grass` corridor with gates. |
| **Farm compound (`cour`)** | 3 grouped rects — logis 7×5, grange 11×6, étable 8×5 — on three sides of a 9–13-tile yard; fourth side a 2 m wall with a 2-tile gate. All doors face the yard. A natural strongpoint. |
| **Bocage fringe** | Jittered-grid Voronoi hedgerow parcels outside the envelope, replacing the drifting parallel lines at `mapgen.ts:213-214`. Gates punched at one jittered position per shared edge. |
| **Farm lanes** | Space-colonisation dendrites from arterial seed nodes to compound yards, rasterised as L-doglegs (never diagonals). |

### 1.4 Battle-playability model

This is a design requirement, not a side effect. The bourg must produce three distinct
fights, and the generator is tuned to guarantee each:

1. **The street fight.** The Grande Rue's straight runs are 25–45 tiles = 25–45 m of clean
   MG lane, terminated by a jog. An MG42 on the place at `objectives[0]` (which
   `scenario.ts:49` already emplaces) covers one approach arm end to end; the jog is where
   the attacker gets out of it. Constraint enforced in Stage 3: **no straight run of the
   Grande Rue inside the envelope may exceed 45 tiles** (reroll the jog schedule), or the
   whole town becomes one bad corridor.
2. **The flank.** Garden walls + rear doors + gates form a continuous foot-only network
   behind both frontages, parallel to the Grande Rue, at a movement cost premium (doors are
   orthogonal-only transits — `path.ts:107-114` — so a squad threading gardens moves in
   single file and loses formation). Constraint enforced in Stage 10: **the rear network
   must be foot-connected end to end on at least one side of the Grande Rue**, verified in
   the flood-fill gate.
3. **The tower.** 4 storeys = 12 m + 1.6 m eye. It sees over every 2 m wall and every
   1-storey roof. It is the most valuable object on the map, it has exactly one stair
   column (which `path.ts:132-155` treats as connecting any adjacent pair of levels, so one
   column serves all four floors), and taking it is a room-clearing problem. This is the
   set-piece.

Vehicles get the Grande Rue, the cross route, and the place. They get nothing else: every
side street narrower than 2 tiles, every venelle, every garden gate is `DOOR`-gated or
wall-flanked. A tank on the place is a threat to the frontage and useless against the
gardens — which is the correct Normandy asymmetry.

---

## 2. Pipeline

### 2.1 RNG stream plan

```ts
// inside `if (kind === 'bourg') { ... }` — zero draws on any other kind
const bourgBase = rng.int(0x7fffffff);              // exactly ONE draw on the shared stream
const S = (tag: number): Rng => mulberry32((bourgBase ^ Math.imul(tag, 0x9e3779b1)) >>> 0);
```

Stage tags are fixed constants, never renumbered:

| Tag | Stage | Tag | Stage |
|---|---|---|---|
| 1 | archetype + envelope | 8 | parcelisation |
| 2 | regional roads | 9 | footprint synthesis |
| 3 | bourg skeleton | 10 | enclosures + back network |
| 4 | landmark reservation | 11 | rural fabric |
| 5 | minor streets | 12 | orchards / fields |
| 6 | (block extraction — no draws) | 13 | woods stands |
| 7 | (depth field — no draws) | 14 | elevation |

**Rules that must hold:**

- One draw on the shared stream (`bourgBase`), inside the guard. Everything else is
  sub-stream. Retuning stage 8 cannot move stage 9.
- `mulberry32` is a 32-bit counter (`rng.ts:8-22`); two sub-streams seeded 1 apart are
  *correlated* for the first few outputs. `Math.imul(tag, 0x9e3779b1)` spaces them by the
  golden-ratio odd constant, which is the standard fix. Do not use `base + tag`.
- No sorting on a bare float. Every comparator gets an index tiebreak.
- The Stage-5 priority queue keys on `(t, insertionIndex)`, never on `t` alone.
- No `Math.hypot`, no `atan2`. Squared-integer, Chebyshev, or Manhattan distance only.
- `rng.int(0)` still burns a draw (`rng.ts:21`). Never write `rng.int(n)` where `n` can be 0.

### 2.2 Stages

Working arrays, all typed, all allocated once per attempt:

```ts
const road   = new Uint8Array(w * h);     // 1 = road centreline/width carved
const resv   = new Uint8Array(w * h);     // 1 = reserved (churchyard, place, infill)
const blockId= new Int32Array(w * h);     // -1 on road/water/reserved
const depth  = new Int16Array(w * h);     // multi-source BFS distance from road, 0 on road
const occ    = new Uint8Array(w * h);     // 1 = a footprint or wall claims this tile
```

---

#### Stage 1 — Seed and envelope · tag 1 · ~0 ms

```
archetype = weightedPick(S(1), [carrefour .35, bourgRue .35, enclos .20, faubourg .10])
placeX    = round(w * S(1).range(0.42, 0.60))
placeY    = roadY[placeX]                       // arterial from Stage 2 must run first — see note
envW      = 70 + S(1).int(41)                   // 70..110
envH      = 55 + S(1).int(31)                   // 55..85
R_env     = rect centred on place, clamped to [6, w-6] × [6, h-6]
```

Ordering note: the arterial (Stage 2) is computed before the envelope because `placeY`
reads `roadY`. Stage 1 therefore draws archetype + envelope dims first, Stage 2 walks the
arterial, then `place` is resolved. Keep those in that literal order.

`dens` is computed lazily as a function, not materialised — it is a 3-op integer expression.

---

#### Stage 2 — Regional roads · tag 2 · ~0 ms

Reuse the existing drifting arterial walk (`mapgen.ts:57-63`) verbatim, on `S(2)`, but only
**outside** `R_env`. Inside `R_env` the arterial is replaced by the Stage-3 Grande Rue. At
each of the two envelope boundary crossings, emit a single explicit jog connecting the
drifting centreline to the Grande Rue's axis-aligned line — the road arrives wandering off
the fields and straightens as it enters town, which is exactly what a real approach does.

`bridge`/`river` water bands do **not** apply to `bourg` (it is its own kind). If a
river-bourg is wanted later it is a separate archetype, not a flag.

---

#### Stage 3 — Bourg skeleton · tag 3 · ~0 ms

The Grande Rue is a **rectilinear polyline**, width 3:

```ts
type Seg = { ax: number; ay: number; bx: number; by: number; axis: 'h'|'v';
             width: 1|2|3; rank: 0|1|2|3; t: number };
```

Grande Rue construction (axis `h`, mirrored for `enclos`/`bourg-rue` variants):

```
y = placeY; x = R_env.x0
while x < R_env.x1:
  run = 25 + S(3).int(21)                 // 25..45 — the MG-lane cap (§1.4)
  emit Seg{ (x,y) → (min(x+run, x1), y), axis 'h', width 3, rank 0 }
  x += run
  if x < x1:
     jog = 1 + S(3).int(3)                // 1..3 tiles
     dir = S(3).next() < 0.5 ? -1 : 1
     emit Seg{ (x,y) → (x, y + dir*jog), axis 'v', width 3, rank 0 }
     y += dir*jog
```

Cross route: same construction on the perpendicular axis, width 2–3, passing through
`place`. For `carrefour`, 1–2 additional routes arrive at the same junction: outside
`R_env` they are drifting walks at a rough diagonal; at the envelope they dogleg to
axis-aligned for their last ~25 tiles. The convergence therefore *looks* multi-angled from
above and is fully axis-aligned where it carries frontage.

For `enclos`, the Grande Rue passes tangent to the reserved churchyard rather than through
the junction; the ring streets are emitted in Stage 5 as rank-1 segments constrained to
hug the reservation.

---

#### Stage 4 — Landmark reservation · tag 4 · ~0 ms

Runs **before** minor streets, so the streets route around the landmarks rather than
through them. That routing-around is what produces the characteristic tangent-street ring.

1. **Churchyard.** Origin `place + (S(4).int(9)-4, S(4).int(9)-4)`, side `24 + S(4).int(11)`.
   Chamfer each corner by a 3–5-step tile staircase. Mark `resv = 1`.
2. **Place widening.** Over a run of `26 + S(4).int(17)` tiles centred on the carrefour,
   widen the Grande Rue from 3 to `11 + S(4).int(7)`, split asymmetrically
   (`northShare = 3 + S(4).int(width-5)`). Written into `road`.
3. **Market infill.** p 0.6: reserve a `6..11 × 5..8` island inside the widened area,
   offset from centre by `2 + S(4).int(5)`, guaranteeing ≥3 tiles of lane on both flanks.
   Mark `resv = 2` (build here in Stage 9).
4. **Civic forecourt.** Reserve a `10×8` set-back parcel on the place for mairie/école.

---

#### Stage 5 — Minor streets · tag 5 · <1 ms

Parish & Müller's growth loop, stripped of the L-system framing (it buys nothing at 20
segments) and of all angles.

```
PQ keyed (t, insertionIndex)   // total order — never key on t alone
seed with the rank-0/1 segments
while PQ not empty and segs < 24:
  seg = pop()
  # globalGoals
  if seg.rank >= 3: continue
  p_branch = 0.55
  if S(5).next() < p_branch:
     root   = point along seg at 18 + S(5).int(15) tiles past the last branch
     side   = higher-dens side with p 0.65, else the other
     len    = 20 + S(5).int(36)
     prop   = Seg perpendicular to seg, from root, length len,
              width max(1, seg.width - 1), rank seg.rank + 1, t seg.t + 1
     # localConstraints
     scan `road` along prop:
       hit at d < len          → truncate to d-1, mark T-junction
       endpoint within 4 of road → extend up to 4 tiles to touch (dead end → loop)
       parallel to existing road at spacing < 8 → reject
       crosses resv            → truncate at the reservation boundary
     if accepted: carve, push to PQ
  push seg's continuation if it was truncated by a reservation
prune every dead-end spur shorter than 8 tiles
```

Rank-1 and rank-2 segments get their own jog schedule (jog every `15 + S(5).int(46)`
tiles, offset `1 + S(5).int(3)`) — a side street that runs 40 tiles dead straight is the
other thing that reads as generated.

`localConstraints`' snap radius of 4 is the single most important number here. Without it,
side streets dead-end three tiles short of the street they should have met, and the whole
network reads as noise instead of a plan.

---

#### Stage 6 — Carve + block extraction · no draws · ~1 ms

Rasterise every segment at its width into `road`. Then connected-component-label the
non-road, non-reserved tiles, 4-connectivity, scanline BFS over `blockId`.

This is the free lunch the polygon literature does not get: on a tile grid, **blocks are
connected components**. No planar-graph face traversal, no half-edge structure, no
degenerate-polygon handling. O(N), ~0.5 ms at 76,800 tiles.

Per block, accumulate `{ id, minX, minY, maxX, maxY, area }`.

---

#### Stage 7 — Depth field and rear boundaries · no draws · ~2 ms

```
depth = multi-source 4-BFS over all non-road tiles, seeded 0 at every road tile
```

This is the grid analogue of a straight skeleton, and it is the right call: the polygon
straight-skeleton algorithm is 500+ lines of edge/split-event ordering and float epsilon
soup whose output *will* differ under different rounding. The BFS is integer and exact.

- The **ridge** — local maxima of `depth` — is the block's rear boundary.
- Any core block with `ridgeDepth > 26` gets a 1-tile back lane carved along the ridge,
  then that block only is re-CCL'd.

`depth` is also a free "how buried is this tile" input for the garden-vs-yard-vs-outbuilding
choice in Stage 10.

---

#### Stage 8 — Frontage extraction and parcelisation · tag 8 · <1 ms

```ts
type FrontageRun = { x0: number; y0: number; len: number; axis: 'h'|'v';
                     side: -1|1; blockId: number; rank: number };
type Plot = { fx: number; fy: number; w: number; d: number; axis: 'h'|'v';
              side: -1|1; dens: number; runIndex: number; indexInRun: number };
```

Extract runs by walking each segment's two flanks, recording maximal runs of tiles whose
neighbour-away-from-road lies in the same block. Discard runs shorter than 6 tiles.

Burgage strip subdivision per run — the only subdivision scheme that is *natively*
axis-aligned when the street is, and the historically correct generator for this settlement
type:

```
s      = dens>0.60 ? 0 : dens>0.35 ? 1 : 2 + S(8).int(3)     // setback
widths: while run not consumed:
          core   ? 5 + S(8).int(5)                            // 5..9
          fringe ? 9 + S(8).int(8)                            // 9..16
          (core chosen with probability dens)
jitter: each interior party-wall position by S(8).int(3)-1, clamped so no plot < 4
runt:   a remainder < 4 tiles is absorbed into the last plot, never emitted
depth:  d = min(ridgeDepth - 1, core ? 34 : 50), floor 10 / 14
```

`indexInRun` is stored because Stage 9's party-wall and wing-pairing logic needs left/right
neighbour identity.

Non-frontage block interiors (garden cores, farm yards, the churchyard's internal division)
get recursive AABB split, depth ≤ 3, ratios `S(8).range(0.35, 0.65)`. With rotation off the
table an OBB split degenerates to AABB, which is fine *here* precisely because these
parcels carry no frontage. Never use it where the burgage subdivider applies — pure
recursive splitting reads as a BSP dungeon.

---

#### Stage 9 — Footprint synthesis · tag 9 · ~1 ms

Per plot, by `dens`:

| dens | Composition |
|---|---|
| > 0.60 | Terrace unit, 1 rect `plotW × (6 + S(9).int(5))`, setback 0. p 0.30 gets a rear wing (`parts`): `3 + S(9).int(2)` wide × `4 + S(9).int(4)` deep, flush to the plot boundary chosen by `indexInRun & 1` so wings pair across boundaries. |
| 0.35–0.60 | Detached or semi-detached townhouse, setback 1, `1 - dens` chance of a venelle gap of `1 + S(9).int(2)` tiles before the plot. |
| < 0.35 | Fringe house (L via `parts`) plus a detached étable across the yard; or, on a large enough non-frontage parcel, a full farm `cour`. |

Special structures:

- **Church** (3-rect group at the churchyard): nave `9×22` storeys 2, tower `5×5` storeys 4
  at the west end, apse `5×4` at the east. Shared spans → `EDGE.NONE`.
- **Market infill**: 2–4 terraced units on the `resv = 2` island.
- **Civic set**: mairie/école — one rect set back 4–6 tiles with a walled forecourt;
  halle — an open rect (floor tiles, `EDGE.WALL` only at the 4 corner edges, no roof mass);
  café/boulangerie — terrace units on the place, role `shop`, 2-tile door opening.
- **Porte-cochère**: p 0.15 core, a 1-tile passage through a house body (two `DOOR` edges
  across the mask, one on each face).

**Overlap policy.** `overlaps()` at `mapgen.ts:114-115` inflates every footprint by 2 tiles
on all sides — this structurally forbids party walls and must not be reused. The bourg
branch uses a per-plot margin: **0 between terrace neighbours in the same run, 2
otherwise**, enforced against `occ` rather than against an O(n²) rect scan.
`touchesRoadOrWater()` at `mapgen.ts:116-120` is likewise not reused: core plots need
setback 0, i.e. the front wall edge *is* the road edge.

Footprints are emitted as `{ rect | parts, role, groupId, doors, frontage }`, not stamped
yet.

---

#### Stage 10 — Enclosures and the back network · tag 10 · <1 ms

- Garden walls on every plot-tail boundary: `EDGE.WALL`, top **1** on plot-to-plot
  boundaries (see-over, no-cross), top **2** on the rear boundary and on any wall facing a
  street or the churchyard.
- One gate (`EDGE.DOOR`) every 2–3 plots along the rear boundary; one gate per venelle
  mouth; two gates on the churchyard.
- One rear door on every terrace house (a second `DOOR` on the tail-facing wall).
- Farm-yard walls: 2 m, one 2-tile gate.

**Connectivity requirement (validated, not hoped for):** the union of plot tails behind one
side of the Grande Rue must be a single foot-connected component reaching from one end of
the envelope to the other. Stage 12's flood fill checks it; failure rerolls the gate
positions once (a bounded sub-loop inside the attempt, drawing from `S(10)`), and only then
fails the attempt.

---

#### Stage 11 — Rural fabric · tag 11 · ~3 ms

- **Farm lanes** by space colonisation: attractors = compound yard tiles + field centroids +
  woods-edge tiles at ~2 per 1000 tiles outside the envelope; nodes seeded on the arterial
  every 30 tiles; `D = 5`, `killR = 7`, `attractionR = 45`. Each growth step rasterises as
  an **L-shaped dogleg** (larger component first), never a diagonal. Dendritic dead-ending
  is wrong for a bourg core and exactly right for farm tracks.
  Determinism: attractors iterated in fixed index order; "nearest node" ties break on node
  index.
- **Bocage** by jittered-grid Voronoi, replacing `mapgen.ts:195-214`'s parallel drifting
  lines: one site per 22×22 cell at `(cx*22 + 3 + S(11).int(16), cy*22 + 3 + S(11).int(16))`;
  each fringe tile takes the nearest site among the 9 neighbouring cells by squared integer
  distance, index tiebreak; a tile is `hedge` if any 4-neighbour has a different site id.
  One O(9N) integer pass. No Delaunay, no float predicates, no cocircular degeneracy.
  Punch gates by removing 2–3 consecutive boundary tiles at one jittered position per
  shared edge.
- Orchards, fields, woods stands as today (tags 12, 13), with `nearVillage` replaced by
  "inside `R_env` expanded by 6".

---

#### Stage 12 — Stamp and validate · no draws

**Stamping** goes through the new mask-based `stampStructure` (§3.3). The legacy
`addBuilding` (`mapgen.ts:318-369`) is left untouched and still serves every other kind —
refactoring it into the new path risks a one-bit fingerprint drift for zero gain.

**Validation, in strict order:**

1. **Flood-fill gate (cheap, first).** Three BFS passes, each 8-connected and mirroring
   `path.ts:105-118`'s corner rule exactly so the answer is A\*-equivalent:
   - foot from `spawns.west` (~2.8 ms measured)
   - foot from `spawns.east` (~2.8 ms)
   - vehicle from `spawns.west` (~2.5 ms)

   Then, as pure array lookups: every objective in both foot components; every building's
   door tile and every stair tile in the west foot component; `spawns.east` in the vehicle
   component; the rear-network end-to-end check from Stage 10.

   ≈ 8 ms total, **O(1) in building count**, versus 32–47 ms today and linear.

2. **A\* checks: none remain.** Reachability is exactly what `astar(...) !== null` tested
   here (`mapgen.ts:371-380`), and the flood fill computes the same relation over the same
   step function. Retain one A\* west→east foot call as a belt-and-braces smoke check only
   if the parity script (§5.4) ever disagrees.

3. Bounded reroll stays at 8 attempts (`mapgen.ts:44`).

**Target reject rate: < 5 % first-attempt over 200 seeds.** Instrumented over 1080 maps
today, attempt 0 succeeded every single time — the reroll path is entirely dormant, so
there is no field evidence it behaves well under load. A bourg that rejects at 30 % would
multiply an already-dominant cost. This is a gate, not an aspiration: if the measured rate
exceeds 5 %, the failing constraint gets relaxed, not the budget raised.

---

#### Stage 13 — Elevation · tag 14 · last, always

Unchanged in structure (`mapgen.ts:279-299`), with one added skip predicate:

```ts
const flatZone = (x, y) => kind === 'bourg' && inRect(x, y, expand(R_env, 4));
```

`flatZone` returns `false` for every other kind, so no draw sequence and no output moves.
The bourg envelope stays flat because a 5 m hill dome running under a 2 m garden wall next
to a floor tile at elev 0 is a visible seam and a LOS anomaly. Drama stays outside town,
where it belongs.

### 2.3 Budget

| Stage group | ms |
|---|---|
| 1–5 skeleton | < 1 |
| 6–7 CCL + depth field | ~3 |
| 8–10 parcels, footprints, enclosures | ~2 |
| 11 rural fabric | ~3 |
| 12 stamp | ~1 |
| 12 validate (3 BFS) | ~8 |
| 13 elevation | ~1 |
| **total / attempt** | **~19 ms** |

At the < 5 % reject target the expected cost is ~20 ms and the 8-attempt worst case is
~152 ms. Both sit inside the 100 ms design budget in expectation; the worst case is a
once-in-hundreds-of-seeds event paid at `bridge.ts:135` when the player commits.

---

## 3. Data-contract changes — all additive

### 3.1 `src/sim/mapgen.ts` types

```ts
export type BuildingRole =
  | 'house' | 'townhouse' | 'shop' | 'farmhouse' | 'barn'
  | 'civic' | 'halle' | 'church' | 'church_tower' | 'church_apse';

export interface Rect { x: number; y: number; w: number; h: number }

export interface DoorEdge { x: number; y: number; side: 'n'|'s'|'e'|'w'; width: 1|2 }

export interface Building {
  x: number; y: number; w: number; h: number;   // unchanged: the primary mass
  role?: BuildingRole;      // absent = 'house'
  parts?: Rect[];           // absent = single rect equal to {x,y,w,h}; parts[0] === that rect
  groupId?: number;         // shared buildingId key for a multi-mass structure
  doors?: DoorEdge[];       // absent = legacy mid-span single door
  frontage?: 'n'|'s'|'e'|'w'; // the street side; the roof ridge runs parallel to it
  terraceRun?: number;      // shared id across the units of one continuous frontage
}

export type ObjectiveKind = 'place' | 'woods' | 'faubourg' | 'church' | 'street';

export interface MapPlan {
  map: GameMap;
  buildings: Building[];
  spawns: { west: Vec; east: Vec };
  objectives: Vec[];
  objectiveKinds?: ObjectiveKind[];   // parallel to objectives; absent on legacy kinds
  woodsStands: Vec[];
}

export type MapKind = 'open' | 'woods' | 'town' | 'river' | 'bridge' | 'road' | 'bourg';
```

Why these are safe:
- Every existing reader destructures `{x,y,w,h}` — `bridge.ts:63`, `roofs.ts:194`,
  `patches.ts`, `sim.ts:478`, and both vehicle/sim tests.
- The fields are outside the fingerprint, which hashes only map arrays
  (`tests/mapgen.test.ts:9`).
- `tests/mapgen.test.ts:26` does `expect(a.buildings).toEqual(b.buildings)`, so the fields
  only need to be deterministic — which they are.
- `parts[0]` is required to equal `{x,y,w,h}`, so `buildingCenter` (`bridge.ts:63`) lands
  on a real floor tile of the structure even for an L. **This is a hard invariant; assert
  it in the generator.**

### 3.2 Wall-top code table — the render interface

This table is the contract between the two implementation lanes. Freeze it at T2.

| `hEdgeTops`/`vEdgeTops` | Meaning | Movement | Standing LOS | Cover |
|---|---|---|---|---|
| 0 (on a `WALL`) | full-height block (legacy) | blocked | blocked | none |
| 1 | low garden / front wall | blocked | **passes** | **none** (D7) |
| 2 | stone yard / churchyard wall | blocked | blocked | none (concealment only) |
| 3 | 1-storey building | blocked | blocked | — |
| 6 | 2-storey building | blocked | blocked | — |
| 12 | church tower (4 storeys) | blocked | blocked | — |

The renderer identifies a free-standing wall as: `edge === EDGE.WALL && top ∈ {1,2} &&
buildingId < 0 on both flanking tiles`. Nothing else is needed — no new map array.

### 3.3 New stamping function

```ts
function stampStructure(map: GameMap, b: Building, id: number): number
```

Replaces single-rect perimeter walking with mask-boundary extraction:

1. Build a `Uint8Array` occupancy mask over `bbox(parts) + 1` border.
2. Interior: `setTerrain 'floor'`, `stories[i]`, `buildingId[i] = b.groupId ?? id`.
3. Walls: for every grid edge, `isWall = inside(a) !== inside(b)`. ~10 lines, and it gets
   L/U/courtyard/church-with-tower for free while leaving the `hEdgeTops`/`vEdgeTops`
   logic untouched.
4. Windows: every 3rd position along each **maximal exterior run**, skipping party-wall
   runs and door positions. Indexing per-run rather than per-rect is what stops windows
   landing on the joint of an L.
5. Doors: from `b.doors`; a 2-wide door writes two adjacent `DOOR` edges.
6. Partitions: AABB split of the mask, depth ≤ 2, one `DOOR` per partition.
7. Tops: `stories * FLOOR_H` where the edge is `EDGE.WALL`, matching `mapgen.ts:342-346`.
8. Stair: for `stories ≥ 2`, the mask tile farthest (squared int) from the primary door
   **among tiles with all 4 neighbours in the mask** — so a stair never lands in a 1-wide
   wing where `addBuilding`'s corner rule would put it.

**Bounds discipline.** `setHEdge`/`setVEdge` do no bounds test (`map.ts:77-83`); a
`setVEdge(w+1, y)` silently lands on `vEdge(0, y+1)`. Valid domains are
`hEdge x∈[0,w) y∈[0,h]` and `vEdge x∈[0,w] y∈[0,h)`. `stampStructure` asserts them in dev
builds — a mask-driven stamper touches far more edge cells than a rect walker and this is
the failure mode that will corrupt the far side of the map without an error.

**Post-pass, after all structures are stamped:**

```
for every shared span between two stamped masks:
   same groupId → EDGE.NONE   (interiors merge — audit-verified: path 15→10 tiles, zero
                               tiles off floor, LOS passes; the stale top is harmless
                               because los() only reads a top on EDGE.WALL, map.ts:210-213)
   different    → EDGE.WALL, top = max(topA, topB)   (kills the WINDOW the run indexer
                               would otherwise leave on a party wall)
```

**Never emit overlapping rects.** The audit tested it: A's south wall is stranded *inside*
B's interior, `buildingIdAt` resolves to the later rect only, and A→B pathing returns
`null`. Abutting or disjoint only. Assert it.

### 3.4 Objectives

```
[0] place            'place'      // road tile at the carrefour — scenario.ts:49 emplaces the MG42 here
[1] east woods       'woods'      // must stay passable — a squad spawns on it (scenario.ts:48,52)
[2] faubourg         'faubourg'   // only when w >= 240, preserving the existing slot (stage.mjs:65)
[n] church           'church'     // churchyard gate tile, passable
[n+1..] street ends  'street'     // greedy coverage fill
```

Greedy coverage fill, deterministic, no rng:

```
while some building centre is > 45 m (GARRISON_RADIUS, bridge.ts:86) from every objective
      and objectives.length < 8:
   pick the uncovered centre with the largest (dist², index) key
   append the nearest road tile to it
```

Greedy cover rather than reroll-on-failure: rerolling a whole map because one fringe farm
sits 47 m from an objective is absurd, and coverage is trivially constructible.

`objectives.length === 3` at `tests/mapgen.test.ts:201` is asserted for the **default kind
only** — that is the escape hatch, and `bourg` uses it. The bridge-last ordering
(`tests/mapgen.test.ts:111, 168`) does not apply: `bourg` carves no water.

### 3.5 Strategic-layer coupling

`CellTerrain = MapKind` (`sector.ts:6`) and `CELL_MINUTES: Record<CellTerrain, number>`
(`sector.ts:32-39`) is exhaustive, so `tsc --noEmit` will **force** a declaration. Required
edits:

- `sector.ts:32-39`: `bourg: 15` (same as `town` — a company column crosses a 500 m cell of
  village in the same time).
- `bridge.ts:456-459`: give `bourg` the same defender multiplier `town` gets. A new
  town-ish kind that misses the ×7 bonus silently rebalances the entire coarse war.
- `sector.ts:21-29` `CHAR_TERRAIN` is `Record<string, …>` and **not** exhaustive. Leave it
  alone at first: the new kind is unreachable from the campaign until a char is added,
  which is the correct staging — the generator gets tested standalone before it can ruin a
  campaign. The flip (`'t'`/`'T'` → `'bourg'`) is its own task, T16, after the art
  baselines are re-approved.

**No version flag.** There is no persisted map — `save.ts:15-36` stores campaign + front
only, and the battle map is regenerated from `(seed, 320, 240, cellTerrain)` at
`bridge.ts:135`. No migration surface exists, so a version flag buys nothing.

---

## 4. Render dressing

Everything here is additive to `roofs.ts` and the `terrain.ts` dressing passes. Nothing
below changes the sim.

### 4.1 What is reused as-is

| Asset | Where | How the bourg feeds it |
|---|---|---|
| Baked roof sprites, 4 materials | `roofs.ts:39-90, 213-225` | more buildings, same path |
| Roof plans gable/hip/cross/catslide | `roofs.ts:143, 250-257` | plus one new `spire` |
| Wall faces (B4) | `roofs.ts` base sprite | `role` biases `WallMat` |
| Cobble paving (G7) | `terrain.ts:566, 612-724`, `patches.ts` | the place is carved as `road`, which is what `pavable` (`terrain.ts:673-681`) requires |
| Door wear trails | `terrain.ts:810-839` | every terrace door and rear door gets one for free |
| Gravel aprons / farmyard earth | `terrain.ts:607-671` | farm `cour` yards read as yards automatically |
| Yards, fences, kitchen gardens (B7) | B7 stamps | keyed off the new enclosure detection |
| Clutter (G6) | G6 stamps | market stalls on the place |
| Hedge runs | `terrain.ts:229-340` | Voronoi bocage is still `hedge` terrain |

### 4.2 New render needs — the complete list

**N1 · Church art.** New `RoofPlan = 'spire'`: a pyramidal slate spire on the `church_tower`
mass with louvred belfry openings on all four faces and a cross finial; nave gets a forced
`slate` cross-gable; apse gets a half-hip. Gate on `b.role`, not on geometry. In `roofs.ts`
`pickMat`/plan selection (`:213-257`).

**N2 · Terrace roof continuity.** For buildings sharing a `terraceRun`, align the ridge to
`b.frontage` (parallel to the street) and suppress the per-building 0.35 m overhang
(`roofs.ts:18`) on the two party-wall sides, so five roofs read as one continuous range
with party-wall parapets rather than five overlapping gables. **Also fix `smallOfPair`**
(`roofs.ts:1181-1192`): the 4 m-proximity heuristic will flag every terrace unit next to a
larger neighbour as an outbuilding and thatch half the high street. Guard it with
`terraceRun === undefined`.

**N3 · Storefront dressing.** `role === 'shop'`: ground-floor shopfront band on the street
wall face, awning stripe, hanging sign, and a stall/crate cluster on the door apron. Reuses
B4's wall-face pass and G6's clutter stamps.

**N4 · Free-standing stone walls.** `drawEdge` (`terrain.ts:1041-1063`) already draws every
edge generically, so garden and churchyard walls render *today* — as a thin dark line
indistinguishable from a house wall. Add a branch: `EDGE.WALL` with `top ∈ {1,2}` and no
adjacent `buildingId` draws as rubble stone with a coping highlight, taller and cooler at
top 2 than top 1; `EDGE.DOOR` in such a run draws gate posts and a plank gate.

**N5 · Elongated place paving.** `PatchIndex` caps square radius at 11 m
(`patches.ts:104`), so a 14×34 place gets an 11 m disc of cobbles with unpaved ends. Change
`Square` to `{cx, cy, rx, ry}` derived from the crossing group's bounding box, keep the
`≥ 4 nearby buildings` test (`patches.ts:99-104`) that stops a farm-lane junction getting
cobbled, and make `pavedAt` a rounded-rect ramp instead of a radial one.

**N6 · Churchyard and garden interiors.** Detect an enclosure as a closed loop of
free-standing wall edges (N4's predicate) and dress the interior: graves + 2–4 yews inside
the churchyard, B7 kitchen-garden beds inside plot tails, packed earth inside farm yards.

**N7 · Bake budget.** `RoofLayer` bakes 4 sprites per building per zoom band, amortised 2
per frame after the first band (`roofs.ts:31, 1237-1261`). At ~65 buildings that is 260
sprites per band ≈ 130 frames ≈ 2.2 s of visible pop-in on a band change. Prioritise the
queue by on-screen-ness and raise the per-frame budget while the camera is static.

**N8 · Roof-art index hash.** All roof art hashes on the **array index** (`hash(i, salt)`
throughout `buildArt`), so inserting a building at the front of the list reshuffles every
roof's material. The bourg emits buildings in geometric order; if that order ever changes,
every roof changes. Switch the salt to a stable per-building key (`groupId ?? i` composed
with `x`,`y`) so material survives list reordering.

---

## 5. Test plan

### 5.1 Fingerprint strategy

**Must stay green, must not be re-snapshotted:**

- `tests/mapgen.test.ts:36-39` — the two inline fingerprints (`8105059f`, `d2a77805`).
  These are the drift tripwire. Changing them is legitimate only when the default layout was
  *intended* to change, which is never in this project.
- `tests/mapgen.test.ts:41-102` — seeds 1-30 connectivity, first-3-buildings-near-objective-0,
  hedge step rules, orchard isolated-tree count ≥ 150.
- `tests/mapgen.test.ts:104-194` — bridge/river geometry, bridge-last objective, 60×40 floor.
- `tests/mapgen.test.ts:153-161` — `'town'` density (`near(town) ≥ near(open) + 6`).
  `'town'` is untouched by this work, so this must not move.
- `tests/sim.test.ts:192` and `tests/vehicles.test.ts:63` — both assume `buildings[0]`
  interior at `+2,+2`, i.e. min footprint 5×4, default kind.
- `tests/perf.test.ts:47, 88, 164, 249` — keeps the ≥56-tile 2-storey rule live; drop it and
  the height-stress scenario goes vacuous.

**New fingerprints:** add two inline snapshots for `generateMap(1, 320, 240, 'bourg')` and
`generateMap(2, …)` using the same FNV-1a helper. These are *expected* to churn during
implementation and get frozen at T14.

**The one-draw guard.** A dedicated test asserts that `generateMap(s, 160, 120, 'open')`
fingerprints are unchanged after the bourg lands. The mechanism that makes this true is D1
+ D2, but the mechanism is not the test.

### 5.2 Structural / morphology tests (new, `tests/bourg.test.ts`)

Over seeds 1-20 at 320×240:

| Assertion | Rationale |
|---|---|
| ≥ 40 buildings, ≤ 90 | Int16 buildingId is fine; the bound catches a runaway parcelizer. |
| ≥ 1 `role === 'church_tower'` with `storiesAt(centre) === 4`, and `map.maxStories === 4` | `maxStories` gates the whole slab-LOS path (`map.ts:156`) and the renderer's floor passes. Leaving it wrong silently disables occlusion. |
| ≥ 1 terrace run of ≥ 4 units sharing a `terraceRun` | The party-wall high street is the whole point. |
| Every party wall between different `groupId`s is `EDGE.WALL`, never `WINDOW` | D5. A window here is a free LOS hole. |
| Every shared span inside one `groupId` is `EDGE.NONE`, and `astar` between two parts stays on `floor` for its whole path | The audit's exact probe: path length 15→10, zero tiles off floor. |
| No two `parts` rects overlap, anywhere, in any building | The audit's confirmed corruption case. |
| `parts[0]` deep-equals `{x,y,w,h}` for every building | `buildingCenter` (`bridge.ts:63`) must land on floor. |
| Longest straight run of 3-wide road inside `R_env` ≤ 45 tiles | §1.4's MG-lane cap. |
| Every building centre within 45 m of some objective | `GARRISON_RADIUS` (`bridge.ts:86`). |
| `objectiveKinds.length === objectives.length`, `[0] === 'place'`, `[1] === 'woods'` | The pinned prefix. |
| `terrainKeyAt(objectives[0])` is `'road'` | `scenario.ts:49` emplaces an MG42 there; `patches.ts` needs road for cobbles. |
| Every `woodsStands` entry passable | `mapgen.ts:239`'s existing guard, retained. |

### 5.3 Connectivity tests

- Both spawns reach every objective on foot; west reaches every door tile and every stair
  tile; west→east on vehicle. (Same relation as `validate`, asserted from outside.)
- The rear-garden network is one foot-connected component spanning the envelope on at least
  one side of the Grande Rue.
- **Venelles and gates are vehicle-proof**: for every `EDGE.DOOR` in a free-standing wall,
  `canStep(..., 'vehicle')` across it is `false` and `canStep(..., 'foot')` is `true`. This
  is D6's whole justification; assert it directly.
- **The tower is clearable**: `astar` from `spawns.west` to the tower stair tile at `l=0`
  succeeds, and from the stair to `l=3` succeeds. 3- and 4-storey buildings are
  representable but **completely untested** today — this is the test that closes that.

### 5.4 Determinism tests

- `generateMap(s, 320, 240, 'bourg')` twice → identical `tiles`, `hEdges`, `vEdges`, `elev`,
  `stories`, `buildingId`, `stairs`, `buildings`, `objectives`, `spawns`.
- **Sub-stream independence** (`scripts/bourg-streams.mjs`): perturb one stage's tag
  constant and assert every *other* stage's output is bit-identical. This is the test that
  makes D2 real rather than aspirational, and it is what lets the team tune stage 8 in week
  three without invalidating every screenshot.
- **Validation parity** (`scripts/validate-parity.mjs`, not a unit test — too slow): over
  60 seeds × 6 legacy kinds × 3 sizes, assert the new flood-fill gate returns exactly the
  same accept/reject verdict as the old 36-A\* `validate`. Run once at T1, keep the script.

### 5.5 Perf tests

Extend `tests/perf.test.ts`:

- `generateMap(seed, 320, 240, 'bourg')` mean over 20 seeds < 40 ms; max < 90 ms.
- Post-T1 regression: `'town'` 320×240 mean drops from ~52 ms to < 15 ms, `'open'` from
  ~34 ms to < 10 ms. T1 is a win for every existing kind and the test should say so.
- First-attempt reject rate over 200 bourg seeds < 5 % (script, reported not asserted, with
  a hard assert at 15 %).
- `RoofLayer` first-band bake at 65 buildings does not exceed the existing frame budget
  (N7).

### 5.6 Art regression

`scripts/sweep.mjs` gains a `bourg` crop set derived from `objectiveKinds`, not from
objective indices: `place`, `church`, one `street` end, one farm `cour`, one bocage parcel.
`stage.mjs:59-113`'s existing `village`/`hamlet`/`farm`/`bocage` crops for legacy kinds are
untouched, because legacy kinds are untouched.

---

## 6. Implementation task breakdown

Two lanes. **Lane A** is sim-side mapgen; **Lane B** is render-side dressing. T1 and T2 are
shared prerequisites executed by Lane A; **T2 is the interface freeze**, after which both
lanes run fully parallel with no shared files until T14.

### File ownership after the freeze

| Lane | Owns |
|---|---|
| A | `src/sim/mapgen.ts`, `src/sim/bourg/*.ts` (new dir), `tests/bourg.test.ts`, `src/strategic/sector.ts`, `src/strategic/bridge.ts` |
| B | `src/render/roofs.ts`, `src/render/terrain.ts`, `src/render/patches.ts`, `src/render/stamps.ts` |

No file appears in both rows. The only coupling is the frozen contract of §3.1 and §3.2.

---

### T1 · Flood-fill validation gate — Lane A — **M** — *blocks everything*

`src/sim/mapgen.ts` (+ `scripts/validate-parity.mjs`). Replace `validate`'s 36 A\* calls
(`mapgen.ts:371-380`) with three 8-connected BFS passes that mirror `path.ts:105-118`'s
corner rule exactly, then answer every reachability question by array lookup. Draws no rng,
changes no output — fingerprints must stay green untouched. Ship the parity script (60
seeds × 6 kinds × 3 sizes, old verdict === new verdict). Add the perf assertions of §5.5.
This is a standalone win for all six existing kinds (~52 ms → < 15 ms on `'town'`) and
should land and be reviewed on its own.

---

### T2 · Contract additions + INTERFACE FREEZE — Lane A — **S** — *blocks Lane B*

`src/sim/mapgen.ts` (types only), `src/strategic/sector.ts`, `src/strategic/bridge.ts`.
Add `BuildingRole`, `Rect`, `DoorEdge`, the optional `Building` fields, `ObjectiveKind`,
`MapPlan.objectiveKinds`, and `MapKind = … | 'bourg'`. Add `CELL_MINUTES.bourg = 15` and
the `bourg` defender multiplier at `bridge.ts:456-459`. Do **not** touch `CHAR_TERRAIN`.
Publish the wall-top code table (§3.2) as a doc comment in `mapgen.ts` — that table is the
render interface and must be readable from the sim side. `tsc --noEmit` green, all existing
tests green, zero behaviour change. **Both lanes start from this commit.**

---

## Lane A — sim

### T3 · Mask-based `stampStructure` — **L**

`src/sim/bourg/stamp.ts`. Full §3.3: occupancy mask, boundary extraction, per-run window
indexing, multi-door support, mask AABB partitions, tops, interior-corner stair with the
4-neighbour guard, dev-build bounds assertions on `setHEdge`/`setVEdge` domains. Plus the
shared-span post-pass (`NONE` within a group, `WALL` between groups, top = max). Legacy
`addBuilding` untouched. Unit-tested standalone against hand-built masks (L, U, courtyard,
church-with-tower, terrace pair) before any generator exists — this is the piece where a
bug corrupts the far side of the map silently.

### T4 · Skeleton: envelope, regional roads, Grande Rue, minor streets — **L**

`src/sim/bourg/streets.ts`. Stages 1-3 and 5: archetype roll, envelope, `dens`, the
arterial handoff jog, the jogged rectilinear polyline with the 45-tile run cap, the cross
route and `carrefour` dogleg convergence, and the PQ growth loop with `localConstraints`
(snap radius 4, parallel-spacing reject 8, reservation truncation, dead-end pruning). The
sub-stream helper `S(tag)` lives here. Output is `Seg[]` + a carved `road` bitmap; nothing
is stamped yet. Debuggable via an ASCII dump script.

### T5 · Landmark reservation — **M**

`src/sim/bourg/landmarks.ts`. Stage 4: chamfered churchyard offset from the carrefour, the
asymmetric place widening carved as `road`, the p-0.6 market infill island with its
guaranteed 3-tile flank lanes, and the civic forecourt. Runs between T4's skeleton and
T4's minor-street growth — so T4 exposes its growth loop as a separate entry point that
takes `resv` as input.

### T6 · Blocks, depth field, frontage runs, burgage parcels — **L**

`src/sim/bourg/parcels.ts`. Stages 6-8: scanline CCL into `blockId`, multi-source BFS into
`depth`, ridge detection, back-lane insertion for blocks deeper than 26 with local re-CCL,
frontage-run extraction along segment flanks, and the burgage strip subdivider with
`dens`-driven setback/width/jitter/runt-absorption. Non-frontage interiors get the depth-≤3
AABB split. Pure geometry, no map writes; output is `Plot[]`.

### T7 · Footprint synthesis and roles — **L**

`src/sim/bourg/footprints.ts`. Stage 9: per-plot composition by `dens` (terrace / rear wing
via `parts` / detached / L+étable / farm `cour`), the church group, market infill, the civic
set, venelle gaps, porte-cochère passages. Emits `Building[]` with `role`, `groupId`,
`parts`, `doors`, `frontage`, `terraceRun`. Enforces the margin policy (0 within a terrace
run, 2 otherwise) against `occ`, and asserts the no-overlap and `parts[0] === {x,y,w,h}`
invariants.

### T8 · Enclosures and the back network — **M**

`src/sim/bourg/enclosures.ts`. Stage 10: garden walls at top 1 / top 2 per §3.2, gates every
2-3 plots, rear doors, venelle-mouth gates, churchyard gates, farm-yard walls. Includes the
rear-network connectivity check and its one bounded gate-position reroll.

### T9 · Rural fabric — **M**

`src/sim/bourg/rural.ts`. Stage 11: space-colonisation farm lanes with L-dogleg
rasterisation and fixed iteration order, jittered-grid Voronoi bocage with gated hedgerows,
and the existing orchard/field/woods passes rebased onto `R_env` proximity instead of
`nearVillage`.

### T10 · Objectives, spawns, garrison coverage — **S**

`src/sim/bourg/objectives.ts`. The tagged objective list of §3.4, the greedy 45 m coverage
fill (deterministic, capped at 8), spawns pinned to the arterial as today, and the
`terrainKeyAt(objectives[0]) === 'road'` guarantee.

### T11 · Wire the pipeline into `generateMap`, elevation guard — **M**

`src/sim/mapgen.ts`. The `kind === 'bourg'` branch: one `bourgBase` draw, stage order,
`stampStructure` call loop with shared `buildingId`, `maxStories = 4`, the `flatZone` skip
predicate in the dome pass (returns `false` for every other kind — verify the `'open'`
fingerprints are still `8105059f` / `d2a77805` in the same commit).

### T12 · `tests/bourg.test.ts` — structure, connectivity, determinism — **M**

Everything in §5.2, §5.3, §5.4. Including the multi-storey clearance test (west spawn →
tower stair at `l=0` → `l=3`), which closes the "3+ storeys is representable and completely
untested" gap, and the vehicle-proof-gate assertions.

### T13 · Perf hardening and reject-rate tuning — **M**

`scripts/bourg-perf.mjs` + `tests/perf.test.ts`. Measure per-stage cost over 200 seeds,
drive the first-attempt reject rate under 5 %, assert mean < 40 ms / max < 90 ms. Also
verify `bridge.ts:135`'s synchronous stage cost at engagement commit, and confirm
`PatchIndex`'s O(w·h) construction (`terrain.ts:1077`) has not moved.

### T14 · Freeze bourg fingerprints, sweep baselines, decision-log entry — **S**

Two inline `bourg` fingerprint snapshots, `scripts/sweep.mjs` crop set keyed off
`objectiveKinds`, and a `docs/decisions/INDEX.md` entry recording D1-D10 and the rejected
alternatives (tensor fields, polygon straight skeleton, Delaunay Voronoi in the core,
space colonisation for streets, a `cobble` terrain key, a map version flag).

### T16 · Campaign wiring — **S** — *last, after art sign-off*

`src/strategic/sector.ts`. Point `CHAR_TERRAIN['t']` and `['T']` at `'bourg'`. One line,
deliberately last: until it lands, the bourg is testable and invisible to the campaign, and
`'town'` keeps every art baseline it has.

---

## Lane B — render (starts at the T2 freeze)

### T15 · Role plumbing + church art (N1) — **L**

`src/render/roofs.ts`. Thread `Building.role` / `frontage` / `terraceRun` into `buildArt`
and `pickMat` (`:213-257`). New `RoofPlan = 'spire'`: pyramidal slate spire, louvred belfry
on four faces, cross finial, gated on `role === 'church_tower'`. `role === 'church'` forces
slate cross-gable; `church_apse` gets a half-hip. Also implement N8 (stable art hash key) —
it is one line and it is the difference between a stable town and a town whose roofs
reshuffle whenever the generator's emission order is touched. Can be developed against
hand-authored `Building[]` fixtures before Lane A emits anything.

### T17 · Terrace roof continuity + `smallOfPair` fix (N2) — **M**

`src/render/roofs.ts`. Ridge aligned to `frontage` across a `terraceRun`, overhang
suppressed on party-wall sides (`roofs.ts:18`), parapet at the joints, and the
`smallOfPair` guard (`roofs.ts:1181-1192`) so a high street does not come out thatched.

### T18 · Free-standing stone walls + gates (N4) — **M**

`src/render/terrain.ts`. New branch in `drawEdge` (`:1041-1063`) for `EDGE.WALL` with top
∈ {1,2} and no adjacent `buildingId`: rubble stone with coping, taller/cooler at top 2;
`EDGE.DOOR` in such a run gets gate posts and a plank gate. Purely derived from the map —
no new sim data, no dependency on Lane A's schedule.

### T19 · Elongated place paving (N5) — **M**

`src/render/patches.ts` + `terrain.ts`. `Square` becomes `{cx, cy, rx, ry}` from the
crossing group's bbox, `pavedAt` becomes a rounded-rect ramp, the `≥ 4 nearby buildings`
gate (`patches.ts:99-104`) stays. Verify legacy maps still cobble identically — the
existing 3-wide-arterial crossing shape must produce the same disc it does today.

### T20 · Enclosure interiors: churchyard, kitchen gardens, farmyards (N6) — **M**

`src/render/terrain.ts` + B7 stamps. Closed-loop enclosure detection from T18's predicate,
then graves + yews inside a churchyard, B7 beds inside plot tails, packed earth inside farm
yards.

### T21 · Storefront dressing (N3) — **M**

`src/render/roofs.ts` (wall-face pass) + `terrain.ts` (apron). `role === 'shop'`: shopfront
band on the street face, awning, hanging sign, stall/crate clutter on the door apron.

### T22 · Bake budget for a 65-building map (N7) — **S**

`src/render/roofs.ts:31, 1237-1261`. Prioritise the bake queue by on-screen-ness, raise the
per-frame budget while the camera is static, and add the frame-budget assertion of §5.5.

---

### Ordering and the critical path

```
T1 ──► T2 ──┬──► Lane A: T3 ──► T4 ──► T5 ──► T6 ──► T7 ──► T8 ──► T9 ──► T10 ──► T11 ──► T12 ──► T13 ──► T14 ──► T16
            │
            └──► Lane B: T15 ──► T17
                          T18 ──► T20
                          T19
                          T21
                          T22
```

Lane B's tasks are mutually independent except T18 → T20, so a single render implementer
can reorder them freely by taste or by what looks worst on screen first. Lane A is a strict
chain — that is inherent to a pipeline — which is why T1 and T2 are carved out as
separately-reviewable prerequisites rather than folded into T11.

The critical path is Lane A. If schedule pressure appears, the correct cuts are, in order:
the `enclos` and `faubourg` archetypes (drop to two archetypes, T4), the porte-cochère and
market-infill flourishes (T5/T7), and the space-colonisation farm lanes (keep the existing
straight lane, T9). Do not cut the back-garden network (T8) — it is the flanking layer, and
without it the bourg is a corridor shoot with nice roofs.
