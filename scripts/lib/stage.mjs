// Shared staging primitives for the visual-debug tools (sweep / vfx / shot).
//
// One place that knows how to: launch a headless Chrome, boot the game into a
// pinned, deterministic, PAUSED battle (strongest red defends so it never
// auto-resolves; nearest blue attacks), derive named scene targets from the
// map plan, move the camera, and — the hard part — capture short-lived VFX by
// grabbing frames from inside the page.
//
// Why in-page capture: transient VFX (muzzle 60ms, tracer 90ms, fireball
// 150ms) are drained into the renderer every real frame by main.ts and age off
// its fx clock, which STOPS under pause — and every staged scene is paused. So
// nothing here waits on wall-clock: `burst()` and `ageFx()` step that clock by
// hand through `__game.advanceFx`, one rAF per step, and `burst()` keeps the
// most-changed frame per age bucket. Ages are exact and repeat run to run.
import { chromium } from 'playwright';

export const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

// Device profiles. `desktop` is the historical default and must stay exactly
// 1280x800 @ dpr 1 with no touch: every sweep / vfx / shot / demo baseline was
// captured against it, and a silently reshot baseline is an invisible art
// regression. Phone profiles also need a mobile UA: Chrome 151 ignores
// isMobile/hasTouch without one, silently running desktop pointer media at a
// phone viewport. Together these options make pointer:coarse + hover:none true
// and turn MOBILE (src/render/view.ts) on.
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
export const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  'phone-landscape': { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
};

export async function launch({ device = 'desktop' } = {}) {
  const profile = DEVICES[device];
  if (!profile) throw new Error(`unknown device "${device}" — one of: ${Object.keys(DEVICES).join(', ')}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  // Chrome 151's first incognito context ignores touch/mobile emulation while
  // still applying its viewport. Burn that context so the phone gate cannot
  // silently exercise desktop controls at 390 px.
  if (profile.hasTouch) {
    const warm = await browser.newContext();
    await (await warm.newPage()).goto('data:text/html,warm');
    await warm.close();
  }
  const context = await browser.newContext({ ...profile });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`  pageerror: ${e.message}`));
  return { browser, page };
}

// Named hours a designer inspecting shadow work actually wants, so nobody has
// to do solar arithmetic to find the interesting minute. See src/sim/solar.ts
// for the arc these sit on.
export const HOUR_PRESETS = { dawn: '0700', dusk: '2030', night: '0200' };

// Parse an --hour argument: a preset name, HHMM, or HH:MM. Returns minutes past
// midnight, or null for "leave it at the canonical hour".
export function hourMin(spec) {
  if (spec === null || spec === undefined || spec === '') return null;
  const s = HOUR_PRESETS[spec] ?? String(spec);
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad --hour "${spec}" — want HHMM, HH:MM, or one of: ${Object.keys(HOUR_PRESETS).join(', ')}`);
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) throw new Error(`bad --hour "${spec}" — ${h}:${min} is not a time of day`);
  return h * 60 + min;
}

