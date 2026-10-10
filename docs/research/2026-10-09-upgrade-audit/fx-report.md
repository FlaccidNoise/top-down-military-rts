# Battle-view FX audit — graphics, effects, animation, audio

Tree: `main` @ 8a90968, clean before and after. Read-only: no source edit, no commit, no bug filed.
Dev server: my own on 5301, cwd confirmed as this repo by `lsof`, symbol check passed. Killed at the end.
Screenshots: `scratchpad/audit/fx/` (66 PNGs). Prefix `d-` desktop 1280x800 dpr 1, `m-` phone 390x844 dpr 3 (canvas clamps to dpr 2), `x-` repo `shot.mjs` presets.
Drivers I wrote (scratchpad only, thin wrappers over `scripts/lib/stage.mjs`): `audit/probe.mjs`, `audit/capture.mjs`, `audit/budget.mjs`, `audit/budget2.mjs`.

Marking: **[code]** = verified by reading code. **[shot]** = verified in a screenshot I opened. **[probe]** = verified by a value read from the running game. **[unverified]** = not confirmed, see section 5.

## 0. Headline

The effects layer is well engineered and under-scaled. The baked atlas, the hot/cool pass split, the ballistic debris and the roof damage are sound. The battle still reads flat for five reasons, in order of weight:

1. Every effect is drawn at true metric size while the men are drawn 1.35x. At the 14 px/m zoom where the game is played, a firefight is a few 4 px sparks and hairlines. [shot d-05, m-05]
2. Every explosion in live play is the same small orange disc. The sim never sends a blast radius, so the renderer's size scaling is dead code outside the test harness. [probe] [shot d-12]
3. Nothing reacts. Shooters do not recoil, victims do not flinch, death is a pose swap, a tank turret never turns. [code] [shot d-14]
4. Nothing lingers and nothing lights. A blast is gone in 600 ms, there is no battle smoke, and night is a flat tint that no flash cuts through. [shot d-11-boom-close-600ms, d-20, d-22]
5. No screen-level finish and no audio space: no vignette, bloom, eased camera, hit-stop, reverb, ambience or music. [code]

Frame cost is not the constraint on desktop: worst measured whole-frame draw under a heavy FX load is 8.2 ms of 16.7 ms. A real phone is unmeasured.

## 1. Inventory

### Effects

