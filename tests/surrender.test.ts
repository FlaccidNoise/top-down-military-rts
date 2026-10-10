import { describe, expect, it, vi } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim, type UnitEvent } from '../src/sim/sim';

// Open ground; soldiers get zeroed ammo unless a test needs live rounds.
const flat = () => new GameMap(20, 10);

function stepUntil(sim: Sim, cond: () => boolean, maxTicks = 600, events?: UnitEvent[]): boolean {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (events) events.push(...sim.takeUnitEvents());
    if (cond()) return true;
  }
  return cond();
}

describe('surrender', () => {
  it('attacker locks an already-broken man with a second enemy within 2m → captured', () => {
    const sim = new Sim(flat(), 42);
    const a1Id = sim.addSquad('blue', 'A1', [{ name: 'A1', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const a2Id = sim.addSquad('blue', 'A2', [{ name: 'A2', weapon: 'garand', x: 6.0, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 6.5, y: 5.5 }]).soldierIds[0];
    const a1 = sim.soldiers[a1Id];
    const a2 = sim.soldiers[a2Id];
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) { s.ammo = {}; s.magLeft = 0; }
    // Break b's morale before any melee lock
    b.morale = 0;
    const events: UnitEvent[] = [];
    // Step until psych update marks b as broken
    expect(stepUntil(sim, () => b.mental === 'broken', 300, events)).toBe(true);
    // b should be captured: 2 blue enemies (a1, a2) within MELEE_ENGAGE (2m)
    expect(b.captured).toBe(true);
    expect(b.alive).toBe(true);
    expect(b.mental).toBe('broken');
    // force-spotted both sides (captor is nearest enemy — a2 at 6.0 is closer than a1 at 5.5)
    expect(sim.spotted['red'].has(a2.id)).toBe(true);
    expect(sim.spotted['blue'].has(b.id)).toBe(true);
    // surrendered UnitEvent emitted
    expect(events.some((e) => e.kind === 'surrendered' && e.side === 'red')).toBe(true);
  });

  it('only ONE enemy within 2m → NOT captured, flees, pursuit behavior unchanged', () => {
    const sim = new Sim(flat(), 42);
    const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 6.5, y: 5.5 }]).soldierIds[0];
    const a = sim.soldiers[aId];
    const b = sim.soldiers[bId];
    for (const s of [a, b]) { s.ammo = {}; s.magLeft = 0; }
    b.morale = 0;
    // Step until b breaks
    expect(stepUntil(sim, () => b.mental === 'broken', 300)).toBe(true);
    // Only 1 enemy within 2m → NOT captured
    expect(b.captured).toBe(false);
    // b should flee (has a path or is fleeing)
    expect(b.fleeing || b.path !== null || b.meleeId === -1).toBe(true);
  });

  it('man breaks mid-lock with ≥2 enemies in reach → captured instead of fleeing', () => {
    const sim = new Sim(flat(), 42);
    const a1Id = sim.addSquad('blue', 'A1', [{ name: 'A1', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const a2Id = sim.addSquad('blue', 'A2', [{ name: 'A2', weapon: 'garand', x: 6.0, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 5.8, y: 5.5 }]).soldierIds[0];
    const a1 = sim.soldiers[a1Id];
    const a2 = sim.soldiers[a2Id];
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) { s.ammo = {}; s.magLeft = 0; }
    const events: UnitEvent[] = [];
    // Step until melee lock between a1 and b
    expect(stepUntil(sim, () => a1.meleeId === b.id || b.meleeId === a1.id, 300, events)).toBe(true);
    // Break b's morale mid-lock
    b.morale = 0;
    // Step until psych update processes the break
    expect(stepUntil(sim, () => b.mental === 'broken', 300, events)).toBe(true);
    // With ≥2 enemies within 2m, b should be captured
    expect(b.captured).toBe(true);
    expect(b.alive).toBe(true);
    expect(b.mental).toBe('broken');
    // Check the surrendered event was emitted
    expect(events.some((e) => e.kind === 'surrendered')).toBe(true);
  });

  it('captured excluded from strength count but alive (not KIA)', () => {
    const sim = new Sim(flat(), 42);
    const a1Id = sim.addSquad('blue', 'A1', [{ name: 'A1', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const a2Id = sim.addSquad('blue', 'A2', [{ name: 'A2', weapon: 'garand', x: 6.0, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 5.8, y: 5.5 }]).soldierIds[0];
    const a1 = sim.soldiers[a1Id];
    const a2 = sim.soldiers[a2Id];
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) { s.ammo = {}; s.magLeft = 0; }
    const events: UnitEvent[] = [];
    expect(stepUntil(sim, () => a1.meleeId === b.id || b.meleeId === a1.id, 300, events)).toBe(true);
    b.morale = 0;
    expect(stepUntil(sim, () => b.captured, 300, events)).toBe(true);
    // b is alive but captured
    expect(b.alive).toBe(true);
    expect(b.captured).toBe(true);
    // Force-spotted both sides
    expect(sim.spotted['red'].has(a1.id)).toBe(true);
    expect(sim.spotted['blue'].has(b.id)).toBe(true);
    // surrendered event, not KIA
    expect(events.some((e) => e.kind === 'surrendered')).toBe(true);
    expect(events.some((e) => e.kind === 'kia' && e.name === 'B')).toBe(false);
  });
});

// #790. A broken man ran 30 m straight away from the nearest enemy on the
// map, leg after leg, and gave up only with two bayonets inside 2 m of him.
// Red's rear is east here (sim.threatAxis: it expects its enemy from the west).
describe('rout and isolated surrender (#790)', () => {
  // One German at (30.5,15.5), kept broken; nobody on the field has a round.
  const stage = (blue: { x: number; y: number }[], mates: { x: number; y: number; leader?: boolean }[] = [], map = new GameMap(80, 30)) => {
    const sim = new Sim(map, 7);
    const squad = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 30.5, y: 15.5 }, ...mates.map((m, i) => ({ name: `M${i}`, weapon: 'kar98k' as const, x: m.x, y: m.y }))]);
    mates.forEach((m, i) => {
      if (m.leader) sim.soldiers[squad.soldierIds[i + 1]].role = 'leader';
    });
    blue.forEach((p, i) => sim.addSquad('blue', `A${i}`, [{ name: `A${i}`, weapon: 'garand', x: p.x, y: p.y }]));
    for (const m of sim.soldiers) {
      m.ammo = {};
      m.magLeft = 0;
    }
    const b = sim.soldiers[squad.soldierIds[0]];
    const events: UnitEvent[] = [];
    const run = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        b.morale = 0;
        sim.step();
        events.push(...sim.takeUnitEvents());
      }
    };
    return { sim, b, run, events, mates: squad.soldierIds.slice(1).map((id) => sim.soldiers[id]) };
  };

  it('he runs for his own rear, not straight away from the nearest enemy', () => {
    const { b, run } = stage([{ x: 30.5, y: 5.5 }]); // one American 10 m north: the old run went south
    run(60);
    expect(b.mental).toBe('broken');
    expect(b.fleeing).toBe(true);
    const end = b.path![b.path!.length - 1];
    expect(end.x).toBeGreaterThan(30.5 + 25); // 30 m east
    expect(Math.abs(end.y - 15.5)).toBeLessThan(3);
  });

  it('with the enemy he knows of between him and his rear, he runs from that enemy instead', () => {
    const { sim, b, run } = stage([{ x: 50.5, y: 15.5 }]); // 20 m east of him: on his own rear
    run(100); // he breaks before the first spotting sweep, and looks again 3 s on
    expect(sim.spotted.red.size).toBe(1);
    expect(b.path![b.path!.length - 1].x).toBeLessThan(30.5 - 15);
  });

  it('he runs to the nearest leader behind him and stops there; a leader forward of him is no place to run', () => {
    const behind = stage([{ x: 30.5, y: 5.5 }], [{ x: 48.5, y: 20.5, leader: true }, { x: 20.5, y: 15.5, leader: true }]);
    behind.run(600);
    const [rear] = behind.mates;
    const gap = Math.hypot(behind.b.x - rear.x, behind.b.y - rear.y);
    expect(gap).toBeLessThan(6); // ROUT_GATHER
    expect(gap).toBeGreaterThan(1.5); // beside his leader, not on top of him
    expect(behind.b.mental).toBe('broken');
    expect(behind.b.fleeing).toBe(false); // gathered: he is not running any more
    const at = { x: behind.b.x, y: behind.b.y };
    behind.run(300);
    expect(behind.b.x).toBe(at.x);
    expect(behind.b.y).toBe(at.y);

    const forward = stage([{ x: 30.5, y: 5.5 }], [{ x: 20.5, y: 15.5, leader: true }]);
    forward.run(60);
    expect(forward.b.path![forward.b.path!.length - 1].x).toBeGreaterThan(30.5 + 25);
  });

  it('the run is solved when he breaks and every 3 s after, and draws no rng', () => {
    const { sim, b, run } = stage([{ x: 30.5, y: 5.5 }]);
    const flee = vi.spyOn(sim as never as { flee(s: unknown): void }, 'flee');
    run(300);
    expect(b.mental).toBe('broken');
    expect(flee.mock.calls.length).toBeGreaterThan(0);
    expect(flee.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(300 / 90));
    const next = vi.spyOn(sim.rng, 'next');
    (sim as never as { flee(s: unknown): void }).flee(b);
    expect(next).not.toHaveBeenCalled();
  });

  const three = [{ x: 40.5, y: 15.5 }, { x: 40.5, y: 18.5 }, { x: 40.5, y: 12.5 }]; // 10 m off: nowhere near a bayonet
  it('out of ammunition with three of them inside 15 m, he gives up without being touched', () => {
    const { b, run, events } = stage(three);
    run(60);
    expect(b.captured).toBe(true);
    expect(b.alive).toBe(true);
    expect(events.filter((e) => e.kind === 'surrendered').map((e) => e.id)).toEqual([b.id]);
  });

  it('two are not enough, and neither are three he is hidden from', () => {
    const two = stage(three.slice(0, 2));
    two.run(120);
    expect(two.b.captured).toBe(false);
    expect(two.b.fleeing).toBe(true);

    const walled = new GameMap(80, 30);
    for (let y = 0; y < 30; y++) walled.setVEdge(36, y, EDGE.WALL);
    const hidden = stage(three, [], walled);
    hidden.run(120);
    expect(hidden.b.captured).toBe(false);
  });

  it('a man with rounds left and his leader standing runs; with the leader down he gives up', () => {
    const led = stage(three, [{ x: 20.5, y: 15.5, leader: true }]);
    led.b.magLeft = 5;
    led.run(60);
    expect(led.b.captured).toBe(false);

    const leaderless = stage(three, [{ x: 20.5, y: 15.5, leader: true }]);
    leaderless.b.magLeft = 5;
    leaderless.mates[0].downed = true;
    leaderless.run(60);
    expect(leaderless.b.captured).toBe(true);
  });
});
