// The drill's proof, on twenty seeds: a player who follows the steps wins, and
// a player who gives the first order and then nothing does not lose. SLOW tier
// (vitest.quick.config.ts). tests/drill.test.ts keeps three seeds in the quick
// tier, and scripts/drillsweep.mjs runs the same players on any number.
import { describe, expect, it } from 'vitest';
import { follower, idler, sitter } from './drill-bot';

// Four batches of five: one synchronous test that steps a sim for a minute of
// wall time starves the worker's reporter and vitest fails the run for it.
const BATCHES = [0, 1, 2, 3].map((b) => Array.from({ length: 5 }, (_, i) => b * 5 + i + 1));
const IDLE_MIN = 3; // the sweep script idles for ten
const TIMEOUT_MS = 60_000;

describe.each(BATCHES)('the drill, seeds %i to +4', (...seeds) => {
  it('is won by following the steps, at little cost', () => {
    const runs = seeds.map((s) => follower(s));
    expect(runs.filter((r) => r.winner !== 'blue').map((r) => `seed ${r.seed}: ${r.winner ?? 'undecided'}`)).toEqual([]);
    for (const r of runs) {
      expect(r.seenAt, `seed ${r.seed}: enemy seen`).toBeGreaterThan(0);
      expect(r.seenAt, `seed ${r.seed}: enemy seen`).toBeLessThan(30);
      expect(r.quietAfter, `seed ${r.seed}: the house never went quiet`).toBeGreaterThanOrEqual(0);
      expect(r.blue, `seed ${r.seed}: platoon left`).toBeGreaterThanOrEqual(Math.ceil(r.blueStart * 0.75));
    }
  }, TIMEOUT_MS);

  it('is not lost by giving the first order and then nothing', () => {
    const runs = seeds.map((s) => idler(s, IDLE_MIN));
    expect(runs.filter((r) => r.winner === 'red').map((r) => `seed ${r.seed}`)).toEqual([]);
    for (const r of runs) expect(r.blue, `seed ${r.seed}: platoon left`).toBeGreaterThanOrEqual(Math.ceil(r.blueStart * 0.75));
  }, TIMEOUT_MS);

  it('starts out of sight: a minute with no order is a minute of nothing', () => {
    for (const s of seeds) {
      const r = sitter(s, 60);
      expect(r.seenAt, `seed ${s}: contact`).toBe(-1);
      expect(r.blue, `seed ${s}`).toBe(r.blueStart);
    }
  }, TIMEOUT_MS);
});
