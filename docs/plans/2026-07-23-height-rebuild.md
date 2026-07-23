# Height System Rebuild — Implementation Spec

Rebuild of the lost `worktree-height` branch (worktree deleted unmerged; no git
objects recoverable). Target behavior below is the authoritative spec, distilled
from the original session brief.

## Hard constraints (must not regress)

1. **Headless determinism**: NO RNG in LOS or any sim logic. Same seed → identical
   `Sim.snapshot()` every run (tests/sim.test.ts invariant). Any new mutable
   Soldier/Sim field MUST be added to `Sim.snapshot()`.
2. **Perf**: 247 soldiers at ~18 ms p95 headless (tests/perf.test.ts). LOS is hot —
   keep the 2.5D profile check allocation-free.
3. `map.ts`'s `los()` stays pure map geometry; smoke stays layered in
   `sim.ts sightBetween()` only.
4. Commit hooks BLOCK the `Co-Authored-By` trailer — never add it.
5. tsc clean + full `npm test` green after every phase.

## Constants

- `FLOOR_H = 3` (m per story), `EYE_H = 1.6` (m eye height above feet).
- Eye z at tile (x,y) level L: `elev[x,y] + L*FLOOR_H + EYE_H`.

## Phase A — sim core

### GameMap (src/sim/map.ts) new fields

- `elev: Uint8Array` (w*h) — terrain elevation, meters. 0 = flat.
- `stories: Uint8Array` (w*h) — building story count on floor tiles, else 0.
- `buildingId: Int16Array` (w*h) — -1 outside buildings; same id = same building.
- `stairs: Uint8Array` (w*h) — 1 = stair tile (inside a building, connects levels).
- `hEdgeTops: Uint8Array` / `vEdgeTops: Uint8Array` — stamped top height (m) of a
  WALL edge; 0 = full-height block (legacy behavior for edges never stamped).
  Windows/doors don't need tops (they pass sight today).
- `maxStories: number` — highest story count on the map (0 = no buildings w/ upper floors).
- Accessors mirroring existing style: `elevAt(x,y)`, `storiesAt(x,y)`,
  `buildingIdAt(x,y)`, `isStair(x,y)`, `hEdgeTop(x,y)`, `vEdgeTop(x,y)`.

### TerrainDef (src/sim/data.ts)

- Add optional `featureHeight?: number` — physical height (m) of the terrain
  feature for the LOS profile check. Set: `woods` ≈ 8 (tree canopy), `hedge` ≈ 2
  (bank + growth). Others omitted.

### los() 2.5D profile check (src/sim/map.ts)

Extend the existing Amanatides & Woo traversal. New optional params
`l0 = 0, l1 = 0` (observer/target floor levels). The eye-to-eye line is lerped in
t (0→1) between `z0 = elev(tx0,ty0) + l0*FLOOR_H + EYE_H` and
`z1 = elev(tx1,ty1) + l1*FLOOR_H + EYE_H`.

Rules, evaluated as the ray crosses each tile/edge:

1. **Ground occlusion**: in each entered intermediate tile, if
   `elev(tile) >= lineZ(tEntry)` the ray is blocked (hill crest). (Same-tile
   observer/target exempt, matching the current early return.)
2. **Wall top**: a WALL edge blocks only if `lineZ(tCross) < edgeTop(edge)`.
   `edgeTop` = stamped top; 0 means full-height (block regardless) so legacy maps
   behave identically.
3. **Feature skip**: terrain with `featureHeight` (hedge/woods) does NOT
   accumulate opacity when `lineZ` over that tile clears `elev(tile) + featureHeight`
   (shooting over the canopy). Below the clearance height, current opacity/cover
   behavior is unchanged.
4. **Floor/ceiling (buildingId heuristic)**: if observer and target tiles share a
   `buildingId >= 0` and `l0 !== l1`, return blocked (the floor/ceiling between
   them). This is the accepted heuristic — gable-above-wall unmodeled, per-story
   windows on shared edges unmodeled (record in docs/decisions).

`LosResult` unchanged. Keep the function allocation-free (perf test).

### Soldier + movement (src/sim/sim.ts)

- `Soldier` gains `level: number` (floor, 0-based) and `climbLeft: number`
  (ticks remaining of a stair climb; while > 0 the soldier is on the stairs,
  treated as transitioning — no level change until it completes, or simplest
  faithful behavior: level flips at completion).
- `advance()`: entering a stair tile with a move path continuing into a
  different-level intent starts a climb (climbLeft = climb duration, ~1 s =
  30 ticks); on completion, level ±1. Direction from the path/order target level.
- Movement between levels ONLY via stair tiles. `canStep` unchanged (2D);
  vertical transitions are stair-mediated, not edges.

### Level-aware A* (src/sim/path.ts)

- Node id becomes `l*w*h + y*w + x`. The level axis buffers are allocated LAZILY
  — only when a search actually needs levels > 0 (start/goal level > 0 or a stair
  is reachable). Ground-only searches keep the current single-layer buffers and
  perf. Neighbors: 2D steps on the same level + vertical step on stair tiles
  (cost ~2). `astar` gains optional `sl = 0, gl = 0` level params and returns
  `{x, y, l}[]`.

### Sight threading (src/sim/sim.ts + all callers)

