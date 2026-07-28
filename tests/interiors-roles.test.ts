import { describe, expect, it as test } from 'vitest';
import { stampStructure } from '../src/sim/bourg/stamp';
import { furnishInteriors } from '../src/sim/interiors/furnish';
import { interiorOf, structuresOf, unreachedFrom, type Interior } from '../src/sim/interiors/kernel';
import { addRearDoor, inferRoles } from '../src/sim/interiors/roles';
import { EDGE, GameMap } from '../src/sim/map';
import { generateMap, type Building } from '../src/sim/mapgen';
import { mulberry32 } from '../src/sim/rng';

// I8: D11's second exterior door and §3.7's legacy role inference.

const MAP = 64;
const rng = (seed: number) => mulberry32(seed >>> 0);

function stamp(map: GameMap, b: Building, id = 0): Interior {
  stampStructure(map, b, id);
  return interiorOf(map, structuresOf(map, [b])[0]) as Interior;
}

const extDoors = (map: GameMap, it: Interior): { x: number; y: number; side: string }[] => {
  const out: { x: number; y: number; side: string }[] = [];
  for (let y = it.y0; y <= it.y0 + it.h; y++)
    for (let x = it.x0; x < it.x0 + it.w; x++) {
      if (map.hEdge(x, y) !== EDGE.DOOR) continue;
      const n = map.buildingIdAt(x, y - 1) === it.id;
      const s = map.buildingIdAt(x, y) === it.id;
      if (n !== s) out.push({ x, y: n ? y - 1 : y, side: n ? 's' : 'n' });
    }
  for (let y = it.y0; y < it.y0 + it.h; y++)
    for (let x = it.x0; x <= it.x0 + it.w; x++) {
      if (map.vEdge(x, y) !== EDGE.DOOR) continue;
      const w = map.buildingIdAt(x - 1, y) === it.id;
      const e = map.buildingIdAt(x, y) === it.id;
      if (w !== e) out.push({ x: w ? x - 1 : x, y, side: w ? 'e' : 'w' });
    }
  return out;
};

