import { describe, expect, it } from 'vitest';
import { TEAMS, WEAPONS } from '../src/sim/data';
import { EDGE, GameMap, los } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { generateMap } from '../src/sim/mapgen';
import { makeScenario } from '../src/sim/scenario';
import { DT, Sim } from '../src/sim/sim';

describe('line of sight', () => {
  const wallMap = (edge: number) => {
    const m = new GameMap(10, 10);
    // vertical barrier at x=5 across all rows, one special edge at y=5
    for (let y = 0; y < 10; y++) m.setVEdge(5, y, EDGE.WALL);
    m.setVEdge(5, 5, edge as 1 | 2 | 3);
    return m;
  };

  it('walls block sight', () => {
    expect(los(wallMap(EDGE.WALL), 2.5, 5.5, 7.5, 5.5).visible).toBe(false);
  });

  it('doors and windows pass sight', () => {
    expect(los(wallMap(EDGE.DOOR), 2.5, 5.5, 7.5, 5.5).visible).toBe(true);
    expect(los(wallMap(EDGE.WINDOW), 2.5, 5.5, 7.5, 5.5).visible).toBe(true);
  });

  it('a target just behind a window gets window cover', () => {
    const r = los(wallMap(EDGE.WINDOW), 2.5, 5.5, 5.5, 5.5);
    expect(r.visible).toBe(true);
    expect(r.cover).toBeGreaterThanOrEqual(0.5);
  });

  it('dense woods block sight', () => {
    const m = new GameMap(20, 5);
    for (let x = 5; x < 15; x++) m.setTerrain(x, 2, 'woods');
    expect(los(m, 1.5, 2.5, 18.5, 2.5).visible).toBe(false);
    expect(los(m, 1.5, 2.5, 6.5, 2.5).visible).toBe(true); // shallow into the treeline
  });
});

describe('pathfinding', () => {
  it('routes through the door, not through walls or windows', () => {
    const plan = generateMap(1);
    const b = plan.buildings[0];
    const inside = { x: b.x + 2, y: b.y + 2 };
    const path = astar(plan.map, plan.spawns.west.x, plan.spawns.west.y, inside.x, inside.y);
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual(inside);
    // every consecutive step must be legal (edge-aware)
    for (let i = 1; i < path!.length; i++) {
      const a = path![i - 1];
      const c = path![i];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      if (dx !== 0 && dy !== 0) continue; // diagonals validated by canStep in astar itself
      expect(plan.map.canStep(a.x, a.y, c.x, c.y)).toBe(true);
    }
  });

  it('returns null for unreachable goals', () => {
    const m = new GameMap(10, 10);
    for (let x = 4; x < 7; x++) {
      m.setHEdge(x, 4, EDGE.WALL);
      m.setHEdge(x, 7, EDGE.WALL);
    }
    for (let y = 4; y < 7; y++) {
      m.setVEdge(4, y, EDGE.WALL);
      m.setVEdge(7, y, EDGE.WALL);
    }
    expect(astar(m, 1, 1, 5, 5)).toBeNull();
  });
});

