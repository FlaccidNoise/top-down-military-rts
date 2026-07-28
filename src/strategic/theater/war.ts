// The war engine (S16, §3.3/3.4/3.6, §6 re-root): timed coarse battles over
// the theater graph, the §3.6 graph retreat, and the full step composition —
// clock++ → resolve due battles (ascending id) → advance movement → detect
// contacts → open or hand off battles. The Lanchester arithmetic is
// bridge.ts coarseOutcome — the tuned asset, untouched.
import { mulberry32 } from '../../sim/rng';
import { lightAt } from '../../sim/solar';
import type { Campaign } from '../../campaign/campaign';
import { applyCoarseBlueLosses, coarseOutcome, TRIVIAL_RATIO } from '../bridge';
import type { BattleRecord } from '../../campaign/campaign';
import { battleSiteOf, COARSE_DEF_MULT, CROSSING_ASSAULT_MULT, type BattleClass } from '../theater';
import {
  edgeById,
  incidentFoot,
  otherEnd,
  pushEvent,
  route,
  type CoarseBattle,
  type Force,
  type FrontV2,
  type TheaterEvent,
} from './force';
import { detectContacts, graphGap, haltAtContact, type Contact } from './contact';
import { stepMovement } from './step';
import { effStrength } from './combat';
import { updateSupplyMinute } from './supply';

export const RETREAT_SETBACK_M = 1500;
export const THREAT_M = 1500;
export const INFILTRATE_MIN = 120; // = the pinned 8 cells x 15 min
const TRIVIAL_DURATION_MIN = 15;

// OQ3 (B): a fought battle charges the theater the same bounded time the
// coarse resolver would have — the debrief return steps this many minutes.
// endMin - startMin is battleDuration-capped at 240 except when a late join
// re-floors endMin at now+15, so the cap is re-asserted here.
export const CATCH_UP_CAP_MIN = 240;
export function battleCatchUpMin(b: CoarseBattle): number {
  return Math.min(CATCH_UP_CAP_MIN, Math.max(0, b.endMin - b.startMin));
}

export function forceById(front: FrontV2, id: number): Force {
  const f = front.forces.find((x) => x.id === id);
  if (!f) throw new Error(`forceById: unknown force ${id}`);
  return f;
}

function trivialForced(atk: Force, def: Force): 'attacker' | 'defender' | null {
  if (atk.strength <= 0 || def.strength <= 0) return null;
  if (atk.strength >= def.strength * TRIVIAL_RATIO) return 'attacker';
  if (def.strength >= atk.strength * TRIVIAL_RATIO) return 'defender';
  return null;
}

// §3.4: durationMin = min(240, 45 + 1.4 x min(atk, def)); trivial collapses
// to 15. The 240 cap is load-bearing — reinforcement joins push min() past
// 139 and the cap stops a two-corps grind from pinning both sides for a day.
export function battleDuration(atkStrength: number, defStrength: number, forced: boolean): number {
  if (forced) return TRIVIAL_DURATION_MIN;
  return Math.min(240, Math.round(45 + 1.4 * Math.min(atkStrength, defStrength)));
}

export function openBattle(front: FrontV2, c: Contact): CoarseBattle {
  const atk = forceById(front, c.attackerId);
  const def = forceById(front, c.defenderId);
  haltAtContact(front, c);
  const forced = trivialForced(atk, def);
  const battle: CoarseBattle = {
    id: front.nextBattleId++,
    site: c.site,
    attackerId: atk.id,
    defenderId: def.id,
    joined: [],
    startMin: front.clockMin,
    endMin: front.clockMin + battleDuration(atk.strength, def.strength, forced !== null),
    forced,
    approachEdgeId: atk.pos.kind === 'edge' ? atk.pos.edgeId : null,
  };
  front.battles.push(battle);
  atk.engagedIn = battle.id;
  def.engagedIn = battle.id;
  return battle;
}

// §3.4 reinforcement: strength adds, endMin recomputes floored at now+15,
// and forced RE-EVALUATES — a 5:1 walkover reinforced to 2:1 loses its
// guaranteed winner.
export function joinBattle(front: FrontV2, battle: CoarseBattle, f: Force): void {
  f.engagedIn = battle.id;
  f.path = [];
  battle.joined.push(f.id);
  const sides = battleSides(front, battle);
  battle.forced = trivialForcedStr(sides.atkStrength, sides.defStrength);
  battle.endMin = Math.max(
    front.clockMin + 15,
    battle.startMin + battleDuration(sides.atkStrength, sides.defStrength, battle.forced !== null),
  );
}

