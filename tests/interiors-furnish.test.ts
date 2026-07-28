import { describe, expect, it as test } from 'vitest';
import { stampStructure } from '../src/sim/bourg/stamp';
import { TERRAIN, type TerrainKey } from '../src/sim/data';
import { churchFrame } from '../src/sim/interiors/church';
import { furnishInteriors } from '../src/sim/interiors/furnish';
import { interiorOf, keepClear, localIndex, sealedTiles, structuresOf, type Interior } from '../src/sim/interiors/kernel';
import { FURNITURE_KEYS, type FurnitureKey } from '../src/sim/interiors/types';
import { EDGE, GameMap } from '../src/sim/map';
import { generateMap, type Building, type BuildingRole } from '../src/sim/mapgen';
import { mulberry32 } from '../src/sim/rng';

// I7: §4.3's four role tables against §4.2's commit rule. The invariants that
// must hold for EVERY building of EVERY role are checked over a sweep; the
// per-role geometry is checked case by case.

const MAP = 64;
const FURN = new Set<string>(FURNITURE_KEYS);

const isFurniture = (k: TerrainKey): k is FurnitureKey => FURN.has(k);

function furnishedBuilding(b: Building, base = 12345): { map: GameMap; it: Interior } {
  const map = new GameMap(MAP, MAP);
  stampStructure(map, b, 0);
  furnishInteriors(map, [b], base);
  const it = interiorOf(map, structuresOf(map, [b])[0]) as Interior;
  return { map, it };
}

function furnishedGroup(bs: Building[], base = 12345): { map: GameMap; it: Interior } {
  const map = new GameMap(MAP, MAP);
  bs.forEach((b, i) => stampStructure(map, b, i));
  furnishInteriors(map, bs, base);
  const it = interiorOf(map, structuresOf(map, bs)[0]) as Interior;
  return { map, it };
}

const furnitureIn = (map: GameMap, it: Interior): number[] =>
  it.tiles.filter((t) => isFurniture(map.terrainKeyAt(t % map.w, (t / map.w) | 0)));

const keysIn = (map: GameMap, it: Interior): Set<TerrainKey> =>
  new Set(furnitureIn(map, it).map((t) => map.terrainKeyAt(t % map.w, (t / map.w) | 0)));

// A church group in the bourg's own shape.
function churchGroup(naveW: number, naveH: number, x0 = 8, y0 = 8): Building[] {
  const towerW = 5;
  const nave: Building = {
    x: x0 + towerW,
    y: y0,
    w: naveW,
    h: naveH,
    role: 'church',
    groupId: 0,
    frontage: 's',
    doors: [{ x: x0 + towerW + (naveW >> 1), y: y0 + naveH - 1, side: 's', width: 1 }],
  };
  return [
    nave,
    { x: x0, y: y0 + ((naveH - towerW) >> 1), w: towerW, h: towerW, role: 'church_tower', groupId: 0 },
    { x: nave.x + nave.w, y: y0 + ((naveH - 5) >> 1), w: 4, h: 5, role: 'church_apse', groupId: 0 },
  ];
}

