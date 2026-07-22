# Mapgen v2 — Bocage Believability + Scale

**Goal:** Make generated maps read unmistakably as Normandy — distinct hedgerows, plowed fields, outlying farm compounds with lanes, orchards — and prove the generator at large sizes (320×240) with a second hamlet.

**Architecture:** All generation stays in `src/sim/mapgen.ts` (headless, seeded-rng-only, self-validating via A*). New terrain types are pure data (`src/sim/data.ts`) + art (`src/render/terrain.ts`); one vehicle-blocking rule lands in `src/sim/map.ts`. The `MapPlan {map, buildings, spawns, objectives}` contract is unchanged except `objectives` may grow a third entry (hamlet) on large maps.

**Tech stack:** TypeScript, Vite, Canvas 2D, vitest. Commands: `npx vitest run` (add `-u` only when a task legitimately changes generated geometry — eyeball the fingerprint diff), `npm run check` (tsc), `npm run dev -- --port 5197 --strictPort`.

**Global constraints (violations = task failure):**
1. Determinism: `src/sim/mapgen.ts` uses ONLY the passed mulberry32 rng. No `Math.random`, no `Date`, no `Math.hypot` (not correctly-rounded across engines — use squared distances). Same seed+size → byte-identical map.
2. `TERRAIN` keys are APPEND-ONLY at the end of the object literal in `src/sim/data.ts` — tile bytes are indexes into `Object.keys(TERRAIN)`; reordering corrupts every map.
3. Walls/doors/windows live on tile EDGES (`hEdges`/`vEdges`) — never solid wall tiles.
4. `plan.buildings[0..2]` must remain the village cluster (scenario.ts indexes them for spawns/posts). Farm/hamlet buildings append AFTER the village ones.
5. Hedge and woods stay vehicle-impassable; roads stay clear by construction (carved last, buildings rejected near roads).
6. DO NOT touch `src/main.ts`, `src/campaign/**`, `src/strategic/**`, `src/ui/**`, `src/sim/scenario.ts` — a parallel session (M-A plan) owns them. If main has moved when you start: merge main into your branch FIRST, run tests, then begin (see memory: design-sequencing-2026-07).
7. After every task: `npx vitest run` green, `npm run check` green, commit. No remote (push is a no-op). A hook blocks the `Co-Authored-By` trailer — omit it.

**Execution note:** Tasks 1–4 all modify `src/sim/mapgen.ts` — run them SEQUENTIALLY (one builder subagent per task, separate validator agent per task in fresh context). Task 5 is browser verification, last. Do not run builders in parallel on this plan.

## File map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/sim/data.ts` | modify | +`hedge`, +`field` terrain defs (appended) |
| `src/sim/map.ts` | modify | vehicles blocked by `hedge` (one line in `canStep`) |
| `src/sim/mapgen.ts` | modify | hedgerows use `hedge`; +fields, +farms with lanes, +orchards, +second hamlet on large maps |
| `src/render/terrain.ts` | modify | hedge shrub art, field furrow art, isolated-tree draw rule |
| `tests/mapgen.test.ts` | modify | behavioral tests per task + updated snapshots |

Current anchors (verified 2026-07-22 at commit 8d34aa1): `data.ts:9-14` TERRAIN object; `map.ts:59-72` canStep; `terrain.ts:43-79` drawTileBase, `terrain.ts:81-101` drawTree, call site `terrain.ts:159`; `mapgen.ts` — hedgeLine ~line 118, stands ~line 140, roads-last ~line 158, `addBuilding` ~line 173, `validate` ~line 190.

---

### Task 1: `hedge` + `field` terrain types

**Files:**
- Modify: `src/sim/data.ts` (TERRAIN object)
- Modify: `src/sim/map.ts` (canStep)
- Modify: `src/sim/mapgen.ts` (hedgeLine writes `hedge`; new field patches)
- Modify: `src/render/terrain.ts` (two drawTileBase branches)
- Test: `tests/mapgen.test.ts`

