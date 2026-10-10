// The frame-budget gate, in two parts.
//
// MORALE: what one transient FX family costs renderer.draw() on a full
// 250-soldier scene. Read `delta` — ms added per frame with the effect at its
// concurrency cap, against a 16.7 ms budget. `legibility` is the same
// changed-pixel metric vfx.mjs scores bursts with (its own bar is 40): a
// transient nobody can see is not cheap, it is missing.
//
// WHOLE FRAME: renderer.draw() idle against a heavy combat load, on two views
// (the squad in its field, the town centre) at the two zooms the game is
// played at. This is the table to record before and after any FX change. The
// load is fixed, so two runs compare: 12 blasts of every kind at staggered
// ages, 60 shots of which 20 are MG bursts, 10 morale crossings (pinned,
// rallied and ambush), one brewed-up tank, and whatever buildings those blasts
// set alight.
//
//   node scripts/fxcost.mjs --port 5271 [--seed 9] [--scale 24] [--n 400]
//                           [--device phone] [--hour night] [--frames 150]
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
//
// A FRESH PAGE PER SCENE. Enough getImageData calls on one canvas and Chrome
// demotes it to software raster for the rest of the page's life: a phone run
// went from 5 ms to 130 ms a frame after ~1,500 readbacks, and a new page
// measured 3.6 ms on the same view. One scene per page keeps every row under
// that, and keeps one scene's scorch decals and roof holes out of the next.
import { arg, launch, gotoStaged, deriveTargets, place, hourMin } from './lib/stage.mjs';

const PORT = Number(arg('port', '5271'));
const SEED = Number(arg('seed', '9'));
const SCALE = Number(arg('scale', '24'));
const N = Number(arg('n', '400'));
const DEVICE = arg('device', 'desktop');
const HOUR = hourMin(arg('hour', null));
const FRAMES = Number(arg('frames', '150'));

const { browser, page } = await launch({ device: DEVICE });
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: 42, hour: HOUR });
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

// --- whole frame -------------------------------------------------------------
// The renderer's transient stores. The idle arm empties them for one draw and
// puts them back, so both arms draw the same terrain, men and decals. A store
// this build does not have is skipped. Add a new one here when you add it to
// the renderer, or its cost lands in BOTH arms and the delta hides it. The
// fires, the firing positions and the pall are not plain arrays and are
// stashed by hand in the loop below.
const STORES = ['booms', 'tracers', 'moraleFx', 'breaches', 'meleeFx', 'birds', 'hits'];