export const fmtHour = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`;

// Navigate to a pinned campaign+seed and stage the static defend scene the art
// gate relies on. Returns the defended cell's terrain kind (after any force).
//
// THE HOUR PIN. `front.clockMin` sits at OP_START_MIN = 06:00, which the solar
// model (src/sim/solar.ts) scores at elevation -1.9 deg: civil twilight, no
// cast shadows, a deep-blue grade. The moment the sun model goes live every
// baseline in this repo would silently reshoot as a dim night frame, and a
// silently reshot art baseline is an invisible regression — nothing downstream
// would ever flag it. So every staged scene is pinned to CANON_CLOCK_MIN
// (14:00 DBST = solar noon), which is the fixed point where the sun model
// reproduces the shipped art byte-for-byte. The constant is read out of
// solar.ts in-page rather than duplicated here, so it cannot drift.
//
// This is why the HUD title of every art baseline reads "Day 1 1400". If it
// ever reads 0600 again, the pin is broken.
//
// THE FLICKER PIN. `flicker=0` freezes the hearth glow (furniture.ts I15) at
// one frame. It runs off wall-clock `now`, so any crop with a lit hearth in it
// repaints forever, place() below cannot settle, and the crop differs between
// two captures of the SAME code — which is why three sweep crops were excluded
// from byte-identity comparison instead of trusted. Pinned by default for the
// same reason the hour is: a staged scene must be reproducible.
export async function gotoStaged(page, { port, seed, camp = 42, fow = 0, haze = null, flicker = 0, forceKind = null, hour = null }) {
  const q = `seed=${seed}&camp=${camp}&fow=${fow}&flicker=${flicker}${haze === null ? '' : `&haze=${haze}`}`;
  await page.goto(`http://[::1]:${port}/?${q}`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => '__game' in window, null, { timeout: 5000 })
    .catch(() => {
      throw new Error(`__game never appeared — is the dev server running? (npm run dev -- --port ${port} --strictPort, reachable at http://[::1]:${port}/)`);
    });
  return page.evaluate(async ({ forceKind, hour }) => {
    const g = window.__game;
    const front = g.front;
    const { CANON_CLOCK_MIN } = await import('/src/sim/solar.ts');
    // Before startEngagementBattle: the battle reads the clock on the way in.
    front.clockMin = hour === null ? CANON_CLOCK_MIN : hour;
    const reds = front.chits
      .filter((c) => c.side === 'red' && c.strength > 0)
      .sort((a, b) => b.strength - a.strength || a.id - b.id);
    const def = reds[0];
    if (!def) throw new Error('no red chit to defend (empty red side) — pick a different seed/camp');
    if (forceKind) front.sector.cells[def.cell].terrain = forceKind;
    const sw = front.sector.w;
    const dist = (c) => Math.abs((c.cell % sw) - (def.cell % sw)) + Math.abs(((c.cell / sw) | 0) - ((def.cell / sw) | 0));
    const atk = front.chits
      .filter((c) => c.side === 'blue' && c.strength > 0)
      .sort((a, b) => dist(a) - dist(b) || a.id - b.id)[0];
    if (!atk) throw new Error('no blue chit to attack (empty blue side) — pick a different seed/camp');
    g.startEngagementBattle({ attackerId: atk.id, defenderId: def.id, cell: def.cell });
    return front.sector.cells[def.cell].terrain;
  }, { forceKind, hour });
}

// What hour a staged page is actually sitting at, and what the canonical hour
// is according to src/sim/solar.ts. The art gate asserts on this; keeping the
// comparison against the module (not against a copy of the number) is the
// whole point.
export function stagedHour(page) {
  return page.evaluate(async () => {
    const { CANON_CLOCK_MIN } = await import('/src/sim/solar.ts');
    return { clockMin: window.__game.front.clockMin, canon: CANON_CLOCK_MIN };
  });
}

