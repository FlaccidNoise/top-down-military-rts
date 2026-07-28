// Standalone theater generation perf — the 30ms mean / 80ms max TARGET over
// 200 seeds (§2 gate). Run on a QUIET machine; the CI assert lives in
// tests/theater-perf.test.ts at 66/180 and must never be tightened to the
// target (harness load flakes it — the bourg lesson).
import { makeTheater } from '../src/strategic/theatergen/index.ts';

const CFG = { sizeKm: 24, riverDensity: 2, crossingScarcity: 1, roadDensity: 2, railDensity: 1, townDensity: 1, townSpacingMinKm: 5, terrainMix: 'bocage', woodsShare: 2 };
const times = [];
for (let seed = 1; seed <= 200; seed++) {
  const t0 = performance.now();
  makeTheater(seed, CFG);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / times.length;
console.log(`theater-gen over 200 seeds: mean ${mean.toFixed(1)}ms (target 30), max ${times[times.length - 1].toFixed(1)}ms (target 80), p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)}ms`);
console.log(mean <= 30 && times[times.length - 1] <= 80 ? 'TARGET MET' : 'TARGET MISSED — investigate before landing a generator change');
