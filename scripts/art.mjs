// Art-audit crop: same staging as shot.mjs, but the DOM HUD is hidden and only
// the canvas is captured, so a prop crop is all art and no chrome.
//
// Three ways to aim it: a named preset crop, a raw world point, or the first
// building carrying a mapgen role — the last is how you find the one church
// tower on a 320x240 map, which no preset centres on.
//
//   node scripts/art.mjs --port 5261 --seed 10 --force bourg --preset church --scale 40
//   node scripts/art.mjs --port 5261 --seed 10 --force bourg --role church_tower --scale 24
//   node scripts/art.mjs --port 5261 --seed 10 --at 116,121 --scale 64
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets, place } from './lib/stage.mjs';

const has = (n) => process.argv.includes(`--${n}`);
const PORT = Number(arg('port', '5261'));
const SEED = Number(arg('seed', '10'));
const CAMP = Number(arg('camp', '42'));
const FORCE = arg('force', null);
const OUT = arg('out', '.screenshots/art.png');

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP, fow: 0, forceKind: FORCE });
const targets = await deriveTargets(page, { seed: SEED, kind });

let x;
let y;
let scale;
if (has('at')) {
  [x, y] = arg('at', '160,120').split(',').map(Number);
  scale = Number(arg('scale', '40'));
} else if (has('role')) {
  const role = arg('role', 'church_tower');
  const hit = await page.evaluate(
    async ({ seed, kind, role }) => {
      const { generateMap } = await import('/src/sim/mapgen.ts');
      const plan = generateMap(seed, 320, 240, kind);
      const b = plan.buildings.find((q) => q.role === role);
      if (!b) return { roles: [...new Set(plan.buildings.map((q) => q.role))] };
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    },
    { seed: SEED, kind, role }
  );
  if (hit.roles) throw new Error(`no building with role "${role}" — this map has: ${hit.roles.join(', ')}`);
  ({ x, y } = hit);
  scale = Number(arg('scale', '24'));
} else {
  const t = targets[arg('preset', 'units')];
  if (!t) throw new Error(`unknown preset "${arg('preset')}" — one of: ${Object.keys(targets).join(', ')}`);
  ({ x, y } = t);
  scale = Number(arg('scale', String(t.scale)));
}
await place(page, x, y, scale);
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  for (const el of document.querySelectorAll('body *')) {
    if (el === canvas || el.contains(canvas)) continue;
    el.style.display = 'none';
  }
});
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
mkdirSync(dirname(OUT), { recursive: true });
const buf = await page.screenshot();
writeFileSync(OUT, buf);
console.log(`${OUT}  (seed ${SEED}, x=${x.toFixed(1)} y=${y.toFixed(1)} @ ${scale}px/m, terrain=${kind})`);
await browser.close();
