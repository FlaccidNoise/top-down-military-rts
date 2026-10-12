// Initial disposition — the order of battle (S13a, §2.5). A separate pure
// function over the finished theater: makeTheater emits geography, THIS
// places the war. Draws come from the DISPOSITION sub-stream (SPEC_TAG 3),
// so retuning red strength never moves the map.
import type { Rng } from '../../sim/rng';
import type { CampaignConfig } from '../../campaign/spec';
import { fitStrength, type Campaign } from '../../campaign/campaign';
import type { Side } from '../../sim/sim';
import type { Theater } from '../theater';
import { MAX_FORCES, route, type ForceInit } from '../theater/force';

export class DispositionError extends Error {
  constructor(public readonly reason: 'no-entry-node' | 'garrison-starved' | 'establishment-zero', detail: string) {
    super(`makeDisposition: ${reason} — ${detail}`);
    this.name = 'DispositionError';
  }
}

// Red by the redStrength knob (0-4). The GARRISON band is what one company
// meets when it attacks, so it stays where one company can win a fought
// battle (see the note on the tutorial's first battle below): levels 2 to 4
// share a band. What the knob buys above that is the FIELD force: more
// battlegroups of about a company each, which is what attacks, retakes a town
// and marches into a threatened one. Big battlegroups were tried and are not
// the lever: three of 140-200 men destroyed AI blue on 12 of 16 seeds, because
// each one beats a company alone (jtbug #797, #799).
//
// Measured 2026-10-11 with garrisons that give up a post and the varied
// spoiling hour (#808), scripts/warsweep2.mjs, 128 seeds, AI both sides (blue
// wins · red attacks a day · AI blue destroyed):
//   Skirmish        1   84% · 0.38 · 6
//   Normandy Bocage 3   61% · 1.29 · 46     at 4: 38% · 1.61 · 76
//   River Line      3   67% · 1.13 · 41     at 4: 49% · 1.49 · 65
//   Open Country    4   82% · 1.31 · 22     at 3: 95% · 1.03 · 5
// Normandy Bocage and River Line run at 3 by the owner's call after his
// replay ("drop the enemy strength, keep adding to the AI", jtbug #805).
// Open Country stays at 4: at 3 AI blue loses 6 wars in 128. These are AI
// against AI. A battle the player fights is harder than its line here says:
// every red force at the site is on the field (#807).
const RED_GARRISON_BAND: Record<number, [number, number]> = {
  0: [0, 0],
  1: [25, 60],
  2: [36, 109], // the newFront-era band the war pin tuned against
  3: [36, 109],
  4: [36, 109],
};
const PICKETS = 3;
const CROSSING_BAND = 0.25;
const OUTPOST_BAND = 0.25;
const RED_MOBILE_COUNT: Record<number, number> = { 0: 0, 1: 2, 2: 3, 3: 4, 4: 5 };
const RED_MOBILE_STRENGTH: Record<number, [number, number]> = {
  0: [0, 0],
  1: [60, 90],
  2: [80, 120],
  3: [80, 120],
  4: [80, 120],
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
  // v3 (jtbug #793): a garrison on every objective, and PICKETS more on the
  // river line: one crossing, then the places just behind the crossings, each
  // on ground no picket holds yet. Garrisoning every crossing made the bridge
  // the only place a war was fought.
  const band = RED_GARRISON_BAND[cfg.redStrength];
  const isObjective = (id: number): boolean => theater.objectiveNodes.includes(id);
  const groundOf = (n: Theater['nodes'][number]): string => (n.crossing ? 'crossing' : n.kind === 'town' || n.kind === 'village' ? n.kind : (theater.regions[n.regionId]?.terrainClass ?? 'farmland'));
  const redFree = theater.nodes.filter((n) => control[n.id] === 'red' && !isObjective(n.id)).sort((a, b) => a.id - b.id);
  const crossings = redFree.filter((n) => n.crossing !== null);
  const nextTo = (n: Theater['nodes'][number], set: readonly Theater['nodes'][number][]): boolean =>
    theater.edges.some((e) => e.moveClass !== 'rail' && ((e.a === n.id && set.some((c) => c.id === e.b)) || (e.b === n.id && set.some((c) => c.id === e.a))));
  const behind = redFree.filter((n) => n.crossing === null && n.kind !== 'halt' && nextTo(n, theater.nodes.filter((c) => c.crossing !== null)));
  const pickets: Theater['nodes'][number][] = crossings.slice(0, 1);
  while (pickets.length < PICKETS) {
    const rest = behind.filter((n) => !pickets.includes(n));
    const have = new Set(pickets.map(groundOf));
    const next = rest.find((n) => !have.has(groundOf(n))) ?? rest[0] ?? crossings.find((n) => !pickets.includes(n));
    if (!next) break;
    pickets.push(next);
  }
  const garrisonable = [...theater.nodes.filter((n) => isObjective(n.id) && control[n.id] === 'red'), ...pickets].sort((a, b) => a.id - b.id);
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
        // The river line is thin and the towns behind it are not. A garrison
        // on a crossing draws from the lowest CROSSING_BAND of the band, a
        // picket or an objective in open country from the lowest OUTPOST_BAND,
        // and only a town off the river from all of it. So the first fight a
        // company meets is one it can win. The tutorial's guided first battle
        // (one company attacking) is the measure: against garrisons from the
        // whole band it was lost at 61, 66, 85, 87 and 92 men and won at 52 to
        // 79, a coin toss from about 60 up.
        strength: Math.round(rng.range(band[0], band[0] + (band[1] - band[0]) * (n.crossing !== null ? CROSSING_BAND : n.kind === 'town' ? 1 : OUTPOST_BAND))),
        companyIndex: -1,
        role: 'garrison',
        engagedIn: null,
        queuedAt: null,
      });
    }
    // Mobile red stands where it can reach what it must hold. The line groups
    // take the red nodes with the least total march to the objectives, off
    // the river line and off the garrisoned places. The reserve stands at the
    // depot, on the supply line it exists to keep open. All of them stood at
    // the two eastmost nodes before, a day's march from anything.
    const held = new Set(garrisonable.map((n) => n.id));
    const marchTo = (from: number): number => theater.objectiveNodes.reduce((a, o) => a + (route(theater, from, o)?.minutes ?? 1e6), 0);
    const redRear = theater.nodes
      .filter((n) => control[n.id] === 'red' && n.crossing === null && !held.has(n.id))
      .map((n) => ({ n, cost: marchTo(n.id) }))
      .sort((a, b) => a.cost - b.cost || a.n.id - b.n.id)
      .map((x) => x.n);
    const mobiles = RED_MOBILE_COUNT[cfg.redStrength];
    const mBand = RED_MOBILE_STRENGTH[cfg.redStrength];
    for (let i = 0; i < mobiles && redRear.length > 0; i++) {
      forces.push({
        side: 'red',
        name: i === mobiles - 1 && mobiles > 1 ? 'Reserve-Kampfgruppe' : `Kampfgruppe ${['Ost', 'Nord', 'Süd', 'West'][i]}`,
        pos: { kind: 'node', nodeId: i === mobiles - 1 && mobiles > 1 ? (theater.sources.red[0] ?? redRear[0].id) : redRear[i % redRear.length].id },
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
