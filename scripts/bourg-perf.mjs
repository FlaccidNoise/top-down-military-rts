// End-to-end bourg measurements through generateMap: the reject rate §2.2
// gates at 5 %, the mean/max §5.5 asserts, and a per-attempt cost breakdown.
// The survey script (scripts/bourg-survey.mjs) measures the PIPELINE; this one
// measures what bridge.ts:135 actually pays, i.e. including validate, the
// elevation pass and every rerolled attempt.
//
//   npx vite-node scripts/bourg-perf.mjs -- [--seeds 200] [--w 320] [--h 240]
//                                          [--kinds] [--stages]
import { generateMap, validate } from '../src/sim/mapgen';
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { buildObjectives } from '../src/sim/bourg/objectives';
import { GameMap } from '../src/sim/map';
import { mulberry32 } from '../src/sim/rng';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const N = arg('seeds', 200);
const W = arg('w', 320);
const H = arg('h', 240);

const stat = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { min: s[0], med: s[s.length >> 1], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1], mean };
};
const fmt = (s) => `min=${s.min.toFixed(1)} med=${s.med.toFixed(1)} mean=${s.mean.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`;

// ── first-attempt reject rate ────────────────────────────────────────────────
// Reproduces generateMap's attempt-0 rng exactly (mapgen.ts:131) and asks only
// whether that first plan validated. A reject is invisible from outside —
// generateMap just costs twice as much — so it has to be measured here.
function attempt0(seed) {
  const rng = mulberry32((seed ^ 0x51ab3fc7) + 0 * 0x9e3779b9);
  const base = rng.int(0x7fffffff);
  const t0 = performance.now();
  const plan = planBourg(base, W, H);
  const t1 = performance.now();
  const map = new GameMap(W, H);
  const st = stampBourg(map, plan);
  map.maxStories = st.maxStories;
  const t2 = performance.now();
  const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
  const t3 = performance.now();
  const ok = validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands });
  const t4 = performance.now();
  return { ok, plan: t1 - t0, stamp: t2 - t1, obj: t3 - t2, val: t4 - t3, buildings: plan.fp.buildings.length };
}

// warm the JIT: the first seed of a cold process runs ~5x the steady-state cost
for (let s = -4; s <= 0; s++) attempt0(s + 1000);

let rejects = 0;
const cols = { plan: [], stamp: [], obj: [], val: [], total: [], full: [] };
const rejectSeeds = [];
for (let s = 1; s <= N; s++) {
  const a = attempt0(s);
  if (!a.ok) {
    rejects++;
    rejectSeeds.push(s);
  }
  cols.plan.push(a.plan);
  cols.stamp.push(a.stamp);
  cols.obj.push(a.obj);
  cols.val.push(a.val);
  cols.total.push(a.plan + a.stamp + a.obj + a.val);
  const t = performance.now();
  generateMap(s, W, H, 'bourg');
  cols.full.push(performance.now() - t);
}

console.log(`bourg ${W}x${H}, ${N} seeds`);
for (const [k, v] of Object.entries(cols)) console.log(`  ${k.padEnd(6)} ${fmt(stat(v))}`);
console.log(`  reject rate (attempt 0): ${rejects}/${N} = ${((100 * rejects) / N).toFixed(2)}%${rejectSeeds.length ? ` seeds=${rejectSeeds.join(',')}` : ''}`);

if (has('kinds')) {
  console.log('\nlegacy kinds (T1 flood-fill gate regression, §5.5):');
  for (const kind of ['open', 'woods', 'town', 'river', 'bridge', 'road']) {
    const v = [];
    for (let s = 1; s <= 20; s++) {
      const t = performance.now();
      generateMap(s, W, H, kind);
      v.push(performance.now() - t);
    }
    console.log(`  ${kind.padEnd(7)} ${fmt(stat(v))}`);
  }
}
