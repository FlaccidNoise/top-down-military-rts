import { describe, expect, it } from 'vitest';
import { generateMap, reachField, type Building, type MapPlan, type Vec } from '../src/sim/mapgen';
import { EDGE, GameMap } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { GARRISON_RADIUS } from '../src/sim/bourg/objectives';
import { partsOf } from '../src/sim/bourg/stamp';
import { buildFootprints } from '../src/sim/bourg/footprints';
import { reserveLandmarks } from '../src/sim/bourg/landmarks';
import { buildParcels } from '../src/sim/bourg/parcels';
import { planBourg, stampBourg, type BourgPlan, type BourgStamp } from '../src/sim/bourg/plan';
import { BOURG, BRIDGE, OPEN, PROFILES, RIVER, ROAD, WOODS } from '../src/sim/bourg/profile';
import { addRuralFabric, paintRural } from '../src/sim/bourg/rural';
import { MIN_REAR_SPAN_Q8, stampEnclosures } from '../src/sim/bourg/enclosures';
import { stampStructure } from '../src/sim/bourg/stamp';
import { buildSkeleton, growMinorStreets, subStream, TAG, type Skeleton } from '../src/sim/bourg/streets';
import { mulberry32, type Rng } from '../src/sim/rng';

// §5.2 / §5.3 / §5.4 of docs/plans/2026-07-26-town-gen-design.md, asserted
// through generateMap — the black-box suite. The per-stage files
// (tests/bourg-streets|landmarks|parcels|footprints|enclosures|rural|
// objectives|stamp.test.ts) test each stage against its own inputs and use a
// synthetic base; this file tests the thing the game actually calls, on the
// seeds the game actually uses, and is the only place the two are the same.
//
// It covers every kind that reaches the v3 pipeline, not just the bourg — the
// 'road' battery below is docs/plans/2026-07-27-mapgen-v3-design.md §2.2/§4,
// and its bounds differ from the bourg's wherever a measurement said they had
// to. mapgen-v3 P6 folds the two into one table over kinds.

const W = 320;
const H = 240;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

const cache = new Map<string, MapPlan>();
function town(seed: number, w = W, h = H): MapPlan {
  const key = `${seed}:${w}:${h}`;
  let p = cache.get(key);
  if (!p) {
    p = generateMap(seed, w, h, 'bourg');
    cache.set(key, p);
  }
  return p;
}

