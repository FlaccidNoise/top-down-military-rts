import { describe, expect, it as test } from 'vitest';
import { stampStructure } from '../src/sim/bourg/stamp';
import {
  Furnisher,
  inMass,
  interiorOf,
  keepClear,
  localIndex,
  putH,
  putV,
  reachInterior,
  resetInterior,
  sealedTiles,
  structuresOf,
  unreachedFrom,
  wallRun,
  type Interior,
} from '../src/sim/interiors/kernel';
import { EDGE, FLOOR_H, GameMap } from '../src/sim/map';
import type { Building } from '../src/sim/mapgen';
import { astar } from '../src/sim/path';

// I3: the interiors kernel exercised against hand-built masks BEFORE any
// generator calls it, mirroring tests/bourg-stamp.test.ts. This is where a bug
// corrupts the far side of the map silently, so the shapes are the awkward
// ones: rect, L, U, an abutting terrace pair, and a church group whose bbox
// swallows a neighbour's tiles.

const MAP = 48;
const fresh = (): GameMap => new GameMap(MAP, MAP);

function build(map: GameMap, bs: Building[]): Interior[] {
  bs.forEach((b, i) => stampStructure(map, b, i));
  return structuresOf(map, bs)
    .map((s) => interiorOf(map, s))
    .filter((v): v is Interior => v !== null);
}

function one(map: GameMap, b: Building): Interior {
  const [it] = build(map, [b]);
  expect(it).toBeDefined();
  return it;
}

