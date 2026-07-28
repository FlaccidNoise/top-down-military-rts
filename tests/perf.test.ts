import { describe, expect, it } from 'vitest';
import { RedCommander } from '../src/sim/ai';
import { GameMap, los } from '../src/sim/map';
import { generateMap, validate, type MapPlan, type Vec } from '../src/sim/mapgen';
import { buildObjectives } from '../src/sim/bourg/objectives';
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { BOURG, BRIDGE, OPEN, RIVER, ROAD, WOODS } from '../src/sim/bourg/profile';
import { furnishInteriors } from '../src/sim/interiors/furnish';
import { mulberry32 } from '../src/sim/rng';
import { PatchIndex } from '../src/render/patches';
import { eligible, fanOffsets, Sim, sightBetween, smokePuff, TEAM_FAN, type Squad } from '../src/sim/sim';
import { resolveMoveSpots } from '../src/sim/spots';
import { COMPANY_TOE, companyHeadcount } from '../src/sim/toe';

// Task 14 perf: headless tick-time benchmark at design scale (a full US
// rifle company vs a full German grenadier company, 320x240 map). Sanity
// thresholds only for now — real target is <=5ms mean; Batch 4 tightens
// these once the perf fixes this benchmark is meant to motivate land.
const SANITY_P95_MS = 250;
// order-burst's single measured tick (18 squads worth of astar all fired at
// once) is a one-shot spike, not a percentile over samples — measured
// 245-265ms across reruns, so it gets its own looser sanity ceiling instead
// of straddling (and flaking against) SANITY_P95_MS.
const BURST_SANITY_MS = 1000; // one-shot spike; full-suite CPU contention roughly doubles the isolated ~250-440ms
const SEED = 7;
const MAP_W = 320;
const MAP_H = 240;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function p95(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}
function max(xs: number[]): number {
  return Math.max(...xs);
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface Scenario {
  sim: Sim;
  commander: RedCommander;
  spawns: { west: Vec; east: Vec };
  objectives: Vec[];
  blueSquads: Squad[];
}

// Company vs company set-piece: blue fans out near the west spawn, red mans
// every building plus the road objectives, round-robin.
function buildScenario(seed: number): Scenario {
  const plan = generateMap(seed, MAP_W, MAP_H);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;

  const blueKeys = COMPANY_TOE.us_rifle_co;
  const blueX = plan.spawns.west.x + 7;
  const blueSquads = blueKeys.map((key, i) => {
    const y = 10 + (i / (blueKeys.length - 1)) * (plan.map.h - 20);
    return sim.addSquadFromDef('blue', key, blueX, y);
  });

  const anchors: Vec[] = [...plan.buildings.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })), ...plan.objectives];
  const posts: Record<number, Vec> = {};
  COMPANY_TOE.de_grenadier_co.forEach((key, i) => {
    const anchor = anchors[i % anchors.length];
    const squad = sim.addSquadFromDef('red', key, anchor.x, anchor.y);
    posts[squad.id] = anchor;
  });
  const commander = new RedCommander({ side: 'red', stance: 'defend', posts });

  return { sim, commander, spawns: plan.spawns, objectives: plan.objectives, blueSquads };
}

// buildScenario variant for the 3D/height perf track (plan
// docs/plans/2026-07-23-3d-height-sim §3): red posts anchor ONLY at 2-story
// building centers, so the commander's defend orders auto-garrison a large
// share of the company upstairs (verified: 47/109 red at level 1 after 300
// warmup ticks on seed 7). Exercises level-threaded sight paths and
// stair-climb A* every tick, which set-piece-247 barely touches.
function buildHeightScenario(seed: number): Scenario {
  const plan = generateMap(seed, MAP_W, MAP_H);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;

  const blueKeys = COMPANY_TOE.us_rifle_co;
  const blueX = plan.spawns.west.x + 7;
  const blueSquads = blueKeys.map((key, i) => {
    const y = 10 + (i / (blueKeys.length - 1)) * (plan.map.h - 20);
    return sim.addSquadFromDef('blue', key, blueX, y);
  });

  const twoStory = plan.buildings.filter((b) => plan.map.stories[(b.y + (b.h >> 1)) * plan.map.w + b.x + (b.w >> 1)] === 2);
  const anchors: Vec[] = twoStory.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }));
  const posts: Record<number, Vec> = {};
  COMPANY_TOE.de_grenadier_co.forEach((key, i) => {
    const anchor = anchors[i % anchors.length];
    const squad = sim.addSquadFromDef('red', key, anchor.x, anchor.y);
    posts[squad.id] = anchor;
  });
  const commander = new RedCommander({ side: 'red', stance: 'defend', posts });

  return { sim, commander, spawns: plan.spawns, objectives: plan.objectives, blueSquads };
}

function warmup(sim: Sim, commander: RedCommander, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    commander.update(sim);
    sim.step();
  }
}

// One tick = one commander.update + one sim.step, timed together (that's the
// real per-frame cost). Bucketed by whether the commander's own 150-tick eval
// cadence actually fires this tick (checked before step() advances sim.tick).
function measureTicks(sim: Sim, commander: RedCommander, ticks: number): { all: number[]; evalTicks: number[]; normalTicks: number[] } {
  const all: number[] = [];
  const evalTicks: number[] = [];
  const normalTicks: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const isEval = sim.tick % 150 === 0;
    const t0 = performance.now();
    commander.update(sim);
    sim.step();
    const dt = performance.now() - t0;
    all.push(dt);
    (isEval ? evalTicks : normalTicks).push(dt);
  }
  return { all, evalTicks, normalTicks };
}