function trivialForcedStr(atk: number, def: number): 'attacker' | 'defender' | null {
  if (atk <= 0 || def <= 0) return null;
  if (atk >= def * TRIVIAL_RATIO) return 'attacker';
  if (def >= atk * TRIVIAL_RATIO) return 'defender';
  return null;
}

interface BattleSides {
  attackers: Force[];
  defenders: Force[];
  atkStrength: number;
  defStrength: number;
  atkEff: number; // strength x combatMult — what the win score reads (§4.4)
  defEff: number;
}

export function battleSides(front: FrontV2, battle: CoarseBattle): BattleSides {
  const principal = forceById(front, battle.attackerId);
  const participants = [battle.attackerId, battle.defenderId, ...battle.joined].map((id) => forceById(front, id));
  const attackers = participants.filter((f) => f.side === principal.side);
  const defenders = participants.filter((f) => f.side !== principal.side);
  return {
    attackers,
    defenders,
    atkStrength: attackers.reduce((a, f) => a + f.strength, 0),
    defStrength: defenders.reduce((a, f) => a + f.strength, 0),
    atkEff: attackers.reduce((a, f) => a + effStrength(f), 0),
    defEff: defenders.reduce((a, f) => a + effStrength(f), 0),
  };
}

// §3.6 graph retreat, replacing the east-first DIRS bias: candidate incident
// edges minus the enemy approach axis minus edges with an enemy inside
// THREAT_M of their far node; score far-node control, then threat distance,
// then length, tie-break lowest edge id; place PARKED at RETREAT_SETBACK_M.
// Blue fallback: infiltrate to the nearest friendly enemy-free node within
// INFILTRATE_MIN graph-minutes, strength kept. Red with no escape: overrun.
// opts.trapped: what happens when no candidate edge survives the threat
// filter. 'overrun' is the beaten-force default; 'stay' serves a voluntary
// stand-down — a force that CHOSE to break contact and cannot is left in
// place to fight, never annihilated by its own order.
export function retreatForce(
  front: FrontV2,
  f: Force,
  approachEdgeId: number | null,
  opts: { trapped?: 'overrun' | 'stay' } = {},
): void {
  const t = front.theater;
  // The retreat pivots on the node BEHIND the force: its own node, or the
  // near end of its edge (opposite its direction of travel).
  const nodeId = f.pos.kind === 'node' ? f.pos.nodeId : (f.pos.dir === 1 ? edgeById(t, f.pos.edgeId).a : edgeById(t, f.pos.edgeId).b);
  const enemies = front.forces.filter((g) => g.side !== f.side && g.strength > 0);
  const nearEnemy = (n: number): number => {
    let best = Infinity;
    for (const g of enemies) best = Math.min(best, graphGap(t, { kind: 'node', nodeId: n }, g.pos));
    return best;
  };
  const candidates = incidentFoot(t, nodeId)
    .filter((e) => e.id !== approachEdgeId)
    .filter((e) => nearEnemy(otherEnd(e, nodeId)) > THREAT_M)
    .map((e) => {
      const far = otherEnd(e, nodeId);
      const control = front.controlByNode[far] === f.side ? 0 : front.controlByNode[far] === null ? 1 : 2;
      return { e, far, control, threat: -nearEnemy(far), len: e.lengthM };
    })
    .sort((p, q) => p.control - q.control || p.threat - q.threat || p.len - q.len || p.e.id - q.e.id);

  if (candidates.length > 0) {
    const { e } = candidates[0];
    const dir: 1 | -1 = e.a === nodeId ? 1 : -1;
    const s = dir === 1 ? Math.min(e.lengthM, RETREAT_SETBACK_M) : Math.max(0, e.lengthM - RETREAT_SETBACK_M);
    f.pos = { kind: 'edge', edgeId: e.id, s, dir };
    f.path = [];
    f.dwellMin = 0;
    pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${f.name} falls back`, forceIds: [f.id] });
    return;
  }

  if (opts.trapped === 'stay') return; // voluntary break-off, nowhere to go: hold

  if (f.side === 'blue') {
    // Infiltrate: nearest friendly, enemy-free node within the graph-minute
    // budget; the persistent roster survives (the pinned asymmetry).
    let best: { n: number; min: number } | null = null;
    for (const n of t.nodes) {
      if (front.controlByNode[n.id] !== 'blue') continue;
      if (nearEnemy(n.id) <= THREAT_M) continue;
      const r = route(t, nodeId, n.id);
      if (!r || r.minutes > INFILTRATE_MIN) continue;
      if (!best || r.minutes < best.min) best = { n: n.id, min: r.minutes };
    }
    if (best) {
      f.pos = { kind: 'node', nodeId: best.n };
      f.path = [];
      f.dwellMin = 0;
      pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${f.name} infiltrates to ${t.nodes[best.n].name}`, forceIds: [f.id], nodeId: best.n });
      return;
    }
  }
  // Overrun: red attrition counters die here; a blue force with truly no
  // escape is overrun too (the roster men already went through the losses).
  f.strength = 0;
  pushEvent(front, { min: front.clockMin, kind: 'overrun', text: `${f.name} is overrun`, forceIds: [f.id] });
}

