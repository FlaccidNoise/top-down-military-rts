import { describe, expect, it } from 'vitest';
import { TERRAIN, type TerrainDef, type TerrainKey } from '../src/sim/data';
import { EDGE, GameMap } from '../src/sim/map';
import { generateMap, reachField } from '../src/sim/mapgen';
import { astar } from '../src/sim/path';
import { mulberry32 } from '../src/sim/rng';
import { Sim } from '../src/sim/sim';

// V1 (verticality design H6/H1): 'bank' and 'rail' append after 'water'.
// I1 (interiors design D3): the four furniture keys append after those.
// GameMap.tiles stores the POSITIONAL index of a key in Object.keys(TERRAIN),
// so any reorder silently rewrites every existing map. These assertions are the
// tripwire; the mapgen fingerprints are the second one.
describe('terrain key indices', () => {
  const keys = Object.keys(TERRAIN) as TerrainKey[];

  it('grass..water hold indices 0..6 and the new keys append after them', () => {
    expect(keys).toEqual(['grass', 'road', 'woods', 'floor', 'hedge', 'field', 'water', 'bank', 'rail', 'furn_heavy', 'furn_light', 'hearth', 'altar']);
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

// ── I1: the interiors terrain contract (interiors design §2.1, D4-D6, D12) ──

// TERRAIN uses `satisfies`, so each entry keeps its literal type and an absent
// optional field is not even a property. Read through TerrainDef to ask.
const def = (k: TerrainKey): TerrainDef => TERRAIN[k];

describe('furniture terrain contract', () => {
  const FURNITURE = ['furn_heavy', 'furn_light', 'hearth', 'altar'] as const;

  it('heavy pieces are impassable and light clutter is passable but slow', () => {
    expect(TERRAIN.furn_heavy.passable).toBe(false);
    expect(TERRAIN.hearth.passable).toBe(false);
    expect(TERRAIN.altar.passable).toBe(false);
    expect(TERRAIN.furn_light.passable).toBe(true);
    // slower than a hedgerow, so astar prefers the clear aisle by a real margin
    expect(TERRAIN.furn_light.moveCost).toBeGreaterThan(TERRAIN.hedge.moveCost);
  });

  it('cover is directional on the heavy pieces and on-tile on the clutter (D5)', () => {
    expect(TERRAIN.furn_heavy.cover).toBe(0);
    expect(TERRAIN.furn_heavy.coverBehind).toBe(0.4);
    expect(TERRAIN.hearth.coverBehind).toBe(0.5); // stone beats wood
    expect(TERRAIN.altar.coverBehind).toBe(0.5);
    expect(TERRAIN.furn_light.cover).toBeLessThan(TERRAIN.woods.cover);
    expect(def('furn_light').coverBehind).toBeUndefined(); // a chair is not a parapet
  });

  it('no furniture key is opaque or carries a featureHeight (D6)', () => {
    for (const k of FURNITURE) {
      expect(TERRAIN[k].opacity, k).toBe(0);
      // a shoot-over height below EYE_H 1.6 would delete the cover on every
      // ground-level shot, which is worse than not modelling the height at all
      expect(def(k).featureHeight, k).toBeUndefined();
    }
  });

  it('every furniture key is closed to vehicles', () => {
    for (const k of FURNITURE) expect(def(k).noVehicle, k).toBe(true);
  });

  it('a light-clutter tile blocks a vehicle and passes infantry', () => {
    const m = new GameMap(8, 8);
    m.setTerrain(4, 4, 'furn_light');
    expect(m.canStep(3, 4, 4, 4, 'vehicle')).toBe(false);
    expect(m.canStep(3, 4, 4, 4, 'foot')).toBe(true);
  });
});

describe('noVehicle replaces the key blacklists (D12)', () => {
  // The rule the three call sites hard-coded before I1. canStep's copy also
  // carried 'bank'; reachField's and findVehicleSpot's did not.
  const legacyBlocked = (k: TerrainKey) => k === 'floor' || k === 'woods' || k === 'hedge' || k === 'bank';

  it('agrees with the old canStep blacklist on every pre-interiors key', () => {
    for (const k of ['grass', 'road', 'woods', 'floor', 'hedge', 'field', 'water', 'bank', 'rail'] as const)
      expect(def(k).noVehicle === true, k).toBe(legacyBlocked(k));
  });

  it('canStep matches the blacklist implementation over 200 random pairs on seeds 1-10', () => {
    const rng = mulberry32(0xc0ffee);
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const { map } = generateMap(seed);
      for (let n = 0; n < 20; n++) {
        const x = 1 + rng.int(map.w - 2);
        const y = 1 + rng.int(map.h - 2);
        const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][rng.int(4)];
        const mode = rng.int(2) === 0 ? 'foot' : 'vehicle';
        // the blacklist formulation, verbatim
        const t = map.terrainAt(x + dx, y + dy);
        let want = map.inBounds(x + dx, y + dy) && t.passable;
        if (want && mode === 'vehicle' && legacyBlocked(map.terrainKeyAt(x + dx, y + dy))) want = false;
        if (want) {
          const e = dx === 1 ? map.vEdge(x + 1, y) : dx === -1 ? map.vEdge(x, y) : dy === 1 ? map.hEdge(x, y + 1) : map.hEdge(x, y);
          want = mode === 'vehicle' ? e === EDGE.NONE : e === EDGE.NONE || e === EDGE.DOOR;
        }
        if (map.canStep(x, y, x + dx, y + dy, mode) !== want) mismatches.push(`seed ${seed} ${mode} ${x},${y}→${x + dx},${y + dy}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // mapgen's reachField inlines canStep for speed and had already drifted from
  // it ('bank' never reached the copy). The 60x40 parity test in mapgen.test.ts
  // cannot see that: relief is size-gated, so no legacy map that small carries a
  // bank tile, and no map at all carries furniture yet. This one is hand-built
  // out of exactly the keys that drifted.
  it('reachField agrees with astar on a map made of bank, rail and furniture', () => {
    const map = new GameMap(24, 16);
    const rng = mulberry32(99);
    const palette = ['grass', 'road', 'bank', 'rail', 'woods', 'hedge', 'water', 'furn_heavy', 'furn_light', 'hearth', 'altar'] as const;
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) map.setTerrain(x, y, palette[rng.int(palette.length)]);
    // a walled room with a door and a window, so the edge rules are exercised too
    for (let x = 4; x < 10; x++) {
      map.setHEdge(x, 4, EDGE.WALL);
      map.setHEdge(x, 9, x === 6 ? EDGE.DOOR : EDGE.WALL);
      for (let y = 4; y < 9; y++) map.setTerrain(x, y, 'floor');
    }
    for (let y = 4; y < 9; y++) {
      map.setVEdge(4, y, y === 6 ? EDGE.WINDOW : EDGE.WALL);
      map.setVEdge(10, y, EDGE.WALL);
    }
    map.setTerrain(6, 5, 'hearth');
    map.setTerrain(7, 7, 'furn_heavy');
    map.setTerrain(8, 7, 'furn_light');

    const mismatches: string[] = [];
    for (const [sx, sy] of [[0, 0], [12, 12], [6, 8]] as const)
      for (const mode of ['foot', 'vehicle'] as const) {
        const field = reachField(map, sx, sy, mode);
        for (let y = 0; y < map.h; y++)
          for (let x = 0; x < map.w; x++) {
            const flood = map.terrainAt(x, y).passable && field[y * map.w + x] === 1;
            if (flood !== (astar(map, sx, sy, x, y, mode) !== null)) mismatches.push(`${mode} from ${sx},${sy} @${x},${y}`);
          }
      }
    expect(mismatches).toEqual([]);
  });

  // findVehicleSpot is private; orderVehicleMove is the observable consequence.
  // Picking a spot astar can never enter drops the order in silence.
  it('a vehicle ordered onto a bank tile still gets a path', () => {
    const map = new GameMap(32, 16);
    for (let y = 6; y < 10; y++) for (let x = 18; x < 22; x++) map.setTerrain(x, y, 'bank');
    const sim = new Sim(map, 1);
    const v = sim.addVehicle('blue', 'sherman', 4.5, 8.5, 0);
    sim.orderVehicleMove(v.id, 19.5, 7.5);
    expect(v.path?.length ?? 0).toBeGreaterThan(0);
    for (const p of v.path ?? []) expect(map.terrainKeyAt(Math.floor(p.x), Math.floor(p.y))).not.toBe('bank');
  });
});
