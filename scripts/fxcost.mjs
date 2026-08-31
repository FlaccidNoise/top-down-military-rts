// The frame-budget gate: what one transient FX family costs renderer.draw() on
// a full 250-soldier scene. Read `delta` — ms added per frame with the effect
// at its concurrency cap, against a 16.7 ms budget. `legibility` is the same
// changed-pixel metric vfx.mjs scores bursts with (its own bar is 40): a
// transient nobody can see is not cheap, it is missing.
//
//   node scripts/fxcost.mjs --port 5271 [--seed 9] [--scale 24] [--n 400]
//
// Dev server must be running: npm run dev -- --port 5271 --strictPort
//
// WHY IT MEASURES THE WAY IT DOES. performance.now() is coarsened to 0.1 ms and
// canvas work is GPU-deferred, so a naive timer around one draw reports one
// quantization bucket and nothing else. Three things fix that: a 1 px readback
// after every draw to force a flush, the MEAN of a few hundred draws rather
// than one, and the two arms INTERLEAVED so thermal drift lands on both. Run it
// two or three times — the delta wanders by a few hundredths of a ms and a
// single run is not a number.
//
// The arms are selected by the clock, not by mutating the scene: the renderer
// ages every transient off (now - at), so drawing at `T + 100` keeps a capped
// set alive and drawing far past its lifetime empties it. Same scene, same
// soldiers, same terrain in both arms.
import { arg, launch, gotoStaged, deriveTargets, place } from './lib/stage.mjs';

const PORT = Number(arg('port', '5271'));
const SEED = Number(arg('seed', '9'));
const SCALE = Number(arg('scale', '24'));
const N = Number(arg('n', '400'));

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: 42 });
const targets = await deriveTargets(page, { seed: SEED, kind });
await place(page, targets.units.x, targets.units.y, SCALE);

const r = await page.evaluate(
  ({ n }) => {
    const g = window.__game;
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const T = 200000;
    const grab = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const changed = (a, b) => {
      let c = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) c++;
      return c;
    };
    const arm = (kind, at, count) => {
      for (let i = 0; i < count; i++)
        g.renderer.addUnitEvents([{ kind, x: g.cam.x + (i % 8) - 4, y: g.cam.y + ((i / 8) | 0) - 2, side: 'blue', name: 'x' }], at);
    };
    const drain = () => g.renderer.draw(ctx, g.cam, [], T + 100000); // age everything out

    drain();
    g.renderer.draw(ctx, g.cam, [], T);
    const base = grab();

    const legibility = {};
    for (const k of ['pinned', 'rallied', 'ambush']) {
      legibility[k] = {};
      for (const age of [40, 150, 300]) {
        drain();
        arm(k, T - age, 1);
        g.renderer.draw(ctx, g.cam, [], T);
        legibility[k][age] = changed(base, grab());
      }
    }

    // The cap itself: shove far more crossings in than the renderer will hold.
    drain();
    arm('pinned', T, 40);
    const cap = g.renderer.moraleFx.length;

    let withFx = 0;
    let without = 0;
    for (let i = 0; i < n; i++) {
      if (g.renderer.moraleFx.length === 0) arm('pinned', T, 40);
      for (const [now, live] of [
        [T + 100, true],
        [T + 100000, false],
      ]) {
        const t0 = performance.now();
        g.renderer.draw(ctx, g.cam, [], now);
        ctx.getImageData(0, 0, 1, 1); // force the flush before stopping the clock
        const dt = performance.now() - t0;
        if (live) withFx += dt;
        else without += dt;
      }
    }
    return { soldiers: g.sim.soldiers.length, scale: g.cam.scale, legibility, cap, withFx: withFx / n, without: without / n };
  },
  { n: N }
);
await browser.close();

const f = (v) => v.toFixed(3);
console.log(`scene: ${r.soldiers} soldiers @ ${r.scale} px/m, seed ${SEED}, n=${N} interleaved pairs`);
console.log(`concurrency cap held: ${r.cap} (40 pushed)`);
console.log(`draw: ${f(r.withFx)} ms with FX at cap, ${f(r.without)} ms without, delta ${f(r.withFx - r.without)} ms`);
for (const [k, ages] of Object.entries(r.legibility))
  console.log(`legibility ${k.padEnd(8)} ${Object.entries(ages).map(([a, px]) => `${a}ms:${px}px`).join('  ')}`);
