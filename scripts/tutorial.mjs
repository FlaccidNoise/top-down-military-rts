// The onboarding gate: a FRESH browser profile plays the game from the main
// menu to a real first victory, and every chapter of the tutorial has to fire
// on its own. Nothing here stages the outcome — the battle is fought with the
// same mouse and keyboard a player has, and if the company cannot win it, this
// gate goes red.
//
//   node scripts/tutorial.mjs                       # both legs
//   node scripts/tutorial.mjs --leg desktop         # desktop only
//   node scripts/tutorial.mjs --leg mobile          # phone only
//   node scripts/tutorial.mjs --shots DIR --port N  # where shots land / which server
//   node scripts/tutorial.mjs --seed 1263164463     # replay one war exactly
//   node scripts/tutorial.mjs --win-budget 600000   # longer leash on the battle
//
// Dev server must be running: npm run dev -- --port 5304 --strictPort
// Every run prints the seed it rolled, so a red run can be replayed with --seed.
//
// WHAT IS DRIVEN AND WHAT IS STAGED. Every decision the tutorial teaches is
// made through real input: menu clicks, a left-click on a company, a
// right-click on a town, the HUD's own clock buttons, ⇧-digit to arm an order.
// Two things are staged, both deliberately:
//   - the CAMERA, exactly as scripts/lib/stage.mjs stages it for the art gate.
//     Framing is a view concern; no game state moves.
//   - the two contact-modal strings a first battle cannot reach (a red attack,
//     and a 5:1 mismatch). Those are UI-string assertions, run in their own
//     fresh contexts against a live war — see stagedModalRun().
//
// NO HARDCODED SCREEN COORDINATES. Every campaign rolls a new seed, so every
// company and every town is somewhere else each run. Screen points are derived
// from live state through the same projection the renderer uses
// (TheaterView.toScreen / Camera.worldToScreen) and then round-tripped through
// the game's own hit-testers (forceAtScreen / nodeAtScreen) before a click is
// dispatched — if the click would miss, this fails loudly instead of silently
// clicking empty ground.
//
// EXPECTED COPY IS IMPORTED, NEVER RETYPED. Bubble text is read out of
// /src/ui/tutorial.ts in the page and compared against the DOM, so a copy edit
// updates both sides at once and can never drift past this gate.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch } from './lib/stage.mjs';

const PORT = Number(arg('port', '5304'));
const URL = arg('url', `http://[::1]:${PORT}`);
const SHOTS = arg('shots', '/private/tmp/lane-t-shots/gate');
const LEG = arg('leg', 'all');
const SEED = arg('seed', null); // pin the campaign to replay a failure
// 600s: organic maps (mapgen-v3) garrison every floor, and on some seeds the
// last defenders sit just above the 25% break-off floor for minutes — a 360s
// leash flaked on trajectory-healthy fights (blue 88 alive, red at 30%).
const WIN_BUDGET_MS = Number(arg('win-budget', '600000'));
const HOLD_MS = 420; // must match src/ui/touch.ts

const fails = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
};
const shots = [];
async function shot(page, name, claim) {
  const p = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p });
  shots.push({ path: p, claim });
  console.log(`  shot ${p} — ${claim}`);
}

// Poll on animation frames and fail with an instruction, never a bare timeout.
async function until(page, fn, argv, { timeout = 15000, what, fix }) {
  try {
    const h = await page.waitForFunction(fn, argv, { timeout, polling: 'raf' });
    return await h.jsonValue();
  } catch {
    const state = await page.evaluate(() => {
      const g = window.__game;
      const v2 = g?.getV2?.();
      return {
        screens: ['mainmenu', 'customize', 'briefing', 'manual', 'debrief', 'theater-hud', 'hud']
          .filter((id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none'; }),
        bubble: document.querySelector('.coach-text')?.textContent ?? null,
        mode: g?.getSelection?.().mode ?? null,
        theater: v2 ? { selectedForce: v2.selectedForce, pending: !!v2.pending, battle: !!v2.battle } : null,
        sim: g?.sim ? { tick: g.sim.tick, winner: g.sim.winner } : null,
      };
    }).catch(() => null);
    throw new Error(
      `gave up after ${timeout}ms waiting for ${what}.\n    live state: ${JSON.stringify(state)}\n    ${fix}`,
    );
  }
}

// ── the copy contract ─────────────────────────────────────────────────────
// The expected string comes out of the module under test, so this asserts the
// bubble the player SEES equals the bubble the driver MEANT to show.

const stepText = (page, id, touch) =>
  page.evaluate(async ({ id, touch }) => {
    const { STEPS } = await import('/src/ui/tutorial.ts');
    const s = STEPS.find((x) => x.id === id);
    if (!s) throw new Error(`no tutorial step '${id}' — STEPS ids are ${STEPS.map((x) => x.id).join(', ')}`);
    return s.text ? (touch ? s.text.touch : s.text.desktop) : null;
  }, { id, touch });

async function waitBubble(page, id, { touch = false, timeout = 20000 } = {}) {
  const want = await stepText(page, id, touch);
  const got = await until(
    page,
    (w) => {
      const e = document.querySelector('.coach-text');
      return e && e.textContent === w ? e.textContent : false;
    },
    want,
    {
      timeout,
      what: `the '${id}' coachmark (${touch ? 'touch' : 'desktop'} copy): "${want}"`,
      fix: `Either the step never fired (check the tutorial?.notify call for its showOn event in src/main.ts) or its anchor was not in the DOM when present() ran (src/ui/tutorial.ts returns silently when querySelector misses).`,
    },
  );
  check(got === want, `${id} bubble shows its own ${touch ? 'touch' : 'desktop'} copy`);
  // Present in the DOM is not the same as readable. A bubble anchored to tall
  // chrome flips above its target and can land off the top of the viewport,
  // where its text exists and nobody can read it.
  const box = await page.evaluate(async () => {
    // coach.ts clamps and flips the bubble inside a requestAnimationFrame, so
    // the rect one tick after append is not where the player sees it.
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    await raf();
    await raf();
    const e = document.querySelector('.coach');
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight };
  });
  check(
    box.top >= 0 && box.left >= 0 && box.right <= box.w + 1 && box.bottom <= box.h + 1,
    `${id} bubble is fully on screen (${box.left},${box.top}–${box.right},${box.bottom} inside ${box.w}x${box.h})` +
      (box.top < 0 ? ' — it is clipped off the TOP: coach.ts flips a bubble above its target when it would fall off the bottom, and never checks that it fits up there' : ''),
  );
  return got;
}

// ── boot ──────────────────────────────────────────────────────────────────

/**
 * SERVER IDENTITY. A dev server on the expected port can belong to another
 * checkout — a lesson this repo has already paid for once. Before asserting
 * anything, prove the server is serving THIS lane by fetching two sources and
 * looking for symbols only this lane has.
 */
async function preflight(page) {
  for (const [path, symbol] of [['/src/ui/tutorial.ts', 'TUTORIAL_STORAGE_KEY'], ['/src/ui/theater-hud.ts', 'objHelp']]) {
    const res = await page.request.get(`${URL}${path}`);
    const body = res.ok() ? await res.text() : '';
    if (!body.includes(symbol))
      throw new Error(
        `${URL}${path} does not contain '${symbol}' (HTTP ${res.status()}).\n    The server on this port is NOT this worktree. Kill it and start your own:\n    npm run dev -- --port ${PORT} --strictPort   (run it inside the lane-t worktree)`,
      );
  }
  console.log(`  ok   server at ${URL} serves this lane (tutorial.ts + theater-hud.ts symbols present)`);
}

/** Main menu → New Operation → Generate & Play, on a profile with no history. */
async function newOperation(page, { tap = false } = {}) {
  await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
  await until(page, () => '__game' in window, null, {
    what: '__game to appear',
    fix: `The app never booted. Check the dev server log and the browser console; the URL must be ${URL}/ with NO ?camp= (the pinned art path has no tutorial at all).`,
  });
  const fresh = await page.evaluate(() => ({
    tutorial: localStorage.getItem('rts.tutorial.v1'),
    continueDisabled: document.getElementById('mm-continue')?.disabled ?? null,
  }));
  check(fresh.tutorial === null, 'fresh profile: no rts.tutorial.v1 in localStorage at boot');
  check(fresh.continueDisabled !== false, 'fresh profile: no saved campaign behind Continue');

  const click = async (sel) => {
    if (tap) {
      const b = await page.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, sel);
      await page.touchscreen.tap(b.x, b.y);
    } else await page.click(sel);
  };
  await until(page, () => !!document.getElementById('mm-new'), null, { what: 'the main menu', fix: 'MainMenu.open() runs at boot unless ?camp= pinned the art path.' });
  await click('#mm-new');
  await until(page, () => { const b = document.getElementById('cz-go'); return !!b && !b.disabled; }, null, {
    what: 'the customize screen with a valid config (#cz-go enabled)',
    fix: 'Generate & Play stays disabled while the theater config is rejected — read #cz-reject.',
  });
  // A rolled seed is the point — every run is a different war, which is what
  // stops this gate from ever depending on a pixel. --seed pins one so a
  // failure can be replayed.
  if (SEED !== null) {
    await page.fill('#cz-seed', SEED);
    await page.dispatchEvent('#cz-seed', 'input');
  }
  await click('#cz-go');
  await until(page, () => !!window.__game.getV2(), null, {
    what: 'a V2 campaign to exist after Generate & Play',
    fix: 'startCampaignV2 threw; a generation reject leaves #boot-error on screen with the reason.',
  });
  const seed = await page.evaluate(() => window.__game.getV2().seed);
  console.log(`  campaign seed ${seed}${SEED === null ? ' (rolled; replay this run with --seed ' + seed + ')' : ' (pinned)'}`);
  return seed;
}

