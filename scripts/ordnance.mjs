// Ordnance gate: every FIRE-type order driven through its real UI path.
//
// The smoke defect this exists to prevent was not a broken sim function — it
// was a UI path that never reached a working one (MOVE_FAMILY gating the armed
// kind), and the sim-level suites were green throughout. So every check here
// clicks the button a player clicks, then asserts on SIM STATE, and the two
// halves must meet. Anything asserted by calling sim.* directly would have
// passed all through the bug.
//
// Usage: npm run dev -- --port P --strictPort  then  node scripts/ordnance.mjs --port P
import { arg, launch, gotoStaged } from './lib/stage.mjs';

const port = Number(arg('port', '5317'));
const seed = Number(arg('seed', '5'));
const fails = [];
const notes = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails.push(what);
};
const note = (what) => { console.log(`  note ${what}`); notes.push(what); };

const { browser, page } = await launch({ device: 'desktop' });
page.on('pageerror', (e) => fails.push(`page error: ${e.message}`));

const kind = await gotoStaged(page, { port, seed, camp: 42, fow: 0, forceKind: 'road' });
console.log(`staged a '${kind}' battle, seed ${seed}\n`);

// Capture booms/shots as the game drains them — the renderer's channel is the
// only place they surface, so wrap it rather than re-deriving explosions.
await page.evaluate(() => {
  const sim = window.__game.sim;
  window.__booms = [];
  window.__shots = [];
  const ob = sim.takeBooms.bind(sim);
  sim.takeBooms = () => { const b = ob(); window.__booms.push(...b); return b; };
  const os = sim.takeEvents.bind(sim); // ShotEvents — the AP round surfaces here
  sim.takeEvents = () => { const s = os(); window.__shots.push(...s); return s; };
  window.__game.setPaused(false);
});

const run = (ms) => page.waitForTimeout(ms);
const clearFx = () => page.evaluate(() => { window.__booms.length = 0; window.__shots.length = 0; });
// Bursts NEAR a called point. Attribution by position matters: a barrage has a
// 20 s time of flight, so an un-attributed count credits whichever fire mission
// happened to be waiting when someone else's rounds arrived.
const boomsNear = (x, y, r = 30) =>
  page.evaluate(({ x, y, r }) => (window.__booms ?? []).filter((b) => Math.hypot(b.x - x, b.y - y) < r).length, { x, y, r });

// A point some blue soldier can actually SEE: indirect fire is gated on
// friendlyHasLos (the shared-vision rule), so calling a mission onto unobserved
// ground is correctly refused and proves nothing about the path.
const observedPoint = (minD, maxD) =>
  page.evaluate(async ({ minD, maxD }) => {
    const { sightBetween } = await import('/src/sim/sim.ts');
    const s = window.__game.sim;
    const eyes = s.soldiers.filter((m) => m.alive && m.side === 'blue' && m.inVehicle < 0);
    for (const m of eyes) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        for (let d = minD; d <= maxD; d += 8) {
          const x = m.x + Math.cos(ang) * d;
          const y = m.y + Math.sin(ang) * d;
          if (x < 4 || y < 4 || x > s.map.w - 4 || y > s.map.h - 4) continue;
          if (!s.map.terrainAt(Math.floor(x), Math.floor(y)).passable) continue;
          if (sightBetween(s, m.x, m.y, x, y, m.level, 0).visible) return { x, y, from: m.id, d };
        }
      }
    }
    return null;
  }, { minD, maxD });

// ── 1-2. Mortar HE mission and smoke mission ────────────────────────────────
const mortar = await page.evaluate(() => {
  const sim = window.__game.sim;
  const e = sim.emplacements.find((m) => m.side === 'blue' && m.state === 'deployed' && ['mortar60', 'mortar81'].includes(m.kind));
  if (!e) return null;
  const [sx, sy] = window.__game.cam.worldToScreen(e.x, e.y, innerWidth, innerHeight);
  return { id: e.id, kind: e.kind, x: e.x, y: e.y, sx: Math.round(sx), sy: Math.round(sy) };
});
check(!!mortar, `a blue mortar is fielded in a campaign battle${mortar ? ` (${mortar.kind})` : ''}`);

