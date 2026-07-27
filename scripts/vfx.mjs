// VFX regression gate — the moving-picture companion to sweep.mjs.
//
// sweep.mjs shoots static art; this stages the transient combat-feel layer
// (muzzle flash, tracer travel, impact, explosion → smoke column, death pose,
// smoke screen) and captures the actual sub-100ms frames from inside the page.
// Output: .screenshots/vfx/<effect>-b<bucket>.png + index.html (rows=effect,
// cols=age bucket, so you read each effect evolve left→right).
//
// Usage: node scripts/vfx.mjs [--port 5198] [--seed 7]
//   Dev server must already be running: npm run dev -- --port 5198 --strictPort
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets, deriveBuilding, wallStage, burst } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const CAMP = 42;
const SCALE = 40; // px/m — effects large enough to read every sub-effect
const OUT = '.screenshots/vfx';
mkdirSync(OUT, { recursive: true });
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// Wall-clock transient effects — must be caught in-page (burst).
// Buckets chosen from renderer timing: shots span muzzle(0-60ms)→travel(0-90)→
// impact(90-340); booms span flash(0-45)→fireball(30-260)→debris→column(→2600).
// A flash is over in 110 ms, so short effects get 4 buckets over 140 ms rather
// than spending half their columns on an empty tail.
//
// `anchor:'wall'` restages the row against real masonry (a miss aimed short of
// a building's west wall, so the overshoot ray lands on stone). `minPeak`
// relaxes the changed-pixel bar for effects that are deliberately quiet, per
// row — never by weakening the global assertion.
const DYN = [
  { name: 'muzzle+tracer hit', trigger: { type: 'shot', hit: true, kill: false }, dur: 340, buckets: 6 },
  { name: 'tracer kill', trigger: { type: 'shot', hit: true, kill: true }, dur: 340, buckets: 6 },
  { name: 'tracer miss', trigger: { type: 'shot', hit: false, kill: false }, dur: 340, buckets: 6 },
  { name: 'muzzle mg42', trigger: { type: 'shot', hit: true, kill: false, weapon: 'mg42' }, dur: 140, buckets: 4 },
  { name: 'muzzle thompson', trigger: { type: 'shot', hit: true, kill: false, weapon: 'thompson' }, dur: 140, buckets: 4, minPeak: 15 },
  { name: 'muzzle bazooka', trigger: { type: 'shot', hit: true, kill: false, weapon: 'bazooka' }, dur: 420, buckets: 4 },
  { name: 'cannon blast', trigger: { type: 'shot', hit: true, kill: false, weapon: 'pak40_gun' }, dur: 720, buckets: 4 },
  { name: 'wall strike', anchor: 'wall', trigger: { type: 'shot', hit: false, kill: false }, dur: 400, buckets: 4, roiFrac: 0.3, minPeak: 15 },
  { name: 'explosion smoke', trigger: { type: 'boom' }, dur: 2600, buckets: 8 },
  { name: 'grenade boom', trigger: { type: 'boom', r: 3 }, dur: 2600, buckets: 8 },
  { name: 'barrage boom', trigger: { type: 'boom', r: 9 }, dur: 2600, buckets: 8 },
];

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP });
const targets = await deriveTargets(page, { seed: SEED, kind });
const anchor = targets.units; // stage over the US squad cluster (real units in frame)

// `village` only exists in the legacy target set; a bourg map calls the same
// crop `place`. Since bourg went live in the campaign the default seed carves
// a bourg, so hard-coding `village` crashed the whole gate on boot.
const house = await deriveBuilding(page, targets.village ?? targets.place);

