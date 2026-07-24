// One-off: survey candidate ?camp= seeds for the CEO demo. Prints, per camp,
// the opening front shape (chit counts/strengths, how far blue is from the
// nearest red, the terrain of that contact) so the demo seed is picked on
// evidence rather than on the first one that loaded.
import { launch, arg } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const CAMPS = arg('camps', '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);

const { browser, page } = await launch();
for (const camp of CAMPS) {
  await page.goto(`http://[::1]:${PORT}/?camp=${camp}&fow=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window, null, { timeout: 5000 });
  const info = await page.evaluate(() => {
    const g = window.__game;
    const f = g.front;
    const sw = f.sector.w;
    const at = (c) => ({ x: c.cell % sw, y: (c.cell / sw) | 0 });
    const blue = f.chits.filter((c) => c.side === 'blue' && c.strength > 0);
    const red = f.chits.filter((c) => c.side === 'red' && c.strength > 0);
    let best = null;
    for (const b of blue)
      for (const r of red) {
        const d = Math.abs(at(b).x - at(r).x) + Math.abs(at(b).y - at(r).y);
        if (!best || d < best.d) best = { d, blue: b.name, red: r.name, terrain: f.sector.cells[r.cell].terrain, redStr: r.strength };
      }
    const objectives = f.sector.cells.filter((c) => c.objective).map((c) => c.terrain);
    return {
      blueChits: blue.length,
      redChits: red.length,
      blueStrength: blue.reduce((a, c) => a + c.strength, 0),
      redStrength: red.reduce((a, c) => a + c.strength, 0),
      nearest: best,
      objectiveTerrain: objectives,
      terrainMix: [...new Set(f.sector.cells.map((c) => c.terrain))].sort(),
    };
  });
  console.log(`camp=${camp} ${JSON.stringify(info)}`);
}
await browser.close();
