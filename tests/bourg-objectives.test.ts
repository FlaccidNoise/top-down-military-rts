import { describe, expect, it } from 'vitest';
import { bourgSpawns, buildObjectives, GARRISON_RADIUS } from '../src/sim/bourg/objectives';
import { planBourg, stampBourg, type BourgPlan, type BourgStamp } from '../src/sim/bourg/plan';
import { GameMap } from '../src/sim/map';
import type { ObjectiveKind, Vec } from '../src/sim/mapgen';

// T10: the tagged objective list, the spawns and the greedy 45 m coverage fill,
// exercised over the assembled pipeline (planBourg + stampBourg — everything
// T11 has to call, in the order it has to call it).

const base = (seed: number): number => (seed * 0x9e3779b1) >>> 1;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const W = 320;
const H = 240;

interface Town {
  plan: BourgPlan;
  stamp: BourgStamp;
  map: GameMap;
  objectives: Vec[];
  kinds: ObjectiveKind[];
}

function build(seed: number, w = W, h = H): Town {
  const plan = planBourg(base(seed), w, h);
  const map = new GameMap(w, h);
  const stamp = stampBourg(map, plan);
  map.maxStories = stamp.maxStories;
  const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, stamp.woodsStands);
  return { plan, stamp, map, objectives, kinds: objectiveKinds };
}

const cache = new Map<number, Town>();
function town(seed: number): Town {
  let t = cache.get(seed);
  if (!t) {
    t = build(seed);
    cache.set(seed, t);
  }
  return t;
}

function flood(t: Town, from: Vec, mode: 'foot' | 'vehicle'): Uint8Array {
  const { map } = t;
  const seen = new Uint8Array(map.w * map.h);
  const q = new Int32Array(map.w * map.h);
  const start = Math.round(from.y) * map.w + Math.round(from.x);
  let head = 0;
  let toe = 0;
  seen[start] = 1;
  q[toe++] = start;
  while (head < toe) {
    const cur = q[head++];
    const cx = cur % map.w;
    const cy = (cur / map.w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni] || !map.canStep(cx, cy, nx, ny, mode)) continue;
      seen[ni] = 1;
      q[toe++] = ni;
    }
  }
  return seen;
}

describe('bourg objectives (T10)', () => {
  it('is deterministic through the whole assembled pipeline', () => {
    for (const seed of [3, 11, 19]) {
      const a = build(seed);
      const b = build(seed);
      expect(a.objectives).toEqual(b.objectives);
      expect(a.kinds).toEqual(b.kinds);
      expect(a.plan.spawns).toEqual(b.plan.spawns);
      expect(a.map.tiles).toEqual(b.map.tiles);
      expect(a.map.hEdges).toEqual(b.map.hEdges);
      expect(a.map.vEdges).toEqual(b.map.vEdges);
      expect(a.map.stairs).toEqual(b.map.stairs);
      expect(a.map.buildingId).toEqual(b.map.buildingId);
    }
  });

  it('pins the tagged prefix and keeps the arrays parallel', () => {
    for (const seed of SEEDS) {
      const { objectives, kinds } = town(seed);
      expect(kinds.length).toBe(objectives.length);
      expect(kinds[0]).toBe('place');
      expect(kinds[1]).toBe('woods');
      // w >= 240 keeps the third slot stage.mjs:65 already reads
      expect(objectives.length).toBeGreaterThanOrEqual(3);
      expect(objectives.length).toBeLessThanOrEqual(12);
      expect(kinds.filter((k) => k === 'church').length).toBe(1);
      // no duplicates: two objectives on one tile is one objective and a
      // wasted coverage slot
      const seen = new Set(objectives.map((o) => `${o.x},${o.y}`));
      expect(seen.size).toBe(objectives.length);
    }
  });

  it('puts the MG42 objective on road and every objective on passable ground', () => {
    for (const seed of SEEDS) {
      const { map, objectives } = town(seed);
      // scenario.ts:49 emplaces an MG42 on objectives[0]; patches.ts needs road
      // under it for the cobbles
      expect([seed, map.terrainKeyAt(objectives[0].x, objectives[0].y)]).toEqual([seed, 'road']);
      for (const o of objectives) expect([seed, o, map.terrainAt(o.x, o.y).passable]).toEqual([seed, o, true]);
    }
  });

  it('garrisons every building: no centre outside 45 m of an objective', () => {
    for (const seed of SEEDS) {
      const { plan, objectives } = town(seed);
      const uncovered = plan.fp.buildings.filter((b) => {
        const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        return !objectives.some(
          (o) => (c.x - o.x) * (c.x - o.x) + (c.y - o.y) * (c.y - o.y) <= GARRISON_RADIUS * GARRISON_RADIUS,
        );
      });
      expect([seed, uncovered.map((b) => `${b.role}@${b.x},${b.y}`)]).toEqual([seed, []]);
    }
  });

  it('reaches every objective from both spawns on foot, and east from west by road', () => {
    for (const seed of SEEDS) {
      const t = town(seed);
      const { west, east } = t.plan.spawns;
      expect(t.map.terrainKeyAt(west.x, west.y)).toBe('road');
      expect(t.map.terrainKeyAt(east.x, east.y)).toBe('road');
      const fromWest = flood(t, west, 'foot');
      const fromEast = flood(t, east, 'foot');
      const byRoad = flood(t, west, 'vehicle');
      for (const o of t.objectives) {
        expect([seed, o, fromWest[o.y * W + o.x]]).toEqual([seed, o, 1]);
        expect([seed, o, fromEast[o.y * W + o.x]]).toEqual([seed, o, 1]);
      }
      expect([seed, byRoad[east.y * W + east.x]]).toEqual([seed, 1]);
      // every door tile and every stair tile from the west spawn (§5.3)
      let strandedDoors = 0;
      for (const b of t.plan.fp.buildings) for (const d of b.doors ?? []) if (!fromWest[d.y * W + d.x]) strandedDoors++;
      let strandedStairs = 0;
      for (let i = 0; i < t.map.stairs.length; i++) if (t.map.stairs[i] && !fromWest[i]) strandedStairs++;
      expect([seed, strandedDoors, strandedStairs]).toEqual([seed, 0, 0]);
    }
  });

  it('survives every map size generateMap allows', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3, 4, 5]) {
        const t = build(seed, w, h);
        expect(t.kinds.length).toBe(t.objectives.length);
        expect(t.kinds[0]).toBe('place');
        expect(t.map.terrainKeyAt(t.objectives[0].x, t.objectives[0].y)).toBe('road');
        expect(bourgSpawns(t.plan.sk).west.x).toBe(3);
      }
  });
});
