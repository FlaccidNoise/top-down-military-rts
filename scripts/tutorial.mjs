// The onboarding gate: a FRESH browser profile plays the whole first run, on a
// desktop and on a phone.
//
//   landing -> Play -> the drill, from its first step to the farm taken ->
//   Start the campaign -> the goal line -> select a company -> march ->
//   Play the clock -> contact -> deployment -> first battle order -> debrief ->
//   back on the theater -> Dig in -> reload: Continue first, Training on the menu
//
// and three paths beside it: a first battle the player defends (each device),
// the first requisition card against a tutorial step, and Skip.
//
//   node scripts/tutorial.mjs --port 5331                  # every leg
//   node scripts/tutorial.mjs --port 5331 --leg desktop    # desktop | phone | landscape | defender | requisition | skip | modal
//   node scripts/tutorial.mjs --port 5331 --shots DIR      # where shots land (default .screenshots/tutorial)
//   node scripts/tutorial.mjs --port 5331 --seed 1263164463  # replay one campaign exactly (?war=)
//
// Dev server must be running: npm run dev -- --port 5331 --strictPort
// Every run prints the campaign seed it rolled, so a red run can be replayed.
//
// WHAT IS DRIVEN AND WHAT IS STAGED. Every decision the game teaches is made
// through real input (scripts/lib/play.mjs): a mouse on the desktop leg, CDP
// touch on the phone legs, which tap and hold and never click. Screen points
// come from live state, the ring a step draws or a man who is on the visible
// map, never from a fixed pixel. Three things are staged, each on purpose:
//   - THE END OF THE FIRST CAMPAIGN BATTLE. The drill is the victory this gate
//     guides a player to and it is fought for real. The campaign battle is
//     asserted as a flow: deployment, an order given through the UI, the
//     debrief. It is then ended by setting sim.winner, because a live first
//     battle is three to eight minutes of AI and is losable (the old gate
//     failed its desktop leg on seed 1636534801 for exactly that), and that is
//     a balance question scripts/firstcontact.mjs answers with numbers.
//   - the two contact-card strings a first battle cannot reach (a red attack,
//     a 5:1 mismatch): stagedModalRun().
//   - THE RED ATTACK OF THE DEFENDER LEG, and one unit event in it. On the first
//     preset red never comes to a player: he attacks in 60 of 60 wars when he
//     follows the steps and meets nobody in 40 of 40 when he orders nothing
//     (scripts/firstcontact.mjs --pick weakest, --pick none, --no-fight). So the
//     red group is put on a parked blue company. Everything the player then
//     does is real input. A 'took-over' event is pushed into the sim's own
//     queue before the staged end, because a battle this short raises none:
//     it proves the path from the drain to the debrief's highlights.
//   - the battle speed (4x, through the game's own control).
//
// EXPECTED COPY IS IMPORTED, NEVER RETYPED. Bubble text is read out of
// /src/ui/tutorial.ts in the page, the goal line out of /src/ui/goal-line.ts,
// and compared against the DOM.
//
// THE LAYOUT VIEWPORT. At every step: the document is no wider or taller than
// the device and the visual viewport is unscaled (jtbug #783 was a bubble that
// grew the page and took every fixed layer with it).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg } from './lib/stage.mjs';
import { checkEndCard, checkOverBattle, checkStep, checkViewport, drillFirstOrder, drillToVictory, manOf, openDevice, overlap, squadOrders, stepView, waitStep } from './lib/play.mjs';

const PORT = Number(arg('port', '5331'));
const URL = `http://localhost:${PORT}`;
const SHOTS = arg('shots', '.screenshots/tutorial');
const LEG = arg('leg', 'all');
const SEED = arg('seed', null);

const fails = [];
// The first-run legs that took an objective in their first battle, and so met the Dig in step.
const digInLegs = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
};
const shots = [];
const shooter = (h, prefix) => {
  let n = 0;
  return async (name) => {
    n++;
    const p = join(SHOTS, `${prefix}-${String(n).padStart(2, '0')}-${name}.png`);
    await h.page.screenshot({ path: p });
    shots.push(p);
  };
};

// Poll and fail with an instruction, never a bare timeout.
async function until(page, fn, argv, { timeout = 15000, what, fix }) {
  try {
    return await (await page.waitForFunction(fn, argv, { timeout, polling: 100 })).jsonValue();
  } catch {
    const state = await page.evaluate(() => {
      const g = window.__game;
      const v2 = g?.getV2?.();
      return {
        screens: ['mainmenu', 'customize', 'manual', 'debrief', 'theater-hud', 'hud', 'rotate', 'pausemenu'].filter((id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none'; }),
        step: g?.tutorialView?.()?.step ?? null,
        bubble: document.querySelector('.coach-text')?.textContent ?? null,
        mode: g?.getSelection?.().mode ?? null,
        theater: v2 ? { selectedForce: v2.selectedForce, pending: !!v2.pending, battle: !!v2.battle, clockMin: v2.front.clockMin } : null,
      };
    }).catch(() => null);
    throw new Error(`gave up after ${timeout}ms waiting for ${what}.\n    live state: ${JSON.stringify(state)}\n    ${fix}`);
  }
}

async function preflight() {
  for (const [path, symbol] of [['/src/ui/tutorial.ts', 'drill-select'], ['/src/drill.ts', 'houseIsQuiet'], ['/src/ui/goal-line.ts', 'goalLine']]) {
    const body = await (await fetch(`${URL}${path}`)).text().catch(() => '');
    if (!body.includes(symbol)) throw new Error(`${URL}${path} does not contain '${symbol}'.\n    The server on this port is NOT this worktree, or none is up. Start one here:\n    npm run dev -- --port ${PORT} --strictPort`);
  }
  console.log(`  ok   server at ${URL} serves this worktree`);
}

/** Words a player can see on the screen right now, the way the audit counted them. */
const visibleWords = (page) =>
  page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    let words = 0;
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const rng = document.createRange();
    for (let node = tw.nextNode(); node; node = tw.nextNode()) {
      const s = node.textContent.replace(/\s+/g, ' ').trim();
      const pe = node.parentElement;
      if (!s || !pe || pe.tagName === 'SCRIPT' || pe.tagName === 'STYLE') continue;
      rng.selectNodeContents(node);
      const r = rng.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue;
      const t = document.elementFromPoint(Math.min(W - 1, Math.max(0, r.left + Math.min(r.width / 2, 6))), Math.min(H - 1, Math.max(0, r.top + r.height / 2)));
      if (!t || !(t === pe || pe.contains(t) || (t.contains(pe) && t.tagName !== 'CANVAS' && t !== document.body))) continue;
      words += s.split(' ').filter((x) => /[\p{L}\p{N}]/u.test(x)).length;
    }
    return words;
  });

const wordsIn = (text) => (text ?? '').split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length;

/** Buttons a player can see that are cut by the screen edge or have something on top of them. */
const brokenControls = (page, rootSel) =>
  page.evaluate((sel) => {
    const out = [];
    for (const e of document.querySelectorAll(`${sel} button, ${sel} [role="button"]`)) {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || e.disabled) continue;
      const name = (e.textContent || e.id || '').replace(/\s+/g, ' ').trim().slice(0, 20);
      // A row inside a scrolling list is reached by scrolling it: judge what shows.
      const scroller = e.closest('#squads, .db-scroll, .th-objs, .th-log');
      const sr = scroller?.getBoundingClientRect();
      if (sr && (r.bottom <= sr.top || r.top >= sr.bottom || r.right <= sr.left || r.left >= sr.right)) continue;
      if (!sr && (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) { out.push(`${name}: cut by the screen edge at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`); continue; }
      const x = Math.max(1, Math.min(innerWidth - 1, r.left + r.width / 2)), y = Math.max(1, Math.min(innerHeight - 1, Math.max(r.top, sr?.top ?? 0) + 6));
      const top = document.elementFromPoint(x, y);
      if (top && top !== e && !e.contains(top) && !top.contains(e)) out.push(`${name}: under ${top.id || top.className || top.tagName}`);
    }
    return out;
  }, rootSel);

