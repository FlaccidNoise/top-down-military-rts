import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { dangerScore } from '../src/sim/orders';
import { DT, Sim, sightBetween, SMOKE_H, smokePuff, grow, SPOT_INTERVAL, type Vehicle } from '../src/sim/sim';
import { LEAN_K, smokeAxisAt, WIND } from '../src/sim/wind';

// V11: the smoke column ages, grows and leans on the wind. The old model was a
// 3.5 m cylinder that appeared instantly and never changed; this one starts
// short, saturates, and drifts downwind with height — so a floor-2 eye that
// sees over a fresh puff is blinded by the same puff eight seconds later.

const ray = (sim: Sim, l0 = 0, l1 = 0) => sightBetween(sim, 5.5, 10.5, 30.5, 10.5, l0, l1);

function simWith(...puffs: ReturnType<typeof smokePuff>[]): Sim {
  const sim = new Sim(new GameMap(40, 20), 1);
  sim.smoke.push(...puffs);
  return sim;
}

describe('the growth curve', () => {
  it('is rational and saturating: monotone, never past the cap, exact at age 0', () => {
    expect(grow(0, 1.5, 10, 10)).toBe(1.5);
    let last = -1;
    for (let a = 0; a <= 600; a += 0.5) {
      const v = grow(a, 1.5, 10, 10);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThan(10);
      last = v;
    }
  });

  it('shell smoke at 3 s matches the old fixed SMOKE_H — the calibration that keeps a fresh screen behaving as it always did', () => {
    const h3 = smokePuff(0, 0, 0, 60, 0, 3).h;
    // 1.5 + 8.5*(3/13) = 3.4615 m, i.e. 1.1% under SMOKE_H (the design says
    // "within 1%"; the arithmetic says 1.1%). The bar is 2%: tight enough that
    // a retune of PLUME[0] which actually moves early-screen behaviour trips
    // it, loose enough not to fail on the design's own rounding.
    expect(h3).toBeCloseTo(3.4615, 4);
    expect(Math.abs(h3 - SMOKE_H) / SMOKE_H).toBeLessThan(0.02);
  });

  it('then climbs the way the design table says (10 s / 30 s / 60 s)', () => {
    const h = (age: number) => smokePuff(0, 0, 0, 60, 0, age).h;
    expect(h(10)).toBeCloseTo(5.75, 2);
    expect(h(30)).toBeCloseTo(7.875, 2);
    expect(h(60)).toBeCloseTo(8.786, 2);
  });

  it('fire (kind 1) is the 20 m plume', () => {
    const p = smokePuff(0, 0, 0, 180, 1, 60);
    expect(p.h).toBeGreaterThan(15);
    expect(p.h).toBeLessThan(20);
    expect(p.r).toBeGreaterThan(smokePuff(0, 0, 0, 180, 0, 60).r);
  });

  it('the reject radius always encloses the whole leaning column', () => {
    for (const kind of [0, 1] as const)
      for (const age of [0, 1, 5, 30, 120]) {
        const p = smokePuff(0, 0, 0, 60, kind, age);
        const reach = p.r + LEAN_K * p.h;
        expect(p.r2max).toBeCloseTo(reach * reach, 9);
        expect(p.r2max).toBeGreaterThanOrEqual(p.r * p.r); // never prunes a hit the refined test would take
      }
  });
});

