# Verticality + atmospherics — micro-relief, railway, stance LOS, dynamic plumes

Design owner: lead technical designer (terrain verticality + atmospherics). Date: 2026-07-26.
Targets: `src/sim/data.ts`, `src/sim/map.ts`, `src/sim/mapgen.ts`, a new `src/sim/relief.ts`,
a new `src/sim/wind.ts`, `src/sim/sim.ts`, plus additive render work in
`src/render/terrain.ts` / `renderer.ts` / `light.ts`.

All line references verified against the working tree at `9c1ec62` (clean). Composes with
`docs/plans/2026-07-26-town-gen-design.md` (the bourg pipeline) — see §6 for the
serialization contract with its Lane A chain.

---

## 0. Decisions up front

| # | Decision | Why |
|---|---|---|
| **H1** | **No slope rule in `canStep`. Ever.** Vehicle-impassable slope is expressed as a new **terrain key** `bank`, added to `canStep`'s existing vehicle blacklist (`map.ts:114-117`). | The existing dome pass (`mapgen.ts:284-298`) skips `road`/`water`/`floor`/near-building tiles, so **every legacy map already contains elevation cliffs of up to 8 m directly against roads**. Any global max-grade rule instantly walls off the arterial on every existing map, breaks `validate`'s vehicle reachability (`mapgen.ts:379`), and changes `astar` on all six kinds. Terrain-key gating is one line and is provably inert on legacy maps (no legacy map writes `bank`). |
| **H2** | **Cuttings are modelled as raised shoulders, never as lowered ground.** | `GameMap.elev` is `Uint8Array` (`map.ts:19`) — unsigned integer metres. There is no representation for "1.5 m below datum", and lifting a global datum would produce a seam at every `floor` tile (which the dome pass pins at 0). A lane at elev 0 between two 2 m shoulders is mechanically and visually identical to a cutting and costs nothing. |
| **H3** | **Elevation is integer, so slopes are terraces: 1 m per tile.** A crest of height `H` therefore costs `H` tiles of batter per flank. | Nothing in the substrate interpolates elevation — `los()` reads `map.elevAt(tx,ty)` as a flat per-tile plateau (`map.ts:258`), and `drawHillshade` takes central differences (`terrain.ts:213-214`). A 3 m embankment is `3 + Wt + 3` ≈ 9-10 tiles wide. That is also roughly correct for a 1:2 batter at 3 m. |
| **H4** | **The stance-discriminating height is 1 m, and only 1 m.** 2 m and above blocks everybody. | Between two men at equal ground elevation the eye-line is horizontal at `e`. A 1 m rise blocks prone (0.4) and passes crouch (1.1) and stand (1.6). A 2 m rise blocks all three. There is nothing in between, because the line is flat. So the design's stance payload lives in **1 m features** — hedge banks, road verges, sunken-lane shoulders, the embankment's lowest terrace, the undulation field — and the 3 m embankment is a deliberate hard wall. |
| **H5** | **`EYE_STAND === EYE_H === 1.6`.** Crouch 1.1, prone 0.4. | `EYE_H = 1.6` (`map.ts:12`) is already the engine's standing eye and is baked into `los()`, `sightBetween`'s smoke z-line (`sim.ts:416-417`), and every LOS test. Moving it to the brief's "~1.7" changes every existing result for zero gameplay gain. Standing stays byte-identical; only crouch and prone are new. |
| **H6** | **New terrain keys are appended after `water`: `bank` (7), `rail` (8).** | `GameMap.tiles` stores `TERRAIN_KEYS.indexOf(key)` and `TERRAIN_KEYS = Object.keys(TERRAIN)` (`map.ts:9, 54-56`), so tile indices are positional. Appending is the rule the water key already followed (`docs/decisions/INDEX.md:12`). `TERRAIN_NAME: Record<TerrainKey,string>` (`ui/tooltip.ts:307`) is exhaustive, so `tsc --noEmit` **forces** both new names — a free compile-time gate. |
| **H7** | **Relief is opt-in per `(kind, size)` via a `RELIEF_BY_KIND` table, and its stage runs LAST in `tryGenerate`, after the dome pass.** Gate: `w >= 240 && h >= 180`. | Two independent guarantees. (a) *Size gate*: `generateMap(seed)` is 160×120 and `generateMap(seed, 60, 40)` is the small-map test — both make **zero** relief draws, so the two inline fingerprints (`tests/mapgen.test.ts:37-38`, `8105059f` / `d2a77805`) and every 60×40 assertion hold byte-identical with no argument. (b) *Last-stage ordering*: the dome pass is already drawn last on purpose (`mapgen.ts:279-282`); appending after it means **no 2D geometry moves at any size** — roads, buildings, hedges, woods, orchards, fields, objectives and spawns are bit-identical on 320×240 too. Only `elev` and (for rail) `tiles` change there. |
| **H8** | **`town` gets no relief at all.** | The bourg design (D1) freezes `'town'` byte-identical, and `tests/mapgen.test.ts:153-161` plus every `scripts/sweep.mjs` town crop depend on it. Verticality goes into `open`, `road`, `woods`, `river`/`bridge` and `bourg`. |
| **H9** | **Stance is a derived function, not stored state, and the renderer consumes the same function.** `stanceOf(s)` lives in `sim.ts`; `renderer.ts:523-541` maps `Stance → Pose`. | There is **no stance field on `Soldier`** today (verified `sim.ts:120-175`) — the thresholds live only in the renderer's pose switch. Deriving in the sim and having the renderer call it makes divergence structurally impossible and adds zero bytes to `snapshot()` (`sim.ts:3345+`), so the battle determinism suite is untouched by the representation itself. |
| **H10** | **The wind constant moves to `src/sim/wind.ts`; `src/render/light.ts` re-exports it.** | `src/sim/*` imports only `data`/`map`/`path`/`rng`/`sim`/`body`/`toe` — it is render-free, and must stay so. The dependency arrow is render → sim. `light.ts:12-13` currently owns the numbers and uses `Math.hypot`, which the project bans in sim decision paths (`mapgen.ts:10-11`); the sim copy normalizes with `Math.sqrt`, which **is** correctly rounded per IEEE-754. |
| **H11** | **The smoke growth/lean curve is evaluated once per puff per tick in `updateSmoke`, cached on the `Smoke` record, and read (never recomputed) by `sightBetween`.** | `sightBetween`'s smoke loop is O(puffs) **per ray**, and `los()` is the hottest path in the game (`tests/perf.test.ts:146-215`). Evaluating `h(age)`, `r(age)` and the reject radius `R²` in the once-per-tick decay loop (`sim.ts:1676-1678`) keeps the per-ray cost at pure comparisons. |
| **H12** | **The growth curve is rational (`a/(a+T)`), never exponential.** | `Math.exp`, `Math.pow` and `Math.hypot` are not guaranteed correctly-rounded across JS engines — the reason `mapgen.ts:10-11` and the 3D-height plan (§7) already ban them. `+ − × ÷` and `Math.sqrt` are IEEE-exact, so a rational saturating curve replays identically on every machine. |
| **H13** | **Frag/blast LOS stays stance-neutral** (`sim.ts:1771` keeps the default eye), pinned by a test. | The brief requires blast/suppression unchanged, and threading a prone body height into the frag ray would silently change explosion lethality on every map. Recorded as a known gap, not an oversight. |

---

## 1. Feature 1 — Micro-relief in mapgen

### 1.1 The four elements

