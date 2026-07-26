// Like shot.mjs but settles the roof-fade lerp (alphas approach their target
// over ~1s at dt*6) before capturing — place()'s two frames are not enough to
// see a fade state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets } from './lib/stage.mjs';

const PORT = Number(arg('port', '5201'));
const SEED = Number(arg('seed', '7'));
const OUT = arg('out', '.screenshots/settle.png');
const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: Number(arg('camp', '42')), fow: 0 });
const targets = await deriveTargets(page, { seed: SEED, kind });
let x, y, scale;
if (process.argv.includes('--at')) {
  [x, y] = arg('at', '160,120').split(',').map(Number);
  scale = Number(arg('scale', '24'));
} else {
  ({ x, y, scale } = targets[arg('preset', 'village')]);
  if (process.argv.includes('--scale')) scale = Number(arg('scale', '24'));
}
const alphas = await page.evaluate(
  async ({ x, y, scale }) => {
    const g = window.__game;
    g.cam.x = x;
    g.cam.y = y;
    g.cam.scale = scale;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 90; i++) await raf();
    const r = g.renderer ?? g.render ?? null;
    return r ? null : null;
  },
  { x, y, scale }
);
void alphas;
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
console.log(`${OUT}  (seed ${SEED}, x=${x.toFixed(1)} y=${y.toFixed(1)} @ ${scale.toFixed(2)}px/m, settled)`);
await browser.close();