describe('interiors roles — §3.7 legacy inference', () => {
  test('a close pair becomes farmhouse + barn, the smaller one the barn', () => {
    const bs: Building[] = [
      { x: 10, y: 10, w: 8, h: 6 }, // 48 — the house
      { x: 20, y: 10, w: 6, h: 5 }, // 30, gap 2 — the barn
      { x: 40, y: 40, w: 7, h: 6 }, // 42, alone
    ];
    inferRoles(bs);
    expect(bs.map((b) => b.role)).toEqual(['farmhouse', 'barn', 'house']);
  });

  test('the gap rule is roofs.ts smallOfPair exactly — 4 m inclusive, diagonal counted', () => {
    const near: Building[] = [
      { x: 10, y: 10, w: 8, h: 6 },
      { x: 22, y: 10, w: 6, h: 5 }, // gap 4 exactly
    ];
    inferRoles(near);
    expect(near.map((b) => b.role)).toEqual(['farmhouse', 'barn']);

    const far: Building[] = [
      { x: 10, y: 10, w: 8, h: 6 },
      { x: 23, y: 10, w: 6, h: 5 }, // gap 5
    ];
    inferRoles(far);
    expect(far.map((b) => b.role)).toEqual(['house', 'house']);

    // equal areas label neither: the comparison is strict, as roofs.ts' is
    const tie: Building[] = [
      { x: 10, y: 10, w: 6, h: 5 },
      { x: 18, y: 10, w: 5, h: 6 },
    ];
    inferRoles(tie);
    expect(tie.map((b) => b.role)).toEqual(['house', 'house']);
  });

  test('the two unlabelled buildings of area >= 40 nearest the objective become shops', () => {
    const bs: Building[] = [
      { x: 50, y: 50, w: 8, h: 6 }, // 48, far
      { x: 10, y: 10, w: 8, h: 6 }, // 48, nearest
      { x: 14, y: 24, w: 7, h: 6 }, // 42, second
      { x: 30, y: 10, w: 4, h: 5 }, // 20 — under the area floor
    ];
    inferRoles(bs, { x: 12, y: 12 });
    expect(bs.map((b) => b.role)).toEqual(['house', 'shop', 'shop', 'house']);
  });

  test('a paired building is never relabelled a shop, and a roled building is never touched', () => {
    const bs: Building[] = [
      { x: 10, y: 10, w: 8, h: 6 }, // farmhouse — paired, right on the objective
      { x: 19, y: 10, w: 6, h: 5 }, // barn
      { x: 40, y: 40, w: 8, h: 6, role: 'civic' },
      { x: 44, y: 10, w: 8, h: 6 },
    ];
    inferRoles(bs, { x: 12, y: 12 });
    expect(bs.map((b) => b.role)).toEqual(['farmhouse', 'barn', 'civic', 'shop']);
  });

  test('every building on every legacy kind ends up with a role, and it is deterministic', () => {
    // 'open' left this list at the mapgen-v3 P3 cutover: the organic pipeline
    // roles every mass it emits, including 9 shops on seed 7, so inferRoles is
    // a no-op there and the "at most two shops" bound is about the INFERENCE
    // and not about the map. It is asserted with the bourg below instead.
    for (const kind of ['town', 'woods', 'river'] as const) {
      const a = generateMap(7, 160, 120, kind);
      const b = generateMap(7, 160, 120, kind);
      inferRoles(a.buildings, a.objectives[0]);
      inferRoles(b.buildings, b.objectives[0]);
      expect(a.buildings.every((x) => x.role !== undefined), kind).toBe(true);
      expect(a.buildings.map((x) => x.role), kind).toEqual(b.buildings.map((x) => x.role));
      // "the TWO nearest, among the buildings still unlabelled" — a kind whose
      // buildings are nearly all in close pairs simply has fewer left over
      expect(a.buildings.filter((x) => x.role === 'shop').length, kind).toBeLessThanOrEqual(2);
    }
  });

  test('a v3 kind is untouched — every building already carries its generator role', () => {
    for (const [kind, w, h] of [['bourg', 320, 240], ['road', 320, 240], ['open', 160, 120]] as const) {
      const plan = generateMap(1, w, h, kind);
      const before = plan.buildings.map((b) => b.role);
      expect(before.every((r) => r !== undefined), kind).toBe(true);
      inferRoles(plan.buildings, plan.objectives[0]);
      expect(plan.buildings.map((b) => b.role), kind).toEqual(before);
    }
  });
});