All four are produced by one new module, `src/sim/relief.ts`, which is **pure geometry over a
`GameMap`** — it takes a map, a profile, a sub-stream and a `flatZone` predicate, and writes
`elev` / `tiles` / `crossings`. It contains no `MapPlan` knowledge and is unit-testable against
a hand-built `GameMap` before `mapgen.ts` is touched at all.

#### R-A · Hedge banks — *the highest-value item in this document*

```
for every tile t with terrainKeyAt(t) === 'hedge' and !flatZone(t):
    elev[t] = max(elev[t], 1)
for every 4-neighbour n of a hedge tile with terrain in {grass, field} and !flatZone(n):
    elev[n] = max(elev[n], 1)        // the bank's shoulder, one side only: the
                                     // side with the LOWER (x*7919+y) hash parity,
                                     // so the bank is asymmetric like a real one
```

Cost: one O(w·h) pass, zero rng draws. Effect: `hedge` already carries `opacity 0.5`,
`coverBehind 0.5`, `featureHeight 2` (`data.ts:16`) — the `coverBehind` "hedgerow lip" model
from the unified-cover decision (`INDEX.md:28`) becomes **physically true** instead of an
abstraction. A prone man (0.4) behind a hedge bank is invisible from the far side; a standing
man (1.6) is not. Norman hedgerows literally grew on earth banks; this is one loop and it is
the single strongest verticality change on the map.

No passability change: `hedge` is already vehicle-blocked and `moveCost 1.8`.

#### R-B · Low-frequency undulation

Deterministic 2-octave value noise on lattices of 48 and 19 tiles, lattice values drawn from
sub-stream `S(20)`, bilinear-interpolated with `+ − × ÷` only, rounded to integer metres:

```
u(x,y) = round( amp * ( 0.7*lerp2(L48, x/48, y/48) + 0.3*lerp2(L19, x/19, y/19) ) )   // 0..amp
```

Applied additively under the domes: `elev[i] = min(255, elev[i] + u)`, subject to:

- skip `road`, `water`, `floor`, `rail` tiles and anything with `nearBuilding` — same skip set
  as the dome pass (`mapgen.ts:293-295`), so building/road seams do not get worse;
- **feather**: any tile with a `road`/`floor` 8-neighbour has `u` clamped to ≤ 1. A 1 m step at
  the road verge is a roadside ditch a prone man can use, which is a feature; a 2 m step there
  would be a wall.
- skip `flatZone` entirely (bourg).

Amplitude by profile: `amp = 2` (open, woods, bourg-fringe), `amp = 1` (road, river/bridge).

Draw count: `(ceil(w/48)+2)·(ceil(h/48)+2) + (ceil(w/19)+2)·(ceil(h/19)+2)` — a pure function of
map size, inside the guard. Runtime ≈ 0.6 ms at 320×240.

Consequence worth stating plainly: **this changes long-range spotting for prone men across the
whole map.** The `SPOT_RANGE = 200` decision (`INDEX.md:37`) measured LOS p95 at 48-56 m and
concluded the constant is inert above ~60 m. Undulation shortens prone sightlines further and
symmetrically; the same measurement script must be re-run and the result appended to that entry.

#### R-C · Linear embankments (2-3 m, flat top 3-4 tiles)

The rail carrier. Profile, built from sub-stream `S(21)`:

```
H  = 2 + S(21).int(2)          // crest height, 2..3 m
Wt = 3 + S(21).int(2)          // flat top, 3..4 tiles
footprint width = Wt + 2H      // 7..10 tiles
```

Cross-section, from the centreline outward (H3: 1 m per tile of batter):

| offset from centre | elev | terrain |
|---|---|---|
| `0 .. Wt-1` (top) | `H` | `rail` (§2) |
| `+1` past the top edge | `H-1` | `bank` |
| `+2` | `H-2` | `bank` |
| … down to `+H` | `0` | unchanged (toe) |

Centreline: a **N→S polyline** at `x = railX`, wandering ±1 with p = 0.08 per row (the arterial
uses 0.18 per column at `mapgen.ts:59-63`; a railway is straighter, and that contrast is the
readable signature). Perpendicular to the west→east arterial, so a level crossing is guaranteed.

`railX` selection is enumerate-then-draw, never reject-and-retry:

```
candidates = every x in [12, w-12] such that
    |x - crossX| >= 40                                  // clear of the village junction
    |x - secondHamletX| >= 30   (when it exists)        // mapgen.ts:153-161
    no water tile in columns [x-H-Wt, x+H+Wt]           // no rail bridges (out of scope)
    no building rect intersects that column band inflated by 1
    the band does not intersect flatZone                // bourg
if candidates is empty: no embankment this seed (deterministic, no reroll)
else railX = candidates[ S(21).int(candidates.length) ]
```

**End taper.** Where the line stops short of a map edge (it normally does not — it runs edge to
edge), the last `6 + 2H` rows ramp the crest down 1 m per row, the top narrowing to nothing.
Rail terrain follows the crest down and stops at the toe. A crest that reaches `y = 0` or
`y = h-1` needs no taper: it leaves the map.

#### R-D · Cuttings / sunken lanes (H2: raised shoulders)

Applied to existing linear features rather than inventing new ones:

- **Farm lanes** (`mapgen.ts:164-193`, carved into the `road` mask): 1-2 lanes chosen from
  `S(22)`; each gets shoulders of `Hs = 1 + S(22).int(2)` (1..2 m), `Hs` tiles of terrace per
  flank, terrain `bank`, the lane itself untouched at elev 0.
- **Bocage parcel borders** (`mapgen.ts:194-214`): one run per parcel-border cluster gets the
  same treatment on the non-hedge flank, producing the classic Norman sunken lane.

Tactical consequence, and the reason this earns its place: **`bank` is vehicle-impassable
(H1), so a sunken lane is an infantry highway armour cannot follow or fire into.** That is
exactly the bocage asymmetry the bourg design wants from its garden network (§1.4 of the town
design), delivered outside the town for free.

### 1.2 Slope passability — the complete rule set

There is **no grade check anywhere**. Passability is entirely terrain-key driven, using hooks
that already exist:

| Hook | File:line | Change |
|---|---|---|
| Vehicle terrain blacklist | `map.ts:114-117` (`k === 'floor' \|\| 'woods' \|\| 'hedge'`) | add `\|\| k === 'bank'` — **one line**, inert on every legacy map |
| Foot passability | `map.ts:113` (`terrainAt().passable`) | `bank.passable = true` — infantry scramble the batter |
| Movement speed | `sim.ts:2404` (`terrainAt(...).moveCost`) and `path.ts:121` (A\* step cost) | `bank.moveCost = 1.5` — slower than field (1.1), faster than hedge (1.8). Both the live mover and the planner read the same `TerrainDef`, so A\* naturally routes around a bank toward the crossing. |
| Vehicle speed on the crest | same | `rail.moveCost = 1.15` — ballast and sleepers |

No new sim surface, no new array, no `canStep` signature change.

### 1.3 Composition with the town design's `flatZone`

The town design T11 introduces
`const flatZone = (x,y) => kind === 'bourg' && inRect(x, y, expand(R_env, 4))`
inside `tryGenerate`, used to skip the dome pass. **Hoist it above the dome pass and pass the
same closure to the relief stage**; do not write a second predicate. Two consumers, one
definition. On every non-bourg kind it returns `false`, so nothing moves.

The rail line is additionally required to stay *outside* `expand(R_env, 4)` but is allowed
within ~15 tiles of it, which is what makes the halt (§2.4) placeable.

### 1.4 Which archetype gets what