// ── screen geometry ───────────────────────────────────────────────────────
// A point is only clickable if the CANVAS gets the event. The theater HUD is
// opaque DOM on top; a click that lands on a panel never reaches the game.
//
// theaterTargets answers both questions the theater phase asks — which company
// to click, which town to right-click — from live state, and only returns a
// point the game's own hit-tester agrees with.

const theaterTargets = (page) =>
  page.evaluate(async () => {
    const { orderMove } = await import('/src/strategic/theater/step.ts');
    const W = innerWidth, H = innerHeight;
    // The coachmark is DOM too: a click that lands on the bubble teaching the
    // move never reaches the map underneath it.
    const blocked = [...document.querySelectorAll('#theater-hud .panel, #squads, #hint, #obj-strip, #touchbar, .coach, #briefing')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const clear = (x, y) =>
      x > 10 && y > 10 && x < W - 10 && y < H - 10 &&
      !blocked.some((r) => x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6);

    const v2 = window.__game.getV2();
    // The strongest company whose marker is on screen and actually hittable.
    const force = v2.front.forces
      .filter((f) => f.side === 'blue' && f.strength > 0 && f.engagedIn === null)
      .map((f) => {
        const p = v2.view.forceXY(f);
        const [x, y] = v2.view.toScreen(p.x, p.y, W, H);
        return { id: f.id, name: f.name, strength: f.strength, x: Math.round(x), y: Math.round(y) };
      })
      .filter((c) => clear(c.x, c.y) && v2.view.forceAtScreen(v2.front, 'blue', c.x, c.y, W, H) === c.id)
      .sort((a, b) => b.strength - a.strength)[0] ?? null;

    // An unheld control node a red garrison is actually sitting on — an empty
    // one flips without a fight and the player never sees a battle — that this
    // company can be ordered onto, weakest first: the target a briefed player
    // picks. Reachability is asked of orderMove itself rather than guessed at
    // (a pure ford objective refuses every order), dry-run on a saved path so
    // the theater is exactly as it was.
    const ctrl = v2.goals.blue.find((c) => c.kind === 'control');
    if (!ctrl) throw new Error('blue has no control goal — makeWarGoals changed shape');
    const redAt = (n) => v2.front.forces
      .filter((f) => f.side === 'red' && f.strength > 0 && f.pos.kind === 'node' && f.pos.nodeId === n)
      .reduce((a, f) => a + f.strength, 0);
    const wouldTake = (nodeId) => {
      if (!force) return { ok: false, reason: 'no company selected' };
      const f = v2.front.forces.find((x) => x.id === force.id);
      const saved = f.path.slice();
      const r = orderMove(v2.front, force.id, nodeId);
      f.path = saved;
      return r;
    };
    const cands = ctrl.nodeIds
      .filter((n) => v2.front.controlByNode[n] !== 'blue')
      .map((n) => {
        const node = v2.front.theater.nodes[n];
        const [x, y] = v2.view.toScreen(node.pos.x, node.pos.y, W, H);
        const r = wouldTake(n);
        return { node: n, name: node.name, kind: node.kind, red: redAt(n), x: Math.round(x), y: Math.round(y), takes: r.ok, why: r.ok ? null : r.reason };
      });
    const objective = cands
      .filter((c) => c.red > 0 && c.takes && clear(c.x, c.y) && v2.view.nodeAtScreen(c.x, c.y, W, H) === c.node)
      .sort((a, b) => a.red - b.red)[0] ?? null;

    return {
      force, objective, cands,
      held: v2.front.controlByNode.filter((c) => c === 'blue').length,
      objectives: ctrl.nodeIds.length,
      need: ctrl.need,
    };
  });

// ── the battle ────────────────────────────────────────────────────────────

/** Frame every living blue, then box-drag the clear region: the whole company. */
async function selectCompany(page) {
  const box = await page.evaluate(() => {
    const g = window.__game, s = g.sim, W = innerWidth, H = innerHeight;
    const r = (id) => { const b = document.getElementById(id)?.getBoundingClientRect(); return b && b.width > 0 && b.height > 0 ? b : null; };
    const sq = r('squads'), hint = r('hint'), strip = r('obj-strip');
    const L = (sq ? sq.right : 0) + 14, T = (strip ? strip.bottom : 0) + 14;
    const B = (hint ? hint.top : H) - 14, R = W - 14;
    const blue = s.soldiers.filter((m) => m.alive && m.side === 'blue' && m.inVehicle < 0);
    if (!blue.length) return null;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const m of blue) { x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y); x1 = Math.max(x1, m.x); y1 = Math.max(y1, m.y); }
    // Frame the company: view-only, the same staging every harness here does.
    g.cam.scale = Math.max(2, Math.min(g.cam.scale, Math.min((R - L) / Math.max(4, x1 - x0 + 10), (B - T) / Math.max(4, y1 - y0 + 10))));
    g.cam.x = (x0 + x1) / 2;
    g.cam.y = (y0 + y1) / 2;
    // Both ends of the drag must land on the CANVAS: mousedown on a panel
    // never starts a box and mouseup on one never commits it. Walk each corner
    // inwards until the point really is the map.
    const canvas = document.querySelector('canvas');
    const onMap = (x, y) => document.elementFromPoint(x, y) === canvas;
    const walk = (x, y, dx, dy) => {
      for (let i = 0; i < 40; i++) {
        const px = x + dx * i * 8, py = y + dy * i * 8;
        if (onMap(px, py)) return { x: Math.round(px), y: Math.round(py) };
      }
      return null;
    };
    const from = walk(L, T, 1, 1);
    const to = walk(R, B, -1, -1);
    return {
      from, to,
      blocking: [document.elementFromPoint(L, T), document.elementFromPoint(R, B)]
        .map((e) => (e && e !== canvas ? (e.id || e.className || e.tagName) : null)).filter(Boolean),
    };
  });
  if (!box || !box.from || !box.to) return { sel: 0, total: 0, blocked: box?.blocking ?? ['no living blue'] };
  await page.mouse.move(box.from.x, box.from.y);
  await page.mouse.down();
  await page.mouse.move((box.from.x + box.to.x) / 2, (box.from.y + box.to.y) / 2, { steps: 3 });
  await page.mouse.move(box.to.x, box.to.y, { steps: 3 });
  await page.mouse.up();
  const got = await page.evaluate(() => {
    const g = window.__game, s = g.sim;
    return {
      sel: g.getSelection().squads.length,
      total: s.squads.filter((q) => q.side === 'blue' && q.soldierIds.some((i) => s.soldiers[i].alive && s.soldiers[i].inVehicle < 0)).length,
    };
  });
  return { ...got, blocked: box.blocking };
}

