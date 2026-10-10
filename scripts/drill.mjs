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
// can give those orders: every input here is a real mouse click or a real CDP
// touch at a point found the way a player finds it, from the ring the step
// draws and the chip it lights. The phone leg taps and holds; it never clicks.
//
// At every step it checks: the bubble says that step's own line in this
// platform's words, the bubble and the ring are on the screen, the battle is
// held, the ticker is clear of both, and the page is no wider or taller than
// the device.
//
// Target discovery is live state only (window.__game.tutorialView, .getDrill,
// .stage): no fixed pixel. The battle runs at 4x through the game's own speed
// control, so a seed takes about twenty seconds.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch } from './lib/stage.mjs';

const PORT = Number(arg('port', '5331'));
const URL = `http://localhost:${PORT}`;
const DEVICES = arg('devices', 'desktop,phone,phone-landscape').split(',');
const IDLE = process.argv.includes('--idle');
const SHOTS = arg('shots', null);
const IDLE_SIM_S = Number(arg('idle-secs', '120'));
const HOLD_MS = 420; // src/ui/touch.ts HOLD_MS: the press that is the right-click
const seedArg = arg('seeds', '1,2,3');
const SEEDS = /^\d+-\d+$/.test(seedArg)
  ? Array.from({ length: Number(seedArg.split('-')[1]) - Number(seedArg.split('-')[0]) + 1 }, (_, i) => Number(seedArg.split('-')[0]) + i)
  : seedArg.split(',').map(Number);

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

async function open(device) {
  const { browser, page } = await launch({ device });
  const cdp = await page.context().newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const TOUCH = device !== 'desktop';
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y })) });
  return {
    browser, page, errors, TOUCH, device,
    /** Select: a click, or a tap. */
    async tap(p) {
      if (TOUCH) { await touch('touchStart', [p]); await touch('touchEnd', []); } else await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(120);
    },
    /** Order: a right-click, or a press held past the hold time. */
    async order(p) {
      if (TOUCH) { await touch('touchStart', [p]); await page.waitForTimeout(HOLD_MS + 180); await touch('touchEnd', []); } else await page.mouse.click(p.x, p.y, { button: 'right' });
      await page.waitForTimeout(150);
    },
    /** A DOM control, pressed where it is. Fails if it is not on the screen. */
    async press(sel) {
      const c = await page.evaluate((s) => {
        const e = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().width > 0);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
      }, sel);
      if (!c) throw new Error(`${sel} is not laid out. The step named a control the HUD is not showing: with no squad selected the order bar is hidden (src/ui/hud.ts), and pollDrill in src/main.ts is what re-selects one.`);
      if (!c.on) throw new Error(`${sel} is partly off the screen at ${Math.round(c.x)},${Math.round(c.y)}.`);
      if (TOUCH) await page.touchscreen.tap(c.x, c.y);
      else await page.mouse.click(c.x, c.y);
      await page.waitForTimeout(120);
    },
  };
}

/** Everything a check needs about the step on screen, in one read. */
const view = (page) =>
  page.evaluate(async () => {
    const { STEPS } = await import('/src/ui/tutorial.ts');
    const g = window.__game;
    const t = g.tutorialView();
    const b = document.querySelector('.coach');
    const br = b && getComputedStyle(b).display !== 'none' ? b.getBoundingClientRect() : null;
    const step = t?.step ? STEPS.find((s) => s.id === t.step) : null;
    const root = document.documentElement;
    return {
      step: t?.step ?? null,
      want: step?.text ? (g.MOBILE ? step.text.touch : step.text.desktop) : null,
      text: document.querySelector('.coach-text')?.textContent ?? null,
      bubble: br && { left: br.left, top: br.top, right: br.right, bottom: br.bottom },
      ring: t?.ring ?? null,
      occupied: t?.occupied ?? [],
      feed: g.pings.feed,
      stage: g.stage(),
      glow: [...document.querySelectorAll('#orderbar .ord.glow')].map((e) => e.dataset.order),
      armed: g.getSelection().armedOrder,
      sel: g.getSelection().squads,
      tick: g.sim.tick,
      winner: g.sim.winner,
      vp: { inner: [innerWidth, innerHeight], doc: [root.scrollWidth, root.scrollHeight], visual: [Math.round(visualViewport.width), Math.round(visualViewport.height)], scale: visualViewport.scale },
    };
  });

