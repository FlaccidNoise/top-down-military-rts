# Destructible terrain — design

**Date** 2026-07-27 · **Status** design, not implemented · **Scope** tactical battle only (strategic emission designed, application deferred to T2 scars)

Owner intent: grenades, HE and vehicles breach walls and flatten fences mid-battle, creating **new sight lines and new assault routes**. Close Combat.

The whole feature rests on one property the codebase already has: **`los()` and `canStep()` read `map.hEdges` / `map.vEdges` live, every call, with no cache in between**. Mutate a byte and vision, pathing, cover, danger scoring and the AI's approach model all move with it, for free. Everything below is about (a) deciding *when* a byte flips, deterministically, and (b) making the renderer notice.

---

## 0. What was read, and what it already gives us

| Fact | Where | Consequence |
|---|---|---|
| Walls are tile-edge bytes, not tiles | `src/sim/map.ts:6` `EDGE`, `:41-48` `hEdges`/`vEdges`/`hEdgeTops`/`vEdgeTops` | A breach is a one-byte write. No geometry, no tile rewrite, no re-index. |
| `los()` blocks only on `EDGE.WALL` | `map.ts:230,239` | Any non-WALL code passes sight with zero further work. **Confirmed: a mutated edge changes LOS with no invalidation anywhere.** |
| `canStep()` foot-passes `NONE\|DOOR`, vehicle-passes `NONE` only | `map.ts:139-140` | Pathing follows the same byte. A* (`path.ts:111-116`) calls `canStep` per expansion — no edge cache. |
| Free-standing masonry is `EDGE.WALL` with top code **1** (waist) or **2** (head) and no building either side | bourg D7; `src/sim/bourg/enclosures.ts:82-88`; `src/render/enclos.ts:100-115` | **Edge class is derivable. No new classification array is needed.** |
| Building masonry is `EDGE.WALL` with top = `stories * FLOOR_H` (≥ 3) and a `buildingId` on at least one side | `src/sim/bourg/stamp.ts:155-158` | Same. |
| `hEdgeTops` / `vEdgeTops` are written **0** for every non-WALL edge | `stamp.ts:126,132`; `enclosures.ts:102,106` | The top byte is free real estate on a non-WALL edge. Used below for breach width. |
| `explode()` is the single blast funnel | `sim.ts:1859-1899`, callers at `:1163,1770,1779,1801,2002,2066` | One insertion point for blast breaching. |
| `explode()` already runs a `los()` from the burst to each victim | `sim.ts:1890` | The "does the blast reach this edge" question has an existing, precedent-blessed answer. |
| Sim uses **one shared sequential RNG stream** (`this.rng`) | memory `sim-rng-test-sensitivity`; `sim.ts` throughout | Any new draw reshuffles every downstream draw. Drives §1's no-RNG decision. |
| `snapshot()` captures **zero map state** | `sim.ts:3473-3570` | Because the map was immutable. It stops being immutable. This is the single biggest correctness hazard in the feature. |
| Chunks bake edges, keyed `${cx},${cy},${band}`, overscanning by `pad = 2` | `src/render/terrain.ts:1306,1324-1328,1365-1370` | Invalidation must cover a **5-tile-radius neighbourhood in tiles → up to 3×3 chunks**, at *every resident band*, with `this.pixels` decremented (`:1378-1383`). |
| `EnclosureIndex` is built once, in `TerrainLayer`'s constructor | `terrain.ts:1282`; `enclos.ts:88-151` | It owns free-standing wall art (`ownsH`/`ownsV` suppress `drawEdge`). A breach must patch it or the old wall keeps drawing. |
| Roofs carry a damage version tag; wall faces are explicitly *reused* across rebakes | `roofs.ts:1814` `ver`, `:2013-2015` | The B8 pattern is the template; wall faces need their own tag added. |
| There is no persisted map — the battle map is regenerated from `(seed, w, h, kind)` | bourg D-rejected-list; `src/strategic/bridge.ts:135` | No save migration surface. Scars re-stamp onto a freshly generated map. |
| Campaign doctrine already says persistent battle damage | Decision 2026-07-22 "deterministic battlefield carve **with scars**"; spec `docs/specs/2026-07-22-strategic-campaign.md:61,119` (`scars: Scar[]` — "wrecks, craters, **ruined buildings**", applied at carve step 5) | Tactical breaching is the *producer* the scar system was specified to consume. Not implemented yet (grep: no `Scar` type in `src/`), so this design **emits** and stubs the apply. |

---

## 1. Damage model

### 1.1 Edge class is derived, not stored

New pure function in `map.ts`:

```ts
export const ECLASS = { NONE:0, GATE:1, FENCE:2, WALL_LOW:3, WALL_HIGH:4, WINDOW:5, DOOR:6, MASONRY:7 } as const;
export function edgeClass(map: GameMap, x: number, y: number, horiz: boolean): number
```

Resolution (no new arrays, all of it already in the map):

| Class | Test | Threshold `THRESH` |
|---|---|---|
| `GATE` | `EDGE.DOOR`, no `buildingId` on either side | **1.5** |
| `FENCE` | *reserved* — see gap note | 1.0 |
| `WALL_LOW` | `EDGE.WALL`, top `1`, no building either side | **3.0** |
| `WALL_HIGH` | `EDGE.WALL`, top `2`, no building either side | **5.0** |
| `WINDOW` | `EDGE.WINDOW` | **4.0** |
| `DOOR` | `EDGE.DOOR` with a building | **4.5** |
| `MASONRY` | `EDGE.WALL`, top ≥ `FLOOR_H`, building either side | **9.0** |