| Effect | Status | Where | Verdict |
|---|---|---|---|
| Muzzle flash | Exists | `src/render/renderer.ts:1892-1915`, specs `src/render/fx.ts:105-111` | Good shape (oriented core, asymmetric spikes, 5 weapon classes). Sized in metres: rifle r 0.3 m is ~4 px at 14 px/m. One flash per ShotEvent, so an MG42 burst shows one 70 ms flash pair while the audio plays 5 taps (`audio.ts:46`). [code] [shot d-05, x-29] |
| Tracers | Exists | bright head `renderer.ts:1845-1859`, thread `1634-1642` | 1-2 px lines, on 20-34% of rounds, fixed 90 ms travel at any range (`TRAVEL_MS`, `renderer.ts:186`). Near invisible at 14 px/m and below. [code] [shot d-05, d-07] |
| Bullet impacts by surface | Partial | `fx.ts:142-170` (`traceOvershoot`), `renderer.ts:1778-1822` | Three surfaces: masonry spall, foliage leaves, ground dust. Correct idea, 0.1-0.25 m puffs are sub-pixel at play zoom. No water, cobble, timber or armour response. [code] |
| Ricochets | Partial | `renderer.ts:1872-1886` | Sparks thrown back off hard cover. No deflected tracer, no sound. [code] |
| Shell casings | Missing | planned in `docs/plans/2026-07-23-feel-events-design.md` §1 | Not shipped. `grep casing` finds only an emplacement palette entry. [code] |
| Explosions (HE, grenade, mortar, AT, brew-up) | Exists, one look for all | `renderer.ts:1921-2036`, hot half `2040-2057` | Layer order is right. Size scaling is dead in live play (defect D1). Fireball is ~1.3 m radius against a 9 m frag radius: reads as a firecracker. [probe] [shot d-11-boom-close-110ms, d-12] |
| Shockwave and dust rings | Exists, not visible | `renderer.ts:1931-1949` | Tan ring at alpha 0.55 or less over tan and green ground. I could not see it in any frame. [shot d-11-boom-close-110ms] |
| Debris | Exists | `renderer.ts:1994-2018`, `fx.ts:63` | Ballistic chunks with ground shadows and landing grit. Best mechanism in the layer. Chunks are 0.1-0.18 m, so visible only at 24 px/m and up. [shot d-11-boom-close-110ms] |
| Smoke screens | Exists | `renderer.ts:810-848` | Sim-owned plume, drawn from the same function LOS uses. Reads as soft airbrushed blobs with no internal structure. Functional. [shot x-24] |
| Burning smoke | Exists | wreck: `renderer.ts:845`. Building: `972-984` | Wreck column is soot only in its lowest third, so it turns pale grey. The code comment promises a black column. [shot d-15-brewup-25s] |
| Fire | Exists, weak | `renderer.ts:935-1012`, hot `1016-1039` | 2-6 licks of 0.84 m or less. Reads as 3-5 orange dots at every zoom, invisible on the whole map. [shot d-16, d-17, d-18, d-23, m-16] |
| Blood and wound feedback | Partial | pool `decals.ts:140`, `renderer.ts:1363-1376`. Smear `1356-1360`. Melee fleck `1571-1578` | Pool at death, pool under a downed man, drag smear. No spray or puff at a bullet hit. Pools are low-contrast brown at 8 px/m decal resolution. [code] [shot d-09, d-10, m-09] |
| Corpses | Partial | `renderer.ts:1303-1306`, `dudes.ts:989-997` | Three static poses picked by id hash. No fall, no cause-keyed pose (`deathCause` was designed, not shipped). Greyed kit reads as a mannequin. [code] [shot d-06, d-09] |
| Wrecks | Exists | `vehicles.ts:470-472`, `1023-1029` | Dedicated dead bake: turret jolt, blown hatch, ash. Good. [code] [shot d-15-brewup-25s, partly hidden by smoke] |
| Persistent decals and scarring | Exists | `decals.ts:8` (8 px/m layer), `marks.ts:15` (640 pock cap) | Scorch, grit, track ruts, blood, old craters, pockmarks. Blurs above ~16 px/m: grit reads as ink blots. Craters have no depth. [shot d-11-boom-close-600ms, m-12] |
| Building damage | Exists | roof holes `roofs.ts:106`, `1370-1449`. Breaches `renderer.ts:360-381` | Roof hole with exposed rafters and slipped tiles is the best destruction art in the game. Cap 3 holes. No wall scorch, no collapse stage. When roofs fade at close zoom the hole read is lost. [shot m-16, d-16] |
| Airstrike plane | Exists, toy | `renderer.ts:1228-1249` | Three `fillRect`s and an ellipse shadow. Strafe impacts are generic booms (`sim.ts:2223`). [code] [unverified by screenshot] |
| Melee FX | Exists | `renderer.ts:1569-1587` | Red disc on hit, white arc on miss. [code] [unverified by screenshot] |

### Soldier animation

| Item | Status | Where | Verdict |
|---|---|---|---|
| Frame counts | — | `dudes.ts:30-32` | walk 6, crawl 4, melee 4. All 15 other poses are 1 frame. [code] |
| Walk / run / crawl | Walk and crawl exist. Run missing | `dudes.ts:972-979`, `renderer.ts:1316-1330` | No distinct run pose or cadence for fast and assault moves. [code] |
| Firing recoil | Missing | `dudes.ts:966` | `aim` is one static frame. Nothing moves when a man fires. [code] |
| Reload | Partial | `renderer.ts:1331` | One static frame, band 24 and up only. [code] |
| Hit reaction | Missing | — | No flinch, stagger or knock-down. [code] |
| Death variety | Partial | `renderer.ts:1303-1306` | 3 poses, instant swap. [code] |
| Carry / drag / aid | Exists | `renderer.ts:1268-1281`, poses `drag`, `dragged`, `aid` | Works, with blood smear trail. [code] |
| Sprites at rest | Exists | `dudes.ts` | Readable helmet and weapon at 32 px/m and up. A squad is a row of identical figures in one pose. [shot d-03, x-27] |

### Vehicle animation