// Named scene targets ({x, y, scale}) derived by re-running the map plan
// in-page, exactly as bridge.ts carved it — not hardcoded coords.
export function deriveTargets(page, { seed, kind }) {
  return page.evaluate(
    async ({ seed, kind }) => {
      const g = window.__game;
      const { generateMap } = await import('/src/sim/mapgen.ts');
      const plan = generateMap(seed, 320, 240, kind);
      // R1: crops come off the objective TAG, never an objective INDEX — every
      // kind now emits objectiveKinds (mapgen.ts objectiveKinds, always
      // present post mapgen-v3), and the greedy garrison fill
      // (objectives.ts:95-125) pads every kind's list out to 12, so an index
      // is only positionally the same thing while the list is a fixed shape,
      // which stopped being true the moment that fill started running for
      // every kind.
      const kinds = plan.objectiveKinds ?? [];
      const objOf = (k) => {
        const i = kinds.indexOf(k);
        return i < 0 ? null : plan.objectives[i];
      };
      const vil = objOf('place') ?? plan.objectives[0];
      const woods = objOf('woods') ?? plan.objectives[1] ?? vil;
      // The secondary cluster (objectives.ts:73-82): 'faubourg' when the
      // archetype grew a real one, 'street' (the far end of the Grande Rue)
      // otherwise — always the FIRST 'street' tag, since it is pushed before
      // the greedy fill's own 'street'-tagged entries.
      const hamlet = objOf('faubourg') ?? objOf('street') ?? vil;
      const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      const bCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
      const farm = plan.buildings
        .map(bCenter)
        .sort((a, b) => Math.min(d2(b, vil), d2(b, hamlet)) - Math.min(d2(a, vil), d2(a, hamlet)))[0];

      // Densest 16x16 block of hedge, away from the two settlement anchors.
      const bestHedgeBlock = (avoid) => {
        let best = null;
        let bestN = 0;
        for (let by = 0; by < 240; by += 16)
          for (let bx = 0; bx < 320; bx += 16) {
            const c = { x: bx + 8, y: by + 8 };
            if (avoid.some(([p, r]) => p && d2(c, p) < r * r)) continue;
            let n = 0;
            for (let y = by; y < by + 16; y++)
              for (let x = bx; x < bx + 16; x++) if (plan.map.terrainKeyAt(x, y) === 'hedge') n++;
            if (n > bestN) {
              bestN = n;
              best = c;
            }
          }
        return best;
      };
      const bocage = bestHedgeBlock([[vil, 40], [hamlet, 30]]) ?? { x: (vil.x + woods.x) / 2, y: (vil.y + woods.y) / 2 };

      const squadCentroid = (side) => {
        const list = g.sim.soldiers.filter((s) => s.side === side && s.alive);
        const bySquad = new Map();
        for (const s of list) {
          const arr = bySquad.get(s.squadId) ?? [];
          arr.push(s);
          bySquad.set(s.squadId, arr);
        }
        const biggest = [...bySquad.values()].sort((a, b) => b.length - a.length)[0] ?? list;
        if (!biggest.length) throw new Error(`no living ${side} soldiers to centre on (empty scene)`);
        return { x: biggest.reduce((a, s) => a + s.x, 0) / biggest.length, y: biggest.reduce((a, s) => a + s.y, 0) / biggest.length };
      };

      // The longest party-wall run. Bourg and road both terrace their
      // frontage (footprints.ts DENS_TERRACE); this is the crop that catches
      // a thatched high street (roofs.ts smallOfPair), invisible in every
      // other frame. Not an objective tag — buildings carry terraceRun
      // directly — so it is derived the same way for every kind that has one.
      const terraceCentroid = (fallback) => {
        const runs = new Map();
        for (const b of plan.buildings) {
          if (b.terraceRun === undefined || b.terraceRun < 0) continue;
          const arr = runs.get(b.terraceRun) ?? [];
          arr.push(bCenter(b));
          runs.set(b.terraceRun, arr);
        }
        const longest = [...runs.values()].sort((a, b) => b.length - a.length)[0] ?? [fallback];
        return { x: longest.reduce((a, p) => a + p.x, 0) / longest.length, y: longest.reduce((a, p) => a + p.y, 0) / longest.length };
      };

      if (kind === 'bourg') {
        const place = vil;
        // A farm cour: the outbuilding-bearing structure farthest from the
        // place, i.e. one of T9's outlying compounds rather than a town yard.
        const rural = plan.buildings.filter((b) => b.role === 'farmhouse' || b.role === 'barn');
        const cour = (rural.length ? rural : plan.buildings).map(bCenter).sort((a, b) => d2(b, place) - d2(a, place))[0];
        return {
          farlod: { x: 160, y: 120, scale: Math.min(1280 / 320, 800 / 240) },
          place: { ...place, scale: 24 },
          church: { ...(objOf('church') ?? place), scale: 24 },
          street: { ...hamlet, scale: 24 },
          terrace: { ...terraceCentroid(place), scale: 24 },
          cour: { ...cour, scale: 24 },
          bocage: { ...(bestHedgeBlock([[place, 60]]) ?? bocage), scale: 24 },
          units: { ...squadCentroid('blue'), scale: 32 },
          enemy: { ...squadCentroid('red'), scale: 32 },
          soldiers48: { ...squadCentroid('blue'), scale: 48 },
        };
      }

      const t = {
        farlod: { x: 160, y: 120, scale: Math.min(1280 / 320, 800 / 240) },
        village: { ...vil, scale: 24 },
        woods: { ...woods, scale: 24 },
        hamlet: { ...hamlet, scale: 24 },
        farm: { ...farm, scale: 24 },
        bocage: { ...bocage, scale: 24 },
        units: { ...squadCentroid('blue'), scale: 32 },
        enemy: { ...squadCentroid('red'), scale: 32 },
        soldiers48: { ...squadCentroid('blue'), scale: 48 },
      };
      // road: the fight IS the street (profile.ts ROAD) — the terraced
      // frontage is the one crop no other kind needs.
      if (kind === 'road') t.terrace = { ...terraceCentroid(vil), scale: 24 };
      // river/bridge: the crossing, appended last and tagged 'bridge'
      // (mapgen.ts:318-322) — always present once plan.sk.profile.water is set.
      if (kind === 'bridge' || kind === 'river') t.bridge = { ...(objOf('bridge') ?? plan.objectives[plan.objectives.length - 1]), scale: 16 };
      // woods: a carved clearing (rural.ts carveClearings) is the kill zone
      // the kind is built around. Clearings are appended to woodsStands AFTER
      // every stand (rural.ts:453-456, "appended, never prepended"), and the
      // profile always carves at least one (profile.ts WOODS.clearings [2,3]
      // plus the guaranteed astride-the-arterial pick), so the last entry is
      // always a clearing centre.
      if (kind === 'woods') t.clearing = { ...plan.woodsStands[plan.woodsStands.length - 1], scale: 24 };
      return t;
    },
    { seed, kind }
  );
}

