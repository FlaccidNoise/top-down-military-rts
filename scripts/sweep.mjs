// Seed-sweep screenshot harness — the regression gate for all art work.
//
// Captures a fixed grid of crops (village, woods, hamlet, farm, bocage,
// units, far-LOD, + bridge/river water) across N seeds against a PINNED
// campaign (?camp= disables saving, so runs never touch a real save).
// Scenes are static: battle boots paused and the sim is never stepped, so
// no winner → no debrief race, and pixels are deterministic (all art noise
// flows through the shared render hash).
//
// Staging + target derivation live in ./lib/stage.mjs (shared with vfx.mjs and
// shot.mjs) so every tool jumps to a scene the same way.
//
// Usage: node scripts/sweep.mjs [--port 5198] [--seeds 1,2,3]
//   Dev server must already be running: npm run dev -- --port 5198 --strictPort
//   Output: .screenshots/sweep/s<seed>-<crop>.png + index.html contact sheet
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, launch, gotoStaged, deriveTargets, place, stageEmplacements, stageVehicles, stagedHour, fmtHour } from './lib/stage.mjs';

const PORT = Number(arg('port', '5198'));
const SEEDS = arg('seeds', '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
const CAMP = 42; // pinned campaign — fixed chit layout across runs
// Water art never shows up unless a red chit happens to sit on a river cell,
// so two sweep slots force the defender's cell terrain before carving. 'bourg'
// is forced so the art gate covers a KNOWN bourg seed regardless of where the
// pinned campaign's chits sit (T16 landed: campaign town cells stage bourg).
const FORCE_KIND = { 3: 'bridge', 8: 'river', 10: 'bourg' };
// `soldiers48` is the close-inspection unit crop: kit, webbing and helmet
// detail only exist at band 48, so the 32 px/m `units` crop cannot regress it.
// `vehicles` is ALWAYS last — staging it spawns five hulls into the live sim,
// which would photobomb every crop shot after it.
const ORDER = ['farlod', 'village', 'woods', 'hamlet', 'farm', 'bocage', 'units', 'enemy', 'soldiers48'];
// §5.6's crop set, derived from objectiveKinds rather than objective indices —
// see deriveTargets. `terrace` is not in the doc's list and is the most
// valuable crop of the six: a party-wall high street coming out thatched
// (roofs.ts smallOfPair) is invisible in every other frame.
const BOURG_ORDER = ['farlod', 'place', 'church', 'terrace', 'street', 'cour', 'bocage', 'units', 'enemy'];
const OUT = '.screenshots/sweep';

mkdirSync(OUT, { recursive: true });
const { browser, page } = await launch();

// Preflight: the art baselines are only comparable if the profile they were
// shot on has not moved. An accidental DPR bump or a MOBILE flip reshoots
// every crop at once, and a reshot baseline is an invisible regression —
// nothing downstream would ever flag it. Cheap assert, catastrophic miss.
//
// The hour is the third member of that family and the newest: under the solar
// model (src/sim/solar.ts) the campaign's own OP_START_MIN of 06:00 is civil
// twilight, so an unpinned sweep reshoots every crop as a dim blue night frame.
// gotoStaged pins it; this asserts the pin actually took.
{
  await page.goto(`http://[::1]:${PORT}/?camp=${CAMP}&seed=${SEEDS[0]}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window, null, { timeout: 5000 });
  const p = await page.evaluate(() => ({ dpr: window.__game.view.dpr, mobile: document.documentElement.classList.contains('mobile') }));
  if (p.dpr !== 1) throw new Error(`sweep preflight: view.dpr is ${p.dpr}, expected 1 — the baselines are 1280x800 @ dpr 1`);
  if (p.mobile) throw new Error('sweep preflight: html.mobile is set — the phone layout would reshoot every art baseline');
  await gotoStaged(page, { port: PORT, seed: SEEDS[0], camp: CAMP });
  const h = await stagedHour(page);
  if (h.clockMin !== h.canon)
    throw new Error(
      `sweep preflight: staged clock is ${fmtHour(h.clockMin)}, expected the canonical ${fmtHour(h.canon)} — every baseline would reshoot under a different sun. Check the hour pin in scripts/lib/stage.mjs gotoStaged.`
    );
  console.log(`preflight ok — 1280x800 @ dpr 1, staged at ${fmtHour(h.canon)} (solar noon)`);
}

const shots = []; // {seed, crop, file}
for (const seed of SEEDS) {
  console.log(`seed ${seed}${FORCE_KIND[seed] ? ` (${FORCE_KIND[seed]})` : ''}`);
  const kind = await gotoStaged(page, { port: PORT, seed, camp: CAMP, forceKind: FORCE_KIND[seed] });
  const targets = await deriveTargets(page, { seed, kind });
  const order = kind === 'bourg' ? BOURG_ORDER : [...(targets.bridge ? [...ORDER, 'bridge'] : ORDER), 'vehicles'];
  for (const name of order) {
    const t = name === 'vehicles' ? await stageVehicles(page, targets.units) : targets[name];
    await place(page, t.x, t.y, t.scale);
    const file = `s${seed}-${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    shots.push({ seed, crop: name, file });
  }
  // Guns last, always: staging emplacements spawns crew squads into the live
  // sim, so any crop shot after it would be comparing a different battle.
  const gt = await stageEmplacements(page, targets.units);
  await place(page, gt.x, gt.y, gt.scale);
  const gfile = `s${seed}-guns.png`;
  await page.screenshot({ path: join(OUT, gfile) });
  shots.push({ seed, crop: 'guns', file: gfile });
}

// Dawn/night rows (N13): the two hours that catch what the canonical grid
// cannot — 07:00 (lenMul at the 3x clamp, 36%-alpha shadows on a 65-degree
// azimuth: the crop that exposes a bad clamp or a stale terrain fallback())
// and 02:00 (the ambient grade, and the ABSENCE of the whole cast pass).
// Two seeds x two crops per hour, appended as NEW rows so not one existing
// baseline moves; deliberately not fanned across all ten seeds — the contact
// sheet is already 10x11 and the marginal information is near zero (§8).
// (The old known-issue here — dawn post shadows clipping at the 1.4 m
// prop:post stamp edge — is gone: the stamp is 5.2 m with the post centred
// and the throw clamps to light.ts SHADOW_LEN_LEGIBLE.)
const HOURS = [
  { label: 'dawn', min: 7 * 60 },
  { label: 'night', min: 2 * 60 },
];
// Seed 3 (bridge-forced) is the sweep's one legacy village map — every
// unforced campaign seed carves a bourg now — and seed 10 is the forced
// bourg, so the pair covers both building arts' casts plus units on each.
const HOUR_SEEDS = [3, 10];
for (const { label, min } of HOURS) {
  for (const seed of HOUR_SEEDS) {
    console.log(`seed ${seed} @ ${label}`);
    const kind = await gotoStaged(page, { port: PORT, seed, camp: CAMP, forceKind: FORCE_KIND[seed], hour: min });
    const targets = await deriveTargets(page, { seed, kind });
    for (const name of [kind === 'bourg' ? 'place' : 'village', 'units']) {
      const t = targets[name];
      await place(page, t.x, t.y, t.scale);
      const file = `s${seed}-${label}-${name}.png`;
      await page.screenshot({ path: join(OUT, file) });
      shots.push({ seed: `${seed}-${label}`, crop: name, file });
    }
  }
}
await browser.close();

// contact sheet: rows = seeds (then the dawn/night rows), cols = crops
const cols = [...new Set(shots.map((s) => s.crop))];
const rowKeys = [...new Set(shots.map((s) => s.seed))];
const rows = rowKeys.map((seed) => {
  const cells = cols.map((c) => {
    const s = shots.find((x) => x.seed === seed && x.crop === c);
    return s ? `<td><a href="${s.file}"><img src="${s.file}" loading="lazy"></a></td>` : '<td></td>';
  });
  return `<tr><th>s${seed}</th>${cells.join('')}</tr>`;
});
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html><title>seed sweep</title><style>
  body{background:#222;color:#ddd;font:12px monospace}img{width:240px;display:block}
  td,th{padding:2px}th{position:sticky;left:0;background:#222}a{color:#7bf}
  </style><p><a href="../vfx/index.html">→ dynamic VFX gate</a> · static art sweep</p>
  <table><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.join('')}</table>`
);
console.log(`${shots.length} shots → ${OUT}/index.html`);
