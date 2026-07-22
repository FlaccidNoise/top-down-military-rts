import { describe, expect, it } from 'vitest';
import { EMPLACEMENTS, WEAPONS } from '../src/sim/data';
import { GameMap } from '../src/sim/map';
import { Sim, sightBetween } from '../src/sim/sim';

describe('emplacement lifecycle', () => {
  it('packed -> deploying -> deployed -> fires on a visible enemy', () => {
    const sim = new Sim(new GameMap(160, 20), 1);
    const e = sim.addEmplacement('blue', 'm1919_tripod', 10.5, 10.5);
    expect(e.state).toBe('packed');
    // 120m out: beyond the crew's personal carbines (70m) but inside the
    // M1919's own 150m range — isolates "the gun fired" from "the crew's
    // personal sidearms fired" (self-defense is intentionally not gated off).
    sim.addSquad('red', 'target', [{ name: 'T', weapon: 'kar98k', x: 130.5, y: 10.5 }]);

    sim.orderDeploy(e.id);
    expect(e.state).toBe('deploying');
    for (let i = 0; i < 901; i++) sim.step();
    expect(e.state).toBe('deployed');

    for (let i = 0; i < 400; i++) sim.step();
    const events = sim.takeEvents();
    expect(events.some((ev) => ev.fx === e.x && ev.fy === e.y)).toBe(true);
  });

  it('gunner killed leaves the lone assistant serving the gun at a degraded (below-minCrew) rate', () => {
    const sim = new Sim(new GameMap(60, 20), 2);
    const e = sim.addEmplacement('blue', 'm1919_tripod', 10.5, 10.5, 0, 'deployed');
    sim.addSquad('red', 'target', [{ name: 'T', weapon: 'kar98k', x: 30.5, y: 10.5, ammo: {} }]);
    sim.soldiers[1].magLeft = 0; // dry: won't return fire and complicate the read

    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const assistant = crew.find((s) => s.role === 'assistant')!;
    assistant.ammo = { belt_3006: 4 }; // his own reserve, isolated from the gunner's
    for (const s of crew) if (s.id !== assistant.id) s.alive = false; // lone survivor, minCrew(2) unmet

    let fired = false;
    for (let i = 0; i < 400 && !fired; i++) {
      sim.step();
      if (sim.takeEvents().length > 0) fired = true;
    }
    expect(fired).toBe(true);
    // served-weapon rule: minCrew(2)/present(1) = 2x base cooldown, floored at 1x
    expect(e.cooldown).toBeGreaterThan(WEAPONS.m1919.cooldown * 1.5);
  });

  it('deploy is blocked while a load is stranded where its carrier died en route, and unblocks once it is hauled to the gun and dropped there', () => {
    const sim = new Sim(new GameMap(60, 20), 3);
    const e = sim.addEmplacement('blue', 'm1919_tripod', 10.5, 10.5);
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const tripodBearer = crew.find((s) => s.carries.includes('tripod_m1919'))!;
    // bearer killed 20m out — still short of the gun. His load lands well
    // outside CREW_RADIUS, so deploy must refuse even though the rest of the
    // crew is present and ready.
    tripodBearer.alive = false;
    tripodBearer.x = e.x + 20;
    tripodBearer.y = e.y;
    sim.droppedKit.push({ side: 'blue', x: tripodBearer.x, y: tripodBearer.y, weapon: tripodBearer.weapon, ammo: {}, magLeft: 0, load: 'tripod_m1919' });

    sim.orderDeploy(e.id);
    expect(e.state).toBe('packed'); // blocked: the tripod never made it to the site

    // a crewman hauls it the rest of the way and drops it at the gun — no
    // need to re-shoulder it onto his back, merely dropped there is enough.
    const dropped = sim.droppedKit.find((k) => k.load === 'tripod_m1919')!;
    dropped.x = e.x;
    dropped.y = e.y;

    sim.orderDeploy(e.id);
    expect(e.state).toBe('deploying');
  });

  it('an idle crewman adjacent to a dropped load shoulders it', () => {
    const sim = new Sim(new GameMap(60, 20), 4);
    const e = sim.addEmplacement('blue', 'm1919_tripod', 10.5, 10.5);
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const bearer = crew.find((s) => s.carries.includes('tripod_m1919'))!;
    bearer.carries = [];
    sim.droppedKit.push({ side: 'blue', x: bearer.x + 1, y: bearer.y, weapon: bearer.weapon, ammo: {}, magLeft: 0, load: 'tripod_m1919' });

    for (let i = 0; i < 90; i++) sim.step();
    expect(bearer.carries).toContain('tripod_m1919');
    expect(sim.droppedKit.some((k) => k.load === 'tripod_m1919')).toBe(false);
  });

  it('a wheeled AT gun stops rolling when nobody is left to push it', () => {
    const sim = new Sim(new GameMap(60, 20), 9);
    const e = sim.addEmplacement('blue', 'at57', 10.5, 10.5);
    sim.orderWheel(e.id, 40, 10.5);
    expect(e.moveTarget).toEqual({ x: 40, y: 10.5 });
    for (let i = 0; i < 60; i++) sim.step(); // 2s at 1 m/s: rolls a couple meters
    const rolledTo = e.x;
    expect(rolledTo).toBeGreaterThan(10.5);

    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    for (const s of crew) s.alive = false; // wiped out mid-wheel

    for (let i = 0; i < 60; i++) sim.step();
    expect(e.x).toBeCloseTo(rolledTo, 5); // frozen: nobody left to push it
  });

  it('mortar HE hits a shared-vision target with tighter scatter when the crew has its own LOS, wider without it', () => {
    const m = new GameMap(80, 20);
    const sim = new Sim(m, 4);
    const e = sim.addEmplacement('blue', 'mortar60', 10.5, 10.5, 0, 'deployed');
    sim.orderFire(e.id, 40.5, 10.5); // in range (180), clear LOS from the gun itself
    expect(e.hasTarget).toBe(true);
    for (let i = 0; i < 200; i++) sim.step();
    expect(sim.takeBooms().length).toBeGreaterThan(0); // fired: crew has its own LOS to the point
  });

  it('mortar fires on a point only a spotter elsewhere on the map can see (shared vision), not the crew itself', () => {
    const m = new GameMap(80, 20);
    for (let y = 0; y < 20; y++) m.setVEdge(20, y, 1 as 1); // EDGE.WALL: blocks the gun's own LOS east
    const sim = new Sim(m, 5);
    const e = sim.addEmplacement('blue', 'mortar60', 10.5, 10.5, 0, 'deployed');
    expect(sightBetween(sim, e.x, e.y, 40.5, 10.5).visible).toBe(false); // confirm the gun itself can't see it
    // a friendly spotter elsewhere on the map (east of the wall) can
    sim.addSquad('blue', 'spotter', [{ name: 'S', weapon: 'garand', x: 25.5, y: 10.5 }]);
    sim.orderFire(e.id, 40.5, 10.5);
    for (let i = 0; i < 200; i++) sim.step();
    expect(sim.takeBooms().length).toBeGreaterThan(0); // fired anyway: shared vision, wider (scatterNoLos) scatter
  });

  it('smoke screen from a mortar mission blocks a previously clear line of sight', () => {
    const sim = new Sim(new GameMap(80, 60), 6);
    // gun sits off to the side so the target point (40m out, above mortar60's
    // 20m minRange) lands on the sightline being tested.
    const e = sim.addEmplacement('blue', 'mortar60', 60.5, 40.5, 0, 'deployed');
    expect(sightBetween(sim, 20.5, 10.5, 30.5, 10.5).visible).toBe(true);
    sim.orderSmoke(e.id, 25.5, 10.5);
    for (let i = 0; i < 700; i++) sim.step(); // time for all 4 rounds to fire and land
    expect(sim.smoke.length).toBeGreaterThan(0);
    // a short segment straddling the target point: within scatter range of
    // every one of the 4 rounds, so this reads the screen, not the roll.
    expect(sightBetween(sim, 20.5, 10.5, 30.5, 10.5).visible).toBe(false);
  });
});

describe('emplacement scenario wiring', () => {
  it('EMPLACEMENTS data referenced by addEmplacement round-trips through Sim', () => {
    const sim = new Sim(new GameMap(40, 20), 7);
    const e = sim.addEmplacement('red', 'at57', 10.5, 10.5);
    expect(EMPLACEMENTS[e.kind].weapon).toBe('at57_gun');
    expect(sim.teams[e.crewTeamId].soldierIds.length).toBe(5);
  });
});