/** The densest surviving enemy knot, centred and projected to screen. */
const enemyKnot = (page) =>
  page.evaluate(() => {
    const g = window.__game, s = g.sim;
    const red = s.soldiers.filter((m) => m.alive && !m.downed && !m.captured && m.side === 'red');
    if (!red.length) return null;
    let best = red[0], bestN = -1;
    for (const m of red) {
      let n = 0;
      for (const o of red) if (Math.hypot(o.x - m.x, o.y - m.y) < 14) n++;
      if (n > bestN) { bestN = n; best = m; }
    }
    g.cam.x = best.x;
    g.cam.y = best.y;
    const [x, y] = g.cam.worldToScreen(best.x, best.y, innerWidth, innerHeight);
    return { x: Math.round(x), y: Math.round(y), wx: best.x, wy: best.y, knot: bestN, left: red.length };
  });

const battleState = (page) =>
  page.evaluate(() => {
    const s = window.__game.sim;
    const eff = (side) => s.soldiers.filter((m) => m.alive && !m.downed && !m.captured && m.side === side).length;
    return { tick: s.tick, blue: eff('blue'), red: eff('red'), winner: s.winner, start: s.startStrength, barrage: s.barragesLeft.blue, air: s.airstrikesLeft.blue };
  });

// The company's doctrine, which is the game's own: smoke the position, put
// fire on it, then go in. ORDER_AFFORDANCE calls assault "charge a SUPPRESSED
// position; pairs with smoke", and BALK_HINT tells a balked assault to
// "suppress or smoke the objective, then re-issue" — walking that cycle is
// playing the game as taught, and a bare assault loop is not.
const CYCLE = [
  { key: 'Shift+Digit5', order: 'smoke', label: 'smoke' },
  { key: 'Shift+Digit4', order: 'fire', label: 'fire' },
  { key: 'Shift+Digit8', order: 'assault', label: 'assault' },
];

/**
 * Fight it. Select the company, arm an order, send it at the strongest knot of
 * defenders, and call the guns when the kill rate flatlines. Nothing here
 * touches sim state — every order goes in through the same keyboard and mouse
 * a player uses.
 */
async function fightToWin(page) {
  const t0 = Date.now();
  let round = 0;
  let lastRed = Infinity;
  let stall = 0;
  let checked = false;
  for (;;) {
    const st = await battleState(page);
    if (st.winner) return { winner: st.winner, ms: Date.now() - t0, rounds: round, ...st };
    if (Date.now() - t0 > WIN_BUDGET_MS) return { winner: null, ms: Date.now() - t0, rounds: round, ...st };

    const sel = await selectCompany(page);
    const knot = await enemyKnot(page);
    if (!knot) { await page.waitForTimeout(500); continue; }
    const step = CYCLE[round % CYCLE.length];
    await page.keyboard.press(step.key);
    if (!checked) {
      // Assert the arming contract once, on the order the tutorial names.
      await page.keyboard.press('Shift+Digit8');
      const armed = await page.evaluate(() => window.__game.getSelection().armedOrder);
      check(armed === 'assault', `⇧8 arms the assault order (armedOrder=${armed})`);
      check(
        sel.sel === sel.total && sel.total > 0,
        `box-drag selects the whole company (${sel.sel}/${sel.total} squads${sel.blocked?.length ? `; DOM over the drag corners: ${sel.blocked.join(', ')}` : ''})`,
      );
      checked = true;
    }
    await page.mouse.click(knot.x, knot.y, { button: 'right' });

    if (st.red >= lastRed) stall++; else stall = 0;
    lastRed = st.red;
    // Every fourth pass, so the log rotates through the cycle instead of
    // reporting the same rung of it forever.
    if (round % 4 === 0)
      console.log(`    t+${((Date.now() - t0) / 1000).toFixed(0)}s squads=${sel.sel}/${sel.total} blue=${st.blue}/${st.start.blue} red=${st.red}/${st.start.red} knot=${knot.knot} ${step.label}`);
    // A position that stops giving ground is what the heavy support is for.
    if (stall >= 2 && (st.barrage > 0 || st.air > 0)) {
      await page.keyboard.press(st.barrage > 0 ? 'KeyB' : 'KeyV');
      await page.mouse.click(knot.x, knot.y);
      console.log(`    t+${((Date.now() - t0) / 1000).toFixed(0)}s ${st.barrage > 0 ? 'barrage' : 'airstrike'} called on the knot`);
      stall = 0;
    }
    round++;
    await page.waitForTimeout(4000);
  }
}