Ordering rationale: a gate is a timber leaf in a hinge; a waist wall is one course of dry stone; a head-high enclosure wall is two; a window is glass and a timber lintel (a blown window **is** a man-sized hole, which is why it sits *below* the door and well below masonry); a house wall is 500 mm of rubble-filled masonry and needs a direct AT round or a tank gun.

**Gap, recorded not overlooked:** there is no picket-fence edge in the data model today. Free-standing walls carry only tops 1 and 2 (`enclos.ts:22` `Top = 1 | 2`). `WALL_LOW` stands in for both "waist garden wall" and "fence" until a generator emits a distinct top code. Adding one later is a `THRESH` row and an `enclos.ts` mask value — no structural change. Do **not** add a top code now: `enclos.ts:104` and `enclosures.ts:100` both pattern-match on `t === 1 || t === 2` and would silently drop an unknown code out of the enclosure art.

`hedge` is terrain (`data.ts:16`), not an edge, and is deliberately excluded — see §2.3.

### 1.2 Blast breaching is deterministic, with zero RNG draws

`explode()`'s param object gains one field:

```ts
breach?: number   // breach energy at the burst point; absent/0 = this blast never breaches
```

Then, at the end of `explode()` (after the soldier loop, so the frag/suppression draw order is untouched):

```
R = p.fragRadius
for each candidate edge whose midpoint m satisfies |m - burst| <= R:
    e = p.breach * (1 - dist/R)                    // linear falloff, + - * only
    if e < THRESH[edgeClass(...)] : continue
    if !los(map, burstX, burstY, m.x, m.y, l, l).visible : continue   // §1.4
    breachEdge(...)
```

**No RNG. Justified on three grounds, in order of weight:**

1. **The shared stream.** `this.rng` is one sequential stream; `sim-rng-test-sensitivity` in memory is a scar from exactly this. One draw per candidate edge per explosion (100–350 candidates at grenade scale) would reshuffle every downstream draw in the tick and invalidate every pinned determinism snapshot, every A/B balance test, and the tuned frag lethality in `tests/blast.test.ts`. That is not a cost worth paying for jitter.
2. **Legibility pillar.** The player must be able to look at a wall and know whether the thing in his hands opens it. "A grenade never opens masonry; a faust always does" is a rule. "A grenade opens masonry 15 % of the time" is a slot machine.
3. **The escape hatch already exists if we want jitter later.** Bourg D2's derived-sub-stream idiom — `mulberry32(base ^ Math.imul(tag, 0x9e3779b1))` — takes **zero** draws from the shared stream. A per-edge jitter would be `mulberry32(seedBase ^ imul(edgeIndex, 0x9e3779b1))`, replay-safe and stream-neutral. Design for it; don't ship it in v1.

Per-explosion breach cap: **4 edges**, taken in a fixed scan order (row-major, h before v). Bounds the render invalidation set and stops one 81 mm round from deleting a whole courtyard.

### 1.3 Breach energy per source

| Source | Call site | `breach` |
|---|---|---|
| Grenade (`GRENADE_BLAST`) | `sim.ts:61,1801` | **2.0** — gate yes, waist wall yes at contact, head wall no, masonry never |
| 60 mm mortar / default blast | `sim.ts:1779` default param | **4.0** |
| 81 mm mortar | `sim.ts:1163` | **5.0** |
| Strafe | `sim.ts:1770` | **0** — 20 mm cannon does not open masonry |
| Airstrike | `sim.ts:2066` | **6.0** |
| Tank HE at infantry | `sim.ts:2002` | **7.0** |
| AT rocket, *missed* vehicle shot | `sim.ts:2066` (`fireApAt` miss branch) | **8.0** |
| AT rocket / tank gun, **deliberate wall shot** (D5) | new | **12.0** — the only thing that reliably opens `MASONRY` |

Small arms: never. No breach path exists from `shoot()`; `MarkLayer` pockmarks stay cosmetic, which is right.

### 1.4 The occlusion guard, and why it is free

A burst inside a courtyard must not breach the far wall of the house next door. Guard: `los()` from burst to edge midpoint must be visible. That is a full grid traversal — but it runs **only on candidates that already passed the threshold test**, which is 0–3 edges on a typical burst and 0 on the overwhelming majority. Ordering the two tests this way is what keeps the whole feature off the tick budget. Do not reorder them.

### 1.5 `EDGE.BREACH`, not `EDGE.NONE` — and the width code trick

**Decision: add `EDGE.BREACH = 4`.** Four arguments, strongest first:

1. **Cover.** The unified cover model (decision 2026-07-23) sources cover from `TerrainDef.cover`, `WINDOW` crossings, and `coverBehind` *only*; bourg **D7** explicitly records that low-wall cover "would need a new `edgeCover` array". A rubble lip wants precisely the behaviour that is already in `los()` for windows and hedgerow banks: **cover granted when the ray crosses it within 2 m of the target** (`map.ts:293-294`). Implementing it is two lines reusing the existing `lastWindowT` accumulator with its own constant `BREACH_COVER = 0.35` — *no new array, no new pass, and the exact `coverBehind` precedent the cover decision was built on*. `EDGE.NONE` throws all of that away and makes a breach strictly better than a doorway, which is backwards.
2. **Vehicle asymmetry.** `NONE` means a grenade hole in a garden wall is a tank route. `BREACH` lets `canStep` decide per mode.
3. **Art needs to know.** With `NONE`, `drawEdge`/`EnclosureIndex` cannot distinguish "no wall was ever here" from "there is a gap with rubble spilling out of it", and would have to diff against a pristine copy of the map.
4. **Scars need a record.** The campaign re-stamp (§4.3) needs to say *breach*, not *absence*.