```ts
type ReliefProfile = { undulation: 0|1|2; hedgeBanks: boolean; rail: boolean; sunken: 0|1|2 };
const RELIEF_BY_KIND: Record<MapKind, ReliefProfile> = {
  open:   { undulation: 2, hedgeBanks: true,  rail: true,  sunken: 0 },
  road:   { undulation: 1, hedgeBanks: true,  rail: false, sunken: 0 },
  woods:  { undulation: 2, hedgeBanks: true,  rail: false, sunken: 2 },
  town:   { undulation: 0, hedgeBanks: false, rail: false, sunken: 0 },   // H8: frozen
  river:  { undulation: 1, hedgeBanks: true,  rail: false, sunken: 0 },
  bridge: { undulation: 1, hedgeBanks: true,  rail: false, sunken: 0 },
  bourg:  { undulation: 2, hedgeBanks: true,  rail: true,  sunken: 1 },   // all flatZone-guarded
};
```

Effective profile = `RELIEF_BY_KIND[kind]` when `w >= 240 && h >= 180`, else the all-zero
profile. `generateMap` gains an optional 5th argument `opts?: { relief?: ReliefProfile | 'none' }`
so tests can pin it either way without touching the table.

### 1.5 RNG discipline

Exactly one draw on the shared stream, inside the guard, following the town design's D2:

```ts
if (profileActive) {
  const reliefBase = rng.int(0x7fffffff);                                   // ONE shared draw
  const S = (tag: number): Rng => mulberry32((reliefBase ^ Math.imul(tag, 0x9e3779b1)) >>> 0);
  applyRelief(map, profile, S, flatZone, ctx);
}
```

Tags **20-29**, disjoint from the bourg pipeline's 1-14 so the two tag spaces can never be
confused during review: `20` undulation, `21` embankment + rail, `22` sunken lanes,
`23` halt/station. R-A (hedge banks) draws nothing.

Never write `S(t).int(n)` where `n` can be 0 — `rng.int(0)` still burns a draw (`rng.ts:21`).
The `candidates.length` guard in §1.1 R-C is exactly that trap.

### 1.6 Write journal and the vehicle-connectivity revert

The relief stage journals every write (`{ i, oldTile, oldElev }`, ~2,400 entries for a 320-tall
embankment). After carving, run the vehicle flood fill from `spawns.west`:

- if `spawns.east` is still in the vehicle component → keep;
- if not → **replay the journal in reverse and drop the embankment for this seed.**

Deterministic, bounded, zero rng, and it never rerolls a whole map because a decoration cut the
map in half. Guaranteed to be rare: the arterial always crosses the line and always produces a
level crossing (§2.2), so a failure means the crossing carve itself broke, which is a bug the
test suite should catch first.

---

## 2. Feature 2 — Railway

### 2.1 Tile-index discipline (the audit's water-last rule)

```ts
export const TERRAIN = {
  grass: …, road: …, woods: …, floor: …, hedge: …, field: …, water: …,   // 0..6, UNTOUCHED
  bank: { color: '#5f6b46', moveCost: 1.5,  cover: 0.10, opacity: 0, passable: true },  // 7
  rail: { color: '#6b6459', moveCost: 1.15, cover: 0.15, opacity: 0, passable: true },  // 8
} satisfies Record<string, TerrainDef>;
```

`bank` and `rail` slot **after `water`**, so `grass=0 … water=6` all hold and both inline
fingerprints are unaffected by the key addition alone. `Object.keys` preserves insertion order
for string keys, which is what `TERRAIN_KEYS` relies on (`map.ts:9`).

Compile-time consequences that `tsc --noEmit` will surface and that must be answered:

| Site | File:line | Action |
|---|---|---|
| `TERRAIN_NAME: Record<TerrainKey, string>` | `ui/tooltip.ts:307` | add `bank: 'Embankment'`, `rail: 'Railway'` |
| vehicle blacklist | `map.ts:114-117` | add `bank` (§1.2) |
| `drawTileBase` if/else chain | `terrain.ts:1058+` | add `rail` and `bank` branches (§2.5) |
| `PatchIndex.kind: TerrainKey` | `patches.ts:30` | no change; rail is not `road`, so `pavable` (`terrain.ts:673-681`) never cobbles it |

Neither key is `passable: false`, so `validate`'s foot reachability (`mapgen.ts:373-378`) and
the `woodsStands` passability guard (`mapgen.ts:239`) are unaffected.

### 2.2 Level crossings — road wins the tile

Roads are carved before relief runs (`mapgen.ts:265-270`; relief is last, H7), so at carve time
the embankment footprint already contains the arterial's 3-tile-wide road band. Rule:

```
for each tile in the embankment footprint:
    if terrainKeyAt(tile) === 'road':
        keep terrain 'road'                        // road wins
        map.crossings[i] = 1                       // NEW additive Uint8Array
        elev[i] = <the same terrace value the bank/crest profile would have given>
    else:
        write 'rail' (crest) or 'bank' (batter), and the terrace elev
```

**The elevation write on road tiles is a deliberate departure from the dome pass**, which skips
`road` unconditionally (`mapgen.ts:293`). It has to be: if the crossing stayed at elev 0 while
the crest sat at 3, the crossing would be a 3 m cliff — impassable to LOS and a visual gash.
The road corridor therefore climbs the same 1 m-per-tile terrace as the flanking bank, so the
crossing is a true at-grade crossing on a ramp.

`GameMap.crossings: Uint8Array` follows the exact precedent of `GameMap.bridges`
(`map.ts:26-31, 43, 46-48`): the sim never reads it, the renderer draws sleepers/rails/warning
posts over the road because the road overwrote the rail and the overlap would otherwise have to
be re-guessed. Add `isCrossing(x,y)` beside `isBridge(x,y)`.

Assertion: no crossing tile may also be a bridge tile — `railX` selection already excludes
columns containing water (§1.1), so this is a cheap invariant check, not a case to handle.

### 2.3 Vehicle rules

| Situation | Behaviour | Mechanism |
|---|---|---|
| Tank crossing the line off-road | **blocked** | `bank` in the vehicle blacklist; the batter is a continuous obstacle |
| Tank at a level crossing | passes, at road speed | crossing tiles are `road`, terrain-untouched |
| Tank driving *along* the crest | allowed, `moveCost 1.15` | `rail` is not blacklisted; reachable only via a crossing |
| Infantry anywhere | passes; `bank` 1.5, `rail` 1.15 | `passable: true` |

A knocked-out tank sitting hull-down on the crest of a 3 m embankment covering 300 m of open
ground is the intended set-piece, and it falls straight out of these four rows. It is also why
`EYE_VEHICLE` (§3.3) matters: a tank's optics clear obstacles a rifleman's do not.

`validate`'s existing west→east vehicle check (`mapgen.ts:379`) is the safety net, backed by
§1.6's revert.

### 2.4 Halt / station (bourg only, optional)

One `Building` with `role: 'halt'`, 7×4, stamped on the town side of the embankment toe,
adjacent to it, drawn from `S(23)`; plus a platform of 2 × 10 `road` tiles at `elev = H-1`
running alongside the crest. Appended to `plan.buildings` **after** every bourg building so the
bourg's own emission order is untouched.

`ObjectiveKind` (town design §3.1) gains `'halt'`; the halt's platform centre is a valid
greedy-coverage objective candidate (town design §3.4). A halt is a natural strongpoint: floor
tiles, a walled platform, and the crest behind it.

Cut first if schedule pressure appears — nothing depends on it.