function logPerf(name: string, d: { all: number[]; evalTicks: number[]; normalTicks: number[] }, soldiers: number): void {
  const line = {
    mean: round(mean(d.all)),
    p95: round(p95(d.all)),
    max: round(max(d.all)),
    evalMean: d.evalTicks.length ? round(mean(d.evalTicks)) : null,
    normalMean: d.normalTicks.length ? round(mean(d.normalTicks)) : null,
    soldiers,
  };
  console.log(`[perf] ${name} ${JSON.stringify(line)}`);
}

describe('company TOE headcount', () => {
  it('us_rifle_co and de_grenadier_co match the design-scale target (138 vs 109)', () => {
    expect(companyHeadcount(COMPANY_TOE.us_rifle_co)).toBe(138);
    expect(companyHeadcount(COMPANY_TOE.de_grenadier_co)).toBe(109);
  });
});

describe('perf: mapgen validation gate', () => {
  // T1 replaced validate()'s 36 A* calls with three flood fills
  // (docs/plans/2026-07-26-town-gen-design.md D3). Measured on this box before
  // the swap: 'town' 320x240 mean 59.6ms, 'open' 40.9ms; after: 5.3ms / 6.6ms.
  //
  // Two asserts, because neither alone is enough. The first is a RATIO, for the
  // same reason los-micro uses one — absolute ms flap under vitest contention,
  // but the property T1 actually bought is that the gate is O(1) in building
  // count, and that is measurable load-invariantly by re-validating one map
  // with its building list padded 20x. Pre-T1 that padding multiplied the A*
  // count by 20; post-T1 it adds 20x an array lookup.
  const PADDED_MAX_RATIO = 1.5;
  // The second is absolute, with the design's post-T1 budget doubled to absorb
  // full-suite contention. It only fires on a real blowup, and the logged mean
  // is the number to read.
  const GEN_SANITY_MS = 30;

  it('flood-fill gate: mapgen stays inside budget and is flat in building count', () => {
    generateMap(1, MAP_W, MAP_H, 'town'); // JIT warmup: the first call runs ~3x the steady state
    const means: Record<string, number> = {};
    // 'open' left this loop at the mapgen-v3 P3 cutover. GEN_SANITY_MS is a
    // single-pass mean under full-suite contention, calibrated against the
    // legacy blob village at ~3 ms; the organic pipeline costs ~20 ms
    // standalone and 50-90 ms contended, so keeping 'open' here would have
    // made this a contention detector. Every v3 kind has its own min-of-reps
    // budget in the block below, which is where that cost belongs.
    for (const kind of ['town'] as const) {
      const ts: number[] = [];
      for (let seed = 1; seed <= 20; seed++) {
        const t0 = performance.now();
        generateMap(seed, MAP_W, MAP_H, kind);
        ts.push(performance.now() - t0);
      }
      means[kind] = mean(ts);
    }

    const plan = generateMap(SEED, MAP_W, MAP_H, 'town');
    const padded = { ...plan, buildings: Array.from({ length: 20 }, () => plan.buildings).flat() };
    // MIN of the reps, not the mean. The ratio is taken between two ~4 ms
    // measurements, and a mean over five reps carries every scheduler hiccup
    // the rest of the suite throws at it — measured 1.00 standalone and 1.57
    // under a full parallel run of the same code, which trips a 1.5 bound on
    // noise alone. The minimum is the least-contended sample of each side, and
    // an O(n) regression still shows up at ~20x.
    const timeValidate = (p: typeof plan): number => {
      let best = Infinity;
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        expect(validate(p)).toBe(true);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    timeValidate(plan); // warmup
    const bare = timeValidate(plan);
    const fat = timeValidate(padded);

    console.log(
      `[perf] mapgen-gate ${JSON.stringify({
        townMean: round(means.town),
        validateMs: round(bare),
        validate20xBuildingsMs: round(fat),
        ratio: round(fat / bare),
        buildings: plan.buildings.length,
      })}`,
    );
    expect(fat / bare).toBeLessThan(PADDED_MAX_RATIO);
    expect(means.town).toBeLessThan(GEN_SANITY_MS);
  }, 60_000);
});

describe('perf: bourg generation (§5.5)', () => {
  // The whole pipeline, through generateMap, i.e. exactly what bridge.ts:135
  // pays synchronously when the player commits an engagement. §5.5's budget,
  // unmodified — but measured MIN-of-reps per seed, for the same reason the
  // flood-fill gate's ratio is: generateMap is a pure deterministic function of
  // (seed, w, h, kind), so repeating one seed measures nothing but scheduler
  // noise, and the minimum is the least-contended sample. Measured standalone:
  // mean 18.0 / max 31.3 over 200 seeds. Measured as a raw single pass under a
  // full parallel suite: mean 31.8 / max 67.8 — inside the budget, but only
  // 25 % clear of it, which is a flake waiting to happen and would make this
  // test a contention detector rather than a generator-cost gate.
  const BOURG_MEAN_MS = 40;
  const BOURG_MAX_MS = 90;
  const BOURG_REPS = 5;
  // §2.2's gate: "if the measured rate exceeds 5 %, the failing constraint gets
  // relaxed, not the budget raised". Measured 0/200. The hard assert sits at
  // the doc's 15 % so a genuine regression fails CI rather than merely doubling
  // the cost of every battle — a reject is otherwise INVISIBLE from outside,
  // because generateMap just silently pays for another attempt.
  const REJECT_HARD_LIMIT = 0.15;
  const REJECT_SEEDS = 60;

  it('bourg-gen: 320x240 stays inside the 40 ms mean / 90 ms max budget', () => {
    generateMap(1, MAP_W, MAP_H, 'bourg'); // JIT warmup: the first call runs ~3x steady state
    const ts: number[] = [];
    const raw: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < BOURG_REPS; rep++) {
        const t0 = performance.now();
        generateMap(seed, MAP_W, MAP_H, 'bourg');
        const dt = performance.now() - t0;
        if (rep === 0) raw.push(dt);
        best = Math.min(best, dt);
      }
      ts.push(best);
    }
    console.log(
      `[perf] bourg-gen ${JSON.stringify({
        mean: round(mean(ts)),
        p95: round(p95(ts)),
        max: round(max(ts)),
        rawMean: round(mean(raw)),
        rawMax: round(max(raw)),
      })}`,
    );
    expect(mean(ts)).toBeLessThan(BOURG_MEAN_MS);
    expect(max(ts)).toBeLessThan(BOURG_MAX_MS);
  }, 60_000);

  // mapgen-v3 §4's budget for the road kind, unmodified at 30/70. Measured the
  // same way as the bourg above and over the same 200 seeds: mean 19.1 / max
  // 20.6. The design's estimate that road would come out CHEAPER than the bourg
  // is wrong and worth writing down — it runs every stage the bourg runs, and
  // what it saves on a smaller nucleus (fewer plots, fewer footprints) it pays
  // back painting rural fabric over the country the nucleus no longer covers.
  // The two kinds cost the same because they are the same pipeline.
  const ROAD_MEAN_MS = 30;
  const ROAD_MAX_MS = 70;

  it('road-gen: 320x240 stays inside the 30 ms mean / 70 ms max budget', () => {
    generateMap(1, MAP_W, MAP_H, 'road'); // JIT warmup
    const ts: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < BOURG_REPS; rep++) {
        const t0 = performance.now();
        generateMap(seed, MAP_W, MAP_H, 'road');
        best = Math.min(best, performance.now() - t0);
      }
      ts.push(best);
    }
    console.log(`[perf] road-gen ${JSON.stringify({ mean: round(mean(ts)), p95: round(p95(ts)), max: round(max(ts)) })}`);
    expect(mean(ts)).toBeLessThan(ROAD_MEAN_MS);
    expect(max(ts)).toBeLessThan(ROAD_MAX_MS);
  }, 60_000);

  // DEVIATION from mapgen-v3 §4, which budgets `open` at 25 mean / 60 max off
  // an estimate of 10-14 ms. Measured the same way as the two above, over the
  // same 200 seeds: mean 21.8 / p95 22.7 / max 24.3 — against the bourg's 22.0
  // and road's 19.0 on the same box, i.e. §4's estimate is wrong by 55 % and
  // for the third time the reason is the same: every v3 kind runs every stage,
  // and a hamlet spends on rural fabric exactly what it saves on nucleus.
  // `open` in fact pays MORE there than road does — bocage CELL 20 against 22
  // is ~20 % more parcels to own and hedge, and there are twice the farms.
  //
  // 25 would sit 15 % clear of the measurement, where the bourg's budget sits
  // at 1.8x its cost and road's at 1.6x, and a gate that tight is a contention
  // detector rather than a generator-cost gate: measured under a loaded box,
  // open-gen read 61.6 against bourg-gen's 59.9 and road-gen's 47.4, i.e. all
  // three inflate together and only the tightest one fails. So `open` takes
  // the BOURG's budget, because it costs what the bourg costs — 21.8 against
  // 22.0 on the same box, both dominated by the same CCL + BFS + bocage work.
  // Raising a budget a design document set needs saying out loud, and this is
  // that: 40/90, not §4's 25/60, on the evidence above.
  const OPEN_MEAN_MS = 40;
  const OPEN_MAX_MS = 90;

  it('open-gen: 320x240 stays inside the 40 ms mean / 90 ms max budget', () => {
    generateMap(1, MAP_W, MAP_H, 'open'); // JIT warmup
    const ts: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < BOURG_REPS; rep++) {
        const t0 = performance.now();
        generateMap(seed, MAP_W, MAP_H, 'open');
        best = Math.min(best, performance.now() - t0);
      }
      ts.push(best);
    }
    console.log(`[perf] open-gen ${JSON.stringify({ mean: round(mean(ts)), p95: round(p95(ts)), max: round(max(ts)) })}`);
    expect(mean(ts)).toBeLessThan(OPEN_MEAN_MS);
    expect(max(ts)).toBeLessThan(OPEN_MAX_MS);
  }, 60_000);

  // The same DEVIATION from mapgen-v3 §4 as `open` above, which budgets the two
  // together at 25 mean / 60 max. Measured the same way over the same 200
  // seeds: mean 22.1 / p95 23.5 / max 24.2, against open's 22.1, road's 19.2
  // and the bourg's 22.5 on the same box. §4 expected `woods` to be the
  // CHEAPEST kind — it skips most of parcels and footprints — and the stand
  // pass gives all of that back and a little more: 19-26 stands at radius 36-51
  // is the pass that paints most of the map, and it costs about what a bourg's
  // fifty plots cost. Same 40/90 as the bourg, for the same reason: 25 would be
  // a contention detector, not a generator-cost gate.
  const WOODS_MEAN_MS = 40;
  const WOODS_MAX_MS = 90;

  it('woods-gen: 320x240 stays inside the 40 ms mean / 90 ms max budget', () => {
    generateMap(1, MAP_W, MAP_H, 'woods'); // JIT warmup
    const ts: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < BOURG_REPS; rep++) {
        const t0 = performance.now();
        generateMap(seed, MAP_W, MAP_H, 'woods');
        best = Math.min(best, performance.now() - t0);
      }
      ts.push(best);
    }
    console.log(`[perf] woods-gen ${JSON.stringify({ mean: round(mean(ts)), p95: round(p95(ts)), max: round(max(ts)) })}`);
    expect(mean(ts)).toBeLessThan(WOODS_MEAN_MS);
    expect(max(ts)).toBeLessThan(WOODS_MAX_MS);
  }, 60_000);

  // mapgen-v3 §4's budget for the two water kinds, UNMODIFIED at 35/80 — the
  // first §4 generator budget of the chain that survives its own measurement.
  // Measured the same way and over the same 200 seeds: river mean 19.5 / p95
  // 20.7 / max 21.1, bridge 20.5 / 21.6 / 22.4, against the bourg's 23.2 and
  // open's 22.7 on the same box. They are the cheapest v3 kinds after `road`
  // for the reason the others were dearer than §4 expected: the band takes a
  // twentieth of the map out of the bocage grid, the parcel CCL and the stand
  // pass, and every stage downstream of it does less work.
  //
  // 35 sits at 1.7-1.8x the measurement, which is where the bourg's 40 sits
  // against its own 23.2 — so unlike `open` and `woods` this one is a
  // generator-cost gate at the design's own number rather than a contention
  // detector, and it needs no deviation.
  const WATER_MEAN_MS = 35;
  const WATER_MAX_MS = 80;

  for (const kind of ['river', 'bridge'] as const) {
    it(`${kind}-gen: 320x240 stays inside the 35 ms mean / 80 ms max budget`, () => {
      generateMap(1, MAP_W, MAP_H, kind); // JIT warmup
      const ts: number[] = [];
      for (let seed = 1; seed <= 20; seed++) {
        let best = Infinity;
        for (let rep = 0; rep < BOURG_REPS; rep++) {
          const t0 = performance.now();
          generateMap(seed, MAP_W, MAP_H, kind);
          best = Math.min(best, performance.now() - t0);
        }
        ts.push(best);
      }
      console.log(`[perf] ${kind}-gen ${JSON.stringify({ mean: round(mean(ts)), p95: round(p95(ts)), max: round(max(ts)) })}`);
      expect(mean(ts)).toBeLessThan(WATER_MEAN_MS);
      expect(max(ts)).toBeLessThan(WATER_MAX_MS);
    }, 60_000);
  }

  for (const [kind, profile] of [
    ['river', RIVER],
    ['bridge', BRIDGE],
  ] as const) {
    it(`${kind}-reject: the first attempt validates on essentially every seed`, () => {
      // Two gates can reject a water map and neither exists on a dry kind: the
      // attempt is thrown away when the deck came out empty (no crossing at
      // all), and validate's west→east vehicle route has to run over that deck
      // because water is the one terrain no vehicle can enter. So this number
      // is the reject rate AND the statement that the crossing works — 0/200
      // rejects, with the minBuildings floor and the empty-deck guard each
      // firing 0 times.
      let rejects = 0;
      let floorHits = 0;
      let noDeck = 0;
      const rejected: number[] = [];
      for (let seed = 1; seed <= REJECT_SEEDS; seed++) {
        const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
        const plan = planBourg(base, MAP_W, MAP_H, profile);
        if (plan.fp.buildings.length < profile.minBuildings) {
          floorHits++;
          rejects++;
          rejected.push(seed);
          continue;
        }
        const map = new GameMap(MAP_W, MAP_H);
        const st = stampBourg(map, plan);
        map.maxStories = st.maxStories;
        if (!st.crossing) {
          noDeck++;
          rejects++;
          rejected.push(seed);
          continue;
        }
        const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
        objectives.push(st.crossing);
        objectiveKinds.push('bridge');
        if (!validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands })) {
          rejects++;
          rejected.push(seed);
        }
      }
      console.log(`[perf] ${kind}-reject ${JSON.stringify({ rejects, floorHits, noDeck, seeds: REJECT_SEEDS, rate: round(rejects / REJECT_SEEDS), rejected })}`);
      expect(rejects / REJECT_SEEDS).toBeLessThan(REJECT_HARD_LIMIT);
    }, 120_000);
  }

  it('woods-reject: the first attempt validates on essentially every seed', () => {
    // The interesting gate on this kind is validate's vehicle route: 'woods' is
    // noVehicle and covers 41-70 % of the map, so if the stand pass could paint
    // over the arterial, west→east would fail here rather than in the game. It
    // cannot — stands only plant on 'grass' and the road bitmap is carved
    // first — and 0/200 rejects with the minBuildings floor firing 0 times is
    // what that looks like from outside.
    let rejects = 0;
    let floorHits = 0;
    const rejected: number[] = [];
    for (let seed = 1; seed <= REJECT_SEEDS; seed++) {
      const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
      const plan = planBourg(base, MAP_W, MAP_H, WOODS);
      if (plan.fp.buildings.length < WOODS.minBuildings) {
        floorHits++;
        rejects++;
        rejected.push(seed);
        continue;
      }
      const map = new GameMap(MAP_W, MAP_H);
      const st = stampBourg(map, plan);
      map.maxStories = st.maxStories;
      const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
      if (!validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands })) {
        rejects++;
        rejected.push(seed);
      }
    }
    console.log(`[perf] woods-reject ${JSON.stringify({ rejects, floorHits, seeds: REJECT_SEEDS, rate: round(rejects / REJECT_SEEDS), rejected })}`);
    expect(rejects / REJECT_SEEDS).toBeLessThan(REJECT_HARD_LIMIT);
  }, 120_000);

  it('open-reject: the first attempt validates on essentially every seed', () => {
    // The bourg's gate on the open profile, plus the one gate open adds:
    // KindProfile.minBuildings rerolls an attempt that placed under four
    // buildings, so it is counted here and not left to look like a validate()
    // failure. Measured 0/200 rejects with the floor firing 0 times — a
    // carrefour hamlet with 4-6 farms round it clears four buildings by a wide
    // margin, and the floor is the guarantee rather than the mechanism.
    let rejects = 0;
    let floorHits = 0;
    const rejected: number[] = [];
    for (let seed = 1; seed <= REJECT_SEEDS; seed++) {
      const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
      const plan = planBourg(base, MAP_W, MAP_H, OPEN);
      if (plan.fp.buildings.length < OPEN.minBuildings) {
        floorHits++;
        rejects++;
        rejected.push(seed);
        continue;
      }
      const map = new GameMap(MAP_W, MAP_H);
      const st = stampBourg(map, plan);
      map.maxStories = st.maxStories;
      const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
      if (!validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands })) {
        rejects++;
        rejected.push(seed);
      }
    }
    console.log(`[perf] open-reject ${JSON.stringify({ rejects, floorHits, seeds: REJECT_SEEDS, rate: round(rejects / REJECT_SEEDS), rejected })}`);
    expect(rejects / REJECT_SEEDS).toBeLessThan(REJECT_HARD_LIMIT);
  }, 120_000);

  it('road-reject: the first attempt validates on essentially every seed', () => {
    // The bourg's gate, on the road profile. Measured 0/200 — the ribbon
    // envelope never strands a spawn, because the arterial IS the rue.
    let rejects = 0;
    const rejected: number[] = [];
    for (let seed = 1; seed <= REJECT_SEEDS; seed++) {
      const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
      const plan = planBourg(base, MAP_W, MAP_H, ROAD);
      const map = new GameMap(MAP_W, MAP_H);
      const st = stampBourg(map, plan);
      map.maxStories = st.maxStories;
      const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
      if (!validate({ map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands })) {
        rejects++;
        rejected.push(seed);
      }
    }
    console.log(`[perf] road-reject ${JSON.stringify({ rejects, seeds: REJECT_SEEDS, rate: round(rejects / REJECT_SEEDS), rejected })}`);
    expect(rejects / REJECT_SEEDS).toBeLessThan(REJECT_HARD_LIMIT);
  }, 120_000);

  it('bourg-reject: the first attempt validates on essentially every seed', () => {
    // generateMap's attempt-0 rng, reproduced (mapgen.ts:131) so the verdict of
    // the FIRST attempt is observable at all. The replay is self-checking: if
    // the seeding here ever drifts from mapgen's, the fidelity assertion below
    // fails loudly instead of the rate quietly becoming meaningless.
    const attempt0 = (seed: number): MapPlan => {
      const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
      const plan = planBourg(base, MAP_W, MAP_H, BOURG);
      const map = new GameMap(MAP_W, MAP_H);
      const st = stampBourg(map, plan);
      map.maxStories = st.maxStories;
      const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
      return { map, buildings: plan.fp.buildings, spawns: plan.spawns, objectives, objectiveKinds, woodsStands: st.woodsStands };
    };
    // `relief: 'none'`, because the replay above stops where T11's pipeline
    // stops: V3's relief stage runs after it and can append a halt to the
    // building list. The reject rate measured below is therefore the
    // pre-relief plan's, which is the right thing to measure — relief cannot
    // sever the vehicle route (it reverts the embankment if it would) and the
    // halt only lands on ground it has already proved clear.
    for (const seed of [1, 7])
      expect(attempt0(seed).buildings).toEqual(generateMap(seed, MAP_W, MAP_H, 'bourg', { relief: 'none' }).buildings);

    let rejects = 0;
    const rejected: number[] = [];
    for (let seed = 1; seed <= REJECT_SEEDS; seed++)
      if (!validate(attempt0(seed))) {
        rejects++;
        rejected.push(seed);
      }
    console.log(`[perf] bourg-reject ${JSON.stringify({ rejects, seeds: REJECT_SEEDS, rate: round(rejects / REJECT_SEEDS), rejected })}`);
    expect(rejects / REJECT_SEEDS).toBeLessThan(REJECT_HARD_LIMIT);
  }, 120_000);

  it('bourg-patches: PatchIndex construction is still O(w·h), not O(buildings)', () => {
    // T13's second half. A bourg is the same 76,800 tiles as a 'town' with ~3x
    // the buildings, so a construction cost that tracks the building list shows
    // up here as a ratio and nowhere else — and PatchIndex is built once per
    // battle load, on the same synchronous path as the generator.
    const best = (map: GameMap): number => {
      let b = Infinity;
      for (let i = 0; i < 9; i++) {
        const t0 = performance.now();
        new PatchIndex(map);
        b = Math.min(b, performance.now() - t0);
      }
      return b;
    };
    const townPlan = generateMap(SEED, MAP_W, MAP_H, 'town');
    const bourgPlan = generateMap(SEED, MAP_W, MAP_H, 'bourg');
    best(townPlan.map); // warmup
    const townMs = best(townPlan.map);
    const bourgMs = best(bourgPlan.map);
    console.log(
      `[perf] bourg-patches ${JSON.stringify({
        townMs: round(townMs),
        bourgMs: round(bourgMs),
        ratio: round(bourgMs / townMs),
        townBuildings: townPlan.buildings.length,
        bourgBuildings: bourgPlan.buildings.length,
      })}`,
    );
    // min-of-reps on both sides, as the flood-fill gate's ratio does; measured
    // 1.08 with 21 vs 55 buildings, and an O(n²) regression is orders out
    expect(bourgMs / townMs).toBeLessThan(2);
  }, 60_000);
});