**Width without a new array:** on a `BREACH` edge, reuse the (otherwise always-zero) top byte as a width class — `1` = foot-only rubble lip, `2` = wide breach, vehicle-passable. This is the same "the top byte is a class code" idiom `enclos.ts` already reads. Wide is produced by tank HE, deliberate AT shots, and tank crush; everything smaller produces a lip.

**Cost of the new code, enumerated honestly.** Every reader of the edge arrays, from grep, and what each needs:

| File | Current handling of an unknown code | Action |
|---|---|---|
| `map.ts` `los()` `:230,239` | falls through → passes sight | ✅ correct as-is; add the 2-line cover branch |
| `map.ts` `canStep()` `:139-140` | blocks both modes | ⚠️ **must change**: foot passes `BREACH`; vehicle passes `BREACH` only when top `=== 2` |
| `path.ts:111-121` | via `canStep` | ✅ free; add the crossing cost (§1.6) |
| `render/fx.ts:155-160` `traceOvershoot` | not `WALL`/`WINDOW` → ray continues | ✅ correct — a round flies through a breach |
| `render/terrain.ts:1223` `drawEdge` | falls into the `else` (window art) | ⚠️ **must change**: add a `BREACH` branch |
| `render/enclos.ts:100-115` | not `WALL`/`DOOR` → dropped from the mask | ✅ *desired* — the run splits at the gap; needs the incremental update of §6.2 |
| `render/roofs.ts:282-287,504-506,1665` | door/window scans; `BREACH` is neither | ⚠️ a breached window must stop being drawn as a window — §6.3 |
| `render/props.ts:55-58`, `render/yards.ts:51-56`, `render/shops.ts:97` | door scans, construction-time | ✅ stale-but-harmless (a doorstep trail does not move because a wall fell) |
| `sim/bourg/*` | mapgen only, runs before any battle | ✅ untouched |

Nine files, three real changes. That is the price, and it is small.

### 1.6 Crossing a rubble lip costs time

There is no per-edge movement cost anywhere in the codebase — soldier speed samples `terrainAt(...).moveCost` once per tick at the soldier's own tile (`sim.ts:2531`), and A* charges `moveCost` per destination tile (`path.ts:121`). Two separate additions:

- **A\* cost.** Precedent: the stair vertical step charges a flat `+2` (`path.ts:136`). Charge a flat `BREACH_STEP = 2.5` when the crossed edge is `BREACH`. Effect: A* prefers a door 2 tiles away over a rubble lip, and prefers the rubble lip over a 6-tile detour. Exactly the Close Combat read.
- **Actual traversal time.** Precedent: `s.climbLeft` (`sim.ts:2515-2528`) — a per-crossing tick timer that halts `advance()` and resumes it. Add `s.scrambleLeft`, set to `SCRAMBLE_TICKS = 18` (0.3 s) when a waypoint is consumed whose incoming edge is a `BREACH`, decremented with the same shape. Do **not** reuse `climbLeft`: its completion branch writes `s.level` from the path waypoint, and coupling a horizontal scramble to the level machinery is a bug waiting for the first breach on an upper floor.

If D3 has to be cut, cut the timer, keep the A* cost. A breach that is merely *preferred less* than a door is 80 % of the gameplay.

---

## 2. Vehicle crush

### 2.1 Pathing

`updateVehicle` (`sim.ts:1901-1924`) follows a path with **no per-step `canStep` re-check** — the path was built with `mode: 'vehicle'`, so by construction it never crosses an edge. Crush therefore has to start at the pathfinder.

Add a third `canStep` mode, `'crush'`, and plumb it through `astar`'s existing `mode` parameter:

| Edge | `'vehicle'` | `'crush'` (light: truck / halftrack) | `'crush'` (tank) |
|---|---|---|---|
| `NONE` | pass | pass | pass |
| `BREACH` top 2 | pass | pass | pass |
| `BREACH` top 1 | block | pass (widens it to 2) | pass |
| `GATE` (free `DOOR`) | block | **pass, crushes** | pass, crushes |
| `WALL_LOW` (top 1) | block | **pass, crushes** | pass, crushes |
| `WALL_HIGH` (top 2) | block | block | **pass, crushes** |
| `WINDOW` / building `DOOR` / `MASONRY` | block | block | **block** |
| `hedge` terrain | block (`map.ts:132`) | block | block — §2.3 |

Two crush modes is one boolean, so make it `'crush_light' | 'crush_heavy'` rather than threading a vehicle class into `canStep`. A* charges these edges `+6` on top of `moveCost`, so a vehicle only crushes when the detour genuinely costs more.

### 2.2 The crush event

In `updateVehicle`, when the hull consumes a waypoint, resolve the edge between the previous and current waypoint tiles (same `x1 === x0 ± 1` arithmetic as `canStep`, `map.ts:135-138`). If it is crushable:

