// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GEN_VERSION } from '../src/campaign/spec';
import {
  BATTLE_CLASS_TO_MAPKIND,
  battleSiteOf,
  COARSE_DEF_MULT,
  CROSSING_ASSAULT_MULT,
  MOVE_MPM,
  pointAlong,
  REGION_PACE_MULT,
  siteKeyOf,
  THEATER_VERSION,
  type Theater,
  type TheaterEdge,
} from '../src/strategic/theater';

// Literal fixture: 24x18 km bounds, a river with one bridge and one ford
// node, a town, a village, a plain junction inside a forest region, and a
// road crossing farmland. Enough geometry to exercise every ladder rung.
const region = (
  id: number,
  terrainClass: Theater['regions'][number]['terrainClass'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Theater['regions'][number] => ({
  id,
  polygon: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
  centroid: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
  bbox: { x0, y0, x1, y1 },
  areaM2: (x1 - x0) * (y1 - y0),
  terrainClass,
  name: `r${id}`,
  seatNodeId: null,
});

const edge = (id: number, a: number, b: number, moveClass: TheaterEdge['moveClass'], pts: { x: number; y: number }[]): TheaterEdge => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return {
    id,
    a,
    b,
    kind: moveClass === 'rail' ? 'rail' : 'road',
    moveClass,
    polyline: pts,
    lengthM: Math.round(len),
    paceMpm: moveClass === 'rail' ? 0 : MOVE_MPM[moveClass],
    rank: moveClass === 'highway' ? 0 : moveClass === 'road' ? 1 : 2,
  };
};

const T: Theater = {
  version: THEATER_VERSION,
  seed: 7,
  name: 'Vireux sector',
  boundsM: { w: 24000, h: 18000 },
  nodes: [
    { id: 0, pos: { x: 2000, y: 2000 }, kind: 'town', name: 'Vireux', regionId: 3, crossing: null, rank: 0 },
    { id: 1, pos: { x: 6000, y: 2000 }, kind: 'village', name: 'St-Denis', regionId: 0, crossing: null, rank: 1 },
    { id: 2, pos: { x: 10000, y: 2000 }, kind: 'bridge', name: 'Pont-Neuf', regionId: 0, crossing: { riverId: 0, kind: 'bridge' }, rank: 2 },
    { id: 3, pos: { x: 10000, y: 6000 }, kind: 'ford', name: 'Gué-Bas', regionId: 0, crossing: { riverId: 0, kind: 'ford' }, rank: 2 },
    { id: 4, pos: { x: 3000, y: 9000 }, kind: 'junction', name: 'Bois-Carrefour', regionId: 1, crossing: null, rank: 2 },
  ],
  edges: [
    edge(0, 0, 1, 'road', [
      { x: 2000, y: 2000 },
      { x: 6000, y: 2000 },
    ]),
    edge(1, 1, 2, 'highway', [
      { x: 6000, y: 2000 },
      { x: 10000, y: 2000 },
    ]),
    edge(2, 0, 4, 'track', [
      { x: 2000, y: 2000 },
      { x: 3000, y: 9000 },
    ]),
    edge(3, 2, 3, 'road', [
      { x: 10000, y: 2000 },
      { x: 10000, y: 6000 },
    ]),
  ],
  regions: [
    region(0, 'farmland', 4000, 0, 24000, 8000),
    region(1, 'forest', 0, 4000, 4000, 18000),
    region(2, 'marsh', 4000, 8000, 24000, 18000),
    region(3, 'settlement', 0, 0, 4000, 4000),
  ],
  rivers: [{ id: 0, name: 'La Vire', polyline: [{ x: 10000, y: 0 }, { x: 10000, y: 18000 }], widthClass: 'river' }],
  objectiveNodes: [0, 2],
  sources: { blue: [0], red: [2] },
};

describe('constants', () => {
  it('THEATER_VERSION is GEN_VERSION — one version, two readers', () => {
    expect(THEATER_VERSION).toBe(GEN_VERSION);
  });

  it('MOVE_MPM: track x forest reproduces the pinned 3:1 road:woods ratio', () => {
    const trackForest = MOVE_MPM.track * REGION_PACE_MULT.forest; // 16.65
    expect(MOVE_MPM.road / trackForest).toBeCloseTo(3.003, 2);
  });

  it('MOVE_MPM: road x forest is 2:1 — the 3:1 figure is a track-class claim', () => {
    expect(MOVE_MPM.road / (MOVE_MPM.road * REGION_PACE_MULT.forest)).toBe(2);
  });

  it('COARSE_DEF_MULT is the break-even ratio fitted to fought battles (jtbug #797): a town 1.3, not the old x7 siege', () => {
    expect(COARSE_DEF_MULT).toEqual({ settlement: 1.3, hamlet: 0.85, forest: 1.45, farmland: 1.3, marsh: 1.0, roadside: 0.8, 'bridge-assault': 1.0, 'ford-assault': 1.33 });
    expect(CROSSING_ASSAULT_MULT).toBe(1.35);
  });

  it('BATTLE_CLASS_TO_MAPKIND is exactly the section-6 table', () => {
    expect(BATTLE_CLASS_TO_MAPKIND).toEqual({
      settlement: 'bourg',
      hamlet: 'open',
      forest: 'woods',
      farmland: 'open',
      marsh: 'open',
      roadside: 'road',
      'bridge-assault': 'bridge',
      'ford-assault': 'river',
    });
  });
});

describe('grep gate — the one MapKind table', () => {
  it('BATTLE_CLASS_TO_MAPKIND is the only Record<_, MapKind> in src/strategic', () => {
    const dir = new URL('../src/strategic/', import.meta.url);
    let hits = 0;
    for (const ent of readdirSync(dir) as string[]) {
      if (!ent.endsWith('.ts')) continue;
      const src = readFileSync(new URL(ent, dir), 'utf8') as string;
      hits += (src.match(/Record<[^>]*,\s*MapKind>/g) ?? []).length;
    }
    expect(hits).toBe(1);
  });
});

describe('siteKeyOf', () => {
  it('is stable across a JSON round-trip of the position', () => {
    const posN = { kind: 'node', nodeId: 2 } as const;
    const posE = { kind: 'edge', edgeId: 1, s: 1450, dir: 1 } as const;
    expect(siteKeyOf(JSON.parse(JSON.stringify(posN)))).toBe(siteKeyOf(posN));
    expect(siteKeyOf(JSON.parse(JSON.stringify(posE)))).toBe(siteKeyOf(posE));
  });

  it('a ±40 m s-perturbation inside one 100 m bucket keys the same site', () => {
    // Math.round buckets are [x50, x50+100): a ±40 window is round-stable
    // when centred on a multiple of 100.
    const base = siteKeyOf({ kind: 'edge', edgeId: 1, s: 1500, dir: 1 });
    expect(siteKeyOf({ kind: 'edge', edgeId: 1, s: 1460, dir: 1 })).toBe(base);
    expect(siteKeyOf({ kind: 'edge', edgeId: 1, s: 1540, dir: -1 })).toBe(base);
  });

  it('distant positions on one edge are DIFFERENT sites (the 9 km edge lesson)', () => {
    expect(siteKeyOf({ kind: 'edge', edgeId: 1, s: 100, dir: 1 })).not.toBe(
      siteKeyOf({ kind: 'edge', edgeId: 1, s: 3900, dir: 1 }),
    );
  });

  it('node and edge keyspaces are prefix-disjoint (the chit-id/cell-index lesson)', () => {
    expect(siteKeyOf({ kind: 'node', nodeId: 5 })).not.toBe(siteKeyOf({ kind: 'edge', edgeId: 5, s: 0, dir: 1 }));
  });
});

describe('battleSiteOf ladder', () => {
  it('crossing node + approach = crossing assault, by crossing kind', () => {
    expect(battleSiteOf(T, { kind: 'node', nodeId: 2 }, 1).battleClass).toBe('bridge-assault');
    expect(battleSiteOf(T, { kind: 'node', nodeId: 3 }, 3).battleClass).toBe('ford-assault');
  });

  it('crossing node WITHOUT an approach falls through to the region ladder', () => {
    expect(battleSiteOf(T, { kind: 'node', nodeId: 2 }).battleClass).toBe('farmland');
  });

  it('town → settlement, village → hamlet', () => {
    expect(battleSiteOf(T, { kind: 'node', nodeId: 0 }).battleClass).toBe('settlement');
    expect(battleSiteOf(T, { kind: 'node', nodeId: 1 }).battleClass).toBe('hamlet');
  });

  it('a plain node inside a forest region resolves by the region', () => {
    expect(battleSiteOf(T, { kind: 'node', nodeId: 4 }).battleClass).toBe('forest');
  });

  it('mid-edge on a metalled road through farmland = roadside; on a track = the region', () => {
    expect(battleSiteOf(T, { kind: 'edge', edgeId: 1, s: 2000, dir: 1 }).battleClass).toBe('roadside');
    // track edge 2 runs from the settlement into the forest; 5 km along it is in the woods
    expect(battleSiteOf(T, { kind: 'edge', edgeId: 2, s: 5000, dir: 1 }).battleClass).toBe('forest');
  });

  it('unknown node/edge ids throw named errors, never resolve silently', () => {
    expect(() => battleSiteOf(T, { kind: 'node', nodeId: 99 })).toThrow('unknown node 99');
    expect(() => battleSiteOf(T, { kind: 'edge', edgeId: 99, s: 0, dir: 1 })).toThrow('unknown edge 99');
  });

  it('an empty-regions theater throws, never invents a class', () => {
    expect(() => battleSiteOf({ ...T, regions: [] }, { kind: 'node', nodeId: 4 })).toThrow('no regions');
  });
});

describe('pointAlong', () => {
  it('interpolates along the polyline and clamps at both ends', () => {
    const e = T.edges[0]; // 4000 m straight east from (2000, 2000)
    expect(pointAlong(e, 0)).toEqual({ x: 2000, y: 2000 });
    expect(pointAlong(e, 1000)).toEqual({ x: 3000, y: 2000 });
    expect(pointAlong(e, 99999)).toEqual({ x: 6000, y: 2000 });
    expect(pointAlong(e, -5)).toEqual({ x: 2000, y: 2000 });
  });
});
