# Strategic Campaign Layer — Design

**Date:** 2026-07-22 · **Status:** Approved design, no implementation yet
**Replaces:** the linear 3-battle operation in `src/campaign/campaign.ts`

## Vision

You are the front commander (Total War / CC5 Grand Campaign fantasy): you move
companies across an operational sector map, battles ignite organically where
forces meet, and you zoom in to fight any of them with the full per-soldier
tactical sim on a battlefield carved from the strategic map's actual terrain.

**Every soldier on the front — both sides — is a named person** with wounds,
xp, and bonds. Battles you don't personally command resolve through a coarse
resolver operating on the same soldier records. Depth over fidelity is the
identity: no other game in the genre persists the *enemy's* wounded.

The roster/bonds system stays the emotional core. Attachment to "your" company
is emergent — it's whichever ones you fight with most — not hardcoded.

## Locked decisions

| Fork | Choice | Why |
|---|---|---|
| Player role | Front commander — strategic layer is a real game vs. a real AI opponent | User's chosen fantasy; also eliminates the need for a friendly-side strategic AI |
| Roster scope | Universal persistence, both sides + two-tier resolution | Data is cheap (~200 B/soldier, ~3k soldiers ≈ MBs); player time is the scarce resource, so only commanded battles get the spatial sim |
| Time model | Continuous clock + pause (1 tick = 1 strategic minute) | Makes "which battle do I command" a real decision — contacts elsewhere resolve while you fight. V1 ships with coarse speed steps |
| Map model | Operational cell grid, ~40×30 cells of 500 m | Each cell IS a tactical-map footprint → honest LODs, direct carve |
| Sector origin | Hand-authored default sector; procgen sectors later | Same cell data format for both; the hand-built sector is the generator's gold standard |
| Supply | Line tracing (Unity of Command) → per-soldier ammo states | Front *shape* becomes gameplay; source of truth for the approved per-soldier ammo mechanic |
| Campaign arc | Operation templates + sandbox mode + procgen campaigns | Objectives are data (cell predicates), so a generator is template-picking, not new systems |

## Architecture

- **`src/strategic/`** — new module. Pure deterministic TS, fixed timestep,
  seeded RNG (`mulberry32`), zero render imports. Same discipline as `src/sim/`.
