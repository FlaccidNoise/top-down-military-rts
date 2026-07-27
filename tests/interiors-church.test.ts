import { describe, expect, it as test } from 'vitest';
import { stampStructure } from '../src/sim/bourg/stamp';
import { churchAcross, churchDeep, churchFrame, isChancel, planChurch } from '../src/sim/interiors/church';
import { interiorOf, resetInterior, sealedTiles, structuresOf, unreachedFrom, type Interior } from '../src/sim/interiors/kernel';
import { planRooms } from '../src/sim/interiors/rooms';
import type { RoomKind, RoomPlan } from '../src/sim/interiors/types';
import { EDGE, GameMap } from '../src/sim/map';
import { generateMap, type Building } from '../src/sim/mapgen';
import { mulberry32 } from '../src/sim/rng';

// I6: the church partitioner. §3.6 — pier-and-gap arcades, the chancel wall and
// its arch, the sacristy, and the one door into the tower.

const MAP = 64;
const rng = (seed: number) => mulberry32(seed >>> 0);

// A church group in the bourg's own shape: tower (5x5, west) + nave + apse,
// all under one groupId so the three masses share a buildingId.
function churchGroup(naveW: number, naveH: number, apse = true): Building[] {
  const x0 = 8;
  const y0 = 8;
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
  const out: Building[] = [
    nave,
    { x: x0, y: y0 + ((naveH - towerW) >> 1), w: towerW, h: towerW, role: 'church_tower', groupId: 0 },
  ];
  if (apse) {
    const apseH = Math.max(3, naveH - 4);
    out.push({ x: nave.x + nave.w, y: y0 + ((naveH - apseH) >> 1), w: 4, h: apseH, role: 'church_apse', groupId: 0 });
  }
  return out;
}

function stampGroup(bs: Building[]): { map: GameMap; it: Interior } {
  const map = new GameMap(MAP, MAP);
  bs.forEach((b, i) => stampStructure(map, b, i));
  const it = interiorOf(map, structuresOf(map, bs)[0]);
  expect(it).not.toBeNull();
  return { map, it: it as Interior };
}

function planned(map: GameMap, it: Interior, seed: number): RoomPlan {
  const stairsBefore = Uint8Array.from(map.stairs);
  resetInterior(map, it);
  const plan = planChurch(map, it, rng(seed));
  expect(map.stairs).toEqual(stairsBefore); // interiors NEVER moves a stair
  expect(sealedTiles(map, it)).toEqual([]);
  // every mass tile in exactly one room
  const seen = new Set<number>();
  const dupes: number[] = [];
  for (const r of plan.rooms) {
    expect(r.tiles.length).toBeGreaterThan(0);
    for (const t of r.tiles) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
  }
  expect(dupes).toEqual([]);
  expect([...seen].sort((a, b) => a - b)).toEqual(it.tiles);
  return plan;
}

const roomOf = (plan: RoomPlan, kind: RoomKind) => plan.rooms.filter((r) => r.kind === kind);

describe('interiors church — the frame (§3.6)', () => {
  test('the liturgical axis runs tower → nave → apse, whichever way the group is laid out', () => {
    const { it } = stampGroup(churchGroup(15, 9));
    const f = churchFrame(it, rng(1));
    expect(f.axis).toBe('x');
    expect(f.dir).toBe(1);
    expect([f.d0, f.d1]).toEqual([13, 28]); // the NAVE only, not the group bbox
    expect([f.a0, f.a1]).toEqual([8, 17]);
  });

  test('a west-facing group (tower to the east) flips dir, not the geometry', () => {
    const map = new GameMap(MAP, MAP);
    const nave: Building = {
      x: 10,
      y: 10,
      w: 15,
      h: 9,
      role: 'church',
      groupId: 0,
      doors: [{ x: 17, y: 18, side: 's', width: 1 }],
    };
    const bs: Building[] = [nave, { x: 25, y: 12, w: 5, h: 5, role: 'church_tower', groupId: 0 }];
    bs.forEach((b, i) => stampStructure(map, b, i));
    const it = interiorOf(map, structuresOf(map, bs)[0]) as Interior;
    const f = churchFrame(it, rng(1));
    expect(f.axis).toBe('x');
    expect(f.dir).toBe(-1);
    // the chancel is at the WEST end of the rect now, because west IS east here
    expect(isChancel(f, 10)).toBe(true);
    expect(isChancel(f, 24)).toBe(false);
  });

  test('the draw count is fixed — three draws, whatever the geometry rejects', () => {
    for (const [w, h] of [
      [15, 9],
      [8, 5],
      [22, 9],
    ] as const) {
      const { it } = stampGroup(churchGroup(w, h, false));
      const r = rng(4);
      churchFrame(it, r);
      const after = rng(4);
      after.int(3);
      after.int(2);
      after.int(2);
      expect(r.next()).toBe(after.next());
    }
  });
});