- **Fence / gate / waist wall** → `EDGE.NONE` (a flattened fence leaves nothing; there is no rubble lip in a snapped gate). Speed penalty: `v.crushLeft = 30` ticks (0.5 s) of stalled movement, mirroring `climbLeft`.
- **Head-high wall, tank only** → `EDGE.BREACH` top `2`. `v.crushLeft = 75` (1.25 s). Plus a **suppression pulse**: `suppressAround(edgeMid, side, 0.25)` for *both* sides — `suppressAround` (`sim.ts:3457`) is side-filtered, so call it twice or add a side-agnostic variant. A Sherman coming through a garden wall 8 m away should make the men behind it flinch, whoever they are.
- Push the crush point onto `pendingBooms`? **No** — that would trigger `roofs.noteImpact` and `decals.scorch` (`renderer.ts:284-285`), and a crushed fence is not a crater. Use the dedicated `pendingBreaches` channel (§4.1).

Vehicles never crush building masonry by driving, at any speed, in any tier. Two reasons: the sim has no building HP and `roofs.ts:102` says in as many words that it "must not gain one"; and a tank that can drive through a house makes every interior fight pointless.

### 2.3 Hedges: keep them crush-proof. Recommendation, with the argument.

**Recommendation: hedges stay hard-blocked for all vehicles, no tank-slow-crush.** Three reasons, and the third is the one that decides it:

1. **History.** A Normandy hedgerow is a 2 m earth bank with a root mat through it, not a hedge. Shermans that tried to climb one showed their belly plate to the far side and were killed for it. That is why the Culin Rhino existed at all — and if a Rhino is ever a campaign unlock, it needs a "before" to be an unlock *of*.
2. **The data already says so.** `hedge` is terrain (`data.ts:16`) with `featureHeight: 2`, `coverBehind: 0.5`, and vehicle-impassability hard-coded in `canStep`'s terrain blacklist (`map.ts:132`) — a decision logged at mapgen-v2, 2026-07-22. Making it crushable means either a new tile-damage system (hedge → grass conversion, which is a *tile* mutation, an entirely separate invalidation story from the edge mutation this design is built on) or a lie.
3. **It is the map's flanking layer.** Bourg D10 makes the rear-garden network's foot-connectivity a *gameplay requirement* — "a bourg without it is a corridor shoot with nice roofs". The bocage grid is the same thing at field scale: it is what makes infantry manoeuvre matter and armour dependent on infantry. A tank that can grind through hedges flattens the whole tactical geometry the map generator was built to produce. Destructible terrain should open *new* choices, not delete the existing ones.

If hedge-crushing is ever wanted, it belongs in a separate tile-destruction design with its own chunk-invalidation story, gated behind a Rhino unlock. Not here.

---

## 3. Structural collapse — explicitly out of scope

**No.** Enough wall damage does not drop a roof, and should not in this feature or the next one.

- The sim has no building HP and `roofs.ts:101-105` records that as a standing constraint, not an omission: roof damage is *"purely a render-side record of detonations the player watched land"*. Adding collapse means adding per-building HP, which means adding it to `snapshot()`, to the campaign save, to the coarse resolver, and to the AI's cover model — for a visual.
- Collapse would also have to answer "what happens to the men inside", "what happens to `stories`, `stairs` and the slab-occlusion LOS gate (`map.ts:203-217,249-273`)", and "what does a half-collapsed 2-storey building do to `los()`'s floor levels". That is a milestone, not a task.

**The cheap alternative is already shipped.** B8 roof damage (`roofs.ts:1897` `noteImpact`) reacts to every boom the player watches land, punching up to `DMG_CAP = 3` holes per building with slipped tiles and snapped rafters. Combine that with §6.3's breached wall faces and a shelled house *reads* wrecked without the sim believing anything new. Ship that, and revisit collapse only if playtesting says the house looks indestructible — which, with three roof holes and two breached faces, it will not.

---

## 4. Sim-state discipline

### 4.1 Where breach state lives

**In `map.hEdges` / `map.vEdges` / the two tops arrays. Nowhere else.** These are already sim-owned battle state on the `GameMap` the `Sim` instance holds; the renderer reads them through `sim.map` and never writes. No parallel "breach set" — a second source of truth for the same fact is how the enclosure index and the roof art end up disagreeing about where the wall is.

Two derived, additive records:

- `Sim.pendingBreaches: BreachEvent[]` + `takeBreaches()`, following the exact `takeBooms()` drain idiom (`sim.ts:1662-1666`). This is the render channel.
- `Sim.breachLog: BreachEvent[]` — append-only, never drained, survives to the debrief. This is the campaign channel (§4.3).

```ts
interface BreachEvent { horiz: boolean; x: number; y: number; cls: number; wide: boolean; cause: 'blast' | 'crush'; }
```

### 4.2 `snapshot()` — the one thing that must not be got wrong

`snapshot()` (`sim.ts:3473-3570`) captures soldiers, vehicles, teams, emplacements, smoke, grenades, kit and three maps. **It captures no map state at all**, because the map has been immutable since day one. The moment breaching lands, two same-seed runs could diverge in wall layout and every determinism test would still pass.

Add, as a top-level key:

```ts
breaches: this.breachLog.map((b) => [b.horiz ? 1 : 0, b.x, b.y, b.cls, b.wide ? 1 : 0]),
```

