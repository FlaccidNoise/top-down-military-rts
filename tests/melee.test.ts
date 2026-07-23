import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim, sightToSoldier } from '../src/sim/sim';

// Open ground; soldiers get zeroed ammo unless a test needs live rounds, so
// melee is the only combat channel (and the RNG sequence stays melee-only).
const flat = () => new GameMap(20, 10);

function pair(opts: { weaponA?: 'garand' | 'thompson' | 'mg42'; weaponB?: 'garand' | 'kar98k'; dist?: number; map?: GameMap; seed?: number } = {}) {
  const sim = new Sim(opts.map ?? flat(), opts.seed ?? 42);
  const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: opts.weaponA ?? 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
  const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: opts.weaponB ?? 'kar98k', x: 5.5 + (opts.dist ?? 1.2), y: 5.5 }]).soldierIds[0];
  const a = sim.soldiers[aId];
  const b = sim.soldiers[bId];
  for (const s of [a, b]) {
    s.ammo = {};
    s.magLeft = 0;
  }
  return { sim, a, b };
}

function stepUntil(sim: Sim, cond: () => boolean, maxTicks = 300): boolean {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (cond()) return true;
  }
  return cond();
}

describe('melee', () => {
  it('adjacent enemies lock into melee, drop paths and ranged targets', () => {
    const { sim, a, b } = pair();
    expect(stepUntil(sim, () => a.meleeId === b.id && b.meleeId === a.id)).toBe(true);
    expect(a.path).toBeNull();
    expect(a.targetId).toBe(-1);
  });

  it('strikes wound through the body model without spending ammo', () => {
    const { sim, a, b } = pair();
    expect(stepUntil(sim, () => a.wounds.length + b.wounds.length > 0 || !a.alive || !b.alive, 1200)).toBe(true);
    expect(a.magLeft).toBe(0); // bayonets are free
    expect(b.magLeft).toBe(0);
  });

  it('a fight resolves: someone dies or goes down inside a minute', () => {
    const { sim, a, b } = pair();
    expect(stepUntil(sim, () => !a.alive || !b.alive || a.downed || b.downed, 1800)).toBe(true);
  });

  it('no melee through a wall, window, or unreachable edge', () => {
    for (const edge of [EDGE.WALL, EDGE.WINDOW] as const) {
      const m = flat();
      for (let y = 0; y < 10; y++) m.setVEdge(6, y, edge);
      const { sim, a, b } = pair({ map: m, dist: 1.4 }); // 5.5 and 6.9 straddle the x=6 edge
      for (let i = 0; i < 120; i++) sim.step();
      expect(a.meleeId).toBe(-1);
      expect(b.meleeId).toBe(-1);
    }
  });

  it('melee starts through a door (room clearing)', () => {
    const m = flat();
    for (let y = 0; y < 10; y++) m.setVEdge(6, y, y === 5 ? EDGE.DOOR : EDGE.WALL);
    const { sim, a, b } = pair({ map: m, dist: 1.4 });
    expect(stepUntil(sim, () => a.meleeId === b.id)).toBe(true);
  });

  it('an SMG fights melee by firing point-blank, spending rounds', () => {
    const { sim, a, b } = pair({ weaponA: 'thompson' });
    a.magLeft = 30;
    a.cooldown = 999; // block ranged fire so any spent round is a melee hip-shot
    expect(stepUntil(sim, () => a.meleeId === b.id)).toBe(true);
    const before = a.magLeft;
    expect(stepUntil(sim, () => a.magLeft < before || !b.alive || b.downed, 300)).toBe(true);
  });

  it('breaking is the way out: a broken man leaves the lock and flees', () => {
    const { sim, a, b } = pair();
    expect(stepUntil(sim, () => b.meleeId === a.id)).toBe(true);
    b.morale = 0;
    sim.step();
    expect(b.mental).toBe('broken');
    expect(b.meleeId).toBe(-1);
    expect(a.meleeId).toBe(b.id); // the winner runs him down
  });

  it('move orders cannot pull a man out of melee', () => {
    const { sim, a, b } = pair();
    expect(stepUntil(sim, () => a.meleeId === b.id)).toBe(true);
    sim.orderMove(a.teamId, 17, 5);
    for (let i = 0; i < 150; i++) sim.step();
    if (a.alive && !a.downed && a.meleeId === b.id) {
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1.4);
      expect(a.x).toBeLessThan(8);
    }
  });

  it('N-vs-1: two attackers pile onto one victim, who fights back at the first', () => {
    const sim = new Sim(flat(), 42);
    const squad = sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'garand', x: 5.5, y: 5.0 },
      { name: 'A2', weapon: 'garand', x: 5.5, y: 6.0 },
    ]);
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 6.6, y: 5.5 }]).soldierIds[0];
    const [a1, a2] = squad.soldierIds.map((id) => sim.soldiers[id]);
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) {
      s.ammo = {};
      s.magLeft = 0;
    }
    expect(stepUntil(sim, () => a1.meleeId === b.id && a2.meleeId === b.id)).toBe(true);
    expect([a1.id, a2.id]).toContain(b.meleeId); // victim fights exactly one of them
  });

  it('is deterministic (snapshot includes melee state)', () => {
    const run = () => {
      const { sim } = pair({ seed: 7 });
      for (let i = 0; i < 600; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });
});