| Item | Status | Where | Verdict |
|---|---|---|---|
| Sprites | Exists | `vehicles.ts` | Strongest art in the game: hatches, markings, stowage. [shot x-25] |
| Track motion | Exists | `renderer.ts:1141` | 3 baked phases off the odometer. [code] |
| Turret traverse | Missing in sim and render | `sim.ts:2672`, `vehicles.ts:590`, `719` | A full-turret tank fires on any bearing at once. The barrel is baked pointing forward. [code] [shot d-14] |
| Gun recoil, hull rock | Missing | — | [code] |
| Exhaust | Missing | — | [code] |
| Dust trail | Exists, not visible | `renderer.ts:1144-1153` | Probe showed 6 live puffs after 10 m of driving. None readable on grass. [probe] [shot d-13, m-13] |
| Track ruts | Exists, faint | `decals.ts:123` | Alpha 0.3 at 8 px/m. [shot d-13] |

### Lighting and atmosphere

| Item | Status | Where | Verdict |
|---|---|---|---|
| Sun and cast shadows | Exists | `light.ts`, `renderer.ts:648-731` | Swept shadows, moving sun. Strong. [shot d-03, d-04] |
| Night | Exists, flat | `renderer.ts:621-626` | One full-viewport tint. Off-map is tinted too. Everything lands at one value. [shot d-19, m-19] |
| Muzzle and explosion light on terrain | Missing | — | Additive sprite blits only. No flash lifts the ground or the shooter. [shot d-20, d-21, d-22] |
| Fire glow | Partial | `renderer.ts:1025` | 3.2 m pool at alpha 0.09. Not perceptible, day or night. [shot d-23] |
| Lit windows, lamps | Missing | — | [code] |
| Weather | Missing | — | [code] |
| Haze, dust motes | Exists | `renderer.ts:855-899` | Five drifting bands under 22 px/m, motes above 20 px/m. Subtle and well judged. [code] |
| Wind on vegetation | Missing | `canopy.ts` | Canopies are fully baked. [code] |
| Ambient life | Partial | birds `renderer.ts:387-451`, chimney smoke `roofs.ts:2397` | Birds flush off blasts near woods. Chimney wisps read as pale discs at 24 px/m and up. [shot d-04, d-16] |
| Water | Static | `terrain.ts:1000-1004` | [code] [unverified by screenshot] |

### Screen level

| Item | Status | Where | Verdict |
|---|---|---|---|
| Vignette | Missing | — | [code] |
| Colour grade | Time-of-day tint only | `renderer.ts:621-626` | [code] |
| Bloom / glow | Missing | — | `lighter` blits only. [code] |
| Camera shake | Exists | `renderer.ts:769-791` | Stateless, 7 px max. Every blast shakes alike because no blast carries a size. [code] |
| Hit-stop | Missing | — | [code] |
| Zoom / pan easing | Missing | `main.ts:1623-1630`, `1796-1806` | Wheel zoom applies in one step. WASD pan is constant speed with no inertia. [code] |
| Cinematic camera | Missing | — | No event focus, follow or kill-cam. [code] |

### Audio (code read only, not listened to)

| Item | Status | Where | Verdict |
|---|---|---|---|
| Weapon voices | Exists | `audio.ts:36-49`, `199-272` | Per-weapon synth with burst taps, bolt clack, body thump. Best-developed feel system. [code] |
| Explosions | Exists, one voice | `audio.ts:297-307` | Three layers. Takes `{x, y}` only: a grenade and a barrage round sound the same. [code] |
| Distance | Partial | `audio.ts:114-132` | Screen-space gain and pan. No low-pass with distance, no delay. [code] |
| Occlusion, reverb | Missing | — | Dry signal into a compressor. [code] |
| Ambience, music | Missing | — | [code] |
| UI sounds | Partial | `audio.ts:340-361` | Unit-event blips only. No select, order-ack or click. [code] |
| Engines, incoming whistle, aircraft, voices | Missing | — | [code] |

## 2. Why it reads flat or toy-like

