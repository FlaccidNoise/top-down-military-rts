import { describe, expect, it } from 'vitest';
import { advanceDays, fillReplacements, newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeHeadlessWorld, runHeadlessWar } from '../src/strategic/headless';
import { makeTheater } from '../src/strategic/theatergen';
import { makeDisposition } from '../src/strategic/theatergen/disposition';
import { makeWarGoals, warStatus, type WarState } from '../src/strategic/goals';
import { OmniscientIntel } from '../src/strategic/intel';
import { articulationNodes, BLUE_V2, Commander2, RED_V2 } from '../src/strategic/planner';
import { addForce, type FrontV2 } from '../src/strategic/theater/force';
import { stepWar } from '../src/strategic/theater/war';
import { syncStrengthsV2 } from '../src/strategic/theater/sync';

const CFG = DEFAULT_PRESET.theater;
const CAMP = DEFAULT_PRESET.campaign;

interface WarResult {
  status: WarState;
  day: number;
  battles: number;
  redAttackOrders: number;
  redRetookObjective: boolean;
  stallMinutes: number;
  tuple: string;
}

function runWar(seed: number, maxDays = CAMP.warDays + 1): WarResult {
  const { theater, initialControlByNode } = makeTheater(seed, CFG);
  const campaign = newCampaign(seed, CAMP.blueCompanies);
  const spec = presetSpec(DEFAULT_PRESET, seed);
  const d = makeDisposition(theater, CAMP, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
  const front: FrontV2 = {
    theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
    controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
  };
  for (const f of d.forces) addForce(front, f);
  const goals = makeWarGoals(theater, CAMP);
  const red = new Commander2('red', RED_V2, goals, CAMP.warDays);
  const blue = new Commander2('blue', BLUE_V2, goals, CAMP.warDays);
  const redIntel = new OmniscientIntel(front, 'red');
  const blueIntel = new OmniscientIntel(front, 'blue');

  const blueObjectiveBaseline = new Set(
    theater.objectiveNodes.filter((n) => initialControlByNode[n] === 'blue'),
  );
  void blueObjectiveBaseline;
  let battles = 0;
  let redAttackOrders = 0;
  let redRetookObjective = false;
  let stallMinutes = 0;
  let prevDay = front.day;
  let status: WarState = { state: 'ongoing' };
  const everBlue = new Set<number>();

  for (let m = 0; m < maxDays * 1440 && status.state === 'ongoing'; m++) {
    const rr = red.evaluate(front, redIntel);
    const br = blue.evaluate(front, blueIntel);
    if (rr) redAttackOrders += rr.orders.filter((o) => o.why === 'attack').length;
    if ((rr && rr.stall) || (br && br.stall)) stallMinutes += RED_V2.evalMinutes;
    const r = stepWar(front, campaign);
    battles += r.resolved.length;
    for (const n of theater.objectiveNodes) {
      if (front.controlByNode[n] === 'blue') everBlue.add(n);
      else if (everBlue.has(n) && front.controlByNode[n] === 'red') redRetookObjective = true;
    }
    if (front.day > prevDay) {
      advanceDays(campaign, front.day - prevDay);
      if (front.day % 2 === 0) fillReplacements(campaign, front.day * 31 + 7, 12);
      syncStrengthsV2(campaign, front);
      prevDay = front.day;
    }
    status = warStatus(front, goals);
  }
  return {
    status, day: front.day, battles, redAttackOrders, redRetookObjective, stallMinutes,
    tuple: `${status.state === 'decided' ? status.winner : 'ongoing'}:${front.day}:${battles}:${campaign.log.length}`,
  };
}

describe('goal-driven AI, headless wars over generated theaters', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = SEEDS.map((s) => runWar(s));

  it('100% termination: every war decides by the deadline', () => {
    for (let i = 0; i < SEEDS.length; i++) {
      expect(results[i].status.state, `seed ${SEEDS[i]} (day ${results[i].day})`).toBe('decided');
    }
  });

  it('outcome variety: both winners occur, >1 distinct tuple', () => {
    const winners = new Set(results.map((r) => (r.status.state === 'decided' ? r.status.winner : 'none')));
    expect(winners.has('blue') || winners.has('red')).toBe(true);
    expect(winners.size).toBeGreaterThanOrEqual(2);
    expect(new Set(results.map((r) => r.tuple)).size).toBeGreaterThan(1);
  });

  it('wars are fought, not walked: battles occur on every seed', () => {
    for (let i = 0; i < SEEDS.length; i++) {
      expect(results[i].battles, `seed ${SEEDS[i]}`).toBeGreaterThan(0);
    }
  });

  it('red actively attacks: a blue-held objective falls to red on a majority of seeds (§4.7)', () => {
    // The doc's gate. Raw attack-order counts undercount red initiative:
    // most counterattacks land as advances into ground blue vacated, and the
    // RETAKE is the observable that matters (baseline: zero on every seed).
    const retaking = results.filter((r) => r.redRetookObjective).length;
    expect(retaking).toBeGreaterThanOrEqual(Math.ceil(SEEDS.length / 2));
  });

  it('the same seed replays the same war bit-for-bit', () => {
    expect(runWar(3).tuple).toBe(runWar(3).tuple);
    expect(runWar(5).tuple).toBe(runWar(5).tuple);
  });

  it('report: aggression + stalls (owner-facing numbers, not a pass/fail)', () => {
    const lines = results.map((r, i) =>
      `seed ${SEEDS[i]}: ${r.tuple} redAtk ${r.redAttackOrders} retook ${r.redRetookObjective} stallMin ${r.stallMinutes}`,
    );
    console.log(lines.join('\n'));
    expect(lines.length).toBe(SEEDS.length);
  });
});

