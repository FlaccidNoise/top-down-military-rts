import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { dangerScore, visibleEnemies } from '../src/sim/orders';
import { Sim, sightBetween, sightToSoldier } from '../src/sim/sim';

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
    sim.squadLastCasualty[0] = sim.tick; // recent squad casualty flat contribution
    sim.orderTeam(0, { kind: 'move', x: 50, y: 10 });
    const st = sim.teams[0].orderState;
    expect(st.phase).toBe('balked');
    expect(st.reason.length).toBeGreaterThan(0);
    expect(sim.soldiers.slice(0, 2).every((s) => s.path === null)).toBe(true); // holds in place
  });

  it('a cautious verdict downgrades fast to move', () => {
    const sim = new Sim(new GameMap(80, 20), 4);
    // A veteran, well-led, high-morale team (raises the compliance threshold
    // per the plan's formula) so a fully-covered 20m path lands in the
    // cautious band instead of comply or balk.
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 10.5, y: 10.5, xp: 30 },
      { name: 'B', weapon: 'garand', x: 10.5, y: 11.5, xp: 30 },
    ]);
    sim.soldiers[0].role = 'leader';
    for (const s of sim.soldiers) s.morale = 1;
    sim.addSquad('red', 'r', [{ name: 'R1', weapon: 'mg42', x: 30.5, y: 10.5 }]); // covers the whole path, well within its 150m range
    sim.orderTeam(0, { kind: 'fast', x: 50, y: 10 });
    const st = sim.teams[0].orderState;
    expect(st.phase).not.toBe('balked');
    expect(st.order?.kind).toBe('move');
    expect(st.reason).toBe('moving cautiously');
  });

  it('a sneaking team does not acquire or fire on a visible enemy', () => {
    const sim = new Sim(new GameMap(120, 20), 5);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 10.5, y: 11.5 },
    ]);
    // 90m out with a short-range weapon (mp40, 50m): can't reach blue at all
    // (its own acquire range excludes them) and doesn't "cover" the short
    // sneak path either (dangerScore uses the enemy's own weapon range), so
    // this stays comply — but the enemy sits well within the blue soldiers'
    // own garand range (100m), so acquire() would normally find it were it
    // not held by the sneak gate.
    sim.addSquad('red', 'r', [{ name: 'R1', weapon: 'mp40', x: 100.5, y: 10.5 }]);
    sim.orderTeam(0, { kind: 'sneak', x: 15, y: 10 });
    expect(sim.teams[0].orderState.phase).not.toBe('balked');
    for (let i = 0; i < 90; i++) sim.step();
    expect(sim.soldiers[0].targetId).toBe(-1);
    expect(sim.soldiers[1].targetId).toBe(-1);
    expect(sim.takeEvents().length).toBe(0);
  });

  it('a sneaking team behind a hedgerow is unseen beyond 20m, spotted inside it', () => {
    const m = new GameMap(80, 20);
    for (let y = 0; y < 20; y++) m.setTerrain(30, y, 'hedge');
    const sim = new Sim(m, 9);
    sim.addSquad('blue', 'sneaker', [{ name: 'A', weapon: 'garand', x: 32.5, y: 10.5 }]);
    sim.addSquad('blue', 'walker', [{ name: 'B', weapon: 'garand', x: 32.5, y: 12.5 }]);
    sim.addSquad('red', 'mg', [{ name: 'R1', weapon: 'mg42', x: 5.5, y: 10.5 }]);
    sim.orderTeam(0, { kind: 'sneak', x: 50, y: 10 });
    expect(sim.teams[0].orderState.order?.kind).toBe('sneak'); // guard: order not downgraded/balked

    const [sneaker, walker, mg] = [sim.soldiers[0], sim.soldiers[1], sim.soldiers[2]];
    // 27m through one hedge (conceal 0.5): the sneaker is unseen, the orderless control isn't
    expect(sightToSoldier(sim, mg.x, mg.y, sneaker).visible).toBe(false);
    expect(sightToSoldier(sim, mg.x, mg.y, walker).visible).toBe(true);
    const seen = visibleEnemies(sim, 'red');
    expect(seen).not.toContain(sneaker);
    expect(seen).toContain(walker);
    // the preview says why, not just that
    const p = sim.shotPreview(mg.x, mg.y, 'mg42', sneaker, false, 1);
    expect(p.visible).toBe(false);
    expect(p.concealed).toBe(true);
    // inside 20m the same concealment no longer hides him
    expect(sightToSoldier(sim, 28.5, 10.5, sneaker).visible).toBe(true);
  });

  it('a sneaking mover is hit as accurately as a stationary target (negates the mover discount)', () => {
    const sim = new Sim(new GameMap(40, 10), 8);
    sim.addSquad('blue', 'shooter', [{ name: 'S', weapon: 'garand', x: 5.5, y: 5.5 }]);
    sim.addSquad('red', 'stationary', [{ name: 'T1', weapon: 'kar98k', x: 25.5, y: 5.5 }]);
    sim.addSquad('red', 'mover', [{ name: 'T2', weapon: 'kar98k', x: 25.5, y: 5.5 }]);
    sim.addSquad('red', 'sneaker', [{ name: 'T3', weapon: 'kar98k', x: 25.5, y: 5.5 }]);
    const shooter = sim.soldiers[0];
    const [stationary, mover, sneaker] = [sim.soldiers[1], sim.soldiers[2], sim.soldiers[3]];
    mover.path = [{ x: 26, y: 5.5 }]; // "moving" for accuracy purposes, no sneak order
    sneaker.path = [{ x: 26, y: 5.5 }];
    sim.orderTeam(sneaker.teamId, { kind: 'sneak', x: 26, y: 5.5 });

    const accStationary = sim.shotPreview(shooter.x, shooter.y, 'garand', stationary, false, 1).acc;
    const accMover = sim.shotPreview(shooter.x, shooter.y, 'garand', mover, false, 1).acc;
    const accSneaker = sim.shotPreview(shooter.x, shooter.y, 'garand', sneaker, false, 1).acc;

    expect(accMover).toBeCloseTo(accStationary * 0.75, 10); // ordinary movers keep the discount
    expect(accSneaker).toBeCloseTo(accStationary, 10); // sneaking movers don't
  });

  it('a bounding team that balks mid-route holds cleanly instead of oscillating (refusal deadlock)', () => {
    const sim = new Sim(new GameMap(80, 20), 6);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 10.5, y: 11.5 },
      { name: 'C', weapon: 'garand', x: 10.5, y: 12.5 },
      { name: 'D', weapon: 'garand', x: 10.5, y: 13.5 },
    ]);
    for (const s of sim.soldiers) s.morale = 0.5; // no leader, modest morale: a reachable balk threshold
    sim.soldiers[0].suppression = 0.5; // under fire at issuance -> bounds immediately
    sim.orderTeam(0, { kind: 'move', x: 50, y: 11.5 }); // 40m: needs multiple 15m legs
    expect(sim.teams[0].orderState.phase).toBe('bounding_a');

    // The threat develops mid-route, after the order was issued (so the
    // initial dispatch complied, and only the leg-alternation recheck balks).
    sim.addSquad('red', 'mg', [
      { name: 'M1', weapon: 'mg42', x: 40.5, y: 11.5 },
      { name: 'M2', weapon: 'kar98k', x: 40.5, y: 10.5 },
      { name: 'M3', weapon: 'kar98k', x: 40.5, y: 12.5 },
      { name: 'M4', weapon: 'kar98k', x: 40.5, y: 9.5 },
    ]);

    let sawBalk = false;
    const phasesAfterBalk: string[] = [];
    for (let i = 0; i < 3000; i++) {
      sim.step();
      const phase = sim.teams[0].orderState.phase;
      if (phase === 'balked') sawBalk = true;
      if (sawBalk) phasesAfterBalk.push(phase);
    }
    expect(sawBalk).toBe(true);
    expect(phasesAfterBalk.every((p) => p === 'balked')).toBe(true); // latches — no oscillation back to bounding
    expect(sim.teams[0].orderState.reason.length).toBeGreaterThan(0);
  });
});

