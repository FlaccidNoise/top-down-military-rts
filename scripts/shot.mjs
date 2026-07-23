// Visual inspector — one shell command to jump to any game state and look.
//
// Built for any agent with only shell + browser (Claude Code or the pi
// harness): boots a pinned, paused, deterministic battle, moves to the state
// you name, and writes a PNG (path printed to stdout) or a JSON state dump.
//
// Dev server must be running: npm run dev -- --port 5198 --strictPort
//
// Examples:
//   node scripts/shot.mjs --seed 7 --preset village          # a named scene
//   node scripts/shot.mjs --seed 7 --at 160,120 --scale 24   # any tile @ px/m
//   node scripts/shot.mjs --seed 7 --map                     # whole map, far-LOD
//   node scripts/shot.mjs --seed 7 --effect boom             # stage a VFX, best frame
//   node scripts/shot.mjs --seed 7 --dump                    # JSON state → stdout
//   node scripts/shot.mjs --list                             # presets + effects
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets, place, burst } from './lib/stage.mjs';

const has = (name) => process.argv.includes(`--${name}`);
const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const CAMP = Number(arg('camp', '42'));
const FOW = Number(arg('fow', '0'));
const FORCE = arg('force', null); // bridge|river|... to force the defended cell's terrain
const OUT = arg('out', '.screenshots/shot.png');
const MAP_W = 320;
const MAP_H = 240;
const PRESETS = ['village', 'woods', 'hamlet', 'farm', 'bocage', 'units', 'enemy', 'farlod', 'bridge'];
const EFFECTS = {
  muzzle: { trigger: { type: 'shot', hit: true, kill: false }, dur: 120, buckets: 3 },
  tracer: { trigger: { type: 'shot', hit: true, kill: false }, dur: 340, buckets: 6 },
  kill: { trigger: { type: 'shot', hit: true, kill: true }, dur: 340, buckets: 6 },
  miss: { trigger: { type: 'shot', hit: false, kill: false }, dur: 120, buckets: 3 },
  boom: { trigger: { type: 'boom' }, dur: 2000, buckets: 8 },
};

if (has('list')) {
  console.log(`presets: ${PRESETS.join(', ')}`);
  console.log(`effects: ${Object.keys(EFFECTS).join(', ')}`);
  process.exit(0);
}

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP, fow: FOW, forceKind: FORCE });

if (has('dump')) {
  const state = await page.evaluate(() => {
    const g = window.__game;
    const sim = g.sim;
    const front = g.front;
    const count = (side, pred) => sim.soldiers.filter((s) => s.side === side && pred(s)).length;
    const per = (side) => ({ alive: count(side, (s) => s.alive), downed: count(side, (s) => s.alive && s.downed), dead: count(side, (s) => !s.alive) });
    return {
      tick: sim.tick,
      winner: sim.winner ?? null,
      cam: { x: +g.cam.x.toFixed(1), y: +g.cam.y.toFixed(1), scale: +g.cam.scale.toFixed(2) },
      blue: per('blue'),
      red: per('red'),
      squads: sim.squads.length,
      vehicles: sim.vehicles.map((v) => ({ side: v.side, kind: v.kind, alive: v.alive })),
      smoke: sim.smoke.length,
      chits: front.chits.filter((c) => c.strength > 0).map((c) => ({ side: c.side, cell: c.cell, strength: c.strength })),
    };
  });
  console.log(JSON.stringify(state, null, 2));
  await browser.close();
  process.exit(0);
}

const targets = await deriveTargets(page, { seed: SEED, kind });
mkdirSync(dirname(OUT), { recursive: true });

if (has('effect')) {
  const name = arg('effect', 'boom');
  const e = EFFECTS[name];
  if (!e) throw new Error(`unknown effect "${name}" — one of: ${Object.keys(EFFECTS).join(', ')}`);
  const anchor = targets.units;
  const frames = await burst(page, { x: anchor.x, y: anchor.y, scale: Number(arg('scale', '40')), trigger: e.trigger, dur: e.dur, buckets: e.buckets });
  const best = frames.reduce((a, f) => (f.score > a.score ? f : a), { score: -1 });
  writeFileSync(OUT, Buffer.from(best.dataUrl.split(',')[1], 'base64'));
  console.log(`${OUT}  (effect ${name}, best frame ${best.ageMs}ms, ${best.score} changed-px)`);
  await browser.close();
  process.exit(0);
}

let x;
let y;
let scale;
if (has('map')) {
  [x, y, scale] = [MAP_W / 2, MAP_H / 2, Math.min(1280 / MAP_W, 800 / MAP_H)];
} else if (has('at')) {
  [x, y] = arg('at', '160,120').split(',').map(Number);
  scale = Number(arg('scale', '24'));
} else {
  const t = targets[arg('preset', 'units')];
  if (!t) throw new Error(`unknown preset "${arg('preset')}" — one of: ${PRESETS.join(', ')}`);
  ({ x, y, scale } = t);
}
await place(page, x, y, scale);
await page.screenshot({ path: OUT });
console.log(`${OUT}  (seed ${SEED}, x=${x.toFixed(1)} y=${y.toFixed(1)} @ ${scale.toFixed(2)}px/m, terrain=${kind})`);
await browser.close();