1. **The violence is smaller than the UI.** Men are oversized 1.35x (`dudes.ts:34`). Flashes, tracers and impacts are not. In `d-05-fight-squad.png` (6 fresh shots in frame) the loudest marks are the amber suppression rings and the red KIA text. `m-05-fight-squad.png` shows the same on phone.
2. **One explosion, and it is small.** `d-11-boom-close-110ms.png`: a 100 px disc at 40 px/m for a round with a 9 m frag radius. `d-11-boom-squad-110ms.png`: 30 px. `d-11-boom-wholemap-110ms.png`: 3 px. `d-12-grenade-left-vs-mortar-right-140ms.png`: grenade and mortar parameters through `sim.explode()` are the same size.
3. **A blast leaves nothing in the air.** `d-11-boom-close-600ms.png`: one soot smudge and ink dots. No dust hangs, so a shelled field looks like a clean field with spots on it.
4. **The tank kill is the weakest set piece.** `d-15-brewup-120ms.png` is the same fireball as a mortar round. `d-15-brewup-4s.png` is four dots. `d-15-brewup-25s.png` is a pale grey cloud.
5. **Fire is dots.** `d-16-fire-building-close.png`: five glows on a floor. `d-17-fire-building-squad.png`: three pixels on a roof. `d-18-fire-building-wholemap.png`: nothing.
6. **Night has no light in it.** `d-19-night-static-squad.png` is a flat blue-grey plate. In `d-20-night-fight-squad.png` and `d-22-night-boom-110ms.png` no flash lights the ground, a wall or the man firing. `d-23-night-fire-building.png`: a burning house lights nothing beside it.
7. **Nothing reacts.** `d-14-vehicle-firing.png`: the Sherman fires with no rock and no recoil. No screenshot can show the missing soldier recoil and flinch. The code confirms both.
8. **The whole-map view carries no battle.** `d-07-fight-wholemap.png` and `m-07-fight-wholemap.png`: a live fight with a blast in frame shows one hairline and some rings.
9. **Casualties are low contrast.** `d-09-aftermath-close.png`, `d-10-aftermath-squad.png`: grey bodies, brown pools near ground value.
10. **Soft on HiDPI.** `m-03-static-close.png`, `m-08-fight-squad-hud.png`: sprites and roofs are upscaled 2x because bake bands ignore dpr (defect D4).
11. **Ambient artefacts break the plate.** Pale chimney discs in `d-04-static-town-24.png` and `d-16`. Blocky pale ground patches in `d-13-vehicle-moving.png`, `d-14`, `m-14`. A visible 1 m grass repeat in `m-13-vehicle-moving.png`.
12. **No finish.** Flat off-map void in `d-02-static-squad.png`. No vignette or glow in any frame.

## 3. Defects found

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| HIGH | src/sim/sim.ts:2348 (also 2746, 2105) | `explode()` and `destroyVehicle()` push `{x, y}` with no radius. `Renderer.boomScale(b.r)` (`renderer.ts:86-88`) then returns 1 for every blast. Probe: three sim-emitted booms all had `r === undefined`. The harness passes `r` by hand (`shot.mjs` grenade and barrage effects), so the gate shows scaling the game never does. | Push `{x, y, r: p.fragRadius, kind}`. Widen `takeBooms()`'s return type. Output-only field. |
| HIGH | scripts/lib/stage.mjs:543 with src/main.ts:1795 | `burst()` stages under pause. `fxNow` has not advanced under pause since 96e5861 (2026-07-28), so a staged transient never ages. Probe: a boom was still live 3200 ms after staging (life is 2600 ms). `shot.mjs --effect boom` and `--effect mg` both report "best frame 0ms". `vfx.mjs` uses the same `burst()`, so the VFX gate sees only the age-0 frame. | Give `__game` a hook that runs the fx clock while the sim stays paused, and have `burst()` use it. Do this before any FX work. |
| MEDIUM | src/sim/sim.ts:2672 with src/render/vehicles.ts:590, 719 | Full-turret vehicles fire on any bearing at once. The sprite bakes the gun forward. Rounds leave the side of the hull. | Render-side turret angle on a split hull/turret bake (upgrade 7). |
| MEDIUM | src/render/dudes.ts:40-44 (and every band picker) | Bands are chosen from CSS px/m. The canvas is scaled by dpr (`main.ts:72-74`). No render file reads `view.dpr`. Every bake is upscaled by dpr on Retina and phones, against the "never upscale on screen" comment. | Pick the band from `scale * view.dpr` where memory allows (upgrade 12). |
| MEDIUM | src/render/audio.ts:297 | `addBooms` takes `{x, y}`. All blasts share one voice. | Key the recipe on `r` and `kind` once D1 lands. |
| LOW | src/render/renderer.ts:845 | Wreck plume is soot for `u < 0.34` only. The "black column" is pale grey. | Hold soot to ~0.8 of the column for `kind === 1`. |
| LOW | src/render/roofs.ts:2402-2416 | Chimney wisps read as hard-edged pale discs at close zoom. Each wisp builds a `createRadialGradient` per frame, the cost `fx.ts` exists to remove. Attribution to the wisps is by position and code, not by toggling them off. | Blit the baked `smoke` puff from the fx atlas. Cap alpha above 24 px/m. |
| LOW | src/render/renderer.ts:510-513, 412-413 | Comments say shake and birds run on wall-clock. The clock passed in is `fxNow` (`main.ts:1961`). A pause inside 350 ms of a blast holds a non-zero shake offset. Code read only. | Zero the shake when paused, or correct the comments. |
| LOW | scripts/fxcost.mjs | Measures the morale FX family only, on one view. Repeated `getImageData` on one page can demote the canvas to software raster: my phone run jumped from 5 ms to 130 ms after ~1,500 readbacks and a fresh page returned to 3.6 ms. | Add whole-frame arms. Use a fresh page per scene. |

