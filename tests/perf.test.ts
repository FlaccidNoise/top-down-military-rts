import { describe, expect, it } from 'vitest';
import { RedCommander } from '../src/sim/ai';
import { generateMap, type Vec } from '../src/sim/mapgen';
import { Sim, type Squad } from '../src/sim/sim';
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
  const commander = new RedCommander({ stance: 'defend', posts });

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

  it('ambush-settle: red dug in at its posts, blue never ordered', () => {
    const { sim, commander } = buildScenario(SEED);
    warmup(sim, commander, 900);
    const d = measureTicks(sim, commander, 600);
    logPerf('ambush-settle', d, sim.soldiers.length);
    expect(p95(d.all)).toBeLessThan(SANITY_P95_MS);
  }, 120_000);
});