// Vehicle art gate: one of every kind, side by side, on FOUR DIFFERENT
// HEADINGS. The heading spread is the whole point — a shadow or highlight
// baked inside the rotating sprite looks fine on a row of tanks all facing
// east and obviously wrong the moment they don't. Mutates the sim, so it is
// opt-in (never part of deriveTargets, which every other crop shares).
export function stageVehicles(page, { x, y }) {
  return page.evaluate(
    ({ x, y }) => {
      const sim = window.__game.sim;
      const row = [
        ['blue', 'sherman', 0],
        ['red', 'panzer4', Math.PI / 2],
        ['red', 'stug3', Math.PI],
        ['blue', 'm3_halftrack', (3 * Math.PI) / 4],
        ['red', 'sdkfz251', Math.PI / 4],
      ];
      const cx = Math.max(16, Math.min(sim.map.w - 16, x));
      const cy = Math.max(12, Math.min(sim.map.h - 12, y));
      row.forEach(([side, kind, facing], i) => {
        const vx = cx + ((i % 3) - 1) * 9;
        const vy = cy + (((i / 3) | 0) - 0.5) * 9;
        sim.addVehicle(side, kind, vx, vy, facing);
      });
      return { x: cx - 2, y: cy, scale: 32 }; // nudge east so the left column clears the HUD sidebar
    },
    { x, y }
  );
}

// Morale-tell gate: the whole psych ladder in one row — steady, shaken, two
// pinned men and two broken ones — so the suppression ring, the pinned pulse
// and the rout chevron are all in frame together and against each other.
//
// The renderer reads `s.mental` continuously, so forcing the field IS the
// staging; nothing steps and the crop holds. suppression/morale are set to
// values the sim's own ladder agrees with, so the row survives even if
// something does step. Mutates the sim (positions included), so it is opt-in
// and must be staged LAST, like vehicles and guns.
//
// Under the default ?flicker=0 the pulse clock is pinned and this settles like
// any other crop. With flicker=1 it deliberately never settles — that is the
// point of the pin, not a bug (#134).
export function stageMorale(page, { x, y }) {
  return page.evaluate(
    ({ x, y }) => {
      const sim = window.__game.sim;
      const cx = Math.max(16, Math.min(sim.map.w - 16, x));
      const cy = Math.max(12, Math.min(sim.map.h - 12, y));
      const row = [
        ['steady', 0, 0.9],
        ['shaken', 0.45, 0.7],
        ['pinned', 0.8, 0.7],
        ['pinned', 1, 0.7],
        ['broken', 0.9, 0.1],
        ['broken', 0.3, 0.1],
      ];
      const men = sim.soldiers.filter((s) => s.alive && !s.downed && !s.captured && s.inVehicle < 0).sort((a, b) => a.id - b.id).slice(0, row.length);
      if (men.length < row.length) throw new Error(`stageMorale needs ${row.length} live soldiers, found ${men.length} — pick a different seed`);
      men.forEach((s, i) => {
        const [mental, supp, morale] = row[i];
        s.x = cx + (i - (row.length - 1) / 2) * 3.2;
        s.y = cy;
        s.level = 0;
        s.path = null;
        s.targetId = -1;
        s.mental = mental;
        s.suppression = supp;
        s.morale = morale;
      });
      return { x: cx, y: cy, scale: 34 };
    },
    { x, y }
  );
}

