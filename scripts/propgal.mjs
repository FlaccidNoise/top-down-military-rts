// Prop art gallery: every prop kind drawn side by side on flat grass at a
// chosen zoom band, so a plan-projection audit does not depend on finding one
// of each out in a generated map.
//
//   node scripts/propgal.mjs --port 5261 --scale 32
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch } from './lib/stage.mjs';

const PORT = Number(arg('port', '5261'));
const SCALE = Number(arg('scale', '32'));
const OUT = arg('out', '.screenshots/propgal.png');

const { browser, page } = await launch();
await page.goto(`http://[::1]:${PORT}/?seed=1&camp=42&fow=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => '__game' in window, null, { timeout: 8000 });

const dataUrl = await page.evaluate(
  async ({ scale }) => {
    const { drawProp } = await import('/src/render/props.ts');
    const kinds = ['well', 'cart', 'barrels', 'crates', 'trough', 'muckheap', 'haystack', 'telegraph', 'fencepost', 'gate'];
    const cellW = 9;
    const cellH = 7;
    const cols = 5;
    const rows = Math.ceil(kinds.length / cols);
    const c = document.createElement('canvas');
    c.width = cellW * cols * scale;
    c.height = cellH * rows * scale * 2; // two detail tiers stacked
    const g = c.getContext('2d');
    g.fillStyle = '#6b7a4a';
    g.fillRect(0, 0, c.width, c.height);
    g.save();
    g.scale(scale, scale);
    for (let tier = 0; tier < 2; tier++) {
      const d = tier === 0 ? 2 : 1;
      kinds.forEach((kind, i) => {
        const cx = (i % cols) * cellW + cellW / 2;
        const cy = ((i / cols) | 0) * cellH + cellH / 2 + tier * cellH * rows;
        for (const axis of [0, 1]) {
          const x = cx + (axis ? 2.2 : -2.2);
          drawProp(g, { x, y: cy, kind, seed: 17 + i * 7, axis, link: true }, scale, d);
        }
      });
    }
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = '13px monospace';
    for (let tier = 0; tier < 2; tier++) {
      kinds.forEach((kind, i) => {
        const px = ((i % cols) * cellW + 0.3) * scale;
        const py = (((i / cols) | 0) * cellH + 0.9 + tier * cellH * rows) * scale;
        g.fillText(`${kind} d=${tier === 0 ? 2 : 1}`, px, py);
      });
    }
    return c.toDataURL();
  },
  { scale: SCALE }
);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log(`${OUT}  (@ ${SCALE}px/m)`);
await browser.close();
