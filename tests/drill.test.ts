import { describe, expect, it } from 'vitest';
import { DRILL_DEFENDERS, DRILL_MAP, enemiesInSight, hasRefused, houseIsQuiet, makeDrill, wouldAssault } from '../src/drill';
import { BREAK_FLOOR_MIN } from '../src/ui/battle-goal';
import { follower, idler, sitter } from './drill-bot';

// Three seeds here, in the quick tier. tests/drill-sweep.test.ts runs twenty.
const SEEDS = [1, 2, 3];

describe('the drill as staged', () => {
  it('is one platoon against the garrison, on a small map', () => {
    const d = makeDrill(1);
    const squads = d.sim.squads.filter((q) => q.side === 'blue');
    expect(d.rifles).toHaveLength(3);
    expect(squads).toHaveLength(4);
    expect(d.rifles).toContain(d.lead);
    expect(d.sim.startStrength.red).toBe(DRILL_DEFENDERS);
    expect(d.sim.map.w).toBe(DRILL_MAP.w);
    expect(d.sim.map.h).toBe(DRILL_MAP.h);
    // A garrison this small must still be a fight: it breaks only at the floor.
    expect(DRILL_DEFENDERS).toBeGreaterThan(BREAK_FLOOR_MIN * 2);
  });

  it('has nothing to call in, and no campaign soldier in it', () => {
    const { sim } = makeDrill(1);
    expect(sim.barragesLeft.blue).toBe(0);
    expect(sim.airstrikesLeft.blue).toBe(0);
    expect(sim.barragesLeft.red).toBe(0);
    expect(sim.soldiers.every((s) => s.pid === undefined || s.pid < 0)).toBe(true);
  });

  it('is the same ground and the same forces on every seed', () => {
    const a = makeDrill(1);
    const b = makeDrill(99);
    const ground = (d: typeof a): string => {
      let out = '';
      for (let y = 0; y < d.sim.map.h; y++) for (let x = 0; x < d.sim.map.w; x++) out += d.sim.map.terrainKeyAt(x, y)[0];
      return out;
    };
    const forces = (d: typeof a): string => d.sim.soldiers.map((s) => `${s.side}:${s.weapon}:${s.squadId}`).join('|');
    expect(ground(a)).toBe(ground(b));
    expect(forces(a)).toBe(forces(b));
    expect(a.hedge).toEqual(b.hedge);
    expect(a.house).toEqual(b.house);
  });

  it('opens with nobody in sight and nobody refusing', () => {
    const d = makeDrill(1);
    expect(enemiesInSight(d.sim)).toEqual([]);
    for (const q of d.rifles) {
      expect(hasRefused(d.sim, q)).toBe(false);
      expect(wouldAssault(d, q)).toBe(true);
    }
  });
});

describe('the drill as played', () => {
  const followed = SEEDS.map((s) => follower(s));

  it('is won by a player who follows the steps', () => {
    expect(followed.filter((r) => r.winner !== 'blue').map((r) => `seed ${r.seed}: ${r.winner ?? 'undecided'}`)).toEqual([]);
  });

  it('shows the enemy soon after the first order, and never before it', () => {
    for (const r of followed) {
      expect(r.seenAt, `seed ${r.seed}`).toBeGreaterThan(0);
      expect(r.seenAt, `seed ${r.seed}`).toBeLessThan(30);
    }
    expect(sitter(1, 30).seenAt, 'contact with nobody ordered anywhere').toBe(-1);
  });

  it('reaches the quiet house the assault step waits for', () => {
    for (const r of followed) expect(r.quietAfter, `seed ${r.seed}`).toBeGreaterThanOrEqual(0);
  });

  it('costs the platoon little', () => {
    for (const r of followed) expect(r.blue, `seed ${r.seed}`).toBeGreaterThanOrEqual(Math.ceil(r.blueStart * 0.75));
  });

  it('is not lost by a player who gives the first order and then nothing', () => {
    const idle = SEEDS.map((s) => idler(s, 1.5));
    expect(idle.filter((r) => r.winner === 'red').map((r) => `seed ${r.seed}`)).toEqual([]);
    for (const r of idle) expect(r.blue, `seed ${r.seed}`).toBeGreaterThanOrEqual(Math.ceil(r.blueStart * 0.75));
  });
});

describe('houseIsQuiet', () => {
  it('is false while a defender has a line to the platoon', () => {
    const d = makeDrill(3);
    d.sim.orderSquad(d.lead, { kind: 'move', x: d.hedge.x, y: d.hedge.y });
    const other = d.rifles.find((q) => q !== d.lead)!;
    let sawContact = false;
    for (let i = 0; i < 30 * 60 && !sawContact; i++) {
      d.sim.step();
      if (enemiesInSight(d.sim).length > 0) sawContact = true;
    }
    expect(sawContact).toBe(true);
    expect(houseIsQuiet(d, other)).toBe(false);
  });
});