// ── desktop leg ───────────────────────────────────────────────────────────

async function desktopLeg() {
  // --viewport WxH shrinks the window AFTER launch — for narrow-window checks
  // (the deploy banner wrap). The default stays the stage.mjs desktop profile.
  const vp = arg('viewport', null);
  console.log(`\n=== desktop ${vp ?? '1280x800'} · fresh profile · full tutorial → first victory ===`);
  const { browser, page } = await launch({ device: 'desktop' });
  if (vp) {
    const [w, h] = vp.split('x').map(Number);
    if (!w || !h) throw new Error(`--viewport wants WxH, got "${vp}"`);
    await page.setViewportSize({ width: w, height: h });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  try {
    await preflight(page);
    await newOperation(page);

    // ch1 — the briefing card is the first thing a new player ever sees.
    await until(page, () => !!document.getElementById('briefing'), null, {
      what: 'the briefing card (#briefing)',
      fix: "The 'briefing' step fires on campaign-start, notified one rAF after startCampaignV2 (src/main.ts). Check that ?camp= is absent — campPinned disables the tutorial outright.",
    });
    const bf = await page.evaluate(async () => {
      const { MANUAL } = await import('/src/ui/manual-data.ts');
      const goal = MANUAL.find((c) => c.id === 'goal');
      return {
        entries: [...document.querySelectorAll('#briefing .bf-entry h3')].map((e) => e.textContent),
        want: goal.entries.slice(0, 3).map((e) => e.heading),
        buttons: [...document.querySelectorAll('#briefing button')].map((b) => b.id),
      };
    });
    check(JSON.stringify(bf.entries) === JSON.stringify(bf.want), `briefing card carries the manual's first three goal entries (${bf.entries.join(' · ')})`);
    check(JSON.stringify(bf.buttons) === JSON.stringify(['bf-begin', 'bf-manual', 'bf-skip']), `briefing card offers Begin, Field Manual and Skip (${bf.buttons.join(', ')})`);
    await shot(page, 'ch1-briefing', 'chapter 1: the briefing card on a fresh profile, before anything else');

    // ch2 — Begin hands over to the live game.
    await page.click('#bf-begin');
    check(await page.evaluate(() => !document.getElementById('briefing')), 'Begin retires the briefing card');
    await waitBubble(page, 'select-force');
    await shot(page, 'ch2-select-force', 'chapter 2: the select-a-company coachmark over the live theater');

    // ch3 — click a company. Derived from live state, never a fixed pixel.
    const { force } = await theaterTargets(page);
    if (!force) throw new Error('no blue company is both on screen and clear of the theater HUD panels — the theater view failed to frame the player\'s own forces. Check TheaterView.frameFor / clampPan.');
    console.log(`  target company: ${force.name} (${force.strength} men) at ${force.x},${force.y}`);
    await page.mouse.click(force.x, force.y);
    check(await page.evaluate((id) => window.__game.getV2().selectedForce === id, force.id), `clicking ${force.name} selects it`);
    await waitBubble(page, 'march');
    await shot(page, 'ch3-march', 'chapter 3: company selected, the march coachmark explains right-click');

    // ch4 — right-click an objective a garrison is holding.
    const theater = await theaterTargets(page);
    const obj = theater.objective;
    if (!obj)
      throw new Error(
        `no unheld objective is garrisoned, reachable AND hittable (held ${theater.held}, need ${theater.need} of ${theater.objectives}).\n    ` +
        `candidates: ${theater.cands.map((c) => `${c.name} [${c.kind}] red=${c.red} ${c.takes ? 'reachable' : `refused: ${c.why}`}`).join(' · ')}\n    ` +
        'An ungarrisoned objective flips without a fight and an unreachable one cannot be ordered at all, so no battle is reachable from here. If EVERY objective refuses, the war is unwinnable as generated — that is a makeWarGoals/makeTheater finding, not a script bug.',
      );
    console.log(`  march target: ${obj.name} [${obj.kind}] (node ${obj.node}, ${obj.red} defenders)`);
    await page.mouse.click(obj.x, obj.y, { button: 'right' });
    const marching = await page.evaluate((id) => {
      const v2 = window.__game.getV2();
      return { edges: v2.front.forces.find((f) => f.id === id).path.length, flash: v2.view.flashText };
    }, force.id);
    check(marching.edges > 0, `right-clicking ${obj.name} puts ${force.name} on the road (${marching.edges} edges${marching.edges ? '' : `, view says "${marching.flash}"`})`);
    await waitBubble(page, 'speed');
    await shot(page, 'ch4-speed', 'chapter 4: march ordered, the speed coachmark points at the clock');

    // ch5 — run the clock until they meet.
    const before = await page.evaluate(() => window.__game.getV2().front.clockMin);
    await page.click('#theater-hud [data-clock="2"]');
    await page.click('#theater-hud [data-clock="pause"]');
    // The war clock itself, not the label: the HUD is signature-throttled and
    // still shows the pre-click text for a frame after Resume.
    const clock = await until(
      page,
      (b) => {
        const min = window.__game.getV2().front.clockMin;
        return min > b ? { min, label: (document.querySelector('#theater-hud .st-pause')?.textContent ?? '').trim() } : false;
      },
      before,
      {
        timeout: 8000,
        what: 'the theater clock to start advancing after Resume',
        fix: 'The clock buttons are #theater-hud [data-clock] (src/ui/theater-hud.ts) — data-clock="pause" toggles stratPaused, "2" sets 60×. A stuck clock means the click never reached the handler.',
      },
    );
    check(clock.min > before, `the clock is running (${before} → ${clock.min} theater minutes; the control now reads "${clock.label}")`);
    await until(page, () => !!document.getElementById('fight'), null, {
      timeout: 180000,
      what: 'the contact modal (#fight)',
      fix: 'The company marched but never met anyone. Either the garrison left before it arrived, or stepWar stopped raising contacts — check detectContacts and v2.pending in src/main.ts.',
    });
    // Where the fight is actually happening. A march at a distant objective
    // routinely meets a garrison ON THE WAY, and it is that ground — not the
    // destination — that changes hands when the battle is won.
    const contact = await page.evaluate(() => {
      const v2 = window.__game.getV2();
      const c = v2.pending;
      const site = c && c.site.kind === 'node' ? { node: c.site.nodeId, name: v2.front.theater.nodes[c.site.nodeId].name } : null;
      return {
        site,
        odds: document.querySelector('.fc-odds')?.textContent ?? null,
        forced: !!document.querySelector('.fc-forced'),
        fight: document.getElementById('fight')?.textContent,
        standdown: !!document.getElementById('standdown'),
      };
    });
    if (contact.site) console.log(`  contact at ${contact.site.name} (node ${contact.site.node})`);
    check(contact.odds !== null && /outnumber|Even match/.test(contact.odds), `contact modal states the odds in words: "${contact.odds}"`);
    // Whoever chose this fight, the modal has to agree with itself: an attacker
    // may walk away, a defender may not. Marching companies are normally the
    // attacker, but a garrison that sorties first is a legal way to meet.
    const blueAttacks = contact.fight === 'Attack';
    check(
      blueAttacks ? contact.standdown && !contact.forced : !contact.standdown && contact.forced,
      `the modal matches the side we are on: ${blueAttacks ? 'attacking — Attack + Stand down, no forced line' : 'defending — Defend, no Stand down, forced line present'}`,
    );
    await waitBubble(page, 'contact');
    await shot(page, 'ch5-contact', 'chapter 5: the contact modal with the odds line and the contact coachmark');

    // ch6 — deployment.
    await page.click('#fight');
    await until(page, () => window.__game.getSelection().mode === 'battle', null, {
      what: 'the battle to boot after Attack',
      fix: 'startTheaterBattle threw — check makeTheaterBattle in the console output.',
    });
    await waitBubble(page, 'deploy');
    await shot(page, 'ch6-deploy', 'chapter 6: deployment — zone drawn, the deploy coachmark points at Resume');

    // Prove it really is the deployment phase: repositioning teleports men
    // inside the zone with the clock stopped. Nothing else in the game does
    // that, so this is the phase asserting itself.
    const dep = await page.evaluate(async (blueAttacks) => {
      const { DEPLOY_ATK_DEPTH, DEPLOY_DEF_LINE, DEPLOY_DEF_DEFAULT } = await import('/src/strategic/deploy.ts');
      const { BATTLE_CLASS_TO_MAPKIND } = await import('/src/strategic/theater.ts');
      const g = window.__game, s = g.sim;
      // The zone the game will accept, read off the same constants it reads.
      const kind = BATTLE_CLASS_TO_MAPKIND[g.getV2().battle.tb.battleClass];
      const zone = blueAttacks
        ? { x0: 0, x1: DEPLOY_ATK_DEPTH }
        : { x0: DEPLOY_DEF_LINE[kind] ?? DEPLOY_DEF_DEFAULT, x1: s.map.w };
      const men = s.soldiers.filter((m) => m.alive && m.side === 'blue' && m.inVehicle < 0);
      const squad = men[0].squadId;
      const mine = men.filter((m) => m.squadId === squad);
      const pick = mine[0];
      const [sx, sy] = g.cam.worldToScreen(pick.x, pick.y, innerWidth, innerHeight);
      // A clear spot inside our own strip, away from where they stand.
      const ty = Math.max(8, Math.min(s.map.h - 8, pick.y + 18));
      const tx = Math.max(zone.x0 + 2, Math.min(zone.x1 - 3, pick.x));
      const [tsx, tsy] = g.cam.worldToScreen(tx, ty, innerWidth, innerHeight);
      return {
        squad, zone, kind, tick: s.tick,
        before: mine.map((m) => ({ id: m.id, x: m.x, y: m.y })),
        sx: Math.round(sx), sy: Math.round(sy), tsx: Math.round(tsx), tsy: Math.round(tsy), tx, ty,
      };
    }, blueAttacks);
    await page.mouse.click(dep.sx, dep.sy);
    const selected = await page.evaluate(() => window.__game.getSelection().squads);
    check(selected.length >= 1, `clicking a man in the deploy zone selects his squad (${selected.join(',')})`);
    await page.mouse.click(dep.tsx, dep.tsy, { button: 'right' });
    const moved = await page.evaluate(({ before, squad, tx, ty, zone }) => {
      const s = window.__game.sim;
      const now = before.map((b) => s.soldiers[b.id]);
      const shifted = now.filter((m, i) => Math.hypot(m.x - before[i].x, m.y - before[i].y) > 1).length;
      const near = now.filter((m) => Math.hypot(m.x - tx, m.y - ty) < 12).length;
      const inZone = now.every((m) => m.x >= zone.x0 && m.x <= zone.x1);
      return { shifted, near, inZone, tick: s.tick, of: now.length, squad };
    }, dep);
    check(moved.shifted > 0 && moved.near > 0, `right-click repositions the squad instantly inside the zone (${moved.shifted}/${moved.of} men moved, ${moved.near} landed on the spot)`);
    check(moved.inZone, `repositioned men stay inside our own ${blueAttacks ? 'attack' : 'defence'} zone on a ${dep.kind} map (x ${dep.zone.x0}–${Math.round(dep.zone.x1)})`);
    check(moved.tick === dep.tick, `the clock never ticked during deployment (tick ${moved.tick})`);

    // ch7 — Resume commits the deployment and starts the fight.
    await page.click('#hud [data-act="pause"]');
    await waitBubble(page, 'battle-orders');
    const running = await until(page, (t) => window.__game.sim.tick > t + 5 ? window.__game.sim.tick : false, moved.tick, {
      what: 'the sim to advance after Resume',
      fix: 'Resume must clear deployPhase and unpause (src/main.ts, the deployPhase && !paused branch).',
    });
    check(running > moved.tick, `Resume begins the battle (tick ${moved.tick} → ${running})`);
    await shot(page, 'ch7-battle-orders', 'chapter 7: the fight has begun and the battle-orders coachmark names the order keys');

    // ch8 — win it for real.
    console.log(`  fighting (budget ${(WIN_BUDGET_MS / 1000).toFixed(0)}s)…`);
    const out = await fightToWin(page);
    if (out.winner !== 'blue') {
      const detail = `blue ${out.blue}/${out.start.blue} vs red ${out.red}/${out.start.red} effective after ${(out.ms / 1000).toFixed(0)}s and ${out.rounds} order passes; sim.winner=${out.winner}`;
      throw new Error(
        `THE GUIDED VICTORY IS NOT REACHABLE: ${detail}.\n    ` +
        (out.winner === 'red'
          ? 'The company the tutorial sends at the weakest garrisoned objective LOST. That is a balance finding, not a script bug — a first battle a briefed player cannot win is a broken onboarding.'
          : 'Red never dropped below the break-off floor (25% of its starting strength, src/sim/sim.ts). Raise --win-budget to confirm it is only slow, then look at whether the survivors are reachable at all (holed up on an upper floor with no assault route).'),
      );
    }
    console.log(`  victory in ${(out.ms / 1000).toFixed(0)}s over ${out.rounds} order passes (red ${out.red}/${out.start.red} left)`);
    check(true, `blue wins the first battle in ${(out.ms / 1000).toFixed(0)}s of real time`);

    await until(page, () => !!document.getElementById('next'), null, {
      timeout: 30000,
      what: 'the debrief (#next)',
      fix: 'showDebrief runs 4s after sim.winner is set (src/main.ts frame loop).',
    });
    const debrief = await page.evaluate(() => ({
      heading: document.querySelector('#debrief h1')?.textContent ?? null,
      sub: document.querySelector('#debrief .sub')?.textContent ?? null,
      ground: [...document.querySelectorAll('#debrief .sub')].map((e) => e.textContent).join(' | '),
    }));
    check(debrief.heading === 'VICTORY', `the debrief declares VICTORY (got "${debrief.heading}")`);
    await waitBubble(page, 'debrief');
    await shot(page, 'ch8-victory', 'chapter 8: the victory debrief with the "these men persist" coachmark');

    // ch9 — back on the theater, the ground has changed hands.
    await page.click('#next');
    const ground = contact.site ?? obj;
    const after = await until(
      page,
      (node) => {
        const v2 = window.__game.getV2();
        if (!v2 || v2.battle) return false;
        // The HUD is signature-throttled, so read it only once it has caught
        // up with the war's own event list — otherwise this asserts on the
        // frame BEFORE the capture was drawn.
        const last = v2.front.events[v2.front.events.length - 1];
        const log = [...document.querySelectorAll('#theater-hud .th-ev')].map((e) => e.textContent);
        if (!last || !log.some((t) => t.includes(last.text))) return false;
        return {
          owner: v2.front.controlByNode[node],
          captures: v2.front.events.filter((e) => e.kind === 'capture' && e.nodeId === node).map((e) => e.text),
          log,
          held: v2.front.controlByNode.filter((c) => c === 'blue').length,
        };
      },
      ground.node,
      {
        what: 'the theater to come back up and the event log to catch up after the debrief',
        fix: 'The #next handler sets mode = strategic and clears v2.battle (src/main.ts showDebrief); TheaterHud.update redraws the log on the next frame.',
      },
    );
    check(after.owner === 'blue', `${ground.name} is ours now (controlByNode = ${after.owner}, ${after.held} nodes held)`);
    check(
      after.captures.length > 0 && after.log.some((t) => after.captures.some((c) => t.includes(c))),
      `the event log shows the capture (${after.captures.join(' / ') || `the war logged no capture for ${ground.name}`}; log reads: ${after.log.slice(0, 2).join(' / ')})`,
    );
    await shot(page, 'ch9-captured', `chapter 9: back on the theater — ${ground.name} taken, the capture in the event log`);

    // The tutorial's own record of the run.
    const state = await page.evaluate(async () => {
      const { STEPS, TUTORIAL_STORAGE_KEY } = await import('/src/ui/tutorial.ts');
      return { saved: JSON.parse(localStorage.getItem(TUTORIAL_STORAGE_KEY) ?? 'null'), all: STEPS.map((s) => s.id), key: TUTORIAL_STORAGE_KEY };
    });
    check(state.saved !== null && state.saved.skipped === false, `${state.key} records a played-through tutorial (skipped=${state.saved?.skipped})`);
    const missing = state.all.filter((id) => !(state.saved?.done ?? []).includes(id));
    check(missing.length === 0, `every step is retired in storage${missing.length ? `: missing ${missing.join(', ')}` : ` (${state.all.length}/${state.all.length})`}`);

    check(errors.length === 0, `no page or console errors on the whole run${errors.length ? `: ${[...new Set(errors)].slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await browser.close();
  }
}

// ── the two strings a first battle cannot reach ───────────────────────────
// Both are contact-modal copy, so both need a live war and a contact the
// player did not choose. Staged on purpose, in their own fresh contexts, and
// the numbers are read out of the app rather than typed here.

async function stagedModalRun(which) {
  console.log(`\n=== staged contact modal: ${which === 'defender' ? 'red chose this fight' : 'a 5:1 mismatch'} ===`);
  const { browser, page } = await launch({ device: 'desktop' });
  try {
    await newOperation(page);
    await until(page, () => !!document.getElementById('briefing'), null, { what: 'the briefing card', fix: 'see the desktop leg' });
    await page.click('#bf-skip'); // this run is about modal copy, not the chain

    const staged = await page.evaluate(async (which) => {
      const { TRIVIAL_RATIO } = await import('/src/strategic/bridge.ts');
      const { orderMove } = await import('/src/strategic/theater/step.ts');
      const v2 = window.__game.getV2();
      const live = (side) => v2.front.forces.filter((f) => f.side === side && f.strength > 0 && f.engagedIn === null);
      if (which === 'defender') {
        // Red must be the one who chose the fight. detectContacts orients on
        // movement first, then on the higher id, so a red force parked on top
        // of a stationary blue one attacks deterministically.
        const blue = live('blue').find((f) => f.pos.kind === 'node' && f.path.length === 0);
        if (!blue) return { ok: false, why: 'no idle blue company parked on a node' };
        const red = live('red').filter((f) => f.id > blue.id).sort((a, b) => b.id - a.id)[0];
        if (!red) return { ok: false, why: 'no red force has an id above a stationary blue force' };
        red.pos = { ...blue.pos };
        red.path = [];
        red.strength = blue.strength; // even odds: the forced line, not the mismatch line
        return { ok: true, ratio: TRIVIAL_RATIO, attacker: red.name, defender: blue.name };
      }
      // A mismatch the player walks into. Marching at the weak force across
      // the map would meet whichever garrison lies between, so the two are put
      // on the same ground and OUR company is the one moving — orient() makes
      // the mover the attacker, which is the modal this asserts.
      const blue = live('blue').find((f) => f.pos.kind === 'node' && f.path.length === 0);
      const red = live('red').sort((a, b) => a.strength - b.strength)[0];
      if (!blue || !red) return { ok: false, why: 'no idle blue company or no live red force' };
      red.pos = { ...blue.pos };
      red.path = [];
      red.strength = Math.max(1, Math.floor(blue.strength / (TRIVIAL_RATIO + 1)));
      const here = blue.pos.nodeId;
      const nextDoor = v2.front.theater.edges.find((e) => e.a === here || e.b === here);
      if (!nextDoor) return { ok: false, why: `node ${here} has no road out` };
      const r = orderMove(v2.front, blue.id, nextDoor.a === here ? nextDoor.b : nextDoor.a);
      if (!r.ok) return { ok: false, why: `orderMove rejected: ${r.reason}` };
      return { ok: true, ratio: TRIVIAL_RATIO, attacker: blue.name, defender: red.name, ratioNow: blue.strength / red.strength };
    }, which);
    if (!staged.ok) throw new Error(`could not stage the ${which} contact: ${staged.why}`);

    await page.click('#theater-hud [data-clock="2"]');
    await page.click('#theater-hud [data-clock="pause"]');
    await until(page, () => !!document.getElementById('fight'), null, {
      timeout: 90000,
      what: `the staged ${which} contact modal`,
      fix: 'The staged forces never met. detectContacts pairs at CONTACT_M over final positions each minute (src/strategic/theater/contact.ts) — check that neither force was re-tasked by the red commander first.',
    });
    const modal = await page.evaluate(() => ({
      odds: document.querySelector('.fc-odds')?.textContent ?? '',
      forced: document.querySelector('.fc-forced')?.textContent ?? null,
      fight: document.getElementById('fight')?.textContent ?? null,
      auto: !!document.getElementById('autoresolve'),
      standdown: !!document.getElementById('standdown'),
    }));
    if (which === 'defender') {
      check(modal.forced === 'They chose this fight. A defender cannot stand down.', `defender modal states "A defender cannot stand down." (got ${JSON.stringify(modal.forced)})`);
      check(modal.fight === 'Defend' && !modal.standdown, `a defender is offered Defend and no Stand down (button "${modal.fight}", standdown=${modal.standdown})`);
      await shot(page, 'ch10a-defender', 'staged: red chose the fight — the defender cannot stand down');
    } else {
      const want = `Auto-resolve is available at ${staged.ratio}:1.`;
      check(modal.auto, 'a trivial mismatch offers Auto-resolve');
      check(modal.odds.includes(want), `the odds line carries "${want}" with the ratio out of TRIVIAL_RATIO (got "${modal.odds}")`);
      check(modal.forced === null, 'no defender line on a fight the player chose');
      await shot(page, 'ch10b-autoresolve', `staged: ${staged.ratioNow.toFixed(1)}:1 — Auto-resolve offered and the 5:1 rule stated`);
    }
  } finally {
    await browser.close();
  }
}

// ── mobile leg ────────────────────────────────────────────────────────────

const touch = (cdp, type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y })) });

