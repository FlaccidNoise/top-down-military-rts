// HUD click gate: a human-length press on a HUD control must land while the
// battle is RUNNING.
//
// The defect this exists to prevent (jtbug #784): the roster was rebuilt with
// innerHTML every 5 sim ticks, so a mouse press that spanned a rebuild put its
// mouseup on a new element and the browser fired no click. 40 ms presses mostly
// landed and 120 ms presses mostly did not, which is why nothing scripted ever
// saw it: page.click() presses for 0 ms.
//
//   node scripts/clicks.mjs --port P            # desktop mouse + phone touch
//   node scripts/clicks.mjs --port P --n 20     # presses per control per hold
//
// Dev server must be running: npm run dev -- --port P --strictPort
import { arg, launch, gotoStaged } from './lib/stage.mjs';

const PORT = Number(arg('port', '5331'));
const N = Number(arg('n', '20'));
const HOLDS = [40, 120, 220]; // ms a button is held: a tap, a click, a slow click
const fails = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
};

for (const device of ['desktop', 'phone-landscape']) {
  console.log(`\n=== ${device} · running battle ===`);
  const { browser, page } = await launch({ device });
  const cdp = await page.context().newCDPSession(page);
  const touch = device !== 'desktop';
  try {
    await gotoStaged(page, { port: PORT, seed: 7 });
    await page.evaluate(() => document.getElementById('rotate')?.classList.add('dismissed'));
    await page.waitForTimeout(600);
    const squads = await page.evaluate(() => {
      const g = window.__game;
      const rifle = g.sim.squads.filter((q) => q.side === 'blue' && q.teamIds.length > 1).map((q) => q.id);
      g.selectSquad(rifle[0]);
      g.setPaused(false);
      return rifle;
    });
    await page.waitForFunction((t) => window.__game.sim.tick > t + 10, await page.evaluate(() => window.__game.sim.tick));
    const centre = (sel) =>
      page.evaluate((s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, sel);
    const press = async (p, hold) => {
      if (touch) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
        await page.waitForTimeout(hold);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.waitForTimeout(hold);
        await page.mouse.up();
      }
      await page.waitForTimeout(80);
    };
    const running = () => page.evaluate(() => { const t = window.__game.sim.tick; return new Promise((r) => setTimeout(() => r(window.__game.sim.tick > t), 120)); });
    check(await running(), `${device}: the sim is stepping while the presses land`);

    // The order chip: the control the defect was measured on.
    const chip = `${touch ? '#touchbar' : '#squads'} [data-order="fire"]`;
    for (const hold of HOLDS) {
      let ok = 0;
      for (let i = 0; i < N; i++) {
        // Known state before each press: nothing armed.
        await page.evaluate(() => { const g = window.__game; if (g.getSelection().armedOrder) document.querySelector('[data-order].armed')?.click(); });
        await page.waitForTimeout(60 + Math.random() * 140); // land anywhere in the HUD's refresh cycle
        const p = await centre(chip);
        if (!p) break;
        await press(p, hold);
        if ((await page.evaluate(() => window.__game.getSelection().armedOrder)) === 'fire') ok++;
      }
      check(ok === N, `${device}: order chip, ${hold} ms press: ${ok}/${N} armed`);
    }

    // A squad card and a soldier row ride the same DOM: desktop only, where the
    // roster is always on screen.
    if (!touch) {
      for (const hold of HOLDS) {
        let ok = 0;
        for (let i = 0; i < N; i++) {
          const want = squads[1 + (i % 2)];
          await page.waitForTimeout(60 + Math.random() * 140);
          const p = await centre(`#squads [data-squad="${want}"] .card-head`);
          if (!p) break;
          await press(p, hold);
          if ((await page.evaluate(() => window.__game.getSelection().squads[0])) === want) ok++;
        }
        check(ok === N, `${device}: squad card, ${hold} ms press: ${ok}/${N} selected`);
      }
      for (const hold of HOLDS) {
        let ok = 0;
        for (let i = 0; i < N; i++) {
          await page.keyboard.press('Escape'); // closes the health panel if the last press opened it
          await page.evaluate((id) => window.__game.selectSquad(id), squads[0]);
          await page.waitForTimeout(60 + Math.random() * 140);
          const p = await centre('#squads [data-soldier]');
          if (!p) break;
          await press(p, hold);
          if (await page.evaluate(() => getComputedStyle(document.getElementById('healthpanel')).display !== 'none')) ok++;
        }
        check(ok === N, `${device}: soldier row, ${hold} ms press: ${ok}/${N} opened the health panel`);
      }
    }
    check(await running(), `${device}: the sim was still stepping at the end`);
  } catch (e) {
    check(false, `${device} aborted: ${e.message}`);
  }
  await browser.close();
}

console.log(fails.length ? `\n${fails.length} FAILED:\n${fails.map((f) => `  - ${f}`).join('\n')}` : '\nall click checks passed');
process.exit(fails.length ? 1 : 0);
