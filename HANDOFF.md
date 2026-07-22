# Handoff — Mapgen v2 SHIPPED (2026-07-22)

## Status
Mapgen v2 (bocage believability + scale) is complete and merged to main
(e986b7f). 68 tests green, tsc clean. This worktree has no pending work.

## What shipped (commits 782d4a4, 7da0da6, b93862f, 5ed0fcd, e986b7f)
- `hedge` + `field` terrain keys (appended; hedge vehicle-blocking via canStep)
- Farm compounds (house+barn) with lanes; lane carve rejects building crossings
- Orchards (staggered woods tiles) + isolated-woods-tile-always-draws-tree art
- `placeCluster` refactor + second hamlet / third objective at w >= 240;
  160×120 fingerprints provably unchanged
- Browser-verified seeds 1/2/7 (.screenshots/v2-*), no art tuning needed
- Decision log updated (docs/decisions/INDEX.md mapgen v2 entry)

## For the next session
- Merge-back recipe changed: root checkout is on `m5-unit-system`, NOT main.
  Fast-forward main from a worktree via `git push . HEAD:main`
  (memory: design-sequencing-2026-07).
- M-A/M5 sessions have uncommitted edits to `src/sim/sim.ts` (+ possibly
  `src/ui/tooltip.ts`); this branch added small additive lines to both
  (findVehicleSpot hedge exclusion; TERRAIN_NAME hedge/field entries) —
  trivial merges, but they should expect them.
- Non-goals deferred by the v2 plan: M-B sector-carve parameterization (waits
  on M-B design; MapPlan is the integration point), rivers/bridges/elevation,
  stone-wall edge types.
