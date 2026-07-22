import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { armorFacing, Sim } from '../src/sim/sim';
import { BUILDINGS, makeScenario } from '../src/sim/scenario';

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
    // five faust men, 12m behind the tank
    sim.addSquad('red', 'AT', [0, 1, 2, 3, 4].map((i) => ({ name: `at${i}`, weapon: 'panzerfaust', x: 18.5, y: 26.5 + i * 2, courage: 0.9 })));
    let t = 0;
    while (v.alive && t < 30 * 240) {
      sim.step();
      t++;
    }
    expect(v.alive).toBe(false);
    expect(v.burning).toBe(true);
  });

  it('rifles cannot hurt tanks and ignore them', () => {
    const map = new GameMap(60, 60);
    const sim = new Sim(map, 32);
    const v = sim.addVehicle('blue', 'sherman', 30.5, 30.5, 0);
    sim.addSquad('red', 'rifles', [{ name: 'r', weapon: 'rifle', x: 45.5, y: 30.5 }]);
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
    const sim = makeScenario(34);
    const b = BUILDINGS[0];
    expect(astar(sim.map, 8, 61, b.x + 2, b.y + 2, 'vehicle')).toBeNull();
    expect(astar(sim.map, 8, 61, 80, 61, 'vehicle')).not.toBeNull();
  });
});

describe('air support', () => {
  it('strafe wounds or suppresses men along the run after the delay', () => {
    const map = new GameMap(160, 40);
    const sim = new Sim(map, 35);
    sim.addSquad('red', 'targets', [0, 1, 2, 3, 4].map((i) => ({ name: `t${i}`, weapon: 'rifle', x: 70.5 + i * 4, y: 20.5 })));
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
    sim.addSquad('blue', 'A', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `b${i}`, weapon: 'rifle', x: 5.5, y: 5.5 + i * 2 })));
    sim.addSquad('red', 'B', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `r${i}`, weapon: 'rifle', x: 190.5, y: 5.5 + i * 2 })));
    for (let i = 0; i < 7; i++) sim.soldiers[8 + i].alive = false; // red: 1 of 8 left (< 2 floor)
    sim.step();
    expect(sim.winner).toBe('blue');
  });
});
