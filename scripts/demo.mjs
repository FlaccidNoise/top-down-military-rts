// Demo rehearsal — walks the pinned CEO demo path end to end through the real
// UI (real clicks and keys, not __game shortcuts, so what it captures is what a
// viewer sees) and writes a numbered PNG per beat to .screenshots/demo/.
//
// Dev server must be running: npm run dev -- --port 5198 --strictPort
// Usage: node scripts/demo.mjs [--port 5198] [--camp 42]
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, arg } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const CAMP = Number(arg('camp', '42'));
const DIR = '.screenshots/demo';
mkdirSync(DIR, { recursive: true });

const { browser, page } = await launch();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

let n = 0;
const shot = async (name) => {
  const path = `${DIR}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path });
  console.log(`  shot ${path}`);
};
const state = () =>
  page.evaluate(() => {
    const g = window.__game;
    const s = g.sim;
    return {
      mode: document.getElementById('debrief')?.style.display === 'flex' ? 'debrief' : s ? 'battle' : 'strategic',
      day: g.front?.day,
      soldiers: s ? s.soldiers.filter((x) => x.alive && !x.downed).length : null,
      blue: s ? s.soldiers.filter((x) => x.alive && !x.downed && x.side === 'blue').length : null,
      red: s ? s.soldiers.filter((x) => x.alive && !x.downed && x.side === 'red').length : null,
      winner: s?.winner ?? null,
      tick: s?.tick ?? null,
    };
  });

console.log(`demo camp=${CAMP} port=${PORT}`);
await page.goto(`http://[::1]:${PORT}/?camp=${CAMP}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => '__game' in window, null, { timeout: 5000 });
await page.waitForTimeout(600);

// Beat 1: the strategic front, exactly as it boots.
await shot('boot-strategic');
console.log(`  state ${JSON.stringify(await state())}`);

// Beat 2: stage the engagement the demo fights. Pick the strongest red chit
// and the nearest blue attacker (same rule the art harness uses), then start
// that battle through the real entry point.
const staged = await page.evaluate(() => {
  const g = window.__game;
  const f = g.front;
  const sw = f.sector.w;
  const reds = f.chits.filter((c) => c.side === 'red' && c.strength > 0).sort((a, b) => b.strength - a.strength || a.id - b.id);
  const def = reds[0];
  const at = (c) => ({ x: c.cell % sw, y: (c.cell / sw) | 0 });
  const atk = f.chits
    .filter((c) => c.side === 'blue' && c.strength > 0)
    .sort((a, b) => {
      const d = (c) => Math.abs(at(c).x - at(def).x) + Math.abs(at(c).y - at(def).y);
      return d(a) - d(b) || a.id - b.id;
    })[0];
  g.startEngagementBattle({ attackerId: atk.id, defenderId: def.id, cell: def.cell });
  return { attacker: atk.name, defender: def.name, terrain: f.sector.cells[def.cell].terrain };
});
console.log(`  staged ${JSON.stringify(staged)}`);
await page.waitForTimeout(900);
await shot('battle-boot-camera-paused');
console.log(`  state ${JSON.stringify(await state())}`);

// Does the boot camera actually show the blue force, or is it under the
// roster panel? (documented risk — measured here, not eyeballed)
const framing = await page.evaluate(() => {
  const g = window.__game;
  const cam = g.cam;
  const cw = innerWidth;
  const ch = innerHeight;
  const blue = g.sim.soldiers.filter((s) => s.alive && s.side === 'blue');
  const panels = [...document.querySelectorAll('#squads, #topbar, #obj-strip, #hint')].map((e) => ({
    id: e.id,
    r: e.getBoundingClientRect(),
  }));
  let onScreen = 0;
  const occluded = {};
  for (const s of blue) {
    const [x, y] = cam.worldToScreen(s.x, s.y, cw, ch);
    if (x < 0 || y < 0 || x > cw || y > ch) continue;
    onScreen++;
    for (const p of panels)
      if (x >= p.r.left && x <= p.r.right && y >= p.r.top && y <= p.r.bottom) occluded[p.id] = (occluded[p.id] || 0) + 1;
  }
  return {
    blue: blue.length,
    onScreen,
    occluded,
    scale: Math.round(cam.scale * 100) / 100,
    panels: panels.map((p) => `${p.id}:${Math.round(p.r.left)},${Math.round(p.r.top)} ${Math.round(p.r.width)}x${Math.round(p.r.height)}`),
  };
});
console.log(`  framing ${JSON.stringify(framing)}`);

// Unpause with the real key the viewer would press.
await page.keyboard.press('Space');
await page.waitForTimeout(1200);
console.log(`  after-unpause ${JSON.stringify(await state())}`);
await shot('battle-running');

// Beat 3: the order burst — select every squad and move the company forward.
// This is the moment that used to freeze for a quarter second.
const burst = await page.evaluate(async () => {
  const g = window.__game;
  const s = g.sim;
  const objective = s.map ? null : null;
  const blueSquads = s.squads.filter((q) => q.side === 'blue');
  const far = { x: s.map.w * 0.72, y: s.map.h * 0.5 };
  const t0 = performance.now();
  for (const q of blueSquads) s.orderSquad(q.id, { kind: 'move', x: far.x, y: far.y });
  return { ms: Math.round(performance.now() - t0), squads: blueSquads.length, far };
});
console.log(`  order-burst-in-page ${JSON.stringify(burst)}`);
await page.waitForTimeout(1500);
await shot('company-advancing');

// Beat 4: let the firefight develop.
await page.waitForTimeout(12000);
await shot('firefight');
console.log(`  state ${JSON.stringify(await state())}`);

// Beat 5: run to a decision, then the debrief the viewer actually reads.
for (let i = 0; i < 40; i++) {
  const st = await state();
  if (st.winner || st.mode === 'debrief') break;
  await page.waitForTimeout(3000);
}
await shot('late-battle');
console.log(`  state ${JSON.stringify(await state())}`);

const ended = await page.evaluate(() => !!window.__game.sim?.winner);
if (ended) {
  await page.waitForTimeout(4000);
  await shot('debrief');
  console.log(`  state ${JSON.stringify(await state())}`);
}

console.log(errors.length ? `ERRORS:\n${[...new Set(errors)].join('\n')}` : 'no page errors');
writeFileSync(`${DIR}/errors.txt`, [...new Set(errors)].join('\n'));
await browser.close();
