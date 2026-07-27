import { describe, expect, it } from 'vitest';
import { planRivers } from '../src/strategic/theatergen/rivers';
import { planSettlements } from '../src/strategic/theatergen/settlements';
import { planNetwork } from '../src/strategic/theatergen/roads';
import { MARSH_RIVER_M, planRegions } from '../src/strategic/theatergen/regions';
import type { Vec } from '../src/strategic/theater';

const B = { w: 24000, h: 18000 };
const CFG = { townDensity: 1, townSpacingMinKm: 5, roadDensity: 2, railDensity: 1, terrainMix: 'bocage' as const, woodsShare: 2 };

const build = (base: number) => {
  const rivers = planRivers(base, 2, B);
  const settlements = planSettlements(base, CFG, B, rivers);
  const net = planNetwork(base, CFG, B, rivers, settlements);
  return { rivers, net, ...planRegions(base, CFG, B, rivers, net.nodes) };
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

describe('T_REGIONS over 32 seeds', () => {
  it('integer-only emissions: every coordinate and area is an integer', () => {
    for (const base of SEEDS.slice(0, 8)) {
      const { regions } = build(base);
      for (const r of regions) {
        expect(Number.isInteger(r.centroid.x) && Number.isInteger(r.centroid.y)).toBe(true);
        expect(Number.isInteger(r.areaM2)).toBe(true);
        for (const p of r.polygon) expect(Number.isInteger(p.x) && Number.isInteger(p.y), `base ${base} region ${r.id}`).toBe(true);
      }
    }
  });

  it('no orphan nodes: every network node resolves to a region', () => {
    for (const base of SEEDS) {
      const { net, regionIdAt, regions } = build(base);
      for (const n of net.nodes) {
        const rid = regionIdAt(n.pos.x, n.pos.y);
        expect(rid, `base ${base} node ${n.id}`).toBeGreaterThanOrEqual(0);
        expect(rid).toBeLessThan(regions.length);
      }
    }
  });

  it('region count sits in the 25-40 band', () => {
    for (const base of SEEDS) {
      const { regions } = build(base);
      expect(regions.length, `base ${base}`).toBeGreaterThanOrEqual(25);
      expect(regions.length).toBeLessThanOrEqual(40);
    }
  });

  it('marsh only near water: every marsh region touches a river corridor', () => {
    for (const base of SEEDS) {
      const { regions, rivers } = build(base);
      for (const r of regions.filter((x) => x.terrainClass === 'marsh')) {
        const near = rivers.some((rv) =>
          rv.polyline.some((v) => r.polygon.some((p) => dist(p, v) <= MARSH_RIVER_M + 1500)),
        );
        expect(near, `base ${base} marsh region ${r.id} is dry`).toBe(true);
      }
    }
  });

  it('forest forms 1-3 massifs (single-linkage clusters at site spacing)', () => {
    for (const base of SEEDS) {
      const { regions } = build(base);
      const forest = regions.filter((r) => r.terrainClass === 'forest');
      expect(forest.length, `base ${base}`).toBeGreaterThanOrEqual(1);
      const parent = forest.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < forest.length; i++)
        for (let j = i + 1; j < forest.length; j++)
          if (dist(forest[i].centroid, forest[j].centroid) < 6500) parent[find(i)] = find(j);
      const massifs = new Set(forest.map((_, i) => find(i))).size;
      expect(massifs, `base ${base}`).toBeLessThanOrEqual(3);
    }
  });

  it('area mix: hard within widened tolerance every seed, fully in-band on >= 24/32', () => {
    let fully = 0;
    for (const base of SEEDS) {
      const { regions } = build(base);
      const total = regions.reduce((a, r) => a + r.areaM2, 0);
      const share = (k: string): number => regions.filter((r) => r.terrainClass === k).reduce((a, r) => a + r.areaM2, 0) / total;
      const f = share('farmland');
      const bo = share('bocage');
      const fo = share('forest');
      const m = share('marsh');
      const s = share('settlement');
      // Hard envelope (band ± 2 pts) — a seed outside THIS is a generator bug,
      // not a tail; S11's validation + reroll owns the strict band.
      expect(f, `base ${base} farmland`).toBeGreaterThanOrEqual(0.28);
      expect(f).toBeLessThanOrEqual(0.47);
      expect(bo, `base ${base} bocage`).toBeGreaterThanOrEqual(0.23);
      expect(bo).toBeLessThanOrEqual(0.42);
      expect(fo, `base ${base} forest`).toBeGreaterThanOrEqual(0.08);
      expect(fo).toBeLessThanOrEqual(0.22);
      expect(m, `base ${base} marsh`).toBeGreaterThanOrEqual(0.01);
      expect(m).toBeLessThanOrEqual(0.1);
      expect(s, `base ${base} settlement`).toBeGreaterThanOrEqual(0.01);
      expect(s).toBeLessThanOrEqual(0.08);
      const inBand =
        f >= 0.3 && f <= 0.45 && bo >= 0.25 && bo <= 0.4 && fo >= 0.1 && fo <= 0.2 && m >= 0.03 && m <= 0.08 && s >= 0.03 && s <= 0.06;
      if (inBand) fully++;
    }
    expect(fully).toBeGreaterThanOrEqual(24);
  });

  it('polygon area agrees with the cell area within lattice tolerance', () => {
    for (const base of SEEDS.slice(0, 8)) {
      const { regions } = build(base);
      for (const r of regions) {
        let a2 = 0;
        for (let i = 0; i < r.polygon.length; i++) {
          const p = r.polygon[i];
          const q = r.polygon[(i + 1) % r.polygon.length];
          a2 += p.x * q.y - q.x * p.y;
        }
        expect(Math.abs(Math.abs(a2) / 2 - r.areaM2) / r.areaM2, `base ${base} region ${r.id}`).toBeLessThanOrEqual(0.25);
      }
    }
  });

  it('settlement regions seat towns; names wait for T_NAMES', () => {
    const { regions, net } = build(7919);
    for (const r of regions) {
      expect(r.name).toBe('');
      if (r.terrainClass === 'settlement') {
        expect(r.seatNodeId, `region ${r.id}`).not.toBeNull();
        const seat = net.nodes.find((n) => n.id === r.seatNodeId)!;
        expect(seat.kind === 'town' || seat.kind === 'village').toBe(true);
      }
    }
  });

  it('regenerates byte-identically and pins 8 seeds', () => {
    const a = build(7919);
    const b = build(7919);
    expect(a.regions).toEqual(b.regions);
    const PINS: [number, number][] = [
      [7919, 2259695549],
      [15838, 2034125012],
      [23757, 2248528667],
      [31676, 2851579293],
      [39595, 1109657809],
      [47514, 897522871],
      [55433, 756876003],
      [63352, 3228332826],
    ];
    for (const [base, h] of PINS) {
      const { regions } = build(base);
      expect(
        fnv(regions.flatMap((r) => [r.id, r.terrainClass, r.areaM2, r.centroid.x, r.centroid.y, r.polygon.length])),
        `base ${base}`,
      ).toBe(h);
    }
  });
});
