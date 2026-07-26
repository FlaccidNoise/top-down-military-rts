// shot.mjs, but with the camera left alone for ~1.5s before the capture.
//
// place() settles two frames, which is right for static scenes but far too
// short for anything on a lerp: the roof fade approaches its target at dt*6,
// so a two-frame shot of a revealed building still shows it ~84% opaque. Use
// this when you need to see a settled fade state, not the frame it started in.
//
//   node scripts/settle.mjs --port 5201 --preset village
//   node scripts/settle.mjs --port 5201 --at 187,112 --scale 32
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const OUT = arg('out', '.screenshots/settle.png');
const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: Number(arg('camp', '42')), fow: Number(arg('fow', '0')) });
const targets = await deriveTargets(page, { seed: SEED, kind });

let x;
let y;
let scale;
if (process.argv.includes('--at')) {
  [x, y] = arg('at', '160,120').split(',').map(Number);
  scale = Number(arg('scale', '24'));
} else {
  const t = targets[arg('preset', 'village')];
  if (!t) throw new Error(`unknown preset "${arg('preset')}" — see node scripts/shot.mjs --list`);
  ({ x, y } = t);
  scale = process.argv.includes('--scale') ? Number(arg('scale', '24')) : t.scale;
}

await page.evaluate(
  async ({ x, y, scale }) => {
    const g = window.__game;
    g.cam.x = x;
    g.cam.y = y;
    g.cam.scale = scale;
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  },
  { x, y, scale }
);
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
console.log(`${OUT}  (seed ${SEED}, x=${x.toFixed(1)} y=${y.toFixed(1)} @ ${scale.toFixed(2)}px/m, settled)`);
await browser.close();