// The theater's flash line is drawn on the canvas, and the canvas is behind
// every DOM panel: where it was drawn, and the panels it is under.
const flashView = (page) =>
  page.evaluate(() => {
    const view = window.__game.getV2().view;
    const f = view.flashRect;
    const under = f
      ? [...document.querySelectorAll('#theater-hud .panel')].map((e) => ({ c: e.className.replace('panel', '').trim(), r: e.getBoundingClientRect() })).filter((q) => q.r.width > 0 && q.r.left < f.right && q.r.right > f.left && q.r.top < f.bottom && q.r.bottom > f.top).map((q) => q.c)
      : [];
    return { text: f ? view.flashText : null, under, onScreen: !!f && f.left >= 0 && f.top >= 0 && f.right <= innerWidth && f.bottom <= innerHeight };
  });
const checkFlash = (f, tag) => check(f.text !== null && f.onScreen && f.under.length === 0, `${tag}: the flash line is on the map, under no panel ("${f.text}"${f.under.length ? `, under: ${f.under.join(', ')}` : ''})`);

// The debrief's highlights: how many, how long, where, and that none is saved.
const highlightsView = (page) =>
  page.evaluate(async () => {
    const { HIGHLIGHTS_SHOWN } = await import('/src/ui/highlights.ts');
    const list = document.querySelector('#debrief .db-high');
    const lines = [...document.querySelectorAll('#debrief .db-high li')].map((e) => e.textContent);
    const roster = document.getElementById('db-show-roster');
    return {
      max: HIGHLIGHTS_SHOWN,
      lines,
      ahead: !list || (!!roster && !!(list.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING) && list.getBoundingClientRect().bottom <= roster.getBoundingClientRect().top),
      saved: Object.keys(localStorage).filter((k) => lines.some((l) => (localStorage.getItem(k) ?? '').includes(l))),
    };
  });
const checkHighlights = (hi, tag) =>
  check(hi.lines.length <= hi.max && hi.lines.every((l) => wordsIn(l) <= 8) && hi.ahead && hi.saved.length === 0, `${tag}: at most ${hi.max} highlights, one short line each, ahead of Show roster, none in storage (${hi.lines.length ? hi.lines.join(' | ') : 'none'}${hi.saved.length ? `; SAVED under ${hi.saved.join(', ')}` : ''})`);

const vpOf = (page) => page.evaluate(() => { const r = document.documentElement; return { inner: [innerWidth, innerHeight], doc: [r.scrollWidth, r.scrollHeight], visual: [Math.round(visualViewport.width), Math.round(visualViewport.height)], scale: visualViewport.scale }; });

async function land(h, { expectFresh = true } = {}) {
  const { page } = h;
  await page.goto(`${URL}/${SEED !== null ? `?war=${SEED}` : ''}`, { waitUntil: 'domcontentloaded' });
  await until(page, () => '__game' in window && !!document.querySelector('#mainmenu button'), null, {
    what: 'the main menu',
    fix: `The app never booted. Check the dev server log and the browser console. The URL must carry no ?camp= (the pinned art path has no tutorial at all) and no ?drill= (that boots past the menu).`,
  });
  if (expectFresh) check(await page.evaluate(() => localStorage.getItem('rts.tutorial.v1') === null), `${h.device}: fresh profile, nothing in localStorage`);
}

// ── the whole first run ───────────────────────────────────────────────────

