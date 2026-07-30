import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Cap fork workers: uncapped fan-out on this 12-core box ballooned to ~24GB
    // across ~10 node processes and triggered a system-wide jetsam (2026-07-29).
    maxWorkers: 3,
    poolOptions: { forks: { execArgv: ['--max-old-space-size=1024'] } },
    // Mapgen integration tests regenerate full 320x240 maps per case and now
    // run 8-13s each after the V4 noise/relief work; the 5s default timed them
    // out under parallel workers while passing standalone (2026-07-28).
    testTimeout: 30000,
  },
});