const RECT: Building = { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
const ELL: Building = {
  x: 10,
  y: 10,
  w: 8,
  h: 5,
  parts: [
    { x: 10, y: 10, w: 8, h: 5 },
    { x: 10, y: 15, w: 4, h: 5 },
  ],
  doors: [{ x: 13, y: 10, side: 'n', width: 1 }],
};
const YOU: Building = {
  x: 10,
  y: 10,
  w: 3,
  h: 8,
  parts: [
    { x: 10, y: 10, w: 3, h: 8 },
    { x: 13, y: 15, w: 4, h: 3 },
    { x: 17, y: 10, w: 3, h: 8 },
  ],
  doors: [{ x: 11, y: 10, side: 'n', width: 1 }],
};

const tileXY = (map: GameMap, t: number): [number, number] => [t % map.w, (t / map.w) | 0];

describe('interiors kernel — structures and the mass', () => {
  test('a Building without groupId is its own structure; a shared groupId makes one', () => {
    const map = fresh();
    const nave: Building = { x: 10, y: 10, w: 8, h: 6, groupId: 0, doors: [{ x: 13, y: 15, side: 's', width: 1 }] };
    const tower: Building = { x: 18, y: 10, w: 4, h: 4, role: 'church_tower', groupId: 0 };
    const shed: Building = { x: 18, y: 14, w: 4, h: 2, doors: [{ x: 19, y: 15, side: 's', width: 1 }] };
    [nave, tower, shed].forEach((b, i) => stampStructure(map, b, i));

    const ss = structuresOf(map, [nave, tower, shed]);
    expect(ss.length).toBe(2);
    expect(ss[0].buildings).toEqual([nave, tower]);
    expect(ss[0].rects.length).toBe(2);
    expect(ss[1].buildings).toEqual([shed]);
    // ids come off the MAP at the leader's centre tile, never from the index
    expect(ss[0].id).toBe(0);
    expect(ss[1].id).toBe(2);
  });

  test('the mass is read off the map, so a neighbour inside the group bbox is excluded', () => {
    const map = fresh();
    const nave: Building = { x: 10, y: 10, w: 8, h: 6, groupId: 0, doors: [{ x: 13, y: 15, side: 's', width: 1 }] };
    const tower: Building = { x: 18, y: 10, w: 4, h: 4, role: 'church_tower', groupId: 0 };
    const shed: Building = { x: 18, y: 14, w: 4, h: 2, doors: [{ x: 19, y: 15, side: 's', width: 1 }] };
    [nave, tower, shed].forEach((b, i) => stampStructure(map, b, i));
    const it = interiorOf(map, structuresOf(map, [nave, tower, shed])[0]) as Interior;

    // the bbox spans the shed…
    expect(it.x0).toBe(10);
    expect(it.y0).toBe(10);
    expect(it.w).toBe(12);
    expect(it.h).toBe(6);
    // …but the shed's tiles are not in the mass, and a rect union would have
    // missed nothing while a bbox fill would have swallowed all eight of them
    expect(it.tiles.length).toBe(8 * 6 + 4 * 4);
    for (let y = 14; y < 16; y++) for (let x = 18; x < 22; x++) expect(inMass(it, x, y)).toBe(false);
    // top is the MAX storey count of the group: a 4-storey tower over a nave
    expect(it.top).toBe(4 * FLOOR_H);
  });

  test('exterior doors are recovered from the map and ordered by interior tile index', () => {
    const map = fresh();
    const b: Building = {
      ...RECT,
      doors: [
        { x: 14, y: 16, side: 's', width: 1 },
        { x: 10, y: 12, side: 'w', width: 1 },
      ],
    };
    const it = one(map, b);
    expect(it.doors).toEqual([
      { x: 10, y: 12, side: 'w' },
      { x: 14, y: 16, side: 's' },
    ]);
  });

  test('stairs of the mass are collected and never written by the kernel', () => {
    const map = fresh();
    const b: Building = { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
    const it = one(map, b);
    expect(it.stairs.length).toBe(1); // 63 tiles => 2 storeys => one stair
    const before = Uint8Array.from(map.stairs);
    resetInterior(map, it);
    wallRun(map, it, 'v', 14, 10, 17, it.top, it.doors[0]);
    expect(map.stairs).toEqual(before);
  });
});

describe('interiors kernel — D10 interior reset', () => {
  test('clears interior edges and their tops, keeps the envelope, doors and windows', () => {
    const map = fresh();
    const it = one(map, RECT);
    // stampStructure partitioned it (9 wide clears MIN_PARTITION_SPAN)
    const partitioned = [...map.vEdges].some((e, i) => e === EDGE.WALL && i % (MAP + 1) > 10 && i % (MAP + 1) < 19);
    expect(partitioned).toBe(true);

    resetInterior(map, it);
    for (let y = 11; y < 17; y++)
      for (let x = 10; x < 19; x++) {
        expect(map.hEdge(x, y)).toBe(EDGE.NONE);
        expect(map.hEdgeTop(x, y)).toBe(0);
      }
    for (let y = 10; y < 17; y++)
      for (let x = 11; x < 19; x++) {
        expect(map.vEdge(x, y)).toBe(EDGE.NONE);
        expect(map.vEdgeTop(x, y)).toBe(0);
      }
    // envelope untouched
    expect(map.hEdge(10, 10)).toBe(EDGE.WALL);
    expect(map.hEdgeTop(10, 10)).toBe(2 * FLOOR_H);
    expect(map.hEdge(14, 17)).toBe(EDGE.DOOR);
    expect([...Array(9).keys()].some((k) => map.hEdge(10 + k, 10) === EDGE.WINDOW)).toBe(true);
  });

  test('a party wall and the neighbour’s own partitions survive the reset', () => {
    const map = fresh();
    const left: Building = { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
    const right: Building = { x: 19, y: 10, w: 9, h: 7, doors: [{ x: 23, y: 16, side: 's', width: 1 }] };
    const its = build(map, [left, right]);
    const rightPartition = [...map.vEdges];

    resetInterior(map, its[0]);
    expect(map.vEdge(19, 12)).toBe(EDGE.WALL); // the party wall
    expect(map.vEdgeTop(19, 12)).toBe(2 * FLOOR_H);
    for (let y = 10; y < 17; y++) for (let x = 20; x < 28; x++) expect(map.vEdge(x, y)).toBe(rightPartition[y * (MAP + 1) + x]);
  });
});

describe('interiors kernel — wallRun', () => {
  test('rejects a line outside the setHEdge/setVEdge domains instead of corrupting the far side', () => {
    const map = fresh();
    const it = one(map, RECT);
    expect(() => wallRun(map, it, 'v', MAP + 1, 10, 17, 6, null)).toThrow(/outside \[0,48\]/);
    expect(() => wallRun(map, it, 'h', -1, 10, 19, 6, null)).toThrow(/outside \[0,48\]/);
    expect(() => wallRun(map, it, 'v', 14, 10, MAP + 1, 6, null)).toThrow(/span/);
    expect(() => putV(map, MAP + 1, 3, EDGE.WALL, 6)).toThrow();
    expect(() => putH(map, 3, MAP + 1, EDGE.WALL, 6)).toThrow();
  });

  test('writes only where both flanks are in the mass, so an L keeps its envelope', () => {
    const map = fresh();
    const it = one(map, ELL);
    resetInterior(map, it);
    // x=14 is interior for y in [10,15) (the head is 8 wide) and IS the wing's
    // east envelope for y in [15,20) — a run over the whole line must write the
    // first half and leave the second, windows and all, exactly as it found it
    const before = [...map.vEdges];
    wallRun(map, it, 'v', 14, 10, 20, it.top, it.doors[0], { doors: false });
    for (let y = 10; y < 15; y++) {
      expect(map.vEdge(14, y)).toBe(EDGE.WALL);
      expect(map.vEdgeTop(14, y)).toBe(it.top);
    }
    for (let y = 15; y < 20; y++) expect(map.vEdge(14, y)).toBe(before[y * (MAP + 1) + 14]);
    expect([...Array(5).keys()].some((k) => map.vEdge(14, 15 + k) === EDGE.WINDOW)).toBe(true);
  });

  test('each contiguous run gets its own door; a cut across an L’s waist seals nothing', () => {
    const map = fresh();
    const it = one(map, ELL);
    resetInterior(map, it);
    // y=15 is the head/wing joint: it is inside the mass for x in [10,14) and
    // outside for x in [14,18) — two runs on one line would be one door short
    const doors = wallRun(map, it, 'h', 15, 10, 18, it.top, it.doors[0]);
    expect(doors.length).toBe(1);
    expect(unreachedFrom(map, it, it.doors[0].x, it.doors[0].y)).toEqual([]);
  });

  test('the door is deterministic: never first or last of a run, min Manhattan to the seed, ties low', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    // run along y in [10,17); seed at y=16 pulls the door to the last legal slot
    expect(wallRun(map, it, 'v', 14, 10, 17, it.top, { x: 14, y: 16 })).toEqual([15]);
    expect(wallRun(map, it, 'v', 15, 10, 17, it.top, { x: 15, y: 10 })).toEqual([11]);
    // an exact tie (seed equidistant from 12 and 14) takes the lower index
    expect(wallRun(map, it, 'v', 16, 11, 16, it.top, { x: 16, y: 13 })).toEqual([13]);
    expect(wallRun(map, it, 'v', 17, 10, 17, it.top, { x: 17, y: 13 }, { doors: false })).toEqual([]);
    for (let y = 10; y < 17; y++) expect(map.vEdge(17, y)).toBe(EDGE.WALL);
  });
});

describe('interiors kernel — the connectivity BFS', () => {
  test('agrees with astar tile-for-tile on a sealed single-door mass', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    wallRun(map, it, 'v', 14, 10, 17, it.top, it.doors[0]);
    wallRun(map, it, 'h', 13, 10, 14, it.top, it.doors[0]);
    const d = it.doors[0];
    const reached = reachInterior(map, it, d.x, d.y, null);
    for (const t of it.tiles) {
      const [x, y] = tileXY(map, t);
      expect(reached[localIndex(it, x, y)] === 1).toBe(astar(map, d.x, d.y, x, y) !== null);
    }
  });

  test('a wall ring round one tile makes exactly that tile unreachable', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    putV(map, 13, 13, EDGE.WALL, it.top);
    putV(map, 14, 13, EDGE.WALL, it.top);
    putH(map, 13, 13, EDGE.WALL, it.top);
    putH(map, 13, 14, EDGE.WALL, it.top);
    const d = it.doors[0];
    expect(unreachedFrom(map, it, d.x, d.y)).toEqual([13 * MAP + 13]);
  });
});