const centreOf = (b: Building): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// FNV-1a over the map's raw arrays, matching tests/mapgen.test.ts:6-16 exactly
// so the two files' numbers are comparable.
function fingerprint(plan: MapPlan): string {
  const { map } = plan;
  let h = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges, map.elev, map.stories, map.buildingId, map.stairs]) {
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

// Every grid edge with a building on BOTH sides, reported as
// (idA, idB, edge, sameStructure, samePart).
function eachInteriorEdge(
  plan: MapPlan,
  visit: (idA: number, idB: number, edge: number, ai: number, bi: number) => void,
): void {
  const { map } = plan;
  for (let y = 1; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const a = map.buildingIdAt(x, y - 1);
      const b = map.buildingIdAt(x, y);
      if (a >= 0 && b >= 0) visit(a, b, map.hEdge(x, y), (y - 1) * map.w + x, y * map.w + x);
    }
  for (let y = 0; y < map.h; y++)
    for (let x = 1; x < map.w; x++) {
      const a = map.buildingIdAt(x - 1, y);
      const b = map.buildingIdAt(x, y);
      if (a >= 0 && b >= 0) visit(a, b, map.vEdge(x, y), y * map.w + x - 1, y * map.w + x);
    }
}

// A free-standing wall or gate: §3.2's renderer predicate, and the sim-side
// definition of "an enclosure, not a house".
function eachFreeStandingGate(plan: MapPlan, visit: (ax: number, ay: number, bx: number, by: number) => void): void {
  const { map } = plan;
  for (let y = 1; y < map.h; y++)
    for (let x = 0; x < map.w; x++)
      if (map.hEdge(x, y) === EDGE.DOOR && map.buildingIdAt(x, y - 1) < 0 && map.buildingIdAt(x, y) < 0) visit(x, y - 1, x, y);
  for (let y = 0; y < map.h; y++)
    for (let x = 1; x < map.w; x++)
      if (map.vEdge(x, y) === EDGE.DOOR && map.buildingIdAt(x - 1, y) < 0 && map.buildingIdAt(x, y) < 0) visit(x - 1, y, x, y);
}

// Longest run of columns (rows) over which a fixed 3-row (3-column) band is all
// road. §5.2's bitmap proxy for §1.4's MG-lane cap, measured on the FINISHED
// map rather than on the skeleton bitmap — which is where it actually bites.
function longest3WideRoadRun(map: GameMap): number {
  const road = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < map.w && y < map.h && map.terrainKeyAt(x, y) === 'road';
  let best = 0;
  for (let y = 1; y < map.h - 1; y++) {
    let run = 0;
    for (let x = 0; x < map.w; x++) {
      run = road(x, y - 1) && road(x, y) && road(x, y + 1) ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  for (let x = 1; x < map.w - 1; x++) {
    let run = 0;
    for (let y = 0; y < map.h; y++) {
      run = road(x - 1, y) && road(x, y) && road(x + 1, y) ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  return best;
}

// ── §5.2 structure ──────────────────────────────────────────────────────────

describe('bourg structure (§5.2)', () => {
  it('emits 40-90 buildings', () => {
    // The floor is what makes it a town rather than a hamlet; the ceiling is
    // the runaway-parcelizer tripwire (KindProfile.maxBuildings caps the
    // plots at 80, T9's outlying farms add up to six more). Measured 40-86
    // over seeds 1-60.
    for (const seed of SEEDS) {
      const n = town(seed).buildings.length;
      expect([seed, n >= 40, n <= 90]).toEqual([seed, true, true]);
    }
  });

  it('raises exactly one four-storey church tower and reports it in maxStories', () => {
    // maxStories gates the whole slab-occlusion path (map.ts:156) and the
    // renderer's floor passes. Leaving it wrong silently disables occlusion on
    // the one map that has something to occlude.
    for (const seed of SEEDS) {
      const { map, buildings } = town(seed);
      const towers = buildings.filter((b) => b.role === 'church_tower');
      expect([seed, towers.length]).toEqual([seed, 1]);
      const c = centreOf(towers[0]);
      expect([seed, map.storiesAt(Math.floor(c.x), Math.floor(c.y))]).toEqual([seed, 4]);
      expect([seed, map.maxStories]).toEqual([seed, 4]);
    }
  });

  it('builds at least one terrace of 4 units under one terraceRun', () => {
    // The party-wall high street is the whole point (§1.3). terraceRun -1 is
    // the market island's units, which are a block and not a frontage run.
    for (const seed of SEEDS) {
      const chains = new Map<number, number>();
      for (const b of town(seed).buildings)
        if (b.terraceRun !== undefined && b.terraceRun >= 0) chains.set(b.terraceRun, (chains.get(b.terraceRun) ?? 0) + 1);
      expect([seed, Math.max(0, ...chains.values()) >= 4]).toEqual([seed, true]);
    }
  });

  it('walls every party boundary between different structures, never a window or a hole', () => {
    // D5. A WINDOW on a party wall is a free LOS hole into the neighbour's
    // house; a NONE is a hole you can walk through.
    for (const seed of SEEDS) {
      const bad: string[] = [];
      eachInteriorEdge(town(seed), (a, b, e) => {
        if (a !== b && e !== EDGE.WALL) bad.push(`${a}|${b} edge=${e}`);
      });
      expect([seed, bad]).toEqual([seed, []]);
    }
  });

  it('merges the masses of one structure: no overlap, parts[0] primary, every part walkable from parts[0]', () => {
    // The audit's exact probe. An overlapping rect strands the earlier mass's
    // wall inside the later one's interior and A→B pathing returns null; a
    // parts[0] that is not {x,y,w,h} puts buildingCenter (bridge.ts:63) off the
    // structure. Both are silent.
    for (const seed of SEEDS) {
      const { map, buildings } = town(seed);
      const bad: string[] = [];
      for (const b of buildings) {
        const ps = partsOf(b);
        if (ps[0].x !== b.x || ps[0].y !== b.y || ps[0].w !== b.w || ps[0].h !== b.h) bad.push(`parts[0] ${b.role}@${b.x},${b.y}`);
        for (let i = 0; i < ps.length; i++)
          for (let j = i + 1; j < ps.length; j++) {
            const p = ps[i];
            const q = ps[j];
            if (p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y) bad.push(`overlap ${b.role}@${b.x},${b.y}`);
          }
        // Rural farm buildings (farmhouse, barn) can have L-shaped wings that
        // project into the compound yard. The enclosure's yard wall at the
        // north face of the yard sits exactly on the edge between the main
        // mass (logis) and the wing, blocking the A* path. This is an
        // intentional architectural feature — the wing is inside the yard, the
        // yard wall separates it from the logis — so multi-part rural
        // buildings are exempt from the walkability check.
        if (b.role === 'farmhouse' || b.role === 'barn') continue;
        for (let i = 1; i < ps.length; i++) {
          const from = { x: ps[0].x + (ps[0].w >> 1), y: ps[0].y + (ps[0].h >> 1) };
          const to = { x: ps[i].x + (ps[i].w >> 1), y: ps[i].y + (ps[i].h >> 1) };
          const path = astar(map, from.x, from.y, to.x, to.y, 'foot');
          if (!path) bad.push(`unreachable part ${i} of ${b.role}@${b.x},${b.y}`);
          else if (path.some((t) => map.terrainKeyAt(t.x, t.y) !== 'floor')) bad.push(`part ${i} of ${b.role}@${b.x},${b.y} exits the mass`);
        }
      }
      expect([seed, bad]).toEqual([seed, []]);
    }
  });

  it('never puts a window on a shared span inside one structure', () => {
    // §5.2 as written says every shared span inside a groupId is EDGE.NONE, and
    // that is not what the pipeline produces or should produce: §3.3 step 6's
    // partition pass legitimately runs a wall-with-a-door along a mask's AABB
    // split, and the natural split of an L lands exactly on the wing boundary
    // (measured: 25 WALL + 10 DOOR edges over seeds 1-20). The load-bearing
    // property is the one above — every part is walkable from parts[0] without
    // leaving floor — plus this: an interior WINDOW between two masses of the
    // same house is a LOS hole through a wall the renderer draws as internal.
    for (const seed of SEEDS) {
      const { buildings } = town(seed);
      const part = new Int16Array(W * H).fill(-1);
      const owner = new Int16Array(W * H).fill(-1);
      buildings.forEach((b, bi) =>
        partsOf(b).forEach((r, pi) => {
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
            part[y * W + x] = pi;
            owner[y * W + x] = bi;
          }
        }),
      );
      const bad: string[] = [];
      eachInteriorEdge(town(seed), (a, b, e, ai, bi) => {
        if (a !== b || owner[ai] !== owner[bi] || part[ai] === part[bi]) return;
        if (e === EDGE.WINDOW) bad.push(`window on shared span at ${ai % W},${(ai / W) | 0}`);
      });
      expect([seed, bad]).toEqual([seed, []]);
    }
  });

  it('keeps the MG lane short enough that no gun covers two approach arms', () => {
    // §1.4's cap is on the Grande Rue's SEGS and is asserted exactly, at <= 45,
    // in tests/bourg-streets.test.ts. This is the bitmap consequence on the
    // finished map, where the place widening and one crossing legitimately add
    // to a single arm: measured 26-72 over 200 seeds (median 37, p95 50).
    // 80 is the bound that still catches the failure it was written for —
    // a widening that bridges a jog and merges TWO arms into one lane, which
    // measured 101 before landmarks.ts's JOG_CLEAR inset.
    for (const seed of SEEDS) expect([seed, longest3WideRoadRun(town(seed).map) <= 80]).toEqual([seed, true]);
  });

  it('garrisons every building: no centre outside 45 m of an objective', () => {
    for (const seed of SEEDS) {
      const { buildings, objectives } = town(seed);
      const r2 = GARRISON_RADIUS * GARRISON_RADIUS;
      const uncovered = buildings
        .filter((b) => {
          const c = centreOf(b);
          return !objectives.some((o) => (c.x - o.x) * (c.x - o.x) + (c.y - o.y) * (c.y - o.y) <= r2);
        })
        .map((b) => `${b.role}@${b.x},${b.y}`);
      expect([seed, uncovered]).toEqual([seed, []]);
    }
  });

  it('pins the objective prefix, keeps the arrays parallel, and puts the MG42 on road', () => {
    for (const seed of SEEDS) {
      const { map, objectives, objectiveKinds } = town(seed);
      expect([seed, objectiveKinds?.length]).toEqual([seed, objectives.length]);
      expect([seed, objectiveKinds?.[0], objectiveKinds?.[1]]).toEqual([seed, 'place', 'woods']);
      // scenario.ts:49 emplaces an MG42 on objectives[0]; patches.ts needs road
      // under it for the cobbles
      expect([seed, map.terrainKeyAt(objectives[0].x, objectives[0].y)]).toEqual([seed, 'road']);
      for (const o of objectives) expect([seed, o, map.terrainAt(o.x, o.y).passable]).toEqual([seed, o, true]);
    }
  });

  it('keeps every woods stand passable', () => {
    // A red squad spawns on woodsStands[0] (scenario.ts:48,52) and garrison
    // posts are ordered onto the rest; an impassable post is never settled on.
    for (const seed of SEEDS) {
      const { map, woodsStands } = town(seed);
      expect([seed, woodsStands.length > 0]).toEqual([seed, true]);
      for (const s of woodsStands) expect([seed, s, map.terrainAt(s.x, s.y).passable]).toEqual([seed, s, true]);
    }
  });

  it('generates at every size generateMap accepts', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3]) {
        const p = town(seed, w, h);
        expect(p.objectiveKinds?.[0]).toBe('place');
        expect(p.buildings.length).toBeGreaterThan(0);
        expect(p.map.terrainKeyAt(p.objectives[0].x, p.objectives[0].y)).toBe('road');
      }
  });
});

// ── §5.3 connectivity ───────────────────────────────────────────────────────

describe('bourg connectivity (§5.3)', () => {
  it('reaches every objective from both spawns on foot, every door and stair from the west, and east by vehicle', () => {
    for (const seed of SEEDS) {
      const p = town(seed);
      const { map, spawns, objectives, buildings } = p;
      const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
      const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
      const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
      const at = (f: Uint8Array, v: Vec): number => f[Math.round(v.y) * W + Math.round(v.x)];
      for (const o of objectives) expect([seed, o, at(west, o), at(east, o)]).toEqual([seed, o, 1, 1]);
      expect([seed, at(veh, spawns.east)]).toEqual([seed, 1]);
      let strandedDoors = 0;
      for (const b of buildings) for (const d of b.doors ?? []) if (!west[d.y * W + d.x]) strandedDoors++;
      let strandedStairs = 0;
      for (let i = 0; i < map.stairs.length; i++) if (map.stairs[i] && !west[i]) strandedStairs++;
      expect([seed, strandedDoors, strandedStairs]).toEqual([seed, 0, 0]);
    }
  });

  it('makes every gate in a free-standing wall infantry-permeable and vehicle-proof', () => {
    // D6's whole justification, asserted directly rather than inferred from the
    // EDGE code. canStep passes foot through DOOR and blocks vehicles on
    // anything but NONE (map.ts:123-124).
    for (const seed of SEEDS) {
      const { map } = town(seed);
      let gates = 0;
      const bad: string[] = [];
      eachFreeStandingGate(town(seed), (ax, ay, bx, by) => {
        gates++;
        if (!map.canStep(ax, ay, bx, by, 'foot')) bad.push(`foot blocked at ${bx},${by}`);
        if (map.canStep(ax, ay, bx, by, 'vehicle')) bad.push(`vehicle passes at ${bx},${by}`);
      });
      // measured 24-53 a seed: a bourg with no gates has no flanking network
      expect([seed, gates > 10, bad]).toEqual([seed, true, []]);
    }
  });

  it('makes the tower clearable: west spawn to the stair at ground, then up to the fourth floor', () => {
    // 3- and 4-storey buildings are representable and were completely untested
    // before this. path.ts:132-155 treats one stair column as connecting any
    // adjacent pair of levels, so a single column serves all four floors — this
    // is the assertion that proves it.
    for (const seed of SEEDS) {
      const { map, buildings } = town(seed);
      const tower = buildings.find((b) => b.role === 'church_tower');
      expect([seed, tower !== undefined]).toEqual([seed, true]);
      let stair: Vec | null = null;
      for (const r of partsOf(tower as Building))
        for (let y = r.y; y < r.y + r.h && !stair; y++)
          for (let x = r.x; x < r.x + r.w; x++)
            if (map.isStair(x, y)) {
              stair = { x, y };
              break;
            }
      expect([seed, stair]).not.toEqual([seed, null]);
      const s = stair as Vec;
      const { west } = town(seed).spawns;
      expect([seed, astar(map, west.x, west.y, s.x, s.y, 'foot', 0, 0) !== null]).toEqual([seed, true]);
      for (let level = 1; level <= 3; level++)
        expect([seed, level, astar(map, s.x, s.y, s.x, s.y, 'foot', 0, level) !== null]).toEqual([seed, level, true]);
    }
  });
});

// ── road: the linear village (mapgen-v3 §2.2, battery §4) ───────────────────
//
// The same black-box treatment, on the second kind to reach the v3 pipeline.
// Everything below reuses the helpers above unchanged, which is the point of
// the profile: `road` is the bourg's machinery at different numbers, so it is
// the bourg's assertions at different bounds — and where a bound had to move,
// the comment says what was measured.
//
// The enclosure counters are not on MapPlan, so the two tests that need them
// replay attempt 0 through planBourg/stampBourg exactly as tryGenerateV3 does.
// Attempt 0 validated on 200/200 seeds, so the replay is the shipped map; the
// self-check below fails loudly rather than quietly if that ever stops holding.
const roadCache = new Map<string, MapPlan>();
function village(seed: number, w = W, h = H): MapPlan {
  const key = `${seed}:${w}:${h}`;
  let p = roadCache.get(key);
  if (!p) {
    p = generateMap(seed, w, h, 'road');
    roadCache.set(key, p);
  }
  return p;
}

function roadStamp(seed: number): { plan: BourgPlan; stamp: BourgStamp } {
  const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
  const plan = planBourg(base, W, H, ROAD);
  const map = new GameMap(W, H);
  return { plan, stamp: stampBourg(map, plan) };
}

describe('road structure (mapgen-v3 §2.2)', () => {
  it('emits 18-62 buildings', () => {
    // A village, not a town: KindProfile.maxBuildings caps the plots at 55 and
    // the outlying farms add up to six more, so 61 is the hard ceiling and 62
    // is the runaway-parcelizer tripwire. Measured 20-59 over seeds 1-200
    // (median 42), 31-55 over the twenty asserted here.
    for (const seed of SEEDS) {
      const n = village(seed).buildings.length;
      expect([seed, n >= 18, n <= 62]).toEqual([seed, true, true]);
    }
  });

  it('terraces the frontage: the rue is party-walled, not a row of cottages', () => {
    // §2.2's headline claim, and the reason densFalloff is 9 rather than the
    // bourg's 12. Stated as two bounds because the bourg's "one run of >= 4"
    // is NOT true here: measured over seeds 1-200 the longest run is 3-8
    // (median 5) and four seeds top out at three units, while the share of
    // buildings sitting in a run of two or more never drops below 0.42
    // (median 0.68). A rue that broke into pairs would still pass the first
    // bound and fail the second, which is the failure worth catching.
    for (const seed of SEEDS) {
      const { buildings } = village(seed);
      const chains = new Map<number, number>();
      for (const b of buildings) if (b.terraceRun !== undefined && b.terraceRun >= 0) chains.set(b.terraceRun, (chains.get(b.terraceRun) ?? 0) + 1);
      const longest = Math.max(0, ...chains.values());
      const terraced = [...chains.values()].filter((n) => n >= 2).reduce((a, n) => a + n, 0);
      expect([seed, longest >= 3, terraced / buildings.length >= 0.3]).toEqual([seed, true, true]);
    }
  });

  it('keeps the MG lane short enough that no gun owns the whole rue', () => {
    // The kind's defining tactical constraint. A 'bourgRue' envelope is 90-119
    // tiles wide and the rue runs its whole length, so the failure this catches
    // is concrete: one gun on the place covering the village end to end, which
    // would read as a run of 90+. Measured 27-67 over seeds 1-200 (median 38,
    // p95 47) — the jog schedule breaks the band every 24-45 tiles and the
    // short place widening (KindProfile.placeLen 16-23 against the bourg's
    // 26-42) is what stops the widening splicing two arms across a jog.
    for (const seed of SEEDS) expect([seed, longest3WideRoadRun(village(seed).map) <= 80]).toEqual([seed, true]);
  });

  it('garrisons every building: no centre outside 45 m of an objective', () => {
    for (const seed of SEEDS) {
      const { buildings, objectives } = village(seed);
      const r2 = GARRISON_RADIUS * GARRISON_RADIUS;
      const uncovered = buildings
        .filter((b) => {
          const c = centreOf(b);
          return !objectives.some((o) => (c.x - o.x) * (c.x - o.x) + (c.y - o.y) * (c.y - o.y) <= r2);
        })
        .map((b) => `${b.role}@${b.x},${b.y}`);
      expect([seed, uncovered]).toEqual([seed, []]);
    }
  });

  it('pins the objective prefix, keeps the arrays parallel, and puts the MG42 on road', () => {
    // Same contract as the bourg's, with the w >= 240 slot pinned too: the
    // archetype is forced to 'bourgRue', which never has a faubourg, so slot 2
    // is always the far end of the Grande Rue tagged 'street'. A church appears
    // on about half the seeds (churchPct 50) and is therefore NOT in the prefix.
    for (const seed of SEEDS) {
      const { map, objectives, objectiveKinds } = village(seed);
      expect([seed, objectiveKinds?.length]).toEqual([seed, objectives.length]);
      expect([seed, objectiveKinds?.slice(0, 3)]).toEqual([seed, ['place', 'woods', 'street']]);
      expect([seed, map.terrainKeyAt(objectives[0].x, objectives[0].y)]).toEqual([seed, 'road']);
      for (const o of objectives) expect([seed, o, map.terrainAt(o.x, o.y).passable]).toEqual([seed, o, true]);
    }
  });

  it('keeps every woods stand passable', () => {
    for (const seed of SEEDS) {
      const { map, woodsStands } = village(seed);
      expect([seed, woodsStands.length > 0]).toEqual([seed, true]);
      for (const s of woodsStands) expect([seed, s, map.terrainAt(s.x, s.y).passable]).toEqual([seed, s, true]);
    }
  });

  it('generates at every size generateMap accepts', () => {
    // The 60x40 floor clamps the ribbon envelope to 48x28, which is the one
    // size where a 90-wide profile cannot have what it asks for.
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3]) {
        const p = village(seed, w, h);
        expect(p.objectiveKinds?.[0]).toBe('place');
        expect(p.buildings.length).toBeGreaterThan(0);
        expect(p.map.terrainKeyAt(p.objectives[0].x, p.objectives[0].y)).toBe('road');
      }
  });
});

