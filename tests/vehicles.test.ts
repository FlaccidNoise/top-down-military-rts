import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { armorFacing, Sim } from '../src/sim/sim';
import { generateMap } from '../src/sim/mapgen';

describe('armor', () => {
  it('facing arcs resolve correctly', () => {
    const v = { x: 10, y: 10, facing: 0 }; // nose pointing +X
    expect(armorFacing(v, 30, 10)).toBe('front');
    expect(armorFacing(v, -10, 10)).toBe('rear');
    expect(armorFacing(v, 10, 30)).toBe('side');
    expect(armorFacing(v, 10, -30)).toBe('side');
  });

  it('a tank-hunting party with panzerfausts kills a Sherman', () => {
    const map = new GameMap(60, 60);
    const sim = new Sim(map, 31);
    const v = sim.addVehicle('blue', 'sherman', 30.5, 30.5, 0);
    // five faust men, close assault distance (national weapon data gave the Sherman's
    // hull MG a faster cooldown than the old generic placeholder — a stand-off rush
    // now gets shredded before landing hits, so the hunting party closes in first)
    sim.addSquad('red', 'AT', [0, 1, 2, 3, 4].map((i) => ({ name: `at${i}`, weapon: 'panzerfaust', x: 26.5, y: 26.5 + i * 2, courage: 0.9 })));
    let t = 0;
    while (v.alive && t < 30 * 240) {
      sim.step();
      t++;
    }
    expect(v.alive).toBe(false);
    expect(v.burning).toBe(true);
  });

  // Live dynamics, no forced preconditions: a TO&E bazooka team is dropped on
  // an empty map with a Panzer IV in view and left alone. Nothing else in the
  // sim consumes rocket_bazooka, so a spent rocket IS an AT engagement.
  it('a bazooka team engages an enemy tank on its own', () => {
    const stage = (withTank: boolean) => {
      const sim = new Sim(new GameMap(80, 40), 51);
      sim.addSquadFromDef('blue', 'us_bazooka', 20.5, 20.5);
      if (withTank) sim.addVehicle('red', 'panzer4', 55.5, 20.5, Math.PI); // 35 m: inside the bazooka's 70 m
      const gunner = sim.soldiers.find((s) => s.weapon === 'bazooka')!;
      const rockets = gunner.ammo.rocket_bazooka ?? 0;
      for (let i = 0; i < 30 * 30; i++) sim.step();
      return rockets - (gunner.ammo.rocket_bazooka ?? 0);
    };
    expect(stage(true)).toBeGreaterThan(0);
    expect(stage(false)).toBe(0); // no armor on the field: the team holds its rockets
  });

  it('rifles cannot hurt tanks and ignore them', () => {
    const map = new GameMap(60, 60);
    const sim = new Sim(map, 32);
    const v = sim.addVehicle('blue', 'sherman', 30.5, 30.5, 0);
    sim.addSquad('red', 'rifles', [{ name: 'r', weapon: 'garand', x: 45.5, y: 30.5 }]);
    for (let i = 0; i < 30 * 30; i++) sim.step();
    expect(v.alive).toBe(true);
  });

  it('tank guns fight each other; a kill wounds or spills the crew', () => {
    const map = new GameMap(120, 40);
    const sim = new Sim(map, 33);
    const a = sim.addVehicle('blue', 'sherman', 20.5, 20.5, 0);
    const b = sim.addVehicle('red', 'panzer4', 90.5, 20.5, Math.PI);
    let t = 0;
    while (a.alive && b.alive && t < 30 * 300) {
      sim.step();
      t++;
    }
    expect(a.alive && b.alive).toBe(false);
    const dead = a.alive ? b : a;
    expect(dead.burning).toBe(true);
    // every surviving crewman is out of the hull
    for (const cid of dead.crewIds) {
      const c = sim.soldiers[cid];
      expect(c.inVehicle).toBe(-1);
    }
  });

  it('vehicles cannot path into buildings', () => {
    const plan = generateMap(34);
    const b = plan.buildings[0];
    const { west, east } = plan.spawns;
    expect(astar(plan.map, west.x, west.y, b.x + 2, b.y + 2, 'vehicle')).toBeNull();
    expect(astar(plan.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
  });
});

describe('transports: mount, ride, dismount', () => {
  it('a squad mounts an M3, rides ~60m, and dismounts in an orderly staggered fashion', () => {
    const sim = new Sim(new GameMap(160, 20), 40);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 10.5, 10.5);
    const m3 = sim.addVehicle('blue', 'm3_halftrack', 10.5, 10.5, 0);
    const teamId = squad.teamIds[0];
    sim.orderMount(teamId, m3.id);
    for (let i = 0; i < 300; i++) sim.step(); // co-located: boards almost immediately
    const team = sim.teams[teamId];
    expect(team.soldierIds.every((id) => sim.soldiers[id].inVehicle === m3.id)).toBe(true);

    sim.orderVehicleMove(m3.id, 90, 10);
    for (let i = 0; i < 600; i++) sim.step();
    expect(Math.hypot(m3.x - 10.5, m3.y - 10.5)).toBeGreaterThan(50);

    sim.orderDismount(m3.id);
    for (let i = 0; i < 300; i++) sim.step();
    expect(team.soldierIds.every((id) => sim.soldiers[id].inVehicle < 0)).toBe(true);
  });

  it('MG fire kills the exposed pintle gunner but leaves the hull-protected driver alone', () => {
    const sim = new Sim(new GameMap(60, 20), 41);
    const m3 = sim.addVehicle('blue', 'm3_halftrack', 30.5, 10.5, 0);
    sim.addSquad('red', 'mg', [{ name: 'G', weapon: 'mg42', x: 10.5, y: 10.5 }]);
    const gunner = sim.soldiers.find((s) => s.inVehicle === m3.id && s.role === 'gunner')!;
    const driver = sim.soldiers.find((s) => s.inVehicle === m3.id && s.role === 'driver')!;
    let t = 0;
    while (gunner.alive && t < 30 * 90) {
      sim.step();
      t++;
    }
    expect(gunner.alive).toBe(false);
    expect(driver.alive).toBe(true);
    expect(driver.inVehicle).toBe(m3.id); // never targeted, never bailed
  });

  it('a penetrating AP hit on an open-top M3 wounds the passengers riding in back, not just the crew', () => {
    const sim = new Sim(new GameMap(40, 20), 42);
    const m3 = sim.addVehicle('blue', 'm3_halftrack', 15.5, 10.5, 0);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 15.5, 10.5);
    const teamId = squad.teamIds[0];
    sim.orderMount(teamId, m3.id);
    for (let i = 0; i < 300; i++) sim.step(); // co-located: boards almost immediately
    const passengers = sim.teams[teamId].soldierIds.map((id) => sim.soldiers[id]);
    expect(passengers.every((s) => s.inVehicle === m3.id)).toBe(true);

    // Fire a battery of AP shells directly at the halftrack — bypasses the
    // acquire/cooldown loop so the penetration-spall path itself (not the
    // hit-chance roll) is what's under test.
    const before = passengers.reduce((a, s) => a + s.wounds.length, 0);
    for (let i = 0; i < 20 && m3.alive; i++) (sim as unknown as { fireApAt: (...a: unknown[]) => void }).fireApAt(0.5, 10.5, 150, 0.95, 200, m3, false);
    const after = passengers.reduce((a, s) => a + s.wounds.length, 0);
    expect(after).toBeGreaterThan(before);
  });
});