Seen in passing, outside FX scope: the ticker printed "M4 Sherman … — PINNED DOWN" for a tank crew [shot d-15-brewup-120ms].

## 4. Top 15 upgrades, ranked by visible impact per unit of work

**Do first, not ranked:** fix the VFX gate (defect D2). Without it no builder can prove a transient changed.

All 15 are Canvas 2D. Sizes: S = one file, hours. M = 2-4 files. L = a new subsystem. "Sim event" means an output-only field in the style of `ShotEvent.weapon`, with no behaviour change. Cost figures marked "est." are estimates from the measured blit rate, not measurements.

| # | Upgrade | What the player sees | Files | Size | Frame-cost risk | Mobile | Sim |
|---|---|---|---|---|---|---|---|
| 1 | **Blast size and kind from the sim, then per-kind recipes** | A grenade is a sharp dirt puff. A mortar is a tall fountain with hanging dust. An AT hit is a jet with sparks. A tank kill is the biggest thing on the field. Shake and sound scale with it. | `sim.ts:2336-2348`, `2746`, `2105`. `renderer.ts:86-88`, `323-336`, `1921-2057`. `audio.ts:297` | S for the wire, M for recipes | Low. Counts already ride `rs` and the zoom tier. | No change. Tiers already cut counts. | Yes: `r`, `kind` on the boom |
| 2 | **FX legibility floor** | Flashes, tracers and impacts keep a minimum screen size below ~20 px/m. Tracers become 2-3 px with a soft under-glow. A firefight is visible at play zoom. | `fx.ts:105-111`, `renderer.ts:1610-1916` | S | Low. Same blit count, larger quads. | Same floor in CSS px | Render-only |
| 3 | **Bursts that match the audio** | An MG42 strobes 5 flashes at 50 ms with staggered tracers. A Thompson stutters. Rifles stay single. | `renderer.ts:1836-1859`. Reuse the `GUN` table in `audio.ts:36-49` | S | Low. Up to 5x flash blits per automatic event, inside the one hot batch. | Cap at 3 taps, as audio does | Render-only |
| 4 | **Shooter and victim reaction** | A man kicks back when he fires. A hit man jerks. A killed man slides 0.3-0.8 m along the shot and settles into his pose over 250 ms. | `sim.ts:360-368`, emit sites `1680`, `2826`, `4234`. `renderer.ts:35-53`, `1267-1403` | M | None measurable. Draw transforms on existing bakes, no new sprites. | Same | Yes: `shooterId`, `targetId` on ShotEvent. Death direction on the `kia` UnitEvent |
| 5 | **Night light through the grade** | A muzzle flash lights the man and 2 m of ground. A blast lights the street. A burning house lights its block. | `renderer.ts:621-641`, `1016-1039` | M | Medium. One low-res offscreen fill, N light blits, one scaled blit. Est. under 0.5 ms desktop. Runs only when `ambient.a > 0`. | 1/8 resolution, 12 lights max | Render-only |
| 6 | **Battle pall** | Dust and smoke hang where the fighting is for 8-20 s and drift on the wind. The field looks fought over. The whole-map view shows where the fight is. | New capped list in `renderer.ts`. Reuse the `fx.ts` atlas. | M | Low. 48 blits max, est. 0.3 ms. | Cap 20 | Render-only. Must look thinner than sim smoke, which blocks sight. Owner decision. |
| 7 | **Vehicle life** | The turret turns to the target. The barrel recoils and the hull rocks on a main-gun shot. Exhaust at idle. A dust trail that shows. | `vehicles.ts:475-547`, `1006-1040`, `1110-1150`. `renderer.ts:684-712`, `1113-1181` | M-L | Low. One more rotated blit per vehicle. A few more cache entries. | Same | Render-only. The sim still fires at once, so a shot can leave before the drawn turret lines up. |
| 8 | **Fire and brew-up that scale** | Flames run along the roof and fill the footprint. A brewed-up tank burns hard for 14 s with cook-off pops under a column that stays black. | `renderer.ts:935-1039`, `845` | M | Medium. More licks per fire. Keep `FIRE_CAP` 12. | Halve lick count | Render-only |
| 9 | **Far-zoom battle read** | On the whole map, shots twinkle and blasts flash at a minimum of ~10 px. | `fx.ts:47-49`, `renderer.ts` shot and boom draws at tier 0 | S | Low | Same | Render-only |
| 10 | **Camera feel** | Zoom eases. Pan has inertia. Shake scales with blast size and distance. Big events (tank kill, barrage in view) get a 40-60 ms hold. | `main.ts:1623-1630`, `1792-1806`, `1880-1899`. `camera.ts`. `renderer.ts:769-791` | S-M | None | Shake x0.6. No hold when a frame is already late. | Render-only. The hold delays `sim.step()` calls and changes no sim result. |
| 11 | **Blood and bodies** | A dark puff at the hit. Spatter along the shot line. Pools that grow for 3 s and read. Corpses keep their uniform colour. | `renderer.ts:1679-1694`, `1363-1376`. `decals.ts:140-164`. `dudes.ts:43-53` | S-M | Low | Same | Render-only. Gore level is an owner decision. |
| 12 | **HiDPI-aware bake bands** | Men, vehicles and roofs are sharp on Retina and phones. | `dudes.ts:40-44`, `vehicles.ts:14`, emplacement, terrain and roof band pickers | S in code | Medium. 4x bake memory at the top band. Band-change hitch, covered by `prewarm` (`renderer.ts:738-764`). | Keep the band-24 cap for terrain. Allow band 48 for men only. | Render-only. Sweep baselines are dpr 1 and do not move. |
| 13 | **Audio space** | Blasts differ by size. Distant fire is duller and late. Shots ring off the valley. A wind bed and a far rumble that rises with the fight. Engines. Order clicks. | `audio.ts` | M | None on the canvas. One reverb send. | Voice cap 12 stays. No convolver, use a feedback delay. | Render-only, but an incoming-shell whistle needs a new sim event with lead time. |
| 14 | **Shell casings and weapon smoke** | Brass skips out to the right of each shot and stays. A wisp hangs at an MG position. | New capped stamp list in the style of `marks.ts` | S | Low | Off below band 24 | Render-only. Position and bearing come from the ShotEvent. |
| 15 | **Screen finish** | A vignette. A soft glow on flashes and fire. A split-tone grade by hour. A treated map edge. | `renderer.ts:493-612` | S-M | Medium for glow: one 1/4-res offscreen pass. Vignette is one blit. | Vignette only | Render-only. A vignette moves all 147 sweep baselines once. |

