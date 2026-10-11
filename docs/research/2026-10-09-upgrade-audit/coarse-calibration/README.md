# Coarse resolver against fought battles — measured 2026-10-10, refitted and APPLIED 2026-10-11

Date: 2026-10-10. Tree: `main` at `1e8efab`. Tracker: jtbug #796, decision in #797.

## Finding

"Auto-resolve" and "fight it yourself" are two different games at the same odds. The planner on both sides decides with the coarse one.

Measured by `scripts/coarsefit.mjs`: 240 fought battles through `makeTheaterBattle`, AI on both sides, 14:00, 25-minute cap. Blue attacking. Fought attacker wins of 6 at 1:1, 1.5:1, 2:1, 3:1, then the coarse win chance now and with the calibration.

| Class | Fought wins of 6 | Coarse now | Coarse calibrated |
|---|---|---|---|
| settlement | 0 3 6 6 | 12 17 22 30% | 16 51 77 94% |
| hamlet | 3 6 6 6 | 25 33 40 51% | 55 86 95 95% |
| forest | 0 3 3 5 | 40 51 58 67% | 7 28 55 86% |
| farmland | 0 4 5 6 | 51 61 67 76% | 21 57 81 95% |
| marsh | 3 6 6 6 | 51 61 67 76% | 60 89 95 95% |
| roadside | 3 6 6 6 | 51 61 67 76% | 66 91 95 95% |
| bridge-assault | 0 2 6 6 | 33 43 51 61% | 13 44 71 93% |
| ford-assault | 1 2 2 5 | 33 43 51 61% | 7 27 54 86% |

A fought battle is close to a threshold near 1.5:1. The coarse curve is far flatter.

Losses: fought, the winner loses a median 38% and the loser 76% in every class. Coarse now gives the winner 4% and the loser 65%.

## Why it is not applied

With the calibration applied, AI blue wins 15 of 16 wars (30 of 32), median war 5 days. Seven pairs of planner attack floors all gave 15 of 16. The lever is red's strength: at `redStrength` 3 blue wins 14 of 16, at 4 it wins 2 of 16 with AI blue destroyed on 8.

So applying it needs a rebalance of red's garrison and mobile strength bands. That is a campaign design decision.

## What the fit needs

- One steepness constant (4), which makes each class multiplier its break-even ratio: town 1.5 (was 7), village 0.95 (was 3), forest 1.9, farmland 1.4, marsh 0.9, roadside 0.85, bridge 1.6, ford 1.92.
- Winner's losses follow the loser's strength (about half as many men as the loser brought).
- Dig-in is worth about ×1.1 in a fought battle, against ×1.5 coarse.

## Related mismatch

A fought battle caps the attacker at about 130 men whatever its theater strength (`FIELD_BUDGET` in `src/strategic/bridge.ts`). The coarse game counts the full strength. Fielding massed forces needs timed arrivals in the sim.

## Files

- `calibration.patch` — removed. The refit below replaced it and is in `src`.
- `table-before-calibration.txt`, `table-after-calibration.txt` — coarse against fought, per class and ratio.

- `table-fought-after-staging-fix.txt` — the fought table re-run on `beabd6a`, after the #796 staging fix.

## After the staging fix (2026-10-10, `beabd6a`)

The German company table was fielded from its front, so any defender under 99 men had no mortar and fired no HE. It is now drawn platoon by platoon with its weapons. Fought wins of 6 at 1:1, 1.5:1, 2:1, 3:1, was → now:

| Class | Was | Now |
|---|---|---|
| settlement | 0 3 6 6 | 0 2 6 6 |
| hamlet | 3 6 6 6 | 3 6 6 6 |
| forest | 0 3 3 5 | 1 2 5 5 |
| farmland | 0 4 5 6 | 0 3 6 6 |
| marsh | 3 6 6 6 | 4 4 6 6 |
| roadside | 3 6 6 6 | 3 6 6 6 |
| bridge | 0 2 6 6 | 0 6 6 6 |
| ford | 1 2 2 5 | 1 1 4 5 |

The threshold near 1.5:1 stays. The winner's cost moved: settlement at 3:1 went from 29% to 42% lost. The calibration patch was fitted to the "was" column: refit before applying.

## Refit and applied (2026-10-11, owner decision on jtbug #797)

The owner played the wave and asked for a harder campaign with a red that attacks. The calibration went in with a rebalance of red.

Refit: 672 fought battles on `main` at `ba4cc08`, 12 a cell for blue attacking (it was 6), 6 a cell for red attacking at all four ratios, 6 a cell against a dug-in defender. Table: `table-refit-2026-10-11.txt`.