describe('interiors kernel — the keep-clear mask K', () => {
  test('holds the door apron, the window nooks, the stair and its neighbours, and the centre', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    const k = keepClear(map, it);
    const clear = (x: number, y: number): boolean => k[localIndex(it, x, y)] === 1;

    // exterior door at hEdge(14,17): the interior tile and one further in
    expect(clear(14, 16)).toBe(true);
    expect(clear(14, 15)).toBe(true);
    expect(clear(14, 14)).toBe(false);
    // every exterior window has its nook
    for (let x = 10; x < 19; x++) {
      if (map.hEdge(x, 10) === EDGE.WINDOW) expect(clear(x, 10)).toBe(true);
      if (map.hEdge(x, 17) === EDGE.WINDOW) expect(clear(x, 16)).toBe(true);
    }
    // the stair and its four orthogonal neighbours
    const [sx, sy] = tileXY(map, it.stairs[0]);
    for (const [x, y] of [
      [sx, sy],
      [sx - 1, sy],
      [sx + 1, sy],
      [sx, sy - 1],
      [sx, sy + 1],
    ])
      if (inMass(it, x, y)) expect(clear(x, y)).toBe(true);
    // the centre tile validate probes
    expect(clear(10 + (9 >> 1), 10 + (7 >> 1))).toBe(true);
  });

  test('an interior door gets a tile each side, and the spine is kept whole', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    const doors = wallRun(map, it, 'v', 14, 10, 17, it.top, it.doors[0]);
    const spine = [12 * MAP + 11, 12 * MAP + 12];
    const k = keepClear(map, it, spine);
    expect(k[localIndex(it, 13, doors[0])]).toBe(1);
    expect(k[localIndex(it, 14, doors[0])]).toBe(1);
    for (const t of spine) {
      const [x, y] = tileXY(map, t);
      expect(k[localIndex(it, x, y)]).toBe(1);
    }
  });
});

