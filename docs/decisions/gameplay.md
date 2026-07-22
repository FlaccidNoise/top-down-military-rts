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