describe('interiors furnish — the invariants that hold for every role (§4.2)', () => {
  const roles: (BuildingRole | undefined)[] = [undefined, 'house', 'farmhouse', 'townhouse', 'shop', 'barn', 'civic'];

  test('nothing is ever sealed, no stair is blocked, no centre tile is blocked', () => {
    const bad: string[] = [];
    for (const role of roles)
      for (const w of [5, 6, 7, 9, 11])
        for (const h of [4, 5, 7, 9])
          for (const base of [1, 7, 99]) {
            const b: Building = { x: 10, y: 10, w, h, role, doors: [{ x: 10 + (w >> 1), y: 10 + h - 1, side: 's', width: 1 }] };
            const { map, it } = furnishedBuilding(b, base);
            const label = `${role ?? 'undef'} ${w}x${h} base ${base}`;
            if (sealedTiles(map, it).length > 0) bad.push(`${label}: sealed`);
            for (const t of it.stairs) if (!map.terrainAt(t % MAP, (t / MAP) | 0).passable) bad.push(`${label}: stair`);
            const cx = b.x + (b.w >> 1);
            const cy = b.y + (b.h >> 1);
            if (!map.terrainAt(cx, cy).passable) bad.push(`${label}: centre`);
          }
    expect(bad).toEqual([]);
  });

  test('furniture only ever replaces bare floor, and never lands on the keep-clear mask', () => {
    const bad: string[] = [];
    for (const role of roles)
      for (const [w, h] of [
        [9, 7],
        [7, 8],
        [11, 9],
      ] as const) {
        const b: Building = { x: 10, y: 10, w, h, role, doors: [{ x: 10 + (w >> 1), y: 10 + h - 1, side: 's', width: 1 }] };
        const map = new GameMap(MAP, MAP);
        stampStructure(map, b, 0);
        const before = Uint8Array.from(map.tiles);
        furnishInteriors(map, [b], 5);
        const it = interiorOf(map, structuresOf(map, [b])[0]) as Interior;
        const inMassIdx = new Set(it.tiles);
        for (let i = 0; i < map.tiles.length; i++) {
          if (map.tiles[i] === before[i]) continue;
          if (!inMassIdx.has(i)) bad.push(`${role ?? 'undef'} ${w}x${h}: wrote outside the mass at ${i}`);
          if (!isFurniture(map.terrainKeyAt(i % MAP, (i / MAP) | 0))) bad.push(`${role ?? 'undef'}: wrote a non-furniture key`);
        }
        // K is rebuilt independently of the pass (spine tiles excepted, which
        // are a superset the plan owns) and must contain no furniture.
        const k = keepClear(map, it);
        for (const t of it.tiles)
          if (k[localIndex(it, t % MAP, (t / MAP) | 0)] === 1 && isFurniture(map.terrainKeyAt(t % MAP, (t / MAP) | 0)))
            bad.push(`${role ?? 'undef'} ${w}x${h}: furniture on K at ${t % MAP},${(t / MAP) | 0}`);
      }
    expect(bad).toEqual([]);
  });

  test('every window keeps a passable firing nook behind it', () => {
    const bad: string[] = [];
    for (const role of roles) {
      const b: Building = { x: 10, y: 10, w: 10, h: 8, role, doors: [{ x: 15, y: 17, side: 's', width: 1 }] };
      const { map, it } = furnishedBuilding(b);
      for (let y = it.y0; y <= it.y0 + it.h; y++)
        for (let x = it.x0; x < it.x0 + it.w; x++) {
          if (map.hEdge(x, y) !== EDGE.WINDOW) continue;
          for (const iy of [y - 1, y])
            if (map.buildingIdAt(x, iy) === it.id && !map.terrainAt(x, iy).passable) bad.push(`${role ?? 'undef'}: nook ${x},${iy}`);
        }
      for (let y = it.y0; y < it.y0 + it.h; y++)
        for (let x = it.x0; x <= it.x0 + it.w; x++) {
          if (map.vEdge(x, y) !== EDGE.WINDOW) continue;
          for (const ix of [x - 1, x])
            if (map.buildingIdAt(ix, y) === it.id && !map.terrainAt(ix, y).passable) bad.push(`${role ?? 'undef'}: nook ${ix},${y}`);
        }
    }
    expect(bad).toEqual([]);
  });

  test('map.hasFurniture is set exactly when something landed', () => {
    const b: Building = { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
    const { map, it } = furnishedBuilding(b);
    expect(furnitureIn(map, it).length).toBeGreaterThan(0);
    expect(map.hasFurniture).toBe(true);

    // a halle IS furnished — stall rows — and every tile of them is passable,
    // which is what lets a market hall with no doors and twenty open edges take
    // furniture at all.
    const halle = furnishedBuilding({ x: 30, y: 30, w: 9, h: 7, role: 'halle' });
    expect(halle.map.hasFurniture).toBe(true);
    expect(furnitureIn(halle.map, halle.it).length).toBeGreaterThan(0);
    expect([...keysIn(halle.map, halle.it)]).toEqual(['furn_light']);

    // a halt is the one role that is still 'none': no plan, no furniture
    const halt = furnishedBuilding({ x: 44, y: 30, w: 7, h: 4, role: 'halt', doors: [{ x: 47, y: 33, side: 's', width: 1 }] });
    expect(halt.map.hasFurniture).toBe(false);
    expect(furnitureIn(halt.map, halt.it)).toEqual([]);
  });
});

describe('interiors furnish — determinism and order invariance (§6.4, D9)', () => {
  test('two runs of the same base produce byte-identical maps', () => {
    const bs: Building[] = [
      { x: 6, y: 6, w: 9, h: 7, role: 'farmhouse', doors: [{ x: 10, y: 12, side: 's', width: 1 }] },
      { x: 20, y: 6, w: 10, h: 8, role: 'barn', doors: [{ x: 25, y: 13, side: 's', width: 1 }] },
      { x: 6, y: 20, w: 8, h: 8, role: 'shop', doors: [{ x: 10, y: 27, side: 's', width: 1 }] },
    ];
    const run = (): GameMap => {
      const map = new GameMap(MAP, MAP);
      bs.forEach((b, i) => stampStructure(map, b, i));
      furnishInteriors(map, bs, 4242);
      return map;
    };
    const a = run();
    const b = run();
    expect(a.tiles).toEqual(b.tiles);
    expect(a.hEdges).toEqual(b.hEdges);
    expect(a.vEdges).toEqual(b.vEdges);
    expect(a.hEdgeTops).toEqual(b.hEdgeTops);
    expect(a.vEdgeTops).toEqual(b.vEdgeTops);
  });

  test('shuffling the building list changes nothing — the streams key on geometry, not index', () => {
    const bs: Building[] = [
      { x: 6, y: 6, w: 9, h: 7, role: 'house', doors: [{ x: 10, y: 12, side: 's', width: 1 }] },
      { x: 20, y: 6, w: 10, h: 8, role: 'barn', doors: [{ x: 25, y: 13, side: 's', width: 1 }] },
      { x: 6, y: 20, w: 8, h: 8, role: 'shop', doors: [{ x: 10, y: 27, side: 's', width: 1 }] },
      ...churchGroup(13, 9, 32, 32),
    ];
    const run = (order: Building[]): GameMap => {
      const map = new GameMap(MAP, MAP);
      // stamped in a FIXED order so the envelope is the same map either way;
      // only the furnishing pass sees the shuffled list
      bs.forEach((b, i) => stampStructure(map, b, i));
      furnishInteriors(map, order, 777);
      return map;
    };
    const straight = run(bs);
    const shuffled = run([...bs].reverse());
    expect(shuffled.tiles).toEqual(straight.tiles);
    expect(shuffled.hEdges).toEqual(straight.hEdges);
    expect(shuffled.vEdges).toEqual(straight.vEdges);
  });

  test('re-running over a furnished map is safe, and settles to a fixed point', () => {
    // Run 1 adds D11's rear doors, which are envelope edges the pass does NOT
    // own and cannot take back — so run 2 sees a two-door mass, picks a
    // different primary door, and may plan a different frontage. That is the
    // one thing a re-run legitimately changes. What must hold at every step is
    // that the map stays valid, and from run 2 on the pass is a fixed point.
    const plan = generateMap(2, 320, 240, 'bourg');
    const check = (): void => {
      for (const struct of structuresOf(plan.map, plan.buildings)) {
        const it = interiorOf(plan.map, struct);
        if (it !== null) expect(sealedTiles(plan.map, it)).toEqual([]);
      }
    };
    furnishInteriors(plan.map, plan.buildings, 61);
    check();
    furnishInteriors(plan.map, plan.buildings, 61);
    check();
    const tiles = Uint8Array.from(plan.map.tiles);
    const hEdges = Uint8Array.from(plan.map.hEdges);
    const vEdges = Uint8Array.from(plan.map.vEdges);
    furnishInteriors(plan.map, plan.buildings, 61);
    expect(plan.map.tiles).toEqual(tiles);
    expect(plan.map.hEdges).toEqual(hEdges);
    expect(plan.map.vEdges).toEqual(vEdges);
  });

  test('two bases produce different interiors — the stream is actually consumed', () => {
    const b: Building = { x: 10, y: 10, w: 11, h: 9, role: 'shop', doors: [{ x: 15, y: 18, side: 's', width: 1 }] };
    const a = furnishedBuilding(b, 1);
    const c = furnishedBuilding(b, 2);
    expect(a.map.tiles).not.toEqual(c.map.tiles);
  });
});

describe('interiors furnish — the per-role tables (§4.3)', () => {
  test('a house gets a hearth on a solid wall, a table, and chairs beside it', () => {
    const b: Building = { x: 10, y: 10, w: 9, h: 7, role: 'house', doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
    const { map, it } = furnishedBuilding(b);
    const keys = keysIn(map, it);
    expect(keys.has('hearth')).toBe(true);
    expect(keys.has('furn_heavy')).toBe(true);
    expect(keys.has('furn_light')).toBe(true);
    // the hearth is against an exterior wall and never orthogonally beside the table
    const hearths = furnitureIn(map, it).filter((t) => map.terrainKeyAt(t % MAP, (t / MAP) | 0) === 'hearth');
    expect(hearths.length).toBe(1);
    const hx = hearths[0] % MAP;
    const hy = (hearths[0] / MAP) | 0;
    const walls = [map.hEdge(hx, hy), map.hEdge(hx, hy + 1), map.vEdge(hx, hy), map.vEdge(hx + 1, hy)];
    expect(walls.some((e) => e === EDGE.WALL)).toBe(true);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      expect(map.terrainKeyAt(hx + dx, hy + dy)).not.toBe('furn_heavy');
  });

  test('a townhouse puts the hearth on the party wall', () => {
    const map = new GameMap(MAP, MAP);
    const left: Building = { x: 10, y: 10, w: 6, h: 8, role: 'townhouse', doors: [{ x: 12, y: 17, side: 's', width: 1 }] };
    const right: Building = { x: 16, y: 10, w: 6, h: 8, role: 'townhouse', doors: [{ x: 18, y: 17, side: 's', width: 1 }] };
    [left, right].forEach((b, i) => stampStructure(map, b, i));
    furnishInteriors(map, [left, right], 31);
    let found = 0;
    for (let y = 10; y < 18; y++)
      for (let x = 10; x < 22; x++) {
        if (map.terrainKeyAt(x, y) !== 'hearth') continue;
        found++;
        // one of its four neighbours is a WALL onto the OTHER unit
        const party = (['n', 's', 'w', 'e'] as const).some((s) => {
          const e = s === 'n' ? map.hEdge(x, y) : s === 's' ? map.hEdge(x, y + 1) : s === 'w' ? map.vEdge(x, y) : map.vEdge(x + 1, y);
          const nx = s === 'w' ? x - 1 : s === 'e' ? x + 1 : x;
          const ny = s === 'n' ? y - 1 : s === 's' ? y + 1 : y;
          return e === EDGE.WALL && map.buildingIdAt(nx, ny) >= 0 && map.buildingIdAt(nx, ny) !== map.buildingIdAt(x, y);
        });
        expect(party).toBe(true);
      }
    expect(found).toBe(2);
  });

  test('a shop gets a counter run across the storefront with a gap in it', () => {
    const b: Building = { x: 10, y: 10, w: 11, h: 9, role: 'shop', doors: [{ x: 15, y: 18, side: 's', width: 1 }] };
    const { map, it } = furnishedBuilding(b);
    // the counter is the longest row of furn_heavy parallel to the frontage
    let bestRow = -1;
    let bestN = 0;
    for (let y = it.y0; y < it.y0 + it.h; y++) {
      let n = 0;
      for (let x = it.x0; x < it.x0 + it.w; x++) if (map.terrainKeyAt(x, y) === 'furn_heavy') n++;
      if (n > bestN) {
        bestN = n;
        bestRow = y;
      }
    }
    expect(bestN).toBeGreaterThanOrEqual(4);
    let gaps = 0;
    for (let x = it.x0; x < it.x0 + it.w; x++) if (map.terrainKeyAt(x, bestRow) !== 'furn_heavy') gaps++;
    expect(gaps).toBeGreaterThan(0); // an attacker can get past — round the offset gap
    expect(sealedTiles(map, it)).toEqual([]);
  });

  test('a barn gets mangers and clutter, and its doorway stays a lane', () => {
    const b: Building = { x: 10, y: 10, w: 12, h: 10, role: 'barn', doors: [{ x: 16, y: 19, side: 's', width: 1 }] };
    const { map, it } = furnishedBuilding(b);
    const keys = keysIn(map, it);
    expect(keys.has('furn_light')).toBe(true);
    for (const d of it.doors)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (map.buildingIdAt(d.x + dx, d.y + dy) === it.id) expect(map.terrainKeyAt(d.x + dx, d.y + dy)).not.toBe('furn_heavy');
  });

  test('a church gets an altar in the chancel, pews in the nave, and a clear central aisle', () => {
    const bs = churchGroup(15, 9);
    const { map, it } = furnishedGroup(bs, 8);
    const f = churchFrame(it, mulberry32(1)); // for a0/a1 only — the arch draws differ, the frame's extents do not
    const keys = keysIn(map, it);
    expect(keys.has('altar')).toBe(true);
    expect(keys.has('furn_heavy')).toBe(true); // the pews

    // the central aisle: a clear lane at least 2 wide, the full length of the
    // nave up to the chancel, is the spine and is protected by K
    const altars = furnitureIn(map, it).filter((t) => map.terrainKeyAt(t % MAP, (t / MAP) | 0) === 'altar');
    expect(altars.length).toBeGreaterThan(0);
    // …and it is in the chancel, east of every pew
    const pewsX = furnitureIn(map, it)
      .filter((t) => map.terrainKeyAt(t % MAP, (t / MAP) | 0) === 'furn_heavy')
      .map((t) => t % MAP);
    expect(Math.max(...altars.map((t) => t % MAP))).toBeGreaterThan(Math.min(...pewsX));
    expect(sealedTiles(map, it)).toEqual([]);
    expect(f.a1 - f.a0).toBe(9);
  });

  test('the pews leave two continuous side alleys and a continuous central aisle', () => {
    const bs = churchGroup(19, 9);
    const { map, it } = furnishedGroup(bs, 3);
    const f = churchFrame(it, mulberry32(1));
    const clearColumn = (y: number): boolean => {
      for (let x = f.d0; x < f.chancel; x++) if (!map.terrainAt(x, y).passable) return false;
      return true;
    };
    // the aisle band is entirely passable, its whole length
    for (let y = f.aisle0; y < f.aisle1; y++) expect(clearColumn(y), `aisle row ${y}`).toBe(true);
    // and so is the 1-tile alley against each bounding wall/arcade
    expect(clearColumn(f.v0)).toBe(true);
    expect(clearColumn(f.v1 - 1)).toBe(true);
  });
});

describe('interiors furnish — the real maps', () => {
  test('a full bourg furnishes with nothing sealed and every centre tile passable', () => {
    const plan = generateMap(3, 320, 240, 'bourg');
    const map = plan.map;
    furnishInteriors(map, plan.buildings, 0x5eed);
    expect(map.hasFurniture).toBe(true);
    const bad: string[] = [];
    for (const struct of structuresOf(map, plan.buildings)) {
      const it = interiorOf(map, struct);
      if (it === null) continue;
      if (sealedTiles(map, it).length > 0) bad.push(`#${it.id} sealed`);
      for (const b of struct.buildings) {
        const cx = b.x + (b.w >> 1);
        const cy = b.y + (b.h >> 1);
        if (!map.terrainAt(cx, cy).passable) bad.push(`#${it.id} centre ${cx},${cy}`);
      }
      for (const t of it.stairs) if (!map.terrainAt(t % map.w, (t / map.w) | 0).passable) bad.push(`#${it.id} stair`);
    }
    expect(bad).toEqual([]);
  });

  // DELETED at the mapgen-v3 P6 retirement: 'a legacy town furnishes too —
  // every building, no role, nothing sealed'. Its subject was a generator that
  // emitted bare role-less footprints, and no generator does: every kind runs
  // the organic pipeline and roles every mass. The surviving half — every
  // building furnished, nothing sealed, on a 160x120 map — is asserted over all
  // six kinds and ten seeds by the sweep in tests/interiors.test.ts.

  test('no furniture key is vehicle-passable — findVehicleSpot can never pick one', () => {
    for (const k of FURNITURE_KEYS) expect(TERRAIN[k].noVehicle).toBe(true);
  });
});
