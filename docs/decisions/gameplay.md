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
