// PRE_RELIEF row printer (docs/plans/2026-07-27-mapgen-v3-design.md §3).
//
// The table at tests/relief-wiring.test.ts:33-41 is plain literals on purpose —
// "an `-u` run must not be able to launder a regression into a new baseline" —
// so a kind whose geometry is MEANT to move recaptures its row here and pastes
// it in by hand. Output is the literal row, ready to paste:
//
//   npx vite-node scripts/fp.mjs                     # every kind, seeds 1-8
//   npx vite-node scripts/fp.mjs -- --kind road      # one row
//   npx vite-node scripts/fp.mjs -- --kind open,road # two
//
// A row printed here for a kind nobody meant to change must equal the committed
// literal exactly. That round-trip is the test of this script.
import { generateMap } from '../src/sim/mapgen';

const KINDS = ['open', 'road', 'woods', 'town', 'river', 'bridge', 'bourg'];
const W = 320;
const H = 240;
const SEEDS = 8;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
};

// FNV-1a over the raw arrays, byte-for-byte the function in tests/mapgen.test.ts,
// tests/bourg.test.ts and tests/relief-wiring.test.ts.
function fingerprint(plan) {
  const { map } = plan;
  let h = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges, map.elev, map.stories, map.buildingId, map.stairs]) {
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

const only = arg('kind');
for (const kind of only ? only.split(',') : KINDS) {
  const row = [];
  for (let seed = 1; seed <= SEEDS; seed++)
    row.push(`'${fingerprint(generateMap(seed, W, H, kind, { relief: 'none' }))}'`);
  console.log(`  ${kind}: [${row.join(', ')}],`);
}
