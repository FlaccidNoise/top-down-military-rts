# Plan: Unit System Foundation (Milestone 5)

**Goal:** Implement the tactical-side unit system designed in the 2026-07-22 specs: data-driven teams/squads, national weapons with discrete ammo, the 7-order vocabulary with interpret+refuse, crewed weapons, transport/StuG vehicles, casualty-chain upgrades, and an AI commander that uses it all.

**Architecture:** Everything composes from the per-soldier atom in `src/sim/` (headless, deterministic, fixed 1/30s timestep, `mulberry32` seeded RNG). All unit content lives as pure data in `src/sim/data.ts`; sim logic consumes keys. New behavior systems (orders, emplacements) get their own files; `sim.ts` stays the entity/update hub. Renderer (`src/render/`, `src/main.ts`) is a thin consumer — sim never imports render.

**Tech stack:** TypeScript 5.5 strict, Vite 6, Vitest 3. Commands: `npm test` (vitest run), `npm run check` (tsc --noEmit). No new dependencies.

**Specs (read before your task):** `docs/specs/2026-07-22-unit-system.md` (schema §7, mechanics §3), `-order-execution.md`, `-casualty-chain.md`, `-ai-commander.md`. Design decisions in `docs/decisions/units.md`, `gameplay.md` — do not relitigate them.

**Excluded from this plan (depends on unbuilt strategic layer):** CompanyDef/AttachmentDef/requisition, supply→ammo scaling, coarse-resolver weights, chit schemas (`docs/specs/2026-07-22-toe-attachments.md` waits for campaign milestone M-A+).

**Post-M-A re-verification (2026-07-22, against `e12e4e4` + wrap-up commits):** M-A tasks 1–6 landed. Touchpoints verified; four moves since the plan was written:
- `makeCampaignBattle` no longer exists. Battles build via `makeStrategicBattle` in `src/strategic/bridge.ts`, whose `redMembers()` carries old weapon keys — an extra Task 1 call site. Commander wiring (`new RedCommander({stance, posts})`) also lives there, not scenario.ts.
- Campaign saves moved: key `'ccg-save-v2'` in `src/strategic/save.ts` (whole state incl. front), not `'ccg-campaign-v1'`. `LEGACY_WEAPONS` applies in `loadGame` — debrief/HUD read `WEAPONS[cs.weapon]` directly off campaign soldiers, so mapping only in `fitRoster` still crashes old saves.
- UI split out of main.ts: buttons/panels in `src/ui/hud.ts`, world-anchored canvas feedback in `src/ui/overlays.ts`, inspect/tooltips in `src/ui/tooltip.ts`. Renderer split into `src/render/{dudes,vehicles,decals,terrain,roofs}.ts`.
- `scenario.ts` gained `placedSquad` + `roadSpot`/`addVehicleOnRoad`; a campaign.test.ts invariant asserts vehicles spawn on road — Task 5's rewrite must keep it.

Work on branch `m5-unit-system`, rebase on main between batches, grep symbols not line numbers.

**Global constraints:**
- Determinism is sacred: seeded RNG only, no `Date.now`/`Math.random`; iterate entities by index order; the `snapshot()` determinism test in `tests/sim.test.ts` must keep passing (extend it with new state, never remove fields from it).
- `data.ts` exports remain `satisfies Record<string, XDef>` const objects with derived key types (existing pattern).
- Existing public Sim API (`orderMove`, `addSquad`, `addVehicle`, `callBarrage`, snapshot) may change signature ONLY where a task says so; update all call sites in the same task.
- Every task ends green: `npm run check && npm test`.
- Commit after each task: `git commit -am "M5 Task N: <title>"`.

## File map

| File | Responsibility |
|---|---|
| `src/sim/data.ts` (M) | All defs: terrain, ammo, weapons, loads, teams, squads, emplacements, vehicles, names |
| `src/sim/sim.ts` (M) | Entities + per-tick update; soldier ammo/stamina/heat; succession; vehicles |
| `src/sim/orders.ts` (C) | Order types, team executor state machines, danger/compliance model |
| `src/sim/emplacement.ts` (C) | Emplacement entity, loads, deploy/pack, indirect fire |
| `src/sim/scenario.ts` (M) | Builds forces from SquadDef keys; new starter scenario |
| `src/sim/ai.ts` (M) | Commander v2: threat map, task groups, order-API-only |
| `src/campaign/campaign.ts` (M) | RosterEntry weapon-key migration only |
| `src/strategic/bridge.ts` (M) | `redMembers` weapon keys; `makeStrategicBattle` stays the battle builder |
| `src/strategic/save.ts` (M) | `LEGACY_WEAPONS` mapping in `loadGame` |
| `src/main.ts` (M) | Order-mode input state, right-click issue |
| `src/ui/hud.ts` (M) | Order buttons, context-action buttons, ammo readout |
| `src/ui/overlays.ts` (M) | Reason chips, danger preview |
| `src/render/renderer.ts` (M) | Emplacement drawing (follow `src/render/vehicles.ts` pattern), minimal |
| `tests/data.test.ts` (C) | Schema referential integrity |
| `tests/orders.test.ts` (C) | Executor + refusal behavior |
| `tests/emplacement.test.ts` (C) | Crewed weapon lifecycle |
| `tests/doctrine.test.ts` (C) | Headless balance/doctrine assertions |