**Insertion-ordered list, not a set or a checksum.** A checksum proves the same *set* of edges broke; the list additionally proves they broke in the same *order*, which is what catches an iteration-order bug in the candidate scan (`Map`/`Set` iteration, `Object.keys`, a float comparison that ties differently) — precisely the class of bug that makes a replay drift 400 ticks later and is undebuggable from a checksum mismatch.

**Tests that pin it — exactly these:**

| Test | Line | What it pins |
|---|---|---|
| `tests/sim.test.ts` "is deterministic: same seed and orders produce identical state" | `:224`, snapshots at `:230,:240` | The primary gate. Extend the scenario to include a wall and a grenade, or the new field is never exercised. |
| `tests/sim.test.ts` casualty-chain determinism | `:715` | Second snapshot comparison. |
| `tests/grenades.test.ts` "determinism: two same-seed runs produce identical snapshots with a grenade thrown" | `:97` | **The most valuable existing test for this feature** — a grenade is the cheapest breacher. Add a garden wall to its fixture. |
| `tests/smoke.test.ts` | `:89` | Snapshot compare; guards against a breach path perturbing smoke ordering. |
| `tests/melee.test.ts` | `:119` | Snapshot compare. |
| `tests/blast.test.ts` | whole file | Pins `explode()`'s frag/suppression maths and the stance-neutral blast LOS. **Must stay byte-identical** — that is the proof the breach scan was appended after the soldier loop and drew nothing. |
| `tests/los.test.ts:80` "flat maps are byte-identical — levels change nothing" | `:80` | Pins the `los()` fast path the new `BREACH` cover branch must not disturb. |
| `tests/vehicles.test.ts:62` "vehicles cannot path into buildings" | `:62` | Pins that `'crush'` mode did not leak into the default `'vehicle'` mode. |
| `tests/enclos.test.ts:101` "byte-identical across two constructions of the same map" | `:101` | Pins the incremental enclosure update against a full rebuild. |
| `tests/perf.test.ts` | whole file | Tick budget. |

**Existing-kind fingerprints are untouched.** Breaching is a *runtime* mutation of a map already generated; `generateMap` draws nothing new, so `tests/mapgen.test.ts`, `tests/bourg*.test.ts` and every art baseline are unaffected by construction. The seed-sweep art gate (`scripts/sweep.mjs`) is likewise safe *by its own design*: "Scenes are static: battle boots paused and the sim is never stepped" (`sweep.mjs:6-8`) — no tick, no explosion, no breach, identical pixels. That property is worth protecting: **do not add a breach to the sweep staging.** If breach art needs a baseline, give it a new dedicated crop staged explicitly, not a mutation of an existing scene.

### 4.3 Campaign scar hook

Doctrine is already written down. Decision 2026-07-22 commits to a "deterministic battlefield carve **with scars**"; the spec defines `scars: Scar[]` on the cell as "wrecks, craters, **ruined buildings** — appended after battles" (`docs/specs/2026-07-22-strategic-campaign.md:61`), applied at carve step 5, "wrecks as obstacles, craters as cover, ruined buildings" (`:119`), with the stated payoff at `:126`: *"with scars, the Panzer killed in June is still rusting there in July."* Scars are a T2 item and are **not implemented** (no `Scar` type anywhere in `src/`).

So this design's job is to be the *producer* that system was specified to consume, and to stop there:

- On battle end, `sim.breachLog` goes into the battle result alongside casualties, as `breaches: BreachEvent[]`. Tile-indexed, so it is exactly re-stampable.
- Re-stamping is exact **because the map is regenerated, not persisted**: `bridge.ts:135` calls `generateMap(seed, 320, 240, kind)` fresh for every engagement, and the bourg decision rejected a map version flag for exactly this reason. A breach recorded at `(h, 114, 87)` on seed *S* refers to the same wall on every future generation of seed *S*.
- Stub `applyScars(map, scars)` in the carve path: for each `breach` scar, write the edge byte and the width code. Six lines. Leave it unreferenced until T2 wires the scar list, but write it now so the shape is fixed and the breach log is not silently thrown away for a milestone.
- **Do not** persist breaches into the strategic save until T2 (`src/strategic/save.ts` key `ccg-save-v3`) — a schema bump for a list nothing reads is churn.

The strategic payoff is worth stating: a town whose walls the player breached in July is a town he can flank next month, and a town the *enemy* breached is one whose defensive geometry has already been spent. That is the strategic-tactical loop the scar decision was for.

---

## 5. AI awareness

**Mostly nothing, deliberately, and that is the point of edge-byte storage.**

| System | Reads edges | Status |
|---|---|---|
| Foot & vehicle pathing | `astar` → `canStep`, live per expansion (`path.ts:111-116`) | ✅ Free. New route available on next repath. |
| Vision / spotting / fog | `los()` → `sightBetween` → `sightToSoldier`, live (`map.ts:225-291`) | ✅ Free. New sight lines are instant. |
| Cover model | `los()`'s `cover` return, plus `coverAt`/`inCover` from terrain (`sim.ts:3044-3047`) | ✅ Free, and the `BREACH` lip feeds it through the same window/`coverBehind` channel. |
| Danger model | `dangerScore` (`orders.ts`), reads LOS + cover | ✅ Free. |
| Order compliance / balk | same danger model | ✅ Free. |
| Red/blue commander approach picking | `ai.ts:260` — `los * 2 + cover - dangerScore`, sampled per team | ⚠️ One nudge (below). |

