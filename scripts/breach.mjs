// Breach inspector — does a hole in a wall READ, and does the game agree?
//
// The destructible-terrain feature is the one place where a render bug is
// indistinguishable from a sim bug by looking at the screen: if the old wall
// keeps drawing, the player has no way to know the sim will walk a squad
// straight through it. So this shoots the two halves together — a before/after
// pair of PNGs, and the sim's own answers to "can a man cross here" and "can
// he see through" on the very edge that was opened.
//
// Every case runs the REAL path: sim.explode() with a breach energy, drained by
// main.ts into Renderer.addBreaches next frame, chunks rebaked by the amortized
// budget. Nothing here reaches into the renderer.
//
// Output: .screenshots/breach/<case>-{before,after}.png + index.html.
//
// Usage: node scripts/breach.mjs [--port 5198] [--seed 10] [--scale 34]
//   Dev server must already be running: npm run dev -- --port 5198 --strictPort
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch, gotoStaged, place } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '10'));
const CAMP = Number(arg('camp', '42'));
const SCALE = Number(arg('scale', '48'));
const OUT = '.screenshots/breach';
mkdirSync(OUT, { recursive: true });

// ECLASS values that name a wall worth blowing, and the energy that opens each
// with margin. The thresholds themselves live in src/sim/map.ts — these are
// deliberately well over them, because this script is asking "does it read",
// not "is the threshold table right" (tests/breach.test.ts asks that).
//
// `wide` is not a parameter: sim.ts derives it from the energy alone
// (BREACH_WIDE_ENERGY = 7), so a garden wall opened by a grenade-scale blast
// keeps its rubble lip and a house wall opened by an AT round does not.
// `direct` writes the edge byte through sim.breachEdge with no blast. Still the
// full render path (pendingBreaches -> takeBreaches -> addBreaches -> stale
// chunks), just without a scorch decal and a roof hole landing on top of the
// art being judged. Those rows are the ART read; the blast rows are the
// INTEGRATION read, and both are needed — a clean drawEdge branch that nothing
// ever calls looks exactly like a working feature in a screenshot.
const CASES = [
  { name: 'art-lip', cls: 'WALL_HIGH', direct: true, wide: false },
  { name: 'art-wide', cls: 'WALL_HIGH', direct: true, wide: true },
  { name: 'art-masonry', cls: 'MASONRY', direct: true, wide: true },
  { name: 'blast-garden-wall', cls: 'WALL_HIGH', energy: 6, radius: 5 },
  { name: 'blast-house-masonry', cls: 'MASONRY', energy: 13, radius: 2.5 },
  { name: 'blast-window', cls: 'WINDOW', energy: 6, radius: 2.5 },
  // THE case D9 exists for. A chunk bakes 2 tiles of its neighbour's ground, so
  // an edge sitting on a 16-tile chunk seam is drawn TWICE, by two different
  // baked canvases. Invalidate only one of them and half the wall survives as a
  // stub floating beside the hole — a bug that is invisible on 15 tiles out of
  // every 16 and unmistakable on the sixteenth.
  { name: 'art-chunk-seam', cls: 'WALL_HIGH', direct: true, wide: false, seam: true },
];
const KEEP_APART = 20; // m between cases, so one burst's 4-edge cap cannot eat the next case's wall

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP, forceKind: 'bourg' });

