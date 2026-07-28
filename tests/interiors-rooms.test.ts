import { describe, expect, it as test } from 'vitest';
import { stampStructure } from '../src/sim/bourg/stamp';
import {
  interiorOf,
  resetInterior,
  sealedTiles,
  structuresOf,
  unreachedFrom,
  type Interior,
} from '../src/sim/interiors/kernel';
import { frameOf, planBarn, planHouse, planRooms, planShop } from '../src/sim/interiors/rooms';
import type { RoomKind, RoomPlan } from '../src/sim/interiors/types';
import { EDGE, GameMap } from '../src/sim/map';
import type { Building, BuildingRole, DoorEdge } from '../src/sim/mapgen';
import { mulberry32 } from '../src/sim/rng';

// I4 / I5: the house, shop and barn partitioners against hand-built masses.
// Every plan is checked for the three invariants that hold regardless of role —
// nothing sealed, at most three wall lines, the stair where the stamper left it
// — and then for the geometry §3.2-§3.5 actually asks for.

const MAP = 64;
const fresh = (): GameMap => new GameMap(MAP, MAP);

function stamp(map: GameMap, b: Building, id = 0): Interior {
  stampStructure(map, b, id);
  const it = interiorOf(map, structuresOf(map, [b])[0]);
  expect(it).not.toBeNull();
  return it as Interior;
}

// Every mass tile assigned to a room exactly once, and every room non-empty.
// Assertions are batched rather than run per tile: the sweep below calls this
// 2376 times and vitest's `expect` costs far more than the check does.
function expectPartition(it: Interior, plan: RoomPlan, label = ''): void {
  const seen = new Set<number>();
  const dupes: number[] = [];
  const empty: string[] = [];
  for (const r of plan.rooms) {
    if (r.tiles.length === 0) empty.push(r.kind);
    for (const t of r.tiles) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
  }
  expect(empty, label).toEqual([]);
  expect(dupes, label).toEqual([]);
  expect([...seen].sort((a, b) => a - b), label).toEqual(it.tiles);
}

// Interior WALL edges per grid line — an edge counts only when BOTH flanking
// tiles belong to this mass, so the envelope and party walls are excluded.
function wallEdgesPerLine(map: GameMap, it: Interior): Map<string, number> {
  const lines = new Map<string, number>();
  const bump = (id: string): void => {
    lines.set(id, (lines.get(id) ?? 0) + 1);
  };
  const x1 = it.x0 + it.w;
  const y1 = it.y0 + it.h;
  for (let y = it.y0 + 1; y < y1; y++)
    for (let x = it.x0; x < x1; x++)
      if (map.hEdge(x, y) === EDGE.WALL && map.buildingIdAt(x, y - 1) === it.id && map.buildingIdAt(x, y) === it.id)
        bump(`h${y}`);
  for (let y = it.y0; y < y1; y++)
    for (let x = it.x0 + 1; x < x1; x++)
      if (map.vEdge(x, y) === EDGE.WALL && map.buildingIdAt(x - 1, y) === it.id && map.buildingIdAt(x, y) === it.id)
        bump(`v${x}`);
  return lines;
}

// The cap of §3.1 counts PARTITION lines: a line separating two rooms. A line
// broken into spans (a cross wall interrupted by the hall) counts once, which
// is what the cap is about. A barn's stall stubs are 1 edge each on their own
// grid line and are explicitly not partitions — no stub separates two rooms —
// so they are measured separately by `stubLines`.
const wallLines = (map: GameMap, it: Interior): string[] =>
  [...wallEdgesPerLine(map, it)]
    .filter(([, n]) => n >= 2)
    .map(([id]) => id)
    .sort();

const stubLines = (map: GameMap, it: Interior): number => [...wallEdgesPerLine(map, it).values()].filter((n) => n === 1).length;