**Interfaces:** produces terrain keys `'hedge'` and `'field'` for all later tasks. Hedge sim profile: slow (1.8×), cover 0.35, opacity 0.5 (two hedges block LOS, one doesn't), vehicle-impassable. Field: near-grass (1.1×, cover 0.05).

- [ ] In `src/sim/data.ts`, append inside `TERRAIN` after `floor` (append-only — constraint 2):
```ts
  hedge: { color: '#2f4a28', moveCost: 1.8, cover: 0.35, opacity: 0.5, passable: true },
  field: { color: '#6a7245', moveCost: 1.1, cover: 0.05, opacity: 0, passable: true },
```
- [ ] In `src/sim/map.ts` `canStep`, replace `if (k === 'floor' || k === 'woods') return false;` with:
```ts
      if (k === 'floor' || k === 'woods' || k === 'hedge') return false;
```
- [ ] In `src/sim/mapgen.ts` `hedgeLine`, change the write `map.setTerrain(x, y, 'woods')` to `map.setTerrain(x, y, 'hedge')` (woods stands keep `'woods'`).
- [ ] In `src/sim/mapgen.ts`, AFTER the woods-stands block and BEFORE the roads-last carve, add field patches:
```ts
  // plowed fields: rect patches on remaining grass
  for (let i = 0, n = 4 + rng.int(4); i < n; i++) {
    const fw = 12 + rng.int(14);
    const fh = 8 + rng.int(10);
    const fx = 2 + rng.int(Math.max(1, w - fw - 4));
    const fy = 2 + rng.int(Math.max(1, h - fh - 4));
    for (let y = fy; y < fy + fh; y++)
      for (let x = fx; x < fx + fw; x++)
        if (!road[y * w + x] && !nearBuilding(x, y) && map.terrainKeyAt(x, y) === 'grass') map.setTerrain(x, y, 'field');
  }
```
- [ ] In `src/render/terrain.ts`, add const `const FIELD: [number, number, number] = [106, 114, 69];` next to the other palette consts, and in `drawTileBase` insert before the final `else` (floor) branch:
```ts
  } else if (t === 'hedge') {
    g.fillStyle = shade(WOODS_GROUND, v * 0.92);
    g.fillRect(x, y, 1, 1);
    for (let i = 0; i < 3; i++) {
      const cx = x + 0.2 + hash(x, y, 50 + i) * 0.6;
      const cy = y + 0.2 + hash(x, y, 55 + i) * 0.6;
      const r = 0.28 + hash(x, y, 60 + i) * 0.2;
      g.fillStyle = shade([52, 82, 44], 0.8 + hash(x, y, 65 + i) * 0.4);
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
  } else if (t === 'field') {
    g.fillStyle = shade(FIELD, v);
    g.fillRect(x, y, 1, 1);
    g.fillStyle = 'rgba(0,0,0,0.10)';
    g.fillRect(x, y + 0.15, 1, 0.12);
    g.fillRect(x, y + 0.65, 1, 0.12);
  }
```
- [ ] Add to `tests/mapgen.test.ts`:
```ts
  it('hedgerows block vehicles but not infantry', () => {
    const p = generateMap(3);
    let hx = -1, hy = -1;
    for (let y = 1; y < p.map.h - 1 && hx < 0; y++)
      for (let x = 1; x < p.map.w - 1 && hx < 0; x++)
        if (p.map.terrainKeyAt(x, y) === 'hedge') { hx = x; hy = y; }
    expect(hx).toBeGreaterThanOrEqual(0);
    expect(p.map.canStep(hx - 1, hy, hx, hy, 'vehicle')).toBe(false);
    expect(p.map.canStep(hx - 1, hy, hx, hy)).toBe(true);
  });
```
- [ ] Run `npx vitest run` — expect FAILURES only in the two fingerprint snapshots (geometry legitimately changed). Run `npx vitest run -u`, confirm all green (expect 60 tests: 59 + 1 new).
- [ ] Run `npm run check` — expect clean exit.
- [ ] Commit: `git add -A && git commit -m "Mapgen v2: hedge + field terrain types (hedgerows vehicle-blocking via terrain, plowed-field patches)"`

### Task 2: Farm compounds with lanes

**Files:**
- Modify: `src/sim/mapgen.ts` (farm placement after village buildings, before the `nearVillage`/hedge section)
- Test: `tests/mapgen.test.ts`

**Interfaces:** appends house+barn `Building` pairs to `buildings` (AFTER village entries — constraint 4) and extends the `road` mask with 1-wide lanes before hedges/stands read it. `validate()` already foot-checks every building, so farms are connectivity-validated for free.

- [ ] In `src/sim/mapgen.ts`, immediately after `if (buildings.length < 4) return null;` add:
```ts
  // outlying farm compounds: house + barn joined to the arterial by a lane
  for (let f = 0, n = 2 + rng.int(2); f < n; f++) {
    for (let tries = 0; tries < 60; tries++) {
      const fx = 8 + rng.int(w - 28);
      const fy = 8 + rng.int(h - 26);
      if ((fx - crossX) * (fx - crossX) + (fy - cy) * (fy - cy) < 35 * 35) continue;
      const house: Building = { x: fx, y: fy, w: 6 + rng.int(3), h: 5 + rng.int(2) };
      const barn: Building = { x: fx, y: fy + house.h + 3, w: 5 + rng.int(3), h: 4 + rng.int(2) };
      if (barn.y + barn.h > h - 3 || fx + Math.max(house.w, barn.w) > w - 4) continue;
      if (touchesRoad(house) || overlaps(house) || touchesRoad(barn) || overlaps(barn)) continue;
      buildings.push(house, barn);
      doorSides.push('s', 'n'); // both doors open onto the shared yard row
      const lx = Math.min(w - 3, fx + Math.max(house.w, barn.w) + 1);
      const target = roadY[lx];
      const step = fy + house.h + 1 < target ? 1 : -1;
      for (let yy = fy + house.h + 1; yy !== target; yy += step) road[yy * w + lx] = 1;
      break;
    }
  }
```
(Note: `overlaps` checks against everything already in `buildings`, so the barn placed in the same iteration is NOT overlap-checked against its own house — their fixed 3-row gap guarantees separation. The lane is written into `road` BEFORE hedges/stands run, so those passes part around it automatically, and the roads-last carve renders it.)
- [ ] Add to `tests/mapgen.test.ts`:
```ts
  it('village buildings stay first; farms append after (seeds 1-15)', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const p = generateMap(seed);
      for (const b of p.buildings.slice(0, 3)) {
        const d2 = (b.x - p.objectives[0].x) ** 2 + (b.y - p.objectives[0].y) ** 2;
        expect(d2).toBeLessThan(30 * 30);
      }
    }
  });
```
- [ ] Run `npx vitest run -u` (snapshots change again) — all green, 61 tests. `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "Mapgen v2: outlying farm compounds (house+barn) with lanes to the road net"`

### Task 3: Orchards + isolated-tree art rule

**Files:**
- Modify: `src/sim/mapgen.ts` (orchard grids, after woods stands / before field patches)
- Modify: `src/render/terrain.ts` (drawTree gains a map param; isolated woods tiles always draw a tree)
- Test: `tests/mapgen.test.ts`

**Interfaces:** orchards are staggered single `woods` tiles (light cover, vehicles weave between rows); the art rule "isolated woods tile always draws its tree" is what makes the regular grid read as an orchard.

- [ ] In `src/sim/mapgen.ts`, after the woods-stands `for` loop and before the field patches from Task 1:
```ts
  // orchards: staggered tree rows near the village
  for (let i = 0, n = 1 + rng.int(2); i < n; i++) {
    const ow = 8 + rng.int(7);
    const oh = 6 + rng.int(5);
    const ox = clamp(crossX - 30 + rng.int(Math.max(1, 60 - ow)), 2, w - ow - 2);
    const oy = clamp(cy - 26 + rng.int(Math.max(1, 52 - oh)), 2, h - oh - 2);
    for (let y = oy; y < oy + oh; y += 2)
      for (let x = ox + (((y - oy) >> 1) % 2); x < ox + ow; x += 2)
        if (!road[y * w + x] && !nearBuilding(x, y) && map.terrainKeyAt(x, y) === 'grass') map.setTerrain(x, y, 'woods');
  }
```
- [ ] In `src/render/terrain.ts`, change `drawTree` signature to `function drawTree(g: Ctx, map: GameMap, x: number, y: number): void` and replace its first line with:
```ts
  const wooded = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'woods';
  const isolated = !wooded(x - 1, y) && !wooded(x + 1, y) && !wooded(x, y - 1) && !wooded(x, y + 1);
  if (!isolated && hash(x, y, 40) >= 0.55) return;
```
Update the call site in the chunk loop: `drawTree(g, this.map, x, y);`
- [ ] Add to `tests/mapgen.test.ts`:
```ts
  it('orchards plant isolated trees (seeds 1-5)', () => {
    let isolatedTrees = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const p = generateMap(seed);
      for (let y = 1; y < p.map.h - 1; y++)
        for (let x = 1; x < p.map.w - 1; x++) {
          if (p.map.terrainKeyAt(x, y) !== 'woods') continue;
          if (
            p.map.terrainKeyAt(x - 1, y) !== 'woods' &&
            p.map.terrainKeyAt(x + 1, y) !== 'woods' &&
            p.map.terrainKeyAt(x, y - 1) !== 'woods' &&
            p.map.terrainKeyAt(x, y + 1) !== 'woods'
          ) isolatedTrees++;
        }
    }
    expect(isolatedTrees).toBeGreaterThan(20);
  });
```
- [ ] `npx vitest run -u` all green (62 tests). `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "Mapgen v2: orchards (staggered tree rows) + isolated woods tiles always draw a tree"`

### Task 4: Second hamlet + 320×240 scale proof

**Files:**
- Modify: `src/sim/mapgen.ts` (settlement list, second cross lane + hamlet cluster when `w >= 240`, area-scaled stand count)
- Test: `tests/mapgen.test.ts`

**Interfaces:** on maps `w >= 240`, `plan.objectives` gains `[2] = hamlet junction`. `spawns`/`buildings[0..2]` contracts unchanged. This task refactors the building-candidate loop into a reusable `placeCluster` — keep behavior at 160×120 identical in SHAPE (snapshot values may shift only if rng call order changes; prefer a refactor that keeps the 160×120 rng sequence intact by only adding calls inside `if (w >= 240)` branches, and verify: fingerprints for seeds 1 and 2 must be UNCHANGED by this task).

- [ ] In `src/sim/mapgen.ts`, wrap the existing village building-candidate `for (let tries…)` loop body in a local closure parameterized by junction and lane, defined where the loop currently sits:
```ts
  const placeCluster = (jx: number, jy: number, laneX: Int32Array, count: number, span: number): void => {
    for (let tries = 0; tries < 300 && buildings.length < count; tries++) {
      const bw = 6 + rng.int(7);
      const bh = 5 + rng.int(5);
      let b: Building;
      let door: 'n' | 's' | 'e' | 'w';
      if (rng.next() < 0.6) {
        const bx = clamp(jx - span + rng.int(Math.max(1, span * 2 + 1 - bw)), 2, w - bw - 3);
        const north = rng.next() < 0.5;
        let edge = north ? h : 0;
        for (let x = bx; x < bx + bw; x++) edge = north ? Math.min(edge, roadY[x] - 1) : Math.max(edge, roadY[x] + 1);
        b = { x: bx, y: north ? edge - bh - 1 : edge + 2, w: bw, h: bh };
        door = north ? 's' : 'n';
      } else {
        const by = clamp(jy - span + 2 + rng.int(Math.max(1, span * 2 - 3 - bh)), 2, h - bh - 3);
        const west = rng.next() < 0.5;
        let edge = west ? w : 0;
        for (let y = by; y < by + bh; y++) edge = west ? Math.min(edge, laneX[y]) : Math.max(edge, laneX[y] + 1);
        b = { x: west ? edge - bw - 1 : edge + 2, y: by, w: bw, h: bh };
        door = west ? 'e' : 'w';
      }
      if (b.x < 2 || b.y < 2 || b.x + b.w > w - 2 || b.y + b.h > h - 2) continue;
      if (touchesRoad(b) || overlaps(b)) continue;
      buildings.push(b);
      doorSides.push(door);
    }
  };
  placeCluster(crossX, cy, roadX, target, 24);
```
(`count` is an absolute `buildings.length` target, so the village call keeps the existing `target` variable. Verify against the current loop line-by-line — the arithmetic above matches today's behavior at span=24 for the village; the seed-1/seed-2 fingerprints must not change.)
- [ ] After the village `placeCluster` call and the `if (buildings.length < 4) return null;` guard (farms from Task 2 stay after the guard), add the hamlet branch:
```ts
  const settlements = [{ x: crossX, y: cy, r: 26 }];
  if (w >= 240) {
    const crossX2 = Math.round(w * (0.15 + rng.range(0, 0.08)));
    const cy2 = roadY[crossX2];
    const roadX2 = new Int32Array(h);
    let rx2 = crossX2;
    for (let y = cy2; y < h; y++) {
      roadX2[y] = rx2;
      if (rng.next() < 0.18) rx2 = clamp(rx2 + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
    }
    rx2 = crossX2;
    for (let y = cy2 - 1; y >= 0; y--) {
      roadX2[y] = rx2;
      if (rng.next() < 0.18) rx2 = clamp(rx2 + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
    }
    for (let y = 0; y < h; y++) for (let dx = 0; dx <= 1; dx++) road[y * w + roadX2[y] + dx] = 1;
    placeCluster(crossX2, cy2, roadX2, buildings.length + 3 + rng.int(2), 14);
    settlements.push({ x: crossX2, y: cy2, r: 16 });
  }
```
Replace the `nearVillage` definition with:
```ts
  const nearVillage = (x: number, y: number) => settlements.some((s) => (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) < s.r * s.r);
```
IMPORTANT ORDERING: the hamlet branch must run BEFORE Task 2's farm loop (farms use `touchesRoad`, which must see the second lane) — place it between the `< 4` guard and the farm loop, and move the `settlements`/`nearVillage` definitions up with it.
- [ ] Scale the stand count: replace `for (let i = 0, n = 2 + rng.int(3); i < n; i++)` with
```ts
  for (let i = 0, n = 2 + rng.int(3) + Math.max(0, Math.round((w * h) / 19200) - 1); i < n; i++)
```
- [ ] At the end of `tryGenerate`, push the hamlet objective when present:
```ts
  const objectives: Vec[] = [{ x: crossX, y: cy }, eastWoods];
  if (settlements.length > 1) objectives.push({ x: settlements[1].x, y: settlements[1].y });
```
(and return that `objectives` variable).
- [ ] Add to `tests/mapgen.test.ts` (import `astar` is already there):
```ts
  it('large maps grow a second hamlet and stay connected (320x240)', () => {
    for (const seed of [1, 5, 9]) {
      const a = generateMap(seed, 320, 240);
      const b = generateMap(seed, 320, 240);
      expect(a.map.tiles).toEqual(b.map.tiles);
      expect(a.objectives.length).toBe(3);
      expect(a.buildings.length).toBeGreaterThanOrEqual(7);
      const { west, east } = a.spawns;
      for (const o of a.objectives) expect(astar(a.map, west.x, west.y, o.x, o.y)).not.toBeNull();
      expect(astar(a.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
    }
  });
```
- [ ] Run `npx vitest run` WITHOUT `-u` first: the seed-1/seed-2 fingerprint snapshots must PASS unchanged (proves the refactor didn't disturb 160×120 generation). Then confirm the new test passes. 63 tests green. `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "Mapgen v2: second hamlet + third objective on large maps; area-scaled woods; 320x240 proof"`

### Task 5: In-browser verification

**Files:** screenshots only (`.screenshots/`, gitignored). Allowed code changes: art-value tweaks inside `src/render/terrain.ts` only; anything else goes back to its owning task.

- [ ] `npm run dev -- --port 5197 --strictPort` (if taken, any free port; memory: graphics-verify-workflow).
- [ ] With playwright MCP, for seeds 1, 2, 7: `http://localhost:5197/?seed=N`, set `window.__game` cam to (80, 60, scale 8.6), screenshot to `.screenshots/v2-seedN-overview.png`. Then zoom a hedgerow/field boundary at scale 14 and a farm compound at scale 14; screenshot each.
- [ ] Acceptance checklist (fix in terrain.ts and re-shoot if any fail):
  - Hedgerows read as dense dark shrub lines, clearly distinct from woods stands.
  - Fields read as plowed strips with visible furrows, distinct from grass at scale 8.
  - Every farm compound has a visible lane connecting it to a road.
  - Orchards read as regular tree rows, not noise.
- [ ] Kill the dev server. If terrain.ts changed: `npx vitest run && npm run check`, then commit `git add -A && git commit -m "Mapgen v2: terrain art tuning from screenshot review"`.
- [ ] Merge to main per memory design-sequencing-2026-07: `git merge main` in the worktree first if main moved (resolve, test), then `git -C <repos>/top-down-military-rts merge --ff-only <branch>`.

## Non-goals (do not build)

- M-B sector-carve parameterization (entry edges / objective hints from sector cells) — wait for the M-B design; the MapPlan contract is the integration point.
- Rivers, bridges, elevation, new EDGE types (stone walls), Voronoi parcels.
- Any change to squad shapes, scenario battle structure, or UI.

## Self-review notes

- Every task independently testable + committable; reviewer can reject Task 3 while approving Task 2.
- Task 4's refactor carries the only snapshot-stability risk — that's why its first test run is WITHOUT `-u` and the seed-1/2 fingerprints are the gate.
- rng-order caution: Tasks 1–3 each change the rng call sequence on purpose (geometry changes, snapshots update via `-u`). Task 4 must NOT change it at 160×120.
