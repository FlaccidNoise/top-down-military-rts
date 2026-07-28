import { describe, expect, it } from 'vitest';
import { planRivers } from '../src/strategic/theatergen/rivers';
import { planSettlements, TOWN_SPACING_M, VILLAGE_SPACING_M } from '../src/strategic/theatergen/settlements';
import { MIN_EDGE_M, planNetwork } from '../src/strategic/theatergen/roads';
import { MOVE_MPM, type TheaterEdge, type TheaterNode, type Vec } from '../src/strategic/theater';

const B = { w: 24000, h: 18000 };
const CFG = { townDensity: 1, townSpacingMinKm: 5, roadDensity: 2, railDensity: 1 };

const build = (base: number) => {
  const rivers = planRivers(base, 2, B);
  const settlements = planSettlements(base, CFG, B, rivers);
  return { rivers, settlements, ...planNetwork(base, CFG, B, rivers, settlements) };
};

const SEEDS = Array.from({ length: 32 }, (_, i) => (i + 1) * 7919);
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

const fnv = (nums: (number | string)[]): number => {
  let h = 2166136261;
  for (const n of nums) {
    for (const ch of String(n)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    h ^= 44;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

describe('T_TOWNS + T_ROADS + T_CROSSINGS + T_RAIL over 32 seeds', () => {
  it('settlement bands: towns 3-5 spaced, >= 2 river-adjacent; villages 8-12 spaced', () => {
    for (const base of SEEDS) {
      const { rivers, nodes } = build(base);
      const towns = nodes.filter((n) => n.kind === 'town');
      const villages = nodes.filter((n) => n.kind === 'village');
      expect(towns.length, `base ${base} towns`).toBeGreaterThanOrEqual(3);
      expect(towns.length).toBeLessThanOrEqual(5);
      expect(villages.length, `base ${base} villages`).toBeGreaterThanOrEqual(8);
      expect(villages.length).toBeLessThanOrEqual(12);
      for (let i = 0; i < towns.length; i++)
        for (let j = i + 1; j < towns.length; j++)
          expect(dist(towns[i].pos, towns[j].pos), `base ${base} town spacing`).toBeGreaterThanOrEqual(TOWN_SPACING_M);
      const all = [...towns, ...villages];
      for (const v of villages)
        for (const o of all)
          if (o.id !== v.id) expect(dist(v.pos, o.pos), `base ${base} village spacing`).toBeGreaterThanOrEqual(VILLAGE_SPACING_M);
      const main = rivers[0].polyline;
      const nearMain = towns.filter((t) => main.some((p) => dist(p, t.pos) <= 900));
      expect(nearMain.length, `base ${base} river towns`).toBeGreaterThanOrEqual(2);
    }
  });

  it('main-river bridge band 2-4, fords 0-2', () => {
    for (const base of SEEDS) {
      const { nodes } = build(base);
      const mains = nodes.filter((n) => n.crossing?.riverId === 0);
      const bridges = mains.filter((n) => n.crossing!.kind === 'bridge').length;
      const fords = mains.filter((n) => n.crossing!.kind === 'ford').length;
      expect(bridges, `base ${base} bridges`).toBeGreaterThanOrEqual(2);
      expect(bridges).toBeLessThanOrEqual(4);
      expect(fords, `base ${base} fords`).toBeLessThanOrEqual(2);
    }
  });

  it('one foot component covering every node — halts included, no orphans', () => {
    for (const base of SEEDS) {
      const { nodes, edges } = build(base);
      const foot = edges.filter((e) => e.moveClass !== 'rail');
      const adj = new Map<number, number[]>();
      for (const e of foot) {
        adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
        adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
      }
      for (const n of nodes) expect(adj.has(n.id), `base ${base} node ${n.id} ${n.kind} has no foot edge`).toBe(true);
      const seen = new Set<number>([nodes[0].id]);
      const q = [nodes[0].id];
      while (q.length) {
        const x = q.pop()!;
        for (const m of adj.get(x) ?? [])
          if (!seen.has(m)) {
            seen.add(m);
            q.push(m);
          }
      }
      expect(seen.size, `base ${base} component`).toBe(nodes.length);
    }
  });

  it('every road-water intersection is minted or merged into a crossing-bearing node', () => {
    const segIntersect = (p1: Vec, p2: Vec, p3: Vec, p4: Vec): Vec | null => {
      const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
      const den = d1x * d2y - d1y * d2x;
      if (den === 0) return null;
      const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
      const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) return null;
      return { x: p1.x + d1x * t, y: p1.y + d1y * t };
    };
    for (const base of SEEDS) {
      const { rivers, nodes, edges } = build(base);
      const bearers = nodes.filter((n) => n.crossing !== null);
      for (const e of edges) {
        if (e.moveClass === 'rail') continue;
        for (const r of rivers) {
          for (let i = 1; i < e.polyline.length; i++) {
            for (let k = 1; k < r.polyline.length; k++) {
              const hit = segIntersect(e.polyline[i - 1], e.polyline[i], r.polyline[k - 1], r.polyline[k]);
              if (!hit) continue;
              const near = bearers.some((n) => dist(n.pos, hit) <= 1250);
              expect(near, `base ${base}: edge ${e.id} crosses river ${r.id} at ${hit.x | 0},${hit.y | 0} with no crossing node`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('MIN_EDGE_M holds on every foot edge; paceMpm and ranks are derived correctly', () => {
    for (const base of SEEDS) {
      const { edges } = build(base);
      for (const e of edges) {
        if (e.moveClass === 'rail') {
          expect(e.paceMpm).toBe(0);
          expect(e.kind).toBe('rail');
          continue;
        }
        expect(e.lengthM, `base ${base} edge ${e.id} ${e.moveClass}`).toBeGreaterThanOrEqual(MIN_EDGE_M);
        expect(e.paceMpm).toBe(MOVE_MPM[e.moveClass]);
        expect(e.rank).toBe(e.moveClass === 'highway' ? 0 : e.moveClass === 'road' ? 1 : 2);
      }
    }
  });

  it('later stages own regionId and names — placeholders here', () => {
    const { nodes } = build(7919);
    for (const n of nodes) {
      expect(n.regionId).toBe(-1);
      expect(n.name).toBe('');
    }
  });

  it('regenerates byte-identically and pins 8 seeds', () => {
    const one = build(7919);
    const two = build(7919);
    expect(one.nodes).toEqual(two.nodes);
    expect(one.edges).toEqual(two.edges);
    const hash = (nodes: TheaterNode[], edges: TheaterEdge[]): number =>
      fnv([
        ...nodes.flatMap((n) => [n.id, n.kind, n.pos.x, n.pos.y, n.crossing ? `${n.crossing.riverId}:${n.crossing.kind}` : '-']),
        ...edges.flatMap((e) => [e.id, e.a, e.b, e.moveClass, e.lengthM]),
      ]);
    const PINS: [number, number][] = [
      [7919, 469309550],
      [15838, 1750633508],
      [23757, 2424973556],
      [31676, 2694955381],
      [39595, 435976680],
      [47514, 2703101955],
      [55433, 3429890231],
      [63352, 1649283003],
    ];
    for (const [base, h] of PINS) {
      const { nodes, edges } = build(base);
      expect(hash(nodes, edges), `base ${base}`).toBe(h);
    }
  });

  it('rail is geometry only: no rail edge carries pace, halts spur to the foot net', () => {
    for (const base of SEEDS.slice(0, 8)) {
      const { nodes, edges } = build(base);
      const halts = nodes.filter((n) => n.kind === 'halt');
      expect(halts.length, `base ${base}`).toBeGreaterThanOrEqual(2); // termini at least
      for (const h of halts) {
        const spurs = edges.filter((e) => e.moveClass === 'track' && (e.a === h.id || e.b === h.id));
        expect(spurs.length, `base ${base} halt ${h.id} unspurred`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
