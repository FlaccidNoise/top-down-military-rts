# Visual Fidelity Audit — 2026-07-23

Baseline screenshots in `.screenshots/` (worktree, gitignored), seed=7, map "Brückenwache Süd" (20,15).
Staging recipes: memory `graphics-verify-workflow.md`. All file:line refs @ 7c25eaa.

## Soldiers (dudes.ts, renderer.ts:257-380)

| # | Finding | Evidence | Root cause |
|---|---------|----------|------------|
| S1 | Figures read as featureless olive blobs even at 48 px/m — limbs/straps/helmet exist in the bake but never separate | audit-06 | Kit palette is 4 near-identical values: uniform `#6d7a4e`, sleeve `#5c6841`, trousers `#5f6a44`, helmet `#5a6644` (dudes.ts:33) |
| S2 | Team halo = filled ellipse under torso + prone stroke; heavy at all zooms, "everyone looks selected"; corpses keep a 0.35α halo | audit-06, audit-08 | dudes.ts:193-196, 142, 181; deadKit outline dudes.ts:51 |
| S3 | Soldiers float — no ground contact shadow | audit-06 | Nothing draws one |
| S4 | Walk gait invisible at ≤24 px/m; no shoulder sway or bob | audit-07 | Leg swing ±0.34m + gun angle ±0.06 only (dudes.ts:256-259) |
| S5 | No US/GE silhouette identity — same body, same helmet circle; hue difference too subtle (olive vs grey-green) | audit-06 vs garrison shots audit-23 | Single shared body drawing; KITS differ only in hue |
| S6 | Dead don't read: deadKit washes to pale grey ≈ ground value; blood pools small (r≤0.75m, 50% α) and lost against grass/scorch | audit-08 (9 corpses, no visible blood) | dudes.ts:43-53; renderer.ts:322-330 |
| S7 | Ring soup: team halo + amber selection ring + yellow suppression ring + gun-solution ring stack on one figure | audit-27 | renderer.ts:366-379 |
| S8 | No kneel pose; `aim` ≈ `idle` but straighter | audit-27 | dudes.ts pose set |

## Terrain (terrain.ts)

| # | Finding | Evidence | Root cause |
|---|---------|----------|------------|
| T1 | Grass = visible 1m square patchwork at ≥24 px/m; single hue, ±10% value only; 3 tiny speckles/tile | audit-06 | coarse() 8m bilinear + per-tile fillRect (terrain.ts:44-55) |
| T2 | Hedges = gappy green pompoms, blocky tile silhouette; doesn't read as continuous bocage wall; color ≈ woods | audit-05, audit-19 | 3 random circles per tile, no neighbor awareness, no shadow (terrain.ts:72-83) |
| T3 | Road shoulders only on N/S edges — E/W edges bare; no ruts/wear; staircase diagonals | audit-04 | terrain.ts:66-68 checks only y±1 |
| T4 | Fields: 2 fixed-phase furrow strips per tile = ruler lines; pale sickly hue; no per-parcel orientation/crop variation | audit-19, audit-22 | terrain.ts:84-89 |
| T5 | Woods ground is plain dark grass — no litter/undergrowth; canopy stops dead at tile edge | audit-21 | drawTree only on woods tiles; no ground texture pass |
| T6 | Interior "planks" are 1m-wide slabs | audit-21 | terrain.ts:91-97 row-height = 1 tile |
| T7 | No macro ground variation: dirt patches, worn paths to doors, mud near roads all absent | audit-04 | Only per-tile hash detail exists |
| T8 | Off-map = flat `#252b20` void, hard map edge; boot camera shows half dead space | audit-02 | renderer.ts:90; main.ts:183-185 boot cam |

## Buildings / roofs (roofs.ts)

| # | Finding | Evidence |
|---|---------|----------|
| B1 | Roofs = flat slab + one 0.14-white half; no gable-end read, no chimneys, no weathering variation | audit-22 |
| B2 | Building shadow = fixed axis rect offset (0.45,0.55); trees offset (0.18,0.22); soldiers none → no coherent sun | audit-20 |
| B3 | No ground AO at wall bases; window glass `#a8ccd8` too bright/cold | audit-21 |

## Vehicles (vehicles.ts)

| # | Finding | Evidence |
|---|---------|----------|
| V1 | Tanks = 3 rects + circle + line: no track links/bogies, engine deck, mantlet, markings; single hatch | audit-13 |
| V2 | All non-Sherman kinds share one generic hull; M3 halftrack drawn as a tank (no open bed/crew) | audit-12 |
| V3 | Enemy read = coral `strokeRect` box — selection styling louder than the art | audit-13 |
| V4 | Wreck = grey hull + scorch circle; reads as ink blot at close zoom | audit-15/16 |

## Effects (renderer.ts:432-489)

| # | Finding | Evidence |
|---|---------|----------|
| E1 | **`sim.smoke` is never rendered** — SMOKE order blocks LOS invisibly. Silent-failure violation | audit-23 (4 puffs staged, nothing drawn); no reference to sim.smoke in render/ |
| E2 | Explosion = 600ms ring + flash disc only: no fireball, dirt ejecta, smoke column, dust, shake | renderer.ts:471-488 |
| E3 | Tracer = full-length instant line 150ms; no projectile motion; MG == rifle visually | renderer.ts:432-462 |
| E4 | Muzzle flash = unoriented radial dot, 60ms | renderer.ts:443-456 |
| E5 | No impact feedback: no dust/sparks at bullet impact, no near-miss dirt kicks (only red kill dot) | renderer.ts:463-468 |
| E6 | Scorch decals: huge blurred charcoal starbursts dominate scene; no crater rim/earth tones | audit-08, audit-26; decals.ts:22-49 |

## Strategic map (strategic.ts)

| # | Finding | Evidence |
|---|---------|----------|
| M1 | Spreadsheet look: flat cell fills + 1px grid everywhere; ownership = flat tint slab; no front-line emphasis | audit-01 |
| M2 | No terrain texture language (woods/town cells = plain rects); chits = letter squares | audit-01 |

## HUD / UI (ui/hud.ts, screenshots)

| # | Finding | Evidence |
|---|---------|----------|
| U1 | Event ping labels stack/overlap into unreadable mess over squad panel; world KIA labels collide | audit-27 (left edge), audit-17 |
| U2 | Squad panel/chips/tooltips functional but styleless — flat black boxes, default-button chips | audit-11 |
| U3 | Stale terrain tooltip persists across mouse-off-canvas and photobombs (known gotcha, still unfixed) | audit-11, audit-17 |
| U4 | Debrief is the best-styled surface but sterile; win banner plain | audit-18 |

## Content gaps noted (sim scope — NOT this pass)
- No water/river/bridge terrain exists; "Brückenwache" battles have no bridge (TERRAIN keys: grass/road/hedge/field/floor/woods).
- Turret has no independent traverse in sim (facing only) — vehicle art keeps turret baked.

## Perf baseline
54 soldiers @ 120fps vsync-capped (memory, re-confirmed by feel — no jank at any zoom). All heavy art must stay in bakes (sprite cache / terrain chunks / decal canvas).