async function firstRun(device) {
  console.log(`\n=== ${device} · fresh profile · landing to the first debrief ===`);
  const h = await openDevice(device);
  const { page } = h;
  const shot = shooter(h, device);
  const ctx = { check, shot, label: device };
  const verb = h.TOUCH ? 'tap' : 'click';
  try {
    // ── landing ──
    await land(h);
    check(await page.evaluate(() => window.__game.MOBILE) === h.TOUCH, `${device}: boots as a ${h.TOUCH ? 'phone' : 'desktop'} (MOBILE ${h.TOUCH})`);
    const menu = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('#mainmenu button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => ({ id: b.id, primary: b.classList.contains('primary'), h: Math.round(b.getBoundingClientRect().height) })),
      rotate: getComputedStyle(document.getElementById('rotate')).display !== 'none',
    }));
    check(menu.buttons.filter((b) => b.primary).map((b) => b.id).join() === 'mm-play', `${device}: the first-run menu has one primary button, Play (${menu.buttons.map((b) => `${b.id}${b.primary ? '*' : ''}`).join(' ')})`);
    check(!menu.buttons.some((b) => b.id === 'mm-continue' || b.id === 'mm-new'), `${device}: no Continue and no setup on a first run`);
    check(!menu.rotate, `${device}: no "turn the phone" screen before the menu`);
    if (h.TOUCH) check(menu.buttons.every((b) => b.h >= 44), `${device}: every menu button is a 44 px target (${menu.buttons.map((b) => `${b.id} ${b.h}`).join(', ')})`);
    const landing = await page.evaluate(async () => {
      const { TAGLINE } = await import('/src/ui/mainmenu.ts');
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const play = r('mm-play'), custom = r('mm-custom'), manual = r('mm-manual');
      const row = document.querySelector('#mainmenu .db-actions').getBoundingClientRect();
      return { tagline: TAGLINE, shown: document.querySelector('#mainmenu .mm-tag')?.textContent ?? null, share: play.width / row.width, tall: play.height, under: custom.top >= play.bottom && manual.top >= play.bottom, inRow: Math.abs(custom.top - manual.top) < 2 };
    });
    check(landing.shown === landing.tagline && wordsIn(landing.tagline) <= 8, `${device}: one line under the title says what this is, in ${wordsIn(landing.tagline)} words ("${landing.shown}")`);
    check(landing.share > 0.8 && landing.tall <= 80 && landing.under && landing.inRow, `${device}: Play is the width of the menu and the two links are in a row under it (Play ${Math.round(landing.share * 100)}% wide, ${Math.round(landing.tall)} px tall)`);
    const landingWords = await visibleWords(page);
    check(landingWords <= 6 + wordsIn(landing.tagline), `${device}: the landing screen is ${landingWords} words`);
    checkViewport(check, `${device} landing`, await vpOf(page));
    await shot('landing');

    // ── Play: the drill, held at its first step ──
    h.inputs = 0;
    await h.press('#mm-play');
    await until(page, () => !!window.__game.getDrill?.(), null, { what: 'the drill to boot after Play', fix: 'onPlay in src/main.ts calls startDrill; a throw there leaves the menu up.' });
    check(await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display === 'none'), `${device}: Play goes straight to the drill, with no "turn the phone" screen and no setup`);
    const d = await drillFirstOrder(h, ctx);
    // Play, the squad, the hedge.
    check(h.inputs === 3, `${device}: three inputs from landing to the first order (${h.inputs})`);
    const read = await page.evaluate(async (touch) => {
      const { STEPS } = await import('/src/ui/tutorial.ts');
      const line = (id) => { const s = STEPS.find((x) => x.id === id); return touch ? s.text.touch : s.text.desktop; };
      return ['Play', line('drill-select'), line('drill-move')];
    }, h.TOUCH);
    const readWords = read.reduce((a, t) => a + wordsIn(t), 0);
    check(readWords < 20, `${device}: ${readWords} words read to get there: ${read.map((t) => `"${t}"`).join(' ')}`);

    // ── the rest of the drill, fought for real ──
    await drillToVictory(h, d, ctx);
    await checkEndCard(h, ctx);

    // ── Start the campaign: no setup screen, no briefing card ──
    await h.press('#next');
    await until(page, () => !!window.__game.getV2(), null, { what: 'a campaign after "Start the campaign"', fix: 'startFirstCampaign in src/main.ts. A generation reject leaves #boot-error on screen with the reason.' });
    const camp = await page.evaluate(async () => {
      const { FIRST_PRESET } = await import('/src/campaign/presets.ts');
      const { goalLine } = await import('/src/ui/goal-line.ts');
      const v2 = window.__game.getV2();
      return {
        seed: v2.seed,
        first: JSON.stringify(v2.campaignCfg) === JSON.stringify(FIRST_PRESET.campaign) && JSON.stringify(v2.theaterCfg) === JSON.stringify(FIRST_PRESET.theater),
        preset: FIRST_PRESET.name,
        goal: goalLine(v2.goals),
        screens: ['customize', 'briefing', 'debrief', 'mainmenu'].filter((id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none'; }),
      };
    });
    console.log(`  campaign seed ${camp.seed}${SEED === null ? ` (rolled; replay with --seed ${camp.seed})` : ' (pinned)'}`);
    check(camp.first, `${device}: the campaign is the first preset (${camp.preset})`);
    check(camp.screens.length === 0, `${device}: straight onto the theater: no setup screen, no briefing card${camp.screens.length ? ` (still up: ${camp.screens.join(', ')})` : ''}`);

    // ── the goal line, and the first theater step ──
    await waitStep(h, 'select-force', 15000);
    let v = await checkStep(h, 'select-force', ctx);
    const line = await page.evaluate(() => {
      const e = document.getElementById('goal-line');
      const r = e?.getBoundingClientRect();
      const next = document.querySelector('#theater-hud .th-next');
      return { text: e?.textContent ?? null, rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null, nextShown: getComputedStyle(next).visibility !== 'hidden', panels: [...document.querySelectorAll('#theater-hud .panel')].map((p) => p.getBoundingClientRect()).filter((p) => p.width > 0).map((p) => ({ left: p.left, top: p.top, right: p.right, bottom: p.bottom })) };
    });
    check(line.text === camp.goal && !!camp.goal, `${device}: one line over the map states the goal from the live war goals ("${line.text}")`);
    check(wordsIn(line.text) <= 10, `${device}: the goal line is ${wordsIn(line.text)} words`);
    check(!!line.rect && line.rect.left >= 0 && line.rect.right <= v.vp.inner[0] && !line.panels.some((p) => overlap(line.rect, p)), `${device}: the goal line is on the map, clear of the HUD panels`);
    check(!overlap(line.rect, v.bubble), `${device}: the goal line and the bubble do not overlap`);
    check(!line.nextShown, `${device}: the theater's own "what next" line is quiet while a step is talking`);
    await h.tap(v.ring);
    check(await page.evaluate(() => window.__game.getV2().selectedForce >= 0), `${device}: a ${verb} on the ringed company selects it`);

    // ── march ──
    await waitStep(h, 'march', 5000);
    v = await checkStep(h, 'march', ctx);
    if (!h.TOUCH) {
      await h.hover(v.ring);
      const preview = await page.evaluate(() => window.__game.getV2().view.preview);
      check(!!preview && preview.ok, `${device}: pointing at the ringed town shows the route before any order (the step's "the route shows first")`);
      await shot('march-preview');
    }
    await h.order(v.ring);
    const march = await page.evaluate(() => { const v2 = window.__game.getV2(); return { edges: v2.front.forces.find((f) => f.id === v2.selectedForce)?.path.length ?? 0, flash: v2.view.flashText, goal: !!document.getElementById('goal-line') }; });
    check(march.edges > 0, `${device}: a ${h.TOUCH ? 'hold' : 'right-click'} on the ringed town orders the march (${march.edges} edges${march.edges ? '' : `; the view says "${march.flash}"`})`);
    check(!march.goal, `${device}: the goal line goes once the first march is ordered`);
    checkFlash(await flashView(page), `${device} march`);

    // ── Play the clock: the step ends when the clock moves, not when a button is pressed ──
    await waitStep(h, 'play', 5000);
    v = await checkStep(h, 'play', ctx);
    const cover = await page.evaluate((b) => [...document.querySelectorAll('#theater-hud .panel')].map((p) => ({ c: p.className, r: p.getBoundingClientRect() })).filter((p) => p.r.width > 0 && b.left < p.r.right && b.right > p.r.left && b.top < p.r.bottom && b.bottom > p.r.top).map((p) => p.c), v.bubble);
    check(cover.length === 0, `${device}: the Play bubble covers no theater panel${cover.length ? ` (on: ${cover.join(', ')})` : ''}`);
    const clock0 = await page.evaluate(() => window.__game.getV2().front.clockMin);
    await h.press('#theater-hud [data-clock="2"]');
    await page.waitForTimeout(400);
    check((await stepView(page)).step === 'play', `${device}: choosing a speed with the clock stopped does not end the Play step`);
    await h.press('#theater-hud [data-clock="pause"]');
    const ran = await until(page, (t) => { const g = window.__game; return g.getV2().front.clockMin > t && g.tutorialView().step !== 'play' ? g.getV2().front.clockMin : false; }, clock0, {
      timeout: 8000,
      what: 'the theater clock to advance and the Play step to retire with it',
      fix: "The frame loop notifies 'clock-advanced' after stepTheaterMinuteV2 (src/main.ts). A stuck clock means the press never reached #theater-hud [data-clock].",
    });
    check(ran > clock0, `${device}: the clock runs (${clock0} to ${ran} theater minutes) and the Play step ends with it`);

    // ── contact ──
    await until(page, () => !!document.getElementById('fight') && window.__game.tutorialView()?.step === 'contact', null, {
      timeout: 240000,
      what: 'the contact card and its step',
      fix: 'The company marched and met nobody in 240 s at 60x. scripts/firstcontact.mjs runs the same march headless on any seed.',
    });
    v = await checkStep(h, 'contact', ctx);
    const card = await page.evaluate(() => { const c = document.getElementById('contact'); const r = c.getBoundingClientRect(); return { text: c.innerText, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, fight: document.getElementById('fight').textContent }; });
    check(!overlap(v.bubble, card.rect), `${device}: the contact bubble is beside the card, not on it`);
    check(!card.text.toLowerCase().includes(v.text.toLowerCase().replace(/\.$/, '')), `${device}: the bubble does not repeat what the card says ("${v.text}")`);
    check(/outnumber|Even match/.test(card.text), `${device}: the card states the odds in words`);
    await h.press('#fight');
    await until(page, () => window.__game.getSelection().mode === 'battle', null, { what: 'the battle to boot', fix: 'startTheaterBattle threw: read the console.' });

    // ── deployment ──
    if (await page.evaluate(() => matchMedia('(orientation: portrait)').matches && window.__game.MOBILE)) {
      const rot = await page.evaluate(() => { const e = document.getElementById('rotate'); return { shown: getComputedStyle(e).display !== 'none', text: e.innerText }; });
      check(rot.shown, `${device}: a campaign battle in portrait says to turn the phone`);
      check(wordsIn(rot.text) <= 12, `${device}: in ${wordsIn(rot.text)} words ("${rot.text.replace(/\s+/g, ' ').trim()}")`);
      await shot('rotate');
      await h.press('#rotate-anyway');
    }
    await waitStep(h, 'deploy', 15000);
    v = await checkStep(h, 'deploy', ctx);
    const broken = await brokenControls(page, '#hud');
    check(broken.length === 0, `${device}: every deployment control is on screen and uncovered${broken.length ? `: ${broken.join(' | ')}` : ''}`);
    check(v.tick === 0, `${device}: the clock is stopped in deployment (tick ${v.tick})`);
    const blueAttacks = card.fight === 'Attack';
    const dep = await page.evaluate(async (attacking) => {
      const { DEPLOY_ATK_DEPTH, DEPLOY_DEF_LINE, DEPLOY_DEF_DEFAULT } = await import('/src/strategic/deploy.ts');
      const { BATTLE_CLASS_TO_MAPKIND } = await import('/src/strategic/theater.ts');
      const g = window.__game, s = g.sim, st = g.stage();
      const kind = BATTLE_CLASS_TO_MAPKIND[g.getV2().battle.tb.battleClass];
      const zone = attacking ? { x0: 0, x1: DEPLOY_ATK_DEPTH } : { x0: DEPLOY_DEF_LINE[kind] ?? DEPLOY_DEF_DEFAULT, x1: s.map.w };
      const scr = (x, y) => g.cam.worldToScreen(x, y, innerWidth, innerHeight);
      const canvas = document.querySelector('canvas');
      const onMap = (x, y) => { const [px, py] = scr(x, y); return px > st.left + 12 && px < st.right - 12 && py > st.top + 12 && py < st.bottom - 12 && document.elementFromPoint(px, py) === canvas; };
      const pick = s.soldiers.find((m) => m.alive && m.side === 'blue' && m.inVehicle < 0 && s.squads[m.squadId].teamIds.length > 1 && onMap(m.x, m.y));
      if (!pick) return null;
      const tx = Math.max(zone.x0 + 2, Math.min(zone.x1 - 3, pick.x));
      const ty = [14, -14, 9, -9].map((dy) => Math.max(8, Math.min(s.map.h - 8, pick.y + dy))).find((y) => onMap(tx, y));
      const [sx, sy] = scr(pick.x, pick.y);
      const [tsx, tsy] = ty === undefined ? [0, 0] : scr(tx, ty);
      return { squad: pick.squadId, tx, ty: ty ?? null, zone, man: { x: sx, y: sy }, spot: { x: tsx, y: tsy }, before: s.squads[pick.squadId].soldierIds.map((i) => ({ id: i, x: s.soldiers[i].x, y: s.soldiers[i].y })) };
    }, blueAttacks);
    if (!dep) throw new Error('no blue rifle squad has a man on the visible map at deployment: bootCamera (src/render/framing.ts) did not frame the force.');
    await h.tap(dep.man);
    check((await page.evaluate(() => window.__game.getSelection().squads)).includes(dep.squad), `${device}: a ${verb} on a man in deployment selects his squad`);
    if (dep.ty !== null) {
      await h.order(dep.spot);
      const moved = await page.evaluate(({ before, tx, ty, zone }) => {
        const s = window.__game.sim;
        const now = before.map((b) => s.soldiers[b.id]);
        return { shifted: now.filter((m, i) => Math.hypot(m.x - before[i].x, m.y - before[i].y) > 1).length, near: now.filter((m) => Math.hypot(m.x - tx, m.y - ty) < 12).length, inZone: now.every((m) => m.x >= zone.x0 && m.x <= zone.x1), tick: s.tick, of: now.length };
      }, dep);
      check(moved.shifted > 0 && moved.near > 0 && moved.inZone && moved.tick === 0, `${device}: a ${h.TOUCH ? 'hold' : 'right-click'} places the squad at once, inside its zone, with the clock stopped (${moved.shifted}/${moved.of} moved, ${moved.near} on the spot)`);
    }
    await shot('deploy-placed');

    // ── Play: the battle, and the first order ──
    await h.press(h.TOUCH ? '[data-tb="pause"]' : '#hud [data-act="pause"]');
    await until(page, () => window.__game.sim.tick > 5, null, { what: 'the battle to run after Play', fix: 'The first unpause commits the deployment (src/main.ts, the deployPhase && !paused branch).' });
    await page.waitForTimeout(300);
    v = await stepView(page);
    // The drill taught selecting and ordering: the campaign does not teach them again.
    check(v.step === null, `${device}: no bubble repeats what the drill taught (step on screen: ${v.step})`);
    checkViewport(check, `${device} battle`, v.vp);
    const man = await manOf(page, dep.squad);
    if (!man) throw new Error(`squad ${dep.squad} has no man on the visible map after Play.`);
    if (!(await page.evaluate((q) => window.__game.getSelection().squads.includes(q), dep.squad))) await h.tap(man);
    const bar = await page.evaluate(() => [...document.querySelectorAll('#orderbar .ob-main [data-order], #orderbar [data-ob="more"]')].map((e) => { const r = e.getBoundingClientRect(); return { k: e.dataset.order ?? 'more', on: r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }));
    check(bar.map((b) => b.k).join() === 'move,fire,smoke,assault,more' && bar.every((b) => b.on), `${device}: the order bar is up with Move, Fire, Smoke, Assault and More, all on screen (${bar.map((b) => `${b.k}${b.on ? '' : '!'}`).join(' ')})`);
    const dest = await page.evaluate((q) => {
      const g = window.__game, s = g.sim, st = g.stage(), canvas = document.querySelector('canvas');
      const men = s.squads[q].soldierIds.map((i) => s.soldiers[i]).filter((m) => m.alive);
      const cx = men.reduce((a, m) => a + m.x, 0) / men.length, cy = men.reduce((a, m) => a + m.y, 0) / men.length;
      for (const [dx, dy] of [[12, 0], [0, 12], [0, -12], [-12, 0], [8, 8], [8, -8]]) {
        const [x, y] = g.cam.worldToScreen(cx + dx, cy + dy, innerWidth, innerHeight);
        if (x > st.left + 12 && x < st.right - 12 && y > st.top + 12 && y < st.bottom - 12 && document.elementFromPoint(x, y) === canvas) return { x, y };
      }
      return null;
    }, dep.squad);
    if (!dest) throw new Error('no ground near the squad is on the visible map to send it to.');
    await h.order(dest);
    const first = await squadOrders(page, dep.squad);
    check(first.some((o) => /^(move|fast|sneak)\//.test(o)), `${device}: the first battle order goes in through the UI (${first.join(', ')})`);
    await shot('first-order');

    // ── the debrief (the battle's end is staged: see the header) ──
    await page.evaluate(() => { window.__game.sim.winner = 'blue'; });
    await until(page, () => !!document.querySelector('#debrief #next') && getComputedStyle(document.getElementById('debrief')).display !== 'none', null, { timeout: 20000, what: 'the debrief', fix: 'showDebrief runs 4 s after sim.winner is set (src/main.ts frame loop).' });
    await waitStep(h, 'debrief', 5000);
    v = await checkStep(h, 'debrief', ctx);
    const deb = await page.evaluate(() => ({ h1: document.querySelector('#debrief h1')?.textContent, stats: document.querySelectorAll('#debrief .db-stat').length, rows: document.querySelectorAll('#debrief tr').length, words: document.querySelector('#debrief .db').innerText.split(/\s+/).filter(Boolean).length }));
    check(deb.h1 === 'VICTORY' && deb.stats === 3 && deb.rows === 0, `${device}: the debrief leads with the result and three numbers, the roster behind a button (${deb.h1}, ${deb.stats} numbers, ${deb.rows} roster rows, ${deb.words} words)`);
    check(!/roster/i.test(v.text), `${device}: the debrief step does not send the player to read the roster ("${v.text}")`);
    await checkOverBattle(h, ctx, 'the debrief');
    checkHighlights(await highlightsView(page), device);
    await h.press('#next');
    await until(page, () => window.__game.getSelection().mode === 'strategic', null, { what: 'the theater after the debrief', fix: 'The #next handler sets mode = strategic (src/main.ts showDebrief).' });
    await page.waitForTimeout(400);
    checkViewport(check, `${device} theater after the battle`, await vpOf(page));
    await shot('theater-after');

    // ── Dig in: one line, the first time an objective is taken ──
    // The first battle is for whatever stands on the road: the ringed town, or
    // a garrison on the way to it. Only the first is an objective taken.
    const took = await page.evaluate(() => { const v2 = window.__game.getV2(); return v2.front.theater.objectiveNodes.filter((n) => v2.front.controlByNode[n] === 'blue').map((n) => v2.front.theater.nodes[n].name); });
    // A red column on its way to reinforce the town can arrive as it falls,
    // and it counterattacks at once (jtbug #799). The contact card then owns
    // the screen and the lesson waits: the step is not raised over a card.
    const counter = await page.evaluate(() => ({ pending: !!window.__game.getV2().pending, fight: document.getElementById('fight')?.textContent ?? null }));
    if (took.length === 0) {
      check((await stepView(page)).step === null, `${device}: the battle was for a town on the way, no objective is held yet, and no Dig in step shows`);
    } else if (counter.pending) {
      check(counter.fight === 'Defend' && (await stepView(page)).step === null, `${device}: ${took.join(', ')} is taken and red counterattacks at once: the card offers Defend and no Dig in step is raised over it (button "${counter.fight}")`);
    } else {
      digInLegs.push(device);
      await waitStep(h, 'dig-in', 8000);
      v = await checkStep(h, 'dig-in', ctx);
      check(!!v.ring, `${device}: ${took.join(', ')} is taken, and with no company selected the Dig in bubble points at the company on it`);
      if (v.ring) await h.tap(v.ring);
      await until(page, () => (document.querySelector('#theater-hud [data-post="dig"]')?.getBoundingClientRect().width ?? 0) > 0, null, { what: "the company's card and its posture row", fix: 'A tap on the ringed company selects it (theaterMark("holder") in src/main.ts) and TheaterHud shows its card with [data-post] buttons.' });
      v = await checkStep(h, 'dig-in', { check, shot: (name) => shot(`${name}-button`) });
      check(v.ring === null, `${device}: once the company is selected the ring is gone and the bubble is on its Dig in button`);
      await h.press('#theater-hud [data-post="dig"]');
      const dug = await page.evaluate(() => { const v2 = window.__game.getV2(); return { posture: v2.front.forces.find((f) => f.id === v2.selectedForce)?.posture, step: window.__game.tutorialView().step }; });
      check(dug.posture === 'dig' && dug.step === null, `${device}: Dig in sets the posture and the step is done (posture ${dug.posture}, step ${dug.step})`);
    }

    // ── what the profile remembers ──
    const state = await page.evaluate(async () => {
      const { STEPS, TUTORIAL_STORAGE_KEY } = await import('/src/ui/tutorial.ts');
      return { saved: JSON.parse(localStorage.getItem(TUTORIAL_STORAGE_KEY) ?? 'null'), want: STEPS.filter((s) => s.scene === 'campaign').map((s) => s.id) };
    });
    // Dig in waits for an objective, and for a counterattack to be answered: a
    // run that took none, or was counterattacked at once, has not met it.
    if (took.length === 0 || counter.pending) state.want = state.want.filter((id) => id !== 'dig-in');
    const missing = state.want.filter((id) => !(state.saved?.done ?? []).includes(id));
    check(state.saved?.skipped === false && state.saved?.drilled === true && missing.length === 0, `${device}: every campaign step is retired in storage${missing.length ? `: missing ${missing.join(', ')}` : ` (${state.want.length}/${state.want.length})`}`);

    // ── a later run: Continue first, Training on the menu ──
    await land(h, { expectFresh: false });
    const later = await page.evaluate(() => [...document.querySelectorAll('#mainmenu button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => ({ id: b.id, primary: b.classList.contains('primary'), disabled: b.disabled, text: b.textContent })));
    check(later[0]?.id === 'mm-continue' && later[0].primary && !later[0].disabled, `${device}: on a later run Continue comes first (${later.map((b) => `${b.id}${b.primary ? '*' : ''}`).join(' ')})`);
    check(later.some((b) => b.id === 'mm-training') && later.some((b) => b.id === 'mm-custom' && b.text === 'Custom operation') && !later.some((b) => b.id === 'mm-play'), `${device}: Training and Custom operation are on the menu, and the one-button landing is gone`);
    check(later.filter((b) => b.primary).length === 1, `${device}: one primary button on the later menu`);
    await shot('menu-later');
    await h.press('#mm-new');
    const confirm = await page.evaluate(() => ({ text: document.getElementById('mm-new')?.textContent, mode: window.__game.getSelection().mode }));
    check(/Replace/.test(confirm.text ?? '') && confirm.mode === 'menu', `${device}: New campaign over a saved one asks first ("${confirm.text}")`);

    check(h.errors.length === 0, `${device}: no page or console errors on the whole run${h.errors.length ? `: ${[...new Set(h.errors)].slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await h.browser.close();
  }
}

// ── a first battle the player defends ─────────────────────────────────────
// The profile started the drill and left it, so every campaign step is still
// to come, the two battle steps included. The red attack is staged (see the
// header). What is checked is what a defender reads: a card with one button,
// a deployment behind his own line, a goal that says to break an attack, a
// pointer to where it comes from, and a first-order line that does not tell
// him to go anywhere.

async function defenderRun(device) {
  console.log(`\n=== ${device} · a first battle the player defends ===`);
  const h = await openDevice(device);
  const { page } = h;
  const shot = shooter(h, `${device}-defender`);
  const ctx = { check, shot, label: `${device} defender` };
  const tag = `${device} defender`;
  try {
    await page.addInitScript(() => { try { if (!localStorage.getItem('rts.tutorial.v1')) localStorage.setItem('rts.tutorial.v1', JSON.stringify({ skipped: false, done: [], drilled: true })); } catch { /* private mode */ } });
    await land(h, { expectFresh: false });
    await h.press('#mm-new');
    await until(page, () => !!window.__game.getV2(), null, { what: 'a campaign', fix: 'startFirstCampaign in src/main.ts.' });
    const seed = await page.evaluate(() => window.__game.getV2().seed);
    console.log(`  campaign seed ${seed}${SEED === null ? ` (rolled; replay with --seed ${seed})` : ' (pinned)'}`);
    await waitStep(h, 'select-force', 15000);
    const staged = await page.evaluate(() => {
      const v2 = window.__game.getV2();
      const live = (side) => v2.front.forces.filter((f) => f.side === side && f.strength > 0 && f.engagedIn === null);
      const blue = live('blue').find((f) => f.pos.kind === 'node' && f.path.length === 0);
      if (!blue) return { ok: false, why: 'no idle blue company parked on a node' };
      // detectContacts orients on movement first, then on the higher id: a red
      // force parked on a stationary blue one is the attacker.
      const red = live('red').filter((f) => f.id > blue.id).sort((a, b) => b.id - a.id)[0];
      if (!red) return { ok: false, why: 'no red force has an id above a stationary blue force' };
      red.pos = { ...blue.pos };
      red.path = [];
      red.posture = 'march';
      red.dugMin = 0;
      red.strength = Math.round(blue.strength * 0.6);
      return { ok: true, blue: blue.name, red: red.name };
    });
    if (!staged.ok) throw new Error(`could not stage the red attack: ${staged.why}`);
    // The player presses Play before he has marched anywhere.
    await h.press('#theater-hud [data-clock="pause"]');
    await until(page, () => !!document.getElementById('fight') && window.__game.tutorialView()?.step === 'contact', null, { timeout: 60000, what: 'the contact card of the red attack and its step', fix: 'The staged forces never met. detectContacts pairs at CONTACT_M each minute (src/strategic/theater/contact.ts).' });

    // ── the contact card: one button ──
    let v = await checkStep(h, 'contact', ctx);
    const card = await page.evaluate(() => { const c = document.getElementById('contact'); const r = c.getBoundingClientRect(); return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, buttons: [...c.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.textContent), forced: c.querySelector('.fc-forced')?.textContent ?? null, odds: c.querySelector('.fc-odds')?.textContent ?? '' }; });
    check(card.buttons.join() === 'Defend', `${tag}: the card has one button, Defend, and no Stand down (${card.buttons.join(' / ')})`);
    check(/chose this fight/i.test(card.forced ?? ''), `${tag}: the card says who chose the fight ("${card.forced}")`);
    check(/outnumber|Even match/.test(card.odds), `${tag}: the card states the odds in words`);
    check(!overlap(v.bubble, card.rect), `${tag}: the contact bubble is beside the card, not on it`);
    await h.press('#fight');
    await until(page, () => window.__game.getSelection().mode === 'battle', null, { what: 'the battle to boot', fix: 'startTheaterBattle threw: read the console.' });
    if (await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none')) await h.press('#rotate-anyway');

    // ── deployment, as the defender ──
    await waitStep(h, 'deploy', 15000);
    v = await checkStep(h, 'deploy', ctx);
    const dep = await page.evaluate(async () => {
      const { GOAL_LABEL, defending } = await import('/src/ui/battle-goal.ts');
      const { DEPLOY_DEF_LINE, DEPLOY_DEF_DEFAULT } = await import('/src/strategic/deploy.ts');
      const { BATTLE_CLASS_TO_MAPKIND } = await import('/src/strategic/theater.ts');
      const g = window.__game, s = g.sim;
      const strip = document.getElementById('obj-strip');
      const sr = strip.getBoundingClientRect();
      // Its parts, left to right: none off the strip, none under the next, none spilling its own box.
      const parts = [...strip.children].map((c) => ({ r: c.getBoundingClientRect(), spill: c.scrollWidth - c.clientWidth }));
      const line = DEPLOY_DEF_LINE[BATTLE_CLASS_TO_MAPKIND[g.getV2().battle.tb.battleClass]] ?? DEPLOY_DEF_DEFAULT;
      const men = (side) => s.soldiers.filter((m) => m.alive && m.side === side && m.inVehicle < 0);
      const meanX = (a) => a.reduce((t, m) => t + m.x, 0) / a.length;
      return {
        want: GOAL_LABEL.defend, attack: GOAL_LABEL.attack, label: strip.querySelector('.obj-kind').textContent, defending: defending(s),
        fits: sr.left >= 0 && sr.right <= innerWidth && parts.every((q, i) => q.r.width > 0 && q.spill <= 1 && q.r.left >= sr.left - 1 && q.r.right <= sr.right + 1 && (i === 0 || q.r.left >= parts[i - 1].r.right - 1)),
        line, behind: men('blue').filter((m) => m.x >= line).length, of: men('blue').length, redFromWest: meanX(men('red')) < meanX(men('blue')),
        pointer: g.enemyPointer(), tick: s.tick,
      };
    });
    check(dep.label === dep.want && dep.want !== dep.attack && dep.defending, `${tag}: the goal strip tells a defender to break an attack, not to make one ("${dep.label}")`);
    check(dep.fits, `${tag}: the goal strip fits the screen with the longer line, and no part of it lies on the next`);
    check(dep.behind === dep.of, `${tag}: every man deploys behind the defender's line (${dep.behind}/${dep.of} at x >= ${dep.line})`);
    check(!!dep.pointer && Math.cos(dep.pointer.angle) < 0 === dep.redFromWest, `${tag}: the ENEMY pointer is up in deployment, under the step, and points where the enemy is (${dep.pointer ? `angle ${dep.pointer.angle.toFixed(2)}` : 'not drawn'}, red to the ${dep.redFromWest ? 'west' : 'east'})`);
    check(dep.tick === 0, `${tag}: the clock is stopped in deployment (tick ${dep.tick})`);

    // ── Play, a squad, an order ──
    await h.press(h.TOUCH ? '[data-tb="pause"]' : '#hud [data-act="pause"]');
    await until(page, () => window.__game.sim.tick > 5, null, { what: 'the battle to run after Play', fix: 'The first unpause commits the deployment (src/main.ts, the deployPhase && !paused branch).' });
    await waitStep(h, 'battle-select', 5000);
    v = await checkStep(h, 'battle-select', ctx);
    if (!v.ring) throw new Error('the battle-select step rings no squad: worldMark("squad") in src/main.ts found no blue man on the visible map.');
    await h.tap(v.ring);
    await waitStep(h, 'battle-order', 5000);
    v = await checkStep(h, 'battle-order', ctx);
    check(/move/i.test(v.text) && !/send|attack|advance/i.test(v.text), `${tag}: the first-order line does not send a defender forward ("${v.text}")`);
    const squad = (await page.evaluate(() => window.__game.getSelection().squads))[0];
    const dest = await page.evaluate((q) => {
      const g = window.__game, s = g.sim, st = g.stage(), canvas = document.querySelector('canvas');
      const men = s.squads[q].soldierIds.map((i) => s.soldiers[i]).filter((m) => m.alive);
      const cx = men.reduce((a, m) => a + m.x, 0) / men.length, cy = men.reduce((a, m) => a + m.y, 0) / men.length;
      const taken = g.tutorialView().occupied;
      for (const [dx, dy] of [[0, 12], [0, -12], [12, 0], [-12, 0], [8, 8], [8, -8], [0, 20], [0, -20]]) {
        const [x, y] = g.cam.worldToScreen(cx + dx, cy + dy, innerWidth, innerHeight);
        if (x > st.left + 12 && x < st.right - 12 && y > st.top + 12 && y < st.bottom - 12 && document.elementFromPoint(x, y) === canvas && !taken.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom)) return { x, y };
      }
      return null;
    }, squad);
    if (!dest) throw new Error('no ground near the selected squad is on the visible map and clear of the bubble.');
    await h.order(dest);
    // A defender's squad is in a house as often as not, and a hold on a house asks which floor.
    const floors = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#floormenu .fm-row')];
      if (rows.length === 0) return null;
      const cs = getComputedStyle(rows[0]);
      return { rows: rows.map((r) => r.textContent), onTop: rows.every((r) => { const b = r.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === r; }), serif: !/mono/i.test(cs.fontFamily), colour: cs.color };
    });
    if (floors) {
      check(floors.onTop && !floors.serif && floors.colour !== 'rgb(0, 0, 0)', `${tag}: the floor menu a hold on a house opens is over the bubble and in the HUD's type (${floors.rows.join(' / ')}; on top ${floors.onTop}, colour ${floors.colour})`);
      await h.press('#floormenu .fm-row:last-child');
    }
    const first = await squadOrders(page, squad);
    check(first.some((o) => /^(move|fast|sneak)\//.test(o)) && (await stepView(page)).step === null, `${tag}: the order goes in through the UI and the step is done (${first.join(', ')})`);
    await shot('first-order');

    // ── the end (staged), and the debrief ──
    const told = await page.evaluate(async () => {
      const s = window.__game.sim;
      if (!Array.isArray(s.pendingUnitEvents)) throw new Error('Sim.pendingUnitEvents is gone: this gate pushes one event into the queue Sim.takeUnitEvents drains (src/sim/sim.ts). Point it at the new queue.');
      const m = s.soldiers.find((x) => x.alive && x.side === 'blue');
      s.pendingUnitEvents.push({ kind: 'took-over', x: m.x, y: m.y, side: 'blue', name: m.name, id: m.id });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      s.winner = 'blue';
      return m.name;
    });
    await until(page, () => !!document.querySelector('#debrief #next') && getComputedStyle(document.getElementById('debrief')).display !== 'none', null, { timeout: 20000, what: 'the debrief', fix: 'showDebrief runs 4 s after sim.winner is set (src/main.ts frame loop).' });
    await waitStep(h, 'debrief', 5000);
    v = await checkStep(h, 'debrief', ctx);
    await checkOverBattle(h, ctx, 'the debrief');
    const deb = await page.evaluate(() => ({ h1: document.querySelector('#debrief h1')?.textContent, outcome: document.querySelector('#debrief .sub')?.textContent ?? '' }));
    check(deb.h1 === 'VICTORY' && /held/i.test(deb.outcome) && !/ours|taken/i.test(deb.outcome), `${tag}: a defence won is a line held, not ground taken (${deb.h1}: "${deb.outcome}")`);
    const hi = await highlightsView(page);
    checkHighlights(hi, tag);
    check(hi.lines.length === 1 && hi.lines[0].startsWith(`${told} `), `${tag}: what a man did in the battle is on the debrief by his name (${hi.lines.join(' | ') || 'no highlights'}; the event was ${told}'s)`);
    await h.press('#next');
    await until(page, () => window.__game.getSelection().mode === 'strategic', null, { what: 'the theater after the debrief', fix: 'The #next handler sets mode = strategic (src/main.ts showDebrief).' });
    await page.waitForTimeout(600);
    check((await stepView(page)).step !== 'dig-in', `${tag}: holding ground the player already had does not raise the Dig in step`);
    check(h.errors.length === 0, `${tag}: no page or console errors on the whole run${h.errors.length ? `: ${[...new Set(h.errors)].slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await h.browser.close();
  }
}

// ── the first requisition, against a tutorial step ────────────────────────
// A requisition card comes up every reinforcement cycle. The first run does
// not explain it: while it is up the tutorial stands down. The player here
// presses Play with the first step still on screen and waits for Day 2.

async function requisitionRun(device) {
  console.log(`\n=== ${device} · the first requisition card, with a tutorial step on screen ===`);
  const h = await openDevice(device);
  const { page } = h;
  const tag = `${device} requisition`;
  try {
    await page.addInitScript(() => { try { if (!localStorage.getItem('rts.tutorial.v1')) localStorage.setItem('rts.tutorial.v1', JSON.stringify({ skipped: false, done: [], drilled: true })); } catch { /* private mode */ } });
    await land(h, { expectFresh: false });
    await h.press('#mm-new');
    await until(page, () => !!window.__game.getV2(), null, { what: 'a campaign', fix: 'startFirstCampaign in src/main.ts.' });
    await waitStep(h, 'select-force', 15000);
    const view = () => page.evaluate(() => {
      const v2 = window.__game.getV2();
      const coach = document.querySelector('.coach');
      const next = document.querySelector('#theater-hud .th-next');
      const card = document.querySelector('#theater-hud .th-contact');
      return {
        clock: v2.front.clockMin, day: v2.front.day, due: v2.front.requisition?.due === true, card: card.getBoundingClientRect().height > 0 && !!document.getElementById('req'),
        step: window.__game.tutorialView().step, bubble: !!coach && getComputedStyle(coach).display !== 'none',
        label: document.querySelector('#theater-hud .st-pause').textContent, next: next.textContent, nextShown: getComputedStyle(next).visibility !== 'hidden',
      };
    });
    await h.press('#theater-hud [data-clock="2"]');
    await h.press('#theater-hud [data-clock="pause"]');
    await until(page, () => !!document.getElementById('req'), null, { timeout: 120000, what: 'the first requisition card', fix: 'The day rollover raises front.requisition.due on a REINFORCE_CYCLE_DAYS day and the frame loop calls showRequisitionV2 (src/main.ts).' });
    await page.waitForTimeout(400);
    let s = await view();
    check(s.step === 'select-force' && !s.bubble, `${tag}: the tutorial bubble stands down while the card is up (step ${s.step}, bubble ${s.bubble ? 'on screen' : 'hidden'})`);
    check(s.nextShown && wordsIn(s.next) <= 5 && /requisition/i.test(s.next), `${tag}: the strip's own line says what to do ("${s.next}")`);
    check(s.label.includes('Play'), `${tag}: the clock control reads Play while the card waits ("${s.label}")`);
    // Space on a keyboard, the button on a phone: the clock holds either way, and the label must not say otherwise.
    const playOn = await page.evaluate(() => { const e = document.querySelector('#theater-hud [data-clock="pause"]'); const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === e || e.contains(top); });
    if (!h.TOUCH) await page.keyboard.press('Space');
    else if (playOn) await h.press('#theater-hud [data-clock="pause"]');
    await page.waitForTimeout(500);
    const after = await view();
    check(after.label.includes('Play') && after.clock === s.clock, `${tag}: ${h.TOUCH ? (playOn ? 'a tap on Play' : 'Play is under the card and') : 'Space'} leaves the label on Play and the clock where it was ("${after.label}", minute ${s.clock} then ${after.clock})`);
    if (!h.TOUCH || playOn) checkFlash(await flashView(page), tag);
    const pick = await page.evaluate(() => [...document.querySelectorAll('#theater-hud [data-card]')].find((e) => !e.disabled)?.dataset.card ?? null);
    if (!pick) throw new Error('the requisition card offers nothing that can be picked: requisitionOffer in src/strategic/requisition.ts blocked all four.');
    await h.press(`#theater-hud [data-card="${pick}"]`);
    await page.waitForTimeout(500);
    s = await view();
    check(!s.card && !s.due, `${tag}: picking ${pick} answers the card`);
    check(s.step === 'select-force' && s.bubble, `${tag}: the step comes back when the card is gone (step ${s.step}, bubble ${s.bubble ? 'on screen' : 'hidden'})`);
    await checkStep(h, 'select-force', { check, shot: null });
    // The next cycle, with no contact in between: the card must come up again
    // (a hidden first card left its #req behind, and the clock then held for a card nobody could see).
    await h.press('#theater-hud [data-clock="pause"]');
    await until(page, () => window.__game.getV2().front.requisition?.due === true, null, { timeout: 120000, what: 'the second requisition to come due', fix: 'The clock did not run after the first card was answered: toggleStratPause in src/main.ts.' });
    await page.waitForTimeout(600);
    s = await view();
    check(s.card, `${tag}: the second requisition card shows when it comes due (day ${s.day})`);
    check(h.errors.length === 0, `${tag}: no page or console errors${h.errors.length ? `: ${[...new Set(h.errors)].slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await h.browser.close();
  }
}

// ── Skip means skip ───────────────────────────────────────────────────────

async function skipRun() {
  console.log('\n=== phone · Skip tutorial in the drill, reload, play on: nothing tutorial-ish again, until Training is asked for ===');
  const h = await openDevice('phone');
  const { page } = h;
  const ctx = { check, shot: null, label: 'skip' };
  try {
    await land(h);
    await h.press('#mm-play');
    await waitStep(h, 'drill-select', 15000);
    await h.press('.coach-skip');
    const after = await page.evaluate(async () => {
      const { TUTORIAL_STORAGE_KEY } = await import('/src/ui/tutorial.ts');
      return { bubble: !!document.querySelector('.coach'), saved: JSON.parse(localStorage.getItem(TUTORIAL_STORAGE_KEY) ?? 'null'), step: window.__game.tutorialView().step };
    });
    check(!after.bubble && after.step === null, 'skip: Skip tutorial clears the bubble on the spot');
    check(after.saved?.skipped === true, `skip: it is written to storage (${JSON.stringify(after.saved)})`);
    // The drill is still a battle, and still has a door.
    const d = await page.evaluate(() => window.__game.getDrill());
    await h.tap((await manOf(page, d.lead)) ?? { x: 100, y: 400 });
    await page.waitForTimeout(300);
    check((await stepView(page)).step === null, 'skip: selecting a squad in the drill brings no step back');
    await h.press('[data-tb="menu"]');
    await h.press('#pm-leave');
    await until(page, () => getComputedStyle(document.getElementById('mainmenu')).display !== 'none', null, { what: 'the main menu after Leave training', fix: 'onLeaveTraining in src/main.ts.' });

    await land(h, { expectFresh: false });
    const menu = await page.evaluate(() => [...document.querySelectorAll('#mainmenu button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => `${b.id}:${b.textContent}`));
    check(!menu.some((b) => b.startsWith('mm-play')) && menu.includes('mm-tutorial:Tutorial: OFF'), `skip: after a reload the menu is the full one and the switch reads OFF (${menu.join(' | ')})`);
    await h.press('#mm-new');
    await until(page, () => !!window.__game.getV2(), null, { what: 'a campaign from New campaign', fix: 'startFirstCampaign in src/main.ts.' });
    await page.waitForTimeout(600);
    const quiet = await page.evaluate(() => ({ bubbles: document.querySelectorAll('.coach').length, goal: !!document.getElementById('goal-line'), next: document.querySelector('#theater-hud .th-next').textContent, nextShown: getComputedStyle(document.querySelector('#theater-hud .th-next')).visibility !== 'hidden' }));
    check(quiet.bubbles === 0 && !quiet.goal, `skip: a skipped profile starts a campaign with no bubble and no goal line (bubbles ${quiet.bubbles}, goal line ${quiet.goal})`);
    check(quiet.nextShown && quiet.next.length > 0 && !/click/i.test(quiet.next), `skip: the theater's own "what next" line speaks, in touch words ("${quiet.next}")`);
    const chrome = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('#theater-hud .panel')].map((e) => ({ cls: e.className.replace('panel', '').trim(), r: e.getBoundingClientRect() })).filter((p) => p.r.width > 0 && p.r.height > 0);
      const out = [];
      for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
        const a = panels[i].r, b = panels[j].r;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) out.push(`${panels[i].cls} x ${panels[j].cls}`);
      }
      return { overlaps: out, gear: [...document.querySelectorAll('#theater-hud button')].some((b) => b.textContent.includes('⚙') && b.getBoundingClientRect().width > 0) };
    });
    check(chrome.overlaps.length === 0, `skip: theater HUD panels do not sit on each other at 390 px${chrome.overlaps.length ? `: ${chrome.overlaps.join(', ')}` : ''}`);
    check(chrome.gear, 'skip: a phone player can open the menu from the theater');

    // Training is asked for: it teaches, and the skip stays.
    await land(h, { expectFresh: false });
    await h.press('#mm-training');
    await waitStep(h, 'drill-select', 15000);
    await checkStep(h, 'drill-select', ctx);
    check(await page.evaluate(async () => { const { TUTORIAL_STORAGE_KEY } = await import('/src/ui/tutorial.ts'); return JSON.parse(localStorage.getItem(TUTORIAL_STORAGE_KEY)).skipped === true; }), 'skip: Training teaches when asked for and leaves the skip in place');
    check(h.errors.length === 0, `skip: no page or console errors${h.errors.length ? `: ${[...new Set(h.errors)].slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await h.browser.close();
  }
}

// ── the Field Manual on a phone ───────────────────────────────────────────

async function manualRun() {
  console.log('\n=== phone · the Field Manual from the first-run menu ===');
  const h = await openDevice('phone');
  const { page } = h;
  try {
    await land(h);
    await h.press('#mm-manual');
    await until(page, () => document.getElementById('manual')?.style.display === 'flex', null, { what: 'the Field Manual', fix: 'The menu wires #mm-manual to manual.open() (src/main.ts).' });
    const rail = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.mn-navi')].find((x) => x.dataset.ch === 'touch');
      if (!b) return null;
      b.scrollIntoView({ inline: 'center', block: 'nearest' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.textContent };
    });
    check(rail !== null, `manual: the rail lists the controls chapter (${rail?.label})`);
    if (rail) await page.touchscreen.tap(rail.x, rail.y);
    const manual = await page.evaluate(() => {
      const ch = document.getElementById('mn-ch-touch');
      const content = document.querySelector('.mn-content');
      const r = ch?.getBoundingClientRect(), cr = content?.getBoundingClientRect();
      const longest = [...document.querySelectorAll('#manual .mn-entry')].map((e) => ({ h: e.querySelector('h3')?.textContent ?? '', n: (e.querySelector('p')?.textContent ?? '').split(/\s+/).filter(Boolean).length })).sort((a, b) => b.n - a.n)[0];
      return { chapter: ch?.querySelector('h2')?.textContent ?? null, entries: ch?.querySelectorAll('.mn-entry').length ?? 0, scrolledTo: !!r && !!cr && r.top >= cr.top - 4 && r.top < cr.bottom, touchColumn: [...document.querySelectorAll('#mn-ch-touch .mn-klabel')].some((c) => c.textContent === 'Touch'), fits: document.documentElement.scrollWidth <= innerWidth, longest };
    });
    check(manual.chapter === 'Controls' && manual.entries > 0, `manual: it carries a Controls chapter with entries (${manual.chapter}, ${manual.entries})`);
    check(manual.scrolledTo, 'manual: tapping the rail entry scrolls that chapter to the top');
    check(manual.touchColumn, 'manual: key tables show a Touch column');
    check(manual.fits, 'manual: it does not overflow a 390 px viewport');
    check(manual.longest.n <= 30, `manual: no entry is a paragraph (longest: "${manual.longest.h}", ${manual.longest.n} words)`);
  } finally {
    await h.browser.close();
  }
}

// ── the two strings a first battle cannot reach ───────────────────────────
// Both are contact-card copy, so both need a live war and a contact the player
// did not choose. Staged on purpose, in their own contexts, with the tutorial
// off, and the numbers are read out of the app rather than typed here.

async function stagedModalRun(which) {
  console.log(`\n=== staged contact card: ${which === 'defender' ? 'red chose this fight' : 'a 5:1 mismatch'} ===`);
  const h = await openDevice('desktop');
  const { page } = h;
  try {
    await page.addInitScript(() => { try { localStorage.setItem('rts.tutorial.v1', JSON.stringify({ skipped: true, done: [], drilled: true })); } catch { /* private mode */ } });
    await land(h, { expectFresh: false });
    await h.press('#mm-new');
    await until(page, () => !!window.__game.getV2(), null, { what: 'a campaign', fix: 'startFirstCampaign in src/main.ts.' });
    await page.waitForTimeout(300);
    const staged = await page.evaluate(async (which) => {
      const { TRIVIAL_RATIO } = await import('/src/strategic/bridge.ts');
      const { orderMove } = await import('/src/strategic/theater/step.ts');
      const v2 = window.__game.getV2();
      const live = (side) => v2.front.forces.filter((f) => f.side === side && f.strength > 0 && f.engagedIn === null);
      const blue = live('blue').find((f) => f.pos.kind === 'node' && f.path.length === 0);
      if (!blue) return { ok: false, why: 'no idle blue company parked on a node' };
      if (which === 'defender') {
        // Red must be the one who chose the fight. detectContacts orients on
        // movement first, then on the higher id, so a red force parked on top
        // of a stationary blue one attacks deterministically.
        const red = live('red').filter((f) => f.id > blue.id).sort((a, b) => b.id - a.id)[0];
        if (!red) return { ok: false, why: 'no red force has an id above a stationary blue force' };
        red.pos = { ...blue.pos };
        red.path = [];
        red.strength = blue.strength; // even odds: the forced line, not the mismatch line
        return { ok: true, ratio: TRIVIAL_RATIO };
      }
      // A mismatch the player walks into: the two are put on the same ground
      // and OUR company is the one moving, which makes it the attacker.
      const red = live('red').sort((a, b) => a.strength - b.strength)[0];
      if (!red) return { ok: false, why: 'no live red force' };
      red.pos = { ...blue.pos };
      red.path = [];
      // Moved off its post: not dug in here, or its earthworks would deny the walkover.
      red.posture = 'march';
      red.dugMin = 0;
      red.strength = Math.max(1, Math.floor(blue.strength / (TRIVIAL_RATIO + 1)));
      const here = blue.pos.nodeId;
      const nextDoor = v2.front.theater.edges.find((e) => e.a === here || e.b === here);
      if (!nextDoor) return { ok: false, why: `node ${here} has no road out` };
      const r = orderMove(v2.front, blue.id, nextDoor.a === here ? nextDoor.b : nextDoor.a);
      if (!r.ok) return { ok: false, why: `orderMove rejected: ${r.reason}` };
      return { ok: true, ratio: TRIVIAL_RATIO, ratioNow: blue.strength / red.strength };
    }, which);
    if (!staged.ok) throw new Error(`could not stage the ${which} contact: ${staged.why}`);
    await h.press('#theater-hud [data-clock="2"]');
    await h.press('#theater-hud [data-clock="pause"]');
    await until(page, () => !!document.getElementById('fight'), null, { timeout: 90000, what: `the staged ${which} contact card`, fix: 'The staged forces never met. detectContacts pairs at CONTACT_M each minute (src/strategic/theater/contact.ts): check that neither force was re-tasked by the red commander first.' });
    const modal = await page.evaluate(() => ({ odds: document.querySelector('.fc-odds')?.textContent ?? '', forced: document.querySelector('.fc-forced')?.textContent ?? null, fight: document.getElementById('fight')?.textContent ?? null, auto: !!document.getElementById('autoresolve'), standdown: !!document.getElementById('standdown') }));
    if (which === 'defender') {
      check(modal.forced === 'They chose this fight. A defender cannot stand down.', `modal: a defender is told "A defender cannot stand down." (got ${JSON.stringify(modal.forced)})`);
      check(modal.fight === 'Defend' && !modal.standdown, `modal: a defender is offered Defend and no Stand down (button "${modal.fight}", standdown ${modal.standdown})`);
    } else {
      const want = 'A walkover: auto-resolve offered.';
      check(modal.auto, 'modal: a walkover offers Auto-resolve');
      check(modal.odds.includes(want), `modal: the odds line carries "${want}" (got "${modal.odds}")`);
      check(modal.forced === null, 'modal: no defender line on a fight the player chose');
    }
  } finally {
    await h.browser.close();
  }
}

// ── main ──────────────────────────────────────────────────────────────────

mkdirSync(SHOTS, { recursive: true });
console.log(`onboarding gate · ${URL} · shots in ${SHOTS}`);
const t0 = Date.now();
await preflight();
// Each leg is independent: one that dies must not take the others' evidence
// with it, or a single red step hides everything downstream of it.
const legs = [
  ['desktop', 'desktop first run', () => firstRun('desktop')],
  ['phone', 'phone first run', () => firstRun('phone')],
  ['landscape', 'phone landscape first run', () => firstRun('phone-landscape')],
  ['defender', 'desktop defender', () => defenderRun('desktop')],
  ['defender', 'phone defender', () => defenderRun('phone')],
  ['defender', 'phone landscape defender', () => defenderRun('phone-landscape')],
  ['requisition', 'desktop requisition', () => requisitionRun('desktop')],
  ['requisition', 'phone requisition', () => requisitionRun('phone')],
  ['skip', 'skip', skipRun],
  ['skip', 'manual', manualRun],
  ['modal', 'staged contact card: a fight red chose', () => stagedModalRun('defender')],
  ['modal', 'staged contact card: a 5:1 mismatch', () => stagedModalRun('trivial')],
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
writeFileSync(join(SHOTS, 'result.txt'), `${fails.length ? fails.join('\n') : 'all checks passed'}\n\n${shots.join('\n')}\n`);
console.log(`\n${shots.length} screenshots in ${SHOTS} (${mins} min)`);
if (LEG === 'all' || ['desktop', 'phone', 'landscape'].includes(LEG)) console.log(`Dig in step met on: ${digInLegs.join(', ') || 'no leg (each first battle was for a town on the way: run a first-run leg again)'}`);
console.log(fails.length ? `${fails.length} FAILED:\n${fails.map((f) => `  - ${f}`).join('\n')}` : 'all checks passed');
process.exit(fails.length ? 1 : 0);
