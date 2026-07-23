import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';

// Open ground; soldiers get zeroed ammo unless a test needs live rounds.
const flat = () => new GameMap(30, 20);

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
    let booms: { x: number; y: number }[] = [];
    expect(stepUntil(sim, () => { booms = booms.concat(sim.takeBooms()); return booms.length > 0; }, 60)).toBe(true);
  });

  it('determinism: two same-seed runs produce identical snapshots with a grenade thrown', () => {
    const run = () => {
      const m = flat();
      const sim = new Sim(m, 42);
      const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]).soldierIds[0];
      const b1Id = sim.addSquad('red', 'B1', [{ name: 'B1', weapon: 'kar98k', x: 12.5, y: 10.5 }]).soldierIds[0];
      const b2Id = sim.addSquad('red', 'B2', [{ name: 'B2', weapon: 'kar98k', x: 13.5, y: 10.5 }]).soldierIds[0];
      const a = sim.soldiers[aId];
      for (const s of [a, sim.soldiers[b1Id], sim.soldiers[b2Id]]) { s.ammo = {}; s.magLeft = 0; }
      a.grenadesLeft = 2;
      forceAssault(sim, a.teamId, 12.5, 10.5);
      for (let i = 0; i < 200; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });
});
