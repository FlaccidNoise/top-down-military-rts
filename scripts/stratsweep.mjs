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
  // A company selected and the player pointing at an objective: the route
  // preview. The pointing is real input (see ACTS).
  preview: () => {
    const v2 = window.__game.getV2();
    v2.selectedForce = v2.front.forces.find((f) => f.side === 'blue').id;
  },
  // The contact decision: Able marches on the nearest garrisoned objective
  // until contact. The card is up and the map is centred on the fight.
  contact: async () => {
    const { orderMove } = await import('/src/strategic/theater/step.ts');
    const v2 = window.__game.getV2();
    orderMove(v2.front, v2.front.forces.find((x) => x.side === 'blue').id, v2.front.theater.objectiveNodes[0]);
    window.__game.stepTheater(600);
    if (!v2.pending) throw new Error('contact: the march met nobody in ten hours');
  },
  // A battle in progress: Able marches on the nearest garrisoned objective
  // until contact, and the contact is opened as a timed battle.
  battle: async () => {
    const { orderMove } = await import('/src/strategic/theater/step.ts');
    const { openBattle } = await import('/src/strategic/theater/war.ts');
    const v2 = window.__game.getV2();
    const f = v2.front.forces.find((x) => x.side === 'blue');
    orderMove(v2.front, f.id, v2.front.theater.objectiveNodes[0]);
    window.__game.stepTheater(600);
    if (!v2.pending) throw new Error('battle: the march met nobody in ten hours');
    openBattle(v2.front, v2.pending);
    v2.pending = null;
    // The battle is open, so the card has no question left to ask: put it away
    // the way TheaterHud.hideContact does.
    document.getElementById('contact').hidden = true;
    document.getElementById('theater-hud').classList.remove('in-contact');
    window.__game.freezeFx(1960); // 40% through a beat: the ring is out and still strong
  },
  // 02:00 on day 2: the night wash.
  night: () => {
    window.__game.stepTheater(20 * 60);
  },
  // News on the map, frozen mid-animation: a town changes hands (ring, and
  // the wash half-way through its move) and a company falls back (arrow).
  events: async () => {
    const { pushEvent } = await import('/src/strategic/theater/force.ts');
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const v2 = window.__game.getV2();
    const front = v2.front;
    await frame(); // the log as it stands is history
    const [a, b] = front.forces.filter((f) => f.side === 'blue');
    const town = front.theater.objectiveNodes.find((n) => front.controlByNode[n] !== 'blue');
    front.controlByNode[town] = 'blue';
    pushEvent(front, { min: front.clockMin, kind: 'capture', text: `${front.theater.nodes[town].name} taken`, forceIds: [a.id], nodeId: town });
    const e = front.theater.edges.find((x) => x.moveClass !== 'rail' && (x.a === b.pos.nodeId || x.b === b.pos.nodeId));
    b.pos = { kind: 'edge', edgeId: e.id, s: e.a === b.pos.nodeId ? 1500 : e.lengthM - 1500, dir: e.a === b.pos.nodeId ? 1 : -1 };
    pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${b.name} falls back`, forceIds: [b.id] });
    await frame(); // taken in at render time 1000
    window.__game.freezeFx(1450);
  },
  // Supply made visible: the depots, a company cut off by an enemy column
  // standing on its road (the cut is marked on him), and an enemy garrison
  // the trace no longer reaches (ISOLATED).
  supply: async () => {
    const { route } = await import('/src/strategic/theater/force.ts');
    const { SUPPLY_LOW_MIN, SUPPLY_OUT_MIN } = await import('/src/strategic/theater/supply.ts');
    const v2 = window.__game.getV2();
    const fr = v2.front;
    const t = fr.theater;
    const able = fr.forces.find((f) => f.side === 'blue');
    // Able has taken the nearest objective and stands there.
    const town = t.objectiveNodes
      .map((n) => ({ n, r: route(t, able.pos.nodeId, n) }))
      .filter((x) => x.r && x.r.edges.length >= 2)
      .sort((a, b) => a.r.minutes - b.r.minutes)[0];
    const road = t.edges[town.r.edges[town.r.edges.length - 1]];
    const holder = fr.forces.find((f) => f.side === 'red' && f.pos.kind === 'node' && f.pos.nodeId === town.n);
    if (holder) holder.strength = 0;
    able.pos = { kind: 'node', nodeId: town.n };
    fr.controlByNode[town.n] = 'blue';
    able.untracedMin = SUPPLY_OUT_MIN;
    // A mobile group has walked onto the road behind him.
    const column = fr.forces.find((f) => f.side === 'red' && f.role === 'line');
    column.pos = { kind: 'edge', edgeId: road.id, s: road.lengthM / 2, dir: 1 };
    // And a garrison further on is cut off in its turn.
    const cutOff = fr.forces.find((f) => f.side === 'red' && f.role === 'garrison' && f.strength > 0);
    cutOff.untracedMin = SUPPLY_LOW_MIN;
    v2.selectedForce = able.id;
  },
  // Three counters on one town, with every pip lit: the fan-out and the
  // counter's vocabulary. Positions and states are written directly.
  stack: async () => {
    const { SUPPLY_LOW_MIN, SUPPLY_OUT_MIN } = await import('/src/strategic/theater/supply.ts');
    const v2 = window.__game.getV2();
    const blue = v2.front.forces.filter((f) => f.side === 'blue');
    const red = v2.front.forces.find((f) => f.side === 'red' && f.role === 'line');
    blue[1].pos = { ...blue[0].pos };
    red.pos = { ...blue[0].pos };
    Object.assign(blue[0], { fatigue: 0.5, untracedMin: SUPPLY_LOW_MIN });
    Object.assign(blue[1], { fatigue: 0.8, untracedMin: SUPPLY_OUT_MIN, strength: 60 });
    red.strength = 30;
    v2.selectedForce = blue[1].id;
  },
  // Fog of war: the enemy is last-seen reports only. A company marches four
  // hours toward the nearest objective so that some reports exist.
  fog: async () => {
    const { orderMove } = await import('/src/strategic/theater/step.ts');
    const v2 = window.__game.getV2();
    v2.campaignCfg.recon = 'contacts';
    v2.view.recon = 'contacts';
    const f = v2.front.forces.find((x) => x.side === 'blue');
    orderMove(v2.front, f.id, v2.front.theater.objectiveNodes[0]);
    window.__game.stepTheater(240);
  },
};

// Real input a state needs after staging, run from Node. A hover and a held
// finger cannot be staged by writing state: the game reads the pointer.
const ACTS = {
  preview: async (page, device) => {
    const [x, y] = await page.evaluate(() => {
      const v2 = window.__game.getV2();
      const W = window.__game.view.w, H = window.__game.view.h;
      const i = v2.view.inset;
      // The first objective that is on screen and clear of the HUD.
      for (const n of v2.front.theater.objectiveNodes) {
        const p = v2.front.theater.nodes[n].pos;
        const [sx, sy] = v2.view.toScreen(p.x, p.y, W, H);
        if (sx > 20 && sx < W - 20 && sy > i.top + 20 && sy < H - i.bottom - 20) return [sx, sy];
      }
      throw new Error('preview: no objective is on screen — boot framing changed');
    });
    if (device === 'desktop') {
      await page.mouse.move(x - 30, y - 30);
      await page.mouse.move(x, y, { steps: 3 });
    } else {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(600); // past the 420 ms hold
    }
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
    await page.evaluate(() => window.__game.freezeFx(1000));
    await page.evaluate(STATES[state]);
    await ACTS[state]?.(page, device);
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
