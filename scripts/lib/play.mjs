// Playing the game the way a player does, for the gates that need to:
// scripts/drill.mjs (the drill, many seeds) and scripts/tutorial.mjs (the whole
// first run). One implementation, so the two cannot disagree about what a tap
// is or what a step has to look like.
//
// Every input is a real mouse event or a real CDP touch. Every target comes
// from live state (window.__game.tutorialView, .getDrill, .stage): the ring a
// step draws is where a player presses, so the ring is where these press.
import { launch } from './stage.mjs';

export const HOLD_MS = 420; // src/ui/touch.ts HOLD_MS: the press that is the right-click

/** A browser on a device profile, with the inputs a player has on it. */
export async function openDevice(device) {
  const { browser, page } = await launch({ device });
  const cdp = await page.context().newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const TOUCH = device !== 'desktop';
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y })) });
  const h = {
    browser, page, errors, TOUCH, device,
    /** How many inputs the player has made. A press, a tap, a hold: one each. */
    inputs: 0,
    /** Select: a click, or a tap. */
    async tap(p) {
      h.inputs++;
      if (TOUCH) { await touch('touchStart', [p]); await touch('touchEnd', []); } else await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(120);
    },
    /** Order: a right-click, or a press held past the hold time. */
    async order(p) {
      h.inputs++;
      if (TOUCH) { await touch('touchStart', [p]); await page.waitForTimeout(HOLD_MS + 180); await touch('touchEnd', []); } else await page.mouse.click(p.x, p.y, { button: 'right' });
      await page.waitForTimeout(150);
    },
    /** Point at a place without pressing. Desktop only: a finger cannot hover. */
    async hover(p) {
      if (!TOUCH) await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(200);
    },
    /** A DOM control, pressed where it is. Fails if it is not whole on the screen or something is on top of it. */
    async press(sel) {
      const c = await page.evaluate((s) => {
        const e = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().width > 0);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        return { x, y, on: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, covered: !!top && top !== e && !e.contains(top) ? (top.id || top.className || top.tagName) : null };
      }, sel);
      if (!c) throw new Error(`${sel} is not laid out. If a tutorial step named it: with no squad selected the order bar is hidden (src/ui/hud.ts), and pollDrill in src/main.ts is what re-selects one.`);
      if (!c.on) throw new Error(`${sel} is partly off the screen at ${Math.round(c.x)},${Math.round(c.y)}.`);
      if (c.covered) throw new Error(`${sel} is covered by "${c.covered}" at ${Math.round(c.x)},${Math.round(c.y)}: a player cannot press it.`);
      h.inputs++;
      if (TOUCH) await page.touchscreen.tap(c.x, c.y);
      else await page.mouse.click(c.x, c.y);
      await page.waitForTimeout(120);
    },
  };
  return h;
}

/** Everything a check needs about the step on screen, in one read. */
export const stepView = (page) =>
  page.evaluate(async () => {
    const { STEPS } = await import('/src/ui/tutorial.ts');
    const g = window.__game;
    const t = g.tutorialView();
    const b = document.querySelector('.coach');
    const br = b && getComputedStyle(b).display !== 'none' ? b.getBoundingClientRect() : null;
    const step = t?.step ? STEPS.find((s) => s.id === t.step) : null;
    const root = document.documentElement;
    const sel = g.getSelection();
    return {
      step: t?.step ?? null,
      want: step?.text ? (g.MOBILE ? step.text.touch : step.text.desktop) : null,
      holds: !!step?.holds,
      text: b ? b.querySelector('.coach-text')?.textContent ?? null : null,
      bubble: br && { left: br.left, top: br.top, right: br.right, bottom: br.bottom },
      ring: t?.ring ?? null,
      occupied: t?.occupied ?? [],
      feed: sel.mode === 'battle' ? g.pings.feed : null,
      // Barks: a word over a man (src/render/barks.ts), where its middle is drawn.
      barks: sel.mode === 'battle'
        ? [...g.barks.speaking].map(([id, b]) => { const m = g.sim.soldiers[id]; const [x, y] = g.cam.worldToScreen(m.x, m.y, innerWidth, innerHeight); return { kind: b.kind, x, y: y - g.cam.scale * 0.9 - 8 }; })
        : [],
      stage: g.stage(),
      glow: [...document.querySelectorAll('#orderbar .ord.glow')].map((e) => e.dataset.order),
      armed: sel.armedOrder,
      sel: sel.squads,
      mode: sel.mode,
      tick: sel.mode === 'battle' ? g.sim.tick : null,
      winner: sel.mode === 'battle' ? g.sim.winner : null,
      vp: { inner: [innerWidth, innerHeight], doc: [root.scrollWidth, root.scrollHeight], visual: [Math.round(visualViewport.width), Math.round(visualViewport.height)], scale: visualViewport.scale },
    };
  });

