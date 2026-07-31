import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Dev-loop suite: excludes files measured >5s (2026-07-31, npx vitest run
// --reporter=json). These stay in the full suite via `npm test`.
const SLOW = [
  'tests/doctrine.test.ts', // 112s — commander soak sims, 6k-80k ticks
  'tests/perf.test.ts', // 64s
  'tests/bourg.test.ts', // 36s — full 320x240 map regen per case
  'tests/strategic-command.test.ts', // 12s
  'tests/sim.test.ts', // 12s
  'tests/enclos.test.ts', // 11s
  'tests/mapgen.test.ts', // 11s
  'tests/patches.test.ts', // 10s
  'tests/relief-wiring.test.ts', // 9s
  'tests/yard-overlap.test.ts', // 7s
];

export default mergeConfig(
  base,
  defineConfig({
    test: { exclude: ['**/node_modules/**', ...SLOW] },
  }),
);
