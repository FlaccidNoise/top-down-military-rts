import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { TEAMS, type SoldierSlot } from '../src/sim/data';
import { Sim, type BoomEvent, type GrenadeThrow, type UnitEvent } from '../src/sim/sim';

// Open ground; soldiers get zeroed ammo unless a test needs live rounds.
const flat = () => new GameMap(30, 20);

// Open ground fenced across the objective with free-standing timber gates —
// the one thing a grenade's 2 energy will open (GATE, threshold 1.5).
const gated = () => {
  const m = flat();
  for (let y = 8; y <= 13; y++) for (const x of [12, 13, 14]) m.setVEdge(x, y, EDGE.DOOR);
  return m;
};

function pair(opts: { dist?: number; map?: GameMap; seed?: number; grenades?: number } = {}) {
  const sim = new Sim(opts.map ?? flat(), opts.seed ?? 42);
  const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]).soldierIds[0];
  const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 5.5 + (opts.dist ?? 8), y: 10.5 }]).soldierIds[0];
  const a = sim.soldiers[aId];
  const b = sim.soldiers[bId];
  for (const s of [a, b]) {
    s.ammo = {};
    s.magLeft = 0;
  }
  a.grenadesLeft = opts.grenades ?? 2;
  return { sim, a, b };
}

function stepUntil(sim: Sim, cond: () => boolean, maxTicks = 600): boolean {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (cond()) return true;
  }
  return cond();
}

// Force a team into executing-assault state, bypassing the compliance ladder
// (unit test for the grenade mechanic, not the refusal model).
function forceAssault(sim: Sim, teamId: number, x: number, y: number): void {
  const st = sim.teams[teamId].orderState;
  st.order = { kind: 'assault', x, y };
  st.phase = 'executing';
}

