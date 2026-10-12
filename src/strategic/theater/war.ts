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
import { battleSiteOf, COARSE_DEF_MULT, CROSSING_ASSAULT_MULT, type BattleClass, type NetPos, type Theater, type TheaterEdge } from '../theater';
import {
  edgeById,
  incidentFoot,
  otherEnd,
  pushEvent,
  route,
  standForce,
  type CoarseBattle,
  type Force,
  type FrontV2,
  type TheaterEvent,
} from './force';
import { CONTACT_M, detectContacts, graphGap, haltAtContact, type Contact } from './contact';
import { stepMovement } from './step';
import { defStrength, effStrength } from './combat';
import { updateSupplyMinute } from './supply';
import { updateIntelMinute } from '../intel';

export const RETREAT_SETBACK_M = 1500;
export const THREAT_M = 1500;
export const INFILTRATE_MIN = 120; // = the pinned 8 cells x 15 min
const TRIVIAL_DURATION_MIN = 15;

// OQ3 (B): a fought battle charges the theater the same bounded time the
// coarse resolver would have — the debrief return steps this many minutes.
// endMin - startMin is battleDuration-capped at 240 except when a late join
// re-floors endMin at now+15, so the cap is re-asserted here.
export const CATCH_UP_CAP_MIN = 240;
// S51 combat-fatigue lumps: coarse participants +0.15; a FOUGHT battle
// (bridge2 applyTheaterOutcome) charges +0.25 — a real fight is worse.
export const COARSE_BATTLE_FATIGUE = 0.15;
export const FOUGHT_BATTLE_FATIGUE = 0.25;
export function battleCatchUpMin(b: CoarseBattle): number {
  return Math.min(CATCH_UP_CAP_MIN, Math.max(0, b.endMin - b.startMin));
}

export function forceById(front: FrontV2, id: number): Force {
  const f = front.forces.find((x) => x.id === id);
  if (!f) throw new Error(`forceById: unknown force ${id}`);
  return f;
}

// The defender's ground: the battle class of a site and what it multiplies
// the defence by. ONE chain for the resolver, the walkover test, the planner
// and the contact card, so none of them can weigh a crossing differently.
export function siteDefence(t: Theater, site: NetPos, approachEdgeId: number | null | undefined): { battleClass: BattleClass; siteKey: number; mult: number } {
  const { battleClass, siteKey } = battleSiteOf(t, site, approachEdgeId ?? undefined);
  const crossing = battleClass === 'bridge-assault' || battleClass === 'ford-assault';
  return { battleClass, siteKey, mult: COARSE_DEF_MULT[battleClass] * (crossing ? CROSSING_ASSAULT_MULT : 1) };
}

// A walkover (jtbug #786, resolves #137): one side has TRIVIAL_RATIO times
// the other's EFFECTIVE strength. Supply, fatigue and posture count on both
// sides, so a starved garrison is a walkover that a fresh one is not. It read
// raw headcount before, blind to the one lever the supply rules give. This is
// the auto-resolve offer and the forced winner.
//   atkEff   the attackers' effective strength
//   defEff   the defenders' effective strength
//   defHeld  the same with digging in counted (defStrength)
// Earthworks can DENY the attacker a walkover. They never GRANT the defender
// one: a dug-in company is hard to shift, it is not sure to rout whoever
// comes.
//
// Ground is NOT in the test, and that is measured, not overlooked. With the
// terrain multiplier denying a walkover (a fresh garrison in a town or behind
// a bridge), AI blue won 2 of 16 pin wars, or 3 with towns only: the remnant
// garrisons it used to walk over became fights it loses one time in five,
// and losing a coarse fight is a rout. The floor for this lane is 4 of 16.
export function walkover(atkEff: number, defEff: number, defHeld: number): 'attacker' | 'defender' | null {
  if (atkEff <= 0 || defEff <= 0) return null;
  if (atkEff >= defHeld * TRIVIAL_RATIO) return 'attacker';
  if (defEff >= atkEff * TRIVIAL_RATIO) return 'defender';
  return null;
}

