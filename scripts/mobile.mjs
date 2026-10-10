// Mobile verification harness — the thing that makes "it works on a phone"
// and "desktop is unchanged" falsifiable instead of asserted.
//
// Two independent runs:
//
//   node scripts/mobile.mjs                      # phone + phone-landscape captures + asserts
//   node scripts/mobile.mjs --perf               # 4x-throttled budget probe (M6 constants)
//   node scripts/mobile.mjs --desktop-regression # re-shoot the desktop art presets and diff
//
// The phone run drives REAL touch (CDP Input.dispatchTouchEvent, the same
// pointer stream a finger produces) rather than __game shortcuts, because the
// gesture layer is exactly what is under test. Assertions are on game state
// (`__game.getSelection()`, `__game.cam`) wherever possible — synthetic touch
// timing is flaky, screenshots of it doubly so; the screenshots are for a
// human to judge, the asserts are what fails the run.
//
// Dev server must be running: npm run dev -- --port 5214 --strictPort
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets, place } from './lib/stage.mjs';

const has = (n) => process.argv.includes(`--${n}`);
const PORT = Number(arg('port', '5214'));
const CAMP = Number(arg('camp', '42'));
const SEED = Number(arg('seed', '7'));
const OUT = arg('out', '.screenshots/mobile');
const BASELINE = arg('baseline', '.screenshots/baseline');
const PRESETS = ['farlod', 'village', 'farm', 'units', 'bocage', 'woods'];
const HOLD_MS = 420; // must match src/ui/touch.ts

const fails = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
};

// ── shared ────────────────────────────────────────────────────────────────

/** Stage the same deterministic battle every other harness stages. */
async function stageBattle(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const f = g.front;
    const sw = f.sector.w;
    const reds = f.chits.filter((c) => c.side === 'red' && c.strength > 0).sort((a, b) => b.strength - a.strength || a.id - b.id);
    const def = reds[0];
    const at = (c) => ({ x: c.cell % sw, y: (c.cell / sw) | 0 });
    const atk = f.chits
      .filter((c) => c.side === 'blue' && c.strength > 0)
      .sort((a, b) => {
        const d = (c) => Math.abs(at(c).x - at(def).x) + Math.abs(at(c).y - at(def).y);
        return d(a) - d(b) || a.id - b.id;
      })[0];
    g.startEngagementBattle({ attackerId: atk.id, defenderId: def.id, cell: def.cell });
    return { attacker: atk.name, defender: def.name };
  });
}

/**
 * The clear region is what the player can actually see: the canvas minus the
 * opaque HUD layers. This is the property the 2026-07-24 boot-framing entry
 * measured — reasserted here at 390px, where the panels are proportionally
 * four times as expensive.
 */
function framing(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const cw = innerWidth;
    const ch = innerHeight;
    const box = (id) => {
      const e = document.getElementById(id);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const panels = ['squads', 'topbar', 'obj-strip', 'hint', 'touchbar'].map((id) => ({ id, r: box(id) })).filter((p) => p.r);
    const clear = { left: 0, top: 0, right: cw, bottom: ch };
    for (const p of panels) {
      if (p.r.width > cw * 0.7) {
        // full-width layer: eats top or bottom, never a side
        if (p.r.top < ch / 2) clear.top = Math.max(clear.top, p.r.bottom);
        else clear.bottom = Math.min(clear.bottom, p.r.top);
      } else if (p.r.left < cw / 2) clear.left = Math.max(clear.left, p.r.right);
      else clear.right = Math.min(clear.right, p.r.left);
    }
    const blue = g.sim.soldiers.filter((s) => s.alive && s.side === 'blue');
    let cx = 0;
    let cy = 0;
    let inClear = 0;
    for (const s of blue) {
      const [x, y] = g.cam.worldToScreen(s.x, s.y, cw, ch);
      cx += x;
      cy += y;
      if (x >= clear.left && x <= clear.right && y >= clear.top && y <= clear.bottom) inClear++;
    }
    return {
      blue: blue.length,
      centroid: { x: Math.round(cx / blue.length), y: Math.round(cy / blue.length) },
      inClear,
      clear: { left: Math.round(clear.left), top: Math.round(clear.top), right: Math.round(clear.right), bottom: Math.round(clear.bottom) },
      scale: Math.round(g.cam.scale * 100) / 100,
      panels: panels.map((p) => `${p.id}:${Math.round(p.r.left)},${Math.round(p.r.top)} ${Math.round(p.r.width)}x${Math.round(p.r.height)}`),
    };
  });
}

