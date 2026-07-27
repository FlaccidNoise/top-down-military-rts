import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { Sim, TEAM_FAN } from '../src/sim/sim';
import { previewMoveSpots, type MovePreview, type OverlayState } from '../src/ui/overlays';

// M4 (movement design §3): the order preview resolves through the same
// function execution does. These cover the failure states first — men the
// resolver cannot place, and the cover count the chip reports — then the
// preview === execution agreement the fan chain is built for.

const state = (o: Partial<OverlayState>): OverlayState => ({
  shot: null,
  selectedSquad: 0,
  selectedTeam: -1,
  targetMode: '',
  armedOrder: null,
  squadForce: false,
  cursor: null,
  selectedSquads: [],
  selectRect: null,
  formationDrag: null,
  ...o,
});

const men = (n: number, x: number, y: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `S${i}`, weapon: 'garand' as const, x, y: y + i * 0.1 }));

// Where the sim decided a man is going. Only PATH_BUDGET_PER_TICK (6) A*
// searches run on the order tick; the rest hold their reserved spot in
// pendingPaths until a later tick, so both have to be read to see a whole
// order — which is what the design's parity plan (§4.2) says to compare.
type PendingPeek = { pendingPaths: Map<number, { spot: { x: number; y: number } }> };
function destOf(sim: Sim, sid: number): [number, number] | null {
  const path = sim.soldiers[sid].path;
  if (path && path.length > 0) return [path[path.length - 1].x - 0.5, path[path.length - 1].y - 0.5];
  const pending = (sim as unknown as PendingPeek).pendingPaths.get(sid);
  return pending ? [pending.spot.x, pending.spot.y] : null;
}

// Every previewed man must end up on the tile the sim sends him to.
function expectParity(sim: Sim, pv: MovePreview): void {
  let checked = 0;
  for (const t of pv.teams) {
    for (const sp of t.spots) {
      expect(destOf(sim, sp.sid), `soldier ${sp.sid} was previewed but never dispatched`).toEqual([sp.x, sp.y]);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
}

describe('refusal surfaces at preview time (design §3.4)', () => {
  it('men with no footing in reach are listed, not silently dropped', () => {
    // A 2x2 grass islet in open water: four tiles for eight men.
    const sim = new Sim(new GameMap(24, 24, 'water'), 3);
    for (let y = 11; y <= 12; y++) for (let x = 11; x <= 12; x++) sim.map.setTerrain(x, y, 'grass');
    sim.addSquad('blue', 'A', men(8, 11.5, 11.5));
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], cursor: { x: 12, y: 12 } }))!;

    expect(pv.placed).toBe(4);
    expect(pv.refused).toBe(4);
    // every man is accounted for — placed or refused, never missing
    expect(pv.placed + pv.refused).toBe(sim.squads[0].soldierIds.length);
    // placed men stand on distinct passable tiles
    const keys = pv.teams[0].spots.map((s) => `${s.x},${s.y}`);
    expect(new Set(keys).size).toBe(4);
    for (const s of pv.teams[0].spots) expect(sim.map.terrainAt(s.x, s.y).passable).toBe(true);
    // and each refusal carries the slot it failed at, so the cross has somewhere to draw
    for (const r of pv.teams[0].refused) expect(Number.isFinite(r.slotX) && Number.isFinite(r.slotY)).toBe(true);
  });

  it('no preview at all when nothing is selected or a target mode owns the cursor', () => {
    const sim = new Sim(new GameMap(24, 24), 3);
    sim.addSquad('blue', 'A', men(4, 5.5, 5.5));
    expect(previewMoveSpots(sim, state({ selectedSquads: [], cursor: { x: 12, y: 12 } }))).toBeNull();
    expect(previewMoveSpots(sim, state({ selectedSquads: [0], cursor: null }))).toBeNull();
    expect(previewMoveSpots(sim, state({ selectedSquads: [0], cursor: { x: 12, y: 12 }, targetMode: 'barrage' }))).toBeNull();
  });
});

