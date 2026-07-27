# Day/night cycle — design

**Owner intent:** a realistic day/night cycle with REAL shadows — direction and length driven
by time of day, night fights dark — under the strict plan-view rule set by the interiors lane
("Plan projection: churchyard graves are footprints + one-sun cast shadows", `b396732`;
"you never see the side of a wall from directly overhead", `617e266`). Under that rule the
cast shadow is the *only* channel that carries height. Moving the sun is therefore not a
lighting feature bolted onto the art — it is a direct rewrite of the one channel that sells
verticality. Get it wrong and every building becomes a coloured rectangle.

Everything below was verified against the tree at `c31bd9c` (main). Symbol references, not
line numbers, wherever a parallel session might have moved code.

---

## 0. What the code already gives us (read, then verified)

| Fact | Where | Why it matters |
|---|---|---|
| `SUN` is a compile-time unit vector, `normalize(0.45, 0.55)` = `(0.63323779, 0.77395730)` | `src/render/light.ts` | Exactly two exported symbols carry direction: `SUN` and `shadowOffset(len)`. ~45 call sites across 9 render files import one of them. That is the whole plumbing surface. |
| Unit shadows take their DIRECTION from the draw matrix, not the bake | `renderer.ts drawUnitShadows`: `ctx.rotate(SUN_A); ctx.translate(off*scale, 0); ctx.scale(1.18,1); ctx.rotate(-SUN_A); ctx.rotate(facing)` — and its own comment says so | **Confirmed.** Soldiers, vehicles, emplacements, and the turret drop-blob reorient for FREE. The `SpriteCache` (`spritecache.ts`) — the biggest cache in the game, a band-48 dude canvas at ~117 KB — gains **nothing** in its keyspace. This is the single fact that makes the feature affordable. |
| Roof shadow direction IS baked | `roofs.ts bakeShadow` calls `shadowOffset(0.71*stories)` / `shadowOffset(1.1*stories)` *inside* the bake; the spire finger too | Needs a sun component in the key. |
| The roof shadow's **bounding box** is computed at art-build time | `roofs.ts buildArt`: `const [csdx, csdy] = shadowOffset(1.1*stories + spireCast)` → `art.sx/sy/sw/sh`, "shadow sprite rect — grown SE by the cast offset plus blur margin" | `RoofArt` is itself sun-dependent. This is the non-obvious one — see §5.2. |
| Terrain bakes direction into chunks | `terrain.ts`: hedge shadow `shadowOffset(0.4)`, hillshade `LIGHT` derived from `SUN` + `SUN_Z=0.84`, trees via `canopy.ts shadowOffset(0.45/0.3)`, plus `props.ts` (9 calls), `yards.ts` (5), `enclos.ts` (5), `shops.ts` (3) — all inside `TerrainLayer.chunk()` | Chunk key gains a sun component. |
| `roofs.ts` shading internals also read `SUN` | spire apex lean `cx - SUN.dx*lean`, roof flashing `crossInto(..., -SUN.dx*fl, ...)`, weathering wash bias, `drawTops` PARALLAX `-SUN * 0.26` | Everything except PARALLAX is baked; PARALLAX is a draw-time offset and is free. |
| `fx.ts` spall highlights are baked into particle stamps | `pock()` / debris chunk: pale crescent at `h - SUN.dx*core*0.5`, "thrown OPPOSITE the sun so every chip catches the same light"; `marks.ts` repeats the contract | Small keyspace; see §5.4. |
| Amortized rebake machinery exists, twice, and is tuned | `terrain.ts`: `BAKES_PER_FRAME=3`, `MOBILE_BAKES_PER_FRAME=12`, `PIXEL_BUDGET` 24M/6M px, `fallback()` serves the same chunk from another band, `flatColor()` stand-in. `roofs.ts` T22: `nextBake()` on-screen-first, `bakeBudgetMs(prewarm, still)` → `BAKE_MS=4` / `BAKE_MS_STATIC=16`, `Baked.ver` damage tag, prev-band serves stale | A sun step is structurally identical to a zoom-band change. We reuse, we do not build. |
| `Front.clockMin` is a real continuous clock; `OP_START_MIN = 6*60` | `strategic/front.ts` | The campaign already knows what time it is. |
| Battles boot at a real hour — but nothing reaches the Sim | `main.ts startEngagementBattle` uses `front.clockMin` for the seed and for `battleTitle = "Day N HHMM — ..."`, then throws the hour away. `makeStrategicBattle(c, front, e, seed)` never passes it on; `new Sim(map, seed)` has no time input | One field to add. |
| `WIND` precedent: sim-side math re-exported by the render light model | `light.ts`: *"The wind now lives sim-side (`src/sim/wind.ts`) because the smoke-column LOS test leans by it, and `src/sim/*` may not import `src/render/*`. Re-exported here so every render consumer keeps importing it from the light model."* | **This is the template for the whole feature.** Solar math goes in `src/sim/solar.ts`; `render/light.ts` re-exports. No exceptions. |
| The strategic header already has a 24 h time ring | `strategic.ts drawTimeRing`, `timeOfDayAngle` | Free hook — and it carries a live bug (§6). |
| `sightToSoldier` is the single sense funnel | `sim.ts`: *"Every soldier-target sense (acquire, live fire, ambush trigger, honest vision, fog-of-war spotting) routes through this"*; conceal ≥ 0.5 AND range > 20 m hides a `sneak`/`ambush` team; "Deterministic, no RNG" | One place to add darkness. The memory note *sight-funnel-callers* warns that threading a new per-observer arg must cover the vehicle/AT callers — a `sim.light` field read *inside* the funnel avoids that trap entirely. |
| SPOT_RANGE=200 is measured-inert above ~60 m | decision 2026-07-23: LOS p95 ≈ 48–56 m over 1,560 sampled sightlines; longest real first-sweep spot 38 m | **Designing night as a multiplier on SPOT_RANGE would do nothing.** See §7.1. |
| The art gate does not pin the hour | `stage.mjs gotoStaged` sets `seed`/`camp`/`fow`/`haze` then calls `startEngagementBattle` immediately, with `stratPaused = true`, so `front.clockMin` sits at `OP_START_MIN` = **06:00** | Under the solar model 06:00 clock is elevation −1.9° — civil twilight, no cast shadows, deep-blue grade. **Without an hour pin, shipping the sun model silently converts every art baseline into a night shot.** This is the highest-severity interaction in the document (§8). |

---

## 1. The load-bearing trick: define the map's compass from the art, not the other way round

Normandy is 49.2° N. In high summer the sun rises at azimuth ~50° (NE) and sets at ~310° (NW);
for the fourteen hours in between it is in the southern half of the sky. A "NW sun at 40°
elevation" — the current house convention, `light.ts` — is astronomically reachable only near
sunset. If we naively declare screen-up = north, then every existing frame in the game is
a 21:15 shot, and pinning the art gate to noon would rotate every shadow in the game by
~130° and reshoot every baseline.