describe('interiors kernel — the commit rule', () => {
  test('refuses a group on K, refuses a duplicate tile, and writes nothing when it refuses', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    const k = keepClear(map, it);
    const f = new Furnisher(map, it, k);
    const door = it.doors[0];
    expect(f.place([door.y * MAP + door.x], 'furn_heavy')).toBe(false);
    expect(map.terrainKeyAt(door.x, door.y)).toBe('floor');
    expect(map.hasFurniture).toBe(false);
    expect(f.place([11 * MAP + 11, 11 * MAP + 11], 'furn_heavy')).toBe(false);
    expect(f.place([], 'furn_heavy')).toBe(false);
    expect(f.placed).toEqual([]);
  });

  test('commits a legal group, marks the map furnished, and refuses to reuse the tile', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    const f = new Furnisher(map, it, keepClear(map, it));
    const t = 13 * MAP + 13;
    expect(f.place([t], 'furn_heavy')).toBe(true);
    expect(map.terrainKeyAt(13, 13)).toBe('furn_heavy');
    expect(map.hasFurniture).toBe(true);
    expect(f.placed).toEqual([t]);
    expect(f.place([t], 'furn_light')).toBe(false);
  });

  test('refuses the group that would seal a tile off, and takes the same group one tile over', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    // an alcove open only to the north: (15,11) and (16,11), boxed on three
    // sides. A soldier cannot cut a corner (path.ts), so the two tiles above it
    // are its ONLY way out.
    putV(map, 15, 11, EDGE.WALL, it.top);
    putV(map, 17, 11, EDGE.WALL, it.top);
    putH(map, 15, 12, EDGE.WALL, it.top);
    putH(map, 16, 12, EDGE.WALL, it.top);
    const f = new Furnisher(map, it, keepClear(map, it));
    const alcove = [11 * MAP + 15, 11 * MAP + 16];
    expect(alcove.every((t) => f.reachable[localIndex(it, ...tileXY(map, t))] === 1)).toBe(true);
    expect(f.place([10 * MAP + 15, 10 * MAP + 16], 'furn_heavy')).toBe(false);
    expect(map.terrainKeyAt(15, 10)).toBe('floor');
    expect(map.terrainKeyAt(16, 10)).toBe('floor');
    // the same 1x2 piece four rows down seals nothing
    expect(f.place([14 * MAP + 15, 14 * MAP + 16], 'furn_heavy')).toBe(true);
    expect(sealedTiles(map, it)).toEqual([]);
  });

  test('a passable key is committed without a BFS — it cannot change the open set', () => {
    const map = fresh();
    const it = one(map, RECT);
    resetInterior(map, it);
    const f = new Furnisher(map, it, keepClear(map, it));
    putV(map, 12, 11, EDGE.WALL, it.top);
    putH(map, 11, 12, EDGE.WALL, it.top);
    expect(f.place([12 * MAP + 12], 'furn_light')).toBe(true);
    expect(unreachedFrom(map, it, it.doors[0].x, it.doors[0].y)).toEqual([]);
  });

  test.each([
    ['rect', RECT],
    ['L', ELL],
    ['U', YOU],
  ])('THE HARNESS PROOF: heavy furniture attempted on every tile of a %s seals nothing', (_name, b) => {
    const map = fresh();
    const it = one(map, b);
    resetInterior(map, it);
    const f = new Furnisher(map, it, keepClear(map, it));
    let taken = 0;
    for (const t of it.tiles) if (f.place([t], 'furn_heavy')) taken++;
    expect(taken).toBeGreaterThan(0);
    expect(sealedTiles(map, it)).toEqual([]);
    // and every keep-clear tile is still floor
    const k = keepClear(map, it);
    for (const t of it.tiles) {
      const [x, y] = tileXY(map, t);
      if (k[localIndex(it, x, y)] === 1) expect(map.terrainKeyAt(x, y)).toBe('floor');
    }
  });

  test('the proof holds for a terrace pair, and neither unit furnishes into the other', () => {
    const map = fresh();
    const left: Building = { x: 10, y: 10, w: 5, h: 8, doors: [{ x: 12, y: 17, side: 's', width: 1 }] };
    const right: Building = { x: 15, y: 10, w: 5, h: 8, doors: [{ x: 17, y: 17, side: 's', width: 1 }] };
    const its = build(map, [left, right]);
    expect(its.length).toBe(2);
    for (const it of its) {
      resetInterior(map, it);
      const f = new Furnisher(map, it, keepClear(map, it));
      for (const t of it.tiles) f.place([t], 'furn_heavy');
      for (const t of f.placed) expect(map.buildingId[t]).toBe(it.id);
      expect(sealedTiles(map, it)).toEqual([]);
    }
  });
});