const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Wait for a named step, or the end of the battle. Returns the view. */
async function waitStep(h, id, timeout) {
  try {
    await h.page.waitForFunction((want) => window.__game.tutorialView()?.step === want || window.__game.sim.winner !== null, id, { timeout, polling: 100 });
  } catch {
    const v = await view(h.page);
    throw new Error(
      `gave up after ${timeout / 1000}s waiting for step '${id}'. On screen: step=${v.step} bubble="${v.text}" tick=${v.tick} selected=[${v.sel}] armed=${v.armed}.\n` +
        `    Each step shows on an event main.ts raises (pollDrill, noteOrder, noteSelection, doArmOrder) and the driver accepts (advance in src/ui/tutorial.ts). ` +
        `If the tick is not moving the battle is still held by the step before this one.`,
    );
  }
  return view(h.page);
}

/** The checks every step gets. `shots` names the screenshot when shooting. */
async function checkStep(h, id, shot) {
  const { page, device } = h;
  await page.waitForTimeout(250); // the bubble places itself on the frame after it shows
  const v = await view(page);
  const tag = `${device} ${id}`;
  check(v.step === id, `${tag}: is the step on screen (${v.step})`);
  check(v.text === v.want && !!v.want, `${tag}: says its own line for this platform ("${v.text}")`);
  const [W, H] = v.vp.inner;
  check(!!v.bubble && v.bubble.left >= 0 && v.bubble.top >= 0 && v.bubble.right <= W && v.bubble.bottom <= H, `${tag}: bubble on screen (${v.bubble ? `${Math.round(v.bubble.left)},${Math.round(v.bubble.top)} to ${Math.round(v.bubble.right)},${Math.round(v.bubble.bottom)}` : 'no bubble'} in ${W}x${H})`);
  if (v.ring) {
    const st = v.stage;
    check(v.ring.x >= st.left && v.ring.x <= st.right && v.ring.y >= st.top && v.ring.y <= st.bottom, `${tag}: the ring is on the map the player can see (${Math.round(v.ring.x)},${Math.round(v.ring.y)} in ${Math.round(st.left)},${Math.round(st.top)} to ${Math.round(st.right)},${Math.round(st.bottom)})`);
    // The ring is what the player presses next: the bubble may touch its edge and no more.
    const nx = Math.max(v.bubble?.left ?? 0, Math.min(v.ring.x, v.bubble?.right ?? 0));
    const ny = Math.max(v.bubble?.top ?? 0, Math.min(v.ring.y, v.bubble?.bottom ?? 0));
    const gap = Math.hypot(nx - v.ring.x, ny - v.ring.y) - v.ring.r;
    check(!!v.bubble && gap >= -4, `${tag}: the bubble is clear of the ring (${Math.round(gap)} px from its edge)`);
  }
  check(!v.feed || !v.occupied.some((r) => overlap(v.feed, r)), `${tag}: the ticker is clear of the bubble and the ring${v.feed ? ` (ticker at y ${Math.round(v.feed.top)} to ${Math.round(v.feed.bottom)})` : ' (no lines)'}`);
  check(v.vp.doc[0] <= W && v.vp.doc[1] <= H && v.vp.visual[0] === W && v.vp.scale === 1, `${tag}: the page is no bigger than the device (doc ${v.vp.doc.join('x')}, visual ${v.vp.visual.join('x')}, device ${W}x${H})`);
  const held = await page.evaluate(async (t0) => { await new Promise((r) => setTimeout(r, 400)); return window.__game.sim.tick === t0; }, v.tick);
  check(held, `${tag}: the battle is held while the step waits`);
  if (shot) await shot(id);
  return v;
}

