// Terrain chunk-bake perf gate. Ground detail is paid for in bake time, and a
// zoom step across a band boundary rebakes every visible chunk, so a chunk
// that creeps past ~8 ms turns a zoom into a visible stall no per-frame budget
// can hide. Measures the three worst surfaces (village crossroads, densest
// hedge chunk, densest woods chunk) at every band.
//
// Dev server must be running: npm run dev -- --port 5202 --strictPort
//
//   node scripts/bake.mjs --port 5202 --seed 7 [--kind bourg]
//
// Also the sun-step perf gate (N14, design §9): after the chunk timings it
// stages a live battle, crosses a sun step through the sim clock, and asserts
// (a) the rebake drains, and (b) night frames are NOT slower than day frames —
// alphaMul 0 deletes the whole per-unit shadow pass, which more than pays for
// the grade's one fillRect. Intuition runs the other way, so it is asserted
// here rather than assumed, and someone "optimising" night later has a number.
import { arg, launch, gotoStaged, deriveTargets, place } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const LIMIT_MS = Number(arg('limit', '8'));
const KIND = arg('kind', 'open'); // --kind bourg times the bourg surfaces (place chunk etc.)
const BANDS = [8, 16, 32, 48];
const REPS = 5;

const { browser, page } = await launch();
await page.goto(`http://[::1]:${PORT}/?seed=${SEED}&camp=42&fow=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => '__game' in window, null, { timeout: 5000 }).catch(() => {
  throw new Error(`__game never appeared — is the dev server running? (npm run dev -- --port ${PORT} --strictPort)`);
});

const rows = await page.evaluate(
  async ({ seed, bands, reps, kind }) => {
    const { generateMap } = await import('/src/sim/mapgen.ts');
    const { TerrainLayer } = await import('/src/render/terrain.ts');
    const { sunStepFor } = await import('/src/render/light.ts');
    const plan = generateMap(seed, 320, 240, kind);
    const map = plan.map;
    const CHUNK = 16;
    const cw = Math.ceil(320 / CHUNK);
    const chh = Math.ceil(240 / CHUNK);

    const count = (cx, cy, pred) => {
      let n = 0;
      for (let y = cy * CHUNK; y < Math.min(240, (cy + 1) * CHUNK); y++)
        for (let x = cx * CHUNK; x < Math.min(320, (cx + 1) * CHUNK); x++) if (pred(map.terrainKeyAt(x, y))) n++;
      return n;
    };
    const densest = (pred) => {
      let best = { cx: 0, cy: 0, n: -1 };
      for (let cy = 0; cy < chh; cy++)
        for (let cx = 0; cx < cw; cx++) {
          const n = count(cx, cy, pred);
          if (n > best.n) best = { cx, cy, n };
        }
      return best;
    };
    const vil = plan.objectives[0];
    const spots = [
      { name: 'village', cx: Math.floor(vil.x / CHUNK), cy: Math.floor(vil.y / CHUNK) },
      { name: 'bocage', ...densest((k) => k === 'hedge') },
      { name: 'woods', ...densest((k) => k === 'woods') },
      { name: 'field', ...densest((k) => k === 'field') },
    ];

    const out = [];
    for (const s of spots) {
      for (const band of bands) {
        const ts = [];
        for (let r = 0; r < reps; r++) {
          // fresh layer per rep so the LRU never serves a warm chunk.
          // The key gained a sun-step component (N4); the step is a key
          // string, not work, so timings must not move with it.
          const layer = new TerrainLayer(map);
          const t0 = performance.now();
          const c = layer.chunk(s.cx, s.cy, band, sunStepFor(band));
          c.getContext('2d').getImageData(0, 0, 1, 1); // force rasterization
          ts.push(performance.now() - t0);
        }
        ts.sort((a, b) => a - b);
        out.push({ name: s.name, cx: s.cx, cy: s.cy, band, avg: ts.reduce((a, b) => a + b, 0) / ts.length, min: ts[0], max: ts[ts.length - 1] });
      }
    }
    return out;
  },
  { seed: SEED, bands: BANDS, reps: REPS, kind: KIND }
);

// --- Sun-step drain + day/night frame cost (N14, design §9.1) ---------------
// Staged battle at the canonical hour, camera on the densest crop. The sun is
// moved through the SIM clock: main.ts re-asserts setSun(sim.clockMin) every
// battle frame, so light.setSun from a probe would be overwritten next frame.
const stagedKind = await gotoStaged(page, { port: PORT, seed: SEED, camp: 42, fow: 0 });
const targets = await deriveTargets(page, { seed: SEED, kind: stagedKind });
const spot = targets.place ?? targets.village;
await place(page, spot.x, spot.y, 24);
const drain = await page.evaluate(async () => {
  const g = window.__game;
  const r = g.renderer;
  const sim = g.sim;
  const draw0 = r.draw.bind(r);
  let times = [];
  r.draw = (...a) => {
    const t0 = performance.now();
    draw0(...a);
    times.push(performance.now() - t0);
  };
  const frames = (n) => new Promise((res) => {
    const step = (k) => (k <= 0 ? res() : requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  await frames(30); // settle the canonical scene
  times = [];
  await frames(120);
  const dayMs = median(times);

  const t0 = performance.now();
  sim.startMin = 7 * 60; // 14:00 -> 07:00: a fresh sun step, every sun-keyed cache stale
  let quiet = 0;
  let n = 0;
  let lastCache = r.terrain.cache.size;
  while (quiet < 10 && n < 600) {
    await frames(1);
    n++;
    // drained = the roof bake queue is empty AND the terrain cache stopped
    // gaining chunks, ten frames straight
    const busy = r.roofs.queue.length > 0 || r.terrain.cache.size !== lastCache;
    lastCache = r.terrain.cache.size;
    quiet = busy ? 0 : quiet + 1;
  }
  const drainFrames = n - quiet;
  const drainMs = performance.now() - t0;
  const drained = quiet >= 10;

  sim.startMin = 2 * 60; // deep night: no cast pass, grade on
  await frames(30);
  times = [];
  await frames(120);
  const nightMs = median(times);

  sim.startMin = 840; // leave the page canonical for anything run after us
  await frames(30);
  return { dayMs, nightMs, drainFrames, drainMs, drained };
});

await browser.close();

let worst = 0;
console.log('chunk         band    avg      min      max');
for (const r of rows) {
  worst = Math.max(worst, r.avg);
  const flag = r.avg > LIMIT_MS ? '  OVER' : '';
  console.log(`${`${r.name} (${r.cx},${r.cy})`.padEnd(14)}${String(r.band).padStart(4)}  ${r.avg.toFixed(2).padStart(6)}ms ${r.min.toFixed(2).padStart(6)}ms ${r.max.toFixed(2).padStart(6)}ms${flag}`);
}
console.log(`\nworst average ${worst.toFixed(2)} ms (limit ${LIMIT_MS} ms)`);

console.log(`\nsun-step drain (14:00 -> 07:00 @ 24 px/m): ${drain.drainFrames} frames / ${drain.drainMs.toFixed(0)} ms${drain.drained ? '' : '  NEVER DRAINED'}`);
console.log(`frame cost median over 120: day ${drain.dayMs.toFixed(2)} ms, night ${drain.nightMs.toFixed(2)} ms`);

let failed = false;
if (worst > LIMIT_MS) {
  console.error(`FAIL: a chunk bake exceeds ${LIMIT_MS} ms — cut ops in the highest tier or move the detail into a stamp (scripts/../src/render/stamps.ts).`);
  failed = true;
}
if (!drain.drained) {
  console.error('FAIL: the 07:00 sun step never drained within 600 frames — the bake queue is starving or thrashing.');
  failed = true;
}
if (drain.nightMs > drain.dayMs * 1.1 + 0.2) {
  console.error(
    `FAIL: night frames (${drain.nightMs.toFixed(2)} ms) are slower than day (${drain.dayMs.toFixed(2)} ms) — the alphaMul early-out in drawUnitShadows or the grade's a===0 skip regressed.`
  );
  failed = true;
}
if (failed) process.exit(1);
