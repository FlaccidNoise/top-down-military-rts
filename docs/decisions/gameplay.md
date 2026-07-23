# Gameplay & AI Decisions

### [APPROVED] Order execution (interpret + refuse) and tactical AI commander (honest vision)
**Date:** 2026-07-22
**Context:** The approved 7-order vocabulary had no behavioral design; the maneuver-AI pillar had no architecture. Specs: [order-execution](../specs/2026-07-22-order-execution.md), [ai-commander](../specs/2026-07-22-ai-commander.md).
**Decision:**
1. Orders are intent, not waypoints: steady troops interpret (auto-bounding under fire, cover micro, emergent formations) and can refuse suicidal orders before psychology breaks — comply / comply-cautious / balk ladder with mandatory UI reason chips (legibility pillar). Counterplay: suppress, smoke, sneak, leader presence.
2. Mount/dismount, deploy/pack, hitch/unhitch, aid/drag, pickup are context actions, not vocabulary; exposed ones run the same compliance check.
3. One shared danger/threat model, three consumers: soldier refusal, team firing-position choice, AI commander plan scoring. Tuned once.
4. AI commander plays through the player's order API only (no hidden micro, no cheats); honest vision + pre-battle briefing; decaying threat map from unit contacts. Its troops balk too — the refusal model forces doctrinal play (suppress before assault) without doctrine scripts. Two layers: commander (belief state, plan, replan-on-trigger) + task groups (base of fire / maneuver / reserve / screen).
5. Difficulty tunes commander skill (replan latency, coordination, spending), never information. Harness gains doctrine-health metrics (suppression-before-assault %, AI balk rate, honesty audit).
**Alternatives considered:** interpret-without-refusal (loses the CC signature); literal waypoint execution (wastes the per-soldier sim); omniscient commander (kills recon/ambush play and poisons resolver calibration); tunable-honesty dial (deferred: honest + optional dial later if difficulty demands).
---

### [APPROVED] Unified cover model: directional lip cover, cover/concealment split, deterministic sneak spotting
**Date:** 2026-07-23
**Context:** Cover grew piecemeal across M1–M5 — cover math in four places, omnidirectional (tile you stand in; windows the only directional case), concealment conflated with cover (opacity only gated binary LOS), and the sneak order had no detection layer (sneaking units always seen).
**Decision:**
1. One sight pipeline, three layers: `los()` computes directional cover = max(target-tile cover, lip cover, window 0.5); `sightBetween` adds smoke; `shotPreview` adds stance (pinned/downed +0.3, never reducing cover). All data-driven from `TerrainDef`.
2. **Lip cover** (`TerrainDef.coverBehind`, hedge 0.5): a shot crossing the terrain within 2m of the target grants that cover — the window rule generalized. Hugging a hedgerow bank (0.5) beats standing in the bushes (0.35) and only holds against shots crossing the hedge; flanking defeats it. Hedgerows stay 1-tile terrain, not edges.
3. **Concealment split**: `LosResult.conceal` = accumulated opacity + smoke (0..1; ≥1 still blocks — two-hedge rule unchanged). Cover stops bullets; concealment stops eyes.
4. **Spotting rule** (completes sneak, deterministic, no RNG): `sightToSoldier` = sightBetween + "sneaking target with conceal ≥ 0.5 is unseen beyond 20m". Every soldier-target sense routes through it (acquire, live fire, ambush trigger, `visibleEnemies` honest vision) so the danger model and AI commander inherit stealth; sight to a map point stays `sightBetween`. Previews surface it as reason `concealed` ("target concealed"), never a bare no-LOS.
5. **Positional summary** `sim.coverAt(x,y)` = max(tile cover, adjacent coverBehind); `inCover` = coverAt > 0.2 or interior floor — still the one definition shared by AI cover-seeking, danger scoring, and move-preview dots, now bocage-bank-aware.
**Alternatives considered:** converting hedgerows to edges (rejected: 1-tile-terrain is a logged mapgen decision; edges are for interiors); probabilistic detection rolls (rejected: RNG in vision breaks determinism and order-preview legibility); per-soldier stance system (deferred: pinned/downed hug-ground already covers the payoff at current scope).
---

