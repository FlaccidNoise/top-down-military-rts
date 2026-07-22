import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/mapgen';
import { astar } from '../src/sim/path';

// FNV-1a over the map's raw arrays — a compact geometry fingerprint.
function fingerprint(seed: number): string {
  const { map } = generateMap(seed);
  let h = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges]) {
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

describe('mapgen', () => {
  it('is deterministic: same seed → identical map and plan', () => {
    const a = generateMap(7);
    const b = generateMap(7);
    expect(fingerprint(7)).toBe(fingerprint(7));
    expect(a.map.tiles).toEqual(b.map.tiles);
    expect(a.map.hEdges).toEqual(b.map.hEdges);
    expect(a.map.vEdges).toEqual(b.map.vEdges);
    expect(a.buildings).toEqual(b.buildings);
    expect(a.spawns).toEqual(b.spawns);
    expect(a.objectives).toEqual(b.objectives);
  });

  it('rejects maps too small for the layout', () => {
    expect(() => generateMap(1, 59, 120)).toThrow(/too small/);
    expect(() => generateMap(1, 160, 39)).toThrow(/too small/);
  });

  it('matches known snapshots (catches accidental generator drift)', () => {
    expect(fingerprint(1)).toMatchInlineSnapshot(`"ef00920e"`);
    expect(fingerprint(2)).toMatchInlineSnapshot(`"2aa5e8b2"`);
  });

  it('spawns reach objectives and buildings on foot; the road carries vehicles (seeds 1-30)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = generateMap(seed);
      expect(p.buildings.length).toBeGreaterThanOrEqual(4);
      const { west, east } = p.spawns;
      for (const o of p.objectives) {
        expect(astar(p.map, west.x, west.y, o.x, o.y)).not.toBeNull();
        expect(astar(p.map, east.x, east.y, o.x, o.y)).not.toBeNull();
      }
      for (const b of p.buildings) {
        expect(astar(p.map, west.x, west.y, b.x + (b.w >> 1), b.y + (b.h >> 1))).not.toBeNull();
      }
      expect(astar(p.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
    }
  });

  it('village buildings stay first; farms append after (seeds 1-15)', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const p = generateMap(seed);
      for (const b of p.buildings.slice(0, 3)) {
        const d2 = (b.x - p.objectives[0].x) ** 2 + (b.y - p.objectives[0].y) ** 2;
        expect(d2).toBeLessThan(30 * 30);
      }
    }
  });

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
    // woods-stand fringe alone yields ~95 across seeds 1-5; orchards push it ~192
    expect(isolatedTrees).toBeGreaterThan(150);
  });
});
