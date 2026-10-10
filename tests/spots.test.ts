import { describe, expect, it } from 'vitest';
import { EDGE, GameMap, los } from '../src/sim/map';
import { orderLevel, resolveMoveSpots, SNAP_R, threatBearing, type SpotQuery } from '../src/sim/spots';
import { RedCommander } from '../src/sim/ai';
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

  it('facing is NOT a rung: it is the formation long axis, not a threat direction (M3)', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const ids = [addOne(sim, 'blue', 5.5, 10.5)];
    sim.spotted.blue.set(999, { x: 20.5, y: 18.5 }); // 8 m south of the anchor
    // a line dragged east-west (facing 0) with the enemy south reads south,
    // not east — the drag axis says nothing about which side the threat is on
    expect(threatBearing(sim, q0(sim, ids, { facing: 0, width: 6 }))).toBeCloseTo(Math.PI / 2, 6);
    // and with no intel at all it falls to travel direction, still not facing
    sim.spotted.blue.clear();
    expect(threatBearing(sim, q0(sim, ids, { facing: 1.2, width: 6 }))).not.toBe(1.2);
  });

  it('2: nearest known contact within 100 m of the anchor — spotted and ghost contacts both count', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const ids = [addOne(sim, 'blue', 5.5, 10.5)];
    sim.spotted.blue.set(999, { x: 20.5, y: 18.5 }); // 8 m south of the anchor
    expect(threatBearing(sim, q0(sim, ids))).toBeCloseTo(Math.PI / 2, 6);
    sim.spotted.blue.clear();
    sim.contacts.blue.set('s999', { kind: 'infantry', x: 20.5, y: 4.5, tick: 0 }); // ghost 6 m north
    expect(threatBearing(sim, q0(sim, ids))).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('3: intel beyond 100 m is ignored — travel direction (centroid → anchor) is the fallback', () => {
    const sim = new Sim(new GameMap(200, 20), 1);
    const ids = [addOne(sim, 'blue', 30.5, 10.5)];
    sim.spotted.blue.set(999, { x: 150.5, y: 10.5 }); // 130 m east of the anchor: out of intel range
    // anchor west of the man ⇒ travel direction is west
    expect(threatBearing(sim, { soldierIds: ids, x: 20.5, y: 10.5, kind: 'move' })).toBeCloseTo(Math.PI, 6);
  });

  it('4: dig-in-where-you-stand reads the side threat axis, never atan2(0,0) = due east', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const ids = [addOne(sim, 'blue', 20.5, 10.5)];
    // anchor on the man himself: the travel vector is degenerate
    expect(threatBearing(sim, { soldierIds: ids, x: 20.5, y: 10.5, kind: 'move' })).toBeCloseTo(0, 6); // default: attacker, enemy east
    sim.threatAxis.blue = Math.PI; // staged as the defender (bridge.ts sets this)
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

  // The flank rule used to hold ONLY on an exactly axis-aligned bearing: the
  // along-run hedge neighbours sit at 90° − Δ, so any off-axis enemy pulled
  // them into the cone and the hedge tile itself outscored its flank
  // (0.875 vs 0.850). cos Δ weighting projects the lip onto the threat
  // direction instead, so the answer no longer turns on a staged coincidence.
  it('a-offaxis: the flank still wins when the enemy is not exactly on the axis', () => {
    for (const dy of [0.1, 1, 3, 6, -4]) {
      const { sim, ids } = hedgeSim();
      const red = addOne(sim, 'red', 40.5, 8.5 + dy);
      sim.spotted.blue.set(red, { x: 40.5, y: 8.5 + dy });
      const q: SpotQuery = { soldierIds: ids, x: HX - 2 + 0.5, y: 8.5, kind: 'move' };
      const [spot] = resolveMoveSpots(sim, q, new Set());
      expect(sim.map.terrainKeyAt(spot.x, spot.y), `enemy dy=${dy} put the man on`).toBe('grass');
      expect(spot.x).toBe(HX - 1);
      expect(spot.covered).toBe(true);
    }
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

// M3 garrison audit. Two rules the resolver had to learn back from findSpot:
// a slot inside a building resolves inside one, and a firing position keeps
// findSpot's full r <= 5 garrison reach even though terrain cover does not.
// A walled room with buildingId `id` on its floor tiles.
function room(sim: Sim, x0: number, y0: number, x1: number, y1: number, id = 0): void {
  const m = sim.map;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      m.setTerrain(x, y, 'floor');
      m.buildingId[y * m.w + x] = id;
    }
  }
  for (let x = x0; x <= x1; x++) {
    m.setHEdge(x, y0, EDGE.WALL);
    m.setHEdge(x, y1 + 1, EDGE.WALL);
  }
  for (let y = y0; y <= y1; y++) {
    m.setVEdge(x0, y, EDGE.WALL);
    m.setVEdge(x1 + 1, y, EDGE.WALL);
  }
}

describe('garrison containment and reach (M3)', () => {
  const EAST: [number, number] = [-0.5, 0.5];

  it('a slot inside a building never resolves onto the ground outside it', () => {
    const sim = new Sim(new GameMap(40, 30), 3);
    room(sim, 10, 10, 16, 16); // windowless: nothing indoors scores
    for (let y = 8; y < 22; y++) sim.map.setTerrain(19, y, 'hedge'); // hedge 2 tiles east of the east wall
    const ids = [addOne(sim, 'blue', 12.5, 13.5)];
    // (18,13) is the hedge's west flank against an eastern threat and sits
    // exactly SNAP_R from the slot: it scores 0.55 and would win outright.
    const [spot] = resolveMoveSpots(sim, { soldierIds: ids, x: 15.5, y: 13.5, kind: 'defend', arc: EAST }, new Set());
    expect([spot.x, spot.y]).toEqual([15, 13]); // holds the house he was told to hold
    expect(sim.map.buildingIdAt(spot.x, spot.y)).toBe(0);
    expect(spot.snapped).toBe(false);
  });

  it('a slot OUTSIDE a building still snaps into one — the pull to windows is one-way', () => {
    const sim = new Sim(new GameMap(40, 30), 3);
    room(sim, 10, 10, 16, 16);
    sim.map.setVEdge(17, 13, EDGE.WINDOW); // east-wall loophole
    const ids = [addOne(sim, 'blue', 25.5, 13.5)];
    const [spot] = resolveMoveSpots(sim, { soldierIds: ids, x: 18.5, y: 13.5, kind: 'defend', arc: EAST }, new Set());
    expect([spot.x, spot.y]).toEqual([16, 13]); // the nook tile, inside the wall
    expect(spot.snapped).toBe(true);
  });

  it('a window nook past SNAP_R still pulls a defender — findSpot scored the whole r <= 5 ring', () => {
    const sim = new Sim(new GameMap(40, 30), 3);
    room(sim, 10, 10, 16, 16);
    sim.map.setVEdge(10, 13, EDGE.WINDOW); // west-wall loophole, 5 tiles off the slot
    const ids = [addOne(sim, 'blue', 12.5, 13.5)];
    const west: [number, number] = [Math.PI - 0.5, Math.PI + 0.5];
    const [spot] = resolveMoveSpots(sim, { soldierIds: ids, x: 15.5, y: 13.5, kind: 'defend', arc: west }, new Set());
    expect([spot.x, spot.y]).toEqual([10, 13]);
    expect(cheby(spot.x, spot.y, 15, 13)).toBe(5); // past the coherence cap, on purpose
  });

  it('a full building still places the man outside rather than dropping him', () => {
    const sim = new Sim(new GameMap(40, 30), 3);
    room(sim, 10, 10, 10, 10); // one interior tile…
    const ids = [addOne(sim, 'blue', 12.5, 13.5)];
    const used = new Set<number>([10 * sim.map.w + 10]); // …and it is already taken
    const [spot] = resolveMoveSpots(sim, { soldierIds: ids, x: 10.5, y: 10.5, kind: 'defend', arc: EAST }, used);
    expect(spot).toBeDefined();
    expect(sim.map.buildingIdAt(spot.x, spot.y)).toBe(-1);
    expect(cheby(spot.x, spot.y, 10, 10)).toBe(1); // nearest ring, findSpot's order
  });
});

describe('red runDefend garrisons through the resolver (M3)', () => {
  it('a defend-stance squad ordered onto a building post ends up inside it, at the windows that face the enemy', () => {
    const sim = new Sim(new GameMap(60, 40), 11);
    room(sim, 20, 16, 27, 23);
    sim.map.setVEdge(28, 19, EDGE.DOOR); // the way in, at the back
    // Red expects its enemy from the west (sim.threatAxis). Two loopholes face
    // that way and four do not (#794: a window on the far wall used to score
    // the same as one facing the enemy).
    for (const y of [17, 21]) sim.map.setVEdge(20, y, EDGE.WINDOW); // west wall
    for (const y of [17, 21]) sim.map.setVEdge(28, y, EDGE.WINDOW); // east wall
    for (const x of [22, 25]) sim.map.setHEdge(x, 24, EDGE.WINDOW); // south wall
    const post = { x: 24.5, y: 19.5 };
    // inside runDefend's 8 m post radius but outside the wall, so the walk in
    // is the resolver's doing, not the spawn's
    const sq = sim.addSquad(
      'red',
      'Garrison',
      Array.from({ length: 6 }, (_, i) => ({ name: `R${i}`, weapon: 'kar98k' as const, x: 31.5, y: 17.5 + i })),
    );
    const commander = new RedCommander({ side: 'red', stance: 'defend', posts: { [sq.id]: post } });
    for (let i = 0; i < 2400; i++) {
      commander.update(sim);
      sim.step();
    }
    const kind = sim.teams[sq.teamIds[0]].orderState.order?.kind;
    expect(['defend', 'ambush']).toContain(kind);
    const men = sq.soldierIds.map((id) => sim.soldiers[id]);
    const inside = men.filter((s) => sim.map.buildingIdAt(Math.floor(s.x), Math.floor(s.y)) === 0);
    expect(inside.length).toBe(men.length);
    const tiles = inside.map((s) => `${Math.floor(s.x)},${Math.floor(s.y)}`);
    expect(tiles).toContain('20,17'); // both west loopholes manned
    expect(tiles).toContain('20,21');
    // The rest stand where one of the two gives them a sight line west,
    // straight or some 30 degrees off it (the resolver's own rays run from
    // the squad's line of march, a few degrees off due west).
    const seesWest = (s: { x: number; y: number }): boolean =>
      [0, Math.PI / 6, -Math.PI / 6].some((a) => los(sim.map, s.x, s.y, Math.max(0.5, s.x - Math.cos(a) * 40), s.y + Math.sin(a) * 40, 0, 0, 1.1, 1.6).visible);
    expect(inside.filter(seesWest).length).toBeGreaterThanOrEqual(4);
    expect(tiles.some((t) => ['27,17', '27,21', '22,23', '25,23'].includes(t))).toBe(false); // the east and south loopholes
  });

  it('field of fire is for holding ground: a move order resolves as it did, and a blind room still places every man', () => {
    const sim = new Sim(new GameMap(60, 40), 11);
    room(sim, 20, 16, 27, 23);
    sim.map.setVEdge(28, 19, EDGE.DOOR);
    for (const y of [17, 21]) sim.map.setVEdge(28, y, EDGE.WINDOW); // loopholes, all facing away from the west
    const ids = Array.from({ length: 6 }, (_, i) => addOne(sim, 'red', 31.5, 17.5 + i));
    const hold = resolveMoveSpots(sim, { soldierIds: ids, x: 24.5, y: 19.5, kind: 'defend', arc: [Math.PI - 0.5, Math.PI + 0.5] }, new Set());
    expect(hold).toHaveLength(6); // nobody dropped for want of a view
    expect(hold.every((s) => sim.map.buildingIdAt(s.x, s.y) === 0)).toBe(true); // and nobody put out of the house
    const move = resolveMoveSpots(sim, { soldierIds: ids, x: 24.5, y: 19.5, kind: 'move' }, new Set());
    expect(move.every((s) => Math.max(Math.abs(s.x - 24), Math.abs(s.y - 19)) <= 5)).toBe(true); // the old reach, not the hold's 8
  });
});

// M4b: the resolver learns which floor it is resolving on. Terrain and walls
// are one 2-D layer shared by every storey (interiors D1), so the storey COUNT
// is the only per-level fact — and it decides whether a tile exists upstairs
// at all.
function storeys(sim: Sim, x0: number, y0: number, x1: number, y1: number, n: number): void {
  const m = sim.map;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.stories[y * m.w + x] = n;
  m.maxStories = Math.max(m.maxStories, n);
}

describe('floors: the resolver only hands out tiles that have the storey (M4b)', () => {
  const EAST: [number, number] = [-0.5, 0.5];

  // One building: a three-storey block at 10..14 with a single-storey lean-to
  // bolted on its east side at 15..18. Upstairs, only the block exists.
  function leanTo(): Sim {
    const sim = new Sim(new GameMap(40, 30), 3);
    room(sim, 10, 10, 18, 16);
    storeys(sim, 10, 10, 14, 16, 3);
    storeys(sim, 15, 10, 18, 16, 1);
    return sim;
  }

  it('an upstairs order never puts a man over the single-storey wing', () => {
    const sim = leanTo();
    const ids = Array.from({ length: 6 }, (_, i) => addOne(sim, 'blue', 20.5, 12.5 + i * 0.1));
    // Anchor deliberately IN the lean-to: every man has to be pulled west.
    const spots = resolveMoveSpots(sim, { soldierIds: ids, x: 16.5, y: 13.5, kind: 'defend', arc: EAST, l: 2 }, new Set());
    expect(spots.length).toBe(6);
    for (const s of spots) {
      expect(sim.map.storiesAt(s.x, s.y)).toBeGreaterThan(2);
      expect(s.l).toBe(2);
      expect(s.x).toBeLessThanOrEqual(14);
    }
  });

  it('a floor the building does not reach refuses the man instead of inventing one', () => {
    const sim = leanTo();
    const ids = [addOne(sim, 'blue', 20.5, 13.5)];
    // Level 3 is the fourth floor; the tallest thing here has three.
    expect(resolveMoveSpots(sim, { soldierIds: ids, x: 12.5, y: 13.5, kind: 'defend', arc: EAST, l: 3 }, new Set())).toEqual([]);
  });

  it('ground orders are untouched: no storey gate, and l is 0', () => {
    const sim = leanTo();
    const ids = [addOne(sim, 'blue', 20.5, 13.5)];
    const q: SpotQuery = { soldierIds: ids, x: 16.5, y: 13.5, kind: 'move' };
    const bare = resolveMoveSpots(sim, q, new Set());
    const zero = resolveMoveSpots(sim, { ...q, l: 0 }, new Set());
    expect(bare).toEqual(zero);
    expect(bare[0].l).toBe(0);
    expect([bare[0].x, bare[0].y]).toEqual([16, 13]); // the lean-to tile, storeys or not
  });

  it('orderLevel: explicit wins, defend and ambush garrison the top storey, everything else is ground', () => {
    const sim = leanTo();
    expect(orderLevel(sim, 'defend', 12.5, 13.5)).toBe(2); // three storeys ⇒ the third
    expect(orderLevel(sim, 'ambush', 12.5, 13.5)).toBe(2);
    expect(orderLevel(sim, 'move', 12.5, 13.5)).toBe(0); // walking there is a ground-floor job
    expect(orderLevel(sim, 'defend', 16.5, 13.5)).toBe(0); // the lean-to has one storey
    expect(orderLevel(sim, 'defend', 25.5, 25.5)).toBe(0); // open ground
    expect(orderLevel(sim, 'defend', 12.5, 13.5, 1)).toBe(1); // the floor menu overrules the default
    expect(orderLevel(sim, 'move', 12.5, 13.5, 2)).toBe(2);
  });
});

describe('ring bound and coherence cap (design §1.2)', () => {
  it('terrain cover never drifts more than SNAP_R from the slot — only a nook reaches further', () => {
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