### 2.5 Render

- **`rail`**: ballast trapezoid (two tones from the existing `coarse`/`hash` noise), sleepers
  every 0.6 m perpendicular to the run direction (derived from the 4-neighbour rail mask exactly
  as `hedgePath` derives hedge continuity, `terrain.ts:229-260`), two rail lines with a specular
  highlight on the sun side.
- **`bank`**: grass base plus a directional batter shading derived from the local `elev`
  gradient, so the slope reads as a slope rather than a stripe.
- **crossings**: `map.isCrossing(x,y)` draws sleepers + rail heads *over* the road base, plus a
  Saint Andrew's cross post on each approach.
- **Hillshade cost.** `drawHillshade` (`terrain.ts:212-222`) early-outs on
  `dzdx === 0 && dzdy === 0`. With undulation, essentially **every** tile has a non-zero
  gradient, so the early-out stops firing and the pass becomes 76,800 `Math.hypot` + `fillRect`
  calls per full bake instead of ~8,000. Two fixes, both required: replace `Math.hypot(dzdx,dzdy,1)`
  with `Math.sqrt(dzdx*dzdx + dzdy*dzdy + 1)`, and keep the `Math.abs(d) < 0.004` early-out
  (which still prunes gentle undulation). Add a chunk-bake-time assertion to the perf suite.

---

## 3. Feature 3 — Stance-aware height LOS

### 3.1 What exists sim-side today: nothing

Verified: `Soldier` (`sim.ts:120-175`) has `level`, `climbLeft`, `downed`, `captured`,
`suppression`, `mental` — **no stance, no pose, no crawl**. `Mental` is
`'steady' | 'shaken' | 'pinned' | 'broken'` (`sim.ts:64`), computed at `sim.ts:2115-2121` from
`suppression` and `morale` against `pinThreshold = 0.7 - (0.5 - courage) * 0.2`.

The only stance in the codebase is the renderer's pose switch, `renderer.ts:523-541`:

```ts
else if (s.mental === 'pinned' || (s.mental === 'broken' && !s.path)) pose = 'prone';
else if (<moving>) pose = 'walk';
else if (s.targetId >= 0) pose = s.suppression > 0.15 ? 'kneel' : 'aim';
else pose = 'idle';
```

### 3.2 The minimal deterministic proxy

Formalize *exactly that predicate* sim-side and have the renderer call it. No new state, no
snapshot change, no balance change beyond the height math itself.

```ts
// src/sim/sim.ts
export type Stance = 'stand' | 'crouch' | 'prone';
export const EYE_STAND  = EYE_H;   // 1.6 — H5, unchanged
export const EYE_CROUCH = 1.1;
export const EYE_PRONE  = 0.4;

export function stanceOf(s: Soldier): Stance {
  if (!s.alive || s.downed || s.captured) return 'prone';
  if (s.mental === 'pinned' || (s.mental === 'broken' && !s.path)) return 'prone';
  if (s.path) return 'stand';
  return s.targetId >= 0 && s.suppression > 0.15 ? 'crouch' : 'stand';
}
export const eyeOf = (s: Soldier): number =>
  { const st = stanceOf(s); return st === 'prone' ? EYE_PRONE : st === 'crouch' ? EYE_CROUCH : EYE_STAND; };
```

`renderer.ts:523-541` becomes `Stance → Pose` (`prone`→`prone`, `crouch`→`kneel`,
`stand`→`walk`/`aim`/`idle` by the existing movement/target branches), keeping every
non-stance pose (`dead`, `surrendered`, `downed`, `drag`, `aid`, `dragged`, `melee`) ahead of it.
What you see is what blocks sight, by construction.

**Doctrine stances are a separate, later change** (V8): `ambush && !path → prone`,
`defend && !path → crouch`. These are genuinely good — a reverse-slope ambush behind a 1 m
hedge bank becomes real — but they move suppression, spotting and the doctrine-health metrics,
so they ship on their own commit with the doctrine suite re-run, not folded into the mechanism.

### 3.3 Threading through the profile LOS

Signatures, all with defaults that preserve today's behaviour bit-for-bit:

```ts
// src/sim/map.ts
export function los(map, x0, y0, x1, y1, l0 = 0, l1 = 0, e0 = EYE_H, e1 = EYE_H): LosResult
//   z0 = elevAt(tx0,ty0) + l0*FLOOR_H + e0;   z1 = elevAt(tx1,ty1) + l1*FLOOR_H + e1;
//   (map.ts:174-175 — two token changes, ZERO added instructions in the traversal loop)

// src/sim/sim.ts
export function sightBetween(sim, x0, y0, x1, y1, l0 = 0, l1 = 0, e0 = EYE_H, e1 = EYE_H): LosResult
//   also replaces the hardcoded EYE_H in the smoke z-line at sim.ts:416-417

export function sightToSoldier(sim, x0, y0, t: Soldier, l0 = 0, e0 = EYE_H): LosResult
//   derives e1 = eyeOf(t) INTERNALLY — no caller ever passes a target eye for a soldier
```

Vehicle constants (V7, its own commit — this *is* a balance change and must bisect cleanly):

```ts
export const EYE_VEHICLE  = 2.2;  // commander's cupola/optics
export const HULL_VEHICLE = 2.0;  // a vehicle AS A TARGET: a bank that hides a man doesn't hide a tank
```

Emplacements keep `EYE_H` (a served gun sights at about chest height, and changing it moves
mortar-spotting balance for no verticality gain). Recorded, not forgotten.

### 3.4 EVERY caller that must pass a height

A prior height change missed exactly the vehicle-facing sites (memory:
`sight-funnel-callers.md`). This is the exhaustive list from
`grep -rn "sightBetween\|sightToSoldier\|\blos(" src/`, **including every vehicle-facing one**.

**Soldier observers — pass `eyeOf(s)`:**

| # | Site | Call | Observer eye | Target eye |
|---|---|---|---|---|
| 1 | `orders.ts:67` `computeVisibleEnemies` | `sightToSoldier(sim, f.x, f.y, e, f.level)` | `eyeOf(f)` | auto |
| 2 | `sim.ts:1485` ambush trigger | `sightToSoldier(this, s.x, s.y, e, s.level)` | `eyeOf(s)` | auto |
| 3 | `sim.ts:2984` `assaultDefenders` | `sightToSoldier(this, s.x, s.y, e, s.level)` | `eyeOf(s)` | auto |
| 4 | `sim.ts:3051` grenade target pick | `sightToSoldier(this, s.x, s.y, e, s.level)` | `eyeOf(s)` | auto |
| 5 | `sim.ts:3254` `fire()` | `sightToSoldier(this, s.x, s.y, t, s.level)` | `eyeOf(s)` | auto |
| 6 | `sim.ts:2799` `sideSeesPoint` (soldiers) | `sightBetween(this, s.x, s.y, x, y, s.level, 0)` | `eyeOf(s)` | `EYE_H` (a map point) |
| 7 | `emplacement.ts:89` `friendlyHasLos` | `sightBetween(sim, s.x, s.y, x, y, s.level, 0)` | `eyeOf(s)` | `EYE_H` |
| 8 | `orders.ts:103` `dangerSamples` | `sightBetween(sim, e.x, e.y, px, py, e.level, 0)` | `eyeOf(e)` | `EYE_STAND` (the hypothetical mover is upright) |

**Vehicle-facing — the class the last change missed:**

