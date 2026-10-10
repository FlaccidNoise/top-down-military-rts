// warsweep-v2 (S58, design §4.7): the V2 stack at scale — procedural
// theaters, disposition, goal-driven Commander2 on BOTH sides, all-coarse
// resolution through the same headless loop the reload pin runs.
//
//   npx vite-node scripts/warsweep2.mjs                       # 16-seed table
//   npx vite-node scripts/warsweep2.mjs -- --seeds 32
//   npx vite-node scripts/warsweep2.mjs -- --recon contacts   # the FOW arm
//   npx vite-node scripts/warsweep2.mjs -- --blue-odds 0.25   # doctrine candidate
//   npx vite-node scripts/warsweep2.mjs -- --gate             # non-zero exit on gate failure
//
// Measured baseline (V2 playable core, 2026-07-27): red retook >= 1 objective
// on 7/8 seeds; V1 grid baseline ZERO on every seed. Gates (--gate): 100%
// termination, both winners occur, > 1 distinct tuple, red retakes on a
// majority of seeds. Prints `PIN seed N {status, day, logLen}` — the source
// line tests/war-pin.test.ts is refrozen from (S59).
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeHeadlessWorld, runHeadlessWar } from '../src/strategic/headless';
import { BLUE_V2, RED_V2 } from '../src/strategic/planner';
import { forceById } from '../src/strategic/theater/war';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const SEEDS = Number(arg('seeds', 16));
const RECON = arg('recon', DEFAULT_PRESET.campaign.recon);
const BLUE_ODDS = arg('blue-odds', null);
const RED_ODDS = arg('red-odds', null);
const GATE = has('gate');

const CAMP = { ...DEFAULT_PRESET.campaign, recon: RECON };
const doctrines = {};
if (BLUE_ODDS !== null) doctrines.blue = { ...BLUE_V2, attackOdds: Number(BLUE_ODDS) };
if (RED_ODDS !== null) doctrines.red = { ...RED_V2, attackOdds: Number(RED_ODDS) };

const runWar = (seed) => {
  const w = makeHeadlessWorld(seed, DEFAULT_PRESET.theater, CAMP, undefined, doctrines);
  const objectives = [...w.front.theater.objectiveNodes];
  const wasBlue = new Set(); // objectives blue held at any point
  let redRetakes = 0; // blue-held objective flipped back to red
  let redAttacks = 0;
  let battles = 0;
  const stallMin = {};
  const redOrders = {}; // why -> forces given that order (a re-issue to the same node counts once)
  const lastOrder = new Map();
  const commitSamples = [];
  let knownBattles = new Set();

  const run = runHeadlessWar(w, 60 * 24 * 45, (r, world) => {
    battles += r.resolved.length;
    // New battles this minute: initiated by whichever side attacks.
    for (const b of world.front.battles) {
      if (knownBattles.has(b.id)) continue;
      knownBattles.add(b.id);
      if (forceById(world.front, b.attackerId).side === 'red') redAttacks++;
    }
    // Objective control watch: blue gain, then any red re-take of it.
    for (const n of objectives) {
      const owner = world.front.controlByNode[n];
      if (owner === 'blue') wasBlue.add(n);
      else if (owner === 'red' && wasBlue.has(n)) {
        wasBlue.delete(n);
        redRetakes++;
      }
    }
    for (const o of world.lastRedReport?.orders ?? []) {
      if (lastOrder.get(o.forceId) === `${o.why}:${o.dest}`) continue;
      lastOrder.set(o.forceId, `${o.why}:${o.dest}`);
      redOrders[o.why] = (redOrders[o.why] ?? 0) + 1;
    }
    if (world.lastRedReport?.stall) {
      stallMin[world.lastRedReport.stall] = (stallMin[world.lastRedReport.stall] ?? 0) + RED_V2.evalMinutes;
    }
    // committedFrac sample per red eval: axis-assigned strength / mobile strength.
    if (world.lastRedReport && world.red.plan) {
      const mobiles = world.front.forces.filter((f) => f.side === 'red' && f.role !== 'garrison' && f.strength > 0);
      const assigned = new Set(world.red.plan.axes.flatMap((a) => a.assigned));
      const tot = mobiles.reduce((a, f) => a + f.strength, 0);
      const com = mobiles.filter((f) => assigned.has(f.id)).reduce((a, f) => a + f.strength, 0);
      if (tot > 0) commitSamples.push(com / tot);
    }
  });

  const days = w.front.day;
  const status = run.status.state === 'decided' ? (run.status.winner === 'blue' ? 'won' : 'lost') : 'HUNG';
  const committedFrac = commitSamples.length > 0 ? commitSamples.reduce((a, x) => a + x, 0) / commitSamples.length : 0;
  return {
    seed,
    status,
    reason: run.status.state === 'decided' ? run.status.reason : 'minute cap',
    day: days,
    logLen: run.logLen,
    battles,
    redAttacks,
    attacksPerDay: redAttacks / Math.max(1, days),
    redRetakes,
    committedFrac,
    stallMin,
    redOrders,
    blueDestroyed: status === 'lost' && days <= CAMP.warDays,
    minutes: run.minutes,
  };
};

