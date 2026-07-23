# Visual Fidelity Pass — Implementation Plan (2026-07-23)

Direction: docs/decisions/architecture.md § "Muted Normandy, one sun". Findings: 2026-07-23-visual-fidelity-audit.md (S/T/B/V/E/M/U numbers below refer to it).

**Invariants for every task:** never touch `src/sim/`; render-side randomness = per-id/per-tile hashes or `Math.random` in bake/decal code only (never the sim RNG); sim-state overlays expire on `sim.tick`; expensive art in bakes, frame loop stays drawImage+transforms; `npm run check` + `npm test` green; screenshot-verify vs audit baseline at the staged scenes below; fps spot-check ≥ 100 at max engagement.

**Verification staging (worktree server `npm run dev -- --port 5199 --strictPort`, `?seed=7`, localStorage.clear()):**
battle via `__game.startEngagementBattle({attackerId:1, defenderId:4, cell:<red chit cell>})`. Scenes: village mid `cam(95,57)@12`, squad close `cam(10.5,39.3)@48`, field `cam(129,22)@20`, farm `cam(50,38)@13`, woods `cam(64,50)@24`, village roofs `cam(95,57)@8`, far LOD `cam(80,60)@3.5`. Vehicles: `sim.addVehicle('blue','sherman',20,56,0)` etc. Smoke: `sim.smoke.push({x,y,ttl:60})`. Explosions: `sim.callBarrage('blue',95,57)` + unpause. Poses: set `mental='pinned'` / `pain=1` on staged blues, `sim.step()` ×3. Clear stale tooltip before shots: dispatch mousemove to (5,5).

## Task 1 — light.ts + terrain rebake (T1-T8, B2-partial) [foundation, do first]
`src/render/light.ts` (new, ~20 ln): `SUN = {dx: 0.45, dy: 0.55}` normalized shadow direction, shadow alpha/soft-edge constants, `shadowOffset(len)` helper. Then terrain.ts:
- Palette swap to muted set (grass ~`#556340` base, road warm dirt, field wheat/turned-earth variants, woods floor `#3d4a33`).
- Grass: add 2nd octave (24–32m lattice) for patch/hue drift; kill visible 1m quantization (blend per-pixel-ish via two overlapping soft rects or finer lattice); more speckle variety.
- Hedge: neighbor-aware continuous mass — draw a capsule strip along the hedge line (check 4-neighbors for `hedge`), bulges from hash; SE drop shadow + base AO; distinct from woods (yellower green, denser).
- Road: shoulders on ALL four edges; twin wheel-rut darkening along road direction (infer from neighbors); dust-tan hue near shoulders.
- Field: per-parcel furrow phase+orientation from parcel hash (flood or 8m block hash); 2-3 crop hue variants; darker boundary strip where field meets non-field.
- Woods: litter/undergrowth texture on woods ground; canopies may overhang 1 tile (already overscan-safe, pad=2); two canopy greens by hash.
- Floor: plank rows 0.33m, two wood tones.
- Building base AO: darken 0.4m ground ring around building footprints (needs sim.buildings — pass to TerrainLayer or draw in roofs.drawShadows with light.ts).
- Renderer off-map: vignette-dark earth tone + 2px map border line instead of flat void (renderer.ts:90).

