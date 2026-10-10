// Theater sweep — the art gate for the strategic map, the counterpart of
// scripts/sweep.mjs for the battle map.
//
// One fixed seed, a fixed list of STAGED theater states, three devices. Each
// state is reached by exact minute-stepping through window.__game.stepTheater
// (the same tick the frame loop runs), never by running the clock on wall
// time, so the same state is the same picture on every run.
//
//   node scripts/stratsweep.mjs --port 5312                      # every state, every device
//   node scripts/stratsweep.mjs --port 5312 --devices phone      # desktop | phone | phone-landscape
//   node scripts/stratsweep.mjs --port 5312 --states start,march # a subset
//   node scripts/stratsweep.mjs --port 5312 --out DIR            # default .screenshots/stratsweep
//   node scripts/stratsweep.mjs --port 5312 --diff DIR           # count shots that differ from DIR
//   node scripts/stratsweep.mjs --port 5312 --perf               # theater frame cost, no shots
//
// Dev server must already be running: npm run dev -- --port 5312 --strictPort
// Output: <out>/<device>-<state>.png and <out>/index.html (contact sheet).
//
// WHAT IS STAGED. The camera is whatever the game boots with, unless a state
// says otherwise: boot framing is one of the things this gate looks at.
// Selection, orders and the clock are staged through the game's own modules.
// Render-clock effects are frozen (window.__game.freezeFx) so an animated
// marker is the same frame every run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch } from './lib/stage.mjs';

const PORT = Number(arg('port', '5312'));
const URL = `http://localhost:${PORT}`;
const OUT = arg('out', '.screenshots/stratsweep');
const DIFF = arg('diff', null);
const PERF = process.argv.includes('--perf');
const SEED = '19440606';
const DEVICES = arg('devices', 'desktop,phone,phone-landscape').split(',');

// Each state stages on top of a FRESH campaign. `stage` runs in the page.
const STATES = {
  // The first thing a new player sees.
  start: () => {},
  // A company selected, nothing ordered.
  selected: () => {
    const v2 = window.__game.getV2();
    v2.selectedForce = v2.front.forces.find((f) => f.side === 'blue').id;
  },
  // The whole theater through the HUD's own control.
  fit: () => {
    document.querySelector('#theater-hud [data-th="fit"]').click();
  },
  // Two companies on the road, 90 minutes in, one selected.
  march: async () => {
    const { orderMove } = await import('/src/strategic/theater/step.ts');
    const v2 = window.__game.getV2();
    const blue = v2.front.forces.filter((f) => f.side === 'blue');
    const objs = v2.front.theater.objectiveNodes;
    orderMove(v2.front, blue[0].id, objs[0]);
    orderMove(v2.front, blue[1].id, objs[objs.length - 1]);
    v2.selectedForce = blue[0].id;
    window.__game.stepTheater(90);
  },
};

const want = arg('states', Object.keys(STATES).join(',')).split(',');
for (const s of want) if (!STATES[s]) throw new Error(`unknown state "${s}" — one of: ${Object.keys(STATES).join(', ')}`);

async function boot(device) {
  const { browser, page } = await launch({ device });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rts.tutorial.v1', JSON.stringify({ skipped: true, done: [] }));
      localStorage.setItem('rts.portrait.dismissed', '1');
    } catch { /* private mode */ }
  });
  await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window);
  return { browser, page, errors };
}

async function newCampaign(page) {
  await page.evaluate(() => { try { localStorage.removeItem('ccg-save-v4'); } catch { /* private mode */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window);
  await page.click('#mm-new');
  await page.waitForFunction(() => { const b = document.getElementById('cz-go'); return !!b && !b.disabled; });
  await page.fill('#cz-seed', SEED);
  await page.dispatchEvent('#cz-seed', 'input');
  await page.evaluate(() => document.getElementById('cz-go').scrollIntoView());
  await page.click('#cz-go');
  await page.waitForFunction(() => !!window.__game.getV2());
  await page.waitForTimeout(250); // first strategic frame builds the HUD the boot camera measures
}

mkdirSync(OUT, { recursive: true });
const shots = [];
let pageErrors = 0;
for (const device of DEVICES) {
  const { browser, page, errors } = await boot(device);
  for (const state of want) {
    await newCampaign(page);
    await page.evaluate(STATES[state]);
    await page.evaluate(() => window.__game.freezeFx?.(1000));
    await page.waitForTimeout(150);
    if (PERF) {
      const ms = await page.evaluate(() => {
        const v2 = window.__game.getV2();
        const ctx = document.querySelector('canvas').getContext('2d');
        const w = window.__game.view.w, h = window.__game.view.h;
        const t = [];
        for (let i = 0; i < 150; i++) {
          const t0 = performance.now();
          v2.view.draw(ctx, v2.front, v2.selectedForce, true, 10, w, h);
          ctx.getImageData(0, 0, 1, 1); // canvas commands are deferred: read a pixel back so the raster is in the number
          t.push(performance.now() - t0);
        }
        t.sort((a, b) => a - b);
        return { mean: t.reduce((a, b) => a + b, 0) / t.length, p95: t[Math.floor(t.length * 0.95)], max: t[t.length - 1] };
      });
      console.log(`perf ${device} ${state}: draw+raster mean ${ms.mean.toFixed(2)} ms · p95 ${ms.p95.toFixed(2)} · max ${ms.max.toFixed(2)} (150 frames)`);
      continue;
    }
    const name = `${device}-${state}.png`;
    await page.screenshot({ path: join(OUT, name) });
    shots.push(name);
    console.log(`shot ${join(OUT, name)}`);
  }
  if (errors.length) {
    pageErrors += errors.length;
    console.error(`  ${device}: ${errors.length} page error(s): ${[...new Set(errors)].join(' | ')}`);
  }
  await browser.close();
}

if (!PERF) {
  writeFileSync(
    join(OUT, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>stratsweep</title><style>body{background:#111;color:#ccc;font:12px monospace}figure{display:inline-block;margin:6px;vertical-align:top}img{max-width:420px;display:block;border:1px solid #333}</style>` +
      shots.map((s) => `<figure><img src="${s}"><figcaption>${s}</figcaption></figure>`).join(''),
  );
  if (DIFF) {
    const changed = shots.filter((s) => !existsSync(join(DIFF, s)) || !readFileSync(join(DIFF, s)).equals(readFileSync(join(OUT, s))));
    console.log(`diff against ${DIFF}: ${changed.length}/${shots.length} shots differ${changed.length ? `: ${changed.join(', ')}` : ''}`);
    if (changed.length) process.exitCode = 1;
  }
}
if (pageErrors) {
  console.error(`FAIL: ${pageErrors} page error(s). A throw in the theater frame loop shows up as a wrong picture, not a crash: fix it before reading the shots.`);
  process.exitCode = 1;
}