describe('cover truth and snap tails', () => {
  // A N-S hedge column at x = 30, enemy known to the east: the resolver puts
  // men on the WEST flank (design §4.3a), which is what the dots must show.
  function hedgeSim(): Sim {
    const sim = new Sim(new GameMap(48, 24), 11);
    for (let y = 0; y < 24; y++) sim.map.setTerrain(30, y, 'hedge');
    sim.addSquad('blue', 'A', men(6, 10.5, 12));
    sim.spotted.blue.set(999, { x: 40.5, y: 12.5 });
    return sim;
  }

  it('dots report directional cover and carry the tail back to their slot', () => {
    const sim = hedgeSim();
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], cursor: { x: 28.4, y: 12.3 } }))!;
    expect(pv.covered).toBeGreaterThan(0);
    const snapped = pv.teams[0].spots.filter((s) => s.snapped);
    expect(snapped.length).toBeGreaterThan(0);
    // a snapped dot sits somewhere other than its own slot tile — the tail has length
    for (const s of snapped) expect([s.x, s.y]).not.toEqual([Math.floor(s.slotX), Math.floor(s.slotY)]);
    // the men are on the hedge's west flank, between it and the enemy east of it
    for (const s of pv.teams[0].spots) expect(s.x).toBeLessThan(30);
    expect(pv.teams[0].spots.some((s) => s.covered && s.x === 29)).toBe(true);
  });

  it('preview === execution for the plain right-click a squad receives', () => {
    const sim = hedgeSim();
    const cursor = { x: 28.4, y: 12.3 };
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], cursor }))!;
    // commitOrder's short-click branch for one selected squad: fanOffsets(1, SQUAD_FAN) === [0]
    sim.orderSquad(0, { kind: 'move', x: cursor.x, y: cursor.y });
    expectParity(sim, pv);
  });

  it('preview === execution for a defend order, arc-free and stance-aware', () => {
    const sim = hedgeSim();
    const cursor = { x: 28.4, y: 12.3 };
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], cursor, armedOrder: 'defend' }))!;
    expect(pv.kind).toBe('defend');
    sim.orderSquad(0, { kind: 'defend', x: cursor.x, y: cursor.y });
    expectParity(sim, pv);
  });

  it('an armed kind outside the move family previews the move the order will actually be', () => {
    const sim = hedgeSim();
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], cursor: { x: 28.4, y: 12.3 }, armedOrder: 'smoke' }))!;
    expect(pv.kind).toBe('move');
  });
});

describe('the fan chain matches commitOrder → orderSquad → orderTeam', () => {
  function twoTeamSim(): Sim {
    const sim = new Sim(new GameMap(64, 40), 5);
    sim.addSquadFromDef('blue', 'us_rifle', 12, 20);
    return sim;
  }

  it('a narrowed team previews alone, at the squad anchor with no team fan', () => {
    const sim = twoTeamSim();
    const teamIds = sim.squads[0].teamIds;
    expect(teamIds.length).toBe(2);
    const cursor = { x: 36, y: 20 };
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], selectedTeam: teamIds[1], cursor }))!;
    expect(pv.teams.map((t) => t.teamId)).toEqual([teamIds[1]]);
    expect([pv.teams[0].x, pv.teams[0].y]).toEqual([cursor.x, cursor.y]);
    sim.orderTeam(teamIds[1], { kind: 'move', x: cursor.x, y: cursor.y });
    expectParity(sim, pv);
  });

  it('shift (squad force) and an armed kind both defeat the narrowing, and fan both teams', () => {
    const cursor = { x: 36, y: 20 };
    for (const st of [
      state({ selectedSquads: [0], selectedTeam: 1, cursor, squadForce: true }),
      state({ selectedSquads: [0], selectedTeam: 1, cursor, armedOrder: 'fast' }),
    ]) {
      const sim = twoTeamSim();
      const pv = previewMoveSpots(sim, st)!;
      expect(pv.teams.length).toBe(2);
      expect(pv.teams.map((t) => t.y)).toEqual([cursor.y - TEAM_FAN / 2, cursor.y + TEAM_FAN / 2]);
    }
  });

  it('preview === execution through a formation drag, both teams', () => {
    const sim = twoTeamSim();
    const drag = { ax: 34, ay: 18, facing: 0.6, width: 12 };
    // the cursor is deliberately elsewhere: the drag branch anchors on the
    // drag, exactly as commitOrder does, and must ignore it
    const pv = previewMoveSpots(sim, state({ selectedSquads: [0], cursor: { x: 5, y: 5 }, formationDrag: drag }))!;
    sim.orderSquad(0, { kind: 'move', x: drag.ax, y: drag.ay, facing: drag.facing, width: drag.width });
    expectParity(sim, pv);
  });
});