// The walkover test for a contact between two forces, before a battle exists.
export function contactWalkover(atk: Force, def: Force): 'attacker' | 'defender' | null {
  return walkover(effStrength(atk), effStrength(def), defStrength(def));
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
  const forced = contactWalkover(atk, def);
  const battle: CoarseBattle = {
    id: front.nextBattleId++,
    site: c.site,
    attackerId: atk.id,
    defenderId: def.id,
    joined: [],
    startMin: front.clockMin,
    endMin: front.clockMin + battleDuration(atk.strength, def.strength, forced !== null),
    forced,
    // Mid-edge: the edge under the attacker. At a node: the edge it last
    // WALKED — an assault delivered onto a crossing node classifies
    // bridge/ford-assault from the bank it actually came from.
    approachEdgeId: atk.pos.kind === 'edge' ? atk.pos.edgeId : atk.lastEdgeId,
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
  standForce(front, f);
  battle.joined.push(f.id);
  const sides = battleSides(front, battle);
  battle.forced = walkover(sides.atkEff, sides.defenders.reduce((a, d) => a + effStrength(d), 0), sides.defEff);
  battle.endMin = Math.max(
    front.clockMin + 15,
    battle.startMin + battleDuration(sides.atkStrength, sides.defStrength, battle.forced !== null),
  );
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
    defEff: defenders.reduce((a, f) => a + defStrength(f), 0),
  };
}

// Where a force set back `m` metres from `fromNode` down edge `e` stands:
// PARKED there, or at the far end of a shorter road.
function setbackOn(e: TheaterEdge, fromNode: number, m = RETREAT_SETBACK_M): NetPos {
  const dir: 1 | -1 = e.a === fromNode ? 1 : -1;
  return { kind: 'edge', edgeId: e.id, s: dir === 1 ? Math.min(e.lengthM, m) : Math.max(0, e.lengthM - m), dir };
}

// The setback on a road, pulled in when an enemy stands on the full one: a
// remnant thrown back down this road earlier is parked at exactly
// RETREAT_SETBACK_M. Each try is more than contact range short of the last,
// so one of them stands clear of that remnant. Null when none is clear.
// Dropping the whole road instead left a force with one road out nowhere to
// go, and it was overrun where it could have stood 400 m short.
const SETBACK_STEP_M = CONTACT_M + 100;
function clearLanding(front: FrontV2, f: Force, e: TheaterEdge, fromNode: number): NetPos | null {
  for (let m = RETREAT_SETBACK_M; m > CONTACT_M; m -= SETBACK_STEP_M) {
    const pos = setbackOn(e, fromNode, m);
    if (clearOfEnemies(front, f, pos)) return pos;
  }
  return null;
}

// A retreat that ends inside contact range of an enemy is not a retreat: the
// two re-contact the same minute. Measured over the 16 pin wars: 6 beaten
// forces were in a new battle the minute they fell back, 5 of them standing
// on the exact metre an earlier loser of the other side was parked on.
function clearOfEnemies(front: FrontV2, f: Force, pos: NetPos): boolean {
  return front.forces.every((g) => g.side === f.side || g.strength <= 0 || graphGap(front.theater, pos, g.pos) > CONTACT_M);
}