| # | Site | Call | Observer eye | Target eye |
|---|---|---|---|---|
| 9 | `sim.ts:2309` **AT solution** (bazooka/schreck vs vehicle) | `sightBetween(this, s.x, s.y, v.x, v.y, s.level, 0)` | `eyeOf(s)` | `HULL_VEHICLE` |
| 10 | `sim.ts:2332` **panzerfaust** | `sightBetween(this, s.x, s.y, v.x, v.y, s.level, 0)` | `eyeOf(s)` | `HULL_VEHICLE` |
| 11 | `sim.ts:1830` **tank terror** | `sightBetween(this, v.x, v.y, s.x, s.y, 0, s.level)` | `EYE_VEHICLE` | `eyeOf(s)` |
| 12 | `sim.ts:1190` emplacement AT gun vs vehicle | `sightBetween(this, e.x, e.y, v.x, v.y)` | `EYE_H` (gun) | `HULL_VEHICLE` |
| 13 | `sim.ts:1846` vehicle→vehicle acquire | `sightBetween(this, v.x, v.y, e.x, e.y)` | `EYE_VEHICLE` | `HULL_VEHICLE` |
| 14 | `sim.ts:1854` vehicle→vehicle fire confirm | `sightBetween(this, v.x, v.y, e.x, e.y)` | `EYE_VEHICLE` | `HULL_VEHICLE` |
| 15 | `sim.ts:1876` vehicle→soldier HE | `sightToSoldier(this, v.x, v.y, t, 0)` | `EYE_VEHICLE` | auto |
| 16 | `sim.ts:2803` `sideSeesPoint` (vehicles) | `sightBetween(this, v.x, v.y, x, y, 0, 0)` | `EYE_VEHICLE` | `EYE_H` |
| 17 | **`ui/tooltip.ts:136` `apSolution`** | `sightBetween(sim, fx, fy, target.x, target.y)` | caller-supplied | `HULL_VEHICLE` |

**Helpers whose signatures must change (and therefore all *their* callers):**

| # | Site | Change |
|---|---|---|
| 18 | `sim.ts:1922` `acquireSoldierTarget(x, y, side, range, arc?, l0)` | add `e0 = EYE_H`. Callers: `sim.ts:1206` (emplacement → `EYE_H`), `sim.ts:1868` (**vehicle MG → `EYE_VEHICLE`**), `sim.ts:3250` (soldier → `eyeOf(s)`) |
| 19 | `sim.ts:1998` `shotPreview(fx, fy, weapon, t, moving, aim, l0)` | add `e0 = EYE_H`. Caller `ui/tooltip.ts:99` passes `eyeOf(s)` |
| 20 | `sim.ts:2810-2814` spotting `spotters: {x,y,l}[]` | becomes `{x,y,l,e}` — `eyeOf(s)` for soldiers, `EYE_VEHICLE` for vehicles; consumed at `sim.ts:2836` |
| 21 | `ui/tooltip.ts:68 / :84` `apSolution` call sites | pass observer eye + **`l0`** (see the bug below) |

**Deliberately left on defaults, each with a comment and a pinning test:**

| # | Site | Why |
|---|---|---|
| 22 | `sim.ts:1771` frag `los()` | H13 — blast unchanged |
| 23 | `emplacement.ts:97` `crewHasLos` | gun optics stay `EYE_H` (§3.3) |
| 24 | `ai.ts:250` overwatch position scoring | positional heuristic over a *hypothetical* position; V8 changes it to the stance the team will adopt at the post (`defend && !path` → crouch) so the AI's model matches its own future reality |
| 25 | `ui/tooltip.ts:115` floor-blocked cue | deliberately re-runs the check with the observer forced onto the target's level; the comment at `:112-114` says so |

**Pre-existing bug found while enumerating, fix it here:** live AT fire passes the shooter's
level (`sim.ts:2309`: `sightBetween(this, s.x, s.y, v.x, v.y, s.level, 0)`), but the tooltip's
mirror does not (`tooltip.ts:84` → `apSolution` → `tooltip.ts:138`
`sightBetween(sim, fx, fy, target.x, target.y)`, `l0` defaulting to 0). An AT man upstairs gets a
ground-floor shot preview. That directly violates the "the UI must never re-derive (and drift
from) this formula" contract at `sim.ts:1995-1996`. `apSolution` gains `l0` and `e0`, and both
call sites pass them.

### 3.5 Cover credit through the unified cover model

No new cover path. `los()` already sources cover from three places (`map.ts:151, 273-274`):
the target tile's `TerrainDef.cover`, a `WINDOW` within 2 m of the target, and `coverBehind`
within 2 m of the target. Stance changes *which rays are blocked*, and blocked rays return
`{visible: false, cover: 0, conceal: 1}` — the existing contract. So:

- A prone man behind a hedge bank: the ray is ground-occluded → not visible at all. Better than
  cover.