// I12 · interiors §6.5. The pass runs synchronously inside `generateMap` on the
// same click that stages a battle (bridge.ts), so its cost is battle-load
// latency, not frame time.
//
// TWO THINGS THIS FILE'S READER NEEDS TO KNOW BEFORE ARGUING WITH THE NUMBERS.
//
// 1. VITEST IS A DEV BUILD. `import.meta.env.DEV` is true here and false in
//    `vite build`, so every measurement below INCLUDES §4.2's post-pass
//    assertion (one connectivity BFS per exterior door per structure), which
//    the shipped bundle does not pay. Measured on a 320x240 bourg, min-of-reps
//    over 10 seeds, warm: 3.99 ms with the assertion, 2.91 ms with it stripped.
//    The design's 4 ms budget is a production budget and the shipped path meets
//    it; what runs in CI is the 4 ms path.
// 2. THE CEILINGS ARE CONTENTION CEILINGS, NOT BUDGETS. Isolated, min-of-reps:
//    0.59 ms mean / 1.01 ms max on 160x120 'open', 0.99 / 1.16 on 160x120
//    'town', 3.25 / 3.93 on a 45-building 320x240 bourg. The whole-suite
//    contention factor this file has already measured for generateMap is ~1.8x
//    (bourg-gen's comment: 18.0 standalone → 31.8 under load), so the asserts
//    sit at roughly 2.5x the isolated mean. The console line is the real
//    regression signal; the assert is the tripwire for a 3x blow-up.
describe('perf: interiors furnishing (§6.5)', () => {
  const FURN_SMALL_MS = 3; // design budget 1.5 at 160x120; measured 0.6-1.0
  const FURN_BOURG_MS = 9; // design budget 4.0 at 320x240 bourg; measured 3.2-4.0
  const FURN_REPS = 6;

  // Times the pass ALONE, on an already-generated map, which is the only way to
  // see it: as a delta between two `generateMap` calls it is inside the noise
  // of the generator it is a tenth of.
  function furnishCost(kind: 'open' | 'town' | 'bourg', w: number, h: number, seeds: number): number[] {
    // V8 needs more than one pass over ~2,000 lines of cold partitioner before
    // it tiers up: a single warmup call measures 27 ms/map on a bourg and 4 ms
    // once warm. Six is empirically past the knee.
    for (let r = 0; r < 6; r++) {
      const p = generateMap(r + 1, w, h, kind);
      furnishInteriors(p.map, p.buildings, 99, p.objectives[0]);
    }
    const out: number[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < FURN_REPS; rep++) {
        // A fresh map every rep: the pass is not byte-idempotent (D11's rear
        // door is an envelope edge it never takes back), so re-furnishing the
        // same map would measure run 2, which is a different and cheaper job.
        const p = generateMap(seed, w, h, kind);
        const t0 = performance.now();
        furnishInteriors(p.map, p.buildings, 12345, p.objectives[0]);
        best = Math.min(best, performance.now() - t0);
      }
      out.push(best);
    }
    return out;
  }

  it('furnish-cost: the pass stays inside its budget on 160x120 and on a 45-building bourg', () => {
    const open = furnishCost('open', 160, 120, 20);
    const town = furnishCost('town', 160, 120, 20);
    const bourg = furnishCost('bourg', MAP_W, MAP_H, 10);
    console.log(
      `[perf] furnish-cost ${JSON.stringify({
        openMean: round(mean(open)),
        openMax: round(max(open)),
        townMean: round(mean(town)),
        townMax: round(max(town)),
        bourgMean: round(mean(bourg)),
        bourgMax: round(max(bourg)),
      })}`,
    );
    expect(mean(open)).toBeLessThan(FURN_SMALL_MS);
    expect(mean(town)).toBeLessThan(FURN_SMALL_MS);
    expect(mean(bourg)).toBeLessThan(FURN_BOURG_MS);
  }, 120_000);

  // The assertion that actually matters, because it is what bridge.ts pays:
  // the WHOLE furnished pipeline against the bourg generator's existing budget.
  // §6.5 predicted ~19 ms/attempt → ~23 ms; the budget is 40/90 and has room.
  it('furnish-gen: a furnished 320x240 bourg still fits the 40 ms mean / 90 ms max budget', () => {
    for (let r = 0; r < 4; r++) generateMap(r + 1, MAP_W, MAP_H, 'bourg', { interiors: true }); // JIT warmup
    const ts: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      let best = Infinity;
      for (let rep = 0; rep < 5; rep++) {
        const t0 = performance.now();
        generateMap(seed, MAP_W, MAP_H, 'bourg', { interiors: true });
        best = Math.min(best, performance.now() - t0);
      }
      ts.push(best);
    }
    console.log(`[perf] furnish-gen ${JSON.stringify({ mean: round(mean(ts)), p95: round(p95(ts)), max: round(max(ts)) })}`);
    expect(mean(ts)).toBeLessThan(40);
    expect(max(ts)).toBeLessThan(90);
  }, 120_000);
});

