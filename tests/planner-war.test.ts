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
  const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1); // the pin set: eight seeds can all fall one way
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
  // The destroyed bound was the jtbug #786 target (at most 2 of 16) while the
  // default preset fielded two red battlegroups. By the owner's call for a
  // red that attacks (2026-10-11, jtbug #797 and #799) it fields five on the
  // calibrated battle math, and from the second day it crosses the line for
  // a company near its ground. AI blue is destroyed on 11 of these 16 seeds
  // under fog and 13 with full knowledge (15 of 32 under fog: these sixteen
  // run against blue). The bounds are those counts and one more: they hold
  // the planner where it was measured, they are not a design target.
  //
  // A march, once ordered, is finished: only the withdraw arm turns a force
  // round. So every mid-road turn-round must come with a withdraw order, in
  // either intel mode. With full knowledge they are also few. Under fog they
  // are not held to a count: a company that marches blind and finds a garrison
  // inside threat range turns back, and that is the fog working, not dither.
  const turnRounds = (recon: 'omniscient' | 'contacts'): { most: number; unexplained: number; destroyed: number; per: number[] } => {
    const per: number[] = [];
    let unexplained = 0;
    let destroyed = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const w = makeHeadlessWorld(seed, CFG, { ...CAMP, recon });
      const last = new Map<number, { edgeId: number; dir: number; free: boolean } | null>();
      let n = 0;
      const run = runHeadlessWar(w, 60 * 24 * 45, () => {
        const withdrawn = new Set([...(w.lastRedReport?.orders ?? []), ...(w.lastBlueReport?.orders ?? [])].filter((o) => o.why === 'withdraw').map((o) => o.forceId));
        for (const f of w.front.forces) {
          const p = last.get(f.id);
          const marching = f.pos.kind === 'edge' && f.path.length > 0;
          if (p && p.free && marching && f.pos.kind === 'edge' && p.edgeId === f.pos.edgeId && p.dir !== f.pos.dir) {
            n++;
            if (!withdrawn.has(f.id)) unexplained++;
          }
          last.set(f.id, marching && f.pos.kind === 'edge' ? { edgeId: f.pos.edgeId, dir: f.pos.dir, free: f.engagedIn === null } : null);
        }
      });
      per.push(n);
      if (run.status.state === 'decided' && run.status.winner === 'red' && run.day <= CAMP.warDays) destroyed++;
    }
    return { most: Math.max(...per), unexplained, destroyed, per };
  };

  it('with full knowledge: single-digit mid-march turn-rounds in every war, all of them withdrawals; blue destroyed on at most fourteen seeds', () => {
    const r = turnRounds('omniscient');
    expect(r.most, `turn-rounds per seed: ${r.per}`).toBeLessThan(10);
    expect(r.unexplained).toBe(0);
    expect(r.destroyed).toBeLessThanOrEqual(14);
  }, 30_000);

  it('under fog: every mid-march turn-round is a withdrawal; blue destroyed on at most twelve seeds', () => {
    const r = turnRounds('contacts');
    expect(r.unexplained, `turn-rounds per seed: ${r.per}`).toBe(0);
    expect(r.destroyed).toBeLessThanOrEqual(12);
  }, 30_000);
});

describe('battle variety (jtbug #793)', () => {
  // Measured before the objectives and garrisons were spread: 51% of the
  // battles in the 16 pin wars were bridge assaults.
  it('no battle class is over 40% of the 16 pin wars, and at least four are over 8%', () => {
    const mix = new Map<string, number>();
    let total = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const w = makeHeadlessWorld(seed, CFG, CAMP);
      runHeadlessWar(w, 60 * 24 * 45, (r) => {
        for (const x of r.resolved) {
          mix.set(x.battleClass, (mix.get(x.battleClass) ?? 0) + 1);
          total++;
        }
      });
    }
    const shares = [...mix.values()].map((n) => n / total);
    expect(Math.max(...shares), JSON.stringify([...mix])).toBeLessThanOrEqual(0.4);
    expect(shares.filter((s) => s > 0.08).length, JSON.stringify([...mix])).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('the river line is thin: only a town off the river is held from the whole band', () => {
    // The redStrength 2 band is 36 to 109 men.
    const at = (frac: number): number => Math.round(36 + (109 - 36) * frac);
    for (let seed = 1; seed <= 32; seed++) {
      const w = makeHeadlessWorld(seed, CFG, CAMP);
      const t = w.front.theater;
      for (const f of w.front.forces.filter((x) => x.role === 'garrison')) {
        const n = t.nodes[f.homeNode!];
        const cap = n.crossing === null && n.kind === 'town' ? at(1) : at(0.25);
        expect(f.strength, `seed ${seed} ${n.name}`).toBeLessThanOrEqual(cap);
        expect(f.strength).toBeGreaterThanOrEqual(36);
      }
    }
  });

  it('objectives and garrisons are not all crossings: every theater has an objective off the river line', () => {
    for (let seed = 1; seed <= 16; seed++) {
      const w = makeHeadlessWorld(seed, CFG, CAMP);
      const t = w.front.theater;
      const dry = t.objectiveNodes.filter((n) => t.nodes[n].crossing === null);
      expect(dry.length, `seed ${seed}: objectives ${t.objectiveNodes}`).toBeGreaterThan(0);
      expect(t.objectiveNodes.filter((n) => t.nodes[n].crossing !== null).length, `seed ${seed}`).toBeLessThanOrEqual(1);
      const garrisons = w.front.forces.filter((f) => f.role === 'garrison');
      for (const o of t.objectiveNodes) expect(garrisons.some((g) => g.homeNode === o), `seed ${seed}: objective ${o} has no garrison`).toBe(true);
    }
  });
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
