#!/usr/bin/env npx vite-node
/**
 * Compare water-kind rejection rates: zero-height vs real-height planBourg.
 * The perf test currently passes zero height; generateMap passes real height.
 */
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { buildObjectives } from '../src/sim/bourg/objectives';
import { RIVER, BRIDGE } from '../src/sim/bourg/profile';
import { generateHeightField } from '../src/sim/bourg/height';
import { subStream, TAG } from '../src/sim/bourg/streets';
import { mulberry32 } from '../src/sim/rng';
import { GameMap } from '../src/sim/map';
import { validate } from '../src/sim/mapgen';

const W = 320, H = 240, N = 60;

function measure(name, profile, useRealHeight) {
  let rejects = 0, floorHits = 0, noDeck = 0;
  const rejected = [];
  for (let seed = 1; seed <= N; seed++) {
    const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
    let height;
    if (useRealHeight) {
      const hrng = subStream(base, TAG.HEIGHT);
      height = generateHeightField(hrng.int(0x7fffffff), W, H, profile.height.amp);
    } else {
      height = new Uint8Array(W * H);
    }
    const plan = planBourg(base, W, H, profile, height);
    if (plan.fp.buildings.length < profile.minBuildings) { floorHits++; rejects++; rejected.push(seed); continue; }
    const map = new GameMap(W, H);
    const st = stampBourg(map, plan);
    map.maxStories = st.maxStories;
    if (!st.crossing) { noDeck++; rejects++; rejected.push(seed); continue; }
    const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
    objectives.push(st.crossing);
    objectiveKinds.push('bridge');
    if (!validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands })) {
      rejects++; rejected.push(seed);
    }
  }
  console.log(`  ${name} (${useRealHeight?'real':'zero'} height): ${rejects}/${N}=${(rejects/N*100).toFixed(1)}% floor=${floorHits} noDeck=${noDeck} seeds=[${rejected.join(',')}]`);
  return { rejects, rate: rejects / N };
}

console.log('=== WATER-KIND REJECT RATE COMPARISON (60 seeds) ===');
const rZero = measure('river', RIVER, false);
const rReal = measure('river', RIVER, true);
const bZero = measure('bridge', BRIDGE, false);
const bReal = measure('bridge', BRIDGE, true);

console.log(`\n  River delta: ${(rZero.rate*100).toFixed(1)}% → ${(rReal.rate*100).toFixed(1)}% (Δ=${((rReal.rate-rZero.rate)*100).toFixed(1)}pp)`);
console.log(`  Bridge delta: ${(bZero.rate*100).toFixed(1)}% → ${(bReal.rate*100).toFixed(1)}% (Δ=${((bReal.rate-bZero.rate)*100).toFixed(1)}pp)`);
console.log(`\n  Current REJECT_HARD_LIMIT: 0.18 (18%)`);
console.log(`  River-real exceeds? ${rReal.rate > 0.18 ? 'YES ✗ (needs fix)' : 'OK ✓'}`);
console.log(`  Bridge-real exceeds? ${bReal.rate > 0.18 ? 'YES ✗ (needs fix)' : 'OK ✓'}`);