**Nothing in the sim says which way is north.** `GameMap` has no compass. Objectives are
tagged by kind, spawns by `west`/`east` (a *tactical* west, the blue start edge). So:

> **Decision D-N1.** Map-north is *defined* as the direction today's shadows already fall:
> `N = SUN_today = (0.63323779, 0.77395730)` in screen space. Map-east is `N` rotated a
> quarter turn: `E = (-N.y, N.x)`.

At solar noon the sun is due south, so shadows fall due north — which is now, by construction,
exactly today's `SUN` vector. **The canonical hour renders byte-identical to the shipped
build.** Every one of the ~45 `SUN`/`shadowOffset` call sites keeps producing today's numbers
at the canonical hour, every sweep baseline survives, and the whole feature becomes a
*deviation from a fixed point* rather than a rewrite.

The compass is only a bookkeeping frame; `spawns.west` keeps its name and meaning
(the blue start edge). Do not rename anything.

---

## 2. Sun model

### 2.1 Solar geometry — one fixed summer day, no seasons

`src/sim/solar.ts`, pure math, no DOM, no RNG:

```
LAT   = 49.2°          // Caen
DECL  = +21°           // one fixed high-summer declination. No date, no seasons, no
                       // equation of time. This is a game.
DBST  = 2 h            // the campaign clock is Double British Summer Time, as it was
                       // in June 1944. solarHour = clockHour - 2.

H     = 15° * (solarHour - 12)                              // hour angle
sin el = sin LAT sin DECL + cos LAT cos DECL cos H
cos az = (sin DECL - sin el sin LAT) / (cos el cos LAT)      // az from N, clockwise
         az = 360° - az  when  H > 0                         // afternoon
```

Computed arc (verified numerically):

| clock (DBST) | elevation | azimuth | note |
|---|---|---|---|
| 02:00 | −19.8° | 0° | solar midnight, darkest |
| 05:30 | −5.7° | 48° | civil dawn begins |
| **06:15** | **0°** | **56°** | **sunrise** (historical D-Day sunrise was 05:58 DBST — close enough for a model with no date) |
| 07:00 | +6.5° | 65° | |
| 10:00 | +35.2° | 98° | |
| 12:00 | +53.1° | 129° | |
| **14:00** | **+61.8°** | **180°** | **solar noon — the canonical hour** |
| 18:00 | +35.2° | 262° | |
| 21:00 | +6.5° | 295° | |
| **21:45** | **0°** | **300°** | **sunset** — 15.5 h of daylight |
| 22:30 | −5.7° | 312° | civil dusk ends |

`OP_START_MIN` = 06:00 is therefore first light. That is a good campaign opening and it is
already what the code says — but it is a *design statement* the owner should sign off on
rather than discover: **under this model the first battle of every campaign is a dawn fight.**

### 2.2 From solar position to the three art quantities

```ts
export interface SunState {
  step: number;              // quantization bucket — the ONLY thing that enters a bake key
  dir: readonly [number, number];  // unit vector: the direction a shadow travels
  lenMul: number;            // multiplier on every shadowOffset()/SHADOW_OFF distance
  alphaMul: number;          // multiplier on SHADOW_ALPHA / SHADOW_SOFT_ALPHA (NOT AO_ALPHA)
  softMul: number;           // multiplier on bakeShadow's blur radii
  ambient: readonly [number, number, number, number]; // r,g,b,a for the world grade
}
```

**Direction.** Toward-sun horizontal = `N·cos(az) + E·sin(az)`; shadow travels the opposite
way: `dir = -(N·cos az + E·sin az)`. At az = 180° this is `+N` = today's `SUN`. ✓

**Length.** Geometric cast is `height · cot(el)`, but the house convention is heavily
foreshortened on purpose — `roofs.ts` casts 0.71 m per 3 m story and `renderer.ts` says so
explicitly: *"not the geometric length a 40-degree sun would imply"*. Preserve that by making
length **relative to the canonical hour**:

```
lenMul = clamp( cot(el) / cot(EL_CANON), 0, 3.0 )      EL_CANON = 61.8°, cot = 0.536
```