async function mobileLeg() {
  console.log('\n=== phone 390x844 · real touch · briefing → march → manual ===');
  const { browser, page } = await launch({ device: 'phone' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const cdp = await page.context().newCDPSession(page);
  try {
    await preflight(page);
    await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
    await until(page, () => '__game' in window, null, { what: '__game on the phone profile', fix: 'see the desktop leg' });
    check(await page.evaluate(() => window.__game.MOBILE === true), 'the phone profile boots with MOBILE on');
    // The portrait banner sits over everything until it is dismissed.
    if (await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none')) await page.click('#rotate-anyway');
    await newOperation(page, { tap: true });

    // m1 — the card a phone player reads first.
    await until(page, () => !!document.getElementById('briefing'), null, { what: 'the briefing card on the phone', fix: 'see the desktop leg' });
    const card = await page.evaluate(() => {
      const el = document.getElementById('briefing');
      const r = el.getBoundingClientRect();
      const body = [...el.querySelectorAll('.bf-entry p')].map((p) => parseFloat(getComputedStyle(p).fontSize));
      return {
        buttons: [...el.querySelectorAll('button')].map((b) => { const q = b.getBoundingClientRect(); return { id: b.id, w: Math.round(q.width), h: Math.round(q.height) }; }),
        fits: r.width <= innerWidth + 1,
        minFont: Math.min(...body),
        overflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    check(card.buttons.every((b) => b.h >= 44), `every briefing button is a 44px target (${card.buttons.map((b) => `${b.id} ${b.w}x${b.h}`).join(', ')})`);
    check(card.fits && card.overflow, 'the briefing card fits the viewport with no horizontal overflow');
    check(card.minFont >= 12, `briefing body text stays legible (${card.minFont}px)`);
    await shot(page, 'm1-briefing', 'mobile: the briefing card, 44px targets, no overflow');

    // m4 (taken here, while the door exists) — the Field Manual on a phone.
    await page.touchscreen.tap(...(await centre(page, '#bf-manual')));
    await until(page, () => document.getElementById('manual')?.style.display === 'flex', null, {
      what: 'the Field Manual to open from the briefing card',
      fix: 'The card wires #bf-manual to openManual("goal") (src/ui/tutorial.ts).',
    });
    // A phone player reaches the touch chapter the way a phone player can:
    // swipe the rail, tap the entry.
    const rail = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.mn-navi')].find((x) => x.dataset.ch === 'touch');
      if (!b) return null;
      b.scrollIntoView({ inline: 'center', block: 'nearest' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.textContent };
    });
    check(rail !== null, `the rail lists the touch chapter (${rail?.label})`);
    if (rail) await page.touchscreen.tap(rail.x, rail.y);
    const manual = await page.evaluate(() => {
      const ch = document.getElementById('mn-ch-touch');
      const content = document.querySelector('.mn-content');
      const keys = [...document.querySelectorAll('#mn-ch-touch .mn-kcol')].map((c) => c.querySelector('.mn-klabel')?.textContent);
      const r = ch?.getBoundingClientRect();
      const cr = content?.getBoundingClientRect();
      return {
        chapter: ch?.querySelector('h2')?.textContent ?? null,
        entries: ch?.querySelectorAll('.mn-entry').length ?? 0,
        scrolledTo: !!r && !!cr && r.top >= cr.top - 4 && r.top < cr.bottom,
        touchColumn: keys.includes('Touch'),
        overflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    check(manual.chapter === 'Touch Controls', `the manual carries a Touch Controls chapter (${manual.chapter})`);
    check(manual.entries > 0, `the touch chapter renders its entries (${manual.entries})`);
    check(manual.scrolledTo, 'tapping the rail entry scrolls the touch chapter to the top of the page');
    check(manual.touchColumn, 'key tables show a Touch column beside Desktop');
    check(manual.overflow, 'the manual does not overflow a 390px viewport');
    await shot(page, 'm4-manual-touch', 'mobile: the Field Manual, reached from the card and scrolled to Touch Controls');
    await page.touchscreen.tap(...(await centre(page, '#mn-close')));

    // m2 — Begin, and the coachmark must speak touch, not mouse.
    await page.touchscreen.tap(...(await centre(page, '#bf-begin')));
    await waitBubble(page, 'select-force', { touch: true });
    const desktopCopy = await stepText(page, 'select-force', false);
    check(
      (await page.evaluate(() => document.querySelector('.coach-text').textContent)) !== desktopCopy,
      'the phone is told to tap, not to click (touch copy, not desktop copy)',
    );
    await shot(page, 'm2-select-force', 'mobile: the select-a-company coachmark in touch copy');

    // m3 — a real finger: tap the company, hold the town.
    const { force } = await theaterTargets(page);
    if (!force) throw new Error('no blue company on screen clear of the phone HUD — check frameStrategic / TheaterView layout at 390x844');
    await touch(cdp, 'touchStart', [force]);
    await touch(cdp, 'touchEnd', []);
    check(await page.evaluate((id) => window.__game.getV2().selectedForce === id, force.id), `a tap selects ${force.name}`);
    await waitBubble(page, 'march', { touch: true });
    const { objective } = await theaterTargets(page);
    if (!objective) throw new Error('no garrisoned unheld objective is hittable at 390x844 — the theater view is too tight to play on a phone');
    await touch(cdp, 'touchStart', [objective]);
    await page.waitForTimeout(HOLD_MS + 180); // the hold is a real duration, not a poll
    await touch(cdp, 'touchEnd', []);
    const marching = await page.evaluate((id) => window.__game.getV2().front.forces.find((f) => f.id === id).path.length, force.id);
    check(marching > 0, `a ${HOLD_MS}ms hold on ${objective.name} orders the march (${marching} edges)`);
    await waitBubble(page, 'speed', { touch: true });
    await shot(page, 'm3-march', 'mobile: press-and-hold ordered the march; the speed coachmark follows');

    // The theater chrome a phone player is left looking at. These two are the
    // same class of defect the tutorial copy exists to prevent — an instruction
    // that names a mouse, and text a panel sits on top of.
    const chrome = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('#theater-hud .panel')].map((e) => ({
        cls: e.className.replace('panel', '').trim(),
        r: e.getBoundingClientRect(),
      })).filter((p) => p.r.width > 0 && p.r.height > 0);
      const overlaps = [];
      for (let i = 0; i < panels.length; i++)
        for (let j = i + 1; j < panels.length; j++) {
          const a = panels[i].r, b = panels[j].r;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 2 && h > 2) overlaps.push(`${panels[i].cls} × ${panels[j].cls} (${Math.round(w)}x${Math.round(h)}px)`);
        }
      return { overlaps, log: document.querySelector('#theater-hud .th-log')?.textContent.trim() ?? '' };
    });
    check(chrome.overlaps.length === 0, `theater HUD panels do not sit on top of each other at 390px${chrome.overlaps.length ? `: ${chrome.overlaps.join(', ')}` : ''}`);
    check(
      !/right-click|Click /i.test(chrome.log),
      `the theater's own instruction line speaks touch on a phone (reads: "${chrome.log}") — src/ui/theater-hud.ts hardcodes the empty-log line and never asks whether this is a touch build`,
    );

    // The claim the tutorial's own touch copy makes in battle: the ⚙ menu.
    // In the theater there is no such door on a phone.
    const gear = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; };
      const inTheater = [...document.querySelectorAll('#theater-hud button, #touchbar button, body > button')].filter(vis);
      return { buttons: inTheater.map((b) => b.textContent.trim()), touchbarVisible: !!document.getElementById('touchbar') && vis(document.getElementById('touchbar')) };
    });
    check(
      gear.buttons.some((t) => t.includes('⚙')),
      `a phone player can open the menu from the theater — no ⚙ among [${gear.buttons.join(' ')}] (touchbar visible: ${gear.touchbarVisible}). ` +
      'The ⚙ chip lives in #touchbar, which is inside hud.root and hidden outside battle mode (src/main.ts frame()), so on a phone the pause menu, keybinds and Field Manual are unreachable for the whole theater phase.',
    );

    check(errors.length === 0, `no page errors on the phone leg${errors.length ? `: ${[...new Set(errors)].join(' | ')}` : ''}`);
  } finally {
    await browser.close();
  }
}

const centre = async (page, sel) => {
  const b = await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) throw new Error(`no ${s} on screen`);
    const r = e.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }, sel);
  return b;
};

