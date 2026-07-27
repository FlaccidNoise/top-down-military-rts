# Movement & Cover UX — resolveMoveSpots, cover-seek AI, truthful order preview

Owner complaints this design answers:
1. "I have a tough time getting units into proper cover" — ordered moves land on formation offsets that ignore adjacent cover.
2. "Make the AI units smarter/better decision makers" — soldier-level positioning intelligence.
3. "Make the placement preview cursor update correctly with where they might go" — the preview must show TRUE final per-soldier positions.

Scope guard: this lane owns soldier-level POSITIONING only. Fire, suppression numbers,
compliance thresholds, and defender-AI doctrine belong to the concurrent balance lane
(lane-b-balance branch; so far touches `scripts/balance.mjs` + `src/strategic/bridge.ts`,
mandate is defender AI + suppression tuning). Collision flags are on every task in §6.

---

## 0. Verified current behavior (all claims cite file:line)

### 0.1 How a move order resolves to per-soldier destinations

- `main.ts commitOrder` (src/main.ts:718-790): plain right-click (`len < 2`) fans K
  selected squads by `fanOffsets(K, SQUAD_FAN)` on the **y axis only** (src/main.ts:757-761);
  right-drag builds `facing`/`width` and fans squads along the facing axis (src/main.ts:772-785).
- `Sim.orderSquad` (src/sim/sim.ts:1743-1768): fans member teams — legacy y-fan at
  `TEAM_FAN` = 8 m (sim.ts:1752-1755) or facing-axis fan with `share = width / nTeams`
  (sim.ts:1756-1767) — then calls `orderTeam` per team.
- `Sim.orderTeam` (sim.ts:1696-1738): compliance ladder first (sim.ts:1706-1715), then
  move-family orders call `moveSoldiersTo` (sim.ts:1725), and defend/ambush do too with an
  auto floor level (sim.ts:1729-1733).
- `moveSoldiersTo` (sim.ts:1637-1663) is the ground truth of "where each man ends up":
  `formationSlots(count, facing, width)` gives per-soldier offsets (sim.ts:510-527 — legacy
  `OFFSETS` blob when no facing, rank-and-file grid with facing), then **`findSpot`**
  resolves each slot to a real tile with a per-call `used` reservation set (sim.ts:1646-1648).
- `findSpot` (sim.ts:1939-1962): Chebyshev ring scan r=0..5 for a passable, unreserved,
  in-bounds tile. On furnished maps only (`this.map.hasFurniture` gate, sim.ts:1940) it
  scores tiles by `garrisonScore` and takes the max; unfurnished maps keep the legacy
  first-passable early return (sim.ts:1951).
- `garrisonScore` (sim.ts:1968-1981): +2 for a window nook (any adjacent WINDOW edge),
  +1 for `coverAt >= 0.4` (heavy furniture), and **identically 0 outside buildings**
  (sim.ts:1969). The comment at sim.ts:1964-1967 records the deliberate I10 restriction:
  "NOT scored on generic terrain cover: doing that would move formation spots on open
  ground on every map, which is a large unrelated behaviour change hiding inside an
  interiors task." This design is exactly that behavior change, done on purpose, in its
  own task, with its own tests.
- PATH_BUDGET amortization (decision log docs/decisions/INDEX.md:55, 2026-07-24):
  `PATH_BUDGET_PER_TICK = 6` (sim.ts:74); over-budget soldiers get their **formation spot
  reserved immediately** and the A* deferred via `pendingPaths` (sim.ts:1649-1661,
  drain at 1678-1688). Consequence for us: spot resolution already happens exactly once,
  synchronously, at order time — a resolver that runs there inherits the amortization for
  free and must NOT run per-tick.
- `nudgeSpawn` (sim.ts:969-982) is the same expanding-ring idea for spawn safety only.
- Silent failure today: if `findSpot` returns null (e.g. destination deep in water — the
  ring only reaches r=5), the soldier is silently skipped (`continue`, sim.ts:1647) and
  the player gets no feedback.

### 0.2 The cover model