// A beaten crossing assault is thrown back down its approach. When that
// landing is not clear (a short road, an enemy on it) the force falls back
// through the node behind it instead, by the same graph retreat as any loser.
//
// `approach` is the road the attacker last WALKED, and that is not always a
// road into the site: an attacker standing on the next node, inside contact
// range, never walked one (jtbug #801). Then there is no approach to be thrown
// back down, and it falls back by the graph retreat.
export function throwBack(front: FrontV2, f: Force, approach: TheaterEdge, siteNode: number): void {
  if (approach.a !== siteNode && approach.b !== siteNode) return retreatForce(front, f, approach.id);
  const landing = clearLanding(front, f, approach, siteNode);
  if (landing) {
    f.pos = landing;
    standForce(front, f);
    pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${f.name} thrown back from the crossing`, forceIds: [f.id] });
    return;
  }
  f.pos = { kind: 'node', nodeId: otherEnd(approach, siteNode) };
  retreatForce(front, f, approach.id);
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
  f.dugMin = 0; // wherever it ends up, the position is lost
  const enemies = front.forces.filter((g) => g.side !== f.side && g.strength > 0);
  const nearEnemy = (n: number): number => {
    let best = Infinity;
    for (const g of enemies) best = Math.min(best, graphGap(t, { kind: 'node', nodeId: n }, g.pos));
    return best;
  };
  // The retreat pivots on a node: the force's own, or the end of its road
  // BEHIND its direction of travel. A force parked facing its rear (a company
  // thrown back from a crossing) has the enemy behind it, so when an enemy
  // stands between it and that end, and none between it and the other, it
  // goes out by the other. Reading only the direction of travel sent it
  // through the node it had just been thrown back from.
  const pivot = (): number => {
    const pos = f.pos;
    if (pos.kind === 'node') return pos.nodeId;
    const e = edgeById(t, pos.edgeId);
    const through = (end: number): boolean =>
      enemies.some((g) => (g.pos.kind === 'node' ? g.pos.nodeId === end : g.pos.edgeId === e.id && (end === e.b ? g.pos.s > pos.s : g.pos.s < pos.s)));
    const [behind, ahead] = pos.dir === 1 ? [e.a, e.b] : [e.b, e.a];
    return through(behind) && !through(ahead) ? ahead : behind;
  };
  const nodeId = pivot();
  const candidates = incidentFoot(t, nodeId)
    .filter((e) => e.id !== approachEdgeId)
    .filter((e) => nearEnemy(otherEnd(e, nodeId)) > THREAT_M)
    .map((e) => {
      const far = otherEnd(e, nodeId);
      const control = front.controlByNode[far] === f.side ? 0 : front.controlByNode[far] === null ? 1 : 2;
      return { e, far, control, threat: -nearEnemy(far), len: e.lengthM, landing: clearLanding(front, f, e, nodeId) };
    })
    // The far node being clear is not enough: an enemy thrown back earlier
    // can be parked on this very road, at this very setback.
    .filter((c): c is typeof c & { landing: NetPos } => c.landing !== null)
    .sort((p, q) => p.control - q.control || p.threat - q.threat || p.len - q.len || p.e.id - q.e.id);

  if (candidates.length > 0) {
    f.pos = candidates[0].landing;
    standForce(front, f);
    pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${f.name} falls back`, forceIds: [f.id] });
    return;
  }

  if (opts.trapped === 'stay') {
    // Voluntary break-off with nowhere to go: HOLD — and hold means stand
    // still whatever the caller left in the path, not resume the march
    // that caused the contact.
    standForce(front, f);
    return;
  }

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
      standForce(front, f);
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
  const { battleClass, siteKey, mult } = siteDefence(t, battle.site, battle.approachEdgeId);
  const terrainMult = lightAt(battle.startMin) < 0.25 ? mult * nightMult : mult;

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

  // S51: a coarse battle is hours under fire — every participant tires.
  for (const f of [...sides.attackers, ...sides.defenders]) {
    f.fatigue = Math.min(1, f.fatigue + COARSE_BATTLE_FATIGUE);
  }

  const principalAtk = forceById(front, battle.attackerId);
  record.won = attackerWins === (principalAtk.side === 'blue');
  campaign.log.push(record);

  const winners = attackerWins ? sides.attackers : sides.defenders;
  const losers = attackerWins ? sides.defenders : sides.attackers;
  for (const f of [...winners, ...losers]) f.engagedIn = null;

  // Winner occupies the site NODE; a mid-edge fight leaves positions alone.
  if (battle.site.kind === 'node') {
    const nodeId = battle.site.nodeId;
    for (const w of winners) {
      if (w.strength <= 0 || (w.pos.kind === 'node' && w.pos.nodeId === nodeId)) continue;
      w.pos = { kind: 'node', nodeId };
      w.dugMin = 0;
    }
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
    l.repulsedAtMin = front.clockMin;
    const beatenAssault = !attackerWins && (battleClass === 'bridge-assault' || battleClass === 'ford-assault') && sides.attackers.includes(l);
    if (beatenAssault && battle.approachEdgeId !== null) {
      const e = edgeById(t, battle.approachEdgeId);
      const siteNode = battle.site.kind === 'node' ? battle.site.nodeId : (l.pos.kind === 'edge' && l.pos.dir === 1 ? e.b : e.a);
      throwBack(front, l, e, siteNode);
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

function siteName(t: FrontV2['theater'], site: CoarseBattle['site']): string {
  return site.kind === 'node' ? t.nodes[site.nodeId].name : edgeById(t, site.edgeId).kind === 'rail' ? 'the line' : 'the road';
}

// A screening force does not fight a stronger enemy: it falls back in front
// of it, by the same graph retreat as a beaten force, with no losses. The
// enemy's march goes on. True when the contact ended that way. A screen with
// nowhere to go stays and fights.
function screenFallsBack(front: FrontV2, c: Contact): boolean {
  const pair = [forceById(front, c.attackerId), forceById(front, c.defenderId)];
  for (const [f, other] of [pair, [pair[1], pair[0]]]) {
    if (f.posture !== 'screen' || other.strength <= f.strength) continue;
    const was = f.pos;
    retreatForce(front, f, other.pos.kind === 'edge' ? other.pos.edgeId : other.lastEdgeId, { trapped: 'stay' });
    if (f.pos !== was) return true;
  }
  return false;
}

// The free forces inside contact range of a fight's site, other than the two
// that are fighting it: the ones the join step folds into a coarse battle and
// the ones whose fire supports a fought one. ONE list for the contact card
// and for staging, so the card's line is true.
export function supportersOf(front: FrontV2, site: NetPos, principals: readonly number[]): Force[] {
  return front.forces
    .filter((f) => !principals.includes(f.id) && f.strength > 0 && f.engagedIn === null && graphGap(front.theater, f.pos, site) <= CONTACT_M)
    .sort((a, b) => a.id - b.id);
}

// Who fights a contact the player answers in person (jtbug #807): the two
// forces that met, and every free force of the AI's side inside contact
// range of the site. A fought battle used to field the two that met and no
// more, so a garrison and the battlegroup that had marched in to hold the
// town with it were beaten one after the other, the second by a company
// that had not moved, and nothing red did to mass counted against a player.
// The player's own companies in range still lend their fire and do not
// field: a battle is fought with one roster.
export function contactStack(front: FrontV2, c: Pick<Contact, 'attackerId' | 'defenderId' | 'site'>): { attackers: Force[]; defenders: Force[] } {
  const atk = forceById(front, c.attackerId);
  const def = forceById(front, c.defenderId);
  const more = supportersOf(front, c.site, [atk.id, def.id]).filter((f) => f.side === 'red');
  return { attackers: [atk, ...more.filter((f) => f.side === atk.side)], defenders: [def, ...more.filter((f) => f.side === def.side)] };
}

// The walkover test for that contact: the one a battle reads once the stack
// has joined it.
export function stackWalkover(front: FrontV2, c: Pick<Contact, 'attackerId' | 'defenderId' | 'site'>): 'attacker' | 'defender' | null {
  const { attackers, defenders } = contactStack(front, c);
  const sum = (fs: Force[], of: (f: Force) => number): number => fs.reduce((a, f) => a + of(f), 0);
  return walkover(sum(attackers, effStrength), sum(defenders, effStrength), sum(defenders, defStrength));
}

// Open the battle for a contact the player fights: the stack joins it now.
export function openFoughtBattle(front: FrontV2, c: Contact): CoarseBattle {
  const { attackers, defenders } = contactStack(front, c);
  const battle = openBattle(front, c);
  for (const f of [...attackers.slice(1), ...defenders.slice(1)]) joinBattle(front, battle, f);
  return battle;
}

export interface StepOptions {
  nightMult?: number;
  // Return true to open a timed coarse battle for this contact; false to
  // leave it PENDING for the caller (the player's contact flow — pin+queue).
  autoBattle?: (c: Contact) => boolean;
  supply?: boolean; // S50: run the hourly supply trace (CampaignConfig.supply)
  recon?: 'omniscient' | 'contacts'; // S53: run the 15-min detection sweep
  nightTempo?: boolean; // S52: light ramps march pace (CampaignConfig.nightTempo)
}

export interface StepResult {
  events: TheaterEvent[];
  resolved: { attackerWon: boolean; battleClass: BattleClass; record: BattleRecord }[];
  pendingContacts: Contact[];
}

// §3.3 composition, one strategic minute.
export function stepWar(front: FrontV2, campaign: Campaign, opts: StepOptions = {}): StepResult {
  front.clockMin++;
  // Day d runs from midnight to midnight: [(d - 1) x 1440, d x 1440). Day 1
  // starts at 06:00 and is the short one. The roll used to sit a day late
  // ((day + 1) x 1440), so "Day 1" lasted 42 hours and a war of D days ran
  // D + 1 of them.
  if (front.clockMin >= front.day * 1440) front.day++;
  // 0) Hourly supply trace (S50) — before battles resolve, so a fight ending
  // on the hour reads the tier of the hour it ends in.
  if (opts.supply) updateSupplyMinute(front);
  const events: TheaterEvent[] = [];
  const done: StepResult['resolved'] = [];

  // 1) Resolve due battles, ascending id.
  for (const b of [...front.battles].sort((p, q) => p.id - q.id)) {
    if (b.endMin <= front.clockMin) done.push(resolveBattleV2(front, campaign, b, opts.nightMult ?? 1.0));
  }
  // 2) Advance all unengaged forces (fatigue + pace kernel inside).
  events.push(...stepMovement(front, { nightTempo: opts.nightTempo }));
  // 3) Contacts over final positions.
  const contacts = detectContacts(front);
  const pending: Contact[] = [];
  for (const c of contacts) {
    if (screenFallsBack(front, c)) continue;
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
      if (graphGap(front.theater, f.pos, b.site) <= CONTACT_M) {
        joinBattle(front, b, f);
        break;
      }
    }
  }
  // 5) FOW detection sweep (S53) over FINAL positions, 15-min cadence.
  if (opts.recon === 'contacts') updateIntelMinute(front);
  return { events, resolved: done, pendingContacts: pending };
}
