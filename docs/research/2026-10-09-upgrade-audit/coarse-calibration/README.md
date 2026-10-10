# Coarse resolver against fought battles — measured, NOT applied

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

- `calibration.patch` — the unapplied change.
- `table-before-calibration.txt`, `table-after-calibration.txt` — coarse against fought, per class and ratio.

The fought numbers were taken before any theater-staging fix from #796 item 1. Re-run `scripts/coarsefit.mjs` before applying.