export const overlap = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The page is the size of the device: nothing has grown the layout viewport, and nothing has zoomed it. */
export function checkViewport(check, tag, vp) {
  const [W, H] = vp.inner;
  check(vp.doc[0] <= W && vp.doc[1] <= H && vp.visual[0] === W && vp.scale === 1, `${tag}: the page is no bigger than the device (doc ${vp.doc.join('x')}, visual ${vp.visual.join('x')}, device ${W}x${H})`);
}

/** Wait for a named step. In a battle the wait also ends when the battle does. */
export async function waitStep(h, id, timeout) {
  try {
    await h.page.waitForFunction((want) => {
      const g = window.__game;
      return g.tutorialView()?.step === want || (g.getSelection().mode === 'battle' && g.sim.winner !== null);
    }, id, { timeout, polling: 100 });
  } catch {
    const v = await stepView(h.page);
    throw new Error(
      `gave up after ${timeout / 1000}s waiting for step '${id}'. On screen: step=${v.step} bubble="${v.text}" mode=${v.mode} tick=${v.tick} selected=[${v.sel}] armed=${v.armed}.\n` +
        `    Each step shows on an event main.ts raises (tutorial.notify at its call sites, pollDrill for the drill) and the driver accepts (advance in src/ui/tutorial.ts). ` +
        `In the drill, a tick that is not moving means the battle is still held by the step before this one.`,
    );
  }
  return stepView(h.page);
}

/**
 * The checks every step gets: its own line in this platform's words, the
 * bubble and the ring on screen and clear of each other, the ticker clear of
 * both, the page no bigger than the device, and the battle held if the step
 * holds it.
 */
export async function checkStep(h, id, { check, shot }) {
  const { page, device } = h;
  await page.waitForTimeout(250); // the bubble places itself on the frame after it shows
  const v = await stepView(page);
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
  // A bark is a word on the canvas. The bubble is DOM over the canvas and the
  // ring is drawn after the barks, so neither can be covered by one. What can
  // happen is a word sitting on the ring's line, and that is checked.
  if (v.barks.length > 0 && v.ring) {
    const onLine = v.barks.filter((b) => Math.abs(Math.hypot(b.x - v.ring.x, b.y - v.ring.y) - v.ring.r) < 7);
    const inside = v.barks.filter((b) => Math.hypot(b.x - v.ring.x, b.y - v.ring.y) < v.ring.r - 7).length;
    const under = v.barks.filter((b) => v.bubble && b.x > v.bubble.left && b.x < v.bubble.right && b.y > v.bubble.top && b.y < v.bubble.bottom).length;
    check(onLine.length === 0, `${tag}: no bark sits on the ring's line (${v.barks.length} on screen: ${v.barks.map((b) => b.kind).join(', ')}; ${inside} inside the ring, ${under} behind the bubble${onLine.length ? `; on the line: ${onLine.map((b) => b.kind).join(', ')}` : ''})`);
  }
  checkViewport(check, tag, v.vp);
  if (v.holds) {
    const held = await page.evaluate(async (t0) => { await new Promise((r) => setTimeout(r, 400)); return window.__game.sim.tick === t0; }, v.tick);
    check(held, `${tag}: the battle is held while the step waits`);
  }
  if (shot) await shot(id);
  return v;
}

/** A man of a squad who is on the visible map: where a player taps to pick it. */
export const manOf = (page, squad) =>
  page.evaluate((q) => {
    const g = window.__game, s = g.sim, st = g.stage();
    const pts = s.squads[q].soldierIds.map((i) => s.soldiers[i]).filter((m) => m.alive && !m.downed)
      .map((m) => { const [x, y] = g.cam.worldToScreen(m.x, m.y, innerWidth, innerHeight); return { x, y }; })
      .filter((p) => p.x > st.left + 8 && p.x < st.right - 8 && p.y > st.top + 8 && p.y < st.bottom - 8);
    return pts[0] ?? null;
  }, squad);