describe('interiors church — arcades, chancel and sacristy (§3.6)', () => {
  test('a 9-wide nave gets one pier-and-gap arcade, and the gaps are NONE not DOOR', () => {
    const { map, it } = stampGroup(churchGroup(15, 9));
    const plan = planned(map, it, 3);
    const f = churchFrame(it, rng(3));
    expect(f.arcadeLo).toBe(10); // a0 + 2
    expect(f.arcadeHi).toBe(-1); // A = 9 < 13

    let piers = 0;
    let gaps = 0;
    let doors = 0;
    for (let x = f.d0; x < f.chancel; x++) {
      const e = map.hEdge(x, f.arcadeLo);
      if (e === EDGE.WALL) piers++;
      else if (e === EDGE.NONE) gaps++;
      else if (e === EDGE.DOOR) doors++;
    }
    expect(doors).toBe(0); // never a DOOR: path.ts allows only orthogonal transits through one
    expect(piers).toBeGreaterThan(0);
    expect(gaps).toBeGreaterThan(piers); // openings outnumber piers
    expect(roomOf(plan, 'aisle').length).toBe(1);
    // the aisle is 2 tiles across, and it stops at the chancel wall
    expect(new Set(roomOf(plan, 'aisle')[0].tiles.map((t) => (t / MAP) | 0))).toEqual(new Set([8, 9]));
  });

  test('a narrow nave gets no arcade at all', () => {
    const { map, it } = stampGroup(churchGroup(14, 7, false));
    const plan = planned(map, it, 3);
    expect(churchFrame(it, rng(3)).arcadeLo).toBe(-1);
    expect(roomOf(plan, 'aisle').length).toBe(0);
  });

  test('a 13-wide nave gets the second arcade, mirrored to a 2-tile aisle', () => {
    const { map, it } = stampGroup(churchGroup(18, 13, false));
    const plan = planned(map, it, 5);
    const f = churchFrame(it, rng(5));
    expect([f.arcadeLo, f.arcadeHi]).toEqual([f.a0 + 2, f.a1 - 2]);
    expect(f.v1 - f.v0).toBe(9);
    expect(roomOf(plan, 'aisle')[0].tiles.length).toBeGreaterThan(0);
  });

  test('the chancel wall is solid except for a contiguous 2-3 tile arch on the axis', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { map, it } = stampGroup(churchGroup(15, 9));
      const plan = planned(map, it, seed);
      const f = churchFrame(it, rng(seed));
      const open: number[] = [];
      for (let y = f.a0; y < f.a1; y++) if (map.vEdge(f.chancel, y) !== EDGE.WALL) open.push(y);
      expect(open.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(open.length, `seed ${seed}`).toBeLessThanOrEqual(3);
      expect(open[open.length - 1] - open[0], `seed ${seed}`).toBe(open.length - 1); // contiguous
      for (const y of open) expect(map.vEdge(f.chancel, y), `seed ${seed}`).toBe(EDGE.NONE);
      // and the arch is on the central aisle
      expect(open.some((y) => y >= f.aisle0 && y < f.aisle1), `seed ${seed}`).toBe(true);
      expect(roomOf(plan, 'chancel').length).toBe(1);
    }
  });

  test('the sacristy is a 3-wide chancel corner with exactly one door, and it never eats the arch', () => {
    let found = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const { map, it } = stampGroup(churchGroup(15, 9));
      const plan = planned(map, it, seed);
      const f = churchFrame(it, rng(seed));
      const sac = roomOf(plan, 'sacristy');
      if (!f.sacristy) {
        expect(sac.length).toBe(0);
        continue;
      }
      found++;
      expect(sac.length).toBe(1);
      expect(sac[0].tiles.length).toBe(f.sacristy.w * f.sacristy.h);
      // one door on its boundary, and the room is reachable from the front door
      let doors = 0;
      const r = f.sacristy;
      for (let y = r.y; y <= r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) if (map.hEdge(x, y) === EDGE.DOOR) doors++;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x <= r.x + r.w; x++) if (map.vEdge(x, y) === EDGE.DOOR) doors++;
      expect(doors, `seed ${seed}`).toBe(1);
      expect(unreachedFrom(map, it, it.doors[0].x, it.doors[0].y), `seed ${seed}`).toEqual([]);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('interiors church — the tower is the prize (§3.6)', () => {
  test('the nave/tower span becomes WALL at the tower height with exactly one door, on the church axis', () => {
    const { map, it } = stampGroup(churchGroup(15, 9));
    const plan = planned(map, it, 2);
    const f = churchFrame(it, rng(2));
    const tower = f.tower as NonNullable<typeof f.tower>;
    const line = tower.x + tower.w;
    let walls = 0;
    let doors = 0;
    let doorY = -1;
    for (let y = tower.y; y < tower.y + tower.h; y++) {
      if (map.vEdge(line, y) === EDGE.WALL) walls++;
      if (map.vEdge(line, y) === EDGE.DOOR) {
        doors++;
        doorY = y;
      }
      expect(map.vEdgeTop(line, y)).toBe(map.vEdge(line, y) === EDGE.WALL ? 12 : 0);
    }
    expect(doors).toBe(1);
    expect(walls).toBe(tower.h - 1);
    expect(doorY).toBeGreaterThanOrEqual(f.aisle0);
    expect(doorY).toBeLessThan(f.aisle1); // the tower arch stands on the central aisle
    expect(roomOf(plan, 'tower')[0].tiles.length).toBe(tower.w * tower.h);
    // the tower's own stair is untouched and still reachable
    expect(it.stairs.some((t) => churchDeep(f, t % MAP, (t / MAP) | 0) < line)).toBe(true);
  });

  test('a group with no tower plans fine and emits no tower room', () => {
    const map = new GameMap(MAP, MAP);
    const b: Building = { x: 10, y: 10, w: 16, h: 9, role: 'church', doors: [{ x: 18, y: 18, side: 's', width: 1 }] };
    stampStructure(map, b, 0);
    const it = interiorOf(map, structuresOf(map, [b])[0]) as Interior;
    const plan = planned(map, it, 6);
    expect(roomOf(plan, 'tower').length).toBe(0);
    expect(roomOf(plan, 'nave').length).toBe(1);
    expect(roomOf(plan, 'chancel').length).toBe(1);
  });
});

describe('interiors church — the spine and the dispatch', () => {
  test('the spine is the central aisle, west of the chancel wall only', () => {
    const { map, it } = stampGroup(churchGroup(15, 9));
    const plan = planned(map, it, 4);
    const f = churchFrame(it, rng(4));
    expect(plan.spine.length).toBeGreaterThan(0);
    for (const t of plan.spine) {
      const x = t % MAP;
      const y = (t / MAP) | 0;
      expect(churchAcross(f, x, y)).toBeGreaterThanOrEqual(f.aisle0);
      expect(churchAcross(f, x, y)).toBeLessThan(f.aisle1);
      expect(isChancel(f, churchDeep(f, x, y))).toBe(false);
    }
  });

  test('planRooms routes all three church roles to the church partitioner', () => {
    for (const role of ['church', 'church_tower', 'church_apse'] as const) {
      const { map, it } = stampGroup(churchGroup(15, 9));
      resetInterior(map, it);
      expect(planRooms(map, it, role, rng(1))).not.toBeNull();
      expect(sealedTiles(map, it)).toEqual([]);
    }
  });
});

describe('interiors church — the real bourg church', () => {
  test('every bourg church partitions cleanly and keeps the tower reachable', () => {
    for (const seed of [1, 2, 3, 4, 5, 7, 11]) {
      const plan = generateMap(seed, 320, 240, 'bourg');
      const map = plan.map;
      const group = plan.buildings.filter((b) => b.role?.startsWith('church'));
      expect(group.length, `seed ${seed}`).toBeGreaterThan(0);
      const it = interiorOf(map, structuresOf(map, group)[0]) as Interior;
      expect(it).not.toBeNull();
      resetInterior(map, it);
      const p = planChurch(map, it, rng(seed));
      expect(sealedTiles(map, it), `seed ${seed}`).toEqual([]);
      expect(p.rooms.map((r) => r.kind), `seed ${seed}`).toContain('tower');
      expect(p.rooms.map((r) => r.kind), `seed ${seed}`).toContain('chancel');
      // the tower keeps exactly one stair, and it is inside the tower mask
      const tower = group.find((b) => b.role === 'church_tower') as Building;
      const inTower = it.stairs.filter((t) => {
        const x = t % map.w;
        const y = (t / map.w) | 0;
        return x >= tower.x && x < tower.x + tower.w && y >= tower.y && y < tower.y + tower.h;
      });
      expect(inTower.length, `seed ${seed}`).toBe(1);
    }
  });
});
