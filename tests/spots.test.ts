import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { resolveMoveSpots, SNAP_R, threatBearing, type SpotQuery } from '../src/sim/spots';
import { eligible, Sim, type Side } from '../src/sim/sim';

// M1 (movement design §4.1, §4.3): the resolver as a pure function. Staged
// maps, manual intel — no generated content, so every assertion is exact.

const cheby = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

function addOne(sim: Sim, side: Side, x: number, y: number): number {
  const weapon = side === 'blue' ? ('garand' as const) : ('kar98k' as const);
  const sq = sim.addSquad(side, `${side}${x}`, [{ name: 'S', weapon, x, y }]);
  return sq.soldierIds[0];
}

// A N→S hedge column at x = HX on open grass.
const HX = 24;
function hedgeSim(): { sim: Sim; ids: number[] } {
  const sim = new Sim(new GameMap(48, 16), 7);
  for (let y = 0; y < 16; y++) sim.map.setTerrain(HX, y, 'hedge');
  const ids = [addOne(sim, 'blue', 8.5, 8.5)];
  return { sim, ids };
}

describe('threatBearing ladder (design §1.3)', () => {
  const q0 = (sim: Sim, ids: number[], extra: Partial<SpotQuery> = {}): SpotQuery => ({
    soldierIds: ids,
    x: 20.5,
    y: 10.5,
    kind: 'move',
    ...extra,
  });

  it('1: arc midpoint wins over everything, wrap included', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const ids = [addOne(sim, 'blue', 5.5, 10.5)];
    sim.spotted.blue.set(999, { x: 20.5, y: 2.5 }); // intel present but outranked
    const west = threatBearing(sim, q0(sim, ids, { kind: 'defend', arc: [Math.PI - 0.3, Math.PI + 0.3], facing: 0.7 }));
    expect(west).toBeCloseTo(Math.PI, 6);
    // wrapping arc 270°→90° midpoint is due east (0), not west
    const wrap = threatBearing(sim, q0(sim, ids, { kind: 'defend', arc: [1.5 * Math.PI, 0.5 * Math.PI] }));
    expect(Math.cos(wrap)).toBeCloseTo(1, 6);
    expect(Math.sin(wrap)).toBeCloseTo(0, 6);
  });

  it('2: facing when no arc', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const ids = [addOne(sim, 'blue', 5.5, 10.5)];
    sim.spotted.blue.set(999, { x: 20.5, y: 2.5 });
    expect(threatBearing(sim, q0(sim, ids, { facing: 1.2, width: 6 }))).toBe(1.2);
  });

  it('3: nearest known contact within 100 m of the anchor — spotted and ghost contacts both count', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const ids = [addOne(sim, 'blue', 5.5, 10.5)];
    sim.spotted.blue.set(999, { x: 20.5, y: 18.5 }); // 8 m south of the anchor
    expect(threatBearing(sim, q0(sim, ids))).toBeCloseTo(Math.PI / 2, 6);
    sim.spotted.blue.clear();
    sim.contacts.blue.set('s999', { kind: 'infantry', x: 20.5, y: 4.5, tick: 0 }); // ghost 6 m north
    expect(threatBearing(sim, q0(sim, ids))).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('4: intel beyond 100 m is ignored — travel direction (centroid → anchor) is the fallback', () => {
    const sim = new Sim(new GameMap(200, 20), 1);
    const ids = [addOne(sim, 'blue', 30.5, 10.5)];
    sim.spotted.blue.set(999, { x: 150.5, y: 10.5 }); // 130 m east of the anchor: out of intel range
    // anchor west of the man ⇒ travel direction is west
    expect(threatBearing(sim, { soldierIds: ids, x: 20.5, y: 10.5, kind: 'move' })).toBeCloseTo(Math.PI, 6);
  });
});