**Three things need attention, all small:**

1. **Stale in-flight paths.** A soldier already walking does not gain the shortcut until he repaths. Assault repaths on `ASSAULT_REPATH_TICKS` (`sim.ts:1830`); ordinary moves do not repath at all. **Nudge:** on `takeBreaches()` being non-empty, clear `s.path` for soldiers within ~25 m of the breach whose current order is `assault` or `move`, forcing one repath. Bounded, cheap, and it is what makes "blow the wall, then the squad pours through" actually read on screen instead of the squad finishing its walk to the door first. This is the single highest-value AI change in the feature.
2. **Approach-sample cache.** `ai.ts:226-229` samples approach candidates "once per team" and scores them. A breach changes both `los` and `dangerScore` at those samples, so the commander will drift toward it for free — but only at the next sampling. Invalidate the cached samples for teams within ~40 m of a breach so the drift is immediate.
3. **LOS-memo audit.** Verify nothing memoizes an LOS or sight result across ticks. From the read: `sightBetween` consults a per-puff smoke cache that `stepSmoke` ages every tick (`sim.ts:1792` — "`agePuff` once per puff per tick; `sightBetween` only ever reads the cache"), and memory records a *pressure* cache with a keyspace fix already landed. Neither appears to key on edges, but this is exactly the kind of thing that produces "I can see through the wall I just rebuilt" bugs. Make it an explicit verification task with a written finding, not an assumption.

Explicitly **not** needed: no new AI order, no "breach that wall" AI behaviour, no danger-model term for rubble. An AI that prefers a fresh breach over a defended door falls out of `dangerScore` (a covered doorway scores dangerous; a fresh hole in an unwatched flank does not) plus item 1. Adding a bespoke "prefer breaches" heuristic on top would double-count.

---

## 6. Render

### 6.1 Dirty-chunk invalidation — the exact keying

`TerrainLayer.cache` is `Map<string, HTMLCanvasElement>` keyed `` `${cx},${cy},${band}` `` (`terrain.ts:1306`), with `BANDS = [4,8,16,32,48]` (`:17`) and `CHUNK = 16` (`:13`). Two traps:

- **Overscan.** A chunk bakes tiles `[x0-2, x0+CHUNK+2)` (`:1324-1328`) and draws edges over that padded range (`:1365-1370`). An edge at tile `(x,y)` therefore appears in every chunk whose padded range covers it. **Invalidate every chunk intersecting `[x-2, x+2] × [y-2, y+2]`** — up to 3×3 chunks, usually 1. Get this wrong and the old wall survives in a neighbour's gutter, visible as a wall stub floating past the breach.
- **All bands, and the pixel ledger.** Delete the key at *every* band, and subtract `c.width * c.height` from `this.pixels` for each (`:1378-1383`) or the LRU budget drifts and starts evicting live chunks.

```ts
invalidateEdge(x: number, y: number): void   // new, on TerrainLayer
```

There is **no visible hole** while a chunk rebakes: `fallback()` (`:1390`) serves the same chunk from another resident band, and `BAKES_PER_FRAME = 3` (`:39`) already amortizes. This is why breaching costs almost nothing on the render side — the machinery for "this chunk changed" is the machinery for "this chunk is new", and it already exists.

### 6.2 `EnclosureIndex` incremental patch

`EnclosureIndex` is constructed once (`terrain.ts:1282`) and its `ownsH`/`ownsV` masks *suppress* the generic `drawEdge` (`:1366,1369`) so free-standing masonry can draw its own layered runs. After a breach it is stale and the old wall keeps drawing.

Add `EnclosureIndex.breach(x, y, horiz)`:
- clear the mask cell (`hFree[y*w+x] = NONE`),
- re-run `collect()` for that **single row or column only** (`enclos.ts:156-187` already loops per-`o`; factor the body out) so the run splits into two shorter runs with the gap between them,
- **do not** re-run `pockets()` (`:193`) — it is a flood fill, and a garden with a hole in its wall is still a garden. The ground dressing must not change under the player.

Pinned by extending `tests/enclos.test.ts:101` ("byte-identical across two constructions"): breach an edge incrementally, rebuild from scratch, assert the run/gate lists match.

### 6.3 Breach art

- **`drawEdge` branch** (`terrain.ts:1223`): `EDGE.BREACH` draws two short stub ends (0.15 of the span at each end, in the same `#2c241a`/`#4a4034` two-line idiom as `EDGE.WALL`) with the middle open, plus a low rubble tumble in the gap. Follow the existing convention exactly — the file's whole readability rests on `line(w, color, t0, t1)`.
- **Enclosure runs**: `drawEnclosureWalls` (`enclos.ts`) gets the same treatment via the split runs from §6.2, plus a rubble pile stamped at each new run end. The `stamp` helper (`render/stamps.ts`) is the right tool.
- **Spill onto the ground**: `DecalLayer.grit(x, y)` (`decals.ts:103`) on the two tiles either side of the breach — that function exists for exactly this ("where a thrown debris chunk came down"). Two or three calls, jittered, at breach time.
- **Pockmarks**: `MarkLayer.add` (`marks.ts:35`) a handful around the lip; the density quota (`PER_CELL = 6`) already stops it caking.

### 6.4 Wall-face version bump (the B8 pattern, extended)

