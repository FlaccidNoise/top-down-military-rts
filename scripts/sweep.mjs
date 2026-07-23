// Seed-sweep screenshot harness — the regression gate for all art work.
//
// Captures a fixed grid of crops (village, woods, hamlet, farm, bocage,
// units, far-LOD, + bridge/river water) across N seeds against a PINNED
// campaign (?camp= disables saving, so runs never touch a real save).
// Scenes are static: battle boots paused and the sim is never stepped, so
// no winner → no debrief race, and pixels are deterministic (all art noise
// flows through the shared render hash).
//
// Usage: node scripts/sweep.mjs [--port 5198] [--seeds 1,2,3]
//   Dev server must already be running: npm run dev -- --port 5198 --strictPort
//   Output: .screenshots/sweep/s<seed>-<crop>.png + index.html contact sheet
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', '5198'));
const SEEDS = arg('seeds', '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
const CAMP = 42; // pinned campaign — fixed chit layout across runs
// Water art never shows up unless a red chit happens to sit on a river cell,
// so two sweep slots force the defender's cell terrain before carving.
const FORCE_KIND = { 3: 'bridge', 8: 'river' };
const OUT = '.screenshots/sweep';
const VIEW = { width: 1280, height: 800 };

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));

const shots = []; // {seed, crop, file}
for (const seed of SEEDS) {
  console.log(`seed ${seed}${FORCE_KIND[seed] ? ` (${FORCE_KIND[seed]})` : ''}`);
  await page.goto(`http://[::1]:${PORT}/?seed=${seed}&camp=${CAMP}&fow=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window);

  // Stage: strongest red chit defends (never auto-resolves), nearest blue
  // attacks; battle boots paused. Then recompute the map plan the same way
  // bridge.ts carved it, and derive crop targets from plan features.
  const crops = await page.evaluate(
    async ({ seed, forceKind }) => {
      const g = window.__game;
      const front = g.front;
      const reds = front.chits
        .filter((c) => c.side === 'red' && c.strength > 0)
        .sort((a, b) => b.strength - a.strength || a.id - b.id);
      const def = reds[0];
      if (forceKind) front.sector.cells[def.cell].terrain = forceKind;
      const sw = front.sector.w;
      const dist = (c) => Math.abs((c.cell % sw) - (def.cell % sw)) + Math.abs(((c.cell / sw) | 0) - ((def.cell / sw) | 0));
      const atk = front.chits
        .filter((c) => c.side === 'blue' && c.strength > 0)
        .sort((a, b) => dist(a) - dist(b) || a.id - b.id)[0];
      g.startEngagementBattle({ attackerId: atk.id, defenderId: def.id, cell: def.cell });

      const kind = front.sector.cells[def.cell].terrain;
      const { generateMap } = await import('/src/sim/mapgen.ts');
      const plan = generateMap(seed, 320, 240, kind);
      const [vil, woods, hamlet] = plan.objectives;
      const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

      // farm: the building most isolated from both settlement clusters
      const bCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
      const farm = plan.buildings
        .map(bCenter)
        .sort((a, b) => Math.min(d2(b, vil), d2(b, hamlet)) - Math.min(d2(a, vil), d2(a, hamlet)))[0];

      // bocage: hedge-densest 16m block away from the settlements
      let bocage = { x: (vil.x + woods.x) / 2, y: (vil.y + woods.y) / 2 };
      let bestHedges = 0;
      for (let by = 0; by < 240; by += 16)
        for (let bx = 0; bx < 320; bx += 16) {
          const c = { x: bx + 8, y: by + 8 };
          if (d2(c, vil) < 40 * 40 || d2(c, hamlet) < 30 * 30) continue;
          let n = 0;
          for (let y = by; y < by + 16; y++)
            for (let x = bx; x < bx + 16; x++) if (plan.map.terrainKeyAt(x, y) === 'hedge') n++;
          if (n > bestHedges) {
            bestHedges = n;
            bocage = c;
          }
        }

      const blues = g.sim.soldiers.filter((s) => s.side === 'blue');
      const units = {
        x: blues.reduce((a, s) => a + s.x, 0) / blues.length,
        y: blues.reduce((a, s) => a + s.y, 0) / blues.length,
      };

      const crops = [
        { name: 'farlod', x: 160, y: 120, scale: Math.min(1280 / 320, 800 / 240) },
        { name: 'village', ...vil, scale: 24 },
        { name: 'woods', ...woods, scale: 24 },
        { name: 'hamlet', ...hamlet, scale: 24 },
        { name: 'farm', ...farm, scale: 24 },
        { name: 'bocage', ...bocage, scale: 24 },
        { name: 'units', ...units, scale: 32 },
      ];
      if (kind === 'bridge' || kind === 'river') {
        const bridge = plan.objectives[plan.objectives.length - 1];
        crops.push({ name: 'bridge', ...bridge, scale: 16 });
      }
      return crops;
    },
    { seed, forceKind: FORCE_KIND[seed] ?? null }
  );

  for (const crop of crops) {
    await page.evaluate(({ x, y, scale }) => {
      const g = window.__game;
      g.cam.x = x;
      g.cam.y = y;
      g.cam.scale = scale;
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, crop);
    const file = `s${seed}-${crop.name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    shots.push({ seed, crop: crop.name, file });
  }
}
await browser.close();

// contact sheet: rows = seeds, cols = crops
const cols = [...new Set(shots.map((s) => s.crop))];
const rows = SEEDS.map((seed) => {
  const cells = cols.map((c) => {
    const s = shots.find((x) => x.seed === seed && x.crop === c);
    return s ? `<td><a href="${s.file}"><img src="${s.file}" loading="lazy"></a></td>` : '<td></td>';
  });
  return `<tr><th>s${seed}</th>${cells.join('')}</tr>`;
});
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><title>seed sweep</title><style>
  body{background:#222;color:#ddd;font:12px monospace}img{width:240px;display:block}
  td,th{padding:2px}th{position:sticky;left:0;background:#222}
  </style><table><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.join('')}</table>`
);
console.log(`${shots.length} shots → ${OUT}/index.html`);
