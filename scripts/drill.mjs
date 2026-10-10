// The drill gate: the training battle played through its real UI, on a
// desktop and on a phone, from its first step to the farm taken.
//
//   node scripts/drill.mjs --port 5331                       # desktop + phone + phone-landscape, seeds 1,2,3
//   node scripts/drill.mjs --port 5331 --devices phone       # desktop | phone | phone-landscape
//   node scripts/drill.mjs --port 5331 --seeds 1-20          # a sweep: a range or a list
//   node scripts/drill.mjs --port 5331 --idle                # steps 1 and 2, then nothing: must not lose
//   node scripts/drill.mjs --port 5331 --shots DIR           # a screenshot at every step of the first seed
//
// Dev server must be running: npm run dev -- --port 5331 --strictPort
//
// WHAT IT PROVES. tests/drill.test.ts and scripts/drillsweep.mjs prove the
// drill is winnable as a sim: orders in, winner out. This proves the player
// can give those orders: every input is a real mouse click or a real CDP touch
// at a point found the way a player finds it, from the ring the step draws and
// the chip it lights (scripts/lib/play.mjs). The phone legs tap and hold; they
// never click.
//
// At every step it checks: the bubble says that step's own line in this
// platform's words, the bubble and the ring are on the screen and clear of
// each other, the battle is held, the ticker is clear of both, and the page is
// no wider or taller than the device.
//
// The battle runs at 4x through the game's own speed control. A seed takes
// under a minute. scripts/tutorial.mjs plays the drill once more as the first
// part of the whole first run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg } from './lib/stage.mjs';
import { checkEndCard, drillFirstOrder, drillIdle, drillToVictory, openDevice } from './lib/play.mjs';

const PORT = Number(arg('port', '5331'));
const URL = `http://localhost:${PORT}`;
const DEVICES = arg('devices', 'desktop,phone,phone-landscape').split(',');
const IDLE = process.argv.includes('--idle');
const SHOTS = arg('shots', null);
const IDLE_SIM_S = Number(arg('idle-secs', '120'));
const seedArg = arg('seeds', '1,2,3');
const SEEDS = /^\d+-\d+$/.test(seedArg)
  ? Array.from({ length: Number(seedArg.split('-')[1]) - Number(seedArg.split('-')[0]) + 1 }, (_, i) => Number(seedArg.split('-')[0]) + i)
  : seedArg.split(',').map(Number);

const failures = [];
const QUIET = SEEDS.length > 3; // a sweep prints failures and one line a seed
const check = (ok, what) => {
  if (!ok) failures.push(what);
  if (!ok || !QUIET) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

async function boot(h, seed) {
  await h.page.goto(`${URL}/?drill=${seed}`, { waitUntil: 'domcontentloaded' });
  await h.page.waitForFunction(() => '__game' in window && window.__game.getDrill?.(), null, { timeout: 20000 }).catch(() => {
    throw new Error(`the drill never booted at ${URL}/?drill=${seed}. Check the dev server serves THIS worktree: curl ${URL}/src/drill.ts must return the module. startDrill is in src/main.ts.`);
  });
  const rotate = await h.page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none');
  check(!rotate, `${h.device} seed ${seed}: the drill opens with no "turn the phone" screen in the way`);
}

async function run(device, seed, shots) {
  const h = await openDevice(device);
  let n = 0;
  const shot = shots
    ? async (name) => {
        n++;
        const dir = join(shots, device);
        mkdirSync(dir, { recursive: true });
        await h.page.screenshot({ path: join(dir, `${String(n).padStart(2, '0')}-${name}.png`) });
      }
    : null;
  const ctx = { check, shot, label: `${device} seed ${seed}`, seed };
  try {
    await boot(h, seed);
    if (IDLE) {
      const end = await drillIdle(h, IDLE_SIM_S, ctx);
      check(end.winner !== 'red', `${device} seed ${seed}: idle after step 2 is not a loss (winner ${end.winner ?? 'none'}, ${end.blue}/${end.blueStart} men left, ${end.red} defenders, ${end.secs} s of battle)`);
      return end;
    }
    const d = await drillFirstOrder(h, ctx);
    const end = await drillToVictory(h, d, ctx);
    await checkEndCard(h, ctx);
    check(h.errors.length === 0, `${device} seed ${seed}: no page or console errors${h.errors.length ? `: ${[...new Set(h.errors)].slice(0, 3).join(' | ')}` : ''}`);
    return end;
  } finally {
    await h.browser.close();
  }
}

const t0 = Date.now();
const served = await (await fetch(`${URL}/src/drill.ts`)).text().catch(() => '');
if (!served.includes('houseIsQuiet')) {
  console.error(`${URL}/src/drill.ts does not carry houseIsQuiet: port ${PORT} is not serving this worktree, or no dev server is up.\nStart one here: npm run dev -- --port ${PORT} --strictPort`);
  process.exit(2);
}
const results = [];
for (const device of DEVICES) {
  console.log(`\n=== ${device} · ${IDLE ? `steps 1-2, Play, then idle for ${IDLE_SIM_S} s` : 'the drill, step by step'} · seeds ${SEEDS.join(',')} ===`);
  for (const seed of SEEDS) {
    try {
      const r = await run(device, seed, SHOTS && seed === SEEDS[0] ? SHOTS : null);
      results.push({ device, seed, ...r });
      if (QUIET) console.log(`  ${device} seed ${seed}: winner ${r.winner ?? 'none'}, ${r.blue}/${r.blueStart} men left, ${r.secs} s of battle${r.recoveries ? `, ${r.recoveries} recoveries` : ''}`);
    } catch (e) {
      failures.push(`${device} seed ${seed}: ${e.message}`);
      console.log(`  FAIL ${device} seed ${seed} aborted: ${e.message}`);
    }
  }
}
for (const device of DEVICES) {
  const rs = results.filter((r) => r.device === device);
  if (!rs.length) continue;
  const worst = Math.min(...rs.map((r) => r.blue));
  console.log(
    IDLE
      ? `${device}: idle on ${rs.length} seeds: lost ${rs.filter((r) => r.winner === 'red').length}, won anyway ${rs.filter((r) => r.winner === 'blue').length}, undecided ${rs.filter((r) => !r.winner).length}; fewest men left ${worst}/${rs[0].blueStart}`
      : `${device}: won ${rs.filter((r) => r.winner === 'blue').length}/${SEEDS.length} seeds; fewest men left ${worst}/${rs[0].blueStart}; longest ${Math.max(...rs.map((r) => r.secs))} s of battle; recovery step used on ${rs.filter((r) => r.recoveries > 0).length}`,
  );
}
console.log(`\n${((Date.now() - t0) / 60000).toFixed(1)} min`);
if (failures.length) {
  console.log(`${failures.length} FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('all drill checks passed');