if (mortar) {
  await page.mouse.click(mortar.sx, mortar.sy);
  const sel = await page.evaluate((id) => {
    const g = window.__game, s = g.sim, pick = g.getSelection();
    const emp = s.emplacements[id];
    const crewSquad = s.teams[emp.crewTeamId]?.squadId;
    return { squads: pick.squads, crewSquad, isCrew: pick.squads.includes(crewSquad) };
  }, mortar.id);
  check(sel.isCrew, `clicking the mortar selects its crew squad (${sel.squads.join(',')} vs crew ${sel.crewSquad})`);

  // HE mission
  const hasFire = (await page.$('button[data-ctx="fire"]')) !== null;
  check(hasFire, 'the mortar crew panel offers a Fire button');
  if (hasFire) {
    // Re-query at the moment of use: the HUD rebuilds on a sig change, so a
    // held handle goes stale between the check and the click.
    await page.click('button[data-ctx="fire"]');
    check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'empfire', 'Fire arms the empfire target mode');
    const obs = await observedPoint(35, 90);
    check(!!obs, 'a mortar target the company can observe exists (indirect fire is spotter-gated)');
    const tgt = await page.evaluate(({ x, y }) => {
      const [sx, sy] = window.__game.cam.worldToScreen(x, y, innerWidth, innerHeight);
      return { sx: Math.round(sx), sy: Math.round(sy) };
    }, obs);
    await clearFx();
    await page.mouse.click(tgt.sx, tgt.sy);
    const armed = await page.evaluate((id) => {
      const e = window.__game.sim.emplacements[id];
      return { hasTarget: e.hasTarget, tx: e.targetX, ty: e.targetY, mode: window.__game.getSelection().targetMode };
    }, mortar.id);
    check(armed.hasTarget, `the click sets the mortar's fire mission (target ${armed.tx?.toFixed(0)},${armed.ty?.toFixed(0)}, observed from ${obs.d.toFixed(0)} m)`);
    check(armed.mode === '', 'the target cursor clears after the call');
    await run(14000); // cooldown + the shell's 3 s time of flight
    const n = await boomsNear(obs.x, obs.y);
    check(n > 0, `the mortar actually fires: ${n} HE bursts on the called point`);
  }

  // Smoke mission
  const hasSmoke = (await page.$('button[data-ctx="smoke"]')) !== null;
  check(hasSmoke, 'the mortar crew panel offers a Smoke mission button');
  if (hasSmoke) {
    const before = await page.evaluate(() => window.__game.sim.smoke.length);
    await page.click('button[data-ctx="smoke"]');
    check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'empsmoke', 'Smoke mission arms the empsmoke target mode');
    const obs2 = await observedPoint(30, 80);
    const tgt = await page.evaluate(({ x, y }) => {
      const [sx, sy] = window.__game.cam.worldToScreen(x, y, innerWidth, innerHeight);
      return { sx: Math.round(sx), sy: Math.round(sy) };
    }, obs2);
    await page.mouse.click(tgt.sx, tgt.sy);
    const rounds = await page.evaluate((id) => window.__game.sim.emplacements[id].smokeRoundsLeft, mortar.id);
    check(rounds > 0, `the call loads a smoke mission (${rounds} rounds queued)`);
    await run(16000);
    const after = await page.evaluate(() => window.__game.sim.smoke.length);
    check(after > before, `the mortar smoke mission puts a screen up (${before} → ${after} puffs)`);
  }
}

// ── 3. Barrage (artillery) ──────────────────────────────────────────────────
const hasBarrage = (await page.$('button[data-act="barrage"]')) !== null;
check(hasBarrage, 'the HUD offers a barrage button');
if (hasBarrage) {
  const left0 = await page.evaluate(() => window.__game.sim.barragesLeft.blue);
  await page.click('button[data-act="barrage"]');
  check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'barrage', 'the barrage button arms the target cursor');
  const t = await page.evaluate(() => {
    const g = window.__game, s = g.sim;
    const red = s.soldiers.find((m) => m.alive && m.side === 'red') ?? { x: s.map.w * 0.7, y: s.map.h / 2 };
    const [sx, sy] = g.cam.worldToScreen(red.x, red.y, innerWidth, innerHeight);
    return { sx: Math.round(sx), sy: Math.round(sy), x: red.x, y: red.y };
  });
  await clearFx();
  await page.mouse.click(t.sx, t.sy);
  const left1 = await page.evaluate(() => window.__game.sim.barragesLeft.blue);
  check(left1 === left0 - 1, `calling a barrage spends one (${left0} → ${left1})`);
  // BARRAGE_DELAY_TICKS is 20 s of sim time before the first round arrives.
  await run(30000);
  const n = await boomsNear(t.x, t.y, 40);
  check(n > 0, `the barrage lands on the called point: ${n} bursts`);
}

// ── 4. Airstrike ────────────────────────────────────────────────────────────
const hasAir = (await page.$('button[data-act="air"]')) !== null;
check(hasAir, 'the HUD offers an airstrike button');
if (hasAir) {
  const left0 = await page.evaluate(() => window.__game.sim.airstrikesLeft.blue);
  await page.click('button[data-act="air"]');
  check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'air', 'the airstrike button arms the target cursor');
  const t = await page.evaluate(() => {
    const g = window.__game, s = g.sim;
    // Well clear of the barrage point so the two cannot borrow each other's hits.
    const red = s.soldiers.find((m) => m.alive && m.side === 'red') ?? { x: s.map.w * 0.7, y: s.map.h / 2 };
    const y = Math.max(10, Math.min(s.map.h - 10, red.y - 70));
    const [sx, sy] = g.cam.worldToScreen(red.x, y, innerWidth, innerHeight);
    return { sx: Math.round(sx), sy: Math.round(sy), x: red.x, y };
  });
  await clearFx();
  await page.mouse.click(t.sx, t.sy);
  const left1 = await page.evaluate(() => window.__game.sim.airstrikesLeft.blue);
  check(left1 === left0 - 1, `calling an airstrike spends one (${left0} → ${left1})`);
  await run(32000); // the run starts 25 s out
  const n = await boomsNear(t.x, t.y, 45);
  check(n > 0, `the airstrike strafes the called point: ${n} impacts`);
}