// Transition-FX gate: the three one-shot morale effects (the sim's pinned /
// rallied / ambush UnitEvents) laid out kind per row, AGE per column, so a
// whole lifetime is in one still.
//
// Ages, not wall-clock, for the reason stageSmoke uses them — the renderer
// keys every transient off (now - at), so injecting at `T - age` and drawing
// at `T` freezes any point of the curve. It drives renderer.draw itself with
// that chosen clock instead of waiting for a frame: the page's own fxNow is
// frozen wherever the pause left it, which would pin every effect at age 0.
// Returns a data URL — the caller writes the file.
// Desktop only: three ages × three kinds is 9 live effects, and MAX_MORALE_FX
// is 10 there but 6 under MOBILE — staged on a phone the last column silently
// never lands.
export function stageMoraleFx(page, { x, y, ages = [40, 150, 300], scale = 30 }) {
  return page.evaluate(
    ({ x, y, ages, scale }) => {
      const g = window.__game;
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const T = 100000; // any clock past the longest lifetime
      const kinds = ['pinned', 'rallied', 'ambush'];
      ages.forEach((age, c) => {
        g.renderer.addUnitEvents(
          kinds.map((kind, r) => ({ kind, x: x + (c - (ages.length - 1) / 2) * 6, y: y + 5 + r * 6, side: 'blue', name: kind })),
          T - age
        );
      });
      g.cam.x = x;
      g.cam.y = y + 11;
      g.cam.scale = scale;
      g.renderer.draw(ctx, g.cam, [], T);
      return canvas.toDataURL('image/png');
    },
    { x, y, ages, scale }
  );
}

// Smoke art gate (V12): one row of shell-smoke puffs at ages spanning the
// plume curve, plus one burning-wreck column. The renderer draws sim.smoke
// straight off `p.h`/`p.r`/`smokeAxisAt`, so the AGE is the whole variable —
// a fresh puff is a 1.5 m ball on the tile and a developed screen is a 10 m
// column smeared 3.5 m downwind. A single age proves none of that.
//
// Ages, not wall-clock: the art gate never steps the sim, so a staged puff
// holds its age forever and the crop is stable. Mutates the sim, so opt-in.
export function stageSmoke(page, { x, y, ages = [1, 5, 15, 30, 45] }) {
  return page.evaluate(
    async ({ x, y, ages }) => {
      const sim = window.__game.sim;
      const { smokePuff } = await import('/src/sim/sim.ts');
      const cx = Math.max(16, Math.min(sim.map.w - 16, x));
      const cy = Math.max(12, Math.min(sim.map.h - 12, y));
      const z = (px, py) => sim.map.elevAt(Math.floor(px), Math.floor(py));
      sim.smoke.length = 0;
      ages.forEach((age, i) => {
        const px = cx + (i - (ages.length - 1) / 2) * 11;
        sim.smoke.push(smokePuff(px, cy, z(px, cy), 60 - age, 0, age));
      });
      // A knocked-out tank's plume: kind 1, twice as tall, and the one case
      // where the lean is long enough to leave the tile it started on.
      sim.smoke.push(smokePuff(cx, cy + 14, z(cx, cy + 14), 150, 1, 30));
      return { x: cx + 6, y: cy + 6, scale: 20 };
    },
    { x, y, ages }
  );
}