/** A man of a squad who is on the visible map: where a player taps to pick it. */
const manOf = (page, squad) =>
  page.evaluate((q) => {
    const g = window.__game, s = g.sim, st = g.stage();
    const pts = s.squads[q].soldierIds.map((i) => s.soldiers[i]).filter((m) => m.alive && !m.downed)
      .map((m) => { const [x, y] = g.cam.worldToScreen(m.x, m.y, innerWidth, innerHeight); return { x, y }; })
      .filter((p) => p.x > st.left + 8 && p.x < st.right - 8 && p.y > st.top + 8 && p.y < st.bottom - 8);
    return pts[0] ?? null;
  }, squad);

const orders = (page, squad) => page.evaluate((q) => { const s = window.__game.sim; return s.squads[q].teamIds.map((t) => `${s.teams[t].orderState.order?.kind ?? 'none'}/${s.teams[t].orderState.phase}`); }, squad);

async function boot(h, seed) {
  const { page } = h;
  await page.goto(`${URL}/?drill=${seed}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window && window.__game.getDrill?.(), null, { timeout: 20000 }).catch(() => {
    throw new Error(`the drill never booted at ${URL}/?drill=${seed}. Check the dev server serves THIS worktree: curl ${URL}/src/drill.ts must return the module. startDrill is in src/main.ts.`);
  });
  // Portrait guidance is about the battlefield and is one tap to pass.
  if (await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none')) await h.press('#rotate-anyway');
}

const setSpeed4 = async (h) => {
  for (let i = 0; i < 3; i++) {
    if (await h.page.evaluate(() => /4/.test(document.querySelector('[data-act="speed"], [data-tb="speed"]')?.textContent ?? ''))) return;
    await h.press(h.TOUCH ? '[data-tb="speed"]' : '#hud [data-act="speed"]');
  }
};

async function follow(device, seed, shots) {
  const h = await open(device);
  const { page } = h;
  let n = 0;
  const shot = shots
    ? async (name) => {
        n++;
        const dir = join(shots, device);
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, `${String(n).padStart(2, '0')}-${name}.png`) });
      }
    : null;
  try {
    await boot(h, seed);
    const d = await page.evaluate(() => window.__game.getDrill());

    // 1. tap your squad
    let v = await waitStep(h, 'drill-select', 15000);
    v = await checkStep(h, 'drill-select', shot);
    check(v.tick === 0, `${device} seed ${seed}: the drill loads held at its first step (tick ${v.tick})`);
    await h.tap((await manOf(page, d.lead)) ?? v.ring);
    check((await page.evaluate(() => window.__game.getSelection().squads))[0] === d.lead, `${device} seed ${seed}: a ${h.TOUCH ? 'tap' : 'click'} on the ringed squad selects it`);

    // 2. send it to the hedge
    await waitStep(h, 'drill-move', 5000);
    v = await checkStep(h, 'drill-move', shot);
    await h.order(v.ring);
    const moved = await orders(page, d.lead);
    check(moved.every((o) => /^(move|fast|sneak)\//.test(o)), `${device} seed ${seed}: a ${h.TOUCH ? 'hold' : 'right-click'} on the hedge orders the squad there (${moved.join(', ')})`);
    await page.waitForFunction((t) => window.__game.sim.tick > t + 3, v.tick, { timeout: 5000 }).catch(() => { throw new Error('the battle did not start after the first order: onTutorialStep in src/main.ts releases the hold when the step retires.'); });
    await setSpeed4(h);

    // 3. enemy seen: the battle stops by itself, Fire lights up
    await waitStep(h, 'drill-contact', 60000);
    v = await checkStep(h, 'drill-contact', shot);
    check(v.glow.includes('fire'), `${device} seed ${seed}: the Fire chip is lit (${v.glow.join(',') || 'none lit'})`);
    await h.press('#orderbar [data-order="fire"]');

    // 4. then the enemy
    await waitStep(h, 'drill-fire', 5000);
    v = await checkStep(h, 'drill-fire', shot);
    check(v.armed === 'fire', `${device} seed ${seed}: Fire is armed (${v.armed})`);
    await h.order(v.ring);
    const firing = await orders(page, d.lead);
    check(firing.some((o) => o.startsWith('fire/')), `${device} seed ${seed}: a ${h.TOUCH ? 'hold' : 'right-click'} on the enemy gives the Fire order (${firing.join(', ')})`);

    // 5 and 6, and the recovery step when a squad refuses
    let recoveries = 0;
    for (;;) {
      const next = await page.waitForFunction(() => {
        const g = window.__game, s = g.tutorialView()?.step;
        return g.sim.winner ? 'won' : s === 'drill-quiet' || s === 'drill-assault' || s === 'drill-balk' ? s : false;
      }, null, { timeout: 120000, polling: 100 }).then((x) => x.jsonValue()).catch(async () => {
        const now = await view(page);
        throw new Error(`nothing happened for 120 s after the Fire order: step=${now.step} tick=${now.tick} winner=${now.winner}. houseIsQuiet (src/drill.ts) is what the next step waits on; npx vite-node scripts/drillsweep.mjs -- --start ${seed} --seeds 1 --verbose shows the same seed headless.`);
      });
      if (next === 'won') break;
      if (next === 'drill-quiet') {
        v = await checkStep(h, 'drill-quiet', shot);
        const other = await page.evaluate(() => { const g = window.__game, dd = g.getDrill(); return dd.rifles.find((q) => q !== dd.shooter); });
        // The ring may be on a squad off to one side: the step brought it into view.
        await h.tap((await manOf(page, other)) ?? v.ring);
        check((await page.evaluate(() => window.__game.getSelection().squads))[0] !== d.lead, `${device} seed ${seed}: another squad is selected`);
        await waitStep(h, 'drill-assault', 5000);
      }
      if (next === 'drill-balk') {
        recoveries++;
        if (recoveries > 3) throw new Error(`the assault was refused ${recoveries} times on seed ${seed}. The recovery step is meant to be rare: scripts/drillsweep.mjs counts it.`);
        v = await checkStep(h, 'drill-balk', shot);
        if (v.armed !== 'fire') await h.press('#orderbar [data-order="fire"]');
        await h.order(v.ring);
        continue;
      }
      v = await checkStep(h, 'drill-assault', shot);
      check(v.glow.includes('assault'), `${device} seed ${seed}: the Assault chip is lit (${v.glow.join(',') || 'none lit'})`);
      await h.press('#orderbar [data-order="assault"]');
      await h.order(v.ring);
      const sel = (await page.evaluate(() => window.__game.getSelection().squads))[0];
      const charge = await orders(page, sel);
      check(charge.some((o) => /^(assault|move)\//.test(o)), `${device} seed ${seed}: a ${h.TOUCH ? 'hold' : 'right-click'} on the house sends the assault (${charge.join(', ')})`);
    }

    const end = await page.evaluate(() => { const s = window.__game.sim; const eff = (side) => s.soldiers.filter((m) => m.side === side && m.alive && !m.downed && !m.captured).length; return { winner: s.winner, blue: eff('blue'), blueStart: s.startStrength.blue, secs: Math.round(s.tick / 30) }; });
    check(end.winner === 'blue', `${device} seed ${seed}: the farm is taken (winner ${end.winner}, ${end.blue}/${end.blueStart} men left, ${end.secs} s of battle, ${recoveries} recoveries)`);
    await page.waitForSelector('#debrief #next', { state: 'visible', timeout: 15000 }).catch(() => { throw new Error('no end card 15 s after the win: showDrillEnd in src/main.ts runs 4 s after sim.winner is set.'); });
    const card = await page.evaluate(() => ({
      h1: document.querySelector('#debrief h1')?.textContent,
      words: document.getElementById('debrief').innerText.split(/\s+/).filter(Boolean).length,
      buttons: [...document.querySelectorAll('#debrief button')].map((b) => b.textContent),
      bubble: !!document.querySelector('.coach'),
      doc: [document.documentElement.scrollWidth, innerWidth],
    }));
    check(card.h1 === 'FARM TAKEN' && card.buttons.length === 2, `${device} seed ${seed}: the end card says so and offers two ways on (${card.h1}; ${card.buttons.join(' / ')})`);
    check(card.words <= 20, `${device} seed ${seed}: the end card is ${card.words} words`);
    check(!card.bubble, `${device} seed ${seed}: no tutorial bubble is left over the end card`);
    check(card.doc[0] <= card.doc[1], `${device} seed ${seed}: the end card fits the width (${card.doc[0]} <= ${card.doc[1]})`);
    if (shot) await shot('end-card');
    check(h.errors.length === 0, `${device} seed ${seed}: no page or console errors${h.errors.length ? `: ${[...new Set(h.errors)].slice(0, 3).join(' | ')}` : ''}`);
    return { ...end, recoveries };
  } finally {
    await h.browser.close();
  }
}

/** Steps 1 and 2 through the UI, then hands off for IDLE_SIM_S of battle. */
async function idle(device, seed) {
  const h = await open(device);
  const { page } = h;
  try {
    await boot(h, seed);
    const d = await page.evaluate(() => window.__game.getDrill());
    let v = await waitStep(h, 'drill-select', 15000);
    await h.tap((await manOf(page, d.lead)) ?? v.ring);
    v = await waitStep(h, 'drill-move', 5000);
    await page.waitForTimeout(250);
    v = await view(page);
    await h.order(v.ring);
    await setSpeed4(h);
    // The battle stops itself when the enemy is seen. A player who does nothing
    // more leaves it stopped, which cannot lose. The harder case is the player
    // who presses Play and walks away, so press it.
    await waitStep(h, 'drill-contact', 60000);
    await h.press(h.TOUCH ? '[data-tb="pause"]' : '#hud [data-act="pause"]');
    const from = await page.evaluate(() => window.__game.sim.tick);
    await page.waitForFunction(({ t, n }) => window.__game.sim.winner !== null || window.__game.sim.tick >= t + n * 30, { t: from, n: IDLE_SIM_S }, { timeout: IDLE_SIM_S * 1000, polling: 250 }).catch(() => {
      throw new Error(`the battle did not run ${IDLE_SIM_S} s of sim time in ${IDLE_SIM_S} s of wall time at 4x: it is held or paused. A tutorial step that holds the battle must still let Play run it (onTutorialStep, src/main.ts).`);
    });
    const end = await page.evaluate(() => { const s = window.__game.sim; const eff = (side) => s.soldiers.filter((m) => m.side === side && m.alive && !m.downed && !m.captured).length; return { winner: s.winner, blue: eff('blue'), blueStart: s.startStrength.blue, red: eff('red'), secs: Math.round(s.tick / 30) }; });
    check(end.winner !== 'red', `${device} seed ${seed}: idle after step 2 is not a loss (winner ${end.winner ?? 'none'}, ${end.blue}/${end.blueStart} men left, ${end.red} defenders, ${end.secs} s of battle)`);
    return end;
  } finally {
    await h.browser.close();
  }
}

const t0 = Date.now();
const res = await (await fetch(`${URL}/src/drill.ts`)).text().catch(() => '');
if (!res.includes('houseIsQuiet')) {
  console.error(`${URL}/src/drill.ts does not carry houseIsQuiet: port ${PORT} is not serving this worktree, or no dev server is up.\nStart one here: npm run dev -- --port ${PORT} --strictPort`);
  process.exit(2);
}
const results = [];
for (const device of DEVICES) {
  console.log(`\n=== ${device} · ${IDLE ? `steps 1-2 then idle for ${IDLE_SIM_S} s` : 'the drill, step by step'} · seeds ${SEEDS.join(',')} ===`);
  for (const seed of SEEDS) {
    try {
      const r = IDLE ? await idle(device, seed) : await follow(device, seed, SHOTS && seed === SEEDS[0] ? SHOTS : null);
      results.push({ device, seed, ...r });
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