const roomOf = (plan: RoomPlan, kind: RoomKind) => plan.rooms.filter((r) => r.kind === kind);
const kinds = (plan: RoomPlan) => plan.rooms.map((r) => r.kind);

// Run a plan and assert the three universal invariants.
function planned(map: GameMap, it: Interior, run: () => RoomPlan | null, maxLines = 3): RoomPlan {
  const stairsBefore = Uint8Array.from(map.stairs);
  resetInterior(map, it);
  const plan = run();
  expect(plan).not.toBeNull();
  expect(map.stairs).toEqual(stairsBefore); // interiors NEVER moves a stair
  expect(sealedTiles(map, it)).toEqual([]);
  expect(wallLines(map, it).length).toBeLessThanOrEqual(maxLines);
  expectPartition(it, plan as RoomPlan);
  return plan as RoomPlan;
}

const rng = (seed: number) => mulberry32(seed >>> 0);

describe('interiors rooms — the house hall plan (§3.2)', () => {
  test('a 9x7 longère gets a 2-wide hall spine, four flanking rooms and three wall lines', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planHouse(map, it, rng(7)));

    expect(roomOf(plan, 'hall').length).toBe(1);
    expect(roomOf(plan, 'hall')[0].tiles.length).toBe(2 * 7); // 2 across x full depth
    expect(plan.spine).toEqual(roomOf(plan, 'hall')[0].tiles);
    expect(plan.rooms.length).toBe(5);
    expect(roomOf(plan, 'kitchen').length).toBe(1);
    expect(roomOf(plan, 'parlor').length).toBe(3);
    expect(wallLines(map, it).length).toBe(3);
  });

  test('the hall runs front-to-back from the door and every room opens onto it', () => {
    const map = fresh();
    const door: DoorEdge = { x: 14, y: 16, side: 's', width: 1 };
    const it = stamp(map, { x: 10, y: 10, w: 9, h: 7, doors: [door] });
    const plan = planned(map, it, () => planHouse(map, it, rng(3)));
    const hall = roomOf(plan, 'hall')[0];
    const cols = new Set(hall.tiles.map((t) => t % MAP));
    const rows = new Set(hall.tiles.map((t) => (t / MAP) | 0));
    expect(cols.size).toBe(2);
    expect(rows.size).toBe(7); // the full depth, front wall to back wall
    expect([...cols]).toContain(13); // clamp(doorAcross - 1, …) = 3 -> x = 13
    // every room is reachable from the front door's own tile
    expect(unreachedFrom(map, it, door.x, door.y)).toEqual([]);
  });

  test('the kitchen is the back room of the wider block, ties to the low across index', () => {
    const map = fresh();
    // door at the far east: hc clamps to A-3 = 7, so the west block is 7 wide
    const it = stamp(map, { x: 10, y: 10, w: 10, h: 7, doors: [{ x: 19, y: 16, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planHouse(map, it, rng(11)));
    const kitchen = roomOf(plan, 'kitchen')[0];
    expect(Math.min(...kitchen.tiles.map((t) => t % MAP))).toBe(10); // the west (wider) block
  });

  test.each(['n', 's', 'e', 'w'] as const)('the frame follows a %s frontage', (side) => {
    const map = fresh();
    const b: Building = {
      x: 10,
      y: 10,
      w: side === 'n' || side === 's' ? 9 : 7,
      h: side === 'n' || side === 's' ? 7 : 9,
      doors: [
        side === 'n'
          ? { x: 14, y: 10, side, width: 1 }
          : side === 's'
            ? { x: 14, y: 16, side, width: 1 }
            : side === 'w'
              ? { x: 10, y: 14, side, width: 1 }
              : { x: 16, y: 14, side, width: 1 },
      ],
    };
    const it = stamp(map, b);
    const f = frameOf(map, it);
    expect(f.side).toBe(side);
    expect(f.A).toBe(9);
    expect(f.D).toBe(7);
    const plan = planned(map, it, () => planHouse(map, it, rng(5)));
    expect(roomOf(plan, 'hall').length).toBe(1);
    // the hall runs perpendicular to the frontage: 7 tiles deep, 2 across
    const hall = roomOf(plan, 'hall')[0];
    const cols = new Set(hall.tiles.map((t) => t % MAP)).size;
    const rows = new Set(hall.tiles.map((t) => (t / MAP) | 0)).size;
    expect(side === 'n' || side === 's' ? [cols, rows] : [rows, cols]).toEqual([2, 7]);
  });
});

describe('interiors rooms — the passage and enfilade plans (§3.2)', () => {
  test('a 6-wide frontage gets a 1-tile passage, two rooms and two doors onto it', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 6, h: 8, doors: [{ x: 12, y: 17, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planHouse(map, it, rng(2)));
    const passage = roomOf(plan, 'passage')[0];
    expect(passage.tiles.length).toBe(8); // 1 across x full depth
    expect(new Set(passage.tiles.map((t) => t % MAP)).size).toBe(1);
    expect(plan.spine).toEqual(passage.tiles);
    expect(kinds(plan).sort()).toEqual(['kitchen', 'parlor', 'passage']);
    // the bounding wall carries two doors — one for each room behind it
    const px = passage.tiles[0] % MAP;
    const wallX = px === it.x0 ? it.x0 + 1 : it.x0 + it.w - 1;
    let doors = 0;
    for (let y = it.y0; y < it.y0 + it.h; y++) if (map.vEdge(wallX, y) === EDGE.DOOR) doors++;
    expect(doors).toBe(2);
  });

  test('the passage hugs the side with the longer shared span against another building', () => {
    const map = fresh();
    // a terrace: the left unit's party wall is on its EAST side
    const left: Building = { x: 10, y: 10, w: 6, h: 8, doors: [{ x: 12, y: 17, side: 's', width: 1 }] };
    const right: Building = { x: 16, y: 10, w: 6, h: 8, doors: [{ x: 18, y: 17, side: 's', width: 1 }] };
    [left, right].forEach((b, i) => stampStructure(map, b, i));
    const it = interiorOf(map, structuresOf(map, [left, right])[0]) as Interior;
    const plan = planned(map, it, () => planHouse(map, it, rng(2)));
    const passage = roomOf(plan, 'passage')[0];
    expect(new Set(passage.tiles.map((t) => t % MAP))).toEqual(new Set([15])); // hard against the party wall
  });

  test('a shallow mass falls through to the enfilade, and a 3-deep one is one room', () => {
    const map = fresh();
    const shallow = stamp(map, { x: 10, y: 10, w: 9, h: 4, doors: [{ x: 14, y: 13, side: 's', width: 1 }] });
    const p1 = planned(map, shallow, () => planHouse(map, shallow, rng(1)));
    expect(kinds(p1)).toEqual(['parlor', 'kitchen']);
    expect(p1.spine).toEqual([]);

    const map2 = fresh();
    const tiny = stamp(map2, { x: 10, y: 10, w: 5, h: 3, doors: [{ x: 12, y: 12, side: 's', width: 1 }] });
    const p2 = planned(map2, tiny, () => planHouse(map2, tiny, rng(1)));
    expect(kinds(p2)).toEqual(['kitchen']);
    expect(wallLines(map2, tiny)).toEqual([]);
  });
});

describe('interiors rooms — the three townhouse variants (§3.3)', () => {
  test('all three variants appear over a run of streams, and none of them seals', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 40; s++) {
      const map = fresh();
      const it = stamp(map, { x: 10, y: 10, w: 6, h: 8, doors: [{ x: 12, y: 17, side: 's', width: 1 }] });
      const plan = planned(map, it, () => planHouse(map, it, rng(s * 2654435761), true));
      const passage = roomOf(plan, 'passage')[0];
      seen.add(!passage ? 'enfilade' : passage.tiles.length === 8 ? 'passage' : 'side-entry');
    }
    expect([...seen].sort()).toEqual(['enfilade', 'passage', 'side-entry']);
  });

  test('the side-entry variant leaves one full-width front room behind a back passage', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 6, h: 8, doors: [{ x: 12, y: 17, side: 's', width: 1 }] });
    // find a stream that rolls >= 0.8
    let s = 1;
    for (; s < 200 && mulberry32(s).next() < 0.8; s++);
    const plan = planned(map, it, () => planHouse(map, it, mulberry32(s), true));
    expect(kinds(plan)).toEqual(['parlor', 'passage']);
    const passage = roomOf(plan, 'passage')[0];
    expect(new Set(passage.tiles.map((t) => (t / MAP) | 0))).toEqual(new Set([10])); // across the BACK
    expect(roomOf(plan, 'parlor')[0].tiles.length).toBe(6 * 7);
  });

  test('a townhouse is dispatched to the house partitioner and keeps its variety', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 6, h: 8, role: 'townhouse', doors: [{ x: 12, y: 17, side: 's', width: 1 }] });
    resetInterior(map, it);
    expect(planRooms(map, it, 'townhouse', rng(9))).not.toBeNull();
    expect(planRooms(map, it, 'halt', rng(9))).toBeNull(); // the one role with no plan
    // A halle is planned as ONE open volume and no wall at all: the aisles of a
    // covered market are furniture (I7's stall rows), never partitions.
    resetInterior(map, it);
    const halle = planRooms(map, it, 'halle', rng(9)) as RoomPlan;
    expect(kinds(halle)).toEqual(['bay']);
    expect(halle.rooms[0].tiles.length).toBe(it.tiles.length);
    expect(wallLines(map, it)).toEqual([]);
    resetInterior(map, it);
    expect(planRooms(map, it, 'church', rng(9))).not.toBeNull(); // I6's, and it is wired
  });
});

