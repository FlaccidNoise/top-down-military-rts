# Unit System Decisions

### [APPROVED] Unit system: team command atom, national asymmetry, crewed weapons, transports
**Date:** 2026-07-22
**Context:** Brainstorm on squad archetypes, crewed weapons, vehicle roster, capability hooks, data schema. Full design: [docs/specs/2026-07-22-unit-system.md](../specs/2026-07-22-unit-system.md).
**Decision:**
1. Team (3–6 men) is the atomic command unit; squad = 1–3 teams sharing leader/bonds, squad click broadcasts orders. Vehicle crews and gun crews are single-team squads — one data shape.
2. National feel = composition + weapon scalars + signature mechanics (served-weapon degradation, belt-fed barrel heat, belt/mag/clip reload, one-shot fausts). No faction doctrine rules. US: 12-man symmetric-fireteam squads, Garands, AT in dedicated teams. German: 9-man Gruppe = MG42 team + rifle team, fausts distributed as ammunition.
3. Crewed weapons (M1919, sMG42, 60mm/8cm mortars, 57mm/PaK 40) pack into carried loads with setup/teardown timers; AT guns wheeled by crew or towed (`towHook`). Mortars fire indirect at any friendly-seen point, extra scatter without own LOS; no C2/radio sim.
4. Ammo = discrete magazines/belts/clips per soldier; reload is a sim event; MG ammo runners are bond-gated.
5. Vehicle roster wave 1 (new mechanics): M3 + SdKfz 251 halftracks (seats, mount/dismount, pintle gun, tow, open-top), StuG III (casemate, traverse-limited turret). Wave 2 (stat-only): M8, M5A1 Stuart, SdKfz 222, Puma.
6. All unit/weapon/emplacement/vehicle defs are pure data in data.ts (schema in spec §7); scenarios reference key lists (ForceDef).
**Alternatives considered:** Squad-atomic command (rejected: crews become special cases; loses fire-and-maneuver); doctrine-rule asymmetry (deferred: third balance system); static emplacements (rejected: defense-only texture); abstract ammo count (rejected: no reload moments to hang signature mechanics on); spotter/C2 indirect fire (deferred: whole radio system for one weapon class); engineers/flamethrowers (someday: new mechanics each).
---