Suggested packages: **A** (items 1, 2, 3, 9: scale and size, about a day of render work plus one sim field), **B** (4, 7, 10: reaction), **C** (5, 6, 8, 15: light and air), **D** (11, 12, 13, 14).

**WebGL:** not proposed. A contained overlay canvas for additive particles and light is possible, but it is L, adds context-loss handling and a second compositing path, and the measured Canvas headroom does not call for it.

**Rules every builder must keep:** animated cosmetics ride `fxNow` or the sim tick so `?flicker=0` pins them. No sim rng. Bake-time randomness comes from `hash`. One sun: a light pool is allowed, a second shadow direction is not. Strict plan view: height is carried by shadow and by drift along the wind axis.

## 5. Measured frame budget and headroom

Machine: Apple M4 Pro, headless Chrome through Playwright. All figures are `renderer.draw()` only. They exclude `sim.step()`, HUD DOM and the overlays `main.ts` draws after the renderer.

**`scripts/fxcost.mjs`, three runs** (258 soldiers, 24 px/m, seed 9, n=400):

| Run | With morale FX at cap | Without | Delta |
|---|---|---|---|
| 1 | 2.413 ms | 2.327 ms | 0.085 ms |
| 2 | 2.268 ms | 2.210 ms | 0.058 ms |
| 3 | 2.361 ms | 2.337 ms | 0.024 ms |

Cap held at 10 of 40 pushed. This probe measures one FX family on one view.