describe('interiors rooms — the shop (§3.4)', () => {
  test('storefront across the frontage, back room and store behind it', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 9, h: 8, role: 'shop', doors: [{ x: 14, y: 17, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planShop(map, it, rng(4)));
    expect(kinds(plan).sort()).toEqual(['backroom', 'store', 'storefront']);
    const front = roomOf(plan, 'storefront')[0];
    // full width, 3 or 4 deep, hard against the door wall
    expect(new Set(front.tiles.map((t) => t % MAP)).size).toBe(9);
    const depth = new Set(front.tiles.map((t) => (t / MAP) | 0)).size;
    expect(depth === 3 || depth === 4).toBe(true);
    expect(Math.max(...front.tiles.map((t) => (t / MAP) | 0))).toBe(17);
    // the store is the smaller child and is the dead end: exactly one door
    const store = roomOf(plan, 'store')[0];
    const back = roomOf(plan, 'backroom')[0];
    expect(store.tiles.length).toBeLessThan(back.tiles.length);
    expect(interiorDoorsAround(map, it, store.tiles)).toBe(1);
  });

  test('a narrow shop skips the back split; a shallow one is a storefront only', () => {
    const map = fresh();
    const narrow = stamp(map, { x: 10, y: 10, w: 5, h: 8, role: 'shop', doors: [{ x: 12, y: 17, side: 's', width: 1 }] });
    const p1 = planned(map, narrow, () => planShop(map, narrow, rng(6)));
    expect(kinds(p1)).toEqual(['storefront', 'backroom']);

    const map2 = fresh();
    const shallow = stamp(map2, { x: 10, y: 10, w: 9, h: 4, role: 'shop', doors: [{ x: 14, y: 13, side: 's', width: 1 }] });
    const p2 = planned(map2, shallow, () => planShop(map2, shallow, rng(6)));
    expect(kinds(p2)).toEqual(['storefront']);
    expect(wallLines(map2, shallow)).toEqual([]);
  });

  test('the shop stream shape does not depend on the mass size', () => {
    // both draws happen before any geometry test, so two shops of different
    // sizes consume exactly the same number of values from their stream
    const draw = (w: number, h: number): number => {
      const map = fresh();
      const it = stamp(map, {
        x: 10,
        y: 10,
        w,
        h,
        role: 'shop',
        doors: [{ x: 10 + (w >> 1), y: 10 + h - 1, side: 's', width: 1 }],
      });
      resetInterior(map, it);
      let n = 0;
      const base = mulberry32(99);
      planShop(map, it, {
        next: () => {
          n++;
          return base.next();
        },
        range: base.range,
        int: (k) => {
          n++;
          return base.int(k);
        },
      });
      return n;
    };
    expect(draw(9, 8)).toBe(draw(5, 4));
  });
});