describe('cover-snap scorer fixtures (design §4.3)', () => {
  it('a: snaps to the WEST flank of a hedge when the known enemy is east — never onto the hedge', () => {
    const { sim, ids } = hedgeSim();
    const red = addOne(sim, 'red', 40.5, 8.5);
    sim.spotted.blue.set(red, { x: 40.5, y: 8.5 });
    const q: SpotQuery = { soldierIds: ids, x: HX - 2 + 0.5, y: 8.5, kind: 'move' };
    const [spot] = resolveMoveSpots(sim, q, new Set());
    // the flank column x = HX-1; the dy-major ring walk reaches (HX-1, 7)
    // first among the equal-score flank tiles (findSpot iteration order)
    expect([spot.x, spot.y]).toEqual([HX - 1, 7]);
    expect(spot.snapped).toBe(true);
    expect(spot.covered).toBe(true);
  });

  it('a-mirror: the same order with the enemy WEST crosses to the east flank', () => {
    const { sim, ids } = hedgeSim();
    const red = addOne(sim, 'red', 4.5, 8.5);
    sim.spotted.blue.set(red, { x: 4.5, y: 8.5 });
    const q: SpotQuery = { soldierIds: ids, x: HX - 2 + 0.5, y: 8.5, kind: 'move' };
    const [spot] = resolveMoveSpots(sim, q, new Set());
    expect(spot.x).toBe(HX + 1); // east flank column — cover between him and the western threat
    expect(spot.covered).toBe(true);
    expect(Math.max(Math.abs(spot.x - (HX - 2)), Math.abs(spot.y - 8))).toBeLessThanOrEqual(SNAP_R);
  });

  it('b: defend-with-arc takes the window nook over open floor', () => {
    const sim = new Sim(new GameMap(30, 30), 3);
    const m = sim.map;
    for (let y = 10; y <= 14; y++) {
      for (let x = 10; x <= 14; x++) {
        m.setTerrain(x, y, 'floor');
        m.buildingId[y * m.w + x] = 0;
      }
    }
    for (let x = 10; x <= 14; x++) {
      m.setHEdge(x, 10, EDGE.WALL);
      m.setHEdge(x, 15, EDGE.WALL);
    }
    for (let y = 10; y <= 14; y++) {
      m.setVEdge(10, y, EDGE.WALL);
      m.setVEdge(15, y, EDGE.WALL);
    }
    m.setVEdge(10, 12, EDGE.WINDOW); // one loophole in the west wall
    const ids = [addOne(sim, 'blue', 12.5, 12.5)];
    const q: SpotQuery = { soldierIds: ids, x: 12.5, y: 12.5, kind: 'defend', arc: [Math.PI - 0.5, Math.PI + 0.5] };
    const [spot] = resolveMoveSpots(sim, q, new Set());
    expect([spot.x, spot.y]).toEqual([10, 12]); // the nook, 2 tiles off-slot
    expect(spot.covered).toBe(true);
  });

  it('b-gate: a window edge with no building around it is not a nook (garrisonScore parity)', () => {
    const sim = new Sim(new GameMap(30, 30), 3);
    sim.map.setVEdge(20, 5, EDGE.WINDOW); // stray edge on open grass, buildingId -1
    const ids = [addOne(sim, 'blue', 18.5, 5.5)];
    const [spot] = resolveMoveSpots(sim, { soldierIds: ids, x: 20.5, y: 5.5, kind: 'defend', arc: [-0.5, 0.5] }, new Set());
    expect([spot.x, spot.y]).toEqual([20, 5]); // stays on its slot…
    expect(spot.covered).toBe(false); // …and is NOT sold to the player as covered
  });

  it('c: a bank flank is prone-only — ambush snaps to it, defend and move do not', () => {
    const sim = new Sim(new GameMap(48, 16), 5);
    for (let y = 0; y < 16; y++) sim.map.setTerrain(30, y, 'bank');
    const ids = [addOne(sim, 'blue', 8.5, 8.5)];
    const east: [number, number] = [-0.5, 0.5];
    const q = (kind: SpotQuery['kind'], arc?: [number, number]): SpotQuery => ({ soldierIds: ids, x: 28.5, y: 8.5, kind, arc });
    const [ambush] = resolveMoveSpots(sim, q('ambush', east), new Set());
    expect(ambush.x).toBe(29); // hugging the bank column, threat side
    expect(ambush.snapped).toBe(true);
    expect(ambush.covered).toBe(true);
    const [defend] = resolveMoveSpots(sim, q('defend', east), new Set());
    expect([defend.x, defend.y]).toEqual([28, 8]); // crouch sees over a 1 m bank: no credit
    expect(defend.snapped).toBe(false);
    const [move] = resolveMoveSpots(sim, q('move'), new Set());
    expect([move.x, move.y]).toEqual([28, 8]);
    expect(move.covered).toBe(false);
  });

  it('d: open ground with no cover in reach is byte-identical to the legacy ring walk', () => {
    const sim = new Sim(new GameMap(60, 20), 9);
    const ids = [addOne(sim, 'blue', 5.5, 9.5), addOne(sim, 'blue', 5.5, 10.5), addOne(sim, 'blue', 5.5, 11.5)];
    const used = new Set<number>();
    const spots = resolveMoveSpots(sim, { soldierIds: ids, x: 40.5, y: 10.5, kind: 'move' }, used);
    // legacy OFFSETS blob: [0,0], [1.5,0], [-1.5,0] — slots taken verbatim
    expect(spots.map((s) => [s.x, s.y])).toEqual([
      [40, 10],
      [42, 10],
      [39, 10],
    ]);
    expect(spots.every((s) => !s.snapped && !s.covered)).toBe(true);
    expect(spots.map((s) => s.sid)).toEqual(ids); // output order = input order
    expect(used.size).toBe(3);
    for (const s of spots) expect(used.has(s.y * sim.map.w + s.x)).toBe(true);
  });

  it('d2: a reserved slot bumps the next man to the legacy ring order tile (r=1 starts at −1,−1)', () => {
    const sim = new Sim(new GameMap(60, 20), 9);
    const a = [addOne(sim, 'blue', 5.5, 9.5)];
    const b = [addOne(sim, 'blue', 5.5, 10.5)];
    const used = new Set<number>();
    const [first] = resolveMoveSpots(sim, { soldierIds: a, x: 40.5, y: 10.5, kind: 'move' }, used);
    const [second] = resolveMoveSpots(sim, { soldierIds: b, x: 40.5, y: 10.5, kind: 'move' }, used);
    expect([first.x, first.y]).toEqual([40, 10]);
    expect([second.x, second.y]).toEqual([39, 9]); // findSpot's dy-major ring: first r=1 candidate
    expect(second.snapped).toBe(true);
  });
});