// ── 5. Bazooka vs armour (the AT mechanism, under natural dynamics) ─────────
// Vehicles do not field in campaign battles yet (that is the vehicle lane's
// job); staging one proves whether the AT fire path works the moment they do.
const at = await page.evaluate(async () => {
  const { WEAPONS } = await import('/src/sim/data.ts');
  const sim = window.__game.sim;
  const man = sim.soldiers.find((m) => m.alive && m.side === 'blue' && WEAPONS[m.weapon]?.pen !== undefined);
  if (!man) return null;
  const w = WEAPONS[man.weapon];
  // Park a red tank in the open, well inside his reach, on a passable tile.
  let vx = man.x + Math.min(25, w.range * 0.5);
  let vy = man.y;
  const p = sim.nudgeSpawn(vx, vy);
  const v = sim.addVehicle('red', 'panzer4', p.x, p.y, Math.PI);
  return { sid: man.id, weapon: man.weapon, range: w.range, vid: v?.id ?? sim.vehicles[sim.vehicles.length - 1].id, vx: p.x, vy: p.y, mx: man.x, my: man.y };
});
check(!!at, `a blue AT man is fielded${at ? ` (${at.weapon}, range ${at.range})` : ''}`);
if (at) {
  // A vehicle has no hp: an AP round surfaces as a ShotEvent AT the hull, then
  // as crew wounds or a brew-up. Count rounds arriving on the tank.
  const wounds0 = await page.evaluate((vid) => {
    const s = window.__game.sim, v = s.vehicles.find((x) => x.id === vid);
    return v.crewIds.reduce((a, id) => a + s.soldiers[id].wounds.length, 0);
  }, at.vid);
  await clearFx();
  await run(20000);
  const res = await page.evaluate((vid) => {
    const s = window.__game.sim, v = s.vehicles.find((x) => x.id === vid);
    const onHull = (window.__shots ?? []).filter((sh) => Math.hypot(sh.tx - v.x, sh.ty - v.y) < 3).length;
    return {
      alive: v.alive,
      burning: v.burning,
      onHull,
      wounds: v.crewIds.reduce((a, id) => a + s.soldiers[id].wounds.length, 0),
    };
  }, at.vid);
  const engaged = res.onHull > 0 || !res.alive || res.wounds > wounds0;
  check(engaged, `the bazooka engages armour under natural dynamics (${res.onHull} rounds on the hull, crew wounds ${wounds0} → ${res.wounds}, alive ${res.alive})`);
  if (!engaged) note(`AT liveness: nothing reached the tank in 20 s at ${Math.hypot(at.vx - at.mx, at.vy - at.my).toFixed(0)} m — check LOS/ammo/cooldown before calling the path good`);
}

// ── 6. Vehicle orders (player-driven) ───────────────────────────────────────
const veh = await page.evaluate(() => {
  const g = window.__game, sim = g.sim;
  const man = sim.soldiers.find((m) => m.alive && m.side === 'blue');
  const p = sim.nudgeSpawn(man.x + 4, man.y + 4);
  const v = sim.addVehicle('blue', 'sherman', p.x, p.y, 0);
  const id = v?.id ?? sim.vehicles[sim.vehicles.length - 1].id;
  const vv = sim.vehicles.find((x) => x.id === id);
  const [sx, sy] = g.cam.worldToScreen(vv.x, vv.y, innerWidth, innerHeight);
  return { id, x: vv.x, y: vv.y, sx: Math.round(sx), sy: Math.round(sy) };
});
await page.mouse.click(veh.sx, veh.sy);
const vsel = await page.evaluate(() => window.__game.getSelection().vehicle);
check(vsel === veh.id, `clicking a vehicle selects it (${vsel} vs ${veh.id})`);
if (vsel === veh.id) {
  const t = await page.evaluate(({ x, y }) => {
    const g = window.__game;
    const p = g.sim.nudgeSpawn(x + 25, y);
    const [sx, sy] = g.cam.worldToScreen(p.x, p.y, innerWidth, innerHeight);
    return { sx: Math.round(sx), sy: Math.round(sy), tx: p.x, ty: p.y };
  }, veh);
  await page.mouse.click(t.sx, t.sy, { button: 'right' });
  await run(9000);
  const moved = await page.evaluate(({ id, x, y }) => {
    const v = window.__game.sim.vehicles.find((k) => k.id === id);
    return { d: Math.hypot(v.x - x, v.y - y), x: v.x, y: v.y };
  }, veh);
  check(moved.d > 3, `a right-click drives the vehicle (${moved.d.toFixed(1)} m travelled)`);
}

await browser.close();
console.log('');
if (notes.length) console.log(`${notes.length} note(s) above`);
if (fails.length) {
  console.error(`${fails.length} FAILED:\n${fails.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('all ordnance checks passed');