// One edge of the wanted class, in the middle of a run of its own kind so the
// breach SPLITS a wall rather than nibbling an end — the end case is the easy
// one, and the run split is what re-phases the enclosure coursing. Picked
// FRESH per case against the live map, because each burst opens up to
// BREACH_CAP edges and a stale pick can land on one of them.
const pick = (cls, away, seam = false) =>
  page.evaluate(
    async ({ cls, away, apart, seam }) => {
      const map = window.__game.sim.map;
      const { EDGE, ECLASS, edgeClass } = await import('/src/sim/map.ts');
      const target = ECLASS[cls];
      const at = (x, y, horiz) => (horiz ? map.hEdge(x, y) : map.vEdge(x, y));
      // How far STANDING wall runs either way. A hole in the middle of a long
      // wall is the shot worth taking: the eye reads a gap against continuity,
      // and a 1 m stub of wall with a hole in it reads as nothing at all.
      // Continuity is "any wall still up", not "the same class" — a window sits
      // every third tile of a house wall and never has a window either side of
      // it, so a same-class test finds no window on any map.
      const reach = (x, y, horiz, dir) => {
        let n = 0;
        for (let k = 1; k <= 8; k++) {
          const tx = x + (horiz ? k * dir : 0);
          const ty = y + (horiz ? 0 : k * dir);
          const e = at(tx, ty, horiz);
          if (e === EDGE.NONE || e === EDGE.BREACH) break;
          n++;
        }
        return n;
      };
      let best = null;
      for (let y = 4; y < map.h - 4; y++) {
        for (let x = 4; x < map.w - 4; x++) {
          if (away.some((p) => Math.hypot(p.x - x, p.y - y) < apart)) continue;
          for (const horiz of [true, false]) {
            if (at(x, y, horiz) === EDGE.NONE) continue;
            if (edgeClass(map, x, y, horiz) !== target) continue;
            // CHUNK = 16 in terrain.ts. The seam runs across the edge's own
            // axis, so a vertical edge straddles it at x % 16 === 0.
            if (seam && (horiz ? y : x) % 16 !== 0) continue;
            const back = reach(x, y, horiz, -1);
            const fwd = reach(x, y, horiz, 1);
            if (back < 2 || fwd < 2) continue; // must be a run MIDDLE, not an end
            const score = Math.min(back, fwd) * 10 + back + fwd;
            if (!best || score > best.score) best = { x, y, horiz, score };
            if (score >= 96) return best; // 8 clear either side: good enough, stop scanning
          }
        }
      }
      return best;
    },
    { cls, away, apart: KEEP_APART, seam },
  );

// Tight crop on the wall itself. place() puts it dead centre of the canvas, and
// a full 1280x800 frame is 90% HUD and neighbouring roofs — at which size a
// 1 m hole is a smudge and the whole point of the shot is lost.
const CROP = { w: 460, h: 340 };
const shot = async () => {
  const box = await page.evaluate(() => {
    const c = document.querySelector('canvas').getBoundingClientRect();
    return { x: c.x, y: c.y, w: c.width, h: c.height };
  });
  return Buffer.from(
    await page.screenshot({
      type: 'png',
      clip: { x: box.x + box.w / 2 - CROP.w / 2, y: box.y + box.h / 2 - CROP.h / 2, width: CROP.w, height: CROP.h },
    }),
  );
};

