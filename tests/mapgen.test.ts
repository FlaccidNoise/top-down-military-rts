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
      expect(p.woodsStands.length).toBeGreaterThan(0);
      for (const s of p.woodsStands) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(p.map.w);
        expect(s.y).toBeLessThan(p.map.h);
      }
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

  it('bridge maps: water river, road bridge objective, spawns connected across it (320x240)', () => {
    for (const seed of [1, 5, 9]) {
      const p = generateMap(seed, 320, 240, 'bridge');
      let water = 0;
      for (let y = 0; y < p.map.h; y++)
        for (let x = 0; x < p.map.w; x++) if (p.map.terrainKeyAt(x, y) === 'water') water++;
      expect(water).toBeGreaterThan(500); // 3-wide band over 240 rows, minus road crossings
      const bridge = p.objectives[p.objectives.length - 1];
      expect(p.map.terrainKeyAt(bridge.x, bridge.y)).toBe('road');
      const { west, east } = p.spawns;
      for (const o of p.objectives) {
        expect(astar(p.map, west.x, west.y, o.x, o.y)).not.toBeNull();
        expect(astar(p.map, east.x, east.y, o.x, o.y)).not.toBeNull();
      }
      expect(astar(p.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
    }
  });

  it('bridge maps are deterministic per seed', () => {
    const a = generateMap(5, 320, 240, 'bridge');
    const b = generateMap(5, 320, 240, 'bridge');
    expect(a.map.tiles).toEqual(b.map.tiles);
    expect(a.objectives).toEqual(b.objectives);
    expect(a.spawns).toEqual(b.spawns);
  });

  it('water blocks foot and vehicle movement', () => {
    const p = generateMap(1, 320, 240, 'bridge');
    let wx = -1, wy = -1;
    for (let y = 1; y < p.map.h - 1 && wx < 0; y++)
      for (let x = 1; x < p.map.w - 1 && wx < 0; x++)
        if (p.map.terrainKeyAt(x, y) === 'water' && p.map.terrainAt(x - 1, y).passable) { wx = x; wy = y; }
    expect(wx).toBeGreaterThanOrEqual(0);
    expect(p.map.canStep(wx - 1, wy, wx, wy)).toBe(false);
    expect(p.map.canStep(wx - 1, wy, wx, wy, 'vehicle')).toBe(false);
  });

  it('river maps carve a wider band than bridge maps', () => {
    const count = (kind: 'bridge' | 'river') => {
      const p = generateMap(2, 320, 240, kind);
      let n = 0;
      for (let y = 0; y < p.map.h; y++)
        for (let x = 0; x < p.map.w; x++) if (p.map.terrainKeyAt(x, y) === 'water') n++;
      return n;
    };
    expect(count('river')).toBeGreaterThan(count('bridge'));
  });

  it('large maps grow a second hamlet and stay connected (320x240)', () => {
    for (const seed of [1, 5, 9]) {
      const a = generateMap(seed, 320, 240);
      const b = generateMap(seed, 320, 240);
      expect(a.map.tiles).toEqual(b.map.tiles);
      expect(a.objectives.length).toBe(3);
      expect(a.buildings.length).toBeGreaterThanOrEqual(7);
      const hamlet = a.objectives[2];
      const hamletBuildings = a.buildings.filter(
        (b) => (b.x - hamlet.x) ** 2 + (b.y - hamlet.y) ** 2 < 22 * 22,
      ).length;
      expect(hamletBuildings).toBeGreaterThanOrEqual(3);
      const { west, east } = a.spawns;
      for (const o of a.objectives) expect(astar(a.map, west.x, west.y, o.x, o.y)).not.toBeNull();
      expect(astar(a.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
      expect(a.woodsStands.length).toBeGreaterThan(0);
      for (const s of a.woodsStands) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(a.map.w);
        expect(s.y).toBeLessThan(a.map.h);
      }
    }
  });
});