describe('the puff ages in the sim, once per tick', () => {
  it('age tracks sim time and h/r/r2max follow it', () => {
    const sim = simWith(smokePuff(20.5, 10.5, 0, 60));
    const p = sim.smoke[0];
    for (let i = 0; i < 90; i++) sim.step();
    expect(p.age).toBeCloseTo(90 * DT, 9);
    expect(p.h).toBeCloseTo(grow(p.age, 1.5, 10, 10), 12);
    expect(p.r).toBeCloseTo(grow(p.age, 1.5, 3, 10), 12);
    const reach = p.r + LEAN_K * p.h;
    expect(p.r2max).toBeCloseTo(reach * reach, 12);
  });

  it('still expires on ttl', () => {
    const sim = simWith(smokePuff(20.5, 10.5, 0, 1));
    for (let i = 0; i < 31; i++) sim.step();
    expect(sim.smoke.length).toBe(0);
  });

  it('two runs with mixed-age smoke snapshot identically', () => {
    const run = () => {
      const sim = simWith(smokePuff(20.5, 10.5, 0, 60), smokePuff(21.5, 10.5, 0, 60, 1, 45));
      for (let i = 0; i < 120; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });
});

describe('the column as an LOS obstacle', () => {
  it('a fresh puff is short enough to see over, and the same puff blinds later', () => {
    // a floor-2 eye (4.6 m) firing down at a ground target
    const fresh = simWith(smokePuff(8.5, 10.5, 0, 60), smokePuff(10.5, 10.5, 0, 60));
    expect(ray(fresh, 1, 0).visible).toBe(true);
    const aged = simWith(smokePuff(8.5, 10.5, 0, 60, 0, 15), smokePuff(10.5, 10.5, 0, 60, 0, 15));
    expect(aged.smoke[0].h).toBeGreaterThan(4.6);
    expect(ray(aged, 1, 0).visible).toBe(false);
  });

  it('a ground eye is blind through a developed screen and sees through a just-thrown one', () => {
    expect(ray(simWith(smokePuff(8.5, 10.5, 0, 60), smokePuff(10.5, 10.5, 0, 60))).visible).toBe(true);
    expect(ray(simWith(smokePuff(8.5, 10.5, 0, 60, 0, 3), smokePuff(10.5, 10.5, 0, 60, 0, 3))).visible).toBe(false);
  });

  it('a smokeless ray pays nothing and returns the base result untouched', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    const base = ray(sim);
    expect(base.visible).toBe(true);
    expect(base.conceal).toBe(0);
  });

  it('one puff conceals without blocking; two block', () => {
    const one = ray(simWith(smokePuff(9.5, 10.5, 0, 60, 0, 3)));
    expect(one.visible).toBe(true);
    expect(one.conceal).toBeCloseTo(0.5, 9);
    expect(ray(simWith(smokePuff(9.5, 10.5, 0, 60, 0, 3), smokePuff(11.5, 10.5, 0, 60, 0, 3))).visible).toBe(false);
  });
});

describe('a burning wreck is a plume (V13)', () => {
  const kill = (sim: Sim, v: Vehicle) => (sim as unknown as { destroyVehicle: (v: Vehicle) => void }).destroyVehicle(v);

  it('a brewed-up tank emits a kind-1 column at the wreck, for three minutes', () => {
    const sim = new Sim(new GameMap(60, 20), 3);
    const v = sim.addVehicle('red', 'panzer4', 30.5, 10.5, 0);
    expect(sim.smoke.length).toBe(0);
    kill(sim, v);
    expect(sim.smoke.length).toBe(1);
    const p = sim.smoke[0];
    expect(p.kind).toBe(1);
    expect(p.x).toBe(v.x);
    expect(p.ttl).toBe(180);
    expect(v.burning).toBe(true);
  });

  it('it screens the ground it died on immediately — no four-tick delay like a grenade', () => {
    const sim = new Sim(new GameMap(60, 20), 3);
    const clear = sightBetween(sim, 5.5, 10.5, 55.5, 10.5);
    expect(clear.conceal).toBe(0);
    kill(sim, sim.addVehicle('red', 'panzer4', 30.5, 10.5, 0));
    expect(sightBetween(sim, 5.5, 10.5, 55.5, 10.5).conceal).toBeGreaterThan(0); // h0 = 2 m, over a standing eye at once
  });

  it('and it grows to a 15 m-plus column that an upstairs eye cannot see over', () => {
    const sim = new Sim(new GameMap(60, 20), 3);
    kill(sim, sim.addVehicle('red', 'panzer4', 30.5, 10.5, 0));
    for (let i = 0; i < 30 * 60; i++) sim.step();
    expect(sim.smoke.length).toBe(1);
    expect(sim.smoke[0].h).toBeGreaterThan(15);
    expect(sightBetween(sim, 5.5, 10.5, 55.5, 10.5, 2, 2).conceal).toBeGreaterThan(0);
  });

  it('the doctrine loop cannot pathologically avoid a wreck: the plume LOWERS the danger model', () => {
    // The worry with a permanent 20 m column is that the AI treats burning
    // ground as lethal and refuses to cross it. It cannot: danger is summed
    // from enemies with LOS to the sampled points, and the plume removes LOS.
    // Same scenario twice, identical rng, wreck or no wreck.
    const build = (wreck: boolean) => {
      const sim = new Sim(new GameMap(80, 20), 4);
      sim.addSquad('red', 'MG', [{ name: 'G', weapon: 'mg42', x: 70.5, y: 10.5 }]);
      const blue = sim.addSquad('blue', 'A', [{ name: 'A1', weapon: 'garand', x: 10.5, y: 10.5 }]);
      for (let i = 0; i < SPOT_INTERVAL + 1; i++) sim.step(); // let blue actually see the MG
      if (wreck) kill(sim, sim.addVehicle('red', 'panzer4', 40.5, 10.5, 0));
      return dangerScore(sim, sim.teams[blue.teamIds[0]], { x: 60, y: 10.5 });
    };
    const open = build(false);
    const screened = build(true);
    expect(open).toBeGreaterThan(0); // the MG really does cover the approach
    expect(screened).toBeLessThanOrEqual(open);
  });

  it('and it burns out on its ttl', () => {
    const sim = new Sim(new GameMap(60, 20), 3);
    kill(sim, sim.addVehicle('red', 'panzer4', 30.5, 10.5, 0));
    for (let i = 0; i < 30 * 181; i++) sim.step();
    expect(sim.smoke.length).toBe(0);
  });
});

describe('the lean is the renderer-visible one (WYSIWYG)', () => {
  // sightBetween re-projects the ray against smokeAxisAt(p, z) before blocking.
  // The renderer (V12) stacks its sprites along the same function from the same
  // file, so these assertions are what keeps the drawn column and the blocking
  // column the same object. Probe the boundary: a ray just inside the leaned
  // axis's radius blocks, one just outside does not.
  const probe = (age: number, offset: number): boolean => {
    const sim = new Sim(new GameMap(60, 60), 1);
    const p = smokePuff(30.5, 30.5, 0, 60, 0, age);
    sim.smoke.push(p);
    // Eye height inside the column's z-interval — at age 0 the top is 1.5 m,
    // below a standing eye, which is exactly why a just-thrown puff screens
    // nobody. The ray runs along x, displaced in y by `offset` from the axis's
    // own y where it crosses that height.
    const e = Math.min(1.6, p.h - 0.1);
    const [, ay] = smokeAxisAt(p, e);
    const y = ay + offset;
    return sightBetween(sim, 5.5, y, 55.5, y, 0, 0, e, e).conceal > 0;
  };

  it('blocks inside the leaned axis and clears outside it, at every age', () => {
    for (const age of [0, 5, 30, 60]) {
      const r = smokePuff(0, 0, 0, 60, 0, age).r;
      expect(probe(age, r - 0.05), `age ${age} just inside`).toBe(true);
      expect(probe(age, r + 0.05), `age ${age} just outside`).toBe(false);
    }
  });

  it('an old column blocks a downwind line its own base does not cover', () => {
    const age = 60;
    const p = smokePuff(30.5, 30.5, 0, 60, 0, age);
    const [, ay] = smokeAxisAt(p, 1.6);
    expect(Math.abs(ay - p.y)).toBeGreaterThan(0.3); // the lean is real at eye height
    const downwind = p.y + (WIND.dy < 0 ? -1 : 1) * (p.r + 0.2);
    const sim = new Sim(new GameMap(60, 60), 1);
    sim.smoke.push(p);
    // that line misses the BASE circle entirely, and is still in the column
    expect(Math.abs(downwind - p.y)).toBeGreaterThan(p.r);
    expect(sightBetween(sim, 5.5, downwind, 55.5, downwind).conceal).toBeGreaterThan(0);
  });

  it('smokeAxisAt is the identity at the column base and leans with the wind above it', () => {
    const p = smokePuff(10, 20, 3, 60, 0, 30);
    expect(smokeAxisAt(p, 3)).toEqual([10, 20]);
    const [ax, ay] = smokeAxisAt(p, 3 + 4);
    expect(ax).toBeCloseTo(10 + WIND.dx * LEAN_K * 4, 12);
    expect(ay).toBeCloseTo(20 + WIND.dy * LEAN_K * 4, 12);
  });
});
