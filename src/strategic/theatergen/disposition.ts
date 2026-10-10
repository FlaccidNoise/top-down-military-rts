// Initial disposition — the order of battle (S13a, §2.5). A separate pure
// function over the finished theater: makeTheater emits geography, THIS
// places the war. Draws come from the DISPOSITION sub-stream (SPEC_TAG 3),
// so retuning red strength never moves the map.
import type { Rng } from '../../sim/rng';
import type { CampaignConfig } from '../../campaign/spec';
import { fitStrength, type Campaign } from '../../campaign/campaign';
import type { Side } from '../../sim/sim';
import type { Theater } from '../theater';
import { MAX_FORCES, type ForceInit } from '../theater/force';

export class DispositionError extends Error {
  constructor(public readonly reason: 'no-entry-node' | 'garrison-starved' | 'establishment-zero', detail: string) {
    super(`makeDisposition: ${reason} — ${detail}`);
    this.name = 'DispositionError';
  }
}

// Red garrison strength bands by redStrength knob (0-4): the §2.5 "stated
// band". Mobile red (line + reserve) scales from the same knob — a goal-
// driven red with only garrisons cannot attack.
const RED_GARRISON_BAND: Record<number, [number, number]> = {
  0: [0, 0],
  1: [25, 60],
  2: [36, 109], // the newFront-era band the war pin tuned against
  3: [60, 140],
  4: [90, 180],
};
const RED_MOBILE_COUNT: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 2, 4: 3 };
const RED_MOBILE_STRENGTH: Record<number, [number, number]> = {
  0: [0, 0],
  1: [60, 90],
  2: [90, 130],
  3: [110, 160],
  4: [140, 200],
};

export interface Disposition {
  forces: ForceInit[];
}

export function makeDisposition(
  theater: Theater,
  cfg: CampaignConfig,
  campaign: Campaign,
  control: Side[],
  rng: Rng,
): Disposition {
  const forces: ForceInit[] = [];

  // -- Blue: one line force per company, on ENTRY NODES — blue-side nodes of
  // the front partition with road rank <= 1, sorted by node id, cycled.
  const entries = theater.nodes
    .filter((n) => control[n.id] === 'blue' && n.rank <= 1)
    .sort((a, b) => a.id - b.id);
  if (entries.length === 0) {
    throw new DispositionError('no-entry-node', 'the blue partition holds no node of road rank <= 1');
  }
  for (let i = 0; i < cfg.blueCompanies; i++) {
    const company = campaign.companies[i];
    if (!company) throw new DispositionError('establishment-zero', `campaign holds no company ${i}`);
    const strength = fitStrength(campaign, i);
    if (strength <= 0) throw new DispositionError('establishment-zero', `${company.name} musters no fit men`);
    forces.push({
      side: 'blue',
      name: company.name,
      pos: { kind: 'node', nodeId: entries[i % entries.length].id },
      path: [],
      dwellMin: 0,
      strength,
      companyIndex: i,
      role: 'line',
      engagedIn: null,
      queuedAt: null,
    });
  }

  // -- Red: garrisons across objective nodes + crossings, strengths drawn on
  // the DISPOSITION stream inside the band; mobile line/reserve from the
  // same knob.
  const band = RED_GARRISON_BAND[cfg.redStrength];
  const garrisonable = theater.nodes
    .filter((n) => (theater.objectiveNodes.includes(n.id) || n.crossing !== null) && control[n.id] === 'red')
    .sort((a, b) => a.id - b.id);
  if (cfg.redStrength > 0) {
    if (garrisonable.length < 2) {
      throw new DispositionError('garrison-starved', `redStrength ${cfg.redStrength} with only ${garrisonable.length} garrisonable nodes`);
    }
    for (const n of garrisonable) {
      if (forces.length >= MAX_FORCES - RED_MOBILE_COUNT[cfg.redStrength]) break;
      forces.push({
        side: 'red',
        name: `Garnison ${n.name}`,
        pos: { kind: 'node', nodeId: n.id },
        path: [],
        dwellMin: 0,
        strength: Math.round(rng.range(band[0], band[1])),
        companyIndex: -1,
        role: 'garrison',
        engagedIn: null,
        queuedAt: null,
      });
    }
    // Mobile red: line + reserve at the deepest red towns (fallback: any red
    // node), so the goal-driven commander has something to attack WITH.
    const redRear = theater.nodes
      .filter((n) => control[n.id] === 'red' && n.crossing === null)
      .sort((a, b) => b.pos.x - a.pos.x || a.id - b.id);
    const mobiles = RED_MOBILE_COUNT[cfg.redStrength];
    const mBand = RED_MOBILE_STRENGTH[cfg.redStrength];
    for (let i = 0; i < mobiles && redRear.length > 0; i++) {
      forces.push({
        side: 'red',
        name: i === mobiles - 1 && mobiles > 1 ? 'Reserve-Kampfgruppe' : `Kampfgruppe ${['Ost', 'Nord', 'Süd'][i]}`,
        pos: { kind: 'node', nodeId: redRear[i % redRear.length].id },
        path: [],
        dwellMin: 0,
        strength: Math.round(rng.range(mBand[0], mBand[1])),
        companyIndex: -1,
        role: i === mobiles - 1 && mobiles > 1 ? 'reserve' : 'line',
        engagedIn: null,
        queuedAt: null,
      });
    }
  }

  if (forces.length > MAX_FORCES) {
    throw new DispositionError('garrison-starved', `disposition wants ${forces.length} forces against MAX_FORCES ${MAX_FORCES}`);
  }
  return { forces };
}