- **Interface to tactical:**
  - `carveBattle(sector, engagement, seed) → Sim` — builds the battlefield and
    populates it from company rosters (extends `makeCampaignBattle`'s job).
  - `applyOutcome(front, outcome)` — one function consumes both tactical
    results and coarse-resolver results; they produce the same `Outcome` shape
    (casualty list keyed by pid, ground result, ammo/fatigue deltas, scars).
- **Renderer:** strategic map view in `src/render/`, reusing the chunked-canvas
  LRU machinery from `terrain.ts` for cell rendering.
- Saves stay JSON. localStorage until size forces IndexedDB (~3k soldier
  records + sector + scars will fit for a while; don't pre-build IndexedDB).

## Data model (sketch)

```ts
interface Cell {
  terrain: { open: number; woods: number; bocage: number; buildings: number }; // fractions
  elevation: number;
  owner: Side | 'contested';
  scars: Scar[];            // wrecks, craters, ruined buildings — appended after battles
}
interface SectorMap {
  w: number; h: number;     // ~40×30
  cells: Cell[];
  roads: Polyline[];        // sector-level, with exact cell-edge crossing points
  rivers: Polyline[];       // bridges = flagged crossing points
  seed: number;
}
interface CompanyChit {
  id: number; side: Side;
  cell: XY; destination?: XY; stance: 'attack' | 'defend' | 'move' | 'rest';
  squads: { name: string; members: pid[] }[];   // the existing squad structure
  supply: 'full' | 'low' | 'out';
  fatigue: number;
  vehicles: VehicleKey[];
}
```

Soldier records: `CSoldier` as-is, moved up to front scope (all companies, both
sides). German name pool + expanded US pool required.

## Time

- Continuous clock, 1-min ticks, speed controls (pause / 1× / fast / very fast).
  V1 ships with only pause + fast-step; smooth flow is endless tuning — later.
- Auto-pause events: contact, battle ended elsewhere, supply line cut,
  objective deadline near, company routed.
- While the player fights a tactical battle, the strategic clock runs 1:1 with
  battle time. Contacts that ignite meanwhile go to the coarse resolver.
  The front does not wait for you.

## Battle lifecycle

1. **Contact:** hostile chits in the same or adjacent cells → engagement forms
   → auto-pause → player chooses **command / delegate / withdraw** (withdrawal
   can be contested — chance based on fatigue/stance).
2. **Command:** `carveBattle` builds the map from the contested cell + approach
   edges; attacker deploys from their approach edge. One contested cell ≈ one
   company per side — matches the sim's ~250-soldier ceiling by construction.
   Extra converging companies become adjacent engagements, not mega-battles.
3. **Delegate:** coarse resolver (below).
4. **Outcome feedback:** cell ownership flips (defender withdrew/routed),
   casualties land on the soldier records, scars append to the cell, supply
   re-traces, fatigue/morale persist to the chit. Front line = the ownership
   boundary; it is never scripted.

## The carve (procgen battlefields)

Pipeline, per contested cell:

1. Read cell + neighbor edge context (~500×500 tiles at current tile scale;
   possibly cell + approach-half of the attacker's neighbor).
2. Lay roads from the sector polylines' exact edge-crossing points (both
   sides of a cell boundary agree by construction).
3. Seed buildings along roads by `terrain.buildings` density → existing
   `addBuilding` machinery (walls/doors/windows/partitions) unchanged.
4. Blob woods/bocage per composition fractions (today's seeded-blob approach).
5. Apply scars (wrecks as obstacles, craters as cover, ruined buildings).
6. **Validation pass:** flood-fill from each deployment edge to objectives;
   on failure, deterministic reroll (seed+1, bounded retries, then relax the
   failing constraint). Non-negotiable — degenerate maps are the pivot's
   biggest real risk.

Determinism: `map = f(sectorSeed, cellXY)` — revisited ground is recognizable,
and with scars, the Panzer killed in June is still rusting there in July.

**Why the pivot is smaller than it looks:** the "hand-built" map is already
90% procedural — `addBuilding` generates interiors from a rect, woods are
seeded blobs. The carve replaces the hand-placed *rect list*, not the
generation machinery.

**Real risks:** degenerate maps (mitigated above); A* cost on ~250k-tile grids
(`path.ts` is flat A* — may need hierarchical pathfinding or a smaller carve
footprint; measure first); bocage needs a new edge-ish terrain treatment
(hedge = high-cover edge or thick tile strip — decide at implementation).

## Coarse resolver

Deterministic, seeded, operating on the same soldier records:

- Abstract rounds (~10 min each). Per round: exchange fire scaled by effective
  strength, weapons, xp, supply, stance, and the cell's terrain defense value;
  roll casualties onto *individual soldiers* through the same body-part hit
  tables; aggregate morale checks → press / stall / withdraw / rout.
- Outputs the same `Outcome` shape as a tactical battle, including bond growth
  for shared survival.
- **Calibration is non-negotiable:** casualty and outcome distributions must
  match the tactical sim's (the 1000-battle headless harness provides the
  reference curves), or the player farms the difference by delegating or
  commanding selectively.

## Supply

- Trace from each side's railhead/depot cell along roads through friendly
  cells to each company. Reachable+short → `full`; long/degraded → `low`;
  cut → `out`.
- Effects: per-soldier ammo loadout at battle start (**this is the approved
  ammo mechanic's source of truth**), replacement flow, healing rate, fatigue
  recovery. `out` companies that stay cut long enough surrender-check.
- V1 may ship binary (connected/cut); the three-state version is the target.
- Encirclement therefore exists from the moment line tracing exists.

## Objectives & campaigns

Objectives are **data over cells**: `{ type, targetCells, deadline }`.
Templates: breakthrough (own any far-edge cell), capture (own a named town's
cells), hold, secure crossings (own all bridge cells), attrition (enemy
strength below X). Victory/loss = predicate evaluation on the front state.

- **Operation mode:** named operation, 1–3 templated objectives, end date,
  phased reinforcements both sides.
- **Sandbox mode:** no deadline; runs until a side collapses.
- **Campaign generator:** picks templates + force mix + depot/railhead
  placement from sector features (bridges, towns, ridges). Works on the
  hand-authored sector first; procgen sectors slot in later (T3).
- Operations chain: the roster carries forward to the next operation.

## Strategic AI (enemy front commander)

The cost of the front-commander fantasy. Tiered:
- **T1:** objective-weighted movement — advance toward objective cells, defend
  held towns/crossings, retreat broken companies. Dumb but legible.
- **T2:** reserves and counterattacks — hold back a reserve, commit it at
  player breakthroughs; exploit cut supply lines. (The genre ships passive
  AI; the aggression metric from the headless harness extends here.)

## Roster at scale (dozens of battles)

- Bond growth +0.15/battle maxes in ~5 battles — retune to ~+0.05 with
  diminishing returns; bonds decay slightly when men are separated (hospital).
- xp cap 10 fine; add veterancy titles at thresholds for legibility.
- Name pools: expand US, add German (both sides are named).
- Memorial/veterans ledger UI — the surface where universal persistence pays
  off (unit history per company, per-soldier service records, enemy aces).
- Replacements arrive via supply, not magic: throttled by supply state.

## LODs

Zoom continuum, all honest (strategic map IS the downsampled tactical world):
1. **Front overview:** cell ownership tint, NATO-style company counters,
   supply lines, objective markers.
2. **Mid:** terrain composition per cell, roads/rivers/towns, scars as icons.
3. **Close:** the *actual* carved battlefield rendered as preview — carve is
   deterministic, so we can show the real ground before the player commits.
4. **Battle:** the tactical game.

## Ambition tiers (each a complete game)

| Tier | Contents | Honest cost |
|---|---|---|
| **T1 — The Operation** | Hand-authored sector, company chits, clock w/ coarse steps, contact→carve v1, binary supply, resolver v1, universal rosters, one operation template, T1 enemy AI | The big one: strategic module + carve + resolver + strategic UI are each real subsystems. Carve validation and resolver calibration are the two items most likely to overrun |
| **T2 — The Front Alive** | Three-state supply→ammo loadouts, scars, contested withdrawal, reinforcement phasing, T2 enemy AI (reserves/counterattack), battlefield-preview LOD, full objective template set + campaign generator, sandbox mode | Mostly deepening existing systems; enemy AI is the risk item |
| **T3 — The Living War** | Procgen sectors, physical logistics (truck columns, convoy-ambush battle type), multi-cell engagements, chained operations | Each feature is its own project; convoy ambush is the highest-value novelty |

## Milestone path (playable at every step)

1. **M-A Strategic skeleton:** cell grid + hand-authored sector + chit
   movement + clock + contact detection. Battles still use today's `makeMap`
   (ignore cell terrain). Playable: a front you move on, battles where you collide.
2. **M-B The carve:** cell→battlefield generator + validation. Organic
   battlefields; revisited ground recognizable.
3. **M-C Everyone is real:** universal rosters both sides + coarse resolver +
   delegate flow + calibration pass.
4. **M-D Supply:** binary line trace → ammo loadouts, replacement throttling.
   *T1 complete — ship it.*
5. Then T2 items in value order: scars → three-state supply → enemy AI T2 →
   campaign generator → sandbox toggle.

## Open questions (deferred to implementation)

- Bocage representation: edge feature vs. tile strip.
- Carve footprint: 1 cell vs. 1.5 cells; hierarchical A* need — measure.
- Off-map artillery/air as strategic assets (currently tactical-only).
- Weather/night: strategically trivial (visibility modifiers), tactically not
  cheap. Not before T2.
- IndexedDB migration trigger point.