`lenMul = 1` at 14:00 by construction. The 3.0 clamp binds below el ≈ 32° (before ~09:35,
after ~18:25); ungated, 07:00 would ask for 16.3× and a three-storey house would throw a 35 m
finger across two chunks. Beyond the clamp the *alpha* ramp carries the story, which is both
the honest read (a very low sun's shadow is diffuse, not infinitely dark) and the thing that
bounds the shadow-sprite bounding box (§5.2).

**Alpha and softness.**

```
alphaMul = smoothstep(-6°, +25°, el)       // 0 through civil twilight, 1 above 25°
softMul  = 1 + 2*(1 - alphaMul)            // low sun ⇒ up to 3× the blur radius
```

At 07:00: `lenMul = 3.0`, `alphaMul = 0.36` — long, faint, soft. Exactly the brief. At night
`alphaMul = 0`, which means **the entire cast-shadow system switches off** — a frame cost saved,
not spent (§9). `AO_ALPHA` is untouched: `light.ts` already documents it as
*"contact/base ambient occlusion, not sun-directional"*, and contact occlusion under a man
survives the sun going down.

Above el = 25° (08:55 → 19:05) `alphaMul` and `ambient.a` are both exactly 1 and 0
respectively, so **the entire nine-hour core of the day renders with today's alphas.** Only
`dir` and `lenMul` move, and both are 1/identity at the canonical hour.

### 2.3 Quantization

Two buckets, folded into one integer. Quantize on the **solar quantities**, not on the clock —
the azimuth rate varies 3× over the day (peak 28°/h near noon, 11°/h at dawn), so a
fixed-minutes bucket would be either too coarse at noon or wastefully fine at dawn.

```
azBucket = floor(az / 18)                    // 20 buckets, 18° each
elBucket = clamp(floor((el + 12) / 5), 0, 20) // 5° elevation steps, floored at astro dark
step     = azBucket * 32 + elBucket           // one int, the bake-key component
```

**Everything rendered is derived from the bucket centre, never from the raw hour.** Two clock
times in the same bucket produce bit-identical art — that is what makes the key sound. An 18°
azimuth bucket is ~38 min of clock at the fastest (noon) and ~100 min at dawn/dusk; a typical
20–40 sim-minute engagement crosses **at most one** step boundary, and most cross none.

`sunStepFor(band)` collapses low bands: **bands ≤ 8 always use step 0.** At 8 px/m a hedge's
0.4 m cast is three pixels and its direction is not readable; baking 300 far-LOD chunks per
sun step to rotate a 3 px smudge is the one place this feature could genuinely hurt (§9).
Day/night at far LOD is carried entirely by the ambient grade, which is a per-frame fillRect
and costs nothing.

### 2.4 API — the consumers do not re-plumb

`render/light.ts` keeps its exact exported surface. `SUN` and `shadowOffset()` become live
reads off a module-level current state:

```ts
// src/render/light.ts
let cur: SunState = sunAt(CANON_CLOCK_MIN);
export function setSun(clockMin: number): boolean;  // returns true if `step` changed
export const SUN = { get dx() { return cur.dir[0]; }, get dy() { return cur.dir[1]; } };
export function shadowOffset(len: number): [number, number] {
  return [cur.dir[0] * len * cur.lenMul, cur.dir[1] * len * cur.lenMul];
}
export function shadowAlpha(): number;      // SHADOW_ALPHA * cur.alphaMul
export function shadowSoftAlpha(): number;  // SHADOW_SOFT_ALPHA * cur.alphaMul
```

A mutable module singleton is normally a smell. It is correct here for one specific reason:
**every consumer of `SUN` reads it either inside a bake whose cache key already records
`cur.step`, or inside a per-frame draw that re-reads it every frame.** There is no third
category. The singleton cannot go stale relative to a cached artifact, because the artifact's
key names the sun it was baked under. Write that reason into the file header — it is the
invariant a future contributor will otherwise break.

`SHADOW_ALPHA` / `SHADOW_SOFT_ALPHA` stay exported as the base constants (they are interpolated
into template strings in ~12 places); the `shadowAlpha()` accessors are what the *cast* passes
switch to. Non-cast uses of `SHADOW_SOFT_ALPHA` — e.g. `renderer.ts` reuses it as a generic
unit-shadow alpha — get audited case by case in N6.

---

## 3. Ambient grading

### 3.1 The ramp

One function, `ambientAt(el) → [r,g,b,a]`, source-over:

| elevation | tint | a | reads as |
|---|---|---|---|
| > +25° | — | **0.00** | full day, no grade drawn at all |
| +25° → 0° | `(255, 196, 132)` | 0 → 0.10 | golden hour ramp |
| 0° → −6° | lerp to `(38, 52, 92)` | 0.10 → 0.42 | civil twilight, warm→blue crossfade |
| −6° → −12° | `(26, 36, 68)` | 0.42 → 0.62 | night |
| < −12° | `(26, 36, 68)` | 0.62 | astronomical dark, floor |

**Source-over, never `multiply`.** Multiply crushes blacks to black; source-over is a lerp
toward the tint, so at the night floor a black pixel *rises* to `(10, 14, 26)` and a white one
falls to `(113, 120, 143)`. That is the brief's requirement — dark blue and low-contrast,
never black — produced by the cheapest composite mode there is. It is also why the maximum
alpha is 0.62 and not 0.85: at 0.62 the world retains 38% of its own value, which is enough
for a player to read hedgerow from field.

### 3.2 Where it applies in the pipeline

The precedent is `worldShake`, and it is exact. `Renderer.draw` does:

```
ctx.fillRect(...)                       // backdrop, deliberately unshaken
const [shx, shy] = this.worldShake(...)
ctx.save(); ctx.translate(shx, shy)
  … every world layer …
ctx.restore()
```

with the comment *"Camera shake: world layers only (HUD/picking stay steady — worldToScreen is
untouched)"*. The grade goes in the same envelope, as the **last draw before `ctx.restore()`**,
sized `fillRect(-24, -24, cw+48, ch+48)` to cover the shake translate. HUD is DOM
(`hud.root`) and untouched by construction; canvas-drawn world-anchored UI (selection rings,
order previews, contact ghosts, `overlays.ts`) is drawn by `main.ts` *after* `renderer.draw()`
returns, so it also sits above the grade and stays legible at night. That falls out of the
existing structure for free — confirm it, don't rebuild it.

### 3.3 Muzzle flashes and tracers gaining punch — confirmed, but conditional

The owner's premise is right, with a caveat worth stating precisely. `fx.ts hotPass()` sets
`globalCompositeOperation = 'lighter'`. Additive blending adds a *fixed* source value to the
destination, so the same flash over a graded-dark background produces the same absolute
increment against a much lower floor — the contrast ratio goes up for free, no per-effect
night tuning. **Provided the grade lands underneath the additive draw.** Today `drawFire`
(muzzle + tracer + impact), `drawFires`, and the boom fireballs all draw *before* the end of
the world block, i.e. they would be graded down along with everything else, and the effect
would be exactly backwards.

So N7 has two halves: the grade, and hoisting the hot passes above it. The seam already exists
— `hotPass()` is a distinct, named concept in `fx.ts` and every additive draw is already
batched through it. The work is collecting those into a `drawHot()` that runs after the grade.

**Cost, stated honestly:** hoisting the hot pass above `roofs.drawTops` changes daylight pixels
too — a tracer that today passes behind a roof edge will pass in front of it. That reshoots
the *dynamic* VFX gate (`scripts/vfx.mjs`), not the static sweep (`sweep.mjs` never fires a
shot; its scenes are paused and unstepped). One reviewed reshoot of ~10 VFX frames is the
price. Do not try to avoid it with a per-layer grade — that way lies four grade call sites and
a soldier lit differently from the ground he stands on.

---

## 4. What changes where — the bake-key / draw-path split

This table is the implementation contract. **Draw-path entries are free.**

### 4.1 Draw path — reorients per frame, zero cache impact

| Site | Change |
|---|---|
| `renderer.ts drawUnitShadows` — soldiers | `SUN_A` becomes a per-frame `Math.atan2(SUN.dy, SUN.dx)`; `SHADOW_OFF[pose] * lenMul`; elongation `scale(1 + 0.18*lenMul, 1)`; `globalAlpha *= alphaMul`; early-out `if (alphaMul < 0.02) return` |
| same — vehicles | `HULL_SHADOW_OFF * lenMul`, `HULL_SHADOW_ALPHA * alphaMul` |
| same — turret drop blob | offset `SUN.dx * 0.7 * lenMul` |
| same — emplacements | `EMPL_SHADOW_OFF * lenMul` |
| `roofs.ts drawTops` | PARALLAX `-SUN * 0.26` — rotates free. (Under strict plan view the parallax is the roof mass displaced up-sun; rotating it with the sun is not just free, it is *more* correct than a fixed offset.) |
| `terrain.ts drawStairs` | Hard-codes a "lit NW lip" (`rgba(255,250,235,0.35)` at the top of each tread) with no `SUN` reference. It is a per-frame pass, so make it derive from `SUN` and fade with `alphaMul` — a lit lip on the wrong side of every step at 07:00 is exactly the kind of thing plan view has no other cue to hide. |

The `SpriteCache` LRU (`spritecache.ts`) is **untouched**. Soldier/vehicle/emplacement shadow
sprites are direction-free silhouettes; nothing about the sun enters `side|weapon|pose|frame|variant|band`.

### 4.2 Bake path — needs `sunStep` in the key

