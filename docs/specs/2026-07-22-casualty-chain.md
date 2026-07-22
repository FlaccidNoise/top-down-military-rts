# Role Succession + Casualty Chain — 2026-07-22

Design only. The per-soldier sim's payoff layer: what happens when men go down. Fixes the role-succession gap between the unit system (slot/role data) and the campaign (replacements, healing, memorial).

**Confirmed fork: stabilize + drag.** Buddy aid stops bleeding; dedicated aidmen are 3× faster; two-man drag/carry moves casualties to cover; nobody returns to the fight mid-battle (a bandaged arm doesn't re-aim a rifle in 20 minutes).

## In-battle role succession

**The rule:** team weapons belong to slots, not men. When the holder goes down, the succession chain fills the slot.

- **Chains**: MG: gunner → assistant → ammo bearer → any teammate. Bazooka/Schreck: gunner → loader. Leader: SL → ASL (US) / senior-most by rank+xp (German). Emplacements: `minCrew` degradation already covers firing; succession reassigns roles within the crew. Vehicles: same rule over vehicle roles (gunner dead → commander mans the gun at a rate penalty; driver dead → anyone with vehicle crewSkill, badly).
- **Trigger**: holder down/dead + weapon functional + successor within reach + team not pinned/broken. **Automatic** — it's doctrine, not an order. Morale-gated: shaken hesitates (delay), pinned won't move to the weapon.
- The swap is a timed, exposed action (crawl to the gun, shoulder it). The MG42 going silent, then speaking again with a new voice, is the intended beat.
- **crewSkill** per soldier per weapon class (mg / mortar / gun / vehicle), grown by use across battles. A rifleman on the MG42 suffers accuracy and heat-discipline penalties (blows the barrel-swap timing); an assistant who's served three battles is qualified. Captured guns (TO&E spec) fire at the captor's crewSkill — usually badly.
- **Leader succession** degrades command: worse leader → higher refusal rates squad-wide (order-execution spec). Protecting NCOs is protecting obedience.
- **Weapon pickup** (own side): adjacent dropped weapon better than mine + not under direct fire → pick up (rifleman upgrades to BAR/MP40). Enemy-weapon pickup: someday — the AmmoKey model already supports it, deliberately unused for now.

## Casualty chain (battle → campaign)

```
hit → wounded (fights on, capacities reduced)
    → downed (pain shock / moving<15% / unconscious)          [existing thresholds]
        → bleeding out ──(aid)──> stabilized
    → battle end triage:
        KIA | died of wounds | hospital (campaign days) | walking wounded (returns, scarred)
    → roster/memorial events
```

- **Buddy aid**: any soldier, adjacent, ~15–20s kneeling over the casualty — exposed and shootable; that vulnerability is the drama. Stops bleeding, partial pain relief. **Aidman** role (US: 1/platoon; German Sanitäter: 1/platoon — in TO&E spec rosters): 3× faster, better triage outcome roll. Carries a carbine/pistol; no special protection rules (maybe someday).
- **Drag/carry**: one-man drag (slow, crouched) or two-man carry (walking pace, weapons slung). **Bond-gated volunteering**: high-bond soldiers attempt rescue under fire on their own — the approved rescue behavior gets its mechanics here; the player can also order it as a context action. Willingness runs the same danger/compliance check as orders (order-execution spec).
- **Bleed-out clock**: existing bleeding model; stabilization freezes it. Downed and unstabilized at battle end → survival roll against remaining blood/wounds. Harsh by design — it's what makes rescue worth dying for.
- **Triage** (battle end, campaign layer): stabilized men roll died-of-wounds by severity and how late aid came; survivors get hospital days = f(severity) (campaign healing rates); light wounds return as walking wounded. Permanent aftermath uses the existing body-part model (lost eye, fingers, limp). Psychological aftermath (acquired courage modifiers after trauma) — someday, one line, don't build yet.
- **Events feed the ledger**: who stabilized whom, who dragged whom out, who died carrying a casualty — bond growth events and memorial/veterans-ledger entries (campaign spec). Rescue is the bond system's compound-interest mechanism.

## Between battles: replacement fill (seam 5, campaign side)

- Replacements arrive via supply throttle (campaign spec) **as riflemen** — green, unbonded (existing rule).
- Slot fill is doctrine-automatic: crew slots filled from *within* the squad by best crewSkill (assistant promoted to gunner; the replacement becomes the new ammo bearer). The squad's MG42 never goes to the new guy while a qualified man lives. Player override in roster UI: someday.
- Team weapons persist with the squad (slot-owned): losing all twelve men loses the squad, not the BAR — equipment attrition is tracked at TO&E/Outcome level (TO&E spec).

## Sim cost note

Everything here rides existing systems: body parts + bleeding (built), psychology gates (built), bonds (built), context actions + danger checks (order-execution spec), crewSkill (one small number per soldier per class). No new subsystem — this spec is choreography, not machinery.