describe('the planner neither dithers nor grinds (jtbug #762)', () => {
  // The two regressions the mid-road turn-round exposed, held as properties
  // of the 16 pin wars. Measured at 31cc59b: up to 86 mid-march reversals in
  // one war, AI blue destroyed before the deadline on 5 of 16 seeds.
  // The destroyed bound is the jtbug #786 target (at most 2 of 16). It was 1
  // while red was inert: a red that sorties and counterattacks finishes a
  // company that attacks at bad odds and stays within reach.
  it('single-digit mid-march reversals in every war; blue destroyed on at most two seeds', () => {
    const reversals: number[] = [];
    let destroyed = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const w = makeHeadlessWorld(seed, CFG, CAMP);
      const last = new Map<number, { edgeId: number; dir: number; free: boolean } | null>();
      let n = 0;
      const run = runHeadlessWar(w, 60 * 24 * 45, () => {
        for (const f of w.front.forces) {
          const p = last.get(f.id);
          const marching = f.pos.kind === 'edge' && f.path.length > 0;
          if (p && p.free && marching && f.pos.kind === 'edge' && p.edgeId === f.pos.edgeId && p.dir !== f.pos.dir) n++;
          last.set(f.id, marching && f.pos.kind === 'edge' ? { edgeId: f.pos.edgeId, dir: f.pos.dir, free: f.engagedIn === null } : null);
        }
      });
      reversals.push(n);
      if (run.status.state === 'decided' && run.status.winner === 'red' && run.day <= CAMP.warDays) destroyed++;
    }
    expect(Math.max(...reversals), `reversals per seed: ${reversals}`).toBeLessThan(10);
    expect(destroyed).toBeLessThanOrEqual(2);
  }, 30_000);
});

describe('planner internals', () => {
  it('articulation nodes: a corridor graph names its cut vertex', () => {
    const { theater } = makeTheater(1, CFG);
    const cuts = articulationNodes(theater);
    expect(cuts.size).toBeGreaterThan(0);
    for (const c of cuts) expect(theater.nodes[c]).toBeDefined();
  });

  it('a garrison is ordered only to sortie and to come home', () => {
    const seed = 2;
    const { theater, initialControlByNode } = makeTheater(seed, CFG);
    const campaign = newCampaign(seed, CAMP.blueCompanies);
    const spec = presetSpec(DEFAULT_PRESET, seed);
    const d = makeDisposition(theater, CAMP, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
    const front: FrontV2 = {
      theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
      controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
    };
    for (const f of d.forces) addForce(front, f);
    const goals = makeWarGoals(theater, CAMP);
    const red = new Commander2('red', RED_V2, goals, CAMP.warDays);
    const garrisonIds = new Set(front.forces.filter((f) => f.role === 'garrison').map((f) => f.id));
    for (let m = 0; m < 1440; m++) {
      front.clockMin++;
      const r = red.evaluate(front, new OmniscientIntel(front, 'red'));
      if (r) for (const o of r.orders) if (garrisonIds.has(o.forceId)) expect(['sortie', 'return'], `garrison ${o.forceId} ordered to ${o.dest}`).toContain(o.why);
    }
  });
});