## Task 2 — soldier bake v2 (S1-S8) [after T1]
dudes.ts (+ renderer.ts soldier draw):
- Kit values: separate torso (light) / sleeves+trousers (dark) / helmet (darkest + rim highlight); US olive vs GE feldgrau at distinct values; skin warm.
- Faction silhouettes: US pot helmet (circle + brim ring) vs GE stahlhelm (ellipse + flared skirt); US pack / GE Y-straps+breadbag on torso; MG gunner belt hint.
- Contact shadow: ellipse under figure drawn in bake bottom layer (rotates with figure — correct, shadow direction from figure is ambient blob, acceptable) — soft `rgba(0,0,0,0.22)`.
- Halo → zoom-attenuated rim: bake-band-dependent alpha/width (band 6/12: current strength; 24: half; 48: thin outline only). Dead: no halo at all (replace with darker uniform, S6).
- Dead/downed read: deadKit darkens (not pale-greys); blood pool bigger + move final pool stamp into DecalLayer on death (persistent), keep dynamic pool while downed.
- Gait: leg swing + shoulder counter-sway (torso ellipse ±8° rotation) + weapon bob ×2 amplitude across the 6 frames.
- Kneel pose for `aim` when stationary-in-cover is NOT derivable render-side cheaply — instead: new `kneel` variant used when `suppression > 0.15 && targetId >= 0` (render-side state only). Poses+frames additions are pre-approved by the framework decision.
- One-ring rule: selection ring OR suppression ring, selection wins (renderer.ts:366-379).

## Task 3 — vehicle bake v2 (V1-V4) [after T1, parallel w/ T2]
vehicles.ts: per-kind silhouettes — sherman (rounded hull, 5 bogie dots, deck grates, star marking), panzer4 (boxy + schürzen hint, balkenkreuz), stug3 (low, no turret circle — casemate + gun forward), m3_halftrack (open bed w/ bench + 2-3 crew helmet dots, front wheels + rear tracks). Track links = dashed edge strips. Turret stays baked (sim has no traverse). Halo → rounded-rect rim matching soldier treatment; enemy box → thinner outline. Dead: burnt hull + ash + persistent smolder (reuse burning puffs at lower rate) + scorch under-decal on death.

## Task 4 — effects pass (E1-E6) [after T1; renderer.ts owner]
renderer.ts (+ decals.ts):
- **Smoke render (E1, biggest gap):** draw `sim.smoke` as 3-5 layered drifting puffs per entry (per-id hash offsets, slow rotation, alpha from ttl fade-in/out, grey w/ slight blue); expire with entry (sim-owned ttl — pause-safe).
- Explosion: 150ms fireball (radial hot gradient) + 8-12 dirt ejecta streaks (earth tones, gravity-less radial fade) + smoke column (3 rising puffs over ~2s) + existing ring kept but earth-toned; optional 2-frame 2px cam shake (skip if it fights pan).
- Muzzle flash: oriented 3-spike star along barrel dir + glow; MG flashes bigger + tracer line thicker/redder vs rifle thin/yellow.
- Tracer: moving short segment (t interpolated along line over 90ms) instead of full instant line.
- Impact: 3-particle dust puff at t.tx/t.ty on every tracer end (earth tone on ground); kill dot kept.
- decals.ts scorch → crater: smaller core, earth-tone rim ring, short ejecta streaks, less blur (E6).

## Task 5 — buildings/roofs (B1-B3) [after T1]
roofs.ts: two-slope shading from light.ts (lit NW slope, shaded SE), gable-end darker triangles at ridge ends, chimney block w/ SE shadow near ridge (hash-placed), per-building weather tint jitter, tile-course keep; shadow rect → offset by light.ts constants, soft edge (two nested alphas). terrain.ts window glass → muted `#7d8a8f`, door warmer.

## Task 6 — strategic map (M1-M2) [independent of T1-T5]
strategic.ts: paper-map background tone; per-cell terrain texture stipple from cell hash (woods = 3-5 tree dots, town = roof specks, river = flow dashes, bridge glyph); grid → hairline at low alpha, remove between same-owner cells; front line = 2px contested-boundary stroke where blue/red ownership meets; ownership tint softened; chits → small NATO-style boxes (side color fill, white sigil, strength bar under); objective = star + pulse kept.

## Task 7 — HUD/UI skin + feed fix (U1-U4) [last; re-sync main first — parallel session owns tooltip.ts/overlays.ts edits]
ui/ui.css + hud.ts: palette tokens matching art direction (paper/ink/amber); event pings → single right-edge feed column, newest on top, max 5, fade-out, no overlap (U1); world KIA labels stack-offset per position collision; order chips + casualty pips styled; stale tooltip cleared on canvas mouseleave (U3, touches tooltip.ts — small, do after merging latest main); boot camera → fit map (main.ts cam init).