## Dependency batches (for subagent execution)

- **Batch 1:** Task 1, Task 2 — data.ts only, sequential (same file), one agent.
- **Batch 2:** Task 3 → 4 → 5 — sim.ts chain, sequential, one agent (or one per task run back-to-back). Task 5 touches scenario/campaign too.
- **Batch 3:** Task 6 → 7 → 8 — orders system, sequential (orders.ts + sim.ts).
- **Batch 4:** Task 9 (emplacements) then Task 10 (vehicles) — both hook sim.ts; sequential.
- **Batch 5:** Task 11 (casualty chain) → Task 12 (AI v2).
- **Batch 6:** Task 13 (UI wiring) ∥ Task 14 (doctrine tests) — parallelizable (disjoint files).
- Pair each batch's builder with a fresh-context validator agent (global CLAUDE.md rule); validator runs check+tests and reviews the diff against the task text.

---

### Task 1: Ammo + national weapon data

**Files:** Modify: `src/sim/data.ts` · Create: `tests/data.test.ts`

**Interfaces (produced):**

```ts
export type AmmoKey = 'clip_3006' | 'mag_bar' | 'belt_3006' | 'belt_792' | 'clip_792'
  | 'mag_mp40' | 'mag_thompson' | 'rocket_bazooka' | 'rocket_schreck' | 'faust'
  | 'shell_60' | 'shell_81' | 'mag_carbine' | 'clip_springfield';

export interface WeaponDef {
  name: string;
  range: number;
  accuracy: number;
  damage: [number, number];
  cooldown: number;
  suppression: number;
  pen?: number;
  ammo: { type: AmmoKey; perUnit: number; reload: number }; // reload seconds
  heat?: { perShot: number; swapTime: number }; // belt-fed barrel model
  arc?: { minRange: number; scatter: number; scatterNoLos: number }; // mortars
  oneShot?: boolean; // consume item, revert to secondary
}
```

