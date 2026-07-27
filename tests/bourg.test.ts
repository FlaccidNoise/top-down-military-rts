import { describe, expect, it } from 'vitest';
import { generateMap, reachField, type Building, type MapPlan, type Vec } from '../src/sim/mapgen';
import { EDGE, GameMap } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { GARRISON_RADIUS } from '../src/sim/bourg/objectives';
import { partsOf } from '../src/sim/bourg/stamp';
import { buildFootprints } from '../src/sim/bourg/footprints';
import { reserveLandmarks } from '../src/sim/bourg/landmarks';
import { buildParcels } from '../src/sim/bourg/parcels';
import { addRuralFabric, paintRural } from '../src/sim/bourg/rural';
import { stampEnclosures } from '../src/sim/bourg/enclosures';
import { stampStructure } from '../src/sim/bourg/stamp';
import { buildSkeleton, growMinorStreets, subStream, TAG, type Skeleton } from '../src/sim/bourg/streets';
import { mulberry32, type Rng } from '../src/sim/rng';

// §5.2 / §5.3 / §5.4 of docs/plans/2026-07-26-town-gen-design.md, asserted
// through generateMap — the black-box suite. The per-stage files
// (tests/bourg-streets|landmarks|parcels|footprints|enclosures|rural|
// objectives|stamp.test.ts) test each stage against its own inputs and use a
// synthetic base; this file tests the thing the game actually calls, on the
// seeds the game actually uses, and is the only place the two are the same.

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
    // the runaway-parcelizer tripwire (footprints.ts MAX_BUILDINGS caps the
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

  // §5.1's one-draw guard. The MECHANISM is D1 (the guard sits before
  // tryGenerate's first draw) plus D2 (one shared-stream draw, inside it), but
  // the mechanism is not the test. tests/mapgen.test.ts:36-39 pins 'open';
  // these pin the other five, and all six were verified byte-identical to
  // `main` over 6 kinds x 3 sizes x 12 seeds at the commit that added them.
  it('leaves every legacy kind byte-identical', () => {
    const fp = (kind: 'woods' | 'town' | 'river' | 'bridge' | 'road', seed: number): string =>
      fingerprint(generateMap(seed, 160, 120, kind));
    expect([fp('woods', 1), fp('woods', 2)]).toMatchInlineSnapshot(`
      [
        "90b98069",
        "ca094aca",
      ]
    `);
    expect([fp('town', 1), fp('town', 2)]).toMatchInlineSnapshot(`
      [
        "18f01cb4",
        "d4caebbc",
      ]
    `);
    expect([fp('river', 1), fp('river', 2)]).toMatchInlineSnapshot(`
      [
        "7fe2cc50",
        "5d499530",
      ]
    `);
    expect([fp('bridge', 1), fp('bridge', 2)]).toMatchInlineSnapshot(`
      [
        "f4c971ab",
        "c4340672",
      ]
    `);
    expect([fp('road', 1), fp('road', 2)]).toMatchInlineSnapshot(`
      [
        "8105059f",
        "d2a77805",
      ]
    `);
  });

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
    const sk = buildSkeleton(mulberry32(7).int(0x7fffffff), W, H);
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
  const sk = buildSkeleton(base, W, H);
  if (perturb !== undefined) {
    const alt = (base ^ 0x5bf03635) >>> 0;
    (sk as { S: (tag: number) => Rng }).S = (tag: number) => subStream(tag === perturb ? alt : base, tag);
  }
  const land = reserveLandmarks(sk as Skeleton);
  growMinorStreets(sk as Skeleton, { resv: land.resv });
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