`Baked` carries `ver` — "damage version this was baked at" (`roofs.ts:1814`) — and `pump()` explicitly **reuses** `wallS`/`wallE` across a damage rebake because "walls and shadow are damage-independent" (`:2011-2015`). A breach makes that comment false for walls.

- Add `wallVer: number[]` parallel to `dmgVer` (`:1824`), and a second field on `Baked`.
- `RoofLayer.noteBreach(x, y, horiz)`: locate the owning building, determine whether the breached edge is on the drawn **S** or **E** face (only those two are drawn — the fake-oblique `PARALLAX`/`H_PROJ` model, `:118-126`), re-derive that face's `openS`/`openE` array from the live map (`:504-506`), bump `wallVer[i]`, enqueue.
- `pump()` reuses `wallS`/`wallE` only when `wallVer` matches, exactly as it does for `ver`.
- `setBand()` (`:1987`) must compare **both** versions when deciding what is stale.
- Bonus, free: because `openS`/`openE` are re-derived, a breached `WINDOW` stops being drawn as a window and becomes a hole — which is the correct read and requires no new art.

### 6.5 Moment-of-breach FX

The masonry vocabulary is already built: `'masonry'` and `'dustTan'` particle kinds and `chunk0..chunk3` tumbling debris in `fx.ts:19-31`, with `shadowOffset`-aware chunk shadows (`:62`). Wire `takeBreaches()` in `main.ts` (next to `takeBooms()` at `:1162`) to a `Renderer.addBreaches()` that throws a masonry burst + 4–6 debris chunks along the wall normal, plus the decal/mark stamps of §6.3. Audio gets the same event.

**Do not route breaches through `addBooms`** — that path stamps `decals.scorch` and `roofs.noteImpact` (`renderer.ts:284-285`), and a crushed fence should not leave a crater or punch a roof hole.

---

## 7. Perf

**Sim side.** Per explosion: an integer scan over `(2R+1)²` tiles, two edge tests each — 98 tests at grenade `R=3`, ~360 at `R=9`. Pure `+ - *` comparisons plus one `edgeClass` call per non-`NONE` edge, no allocation. The `los()` guard runs only on threshold-passers (0–3, usually 0). Against the ~5 ms mean tick target and the existing 250 ms sanity p95 (`tests/perf.test.ts:16`) this is noise. Pin it anyway with a perf case: a 20-round barrage on the bourg place, asserting the breach scan stays under 0.2 ms/tick.

**Render side.** The number to measure is **one 16×16 chunk bake on a bourg at band 32** — `scripts/bake.mjs` exists for exactly this and its header names the threshold: a bake "that creeps past ~8 ms turns a zoom into a visible stall no per-frame budget" can hide. A bourg chunk is the expensive case (paving, enclosure ground, planting, shopfronts, edges, hillshade). Expectation, from the fact that a whole 320×240 bourg map generates in 18 ms and the renderer already bakes 3 chunks/frame at 60 Hz without a budget mechanism for it: **2–5 ms per chunk**, i.e. one breach's worth of rebake (1 chunk, 1 resident band, typical) fits inside a frame. Measure before committing; if a bourg chunk is over 8 ms that is a pre-existing problem this feature merely surfaces.

**Worst case: barrage on a town.** 20 rounds over ~12 m of the place, capped at 4 breaches each = ≤ 80 breaches, but the invalidation sets **union** — a 12 m circle plus the 2-tile pad spans ~5×5 chunks, not 80×9. So the worst realistic case is ~25 chunk keys × 2 resident bands = 50 bakes, drained at 3/frame = **~17 frames (0.28 s)** with band-fallback art serving throughout. Acceptable, and self-limiting: the per-explosion cap of 4 is the knob if it is not.

Roof side is already capped: `DMG_CAP = 3` holes/building (`roofs.ts:106`) and the amortized `bakeBudgetMs` queue (`:1804`).

---

## 8. Tasks

Lane A = sim (headless, testable without a canvas). Lane B = render. `D1` gates everything; after it the two lanes run independently until `D9`.