| Constant | 2026-10-10 patch | Applied |
|---|---|---|
| Steepness | 4 | 5 (best fit between 5 and 6. Log-likelihood -123 against -126 at 4 and -171 at 1) |
| settlement | 1.5 | 1.3 |
| hamlet | 0.95 | 0.85 |
| forest | 1.9 | 1.45 |
| farmland | 1.4 | 1.3 |
| marsh | 0.9 | 1.0 |
| roadside | 0.85 | 0.8 |
| bridge | 1.6 | 1.35 |
| ford | 1.92 | 1.8 (class 1.33 on the crossing 1.35) |
| Dig-in | 1.1 | 1.2 (best fit 1.18: 75 attacker wins of 95 became 64) |
| Winner's losses, per man the loser brought | 0.35 to 0.75 | 0.25 to 0.9 (measured p10 0.26, median 0.57, p90 1.03) |

What the refit showed that the first fit could not:

- A town is worth 1.3, not 1.5. At 1:1 blue took it 4 times in 12 (0 of 6 before).
- **Red attacking does not get its numbers.** At 1:1, 1.5:1, 2:1 and 3:1 in theater strength red won the same count in every class (town 0, 0, 0, 0 of 6. Road 4, 4, 4, 4). A red attacker fields about 130 men against a full company whatever it brings (`FIELD_BUDGET`). So the coarse game credits red's mass and a fought battle does not. The class multipliers fit red at 1:1. Above that the coarse game is kinder to red than a battle the player fights.

## Red after the calibration

With the calibration alone AI blue won 15 of 16 wars. Red's field force was the lever, not its garrisons and not its odds floors:

- Bigger garrisons balance the coarse war and break the fought one: one company cannot take a town held at 1:1.
- Bigger battlegroups (3 of 140 to 200) destroyed AI blue on 12 of 16 seeds.
- More battlegroups of about a company each gave a graded ladder. That is what shipped: 2, 3, 4 and 5 groups at enemy strength 1 to 4, garrisons unchanged above strength 1.
- A hold-to-win clock (blue must hold its objectives 6, 12 or 24 hours) was prototyped and dropped: it moved no outcome, the wins came half a day to three days later.

`scripts/warsweep2.mjs`, 32 seeds, AI both sides, after the calibration, the reinforce arm, the new table and red's spoiling attack:

| Preset | Enemy strength | Blue wins | Red attacks a day | AI blue destroyed |
|---|---|---|---|---|
| Skirmish (first campaign) | 1 | 88% | 0.47 | 1 of 32 |
| Normandy Bocage | 4 | 53% | 1.39 | 15 of 32 |
| River Line | 4 | 53% | 1.51 | 15 of 32 |
| Open Country | 4 | 81% | 1.65 | 6 of 32 |

At enemy strength 3 Normandy Bocage is 75%, 0.90 and 8, and River Line 63%, 1.20 and 12. At 2 Normandy Bocage is 91%, 0.66 and 2. Without the spoiling attack the strength-4 rows were 56%, 63%, 81% and 91% for Skirmish. Before this work Normandy Bocage ran at strength 2 with two battlegroups: 25% on the old math (AI blue ran out of days against towns worth x7), 0.45 attacks a day.

Every red win in these sweeps is AI blue destroyed. None is the deadline: blue either takes its objectives in about a week or loses its companies.

## The spoiling attack

Before it an idle player was never attacked: `scripts/firstcontact.mjs --pick none`, 12 seeds on Skirmish and on Normandy Bocage, no contact in a whole war. Red counterattacked on its own ground only.

From the second day red's hunt now crosses the line for a company within 240 march minutes of the hunters (`RED_V2.spoilMinutes`, `SPOIL_FROM_DAY`). The same sweep after it:

- Normandy Bocage: contact in 12 of 12 wars, every one on Day 2 near 05:30. Fought with the AI defending: blue held 7, lost 4, 1 undecided at the cap. A company that held lost a median 76 of 143.
- Skirmish: no contact in 12 of 12. Two battlegroups of 60 to 90 do not make the odds against a full company, so the first campaign stays quiet until the player moves.

Where the company stands decides it. Red attacking won 0 of 6 against a town, a forest or a bridge at even strength, and 3 of 5 against a village and 4 of 6 on a road.

To switch it off: `spoilMinutes: 0` in `RED_V2` (`src/strategic/planner.ts`), then refreeze the pin.

Not confirmed: any of it against a human. Every number here is AI against AI, and the player fights his battles where the AI's are rolled.