console.log(`warsweep-v2: seeds 1..${SEEDS} · recon ${RECON}` +
  (doctrines.blue ? ` · blue attackOdds ${doctrines.blue.attackOdds}` : '') +
  (doctrines.red ? ` · red attackOdds ${doctrines.red.attackOdds}` : ''));
console.log('seed  result  day  logLen  battles  redAtk  atk/day  retakes  commit%  stall(red)');
const rows = [];
for (let s = 1; s <= SEEDS; s++) {
  const r = runWar(s);
  rows.push(r);
  const stall = Object.entries(r.stallMin).map(([k, v]) => `${k}:${v}`).join(',') || '-';
  console.log(
    `${String(r.seed).padStart(4)}  ${r.status.padEnd(6)}  ${String(r.day).padStart(3)}  ${String(r.logLen).padStart(6)}  ` +
    `${String(r.battles).padStart(7)}  ${String(r.redAttacks).padStart(6)}  ${r.attacksPerDay.toFixed(2).padStart(7)}  ` +
    `${String(r.redRetakes).padStart(7)}  ${(r.committedFrac * 100).toFixed(0).padStart(6)}%  ${stall}`,
  );
}
for (const r of rows) console.log(`PIN seed ${r.seed} {status: '${r.status}', day: ${r.day}, logLen: ${r.logLen}}`);

const won = rows.filter((r) => r.status === 'won').length;
const hung = rows.filter((r) => r.status === 'HUNG').length;
const retakeSeeds = rows.filter((r) => r.redRetakes > 0).length;
const daysSorted = rows.map((r) => r.day).sort((a, b) => a - b);
const tuples = new Set(rows.map((r) => `${r.status}:${r.day}:${r.logLen}`));
const meanAtk = rows.reduce((a, r) => a + r.attacksPerDay, 0) / rows.length;
const meanCommit = rows.reduce((a, r) => a + r.committedFrac, 0) / rows.length;
const destroyed = rows.filter((r) => r.blueDestroyed).map((r) => r.seed);
const orderTotals = {};
for (const r of rows) for (const [k, v] of Object.entries(r.redOrders)) orderTotals[k] = (orderTotals[k] ?? 0) + v;
console.log(`red orders: ${Object.entries(orderTotals).sort().map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`AI blue destroyed before the deadline on ${destroyed.length}/${rows.length} seeds${destroyed.length ? ` (${destroyed.join(', ')})` : ''}`);
console.log(
  `summary: blue wins ${won}/${rows.length} (${((won / rows.length) * 100).toFixed(0)}%) · hung ${hung} · ` +
  `days min/med/max ${daysSorted[0]}/${daysSorted[daysSorted.length >> 1]}/${daysSorted[daysSorted.length - 1]} · ` +
  `red atk/day mean ${meanAtk.toFixed(2)} · red retakes on ${retakeSeeds}/${rows.length} seeds · commit mean ${(meanCommit * 100).toFixed(0)}%`,
);

if (GATE) {
  const failures = [];
  if (hung > 0) failures.push(`${hung} wars hit the minute cap (termination gate)`);
  if (won === 0 || won === rows.length) failures.push('single-winner outcome set (variety gate)');
  if (tuples.size <= 1) failures.push('one distinct tuple (variety gate)');
  if (retakeSeeds * 2 <= rows.length) failures.push(`red retook objectives on only ${retakeSeeds}/${rows.length} seeds (aggression gate)`);
  if (failures.length > 0) {
    console.error('GATE FAILURES:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('gates: all green');
}
