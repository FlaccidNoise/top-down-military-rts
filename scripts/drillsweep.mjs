// Drill sweep, headless: is the training battle winnable by following its
// steps, and safe for a player who stops after the second one?
//
//   npx vite-node scripts/drillsweep.mjs -- [--seeds 100] [--start 1] [--cap-min 10] [--verbose]
//
// The players are tests/drill-bot.ts, the same policies the unit gate
// (tests/drill.test.ts) runs on 20 seeds. This is the wide version, for after a
// balance pass: it prints one line per player and exits 1 if the follower
// fails to win a seed, the idler loses one, or the start line is under fire.
import { follower, idler, sitter } from '../tests/drill-bot';

const argN = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const SEEDS = argN('seeds', 100);
const START = argN('start', 1);
const CAP_MIN = argN('cap-min', 10);
const VERBOSE = process.argv.includes('--verbose');

const f = [];
const id = [];
const sit = [];
for (let s = START; s < START + SEEDS; s++) {
  f.push(follower(s, CAP_MIN));
  id.push(idler(s, CAP_MIN));
  sit.push(sitter(s));
}
if (VERBOSE) {
  for (const r of f) console.log('follow', JSON.stringify(r));
  for (const r of id) console.log('idle  ', JSON.stringify(r));
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const count = (a, w) => a.filter((r) => r.winner === w).length;
console.log(
  `follower, seeds ${START}..${START + SEEDS - 1}: blue wins ${count(f, 'blue')}/${SEEDS}, red wins ${count(f, 'red')}, undecided ${count(f, null)}. ` +
    `Median ${med(f.map((r) => r.secs))} s of battle (max ${Math.max(...f.map((r) => r.secs))}). ` +
    `Blue left: median ${med(f.map((r) => r.blue))} of ${f[0].blueStart}, worst ${Math.min(...f.map((r) => r.blue))}. First squad left: worst ${Math.min(...f.map((r) => r.lead))}. ` +
    `Enemy seen at median ${med(f.map((r) => r.seenAt)).toFixed(0)} s (max ${Math.max(...f.map((r) => r.seenAt)).toFixed(0)}). ` +
    `House quiet median ${med(f.map((r) => r.quietAfter)).toFixed(0)} s after Fire (max ${Math.max(...f.map((r) => r.quietAfter)).toFixed(0)}, never in ${f.filter((r) => r.quietAfter < 0).length}). ` +
    `Recovery step used in ${f.filter((r) => r.recoveries > 0).length} runs.`,
);
console.log(
  `idler (steps 1-2, then nothing for ${CAP_MIN} min): red wins ${count(id, 'red')}/${SEEDS}, blue wins ${count(id, 'blue')}, undecided ${count(id, null)}. ` +
    `Blue left: median ${med(id.map((r) => r.blue))} of ${id[0].blueStart}, worst ${Math.min(...id.map((r) => r.blue))}.`,
);
console.log(`sitter (no order, 2 min): either side sees the other in ${sit.filter((r) => r.seenAt >= 0).length}/${SEEDS} runs, blue losses worst ${Math.max(...sit.map((r) => r.blueStart - r.blue))}.`);
const bad = [
  ...f.filter((r) => r.winner !== 'blue').map((r) => `follower seed ${r.seed}: ${r.winner ?? 'undecided'}`),
  ...id.filter((r) => r.winner === 'red').map((r) => `idler seed ${r.seed}: lost`),
  ...sit.filter((r) => r.seenAt >= 0).map((r) => `sitter seed ${r.seed}: contact at ${r.seenAt.toFixed(0)} s with nobody ordered anywhere`),
];
if (bad.length) {
  console.error(`${bad.length} FAILED:\n${bad.map((b) => `  - ${b}`).join('\n')}\nRe-run one with --start N --seeds 1 --verbose. The drill is authored in src/drill.ts: tune the ground and the forces there, never the sim.`);
  process.exit(1);
}
console.log('drill sweep passed');