- `sightBetween(sim, x0, y0, x1, y1, l0 = 0, l1 = 0)` — passes levels to los().
- `sightToSoldier(sim, x0, y0, t, l0 = 0)` — target level is `t.level`.
- Thread observer level through EVERY soldier-endpoint sight caller:
  acquire/fire (sim.ts ~1394, 1889, 2826, 3020), AT guns / panzerfaust
  (~2179, 2202), tank terror / apSolution (~1721, 1745, 1767), vehicle MG
  (1136), spotting/FoW (2641, 2645, 2678), ai.ts:249, emplacement.ts:89,97,
  orders.ts:45,81. Vehicles/emplacements are always level 0.
- Snapshot: add `s.level` and `s.climbLeft`.

## Phase B — mapgen (src/sim/mapgen.ts)

- **Cosine hill domes**: after ALL existing generation (last rng position, so
  existing rng consumption order is untouched → 2D geometry byte-identical per
  seed). 2–4 domes: center + radius from rng, `elev = round(peak * 0.5 *
  (1 + cos(pi * min(1, d/r))))`, peak 3–8 m. Skip tiles that are road, water,
  building floor, or within 1 of a building (hills don't lift structures — a
  building on a dome edge keeps its base elev via its own tiles being skipped).
- **2-story village houses**: buildings with footprint w*h >= 56 tiles get
  `stories = 2`, a `buildingId` (unique per building, assigned for ALL buildings,
  1-story included), WALL edge tops stamped at `FLOOR_H` for story 1 and
  `2*FLOOR_H` where a second story exists... simpler faithful rule: stamp every
  exterior wall edge of a 2-story building with top = `2*FLOOR_H`; 1-story
  buildings stamp `FLOOR_H`. Stair: back corner (corner farthest from the door)
  interior tile marked `stairs = 1`.
- `map.maxStories` computed at end.
- Regenerate mapgen fingerprints in tests/mapgen.test.ts to whatever this
  implementation produces (fingerprints now cover elev/stories too — extend the
  fingerprint hash to include the new arrays so elevation regressions are caught).

## Phase C — orders & UI

- **Auto-garrison**: `defend`/`ambush` orders on a 2-story building place members
  on the TOP floor (level = stories-1) when a stair path exists (src/sim/orders.ts
  + sim order execution).
- **Floor menu**: Alt+right-click on a multi-story building opens a small DOM menu
  (new src/ui/floormenu.ts) listing floors; choosing one issues the garrison/move
  order at that level. Empty state: single-story → no menu. Edge: no stair access
  → upper floors disabled with reason.
- **pickAt tie** (src/ui/tooltip.ts): an exact positional tie between soldiers on
  different levels resolves to the UPPER soldier. Same for click-selection in
  src/main.ts.

## Phase D — render

- **terrain.ts**: one-sun hillshade — per elevation tile, lambertian shade from a
  fixed sun (NW), drawn as a light multiply/overlay pass; stair glyph (⌂-style
  chevron or "≡" steps) rendered on stair tiles.
- **roofs.ts**: roof drop-shadow offset × stories (taller = longer shadow);
  roof-fade keyed on `sim.soldierVisibleTo` for upper-floor occupants (fade the
  roof of a floor a visible soldier occupies so you can see inside).
- **renderer.ts drawSoldier**: upper-floor sprite scale ×1.06.

## Phase E — legibility pass (designed 2026-07-23 against the landed redesign)

Problem: an upstairs soldier is distinguishable only by ×1.06 sprite, a tooltip
line, and roof fade — no at-a-glance floor reading, no explanation when a shot is
floor-blocked. Empty/edge states first: everything below is a no-op on flat maps
(maxStories=0) and for level-0 soldiers.

1. **Floor badge** (renderer.ts drawSoldier): small dark chip with the floor
   number (`2` at level 1, …) above the sprite when `s.level > 0`, only when
   `cam.scale >= SPRITE_MIN_SCALE` (sprite path). At dot zoom (drawDot), a white
   ring around upper-floor dots. Level 0 → nothing drawn.
2. **Floor-aware draw order** (renderer.ts draw): within each existing category
   pass (dead/downed/living), iterate `level 0..maxStories` ascending so upper
   floors paint on top. maxStories=0 → exactly the current single pass.
3. **Floor focus filter** (main.ts + renderer): `F` key (registered in keymap.ts
   once the controls pass lands — until then a direct keydown listener) cycles
   floor focus: All → Ground → Floor 2 → … → All (range from map.maxStories).
   Non-focused-floor soldiers draw at 40% alpha; HUD/status line shows the focus
   when active. maxStories=0 → key does nothing, no HUD change.
4. **Shot-preview floor-blocked cue** (tooltip.ts computeShot + overlays.ts):
   when the shot reason would be `no-los`, re-run `sightToSoldier` with the
   observer level FORCED to the target's level; if that clears LOS, the block is
   vertical separation — reason becomes `'floor-blocked'`, text
   `blocked by floor/ceiling`. overlays.ts branches on reason: add the case
   (same styling family as no-los, distinct label). Deterministic — UI-side
   derived data only, sim untouched.

## Verification

- `node_modules/.bin/tsc --noEmit` clean.
- `npm test` green (update mapgen fingerprints; all other tests must pass
  UNCHANGED — height must be invisible to flat maps: elev all 0, no stories ⇒
  identical behavior to before).
- Determinism: snapshot-equality tests unchanged and green.