async function wholeFrame(view, scale) {
  const { browser, page } = await launch({ device: DEVICE });
  const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: 42, hour: HOUR });
  const targets = await deriveTargets(page, { seed: SEED, kind });
  const at = view === 'field' ? targets.units : (targets.place ?? targets.village);
  const r = await page.evaluate(
    ({ x, y, scale, n, stores }) => {
      const g = window.__game;
      const R = g.renderer;
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      g.cam.x = x;
      g.cam.y = y;
      g.cam.scale = scale;
      const T = 500000;
      const draw = (now) => {
        const t0 = performance.now();
        R.draw(ctx, g.cam, [], now);
        ctx.getImageData(0, 0, 1, 1); // force the flush before stopping the clock
        return performance.now() - t0;
      };
      // Terrain chunks bake on a per-frame budget: draw until the view is warm.
      for (let i = 0; i < 80; i++) draw(T);

      // kind and frag radius as sim.ts sends them; a brew-up has no radius
      const KINDS = [
        ['grenade', 3],
        ['mortar', 5],
        ['shell', 9],
        ['at', 3],
        ['bomb', 5],
        ['brewup', undefined],
      ];
      for (let i = 0; i < 12; i++) {
        const [kind, r] = KINDS[i % KINDS.length];
        R.addBooms([{ x: x + ((i % 4) - 1.5) * 5, y: y + (((i / 4) | 0) - 1) * 5, kind, ...(r === undefined ? {} : { r }) }], T - i * 180);
      }
      // Real ids on the shots, so the firer's kick, the victim's jerk and the
      // blood off a hit are all in the load.
      const men = g.sim.soldiers.filter((s) => s.alive);
      for (let i = 0; i < 60; i++) {
        const a = i * 0.7;
        R.addEvents(
          [{ fx: x + Math.cos(a) * 8, fy: y + Math.sin(a) * 8, tx: x - Math.cos(a) * 9, ty: y - Math.sin(a) * 9, hit: i % 3 === 0, kill: i % 9 === 0, weapon: i % 3 === 0 ? 'mg42' : 'garand', shooterId: men[i % men.length].id, targetId: men[(i * 7 + 3) % men.length].id }],
          T - (i % 6) * 40
        );
      }
      // all three crossings: the sim emits 'rallied' for real now, about 34 a battle
      for (let i = 0; i < 10; i++) R.addUnitEvents([{ kind: ['pinned', 'rallied', 'ambush'][i % 3], x: x + i - 5, y: y + 2, side: 'blue', name: 'x' }], T - 100);
      const wreck = g.sim.addVehicle('red', 'panzer4', x + 7, y + 6, 0.6);
      wreck.alive = false;
      wreck.burning = true;
      for (let i = 0; i < 10; i++) draw(T); // the fx atlas and the wreck sprite bake on first use

      const heavy = [];
      const idle = [];
      const live = Object.fromEntries(stores.filter((k) => R[k]).map((k) => [k, R[k].length]));
      live.fires = R.fires.size;
      live.pall = R.pall.puffs.length;
      live.firing = R.firing.size;
      for (let i = 0; i < n; i++) {
        heavy.push(draw(T));
        const held = stores.filter((k) => R[k]).map((k) => [k, R[k]]);
        for (const [k] of held) R[k] = [];
        const fires = R.fires;
        R.fires = new Map();
        const firing = R.firing;
        R.firing = new Map();
        const pall = R.pall.puffs.splice(0);
        wreck.burning = false;
        idle.push(draw(T));
        for (const [k, v] of held) R[k] = v;
        R.fires = fires;
        R.firing = firing;
        R.pall.puffs.push(...pall);
        wreck.burning = true;
      }
      // A trimmed mean, not the mean: other sessions share this machine, and
      // a few preempted draws in 150 moved a plain mean by tenths of a
      // millisecond. Dropping the slowest tenth keeps the sub-0.1 ms
      // resolution a median would lose to the clock's quantization.
      const trim = (a) => {
        a.sort((p, q) => p - q);
        const keep = Math.ceil(a.length * 0.9);
        let s = 0;
        for (let i = 0; i < keep; i++) s += a[i];
        return s / keep;
      };
      return { idle: trim(idle), heavy: trim(heavy), max: heavy[heavy.length - 1], live, mpx: (canvas.width * canvas.height) / 1e6 };
    },
    { x: at.x, y: at.y, scale, n: FRAMES, stores: STORES }
  );
  await browser.close();
  return r;
}

console.log(`\nwhole frame: ${DEVICE}${HOUR === null ? '' : `, hour ${arg('hour')}`}, seed ${SEED}, n=${FRAMES} interleaved pairs, renderer.draw() only`);
console.log('view   px/m   idle ms  heavy ms   delta   max ms   live      (idle, heavy: mean of the fastest 90%)');
for (const view of ['field', 'town']) {
  for (const scale of [14, 24]) {
    const w = await wholeFrame(view, scale);
    const live = Object.entries(w.live).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`${view.padEnd(6)} ${String(scale).padStart(4)}  ${w.idle.toFixed(2).padStart(8)}  ${w.heavy.toFixed(2).padStart(8)}  ${(w.heavy - w.idle).toFixed(2).padStart(6)}  ${w.max.toFixed(1).padStart(7)}   ${live} (${w.mpx.toFixed(2)} Mpx)`);
  }
}
