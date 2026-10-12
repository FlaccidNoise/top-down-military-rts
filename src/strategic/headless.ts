// Headless V2 war runner: the SAME per-minute composition main.ts's
// strategic tick runs — evaluate both commanders → stepWar (all-coarse) →
// day roll — with zero DOM. One implementation, two consumers: the
// reload-determinism pin (S56) and scripts/warsweep-v2 (S58). Drift between
// this loop and main's tick is the bug class the pin exists to catch.
import { advanceDays, newCampaign, type Campaign } from '../campaign/campaign';
import { GEN_VERSION, SPEC_TAG, specStream, type CampaignConfig, type CampaignSpec, type TheaterConfig } from '../campaign/spec';
import { REINFORCE_CYCLE_DAYS } from './front';
import { cycleRefit } from './refit';
import { makeWarGoals, warStatus, type WarGoals, type WarState } from './goals';
import { ContactIntel, OmniscientIntel, type IntelView } from './intel';
import { BLUE_V2, Commander2, redDoctrine, spoilDelayMin, type DoctrineV2, type OperationalPlan, type PlannerReport } from './planner';
import { makeTheater } from './theatergen';
import { makeDisposition } from './theatergen/disposition';
import { addForce, type FrontV2 } from './theater/force';
import { stepWar, type StepResult } from './theater/war';
import { syncStrengthsV2 } from './theater/sync';

export interface CommanderRestore {
  lastEvalMin: number;
  plan: OperationalPlan | null;
}

export interface HeadlessWorld {
  seed: number;
  theaterCfg: TheaterConfig;
  campaignCfg: CampaignConfig;
  campaign: Campaign;
  front: FrontV2;
  goals: WarGoals;
  red: Commander2;
  blue: Commander2;
  redIntel: IntelView;
  blueIntel: IntelView;
  prevDay: number;
  // The most recent evaluate() results — null between cadence ticks. The
  // sweep reads stall codes and order streams from here (§4.6).
  lastRedReport: PlannerReport | null;
  lastBlueReport: PlannerReport | null;
}

const intelFor = (front: FrontV2, side: 'blue' | 'red', cfg: CampaignConfig): IntelView =>
  cfg.recon === 'contacts' ? new ContactIntel(front, side) : new OmniscientIntel(front, side);

// Build commanders + intel around an EXISTING campaign/front pair (the
// reload path) or a fresh disposition (the sweep path).
export function makeHeadlessWorld(
  seed: number,
  theaterCfg: TheaterConfig,
  campaignCfg: CampaignConfig,
  restore?: {
    campaign: Campaign;
    front: FrontV2;
    ai?: Partial<Record<'blue' | 'red', CommanderRestore>>;
  },
  doctrines?: Partial<Record<'blue' | 'red', DoctrineV2>>,
): HeadlessWorld {
  let campaign: Campaign;
  let front: FrontV2;
  if (restore) {
    ({ campaign, front } = restore);
  } else {
    const { theater, initialControlByNode } = makeTheater(seed, theaterCfg);
    campaign = newCampaign(seed, campaignCfg.blueCompanies);
    const spec: CampaignSpec = { genVersion: GEN_VERSION, seed, seedText: String(seed), theater: theaterCfg, campaign: campaignCfg };
    const d = makeDisposition(theater, campaignCfg, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
    front = {
      theater,
      clockMin: 360,
      day: 1,
      nextForceId: 0,
      nextBattleId: 0,
      forces: [],
      controlByNode: [...initialControlByNode],
      battles: [],
      events: [],
      defileQueues: {},
    };
    for (const f of d.forces) addForce(front, f);
  }
  const goals = makeWarGoals(front.theater, campaignCfg);
  const kernel = { nightTempo: campaignCfg.nightTempo, fog: campaignCfg.recon === 'contacts', spoilDelayMin: spoilDelayMin(seed) };
  const red = new Commander2('red', doctrines?.red ?? redDoctrine(campaignCfg.redStrength), goals, campaignCfg.warDays, kernel);
  const blue = new Commander2('blue', doctrines?.blue ?? BLUE_V2, goals, campaignCfg.warDays, kernel);
  for (const [cmd, side] of [
    [red, 'red'],
    [blue, 'blue'],
  ] as const) {
    const r = restore?.ai?.[side];
    if (r) {
      cmd.plan = r.plan;
      cmd.lastEvalMin = r.lastEvalMin;
    }
  }
  return {
    seed,
    theaterCfg,
    campaignCfg,
    campaign,
    front,
    goals,
    red,
    blue,
    redIntel: intelFor(front, 'red', campaignCfg),
    blueIntel: intelFor(front, 'blue', campaignCfg),
    prevDay: front.day,
    lastRedReport: null,
    lastBlueReport: null,
  };
}

// One strategic minute, main-loop order: red evaluates, blue evaluates,
// the war steps (auto-battle — nobody answers a modal here), the day rolls.
export function stepWorldMinute(w: HeadlessWorld): StepResult {
  w.lastRedReport = w.red.evaluate(w.front, w.redIntel);
  w.lastBlueReport = w.blue.evaluate(w.front, w.blueIntel);
  const r = stepWar(w.front, w.campaign, {
    autoBattle: () => true,
    supply: w.campaignCfg.supply,
    recon: w.campaignCfg.recon,
    nightTempo: w.campaignCfg.nightTempo,
  });
  if (w.front.day > w.prevDay) {
    advanceDays(w.campaign, w.front.day - w.prevDay);
    if (w.front.day % REINFORCE_CYCLE_DAYS === 0) cycleRefit(w.campaign, w.front, w.front.day * 31 + 7);
    syncStrengthsV2(w.campaign, w.front);
    w.prevDay = w.front.day;
  }
  return r;
}

export interface WarRun {
  status: WarState;
  day: number;
  logLen: number;
  minutes: number;
}

// Run to decision or the minute cap. onMinute sees each step's result —
// the trace hook the determinism pin compares on.
export function runHeadlessWar(
  w: HeadlessWorld,
  maxMinutes = 60 * 24 * 45,
  onMinute?: (r: StepResult, w: HeadlessWorld) => void,
): WarRun {
  let minutes = 0;
  let st = warStatus(w.front, w.goals);
  while (st.state === 'ongoing' && minutes < maxMinutes) {
    const r = stepWorldMinute(w);
    onMinute?.(r, w);
    minutes++;
    st = warStatus(w.front, w.goals);
  }
  return { status: st, day: w.front.day, logLen: w.campaign.log.length, minutes };
}