- [ ] Replace `WEAPONS` with national roster. Exact table (tune later via harness; these are the spec's relative relationships — Garand fast, K98 slow/accurate, MG42 suppression monster that heats 2× M1919):

```ts
export const WEAPONS = {
  garand:     { name: 'M1 Garand', range: 100, accuracy: 0.35, damage: [35, 80], cooldown: 1.6, suppression: 0.05, ammo: { type: 'clip_3006', perUnit: 8, reload: 2.5 } },
  carbine:    { name: 'M1 Carbine', range: 70, accuracy: 0.35, damage: [28, 65], cooldown: 1.4, suppression: 0.04, ammo: { type: 'mag_carbine', perUnit: 15, reload: 3 } },
  thompson:   { name: 'Thompson', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05, ammo: { type: 'mag_thompson', perUnit: 30, reload: 3.5 } },
  bar:        { name: 'BAR', range: 110, accuracy: 0.38, damage: [30, 70], cooldown: 1.2, suppression: 0.1, ammo: { type: 'mag_bar', perUnit: 20, reload: 4 } },
  m1919:      { name: 'M1919A4', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 2.4, suppression: 0.16, ammo: { type: 'belt_3006', perUnit: 250, reload: 8 }, heat: { perShot: 0.02, swapTime: 10 } },
  springfield:{ name: 'M1903A4', range: 200, accuracy: 0.55, damage: [40, 85], cooldown: 4, suppression: 0.04, ammo: { type: 'clip_springfield', perUnit: 5, reload: 4 } },
  kar98k:     { name: 'Kar98k', range: 110, accuracy: 0.38, damage: [40, 85], cooldown: 2.6, suppression: 0.05, ammo: { type: 'clip_792', perUnit: 5, reload: 3 } },
  kar98k_scoped:{ name: 'Kar98k (scoped)', range: 200, accuracy: 0.55, damage: [40, 85], cooldown: 4, suppression: 0.04, ammo: { type: 'clip_792', perUnit: 5, reload: 4 } },
  mp40:       { name: 'MP40', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05, ammo: { type: 'mag_mp40', perUnit: 32, reload: 3.5 } },
  mg42:       { name: 'MG42', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 1.8, suppression: 0.22, ammo: { type: 'belt_792', perUnit: 250, reload: 7 }, heat: { perShot: 0.04, swapTime: 8 } },
  bazooka:    { name: 'Bazooka', range: 70, accuracy: 0.35, damage: [30, 70], cooldown: 7, suppression: 0.1, pen: 100, ammo: { type: 'rocket_bazooka', perUnit: 1, reload: 7 } },
  schreck:    { name: 'Panzerschreck', range: 90, accuracy: 0.4, damage: [30, 70], cooldown: 8, suppression: 0.1, pen: 160, ammo: { type: 'rocket_schreck', perUnit: 1, reload: 8 } },
  panzerfaust:{ name: 'Panzerfaust', range: 35, accuracy: 0.5, damage: [30, 70], cooldown: 9, suppression: 0.1, pen: 150, ammo: { type: 'faust', perUnit: 1, reload: 0 }, oneShot: true },
  mortar60:   { name: 'M2 60mm', range: 180, accuracy: 0.5, damage: [25, 75], cooldown: 4, suppression: 0.12, ammo: { type: 'shell_60', perUnit: 1, reload: 4 }, arc: { minRange: 20, scatter: 4, scatterNoLos: 9 } },
  mortar81:   { name: 'GrW 34 8cm', range: 240, accuracy: 0.5, damage: [30, 85], cooldown: 6, suppression: 0.16, ammo: { type: 'shell_81', perUnit: 1, reload: 6 }, arc: { minRange: 30, scatter: 5, scatterNoLos: 10 } },
} satisfies Record<string, WeaponDef>;
export type WeaponKey = keyof typeof WEAPONS;
```

- [ ] Write `tests/data.test.ts`: every weapon's `ammo.type` is a valid AmmoKey (compile-time) plus runtime checks — `damage[0] <= damage[1]`, `cooldown > 0`, belt-fed (`perUnit >= 50`) implies `heat` present, `arc` implies `pen` absent. Run `npm test` — expect PASS.
- [ ] `npm run check` will FAIL at call sites using old keys (`'rifle'`, `'smg'`, `'mg'`). Fix now with side-mapped substitutes so the build stays green: in `scenario.ts` `squadMembers()` use `i === 0 ? (side === 'blue' ? 'thompson' : 'mp40') : i === 1 ? (side === 'blue' ? 'bar' : 'mg42') : i === 2 ? at : (side === 'blue' ? 'garand' : 'kar98k')` (full restructure lands in Task 5); in `src/strategic/bridge.ts` `redMembers()` → `'mp40'`/`'mg42'`/`'panzerfaust'`/`'kar98k'`; in `sim.ts` `addVehicle()` crew weapons → `'carbine'`/`'mp40'` by side; in `updateVehicle()` the hull-MG `fireSmallArms(…, 'mg', …)` literal → side-mapped `'m1919'`/`'mg42'`; in `campaign/campaign.ts` update the new-soldier literals (`newSoldier()` `weapon: 'rifle'` → `'garand'`; `newCampaign()` `'smg'` → `'thompson'`, `'mg'` → `'bar'`) AND map old keys in saved campaigns through a `LEGACY_WEAPONS: Record<string, WeaponKey>` table (`rifle→garand, smg→thompson, mg→bar`) applied to every `campaign.soldiers[*].weapon` in `loadGame` (`src/strategic/save.ts`, localStorage key `'ccg-save-v2'`) — the boundary where old saves enter; debrief/HUD read `WEAPONS[cs.weapon]` directly, so `fitRoster`-only mapping crashes them.
- [ ] `npm run check && npm test` — expect PASS. Commit.

### Task 2: Team/Squad/Load/Emplacement/Vehicle defs

**Files:** Modify: `src/sim/data.ts`, `tests/data.test.ts`

**Interfaces (produced — consumed by Tasks 5, 9, 10):**

```ts
export type Role = 'leader' | 'gunner' | 'assistant' | 'rifleman' | 'bearer' | 'driver' | 'sniper' | 'scout' | 'aidman';
export interface SoldierSlot {
  role: Role;
  weapon: WeaponKey;
  ammo: Partial<Record<AmmoKey, number>>; // discrete units carried
  carries?: LoadKey[];
}
export interface TeamDef { name: string; slots: SoldierSlot[] }
export interface SquadDef { name: string; side: 'us' | 'de'; teams: TeamKey[] }
export interface LoadDef { name: string; speedCap: number; staminaMult: number }
export interface EmplacementDef {
  name: string; weapon: WeaponKey;
  setupTime: number; packTime: number;
  loads: LoadKey[]; // empty = not man-packable
  wheeled?: { speed: number };
  towable?: boolean;
  minCrew: number;
}
export interface VehicleDef { /* existing fields plus: */
  ammo: { ap: number; he: number };
  turret: 'full' | number; // traverse degrees
  crew: SoldierSlot[];
  seats?: number;
  towHook?: boolean;
  openTop?: boolean;
}
```

- [ ] Add `LOADS`: `tripod_m1919 {speedCap 1.4, staminaMult 2}`, `lafette {1.2, 2.5}`, `mg_gun {1.6, 1.5}`, `mortar_tube {1.4, 2}`, `mortar_baseplate {1.4, 2}`, `ammo_cans {1.6, 1.5}`, `shell_load {1.6, 1.5}`.
- [ ] Add `TEAMS` + `SQUADS` implementing the spec §2 rosters exactly. US rifle squad = `us_able` (leader/thompson + gunner/bar + assistant/garand + 3 rifleman/garand) + `us_baker` (leader/garand + 5 rifleman/garand, one slot with `ammo: { clip_3006: 10 }` extra as grenadier stand-in — no grenades this milestone). German Gruppe = `de_mg_trupp` (gunner/mg42 with 2 `belt_792`, assistant/kar98k carrying 2 `belt_792` + `mg_gun` spare-barrel abstraction rides `heat.swapTime`, bearer/kar98k with 3 `belt_792`) + `de_schuetzen` (leader/mp40 + 5 rifleman/kar98k, two slots also carrying `faust: 1`). Weapons teams: `us_m1919_team` (5), `us_mortar60_team` (4), `us_bazooka_team` (2), `us_sniper_team` (2), German `de_smg42_team` (6), `de_mortar81_team` (5), `de_schreck_team` (2), `de_sniper_team` (2). Every crew slot's `carries` distributes that emplacement's loads. Ammo counts per slot: riflemen 8 clips, SMG 5 mags, BAR 8 mags, snipers 8 clips, mortar bearers 6 shells each, rocket teams 4 rockets on the loader.
- [ ] Add `EMPLACEMENTS`: `m1919_tripod { weapon: 'm1919', setup 30, pack 20, loads: [tripod_m1919, mg_gun, ammo_cans], minCrew 2 }`, `mg42_lafette { weapon: 'mg42', setup 30, pack 20, loads: [lafette, mg_gun, ammo_cans], minCrew 2 }`, `mortar60 { weapon: 'mortar60', setup 45, pack 30, loads: [mortar_tube, mortar_baseplate, shell_load], minCrew 2 }`, `mortar81 { weapon: 'mortar81', setup 60, pack 40, loads: [mortar_tube, mortar_baseplate, shell_load], minCrew 3 }`, `at57 { weapon: 'at57_gun', setup 60, pack 45, loads: [], wheeled: { speed: 1 }, towable: true, minCrew 3 }`, `pak40 { weapon: 'pak40_gun', setup 60, pack 45, loads: [], wheeled: { speed: 0.8 }, towable: true, minCrew 3 }` — add `at57_gun` (pen 110, range 140) and `pak40_gun` (pen 150, range 160) to WEAPONS with `ammo { type: 'shell_57'|'shell_75', perUnit: 1, reload: 5 }` (extend AmmoKey).
- [ ] Extend `VEHICLES`: sherman/panzer4 gain `ammo: { ap: 30, he: 40 }`, `turret: 'full'`, `crew` (3 slots: leader/carbine|mp40, gunner, driver). Add `stug3 { armor { front: 80, side: 30, rear: 30 }, gunPen: 135, turret: 12, speed: 4, crew: 3 slots mp40 }`, `m3_halftrack { armor { front: 15, side: 10, rear: 10 }, speed: 7, turret: 'full', mgRange 100, gunPen 0 …, crew: [driver/carbine, gunner/carbine], seats: 12, towHook: true, openTop: true }`, `sdkfz251 { similar, seats: 10 }`. Halftrack "gun" is the pintle MG: model as `gunPen 0, gunRange 0` + mg fields (vehicle update already falls back to MG when no gun target; guard HE fire on `def.ammo.he > 0` in Task 10).
- [ ] Extend `tests/data.test.ts`: every `SquadDef.teams` key exists in TEAMS; every slot weapon in WEAPONS; every `carries` load in LOADS; every emplacement weapon exists; per-squad slot-count sanity (us_rifle = 12, de_gruppe = 9); each squad's sides consistent. Run — expect PASS. Commit.

### Task 3: Soldier ammo, reload, heat, one-shot

**Files:** Modify: `src/sim/sim.ts`, `tests/sim.test.ts`

**Interfaces:** `Soldier` gains `ammo: Partial<Record<AmmoKey, number>>`, `magLeft: number`, `reloading: number` (seconds left, 0 = not), `heat: number`, `secondary?: WeaponKey`. `MemberInit` gains `ammo?`, `secondary?`. Snapshot gains `magLeft`, `reloading > 0`, `heat` (rounded), ammo unit total.

- [ ] In `addSquad`, initialize `magLeft: WEAPONS[m.weapon].ammo.perUnit`, `ammo: m.ammo ?? { [WEAPONS[m.weapon].ammo.type]: 6 }` (fallback for legacy callers), `heat: 0`, `reloading: 0`.
- [ ] In `fireSmallArms` change signature to take the shooter `Soldier` (not fx/fy/weapon) for infantry; keep a separate thin path for vehicle MGs (they get `magLeft: Infinity` semantics — no vehicle ammo until Task 10). On each shot: `s.magLeft--`. Heat: `if (w.heat) s.heat = Math.min(1.5, s.heat + w.heat.perShot)`.
- [ ] In `updateSoldier` before combat: tick `s.reloading -= DT` and return while `> 0`. Start reload when `magLeft === 0`: if `s.ammo[type] > 0` decrement, set `reloading = w.ammo.reload * assistFactor(s)`, `magLeft = perUnit` on completion; else weapon dry → if `w.oneShot && s.secondary` swap `s.weapon = s.secondary` (faust fired → rifle); else dry soldier: no fire (runner behavior arrives Task 8).
- [ ] Barrel heat: when `s.heat >= 1` force `reloading = w.heat.swapTime * assistFactor(s)`, reset `heat = 0` on completion. `assistFactor(s)`: 1 if a living, non-downed soldier with `role === 'assistant'` in same team within 3m, else 1.75. Roles arrive in Task 5 — until then implement `assistFactor` returning 1.75 with a `// Task 5 wires roles` note and a passing placeholder test asserting the factor for a lone gunner.
- [ ] Garand en-bloc: reload discards remainder (that's already the semantics — `magLeft` reset). Add `pendingPings: {x,y}[]` + `takePings()` event when a `clip_3006` weapon reloads from empty (renderer/audio hook later).
- [ ] Tests (`tests/sim.test.ts` additions): (a) rifleman fires 8 shots → `reloading > 0`, clip count decremented; (b) MG42 sustained fire reaches `heat >= 1` → long swap, suppression output gap measurable (no shots for swapTime); (c) faust soldier fires once at a vehicle → `weapon === secondary`; (d) determinism snapshot still stable across two runs of 500 ticks. Run — PASS. Commit.

### Task 4: Stamina

**Files:** Modify: `src/sim/sim.ts`, `tests/sim.test.ts`

- [ ] `Soldier` gains `stamina: number` (1 = rested). Drain in `advance()`: `s.stamina -= drainRate * DT` where drainRate = 0.004 walking, 0.02 sprinting (sprint flag arrives with orders — until Task 6, all movement is walking), × `max(load staminaMult)` when carrying loads (Task 9 wires loads; factor 1 until then). Recover +0.008/s when stationary and suppression < 0.3.
- [ ] Thresholds (research five-layer): `>0.6` rested, `0.3–0.6` winded (moveSpeed ×0.85, aimFactor ×0.92), `<0.3` fatigued (moveSpeed ×0.6, aimFactor ×0.8, cannot sprint). Implement inside `moveSpeed`/`aimFactor`. Add `stamina` to snapshot.
- [ ] Test: soldier ordered across the map arrives with lower stamina; stationary soldier recovers; fatigued aim < rested aim. Run — PASS. Commit.

### Task 5: Teams in the Sim + data-driven force building

**Files:** Modify: `src/sim/sim.ts`, `src/sim/scenario.ts`, `src/campaign/campaign.ts`, `tests/sim.test.ts`, `tests/campaign.test.ts`, `tests/vehicles.test.ts`

**Interfaces:** `Team { id, squadId, name, soldierIds }`; `Squad` gains `teamIds: number[]`; `Soldier` gains `teamId: number`, `role: Role`; new `Sim.addSquadFromDef(side: Side, key: SquadKey, x: number, y: number, roster?: MemberInit[][]) → Squad` (per-team member overrides for campaign wiring); `Sim.orderMove(teamId, …)` retargets **teams**; new `Sim.orderSquadMove(squadId, …)` broadcasts to member teams (offset destinations by team index × 8m). `addVehicle` builds crew from `def.crew` slots.

- [ ] Implement `addSquadFromDef`: for each TeamKey, spawn soldiers from slots (names from side pool via existing rng pattern; ammo from slot; `role` from slot; secondary for faust carriers = their `weapon` with faust as… faust carriers: slot weapon `kar98k`, plus `ammo.faust ≥ 1` — implement "has faust" as: when an enemy vehicle is in 35m and LOS, soldier with `ammo.faust > 0` fires faust ballistics (use WEAPONS.panzerfaust, decrement faust count) — replaces the old dedicated-AT-man branch in `updateSoldier` (sim.ts:695-711 keeps working for `pen` weapons like bazooka).
- [ ] Rework `addSquad` internals to create one implicit team per legacy call (keeps old tests/campaign compiling); `assistFactor` from Task 3 now checks real team roles.
- [ ] Rewrite `scenario.ts` force building on top of the mapgen MapPlan (positions from `plan.spawns.west/east` and `plan.objectives`, NOT hardcoded coords): `makeScenario` fields blue = 2× `us_rifle` + 1× `us_bazooka_team` + 1× `us_m1919_team` at west spawn, red = 2× `de_gruppe` + 1× `de_smg42_team` in `plan.buildings`/east woods, same vehicles (emplacement teams spawn as squads now; emplacement *objects* arrive in Task 9 — until then their crews fight as infantry).
- [ ] Campaign compatibility, NOT restructure: `makeStrategicBattle`/`redMembers` (`src/strategic/bridge.ts`) and `fitRoster` keep their 9-man legacy squads flowing through the implicit-team path in `addSquad` (+ `LEGACY_WEAPONS`). Vehicles keep spawning via `roadSpot` (campaign.test.ts invariant). Do NOT rebuild `campaign.ts` around the new TO&E — the strategic layer (M-C) replaces that module; `SQUAD_SIZE = 9` stays until then.
- [ ] Update `moraleShock`/steadying loops to iterate squad (unchanged — bonds stay squad-scoped per spec).
- [ ] Tests: US squad spawns 12 with 2 teams and correct weapons; Gruppe spawns 9, MG-Trupp has 3; `orderSquadMove` moves both teams; determinism holds. Run all suites — PASS. Commit.

### Task 6: Order vocabulary + team executor (move/fast/sneak)

**Files:** Create: `src/sim/orders.ts`, `tests/orders.test.ts` · Modify: `src/sim/sim.ts`

**Interfaces (produced):**

```ts
export type OrderKind = 'move' | 'fast' | 'sneak' | 'fire' | 'smoke' | 'defend' | 'ambush';
export interface TeamOrder { kind: OrderKind; x: number; y: number; arc?: [number, number]; targetId?: number }
export interface OrderState { // per team, lives on Team
  order: TeamOrder | null;
  phase: 'idle' | 'executing' | 'bounding_a' | 'bounding_b' | 'balked';
  reason: string; // legibility chip, '' when complying
}
export function dangerScore(sim: Sim, team: Team, dest: {x,y}): number; // 0..1+
export function compliance(sim: Sim, team: Team, danger: number): 'comply' | 'cautious' | 'balk';
```

- [ ] `Sim.orderTeam(teamId, order: TeamOrder)` — validates, runs compliance, stores OrderState, emits reason. `orderSquadMove` becomes `orderSquad(squadId, order)` broadcasting.
- [ ] `dangerScore`: sample 8 points along straight line to dest; sum per-point: open ground (terrain cover < 0.1) +0.05, known enemy with LOS to point within weapon range +0.15 (knowledge = enemies any team member currently has LOS to — the honest-vision primitive reused by Task 12), recent squad casualty (<30s) +0.2 flat. Deterministic, no RNG.
- [ ] `compliance`: threshold = 0.45 + leaderBonus (0.15 if leader alive in team) + avgMorale×0.3 + xpAvg×0.02 − (fatigued ? 0.1 : 0). danger < threshold → comply; < threshold+0.25 → cautious (downgrade fast→move, force bounding); else balk with reason string `"open ground under fire — suppress or smoke first"`.
- [ ] Executor in `sim.ts` per tick per team: `move` not-under-fire = current pathing (per-soldier offsets, existing `findSpot`); under effective fire (any member suppression > 0.35) = bounding: split team soldierIds into halves A/B; A moves 15m legs while B halts (fires if targets), alternate on leg completion. `fast`: sprint flag (BASE_SPEED×1.6, stamina drainRate 0.02, no firing while moving). `sneak`: speed ×0.35, spotting penalty stub (detectability model = target `path !== null` accuracy bonus in `fireSmallArms` — sneaking negates it), holds fire (no acquire) until fired upon (any member wounded → sneak breaks to move).
- [ ] Broken/pinned interactions unchanged (psychology overrides orders as today: sim.ts:316, :687).
- [ ] Tests: steady team in quiet map complies and bounds only under fire; team ordered across open ground covered by an MG42 balks with nonempty reason; cautious downgrade converts fast→move; sneak team doesn't acquire targets. Run — PASS. Commit.

### Task 7: fire/smoke/defend/ambush

**Files:** Modify: `src/sim/orders.ts`, `src/sim/sim.ts`, `tests/orders.test.ts`

- [ ] `fire`: sets team target point/unit; members with LOS engage (area fire = suppressAround at point when no visible target, costing ammo at cooldown rate — MGs' area suppression); ammo discipline: soldier stops area fire below 30% of starting units unless order is defend/ambush-triggered.
- [ ] `smoke`: add `SMOKE` terrain-less effect — `Sim.smoke: {x,y,ttl}[]`; LOS integration: each smoke puff within 1.5m of the LOS ray adds 0.5 opacity (modify `los` call sites via a wrapper `sightBetween(sim, …)` in sim.ts — do NOT touch map.ts los signature). Rifle team smoke: 2 puffs at point ≤30m, 60s ttl, consumes team smoke budget (2/battle); mortar smoke arrives with emplacements (Task 9).
- [ ] `defend`: position + facing arc `[from,to]` radians; members only acquire targets inside arc; +0.1 accuracy inside arc (registered); suppression decay ×1.2 while defending (settled in).
- [ ] `ambush`: defend + hold-fire until trigger — enemy within per-weapon threshold (`pen` weapons: 0.8×range; MG: 60m; else 40m) or team takes a casualty. On trigger: one-time first-volley aim bonus ×1.3, order converts to defend.
- [ ] Tests: MG area-fire suppresses without LOS targets at the point; smoke blocks a previously clear LOS; defend arc ignores flank targets until arc updated; ambush holds fire at 70m, opens at 40m with bonus. Run — PASS. Commit.

### Task 8: Ammo runner + pickup

**Files:** Modify: `src/sim/sim.ts`, `tests/sim.test.ts`

- [ ] Runner: every 60 ticks, an MG soldier with total belts ≤ 1 flags need; nearest same-squad soldier carrying that AmmoKey ≥ 2 and `rescueWillingness`-style check (`bond×1.2 + courage×0.5 − suppression×0.8 ≥ 0.6`) runs to gunner (reuse RescueTask pattern: new task kind `'ammo'` in a union — `task: RescueTask | AmmoTask | null`), transfers half his units, returns to prior position.
- [ ] Dropped kit: on `kill()`/downed, push `{x, y, weapon, ammo}` to `sim.droppedKit[]`. Pickup: idle soldier within 2m of kit whose weapon ranks higher (rank: mg42/bar/m1919 > smg > rifle > carbine) swaps (timed 3s via `reloading`), inherits remaining ammo. Same-side only.
- [ ] Tests: dry MG42 gets resupplied by bonded bearer; rifleman adjacent to dead BAR man upgrades. Determinism snapshot extended (kit list). Run — PASS. Commit.

### Task 9: Emplacements (crewed weapons)

**Files:** Create: `src/sim/emplacement.ts`, `tests/emplacement.test.ts` · Modify: `src/sim/sim.ts`, `src/sim/scenario.ts`, `src/render/renderer.ts` (draw a simple gun glyph — reuse the `src/render/vehicles.ts` drawing pattern at 40% scale)

**Interfaces:**

```ts
export interface Emplacement {
  id: number; side: Side; kind: EmplacementKey;
  x: number; y: number; facing: number;
  state: 'packed' | 'deploying' | 'deployed' | 'packing';
  timer: number;
  crewTeamId: number;
  loadsPresent: LoadKey[]; // must equal def.loads to deploy
  cooldown: number; heat: number; // shares weapon fire model
  towedBy: number; // vehicle id, -1
}
```

- [ ] `Sim.addEmplacement(side, kind, x, y)` spawns the matching crew squad (`us_m1919_team` etc. — add `crewOf` mapping table in data.ts task-locally: `EMPLACEMENT_CREW: Record<EmplacementKey, SquadKey>`), distributes `def.loads` onto crew slots' `carries`.
- [ ] Context actions on Sim: `orderDeploy(empId)`, `orderPack(empId)`, `orderWheel(empId, x, y)` (crew pushes at `wheeled.speed`), hitch/unhitch (`towedBy`, Task 10 moves it). Deploy requires all loads within 3m (carried or dropped there) + crew ≥ minCrew; runs `setupTime` timer.
- [ ] Fire loop (in `emplacement.ts`, called from `Sim.step`): deployed + crew ≥ 1 → fire `def.weapon` using the **gunner's** soldier ammo/aim (crew members within 3m); rate scales `crewPresent/minCrew` (served-weapon rule); direct weapons use `fireSmallArms`/`fireApAt`; `arc` weapons (mortars) fire at target point if `sightBetween` from ANY friendly soldier to point (shared vision), scatter = `arc.scatter` with own-crew LOS else `arc.scatterNoLos`, shells drop via `explode` after 3s flight; smoke shells (`orderSmoke` on mortar: 4-round screen, consumes shells).
- [ ] Loads while moving: crew soldier carrying loads gets `speedCap` and `staminaMult` applied (wires Task 4's factor). Casualty drops loads at position (`droppedKit` reuse with `load` field); any soldier ordered adjacent picks up.
- [ ] `makeScenario`: red gains 1× `mg42_lafette` deployed near `plan.objectives[0]` facing the west approach, blue gains 1× `mortar60` packed at the west spawn. Snapshot: emplacement state tuple.
- [ ] Tests: full lifecycle packed→deploying→deployed→fires; gunner killed → assistant continues at degraded rate (minCrew); tripod bearer killed en route → deploy blocked until load picked up; mortar hits shared-vision target with larger scatter when crew lacks LOS; smoke screen blocks LOS. Run — PASS. Commit.

### Task 10: Vehicles wave 1 — transports, towing, StuG

**Files:** Modify: `src/sim/sim.ts`, `src/sim/data.ts` (only if Task 2 numbers need holes patched), `src/sim/scenario.ts`, `tests/vehicles.test.ts`

- [ ] Data-driven crews: `addVehicle` builds crew from `def.crew` (Task 5 interface); vehicle main-gun ammo: decrement `ammo.ap`/`ammo.he` per shot, no fire when dry.
- [ ] Turret arc: `turret: number` (StuG) → main gun fires only when |bearing − hull facing| ≤ arc; otherwise vehicle rotates hull toward target at 30°/s before firing (add `v.turning` handling in `updateVehicle` before the fire block).
- [ ] Transport: `Vehicle` gains `passengerTeamIds: number[]`; `Sim.orderMount(teamId, vehicleId)` (team paths to vehicle, boards within 2m, soldiers get `inVehicle = v.id` but excluded from `crewIds` spall — passengers take spall only if `openTop` and arcing/explosion hits: in `explode()`, `openTop` passengers within suppRadius take fragment rolls at 0.5×), `orderDismount(vehicleId)` (soldiers placed via `findSpot` ring, 1 per 0.5s — dismount-under-fire runs compliance check from Task 6, balk = vehicle keeps its passengers). Pintle gunner (`role 'gunner'` in halftrack crew) fires vehicle MG; if `openTop`, he's targetable by small arms (in `acquireSoldierTarget`, include exposed gunners of open-top vehicles).
- [ ] Towing: `orderHitch(vehicleId, empId)` when `towHook` && `towable` && adjacent → emplacement `towedBy = v.id`, follows vehicle position; unhitch drops it at rear. Towed emplacement can't deploy.
- [ ] `makeScenario`: blue M3 carrying the mortar team from the west spawn, red adds a StuG near the east spawn facing west (positions from `plan.spawns`).
- [ ] Tests: squad mounts M3, rides 60m, dismounts in order; MG fire kills exposed pintle gunner but not hull-protected driver; AP shell into M3 wounds passengers heavily (openTop spall path); StuG cannot hit a flanking Sherman until hull rotates (assert no shot events while |bearing| > 12°); PaK towed, unhitched, deployed, kills a Sherman frontally at 120m… use at57 vs panzer4 side armor instead (pen 110 vs 85 front is marginal by design — pick the deterministic case). Run — PASS. Commit.

### Task 11: Casualty chain v2 + succession

**Files:** Modify: `src/sim/sim.ts`, `tests/sim.test.ts`

- [ ] Aidman: `role 'aidman'` → `AID_SECONDS / 3` when he performs aid; add one aidman slot to `us_rifle`/`de_gruppe` baker/schützen teams (data.ts edit).
- [ ] Two-man carry: if a second willing squadmate is within 5m when drag starts, both attach (`carriedBy` + `helperId`), speed = `moveSpeed × 0.8` instead of 0.45, both weapons slung (no firing).
- [ ] Succession: on gunner death/downed with weapon functional — nearest same-team `assistant` else `bearer` else any, not pinned/broken, within 8m: gets task kind `'takeOver'` (goto weapon position → 3s swap → inherits weapon + remaining ammo + role 'gunner'). Leader death: highest `xp` teammate becomes `role 'leader'` after 10s (compliance leaderBonus reads current roles — Task 6 already does).
- [ ] `crewSkill`: `Soldier.crewSkill: Partial<Record<'mg'|'mortar'|'gun'|'vehicle', number>>` (0..1); firing a class accrues +0.0005/shot; non-gunner on an MG applies `aimFactor × (0.7 + 0.3 × skill)` and heat perShot ×1.5. Persist through campaign: add field to `RosterEntry`, copy in `fitRoster`/battle-end harvest (campaign.ts:~roster update site).
- [ ] Tests: MG42 gunner killed → assistant on the gun within ~10s, worse aim; carry pair moves casualty faster than solo drag; aidman stabilizes 3× faster. Run all — PASS. Commit.

### Task 12: AI commander v2

**Files:** Modify: `src/sim/ai.ts`, `tests/doctrine.test.ts` (create) 

- [ ] Replace `RedCommander` internals (keep constructor config shape + `update(sim)` signature so `src/strategic/bridge.ts` wiring stands — `makeStrategicBattle` constructs `new RedCommander({ stance, posts })`): belief state `threat: { x, y, conf, tick }[]` built ONLY from red units' current LOS contacts (reuse `dangerScore`'s knowledge primitive — export a `visibleEnemies(sim, side)` helper from orders.ts) + decay (conf ×0.95 per eval when not re-sighted); briefing = `cfg.posts`.
- [ ] Task groups: partition squads at construction — MG/emplacement squads = base-of-fire, rifle squads = maneuver (2) + reserve (rest). Attack loop per eval: base-of-fire → `defend`/`fire` orders on positions with LOS toward next post; maneuver → bounded `move` on the flank axis (pick left/right by lower summed dangerScore); when threat conf at post < 0.3 or suppression established (base-of-fire firing ≥ 10s) → `fast` assault; reserve commits when a maneuver squad drops below 50%. Defend stance: posts get `ambush` (AT/MG) and `defend` arcs toward likely approach (nearest map edge held by enemy), reserve counterattacks any post with enemies (existing logic, now via `orderSquad`).
- [ ] Commander uses ONLY: `sim.orderSquad/orderTeam/orderVehicleMove/orderMount/orderDeploy/callBarrage` + `visibleEnemies` + own-side state. Add the honesty audit as a test: wrap sim in a Proxy in `tests/doctrine.test.ts` asserting no reads of blue soldier positions except through `visibleEnemies` (pragmatic version: assert commander module has no direct `soldiers.filter` over enemy side — code-review-level check documented in test comments, plus behavioral test below).
- [ ] Behavioral tests (doctrine.test.ts, headless, seeded): (a) aggression — attack-stance red gains ≥ 40m ground toward post by tick 6000 vs a passive blue; (b) ambush honesty — hidden blue MG (no LOS from red ever) is never targeted by red orders; (c) suppression-before-assault — red rifle squads receive `fast` only after red MG fire events near the post exceed threshold; (d) existing campaign battles still produce a winner within 20k ticks. Run — PASS. Commit.

### Task 13: UI wiring (minimal, legibility pillar)

**Files:** Modify: `src/main.ts`, `src/ui/hud.ts`, `src/ui/overlays.ts`, `src/ui/tooltip.ts`

- [ ] Order buttons (Hud callback pattern in `src/ui/hud.ts`; keydown handling in main.ts battle branch — note `Digit` keys currently select squads, so order keys need a mode or modifier): keys 1–7 select order kind for selected team/squad; right-click issues. Selected team shows OrderState: order kind + `reason` chip text drawn above the team (`drawOverlays` in `src/ui/overlays.ts`, existing world-anchored pattern). Balked teams flash the chip.
- [ ] Context-action buttons appear by selection (hud.ts): emplacement (deploy/pack/wheel/smoke for mortars), vehicle (mount/dismount/hitch/unhitch). Ammo readout in the soldier inspect rows (hud.ts) / tooltip panel: `magLeft + units`.
- [ ] Danger preview: while an order is pending placement, draw the 8 sample points of `dangerScore` colored green→red in `overlays.ts` (exported from orders.ts — the legibility contract from the spec).
- [ ] Manual verify in browser (`npm run dev`): issue each of the 7 orders; provoke a balk and read the reason chip; mount/dismount; deploy the mortar and fire smoke. Commit.

### Task 14: Doctrine/balance harness assertions

**Files:** Modify: `tests/doctrine.test.ts`

- [ ] Codify the spec's falsifiable claims as seeded headless tests (50-run loops, assert distribution direction, not exact values): (a) killing the MG-Trupp first drops Gruppe kill output by > 50% vs baseline; (b) US squad output degrades ≈ linearly with casualties (no > 35% cliff from any single loss); (c) MG42 total suppression delivered over 5 min < 1.5× M1919 despite 2× rate (heat rationing works); (d) refusal: assaults ordered without suppression balk ≥ 60% of the time at full MG coverage. Where a claim fails, file the number in the test as `.skip` with a `// TUNE:` comment rather than fudging the assertion — these tests are the tuning dashboard. Run — record results in commit message. Commit.

## Self-review checklist (executor: verify before calling done)

- Every spec §-reference above implemented or explicitly deferred with a comment.
- `npm run check && npm test` green after every task; snapshot determinism test extended, never weakened.
- No `Math.random`/`Date.now` anywhere in `src/sim/`.
- data.ts contains zero logic; sim contains zero literals that belong in defs.