// how many DOOR edges lead into a set of tiles from outside it
function interiorDoorsAround(map: GameMap, it: Interior, tiles: number[]): number {
  const set = new Set(tiles);
  let n = 0;
  for (const t of tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    if (map.hEdge(x, y) === EDGE.DOOR && !set.has((y - 1) * map.w + x) && map.buildingIdAt(x, y - 1) === it.id) n++;
    if (map.hEdge(x, y + 1) === EDGE.DOOR && !set.has((y + 1) * map.w + x) && map.buildingIdAt(x, y + 1) === it.id) n++;
    if (map.vEdge(x, y) === EDGE.DOOR && !set.has(y * map.w + x - 1) && map.buildingIdAt(x - 1, y) === it.id) n++;
    if (map.vEdge(x + 1, y) === EDGE.DOOR && !set.has(y * map.w + x + 1) && map.buildingIdAt(x + 1, y) === it.id) n++;
  }
  return n;
}

describe('interiors rooms — the barn (§3.5)', () => {
  test('stall stubs run off the wall farthest from the door and seal nothing', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 12, h: 6, role: 'barn', doors: [{ x: 15, y: 15, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planBarn(map, it, rng(8)));
    expect(kinds(plan)).toEqual(['bay']);
    // the long axis is x, and the door is on the south wall, so the stubs hang
    // off the NORTH row — 1-long vertical edges, every 2 columns
    let north = 0;
    let south = 0;
    for (let x = it.x0 + 1; x < it.x0 + it.w; x++) {
      if (map.vEdge(x, 10) === EDGE.WALL) north++;
      if (map.vEdge(x, 15) === EDGE.WALL) south++;
    }
    expect(north).toBeGreaterThan(2);
    expect(south).toBe(0);
    // stubs are stubs: none of them reaches the next row, and none of them is a
    // partition line
    for (let x = it.x0 + 1; x < it.x0 + it.w; x++) if (map.vEdge(x, 10) === EDGE.WALL) expect(map.vEdge(x, 11)).toBe(EDGE.NONE);
    expect(wallLines(map, it)).toEqual([]);
    expect(stubLines(map, it)).toBe(north);
  });

  test('a barn at least 7x7 gets a 3x3 tack room in the far corner with exactly one door', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 9, h: 8, role: 'barn', doors: [{ x: 14, y: 17, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planBarn(map, it, rng(8)));
    const tack = roomOf(plan, 'tackroom');
    expect(tack.length).toBe(1);
    expect(tack[0].tiles.length).toBe(9);
    const xs = tack[0].tiles.map((t) => t % MAP);
    const ys = tack[0].tiles.map((t) => (t / MAP) | 0);
    expect(Math.min(...ys)).toBe(10); // the door is south, so the room is north
    expect(interiorDoorsAround(map, it, tack[0].tiles)).toBe(1);
    // and the bay does not double-count the tack room's tiles
    expect(roomOf(plan, 'bay')[0].tiles.length).toBe(9 * 8 - 9);
    expect(Math.min(...xs) === 10 || Math.max(...xs) === 18).toBe(true);
  });

  test('a barn under 7x7 skips the tack room', () => {
    const map = fresh();
    const it = stamp(map, { x: 10, y: 10, w: 8, h: 5, role: 'barn', doors: [{ x: 14, y: 14, side: 's', width: 1 }] });
    const plan = planned(map, it, () => planBarn(map, it, rng(8)));
    expect(kinds(plan)).toEqual(['bay']);
  });
});

