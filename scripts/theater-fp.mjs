// Theater fingerprint rows — hand-pasteable, the PRE_RELIEF discipline: when
// a pin moves WITH a THEATER_VERSION bump, paste the new rows; a move
// without a bump is the tripwire firing (never launder with -u).
//   npx vite-node scripts/theater-fp.mjs               # seeds 1-3, default cfg
//   npx vite-node scripts/theater-fp.mjs -- --seeds 8
import { makeTheater } from '../src/strategic/theatergen/index.ts';
import { perFieldFingerprint, theaterFingerprint } from '../src/strategic/theater/fingerprint.ts';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const SEEDS = arg('seeds', 3);
const CFG = { sizeKm: 24, riverDensity: 2, crossingScarcity: 1, roadDensity: 2, railDensity: 1, townDensity: 1, townSpacingMinKm: 5, terrainMix: 'bocage', woodsShare: 2 };

for (let seed = 1; seed <= SEEDS; seed++) {
  const { theater } = makeTheater(seed, CFG);
  const f = perFieldFingerprint(theater);
  console.log(`  [${seed}, ${theaterFingerprint(theater)}], // ${theater.name} — ${Object.entries(f).map(([k, v]) => `${k}:${v}`).join(' ')}`);
}
