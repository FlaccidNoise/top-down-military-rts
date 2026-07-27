// Order-preview inspector — shoots the move preview overlay (M4) in a real
// battle, driven by real pointer events, so what lands in the PNG is what a
// player sees.
//
// It never releases the button: the order is previewed, never committed, which
// is the whole point of the surface under test.
//
// Dev server must be running: npm run dev -- --port 5199 --strictPort
//
// Examples:
//   node scripts/preview.mjs --scene hedge --out .screenshots/m4-hedge.png
//   node scripts/preview.mjs --scene interior --order move
//   node scripts/preview.mjs --scene pond            # the refusal state
//   node scripts/preview.mjs --scene hedge --device phone-landscape --touch
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, gotoStaged, place } from './lib/stage.mjs';

const HOLD_MS = 420; // must match src/ui/touch.ts

const has = (name) => process.argv.includes(`--${name}`);
const PORT = Number(arg('port', '5199'));
const SEED = Number(arg('seed', '7'));
const CAMP = Number(arg('camp', '42'));
const SCENE = arg('scene', 'hedge');
const ORDER = arg('order', SCENE === 'hedge' ? 'defend' : ''); // '' = plain move, no armed kind
const DEVICE = arg('device', 'desktop');
const SCALE = Number(arg('scale', '26'));
const DRAG = Number(arg('drag', SCENE === 'hedge' ? '14' : '0')); // metres of right-drag; 0 = plain hover
const OUT = arg('out', `.screenshots/m4-${SCENE}.png`);
const POND_R = Number(arg('pond', '11')); // pond scene: water radius, must beat the resolver's r<=5 fallback
const TOUCH = has('touch'); // drive the phone gesture path instead of the mouse
const SCENES = ['hedge', 'interior', 'pond'];
if (!SCENES.includes(SCENE)) throw new Error(`unknown scene "${SCENE}" — one of: ${SCENES.join(', ')}`);

const { browser, page } = await launch({ device: DEVICE });
await gotoStaged(page, { port: PORT, seed: SEED, camp: CAMP, fow: 0 });
await page.evaluate(() => window.__game.setPaused(true));

// Where to aim. Each scene derives its anchor from the live map, never from a
// hardcoded coordinate. `pond` STAGES its terrain: a water pocket around a 2x2
// islet, the smallest honest way to reproduce "the resolver cannot place most
// of this team" on a generated map.
const anchor = await page.evaluate(({ scene, pondR }) => {
  const sim = window.__game.sim;
  const m = sim.map;
  const blue = sim.soldiers.filter((s) => s.side === 'blue' && s.alive);
  const cx = blue.reduce((a, s) => a + s.x, 0) / blue.length;
  const cy = blue.reduce((a, s) => a + s.y, 0) / blue.length;
  const near = (x, y) => (x - cx) ** 2 + (y - cy) ** 2;

  if (scene === 'interior') {
    const b = sim.buildings.reduce((best, b) => (near(b.x + b.w / 2, b.y + b.h / 2) < near(best.x + best.w / 2, best.y + best.h / 2) ? b : best));
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  if (scene === 'pond') {
    // Put it on open ground the squad can see, then drown it. The radius has
    // to beat the resolver's own fallback reach (r <= 5) plus the formation
    // spread, or every slot just walks to the far bank and nobody is refused;
    // the 2x2 islet is what makes it a PARTIAL refusal instead of a total one.
    const R = pondR;
    let spot = null;
    for (let r = R + 3; r < 60 && !spot; r += 2) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x > R + 2 && y > R + 2 && x < m.w - R - 2 && y < m.h - R - 2 && m.terrainKeyAt(x, y) === 'grass') { spot = { x, y }; break; }
      }
    }
    if (!spot) throw new Error('no open ground near the squad to stage the pond on');
    for (let y = spot.y - R; y <= spot.y + R; y++) for (let x = spot.x - R; x <= spot.x + R; x++) m.setTerrain(x, y, 'water');
    for (let y = spot.y; y <= spot.y + 1; y++) for (let x = spot.x; x <= spot.x + 1; x++) m.setTerrain(x, y, 'grass');
    return { x: spot.x + 1, y: spot.y + 1 };
  }

  // hedge: the longest run of cover-bearing hedge nearest the squad.
  let best = null;
  for (let y = 4; y < m.h - 4; y++) {
    for (let x = 4; x < m.w - 4; x++) {
      if (m.terrainKeyAt(x, y) !== 'hedge') continue;
      let run = 0;
      while (m.terrainKeyAt(x, y + run) === 'hedge' && y + run < m.h - 4) run++;
      if (run < 5) continue;
      const score = run - Math.sqrt(near(x, y)) / 8;
      if (!best || score > best.score) best = { score, x, y: y + Math.floor(run / 2) };
    }
  }
  if (!best) throw new Error('no hedge run on this map — try --seed with a bocage cell');
  // Bocage banks are several tiles thick. Step off the WEST face and stand the
  // order in the open field, which is where a player actually clicks: the snap
  // then has somewhere to pull from and the tails are visible.
  let wx = best.x;
  while (wx > 2 && m.terrainKeyAt(wx - 1, best.y) === 'hedge') wx--;
  return { x: wx - 3.5, y: best.y };
}, { scene: SCENE, pondR: POND_R });