// The melee × FoW seam: contact is a sense. The lock ignores smoke and
// concealment, but pays for it with honest intel — both fighters are spotted
// for both sides while steel is out, and a melee kill is a found corpse.
describe('melee × fog of war', () => {
  // two puffs on the ray = accumulated opacity 1.0: LOS fully blocked at any range
  const smokeAt = (sim: Sim, x: number, y: number) => {
    sim.smoke.push({ x, y, ttl: 9999 }, { x, y, ttl: 9999 });
  };

  it('smoke does not stop a melee lock, and contact spots both fighters for both sides', () => {
    const { sim, a, b } = pair();
    smokeAt(sim, (a.x + b.x) / 2, a.y);
    expect(sightToSoldier(sim, a.x, a.y, b).visible).toBe(false); // staging guard: smoke really blinds them
    expect(stepUntil(sim, () => a.meleeId === b.id && b.meleeId === a.id)).toBe(true);
    expect(sim.soldierVisibleTo('blue', b)).toBe(true); // bumped into: intel, not raycast
    expect(sim.soldierVisibleTo('red', a)).toBe(true);
  });

  it('the spot holds across sweeps while the fight lasts; a melee kill is a found corpse', () => {
    const { sim, a, b } = pair();
    smokeAt(sim, (a.x + b.x) / 2, a.y);
    expect(stepUntil(sim, () => a.meleeId === b.id)).toBe(true);
    for (let i = 0; i < 31; i++) sim.step(); // two full sweeps: raycasts fail in smoke, contact must not ghost
    expect(sim.soldierVisibleTo('blue', b)).toBe(true);
    expect(sim.soldierVisibleTo('red', a)).toBe(true);
    let kill: { attackerId: number; victimId: number } | undefined;
    for (let i = 0; i < 3600 && !kill; i++) {
      sim.step();
      kill = sim.takeMeleeEvents().find((e) => e.kill);
    }
    expect(kill).toBeDefined(); // this seed's fight ends in a kill, not a bleed-out
    const victim = sim.soldiers[kill!.victimId];
    const killer = sim.soldiers[kill!.attackerId];
    expect(victim.alive).toBe(false);
    expect(sim.soldierVisibleTo(killer.side, victim)).toBe(true); // corpse found at arm's length, despite the smoke
  });

  it('melee events always pair opposite sides — the invariant that makes the renderer FX gate a safe no-op', () => {
    // soldierVisibleTo is unconditionally true for own-side men, so the FX
    // gate in addMeleeEvents can only bite if a melee ever pairs two
    // non-player sides. Pin the pairing invariant: if this fails, the gate
    // just became load-bearing and needs real tests.
    const { sim, a, b } = pair();
    let events = 0;
    for (let i = 0; i < 1800 && a.alive && b.alive && !a.downed && !b.downed; i++) {
      sim.step();
      for (const e of sim.takeMeleeEvents()) {
        events++;
        expect(sim.soldiers[e.attackerId].side).not.toBe(sim.soldiers[e.victimId].side);
      }
    }
    expect(events).toBeGreaterThan(0);
  });

  it('a sneaking man hidden even from the sweep is revealed by melee contact; his team order survives', () => {
    const { sim, a, b } = pair({ dist: 4 }); // beyond the 2m lock range
    sim.orderTeam(b.teamId, { kind: 'sneak', x: b.x, y: b.y }); // sneak in place
    smokeAt(sim, a.x + 1, a.y);
    smokeAt(sim, b.x - 1, b.y);
    for (let i = 0; i < 15; i++) sim.step(); // a full sweep passes...
    expect(sim.soldierVisibleTo('blue', b)).toBe(false); // ...and the sneak+smoke stack holds
    b.x = a.x + 1.3; // staged: he creeps onto the blue man's position between sweeps
    expect(stepUntil(sim, () => a.meleeId === b.id || b.meleeId === a.id)).toBe(true);
    expect(sim.soldierVisibleTo('blue', b)).toBe(true); // contact breaks the sneak
    expect(sim.teams[b.teamId].orderState.order?.kind).toBe('sneak'); // one man's bad luck doesn't blow the team's order
  });
});