describe('perf: los micro-benchmark', () => {
  // Isolates los()'s constant factor from whole-tick noise so the 3D plan's
  // slab-LOS step can't hide a regression inside SANITY_P95_MS's headroom
  // (docs/plans/2026-07-23-3d-height-sim §3). 10k los() calls between building
  // tiles of the 16-building seed-7 map, observer/target levels mixed 0..2.
  //
  // Measured baseline (pre-slab-LOS, M-series dev box, 2026-07-23): 8.2ms
  // median of 5 reps; post-slab-LOS 11.8ms (1.44x, pinned at commit 808571b).
  // Absolute-ms asserts flap hopelessly on this shared box (same code: 12ms
  // quiet standalone, 31ms under load-4.5, 70-800ms inside contended vitest),
  // so the assert is a RATIO: same-process 10k-call runs on the building map
  // (slab path, mixed levels) vs a flat all-grass map (legacy path,
  // maxStories=0). Both suffer identical contention, so the ratio is
  // load-invariant. Pinned ratio ~0.64 (building-map rays block early on
  // walls — SHORTER traversals than unobstructed flat-map rays), so 2.5x is
  // a generous tripwire that only fires on a real slab-path blowup.
  const LOS_MICRO_MAX_RATIO = 2.5;
  it('los-micro: 10k mixed-level los() calls on a building-heavy map', () => {
    const plan = generateMap(SEED, MAP_W, MAP_H);
    const m = plan.map;
    const flat = new GameMap(MAP_W, MAP_H);
    const bldg: number[] = [];
    for (let i = 0; i < m.stories.length; i++) if (m.buildingId[i] >= 0) bldg.push(i);
    let acc = 0;
    const run = (): number => {
      const t0 = performance.now();
      for (let i = 0; i < 10_000; i++) {
        const a = bldg[(i * 37) % bldg.length];
        const b = bldg[(i * 91 + 13) % bldg.length];
        const r = los(
          m,
          (a % m.w) + 0.5,
          Math.floor(a / m.w) + 0.5,
          (b % m.w) + 0.5,
          Math.floor(b / m.w) + 0.5,
          i % (m.maxStories + 1),
          (i >> 1) % (m.maxStories + 1),
        );
        acc += r.conceal;
      }
      return performance.now() - t0;
    };
    const runFlat = (): number => {
      const t0 = performance.now();
      for (let i = 0; i < 10_000; i++) {
        const a = bldg[(i * 37) % bldg.length];
        const b = bldg[(i * 91 + 13) % bldg.length];
        const r = los(
          flat,
          (a % flat.w) + 0.5,
          Math.floor(a / flat.w) + 0.5,
          (b % flat.w) + 0.5,
          Math.floor(b / flat.w) + 0.5,
          i % (flat.maxStories + 1),
          (i >> 1) % (flat.maxStories + 1),
        );
        acc += r.conceal;
      }
      return performance.now() - t0;
    };
    run(); runFlat(); // JIT warmup, untimed
    const reps = [run(), run(), run(), run(), run()].sort((x, y) => x - y);
    const flatReps = [runFlat(), runFlat(), runFlat(), runFlat(), runFlat()].sort((x, y) => x - y);
    const median = reps[2];
    const ratio = reps[2] / flatReps[2];
    console.log(`[perf] los-micro ${JSON.stringify({ medianMs: round(median), flatMs: round(flatReps[2]), ratio: round(ratio), calls: 10_000, buildingTiles: bldg.length, acc: round(acc) })}`);
    expect(ratio).toBeLessThan(LOS_MICRO_MAX_RATIO);
  }, 60_000);

  // V11's smoke arm. The aged column is O(1) per puff with a hard instruction
  // bound — one projection for the cheap reject, one more for the surviving
  // few, and everything age-dependent (h, r, r2max) precomputed once per tick
  // in stepSmoke, never per ray. Same load-invariant ratio shape as above:
  // 10k sightBetween calls through a 12-puff screen of mixed ages against the
  // identical calls with sim.smoke = [].
  it('los-micro: 10k sightBetween calls through a 12-puff mixed-age screen', () => {
    const sim = new Sim(new GameMap(MAP_W, MAP_H), SEED);
    const puffs = Array.from({ length: 12 }, (_, i) =>
      smokePuff(60 + (i % 4) * 6, 40 + Math.floor(i / 4) * 6, 0, 60, (i % 6 === 5 ? 1 : 0) as 0 | 1, i * 5),
    );
    let acc = 0;
    const run = (smoke: boolean): number => {
      sim.smoke = smoke ? puffs : [];
      const t0 = performance.now();
      for (let i = 0; i < 10_000; i++) {
        const r = sightBetween(sim, 20.5 + (i % 17), 20.5 + (i % 13), 100.5 - (i % 19), 60.5 + (i % 11));
        acc += r.conceal;
      }
      return performance.now() - t0;
    };
    run(true); run(false); // JIT warmup, untimed
    const smokeReps = [run(true), run(true), run(true), run(true), run(true)].sort((x, y) => x - y);
    const bareReps = [run(false), run(false), run(false), run(false), run(false)].sort((x, y) => x - y);
    const ratio = smokeReps[2] / bareReps[2];
    console.log(`[perf] los-micro-smoke ${JSON.stringify({ smokeMs: round(smokeReps[2]), bareMs: round(bareReps[2]), ratio: round(ratio), puffs: puffs.length, acc: round(acc) })}`);
    expect(ratio).toBeLessThan(LOS_MICRO_MAX_RATIO);
  }, 60_000);
});

