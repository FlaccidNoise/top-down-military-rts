import { describe, expect, it } from 'vitest';
import { TERRAIN, type TerrainKey } from '../src/sim/data';
import { GameMap } from '../src/sim/map';

// V1 (verticality design H6/H1): 'bank' and 'rail' append after 'water'.
// GameMap.tiles stores the POSITIONAL index of a key in Object.keys(TERRAIN),
// so any reorder silently rewrites every existing map. These assertions are the
// tripwire; the mapgen fingerprints are the second one.
describe('terrain key indices', () => {
  const keys = Object.keys(TERRAIN) as TerrainKey[];

  it('grass..water hold indices 0..6 and the new keys append after them', () => {
    expect(keys).toEqual(['grass', 'road', 'woods', 'floor', 'hedge', 'field', 'water', 'bank', 'rail']);
  });

  it('bank and rail are foot-passable', () => {
    expect(TERRAIN.bank.passable).toBe(true);
    expect(TERRAIN.rail.passable).toBe(true);
  });

  it('bank is slower than field and faster than hedge; rail is ballast-slow', () => {
    expect(TERRAIN.bank.moveCost).toBeGreaterThan(TERRAIN.field.moveCost);
    expect(TERRAIN.bank.moveCost).toBeLessThan(TERRAIN.hedge.moveCost);
    expect(TERRAIN.rail.moveCost).toBeGreaterThan(TERRAIN.road.moveCost);
  });

  it('neither new key is opaque (relief blocks by elevation, not by opacity)', () => {
    expect(TERRAIN.bank.opacity).toBe(0);
    expect(TERRAIN.rail.opacity).toBe(0);
  });
});

describe('canStep vehicle blacklist', () => {
  it('vehicles cannot enter a bank tile but infantry can', () => {
    const m = new GameMap(8, 8);
    m.setTerrain(4, 4, 'bank');
    expect(m.canStep(3, 4, 4, 4, 'vehicle')).toBe(false);
    expect(m.canStep(3, 4, 4, 4, 'foot')).toBe(true);
  });

  it('vehicles can drive the rail crest', () => {
    const m = new GameMap(8, 8);
    m.setTerrain(4, 4, 'rail');
    expect(m.canStep(3, 4, 4, 4, 'vehicle')).toBe(true);
  });

  it('a level crossing is an ordinary road tile to the mover', () => {
    const m = new GameMap(8, 8);
    m.setTerrain(4, 4, 'road');
    m.crossings[4 * m.w + 4] = 1;
    expect(m.isCrossing(4, 4)).toBe(true);
    expect(m.canStep(3, 4, 4, 4, 'vehicle')).toBe(true);
  });

  it('crossings default to empty and are bounds-checked', () => {
    const m = new GameMap(8, 8);
    expect(m.crossings.length).toBe(64);
    expect(m.crossings.some((v) => v !== 0)).toBe(false);
    expect(m.isCrossing(-1, 0)).toBe(false);
    expect(m.isCrossing(8, 8)).toBe(false);
  });
});