## Execution
Dependency: T1 → {T2, T3, T5} (parallel, disjoint files) → T4 → T6 → T7. Builder + separate validator (fresh context) per task; validator re-runs staging recipe, compares against audit baseline screenshots, checks fps (>100 at 54 soldiers), tsc + vitest. Commit per task on `visual-fidelity-pass`; land on main via `git push . HEAD:main` (fast-forward only — on failure, merge main in and re-verify) at T1, after T2+T3+T5, and at the end.

## Outcome (2026-07-23, end of session)
All 7 tasks built, independently validated (fresh-context screenshot validators), and landed on main @ 5a166df. Perf at the new 247-soldier scale: 8.8ms/frame avg (~114fps). Known leftovers, none blocking:
- Hedge walls show slight per-tile capsule segmentation at 24 px/m (polish: extend strokes across tile boundaries).
- Worn-paths-to-doors / mud-near-roads ground detail (audit T7-finding) deferred.
- Event feed shows 6 entries vs the planned 5 (cosmetic).
- Boot-camera whole-map fit can leave the west-edge blue spawn under the roster panel on 320×240 maps (documented tradeoff; revisit if players complain).
- audit-03 baseline screenshot is mislabeled (contains a strategic frame) — auto-debrief fired mid-capture; wall-clock debrief trigger while paused is a known scripting hazard (see graphics-verify-workflow memory).

## Outcome 2 — seed sweep + tails fixes (2026-07-23, `visual-fidelity-pass`, branched from 329c987)
Everything above was validated on seed=7 only. Built `scripts/sweep.mjs` (Playwright): 8 fixed crops × 10 seeds (village/woods/hamlet/farm/bocage/units/enemy/far-LOD, + bridge on 2 water-forced seeds) against a pinned campaign via new `?camp=N` (pins the campaign seed AND disables saving so runs never clobber a real save). This is now the art regression gate — `.screenshots/sweep/index.html` contact sheet. Three fresh-context validators eyeballed the sweep. Fixed leftovers + tails defects:
- **Hedge segmentation (resolved).** `drawHedgeRun` strokes whole runs one layer at a time (AO→shadow→mass→rim) with smooth-noise (8m/28m) width+shade; foliage dabs restore lumpiness. Continuous banks across tile + field boundaries at 24 px/m.
- **T7 ground detail (done).** Worn dirt trails out from exterior building doors (post-pass, trails cross tiles); dusty grass verges along roads.
- **Water art (sweep-found).** The sim session's new river/bridge maps had hard tile-staircase banks and NO bridge (road forded water). Added plank bridge deck (curb rails, NW-lit tops) where road crosses water + bank post-pass (jittered mud fringe on land side, waterline, ripple dashes).
- **Woods floor grid (sweep-found).** Floor got grass's 2×2 sub-tile sampling (killed the 1m checkerboard); tree canopy-gap cull now only fires deep inside stands, so edge tiles keep their canopy instead of exposing dark floor squares against grass.
- **Feel-ceiling** (recoil/casings/death-pose/camera): NOT built — needs richer sim events. Design in docs/plans/2026-07-23-feel-events-design.md for the sim session (ShotEvent shooterId+weapon; deathCause/dir persisted on Soldier; camera shake is renderer-only).

Validator false-positives worth recording: (1) "buildings cast no ground shadow" — the overcast-soft shadow is real (~27% darkening at the wall base, measured) but doesn't read at thumbnail scale; per rule-2 design, not a bug. (2) "saturated red poppy/fruit dots at far-LOD" — those are the German garrison; the harness runs `?fow=0` so enemies render as red team dots. That same blind spot is why they couldn't test helmet coding — sprite crops only framed blue spawns. Fixed by adding the `enemy` crop (German feldgrau now regression-covered; distinct from US olive). Not landed on main yet — `visual-fidelity-pass` @ 366ee2d.