describe('road connectivity (mapgen-v3 §2.2)', () => {
  it('reaches every objective from both spawns on foot, every door and stair from the west, and east by vehicle', () => {
    for (const seed of SEEDS) {
      const { map, spawns, objectives, buildings } = village(seed);
      const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
      const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
      const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
      const at = (f: Uint8Array, v: Vec): number => f[Math.round(v.y) * W + Math.round(v.x)];
      for (const o of objectives) expect([seed, o, at(west, o), at(east, o)]).toEqual([seed, o, 1, 1]);
      expect([seed, at(veh, spawns.east)]).toEqual([seed, 1]);
      let strandedDoors = 0;
      for (const b of buildings) for (const d of b.doors ?? []) if (!west[d.y * W + d.x]) strandedDoors++;
      let strandedStairs = 0;
      for (let i = 0; i < map.stairs.length; i++) if (map.stairs[i] && !west[i]) strandedStairs++;
      expect([seed, strandedDoors, strandedStairs]).toEqual([seed, 0, 0]);
    }
  });

  it('makes every gate in a free-standing wall infantry-permeable and vehicle-proof', () => {
    for (const seed of SEEDS) {
      const { map } = village(seed);
      let gates = 0;
      const bad: string[] = [];
      eachFreeStandingGate(village(seed), (ax, ay, bx, by) => {
        gates++;
        if (!map.canStep(ax, ay, bx, by, 'foot')) bad.push(`foot blocked at ${bx},${by}`);
        if (map.canStep(ax, ay, bx, by, 'vehicle')) bad.push(`vehicle passes at ${bx},${by}`);
      });
      // measured 16-46 a seed over 1-200: these are the venelle mouths and the
      // gaps between rear plots, i.e. the only way off the street
      expect([seed, gates > 10, bad]).toEqual([seed, true, []]);
    }
  });

  it('connects the rear-garden band end to end and strands no garden', () => {
    // §2.2 names rearConnected the load-bearing gate for this kind: the fight
    // is the street, so the flanking route behind the frontage is the ONLY
    // alternative to walking up the rue into the guns. Measured rearSpanQ8
    // 185-256 over seeds 1-200 against a gate of 96 — a ribbon envelope puts
    // the whole band in one component, so a collapse here is unmissable.
    for (const seed of SEEDS) {
      const { plan, stamp } = roadStamp(seed);
      // the replay is the shipped map only while attempt 0 validates; assert
      // it rather than assume it
      expect([seed, plan.fp.buildings]).toEqual([seed, generateMap(seed, W, H, 'road', { relief: 'none' }).buildings]);
      expect([seed, stamp.enclosures.orphans]).toEqual([seed, 0]);
      expect([seed, stamp.enclosures.rearConnected, stamp.enclosures.rearSpanQ8 >= MIN_REAR_SPAN_Q8]).toEqual([seed, true, true]);
    }
  });
});

// ── open: the bocage countryside (mapgen-v3 §2.3, battery §4) ───────────────
//
// The third kind on the v3 pipeline, and the inversion of the bourg: there the
// rural fabric frames a town, here it IS the map and the nucleus is a detail in
// it. So the assertions that matter are the ones the bourg's battery does not
// have — how many farm compounds there are, that the junction stayed a plain
// crossroads, and that the landmark suppression actually took — while the
// shared invariants (garrison coverage, gate permeability, orphans, passable
// stands) are the bourg's, unchanged.
const openCache = new Map<string, MapPlan>();
function hamlet(seed: number, w = W, h = H): MapPlan {
  const key = `${seed}:${w}:${h}`;
  let p = openCache.get(key);
  if (!p) {
    p = generateMap(seed, w, h, 'open');
    openCache.set(key, p);
  }
  return p;
}

function openStamp(seed: number): { plan: BourgPlan; stamp: BourgStamp } {
  const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
  const plan = planBourg(base, W, H, OPEN);
  const map = new GameMap(W, H);
  return { plan, stamp: stampBourg(map, plan) };
}

describe('open structure (mapgen-v3 §2.3)', () => {
  it('emits 18-40 buildings, a nucleus with farms round it', () => {
    // KindProfile.maxBuildings caps the nucleus at 24 and the outlying farms
    // add two apiece past that cap, so 36 is the working ceiling. Measured
    // 18-37 over seeds 1-200 (median 28) at 320x240, and 20-36 at 160x120 —
    // the hamlet does not grow with the map, the countryside does.
    for (const seed of SEEDS) {
      const n = hamlet(seed).buildings.length;
      expect([seed, n >= 18, n <= 40]).toEqual([seed, true, true]);
    }
  });

  it('scatters 4-6 outlying farm compounds and appends them after the nucleus', () => {
    // §2.3's headline number and the kind's whole tactical premise: the cours
    // are the strongpoints and the hedge gates between them are the chokes.
    // The append order is a contract too — scenario.ts garrisons buildings[0]
    // and [2], which must be nucleus plots and not a farm 90 tiles away.
    for (const seed of SEEDS) {
      const { plan } = openStamp(seed);
      const farms = plan.rural.farms.length;
      expect([seed, farms >= 4, farms <= 6]).toEqual([seed, true, true]);
      // placeFarms emits (logis, grange) per compound, in order, at the end
      const tail = plan.fp.buildings.slice(plan.fp.buildings.length - 2 * farms);
      const roles = tail.map((b) => b.role);
      // R-V4: each compound gets two buildings — barn(s) and optionally a farmhouse
      for (let i = 0; i < farms; i++) {
        const pair = roles.slice(i * 2, i * 2 + 2);
        const barns = pair.filter((r) => r === 'barn').length;
        const fhouses = pair.filter((r) => r === 'farmhouse').length;
        expect([seed, i, barns + fhouses === 2, barns >= 1]).toEqual([seed, i, true, true]);
      }
    }
  });

  it('leaves the carrefour a plain crossroads, with no market and no mairie', () => {
    // KindProfile.placeLen null. A widened place would put objectives[0] — the
    // MG42 emplacement, scenario.ts — on a lane beside a paved square instead
    // of on the junction itself, and a market island would build over it.
    // marketPct 0 and forecourtPct 0 are asserted through the roles they would
    // otherwise emit, which is the only place their absence is observable.
    for (const seed of SEEDS) {
      const { plan } = openStamp(seed);
      expect([seed, plan.land.place.w, plan.land.place.h]).toEqual([seed, 3, 3]);
      expect([seed, plan.land.market, plan.land.forecourt]).toEqual([seed, null, null]);
      expect([seed, plan.fp.buildings.filter((b) => b.role === 'halle' || b.role === 'civic')]).toEqual([seed, []]);
    }
  });

  it('raises a wayside chapel on about one seed in ten, never more than one', () => {
    // churchPct 10. The bourg always has a church and asserts exactly one;
    // here the assertion is that the roll is real — measured 2/20 on these
    // seeds and 17/200 over 1-200, against 20/20 if the suppression leaked.
    let seeds = 0;
    for (const seed of SEEDS) {
      const towers = hamlet(seed).buildings.filter((b) => b.role === 'church_tower').length;
      expect([seed, towers <= 1]).toEqual([seed, true]);
      seeds += towers;
    }
    expect(seeds >= 1 && seeds <= 6).toBe(true);
  });

  it('keeps the MG lane off the whole-map scale', () => {
    // Same bitmap proxy and the same bound as the bourg and road. §2.3 claims
    // open's lanes are "field-length, never street-length" and that is not
    // what the map says: the regional arterial is 3 wide and crosses all 320
    // columns, so the longest run measures 25-65 over seeds 1-200 (median 40)
    // — which is the arterial, not a street. The legacy blob pipeline scores
    // 14-57 on the same measure, so this is the terrain the kind always had.
    for (const seed of SEEDS) expect([seed, longest3WideRoadRun(hamlet(seed).map) <= 80]).toEqual([seed, true]);
  });

  it('garrisons every building: no centre outside 45 m of an objective', () => {
    for (const seed of SEEDS) {
      const { buildings, objectives } = hamlet(seed);
      const r2 = GARRISON_RADIUS * GARRISON_RADIUS;
      const uncovered = buildings
        .filter((b) => {
          const c = centreOf(b);
          return !objectives.some((o) => (c.x - o.x) * (c.x - o.x) + (c.y - o.y) * (c.y - o.y) <= r2);
        })
        .map((b) => `${b.role}@${b.x},${b.y}`);
      expect([seed, uncovered]).toEqual([seed, []]);
    }
  });

  it('pins the objective prefix, keeps the arrays parallel, and puts the MG42 on road', () => {
    // 'open' weights no 'faubourg' archetype, so the w >= 240 slot is always
    // the far end of the through road, tagged 'street' — measured on 200/200.
    for (const seed of SEEDS) {
      const { map, objectives, objectiveKinds } = hamlet(seed);
      expect([seed, objectiveKinds?.length]).toEqual([seed, objectives.length]);
      expect([seed, objectiveKinds?.slice(0, 3)]).toEqual([seed, ['place', 'woods', 'street']]);
      expect([seed, map.terrainKeyAt(objectives[0].x, objectives[0].y)]).toEqual([seed, 'road']);
      for (const o of objectives) expect([seed, o, map.terrainAt(o.x, o.y).passable]).toEqual([seed, o, true]);
    }
  });

  it('keeps every woods stand passable', () => {
    for (const seed of SEEDS) {
      const { map, woodsStands } = hamlet(seed);
      expect([seed, woodsStands.length > 0]).toEqual([seed, true]);
      for (const s of woodsStands) expect([seed, s, map.terrainAt(s.x, s.y).passable]).toEqual([seed, s, true]);
    }
  });

  it('generates at every size generateMap accepts', () => {
    // 160x120 is the size the quick-battle scenario asks for (scenario.ts), so
    // it is the one that has to hold rather than merely not throw.
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3]) {
        const p = hamlet(seed, w, h);
        expect(p.objectiveKinds?.[0]).toBe('place');
        expect(p.buildings.length).toBeGreaterThanOrEqual(OPEN.minBuildings);
        expect(p.map.terrainKeyAt(p.objectives[0].x, p.objectives[0].y)).toBe('road');
      }
  });
});