describe('perf: design-scale tick time', () => {
  it('set-piece-247: company vs company, both dug in / settling', () => {
    const { sim, commander } = buildScenario(SEED);
    warmup(sim, commander, 300);
    const d = measureTicks(sim, commander, 600);
    logPerf('set-piece-247', d, sim.soldiers.length);
    expect(p95(d.all)).toBeLessThan(SANITY_P95_MS);
  }, 120_000);

  it('order-burst: one tick issuing a move order to every blue squad', () => {
    const { sim, commander, spawns, objectives, blueSquads } = buildScenario(SEED);
    warmup(sim, commander, 300);

    const far = objectives.reduce((a, o) =>
      Math.hypot(o.x - spawns.west.x, o.y - spawns.west.y) > Math.hypot(a.x - spawns.west.x, a.y - spawns.west.y) ? o : a,
    );
    const burstStart = performance.now();
    for (const squad of blueSquads) sim.orderSquad(squad.id, { kind: 'move', x: far.x, y: far.y });
    commander.update(sim);
    sim.step();
    const burstMs = performance.now() - burstStart;

    const follow = measureTicks(sim, commander, 60);
    console.log(`[perf] order-burst ${JSON.stringify({ burstMs: round(burstMs), followMean: round(mean(follow.all)), followP95: round(p95(follow.all)), soldiers: sim.soldiers.length })}`);
    expect(burstMs).toBeLessThan(BURST_SANITY_MS);
    expect(p95(follow.all)).toBeLessThan(SANITY_P95_MS);
  }, 120_000);

  it('height-stress: red garrisoned upstairs in 2-story buildings', () => {
    const { sim, commander } = buildHeightScenario(SEED);
    warmup(sim, commander, 300);
    // Scenario validity: the defend auto-garrison must actually have put red
    // upstairs, or this benchmark exercises nothing new.
    expect(sim.soldiers.some((s) => s.side === 'red' && s.level === 1)).toBe(true);
    const d = measureTicks(sim, commander, 600);
    logPerf('height-stress', d, sim.soldiers.length);
    // Budget: same SANITY_P95_MS as the flat set-piece — level-threaded sight
    // adds compares, not new traversals, so this should land within a few
    // percent of set-piece-247. Tighten only after two green runs (plan §3).
    expect(p95(d.all)).toBeLessThan(SANITY_P95_MS);
  }, 120_000);

  it('ambush-settle: red dug in at its posts, blue never ordered', () => {
    const { sim, commander } = buildScenario(SEED);
    warmup(sim, commander, 900);
    const d = measureTicks(sim, commander, 600);
    logPerf('ambush-settle', d, sim.soldiers.length);
    expect(p95(d.all)).toBeLessThan(SANITY_P95_MS);
  }, 120_000);

  it('night-settle: the 02:00 set piece stays inside the same tick budget', () => {
    // Sim half of the N14 night-cost claim: the night rules are threshold
    // compares plus a per-tick light memo, and the spotting sweep
    // short-circuits on a 25 m cap instead of 200 m — night ticks must fit
    // the same budget as set-piece-247, with zero night-specific machinery.
    // (The RENDER half — night frames not slower than day, sun-step drain —
    // is asserted browser-side in scripts/bake.mjs, where frames exist.
    // A cross-scenario day-vs-night tick-time compare is deliberately not
    // asserted here: the two runs diverge behaviourally, so it would pin
    // scheduler noise, not the mechanism.)
    const { sim, commander } = buildScenario(SEED);
    sim.startMin = 2 * 60;
    warmup(sim, commander, 300);
    const d = measureTicks(sim, commander, 600);
    logPerf('night-settle', d, sim.soldiers.length);
    expect(sim.light).toBe(0); // guard: this really is the dark case
    expect(p95(d.all)).toBeLessThan(SANITY_P95_MS);
  }, 120_000);
});

