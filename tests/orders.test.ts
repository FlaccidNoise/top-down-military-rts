import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim, sightBetween } from '../src/sim/sim';

describe('order vocabulary: move/fast/sneak executor', () => {
  it('a steady team in a quiet map complies and paths directly (no bounding)', () => {
    const sim = new Sim(new GameMap(60, 20), 1);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 5.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 5.5, y: 11.5 },
      { name: 'C', weapon: 'garand', x: 5.5, y: 12.5 },
    ]);
    sim.orderTeam(0, { kind: 'move', x: 50, y: 10 });
    const st = sim.teams[0].orderState;
    expect(st.phase).toBe('executing');
    expect(st.reason).toBe('');
    expect(sim.soldiers.some((s) => s.path !== null)).toBe(true);
    for (let i = 0; i < 60; i++) {
      sim.step();
      expect(sim.teams[0].orderState.phase).not.toMatch(/bounding/);
    }
  });

  it('bounds (splits into two elements) the instant the team is under effective fire', () => {
    const sim = new Sim(new GameMap(60, 20), 2);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 5.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 5.5, y: 11.5 },
      { name: 'C', weapon: 'garand', x: 5.5, y: 12.5 },
      { name: 'D', weapon: 'garand', x: 5.5, y: 13.5 },
    ]);
    sim.soldiers[0].suppression = 0.5; // > 0.35: "under effective fire"
    sim.orderTeam(0, { kind: 'move', x: 50, y: 10 });
    expect(sim.teams[0].orderState.phase).toBe('bounding_a');
    // one element rushes, the other holds (no path)
    const moving = sim.soldiers.filter((s) => s.path !== null).length;
    expect(moving).toBeGreaterThan(0);
    expect(moving).toBeLessThan(sim.soldiers.length);
  });

  it('balks with a nonempty reason when ordered across open ground covered by enemy MG/rifle fire', () => {
    const sim = new Sim(new GameMap(80, 20), 3);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'thompson', x: 10.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 10.5, y: 11.5 },
    ]);
    for (const s of sim.soldiers) s.morale = 0.5; // no leader, modest morale -> a reachable threshold
    sim.addSquad('red', 'mg', [
      { name: 'M1', weapon: 'mg42', x: 40.5, y: 10.5 },
      { name: 'M2', weapon: 'kar98k', x: 40.5, y: 11.5 },
      { name: 'M3', weapon: 'kar98k', x: 40.5, y: 12.5 },
      { name: 'M4', weapon: 'kar98k', x: 40.5, y: 9.5 },
      { name: 'M5', weapon: 'kar98k', x: 40.5, y: 8.5 },
    ]);
    sim.teamLastCasualty[0] = sim.tick; // recent squad casualty flat contribution
    sim.orderTeam(0, { kind: 'move', x: 50, y: 10 });
    const st = sim.teams[0].orderState;
    expect(st.phase).toBe('balked');
    expect(st.reason.length).toBeGreaterThan(0);
    expect(sim.soldiers.slice(0, 2).every((s) => s.path === null)).toBe(true); // holds in place
  });

  it('a cautious verdict downgrades fast to move', () => {
    const sim = new Sim(new GameMap(80, 20), 4);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 10.5, y: 11.5 },
    ]);
    for (const s of sim.soldiers) s.morale = 0.4; // no leader, lower morale -> lower threshold
    sim.addSquad('red', 'r', [
      { name: 'R1', weapon: 'kar98k', x: 25.5, y: 10.5 },
      { name: 'R2', weapon: 'kar98k', x: 25.5, y: 11.5 },
      { name: 'R3', weapon: 'kar98k', x: 25.5, y: 9.5 },
    ]);
    sim.teamLastCasualty[0] = sim.tick;
    sim.orderTeam(0, { kind: 'fast', x: 50, y: 10 });
    const st = sim.teams[0].orderState;
    expect(st.phase).not.toBe('balked');
    expect(st.order?.kind).toBe('move');
    expect(st.reason).toBe('moving cautiously');
  });

  it('a sneaking team does not acquire or fire on a visible enemy', () => {
    const sim = new Sim(new GameMap(60, 20), 5);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 10.5, y: 11.5 },
    ]);
    sim.addSquad('red', 'r', [{ name: 'R1', weapon: 'kar98k', x: 20.5, y: 10.5, ammo: {} }]);
    sim.soldiers[2].magLeft = 0; // enemy is dry: can't fire back and mask the assertion
    sim.orderTeam(0, { kind: 'sneak', x: 15, y: 10 });
    expect(sim.teams[0].orderState.phase).not.toBe('balked');
    for (let i = 0; i < 90; i++) sim.step();
    expect(sim.soldiers[0].targetId).toBe(-1);
    expect(sim.soldiers[1].targetId).toBe(-1);
    expect(sim.takeEvents().length).toBe(0);
  });
});

