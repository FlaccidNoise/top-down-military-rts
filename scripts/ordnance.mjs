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
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails.push(what);
};

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
// A control the HUD is expected to be showing. The HUD rebuilds on the frame
// after a selection changes, so "is it there" gets two seconds to become true
// rather than one instant: a button that never comes still fails.
const offered = (sel) => page.waitForSelector(sel, { timeout: 2000 }).then(() => true, () => false);
const clearFx = () => page.evaluate(() => { window.__booms.length = 0; window.__shots.length = 0; });
// Bursts NEAR a called point. Attribution by position matters: a barrage has a
// 20 s time of flight, so an un-attributed count credits whichever fire mission
// happened to be waiting when someone else's rounds arrived.
const boomsNear = (x, y, r = 30) =>
  page.evaluate(({ x, y, r }) => (window.__booms ?? []).filter((b) => Math.hypot(b.x - x, b.y - y) < r).length, { x, y, r });

// EVERY world click goes through here: centre the camera on the point, then
// click the middle of the canvas. Two things this defends against, both of
// which produced false failures first — a point can be off screen entirely
// (boot framing fits whatever is fielded, and armour at the west entry moves
// it), and a point near the left edge can sit UNDER the opaque roster panel,
// where the click never reaches the canvas at all.
async function clickWorld(x, y, button = 'left') {
  const at = await page.evaluate(({ x, y }) => {
    const cam = window.__game.cam;
    cam.x = x;
    cam.y = y;
    cam.scale = Math.max(cam.minScale, Math.min(cam.maxScale, 12));
    const [sx, sy] = cam.worldToScreen(x, y, innerWidth, innerHeight);
    return { sx: Math.round(sx), sy: Math.round(sy) };
  }, { x, y });
  await page.mouse.click(at.sx, at.sy, button === 'right' ? { button: 'right' } : {});
}

// A point some blue soldier can actually SEE: indirect fire is gated on
// friendlyHasLos (the shared-vision rule), so calling a mission onto unobserved
// ground is correctly refused and proves nothing about the path.
const observedPoint = (minD, maxD) =>
  page.evaluate(async ({ minD, maxD }) => {
    const { sightBetween } = await import('/src/sim/sim.ts');
    const s = window.__game.sim;
    for (const m of s.soldiers.filter((k) => k.alive && k.side === 'blue' && k.inVehicle < 0)) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        for (let d = minD; d <= maxD; d += 8) {
          const x = m.x + Math.cos(ang) * d;
          const y = m.y + Math.sin(ang) * d;
          if (x < 4 || y < 4 || x > s.map.w - 4 || y > s.map.h - 4) continue;
          if (!s.map.terrainAt(Math.floor(x), Math.floor(y)).passable) continue;
          if (sightBetween(s, m.x, m.y, x, y, m.level, 0).visible) return { x, y, d };
        }
      }
    }
    return null;
  }, { minD, maxD });

// ── 1. Vehicle orders (player-driven) ───────────────────────────────────────
// Use the battle's OWN blue armour — the fielding lane put it there.
//
// FIRST, before anything is fired: this check needs a living blue hull, and
// the rest of the gate is three minutes of live battle during which one can be
// lost — most often to the red hull section 6 stages 25 m from the bazooka
// man, which then had the vehicle checks still to come (2 failures in 6 runs
// on main: "blue armour is on the field to command"). At tick 0 the hulls are
// as staging left them, so a failure here is a fielding or a UI defect and
// never the luck of the battle. What is proved is unchanged: the hull is
// there, a click selects it, a right-click drives it.
const veh = await page.evaluate(() => {
  const s = window.__game.sim;
  const v = s.vehicles.find((k) => k.alive && k.side === 'blue');
  return v ? { id: v.id, kind: v.kind, x: v.x, y: v.y } : null;
});
check(!!veh, `blue armour is on the field to command${veh ? ` (${veh.kind})` : ''}`);
if (veh) {
  await clickWorld(veh.x, veh.y);
  const vsel = await page.evaluate(() => window.__game.getSelection().vehicle);
  check(vsel === veh.id, `clicking the hull selects it (${vsel} vs ${veh.id})`);
  if (vsel === veh.id) {
    const dest = await page.evaluate(({ x, y }) => window.__game.sim.nudgeSpawn(x + 25, y), veh);
    await clickWorld(dest.x, dest.y, 'right');
    await run(9000);
    const moved = await page.evaluate(({ id, x, y }) => {
      const v = window.__game.sim.vehicles.find((k) => k.id === id);
      return Math.hypot(v.x - x, v.y - y);
    }, veh);
    check(moved > 3, `a right-click drives it (${moved.toFixed(1)} m travelled)`);
  }
  // Escape steps down the cancel ladder, and a selected hull is its last rung:
  // it lets go of the hull and does not open the pause menu.
  await page.keyboard.press('Escape');
  const esc = await page.evaluate(() => ({ vehicle: window.__game.getSelection().vehicle, menu: getComputedStyle(document.getElementById('pausemenu')).display !== 'none' }));
  check(esc.vehicle === -1 && !esc.menu, `Escape with a hull selected deselects it and opens no menu (vehicle ${esc.vehicle}, menu open ${esc.menu})`);
}