| Cache | Key today | Key after |
|---|---|---|
| `TerrainLayer.cache` | `` `${cx},${cy},${band}` `` | `` `${cx},${cy},${band},${sunStepFor(band)}` `` |
| `TerrainLayer.flat` | `` `${cx},${cy}` `` | unchanged — a dominant-terrain colour has no direction. Tint it via the grade like everything else. |
| `stamp()` cache (`stamps.ts`) used by grass/verge/gravel/cobble/litter | keyed by content + band | unchanged — none of those stamps read `SUN` |
| `canopySprite` (`canopy.ts`) | content + band + detail | **+ sunStep** (`shadowOffset(0.45)` inside) |
| `RoofLayer.sprites` | `Map<band, (Baked|null)[]>` | `Map<`${band}:${sunStep}`, …>`, same "keep current + prev, evict the rest" rule in `setBand` |
| `Baked.ver` | one number (damage) | a version *record* — see §10 |
| `fx.ts` particle stamps (`pock`, debris chunks) | kind + variant + px | **+ azBucket only** (not elBucket) — see §5.4 |

---

## 5. Four traps

### 5.1 `TerrainLayer.fallback()` must learn about sun steps

`fallback()` today walks `BANDS` crispest-first for the same `(cx,cy)`. It must now search a
2-D space, in this priority order:

