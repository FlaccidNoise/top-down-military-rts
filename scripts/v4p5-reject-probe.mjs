#!/usr/bin/env npx vite-node
/**
 * V4-P5 reject-rate probe: planBourg → stampBourg → buildObjectives → validate()
 * Replicates perf.test.ts's full rejection pipeline.
 */
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { buildObjectives } from '../src/sim/bourg/objectives';
import { BOURG, OPEN, ROAD, WOODS, RIVER, BRIDGE } from '../src/sim/bourg/profile';
import { generateHeightField } from '../src/sim/bourg/height';
import { subStream, TAG } from '../src/sim/bourg/streets';
import { mulberry32 } from '../src/sim/rng';
import { GameMap } from '../src/sim/map';
import { validate } from '../src/sim/mapgen';

const W = 320, H = 240;
const KINDS = [
  { name: 'open', profile: OPEN },
  { name: 'road', profile: ROAD },
  { name: 'woods', profile: WOODS },
  { name: 'river', profile: RIVER },
  { name: 'bridge', profile: BRIDGE },
  { name: 'bourg', profile: BOURG },
];
const SEEDS = 30;

console.log('=== V4-P5 REJECT RATES (30 seeds, full pipeline) ===');

for (const { name, profile } of KINDS) {
  let rejects = 0, floorHits = 0, noDeck = 0;
  const rejectedSeeds = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
    const heightRng = subStream(base, TAG.HEIGHT);
    const heightSeed = heightRng.int(0x7fffffff);
    const height = generateHeightField(heightSeed, W, H, profile.height.amp);
    const plan = planBourg(base, W, H, profile, height);
    if (plan.fp.buildings.length < profile.minBuildings) {
      floorHits++; rejects++; rejectedSeeds.push(seed); continue;
    }
    const map = new GameMap(W, H);
    const st = stampBourg(map, plan);
    map.maxStories = st.maxStories;
    const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
    const ok = validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands });
    if (!ok) { rejects++; rejectedSeeds.push(seed); }
  }
  const rate = rejects / SEEDS;
  const limit = 0.18;
  console.log(`  ${name}: ${rejects}/${SEEDS}=${(rate*100).toFixed(1)}% (floor=${floorHits}) ${rate>limit?'EXCEEDS ✗':'OK ✓'} ${rejectedSeeds.length>0?'seeds:'+rejectedSeeds.join(','):''}`);
}

// Also check: the bourg-reject test's attempt0 parity
console.log('\n=== BOURG ATTEMPT-0 PARITY (seeds 1,7) ===');
import { generateMap } from '../src/sim/mapgen';
for (const seed of [1, 7]) {
  const gm = generateMap(seed, W, H, 'bourg', { relief: 'none' });
  const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
  const heightRng = subStream(base, TAG.HEIGHT);
  const heightSeed = heightRng.int(0x7fffffff);
  const height = generateHeightField(heightSeed, W, H, BOURG.height.amp);
  const plan = planBourg(base, W, H, BOURG, height);
  const map = new GameMap(W, H);
  const st = stampBourg(map, plan);
  map.maxStories = st.maxStories;
  const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
  const a0 = { map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands };
  const match = JSON.stringify(a0.buildings.map(b => ({ x: b.x, y: b.y, w: b.w, d: b.d, stories: b.stories })))
    === JSON.stringify(gm.buildings.map(b => ({ x: b.x, y: b.y, w: b.w, d: b.d, stories: b.stories })));
  console.log(`  seed ${seed}: attempt0 == generateMap(relief:none): ${match ? '✓' : '✗'}`);
  if (!match) {
    console.log(`    attempt0 buildings: ${a0.buildings.length}, generateMap: ${gm.buildings.length}`);
  }
}