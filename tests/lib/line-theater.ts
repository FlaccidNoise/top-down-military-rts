// Shared hand-built line theater A(0)–B(1)–C(2)–D(3): 2000 m plain road
// edges through one farmland region, blue sources west, red east. Precise
// control over graph distances for the supply/intel/fatigue batteries.
import { addForce, type Force, type FrontV2 } from '../../src/strategic/theater/force';
import type { Theater } from '../../src/strategic/theater';

export const lineTheater = (): Theater => {
  const node = (id: number, x: number): Theater['nodes'][number] => ({
    id, pos: { x, y: 1000 }, kind: 'crossroads', name: `N${id}`, regionId: 0, crossing: null, rank: 2,
  });
  const edge = (id: number, a: number, b: number): Theater['edges'][number] => ({
    id, a, b, kind: 'road', moveClass: 'road',
    polyline: [{ x: a * 2000, y: 1000 }, { x: b * 2000, y: 1000 }], lengthM: 2000, paceMpm: 50, rank: 1,
  });
  return {
    version: 1, seed: 0, name: 'Ligne', boundsM: { w: 8000, h: 2000 },
    nodes: [node(0, 0), node(1, 2000), node(2, 4000), node(3, 6000)],
    edges: [edge(0, 0, 1), edge(1, 1, 2), edge(2, 2, 3)],
    regions: [{
      id: 0, polygon: [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 2000 }, { x: 0, y: 2000 }],
      centroid: { x: 4000, y: 1000 }, bbox: { x0: 0, y0: 0, x1: 8000, y1: 2000 },
      areaM2: 16_000_000, terrainClass: 'farmland', name: 'Plaine', seatNodeId: null,
    }],
    rivers: [], objectiveNodes: [2], sources: { blue: [0], red: [3] },
  };
};

export const lineFront = (): FrontV2 => ({
  theater: lineTheater(), clockMin: 0, day: 1, nextForceId: 0, nextBattleId: 0,
  forces: [], controlByNode: ['blue', 'blue', 'red', 'red'], battles: [], events: [], defileQueues: {},
});

export const place = (fr: FrontV2, side: 'blue' | 'red', nodeId: number, strength = 100): Force =>
  addForce(fr, {
    side, name: side === 'blue' ? 'Able' : 'Wache', pos: { kind: 'node', nodeId }, path: [],
    dwellMin: 0, strength, companyIndex: side === 'blue' ? 0 : -1, role: 'line', engagedIn: null, queuedAt: null,
  });
