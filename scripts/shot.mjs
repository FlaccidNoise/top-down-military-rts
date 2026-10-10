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
//   node scripts/shot.mjs --seed 7 --preset place --hour dawn  # the same scene at 07:00
//   node scripts/shot.mjs --seed 7 --dump                    # JSON state → stdout
//   node scripts/shot.mjs --list                             # presets + effects
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets, deriveBuilding, wallStage, place, burst, ageFx, FX_FLUSH_MS, stageEmplacements, stageMorale, stageMoraleFx, stageSmoke, stageVehicles, hourMin, fmtHour, HOUR_PRESETS, stagedHour } from './lib/stage.mjs';

const has = (name) => process.argv.includes(`--${name}`);
const PORT = Number(arg('port', '5198'));
const SEED = Number(arg('seed', '7'));
const CAMP = Number(arg('camp', '42'));
const FOW = Number(arg('fow', '0'));
const FORCE = arg('force', null); // bridge|river|... to force the defended cell's terrain
// --hour dawn|dusk|night|HHMM moves the sun (src/sim/solar.ts). Omitted, every
// scene stages at the canonical hour, which is what the art gate shoots — so a
// shot taken without --hour is directly comparable to a sweep baseline.
const HOUR = hourMin(arg('hour', null));
// Cosmetic clocks (hearth glow, the pinned-morale ring pulse) are pinned by
// default so a shot is comparable to a sweep baseline. --flicker 1 unpins them,
// which is how you prove an animated tell actually animates: shoot twice.
const FLICKER = Number(arg('flicker', '0'));
const OUT = arg('out', '.screenshots/shot.png');
const MAP_W = 320;
const MAP_H = 240;
const PRESETS = ['village', 'woods', 'hamlet', 'farm', 'bocage', 'units', 'enemy', 'soldiers48', 'vehicles', 'guns', 'morale', 'farlod', 'bridge'];
// `anchor: 'wall'|'building'` stages against the masonry nearest the village
// instead of the blue squad; `hold` swaps the burst for a plain screenshot
// after N ms, which is how a sim-tick-lived effect (a building fire) is shot.
const EFFECTS = {
  muzzle: { trigger: { type: 'shot', hit: true, kill: false }, dur: 120, buckets: 3 },
  mg: { trigger: { type: 'shot', hit: true, kill: false, weapon: 'mg42' }, dur: 140, buckets: 4 },
  bazooka: { trigger: { type: 'shot', hit: true, kill: false, weapon: 'bazooka' }, dur: 400, buckets: 4 },
  cannon: { trigger: { type: 'shot', hit: true, kill: false, weapon: 'pak40_gun' }, dur: 700, buckets: 4 },
  tracer: { trigger: { type: 'shot', hit: true, kill: false }, dur: 340, buckets: 6 },
  kill: { trigger: { type: 'shot', hit: true, kill: true }, dur: 340, buckets: 6 },
  miss: { trigger: { type: 'shot', hit: false, kill: false }, dur: 120, buckets: 3 },
  wall: { anchor: 'wall', trigger: { type: 'shot', hit: false, kill: false }, dur: 400, buckets: 4, roiFrac: 0.3 },
  // `boom` is the blast with no kind and no radius; the rest name a recipe
  // (src/render/fx.ts BLAST) at its reference radius.
  boom: { trigger: { type: 'boom' }, dur: 2000, buckets: 8 },
  grenade: { trigger: { type: 'boom', r: 3, kind: 'grenade' }, dur: 2000, buckets: 8 },
  mortar: { trigger: { type: 'boom', r: 9, kind: 'mortar' }, dur: 2600, buckets: 8 },
  barrage: { trigger: { type: 'boom', r: 12, kind: 'shell' }, dur: 2600, buckets: 8 },
  at: { trigger: { type: 'boom', r: 4, kind: 'at' }, dur: 1200, buckets: 8 },
  bomb: { trigger: { type: 'boom', r: 14, kind: 'bomb' }, dur: 3000, buckets: 8 },
  brewup: { trigger: { type: 'boom', r: 6, kind: 'brewup' }, dur: 3000, buckets: 8 },
  fire: { anchor: 'building', trigger: { type: 'boom', r: 6 }, hold: FX_FLUSH_MS, scale: 30 },
  // Sim-owned smoke, not a boom's column: staged at five ages so the plume
  // curve (V11) and the lean the renderer reads off it (V12) are both in one
  // frame. `hold` is short because nothing here animates on wall-clock.
  smoke: { trigger: { type: 'smoke' }, hold: 2500 },
};