describe('order vocabulary: fire/smoke/defend/ambush', () => {
  it('an MG on a fire order suppresses a point with no visible target (area fire)', () => {
    const m = new GameMap(30, 10);
    for (let y = 0; y < 10; y++) m.setVEdge(15, y, EDGE.WALL); // blocks the gunner's own LOS/acquire
    const sim = new Sim(m, 10);
    sim.addSquad('blue', 'gun', [{ name: 'G', weapon: 'mg42', x: 5.5, y: 5.5 }]);
    sim.addSquad('red', 'e', [{ name: 'E', weapon: 'kar98k', x: 22.5, y: 5.5 }]);
    const target = sim.soldiers[1];
    expect(sightBetween(sim, sim.soldiers[0].x, sim.soldiers[0].y, target.x, target.y).visible).toBe(false);
    sim.orderTeam(0, { kind: 'fire', x: target.x, y: target.y });
    const startAmmo = Object.values(sim.soldiers[0].ammo).reduce((a: number, n) => a + (n ?? 0), 0);
    for (let i = 0; i < 90; i++) sim.step();
    expect(target.suppression).toBeGreaterThan(0);
    expect(sim.soldiers[0].targetId).toBe(-1); // never had a visible target to aim at
    const endAmmo = Object.values(sim.soldiers[0].ammo).reduce((a: number, n) => a + (n ?? 0), 0);
    expect(endAmmo).toBeLessThanOrEqual(startAmmo); // area fire still burns ammo
  });

  it('smoke blocks a previously clear line of sight', () => {
    const sim = new Sim(new GameMap(40, 10), 11);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 5.5 }]);
    expect(sightBetween(sim, 5.5, 5.5, 25.5, 5.5).visible).toBe(true);
    sim.orderTeam(0, { kind: 'smoke', x: 15, y: 5.5 });
    expect(sim.smoke.length).toBe(2);
    expect(sightBetween(sim, 5.5, 5.5, 25.5, 5.5).visible).toBe(false);
  });

  it('defend arc ignores a flanking target until the arc is updated to cover it', () => {
    const sim = new Sim(new GameMap(30, 20), 12);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 10.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 5.5, y: 10.5, ammo: {} }]); // due west: angle pi
    sim.soldiers[1].magLeft = 0; // dry: won't shoot blue and confound the arc assertion
    sim.orderTeam(0, { kind: 'defend', x: 10.5, y: 10.5, arc: [0, Math.PI / 2] });
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.soldiers[0].targetId).toBe(-1);
    sim.orderTeam(0, { kind: 'defend', x: 10.5, y: 10.5, arc: [Math.PI - 0.3, Math.PI + 0.3] });
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.soldiers[0].targetId).toBe(1);
  });

  it('ambush holds fire at 70m and opens (with the first-volley bonus) once the enemy closes to 40m', () => {
    const sim = new Sim(new GameMap(120, 20), 13);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 10.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 80.5, y: 10.5, ammo: {} }]); // 70m out, dry
    sim.soldiers[1].magLeft = 0; // won't take a shot at blue and cause an incidental casualty trigger
    const enemy = sim.soldiers[1];
    sim.orderTeam(0, { kind: 'ambush', x: 10.5, y: 10.5 });
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.teams[0].orderState.order?.kind).toBe('ambush');
    expect(sim.soldiers[0].targetId).toBe(-1);
    expect(sim.takeEvents().length).toBe(0);

    enemy.x = 50.5; // 40m out: at the rifleman-class ambush threshold
    sim.step();
    expect(sim.teams[0].orderState.order?.kind).toBe('defend'); // ambush converts to defend on trigger
    expect(sim.teams[0].ambushBonusTick).toBe(sim.tick);
    expect(sim.takeEvents().length).toBeGreaterThan(0); // trigger fires immediately
  });
});