describe('StuG restricted turret arc', () => {
  it('cannot hit a flanking Sherman until the hull rotates onto it (turret arc = 12 deg)', () => {
    const sim = new Sim(new GameMap(80, 80), 43);
    const stug = sim.addVehicle('red', 'stug3', 40.5, 40.5, 0); // hull facing +X
    const sherman = sim.addVehicle('blue', 'sherman', 40.5, 25.5, 0); // due "north": well outside the arc
    let sawOutOfArcShot = false;
    for (let i = 0; i < 30 * 60 && stug.alive && sherman.alive; i++) {
      sim.step();
      const bearing = Math.atan2(sherman.y - stug.y, sherman.x - stug.x);
      let diff = bearing - stug.facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const events = sim.takeEvents();
      if (Math.abs(diff) > (12 * Math.PI) / 180 + 1e-6 && events.some((ev) => ev.fx === stug.x && ev.fy === stug.y)) {
        sawOutOfArcShot = true;
      }
    }
    expect(sawOutOfArcShot).toBe(false);
  });
});

describe('AT gun: towing and a deterministic side-armor kill', () => {
  it('an at57 is towed by an M3, unhitched, deployed, and kills a Panzer IV shot into its side armor', () => {
    const sim = new Sim(new GameMap(200, 200), 44);
    const emp = sim.addEmplacement('blue', 'at57', 20.5, 50.5);
    const m3 = sim.addVehicle('blue', 'm3_halftrack', 20.5, 50.5, 0);

    sim.orderHitch(m3.id, emp.id);
    expect(emp.towedBy).toBe(m3.id);

    sim.orderVehicleMove(m3.id, 60, 50);
    for (let i = 0; i < 400; i++) sim.step();
    expect(Math.hypot(emp.x - 20.5, emp.y - 50.5)).toBeGreaterThan(20); // towed along behind the M3

    sim.orderUnhitch(emp.id);
    expect(emp.towedBy).toBe(-1);

    sim.orderDeploy(emp.id);
    for (let i = 0; i < 1801; i++) sim.step(); // 60s setup
    expect(emp.state).toBe('deployed');

    // 120m out, facing east (0): the incoming round from due "south" of it
    // strikes broadside — side armor 35 vs at57's pen 110 (front 85 is
    // marginal by design; side is the deterministic case). Beyond the
    // Panzer's own 100m MG range, so it can never shoot back at the crew.
    const panzer = sim.addVehicle('red', 'panzer4', emp.x, emp.y + 120, 0);
    let t = 0;
    while (panzer.alive && t < 30 * 150) {
      sim.step();
      t++;
    }
    expect(panzer.alive).toBe(false);
  });
});