- `TerrainDef.cover` = omnidirectional on-tile cover; `coverBehind` = directional lip
  cover granted when a shot crosses that tile within 2 m of the target (src/sim/data.ts:4-6).
  Values: hedge cover 0.35 + coverBehind 0.5 (data.ts:25), furn_heavy/hearth/altar
  coverBehind 0.4/0.5/0.5 impassable (data.ts:52-55), furn_light cover 0.25 passable
  (data.ts:53), woods 0.3, bank 0.1, rail 0.15 (data.ts:23,34,35).
- Lip mechanics in `los()` (src/sim/map.ts:494-496, 503-505): the last coverBehind tile
  crossed grants its cover only if crossed within 2 m of the target — i.e. **the covering
  tile must sit between shooter and target**. Hugging the wrong side of a hedge gives nothing.
  WINDOW crossings give 0.5 and BREACH crossings give `BREACH_COVER` 0.35 the same way
  (map.ts:38, 503-504).
- `Sim.coverAt` (sim.ts:3617-3627): max of on-tile cover and the four orthogonal
  neighbors' coverBehind — deliberately **omnidirectional**, so it cannot distinguish the
  safe side of a hedge from the exposed side. `inCover` = coverAt > 0.2 or interior floor
  (sim.ts:3631-3633).
- Stance heights (sim.ts:551-592): EYE_STAND 1.6 / EYE_CROUCH 1.1 / EYE_PRONE 0.4; a 1 m
  relief feature (hedge banks, verges, sunken-lane shoulders) blocks prone and passes
  crouch/stand (comment sim.ts:552-556). Stance is derived, never stored: `stanceOf`
  (sim.ts:576-587) — ambush=prone, defend=crouch, moving+supp>0.5=prone-crawl.
  Consequence: 'bank' tiles are only cover for a prone man; a hedge's coverBehind works
  at all stances (featureHeight 2 m, data.ts:25, never skipped by a 1.6 m eye on flat ground).
- Craters: **render-only decor**. `craterSpots` are pre-battle prop picks
  (src/render/props.ts:295-299) drawn as decals (src/render/renderer.ts:264); the sim
  never writes crater terrain (booms punch roof holes and stamp scorch, sim.ts:1995-1996;
  battlefield scars are a future strategic-layer arm, src/strategic/bridge.ts:418-425).
  So craters contribute zero sim cover and are out of scope here.

### 0.3 Preview/UI surfaces — what the player sees vs. what the sim does

- Input flow: RMB-down anchors (src/main.ts:823-826), mouse-up commits
  (main.ts:868-873); touch press-and-hold (HOLD_MS 420, src/ui/touch.ts:9) maps
  holdStart/holdMove/holdEnd onto the same anchor + `mouse.x/y` hover emulation
  (main.ts:914-934), so every desktop preview surface works on touch for free.