// #790. Ten grenades were thrown in 38 battles: one US slot carried any, and
// a man threw only inside an executing assault.
describe('grenades outside the charge (#790)', () => {
  // The thrower at (5.5,10.5); a German 9 m east of him, hard up against a
  // hedge (cover from the tile behind him), in plain view.
  const behindHedge = (kind: 'defend' | 'move' | 'sneak' | null, opts: { friend?: boolean; open?: boolean } = {}) => {
    const m = flat();
    if (!opts.open) for (let y = 6; y <= 14; y++) m.setTerrain(15, y, 'hedge');
    const { sim, a, b } = pair({ dist: 9, map: m });
    if (opts.friend) {
      const f = sim.soldiers[sim.addSquad('blue', 'F', [{ name: 'F', weapon: 'garand', x: 12.5, y: 12.5, ammo: {} }]).soldierIds[0]];
      f.magLeft = 0;
    }
    // He holds where he is, or walks (or crawls) away west with the German behind him.
    if (kind) sim.orderTeam(a.teamId, { kind, x: kind === 'defend' ? a.x : 1.5, y: a.y });
    const under: (string | null)[] = []; // the order he was under at each throw
    const throws: GrenadeThrow[] = [];
    const events: UnitEvent[] = [];
    const booms: BoomEvent[] = [];
    const run = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        sim.step();
        const thrown = sim.takeGrenades();
        for (const _ of thrown) under.push(sim.teams[a.teamId].orderState.order?.kind ?? null);
        throws.push(...thrown);
        events.push(...sim.takeUnitEvents().filter((e) => e.kind === 'grenade'));
        booms.push(...sim.takeBooms());
      }
    };
    return { sim, a, b, throws, events, booms, under, run };
  };

  it.each(['defend', 'move', null] as const)('a man on %s throws at a spotted enemy behind cover, and the throw is reported', (kind) => {
    const { sim, a, b, throws, events, booms, under, run } = behindHedge(kind);
    expect(sim.inCover(b.x, b.y)).toBe(true);
    run(62); // the spotting sweep, one stagger window and the fuse; his second is a cooldown away
    expect(a.grenadesLeft).toBe(1);
    expect(throws).toHaveLength(1);
    expect(under).toEqual([kind]);
    // exactly the record the renderer draws the arc from
    expect(Object.keys(throws[0]).sort()).toEqual(['flightTicks', 'fromX', 'fromY', 'side', 'toX', 'toY']);
    expect(throws[0]).toMatchObject({ fromX: events[0].x, fromY: events[0].y, flightTicks: 30, side: 'blue' });
    expect(Math.hypot(throws[0].toX - b.x, throws[0].toY - b.y)).toBeLessThanOrEqual(2); // GRENADE_SCATTER
    expect(events.map((e) => [e.side, e.id, e.team])).toEqual([['blue', a.id, sim.teams[a.teamId].name]]);
    expect(booms.filter((x) => x.kind === 'grenade').map((x) => [x.x, x.y])).toEqual([[throws[0].toX, throws[0].toY]]); // it lands where the arc said
  });

  it('a lone man in the open is still a fire problem; a friend by the target stays the hand; a sneaking man keeps quiet', () => {
    const open = behindHedge('defend', { open: true });
    open.run(300);
    expect(open.a.grenadesLeft).toBe(2);

    const friend = behindHedge('defend', { friend: true }); // a blue man 2.8 m from the target
    friend.run(300);
    expect(friend.a.grenadesLeft).toBe(2);

    const sneak = behindHedge('sneak');
    sneak.run(30); // the window the walking man of the case above throws in
    expect(sneak.sim.teams[sneak.a.teamId].orderState.order?.kind).toBe('sneak');
    expect(Math.hypot(sneak.b.x - sneak.a.x, sneak.b.y - sneak.a.y)).toBeLessThan(12);
    expect(sneak.a.grenadesLeft).toBe(2);
  });

  it('a second man does not throw at a spot with one already in the air', () => {
    const { sim, a, throws, run } = behindHedge('defend');
    const c = sim.soldiers[sim.addSquad('blue', 'C', [{ name: 'C', weapon: 'garand', x: 5.5, y: 12.5, ammo: {} }]).soldierIds[0]];
    c.magLeft = 0;
    c.grenadesLeft = 2;
    run(30);
    expect(throws).toHaveLength(1);
    expect(a.grenadesLeft + c.grenadesLeft).toBe(3);
  });

  it('every rifleman of a rifle team carries two, on both sides; nobody else carries any', () => {
    for (const key of ['us_able', 'us_baker', 'de_schuetzen'] as const) {
      const slots: SoldierSlot[] = TEAMS[key].slots;
      expect(slots.filter((sl) => sl.role === 'rifleman').length, key).toBeGreaterThan(0);
      for (const sl of slots) expect(sl.grenades ?? 0, `${key} ${sl.role}`).toBe(sl.role === 'rifleman' ? 2 : 0);
    }
    for (const key of ['us_m1919_team', 'us_bazooka_team', 'de_mg_trupp', 'de_smg42_team', 'de_schreck_team'] as const) {
      const slots: SoldierSlot[] = TEAMS[key].slots;
      expect(slots.every((sl) => (sl.grenades ?? 0) === 0), key).toBe(true);
    }
  });
});