describe('simulation', () => {
  it('is deterministic: same seed and orders produce identical state', () => {
    const run = () => {
      const sim = makeScenario(42);
      sim.orderSquad(0, { kind: 'move', x: 80, y: 55 });
      sim.orderSquad(1, { kind: 'move', x: 80, y: 70 });
      for (let i = 0; i < 3000; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });

  it('different seeds diverge', () => {
    const run = (seed: number) => {
      const sim = makeScenario(seed);
      sim.orderSquad(0, { kind: 'move', x: 80, y: 55 });
      for (let i = 0; i < 3000; i++) sim.step();
      return sim.snapshot();
    };
    expect(run(1)).not.toBe(run(2));
  });

  it('aimFactor is exactly the product of its exposed breakdown', () => {
    const sim = makeScenario(3);
    const s = sim.soldiers[0];
    s.pain = 0.3;
    s.suppression = 0.5;
    s.xp = 3;
    s.mental = 'shaken';
    const product = sim.aimBreakdown(s).reduce((a, t) => a * t.mult, 1);
    expect(sim.aimFactor(s)).toBe(product);
  });

  it('shotPreview reports blocked LOS and matches the live-fire formula in the open', () => {
    const m = new GameMap(20, 10);
    for (let y = 0; y < 10; y++) m.setVEdge(10, y, EDGE.WALL);
    const sim = new Sim(m, 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 15.5, y: 2.5 }]);
    const [shooter, target] = sim.soldiers;
    expect(sim.shotPreview(shooter.x, shooter.y, 'garand', target, false, 1).visible).toBe(false);
    target.x = 8.5; // same side of the wall
    const p = sim.shotPreview(shooter.x, shooter.y, 'garand', target, false, 1);
    const w = WEAPONS.garand;
    const d = Math.hypot(target.x - shooter.x, target.y - shooter.y);
    expect(p.visible).toBe(true);
    expect(p.acc).toBeCloseTo(w.accuracy * (1 - 0.75 * (d / w.range)), 12);
  });

  it('apShotPreview reports the struck arc and certain/impossible penetration odds', () => {
    const sim = makeScenario(5);
    const panzer = sim.vehicles.find((v) => v.kind === 'panzer4')!;
    // shot from dead ahead: front arc
    const front = sim.apShotPreview(panzer.x + Math.cos(panzer.facing) * 50, panzer.y + Math.sin(panzer.facing) * 50, 120, 0.5, 120, panzer, false);
    expect(front.arc).toBe('front');
    expect(front.armor).toBe(85);
    const rear = sim.apShotPreview(panzer.x - Math.cos(panzer.facing) * 50, panzer.y - Math.sin(panzer.facing) * 50, 120, 0.5, 120, panzer, false);
    expect(rear.arc).toBe('rear');
    expect(rear.penChance).toBe(1); // 25mm plate vs 90+ effective pen
  });

  it('queues unit events so DOWN then KIA across one frame batch keeps both', () => {
    const sim = new Sim(new GameMap(10, 10), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    const s = sim.soldiers[0];
    s.pain = 1; // >= 0.8 → downed
    sim.step();
    s.wounds.push({ part: 0, dmg: 10 });
    s.bloodLoss = 1; // → kill on next physiology tick
    sim.step();
    const kinds = sim.takeUnitEvents().map((e) => e.kind);
    expect(kinds).toEqual(['downed', 'kia']);
    expect(sim.takeUnitEvents()).toEqual([]); // queue drains
  });

  it('waypoint queue dispatches legs in order; a direct order cancels it', () => {
    const sim = new Sim(new GameMap(60, 20), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    sim.queueMove(0, 20, 10); // idle → dispatches immediately
    sim.queueMove(0, 40, 10);
    expect(sim.squadWaypoints[0].length).toBe(1);
    let reachedFirst = false;
    for (let i = 0; i < 30 * 120 && (sim.squadDest[0] || sim.squadWaypoints[0].length); i++) {
      if (Math.hypot(s.x - 20, s.y - 10) < 6) reachedFirst = true;
      sim.step();
    }
    expect(reachedFirst).toBe(true);
    expect(Math.hypot(s.x - 40, s.y - 10)).toBeLessThan(6);
    expect(sim.squadDest[0]).toBeNull();

    sim.queueMove(0, 20, 10);
    sim.queueMove(0, 2, 10);
    sim.orderSquad(0, { kind: 'move', x: 50, y: 10 }); // direct order wipes the queue
    expect(sim.squadWaypoints[0]).toEqual([]);
  });

  it('an assault produces a resolved firefight with no NaN state', () => {
    const sim = makeScenario(7);
    const [b0, b2] = [sim.buildings[0], sim.buildings[2]];
    sim.orderSquad(0, { kind: 'move', x: b0.x + b0.w / 2, y: b0.y + b0.h / 2 });
    sim.orderSquad(1, { kind: 'move', x: b2.x + b2.w / 2, y: b2.y + b2.h / 2 });
    let steps = 0;
    while (sim.winner === null && steps < 30 * 60 * 10) {
      sim.step();
      steps++;
      sim.takeEvents();
    }
    const casualties = sim.soldiers.filter((s) => !s.alive || s.downed).length;
    expect(casualties).toBeGreaterThan(0);
    for (const s of sim.soldiers) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.y)).toBe(true);
      expect(Number.isFinite(s.pain)).toBe(true);
      expect(Number.isFinite(s.bloodLoss)).toBe(true);
      expect(Number.isFinite(s.suppression)).toBe(true);
      expect(Number.isFinite(s.morale)).toBe(true);
    }
  });
});