// ── 2-3. Mortar HE mission and smoke mission ────────────────────────────────
const mortar = await page.evaluate(() => {
  const s = window.__game.sim;
  const e = s.emplacements.find((m) => m.side === 'blue' && m.state === 'deployed' && ['mortar60', 'mortar81'].includes(m.kind));
  return e ? { id: e.id, kind: e.kind, x: e.x, y: e.y } : null;
});
check(!!mortar, `a blue mortar is fielded in a campaign battle${mortar ? ` (${mortar.kind})` : ''}`);

if (mortar) {
  await clickWorld(mortar.x, mortar.y);
  const sel = await page.evaluate((id) => {
    const g = window.__game, s = g.sim, pick = g.getSelection();
    return { squads: pick.squads, crewSquad: s.teams[s.emplacements[id].crewTeamId]?.squadId };
  }, mortar.id);
  check(sel.squads.includes(sel.crewSquad), `clicking the mortar selects its crew squad (${sel.squads.join(',')} vs crew ${sel.crewSquad})`);

  // HE mission
  const hasFire = await offered('button[data-ctx="fire"]');
  check(hasFire, 'the mortar crew panel offers a Fire button');
  if (hasFire) {
    // Re-query at the moment of use: the HUD rebuilds on a sig change, so a
    // held handle goes stale between the check and the click.
    await page.click('button[data-ctx="fire"]');
    check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'empfire', 'Fire arms the empfire target mode');
    const obs = await observedPoint(35, 90);
    check(!!obs, 'a mortar target the company can observe exists (indirect fire is spotter-gated)');
    await clearFx();
    await clickWorld(obs.x, obs.y);
    const armed = await page.evaluate((id) => {
      const e = window.__game.sim.emplacements[id];
      return { hasTarget: e.hasTarget, tx: e.targetX, ty: e.targetY, mode: window.__game.getSelection().targetMode };
    }, mortar.id);
    check(armed.hasTarget, `the click sets the mortar's fire mission (target ${armed.tx?.toFixed(0)},${armed.ty?.toFixed(0)}, observed from ${obs.d.toFixed(0)} m)`);
    check(armed.mode === '', 'the target cursor clears after the call');
    await run(14000); // cooldown + the shell's 3 s time of flight
    check((await boomsNear(obs.x, obs.y)) > 0, `the mortar actually fires: ${await boomsNear(obs.x, obs.y)} HE bursts on the called point`);
  }

  // Smoke mission — re-select: the fire mission may have shifted the panel.
  await clickWorld(mortar.x, mortar.y);
  const hasSmoke = await offered('button[data-ctx="smoke"]');
  check(hasSmoke, 'the mortar crew panel offers a Smoke mission button');
  if (hasSmoke) {
    const before = await page.evaluate(() => window.__game.sim.smoke.length);
    await page.click('button[data-ctx="smoke"]');
    check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'empsmoke', 'Smoke mission arms the empsmoke target mode');
    const obs2 = await observedPoint(30, 80);
    await clickWorld(obs2.x, obs2.y);
    const rounds = await page.evaluate((id) => window.__game.sim.emplacements[id].smokeRoundsLeft, mortar.id);
    check(rounds > 0, `the call loads a smoke mission (${rounds} rounds queued)`);
    await run(16000);
    const after = await page.evaluate(() => window.__game.sim.smoke.length);
    check(after > before, `the mortar smoke mission puts a screen up (${before} → ${after} puffs)`);
  }
}

