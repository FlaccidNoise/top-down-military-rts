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

  it('matches known snapshots (catches accidental generator drift)', () => {
    expect(fingerprint(1)).toMatchInlineSnapshot(`"edc6ca5c"`);
    expect(fingerprint(2)).toMatchInlineSnapshot(`"7b13704f"`);
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
});