export const squadOrders = (page, squad) => page.evaluate((q) => { const s = window.__game.sim; return s.squads[q].teamIds.map((t) => `${s.teams[t].orderState.order?.kind ?? 'none'}/${s.teams[t].orderState.phase}`); }, squad);

/** The battle at 4x, through the game's own speed control. */
export async function setSpeed4(h) {
  const before = h.inputs;
  for (let i = 0; i < 3; i++) {
    if (await h.page.evaluate(() => /4/.test([...document.querySelectorAll('[data-act="speed"], [data-tb="speed"]')].find((e) => e.getBoundingClientRect().width > 0)?.textContent ?? ''))) break;
    await h.press(h.TOUCH ? '[data-tb="speed"]' : '#hud [data-act="speed"]');
  }
  h.inputs = before; // a gate convenience, not something the lesson asks of the player
}

const battleEnd = (page) => page.evaluate(() => { const s = window.__game.sim; const eff = (side) => s.soldiers.filter((m) => m.side === side && m.alive && !m.downed && !m.captured).length; return { winner: s.winner, blue: eff('blue'), blueStart: s.startStrength.blue, red: eff('red'), secs: Math.round(s.tick / 30) }; });

/**
 * Steps 1 and 2 of the drill: tap the squad, send it to the hedge. Returns the
 * drill as staged. The battle is running when this returns.
 */
