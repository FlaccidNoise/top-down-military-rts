// Production-bundle smoke test: loads a built dist/ from a plain static file
// server (no vite, no dev middleware) and asserts the game actually boots —
// __game present, a battle stageable, no console/page errors. Catches the
// class of failure `npm run dev` cannot: wrong asset base, missing files,
// anything that only breaks once bundled.
//
// Usage: node scripts/smoke-dist.mjs --url http://127.0.0.1:5211/pr-123/
import { launch, arg } from './lib/stage.mjs';

const URL = arg('url', 'http://127.0.0.1:5211/pr-123/');
const { browser, page } = await launch();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

const resp = await page.goto(`${URL}?camp=42`, { waitUntil: 'load' });
console.log(`GET ${URL} -> ${resp.status()}`);
await page.waitForFunction(() => '__game' in window, null, { timeout: 8000 });

// PWA assets are the one part of the deploy contract vite's dev server hides:
// it rewrites './x' to '/x', so only a built bundle served from a subpath can
// prove the manifest and icons resolve rather than 404ing at the domain root.
const pwa = await page.evaluate(() => ({
  manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
  icon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
}));
for (const [name, href] of Object.entries(pwa)) {
  if (!href) { errors.push(`missing ${name} link`); continue; }
  if (href.startsWith('/')) errors.push(`${name} href is root-absolute (${href}) — it 404s on every subpath host`);
  const r = await page.request.get(new globalThis.URL(href, `${URL}?camp=42`).href);
  if (!r.ok()) errors.push(`${name} ${href} -> ${r.status()}`);
}
console.log(`pwa ${JSON.stringify(pwa)}`);

const boot = await page.evaluate(() => {
  const g = window.__game;
  const f = g.front;
  const red = f.chits.filter((c) => c.side === 'red' && c.strength > 0).sort((a, b) => b.strength - a.strength || a.id - b.id)[0];
  const blue = f.chits.filter((c) => c.side === 'blue' && c.strength > 0)[0];
  g.startEngagementBattle({ attackerId: blue.id, defenderId: red.id, cell: red.cell });
  return { day: f.day, chits: f.chits.length };
});
await page.waitForTimeout(1500);
await page.keyboard.press('Space');
await page.waitForTimeout(2000);

const battle = await page.evaluate(() => ({
  tick: window.__game.sim.tick,
  soldiers: window.__game.sim.soldiers.length,
  scale: Math.round(window.__game.cam.scale * 100) / 100,
}));
await page.screenshot({ path: '.screenshots/demo/dist-smoke.png' });
console.log(`boot ${JSON.stringify(boot)}  battle ${JSON.stringify(battle)}`);

const bad = [...new Set(errors)];
console.log(bad.length ? `FAIL:\n${bad.join('\n')}` : 'PASS: no console errors, no failed requests, sim advanced');
await browser.close();
process.exit(bad.length || battle.tick === 0 ? 1 : 0);