const rows = [];
const used = [];
let failures = 0;
for (const c of CASES) {
  const e = await pick(c.cls, used, c.seam);
  if (!e) {
    console.error(`  MISSING: no ${c.cls} edge with two wall neighbours on seed ${SEED} — nothing to blow`);
    failures++;
    continue;
  }
  used.push({ x: e.x, y: e.y });
  const mx = e.horiz ? e.x + 0.5 : e.x;
  const my = e.horiz ? e.y : e.y + 0.5;
  await place(page, mx, my, SCALE);
  writeFileSync(join(OUT, `${c.name}-before.png`), await shot());

  // The sim's own answers, on the two tiles the edge separates.
  const probe = () =>
    page.evaluate(
      async ({ x, y, horiz }) => {
        const map = window.__game.sim.map;
        const { los } = await import('/src/sim/map.ts');
        const a = horiz ? [x, y - 1] : [x - 1, y];
        const b = horiz ? [x, y] : [x, y];
        return {
          foot: map.canStep(a[0], a[1], b[0], b[1], 'foot'),
          vehicle: map.canStep(a[0], a[1], b[0], b[1], 'vehicle'),
          sight: los(map, a[0] + 0.5, a[1] + 0.5, b[0] + 0.5, b[1] + 0.5, 0, 0).visible,
          edge: horiz ? map.hEdge(x, y) : map.vEdge(x, y),
          top: horiz ? map.hEdgeTop(x, y) : map.vEdgeTop(x, y),
          // canStep rejects on the DESTINATION TILE before it ever looks at the
          // edge, so a breach into water or a hedgerow bank stays blocked and
          // that is correct, not a bug. Reported so the row cannot be misread.
          terrain: `${map.terrainKeyAt(a[0], a[1])}->${map.terrainKeyAt(b[0], b[1])}`,
        };
      },
      e,
    );

  const before = await probe();
  await page.evaluate(
    ({ e, c, mx, my }) => {
      const sim = window.__game.sim;
      if (c.direct) {
        // `private` is a compile-time fiction; this is the same call the blast
        // scan makes, minus the blast. ECLASS is passed through as `cls` only
        // for the event record — the byte written is BREACH either way.
        sim.breachEdge(e.horiz, e.x, e.y, 0, c.wide, 'blast');
        return;
      }
      // Burst on the near face, half a metre off the wall, so the crater and
      // the scorch land BESIDE the opening rather than over the art.
      const bx = mx + (e.horiz ? 0 : -0.6);
      const by = my + (e.horiz ? -0.6 : 0);
      sim.explode(bx, by, { suppRadius: c.radius, fragRadius: c.radius, frags: 0, dmg: [0, 0], breach: c.energy, kind: 'shell' }, 0);
    },
    { e, c, mx, my },
  );
  // Let the drain run, the chunks rebake through the per-frame budget, and the
  // blast FX expire — what is left on screen is the permanent art.
  await page.waitForTimeout(c.direct ? 1600 : 3200);
  const settle = await place(page, mx, my, SCALE);
  writeFileSync(join(OUT, `${c.name}-after.png`), await shot());
  const after = await probe();

  const opened = after.edge !== before.edge;
  const note = [];
  if (!opened) note.push('EDGE DID NOT OPEN');
  if (opened && !after.foot) note.push('still blocks foot');
  if (opened && before.sight && after.sight) note.push('sight unchanged (was already open)');
  if (!settle.quiesced) note.push('never went still');
  if (note.includes('EDGE DID NOT OPEN')) failures++;
  console.log(
    `${c.name.padEnd(18)} (${e.x},${e.y})${e.horiz ? 'h' : 'v'}  edge ${before.edge}->${after.edge} top ${before.top}->${after.top}  ` +
      `foot ${before.foot}->${after.foot}  vehicle ${before.vehicle}->${after.vehicle}  ` +
      `sight ${before.sight}->${after.sight}  [${after.terrain}]  ${note.join('; ')}`,
  );
  rows.push({ ...c, e, before, after, note });
}

const cell = (f) => `<td><img src="${f}"><div class="cap">${f}</div></td>`;
writeFileSync(
  join(OUT, 'index.html'),
  `<meta charset=utf-8><title>breach — seed ${SEED} (${kind})</title>
<style>body{background:#141414;color:#ddd;font:12px system-ui;margin:16px}
img{width:460px;image-rendering:pixelated;display:block;border:1px solid #333}td{padding:6px;vertical-align:top}
.cap{color:#888;padding-top:3px}h2{font-size:14px;margin:18px 0 4px}
.bad{color:#e88}</style>
<h1>breach — seed ${SEED}, ${kind}, ${SCALE} px/m</h1>
${rows
  .map(
    (r) => `<h2>${r.name} — ${r.cls}, ${r.direct ? `direct ${r.wide ? 'wide' : 'lip'}` : `blast ${r.energy}`} @ (${r.e.x},${r.e.y}) ${r.e.horiz ? 'h' : 'v'}
  <span class="${r.note.length ? 'bad' : ''}">foot ${r.before.foot}&rarr;${r.after.foot} · vehicle ${r.before.vehicle}&rarr;${r.after.vehicle} · sight ${r.before.sight}&rarr;${r.after.sight} ${r.note.join('; ')}</span></h2>
<table><tr>${cell(`${r.name}-before.png`)}${cell(`${r.name}-after.png`)}</tr></table>`,
  )
  .join('\n')}`,
);

await browser.close();
console.log(`\n${OUT}/index.html`);
if (failures) {
  console.error(`${failures} case(s) failed to open an edge`);
  process.exit(1);
}
