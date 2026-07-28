// Save v4 (S37/§7, OQ1): the versioned clean break. The payload persists the
// CampaignSpec seed material and the MUTABLE war — the theater itself is
// REGENERATED from (genVersion, seed, cfg), which the 16-seed byte-identity
// gate makes safe. v3 saves are structurally unmigratable (positional owners
// over a dead grid), but the campaign roster is theater-independent: the
// legacy path carries the named men into a fresh war (the boot modal's
// 'Continue with these men'), never a silent reset.
import type { Campaign } from '../campaign/campaign';
import { GEN_VERSION, type CampaignConfig, type TheaterConfig } from '../campaign/spec';
import { makeTheater } from './theatergen';
import type { CoarseBattle, Force, FrontV2, TheaterEvent } from './theater/force';

const KEY_V4 = 'ccg-save-v4';
const KEY_V3 = 'ccg-save-v3';

export interface SaveV4 {
  schema: 4;
  genVersion: number;
  seed: number;
  theaterCfg: TheaterConfig;
  campaignCfg: CampaignConfig;
  campaign: Campaign;
  front: {
    clockMin: number;
    day: number;
    nextForceId: number;
    nextBattleId: number;
    forces: Force[];
    controlByNode: (('blue' | 'red') | null)[];
    battles: CoarseBattle[];
    events: TheaterEvent[];
    defileQueues: Record<number, number[]>;
  };
}

export function saveGameV2(seed: number, cfg: TheaterConfig, campaignCfg: CampaignConfig, campaign: Campaign, front: FrontV2): boolean {
  const payload: SaveV4 = {
    schema: 4,
    genVersion: GEN_VERSION,
    seed,
    theaterCfg: cfg,
    campaignCfg,
    campaign,
    front: {
      clockMin: front.clockMin,
      day: front.day,
      nextForceId: front.nextForceId,
      nextBattleId: front.nextBattleId,
      forces: front.forces,
      controlByNode: front.controlByNode,
      battles: front.battles,
      events: front.events,
      defileQueues: front.defileQueues,
    },
  };
  try {
    localStorage.setItem(KEY_V4, JSON.stringify(payload));
    return true;
  } catch {
    return false; // storage full/blocked — the caller surfaces the banner
  }
}

export type LoadV2 =
  | { status: 'ok'; seed: number; cfg: TheaterConfig; campaignCfg: CampaignConfig; campaign: Campaign; front: FrontV2 }
  | { status: 'none' }
  | { status: 'stale-generator' }
  | { status: 'corrupt'; detail: string }
  | { status: 'legacy' };

export function loadGameV2(): LoadV2 {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY_V4);
  } catch {
    return { status: 'none' };
  }
  if (raw === null) {
    try {
      if (localStorage.getItem(KEY_V3) !== null) return { status: 'legacy' };
    } catch {
      /* unreadable = none */
    }
    return { status: 'none' };
  }
  let p: SaveV4;
  try {
    p = JSON.parse(raw) as SaveV4;
  } catch (e) {
    return { status: 'corrupt', detail: e instanceof Error ? e.message : 'unparseable' };
  }
  if (p.schema !== 4 || !p.campaign || !p.front || typeof p.seed !== 'number') {
    return { status: 'corrupt', detail: 'missing fields' };
  }
  if (p.genVersion !== GEN_VERSION) return { status: 'stale-generator' };
  let theater;
  try {
    theater = makeTheater(p.seed, p.theaterCfg).theater;
  } catch (e) {
    return { status: 'corrupt', detail: `theater regeneration failed: ${e instanceof Error ? e.message : e}` };
  }
  const front: FrontV2 = {
    theater,
    ...p.front,
    // Saves written before the realism wave carry no supply/fatigue fields:
    // normalize to fresh, exactly what addForce defaults a new force to.
    forces: p.front.forces.map((f) => ({ ...f, untracedMin: f.untracedMin ?? 0, fatigue: f.fatigue ?? 0 })),
  };
  return { status: 'ok', seed: p.seed, cfg: p.theaterCfg, campaignCfg: p.campaignCfg, campaign: p.campaign, front };
}

// The OQ1 roster carry-over: the v3 campaign object is schema-compatible —
// the men, wounds, bonds and battle diary come along; the WAR restarts on a
// fresh theater at day 1.
export function adoptLegacyRoster(): Campaign | null {
  try {
    const raw = localStorage.getItem(KEY_V3);
    if (raw === null) return null;
    const v3 = JSON.parse(raw) as { campaign?: Campaign };
    return v3.campaign ?? null;
  } catch {
    return null;
  }
}

export function discardSaves(): void {
  try {
    localStorage.removeItem(KEY_V4);
    localStorage.removeItem(KEY_V3);
  } catch {
    /* nothing to lose */
  }
}
