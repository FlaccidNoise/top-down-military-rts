// Gait gate: a man who is walking is drawn walking on EVERY frame.
//
// The defect this exists to prevent (jtbug #804): the sim steps at 30 Hz and
// the screen draws at 60 or 120. The renderer measured "is he moving" as the
// distance since the last FRAME, so on a frame with no sim step a marching man
// was drawn in his standing pose, with his standing turn, and went back to the
// walk on the next. A still shows nothing: it only exists between frames.
//
//   node scripts/gait.mjs --port P
//
// Dev server must be running: npm run dev -- --port P --strictPort
import { arg, launch, gotoStaged } from './lib/stage.mjs';

const PORT = Number(arg('port', '5331'));
const FRAMES = Number(arg('frames', '240'));
const fails = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
};

const { browser, page } = await launch({ device: 'desktop' });
try {
  await gotoStaged(page, { port: PORT, seed: 7 });
  const r = await page.evaluate(async (frames) => {
    const g = window.__game;
    const s = g.sim;
    const sq = s.squads.find((q) => q.side === 'blue' && q.teamIds.length > 1);
    const men = s.soldiers.filter((m) => m.squadId === sq.id);
    const lead = men[0];
    // Along the start line, not at the enemy: nobody is shot, so nobody stops.
    const dy = lead.y < s.map.h / 2 ? 30 : -30;
    s.orderSquad(sq.id, { kind: 'move', x: lead.x, y: lead.y + dy });
    g.cam.x = lead.x;
    g.cam.y = lead.y + dy / 2;
    g.cam.scale = 14;
    g.setPaused(false);
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    const GAIT = new Set(['walk', 'run', 'crawl']);
    const at = new Map(men.map((m) => [m.id, { x: m.x, y: m.y, moving: false }]));
    let tick = s.tick;
    let noStep = 0; // frames drawn with no sim step before them
    let samples = 0; // a man mid-march, drawn on such a frame
    let rest = 0; // ... and drawn in a rest pose
    const seen = {};
    for (let i = 0; i < frames; i++) {
      await raf();
      const stepped = s.tick !== tick;
      tick = s.tick;
      if (!stepped) noStep++;
      for (const m of men) {
        const a = at.get(m.id);
        if (stepped) {
          a.moving = Math.hypot(m.x - a.x, m.y - a.y) > 1e-4;
          a.x = m.x;
          a.y = m.y;
          continue;
        }
        if (!a.moving || !m.alive || m.downed) continue;
        const pose = g.renderer.rs.get(m.id)?.pose;
        samples++;
        seen[pose] = (seen[pose] ?? 0) + 1;
        if (!GAIT.has(pose)) rest++;
      }
    }
    return { noStep, samples, rest, seen };
  }, FRAMES);
  console.log(`  ${FRAMES} frames, ${r.noStep} with no sim step, poses on those: ${JSON.stringify(r.seen)}`);
  check(r.noStep >= FRAMES / 4 && r.samples >= 100, `the run can see the defect (${r.noStep} frames with no step, ${r.samples} samples of a marching man)`);
  check(r.rest === 0, `a marching man keeps his gait pose between sim steps (${r.rest} of ${r.samples} drawn at rest)`);
} finally {
  await browser.close();
}

if (fails.length) {
  console.error(`\ngait gate FAILED (${fails.length}):\n` + fails.map((f) => `  - ${f}`).join('\n') + `\nFix: in drawSoldier (src/render/renderer.ts) measure movement per sim step, not per frame.`);
  process.exit(1);
}
console.log('\ngait gate passed');