describe('perf: move-spot resolver (movement design §3.3)', () => {
  // The preview recomputes every selected team's spots on any cursor/selection
  // change (overlays.ts previewMoveSpots, memoized per tick), so a select-all
  // drag pays this on the mousemove path. §3.3 budgets one full company
  // recompute at "well under 0.5 ms"; M4 measured 0.83 ms in-browser for 18
  // squads / 138 men / 27 teams.
  //
  // Budgeted absolute rather than as a ratio: unlike los-micro there is no
  // second implementation to divide by, and min-of-reps (the furnish-cost
  // idiom) already strips the contention spikes that make small absolute
  // numbers flap. Measured standalone on this box, seed 7, 27 teams / 137
  // movers: mean 1.20 ms, max 1.28 ms. The 5x ceiling matches what
  // GEN_SANITY_MS allows itself, and only fires on a real algorithmic
  // regression — an unbounded ring, a per-tile allocation — not a loaded box.
  const RESOLVER_COMPANY_MS = 6;

  // One select-all preview: every team of every blue squad, each with its own
  // `used` set, anchored exactly as orderSquad's legacy y-axis fan places them
  // (sim.ts orderSquad). Same call pattern the overlay runs, resolver only —
  // no dangerScore raycasts, no canvas.
  function recompute(sim: Sim, squads: Squad[], x: number, y: number): number {
    let spots = 0;
    for (const squad of squads) {
      const offs = fanOffsets(squad.teamIds.length, TEAM_FAN);
      squad.teamIds.forEach((teamId, ti) => {
        const ids = sim.teams[teamId].soldierIds.filter((id) => eligible(sim.soldiers[id]));
        if (ids.length === 0) return;
        spots += resolveMoveSpots(sim, { soldierIds: ids, x, y: y + offs[ti], kind: 'move' }, new Set<number>()).length;
      });
    }
    return spots;
  }

  it('resolver-company: one select-all recompute for a full rifle company', () => {
    const { sim, commander, spawns, objectives, blueSquads } = buildScenario(SEED);
    warmup(sim, commander, 300);
    const far = objectives.reduce((a, o) =>
      Math.hypot(o.x - spawns.west.x, o.y - spawns.west.y) > Math.hypot(a.x - spawns.west.x, a.y - spawns.west.y) ? o : a,
    );

    // Scenario validity: this has to be the design-scale select-all the budget
    // is about, not a handful of survivors.
    const teams = blueSquads.reduce((a, s) => a + s.teamIds.length, 0);
    const movers = blueSquads.reduce((a, s) => a + s.soldierIds.filter((id) => eligible(sim.soldiers[id])).length, 0);
    expect(teams).toBeGreaterThanOrEqual(20);
    expect(movers).toBeGreaterThanOrEqual(120);

    for (let r = 0; r < 8; r++) recompute(sim, blueSquads, far.x, far.y); // JIT warmup, untimed

    // The cursor moves a tile each sample: a still cursor is the memoized case
    // the overlay never recomputes, so measuring it would flatter the budget.
    const ts: number[] = [];
    let placed = 0;
    for (let sample = 0; sample < 12; sample++) {
      let best = Infinity;
      for (let rep = 0; rep < 5; rep++) {
        const t0 = performance.now();
        placed = recompute(sim, blueSquads, far.x + sample, far.y);
        best = Math.min(best, performance.now() - t0);
      }
      ts.push(best);
    }
    console.log(`[perf] resolver-company ${JSON.stringify({ mean: round(mean(ts)), max: round(max(ts)), teams, movers, placed })}`);
    expect(mean(ts)).toBeLessThan(RESOLVER_COMPANY_MS);
    expect(max(ts)).toBeLessThan(RESOLVER_COMPANY_MS * 2);
  }, 120_000);
});
