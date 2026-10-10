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
import type { OperationalPlan } from './planner';
import type { Requisition } from './requisition';
import { garrisonPost, type CoarseBattle, type Force, type FrontV2, type StratContact, type TheaterEvent } from './theater/force';

// §4.8: a reloaded commander must NOT forget its axes — a goal-driven
// opponent that replans on load is a determinism break dressed as
// simplification. lastEvalMin is null on the wire when the instance holds
// -Infinity (never evaluated): JSON has no -Infinity.
export interface CommanderSaveV2 {
  lastEvalMin: number | null;
  plan: OperationalPlan | null;
}
export type AiSave = Partial<Record<'blue' | 'red', CommanderSaveV2>>;

const KEY_V4 = 'ccg-save-v4';
const KEY_V3 = 'ccg-save-v3'; // frozen pre-V2 artifact, sole owner — V1 writes 'ccg-save-v3-grid' (#138)

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
    intel?: Record<'blue' | 'red', StratContact[]>; // S53: absent when omniscient
    requisition?: Requisition; // absent: nothing due, nothing running
  };
  ai?: AiSave; // §4.8: absent on saves written before commander persistence
}

export function saveGameV2(
  seed: number,
  cfg: TheaterConfig,
  campaignCfg: CampaignConfig,
  campaign: Campaign,
  front: FrontV2,
  ai?: Partial<Record<'blue' | 'red', { lastEvalMin: number; plan: OperationalPlan | null }>>,
): boolean {
  const wireAi: AiSave | undefined = ai
    ? Object.fromEntries(
        Object.entries(ai).map(([side, c]) => [
          side,
          { lastEvalMin: Number.isFinite(c.lastEvalMin) ? c.lastEvalMin : null, plan: c.plan },
        ]),
      )
    : undefined;
  const payload: SaveV4 = {
    schema: 4,
    genVersion: GEN_VERSION,
    seed,
    theaterCfg: cfg,
    campaignCfg,
    campaign,
    ai: wireAi,
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
      intel: front.intel,
      requisition: front.requisition,
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
  | { status: 'ok'; seed: number; cfg: TheaterConfig; campaignCfg: CampaignConfig; campaign: Campaign; front: FrontV2; ai?: AiSave }
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
    forces: p.front.forces.map((f) => ({ ...f, untracedMin: f.untracedMin ?? 0, fatigue: f.fatigue ?? 0, lastEdgeId: f.lastEdgeId ?? null, repulsedAtMin: f.repulsedAtMin ?? null, establishment: f.establishment ?? f.strength, homeNode: f.homeNode === undefined ? garrisonPost(f) : f.homeNode, posture: f.posture ?? 'march', dugMin: f.dugMin ?? 0, armorAttacks: f.armorAttacks ?? 0, reconUntilDay: f.reconUntilDay ?? 0, owedMen: f.owedMen ?? 0 })),
  };
  repairDefiles(front);
  return { status: 'ok', seed: p.seed, cfg: p.theaterCfg, campaignCfg: p.campaignCfg, campaign: p.campaign, front, ai: p.ai };
}

// Saves written before jtbug #760 can carry a defile queue headed by a force
// that left the bridge, or a force still marked queued with no path: the
// bridge never reopens and the force refuses every order. Keep only the ids
// that are really waiting at or crossing that bridge, then clear any queuedAt
// its queue no longer backs. A healthy save passes through unchanged, so the
// reload-determinism pin holds.
function repairDefiles(front: FrontV2): void {
  for (const [key, q] of Object.entries(front.defileQueues)) {
    const nodeId = Number(key);
    front.defileQueues[nodeId] = [...new Set(q)].filter((id) => {
      const f = front.forces.find((x) => x.id === id);
      return f !== undefined && f.strength > 0 && f.engagedIn === null && f.path.length > 0 && f.pos.kind === 'node' && f.pos.nodeId === nodeId;
    });
  }
  for (const f of front.forces) {
    if (f.queuedAt !== null && !(front.defileQueues[f.queuedAt] ?? []).includes(f.id)) f.queuedAt = null;
  }
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