1. same sunStep, any other band — right shadows, wrong sharpness (today's behaviour)
2. **other sunStep, same band** — right sharpness, shadows one 18° bucket stale
3. other sunStep, other band

Order 2 above 3 matters: a one-bucket-stale shadow at the correct resolution is far less
visible than a correct shadow at quarter resolution, because the shadow is 15–30% of the frame's
ink and the resolution is all of it. This is the serve-stale story for sun steps and it is
*the same mechanism* as the band story — `terrain.ts`'s own header already argues it:
*"Amortization is only free when there is something correct to show meanwhile."*

The pixel ledger (`this.pixels`, decremented on eviction) must stay exact across the widened
keyspace. The LRU handles retirement of dead sun steps for free — they simply stop being
touched and age out.

### 5.2 The roof shadow bounding box is sun-dependent, and padding to worst case is not affordable

`buildArt` computes `art.sx/sy/sw/sh` from `shadowOffset(1.1*stories + spireCast)`. Two wrong
answers and one right one:

- **Wrong: rebuild `RoofArt` on every sun step.** `buildArt` runs `artContexts()` over the whole
  building list, resolves terrace runs and party walls, and hashes ~30 art decisions per
  building. Rebuilding it re-derives material and jitter — which are hash-stable, so it *would*
  be correct, but it is 65 buildings of work to move four numbers, and it puts a sun step on
  the same footing as a new battle.
- **Wrong: pad the box to the worst-case cast (all azimuths, `lenMul` 3).** Budgeted: a 3-storey
  house casts `1.1 × 3 × 3 = 9.9 m`, so the pad is a 9.9 m radius on a ~10×8 m footprint →
  29.8 × 27.8 = 828 m² against today's ~150 m². At `sBand = band/2 = 16` that is 212 kpx =
  **848 KB per building**, ×65 buildings = **55 MB**. Dead on arrival.
- **Right: move the shadow rect from `RoofArt` onto `Baked`.** The shadow canvas and the rect
  that positions it are produced together by `bakeShadow` and consumed together by
  `drawShadows` (`ctx.drawImage(spr.shadow, art.sx, art.sy, art.sw, art.sh)`). They belong on the
  same object. `RoofArt` keeps `ox/oy/ow/oh` (the roof sprite box, sun-independent);
  `Baked` gains `sx/sy/sw/sh` alongside `shadow`.

While there: `bakeShadow`'s blur radii (`blur(0.28*band)` / `blur(0.12*band)`) scale by
`softMul`, and `onScreen(cam, i, cw, ch, 2*stories[i])` — the reject pad `drawShadows` uses to
decide a shadow is off-screen — must scale by `lenMul` or a low-sun shadow pops in at the
screen edge.

### 5.3 `pump()`'s "walls and shadow are damage-independent" reuse becomes false

`pump()` currently reuses `cur[i]?.shadow ?? bakeShadow(...)` across a damage-driven rebake,
with the comment *"walls and shadow are damage-independent"*. Under a **sun**-driven rebake the
shadow is precisely the thing that changed and the roof is not. So the reuse predicate must be
per-artifact and per-cause, not one boolean — §10.

### 5.4 `fx.ts` spall crescents: azimuth bucket only

`pock()` and the debris chunks bake a pale crescent *opposite* the sun into a small particle
stamp, and `marks.ts` documents the contract (*"spinning the sprite would break the one-sun
contract"*). These stamps persist as wall marks for the whole battle.

Key them on **`azBucket` only**, not the full `step`. Rationale: the crescent is a lit-side
highlight whose *direction* is the whole read; its length and alpha are a couple of pixels and
nobody will see them ramp. Dropping `elBucket` cuts the keyspace 21× on a cache of tiny
sprites, and — importantly — a mark stamped at 13:50 keeps its sprite when the sun steps at
14:05 instead of leaving a mismatched pair on the same wall.

At night these are additive-adjacent detail on a graded-dark wall and effectively invisible;
no night-specific work is needed.

---

## 6. Strategic layer

**Map tint.** `StrategicView.draw` gets the same `ambientAt()` wash over the sector-map region
only (not the header, not the chit panel). One `fillRect`. The point is not realism at
500 m/cell — it is that the player reads "it's 02:00, my company is going to fight in the dark"
*before* committing, from the same colour language the battlefield will use.

**A live bug the model fixes.** `drawTimeRing` hard-codes `tod >= 6*60 && tod < 18*60` as
daylight. Under the real arc, sunset is 21:45: the ring currently draws a hollow "night" marker
at 19:00 while it is broad daylight outside, and the moment the battlefield actually grades,
the UI and the world will visibly disagree. Replace the literal with `elevationAt(clockMin) > 0`.

**The coarse resolver — recommendation: ship the hook, defer the number.**

`resolveCoarse` builds `terrainMult` from a chain whose comment reads: *"Coarse balance knobs
(tuned 2026-07 across 16 campaign seeds: wars run 1-15 days with both 'won' and 'lost'
outcomes)"*. That is a calibrated distribution, and its calibration is the asset — not the
constants.

Arguments actually on the table:

- *For a defender bonus.* The sim's own night rules (§7) shorten spotting and make concealment
  cheap. Both favour whoever is already hidden and dug in — the defender. A coarse resolver
  that ignores night is inconsistent with the fine one, and consistency between the two
  resolvers is what makes the campaign feel like one world.
- *For deferring.* The player never watches a coarse battle; it is AI-vs-AI and surfaces as a
  single `stratView.flash` line. The change is invisible where the player looks and dangerous
  where they don't: `terrainMult` already spans 1.0→21.0 (town × river crossing), and injecting
  another multiplier without re-running the 16-seed sweep risks pushing the war-length
  distribution out of the 1–15 day band that makes the campaign work at all.
- *Against pure deferral.* There is a small real exploit: a human who fights at night eats the
  spotting penalty while the AI-vs-AI resolver does not, so "let the AI handle the night ones"
  becomes weakly optimal. Small, because the player controls one company on one axis.

**Recommendation:** land `nightMult` in the chain with a value of exactly **1.0**, plus a
16-seed campaign-length sweep script that measures the *current* distribution and can re-measure
under a candidate value. Then pick the number from the sweep. If forced to guess today:
`terrainMult *= 1.15` when the engagement resolves between civil dusk and civil dawn — and label
it a guess, because it is one. **Never change a tuned constant without re-running the thing that
tuned it. The sweep is the work; the constant is a byproduct.**

---

## 7. Night gameplay (Lane A)

### 7.1 Spotting — an absolute cap, not a multiplier, because of the measurement

Decision 2026-07-23 established that `SPOT_RANGE = 200` is **inert above ~60 m** on generated
maps: LOS p95 is 48–56 m, and the longest real first-sweep spot measured 38 m. Bocage binds,
not the constant.

The consequence for this design is direct and easy to get wrong: **a multiplicative night factor
does nothing until it is severe.** `SPOT_RANGE × 0.5` at dusk = 100 m = still inert = a dusk
setting that changes literally zero pixels of fog. Only around ×0.15 does it start to bite, at
which point it lurches from "no effect" to "blind". A multiplier gives us a cliff where we want
a ramp.

Use an **absolute cap** instead, so the knob lives in the band the map actually operates in:

```
spotCap(light) = lerp over the light level:
   full day (el > 25°)     → Infinity  (i.e. SPOT_RANGE, unchanged)
   golden (el 25° → 0°)    → Infinity → 90 m
   civil twilight (0→−6°)  →   90 m   → 45 m
   night (below −6°)       →   45 m   → 25 m floor
```

Applied as `Math.min(SPOT_RANGE, spotCap(this.light))` in the two range tests —
`updateSpotting`'s spotter loop and `sideSeesPoint`. 90 m is deliberately just above the
measured p95 so the golden-hour setting is *nearly* free (it clips the rare long sightline and
nothing else); 45 m and 25 m are below it, so twilight and night genuinely bite. This is
designed against the measurement, not against the constant.

### 7.2 Darkness as a concealment source — the interesting half

`sightToSoldier`'s hiding clause today: `conceal ≥ 0.5` **and** the target's team is on
`sneak`/`ambush` **and** range > 20 m. Ramp both numeric thresholds with light:

```
concealNeed(light) = lerp(0.5 → 0.18)     // day → night
hideFloor(light)   = lerp(20 m → 8 m)     // day → night
```

At night a *single* woods tile or half a hedge on the ray hides a sneaking team, and it hides
them from 8 m instead of 20 m. Night becomes the infiltrator's and the ambusher's weather,
which is both historically right and the reason to want a night mission at all. It composes
with the existing rule rather than forking it, and the ambush-reveal contract is untouched: a
trigger still converts the order to `defend`, so **the first volley still gives the position
away** — and at night, with the muzzle flash now the brightest thing in a graded-dark frame
(§3.3), it gives it away *harder*. That is the design working as one piece.

Note what this deliberately does **not** do: it does not blanket-hide non-sneaking troops. A
squad standing in the open at midnight is still visible at 25 m. Darkness rewards a chosen
posture; it is not a free invisibility field.

### 7.3 Where the light level lives, and why it lives there

`sim.light: number` (0..1), a **pure function of `startMin + tick/1800`** and nothing else — no
RNG, no state, no accumulation. Read *inside* `sightToSoldier` and `updateSpotting`, never
passed as an argument.

That placement is load-bearing for two recorded reasons:

- The memory note *sight-funnel-callers* records a scar: threading a new per-shooter argument
  through `sightBetween`/`sightToSoldier` must cover the vehicle-facing callers (AT, faust,
  tank-terror, apSolution), and a plan that lists only the soldier-vs-soldier callers will
  quietly miss them. A field on `Sim`, read inside the funnel, has **no call sites to miss**.
- `sightToSoldier`'s own header sets the precedent for exactly this: *"The target's eye is
  DERIVED here, never passed: no caller may disagree with `stanceOf` about how tall the man it
  is looking at is."* Same rule, same reason.

`sightBetween` (sight to a *map point* — mortar spotting, LOS previews) keeps day behaviour. A
map point is not hiding; darkening it would silently break `friendlyHasLos`, which is a
different, deliberately unlimited-range rule.

### 7.4 Determinism

- **Zero new RNG draws.** Every night rule is a threshold comparison. The memory note
  *sim-rng-test-sensitivity* records what happens when a new draw enters the shared sequential
  stream: every downstream draw shifts and every pinned snapshot and A/B balance test dies.
  Nothing here draws. Behaviour changes; the stream does not.
- **`light` stays out of `snapshot()`.** It is derivable from `(startMin, tick)`, both already
  pinned. Adding it would add bytes and change every snapshot string for zero information.
- **`startMin` defaults to `CANON_CLOCK_MIN`.** `src/sim/scenario.ts` and every test that
  constructs a `Sim` directly therefore keeps today's behaviour with no edit: `light` = 1,
  `spotCap` = ∞, `concealNeed` = 0.5, `hideFloor` = 20. The entire existing suite is a
  no-op-by-default.

**Tests that pin it:**

| Suite | What it must assert |
|---|---|
| `tests/sim.test.ts` (FoW block) | at `startMin = CANON`, snapshot and spotting sets byte-identical to today; at 02:00, a target at 60 m with clear LOS is **not** spotted and at 20 m **is** |
| new `tests/night.test.ts` | `light` is a pure function of `(startMin, tick)` — two Sims, same inputs, stepped differently, same light at the same tick; the `concealNeed`/`hideFloor` ramp is monotone; a sneaking team behind one hedge at 12 m is hidden at 02:00 and seen at 14:00 |
| `tests/doctrine.test.ts` | one night A/B case: same seed, same scenario, `startMin` 14:00 vs 02:00 — assert the *direction* of the effect (fewer engagements, shorter median engagement range), never an exact casualty count. The memory note *forced-precondition-tests-hide-dead-features* applies: also probe that night spotting fires under **natural** battle dynamics, not only in a scenario that forces a spotter to 60 m |
| `tests/campaign.test.ts` | `makeStrategicBattle` propagates `front.clockMin` into `sim.startMin`; `resolveCoarse` with `nightMult = 1.0` reproduces today's outcomes bit-for-bit |
| `tests/light.test.ts` (new) | `sunAt(CANON).dir` equals `normalize(0.45, 0.55)` to 1e-9; `lenMul === 1`; `alphaMul === 1`; `ambient[3] === 0`; `step` is stable across ±15 min of clock inside a bucket |

That last suite is the guard for the whole §1 trick. If it ever goes red, every art baseline in
the repo is invalid.

---

## 8. Art-gate discipline — the ordering constraint that must not be missed

**The hazard, stated plainly.** `gotoStaged` stages at whatever `front.clockMin` happens to be,
which is `OP_START_MIN` = 06:00, which the solar model scores at **elevation −1.9°** — civil
twilight, `alphaMul = 0`, `ambient.a ≈ 0.40`. If the sun model lands before the hour pin,
`npm run sweep` reshoots every baseline in the repo as a dim blue night frame, and the decision
log's own standing warning applies: *"a silently reshot art baseline is an invisible
regression — nothing downstream would ever flag it."*

> **Hard ordering constraint: N12 (the hour pin) lands on main BEFORE N2/N3 (the sun going
> live). Not as a dependency edge — as a merge gate.**

**The pin.** `gotoStaged(page, { …, hour = CANON_CLOCK_MIN })` sets `front.clockMin = hour`
inside the same `page.evaluate` that picks the chits, *before* `startEngagementBattle`. The
canonical hour is **14:00 DBST = solar noon = 840 min**, chosen because §1 makes it the exact
fixed point where every existing baseline is reproduced. Add a `sweep.mjs` preflight assert
next to the existing dpr/mobile ones: fail loudly if the staged `clockMin` is not the canonical
value, for the same reason those exist.

`?hour=HHMM` (or `?clock=<min>`) joins `?camp` / `?seed` / `?fow` / `?haze` in `main.ts` as a
staging switch that sets `front.clockMin` at boot. Same debug-switch pattern as `?fow=0` —
never read by `step()`.

**New sweep rows: two, deliberately small.** Every existing row keeps the canonical hour and
stays pixel-comparable. Add `--hour 0700` (dawn: 3× clamped, 36%-alpha shadows on a 65°
azimuth — the crop that catches a bad `lenMul` clamp or a stale `fallback()`) and `--hour 0200`
(deep night: the grade, and the absence of the cast pass) on **2 seeds × 2 crops** = 8 new
shots. Crops: `village`/`place` (masonry cast shadows, roof shadow bbox, enclosure walls) and
`units` (unit shadow reorientation, elongation, alpha). Do not fan dawn/night across all ten
seeds — the contact sheet is already 10×11 and the marginal information is near zero.

`shot.mjs` gains `--hour HHMM` threaded into `gotoStaged`, plus three named presets —
`dawn` 0700, `dusk` 2030, `night` 0200 — because a designer inspecting shadow work should not
have to do solar arithmetic to find the interesting hour.

**Also verify (do not assume):** `place()`'s settle loop stops after two pixel-identical frames.
A sun step queues bakes exactly like a band change, and `place()` was already extended once for
that reason (*"a fixed settle captures a half-drawn world"*). Confirm the 120-frame cap is still
enough when a scene boots into a non-canonical hour with a cold cache; if not, the cap is the
knob, not the loop.

---

## 9. Perf

### 9.1 Worst case: a sun step crossing

A sun step invalidates the same things a zoom-band change does, so the honest framing is
**"a sun step costs exactly one band change"** — a shipped, tuned, amortized path — and it
happens at most **once or twice in a 40-minute battle** (§2.3), against a band change happening
on every scroll-wheel notch.

**Terrain, desktop, band 32 @ 24 px/m.** A 1280×800 viewport shows 53.3 × 33.3 m = 3.3 × 2.1
chunks of 16 m → **12–20 visible chunks** with neighbours. `terrain.ts` states 2–5 ms per chunk,
so 24–100 ms of work, drained at `BAKES_PER_FRAME = 3` → **4–7 frames (~70–120 ms)**, with the
previous sun step serving through `fallback()` priority 2 the whole time. **No visible holes**:
the flat-colour stand-in only triggers when nothing is cached at any key, which cannot happen
on a sun step by definition.

**Terrain, far LOD (band 4, whole 320×240 map = 300 chunks)** would be 150–450 ms drained at
3/frame = **~100 frames ≈ 1.7 s** of stale-sun art. This is the one genuinely bad case, and
`sunStepFor(band) = band <= 8 ? 0 : step` (§2.3) **eliminates it entirely** — bands 4 and 8
never rebake for the sun. Day/night at far LOD is the ambient grade, which is one fillRect.

**Roofs.** 65 buildings × ~4 ms at band 32 = 260 ms, drained by `bakeBudgetMs` (4 ms moving,
16 ms still, floor of `BAKES_PER_FRAME = 2`) → **0.5–1.1 s**, previous `(band, step)` serving
throughout, on-screen buildings first via `nextBake`. Numerically identical to a band change,
which ships today. One optimisation available and worth taking: on a **sun-only** step the roof
*top* sprite is unchanged for everything except spire lean, flashing, and weathering bias — so a
sun rebake can reuse `roof` for flat-plan buildings and rebake only `shadow`. That turns the
common case from ~4 ms into the shadow bake alone. Measure before implementing; §10's version
record is what makes it expressible.

**Grade.** One source-over `fillRect` over 1280×800 ≈ 0.1–0.3 ms, and **skipped entirely above
el 25°** — the nine-hour core of the day pays nothing.

**Night is a net frame win.** `alphaMul = 0` early-outs `drawUnitShadows`, which today runs a
`save`/`rotate`/`translate`/`scale`/`rotate`/`rotate`/`drawImage`/`restore` per visible soldier
(up to ~138), per vehicle, per emplacement, plus a turret blob each. That loop disappearing
more than pays for the fillRect. Expect night frames to be **faster** than day frames, not
slower — measure and record it, because the intuition runs the other way and someone will
"optimise" the wrong thing later.

**Mobile.** `MOBILE_BAKES_PER_FRAME = 12` and the flat-colour stand-in already handle a cold
cache; a sun step is strictly easier than the boot frame that constant exists for. No new
mobile-specific mechanism. But: the widened terrain keyspace competes for a 6M-px budget, so
verify that two resident sun steps × two resident bands does not thrash. If it does, the fix is
to evict non-current sun steps eagerly on mobile (keep current + prev only, like roofs), not to
raise the budget.

### 9.2 Measurement tasks

`scripts/bake.mjs` exists to time a single chunk bake and its header names the ~8 ms stall
threshold. Time a bourg chunk at band 32 before and after the keyspace change (it should be
unchanged — the key is a string, the work is not), and time a full sun-step drain end to end.

---

## 10. Collision with the in-flight destructible-terrain lane

`docs/plans/2026-07-27-destructible-terrain-design.md` (tasks D9, D11) touches **the same four
functions** this design touches. This is not adjacent work; it is the same lines.

| Shared mechanism | Destructible needs | Day/night needs | Conflict |
|---|---|---|---|
| `TerrainLayer` chunk key + `fallback()` + pixel ledger | `invalidateEdge(x,y)`: targeted 3×3 chunk neighbourhood, **all bands** (D9) | `sunStep` as a **key component**, plus sun-aware `fallback()` priority (N4) | Both rewrite the key string and the eviction path. |
| `roofs.ts` `Baked` version tag, `setBand()` staleness test, `pump()` reuse | `wallVer[]` + a second version field; `setBand` compares both (D11) | `sunVer` + `(band, step)` sprite map; `pump`'s "shadow is damage-independent" reuse becomes false (N5, §5.3) | Both add a version field and both rewrite the same comparison. |

**Name the shared mechanism so one implementation serves both: a per-artifact version record.**

```ts
interface Baked {
  roof: HTMLCanvasElement;  wallS: HTMLCanvasElement;  wallE: HTMLCanvasElement;
  shadow: HTMLCanvasElement;  sx: number; sy: number; sw: number; sh: number;  // §5.2
  ver: { dmg: number; wall: number; sun: number };
}
```

`setBand()` and `pump()` compare the record field-wise and rebake **only** the artifacts whose
governing field moved: `dmg` → `roof`; `wall` → `wallS`/`wallE` and the re-derived `openS`/`openE`;
`sun` → `shadow` (+ `roof` only when the plan has a spire, flashing, or weathering bias). That
single structure subsumes D11's "compare both versions" and this design's sun rebake, and it
expresses the §9.1 optimisation for free.

For terrain the shared piece is smaller but sharper: **`invalidateEdge` must delete across every
sunStep as well as every band.** If it does not, the sun-aware `fallback()` (§5.1 priority 2)
will happily resurrect a pre-breach chunk from a stale sun step and the breached wall will
reappear at full resolution the next time the camera moves. That is a genuine cross-lane bug
that neither lane's tests would catch alone, because each is correct in isolation. Whichever
lane lands second owns the combined test.

**Sequencing recommendation:** let **D9/D11 land first** — that lane is specced, in flight, and
its invalidation is spatial and subtle, whereas the sun's is wholesale and mechanical. N4/N5 then
add one key component and one version field to structures already shaped to accept them. If the
order inverts, N4/N5 must ship the generalised shapes (the version *record*, the multi-axis
`fallback()`) so D9/D11 reduce to one field and one loop each.

**Also in flight:** the plan-projection commits (`617e266`, `a12a82d`, `28eb004`, `b396732`,
`53aa40a`) live on the interiors worktree, not on main. They add `shadowOffset` call sites
(`castSlab()` sweeping a footprint along the offset into one connected shadow; named heights
`AWNING_H 2.3` / `SIGN_H 2.5` / `TRESTLE_H 0.8`; a wall's SE flank re-expressed as a second
softer shadow layer). All of them are inside terrain chunk bakes, so they inherit the sunStep
key automatically — **but `castSlab()` is a swept-geometry shadow, not an offset blit**, so its
shape is genuinely direction-dependent and a low sun will stretch it 3×. Re-review that function
against `lenMul` once both lanes are on main; it is the one place where a rotating sun changes
shadow *topology* rather than just its offset.

---

## 11. FUTURE — named and explicitly out of scope

Listed so nobody designs around their absence, and so nobody sneaks them in:

- **Flares and illumination rounds.** A mortar illum round or a parachute flare as a moving,
  expiring local light that lifts `spotCap` in a radius. Genuinely great, genuinely a whole
  second lighting system (a per-source radial term inside the sense funnel, plus a bright
  additive world sprite). Not now.
- **Moon phase / moonlight.** Would make the night floor vary by campaign day. One more input
  to a function that currently has one; cheap to add later, no structural cost to omitting.
- **Weather and overcast.** Would multiply `alphaMul` and flatten `ambient`. Composes cleanly
  with everything above — it is another multiplier on the same three quantities.
- **Vehicle headlights, building window light, blackout discipline.** Same objection as flares.
- **Night ambience audio.** `src/render/audio.ts` (`AudioEngine`) is a procedural WebAudio layer
  with no ambience bed at all today. A night bed, and attenuating the daytime layers, is real
  polish and is **not designed here** — noted only so it is visible on the roadmap. One
  adjacent freebie *is* in scope as N14 because it is a bug rather than a feature:
  `renderer.drawBirds` puts birds over the battlefield at 02:00.
- **A player-facing time-of-day scenario picker.** The hour comes from the campaign clock. A
  skirmish-mode hour selector is a menu feature, not a lighting feature.

---

## 12. Tasks

Lane **A** = sim (`src/sim/**`, `src/strategic/**`), Lane **B** = render + tooling
(`src/render/**`, `scripts/**`). Sizes: **S** ≈ a sitting, **M** ≈ a day, **L** ≈ multi-day.

| # | Lane | Size | Task | Files | Deps |
|---|---|---|---|---|---|
| **N1** | A | **M** | `src/sim/solar.ts`: pure solar geometry (LAT 49.2, DECL +21, DBST 2 h), `elevationAt`/`azimuthAt`, `sunStepOf` (18° az × 5° el buckets, §2.3), `SunState` derived from bucket **centres**, `lenMul` (cot ratio, clamp 3.0), `alphaMul`/`softMul` (smoothstep −6→+25), `ambientAt` ramp (§3.1), `CANON_CLOCK_MIN = 840`. No DOM, no RNG — the `src/sim/wind.ts` precedent verbatim. `tests/light.test.ts`: freeze `sunAt(CANON).dir === normalize(0.45,0.55)` to 1e-9, `lenMul === 1`, `alphaMul === 1`, `ambient.a === 0`, bucket stability across ±15 min. | `src/sim/solar.ts`, `tests/light.test.ts` | — |
| **N2** | B | **S** | `src/render/light.ts` adapter: re-export solar (WIND pattern), `setSun(clockMin) → bool stepChanged`, `SUN` as getters, `shadowOffset` × `lenMul`, `shadowAlpha()`/`shadowSoftAlpha()`. Header comment stating the singleton invariant (§2.4). Zero consumer edits — `npm run check` must pass on all ~45 call sites untouched. | `src/render/light.ts` | N1 |
| **N3** | A | **S** | `Sim.startMin` (default `CANON_CLOCK_MIN`), `get clockMin()`, `get light()` — pure in `(startMin, tick)`, **not** in `snapshot()`. `makeStrategicBattle` sets `sim.startMin = front.clockMin`. `?hour=HHMM` in `main.ts` next to `?camp`/`?seed`/`?fow`, plus `renderer.setSun` wired from `sim.clockMin` per frame. | `src/sim/sim.ts`, `src/strategic/bridge.ts`, `src/main.ts` | N1, **N12 merged** |
| **N4** | B | **M** | Terrain keyspace: key `` `${cx},${cy},${band},${sunStepFor(band)}` ``, `sunStepFor` collapsing bands ≤ 8 to 0; `fallback()` 3-tier priority (§5.1); pixel ledger exact across the widened space; `canopySprite` key gains sunStep. **Conflicts with D9** — adopt or provide the shared invalidation shape (§10). | `src/render/terrain.ts`, `src/render/canopy.ts` | N2 |
| **N5** | B | **M** | Roofs: sprite map keyed `` `${band}:${sunStep}` `` with keep-current+prev eviction; `Baked.ver` → the version **record** (§10); shadow rect `sx/sy/sw/sh` moves `RoofArt` → `Baked` (§5.2); `bakeShadow` blur × `softMul`; `pump()` per-artifact reuse; `drawShadows` on-screen pad × `lenMul`. **Conflicts with D11.** | `src/render/roofs.ts` | N2 |
| **N6** | B | **S** | Draw-path reorientation (§4.1): per-frame `SUN_A`; `SHADOW_OFF`/`HULL_SHADOW_OFF`/`EMPL_SHADOW_OFF` × `lenMul`; elongation and alphas scaled; `drawUnitShadows` early-out below `alphaMul` 0.02; `drawTops` PARALLAX rotates; `drawStairs`' hard-coded NW tread lip derived from `SUN` and faded by `alphaMul`. Audit each non-cast use of `SHADOW_SOFT_ALPHA` individually. | `src/render/renderer.ts`, `src/render/roofs.ts`, `src/render/terrain.ts` | N2 |
| **N7** | B | **M** | Ambient grade + hot-pass hoist: `gradeWorld()` as the final draw inside the `worldShake` save/restore, `fillRect(-24,-24,cw+48,ch+48)`, **source-over not multiply** (§3.1); collect every `hotPass` additive draw into a `drawHot()` running after the grade (§3.3). Reshoot the `vfx.mjs` gate — one reviewed reshoot, called out in the commit. | `src/render/renderer.ts`, `src/render/fx.ts` | N2 |
| **N8** | A | **M** | Night sim rules: `spotCap(light)` **absolute cap** in `updateSpotting` + `sideSeesPoint` (§7.1 — a multiplier is measurably inert, do not use one); `concealNeed`/`hideFloor` ramps inside `sightToSoldier` (§7.2). Read `sim.light` inside the funnel, never as a new argument (§7.3). Zero RNG draws. | `src/sim/sim.ts` | N3 |
| **N9** | A | **S** | Test pinning (§7.4 table): `tests/night.test.ts` (new) purity + monotonicity + hide/see pair; `tests/sim.test.ts` FoW block gains the 60 m/20 m night pair and a CANON-is-unchanged snapshot assert; `tests/doctrine.test.ts` night A/B asserting *direction* only, plus a natural-dynamics liveness probe (per *forced-precondition-tests-hide-dead-features*); `tests/campaign.test.ts` clock propagation + `nightMult=1.0` bit-identity. | `tests/night.test.ts`, `tests/sim.test.ts`, `tests/doctrine.test.ts`, `tests/campaign.test.ts` | N8, N11 |
| **N10** | B | **S** | Strategic day/night: `ambientAt()` wash over the sector-map region only (not header, not panels); **fix `drawTimeRing`'s hard-coded 06:00–18:00 daylight test** to `elevationAt(clockMin) > 0` (§6 — it is wrong today and will visibly contradict the graded battlefield). | `src/render/strategic.ts` | N1 |
| **N11** | A | **S** | Coarse resolver: `nightMult` in `resolveCoarse`'s `terrainMult` chain, value **1.0**; a 16-seed campaign-length sweep script that measures the current war-length/outcome distribution and can re-measure a candidate. **Do not pick a number without the sweep** (§6). | `src/strategic/bridge.ts`, `scripts/` (new sweep) | N3 |
| **N12** | B | **S** | **Art-gate hour pin — merge gate, lands before N3.** `gotoStaged({ hour = CANON_CLOCK_MIN })` setting `front.clockMin` before `startEngagementBattle`; `sweep.mjs` preflight asserting the canonical hour alongside the dpr/mobile asserts; `shot.mjs --hour` + `dawn`/`dusk`/`night` presets. Verify `place()`'s 120-frame settle cap still quiesces a cold non-canonical scene (§8). | `scripts/lib/stage.mjs`, `scripts/sweep.mjs`, `scripts/shot.mjs` | — |
| **N13** | B | **S** | New sweep rows: `--hour 0700` and `--hour 0200`, **2 seeds × 2 crops** (`village`/`place`, `units`) = 8 shots, added as new rows so no existing baseline moves. | `scripts/sweep.mjs` | N12, N4, N5, N7 |
| **N14** | B | **S** | Perf + night polish: `bake.mjs` timings for a bourg chunk at band 32 before/after the keyspace change and a full sun-step drain; a perf case asserting a sun step drains within N frames and that **night frames are not slower than day frames** (§9.1); suppress `drawBirds` below civil twilight. Note night audio ambience as FUTURE, do not build it. | `scripts/bake.mjs`, `tests/perf.test.ts`, `src/render/renderer.ts` | N4, N5, N7 |

### Sequencing

```
merge gate:  N12 ────────────────────────────┐
                                             ▼
N1 ──┬── N2 ──┬── N4 ──┐                   N3 ──┬── N8 ──┐
     │        ├── N5 ──┤                        ├── N11 ─┴── N9
     │        ├── N6 ──┼──► N13, N14
     │        └── N7 ──┘
     └── N10
```

Batch 1 (no deps): **N1, N12**. Batch 2: **N2, N10**, then **N3**. Batch 3 (parallel, but N4/N5
must reconcile with the destructible lane first): **N4, N5, N6, N7, N8, N11**. Batch 4:
**N9, N13, N14**.

---

## 13. Decisions, compressed

1. **Map-north is defined as today's shadow direction**, so solar noon reproduces the shipped
   art byte-for-byte and the whole feature is a deviation from a fixed point. (§1)
2. **Solar math lives sim-side** (`src/sim/solar.ts`), re-exported by `render/light.ts` — the
   `WIND` precedent, verbatim. (§0)
3. **Quantize on azimuth and elevation, not on time**; bands ≤ 8 pin to step 0, which deletes
   the only bad perf case. (§2.3, §9.1)
4. **`SUN`/`shadowOffset` keep their signatures**; ~45 consumers are untouched, and the mutable
   singleton is safe because every reader is either per-frame or inside a sun-keyed bake. (§2.4)
5. **The roof shadow bbox moves onto `Baked`**; worst-case padding was budgeted at 55 MB and
   rejected. (§5.2)
6. **Ambient grade is source-over, never multiply** — night must lift blacks, not crush them.
   (§3.1)
7. **Hot FX hoist above the grade** — the free-punch premise is true only in that order, and it
   costs one reviewed VFX-gate reshoot. (§3.3)
8. **Night spotting is an absolute cap, not a multiplier**, because SPOT_RANGE is measured-inert
   above ~60 m. (§7.1)
9. **Darkness lowers the concealment threshold**, making night the ambusher's weather while the
   first-volley reveal still holds. (§7.2)
10. **`resolveCoarse` gets the hook at 1.0 and the sweep, not a guessed constant.** (§6)
11. **The hour pin is a merge gate, not a dependency** — without it the sun model silently
    reshoots every art baseline as a night frame. (§8)
12. **Shared with destructible terrain: a per-artifact version record and a sun-aware
    `invalidateEdge`.** One implementation serves both lanes; the second lane owns the combined
    test. (§10)