### [APPROVED] Fog of war: sim-owned per-side spotting, last-known contacts, ambush concealment
**Date:** 2026-07-23
**Context:** The player was omniscient (renderer drew everything; tooltips probed anything; HUD printed the exact enemy headcount) while the red AI already played under honest vision. FoW makes the player's intel as honest as the AI's and turns the concealment layer into visible gameplay.
**Decision:**
1. The sim owns "what a side knows": `updateSpotting()` sweeps every 15 ticks (0.5 s) per side — a living un-downed friendly or alive vehicle within `SPOT_RANGE` 200 m with `sightToSoldier` LOS spots enemy soldiers (concealment-aware); `sightBetween` spots vehicles. Deterministic, no RNG, never read back by sim behavior. Two intel layers stay distinct: `visibleEnemies` = engagement/danger semantics (weapon-range), `spotted` = knowledge semantics (SPOT_RANGE); both look through `sightToSoldier`.
2. `spotted` maps carry the last-seen position; losing LOS converts it to a fading last-known contact (45 s TTL, dashed "?" marker). Statics — corpses, wrecks, emplacements — are permanent once seen (`seenStatic`), and finding one resolves its ghost.
3. **Ambush concealment**: the sneak spotting rule extends to untriggered `ambush` orders (stationary, holding fire, conceal ≥ 0.5, > 20 m). The trigger converts to defend, so the first volley reveals the position — the hidden-first-volley moment. This also removes ambushers from the enemy's danger model until they fire (honest: you can't balk at what you can't see).
4. UI consumes exactly three helpers — `soldierVisibleTo` / `vehicleVisibleTo` / `emplacementVisibleTo` — in the renderer, `pickAt`, and the HUD (GE count becomes "~spotted"); enemy unit-event pings gate on `sideSeesPoint`. `fowDisabled` (?fow=0 / `__game.setFow(false)`) is read only by the helpers, never by `step()`. Tracers/muzzle flashes render unfiltered — fire revealing itself IS the intel.
**Alternatives considered:** muzzle-flash "fire contacts" (rejected as structurally redundant: LOS is symmetric, so any shooter in weapon range is spotted at the next 0.5 s sweep — the renderer's existing muzzle-flash effect already gives the moment); render-side FoW (rejected: UI re-deriving vision violates the one-definition rule); tile shroud/explored-map (rejected: company-scale daytime maps — the ground is known, the enemy isn't); RNG detection rolls (rejected: determinism + legibility).
---

### [APPROVED] Melee close combat: proximity lock, strike cycles through the wound model
**Date:** 2026-07-23
**Context:** The sim had ranged combat only — assaults that closed to arm's length ended as point-blank rifle duels, and there was no cost to walking through an occupied room or over a broken defender.
**Decision:**
1. **Trigger — proximity, no new order.** An eligible soldier (alive, on foot, not downed/pinned/broken) within 2.0m of an enemy along a walkable tile chain (`canStep`: doors pass, walls and windows don't) locks both into melee automatically. Assaults, room clearing, hedge crossings, and overruns produce contact naturally; the victim of an engaged attacker fights back even if pinned. N-vs-1 allowed — extra attackers pile onto the same victim, who strikes back at whoever engaged him first.
2. **Lock.** Melee overrides tasks, ranged targeting, and movement; the only motion is closing to contact (0.9m) via wall-aware straight steps. Disengage only by outcome: opponent dead, downed, or gone past 2.5m. Breaking (morale < 0.25) is the one way out — a broken man drops the lock and flees, and a pursuer keeps striking while he's in strike reach (routs at contact get run down); once the runner opens the gap past strike range the pursuit breaks off and the rifle takes over (equal speeds would otherwise freeze the chase into a futile jog).
3. **Resolution — tick-based strike cycles, standard models.** `meleePhase` advances at a jittered tempo (~1.4s per strike, 0.5–0.9s first windup); a strike lands at phase wrap. Hit chance = weapon-class base × `aimFactor` (the one aim formula — pain, suppression, nerves, stamina, veterancy degrade melee exactly like ranged fire). Hits resolve through `wound()` (part roll, pain, bleed, morale shock, fatal check) — no parallel HP system. Misses suppress the target (+0.1); engaging spikes both +0.15; melee drains stamina (0.03/s).
4. **SMG position.** An SMG with rounds left fights melee by shooting from the hip: 0.7 base vs the bayonet's 0.55, weapon damage, consumes a round, emits a real ShotEvent (muzzle flash). SMGs dominate CQC by firing, not clubbing — their tradeoff is ammo. Dry SMGs club at 0.45; MG/AT/mortar hands are clumsy (0.35, [20,50]).
5. **Legibility.** New `MeleeEvent` queue (hit/kill fleck, miss swish, blood decal) mirrors ShotEvent's consume shape; `meleePhase`/`meleeId` are sim state, so the 4-frame melee pose (guard/windup/thrust/recover, fixed bayonet on rifles) freezes on pause like walk. Melee state is in `snapshot()` for determinism tests.
**Alternatives considered:** a charge order (rejected: order-vocabulary change for behavior adjacency already yields); strict 1-1 pairing (rejected: swarming attackers would idle); opposed-roll resolution (rejected: single roll per swing keeps aimFactor the shared, legible skill formula). **Open edges:** `pickFirer` can still serve an emplacement while its crewman is bayonet-fighting; broken men caught in melee die rather than surrender.
---