/** Skip means skip: a profile that opted out must never see tutorial chrome. */
async function mobileSkipLeg() {
  console.log('\n=== phone · Skip tutorial, then reload: no artifacts, ever ===');
  const { browser, page } = await launch({ device: 'phone' });
  try {
    await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
    await until(page, () => '__game' in window, null, { what: '__game on the phone profile', fix: 'see the desktop leg' });
    if (await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none')) await page.click('#rotate-anyway');
    await newOperation(page, { tap: true });
    await until(page, () => !!document.getElementById('briefing'), null, { what: 'the briefing card', fix: 'see the desktop leg' });
    await page.touchscreen.tap(...(await centre(page, '#bf-skip')));
    const afterSkip = await page.evaluate(async () => {
      const { TUTORIAL_STORAGE_KEY } = await import('/src/ui/tutorial.ts');
      return { card: !!document.getElementById('briefing'), bubble: !!document.querySelector('.coach'), saved: JSON.parse(localStorage.getItem(TUTORIAL_STORAGE_KEY) ?? 'null') };
    });
    check(!afterSkip.card && !afterSkip.bubble, 'Skip clears the card and any bubble on the spot');
    check(afterSkip.saved?.skipped === true, `skip is written to storage (${JSON.stringify(afterSkip.saved)})`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await until(page, () => '__game' in window, null, { what: '__game after reload', fix: 'see the desktop leg' });
    if (await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none')) await page.click('#rotate-anyway');
    await until(page, () => { const b = document.getElementById('mm-continue'); return !!b && !b.disabled; }, null, {
      what: 'Continue to be offered after the reload',
      fix: 'startCampaignV2 saves on a fresh start; if Continue is disabled the save never landed.',
    });
    await page.touchscreen.tap(...(await centre(page, '#mm-continue')));
    await until(page, () => !!window.__game.getV2(), null, { what: 'the saved campaign to load', fix: 'loadGameV2 returned non-ok — read the console.' });

    // Play a little: select and march. A skipped profile must stay silent.
    const { force } = await theaterTargets(page);
    if (force) {
      const cdp = await page.context().newCDPSession(page);
      await touch(cdp, 'touchStart', [force]);
      await touch(cdp, 'touchEnd', []);
      const { objective } = await theaterTargets(page);
      if (objective) {
        await touch(cdp, 'touchStart', [objective]);
        await page.waitForTimeout(HOLD_MS + 180);
        await touch(cdp, 'touchEnd', []);
      }
    }
    const clean = await page.evaluate(() => ({
      card: !!document.getElementById('briefing'),
      bubbles: document.querySelectorAll('.coach').length,
      selected: window.__game.getV2().selectedForce,
    }));
    check(!clean.card && clean.bubbles === 0, `a skipped profile shows no card and no coachmarks after a reload and a march (bubbles=${clean.bubbles})`);
    check(clean.selected >= 0, 'the game is still fully playable with the tutorial off');
    await shot(page, 'm5-clean', 'mobile: skipped profile, reloaded and played — zero tutorial artifacts');
  } finally {
    await browser.close();
  }
}

// ── main ──────────────────────────────────────────────────────────────────

mkdirSync(SHOTS, { recursive: true });
console.log(`tutorial gate · ${URL} · shots → ${SHOTS}`);
const t0 = Date.now();
// Each leg is independent: one that dies must not take the others' evidence
// with it, or a single red step hides everything downstream of it.
const legs = [
  ['desktop', 'desktop', desktopLeg],
  ['desktop', 'staged contact-modal copy: a fight red chose', () => stagedModalRun('defender')],
  ['desktop', 'staged contact-modal copy: a 5:1 mismatch', () => stagedModalRun('trivial')],
  ['mobile', 'mobile', mobileLeg],
  ['mobile', 'mobile skip', mobileSkipLeg],
];
for (const [leg, name, run] of legs) {
  if (LEG !== 'all' && LEG !== leg) continue;
  try {
    await run();
  } catch (e) {
    check(false, `${name} leg aborted: ${e.message}`);
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
writeFileSync(join(SHOTS, 'result.txt'), `${fails.length ? fails.join('\n') : 'all checks passed'}\n\n${shots.map((s) => `${s.path} — ${s.claim}`).join('\n')}\n`);
console.log(`\n${shots.length} screenshots in ${SHOTS} (${mins} min)`);
console.log(fails.length ? `${fails.length} FAILED:\n${fails.map((f) => `  - ${f}`).join('\n')}` : 'all checks passed');
process.exit(fails.length ? 1 : 0);