describe('ring bound and coherence cap (design §1.2)', () => {
  it('never drifts more than SNAP_R from the slot, and cover beyond SNAP_R does not attract', () => {
    const { sim, ids } = hedgeSim();
    const red = addOne(sim, 'red', 40.5, 8.5);
    sim.spotted.blue.set(red, { x: 40.5, y: 8.5 });
    // slot 4 tiles west of the flank tile (HX-1): out of snap reach ⇒ no snap
    const far = resolveMoveSpots(sim, { soldierIds: ids, x: HX - 5 + 0.5, y: 8.5, kind: 'move' }, new Set())[0];
    expect([far.x, far.y]).toEqual([HX - 5, 8]);
    expect(far.snapped).toBe(false);
    // sweep anchors up to the hedge: drift stays within the cap everywhere
    for (let ax = 18; ax <= 27; ax++) {
      const [s] = resolveMoveSpots(sim, { soldierIds: ids, x: ax + 0.5, y: 8.5, kind: 'move' }, new Set());
      expect(cheby(s.x, s.y, ax, 8)).toBeLessThanOrEqual(SNAP_R);
    }
  });
});

describe('purity, determinism, zero rng (design §4.1)', () => {
  function intelSim(seed: number): { sim: Sim; ids: number[] } {
    const { sim, ids } = hedgeSim();
    const red = addOne(sim, 'red', 40.5, 8.5);
    sim.spotted.blue.set(red, { x: 40.5, y: 8.5 });
    void seed;
    return { sim, ids };
  }

  it('same inputs ⇒ byte-equal outputs across 100 calls', () => {
    const { sim, ids } = intelSim(7);
    const q: SpotQuery = { soldierIds: ids, x: 22.5, y: 8.5, kind: 'move' };
    const first = JSON.stringify(resolveMoveSpots(sim, q, new Set()));
    for (let i = 0; i < 99; i++) {
      expect(JSON.stringify(resolveMoveSpots(sim, q, new Set()))).toBe(first);
    }
  });

  it('does not mutate the sim and draws zero rng — twin sims stay in lockstep after 50 resolver calls', () => {
    const a = intelSim(7);
    const b = intelSim(7);
    const before = a.sim.snapshot();
    const q: SpotQuery = { soldierIds: a.ids, x: 22.5, y: 8.5, kind: 'move' };
    for (let i = 0; i < 50; i++) resolveMoveSpots(a.sim, q, new Set());
    expect(a.sim.snapshot()).toBe(before); // no state written by the resolver itself
    // any hidden rng draw or mutation would desync the shared-stream twins here
    for (let t = 0; t < 30; t++) {
      a.sim.step();
      b.sim.step();
    }
    expect(a.sim.snapshot()).toBe(b.sim.snapshot());
  });

  it('empty query resolves to nothing and touches nothing', () => {
    const { sim } = intelSim(7);
    const used = new Set<number>();
    expect(resolveMoveSpots(sim, { soldierIds: [], x: 22.5, y: 8.5, kind: 'move' }, used)).toEqual([]);
    expect(used.size).toBe(0);
  });
});

describe('shared eligible() export', () => {
  it('is the sim predicate: alive, not downed, not captured, not broken', () => {
    const sim = new Sim(new GameMap(20, 20), 1);
    const id = addOne(sim, 'blue', 5.5, 5.5);
    const s = sim.soldiers[id];
    expect(eligible(s)).toBe(true);
    s.mental = 'broken';
    expect(eligible(s)).toBe(false);
    s.mental = 'steady';
    s.downed = true;
    expect(eligible(s)).toBe(false);
    s.downed = false;
    s.captured = true;
    expect(eligible(s)).toBe(false);
    s.captured = false;
    s.alive = false;
    expect(eligible(s)).toBe(false);
  });
});