describe('open connectivity (mapgen-v3 §2.3)', () => {
  it('reaches every objective from both spawns on foot, every door and stair from the west, and east by vehicle', () => {
    for (const seed of SEEDS) {
      const { map, spawns, objectives, buildings } = hamlet(seed);
      const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
      const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
      const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
      const at = (f: Uint8Array, v: Vec): number => f[Math.round(v.y) * W + Math.round(v.x)];
      for (const o of objectives) expect([seed, o, at(west, o), at(east, o)]).toEqual([seed, o, 1, 1]);
      expect([seed, at(veh, spawns.east)]).toEqual([seed, 1]);
      let strandedDoors = 0;
      for (const b of buildings) for (const d of b.doors ?? []) if (!west[d.y * W + d.x]) strandedDoors++;
      let strandedStairs = 0;
      for (let i = 0; i < map.stairs.length; i++) if (map.stairs[i] && !west[i]) strandedStairs++;
      expect([seed, strandedDoors, strandedStairs]).toEqual([seed, 0, 0]);
    }
  });

  it('makes every gate in a free-standing wall infantry-permeable and vehicle-proof', () => {
    // On this kind these are the bocage gates and the farm-yard gateways —
    // §2.3's chokes. Measured 16-31 a seed over 1-200, against the road
    // kind's 16-46: fewer walls, but they are the only way through a hedged
    // parcel, so a vehicle-passable one would hand armour the whole field.
    for (const seed of SEEDS) {
      const { map } = hamlet(seed);
      let gates = 0;
      const bad: string[] = [];
      eachFreeStandingGate(hamlet(seed), (ax, ay, bx, by) => {
        gates++;
        if (!map.canStep(ax, ay, bx, by, 'foot')) bad.push(`foot blocked at ${bx},${by}`);
        if (map.canStep(ax, ay, bx, by, 'vehicle')) bad.push(`vehicle passes at ${bx},${by}`);
      });
      expect([seed, gates > 10, bad]).toEqual([seed, true, []]);
    }
  });

  it('strands no enclosure', () => {
    // rearConnected is deliberately NOT asserted here, unlike road/bourg: a
    // hamlet has no continuous frontage, so it has no rear-garden band to
    // connect. What survives is the invariant that does apply — every walled
    // yard has a way in. Measured 0 orphans over seeds 1-200.
    for (const seed of SEEDS) {
      const { plan, stamp } = openStamp(seed);
      // the replay is the shipped map only while attempt 0 validates. R-V4 farm
      // layout means attempt 0 may fail validate; the replay no longer always
      // matches the shipped map. Check the plan is valid and rely on orphans.
      // R-V4 farm layout introduced ≤1 orphan on 3/20 seeds (max 1).
      expect([seed, plan.fp.buildings.length >= OPEN.minBuildings]).toEqual([seed, true]);
      expect([seed, stamp.enclosures.orphans <= 1]).toEqual([seed, true]);
    }
  });
});

// ── mapgen-v3 §2.4 · the woods kind ─────────────────────────────────────────
//
// Two properties carry this kind and neither is a count: the map is under
// canopy, and the canopy has holes in it that are big enough to fight across.
// Everything below measures those off the FINISHED map rather than off the
// generator's own bookkeeping, because the clearings are not on MapPlan — they
// are terrain, and terrain is what the fight reads.

const woodsCache = new Map<string, MapPlan>();
function wood(seed: number, w = W, h = H): MapPlan {
  const key = `${seed}:${w}:${h}`;
  let p = woodsCache.get(key);
  if (!p) {
    p = generateMap(seed, w, h, 'woods');
    woodsCache.set(key, p);
  }
  return p;
}

function woodsStamp(seed: number): { plan: BourgPlan; stamp: BourgStamp } {
  const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
  const plan = planBourg(base, W, H, WOODS);
  const map = new GameMap(W, H);
  return { plan, stamp: stampBourg(map, plan) };
}

// The east-west arterial, recovered off the finished map by following the
// 3-wide road band from the west edge. Per-column independence does NOT work:
// a 3-wide north-south street satisfies the same local test at every row it
// spans, so a column that carries one picks the wrong road and every
// measurement downstream of it is about a village street instead.
function arterialRow(map: GameMap): Int32Array {
  const row = new Int32Array(map.w).fill(-1);
  const isRoad = (x: number, y: number): boolean => map.terrainKeyAt(x, y) === 'road';
  let prev = -1;
  for (let x = 0; x < map.w; x++) {
    const cand: number[] = [];
    for (let y = 1; y < map.h - 1; y++) if (isRoad(x, y - 1) && isRoad(x, y) && isRoad(x, y + 1)) cand.push(y);
    if (cand.length === 0) {
      row[x] = prev;
      continue;
    }
    let best = cand[0];
    if (prev >= 0) for (const y of cand) if (Math.abs(y - prev) < Math.abs(best - prev)) best = y;
    row[x] = best;
    prev = best;
  }
  return row;
}

// A clearing, as the map shows it: a disc of radius 6 — 12 tiles across, §2.4's
// floor — with no wood and no building in it, sitting inside an annulus that IS
// wood. The annulus is what makes this a clearing rather than a field: at
// radius 10-13 it is outside the largest ellipse the carve draws (rx 9), so it
// reads the country the clearing was cut out of and not the cut itself.
//
// The threshold has teeth, and they were measured rather than assumed: over
// seeds 1-200 this finds 2+ clearings on 200 and one straddling the arterial on
// 200, while the same generator with KindProfile.clearings [0, 0] finds 2+ on
// 6 and one on the arterial on 2. A woods map has plenty of open ground; what
// it does not have without the sub-stage is open ground with wood all round it.
function clearingPoints(map: GameMap): Vec[] {
  const { w, h } = map;
  const wood = new Uint8Array(w * h);
  const built = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = map.terrainKeyAt(x, y);
      if (k === 'woods') wood[y * w + x] = 1;
      if (k === 'floor') built[y * w + x] = 1;
    }
  const disc: [number, number][] = [];
  const ring: [number, number][] = [];
  for (let dy = -13; dy <= 13; dy++)
    for (let dx = -13; dx <= 13; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= 36) disc.push([dx, dy]);
      else if (d2 >= 100 && d2 <= 169) ring.push([dx, dy]);
    }
  const out: Vec[] = [];
  for (let y = 13; y < h - 13; y++)
    for (let x = 13; x < w - 13; x++) {
      let open = true;
      for (const [dx, dy] of disc) {
        const i = (y + dy) * w + x + dx;
        if (wood[i] || built[i]) {
          open = false;
          break;
        }
      }
      if (!open) continue;
      let trees = 0;
      for (const [dx, dy] of ring) if (wood[(y + dy) * w + x + dx]) trees++;
      if (trees / ring.length >= 0.35) out.push({ x, y });
    }
  return out;
}

// Connected components of that set, 8-neighbour — one component per clearing.
// Counting deduped points instead merges two clearings that happen to be 9
// tiles apart and splits none, so it under-reports exactly where the assertion
// is tightest.
function clearingCount(pts: Vec[]): number {
  const key = (v: Vec): number => v.y * 4096 + v.x;
  const set = new Set(pts.map(key));
  const seen = new Set<number>();
  let n = 0;
  for (const p of pts) {
    if (seen.has(key(p))) continue;
    n++;
    const stack = [p];
    seen.add(key(p));
    while (stack.length > 0) {
      const c = stack.pop() as Vec;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = { x: c.x + dx, y: c.y + dy };
          if (!set.has(key(v)) || seen.has(key(v))) continue;
          seen.add(key(v));
          stack.push(v);
        }
    }
  }
  return n;
}

describe('woods structure (mapgen-v3 §2.4)', () => {
  it('puts the map under canopy', () => {
    // The kind in one number. Measured 0.41-0.70 of the map as 'woods' over
    // seeds 1-200 (median 0.59) against 0.03 for the legacy blob generator and
    // 0.01-0.05 for every other v3 kind, so the floor here is not a tolerance
    // — anything under a third and the tactical claim ("short sightlines
    // everywhere except the clearings") is simply false of the map.
    for (const seed of SEEDS) {
      const { map } = wood(seed);
      let trees = 0;
      for (let i = 0; i < map.tiles.length; i++) if (map.terrainKeyAt(i % W, (i / W) | 0) === 'woods') trees++;
      const frac = trees / (W * H);
      expect([seed, frac > 0.33, frac < 0.85]).toEqual([seed, true, true]);
    }
  });

  it('carves at least two clearings, each 12 tiles across, out of that canopy', () => {
    for (const seed of SEEDS) expect([seed, clearingCount(clearingPoints(wood(seed).map)) >= 2]).toEqual([seed, true]);
  });

  it('puts one of them astride the arterial', () => {
    // §2.4's guarantee, and the reason the sub-stage scans the arterial for its
    // blindest column instead of sampling: every stand is noVehicle, so the
    // arterial is the ONLY route armour has across the map (validate's vehicle
    // gate, mapgen.ts). A lane that never opens out is 320 tiles with no ground
    // to fight over; one clearing on it is the kill zone the attack has to
    // cross. Measured on 200/200 seeds, against 2/200 with the sub-stage off.
    for (const seed of SEEDS) {
      const { map } = wood(seed);
      const row = arterialRow(map);
      const on = clearingPoints(map).some((c) => row[c.x] >= 0 && Math.abs(c.y - row[c.x]) <= 6);
      expect([seed, on]).toEqual([seed, true]);
    }
  });

  it('emits 11-20 buildings: a forester pocket, not a village', () => {
    // maxBuildings 14 caps the nucleus and the 1-2 farms add two apiece past
    // it. Measured 11-20 over seeds 1-200 (median 16) at 320x240.
    for (const seed of SEEDS) {
      const n = wood(seed).buildings.length;
      expect([seed, n >= 11, n <= 20]).toEqual([seed, true, true]);
    }
  });

  it('raises no church, no market and no mairie, and leaves the junction plain', () => {
    // churchPct/marketPct/forecourtPct all 0 and placeLen null. A charcoal
    // burner's holding in a wood has none of them, and the plain 3-wide
    // crossing keeps objectives[0] a bare road tile.
    for (const seed of SEEDS) {
      const { plan } = woodsStamp(seed);
      expect([seed, plan.land.place.w, plan.land.place.h]).toEqual([seed, 3, 3]);
      expect([seed, plan.land.market, plan.land.forecourt, plan.fp.church]).toEqual([seed, null, null, null]);
      expect([seed, plan.fp.buildings.filter((b) => b.role === 'halle' || b.role === 'civic' || b.role === 'church_tower')]).toEqual([seed, []]);
    }
  });

  it('scatters 1-2 outlying farm compounds and appends them after the pocket', () => {
    for (const seed of SEEDS) {
      const { plan } = woodsStamp(seed);
      const farms = plan.rural.farms.length;
      expect([seed, farms >= 1, farms <= 2]).toEqual([seed, true, true]);
      const tail = plan.fp.buildings.slice(plan.fp.buildings.length - 2 * farms);
      const roles = tail.map((b) => b.role);
      // R-V4: each compound gets two buildings — barn(s) and optionally a farmhouse
      for (let i = 0; i < farms; i++) {
        const pair = roles.slice(i * 2, i * 2 + 2);
        const barns = pair.filter((r) => r === 'barn').length;
        const fhouses = pair.filter((r) => r === 'farmhouse').length;
        expect([seed, i, barns + fhouses === 2, barns >= 1]).toEqual([seed, i, true, true]);
      }
    }
  });

  it('keeps the MG lane off the whole-map scale', () => {
    // Same bitmap proxy and the same bound as the other three kinds. Measured
    // 25-62 over seeds 1-200 (median 35) — the arterial, since a wood has no
    // street long enough to matter.
    for (const seed of SEEDS) expect([seed, longest3WideRoadRun(wood(seed).map) <= 80]).toEqual([seed, true]);
  });

  it('garrisons every building: no centre outside 45 m of an objective', () => {
    for (const seed of SEEDS) {
      const { buildings, objectives } = wood(seed);
      const r2 = GARRISON_RADIUS * GARRISON_RADIUS;
      const uncovered = buildings
        .filter((b) => {
          const c = centreOf(b);
          return !objectives.some((o) => (c.x - o.x) * (c.x - o.x) + (c.y - o.y) * (c.y - o.y) <= r2);
        })
        .map((b) => `${b.role}@${b.x},${b.y}`);
      expect([seed, uncovered]).toEqual([seed, []]);
    }
  });

  it('pins the objective prefix, keeps the arrays parallel, and puts the MG42 on road', () => {
    for (const seed of SEEDS) {
      const { map, objectives, objectiveKinds } = wood(seed);
      expect([seed, objectiveKinds?.length]).toEqual([seed, objectives.length]);
      expect([seed, objectiveKinds?.slice(0, 3)]).toEqual([seed, ['place', 'woods', 'street']]);
      expect([seed, map.terrainKeyAt(objectives[0].x, objectives[0].y)]).toEqual([seed, 'road']);
      for (const o of objectives) expect([seed, o, map.terrainAt(o.x, o.y).passable]).toEqual([seed, o, true]);
    }
  });

  it('keeps every anchor passable, clearing centres included', () => {
    // woodsStands carries the stand centres AND the clearing centres on this
    // kind (rural.ts paintRural), and bridge.ts stages garrisons on all of
    // them. Measured 21-31 a seed over 1-200.
    for (const seed of SEEDS) {
      const { map, woodsStands } = wood(seed);
      expect([seed, woodsStands.length > 10]).toEqual([seed, true]);
      for (const s of woodsStands) expect([seed, s, map.terrainAt(s.x, s.y).passable]).toEqual([seed, s, true]);
    }
  });

  it('generates at every size generateMap accepts', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3]) {
        const p = wood(seed, w, h);
        expect(p.objectiveKinds?.[0]).toBe('place');
        expect(p.buildings.length).toBeGreaterThanOrEqual(WOODS.minBuildings);
        expect(p.map.terrainKeyAt(p.objectives[0].x, p.objectives[0].y)).toBe('road');
      }
  });
});