describe('ammo, reload, heat, one-shot', () => {
  it('reload starts when the mag runs dry, and the clip count drops', () => {
    const sim = new Sim(new GameMap(10, 10), 40);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5, ammo: { clip_3006: 3 } }]);
    const s = sim.soldiers[0];
    s.magLeft = 0;
    sim.step();
    expect(s.reloading).toBeGreaterThan(0);
    expect(s.ammo.clip_3006).toBe(2);
  });

  it('a Garand reload from empty pings', () => {
    const sim = new Sim(new GameMap(10, 10), 45);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5, ammo: { clip_3006: 3 } }]);
    sim.soldiers[0].magLeft = 0;
    sim.step();
    expect(sim.takeUnitEvents().map((e) => e.kind)).toEqual(['ping']);
  });

  it('MG42 barrel heat forces a long swap with no shots fired during it', () => {
    const sim = new Sim(new GameMap(180, 10), 41);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'mg42', x: 2.5, y: 5.5 }]);
    // out of the gunner's garand-armed target's own range, so there's no return fire muddying the window
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 130.5, y: 5.5 }]);
    const gunner = sim.soldiers[0];
    gunner.heat = 1;
    const swapTicks = Math.ceil((WEAPONS.mg42.heat!.swapTime * sim.assistFactor(gunner)) / DT);
    for (let i = 0; i < swapTicks - 5; i++) sim.step();
    expect(gunner.heat).toBe(1); // still mid-swap, not yet reset
    expect(gunner.reloading).toBeGreaterThan(0);
    expect(sim.takeEvents().length).toBe(0); // no shots landed during the swap window
  });

  it('a panzerfaust soldier fires once at a vehicle, then reverts to his secondary weapon', () => {
    const sim = new Sim(new GameMap(20, 10), 42);
    sim.addSquad('red', 'a', [{ name: 'A', weapon: 'panzerfaust', x: 5.5, y: 5.5, ammo: {}, secondary: 'kar98k' }]);
    const v = sim.addVehicle('blue', 'sherman', 15.5, 5.5, Math.PI);
    v.gunCooldown = 999; // isolate: only the faust shot should register this test
    v.mgCooldown = 999;
    const soldier = sim.soldiers[0];
    sim.step(); // fires the faust
    expect(soldier.weapon).toBe('panzerfaust');
    sim.step(); // dry, no faust reserve left: reverts to the secondary
    expect(soldier.weapon).toBe('kar98k');
  });

  it('assistFactor: a lone gunner gets the unassisted (slower) multiplier', () => {
    const sim = new Sim(new GameMap(10, 10), 44);
    sim.addSquad('blue', 'gun', [{ name: 'G', weapon: 'm1919', x: 2.5, y: 2.5 }]);
    expect(sim.assistFactor(sim.soldiers[0])).toBe(1.75);
  });
});

describe('stamina', () => {
  it('marching drains stamina; standing still recovers it', () => {
    const sim = new Sim(new GameMap(60, 20), 50);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    sim.orderMove(0, 50, 10);
    for (let i = 0; i < 30 * 60 && s.path; i++) sim.step();
    expect(s.stamina).toBeLessThan(1);
    const winded = s.stamina;
    for (let i = 0; i < 30 * 60; i++) sim.step(); // standing still, no fire: recovers
    expect(s.stamina).toBeGreaterThan(winded);
  });

  it('fatigued soldiers aim worse than rested ones', () => {
    const sim = new Sim(new GameMap(10, 10), 51);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    const s = sim.soldiers[0];
    const rested = sim.aimFactor(s);
    s.stamina = 0.1;
    expect(sim.aimFactor(s)).toBeLessThan(rested);
  });
});