// Resolve one due battle (§6 re-root): both clocks bound to startMin, the
// BattleClass drives the multiplier chain, control paints the site node,
// losers route through the graph retreat, beaten crossing-assault attackers
// are set back down their approach edge.
export function resolveBattleV2(
  front: FrontV2,
  campaign: Campaign,
  battle: CoarseBattle,
  nightMult = 1.0,
): { attackerWon: boolean; battleClass: BattleClass; record: BattleRecord } {
  const t = front.theater;
  const sides = battleSides(front, battle);
  const { battleClass, siteKey } = battleSiteOf(t, battle.site, battle.approachEdgeId ?? undefined);
  let terrainMult = COARSE_DEF_MULT[battleClass];
  if (battleClass === 'bridge-assault' || battleClass === 'ford-assault') terrainMult *= CROSSING_ASSAULT_MULT;
  if (lightAt(battle.startMin) < 0.25) terrainMult *= nightMult;

  const seed = (campaign.seed ^ (battle.startMin * 7919 + siteKey)) >>> 0;
  const rng = mulberry32(seed);
  const { attackerWins, atkLosses, defLosses } = coarseOutcome(
    sides.atkStrength,
    sides.defStrength,
    terrainMult,
    rng,
    battle.forced,
    sides.atkEff,
    sides.defEff,
  );

  const record: BattleRecord = { day: front.day, won: false, kia: [], wounded: [] };
  const distribute = (group: Force[], losses: number): void => {
    const total = group.reduce((a, f) => a + f.strength, 0);
    let remaining = losses;
    for (let i = 0; i < group.length; i++) {
      const f = group[i];
      const share = i === group.length - 1 ? remaining : Math.min(remaining, Math.round((losses * f.strength) / Math.max(1, total)));
      f.strength = Math.max(0, f.strength - share);
      remaining -= share;
      applyCoarseBlueLosses(campaign, f, share, rng, record);
    }
  };
  distribute(sides.attackers, atkLosses);
  distribute(sides.defenders, defLosses);

  const principalAtk = forceById(front, battle.attackerId);
  record.won = attackerWins === (principalAtk.side === 'blue');
  campaign.log.push(record);

  const winners = attackerWins ? sides.attackers : sides.defenders;
  const losers = attackerWins ? sides.defenders : sides.attackers;
  for (const f of [...winners, ...losers]) f.engagedIn = null;

  // Winner occupies the site NODE; a mid-edge fight leaves positions alone.
  if (battle.site.kind === 'node') {
    const nodeId = battle.site.nodeId;
    for (const w of winners) if (w.strength > 0) w.pos = { kind: 'node', nodeId };
    const winnerSide = winners[0]?.side;
    if (winnerSide && front.controlByNode[nodeId] !== winnerSide) {
      front.controlByNode[nodeId] = winnerSide;
      pushEvent(front, { min: front.clockMin, kind: 'capture', text: `${t.nodes[nodeId].name} taken`, forceIds: winners.map((f) => f.id), nodeId });
    }
  }
  // Losers: beaten crossing-assault attackers take the setback down their
  // approach; everyone else walks the §3.6 retreat.
  for (const l of losers) {
    if (l.strength <= 0) {
      pushEvent(front, { min: front.clockMin, kind: 'overrun', text: `${l.name} is destroyed`, forceIds: [l.id] });
      continue;
    }
    const beatenAssault = !attackerWins && (battleClass === 'bridge-assault' || battleClass === 'ford-assault') && sides.attackers.includes(l);
    if (beatenAssault && battle.approachEdgeId !== null) {
      const e = edgeById(t, battle.approachEdgeId);
      const siteNode = battle.site.kind === 'node' ? battle.site.nodeId : (l.pos.kind === 'edge' && l.pos.dir === 1 ? e.b : e.a);
      const dir: 1 | -1 = e.a === siteNode ? 1 : -1;
      const s = dir === 1 ? Math.min(e.lengthM, RETREAT_SETBACK_M) : Math.max(0, e.lengthM - RETREAT_SETBACK_M);
      f2Park(l, e.id, s, dir);
      pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${l.name} thrown back from the crossing`, forceIds: [l.id] });
    } else {
      retreatForce(front, l, battle.approachEdgeId);
    }
  }
  front.battles.splice(front.battles.indexOf(battle), 1);
  const ev: TheaterEvent = {
    min: front.clockMin,
    kind: 'battle-resolved',
    text: `${attackerWins ? 'Attack succeeds' : 'Defence holds'} at ${siteName(t, battle.site)}`,
    forceIds: [battle.attackerId, battle.defenderId, ...battle.joined],
    nodeId: battle.site.kind === 'node' ? battle.site.nodeId : undefined,
  };
  pushEvent(front, ev);
  return { attackerWon: attackerWins, battleClass, record };
}

function f2Park(f: Force, edgeId: number, s: number, dir: 1 | -1): void {
  f.pos = { kind: 'edge', edgeId, s, dir };
  f.path = [];
  f.dwellMin = 0;
}

function siteName(t: FrontV2['theater'], site: CoarseBattle['site']): string {
  return site.kind === 'node' ? t.nodes[site.nodeId].name : edgeById(t, site.edgeId).kind === 'rail' ? 'the line' : 'the road';
}

export interface StepOptions {
  nightMult?: number;
  // Return true to open a timed coarse battle for this contact; false to
  // leave it PENDING for the caller (the player's contact flow — pin+queue).
  autoBattle?: (c: Contact) => boolean;
  supply?: boolean; // S50: run the hourly supply trace (CampaignConfig.supply)
}

export interface StepResult {
  events: TheaterEvent[];
  resolved: { attackerWon: boolean; battleClass: BattleClass; record: BattleRecord }[];
  pendingContacts: Contact[];
}

// §3.3 composition, one strategic minute.
export function stepWar(front: FrontV2, campaign: Campaign, opts: StepOptions = {}): StepResult {
  front.clockMin++;
  if (front.clockMin >= (front.day + 1) * 1440) front.day++;
  // 0) Hourly supply trace (S50) — before battles resolve, so a fight ending
  // on the hour reads the tier of the hour it ends in.
  if (opts.supply) updateSupplyMinute(front);
  const events: TheaterEvent[] = [];
  const done: StepResult['resolved'] = [];

  // 1) Resolve due battles, ascending id.
  for (const b of [...front.battles].sort((p, q) => p.id - q.id)) {
    if (b.endMin <= front.clockMin) done.push(resolveBattleV2(front, campaign, b, opts.nightMult ?? 1.0));
  }
  // 2) Advance all unengaged forces.
  events.push(...stepMovement(front));
  // 3) Contacts over final positions.
  const contacts = detectContacts(front);
  const pending: Contact[] = [];
  for (const c of contacts) {
    if ((opts.autoBattle ?? (() => true))(c)) openBattle(front, c);
    else {
      haltAtContact(front, c);
      pending.push(c);
    }
  }
  // 4) Reinforcement joins: an unengaged force within contact range of a
  // battle site joins its side's fight.
  for (const f of front.forces) {
    if (f.engagedIn !== null || f.strength <= 0) continue;
    for (const b of front.battles) {
      if (graphGap(front.theater, f.pos, b.site) <= 300) {
        joinBattle(front, b, f);
        break;
      }
    }
  }
  return { events, resolved: done, pendingContacts: pending };
}