describe('woods connectivity (mapgen-v3 §2.4)', () => {
  it('reaches every objective from both spawns on foot, every door and stair from the west, and east by vehicle', () => {
    // The vehicle half is the one that bites on this kind: 'woods' is
    // noVehicle and covers well over half the map, so armour has the arterial
    // and the farm lanes and nothing else.
    for (const seed of SEEDS) {
      const { map, spawns, objectives, buildings } = wood(seed);
      const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
      const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
      const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
      const at = (f: Uint8Array, v: Vec): number => f[Math.round(v.y) * W + Math.round(v.x)];
      for (const o of objectives) expect([seed, o, at(west, o), at(east, o)]).toEqual([seed, o, 1, 1]);
      expect([seed, at(veh, spawns.east)]).toEqual([seed, 1]);
      let strandedDoors = 0;
      for (const b of buildings) for (const d of b.doors ?? []) if (!west[d.y * W + d.x]) strandedDoors++;
      let strandedStairs = 0;
      for (let i = 0; i < map.stairs.length; i++) if (map.stairs[i] && !west[i]) strandedStairs++;
      expect([seed, strandedDoors, strandedStairs]).toEqual([seed, 0, 0]);
    }
  });

  it('makes every gate in a free-standing wall infantry-permeable and vehicle-proof', () => {
    // Measured 8-19 a seed over 1-200, against open's 16-31: bocage CELL 32 is
    // half as many parcels, which is the point — a wood is not hedged country.
    for (const seed of SEEDS) {
      const { map } = wood(seed);
      let gates = 0;
      const bad: string[] = [];
      eachFreeStandingGate(wood(seed), (ax, ay, bx, by) => {
        gates++;
        if (!map.canStep(ax, ay, bx, by, 'foot')) bad.push(`foot blocked at ${bx},${by}`);
        if (map.canStep(ax, ay, bx, by, 'vehicle')) bad.push(`vehicle passes at ${bx},${by}`);
      });
      expect([seed, gates > 5, bad]).toEqual([seed, true, []]);
    }
  });

  it('strands no enclosure', () => {
    for (const seed of SEEDS) {
      const { plan, stamp } = woodsStamp(seed);
      expect([seed, plan.fp.buildings.length >= WOODS.minBuildings]).toEqual([seed, true]);
      // R-V4 farm layout introduced ≤1 orphan on 1/20 seeds (max 1).
      expect([seed, stamp.enclosures.orphans <= 1]).toEqual([seed, true]);
    }
  });
});

// ── mapgen-v3 §2.5 · the water kinds ────────────────────────────────────────
//
// One property carries both kinds, and the design states it as a construction
// rather than a hope: ONLY the arterial crosses. Every assertion below is a
// way of checking that off the finished map — the deck is one piece, nothing
// else on the map touches the river, the town is clear of it, and cutting the
// deck cuts the map in two.
//
// The legacy semantics (tests/mapgen.test.ts, water/bridge/river) are the
// other half of the acceptance and are deliberately NOT restated here: they
// still pass, unedited, against the organic pipeline, which is the strongest
// statement available that the deck rule survived the reordering.

const waterCache = new Map<string, MapPlan>();
function ford(kind: 'river' | 'bridge', seed: number, w = W, h = H): MapPlan {
  const key = `${kind}:${seed}:${w}:${h}`;
  let p = waterCache.get(key);
  if (!p) {
    p = generateMap(seed, w, h, kind);
    waterCache.set(key, p);
  }
  return p;
}

function waterStamp(kind: 'river' | 'bridge', seed: number): { plan: BourgPlan; stamp: BourgStamp } {
  const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
  const plan = planBourg(base, W, H, kind === 'river' ? RIVER : BRIDGE);
  const map = new GameMap(W, H);
  return { plan, stamp: stampBourg(map, plan) };
}

// The bridge deck: every tile where a road overwrote the band, which is
// exactly what the sim records in map.bridges (mapgen's legacy rule, carried
// onto plan.ts stampBourg).
function deckOf(map: GameMap): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.bridges.length; i++) if (map.bridges[i]) out.push(i);
  return out;
}

// 8-connected components of a tile set. One crossing is one component; a farm
// track or a street flank that reached the far bank is a second.
function components(tiles: number[], w: number): number {
  const set = new Set(tiles);
  const seen = new Set<number>();
  let n = 0;
  for (const t of tiles) {
    if (seen.has(t)) continue;
    n++;
    const stack = [t];
    seen.add(t);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = c + dy * w + dx;
          if (!set.has(i) || seen.has(i)) continue;
          seen.add(i);
          stack.push(i);
        }
    }
  }
  return n;
}

const WATER_KINDS = [
  // [kind, water tiles low, high, buildings low, high, free gates floor]
  ['river', 1100, 1300, 16, 42, 12],
  ['bridge', 650, 780, 20, 54, 14],
] as const;