export async function drillFirstOrder(h, ctx) {
  const { page, device } = h;
  const { check, label } = ctx;
  const d = await page.evaluate(() => window.__game.getDrill());
  await waitStep(h, 'drill-select', 15000);
  let v = await checkStep(h, 'drill-select', ctx);
  check(v.tick === 0, `${label}: the drill loads held at its first step (tick ${v.tick})`);
  await h.tap((await manOf(page, d.lead)) ?? v.ring);
  check((await page.evaluate(() => window.__game.getSelection().squads))[0] === d.lead, `${label}: a ${h.TOUCH ? 'tap' : 'click'} on the ringed squad selects it`);
  await waitStep(h, 'drill-move', 5000);
  v = await checkStep(h, 'drill-move', ctx);
  await h.order(v.ring);
  const moved = await squadOrders(page, d.lead);
  check(moved.every((o) => /^(move|fast|sneak)\//.test(o)), `${label}: a ${h.TOUCH ? 'hold' : 'right-click'} on the hedge orders the squad there (${moved.join(', ')})`);
  await page.waitForFunction((t) => window.__game.sim.tick > t + 3, v.tick, { timeout: 5000 }).catch(() => { throw new Error(`${device}: the battle did not start after the first order: onTutorialStep in src/main.ts releases the hold when the step retires.`); });
  return d;
}

/** The rest of the drill, from the enemy being seen to the farm taken. */
export async function drillToVictory(h, d, ctx) {
  const { page } = h;
  const { check, label, seed } = ctx;
  await setSpeed4(h);
  // 3. enemy seen: the battle stops by itself, Fire lights up
  await waitStep(h, 'drill-contact', 60000);
  let v = await checkStep(h, 'drill-contact', ctx);
  check(v.glow.includes('fire'), `${label}: the Fire chip is lit (${v.glow.join(',') || 'none lit'})`);
  await h.press('#orderbar [data-order="fire"]');
  // 4. then the enemy
  await waitStep(h, 'drill-fire', 5000);
  v = await checkStep(h, 'drill-fire', ctx);
  check(v.armed === 'fire', `${label}: Fire is armed (${v.armed})`);
  await h.order(v.ring);
  const firing = await squadOrders(page, d.lead);
  check(firing.some((o) => o.startsWith('fire/')), `${label}: a ${h.TOUCH ? 'hold' : 'right-click'} on the enemy gives the Fire order (${firing.join(', ')})`);

  // 5 and 6, and the recovery step when a squad refuses
  let recoveries = 0;
  for (;;) {
    const next = await page.waitForFunction(() => {
      const g = window.__game, s = g.tutorialView()?.step;
      return g.sim.winner ? 'won' : s === 'drill-quiet' || s === 'drill-assault' || s === 'drill-balk' ? s : false;
    }, null, { timeout: 180000, polling: 100 }).then((x) => x.jsonValue()).catch(async () => {
      const now = await stepView(page);
      throw new Error(`nothing happened for 180 s after the last order: step=${now.step} tick=${now.tick} winner=${now.winner}. houseIsQuiet (src/drill.ts) is what the next step waits on${seed !== undefined ? `; npx vite-node scripts/drillsweep.mjs -- --start ${seed} --seeds 1 --verbose plays the same seed headless` : ''}.`);
    });
    if (next === 'won') break;
    if (next === 'drill-quiet') {
      v = await checkStep(h, 'drill-quiet', ctx);
      const other = await page.evaluate(() => { const dd = window.__game.getDrill(); return dd.rifles.find((q) => q !== dd.shooter); });
      await h.tap((await manOf(page, other)) ?? v.ring);
      check((await page.evaluate(() => window.__game.getSelection().squads))[0] !== d.lead, `${label}: another squad is selected`);
      await waitStep(h, 'drill-assault', 5000);
    }
    if (next === 'drill-balk') {
      recoveries++;
      if (recoveries > 3) throw new Error(`the assault was refused ${recoveries} times. The recovery step is meant to be rare: scripts/drillsweep.mjs counts it.`);
      v = await checkStep(h, 'drill-balk', ctx);
      if (v.armed !== 'fire') await h.press('#orderbar [data-order="fire"]');
      await h.order(v.ring);
      continue;
    }
    v = await checkStep(h, 'drill-assault', ctx);
    check(v.glow.includes('assault'), `${label}: the Assault chip is lit (${v.glow.join(',') || 'none lit'})`);
    await h.press('#orderbar [data-order="assault"]');
    await h.order(v.ring);
    const sel = (await page.evaluate(() => window.__game.getSelection().squads))[0];
    const charge = await squadOrders(page, sel);
    check(charge.some((o) => /^(assault|move)\//.test(o)), `${label}: a ${h.TOUCH ? 'hold' : 'right-click'} on the house sends the assault (${charge.join(', ')})`);
  }
  const end = await battleEnd(page);
  check(end.winner === 'blue', `${label}: the farm is taken (winner ${end.winner}, ${end.blue}/${end.blueStart} men left, ${end.secs} s of battle, ${recoveries} recoveries)`);
  return { ...end, recoveries };
}

/** The card that ends the drill. Leaves it on screen. */
export async function checkEndCard(h, ctx) {
  const { page } = h;
  const { check, label, shot } = ctx;
  await page.waitForSelector('#debrief #next', { state: 'visible', timeout: 15000 }).catch(() => { throw new Error('no end card 15 s after the win: showDrillEnd in src/main.ts runs 4 s after sim.winner is set.'); });
  const card = await page.evaluate(() => ({
    h1: document.querySelector('#debrief h1')?.textContent,
    words: document.getElementById('debrief').innerText.split(/\s+/).filter(Boolean).length,
    buttons: [...document.querySelectorAll('#debrief button')].map((b) => b.textContent),
    bubble: !!document.querySelector('.coach'),
    doc: [document.documentElement.scrollWidth, innerWidth],
  }));
  check(card.h1 === 'FARM TAKEN' && card.buttons.length === 2, `${label}: the end card says so and offers two ways on (${card.h1}; ${card.buttons.join(' / ')})`);
  check(card.words <= 20, `${label}: the end card is ${card.words} words`);
  check(!card.bubble, `${label}: no tutorial bubble is left over the end card`);
  check(card.doc[0] <= card.doc[1], `${label}: the end card fits the width (${card.doc[0]} <= ${card.doc[1]})`);
  if (shot) await shot('end-card');
  return card;
}

/** Steps 1 and 2, then Play pressed and hands off for `simSecs` of battle. */
export async function drillIdle(h, simSecs, ctx) {
  const { page } = h;
  await drillFirstOrder(h, ctx);
  await setSpeed4(h);
  // The battle stops itself when the enemy is seen. A player who does nothing
  // more leaves it stopped, which cannot lose. The harder case is the player
  // who presses Play and walks away, so press it.
  await waitStep(h, 'drill-contact', 60000);
  await h.press(h.TOUCH ? '[data-tb="pause"]' : '#hud [data-act="pause"]');
  const from = await page.evaluate(() => window.__game.sim.tick);
  await page.waitForFunction(({ t, n }) => window.__game.sim.winner !== null || window.__game.sim.tick >= t + n * 30, { t: from, n: simSecs }, { timeout: simSecs * 1500, polling: 250 }).catch(() => {
    throw new Error(`the battle did not run ${simSecs} s of sim time in ${simSecs * 1.5} s of wall time at 4x: it is held or paused. A tutorial step that holds the battle must still let Play run it (onTutorialStep, src/main.ts).`);
  });
  return battleEnd(page);
}
