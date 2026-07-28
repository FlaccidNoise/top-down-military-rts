// Per-seed measurements of the whole bourg pipeline (T7-T10), for tuning and
// for the numbers §5.2/§5.5 assert against. Run with:
//   npx vite-node scripts/bourg-survey.mjs -- [--seeds 20] [--w 320] [--h 240]
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { BOURG } from '../src/sim/bourg/profile';
import { buildObjectives } from '../src/sim/bourg/objectives';
import { GameMap } from '../src/sim/map';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const N = arg('seeds', 20);
const W = arg('w', 320);
const H = arg('h', 240);
const base = (s) => (s * 0x9e3779b1) >>> 1;

const cols = { bld: [], terrace: [], obj: [], walls: [], gates: [], span: [], lanes: [], hedge: [], stands: [], ms: [] };
for (let s = 1; s <= N; s++) {
  const t0 = performance.now();
  const plan = planBourg(base(s), W, H, BOURG);
  const map = new GameMap(W, H);
  const st = stampBourg(map, plan);
  map.maxStories = st.maxStories;
  const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
  const ms = performance.now() - t0;
  const chains = new Map();
  for (const b of plan.fp.buildings)
    if (b.terraceRun !== undefined) chains.set(b.terraceRun, (chains.get(b.terraceRun) ?? 0) + 1);
  let hedge = 0;
  for (let i = 0; i < W * H; i++) if (map.terrainKeyAt(i % W, (i / W) | 0) === 'hedge') hedge++;
  const row = {
    bld: plan.fp.buildings.length,
    terrace: Math.max(0, ...chains.values()),
    obj: objectives.length,
    walls: st.enclosures.walls,
    gates: st.enclosures.gates,
    span: st.enclosures.rearSpanQ8,
    lanes: plan.rural.lanes,
    hedge,
    stands: st.woodsStands.length,
    ms: Math.round(ms * 10) / 10,
  };
  for (const k of Object.keys(cols)) cols[k].push(row[k]);
  console.log(
    `seed ${String(s).padStart(3)} ${plan.sk.archetype.padEnd(9)} ` +
      Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' ') +
      ` orphans=${st.enclosures.orphans} kinds=${objectiveKinds.join(',')}`,
  );
}
console.log('---');
for (const [k, v] of Object.entries(cols)) {
  const sorted = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.log(`${k.padEnd(8)} min=${sorted[0]} med=${sorted[v.length >> 1]} max=${sorted[v.length - 1]} mean=${mean.toFixed(1)}`);
}
