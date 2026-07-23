// Shared staging primitives for the visual-debug tools (sweep / vfx / shot).
//
// One place that knows how to: launch a headless Chrome, boot the game into a
// pinned, deterministic, PAUSED battle (strongest red defends so it never
// auto-resolves; nearest blue attacks), derive named scene targets from the
// map plan, move the camera, and — the hard part — capture short-lived
// wall-clock VFX by grabbing frames from inside the page.
//
// Why in-page capture: transient VFX (muzzle 60ms, tracer 90ms, fireball
// 150ms) age off wall-clock `now` and are drained into the renderer every real
// frame by main.ts, paused or not. An MCP/Playwright screenshot round-trip
// (150-400ms) always misses that window, so `burst()` runs a requestAnimation-
// Frame loop in the page and keeps the brightest frame per age bucket.
import { chromium } from 'playwright';

export const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

export async function launch(viewport = { width: 1280, height: 800 }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
  return { browser, page };
}

// Navigate to a pinned campaign+seed and stage the static defend scene the art
// gate relies on. Returns the defended cell's terrain kind (after any force).
export async function gotoStaged(page, { port, seed, camp = 42, fow = 0, forceKind = null }) {
  await page.goto(`http://[::1]:${port}/?seed=${seed}&camp=${camp}&fow=${fow}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__game' in window);
  return page.evaluate(({ forceKind }) => {
    const g = window.__game;
    const front = g.front;
    const reds = front.chits
      .filter((c) => c.side === 'red' && c.strength > 0)
      .sort((a, b) => b.strength - a.strength || a.id - b.id);
    const def = reds[0];
    if (forceKind) front.sector.cells[def.cell].terrain = forceKind;
    const sw = front.sector.w;
    const dist = (c) => Math.abs((c.cell % sw) - (def.cell % sw)) + Math.abs(((c.cell / sw) | 0) - ((def.cell / sw) | 0));
    const atk = front.chits
      .filter((c) => c.side === 'blue' && c.strength > 0)
      .sort((a, b) => dist(a) - dist(b) || a.id - b.id)[0];
    g.startEngagementBattle({ attackerId: atk.id, defenderId: def.id, cell: def.cell });
    return front.sector.cells[def.cell].terrain;
  }, { forceKind });
}

// Named scene targets ({x, y, scale}) derived by re-running the map plan
// in-page, exactly as bridge.ts carved it — not hardcoded coords.
export function deriveTargets(page, { seed, kind }) {
  return page.evaluate(
    async ({ seed, kind }) => {
      const g = window.__game;
      const { generateMap } = await import('/src/sim/mapgen.ts');
      const plan = generateMap(seed, 320, 240, kind);
      const [vil, woods, hamlet] = plan.objectives;
      const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      const bCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
      const farm = plan.buildings
        .map(bCenter)
        .sort((a, b) => Math.min(d2(b, vil), d2(b, hamlet)) - Math.min(d2(a, vil), d2(a, hamlet)))[0];

      let bocage = { x: (vil.x + woods.x) / 2, y: (vil.y + woods.y) / 2 };
      let bestHedges = 0;
      for (let by = 0; by < 240; by += 16)
        for (let bx = 0; bx < 320; bx += 16) {
          const c = { x: bx + 8, y: by + 8 };
          if (d2(c, vil) < 40 * 40 || d2(c, hamlet) < 30 * 30) continue;
          let n = 0;
          for (let y = by; y < by + 16; y++)
            for (let x = bx; x < bx + 16; x++) if (plan.map.terrainKeyAt(x, y) === 'hedge') n++;
          if (n > bestHedges) {
            bestHedges = n;
            bocage = c;
          }
        }

      const squadCentroid = (side) => {
        const list = g.sim.soldiers.filter((s) => s.side === side && s.alive);
        const bySquad = new Map();
        for (const s of list) {
          const arr = bySquad.get(s.squadId) ?? [];
          arr.push(s);
          bySquad.set(s.squadId, arr);
        }
        const biggest = [...bySquad.values()].sort((a, b) => b.length - a.length)[0] ?? list;
        return { x: biggest.reduce((a, s) => a + s.x, 0) / biggest.length, y: biggest.reduce((a, s) => a + s.y, 0) / biggest.length };
      };

      const t = {
        farlod: { x: 160, y: 120, scale: Math.min(1280 / 320, 800 / 240) },
        village: { ...vil, scale: 24 },
        woods: { ...woods, scale: 24 },
        hamlet: { ...hamlet, scale: 24 },
        farm: { ...farm, scale: 24 },
        bocage: { ...bocage, scale: 24 },
        units: { ...squadCentroid('blue'), scale: 32 },
        enemy: { ...squadCentroid('red'), scale: 32 },
      };
      if (kind === 'bridge' || kind === 'river') t.bridge = { ...plan.objectives[plan.objectives.length - 1], scale: 16 };
      return t;
    },
    { seed, kind }
  );
}

// Point the camera and settle two frames (deterministic for static scenes).
export function place(page, x, y, scale) {
  return page.evaluate(
    ({ x, y, scale }) => {
      const g = window.__game;
      g.cam.x = x;
      g.cam.y = y;
      g.cam.scale = scale;
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    { x, y, scale }
  );
}

// Trigger a transient VFX and capture it from inside the page. `trigger`:
//   { type:'shot', hit, kill }  — enqueues a ShotEvent (muzzle + tracer + impact)
//   { type:'boom' }             — enqueues a boom (fireball + ejecta + smoke column)
// Both enqueue exactly like the sim does; main.ts drains them next frame.
//
// Scoring isolates the effect: score = count of ROI pixels whose peak channel
// changed >30 vs a pre-fire baseline frame. A flat static scene scores ~0, so
// the peak is unambiguously the effect (summed brightness would drown in the
// terrain's fixed ~25M). Per frame we only diff + drawImage the current best
// into a per-bucket canvas; toDataURL runs once per bucket at the end, so the
// rAF loop stays fast enough to fill every bucket.
// Returns [{ bucket, ageMs, score, dataUrl }] — most-changed frame per bucket.
export function burst(page, { x, y, scale, trigger, dur, buckets, roiFrac = 0.6 }) {
  return page.evaluate(
    async ({ x, y, scale, trigger, dur, buckets, roiFrac }) => {
      const g = window.__game;
      const sim = g.sim;
      const canvas = document.querySelector('canvas');
      g.cam.x = x;
      g.cam.y = y;
      g.cam.scale = scale;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      await raf();
      await raf(); // render the quiescent scene at this camera before baselining

      const rw = Math.round(canvas.width * roiFrac);
      const rh = Math.round(canvas.height * roiFrac);
      const rx = Math.round((canvas.width - rw) / 2);
      const ry = Math.round((canvas.height - rh) / 2);
      const probe = document.createElement('canvas');
      probe.width = canvas.width;
      probe.height = canvas.height;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      const roi = () => {
        pctx.drawImage(canvas, 0, 0);
        return pctx.getImageData(rx, ry, rw, rh).data;
      };
      const maxch = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]);
      const base = roi();

      if (trigger.type === 'shot') sim.pendingEvents.push({ fx: x - 6, fy: y, tx: x + 6, ty: y, hit: trigger.hit, kill: trigger.kill });
      else if (trigger.type === 'boom') sim.pendingBooms.push({ x, y });

      const snap = Array.from({ length: buckets }, () => null); // per-bucket best canvas
      const meta = Array.from({ length: buckets }, () => null);
      const start = performance.now();
      let age = 0;
      while ((age = performance.now() - start) < dur) {
        await raf();
        const d = roi();
        let score = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(maxch(d, i) - maxch(base, i)) > 30) score++;
        const b = Math.min(buckets - 1, Math.floor((age / dur) * buckets));
        if (!meta[b] || score > meta[b].score) {
          let c = snap[b];
          if (!c) {
            c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            snap[b] = c;
          }
          c.getContext('2d').drawImage(canvas, 0, 0);
          meta[b] = { bucket: b, ageMs: Math.round(age), score };
        }
      }
      return meta
        .map((m, b) => (m ? { ...m, dataUrl: snap[b].toDataURL('image/png') } : null))
        .filter(Boolean);
    },
    { x, y, scale, trigger, dur, buckets, roiFrac }
  );
}
