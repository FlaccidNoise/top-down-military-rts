# Upgrade audit and plan — 2026-10-09

Owner ask: audit the game, then upgrade (not polish) battle graphics and effects so combat feels punchy, cinematic and real. Upgrade the strategic map (visuals, clarity, depth). Build a real tutorial, cut the text, and make the game understandable on landing, on mobile and desktop. Reference for feel: Defilade.

Audited tree: `main` at `8a90968`. Epic: jtbug #759.

## Status — 2026-10-10

All four lanes are on `main` at `4f59e33`. Not deployed. `HANDOFF.md` has the list of what landed.

- Balance is in band: blue attacking 6/8 fixed and 8/18 held-out, red attacking 6/16, war pin blue 4/16.
- Open owner decision, jtbug #797: calibrate auto-resolve to fought battles and rebalance red's strength, or leave the two apart. The measured calibration is in `docs/research/2026-10-09-upgrade-audit/coarse-calibration/` and is not applied.
- Of "Decisions needed" below: 1 and 2 were taken by the orchestrator (see `docs/decisions/INDEX.md`, 2026-10-10). 4 was taken as fog on, and reverts alone at 15eeb85. 3 and 5 are still open.
- "Not confirmed" below still stands in full. No human has played this tree.

## Sources

Five reports, each with `file:line` evidence and a list of what it could not confirm:

| Report | File | Evidence base |
|---|---|---|
| Battle FX | `docs/research/2026-10-09-upgrade-audit/fx-report.md` | 66 screenshots, live probes, whole-frame timing |
| Strategic layer | `.../strategic-report.md` | 46 screenshots, 16-seed headless wars, click and turn probes |
| Onboarding and HUD | `.../onboarding-report.md` | 103 screenshots, fresh-profile walks on 3 form factors, both gate legs |
| Tactical AI | `.../ai-report.md` | 38 battles through `makeStrategicBattle`, AI both sides |
| Defilade | `.../defilade-research.md` | Steam page, 2 developer videos, 55 trailer frames. Nobody outside a private playtest has played it. |

Screenshots and probe scripts are local only, in `.screenshots/audit-2026-10-09/` (git-ignored). The reports name them by file.

## What the reference game is

Defilade (RBGames, solo developer, Godot) is modern warfare, isometric 3D, base-building, and unreleased. Its viewers praise soldier behaviour more than graphics: cover by shape, pinning, order refusal, drag-rescue under covering fire, rare surrender, single shots when ammo runs low. Its HUD is nearly bare.

What transfers to strict plan view: layered explosions, smoke colour by cause, thick tracers, persistent scarring, long cast shadows, additive glow, a named-soldier feed, per-man roster status, optional intent bubbles, a ghost preview of cover spots, a slower pace. What does not: depth of field, oblique close-ups, vertical flame and smoke columns, skeletal animation.

The strict plan-view art rule stays in force.

## Findings

### Battle graphics and effects

The effects layer is well built and under-scaled.

1. Effects are drawn at true metric size while men are drawn 1.35x. At play zoom (14 px/m) a firefight is 4 px sparks and hairlines.
2. Every live explosion is the same ~1.3 m disc. The sim sends no blast radius, so size scaling works only in the test harness.
3. Nothing reacts: no recoil, no hit flinch, death is a pose swap, a turret never turns.
4. Nothing lingers and nothing lights: a blast is gone in 600 ms, fire is 3 to 5 dots, night is a flat tint.
5. No screen finish and no audio space.