- Move-order preview (src/ui/overlays.ts:99-155): recomputes squad/team fans and
  `formationSlots`, then draws a dot per slot colored by `sim.inCover(px, py)`
  (overlays.ts:140-145). **It never runs `findSpot`**: no ring walk, no `used`
  reservation, no garrisonScore. Divergences from truth, in order of player pain:
  1. Dots land on impassable tiles (walls, water, furn_heavy) where the sim will ring-walk
     away — the exact "cursor doesn't show where they go" complaint.
  2. On furnished maps the sim snaps men to window nooks/furniture (findSpot scoring path)
     up to 5 tiles away; the preview shows the naive grid.
  3. Cover coloring uses omnidirectional `inCover`, so a dot on the enemy side of a hedge
     shows green.
  4. Eligibility filter drift: overlays.ts:122-124 checks alive/!downed/mental, missing
     `captured` (sim's `eligible`, sim.ts:1690-1692) — dot count can exceed mover count.
  5. Preview requires `pick?.kind === 'terrain'` (overlays.ts:100) — hovering a body or
     vehicle at the destination blanks it.
- Danger preview + context chip (overlays.ts:157-212): armed orders draw the 8
  `dangerSamples` dots and a chip with dangerScore/cover/ETA/compliance verdict —
  this is the legibility surface to integrate with, not duplicate.
- Formation drag preview (overlays.ts:214-241) matches commitOrder's fan math
  (main.ts:772-785); it is anchor/segment geometry only, no per-soldier truth.
- `dangerSamples`/`dangerScore`/`compliance` (src/sim/orders.ts:95-151) are deterministic,
  rng-free, and already shared sim↔UI — the pattern this design copies. `visibleEnemies`
  is memoized per (sim, tick, breach-count, side) (orders.ts:50-67).

### 0.4 AI unit-level behavior today (the gap)

- Move order completes ⇒ order cleared, men stand in the open where their slot landed
  (sim.ts:2160-2166). No settle-into-cover step exists.
- A suppressed stationary soldier **never relocates on his own**: `findCoverSpot`
  (sim.ts:3635-3650) has exactly one caller — the rescue drag (sim.ts:3210). Pinned men
  hug the ground in place (sim.ts:2840), suppression 0.35+ men just stand/crouch there
  (`stanceOf` sim.ts:586).
- Defend/ambush garrison via the same `moveSoldiersTo`→`findSpot` path (sim.ts:1729-1733);
  scoring is interiors-only (§0.1), so "defend this hedgerow" puts nobody on the bank.
- Compliance ladder (orders.ts:140-151) and `dangerScore` (orders.ts:129-138) are the
  refusal model; bounding under fire (sim.ts:1717-1721, 1811-1832). We do not touch any
  of these numbers.
- Red commander (src/sim/ai.ts): `baseFiringSpot` already scores LOS+cover+danger for MG
  positions (ai.ts:268-304) and `runDefend` issues squad-level ambush (ai.ts:340-358).
  It orders through the public `orderTeam`/`orderSquad` API, so every sim-side improvement
  here upgrades red for free — zero ai.ts changes needed.

---

## 1. `resolveMoveSpots` — one pure function, truth by construction

### 1.1 Signature and home

New file `src/sim/spots.ts` (sim.ts is 4164 lines; the danger model precedent lives in
its own orders.ts module):

```ts
export interface SpotQuery {
  soldierIds: number[];        // pre-filtered by the ONE shared eligible() predicate
  x: number; y: number;        // team anchor (post-fan destination, = orderTeam's order.x/y)
  facing?: number;             // TeamOrder.facing (orders.ts:15)
  width?: number;              // TeamOrder.width (orders.ts:16)
  kind: OrderKind;             // stance + threat-bearing policy
  arc?: [number, number];      // defend/ambush facing arc (orders.ts:12)
}
export interface ResolvedSpot { sid: number; x: number; y: number; covered: boolean; snapped: boolean }
export function resolveMoveSpots(sim: Sim, q: SpotQuery, used: Set<number>): ResolvedSpot[];
```

- **Pure**: reads sim (map, contacts, soldiers), never writes it. The caller owns `used`
  (execution: one set per `moveSoldiersTo` call, preserving today's per-team reservation
  scope, sim.ts:1640; preview: one set per previewed team, same iteration order ⇒ identical
  output). No rng, no `sim.rng` draws, no Date/Math.random — same contract as
  dangerSamples (orders.ts:94).
- `eligible(s)` must be **exported** from sim.ts (today private, sim.ts:1690-1692) and
  used by both the resolver callers and the overlay, killing divergence §0.3(4).

### 1.2 Algorithm

For each soldier i, anchor = `formationSlots(n, facing, width)[i]` + (q.x, q.y) — the
formation slot stays the anchor; cover-snap is a bounded correction, not a re-plan.

Ring-scan r = 0..SNAP_R (**SNAP_R = 3** tiles ≈ 3 m) in the exact `findSpot` iteration
order (Chebyshev rings, dy-major — sim.ts:1943-1946) for determinism and diff-ability.
Reject: out of bounds, `!terrainAt(nx,ny).passable`, tile in `used`. Score the rest:

```
score(tile) =
    2.0 * directionalCover(tile, threatBearing, stance)   // the point of the feature
  + 1.0 * nook(tile)                                      // window/breach firing position (garrisonScore's +2, sim.ts:1970-1976)
  + 0.5 * onTileCover(tile)                               // woods/furn_light/hedge body
  - 0.15 * chebyshevDist(tile, slot)                      // stay near your slot; ties break toward it
```

- `directionalCover`: the orthogonal neighbor of `tile` in the threat quadrant
  (|Δbearing| ≤ 90°) contributes its `coverBehind` (data.ts:6); this reproduces the los()
  lip rule (map.ts:503-505) — cover only counts if the covering tile lies between the man
  and the threat, which is what "ends up ON the bank side facing the enemy" means.
- **Stance-aware**: stance at destination = ambush→prone, defend→crouch, else stand
  (mirrors stanceOf, sim.ts:583-586). 'bank' tiles (1 m relief, §0.2) add a directional
  bonus **only for prone** (ambush); hedge/furniture coverBehind counts at all stances.
  Do not model relief elevation deltas in v1 — that is the stance-relief LOS work's
  substrate (tests/stance-relief.test.ts) and a resolver raycast per tile blows the budget.
- Accept the best tile only if `bestScore > 0` AND r ≤ SNAP_R (else keep the plain
  findSpot result): open ground stays byte-identical to today's ring walk, which keeps
  the unfurnished-map early-return guarantee (sim.ts:1951) intact where no cover exists.
- **Coherence**: max drift from slot is SNAP_R by construction; the `-0.15/tile` slot
  penalty stops a whole team piling onto one hedge segment 3 m off-axis; `used`
  reservation already prevents stacking (sim.ts:1648).
- Fallback ladder if no scored tile: extend plain passable ring to r=5 exactly like
  findSpot today; null ⇒ caller skips (and the UI now shows it, §3.4).

### 1.3 Threat bearing — decided: intel first, facing second, travel direction last

Priority:
1. `q.arc` midpoint when the order carries one (defend/ambush — the player literally
   drew the threat direction).
2. ~~`q.facing` when set (right-drag formation — the player faced the line somewhere).~~
   **DELETED at M3, by audit.** A right-drag does not face the line: `facing` is the
   long axis the rank-and-file grid spreads ALONG (formationSlots, sim.ts:524-526) and
   main.ts:797-804 fans squads by cos/sin of it. Reading it as a threat bearing put a
   line dragged east-west 90° off. The threat is perpendicular to a drawn line and
   `facing` cannot say which of the two sides, so rungs 3 and 4 — which both know where
   the men came from — answer it instead.
3. Nearest **known contact** of the ordering side within 100 m of the anchor:
   `sim.spotted[side]` positions plus `sim.contacts[side]` ghosts (sim.ts:749,
   3525-3560, CONTACT_TTL sim.ts:713). NOT `visibleEnemies` — it is weapon-range-gated
   (orders.ts:56-83) and reports nothing during the approach march, which is precisely
   when you want to arrive on the right side of the hedge.
4. Fallback: bearing from the team centroid to the anchor (direction of travel — you
   default to covering the way you're advancing).

Justification over a pure danger-model bearing: dangerSamples samples the PATH, not the
destination's surroundings, and honest-vision rules (ai.ts:11-19) mean per-side intel is
the only legitimate "likely threat" source the red commander can also use. Deterministic:
contacts/spotted only mutate on the 0.5 s spotting sweep inside step() (sim.ts:2039,
SPOT_INTERVAL sim.ts:711), so within a tick the bearing is stable — same memo premise as
seenCache (orders.ts:35-49), and it is what makes preview===execution exact at commit time.

### 1.4 Integration with execution

`moveSoldiersTo` (sim.ts:1637-1663) becomes: filter by `eligible` → call
`resolveMoveSpots` → reserve + pathTo/pendingPaths exactly as today (sim.ts:1649-1661).
The resolver replaces the `formationSlots`+`findSpot` pair for ORDERED movement only.
`findSpot` keeps its other callers unchanged: dismount ring (sim.ts:1170), vehicle bail
(sim.ts:2624), flee (sim.ts:3669) — those have no formation anchor or player preview.
`moveSoldiersTo` needs the order kind/arc threaded in (new params alongside gl/facing/width,
callers sim.ts:1725, 1733); the deferred-A* machinery is untouched — the resolver runs
once at order time, which is the amortization contract (decision log INDEX.md:55).

---

## 2. Cover-seek behaviors (soldier-level smartness)

### 2.1 (a) Arrival settle — owned by the resolver, no new runtime behavior

There is no facing field on Soldier — target acquisition is omnidirectional except
defend/ambush arcs (orders.ts:12, sim.ts:1602, 3956-3971), and stance is derived
(sim.ts:566-576). So "settle into cover facing the threat" IS "the resolved tile is on
the threat side of the cover": position is the whole feature, and it costs nothing at
runtime. Deliberately NOT adding: auto-defend on arrival (changes order semantics and
collides with lane-b's defender tuning), a facing field (snapshot format change for
zero sim effect).

### 2.2 (b) Under effective fire in the open, stationary ⇒ crawl to cover

New block in `updateSoldier`, gated on a cadence like flee/rescue (`(tick + s.id) % 45`,
pattern at sim.ts:2793, 2814):

Trigger — ALL of: `!s.path` (a moving squad keeps moving; bounding's held half has
path=null but its team phase is bounding_* — exclude via team orderState phase),
`s.suppression > 0.35` (the existing "under fire" line: teamUnderFire sim.ts:1773,
stance crouch threshold sim.ts:586) but `s.mental !== 'pinned'` (pinned men cannot move,
sim.ts:2840) and not broken (flee owns them, sim.ts:2789-2795), `!sim.inCover(s.x, s.y)`,
no task/melee/emplacement, and team order is not an executing move-family order.

Action: score tiles ring r ≤ **8** around the soldier with the §1.2 scorer (threat
bearing = nearest known contact, priority 3), path via plain `astar` like the rescue
crawl (sim.ts:3216); moving at supp > 0.5 already renders and sights as a prone crawl
(stanceOf sim.ts:582). No relocation found ⇒ stay (today's behavior). Deterministic:
cadence + rng-free scoring + rng-free astar. One relocation per trigger; arriving in
cover kills the trigger predicate (`inCover` true), so no oscillation; a fresh player
order overwrites the path (orders drop tasks, sim.ts:1671).

**Balance-lane risk — the one real overlap.** This behavior reduces attrition of
suppressed troops on both sides and will move lane-b's blob-vs-doctrine baselines
(scripts/.balance-baseline.json). Containment: it ships LAST in the chain (M6), behind
its own constant (`CRAWL_SUPP_THRESHOLD`) placed in spots.ts — NOT among sim.ts's
suppression constants (SUPP_DECAY sim.ts:55, pin thresholds sim.ts:2757-2762) that
lane-b owns — and the task includes re-running `scripts/balance.mjs` and handing the
delta to lane-b rather than self-tuning.

### 2.3 (c) Defend/ambush garrison — the resolver IS the extension

Defend/ambush already flow through moveSoldiersTo (sim.ts:1729-1733), so M2 upgrades
them automatically: arc-midpoint threat bearing, crouch/prone stance scoring, window
nooks kept via the nook term. This intentionally lifts the I10 "interiors only"
restriction (sim.ts:1964-1967) — that guard existed to keep an interiors task honest,
and this design is the "large behaviour change" done as its own reviewed feature.
Red's runDefend ambushes (ai.ts:352-356) inherit it through the public API — flag to
lane-b that defender garrisons will tighten (better spots ⇒ fewer defender casualties);
same containment protocol as §2.2.

---

## 3. Preview UX — ghost dots that cannot lie

### 3.1 Reuse, don't imitate

`drawOverlays`'s move-order preview block (overlays.ts:99-155) drops its slot math and
calls `resolveMoveSpots` per team with the SAME fan chain commitOrder/orderSquad run:
squad fan from main.ts:757/781 geometry (already mirrored at overlays.ts:103-114), team
fan from sim.ts:1752/1758-1766 (mirrored at overlays.ts:117-133), then resolver with a
fresh `used` per team in `squad.teamIds` order. Parity is now structural: both sides call
one function with the same anchors. Dot rendering: `covered` ⇒ green dot (existing style
overlays.ts:141-151), snapped ⇒ small tail line slot→spot so the player SEES the snap;
uncovered stays neutral.

### 3.2 Armed-kind correctness

The preview must pass the effective kind (armedOrder ?? 'move' — main.ts:729, 753) and,
for defend/ambush with no arc yet, the §1.3 bearing ladder — preview and execution share
it, so they cannot disagree.

### 3.3 Budget + memoization

Cost per full recompute: ~140 soldiers (select-all company) × 49 tiles × (~5 terrainAt +
1 neighbor lookup) ≈ 50k array reads — well under 0.5 ms, but not per-mousemove-event.
Memoize in overlays module state keyed by
`(selectedSquads.join(), selectedTeam, floor(pick.x), floor(pick.y), quantized facing (0.05 rad)/width (1 m), kind, sim.tick)`
— recompute only on tile/formation/selection change or new tick (bearing inputs only
move on the spotting sweep, §1.3, so tick-scoped caching is conservative-correct).
Same-tick reuse also keeps the 60 fps mousemove path allocation-light. Add a
`perf.test.ts` case: resolver for 140 soldiers < 1 ms.

### 3.4 Refusal early — kill the silent failure

- Destination tile impassable with no resolvable ring (resolver returns null for all
  members): draw the existing refusal styling (balk chip pattern, overlays.ts:243-249)
  at the cursor — "no footing there" — instead of nothing; commitOrder already issues
  the order and the sim silently drops movers today (sim.ts:1647).
- Integrate, not duplicate, the danger surface: ghost dots render alongside
  dangerSamples dots + context chip (overlays.ts:157-212); the chip's cover line
  switches from `inCover(cursor)` (overlays.ts:209) to "n/m men covered" counted from
  resolver output — same chip, truer number.
- Water/void: `pick.kind === 'terrain'` gate stays, but extend the preview to soldier/
  vehicle picks by falling back to pick coordinates (fixes §0.3(5)).

### 3.5 Touch

Nothing extra: holdStart/holdMove already alias `mouse.x/y` and set `mouse.onCanvas`
(main.ts:914-926), so pickAt (main.ts:1218) and the overlay path serve the hold-ring
flow; formation hold-drag reuses formationDrag state (main.ts:1226-1235). Verify in the
touch test rig (tests/touch.test.ts) that holdMove produces resolver dots.

---

## 4. Test plan

1. **Resolver purity/determinism** (new tests/spots.test.ts): same sim state ⇒ identical
   output across 100 calls; call does not mutate snapshot() (sim.ts:4051); zero rng draws
   (compare `sim.rng` sequence before/after — the shared-stream lesson, memory:
   sim-rng-test-sensitivity).
2. **Preview===execution parity — the headline invariant**: build a furnished bourg
   battle, for a grid of destinations × formations × kinds: collect resolver output with
   preview's call pattern, then issue the real order the same tick and read
   `pendingPaths`/path targets — tile-exact equality. This test would have caught every
   divergence in §0.3.
3. **Cover-snap quality fixtures**: (a) soldier ordered 2 m from a hedge with a known
   enemy east ⇒ final tile is the WEST neighbor of the hedge run (lip rule, map.ts:503-505);
   (b) defend with arc ⇒ window nook chosen over open floor (extends
   tests/interiors-roles.test.ts patterns); (c) ambush by a bank ⇒ bank-adjacent tile
   chosen prone-only (stance-relief substrate, tests/stance-relief.test.ts); (d) open
   field, no cover in r≤3 ⇒ byte-identical to legacy findSpot result.
4. **Under-fire relocation liveness under natural dynamics** — NOT forced preconditions
   (recorded lesson: forced-precondition tests hide dead features): run a scripted MG42
   overwatch scenario ~200 s and assert ≥1 unordered soldier actually relocated into
   `inCover` ground via the crawl trigger, plus the unit-level trigger tests.
5. **Battle determinism suites**: existing snapshot() double-run tests (tests/sim.test.ts,
   breach/grenades/smoke/melee) must pass; expected baseline CHANGES (spots move) are
   re-recorded once in the same commit, called out in the task.
6. **Perf**: resolver 140-soldier budget in tests/perf.test.ts; order-burst profile
   re-checked (astar dominates at 98%, memory: perf-order-burst-profile — resolver adds
   no astar, so the burst envelope holds).

---

## 5. Task breakdown (one sequential chain)

| # | Task | Files | Size | Deps | lane-b collision |
|---|------|-------|------|------|------------------|
| M1 | `src/sim/spots.ts`: `resolveMoveSpots` + `threatBearing` + scorer; export `eligible` from sim.ts; unit tests (purity, determinism, scoring fixtures §4.1/4.3a-d as pure-function tests) | spots.ts (new), sim.ts (export only), tests/spots.test.ts | M | — | none |
| M2 | Wire execution: `moveSoldiersTo` calls resolver (kind/arc threaded from orderTeam at sim.ts:1725/1733); findSpot untouched for dismount/bail/flee; re-record determinism baselines | sim.ts:1637-1663, 1696-1738 | M | M1 | LOW — sim.ts shared file, different region from suppression block (2740-2830); rebase-only risk |
| M3 | Defend/ambush garrison audit: arc bearing, nook parity vs old garrisonScore, red runDefend smoke test; delete garrisonScore's scoring path if fully subsumed (findSpot keeps plain ring) | sim.ts:1939-1981, tests/interiors-roles.test.ts | S | M2 | MEDIUM — defender positions tighten; notify lane-b, re-run scripts/balance.mjs, hand over delta |
| M4 | Preview truth: overlays move-preview block → resolver + memo + snap tails + refusal-early + chip "n/m covered"; extend past terrain-pick gate | overlays.ts:99-155, 182-212; main.ts:1218-1250 (pass armedOrder kind through OverlayState) | M | M2 | none (UI-only) |
| M5 | Preview parity + budget tests (§4.2, §4.6) and touch verification (§3.5) | tests/spots.test.ts, tests/overlays or new tests/preview-parity.test.ts, tests/perf.test.ts, tests/touch.test.ts | M | M4 | none |
| M6 | Under-fire crawl-to-cover behavior + liveness test (§2.2, §4.4); balance re-baseline handoff | sim.ts updateSoldier (new block near 2814-2840), spots.ts (CRAWL_* consts), new tests | M | M2, M5 (ship last) | HIGH — attrition shifts both sides; constant lives in spots.ts, lane-b owns any retune of SUPP_DECAY/pin thresholds; coordinate before merge |

Chain: M1 → M2 → M3 → M4 → M5 → M6. Each task commits green (`npm test`) and is a
rewind point. No timeline estimates (house rule).

## 6. Coordination note (lane-b)

Shared file regions to watch at merge: sim.ts suppression/mental block (2750-2830 — M6
adds an adjacent block, lane-b tunes the constants inside it); ai.ts untouched by this
lane (verify at merge — lane-b may rewrite runDefend); scripts/.balance-baseline.json is
lane-b's artifact — this lane never re-records it, only reports deltas. Both lanes cite
decision log INDEX.md:55 (order-burst) as a constraint neither may relax.

## 7. Rejected alternatives

- **Danger-model threat bearing** (dangerSamples direction): samples the approach path,
  not the destination; weapon-range-gated visibleEnemies is blind at march distance (§1.3).
- **Full-map cover search / larger snap radius**: breaks formation coherence and turns
  a move order into a scatter; SNAP_R=3 keeps intent legible.
- **Facing field on Soldier**: snapshot format change, zero sim consumers (§2.1).
- **Auto-defend on arrival**: order-vocabulary change, collides with lane-b.
- **Crater cover**: no sim substrate exists (§0.2); belongs to the destructible-terrain
  scars design, not this lane.