// The nearest blue squad gets the order. selectSquad drives the same path the
// roster click does, so the HUD and the overlay agree on the selection.
await page.evaluate(({ x, y }) => {
  const sim = window.__game.sim;
  let best = -1;
  let bd = Infinity;
  sim.squads.forEach((sq, i) => {
    if (sq.side !== 'blue') return;
    const men = sq.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
    if (men.length === 0) return;
    const mx = men.reduce((a, s) => a + s.x, 0) / men.length;
    const my = men.reduce((a, s) => a + s.y, 0) / men.length;
    const d = (mx - x) ** 2 + (my - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  if (best < 0) throw new Error('no living blue squad to order');
  window.__game.selectSquad(best);
}, anchor);

const stripCoach = async () => { if (!has('coach')) await page.evaluate(() => document.querySelectorAll('.coach').forEach((e) => e.remove())); };
await stripCoach();

if (ORDER) {
  // Desktop roster and phone touch bar both publish [data-order]; only one of
  // them is ever visible, so let the selector pick the live control surface.
  const btn = page.locator(`[data-order="${ORDER}"]:visible`).first();
  await btn.waitFor({ state: 'visible', timeout: 5000 });
  await btn.click({ force: true }); // a one-time coachmark can sit over the chip
  const armed = await page.evaluate(() => window.__game.getSelection().armedOrder);
  if (armed !== ORDER) throw new Error(`arming "${ORDER}" did not take (armedOrder=${armed}) — is the kind available to this squad?`);
}

// The men land on the ANCHOR (orderSquad fans around it) and the chip is drawn
// at the CURSOR, so a drag has to keep both ends in frame: centre the camera
// between them, then shift east of the roster panel so neither hides under it.
const drop = { x: anchor.x, y: anchor.y + DRAG };
const HUD_M = Number(arg('hud', '6')); // metres of camera offset clearing the left roster
await place(page, (anchor.x + drop.x) / 2 - HUD_M, (anchor.y + drop.y) / 2, SCALE);

// Real pointer events from here: the preview reads mouse.x/y + onCanvas, and
// a right-button drag is what builds formationDrag.
const screen = await page.evaluate(({ a, d }) => {
  const g = window.__game;
  const [ax, ay] = g.cam.worldToScreen(a.x, a.y, g.view.w, g.view.h);
  const [dx, dy] = g.cam.worldToScreen(d.x, d.y, g.view.w, g.view.h);
  return { ax, ay, dx, dy };
}, { a: anchor, d: drop });

if (TOUCH) {
  // The phone's order gesture: press, wait past HOLD_MS so touch.ts fires
  // holdStart (which is beginOrderAnchor plus the mouse.x/y hover aliases the
  // preview reads), then drag. No touchEnd — that would commit the order.
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y }] });
  await send('touchStart', screen.ax, screen.ay);
  await page.waitForTimeout(HOLD_MS + 180);
  if (DRAG > 0) await send('touchMove', screen.dx, screen.dy);
} else {
  await page.mouse.move(screen.ax, screen.ay);
  if (DRAG > 0) {
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(screen.dx, screen.dy, { steps: 6 });
  }
}
// One-time coachmarks are tutorial furniture, not the surface under test, and
// they land on top of it — including on the order chip. --coach keeps them.
await stripCoach();
await page.waitForTimeout(200); // a few frames with the cursor where it will be shot

const summary = await page.evaluate(() => {
  const g = window.__game;
  const sel = g.getSelection();
  return { squads: sel.squads, armed: sel.armedOrder, tick: g.sim.tick };
});

// --dump prints the dots in the frame: the same previewMoveSpots the overlay
// draws, rebuilt from the state this script just drove the game into.
if (has('dump')) {
  const dump = await page.evaluate(async ({ a, d, drag }) => {
    const g = window.__game;
    const { previewMoveSpots } = await import('/src/ui/overlays.ts');
    const sel = g.getSelection();
    const facing = Math.atan2(d.y - a.y, d.x - a.x);
    const len = Math.hypot(d.x - a.x, d.y - a.y);
    const pv = previewMoveSpots(g.sim, {
      shot: null,
      selectedSquad: sel.squads[sel.squads.length - 1],
      selectedTeam: sel.team,
      targetMode: '',
      armedOrder: sel.armedOrder,
      squadForce: false,
      cursor: drag ? { x: d.x, y: d.y } : { x: a.x, y: a.y },
      selectedSquads: sel.squads,
      selectRect: null,
      formationDrag: drag ? { ax: a.x, ay: a.y, facing, width: Math.max(3, Math.min(60, len)) } : null,
    });
    if (!pv) return null;
    return {
      kind: pv.kind,
      placed: pv.placed,
      covered: pv.covered,
      refused: pv.refused,
      teams: pv.teams.map((t) => ({
        teamId: t.teamId,
        verdict: t.verdict,
        spots: t.spots.map((s) => `(${s.x},${s.y}) ${g.sim.map.terrainKeyAt(s.x, s.y)}${s.covered ? ' COVERED' : ''}${s.snapped ? ' snapped' : ''}`),
        refused: t.refused.map((r) => `slot (${r.slotX.toFixed(1)},${r.slotY.toFixed(1)})`),
      })),
    };
  }, { a: anchor, d: drop, drag: DRAG > 0 });
  console.log(JSON.stringify(dump, null, 2));
}

mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
console.log(
  `${OUT}  (scene ${SCENE}, order ${ORDER || 'move'}, drag ${DRAG}m, squad ${summary.squads.join(',')}, armed=${summary.armed}, anchor ${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} @ ${SCALE}px/m, ${DEVICE})`
);
if (has('keep')) await page.waitForTimeout(60000);
await browser.close();
