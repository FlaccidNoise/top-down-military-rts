import { describe, expect, it } from 'vitest';
import { makeTheater } from '../src/strategic/theatergen';

// CI ASSERT at 66/180 — deliberately 2.2x the 30/80 TARGET, because the
// suite runs under harness load and a tightened budget flakes (the bourg
// mapgen lesson: 39-45ms against a 40ms budget). Do NOT tighten this to the
// target; scripts/theaterperf.mjs measures the target on a quiet machine.
const CFG = { sizeKm: 24, riverDensity: 2, crossingScarcity: 1, roadDensity: 2, railDensity: 1, townDensity: 1, townSpacingMinKm: 5, terrainMix: 'bocage', woodsShare: 2 } as const;

describe('theater generation perf (CI band)', () => {
  it('stays inside 66ms mean / 180ms max over 24 seeds, min-of-3-reps', () => {
    const times: number[] = [];
    for (let seed = 1; seed <= 24; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        makeTheater(seed, CFG);
        best = Math.min(best, performance.now() - t0);
      }
      times.push(best);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    expect(mean).toBeLessThanOrEqual(66);
    expect(Math.max(...times)).toBeLessThanOrEqual(180);
  });
});
