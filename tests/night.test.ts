// Night rules battery (day/night design §7.4). The load-bearing claims:
// sim.light is PURE in (startMin, tick); every ramp returns its exact shipped
// constant at light === 1 (the whole existing suite is a no-op-by-default);
// and darkness rewards the sneak/ambush posture without blanket-hiding troops.
import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { CANON_CLOCK_MIN, lightAt } from '../src/sim/solar';
import { Sim, concealNeedOf, hideFloorOf, sightToSoldier, spotCapOf } from '../src/sim/sim';

describe('sim.light purity', () => {
  it('light is a pure function of (startMin, tick) — battle content is irrelevant', () => {
    // Same startMin, radically different worlds and seeds, stepped to the same
    // tick: identical light, and identical to the closed form.
    const a = new Sim(new GameMap(20, 20), 1);
    const b = new Sim(new GameMap(80, 40), 999);
    b.addSquad('blue', 'x', [{ name: 'A', weapon: 'garand', x: 5.5, y: 5.5 }]);
    b.addSquad('red', 'y', [{ name: 'R', weapon: 'kar98k', x: 40.5, y: 5.5 }]);
    a.startMin = 21 * 60; // 21:00 — on the dusk ramp, where light actually moves
    b.startMin = 21 * 60;
    for (let i = 0; i < 300; i++) a.step();
    for (let i = 0; i < 300; i++) b.step();
    expect(a.tick).toBe(b.tick);
    expect(a.light).toBe(b.light);
    expect(a.light).toBe(lightAt(21 * 60 + 300 / 1800));
    expect(a.clockMin).toBe(21 * 60 + 300 / 1800);
  });

  it('defaults to the canonical hour: full day, every ramp at its shipped constant', () => {
    const sim = new Sim(new GameMap(10, 10), 1);
    expect(sim.startMin).toBe(CANON_CLOCK_MIN);
    expect(sim.light).toBe(1);
    expect(spotCapOf(1)).toBe(Infinity);
    expect(concealNeedOf(1)).toBe(0.5);
    expect(hideFloorOf(1)).toBe(20);
  });

  it('lightAt hits the landmarks and rises monotonically from solar midnight to noon', () => {
    expect(lightAt(CANON_CLOCK_MIN)).toBe(1); // 14:00 = solar noon, el 61.8
    expect(lightAt(2 * 60)).toBe(0); // 02:00 = solar midnight, el -19.8 — astronomical dark
    let prev = -1;
    for (let m = 2 * 60; m <= CANON_CLOCK_MIN; m++) {
      const l = lightAt(m);
      expect(l).toBeGreaterThanOrEqual(prev);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
      prev = l;
    }
  });
});

describe('night ramps', () => {
  it('spotCap, concealNeed and hideFloor are monotone in light and hit the design endpoints', () => {
    expect(spotCapOf(0)).toBe(25);
    expect(concealNeedOf(0)).toBeCloseTo(0.18, 12);
    expect(hideFloorOf(0)).toBeCloseTo(8, 12);
    let pc = -1;
    let pn = -1;
    let pf = -1;
    for (let l = 0; l <= 1.0001; l += 0.01) {
      const light = Math.min(1, l);
      expect(spotCapOf(light)).toBeGreaterThanOrEqual(pc);
      expect(concealNeedOf(light)).toBeGreaterThanOrEqual(pn);
      expect(hideFloorOf(light)).toBeGreaterThanOrEqual(pf);
      pc = Math.min(200, spotCapOf(light)); // Infinity at 1 still satisfies >= 200
      pn = concealNeedOf(light);
      pf = hideFloorOf(light);
    }
  });
});

describe('darkness as concealment (§7.2)', () => {
  // One hedge line, crossed far from the target: conceal 0.5, no cover. At
  // 12 m a sneaking man sits between the night hide floor (8 m) and the day
  // one (20 m) — the pair of assertions that pins the ramp's direction.
  const staged = (startMin: number) => {
    const m = new GameMap(30, 6);
    for (let y = 0; y < 6; y++) m.setTerrain(10, y, 'hedge');
    const sim = new Sim(m, 5);
    sim.startMin = startMin;
    sim.addSquad('blue', 'obs', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    sim.addSquad('red', 'snk', [{ name: 'R', weapon: 'kar98k', x: 14.5, y: 2.5 }]); // 12 m, hedge 4.5 m short of him
    const target = sim.soldiers[1];
    sim.orderTeam(target.teamId, { kind: 'sneak', x: 14.5, y: 2.5 });
    expect(sim.teams[target.teamId].orderState.order?.kind).toBe('sneak'); // guard the fixture
    return { sim, target };
  };

  it('a sneaking man behind one hedge at 12 m is seen at 14:00 and hidden at 02:00', () => {
    const day = staged(CANON_CLOCK_MIN);
    const daySight = sightToSoldier(day.sim, 2.5, 2.5, day.target);
    expect(daySight.visible).toBe(true); // 12 m < the 20 m day floor

    const night = staged(2 * 60);
    const nightSight = sightToSoldier(night.sim, 2.5, 2.5, night.target);
    expect(nightSight.visible).toBe(false); // conceal 0.5 >= 0.18 need, 12 m > the 8 m night floor
    expect(nightSight.concealed).toBe(true);
  });

  it('darkness is not an invisibility field: the same man in the open at 02:00 is seen at 12 m', () => {
    const m = new GameMap(30, 6); // no hedge — nothing on the ray
    const sim = new Sim(m, 5);
    sim.startMin = 2 * 60;
    sim.addSquad('blue', 'obs', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    sim.addSquad('red', 'snk', [{ name: 'R', weapon: 'kar98k', x: 14.5, y: 2.5 }]);
    const target = sim.soldiers[1];
    sim.orderTeam(target.teamId, { kind: 'sneak', x: 14.5, y: 2.5 });
    expect(sightToSoldier(sim, 2.5, 2.5, target).visible).toBe(true); // conceal 0 < 0.18: posture alone hides nobody
  });
});