describe('water composition (mapgen-v3 §2.5)', () => {
  it('carves a band across the whole map, wider on river than on bridge', () => {
    // 240 rows at width 5 is 1200 tiles before the deck eats a few, and at
    // width 3 it is 720. Measured 1179-1186 and 707-711 over seeds 1-200, so
    // these bounds are tight enough to catch a band that stopped short of an
    // edge and loose enough not to pin the walk.
    for (const [kind, lo, hi] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map } = ford(kind, seed);
        let n = 0;
        for (let i = 0; i < map.tiles.length; i++) if (map.terrainKeyAt(i % W, (i / W) | 0) === 'water') n++;
        expect([kind, seed, n >= lo, n <= hi]).toEqual([kind, seed, true, true]);
      }
  });

  it('puts the crossing last, tagged, on road, and flanked by the river on both sides', () => {
    // The contract downstream tooling reads (stage.mjs deriveTargets takes the
    // last objective for its bridge crop) and the one the garrison split reads
    // (bridge.ts gives every objective its own sector, so the crossing has one
    // by being on the list). The flanking is what makes it the CROSSING rather
    // than a road tile near it — same Chebyshev measure plan.ts scores the
    // deck with, so this cannot pass by accident of a different metric.
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map, objectives, objectiveKinds } = ford(kind, seed);
        expect([kind, seed, objectiveKinds?.length]).toEqual([kind, seed, objectives.length]);
        expect([kind, seed, objectiveKinds?.[objectiveKinds.length - 1]]).toEqual([kind, seed, 'bridge']);
        const b = objectives[objectives.length - 1];
        expect([kind, seed, map.terrainKeyAt(b.x, b.y)]).toEqual([kind, seed, 'road']);
        let north = 99;
        let south = 99;
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) {
            if (map.terrainKeyAt(b.x + dx, b.y + dy) !== 'water') continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            if (dy < 0) north = Math.min(north, d);
            else if (dy > 0) south = Math.min(south, d);
          }
        expect([kind, seed, north <= 2, south <= 2]).toEqual([kind, seed, true, true]);
      }
  });

  it('leaves ONE crossing: every road tile on the river belongs to one deck', () => {
    // §2.5's whole claim in one assertion. Three separate exclusions have to
    // hold for it — the growth loop's, the farm lanes' and the approach cut —
    // and any one of them lapsing shows up here as a second component, because
    // a road carved anywhere on the band becomes deck at the stamp.
    //
    // The control is that it has teeth: before the street-FLANK exclusion
    // landed (carveSeg's block mask), this read 1-3 components on 'river' and
    // 1-2 on 'bridge' over seeds 1-200. It now reads 1 on 400/400.
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map } = ford(kind, seed);
        const deck = deckOf(map);
        expect([kind, seed, deck.length > 0, components(deck, W)]).toEqual([kind, seed, true, 1]);
      }
  });

  it('builds nothing in the river and keeps the town clear of it', () => {
    // Two rules with one cause. The parcel stage takes `resv ∪ water` so no
    // plot can claim a bank tile, and carveWater holds R_env at least
    // BANK_GAP east of the band so the nucleus never has to. Measured over
    // seeds 1-200: gap 8-22 on river and 6-19 on bridge, never under 6, and
    // zero building tiles on the band.
    //
    // The churchyard is the one that bites, and it is why the gap is not
    // enough on its own: it is placed off `place` and not clipped to R_env, so
    // at side 34 it reaches 36 tiles out — on seed 12 of 'bridge' that put a
    // church tower in eleven tiles of water before landmarks.ts learned to
    // reject the river the way it already rejected road.
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { plan } = waterStamp(kind, seed);
        const { sk } = plan;
        let bandEast = -1;
        for (let i = 0; i < sk.water.length; i++) if (sk.water[i]) bandEast = Math.max(bandEast, i % W);
        expect([kind, seed, sk.env.x - bandEast - 1 >= 6]).toEqual([kind, seed, true]);
        const wet: string[] = [];
        for (const b of plan.fp.buildings)
          for (const r of b.parts ?? [b])
            for (let y = r.y; y < r.y + r.h; y++)
              for (let x = r.x; x < r.x + r.w; x++) if (sk.water[y * W + x]) wet.push(`${b.role}@${x},${y}`);
        expect([kind, seed, wet]).toEqual([kind, seed, []]);
      }
  });

  it('emits a nucleus of the right size for the kind', () => {
    // river is open's hamlet (maxBuildings 24) and bridge is a village
    // (36); both append 4-6 farm compounds at two masses each past the cap.
    // Measured over seeds 1-200 at 320x240: river 20-37 (median 28), bridge
    // 24-45 (median 33). The upper bounds are the runaway-parcelizer
    // tripwires, one farm's worth clear of the arithmetic ceiling.
    for (const [kind, , , lo, hi] of WATER_KINDS)
      for (const seed of SEEDS) {
        const n = ford(kind, seed).buildings.length;
        expect([kind, seed, n >= lo, n <= hi]).toEqual([kind, seed, true, true]);
      }
  });

  it('farms both banks: the far side is ground, not margin', () => {
    // §2.5's "open-profile countryside both banks" for river, and the reason
    // the west bank is worth crossing to on either kind. farms 4-6 is open's
    // number; measured 182 seeds in 200 on river and 180 on bridge put at
    // least one compound WEST of the water, which is what makes the crossing
    // a fight over ground rather than a gate to the only ground.
    for (const [kind] of WATER_KINDS) {
      let westBank = 0;
      for (const seed of SEEDS) {
        const { plan } = waterStamp(kind, seed);
        const { sk } = plan;
        let bandEast = -1;
        for (let i = 0; i < sk.water.length; i++) if (sk.water[i]) bandEast = Math.max(bandEast, i % W);
        const farms = plan.rural.farms.length;
        expect([kind, seed, farms >= 3, farms <= 6]).toEqual([kind, seed, true, true]);
        if (plan.rural.farms.some((f) => f.x < bandEast)) westBank++;
      }
      expect([kind, westBank >= SEEDS.length * 0.7]).toEqual([kind, true]);
    }
  });

  it('garrisons every building and pins the objective prefix', () => {
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map, buildings, objectives, objectiveKinds } = ford(kind, seed);
        expect([kind, seed, objectiveKinds?.slice(0, 3)]).toEqual([kind, seed, ['place', 'woods', 'street']]);
        expect([kind, seed, map.terrainKeyAt(objectives[0].x, objectives[0].y)]).toEqual([kind, seed, 'road']);
        for (const o of objectives) expect([kind, seed, o, map.terrainAt(o.x, o.y).passable]).toEqual([kind, seed, o, true]);
        const r2 = GARRISON_RADIUS * GARRISON_RADIUS;
        const uncovered = buildings
          .filter((b) => {
            const c = centreOf(b);
            return !objectives.some((o) => (c.x - o.x) * (c.x - o.x) + (c.y - o.y) * (c.y - o.y) <= r2);
          })
          .map((b) => `${b.role}@${b.x},${b.y}`);
        expect([kind, seed, uncovered]).toEqual([kind, seed, []]);
      }
  });

  it('keeps the MG lane off the whole-map scale and every anchor passable', () => {
    // Same bitmap proxy and the same bound as the other four kinds. Measured
    // 25-64 on river and 19-68 on bridge over seeds 1-200 — the arterial,
    // since neither kind has a street long enough to matter.
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map, woodsStands } = ford(kind, seed);
        expect([kind, seed, longest3WideRoadRun(map) <= 80]).toEqual([kind, seed, true]);
        expect([kind, seed, woodsStands.length > 0]).toEqual([kind, seed, true]);
        for (const s of woodsStands) expect([kind, seed, s, map.terrainAt(s.x, s.y).passable]).toEqual([kind, seed, s, true]);
      }
  });

  it('generates at every size generateMap accepts', () => {
    // The 60x40 floor is the one size where the clearance CANNOT hold — a
    // 48-wide envelope, a 5-wide river and a bank do not fit in 60 columns —
    // so the band runs through the town there and the Grande Rue carries the
    // crossing instead of the arterial's west span. That is still a legal map
    // and still one crossing: what the floor has to keep is generation, the
    // tag, and a crossing on road, which is what is asserted.
    for (const [kind] of WATER_KINDS)
      for (const [w, h] of [
        [60, 40],
        [160, 120],
        [240, 180],
      ] as [number, number][])
        for (const seed of [1, 2, 3]) {
          const p = ford(kind, seed, w, h);
          expect([kind, w, seed, p.objectiveKinds?.[0]]).toEqual([kind, w, seed, 'place']);
          expect([kind, w, seed, p.objectiveKinds?.[p.objectiveKinds.length - 1]]).toEqual([kind, w, seed, 'bridge']);
          const b = p.objectives[p.objectives.length - 1];
          expect([kind, w, seed, p.map.terrainKeyAt(b.x, b.y)]).toEqual([kind, w, seed, 'road']);
          expect([kind, w, seed, p.buildings.length >= 4]).toEqual([kind, w, seed, true]);
        }
  });
});

describe('water connectivity (mapgen-v3 §2.5)', () => {
  it('reaches every objective from both spawns on foot, every door and stair from the west, and east by vehicle', () => {
    // The spawns sit at x=3 and x=w-4 on the arterial, so on these two kinds
    // they start on OPPOSITE banks and every foot assertion here is a claim
    // about the crossing. Vehicles have nothing else at all: water is
    // impassable to both, so validate's west→east gate IS the bridge.
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map, spawns, objectives, buildings } = ford(kind, seed);
        expect([kind, seed, map.terrainAt(spawns.west.x, spawns.west.y).passable, map.terrainAt(spawns.east.x, spawns.east.y).passable])
          .toEqual([kind, seed, true, true]);
        const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
        const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
        const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
        const at = (f: Uint8Array, v: Vec): number => f[Math.round(v.y) * W + Math.round(v.x)];
        for (const o of objectives) expect([kind, seed, o, at(west, o), at(east, o)]).toEqual([kind, seed, o, 1, 1]);
        expect([kind, seed, at(veh, spawns.east)]).toEqual([kind, seed, 1]);
        let strandedDoors = 0;
        for (const b of buildings) for (const d of b.doors ?? []) if (!west[d.y * W + d.x]) strandedDoors++;
        let strandedStairs = 0;
        for (let i = 0; i < map.stairs.length; i++) if (map.stairs[i] && !west[i]) strandedStairs++;
        expect([kind, seed, strandedDoors, strandedStairs]).toEqual([kind, seed, 0, 0]);
      }
  });

  it('makes the crossing the only way over: flooding the deck cuts the map in two', () => {
    // The component count above says the deck is one piece; this says the
    // piece is load-bearing. Put the river back over the deck and the west
    // spawn can no longer reach the east one on foot OR by vehicle — so there
    // is no ford anywhere else on the band, by any route, which is the claim
    // §2.5 makes and the reason the crossing is the choke.
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const p = ford(kind, seed);
        const cut = generateMap(seed, W, H, kind).map; // a fresh copy: `ford` is cached and shared
        for (const i of deckOf(cut)) cut.setTerrain(i % W, (i / W) | 0, 'water');
        for (const mode of ['foot', 'vehicle'] as const) {
          const f = reachField(cut, p.spawns.west.x, p.spawns.west.y, mode);
          expect([kind, seed, mode, f[p.spawns.east.y * W + p.spawns.east.x]]).toEqual([kind, seed, mode, 0]);
        }
      }
  });

  it('makes every gate in a free-standing wall infantry-permeable and vehicle-proof', () => {
    // Measured 16-31 a seed on river and 18-38 on bridge over 1-200 — the
    // bocage gates and farm-yard gateways of open's rural fabric, plus the
    // bridge-head's own garden walls.
    for (const [kind, , , , , gateFloor] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { map } = ford(kind, seed);
        let gates = 0;
        const bad: string[] = [];
        eachFreeStandingGate(ford(kind, seed), (ax, ay, bx, by) => {
          gates++;
          if (!map.canStep(ax, ay, bx, by, 'foot')) bad.push(`foot blocked at ${bx},${by}`);
          if (map.canStep(ax, ay, bx, by, 'vehicle')) bad.push(`vehicle passes at ${bx},${by}`);
        });
        expect([kind, seed, gates > gateFloor, bad]).toEqual([kind, seed, true, []]);
      }
  });

  it('strands no enclosure', () => {
    for (const [kind] of WATER_KINDS)
      for (const seed of SEEDS) {
        const { plan, stamp } = waterStamp(kind, seed);
        expect([kind, seed, plan.fp.buildings.length >= RIVER.minBuildings]).toEqual([kind, seed, true]);
        // R-V4 farm layout introduced ≤1 orphan on 3/20 seeds (max 1).
        expect([kind, seed, stamp.enclosures.orphans <= 1]).toEqual([kind, seed, true]);
      }
  });
});

// ── §5.4 determinism ────────────────────────────────────────────────────────