// ── phone run ─────────────────────────────────────────────────────────────

async function touchSeq(cdp, points, type) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y })) });
}

async function phoneRun(device) {
  console.log(`\n=== ${device} ===`);
  const { browser, page } = await launch({ device });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const cdp = await page.context().newCDPSession(page);
  const dir = join(OUT, device);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const shot = async (name) => {
    const p = join(dir, `${String(++n).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: p });
    console.log(`  shot ${p}`);
    return p;
  };
  const noOverflow = async (where) => {
    const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    check(over.sw <= over.iw, `${device} no horizontal overflow at ${where} (scrollWidth ${over.sw} <= ${over.iw})`);
  };

  await page.goto(`http://[::1]:${PORT}/?camp=${CAMP}&seed=${SEED}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window, null, { timeout: 8000 });
  await page.waitForTimeout(500);

  check(await page.evaluate(() => window.__game.MOBILE === true), `${device} boots with MOBILE on`);

  // (0) PWA + portrait guidance. The banner is CSS-only, so "does it show in
  // portrait and hide in landscape" is a real assertion, not a formality. It
  // is about the battlefield: it must NOT show before a battle (here), and
  // must show in portrait once one starts (asserted after stageBattle).
  const meta = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
    appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
    statusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
    themeColor: document.querySelector('meta[name="theme-color"]')?.content,
    rotateVisible: getComputedStyle(document.getElementById('rotate')).display !== 'none',
    portrait: matchMedia('(orientation: portrait)').matches,
  }));
  // Vite's dev HTML transform rewrites './x' to '/x', so the relative-path
  // half of the deploy contract is only checkable against a real build —
  // scripts/smoke-dist.mjs asserts it there, under a subpath URL.
  check(!!meta.manifest, `${device} manifest link present (${meta.manifest})`);
  check(meta.appleCapable === 'yes' && meta.statusBar === 'black-translucent', `${device} apple standalone meta present`);
  check(!meta.rotateVisible, `${device} no rotate banner before a battle (visible=${meta.rotateVisible}, portrait=${meta.portrait})`);
  const manifestRes = await page.request.get(`http://[::1]:${PORT}/manifest.webmanifest`);
  const manifest = manifestRes.ok() ? await manifestRes.json() : null;
  check(!!manifest && manifest.display === 'standalone' && manifest.orientation === 'landscape' && manifest.icons.length > 0, `${device} manifest serves and declares standalone/landscape + an icon`);

  // The classifier is pure and exposed on the __game seam precisely so the
  // grammar can be asserted here without synthesising timing-sensitive touch.
  const gestures = await page.evaluate(() => {
    const c = window.__game.classify;
    return {
      tap: c({ dt: 80, dist: 0, fingers: 0, maxFingers: 1 }),
      hold: c({ dt: 500, dist: 0, fingers: 0, maxFingers: 1 }),
      pan: c({ dt: 60, dist: 40, fingers: 1, maxFingers: 1 }),
      holdDrag: c({ dt: 500, dist: 40, fingers: 1, maxFingers: 1 }),
      pinch: c({ dt: 200, dist: 30, fingers: 2, maxFingers: 2 }),
      twoTap: c({ dt: 200, dist: 2, fingers: 0, maxFingers: 2 }),
    };
  });
  check(
    Object.entries(gestures).every(([k, v]) => k === v),
    `${device} touch grammar classifies as documented (${JSON.stringify(gestures)})`,
  );

  await shot('strategic-boot');
  await noOverflow('strategic boot');

  // (a) the clock controls exist as real touch targets — a touch player who
  // cannot start the clock cannot play the campaign at all.
  const clock = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#st-progress .st-clock-ctl .hbtn')].map((e) => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    return { buttons: b, paused: !!document.querySelector('#st-progress') };
  });
  check(clock.buttons.length >= 4, `${device} strategic clock controls present (${clock.buttons.length})`);
  check(clock.buttons.every((b) => b.h >= 30), `${device} clock controls >= 30px tall (${clock.buttons.map((b) => b.h).join(',')})`);
  const play = clock.buttons[0];
  await page.touchscreen.tap(play.x, play.y);
  await page.waitForTimeout(200);

  // (b) staged battle at boot framing
  console.log(`  staged ${JSON.stringify(await stageBattle(page))}`);
  await page.waitForTimeout(1200);
  // The portrait guidance belongs HERE: at battle entry, in portrait only.
  const rot = await page.evaluate(() => ({
    visible: getComputedStyle(document.getElementById('rotate')).display !== 'none',
    portrait: matchMedia('(orientation: portrait)').matches,
  }));
  check(rot.visible === rot.portrait, `${device} rotate banner shows at battle entry exactly in portrait (visible=${rot.visible}, portrait=${rot.portrait})`);
  if (rot.visible) {
    await shot('rotate-banner');
    await page.click('#rotate-anyway');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display === 'none'), `${device} rotate banner dismisses`);
  }
  await shot('battle-boot');
  const f = await framing(page);
  console.log(`  framing ${JSON.stringify(f)}`);
  check(
    f.centroid.x >= f.clear.left && f.centroid.x <= f.clear.right && f.centroid.y >= f.clear.top && f.centroid.y <= f.clear.bottom,
    `${device} blue centroid inside the clear region`,
  );
  check(f.inClear / f.blue >= 0.5, `${device} >=50% of blue in the clear region (${f.inClear}/${f.blue})`);
  await noOverflow('battle boot');

  // (c) the touch bar is the control surface: every chip a real target
  const chips = await page.evaluate(() => {
    const bar = document.getElementById('touchbar');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return {
      barH: Math.round(r.height),
      acts: [...bar.querySelectorAll('.tb-acts .hbtn')].map((e) => {
        const b = e.getBoundingClientRect();
        return { tb: e.dataset.tb, w: Math.round(b.width), h: Math.round(b.height), x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }),
    };
  });
  check(!!chips, `${device} #touchbar exists`);
  check(chips.acts.length === 9, `${device} touch bar has all 9 action chips (${chips.acts.length})`);
  check(chips.acts.every((c) => c.h >= 44 && c.w >= 44), `${device} every action chip >= 44x44 (min ${Math.min(...chips.acts.map((c) => Math.min(c.w, c.h)))})`);
  const chip = (name) => chips.acts.find((c) => c.tb === name);

  // (d) roster sheet
  await page.touchscreen.tap(chip('roster').x, chip('roster').y);
  await page.waitForTimeout(250);
  const sheet = await page.evaluate(() => {
    const e = document.getElementById('squads');
    const r = e.getBoundingClientRect();
    const bar = document.getElementById('touchbar').getBoundingClientRect();
    return { open: e.classList.contains('open'), top: Math.round(r.top), bottom: Math.round(r.bottom), barTop: Math.round(bar.top), cards: e.querySelectorAll('.card').length };
  });
  check(sheet.open && sheet.cards > 0, `${device} roster sheet opens with ${sheet.cards} cards`);
  check(sheet.bottom <= sheet.barTop + 1, `${device} roster sheet sits above the touch bar (${sheet.bottom} <= ${sheet.barTop})`);
  await shot('roster-open');
  await noOverflow('roster open');

  // (e) selecting from the sheet closes it and lights the order chips
  const card = await page.evaluate(() => {
    const c = document.querySelector('#squads .card[data-squad]');
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.tap(card.x, card.y);
  await page.waitForTimeout(300);
  const afterSelect = await page.evaluate(() => ({
    sel: window.__game.getSelection().squads,
    rosterOpen: document.getElementById('squads').classList.contains('open'),
    orders: [...document.querySelectorAll('#touchbar .tb-orders .ord')].map((e) => {
      const r = e.getBoundingClientRect();
      return { k: e.dataset.order, w: Math.round(r.width), h: Math.round(r.height) };
    }),
  }));
  check(afterSelect.sel.length === 1, `${device} tapping a card selects one squad`);
  check(!afterSelect.rosterOpen, `${device} the sheet auto-collapses on selection`);
  check(afterSelect.orders.length === 8, `${device} 8 order chips appear once a squad is selected`);
  check(afterSelect.orders.every((o) => o.h >= 44), `${device} order chips >= 44px tall`);
  await shot('order-chips');

  // (f) press-and-hold = the right-click equivalent. Captured mid-hold so the
  // growing ring and the docked tooltip are both on screen.
  const mid = await page.evaluate(() => {
    const bar = document.getElementById('touchbar').getBoundingClientRect();
    const top = document.getElementById('topbar').getBoundingClientRect();
    return { x: Math.round(innerWidth * 0.6), y: Math.round((top.bottom + bar.top) / 2) };
  });
  await touchSeq(cdp, [mid], 'touchStart');
  await page.waitForTimeout(HOLD_MS + 160);
  await shot('hold-order');
  const holdArmed = await page.evaluate(() => !!document.getElementById('tip') && getComputedStyle(document.getElementById('tip')).display);
  await touchSeq(cdp, [mid], 'touchEnd');
  await page.waitForTimeout(300);
  const ordered = await page.evaluate(() => {
    const g = window.__game;
    const sq = g.getSelection().squads[0];
    if (sq === undefined) return null;
    return g.sim.squads[sq].teamIds.map((t) => g.sim.teams[t].orderState.order?.kind ?? null);
  });
  check(ordered !== null && ordered.some((k) => k !== null), `${device} press-and-hold issues an order (${JSON.stringify(ordered)})`);
  console.log(`  tip display mid-hold: ${holdArmed}`);

  // (g) SELECT box mode — the deferred touch box-select
  await page.touchscreen.tap(chip('select').x, chip('select').y);
  await page.waitForTimeout(150);
  check(await page.evaluate(() => document.querySelector('#touchbar [data-tb="select"]').classList.contains('active')), `${device} SELECT latches`);
  const boxed = await page.evaluate(() => {
    const g = window.__game;
    const cw = innerWidth;
    const ch = innerHeight;
    const blue = g.sim.soldiers.filter((s) => s.alive && s.side === 'blue');
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (const s of blue) {
      const [x, y] = g.cam.worldToScreen(s.x, s.y, cw, ch);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const bar = document.getElementById('touchbar').getBoundingClientRect();
    const top = document.getElementById('topbar').getBoundingClientRect();
    return {
      from: { x: Math.max(8, Math.min(cw - 8, x0 - 12)), y: Math.max(top.bottom + 8, Math.min(bar.top - 8, y0 - 12)) },
      to: { x: Math.max(8, Math.min(cw - 8, x1 + 12)), y: Math.max(top.bottom + 8, Math.min(bar.top - 8, y1 + 12)) },
    };
  });
  await touchSeq(cdp, [boxed.from], 'touchStart');
  for (let i = 1; i <= 8; i++) {
    await touchSeq(cdp, [{ x: boxed.from.x + ((boxed.to.x - boxed.from.x) * i) / 8, y: boxed.from.y + ((boxed.to.y - boxed.from.y) * i) / 8 }], 'touchMove');
    await page.waitForTimeout(20);
  }
  await shot('box-drag');
  await touchSeq(cdp, [boxed.to], 'touchEnd');
  await page.waitForTimeout(200);
  const boxSel = await page.evaluate(() => ({ squads: window.__game.getSelection().squads, latched: document.querySelector('#touchbar [data-tb="select"]').classList.contains('active') }));
  check(boxSel.squads.length > 1, `${device} box drag selects multiple squads (${boxSel.squads.length})`);
  check(!boxSel.latched, `${device} SELECT unlatches after the box commits, so panning works again`);
  await shot('box-selected');
  await noOverflow('after box select');

  check(errors.length === 0, `${device} no page/console errors${errors.length ? `: ${[...new Set(errors)].join(' | ')}` : ''}`);
  await browser.close();
}

// ── budget probe (M6) ─────────────────────────────────────────────────────
// Measured, not guessed: the constants in terrain.ts / dudes.ts / audio.ts are
// only defensible against numbers from a throttled phone profile.

async function perfRun() {
  console.log('\n=== budget probe: phone @ 4x CPU throttle ===');
  const { browser, page } = await launch({ device: 'phone' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const dir = join(OUT, 'perf');
  mkdirSync(dir, { recursive: true });

  await page.goto(`http://[::1]:${PORT}/?camp=${CAMP}&seed=${SEED}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window, null, { timeout: 8000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.waitForTimeout(400);

  // First-frame bake: how many frames until nothing is painted flat?
  await stageBattle(page);
  const fill = await page.evaluate(async () => {
    const g = window.__game;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const trace = [];
    for (let i = 0; i < 30; i++) {
      await raf();
      const t = g.renderer?.terrain;
      trace.push(t ? t.pending.size : -1);
      if (i >= 2 && trace[i] === 0 && trace[i - 1] === 0) break;
    }
    return trace;
  });
  const firstClean = fill.findIndex((n) => n === 0);
  console.log(`  flat-fill trace (pending chunks per frame): ${fill.join(',')}`);
  check(firstClean >= 0 && firstClean <= 6, `bake budget fills in within 6 frames (clean at frame ${firstClean})`);
  await page.screenshot({ path: join(dir, 'boot-throttled.png') });

  // Sustained frame rate with the full 247-soldier engagement running.
  await page.evaluate(() => window.__game.setPaused(false));
  const fps = await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    await raf();
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 3000) { await raf(); n++; }
    return { fps: Math.round((n / (performance.now() - t0)) * 1000), frames: n };
  });
  const soldiers = await page.evaluate(() => window.__game.sim.soldiers.length);
  console.log(`  ${fps.fps} fps over ${fps.frames} frames with ${soldiers} soldiers`);
  check(fps.fps >= 24, `>= 24 fps at boot framing with ${soldiers} soldiers under 4x throttle (got ${fps.fps})`);

  const metrics = await cdp.send('Performance.getMetrics');
  const heap = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
  // Terrain is the dominant canvas consumer and PIXEL_BUDGET caps it outright;
  // report the live figure rather than trusting the constant.
  const cache = await page.evaluate(() => {
    const t = window.__game.renderer?.terrain;
    return t ? { chunks: t.cache.size, px: t.pixels } : null;
  });
  console.log(`  JS heap ${(heap / 1e6).toFixed(1)} MB · terrain cache ${cache.chunks} chunks / ${(cache.px / 1e6).toFixed(2)} Mpx (~${((cache.px * 4) / 1e6).toFixed(1)} MB)`);
  check(cache.px <= 6_000_000, `terrain cache inside the mobile pixel budget (${(cache.px / 1e6).toFixed(2)} Mpx <= 6.00)`);
  check(heap / 1e6 + (cache.px * 4) / 1e6 < 150, `heap + terrain canvas under 150 MB (${(heap / 1e6 + (cache.px * 4) / 1e6).toFixed(1)} MB)`);
  await page.screenshot({ path: join(dir, 'running-throttled.png') });
  await browser.close();
}

// ── desktop regression ────────────────────────────────────────────────────

async function pixelDiff(page, a, b) {
  return page.evaluate(
    async ([da, db]) => {
      const load = async (d) => {
        const img = await createImageBitmap(await (await fetch(d)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, px: g.getImageData(0, 0, img.width, img.height).data };
      };
      const A = await load(da);
      const B = await load(db);
      if (A.w !== B.w || A.h !== B.h) return { differing: -1, total: 0, maxDelta: 255 };
      let differing = 0;
      let maxDelta = 0;
      for (let i = 0; i < A.px.length; i += 4) {
        const m = Math.max(Math.abs(A.px[i] - B.px[i]), Math.abs(A.px[i + 1] - B.px[i + 1]), Math.abs(A.px[i + 2] - B.px[i + 2]));
        if (m > maxDelta) maxDelta = m;
        if (m > 8) differing++;
      }
      return { differing, total: A.px.length / 4, maxDelta };
    },
    [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`],
  );
}

async function desktopRegression() {
  console.log('\n=== desktop regression (1280x800 @ dpr 1) ===');
  if (!existsSync(BASELINE)) throw new Error(`no baseline at ${BASELINE} — capture it BEFORE the mobile work: node scripts/shot.mjs --preset <p> --out ${BASELINE}/<p>.png`);
  const { browser, page } = await launch();
  const dir = join(OUT, 'desktop');
  mkdirSync(dir, { recursive: true });

  // The preflight the art gate itself should never fail: a DPR or MOBILE flip
  // silently reshoots every baseline, and a reshot baseline is invisible.
  await page.goto(`http://[::1]:${PORT}/?camp=${CAMP}&seed=${SEED}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window, null, { timeout: 8000 });
  const pre = await page.evaluate(() => ({ dpr: window.__game.view.dpr, mobile: document.documentElement.classList.contains('mobile'), bar: !!document.getElementById('touchbar') }));
  check(pre.dpr === 1, `desktop preflight view.dpr === 1 (got ${pre.dpr})`);
  check(pre.mobile === false, 'desktop preflight html.mobile absent');
  check(pre.bar === false, 'desktop preflight no #touchbar built');

  for (const name of PRESETS) {
    const base = join(BASELINE, `${name}.png`);
    if (!existsSync(base)) { console.log(`  skip ${name} (no baseline)`); continue; }
    // One reload per preset, exactly how shot.mjs captured the baselines.
    // Walking presets on a warm page leaves the chunk cache and the roof-fade
    // lerp in a different state and shows up as a fake 0.35% regression.
    const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP, fow: 0 });
    const targets = await deriveTargets(page, { seed: SEED, kind });
    const t = targets[name];
    await place(page, t.x, t.y, t.scale);
    const out = join(dir, `${name}.png`);
    await page.screenshot({ path: out });
    const d = await pixelDiff(page, readFileSync(base), readFileSync(out));
    const pct = d.total ? (d.differing / d.total) * 100 : 100;
    console.log(`  ${name}: ${d.differing} px differ >8 (${pct.toFixed(4)}%), max channel delta ${d.maxDelta}`);
    // The static art sweep is deterministic in content but the amortized bake
    // means a capture can land one frame either side of the last chunk, so a
    // handful of pixels is noise. A leaked mobile rule moves panels — tens of
    // thousands of pixels — and cannot hide under this floor.
    check(pct < 0.05, `desktop ${name} unchanged (${pct.toFixed(4)}% of pixels differ)`);
  }
  await browser.close();
}

// ── main ──────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
if (has('desktop-regression')) {
  await desktopRegression();
} else if (has('perf')) {
  await perfRun();
} else {
  for (const d of (arg('device', 'phone,phone-landscape')).split(',')) await phoneRun(d);
}
writeFileSync(join(OUT, 'result.txt'), fails.length ? fails.join('\n') : 'all checks passed');
console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.map((f) => `  - ${f}`).join('\n')}` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