const rows = [];
let warnings = 0;
for (const e of DYN) {
  let at = anchor;
  let trigger = e.trigger;
  if (e.anchor === 'wall') {
    const w = wallStage(house);
    at = w.anchor;
    trigger = { ...e.trigger, ...w.aim };
  }
  const frames = await burst(page, { x: at.x, y: at.y, scale: SCALE, trigger, dur: e.dur, buckets: e.buckets, roiFrac: e.roiFrac });
  const cells = frames.map((f) => {
    const file = `${slug(e.name)}-b${f.bucket}.png`;
    writeFileSync(join(OUT, file), Buffer.from(f.dataUrl.split(',')[1], 'base64'));
    return { file, bucket: f.bucket, age: f.ageMs, score: f.score };
  });
  const peak = cells.reduce((a, c) => (c.score > a.score ? c : a), { score: 0, age: -1 });
  // measure, don't assume: score = ROI pixels changed vs the pre-fire frame, so
  // a peak of ~0 means we missed the effect window entirely.
  const ok = cells.length === e.buckets && peak.score > (e.minPeak ?? 40);
  if (!ok) warnings++;
  console.log(`${ok ? 'ok ' : 'WARN'} ${e.name}: ${cells.length}/${e.buckets} buckets, peak ${peak.score} changed-px @ ${peak.age}ms`);
  rows.push({ name: e.name, cells });
}

// Let the last burst's booms/tracers expire so they don't photobomb the static
// sim-state captures below (BOOM_MS=2600).
await page.waitForTimeout(2800);

// Static sim-state effects — pause-safe, so a normal screenshot is reliable.
// Death pose: kill the nearest blue soldier in place (renderer stamps a blood
// pool the first dead frame, then draws the 'dead' sprite).
await page.evaluate(
  ({ x, y }) => {
    const g = window.__game;
    const sim = g.sim;
    let best = null;
    let bd = Infinity;
    for (const s of sim.soldiers) {
      if (s.side !== 'blue' || !s.alive) continue;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) throw new Error('no living blue soldier near anchor for death pose');
    g.cam.x = best.x;
    g.cam.y = best.y;
    g.cam.scale = 56;
    return new Promise((r) => requestAnimationFrame(() => {
      best.alive = false;
      requestAnimationFrame(() => requestAnimationFrame(r));
    }));
  },
  anchor
);
await page.screenshot({ path: join(OUT, 'death-pose.png') });
rows.push({ name: 'death pose', cells: [{ file: 'death-pose.png', bucket: 0, age: 0, score: 0 }] });

// Smoke screen (sim.smoke, sim-state): push at ttl 60 so the renderer records
// maxTtl=60, then drop ttl to 36 → life 0.4 → full opacity while paused.
await page.evaluate(
  ({ x, y }) => {
    const g = window.__game;
    const sim = g.sim;
    g.cam.x = x;
    g.cam.y = y;
    g.cam.scale = 40;
    sim.smoke.push({ x: x - 2, y, ttl: 60 }, { x: x + 2, y, ttl: 60 }, { x, y: y - 2, ttl: 60 });
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const p of sim.smoke) p.ttl = 36;
      requestAnimationFrame(() => requestAnimationFrame(r));
    })));
  },
  anchor
);
await page.screenshot({ path: join(OUT, 'smoke-screen.png') });
rows.push({ name: 'smoke screen', cells: [{ file: 'smoke-screen.png', bucket: 0, age: 0, score: 0 }] });

// Pockmarks (marks.ts): twenty misses into one wall. Each target y is offset a
// little because the 1-in-3 mark gate hashes the impact coords — twenty rounds
// at identical coordinates would either all mark or none would.
await page.evaluate(
  (b) => {
    const g = window.__game;
    const my = b.y + b.h / 2;
    g.cam.x = b.x; // wall on the screen centre line, so the clip below lands on it
    g.cam.y = my;
    g.cam.scale = 64;
    for (let i = 0; i < 20; i++) {
      const ty = my - 1.4 + i * 0.14;
      g.sim.pendingEvents.push({ fx: b.x - 6, fy: ty, tx: b.x - 1.2, ty, hit: false, kill: false, weapon: 'garand' });
    }
  },
  house
);
await page.waitForTimeout(600); // let the tracers and spall age off; the marks are permanent
// Clipped: a 0.15 m chip is ~10 px here and would vanish in a 220 px contact
// sheet cell, which is the one thing a regression gate cannot afford.
await page.screenshot({ path: join(OUT, 'pockmarks.png'), clip: { x: 460, y: 220, width: 360, height: 360 } });
rows.push({ name: 'pockmarks', cells: [{ file: 'pockmarks.png', bucket: 0, age: 0, score: 0 }] });

