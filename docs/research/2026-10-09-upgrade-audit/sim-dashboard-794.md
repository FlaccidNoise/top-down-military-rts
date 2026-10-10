# Balance record, wave 2026-10 (#794, tracker #131)

Taken at `e6978e3`. Full runs: `scripts/.balance-wave-2026-10.json`.

| set | attacker | wins | defender wins | holds | attacker KIA | defender KIA |
|---|---|---|---|---|---|---|
| fixed | blue | 5/8 | 3 | 0 | 69.6 of 141.8 | 63.0 of 113.5 |
| heldOutA | blue | 4/9 | 5 | 0 | 69.0 of 143.0 | 59.6 of 115.0 |
| heldOutB | blue | 4/9 | 5 | 0 | 74.0 of 143.0 | 61.6 of 115.0 |
| redAttacking | red | 7/16 | 7 | 2 | 64.0 of 115.0 | 71.3 of 141.8 |
| redAttackingTheater | red | 4/16 | 12 | 0 | 74.2 of 124.5 | 65.8 of 141.8 |
| blueAttackingTheaterThin | blue | 16/16 | 0 | 0 | 10.1 of 143.0 | 29.5 of 50.5 |
| blueAttackingTheaterTown | blue | 15/16 | 1 | 0 | 40.0 of 143.0 | 50.4 of 80.4 |

Blue attacking, both held-out sets: **8 of 18** (band 6-12). Red attacking: **7 of 16** (band 5-11).

## Firing rates per battle

| behaviour | fixed | heldOutA | heldOutB | redAttacking | redAttackingTheater | blueAttackingTheaterThin | blueAttackingTheaterTown |
|---|---|---|---|---|---|---|---|
| defenderNeverFiredPct | 25.1 | 34.3 | 32.2 | 40.4 | 36.8 | 41.2 | 31.7 |
| defenderPostDriftMedianM | 7 | 5 | 5 | 6 | 5 | 6 | 7 |
| defenderFellBack | 4.62 | 4.11 | 4.0 | 4.81 | 5.75 | 1.94 | 4.75 |
| defenderCounterattacks | 0.38 | 0.33 | 0.22 | 1.0 | 0.94 | 0.0 | 0.12 |
| defenderArcsRelaid | 6.0 | 3.56 | 2.44 | 4.5 | 5.31 | 1.88 | 1.5 |
| grenadesThrownBothSides | 6.88 | 7.66 | 3.88 | 7.49 | 8.31 | 2.68 | 4.12 |
| surrenderedBothSides | 1.5 | 1.11 | 1.0 | 2.06 | 2.94 | 1.62 | 1.75 |
| attackerMortarHeShells | 20.0 | 19.89 | 18.22 | 13.12 | 7.94 | 22.94 | 17.56 |
| defenderMortarHeShells | 17.62 | 31.56 | 33.56 | 29.81 | 22.12 | 0.0 | 4.81 |
| defenderHeBurstsWithin10mOfALiveEnemyPct | 93.6 | 95.4 | 95.7 | 98.1 | 92.4 | 0 | 98.7 |
| attackerBarragesCalled | 1.5 | 1.67 | 2.0 | 1.81 | 1.94 | 1.44 | 1.19 |
| defenderBarragesCalled | 1.0 | 1.0 | 1.0 | 2.0 | 2.69 | 1.0 | 1.06 |
| attackerAirstrikesCalled | 0.25 | 0.56 | 0.22 | 0.0 | 0.0 | 0.88 | 0.25 |
| defenderAirstrikesCalled | 0.0 | 0.0 | 0.0 | 0.69 | 0.5 | 0.0 | 0.0 |
| attackerHullsLost | 2 of 12 | 1 of 18 | 1 of 18 | 6 of 36 | 6 of 36 | 1 of 32 | 9 of 32 |

## Why a defender never fires (share of all defenders)

| reason | fixed | heldOutA | heldOutB | redAttacking | redAttackingTheater | blueAttackingTheaterThin | blueAttackingTheaterTown |
|---|---|---|---|---|---|---|---|
| noLos | 12.3 | 19.3 | 18.2 | 23.1 | 22.4 | 12.6 | 15.1 |
| outBeforeAnyEnemyInRange | 4.2 | 4.2 | 4.9 | 5.3 | 2.4 | 12.4 | 3.2 |
| noEnemyEverInRange | 4.0 | 6.2 | 4.3 | 5.8 | 7.3 | 9.0 | 6.8 |
| task | 1.7 | 0.8 | 1.1 | 0.5 | 0.3 | 1.0 | 1.9 |
| crewOnGun | 1.4 | 1.3 | 1.7 | 1.4 | 1.4 | 0.6 | 1.0 |
| broken | 1.2 | 2.4 | 1.4 | 2.8 | 1.9 | 3.3 | 2.6 |
| melee | 0.2 | 0 | 0 | 0 | 0.0 | 0 | 0 |
| outsideArc | 0.1 | 0.2 | 0.7 | 0.1 | 0.3 | 2.2 | 1.0 |
| ambushHold | 0 | 0 | 0 | 1.5 | 0.8 | 0 | 0 |
| dry | 0 | 0 | 0 | 0.0 | 0 | 0 | 0 |
