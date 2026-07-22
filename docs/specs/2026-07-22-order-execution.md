# Order Execution & Soldier Micro-AI — 2026-07-22

Design only. Cashes out the approved order vocabulary (move/fast/sneak/fire/smoke/defend/ambush) into per-soldier behavior. Companion to 2026-07-22-unit-system.md (teams take orders) and 2026-07-22-ai-commander.md (AI issues the same orders).

**Confirmed fork: interpret + refuse.** Orders are intent, not waypoints — steady troops execute intelligently, and suicidal orders get refused *before* psychology breaks. Fully Close Combat. The cost is a legibility debt: every non-compliance must surface its reason in the UI or it reads as a bug.

## Behavior stack (per soldier, top preempts bottom)

1. **Reflexes** (always on): hit-the-dirt under sudden effective fire; face threats; return fire when weapon ready, target visible, and fire discipline allows; inherit suppression posture from the psychology ladder.
2. **Order task** (issued by team executor): the current order decomposed into per-soldier tasks.
3. **Opportunity micro**: firing-position choice within a small radius (cover-seeking), spacing (≥3m spread — no clumping), reload timing, context behavior (aid, pickup, succession — see casualty-chain spec).
4. **Idle micro**: scan facing, improve position.

The **team executor** is a per-team state machine translating one order into member tasks. Squad click broadcasts to teams (unit spec §1).

## Per-order execution

| Order | Not under fire | Under effective fire |
|---|---|---|
| **move** | cover-biased A* path (cover tiles/edges discount path cost), loose column/wedge, walking pace | **auto-bounding**: team splits into two elements; one suppresses (if targets visible), other rushes 10–20m cover-to-cover; alternate |
| **fast** | sprint, direct path, stamina burn | same — no bounding, no firing on the move. The "cross the beaten zone behind smoke" tool |
| **sneak** | crouch/crawl, heaviest cover bias, ~0.3× speed, reduced detectability, single file | holds fire until fired on; breaks contact rather than engage |
| **fire** | target point/unit/area; MGs take area suppression, riflemen take visible individuals; sustained | — (already firing) |
| **smoke** | throw grenades (~30m) or loft mortar smoke shells at point, then resume prior stance | same; throwing exposes briefly |
| **defend** | position + facing arc; soldiers pick/improve positions, MGs deploy on best arc lines; engage only inside arc at effective range; MG **FPF line**: pre-registered arc with accuracy bonus | holds ground per psychology ladder |
| **ambush** | defend + hold fire until trigger: per-weapon-class range threshold (faust ~30m, MG opening burst 50–100m, sniper = first shot at high-value target) or until spotted. **Opening volley bonus**: first shots aimed and rested | trigger fires |

Formations are emergent slot offsets chosen by the executor (column on roads/sneak, line when firing, wedge default) — never player-set.

**Context actions** (not vocabulary; shown situationally): mount/dismount, deploy/pack, hitch/unhitch, pick up load/weapon, aid/drag. All are timed and interruptible; the ones that expose soldiers (dismount into fire, pack the MG under fire) run the same compliance check as orders.

**Room clearing**: stack at the door edge, first man posts, team flows room-to-room using the edge-wall interiors. Fire discipline masks friendlies in the firing arc; fratricide stays *possible* (sim honesty) but rare.

## The refusal model

Runs when a team receives an order and at each bound/leg:

- **Danger score** for the ordered action, computed from what the *team knows*: fire density crossing the path, open-ground fraction, known enemy positions, recent casualties nearby. Deterministic, seeded.
- **Compliance threshold** from: leader present + leader quality, team morale state, bonds, experience, stamina.
- Outcome ladder:
  1. **Comply** — execute as ordered.
  2. **Comply-cautious** — auto-downgrade: fast→move, move→bounding even without fire, sneak legs lengthen. UI chip: "moving cautiously".
  3. **Balk** — refuse; hold in best local cover. UI chip with the *reason*: "Refuses: open ground under MG fire — suppress or smoke first."
  4. Rout/berserk stays owned by the existing psychology ladder — refusal is upstream of breaking, not a new mental state.
- **Counterplay is the game**: suppress the threat (danger drops), smoke the path, order sneak instead, move the leader up. Leader death raises refusal squad-wide — protect your NCOs.
- **Legibility contract** (pillar #4): the danger score itself is inspectable (hover the order preview → projected danger along path), so refusal is never a mystery die roll.

Same model, three consumers (coherence rule): soldier refusal, team firing-position choice, and the AI commander's plan risk assessment all read **one shared danger/threat evaluation** — see ai-commander spec. Tune once, everything moves together.

## Capability hooks honored

- **Stamina**: fast burns it; bounding rushes cost bursts; Fatigued teams auto-downgrade fast→move (a refusal-flavored effect with a stamina reason chip).
- **Ammo discipline**: soldiers cease area fire below ~30% ammo unless defend/ambush arc is triggered; MGs hold a final belt for FPF.
- **Loads**: teams carrying emplacement loads cap at walking pace and cannot fast/bound (unit spec §4).

## Failure modes to test (headless scenarios)

Bounding into a building edge; refusal deadlock (both elements balk — must resolve to hold, not oscillate); sneak pathing through contested interiors; smoke-then-fast timing window; ambush trigger vs sneaking enemy (detectability interaction); order spam (new order mid-bound must cleanly cancel tasks).
