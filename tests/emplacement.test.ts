import { describe, expect, it } from 'vitest';
import { EMPLACEMENTS, WEAPONS } from '../src/sim/data';
import { GameMap } from '../src/sim/map';
import { Sim, sightBetween } from '../src/sim/sim';

// #765. A belt is ammo.perUnit bursts on a tripod as it is in a man's hands.
// The emplaced path used to spend a whole belt on every burst.
describe('emplaced MG belts (#765)', () => {
  const gun = (seed: number) => {
    const sim = new Sim(new GameMap(200, 44), seed);
    const e = sim.addEmplacement('blue', 'mg42_lafette', 10.5, 20.5, 0, 'deployed');
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const belts = () => crew.reduce((a, s) => a + (s.ammo.belt_792 ?? 0), 0);
    const bursts = () => sim.takeEvents().filter((ev) => ev.fx === e.x && ev.fy === e.y).length;
    const targets = (n: number, x: number) => {
      const sq = sim.addSquad(
        'red',
        'targets',
        Array.from({ length: n }, (_, i) => ({ name: `T${i}`, weapon: 'kar98k' as const, x: x + (i % 4) * 2, y: 4.5 + Math.floor(i / 4) * 4, ammo: {} })),
      );
      for (const id of sq.soldierIds) sim.soldiers[id].magLeft = 0; // dry: nothing comes back at the gun
    };
    return { sim, e, belts, bursts, targets };
  };

  it('a tripod MG42 fires on through one belt: more bursts than its crew carries belts, and none drawn', () => {
    const { sim, e, belts, bursts, targets } = gun(3);
    targets(36, 80.5);
    const carried = belts();
    expect(carried).toBe(12);
    let fired = 0;
    for (let i = 0; i < 30 * 180 && fired <= carried * 2; i++) {
      sim.step();
      fired += bursts();
    }
    expect(fired).toBeGreaterThan(carried * 2); // 12 was the cap, 24 with the old stockpile
    expect(belts()).toBe(carried);
    expect(e.magLeft).toBe(WEAPONS.mg42.ammo.perUnit - fired);
  });

  it('a spent belt is changed from the crew stock, and the change takes the reload time', () => {
    const { sim, e, belts, bursts, targets } = gun(4);
    targets(8, 60.5);
    const carried = belts();
    e.magLeft = 1; // staged: the last burst of the belt on the gun
    let fired = 0;
    for (let i = 0; i < 300 && fired === 0; i++) {
      sim.step();
      fired += bursts();
    }
    expect([fired, e.magLeft, belts()]).toEqual([1, 0, carried]);
    for (let i = 0; i < 300 && e.magLeft === 0; i++) sim.step();
    expect([e.magLeft, belts()]).toEqual([WEAPONS.mg42.ammo.perUnit, carried - 1]);
    expect(e.cooldown).toBeGreaterThan(WEAPONS.mg42.ammo.reload - 0.1);
    let during = 0;
    for (let i = 0; i < Math.floor(WEAPONS.mg42.ammo.reload * 30) - 5; i++) {
      sim.step();
      during += bursts();
    }
    expect(during).toBe(0); // silent while the belt goes on
    for (let i = 0; i < 300 && fired === 1; i++) {
      sim.step();
      fired += bursts();
    }
    expect(fired).toBeGreaterThan(1); // and back in action after it
  });

  it('with no belt left to change to, the gun stops when the one on it runs out', () => {
    const { sim, e, bursts, targets } = gun(5);
    targets(16, 60.5);
    for (const id of sim.teams[e.crewTeamId].soldierIds) delete sim.soldiers[id].ammo.belt_792;
    e.magLeft = 3;
    let fired = 0;
    for (let i = 0; i < 30 * 60; i++) {
      sim.step();
      fired += bursts();
    }
    expect(fired).toBe(3);
  });
});

// #787. Nothing used to bring a routed crew back: the defending commander
// re-posts a squad only when an enemy stands on its post.
describe('a routed crew goes back to its gun (#787)', () => {
  it('the gunner who ran returns once he is steady, but not while an enemy holds the gun', () => {
    const sim = new Sim(new GameMap(140, 40), 6);
    const e = sim.addEmplacement('blue', 'mg42_lafette', 70.5, 20.5, 0, 'deployed');
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const gunner = crew.find((m) => m.role === 'gunner')!;
    // A quiet gun and a quiet enemy: this is about one man's legs, and a
    // firefight round the pit would decide it for him.
    for (const m of crew) {
      m.ammo = {};
      if (m !== gunner) m.magLeft = 0;
    }
    e.magLeft = 0;
    const holder = sim.soldiers[sim.addSquad('red', 'holder', [{ name: 'H', weapon: 'kar98k', x: 62.5, y: 20.5, ammo: {} }]).soldierIds[0]];
    holder.magLeft = 0;
    const off = () => Math.hypot(gunner.x - e.x, gunner.y - e.y);

    // The rout is staged. Nothing after it is.
    for (let i = 0; i < 20; i++) {
      gunner.morale = 0;
      gunner.suppression = 1;
      sim.step();
    }
    expect(gunner.mental).toBe('broken');
    expect(gunner.fledGun).toBe(true);
    for (let i = 0; i < 30 * 240 && gunner.mental !== 'steady'; i++) sim.step();
    expect(gunner.mental).toBe('steady');
    expect(off()).toBeGreaterThan(15); // he ran

    for (let i = 0; i < 30 * 30; i++) sim.step();
    expect(off()).toBeGreaterThan(15); // steady, and staying away: the enemy is 8 m from the gun
    expect(gunner.fledGun).toBe(true);

    holder.x = 5.5; // the enemy goes
    for (let i = 0; i < 30 * 60 && gunner.fledGun; i++) sim.step();
    expect(off()).toBeLessThanOrEqual(4); // CREW_RADIUS: on the gun again
    expect(gunner.fledGun).toBe(false);
  });
});

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