describe('air support', () => {
  it('strafe wounds or suppresses men along the run after the delay', () => {
    const map = new GameMap(160, 40);
    const sim = new Sim(map, 35);
    sim.addSquad('red', 'targets', [0, 1, 2, 3, 4].map((i) => ({ name: `t${i}`, weapon: 'garand', x: 70.5 + i * 4, y: 20.5 })));
    expect(sim.callAirstrike('blue', 78, 20.5)).toBe(true);
    expect(sim.callAirstrike('blue', 78, 20.5)).toBe(false); // one per battle
    for (let i = 0; i < 30 * 28; i++) sim.step();
    const touched = sim.soldiers.filter((s) => s.wounds.length > 0 || s.suppression > 0.2 || !s.alive);
    expect(touched.length).toBeGreaterThan(0);
  });
});

describe('battle end', () => {
  it('a side below quarter strength forfeits without annihilation', () => {
    const map = new GameMap(200, 40);
    const sim = new Sim(map, 36);
    // far apart: no actual combat, we just declare casualties
    sim.addSquad('blue', 'A', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `b${i}`, weapon: 'garand', x: 5.5, y: 5.5 + i * 2 })));
    sim.addSquad('red', 'B', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `r${i}`, weapon: 'garand', x: 190.5, y: 5.5 + i * 2 })));
    for (let i = 0; i < 7; i++) sim.soldiers[8 + i].alive = false; // red: 1 of 8 left (< 2 floor)
    sim.step();
    expect(sim.winner).toBe('blue');
  });
});