| # | Lane | Size | Task | Files | Depends |
|---|---|---|---|---|---|
| **D1** | A | **S** | `EDGE.BREACH = 4`; `ECLASS` + `edgeClass(map,x,y,horiz)`; `canStep` passes `BREACH` on foot and on vehicle when top `=== 2`; `los()` grants `BREACH_COVER = 0.35` through the existing `lastWindowT` accumulator. No behaviour change until something breaches — `tests/los.test.ts:80` and `tests/vehicles.test.ts:62` must stay green untouched. | `src/sim/map.ts` | — |
| **D2** | A | **M** | `breach?: number` on the `explode()` param object; per-source energies (§1.3) at all six existing call sites; the deterministic candidate scan appended **after** the soldier loop with the threshold-then-`los()` ordering and a 4-edge cap; `breachEdge()` writes the byte + width code; `pendingBreaches`/`takeBreaches()` (the `takeBooms` idiom) and append-only `breachLog`. **Zero `this.rng` draws.** `tests/blast.test.ts` must stay byte-identical. | `src/sim/sim.ts`, `src/sim/data.ts` | D1 |
| **D3** | A | **S** | Rubble-lip crossing cost: flat `BREACH_STEP = 2.5` in `astar`'s `stepCost` (stair `+2` precedent); `s.scrambleLeft` traversal timer in `advance()` (the `climbLeft` shape — **a new field, not a reuse**). Add `scrambleLeft` to `snapshot()`. | `src/sim/path.ts`, `src/sim/sim.ts` | D1 |
| **D4** | A | **M** | Vehicle crush: `'crush_light' \| 'crush_heavy'` `canStep` modes per §2.1's table, plumbed through `astar`'s `mode`; edge resolution on waypoint consumption in `updateVehicle`; `v.crushLeft` stall; side-agnostic `suppressAround` pulse on a tank wall-crush; fence/gate → `NONE`, head wall → `BREACH` top 2. **Hedges stay blocked** (§2.3). | `src/sim/map.ts`, `src/sim/path.ts`, `src/sim/sim.ts` | D1 |
| **D5** | A | **M** | Player-directed breaching: extend the existing point-target affordance (the mortar HE point, `sim.ts:1130`) to let an AT gunner / tank gun be assigned a **wall** target, firing a `breach: 12` blast at the edge midpoint. Without this, breaching is accidental-only and the owner intent ("assault routes you *make*") is unmet. | `src/sim/orders.ts`, `src/sim/sim.ts`, `src/ui/*` | D2 |
| **D6** | A | **S** | `snapshot()` gains the insertion-ordered `breaches` list (§4.2); extend `tests/grenades.test.ts:97` and `tests/sim.test.ts:224` fixtures to contain a breachable wall so the field is actually exercised; new `tests/breach.test.ts` for threshold table, occlusion guard, the 4-edge cap, and a same-seed replay with 30 breaches. | `src/sim/sim.ts`, `tests/*` | D2 |
| **D7** | A | **S** | AI: clear `s.path` for `move`/`assault` soldiers within 25 m of a fresh breach (one forced repath); invalidate `ai.ts`'s per-team approach samples within 40 m. Plus the written LOS-memo audit (§5 item 3) — a finding, not an assumption. | `src/sim/sim.ts`, `src/sim/ai.ts` | D2 |
| **D8** | A | **S** | Campaign emission: `breaches: BreachEvent[]` on the battle result; `applyScars(map, scars)` stub in the carve path re-stamping edge bytes (exact, because `bridge.ts:135` regenerates from the seed). No save-schema bump until T2. | `src/strategic/bridge.ts`, `src/campaign/campaign.ts` | D2 |
| **D9** | B | **M** | `TerrainLayer.invalidateEdge(x,y)`: 3×3 chunk neighbourhood for `pad = 2`, **all bands**, with `this.pixels` decremented; `EnclosureIndex.breach(x,y,horiz)` clearing the mask cell and re-`collect`ing that row/column only, never re-running `pockets()`; extend `tests/enclos.test.ts:101` to assert incremental == full rebuild. This is the wiring point for D10–D12. | `src/render/terrain.ts`, `src/render/enclos.ts`, `tests/enclos.test.ts` | D1, D2 |
| **D10** | B | **M** | Breach art: `drawEdge` `EDGE.BREACH` branch (stub ends + open middle + rubble tumble, in the file's own `line(w,color,t0,t1)` idiom); rubble pile stamps at the new enclosure-run ends via `render/stamps.ts`; `DecalLayer.grit` spill on both adjacent tiles; a few `MarkLayer` pocks on the lip. | `src/render/terrain.ts`, `src/render/enclos.ts`, `src/render/decals.ts` | D9 |
| **D11** | B | **S** | `RoofLayer.noteBreach(x,y,horiz)` + `wallVer[]` parallel to `dmgVer[]` + a second version field on `Baked`; re-derive `openS`/`openE` from the live map; `pump()` and `setBand()` compare both versions. Free win: a breached `WINDOW` stops drawing as a window. | `src/render/roofs.ts` | D9 |
| **D12** | B | **S** | Moment-of-breach FX: wire `takeBreaches()` in `main.ts` beside `takeBooms()`; `Renderer.addBreaches()` throwing the existing `'masonry'` + `'dustTan'` + `chunk0..3` particles along the wall normal; audio event. **Not** through `addBooms` (no scorch, no roof hole). | `src/main.ts`, `src/render/renderer.ts`, `src/render/audio.ts` | D9 |
| **D13** | B | **S** | Perf: measure one bourg chunk bake at band 32 with `scripts/bake.mjs` against the ~8 ms threshold; add a sim perf case for a 20-round barrage on the place (breach scan < 0.2 ms/tick). If breach art needs an art-gate baseline, add a **new dedicated sweep crop** — do not mutate an existing static scene (`sweep.mjs:6-8`). | `scripts/bake.mjs`, `tests/perf.test.ts`, `scripts/sweep.mjs` | D2, D10 |

**Critical path:** D1 → D2 → {D6, D9} → ship. D3/D4/D5/D7/D8 and D10–D13 are all independently droppable; the minimum shippable feature that meets owner intent is **D1 + D2 + D5 + D6 + D9 + D10**.

**Standing constraint for every task:** the battle determinism suite stays green — `tests/sim.test.ts:224`, `tests/sim.test.ts:715`, `tests/grenades.test.ts:97`, `tests/smoke.test.ts:89`, `tests/melee.test.ts:119`, plus `tests/blast.test.ts` byte-identical and `tests/los.test.ts:80` untouched. Existing-kind mapgen fingerprints are unaffected by construction: breaching mutates a generated map at runtime and `generateMap` draws nothing new.
