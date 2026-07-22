# Tactical AI Commander — 2026-07-22

Design only. The "AI must maneuver and counterattack" pillar (research amendment #3). Consumes the unit system, order-execution, and TO&E specs; the headless harness runs two of these against each other.

**Confirmed fork: honest vision + briefing.** The AI knows only what its units see, plus the pre-battle briefing (objectives, terrain, own deployment — exactly what the player gets). Contact reports build a decaying threat map. Scouting works against it; ambushes work on it; the balance harness measures real doctrine, not information cheats.

## The prime rule

**The AI plays through the player's order API.** Seven orders + context actions to teams/squads, nothing else — no hidden micro, no secret buffs. Consequences:

- AI behavior is testable in the headless harness with the same instrumentation as player orders.
- **Its troops refuse suicidal orders too.** The refusal model (order-execution spec) is the AI's doctrine teacher: an AI that orders an unsupported rush gets balked at, exactly like the player — so competent AI *must* suppress, smoke, and flank. Doctrine emerges from the constraint, not from scripts.

## Architecture

Two layers (platoons are roster groupings, not AI):

### Commander (per side)
- **Belief state**: threat map — grid of suspected enemy positions with confidence, fed by unit contacts, fire signatures (sound/tracer direction from units taking fire), and casualties; confidence decays over time. Plus the briefing (static).
- **Plan**: current scheme of maneuver, decomposed into **task groups** (2–4 squads + attachments assigned a role: base of fire / maneuver / reserve / screen).
- **Replan triggers only** (no per-tick flip-flop): contact where none expected, a task group combat-ineffective, objective lost/taken, phase timer expired, supply of a key weapon (MG belts, smoke) exhausted.

### Task-group execution
Each role is a small state machine issuing orders to its squads:
- **Base of fire**: MGs/StuG to positions scored by LOS to objective approaches + cover + range-band fit; `fire`/`defend` with arcs; displace forward when maneuver element wins ground.
- **Maneuver**: covered-route bounding (`move`) on the flank axis; `smoke` + `fast` across the last exposed gap once suppression is established (measured: threat map cells under sustained fire).
- **Reserve**: held out of contact; committed by commander on breakthrough or counterattack trigger.
- **Screen** (defense): sniper/scout teams forward on `sneak`, fall back on contact — feeds the threat map.

## Attack plan template

recon (screen forward to contact) → shape (base of fire set, mortars registered, smoke budgeted) → maneuver (flank axis chosen by covered-route scoring) → assault (suppression-gated — the refusal model enforces this) → consolidate (defend arcs on taken ground, crew weapons displace forward).

## Defense plan template

Engagement areas from terrain scoring: interlocking MG arcs + FPF lines, AT guns/StuG **keyholed** (narrow-arc positions covering approaches, hidden from wide observation), infantry on reverse slopes/interiors with `ambush`, reserve (1–2 squads + vehicle) counterattacks lost positions or overextended attackers. Counterattack aggression is the harness's headline metric.

## One danger model, three consumers

The commander's position/route scoring reuses the *same* danger/threat evaluation soldiers use for refusal and teams use for firing positions (order-execution spec). One implementation, tuned once:
- soldier: "do I balk?"
- team: "which rock do I shoot from?"
- commander: "which axis is the covered approach?"

## National flavor without doctrine code

No faction branches. The commander scores what its force is good at: a German force's plan gravitates to MG42 arc anchoring because its suppression mass lives there; a US force leans fire-superiority + mortar smoke because semi-auto DPS and 60mm ammo make those scores win. Composition (TO&E spec) drives doctrine — consistent with the no-doctrine-rules decision.

## Difficulty = skill, not sight

Locked out: intel cheats. Difficulty tunes commander quality: replan latency, plan-library breadth, coordination tightness (smoke-assault timing windows), requisition spending quality (TO&E spec budget), reserve commitment judgment. A dumb commander is late and clumsy, not blind or all-seeing.

## Harness metrics (extends the aggression mandate)

- **Aggression**: ground gained under fire, counterattacks launched, time-to-first-contact, reserve commitment rate.
- **Doctrine health**: assaults launched with suppression established (%), balk rate of AI-ordered actions (high = AI ordering stupidly), MG ammo spent per meter gained.
- **Honesty audit**: log every commander decision's input set; assert no reads outside belief state + briefing.
- 1000-battle commander-vs-commander runs calibrate both balance (unit spec claims) and the coarse resolver's outcome curves (campaign spec).