describe('dangerScore: squad-scoped recent casualty', () => {
  it("a sister team's recent casualty raises this team's danger by exactly the flat term", () => {
    const sim = new Sim(new GameMap(40, 20), 20);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 10, 10);
    const able = sim.teams[squad.teamIds[0]];
    const dest = { x: 30, y: 10 };
    const before = dangerScore(sim, able, dest);
    sim.squadLastCasualty[squad.id] = sim.tick; // e.g. Baker (the sister team) just took a hit
    const after = dangerScore(sim, able, dest);
    expect(after).toBeCloseTo(before + 0.2, 10);
  });

  it("a same-team casualty timestamp alone (teamLastCasualty) does not affect dangerScore", () => {
    const sim = new Sim(new GameMap(40, 20), 21);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 10, 10);
    const able = sim.teams[squad.teamIds[0]];
    const dest = { x: 30, y: 10 };
    const before = dangerScore(sim, able, dest);
    sim.teamLastCasualty[able.id] = sim.tick; // ambush-trigger clock only, not dangerScore's
    const after = dangerScore(sim, able, dest);
    expect(after).toBeCloseTo(before, 10);
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
    // Veteran/led/high-morale (raises the compliance threshold) so holding
    // an ambush position already "covered" by a known kar98k at 70m or 40m
    // (both well within its 110m range) doesn't balk before the trigger can
    // even be evaluated.
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 10.5, y: 10.5, xp: 30 }]);
    sim.soldiers[0].role = 'leader';
    sim.soldiers[0].morale = 1;
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 80.5, y: 10.5, ammo: {} }]); // 70m out, dry
    sim.soldiers[1].magLeft = 0; // won't take a shot at blue and cause an incidental casualty trigger
    const enemy = sim.soldiers[1];
    sim.orderTeam(0, { kind: 'ambush', x: 10.5, y: 10.5 });
    expect(sim.teams[0].orderState.phase).not.toBe('balked');
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
