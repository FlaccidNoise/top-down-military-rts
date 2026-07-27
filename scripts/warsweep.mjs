// The 16-seed war sweep the coarse night multiplier is gated on (day/night
// design §6): resolveCoarse's balance knobs were tuned across 16 campaign
// seeds to a war-length distribution of 1-15 days with both 'won' and 'lost'
// outcomes. That DISTRIBUTION is the asset, not the constants — never change
// a tuned constant without re-running the thing that tuned it. This script is
// the thing: it measures the current distribution, and re-measures it under a
// candidate nightMult so a number can be picked from evidence.
//
//   npx vite-node scripts/warsweep.mjs                 # current distribution
//   npx vite-node scripts/warsweep.mjs -- --night 1.15 # a candidate value
//   npx vite-node scripts/warsweep.mjs -- --seeds 32   # widen the sample
//
// Headless AI-vs-AI war, mirroring the main.ts strategic tick and the
// strategic-command.test.ts AI-vs-AI block: both commanders, coarse
// resolution, heal clocks and reinforcement cycles on day change.
import { newCampaign, advanceDays, fillReplacements } from '../src/campaign/campaign';
import { newFront, resolveCoarse, setCoarseNightMult, syncStrengths } from '../src/strategic/bridge';
import { StrategicCommander, RED_DEFENDER, BLUE_ATTACKER } from '../src/strategic/command';
import { operationStatus, REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY } from '../src/strategic/front';
import { makeDefaultSector } from '../src/strategic/sector';
import { lightAt } from '../src/sim/solar';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const SEEDS = arg('seeds', 16);
const NIGHT = arg('night', 1.0);
setCoarseNightMult(NIGHT);

const runWar = (seed) => {
  const c = newCampaign(seed);
  const front = newFront(c, makeDefaultSector());
  const redCmd = new StrategicCommander('red', RED_DEFENDER);
  const blueCmd = new StrategicCommander('blue', BLUE_ATTACKER);
  let prevDay = front.day;
  let steps = 0;
  let nightBattles = 0;
  let battles = 0;
  while (operationStatus(front) === 'ongoing' && steps < 100000) {
    redCmd.evaluate(front);
    blueCmd.evaluate(front);
    const e = front.step();
    if (front.day > prevDay) {
      advanceDays(c, front.day - prevDay);
      if (front.day % REINFORCE_CYCLE_DAYS === 0) fillReplacements(c, front.day * 31 + 7, REINFORCE_PER_COMPANY);
      syncStrengths(c, front);
      prevDay = front.day;
    }
    if (e) {
      battles++;
      if (lightAt(front.clockMin) < 0.25) nightBattles++; // the band the hook fires in
      resolveCoarse(c, front, e);
    }
    steps++;
  }
  return { seed, status: operationStatus(front), day: front.day, battles, nightBattles };
};

console.log(`nightMult ${NIGHT.toFixed(2)} over seeds 1..${SEEDS}`);
const rows = [];
for (let s = 1; s <= SEEDS; s++) {
  const r = runWar(s);
  rows.push(r);
  console.log(`  seed ${String(r.seed).padStart(3)}  ${r.status.padEnd(4)}  day ${String(r.day).padStart(2)}  battles ${String(r.battles).padStart(3)}  night ${r.nightBattles}`);
}
const days = rows.map((r) => r.day).sort((a, b) => a - b);
const won = rows.filter((r) => r.status === 'won').length;
const nightShare = rows.reduce((a, r) => a + r.nightBattles, 0) / Math.max(1, rows.reduce((a, r) => a + r.battles, 0));
console.log(`summary: won ${won}/${rows.length}, days min/med/max ${days[0]}/${days[days.length >> 1]}/${days[days.length - 1]}, night-battle share ${(nightShare * 100).toFixed(1)}%`);
console.log('gate: wars must span 1-15 days and both outcomes must occur before any nightMult lands.');