describe('interiors rooms — the invariants over a size sweep', () => {
  const ROLES: BuildingRole[] = ['house', 'farmhouse', 'townhouse', 'civic', 'shop', 'barn'];

  test('nothing seals, nothing exceeds three wall lines, no stair moves', () => {
    let count = 0;
    for (const role of ROLES)
      for (let w = 3; w <= 13; w++)
        for (let h = 3; h <= 11; h++)
          for (const side of ['n', 's', 'e', 'w'] as const) {
            const map = new GameMap(28, 28); // the sweep runs 2376 times: keep the allocation small
            const door: DoorEdge =
              side === 'n'
                ? { x: 10 + (w >> 1), y: 10, side, width: 1 }
                : side === 's'
                  ? { x: 10 + (w >> 1), y: 10 + h - 1, side, width: 1 }
                  : side === 'w'
                    ? { x: 10, y: 10 + (h >> 1), side, width: 1 }
                    : { x: 10 + w - 1, y: 10 + (h >> 1), side, width: 1 };
            const it = stamp(map, { x: 10, y: 10, w, h, role, doors: [door] });
            const stairsBefore = Uint8Array.from(map.stairs);
            resetInterior(map, it);
            const plan = planRooms(map, it, role, rng(w * 131 + h * 17 + side.charCodeAt(0)));
            expect(plan).not.toBeNull();
            expect(map.stairs, `${role} ${w}x${h} ${side}`).toEqual(stairsBefore);
            expect(sealedTiles(map, it), `${role} ${w}x${h} ${side}`).toEqual([]);
            expect(wallLines(map, it).length, `${role} ${w}x${h} ${side}`).toBeLessThanOrEqual(3);
            expectPartition(it, plan as RoomPlan, `${role} ${w}x${h} ${side}`);
            // the tile validate probes must still be reachable from the door
            expect(unreachedFrom(map, it, door.x, door.y), `${role} ${w}x${h} ${side}`).toEqual([]);
            count++;
          }
    expect(count).toBe(ROLES.length * 11 * 9 * 4);
  });

  test('planning twice from the same stream writes byte-identical edges', () => {
    for (const role of ROLES) {
      const run = (): [Uint8Array, Uint8Array] => {
        const map = fresh();
        const it = stamp(map, { x: 10, y: 10, w: 9, h: 8, role, doors: [{ x: 14, y: 17, side: 's', width: 1 }] });
        resetInterior(map, it);
        planRooms(map, it, role, rng(1234));
        return [Uint8Array.from(map.hEdges), Uint8Array.from(map.vEdges)];
      };
      const [h1, v1] = run();
      const [h2, v2] = run();
      expect(h1).toEqual(h2);
      expect(v1).toEqual(v2);
    }
  });

  test('a partitioned L keeps every wing reachable', () => {
    const map = fresh();
    const it = stamp(map, {
      x: 10,
      y: 10,
      w: 9,
      h: 5,
      role: 'house',
      parts: [
        { x: 10, y: 10, w: 9, h: 5 },
        { x: 10, y: 15, w: 5, h: 6 },
      ],
      doors: [{ x: 14, y: 10, side: 'n', width: 1 }],
    });
    const plan = planned(map, it, () => planHouse(map, it, rng(21)));
    expect(plan.rooms.length).toBeGreaterThan(1);
    expect(sealedTiles(map, it)).toEqual([]);
  });
});
