import { describe, expect, it } from 'vitest';
import { applyHit, capacities, consciousness, freshBody, P, PARTS, rollPart } from '../src/sim/body';
import { GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';

describe('anatomy', () => {
  it('a destroyed hand halves manipulation', () => {
    const body = freshBody();
    applyHit(body, P.L_HAND, 100);
    expect(body[P.L_HAND]).toBe(0);
    expect(capacities(body).manipulation).toBeCloseTo(0.5);
  });

  it('leg damage degrades moving; both legs gone means immobile', () => {
    const body = freshBody();
    applyHit(body, P.L_LEG, 15);
    expect(capacities(body).moving).toBeCloseTo(0.75);
    applyHit(body, P.L_LEG, 100);
    applyHit(body, P.R_LEG, 100);
    expect(capacities(body).moving).toBe(0);
  });

  it('head or torso destruction is fatal, limb destruction is not', () => {
    expect(applyHit(freshBody(), P.HEAD, 80).fatal).toBe(true);
    expect(applyHit(freshBody(), P.TORSO, 80).fatal).toBe(true);
    expect(applyHit(freshBody(), P.R_ARM, 80).fatal).toBe(false);
  });

  it('pain and blood loss knock consciousness down', () => {
    expect(consciousness(0, 0)).toBe(1);
    expect(consciousness(0.9, 0)).toBeLessThan(0.7);
    expect(consciousness(0, 0.8)).toBeLessThan(0.1);
  });

  it('hit location roll covers all parts and favors the torso', () => {
    const counts = new Array(PARTS.length).fill(0);
    for (let i = 0; i < 1000; i++) counts[rollPart(i / 1000)]++;
    expect(counts[P.TORSO]).toBeGreaterThan(counts[P.HEAD]);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });
});

describe('physiology in battle', () => {
  const duel = (dmg: number, part: number) => {
    const map = new GameMap(20, 20);
    const sim = new Sim(map, 1);
    sim.addSquad('blue', 'A', [{ name: 'a', weapon: 'garand', x: 2.5, y: 2.5 }]);
    const s = sim.soldiers[0];
    const r = applyHit(s.body, part, dmg);
    s.wounds.push(r.wound);
    s.bleedRate += r.bleedRate;
    s.pain += r.pain;
    return { sim, s };
  };

  it('pain shock downs a soldier without killing him', () => {
    const { sim, s } = duel(14, P.L_HAND);
    const r2 = applyHit(s.body, P.R_LEG, 30);
    s.wounds.push(r2.wound);
    s.pain += r2.pain;
    s.pain = 0.85; // shock threshold
    sim.step();
    expect(s.alive).toBe(true);
    expect(s.downed).toBe(true);
  });

  it('untreated heavy bleeding kills within minutes', () => {
    const { sim, s } = duel(38, P.TORSO);
    expect(s.alive).toBe(true);
    for (let i = 0; i < 30 * 60 * 10 && s.alive; i++) sim.step();
    expect(s.alive).toBe(false);
  });

  it('a light graze does not bleed out', () => {
    const { sim, s } = duel(4, P.L_ARM);
    for (let i = 0; i < 30 * 60 * 10; i++) sim.step();
    expect(s.alive).toBe(true);
    expect(s.downed).toBe(false);
  });
});

describe('psychology', () => {
  it('sustained MG fire pins men in the open', () => {
    // targets sit beyond rifle range (137m) so they can't silence the MGs
    const map = new GameMap(160, 20);
    const sim = new Sim(map, 3);
    sim.addSquad('blue', 'MG', [
      { name: 'mg1', weapon: 'm1919', x: 2.5, y: 8.5 },
      { name: 'mg2', weapon: 'm1919', x: 2.5, y: 12.5 },
    ]);
    sim.addSquad('red', 'targets', [0, 1, 2, 3].map((i) => ({ name: `t${i}`, weapon: 'garand', x: 140.5, y: 7.5 + i * 2 })));
    for (let i = 0; i < 30 * 45; i++) sim.step();
    const pinnedOrWorse = sim.soldiers.filter(
      (s) => s.side === 'red' && s.alive && !s.downed && (s.mental === 'pinned' || s.mental === 'broken'),
    );
    const suppressed = sim.soldiers.filter((s) => s.side === 'red' && s.alive && s.suppression > 0.3);
    expect(pinnedOrWorse.length + suppressed.length).toBeGreaterThan(0);
  });

  it('broken men flee away from the enemy and ignore orders', () => {
    const map = new GameMap(80, 20);
    const sim = new Sim(map, 4);
    sim.addSquad('blue', 'A', [{ name: 'a', weapon: 'garand', x: 40.5, y: 10.5 }]);
    sim.addSquad('red', 'B', [{ name: 'b', weapon: 'garand', x: 20.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    s.morale = 0.1; // broken
    for (let i = 0; i < 30 * 10; i++) sim.step();
    expect(s.mental).toBe('broken');
    expect(s.x).toBeGreaterThan(41); // fled east, away from the enemy in the west
    const beforeOrder = s.x;
    sim.orderMove(0, 20, 10); // order him toward the enemy — refused
    expect(s.path === null || s.fleeing).toBe(true);
    for (let i = 0; i < 30 * 5; i++) sim.step();
    expect(s.x).toBeGreaterThanOrEqual(beforeOrder - 1);
  });

  it('suppression decays and morale recovers when the fire stops', () => {
    const map = new GameMap(20, 20);
    const sim = new Sim(map, 5);
    sim.addSquad('blue', 'A', [{ name: 'a', weapon: 'garand', x: 10.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    s.suppression = 0.9;
    s.morale = 0.4;
    for (let i = 0; i < 30 * 60; i++) sim.step();
    expect(s.suppression).toBeLessThan(0.1);
    expect(s.morale).toBeGreaterThan(0.4);
  });
});