describe('interiors roles — D11 the rear door', () => {
  test('a legacy-sized building gets a second door on the opposite face, 2 in from each corner', () => {
    const map = new GameMap(MAP, MAP);
    const b: Building = { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
    const it = stamp(map, b);
    expect(it.doors.length).toBe(1);
    const door = addRearDoor(map, it, rng(4));
    expect(door).not.toBeNull();
    expect((door as { side: string }).side).toBe('n');
    const doors = extDoors(map, it);
    expect(doors.length).toBe(2);
    expect(new Set(doors.map((d) => d.side))).toEqual(new Set(['n', 's']));
    const rear = doors.find((d) => d.side === 'n') as { x: number };
    expect(rear.x).toBeGreaterThanOrEqual(b.x + 2);
    expect(rear.x).toBeLessThanOrEqual(b.x + b.w - 3);
    // appended, so the stamper's door is still the primary
    expect(it.doors[0]).toEqual({ x: 14, y: 16, side: 's' });
    expect(it.doors.length).toBe(2);
  });

  test('it draws exactly one integer whether or not it places anything', () => {
    const map = new GameMap(MAP, MAP);
    const small: Building = { x: 10, y: 10, w: 4, h: 4, doors: [{ x: 11, y: 13, side: 's', width: 1 }] }; // area 16
    const it = stamp(map, small);
    const r = rng(9);
    expect(addRearDoor(map, it, r)).toBeNull();
    const ref = rng(9);
    ref.int(0x40000000);
    expect(r.next()).toBe(ref.next());
  });

  test('it never opens onto another building, and never fires twice', () => {
    const map = new GameMap(MAP, MAP);
    // a terrace: the middle unit's east and west faces are both party walls
    const bs: Building[] = [0, 1, 2].map((i) => ({
      x: 10 + i * 6,
      y: 10,
      w: 6,
      h: 7,
      doors: [{ x: 12 + i * 6, y: 16, side: 's' as const, width: 1 as const }],
    }));
    bs.forEach((b, i) => stampStructure(map, b, i));
    const mid = interiorOf(map, structuresOf(map, [bs[1]])[0]) as Interior;
    expect(addRearDoor(map, mid, rng(2))).not.toBeNull();
    const doors = extDoors(map, mid);
    expect(doors.length).toBe(2);
    for (const d of doors) expect(['n', 's']).toContain(d.side); // never through a party wall
    // a second call is a no-op: the mass now has doors on two sides
    expect(addRearDoor(map, mid, rng(2))).toBeNull();
  });

  test('a door is never cut where it would open onto water', () => {
    const map = new GameMap(MAP, MAP);
    const b: Building = { x: 10, y: 10, w: 9, h: 7, doors: [{ x: 14, y: 16, side: 's', width: 1 }] };
    for (let x = 0; x < MAP; x++) map.setTerrain(x, 9, 'water'); // the whole north bank
    const it = stamp(map, b);
    expect(addRearDoor(map, it, rng(4))).toBeNull();
    expect(extDoors(map, it).length).toBe(1);
  });

  test('both doors reach the whole interior after the pass has furnished it', () => {
    const bad: string[] = [];
    for (const kind of ['open', 'town'] as const) {
      const plan = generateMap(5, 160, 120, kind);
      furnishInteriors(plan.map, plan.buildings, 21, plan.objectives[0]);
      for (const struct of structuresOf(plan.map, plan.buildings)) {
        const it = interiorOf(plan.map, struct);
        if (it === null) continue;
        const doors = extDoors(plan.map, it);
        if (it.tiles.length >= 20 && doors.length < 2) bad.push(`${kind} #${it.id}: ${doors.length} door(s)`);
        if (new Set(doors.map((d) => d.side)).size < Math.min(2, doors.length)) bad.push(`${kind} #${it.id}: one side only`);
        for (const d of doors) if (unreachedFrom(plan.map, it, d.x, d.y).length > 0) bad.push(`${kind} #${it.id}: door ${d.x},${d.y}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('after the pass every bourg mass of area >= 20 has two doors on two sides', () => {
    // The bourg already gives most of its buildings two openings (frontage +
    // venelle), so D11 fires on only a handful here — 5 barns and 2 farmhouses
    // on this seed. It is the LEGACY kinds, where addBuilding emits exactly one
    // door, that it transforms. What matters either way is the end state.
    const plan = generateMap(4, 320, 240, 'bourg');
    const before = new Map<number, number>();
    for (const struct of structuresOf(plan.map, plan.buildings)) {
      const it = interiorOf(plan.map, struct);
      if (it !== null) before.set(it.id, it.doors.length);
    }
    furnishInteriors(plan.map, plan.buildings, 21, plan.objectives[0]);
    let gained = 0;
    const bad: string[] = [];
    for (const struct of structuresOf(plan.map, plan.buildings)) {
      const it = interiorOf(plan.map, struct);
      if (it === null) continue;
      const was = before.get(it.id) ?? 0;
      if (was === 1 && it.doors.length === 2) gained++;
      if (was >= 2 && it.doors.length > was + 1) bad.push(`#${it.id}: ${was} -> ${it.doors.length}`);
      if (it.tiles.length >= 20 && it.doors.length < 2) bad.push(`#${it.id}: area ${it.tiles.length}, ${it.doors.length} door(s)`);
      if (new Set(it.doors.map((d) => d.side)).size < Math.min(2, it.doors.length)) bad.push(`#${it.id}: one side only`);
      for (const d of it.doors) if (unreachedFrom(plan.map, it, d.x, d.y).length > 0) bad.push(`#${it.id}: unreachable from ${d.x},${d.y}`);
    }
    expect(bad).toEqual([]);
    expect(gained).toBeGreaterThanOrEqual(5);
  });
});