// ── 4. Barrage (artillery) ──────────────────────────────────────────────────
const hasBarrage = await offered('button[data-act="barrage"]');
check(hasBarrage, 'the HUD offers a barrage button');
if (hasBarrage) {
  const left0 = await page.evaluate(() => window.__game.sim.barragesLeft.blue);
  await page.click('button[data-act="barrage"]');
  check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'barrage', 'the barrage button arms the target cursor');
  const t = await page.evaluate(() => {
    const s = window.__game.sim;
    const red = s.soldiers.find((m) => m.alive && m.side === 'red') ?? { x: s.map.w * 0.7, y: s.map.h / 2 };
    return { x: red.x, y: red.y };
  });
  await clearFx();
  await clickWorld(t.x, t.y);
  const left1 = await page.evaluate(() => window.__game.sim.barragesLeft.blue);
  check(left1 === left0 - 1, `calling a barrage spends one (${left0} → ${left1})`);
  // BARRAGE_DELAY_TICKS is 20 s of sim time before the first round arrives.
  await run(30000);
  check((await boomsNear(t.x, t.y, 40)) > 0, `the barrage lands on the called point: ${await boomsNear(t.x, t.y, 40)} bursts`);
}

// ── 5. Airstrike ────────────────────────────────────────────────────────────
const hasAir = await offered('button[data-act="air"]');
check(hasAir, 'the HUD offers an airstrike button');
if (hasAir) {
  const left0 = await page.evaluate(() => window.__game.sim.airstrikesLeft.blue);
  await page.click('button[data-act="air"]');
  check((await page.evaluate(() => window.__game.getSelection().targetMode)) === 'air', 'the airstrike button arms the target cursor');
  const t = await page.evaluate(() => {
    const s = window.__game.sim;
    // Well clear of the barrage point so the two cannot borrow each other's hits.
    const red = s.soldiers.find((m) => m.alive && m.side === 'red') ?? { x: s.map.w * 0.7, y: s.map.h / 2 };
    return { x: red.x, y: Math.max(10, Math.min(s.map.h - 10, red.y - 70)) };
  });
  await clearFx();
  await clickWorld(t.x, t.y);
  const left1 = await page.evaluate(() => window.__game.sim.airstrikesLeft.blue);
  check(left1 === left0 - 1, `calling an airstrike spends one (${left0} → ${left1})`);
  await run(32000); // the run starts 25 s out
  check((await boomsNear(t.x, t.y, 45)) > 0, `the airstrike strafes the called point: ${await boomsNear(t.x, t.y, 45)} impacts`);
}

// ── 6. Bazooka vs armour, under natural dynamics ───────────────────────────
// Campaign battles now field armour, so the enemy hull is the game's own, not
// one staged by this script — the AT loops finally have something to acquire.
const at = await page.evaluate(async () => {
  const { WEAPONS } = await import('/src/sim/data.ts');
  const s = window.__game.sim;
  const man = s.soldiers.find((m) => m.alive && m.side === 'blue' && WEAPONS[m.weapon]?.pen !== undefined);
  if (!man) return null;
  const w = WEAPONS[man.weapon];
  let v = s.vehicles.find((k) => k.alive && k.side === 'red');
  if (!v) {
    // No red armour on this seed (kind-gated): stage one so the path is still
    // exercised, and say so in the label.
    const p = s.nudgeSpawn(man.x + Math.min(25, w.range * 0.5), man.y);
    v = s.addVehicle('red', 'panzer4', p.x, p.y, Math.PI) ?? s.vehicles[s.vehicles.length - 1];
    return { vid: v.id, staged: true, weapon: man.weapon, range: w.range };
  }
  return { vid: v.id, staged: false, weapon: man.weapon, range: w.range, kind: v.kind };
});
check(!!at, `a blue AT man is fielded${at ? ` (${at.weapon}, range ${at.range})` : ''}`);
if (at) {
  const wounds0 = await page.evaluate((vid) => {
    const s = window.__game.sim, v = s.vehicles.find((x) => x.id === vid);
    return v.crewIds.reduce((a, id) => a + s.soldiers[id].wounds.length, 0);
  }, at.vid);
  await clearFx();
  await run(20000);
  const res = await page.evaluate((vid) => {
    const s = window.__game.sim, v = s.vehicles.find((x) => x.id === vid);
    return {
      alive: v.alive,
      onHull: (window.__shots ?? []).filter((sh) => Math.hypot(sh.tx - v.x, sh.ty - v.y) < 3).length,
      wounds: v.crewIds.reduce((a, id) => a + s.soldiers[id].wounds.length, 0),
    };
  }, at.vid);
  const engaged = res.onHull > 0 || !res.alive || res.wounds > wounds0;
  check(engaged, `the bazooka engages ${at.staged ? 'staged' : 'FIELDED'} armour (${res.onHull} rounds on the hull, crew wounds ${wounds0} → ${res.wounds}, alive ${res.alive})`);
}

await browser.close();
console.log('');
if (fails.length) {
  console.error(`${fails.length} FAILED:\n${fails.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('all ordnance checks passed');