if (has('list')) {
  console.log(`presets: ${PRESETS.join(', ')}`);
  console.log(`effects: ${Object.keys(EFFECTS).join(', ')}`);
  console.log(`hours:   ${Object.entries(HOUR_PRESETS).map(([k, v]) => `${k} (${v})`).join(', ')}, or any HHMM — default is the canonical hour the art gate shoots`);
  process.exit(0);
}

const { browser, page } = await launch();
const kind = await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP, fow: FOW, flicker: FLICKER, forceKind: FORCE, hour: HOUR });
const staged = await stagedHour(page);
const at = `${fmtHour(staged.clockMin)}${staged.clockMin === staged.canon ? ' canonical' : ''}`;

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
  // Effects stage over the blue squad cluster by default; --preset puts the
  // same effect anywhere named (a boom in the woods, for the startled birds).
  let anchor = targets[arg('preset', 'units')];
  if (!anchor) throw new Error(`unknown preset "${arg('preset')}" — one of: ${PRESETS.join(', ')}`);
  let trigger = e.trigger;
  if (e.anchor) {
    // `village` only exists in the legacy target set; a bourg map calls the
    // same crop `place`, and the default seed carves a bourg.
    const b = await deriveBuilding(page, targets.village ?? targets.place);
    if (e.anchor === 'wall') {
      const w = wallStage(b);
      anchor = w.anchor;
      trigger = { ...e.trigger, ...w.aim };
    } else anchor = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
  const scale = Number(arg('scale', String(e.scale ?? 40)));
  if (e.hold) {
    // A held effect is one whose subject OUTLIVES the transient that made it —
    // a building fire after the blast, a smoke screen the sim owns. Stage it,
    // wait for the transient to expire, and shoot what is left standing.
    const view = trigger.type === 'smoke' ? await stageSmoke(page, anchor) : { ...anchor, scale };
    await page.evaluate(
      ({ x, y, scale, trigger }) => {
        const g = window.__game;
        g.cam.x = x;
        g.cam.y = y;
        g.cam.scale = scale;
        if (trigger.type !== 'smoke') g.sim.pendingBooms.push({ x, y, r: trigger.r });
      },
      { x: view.x, y: view.y, scale: has('scale') ? scale : (view.scale ?? scale), trigger }
    );
    await ageFx(page, e.hold); // age the blast and its smoke out; what is left is the fire
    await page.screenshot({ path: OUT });
    console.log(`${OUT}  (effect ${name}, ${e.hold}ms after the blast, ${at})`);
    await browser.close();
    process.exit(0);
  }
  const frames = await burst(page, { x: anchor.x, y: anchor.y, scale, trigger, dur: e.dur, buckets: e.buckets, roiFrac: e.roiFrac });
  const best = frames.reduce((a, f) => (f.score > a.score ? f : a), { score: -1 });
  writeFileSync(OUT, Buffer.from(best.dataUrl.split(',')[1], 'base64'));
  console.log(`${OUT}  (effect ${name}, best frame ${best.ageMs}ms, ${best.score} changed-px, ${at})`);
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
} else if (arg('preset', 'units') === 'vehicles') {
  ({ x, y, scale } = await stageVehicles(page, targets.units));
} else if (arg('preset', 'units') === 'guns') {
  ({ x, y, scale } = await stageEmplacements(page, targets.units));
} else if (arg('preset', 'units') === 'morale') {
  // The psych ladder, staged. Shoot it twice with --flicker 1 to watch the
  // pinned ring breathe; the default pin holds it on one frame. --fx swaps the
  // ladder for the three one-shot transition effects at a spread of ages.
  ({ x, y, scale } = await stageMorale(page, targets.units));
  if (has('fx')) {
    await place(page, x, y, scale);
    const url = await stageMoraleFx(page, { x, y });
    writeFileSync(OUT, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`${OUT}  (morale transition FX: pinned/rallied/ambush x ages 40/150/300 ms, ${at})`);
    await browser.close();
    process.exit(0);
  }
} else {
  const t = targets[arg('preset', 'units')];
  if (!t) throw new Error(`unknown preset "${arg('preset')}" — one of: ${PRESETS.join(', ')}`);
  ({ x, y, scale } = t);
}
await place(page, x, y, scale);
await page.screenshot({ path: OUT });
console.log(`${OUT}  (seed ${SEED}, x=${x.toFixed(1)} y=${y.toFixed(1)} @ ${scale.toFixed(2)}px/m, terrain=${kind}, ${at})`);
await browser.close();