// Building fire (FX5). Its lifetime runs on sim.tick and the game is paused, so
// the fire survives the wait that kills the blast transient — which is the
// point of the two-clock split, and worth asserting.
await page.evaluate(
  (b) => {
    const g = window.__game;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    g.cam.x = cx;
    g.cam.y = cy;
    g.cam.scale = 30;
    g.sim.pendingBooms.push({ x: cx, y: cy, r: 6 });
  },
  house
);
await page.waitForTimeout(2900);
await page.screenshot({ path: join(OUT, 'building-fire.png') });
rows.push({ name: 'building fire', cells: [{ file: 'building-fire.png', bucket: 0, age: 0, score: 0 }] });

// Vehicle brew-up (FX5): no vehicles in the staged garrison scenario, so add
// one and kill it — the same wreck+burning state destroyVehicle leaves behind.
await page.evaluate(
  ({ x, y }) => {
    const g = window.__game;
    const v = g.sim.addVehicle('red', 'panzer4', x, y, 0.6);
    v.alive = false;
    v.burning = true;
    g.cam.x = x;
    g.cam.y = y;
    g.cam.scale = 30;
  },
  { x: anchor.x + 6, y: anchor.y }
);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'brew-up.png') });
rows.push({ name: 'vehicle brew-up', cells: [{ file: 'brew-up.png', bucket: 0, age: 0, score: 0 }] });

await browser.close();

// Haze (FX7) needs its own page: the band layer is chosen at battle start from
// ?haze, and it only exists at the far zooms, so it gets a fresh far shot with
// the switch both ways.
{
  const { browser: b2, page: p2 } = await launch();
  const k2 = await gotoStaged(p2, { port: PORT, seed: SEED, camp: CAMP });
  const t2 = await deriveTargets(p2, { seed: SEED, kind: k2 });
  for (const [name, file, on] of [['haze', 'haze-on.png', 1], ['haze off', 'haze-off.png', 0]]) {
    if (!on) await gotoStaged(p2, { port: PORT, seed: SEED, camp: CAMP, haze: 0 });
    await p2.evaluate(
      async ({ x, y }) => {
        const g = window.__game;
        g.cam.x = x;
        g.cam.y = y;
        g.cam.scale = 12;
        for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
      },
      t2.village ?? t2.place
    );
    await p2.screenshot({ path: join(OUT, file) });
    rows.push({ name, cells: [{ file, bucket: 0, age: 0, score: 0 }] });
  }
  await b2.close();
}

const maxCols = Math.max(...rows.map((r) => r.cells.length));
const html = `<!doctype html><title>vfx capture — seed ${SEED}</title><style>
  body{background:#222;color:#ddd;font:12px monospace}img{width:220px;display:block}
  td,th{padding:2px;vertical-align:top}th{position:sticky;left:0;background:#222;text-align:left}
  .cap{color:#8a8;font-size:10px}a{color:#7bf}</style>
  <p><a href="../sweep/index.html">← static art sweep</a> · dynamic VFX gate, seed ${SEED}</p>
  <table>${rows
    .map(
      (r) =>
        `<tr><th>${r.name}</th>${Array.from({ length: maxCols }, (_, i) => {
          const c = r.cells[i];
          return c
            ? `<td><a href="${c.file}"><img src="${c.file}" loading="lazy"></a><div class="cap">${c.age}ms${c.score ? ` · ${c.score | 0}` : ''}</div></td>`
            : '<td></td>';
        }).join('')}</tr>`
    )
    .join('')}</table>`;
writeFileSync(join(OUT, 'index.html'), html);
console.log(`${rows.length} effects → ${OUT}/index.html${warnings ? ` (${warnings} WARN)` : ''}`);
