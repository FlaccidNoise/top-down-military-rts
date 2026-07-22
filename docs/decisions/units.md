# Unit System Decisions

### [APPROVED] Company TO&E + requisition attachments; casualty chain + role succession
**Date:** 2026-07-22
**Context:** Coherence pass stitching unit system ↔ strategic campaign surfaced five seams (chit schema, supply→ammo mapping, missing TO&E, resolver weights, role succession). Specs: [toe-attachments](../specs/2026-07-22-toe-attachments.md), [casualty-chain](../specs/2026-07-22-casualty-chain.md).
**Decision:**
1. Company core is fixed historical TO&E (US rifle co '44: 18 squads/~138 men — exactly the design target; German Grenadier co: 16 squads/~109, smaller + MG-heavier). Battalion assets (StuG/Sherman sections, PaK/57mm, halftrack lift, extra HMGs) attach per operation via requisition points; AI spends the same catalog. Free point-buy rejected.
2. Supply→ammo: full/low/out = 100/50/25% of def loadouts, scaled per-soldier so MG-belt distribution (ammo runners) survives scarcity. VehicleDef gains ap/he ammo counts.
3. CompanyChit schema superseded: chits carry SquadInstances (team structure), attachments, emplacements. Coarse-resolver weights derive from weapon defs; Outcome gains equipment results incl. gun capture.
4. Medicine: stabilize + drag only — buddy aid (slow, exposed), aidmen 3× faster, two-man carry, bond-gated rescue volunteering; no return-to-fight mid-battle. Unstabilized downed roll survival at battle end.
5. Role succession: team weapons belong to slots; automatic doctrine-driven chains (MG gunner→assistant→bearer; leader→ASL/senior) gated by morale; per-class crewSkill grown by use; replacements arrive as riflemen, crew slots fill from within the squad.
**Alternatives considered:** fully templated forces (no requisition loop); treat-and-return medicine (rejected: arcade vs capacity model); ordered-only succession (rejected: it's doctrine, not a decision).
---

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