describe('grenades', () => {
  it('assaulting grenadier within 12m of ≥2 clustered visible defenders throws (2→1)', () => {
    const m = flat();
    const sim = new Sim(m, 42);
    const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]).soldierIds[0];
    const b1Id = sim.addSquad('red', 'B1', [{ name: 'B1', weapon: 'kar98k', x: 12.5, y: 10.5 }]).soldierIds[0];
    const b2Id = sim.addSquad('red', 'B2', [{ name: 'B2', weapon: 'kar98k', x: 13.5, y: 10.5 }]).soldierIds[0];
    const a = sim.soldiers[aId];
    const b1 = sim.soldiers[b1Id];
    const b2 = sim.soldiers[b2Id];
    for (const s of [a, b1, b2]) { s.ammo = {}; s.magLeft = 0; }
    a.grenadesLeft = 2;
    forceAssault(sim, a.teamId, 12.5, 10.5);
    expect(stepUntil(sim, () => a.grenadesLeft < 2, 300)).toBe(true);
    expect(a.grenadesLeft).toBe(1);
  });

  it('no throw vs a lone open-ground defender', () => {
    const { sim, a, b } = pair({ dist: 8, grenades: 2 });
    forceAssault(sim, a.teamId, b.x, b.y);
    // Step many ticks — should never throw at a lone man in the open
    for (let i = 0; i < 300; i++) sim.step();
    expect(a.grenadesLeft).toBe(2);
  });

  it('no throw at grenadesLeft=0, no throw under a non-assault order', () => {
    // grenadesLeft = 0
    const { sim: sim1, a: a1 } = pair({ dist: 8, grenades: 0 });
    forceAssault(sim1, a1.teamId, 13.5, 10.5);
    for (let i = 0; i < 200; i++) sim1.step();
    expect(a1.grenadesLeft).toBe(0);

    // non-assault order
    const { sim: sim2, a: a2, b: b2 } = pair({ dist: 8, grenades: 2 });
    const team2 = sim2.teams[a2.teamId];
    team2.orderState.order = { kind: 'move', x: b2.x, y: b2.y };
    team2.orderState.phase = 'executing';
    for (let i = 0; i < 200; i++) sim2.step();
    expect(a2.grenadesLeft).toBe(2);
  });

  it('after GRENADE_FUSE_TICKS the grenade bursts → pendingBooms emitted', () => {
    const m = flat();
    const sim = new Sim(m, 42);
    const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]).soldierIds[0];
    const b1Id = sim.addSquad('red', 'B1', [{ name: 'B1', weapon: 'kar98k', x: 12.5, y: 10.5 }]).soldierIds[0];
    const b2Id = sim.addSquad('red', 'B2', [{ name: 'B2', weapon: 'kar98k', x: 13.5, y: 10.5 }]).soldierIds[0];
    const a = sim.soldiers[aId];
    const b1 = sim.soldiers[b1Id];
    const b2 = sim.soldiers[b2Id];
    for (const s of [a, b1, b2]) { s.ammo = {}; s.magLeft = 0; }
    a.grenadesLeft = 2;
    forceAssault(sim, a.teamId, 12.5, 10.5);
    expect(stepUntil(sim, () => a.grenadesLeft < 2, 300)).toBe(true);
    // Now step until the grenade explodes (30 ticks fuse)
    let booms: BoomEvent[] = [];
    expect(stepUntil(sim, () => { booms = booms.concat(sim.takeBooms()); return booms.length > 0; }, 60)).toBe(true);
    // The renderer scales a blast off `r`: a grenade must not arrive as a shell.
    expect(booms[0].kind).toBe('grenade');
    expect(booms[0].r).toBe(3);
  });

  it('determinism: two same-seed runs produce identical snapshots with a grenade thrown', () => {
    const run = () => {
      // A grenade is the cheapest breacher there is, which makes this the most
      // valuable existing fixture for the destructible-terrain snapshot field
      // (design section 4.2). Its 2 energy opens exactly one class — a gate,
      // and only within 0.75 m — so the objective is fenced with them and the
      // run below asserts the hole actually appeared.
      const m = gated();
      const sim = new Sim(m, 42);
      const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]).soldierIds[0];
      const b1Id = sim.addSquad('red', 'B1', [{ name: 'B1', weapon: 'kar98k', x: 12.5, y: 10.5 }]).soldierIds[0];
      const b2Id = sim.addSquad('red', 'B2', [{ name: 'B2', weapon: 'kar98k', x: 13.5, y: 10.5 }]).soldierIds[0];
      const a = sim.soldiers[aId];
      for (const s of [a, sim.soldiers[b1Id], sim.soldiers[b2Id]]) { s.ammo = {}; s.magLeft = 0; }
      a.grenadesLeft = 2;
      forceAssault(sim, a.teamId, 12.5, 10.5);
      for (let i = 0; i < 200; i++) sim.step();
      return sim;
    };
    const a = run();
    expect(a.snapshot()).toBe(run().snapshot());
    expect(a.breachLog.length).toBeGreaterThan(0); // the gates really went in
    expect(JSON.parse(a.snapshot()).breaches).toHaveLength(a.breachLog.length);
  });
});