describe('teams and data-driven squads', () => {
  it('addSquadFromDef spawns a US rifle squad as 12 men in 2 teams with the roster weapons', () => {
    const sim = new Sim(new GameMap(40, 40), 60);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 20, 20);
    expect(squad.soldierIds.length).toBe(12);
    expect(squad.teamIds.length).toBe(2);
    const [able, baker] = squad.teamIds.map((id) => sim.teams[id]);
    expect(able.soldierIds.map((id) => sim.soldiers[id].weapon)).toEqual(TEAMS.us_able.slots.map((sl) => sl.weapon));
    expect(able.soldierIds.map((id) => sim.soldiers[id].role)).toEqual(TEAMS.us_able.slots.map((sl) => sl.role));
    expect(baker.soldierIds.map((id) => sim.soldiers[id].weapon)).toEqual(TEAMS.us_baker.slots.map((sl) => sl.weapon));
  });

  it('addSquadFromDef spawns a German Gruppe as 9 men, MG-Trupp holding 3', () => {
    const sim = new Sim(new GameMap(40, 40), 61);
    const squad = sim.addSquadFromDef('red', 'de_gruppe', 20, 20);
    expect(squad.soldierIds.length).toBe(9);
    const mgTrupp = sim.teams[squad.teamIds[0]];
    expect(mgTrupp.soldierIds.length).toBe(3);
  });

  it('orderSquad moves both teams of a multi-team squad', () => {
    const sim = new Sim(new GameMap(60, 40), 62);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 5, 20);
    sim.orderSquad(squad.id, { kind: 'move', x: 50, y: 20 });
    const moving = (teamId: number) => sim.teams[teamId].soldierIds.some((id) => sim.soldiers[id].path !== null);
    expect(squad.teamIds.every(moving)).toBe(true);
  });
});

describe('ammo runner + weapon pickup', () => {
  it('a dry MG42 gunner gets resupplied by a bonded bearer', () => {
    const sim = new Sim(new GameMap(20, 20), 70);
    sim.addSquad('blue', 'g', [
      { name: 'Gunner', weapon: 'mg42', x: 5.5, y: 5.5, ammo: { belt_792: 1 } },
      { name: 'Bearer', weapon: 'kar98k', x: 6.5, y: 5.5, ammo: { belt_792: 4 } },
    ]);
    const [gunner, bearer] = sim.soldiers;
    bearer.bonds[gunner.id] = 1;
    bearer.courage = 0.8;
    for (let i = 0; i < 300 && bearer.task === null; i++) sim.step();
    expect(bearer.task?.kind).toBe('ammo');
    for (let i = 0; i < 300 && bearer.task !== null; i++) sim.step();
    expect(bearer.task).toBeNull();
    expect(gunner.ammo.belt_792).toBeGreaterThan(1);
    expect(bearer.ammo.belt_792).toBeLessThan(4);
  });

  it('a rifleman adjacent to a dead BAR man upgrades weapons', () => {
    const sim = new Sim(new GameMap(20, 20), 71);
    sim.addSquad('blue', 's', [
      { name: 'Dead', weapon: 'bar', x: 5.5, y: 5.5, ammo: { mag_bar: 5 } },
      { name: 'Rifle', weapon: 'garand', x: 6.0, y: 5.5, ammo: { clip_3006: 8 } },
    ]);
    const [dead, rifle] = sim.soldiers;
    dead.wounds.push({ part: 0, dmg: 100 });
    dead.bloodLoss = 1; // kills on the next physiology tick
    for (let i = 0; i < 250 && rifle.weapon !== 'bar'; i++) sim.step();
    expect(rifle.weapon).toBe('bar');
    expect(rifle.ammo.mag_bar).toBe(5);
    expect(sim.droppedKit.length).toBe(0); // kit consumed
  });
});