The VFX gate has been blind since 2026-07-28: it stages under pause and the fx clock stops under pause, so it checks frame zero only (#780).

Frame budget is not the limit on desktop: worst heavy frame 8.2 ms of 16.7 ms. No real phone was measured.

### Strategic layer

Broken on `main`:

| Bug | Finding |
|---|---|
| #760 | Bridge queue deadlocks forces for 10 to 12 game days on pin seeds 12, 13, 16. A queued force rejects every order and the queue is saved. |
| #761 | Mouse clicks on Pause and speed do not land while the clock runs: 0 of 36 at 60x. The HUD rebuilds its DOM every game minute. |
| #762 | A march cannot be halted or reversed: 10 minutes out costs 155 minutes back. |

Clarity: objectives read well. Own forces are 16x10 px rectangles. There is no front line, no territory shading, no legend, no drawn supply, no night visual, and no desktop camera. The phone map uses a third of the screen. The legacy V1 grid has a legend, territory colour, lettered counters and a reinforcement countdown that V2 dropped.

Depth: the player has one real verb (march) and one real implicit choice (which captured objective to leave a company on). Massing two companies does nothing in a fought battle (code read). 7 to 10 of red's 9 to 12 forces never move. Red issued 34 attack orders in 16 wars. 66% of battles are bridge assaults. Supply, fatigue and night tempo are live and invisible, including the enemy's supply state.

### Onboarding, tutorial, text

The shipped tutorial teaches the theater by doing and stops teaching when the battle starts. Its one battle step retires the frame it shows and points at the manual.

| Measure | Desktop | Phone portrait |
|---|---|---|
| Inputs from landing to first battle order | 11 | 12 |
| Words on that path | 689 | 468 |
| Screens | 9 | 10 |

- The first battle is a live 143-man fight at 1x with no speed control. The gate's own bot lost it twice on seed 1636534801, so the tutorial gate's desktop leg is red on `main`.
- Phone portrait with the tutorial on: deployment opens with every control off screen (#783). The phone gate leg stops at the march step and never reaches a battle.
- Desktop clicks on roster order chips are dropped while the battle runs: 3 of 20 at a 120 ms press (#784).
- A V2 battle never shows its goal or win rule (#784).
- The briefing card is 163 words. The customize screen has 34 controls. The manual is 67 entries and 2,934 words.

### Tactical AI and emergent behaviour

The soldier layer is rich and mostly live: pinning, rout, melee, crawl to cover, rescue starts, weapon succession, leader promotion. Three defects mute it and much of it is silent on screen.

| Bug | Finding | Measured |
|---|---|---|
| #765 | Emplaced MGs spend a 250-round belt per burst | MG42 capped at 24 bursts per battle, M1919 at 4. 10 of 24 guns never fired |
| #763 | Commander re-issues unchanged orders every 5 s | Cancels 68% of its own side's rescues |
| #763 | Attacker reserve gets one order, then idles | 50 of 126 men |
| #764 | A refused ambush team never fires again | 12 mute team instances in 38 battles |
| #766 | Per-man `rallied` event cannot fire | 0 in 38 battles. Its test forces the input |

Near dead in play: grenades (10 thrown in 38 battles, Germans carry none), drag to cover (34 in 2,089 rescue starts), attackers going upstairs (2 of 36 battles), tank AP (0 shots), AI airstrike, AI team smoke, AI mount orders.

AI attack shape: blue AI wins 4 of 30, lead element median loss 60 of 60, attackers stand upright in 97% of samples. Half the garrison never fires and no defender squad leaves its post.

## Plan

Four lanes, each one builder on its own worktree, sequential commits, merged to `main` one lane at a time behind the standard gate (`npm run check && npm run test:quick`) plus the lane's own gates.

### Lane: strategic (#760, #761, #762, #782)

1. Deadlock, clock clicks, halt and turn-round. **Done on the lane branch**, gates green, war pin refrozen twice.
2. Planner cool-off after a repulse and withdraw hysteresis. Turn-round exposed both: AI blue was destroyed on 5 of 16 pin seeds, against 1 before.
3. Clarity: camera and boot framing, unit counters, order preview and arrows, territory wash and front line, visible events and night, contact as a map callout, legend and objectives strip, visible supply, phone pass, a theater screenshot gate.
4. Depth, after clarity lands and after an owner decision on order: postures (march, forced march, rest, dig in, screen), concentration that pays in fought battles, isolation as a weapon, requisition at the 2-day cycle (#133), fog on by default with a recon verb, a red that plays, tempo scoring, refit, crossings you can change.

### Lane: sim and AI (#763, #764, #765, #766)

1. Stop re-issuing unchanged orders. Reserve joins the attack. Armour follows the working objective.
2. Stationary orders skip the movement danger ladder.
3. `rallied` made reachable. Role integrity for gunners, aidmen and AT men.
4. Output-only events and ticker lines for five silent behaviours. Blast radius and kind, shooter and target ids, and kill direction sent to the renderer.
5. MG belts, last, so the balance effect is isolated.

A fixed probe set runs after each outcome-changing commit and gives a dashboard.

Held for an owner decision after the dashboard, because each moves balance: men go to ground when halted, grenades for both sides, drag under fire, armour and infantry cooperation, attacker mortar support, defenders that fall back and counterattack, rout toward own lines.

### Lane: battle FX (#780, #781)

0. Fix the VFX gate.
1. Minimum on-screen size for flashes, tracers and impacts. Battle read at whole-map zoom.
2. Blast recipes by size and kind, with shake and sound to match.
3. One flash per audio tap for automatic weapons.
4. Lingering battle pall, visibly thinner than sight-blocking smoke.
5. Fire that fills a footprint. A tank that burns under black smoke.
6. Night light through the grade.
7. Reaction: recoil, hit jerk, death slide, turret traverse, hull rock, exhaust, eased zoom and pan.
8. Blood and bodies, moderate gore.
9. HiDPI bake bands, casings, vignette and glow. The vignette re-baselines the art sweep once.

### Lane: onboarding and battle HUD (#783, #784, #785)

1. Defects: coach bubble layer, roster click loss, battle goal strip, battle speed, small copy and touch-target fixes.
2. HUD diet: one order bar with four primary orders, slim roster, key legend behind a `?` card, one-line tooltips, plain-language context chip, debrief summary first.
3. Drill battle: one platoon against one farmhouse, seven event-gated steps, replayable as Training.
4. Landing flow: Play goes straight to the drill. Three inputs and under 20 words to the first order. Customize moves behind "Custom operation".
5. Text cuts. Gate extended through a phone battle.

## Decisions taken, open to overrule

| Decision | Why |
|---|---|
| Strict plan view stays. Defilade's look is matched with 2D analogues. | Standing owner rule. The research found the parts viewers praise do not depend on 3D. |
| A scripted drill battle before the campaign. | The 2026-07-28 decision rejected a scripted staged first campaign. This is one battle against a defender that holds its position, gated on events, replayable. That rejection stands for campaigns. |
| MG belt bug is fixed although it strengthens defence. | It is a bug. The dashboard shows the cost. Attacker-side items move up if attack outcomes collapse. |
| Gore is moderate. | Hit puff and readable pools. No dismemberment. |
| Battle pall is cosmetic and thin. | Sim smoke blocks sight. The player must never confuse the two. |

## Decisions needed from the owner

1. Order of the strategic depth items once clarity lands.
2. Which of the held sim behaviours to build, after the dashboard.
3. Whether to stage a defender hull so tank-versus-tank can happen at all (`bridge.ts` stages a towed gun and no hull).
4. Fog of war on by default in presets. It changes the war (blue wins 8 of 16 against 4).
5. Balance baselines stay stale by the 2026-07-28 decision (#131). This wave moves balance again.

## Not confirmed anywhere in this audit

- Real-phone performance and layout. All phone evidence is desktop Chrome emulation.
- A human-played campaign reaching the bridge deadlock. It was measured with AI on both sides.
- The click-loss bugs outside headless Chrome.
- Audio by ear.
- Whether a human wins the first campaign battle. Bots only.