**Whole frame, desktop 1280x800 dpr 1** (`audit/budget.mjs`, n=150 interleaved). Heavy = 12 blasts at staggered ages, 60 shots (20 MG), 10 morale FX:

| View | Zoom | Idle | Heavy | Delta |
|---|---|---|---|---|
| Squad in a field | 3.33 | 4.69 ms | 5.61 ms | 0.93 |
| | 8 | 2.06 | 3.27 | 1.21 |
| | 14 | 2.26 | 3.87 | 1.61 |
| | 24 | 2.21 | 4.10 | 1.90 |
| | 40 | 2.17 | 4.39 | 2.22 |
| Town centre | 3.33 | 6.89 | 8.16 | 1.27 |
| | 8 | 5.43 | 6.59 | 1.17 |
| | 14 | 5.10 | 6.52 | 1.43 |
| | 24 | 4.12 | 5.92 | 1.80 |
| | 40 | 3.39 | 5.54 | 2.15 |

**Desktop headroom:** worst measured heavy frame is 8.2 ms. That leaves 8.5 ms of 16.7 ms. At play zoom (14-24) the heavy frame is 3.9-6.5 ms, leaving 10-13 ms. The whole current combat FX load costs 1-2 ms.

**Phone profile (390x844, 1.32 Mpx canvas) — emulation on the same M4 Pro, not a phone:**
- Fresh-page idle draw, town centre: 3.6 ms at 24 px/m, 3.65 ms at 14, 3.25 ms at 32, 7.6 ms at 1.2.
- Frame pacing in the game's own loop with no readback: 60 fps idle and heavy at 1.2, 14, 24 and 32 px/m. p95 gap 17.6 ms or less.
- Squad view before the artefact began: idle 2.7-5.3 ms, heavy 3.8-6.6 ms.
- The `budget.mjs` phone run reported 30-135 ms from its sixth row on. That is a readback artefact: a fresh page returned 3.6 ms on the same view.

**Real-phone headroom: not measured.** The emulation shows the larger canvas does not break the frame on desktop hardware. It says nothing about a phone CPU or GPU. Treat items 5, 8 and 15 as needing a device check before they ship to mobile.

## 6. Not confirmed, and where I looked

- **Audio by ear.** Code read only (`audio.ts`, all 362 lines). I did not listen to anything.
- **Real phone performance.** Emulated profile only.
- **Tank main-gun shot.** The firing capture (`d-14`, `m-14`) caught the hull M1919, not the cannon. Cannon flash and wash are code read only (`renderer.ts:1661-1670`).
- **Airstrike plane, melee FX, wall breach FX, birds, bazooka back-blast, a live smoke throw.** Code read only. `x-24` covers staged smoke at five ages.
- **`scripts/vfx.mjs` end to end.** Not run, because it writes into the repo's `.screenshots/`. The dead-gate finding rests on the paused-ageing probe and on two `shot.mjs --effect` runs through the same `burst()`.
- **Chimney wisps as the pale discs.** Inferred from position and `roofs.ts:2397-2435`. Not isolated by turning them off.
- **Shake offset frozen under pause.** Derived from code. Not observed.
- **Determinism impact of new event fields.** A grep of `snapshot()` around `sim.ts:4380-4440` found `pendingGrenades` only. I did not read the whole function. The builder must confirm `pendingBooms` and `pendingEvents` are outside the snapshot before adding fields, and run the determinism suite.
- **Cost of every proposed upgrade.** Estimates. Only the current load is measured.
- **Files read in part.** `terrain.ts`, `roofs.ts`, `vehicles.ts`, `dudes.ts`, `emplacements.ts`: grep and targeted reads. `renderer.ts`, `fx.ts`, `decals.ts`, `marks.ts`, `light.ts`, `canopy.ts`, `camera.ts`, `view.ts`, `audio.ts` read in full. `patches.ts` is map structure, not FX.
- **Decision log.** Entries from line 51 on were read to 260 characters each, including the 2026-07-26 touch entry. Mobile caps in this report come from code: `view.ts:11-22`, `dudes.ts:40`, `renderer.ts:126`, `audio.ts:51-58`, `main.ts:633-639`, `1888`.
- **Wreck art at rest.** Seen only under smoke in `d-15-brewup-25s`.
- **Whether any sweep crop contains a transient.** Not checked.
- **Retina desktop.** The dpr finding is from code plus the phone screenshots. No Retina desktop capture was taken.