- A prone man behind a 1 m road verge with the shooter close enough that the line clears it:
  visible, and the verge tile is `grass` (cover 0) — **he gets no cover credit**. This is the
  known gap the bourg design already recorded as D7 ("low-wall cover would need a new
  `edgeCover` array"). Same gap, same answer: out of scope, recorded. The mitigation is that
  `bank` carries `cover: 0.10` and `rail` `cover: 0.15`, so a man *on* the slope or the ballast
  gets a small terrain credit through the normal path.
- `shotPreview` (`sim.ts:2002-2003`) already adds up to +0.3 cover for a `pinned` or `downed`
  target — and `stanceOf` returns `prone` for exactly those states. The two models agree without
  being wired together.

### 3.6 AI symmetry — no blind-spot asymmetry

Every red sense and every blue sense routes through the same two functions. Enumerated:
red's target acquisition (#5, #18), red's ambush trigger (#2), red's visible-enemy set (#1),
red's grenade and assault picks (#3, #4), red's fog-of-war sweep (#20), red's danger model (#8),
and the red commander's own `runAttack`/overwatch logic (`ai.ts:250`, #24) all call
`sightToSoldier` / `sightBetween`. There is no red-only or blue-only sight path anywhere in
`src/sim/`.

`stanceOf` is a pure function of a `Soldier`, applied identically to both sides, with no side
term. Therefore: **a prone red man behind an embankment is invisible to blue on exactly the
same terms a prone blue man is invisible to red.** Verticality cannot create a fairness gap; it
can only make both sides blinder in the same places. This is the same guarantee the fog-of-war
decision relied on (`INDEX.md:29`, "concealment hides from intel too").

The one residual is *AI quality*, not fairness: #24 evaluates hypothetical positions with a
standing eye while the team will actually be crouched there, so red slightly over-values
overwatch spots on relief maps. Blue has no auto-positioner, so there is no mirror-image
handicap; V8 fixes it by evaluating at the post's future stance. Ship a test that runs the same
scenario mirrored (sides swapped, map mirrored in x) and asserts identical spot counts.

### 3.7 Perf

**Zero added cost in the LOS hot loop.** `los()`'s change is `+ EYE_H` → `+ e0` / `+ e1` at
`map.ts:174-175`, outside the `while` traversal. The traversal, the slab loop, the edge tests
and the terrain accumulation are untouched instruction-for-instruction. `eyeOf(s)` costs 3-4
predictable branches **once per call**, not once per tile step; a 60-tile ray amortizes it to
nothing.

Relief makes `los()` *cheaper*: the ground-occlusion test `map.elevAt(tx,ty) >= lineZ`
(`map.ts:258`) already runs on every entered tile, and undulation causes more rays to terminate
early. Extend `tests/perf.test.ts:163`'s load-invariant ratio benchmark with a third arm — a
320×240 relief map — and assert `reliefRatio <= LOS_MICRO_MAX_RATIO` (2.5), with the expectation
that it lands **below** the building-map ratio of ~0.64.

---

## 4. Feature 4 — Dynamic 3D plumes

### 4.1 Where the wind lives

New `src/sim/wind.ts`:

```ts
// One wind, the same way there is one sun. Sim-side because sim must never
// import render; render/light.ts re-exports this so fx.ts and roofs.ts are unchanged.
// Math.sqrt is IEEE-754 correctly-rounded; Math.hypot is not — hence sqrt here.
const RX = 0.82, RY = -0.57;
const L = Math.sqrt(RX * RX + RY * RY);
export const WIND = { dx: RX / L, dy: RY / L };
export const WIND_SPEED = 1.6;      // m/s, was fx.ts:40
export const LEAN_K = 0.35;         // horizontal metres of drift per vertical metre
```

`src/render/light.ts:12-13` becomes `export { WIND } from '../sim/wind';`. `fx.ts:38-40` keeps
its `WIND = { ...LIGHT_WIND, speed: WIND_SPEED }` shape, so `renderer.ts:880, 1097-1098` and
`roofs.ts:1354-1355` need no edit at all. Direction of dependency is preserved: render → sim.

### 4.2 The aged, leaning column

`Smoke` (`sim.ts:306-312`) gains four fields, all additive:

```ts
export interface Smoke {
  x: number; y: number; z0: number;
  h: number;      // CURRENT height, m — now recomputed each tick instead of constant
  ttl: number;
  age: number;    // seconds since deploy
  kind: 0 | 1;    // 0 = shell/grenade, 1 = fire (burning wreck / building)
  r: number;      // CURRENT radius, m
  r2max: number;  // cached (r + LEAN_K*h)^2 — the per-ray early-reject radius, squared
}
```

Curves — rational and saturating (H12), evaluated **once per puff per tick** in the existing
decay loop at `sim.ts:1676-1678`:

```ts
const PLUME = [
  { h0: 1.5, hMax: 10, T: 10, r0: 1.5, rMax: 3.0 },   // 0 shell smoke
  { h0: 2.0, hMax: 20, T:  8, r0: 2.0, rMax: 4.5 },   // 1 fire
] as const;

function grow(a: number, v0: number, vMax: number, T: number): number {
  return v0 + (vMax - v0) * (a / (a + T));            // + - * / only
}

// in updateSmoke, per puff, per tick:
p.age += DT;
const k = PLUME[p.kind];
p.h  = grow(p.age, k.h0,  k.hMax, k.T);
p.r  = grow(p.age, k.r0,  k.rMax, k.T);
const R = p.r + LEAN_K * p.h;
p.r2max = R * R;
```

Shell-smoke calibration against the existing constant: `h(3 s) = 1.5 + 8.5·(3/13) = 3.46 m`,
which is `SMOKE_H = 3.5` to within 1 %. So the first three seconds are indistinguishable from
today, and the column then grows: `h(10) = 5.75`, `h(30) = 7.87`, `h(60) = 8.79`, cap 10.

`SMOKE_H` stays exported (it is imported by `tests/sim.test.ts:7`) and is redefined as
"the deploy-plus-3-seconds height of shell smoke", with the calibration asserted by a test so a
future retune of `PLUME[0]` cannot silently drift it.

**This supersedes the 2026-07-23 3D-height decision** (`INDEX.md:23`, "3D smoke columns z0+3.5m,
upstairs sees over ground smoke"). A floor-2 eye at 4.6 m now sees over a fresh puff and is
blinded by an eight-second-old one. That is the correct model and it is the point of the
feature, but it changes the AI's smoke doctrine loop (`INDEX.md:39`, `maybeSmokeObjective` /
"smoke before assault"): the screen gets *better* over time rather than being static.
`tests/doctrine.test.ts`'s smoke-before-assault metric must be re-run and, if it moves, its
threshold re-justified in the same commit.

### 4.3 The LOS test — a slanted capsule, sampled once

The column axis at height `z` is
`axis(z) = (p.x + WIND.dx·LEAN_K·(z - p.z0),  p.y + WIND.dy·LEAN_K·(z - p.z0))`.

Replacing the loop body at `sim.ts:419-430`:

```
for each puff p:
  # 1. Cheap reject against the ENLARGED radius — one projection, no z math.
  t  = closestT(p.x, p.y, x0, y0, x1, y1)
  cx = p.x - (x0 + t*dx);  cy = p.y - (y0 + t*dy)
  if cx*cx + cy*cy > p.r2max: continue          # prunes ~all puffs, CHEAPER than today

  # 2. Height of the eye-line where the column's BASE sits.
  lineZ = zEye0 + (zEye1 - zEye0)*t
  if lineZ < p.z0: continue                     # ray passes under the column
  zc = min(lineZ, p.z0 + p.h)                   # clamp to the column top

  # 3. Re-project against the axis AT that height — one more projection.
  const off = LEAN_K * (zc - p.z0)
  ax = p.x + WIND.dx*off;  ay = p.y + WIND.dy*off
  t2 = closestT(ax, ay, x0, y0, x1, y1)
  bx = ax - (x0 + t2*dx);  by = ay - (y0 + t2*dy)
  if bx*bx + by*by > p.r*p.r: continue

  # 4. Confirm the z-interval at the refined parameter.
  lineZ2 = zEye0 + (zEye1 - zEye0)*t2
  if lineZ2 < p.z0 || lineZ2 > p.z0 + p.h: continue
  opacity += 0.5
```

One fixed-point refinement, no iteration, no allocation, no transcendental — **O(1) per puff,
with a hard instruction bound**. All arithmetic is `+ − × ÷` and comparisons, so it replays
exactly across engines.

Cost accounting against today's loop:
- **Rejected puffs (the overwhelming majority): ~12 flops, versus ~14 today** — the enlarged-radius
  reject fires before any z arithmetic, so the common case is *faster* than the current code,
  which computes `lineZ` for every puff inside the 1.5 m gate.
- **Surviving puffs: ~26 flops, versus ~14 today** — one extra projection and two multiply-adds.
- The `if (!base.visible || sim.smoke.length === 0) return base` early-out at `sim.ts:413` is
  unchanged, so smokeless rays pay literally nothing.
- Everything age-dependent (`h`, `r`, `r2max`) is precomputed per tick (H11), never per ray.

Net expected effect on the whole-tick budget: neutral. Add a smoke arm to the perf suite —
10k `sightBetween` calls through a 12-puff screen, ratio-asserted against the same call count
with `sim.smoke = []`.

### 4.4 Renderer parity

`renderer.ts:268-310` currently derives an alpha envelope from a private `smokeMaxTtl` map keyed
on `(x,y)`. Replace with direct reads of the sim's own fields plus one shared helper exported
from `sim/wind.ts`:

```ts
export const smokeAxisAt = (p: Smoke, z: number): [number, number] =>
  [p.x + WIND.dx * LEAN_K * (z - p.z0), p.y + WIND.dy * LEAN_K * (z - p.z0)];
```

The renderer draws N puffs sampled up the column at `z = p.z0 + i/(N-1) · p.h`, each positioned
by `smokeAxisAt` and sized from `p.r`. **The renderer and `sightBetween` therefore evaluate the
same lean formula from the same file** — what you see is what blocks sight, structurally, not by
coincidence. `smokeMaxTtl` and its key-eviction loop (`renderer.ts:99, 310`) are deleted; `age`
supplies the envelope directly.

### 4.5 Burning wrecks (the `kind: 1` source)

There is no fire in the sim today. One line at the vehicle-death site pushes
`{ ..., kind: 1, ttl: 180 }`, giving a knocked-out tank a 20 m plume that blinds the street it
died in for three minutes and is visible from anywhere on the map. Cheap, dramatic, and it feeds
the `seenStatic` wreck rule already in place (`INDEX.md:29`). Own V-task, last, fully optional.

### 4.6 Determinism

`snapshot()` (`sim.ts:3419`) extends the smoke tuple to include `age`, `kind`, `h`, `r` at the
same `Math.round(v * 1e6)` precision as the existing fields. There is no inline snapshot of sim
state anywhere in `tests/` (only two-runs-agree comparisons at `sim.test.ts:224`,
`melee.test.ts:115`, `grenades.test.ts:97`), so the suite stays green and gains coverage of the
new fields for free.

Blast and suppression are untouched: `explode` (`sim.ts:1755-1780`) never reads `sim.smoke`.

---

## 5. Test plan

### 5.1 Determinism gates (must stay green, must NOT be re-snapshotted)

| Test | Why it holds |
|---|---|
| `tests/mapgen.test.ts:37-38` — `8105059f` / `d2a77805` | 160×120 fails the `w >= 240` gate → zero relief draws, zero writes (H7a) |
| `tests/mapgen.test.ts:41-102` — seeds 1-30 connectivity, hedge steps, orchard count | default kind, 160×120 |
| `tests/mapgen.test.ts:104-194` — bridge/river geometry, bridge-last, 60×40 floor | 60×40 fails the gate; bridge/river 2D geometry is untouched by a last-stage elev pass (H7b) |
| `tests/mapgen.test.ts:153-161` — `'town'` density | `town` has the null profile (H8) |
| `tests/sim.test.ts:192`, `tests/vehicles.test.ts:63` | `buildings[0]` geometry unchanged at any size |
| `tests/los.test.ts` (whole file) | `los()`'s new params default to `EYE_H`; `:90-92`'s flat-map equality loop is the strongest guard |
| `tests/perf.test.ts:88, 249` — 2-storey selection and height-stress | building placement is bit-identical at 320×240 (H7b); only `elev` moved |

### 5.2 New determinism assertions

- `generateMap(s, 320, 240, k)` twice → identical `tiles`/`elev`/`crossings` for every kind.
- **Sub-stream independence**: perturb tag 21 and assert the undulation field (tag 20) and the
  sunken lanes (tag 22) are bit-identical. This is what makes §1.5 real rather than aspirational.
- **`relief: 'none'` parity**: `generateMap(s, 320, 240, k, { relief: 'none' })` is byte-identical
  to today's `generateMap(s, 320, 240, k)`, over 30 seeds × 6 kinds. This is the single test that
  proves H7's "additive, guarded" claim end to end, and it must be written **first**, against the
  pre-change binary via a fixture dump.
- Battle determinism suite (`sim.test.ts:224`, `melee.test.ts:115`, `grenades.test.ts:97`) green
  with smoke on the map at ≥ 30 s age.

### 5.3 Behaviour tests

| Assertion | Feature |
|---|---|
| A 1 m bank between two prone men blocks; between two standing men passes | H4, the headline |
| A 3 m embankment blocks stand→stand both ways | R-C |
| `canStep(..., 'vehicle')` across any `bank` tile is `false`; across a crossing tile is `true` | H1, §2.3 |
| A vehicle path from `spawns.west` to `spawns.east` exists on every relief seed, and crosses at a `crossings` tile | §1.6 |
| No `crossings` tile is also a `bridges` tile; no `rail` tile is adjacent to `water` | §2.2 |
| Every rail crest tile has `elev === H`; every bank tile's elev differs from its outward neighbour by exactly 1 | H3 |
| Embankment taper: no elev step > 1 anywhere along the centreline | R-C |
| `stanceOf` agrees with the renderer's pose for all 4×3 (mental × path/target) combinations | H9 |
| A pinned man behind a hedge bank is invisible; the same man `steady` is visible | §3.2 |
| **Mirror test**: same scenario with sides swapped and the map mirrored in x → identical spot counts, identical acquire counts | §3.6 AI symmetry |
| Every one of the 21 call sites in §3.4 passes a non-default eye — enforced by a lint-style test that greps for bare `sightBetween(`/`sightToSoldier(` calls in `src/sim/` and `src/ui/` against an allow-list of the 4 deliberate defaults (§3.4 #22-25) | the recorded lesson |
| `shotPreview` and `apSolution` agree with live fire for an upstairs AT man | the §3.4 bug fix |
| Smoke `h(3 s)` within 1 % of `SMOKE_H` | §4.2 calibration |
| A floor-2 eye sees over a 0 s puff and is blinded by a 15 s puff | §4.2 |
| The renderer's drawn column top and `sightBetween`'s blocking top agree to < 0.01 m at ages 0/5/30/60 | §4.4 WYSIWYG |
| Frag LOS is unchanged by the victim's stance | H13 |

### 5.4 Perf

- `los-micro` gains a **relief arm** (320×240 relief map) and a **smoke arm** (12 puffs, mixed
  ages); both ratio-asserted against the existing flat baseline, `< 2.5`.
- `generateMap(s, 320, 240, 'open')` mean stays under its current ~34 ms (relief adds ≈ 2 ms:
  0.6 ms undulation + 0.3 ms hedge banks + 0.5 ms embankment + 0.6 ms the connectivity flood
  fill). If the town design's T1 lands first, the same measurement should show < 12 ms.
- Chunk-bake time with a fully undulating `elev` field (§2.5) asserted against the current
  `PIXEL_BUDGET` path.

### 5.5 Art regression

`scripts/sweep.mjs` crops derive from `plan.objectives` / `plan.buildings`
(`scripts/lib/stage.mjs:59-113`), both of which are **bit-identical** under H7b — so the crops
stay in exactly the same places and the diffs are purely the new art (hillshade, rail, banks).
That makes re-approval a genuine visual review rather than a re-baseline of moved windows.
Add one new crop: the level crossing, located from `map.crossings`.

---

## 6. Task breakdown

### Dependency structure

Two files are contended with the bourg pipeline, and only two:

- **`src/sim/mapgen.ts`** — owned by the town design's Lane A (T1→T14). Any V-task that edits it
  **serializes after town-design T11** (which introduces `flatZone`, the predicate V3 must reuse
  rather than duplicate). That is **V3** and **V5** only.
- **`src/render/terrain.ts`** — owned by the town design's Lane B (T18/T19/T20). **V4** must
  coordinate with T18; both add branches, in different functions (`drawTileBase` vs `drawEdge`),
  so a rebase is the whole cost.

Everything else — `data.ts`, `map.ts`, `relief.ts`, `wind.ts`, `sim.ts`, `renderer.ts`,
`light.ts`, `ai.ts`, `orders.ts`, `emplacement.ts`, `tooltip.ts` — is **untouched by the bourg
work** and runs fully parallel with it.

```
                     ┌─ V1 ─┬─ V2 ─── [town T11] ─── V3 ─┬─ V5
                     │      └─ V4                        └─ V14 ─ V15
  (start, parallel) ─┼─ V6 ─── V7 ─┬─ V8
                     │             └─ V9
                     └─ V10 ── V11 ─┬─ V12
                                    └─ V13
```

`V6` and `V11` both edit `sightBetween`'s body — V11 serializes after V6 to avoid a merge in the
hottest function in the codebase.

### The tasks

**V1 · Terrain keys, vehicle blacklist, `crossings` array — S — Lane R**
`src/sim/data.ts` (append `bank`, `rail` after `water`), `src/sim/map.ts` (`crossings: Uint8Array`
+ `isCrossing()` mirroring `bridges` at `:26-31,43,46-48`; add `bank` to the vehicle blacklist at
`:114-117`), `src/ui/tooltip.ts:307` (`TERRAIN_NAME` entries — `tsc` forces these). Zero
behaviour change: no generator writes either key yet. `tsc --noEmit` + full suite green,
fingerprints untouched. *No dependency; start immediately.*

**V2 · `src/sim/relief.ts` — the geometry module — L — Lane R**
Pure functions over a `GameMap`: `hedgeBanks()`, `undulate()` (2-octave integer value noise with
the road/floor feather), `embankment()` (candidate enumeration, terrace profile, crossing carve,
end taper), `sunkenLane()`, plus the write journal and its reverse-replay. Takes a `ReliefProfile`,
an `S(tag)` sub-stream factory and a `flatZone` predicate as arguments — **no `mapgen.ts`
import, no `MapPlan` knowledge**. Unit-tested against hand-built `GameMap`s (a bare grass map, a
map with a road band, a map with a water column, a map with a `flatZone` rect) before any
generator wiring exists. This is where a bug silently corrupts elevation across the map, so it
is tested standalone. *Depends on V1.*

**V3 · Wire relief into `generateMap` — M — Lane R — SERIALIZES AFTER TOWN-DESIGN T11**
`src/sim/mapgen.ts`. `RELIEF_BY_KIND`, the `w >= 240 && h >= 180` gate, the optional 5th
`opts.relief` argument, the single `reliefBase = rng.int(0x7fffffff)` draw inside the guard, the
tag-20-to-23 sub-stream factory, the call placed **after** the dome pass at `:279-298`, hoisting
T11's `flatZone` above the dome pass so both consumers share one definition, and the vehicle
flood-fill + journal revert. Same commit verifies `8105059f` / `d2a77805` and ships the
`relief: 'none'` parity test of §5.2. *Depends on V2 + town T11.*

**V4 · Rail / bank / crossing render + hillshade cost fix — M — Lane R (render)**
`src/render/terrain.ts`: `drawTileBase` branches for `rail` (ballast, neighbour-derived sleeper
direction, two rail lines with a sun-side specular) and `bank` (gradient-derived batter shading);
a crossing overlay gated on `map.isCrossing`; the `Math.hypot` → `Math.sqrt` swap and the
bake-budget assertion of §2.5. Developable against a hand-built map before V3 lands.
*Depends on V1; coordinate with town-design T18.*

**V5 · Halt / station role for bourg — S — Lane R**
`src/sim/relief.ts` + `src/sim/mapgen.ts` (bourg branch): the 7×4 `role: 'halt'` rect, the `road`
platform strip at `elev = H-1`, `ObjectiveKind` gains `'halt'`, appended after every bourg
building. First thing to cut. *Depends on V3 + town-design T7/T10.*

**V6 · Eye-height parameters + `stanceOf`/`eyeOf` + renderer pose unification — M — Lane S**
`src/sim/map.ts` (`los` gains `e0`/`e1`, defaulting to `EYE_H`), `src/sim/sim.ts`
(`Stance`, `EYE_STAND/CROUCH/PRONE`, `stanceOf`, `eyeOf`; `sightBetween` gains `e0`/`e1` and uses
them for the smoke z-line at `:416-417`; `sightToSoldier` gains `e0` and derives `e1 = eyeOf(t)`),
`src/render/renderer.ts:523-541` rewritten as `Stance → Pose`. **Zero call sites updated in this
task** — defaults keep every result byte-identical, so this commit's whole job is to prove the
plumbing is inert. `tests/los.test.ts` is the gate. *No dependency; start immediately.*

**V7 · Thread the eye through all 21 call sites — M — Lane S**
The complete table of §3.4, including `EYE_VEHICLE`/`HULL_VEHICLE` and all seven vehicle-facing
sites (#9-#15 and #18's vehicle-MG caller), the three signature changes (#18 `acquireSoldierTarget`,
#19 `shotPreview`, #20 the `spotters` array), the `apSolution` fixes (#17, #21) including the
missing-`l0` bug, and the four documented defaults (#22-25) with their pinning tests. Ships the
grep-based allow-list test so the next height change cannot repeat the recorded miss.
*Depends on V6.*

**V8 · Doctrine stances + the AI positional heuristic — M — Lane S**
`ambush && !path → prone`, `defend && !path → crouch` in `stanceOf`, the matching renderer poses,
and `ai.ts:250` evaluating the post's future stance instead of a standing eye. Balance-bearing:
re-run `tests/doctrine.test.ts` in full and re-justify any moved metric in the same commit.
*Depends on V7.*

**V9 · Stance × relief behaviour tests + the AI-symmetry mirror test — M — Lane S**
Everything in §5.3's stance and symmetry rows, on staged maps rather than generated ones so the
assertions are exact. *Depends on V7; parallel with V8.*

**V10 · `src/sim/wind.ts` + `light.ts` re-export — S — Lane P**
Move the wind numbers sim-side with `Math.sqrt` normalization, re-export from `light.ts:12-13`,
keep `fx.ts:38-40`'s shape so `renderer.ts` and `roofs.ts` are literally unchanged. Assert
`WIND.dx`/`WIND.dy` are bit-identical to today's values. *No dependency; start immediately.*

**V11 · Aged, leaning smoke: model + LOS — M — Lane P**
`src/sim/sim.ts`: the four new `Smoke` fields, `PLUME`, `grow()`, the once-per-tick recompute in
`updateSmoke` (`:1676-1678`), the two-projection capsule test replacing `:419-430`, the
`SMOKE_H` calibration redefinition, and the `snapshot()` extension. Ships the smoke perf arm.
*Depends on V6 (same function) + V10.*

**V12 · Renderer reads the same height/lean — M — Lane P**
`src/render/renderer.ts:268-310`: draw the column as N puffs along `smokeAxisAt`, sized from
`p.r`, envelope from `p.age`; delete `smokeMaxTtl` (`:99, 310`). Ships the WYSIWYG agreement
test of §5.3. *Depends on V11.*

**V13 · Burning wrecks emit a `kind: 1` plume — S — Lane P**
One push at the vehicle-death site, `ttl: 180`. Verify the AI doctrine loop does not
pathologically avoid every wreck. Fully optional. *Depends on V11.*

**V14 · Perf hardening — S — cross-cutting**
`tests/perf.test.ts`: the relief arm and the smoke arm on the load-invariant ratio benchmark
(`:163`), the mapgen budget assertion, and the chunk-bake assertion of §2.5.
*Depends on V3 + V11.*

**V15 · Fingerprints, sweep baselines, decision log — S — cross-cutting**
New inline fingerprints for `generateMap(1|2, 320, 240, k)` for every relief-bearing kind (the
320×240 tripwire that does not exist today), the `scripts/sweep.mjs` level-crossing crop, art
re-approval, the re-run of the `SPOT_RANGE` measurement script from `INDEX.md:37`, and a
`docs/decisions/INDEX.md` entry recording H1-H13 — explicitly noting that §4.2 **supersedes** the
2026-07-23 3D-height entry's constant-height smoke column, and that D7's low-wall-cover gap is
now also the 1 m-relief-cover gap. *Depends on everything.*