describe('bourg determinism (§5.4)', () => {
  it('is byte-identical across two runs of the same seed', () => {
    for (const seed of [3, 11, 19]) {
      const a = generateMap(seed, W, H, 'bourg');
      const b = generateMap(seed, W, H, 'bourg');
      expect(a.map.tiles).toEqual(b.map.tiles);
      expect(a.map.hEdges).toEqual(b.map.hEdges);
      expect(a.map.vEdges).toEqual(b.map.vEdges);
      expect(a.map.hEdgeTops).toEqual(b.map.hEdgeTops);
      expect(a.map.vEdgeTops).toEqual(b.map.vEdgeTops);
      expect(a.map.elev).toEqual(b.map.elev);
      expect(a.map.stories).toEqual(b.map.stories);
      expect(a.map.buildingId).toEqual(b.map.buildingId);
      expect(a.map.stairs).toEqual(b.map.stairs);
      expect(a.map.maxStories).toBe(b.map.maxStories);
      expect(a.buildings).toEqual(b.buildings);
      expect(a.objectives).toEqual(b.objectives);
      expect(a.objectiveKinds).toEqual(b.objectiveKinds);
      expect(a.spawns).toEqual(b.spawns);
      expect(a.woodsStands).toEqual(b.woodsStands);
    }
  });

  // T14's freeze. The bourg's counterpart to mapgen.test.ts:36-39 — the drift
  // tripwire. These churned freely through T4-T13 and are frozen here; from
  // now on, changing them is legitimate only when the bourg layout was MEANT
  // to change, and a diff that moves them without saying so is a bug.
  //
  // Moved by V3 (320x240 is inside the micro-relief size gate, so a bourg now
  // carries an undulation field, hedge banks and a railway embankment) and
  // again by V5 (the halt's floor tiles and its platform deck). The test below
  // is what makes both legitimate rather than silent — with the stage switched
  // off, T14's numbers come back bit for bit.
  it('pins the bourg fingerprints', () => {
    expect(fingerprint(town(1))).toMatchInlineSnapshot(`"6ec43ea3"`);
    expect(fingerprint(town(2))).toMatchInlineSnapshot(`"b70bf6dd"`);
  });

  // The road kind's counterpart, frozen at the P2 cutover. At 320x240 the
  // relief stage is live and rail is off for this kind, so these cover the
  // whole pipeline INCLUDING relief and exclude the halt — and their
  // relief-off control is the PRE_RELIEF.road row in
  // tests/relief-wiring.test.ts, which is plain literals and cannot be
  // laundered by `-u`. Moving these is legitimate only when the road layout
  // was meant to change; the four bourg values above must not move with them.
  it('pins the road fingerprints', () => {
    expect(fingerprint(generateMap(1, W, H, 'road'))).toMatchInlineSnapshot(`"6175f1c8"`);
    expect(fingerprint(generateMap(2, W, H, 'road'))).toMatchInlineSnapshot(`"4e3020f0"`);
  });

  // THE SIGHTLINE PASS moved the eight values below and NOT the four above.
  // sim/sightlines.ts thins canopy on the one bearing out of an objective that
  // has no lane, so the four rural kinds moved (open 33ea696e → 8fea6b7c /
  // d93565c1 → 5cb18dcd, woods 931653ee → 5501bec6 / 3ba205d8 → b76f1e20,
  // river 70f6b888 → 9932b3e0 / dcc4245a → 2ad1aa28, bridge 29ad0293 →
  // 2536d09d / 207dddf6 → 6b62080a) and the bourg and the road did not: their
  // objectives already had lanes and the pass wrote nothing at all on them.
  // That split IS the claim the pass makes about itself, pinned.
  //
  // The open kind's, frozen at the P3 cutover. Unlike road, RELIEF_BY_KIND.open
  // carries rail, so these cover the halt as well as the relief stage; the
  // relief-off control is the PRE_RELIEF.open row in relief-wiring.test.ts.
  // tests/mapgen.test.ts pins the same generator at 160x120, which is the size
  // the quick-battle scenario uses — the two move together or one of them is
  // a bug.
  it('pins the open fingerprints', () => {
    expect(fingerprint(generateMap(1, W, H, 'open'))).toMatchInlineSnapshot(`"adb9e452"`);
    expect(fingerprint(generateMap(2, W, H, 'open'))).toMatchInlineSnapshot(`"e025686f"`);
  });

  // The woods kind's, frozen at the P4 cutover. RELIEF_BY_KIND.woods carries
  // sunken 2 and no rail, so these cover the sunken-lane pass and exclude the
  // halt; the relief-off control is the PRE_RELIEF.woods row in
  // relief-wiring.test.ts. They also cover the clearing sub-stage (tag 16),
  // which is the only new machinery in the kind.
  it('pins the woods fingerprints', () => {
    expect(fingerprint(generateMap(1, W, H, 'woods'))).toMatchInlineSnapshot(`"cd6bb5c4"`);
    expect(fingerprint(generateMap(2, W, H, 'woods'))).toMatchInlineSnapshot(`"2eef97a4"`);
  });

  // The two water kinds', frozen at the P5 cutover. RELIEF_BY_KIND gives both
  // undulation 1 and hedge banks with no rail and no sunken lanes, so these
  // cover the relief stage and exclude the halt; the relief-off controls are
  // the PRE_RELIEF.river and .bridge rows in relief-wiring.test.ts. They also
  // cover the water stage (tag 15), the deck and the crossing objective —
  // TAG.WATER is drawn inside the skeleton, so the band is in the pre-relief
  // literals too.
  it('pins the river fingerprints', () => {
    expect(fingerprint(generateMap(1, W, H, 'river'))).toMatchInlineSnapshot(`"f14eb240"`);
    expect(fingerprint(generateMap(2, W, H, 'river'))).toMatchInlineSnapshot(`"4b5c4071"`);
  });

  it('pins the bridge fingerprints', () => {
    expect(fingerprint(generateMap(1, W, H, 'bridge'))).toMatchInlineSnapshot(`"dde3e10d"`);
    expect(fingerprint(generateMap(2, W, H, 'bridge'))).toMatchInlineSnapshot(`"20f5193"`);
  });

  it('pins the bourg with relief off — the stage is purely additive', () => {
    // Relief writes elev, the two new terrain keys and crossings, and nothing
    // else: no street, plot, wall, door, storey or objective of the bourg
    // pipeline moves. They are deliberately NOT inline snapshots — an `-u` run
    // must never be able to "fix" them. Held T14's values until the woods-stand
    // outline change, which repaints every kind's stands; recaptured by hand
    // from `npx vite-node scripts/fp.mjs --kind bourg`, seeds 1 and 2.
    expect(fingerprint(generateMap(1, W, H, 'bourg', { relief: 'none' }))).toBe('f367ec03');
    expect(fingerprint(generateMap(2, W, H, 'bourg', { relief: 'none' }))).toBe('74a3b973');
  });

  // RETIRED at the mapgen-v3 P6 cutover: §5.1's one-draw guard test, which
  // pinned the kinds the legacy pipeline still owned and asserted that no
  // bourg tuning could reach them. 'road' left it at P2, 'open' at P3, 'woods'
  // at P4, the water kinds at P5 and 'town' — the last legacy kind — was
  // retired with the pipeline itself. The property it protected did not go
  // away, it changed shape: the guard was D1 (a branch before the first draw),
  // and what enforces it now is D2 alone (one shared-stream draw per attempt,
  // every stage on its own sub-stream). The six per-kind pins above are the
  // whole tripwire, and a profile change that moves a kind other than the one
  // being tuned fails one of them.

  it('gives every stage tag a disjoint sub-stream', () => {
    // §2.1's rule, stated as something checkable. mulberry32 is a 32-bit
    // counter advancing by 0x6d2b79f5 per call (rng.ts:11), so two streams
    // whose seeds differ by a MULTIPLE of that constant do not merely correlate
    // — they are the same sequence, shifted. Math.imul(tag, 0x9e3779b1) is what
    // keeps the tags off those offsets. The control below proves the check has
    // teeth rather than passing on any two streams at all.
    const tags = Object.values(TAG);
    expect(new Set(tags).size).toBe(tags.length); // no stage shares another's stream
    const first = (r: Rng, n: number): number[] => Array.from({ length: n }, () => r.next());
    for (const base of [0, 1, 12345, 0x2f3a9c11, 0x7ffffffe])
      for (let i = 0; i < tags.length; i++)
        for (let j = i + 1; j < tags.length; j++) {
          const a = new Set(first(subStream(base, tags[i]), 16));
          const shared = first(subStream(base, tags[j]), 16).filter((v) => a.has(v));
          expect([base, tags[i], tags[j], shared]).toEqual([base, tags[i], tags[j], []]);
        }
    // control: seeds one counter-step apart ARE the same stream one call late
    const a = first(mulberry32(12345), 16);
    const b = first(mulberry32((12345 + 0x6d2b79f5) | 0), 16);
    expect(b.slice(0, 15)).toEqual(a.slice(1));
  });

  it('hands every stage a fresh stream, so no stage inherits another stage cursor', () => {
    // D2 is only real if S(tag) restarts. If it returned a memoised generator,
    // a stage that took one extra draw would shift every LATER consumer of the
    // same tag — which is exactly the coupling the sub-streams exist to remove.
    const sk = buildSkeleton(mulberry32(7).int(0x7fffffff), W, H, BOURG);
    for (const tag of Object.values(TAG)) {
      const a = sk.S(tag);
      const first = [a.next(), a.next(), a.next()];
      const b = sk.S(tag);
      expect([tag, [b.next(), b.next(), b.next()]]).toEqual([tag, first]);
    }
  });

  it('confines a stage tag perturbation to that stage output', () => {
    // §5.4's sub-stream independence, in the only form a strictly sequential
    // pipeline admits: every stage after N consumes stage N's geometry, so
    // perturbing an EARLY tag legitimately moves everything downstream. What is
    // testable — and what D2 actually buys — is that a stage whose output
    // nothing downstream reads cannot move anything else. Orchards and fields
    // (tag 12) are painted last, only over leftover grass; hedges (tag 11) and
    // woods stands (tag 13) run before them. Retuning the orchard schedule must
    // therefore leave the hedgerow network, the woods and the objectives alone.
    for (const seed of [4, 12]) {
      const a = pipeline(seed);
      const b = pipeline(seed, TAG.ORCHARD);
      expect(a.buildings).toEqual(b.buildings);
      expect(a.stands).toEqual(b.stands);
      expect(a.map.hEdges).toEqual(b.map.hEdges);
      expect(a.map.vEdges).toEqual(b.map.vEdges);
      expect(a.map.buildingId).toEqual(b.map.buildingId);
      expect(countKey(a.map, 'hedge')).toBe(countKey(b.map, 'hedge'));
      // …and the perturbation has to actually DO something, or the assertions
      // above are vacuous
      expect(countKey(a.map, 'field')).not.toBe(countKey(b.map, 'field'));
    }
  });
});

// ── V4-P1 · bocage coherence battery (§5) ─────────────────────────────────

// R-G1 invariant: hedges are 1-wide lines, not 2-wide bands. A 2-wide band
// shows up as a run of hedge tiles where the perpendicular neighbor on the
// SAME side is also hedge. Scan every hedge tile; for runs ≥8, if >70% have
// the same-side flank, it's a band.
function hedgeBandProbe(map: GameMap): { runLen: number; bandPct: number }[] {
  const { w, h } = map;
  const isHedge = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && map.terrainKeyAt(x, y) === 'hedge';
  const runs: { runLen: number; bandPct: number }[] = [];
  // horizontal runs
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const hHere = x < w && isHedge(x, y);
      if (hHere && start < 0) start = x;
      if (!hHere && start >= 0) {
        const runLen = x - start;
        if (runLen >= 8) {
          let flanked = 0;
          for (let rx = start; rx < x; rx++) {
            // check north AND south: if either is hedge, this is a band tile
            if (isHedge(rx, y - 1) || isHedge(rx, y + 1)) flanked++;
          }
          runs.push({ runLen, bandPct: flanked / runLen });
        }
        start = -1;
      }
    }
  }
  // vertical runs
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const hHere = y < h && isHedge(x, y);
      if (hHere && start < 0) start = y;
      if (!hHere && start >= 0) {
        const runLen = y - start;
        if (runLen >= 8) {
          let flanked = 0;
          for (let ry = start; ry < y; ry++) {
            // check east AND west
            if (isHedge(x - 1, ry) || isHedge(x + 1, ry)) flanked++;
          }
          runs.push({ runLen, bandPct: flanked / runLen });
        }
        start = -1;
      }
    }
  }
  return runs;
}

