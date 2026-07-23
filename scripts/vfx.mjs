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
import { arg, launch, gotoStaged, deriveTargets, burst } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const CAMP = 42;
const SCALE = 40; // px/m — effects large enough to read every sub-effect
const OUT = '.screenshots/vfx';
mkdirSync(OUT, { recursive: true });
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// Wall-clock transient effects — must be caught in-page (burst).
// Buckets chosen from renderer timing: shots span muzzle(0-60ms)→travel(0-90)→
// impact(90-340); booms span fireball(0-150)→ejecta→smoke column(→2000).
const DYN = [
  { name: 'muzzle+tracer hit', trigger: { type: 'shot', hit: true, kill: false }, dur: 340, buckets: 6 },
  { name: 'tracer kill', trigger: { type: 'shot', hit: true, kill: true }, dur: 340, buckets: 6 },
  { name: 'tracer miss', trigger: { type: 'shot', hit: false, kill: false }, dur: 340, buckets: 6 },
  { name: 'explosion smoke', trigger: { type: 'boom' }, dur: 2000, buckets: 8 },
];

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP });
const targets = await deriveTargets(page, { seed: SEED, kind });
const anchor = targets.units; // stage over the US squad cluster (real units in frame)

const rows = [];
let warnings = 0;
for (const e of DYN) {
  const frames = await burst(page, { x: anchor.x, y: anchor.y, scale: SCALE, trigger: e.trigger, dur: e.dur, buckets: e.buckets });
  const cells = frames.map((f) => {
    const file = `${slug(e.name)}-b${f.bucket}.png`;
    writeFileSync(join(OUT, file), Buffer.from(f.dataUrl.split(',')[1], 'base64'));
    return { file, bucket: f.bucket, age: f.ageMs, score: f.score };
  });
  const peak = cells.reduce((a, c) => (c.score > a.score ? c : a), { score: 0, age: -1 });
  // measure, don't assume: score = ROI pixels changed vs the pre-fire frame, so
  // a peak of ~0 means we missed the effect window entirely.
  const ok = cells.length === e.buckets && peak.score > 40;
  if (!ok) warnings++;
  console.log(`${ok ? 'ok ' : 'WARN'} ${e.name}: ${cells.length}/${e.buckets} buckets, peak ${peak.score} changed-px @ ${peak.age}ms`);
  rows.push({ name: e.name, cells });
}

// Let the last burst's booms/tracers expire so they don't photobomb the static
// sim-state captures below (BOOM_MS=2000).
await page.waitForTimeout(2200);

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

await browser.close();

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