// Emplacement art gate: one of every kind on two headings, plus one still
// packed, so the setup/teardown read is in frame too. Same heading-spread
// rationale as stageVehicles — a mount whose highlight is baked into the
// rotating sprite looks fine on one bearing and wrong on the next. Mutates the
// sim, so it is opt-in.
export function stageEmplacements(page, { x, y }) {
  return page.evaluate(
    ({ x, y }) => {
      const sim = window.__game.sim;
      const row = [
        ['blue', 'm1919_tripod', 0, 'deployed'],
        ['red', 'mg42_lafette', Math.PI / 2, 'deployed'],
        ['blue', 'mortar60', Math.PI, 'deployed'],
        ['red', 'mortar81', -Math.PI / 4, 'deployed'],
        ['blue', 'at57', 0, 'deployed'],
        ['red', 'pak40', Math.PI / 2, 'deployed'],
        ['red', 'pak40', Math.PI, 'packed'],
      ];
      const cx = Math.max(20, Math.min(sim.map.w - 20, x));
      const cy = Math.max(14, Math.min(sim.map.h - 14, y));
      row.forEach(([side, kind, facing, state], i) => {
        sim.addEmplacement(side, kind, cx + ((i % 4) - 1.5) * 9, cy + (((i / 4) | 0) - 0.5) * 10, facing, state);
      });
      return { x: cx, y: cy, scale: 26 };
    },
    { x, y }
  );
}

// Point the camera and settle until the full canvas stops changing. Two frames
// used to be enough, but bake work is amortized across frames and roof fades
// can continue after a downscaled centre probe appears still. Compare every
// native pixel exactly: the screenshot is full-frame, so the settle gate must
// cover that same frame and tolerate no one-level drift (#278).
//
// Returns { frames, quiesced }, and SHOUTS when it hits the cap instead of
// returning a half-settled world in silence.
//
// MEASURED, 2026-07-27, because §8 of the day/night design asks whether this
// cap still holds: most crops settle in 2-4 frames, but some crops NEVER
// settled, and raising the cap made them strictly worse. Seed 10's `enemy`
// crop (bourg interiors) was still repainting 120-200 px/frame at delta ~14
// after 300 frames. The cause was furniture.ts drawHearthGlow — I15 firelight,
// deliberately in the frame loop with two incommensurate sine rates off
// wall-clock `now` so the flicker never reads as a loop. A scene with a
// visible lit hearth could not be pixel-stable, so `place()` never converged
// on it and the baseline was not reproducible: two back-to-back captures
// differed by 221 px at cap 120, and by 18,626 px at cap 400 — a longer settle
// just let the flicker phase drift further apart. FIXED (2026-08-05, jtbug
// #134): gotoStaged pins the flicker clock with ?flicker=0, so hearth crops now
// settle like every other one. 120 stays; a longer cap was never the answer.
export const SETTLE_CAP = 120;
export async function place(page, x, y, scale) {
  const r = await page.evaluate(
    async ({ x, y, scale, cap }) => {
      const g = window.__game;
      g.cam.x = x;
      g.cam.y = y;
      g.cam.scale = scale;
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const snap = () => new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
      await raf();
      await raf();
      let prev = snap();
      let i = 0;
      let stable = 0;
      for (; i < cap && stable < 6; i++) {
        await raf();
        const cur = snap();
        let same = cur.length === prev.length;
        for (let k = 0; same && k < cur.length; k++) {
          if (cur[k] !== prev[k]) same = false;
        }
        stable = same ? stable + 1 : 0;
        prev = cur;
      }
      return { frames: i, quiesced: stable >= 6 };
    },
    { x, y, scale, cap: SETTLE_CAP }
  );
  if (!r.quiesced)
    console.warn(
      `  WARNING: place(${x.toFixed(1)}, ${y.toFixed(1)} @ ${scale}) never went still in ${SETTLE_CAP} frames — this crop is NOT a reproducible baseline; it will differ between captures. Usual cause: a frame-loop animation on wall-clock \`now\` in view. First check the page was staged through gotoStaged (it pins ?flicker=0 for the hearth glow). Do not raise SETTLE_CAP — that makes the drift worse. Pin the animation clock, or move the crop off it.`
    );
  return r;
}

// The building footprint nearest a point, straight out of sim.buildings — the
// anchor for anything that needs real masonry (wall strikes, building fires).
export function deriveBuilding(page, { x, y }) {
  return page.evaluate(
    ({ x, y }) => {
      const bs = window.__game.sim.buildings;
      if (!bs.length) throw new Error('no buildings in this scenario — pick a village/hamlet seed');
      return bs.reduce((best, b) => {
        const d = (b.x + b.w / 2 - x) ** 2 + (b.y + b.h / 2 - y) ** 2;
        return d < best.d ? { d, b } : best;
      }, { d: Infinity, b: null }).b;
    },
    { x, y }
  );
}

