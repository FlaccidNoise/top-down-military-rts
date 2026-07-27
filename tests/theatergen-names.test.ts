import { describe, expect, it } from 'vitest';
import { planRivers } from '../src/strategic/theatergen/rivers';
import { planSettlements } from '../src/strategic/theatergen/settlements';
import { planNetwork } from '../src/strategic/theatergen/roads';
import { planRegions } from '../src/strategic/theatergen/regions';
import { nameAll } from '../src/strategic/theatergen/names';

const B = { w: 24000, h: 18000 };
const CFG = { townDensity: 1, townSpacingMinKm: 5, roadDensity: 2, railDensity: 1, terrainMix: 'bocage' as const, woodsShare: 2 };

const build = (base: number) => {
  const rivers = planRivers(base, 2, B);
  const settlements = planSettlements(base, CFG, B, rivers);
  const net = planNetwork(base, CFG, B, rivers, settlements);
  const { regions } = planRegions(base, CFG, B, rivers, net.nodes);
  const theaterName = nameAll(base, net.nodes, regions, rivers);
  return { rivers, net, regions, theaterName };
};

describe('T_NAMES over 64 seeds', () => {
  it('names everything, zero duplicates among nodes, every template exercised', () => {
    const templates = new Set<string>();
    for (let seed = 1; seed <= 64; seed++) {
      const { net, regions, rivers, theaterName } = build(seed * 7919);
      const names = net.nodes.map((n) => n.name);
      expect(new Set(names).size, `seed ${seed} duplicates`).toBe(names.length);
      expect(names.every((n) => n.length > 0)).toBe(true);
      expect(regions.every((r) => r.name.length > 0)).toBe(true);
      expect(rivers.every((r) => r.name.length > 0)).toBe(true);
      expect(theaterName.endsWith(' sector')).toBe(true);
      for (const n of net.nodes) {
        if (n.name.startsWith('Pont-') || n.name.startsWith('Gué-')) templates.add('crossing');
        else if (n.name.endsWith('-Halte')) templates.add('halt');
        else if (n.name.startsWith('La Croix-')) templates.add('cross');
        else if (/^(St|Ste|Notre)/.test(n.name)) templates.add('saint');
        else if (n.name.includes('-sur-')) templates.add('root-sur-river');
        else if (/(ville|Vicomte|Bessin|Campagne|Sec|Buissons|Bocage)$/.test(n.name)) templates.add('root-suffix');
        else templates.add('bare-root');
      }
    }
    expect([...templates].sort()).toEqual(['bare-root', 'cross', 'crossing', 'halt', 'root-suffix', 'root-sur-river', 'saint']);
  });

  it('geometry-keyed: a reversed node array renames NOTHING', () => {
    const base = 7919;
    const a = build(base);
    const byId = new Map(a.net.nodes.map((n) => [n.id, n.name]));
    const rivers = planRivers(base, 2, B);
    const settlements = planSettlements(base, CFG, B, rivers);
    const net = planNetwork(base, CFG, B, rivers, settlements);
    const { regions } = planRegions(base, CFG, B, rivers, net.nodes);
    const shuffled = [...net.nodes].reverse();
    nameAll(base, shuffled, regions, rivers);
    for (const n of net.nodes) expect(n.name, `node ${n.id}`).toBe(byId.get(n.id));
  });

  it('marsh and forest regions carry their class features', () => {
    const { regions } = build(7919);
    for (const r of regions) {
      if (r.terrainClass === 'forest') expect(r.name.startsWith('Bois de ')).toBe(true);
      if (r.terrainClass === 'marsh') expect(r.name.startsWith('Marais de ')).toBe(true);
    }
  });

  it('a theater with no towns throws by name, never names itself after nothing', () => {
    const { net, regions, rivers } = build(7919);
    const townless = net.nodes.filter((n) => n.kind !== 'town');
    expect(() => nameAll(7919, townless, regions, rivers)).toThrow('no town');
  });

  it('pins three seeds — theater, first node, main river', () => {
    const PINS: [number, string, string, string][] = [
      [7919, 'Pont-Aunay sector', 'Pont-Aunay', 'La Vire'],
      [15838, 'Gonfreville-les-Buissons sector', 'Gonfreville-les-Buissons', 'La Seulles'],
      [23757, 'Gué-de-Hottot sector', 'Gué-de-Hottot', 'La Sienne'],
    ];
    for (const [base, theater, firstNode, mainRiver] of PINS) {
      const { net, rivers, theaterName } = build(base);
      expect(theaterName, `base ${base}`).toBe(theater);
      expect(net.nodes[0].name).toBe(firstNode);
      expect(rivers[0].name).toBe(mainRiver);
    }
  });
});
