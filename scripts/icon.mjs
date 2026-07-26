// Rasterize public/icon.svg to public/icon-512.png.
//
// The SVG is the source of truth; this exists because Android's installer and
// iOS's apple-touch-icon both want a raster, and a committed binary with no
// way to regenerate it is a dead asset. No dev server needed — it renders in
// the headless Chrome that is already a devDependency.
//
//   node scripts/icon.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SIZE = 512;
const SRC = new URL('../public/icon.svg', import.meta.url);
const OUT = fileURLToPath(new URL('../public/icon-512.png', import.meta.url));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(`<style>html,body{margin:0;background:#1a1d1a}svg{display:block}</style>${readFileSync(SRC, 'utf8')}`);
await page.screenshot({ path: OUT });
await browser.close();
console.log(`${OUT}  (${SIZE}x${SIZE})`);