// Staging for a round that misses into masonry: aim short of a building's west
// wall so the overshoot ray lands on stone, and centre the camera ON the wall
// so a tightened ROI scores the strike rather than the muzzle flash behind it.
export function wallStage(b) {
  const my = b.y + b.h / 2;
  return { anchor: { x: b.x, y: my }, aim: { fx: b.x - 7, fy: my, tx: b.x - 1.2, ty: my } };
}

// Trigger a transient VFX and capture it from inside the page. `trigger`:
//   { type:'shot', hit, kill, weapon } — enqueues a ShotEvent (muzzle + tracer
//                                 + impact); weapon picks the muzzle signature
//                                 and defaults to a rifle. fx/fy/tx/ty override
//                                 the default 12 m span across the anchor, which
//                                 is how a miss gets aimed into known masonry
//   { type:'boom', r, kind }    — enqueues a boom (fireball + ejecta + smoke
//                                 column); r is the blast radius in metres
//                                 (grenade ~3, mortar/barrage ~9), kind the
//                                 sim's blast kind. Both optional, as they are
//                                 on the sim's own boom
// Both enqueue exactly like the sim does; main.ts drains them next frame.
// `roiFrac` tightens the scored/diffed region for deliberately quiet effects.
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
    async ({ x, y, scale, trigger, dur, buckets, roiFrac, FX_FLUSH_MS }) => {
      const g = window.__game;
      const sim = g.sim;
      const canvas = document.querySelector('canvas');
      g.cam.x = x;
      g.cam.y = y;
      g.cam.scale = scale;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      // Settle before baselining. Two frames used to be enough; the roof fade
      // now lerps at dt*6, so a camera move keeps repainting whole buildings
      // for ~0.7 s and every changed-pixel score after it is measuring the
      // fade, not the effect (a rifle miss scored 95k that way).
      for (let i = 0; i < 45; i++) await raf();

      // ROI defaults to the centre 60% — covers muzzle→impact span and the rising smoke column
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

      if (trigger.type === 'shot')
        sim.pendingEvents.push({
          fx: trigger.fx ?? x - 6,
          fy: trigger.fy ?? y,
          tx: trigger.tx ?? x + 6,
          ty: trigger.ty ?? y,
          hit: trigger.hit,
          kill: trigger.kill,
          weapon: trigger.weapon ?? 'garand',
        });
      else if (trigger.type === 'boom') sim.pendingBooms.push({ x, y, ...(trigger.r === undefined ? {} : { r: trigger.r }), ...(trigger.kind === undefined ? {} : { kind: trigger.kind }) });

      const snap = Array.from({ length: buckets }, () => null); // per-bucket best canvas
      const meta = Array.from({ length: buckets }, () => null);
      // One 60 Hz frame of fx clock per real frame. The first pass through the
      // loop is the frame main.ts drains the trigger on, so it is age 0.
      const STEP = 1000 / 60;
      for (let age = 0; age < dur; age += STEP) {
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
        g.advanceFx(STEP);
      }
      // Age the leftovers out, so the next burst baselines a clean scene
      // instead of this one's smoke.
      g.advanceFx(FX_FLUSH_MS);
      await raf();
      await raf();
      return meta
        .map((m, b) => (m ? { ...m, dataUrl: snap[b].toDataURL('image/png') } : null))
        .filter(Boolean);
    },
    { x, y, scale, trigger, dur, buckets, roiFrac, FX_FLUSH_MS }
  );
}

// Longer than any transient the renderer keeps on the fx clock. Advancing by
// this much empties them all.
export const FX_FLUSH_MS = 30000;

// Age every fx-clock transient by `ms` under pause, then give the wall-clock
// reveals (the roof fade after a camera move) `settleMs` of real time. This is
// what a held shot waits on: `waitForTimeout` alone ages nothing in a paused
// scene, so "the fire left after the blast" was the blast at age 0.
export async function ageFx(page, ms, settleMs = 800) {
  await page.evaluate(async (ms) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    await raf(); // whatever was just pushed has to be drained at the OLD clock first
    window.__game.advanceFx(ms);
    await raf();
    await raf();
  }, ms);
  await page.waitForTimeout(settleMs);
}