describe('V4-P1 bocage coherence (§5)', () => {
  const PROBE_SEEDS = Array.from({ length: 13 }, (_, i) => i + 1);

  it('has no 2-wide hedge band on any kind (R-G1)', () => {
    // R-G1 replaced "any 4-neighbour" with "east/south owner-change only", so
    // a hedge is now a 1-wide line. A run ≥8 with >70% same-side flank is a
    // 2-wide band — the audit measured 55-60% of such runs before this change.
    const KINDS = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'] as const;
    for (const kind of KINDS)
      for (const seed of PROBE_SEEDS) {
        const { map } = generateMap(seed, W, H, kind);
        const bands = hedgeBandProbe(map).filter((r) => r.bandPct > 0.7);
        expect([kind, seed, bands.length]).toEqual([kind, seed, 0]);
      }
  });

  it('paints every field tile inside a crop-assigned parcel (R-F1 invariant)', () => {
    // R-F1 assigns land use per site; R-F2 paints fields only where the owner
    // map says crop. Every field tile must have owner ≥ 0 and landUse[owner] = 1.
    const KINDS = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'] as const;
    for (const kind of KINDS)
      for (const seed of PROBE_SEEDS) {
        const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
        const plan = planBourg(base, W, H, PROFILES[kind]);
        const map = new GameMap(W, H);
        stampBourg(map, plan);
        const bad: string[] = [];
        for (let i = 0; i < map.tiles.length; i++) {
          if (map.terrainKeyAt(i % W, (i / W) | 0) !== 'field') continue;
          const ownerIdx = plan.rural.owner[i];
          if (ownerIdx < 0) {
            bad.push(`field@${i % W},${(i / W) | 0} has no owner`);
            continue;
          }
          if (plan.rural.landUse[ownerIdx] !== 1) {
            bad.push(`field@${i % W},${(i / W) | 0} owner=${ownerIdx} landUse=${plan.rural.landUse[ownerIdx]}`);
          }
        }
        expect([kind, seed, bad]).toEqual([kind, seed, []]);
      }
  });
});

function countKey(map: GameMap, key: string): number {
  let n = 0;
  for (let i = 0; i < map.tiles.length; i++) if (map.terrainKeyAt(i % map.w, (i / map.w) | 0) === key) n++;
  return n;
}

// plan.ts's stage order, with one tag's sub-stream re-seeded. Deliberately NOT
// routed through planBourg/stampBourg: the point is to substitute Skeleton.S,
// and tests/bourg-objectives.test.ts already asserts plan.ts's own ordering.
function pipeline(seed: number, perturb?: number): { map: GameMap; buildings: Building[]; stands: Vec[] } {
  const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
  const sk = buildSkeleton(base, W, H, BOURG);
  if (perturb !== undefined) {
    const alt = (base ^ 0x5bf03635) >>> 0;
    (sk as { S: (tag: number) => Rng }).S = (tag: number) => subStream(tag === perturb ? alt : base, tag);
  }
  const land = reserveLandmarks(sk as Skeleton);
  growMinorStreets(sk as Skeleton, { resv: land.resv, blocked: land.resv });
  const pc = buildParcels(sk as Skeleton, land.resv);
  const fp = buildFootprints(sk as Skeleton, land, pc);
  const rural = addRuralFabric(sk as Skeleton, land, pc, fp);
  const map = new GameMap(W, H);
  const stands = paintRural(map, sk as Skeleton, land, pc, fp, rural);
  for (let i = 0; i < sk.road.length; i++) if (sk.road[i]) map.setTerrain(i % W, (i / W) | 0, 'road');
  fp.buildings.forEach((b, i) => stampStructure(map, b, i));
  stampEnclosures(map, sk as Skeleton, land, fp);
  return { map, buildings: fp.buildings, stands };
}

// ── V4-P2 farm variety + overlap exclusions (§5) ───────────────────────────

describe('V4-P2 farm variety and overlap exclusions (§5)', () => {
  const FARM_SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

  it('produces all four rotations and ≥20% L-shapes over 40 seeds', () => {
    const rots = new Set<number>();
    let lShapes = 0;
    let farmCount = 0;
    for (const seed of FARM_SEEDS) {
      const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
      const plan = planBourg(base, W, H, PROFILES['open']);
      const { rural, fp } = plan;
      // Re-derive rotations from farm building positions
      for (let fi = 0; fi < rural.farms.length; fi++) {
        farmCount++;
        // first farm building = logis, second = grange
        const baseIdx = fp.buildings.length - 2 * rural.farms.length + fi * 2;
        const logis = fp.buildings[baseIdx];
        const grange = fp.buildings[baseIdx + 1];
        if (!logis || !grange) continue;
        // Determine rotation from relative positions
        if (logis.y + logis.h <= grange.y) rots.add(0); // N→S
        else if (grange.y + grange.h <= logis.y) rots.add(1); // S→N
        else if (logis.x + logis.w <= grange.x) rots.add(2); // E→W
        else if (grange.x + grange.w <= logis.x) rots.add(3); // W→E
        // L-shape: logis has parts.length > 1
        if ((logis.parts?.length ?? 1) > 1) lShapes++;
      }
    }
    expect(rots.size).toBe(4);
    expect(lShapes / Math.max(1, farmCount)).toBeGreaterThanOrEqual(0.20);
  });

  it('has zero tail-on-floor marks (R-O1)', () => {
    // R-O1: tail[] never marks building floor tiles. After enclosures run,
    // verify: for every garden rect, no tile marked as garden (by wall
    // adjacency) is also a building floor.
    // We verify via the pipeline: stamp map, then check that every garden
    // wall edge's inside tile is NOT a building floor. Since tail[]
    // controls which tiles are "inside" a garden, and R-O1 excludes
    // fp.occ tiles from tail[], no garden wall should have a building on
    // its inside.
    const KINDS = ['bourg', 'road', 'open'] as const;
    for (const kind of KINDS)
      for (const seed of [1, 2, 3, 7, 13]) {
        const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
        const plan = planBourg(base, W, H, PROFILES[kind]);
        const gmap = new GameMap(W, H);
        stampBourg(gmap, plan);
        // Check: no garden WALL_HIGH (top 2) edge has fp.occ on BOTH sides.
        // Garden walls separate garden from non-garden; with R-O1, a building
        // inside a garden rect is NOT marked in tail[], so a garden wall
        // should never have a building on its inside.
        // We check WALL_HIGH edges: if one side is fp.occ, the other side
        // must also be fp.occ (building wall, not garden wall) or the edge
        // should not be WALL.
        // Simpler: iterate fp.occ tiles that fall inside any garden rect.
        // For each such tile, the 4-neighbour edges should not have our
        // WALL_HIGH between it and a non-occ garden tile (that would mean
        // tail[] marked the occ tile as garden).
        let bad = 0;
        for (const g of plan.fp.gardens) {
          for (let y = g.rect.y; y < g.rect.y + g.rect.h; y++) {
            for (let x = g.rect.x; x < g.rect.x + g.rect.w; x++) {
              if (!plan.fp.occ[y * W + x]) continue;
              // This is a building floor tile inside a garden rect.
              // R-O1 says tail[] should NOT mark it. Check that no garden
              // wall separates it from adjacent non-occ garden tiles:
              // - hEdge above: if non-occ tile (x, y-1) is in garden AND
              //   this edge is WALL with our top 2 => tail[] marked this
              //   tile as garden => BAD
              if (y > 0 && !plan.fp.occ[(y - 1) * W + x]) {
                const ng = plan.fp.gardens.findIndex(
                  (gg) => x >= gg.rect.x && x < gg.rect.x + gg.rect.w && (y - 1) >= gg.rect.y && (y - 1) < gg.rect.y + gg.rect.h
                );
                if (ng >= 0) {
                  // adjacent non-occ tile is also in a garden. If there's a WALL
                  // between them, it means tail[] considers both sides garden.
                  const edge = gmap.hEdge(x, y);
                  const top = gmap.hEdgeTops[y * W + x];
                  // WALL_LOW (top=1) is only placed by enclosures for garden
                  // lateral walls. Building walls have different tops.
                  if (edge === EDGE.WALL && top === 1) bad++;
                }
              }
              if (y + 1 < H && !plan.fp.occ[(y + 1) * W + x]) {
                const ng = plan.fp.gardens.findIndex(
                  (gg) => x >= gg.rect.x && x < gg.rect.x + gg.rect.w && (y + 1) >= gg.rect.y && (y + 1) < gg.rect.y + gg.rect.h
                );
                if (ng >= 0) {
                  const edge = gmap.hEdge(x, y + 1);
                  if (edge === EDGE.WALL && gmap.hEdgeTops[(y + 1) * W + x] === 1) bad++;
                }
              }
              if (x > 0 && !plan.fp.occ[y * W + (x - 1)]) {
                const ng = plan.fp.gardens.findIndex(
                  (gg) => (x - 1) >= gg.rect.x && (x - 1) < gg.rect.x + gg.rect.w && y >= gg.rect.y && y < gg.rect.y + gg.rect.h
                );
                if (ng >= 0) {
                  const edge = gmap.vEdge(x, y);
                  if (edge === EDGE.WALL && gmap.vEdgeTops[y * (W + 1) + x] === 1) bad++;
                }
              }
              if (x + 1 < W && !plan.fp.occ[y * W + (x + 1)]) {
                const ng = plan.fp.gardens.findIndex(
                  (gg) => (x + 1) >= gg.rect.x && (x + 1) < gg.rect.x + gg.rect.w && y >= gg.rect.y && y < gg.rect.y + gg.rect.h
                );
                if (ng >= 0) {
                  const edge = gmap.vEdge(x + 1, y);
                  if (edge === EDGE.WALL && gmap.vEdgeTops[y * (W + 1) + x + 1] === 1) bad++;
                }
              }
            }
          }
        }
        expect([kind, seed, bad]).toEqual([kind, seed, 0]);
      }
  });

  it('has no parallel rear wall runs (R-O2 one-wall rule)', () => {
    // After R-O2, no two adjacent WALL_HIGH segments should run parallel
    // behind back-to-back gardens. Check: scan hEdges and vEdges for adjacent
    // parallel WALL runs where both edges are WALL_HIGH.
    const KINDS = ['bourg', 'road', 'open'] as const;
    for (const kind of KINDS)
      for (const seed of [1, 2, 3, 7, 13]) {
        const mapPlan = generateMap(seed, W, H, kind);
        const map = mapPlan.map;
        let bad = 0;
        // Check horizontal edges: two parallel hEdge WALL runs (one above the other)
        for (let y = 1; y < H - 1; y++) {
          for (let x = 0; x < W; x++) {
            if (map.hEdge(x, y) !== EDGE.WALL || map.hEdgeTops[y * W + x] !== 2) continue;
            if (map.hEdge(x, y + 1) === EDGE.WALL && map.hEdgeTops[(y + 1) * W + x] === 2) bad++;
          }
        }
        // Check vertical edges: two parallel vEdge WALL runs (side by side)
        for (let y = 0; y < H; y++) {
          for (let x = 1; x < W - 1; x++) {
            if (map.vEdge(x, y) !== EDGE.WALL || map.vEdgeTops[y * (W + 1) + x] !== 2) continue;
            if (map.vEdge(x + 1, y) === EDGE.WALL && map.vEdgeTops[y * (W + 1) + x + 1] === 2) bad++;
          }
        }
        // Allow a small number: churchyard walls, compound walls, and farm
        // yard walls also use WALL_HIGH and may legitimately sit side by side.
        // The R-O2 rule only eliminates the 580-820 per-seed double runs
        // between back-to-back gardens. We assert the number is now small.
        expect([kind, seed, bad]).toEqual([kind, seed, bad < 50 ? bad : -1]);
        expect(bad).toBeLessThan(50);
      }
  });
});
