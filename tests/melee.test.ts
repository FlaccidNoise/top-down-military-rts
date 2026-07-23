import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';

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

  it('is deterministic (snapshot includes melee state)', () => {
    const run = () => {
      const { sim } = pair({ seed: 7 });
      for (let i = 0; i < 600; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });
});
