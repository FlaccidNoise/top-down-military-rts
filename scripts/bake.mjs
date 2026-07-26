// Terrain chunk-bake perf gate. Ground detail is paid for in bake time, and a
// zoom step across a band boundary rebakes every visible chunk, so a chunk
// that creeps past ~8 ms turns a zoom into a visible stall no per-frame budget
// can hide. Measures the three worst surfaces (village crossroads, densest
// hedge chunk, densest woods chunk) at every band.
//
// Dev server must be running: npm run dev -- --port 5202 --strictPort
//
//   node scripts/bake.mjs --port 5202 --seed 7
import { arg, launch } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const LIMIT_MS = Number(arg('limit', '8'));
const BANDS = [8, 16, 32, 48];
const REPS = 5;

const { browser, page } = await launch();
await page.goto(`http://[::1]:${PORT}/?seed=${SEED}&camp=42&fow=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => '__game' in window, null, { timeout: 5000 }).catch(() => {
  throw new Error(`__game never appeared — is the dev server running? (npm run dev -- --port ${PORT} --strictPort)`);
});

const rows = await page.evaluate(
  async ({ seed, bands, reps }) => {
    const { generateMap } = await import('/src/sim/mapgen.ts');
    const { TerrainLayer } = await import('/src/render/terrain.ts');
    const plan = generateMap(seed, 320, 240, 'town');
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
          // fresh layer per rep so the LRU never serves a warm chunk
          const layer = new TerrainLayer(map);
          const t0 = performance.now();
          const c = layer.chunk(s.cx, s.cy, band);
          c.getContext('2d').getImageData(0, 0, 1, 1); // force rasterization
          ts.push(performance.now() - t0);
        }
        ts.sort((a, b) => a - b);
        out.push({ name: s.name, cx: s.cx, cy: s.cy, band, avg: ts.reduce((a, b) => a + b, 0) / ts.length, min: ts[0], max: ts[ts.length - 1] });
      }
    }
    return out;
  },
  { seed: SEED, bands: BANDS, reps: REPS }
);

await browser.close();

let worst = 0;
console.log('chunk         band    avg      min      max');
for (const r of rows) {
  worst = Math.max(worst, r.avg);
  const flag = r.avg > LIMIT_MS ? '  OVER' : '';
  console.log(`${`${r.name} (${r.cx},${r.cy})`.padEnd(14)}${String(r.band).padStart(4)}  ${r.avg.toFixed(2).padStart(6)}ms ${r.min.toFixed(2).padStart(6)}ms ${r.max.toFixed(2).padStart(6)}ms${flag}`);
}
console.log(`\nworst average ${worst.toFixed(2)} ms (limit ${LIMIT_MS} ms)`);
if (worst > LIMIT_MS) {
  console.error(`FAIL: a chunk bake exceeds ${LIMIT_MS} ms — cut ops in the highest tier or move the detail into a stamp (scripts/../src/render/stamps.ts).`);
  process.exit(1);
}
