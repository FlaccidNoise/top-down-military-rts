// The V2 battle bridge (S20/§3.10): a theater contact becomes a REAL tactical
// battle through the EXISTING makeStrategicBattle — via a two-cell adapter
// front, so the tuned staging path (TO&E fielding, garrison anchors, ford
// spawns, interiors) runs byte-for-byte unmodified and stays pinned by its
// own tests. The outcome path mirrors resolveBattleV2's control/retreat tail
// so a fought battle and a coarse battle mutate the theater by the same
// rules.
import type { Campaign, BattleRecord } from '../campaign/campaign';
import type { Sim } from '../sim/sim';
import type { BreachEvent } from '../sim/sim';
import type { RedCommander } from '../sim/ai';
import { applyBattleResults } from '../campaign/campaign';
import { ARMOR_KINDS, makeStrategicBattle } from './bridge';
import { barrageRunning, REQ_ARMOR, REQ_BARRAGES } from './requisition';
import type { Chit, Front } from './front';
import { battleSiteOf, BATTLE_CLASS_TO_MAPKIND, type BattleClass } from './theater';
import { pushEvent, type CoarseBattle, type FrontV2 } from './theater/force';
import { battleSides, forceById, retreatForce, supportersOf, throwBack } from './theater/war';
import { edgeById } from './theater/force';
import { syncStrengthsV2 } from './theater/sync';
import { SUPPLY_AMMO_MULT, supplyTierOf } from './theater/supply';
import { dugIn, FATIGUE_STAMINA_SLOPE } from './theater/step';
import { FOUGHT_BATTLE_FATIGUE } from './theater/war';

export const DIG_BARRAGES = 1;
// Concentration (jtbug #786): each friendly company inside contact range of a
// fought battle lends this many barrages: its mortars, firing from where it
// stands. It does not field. A force that JOINED the battle (openFoughtBattle:
// the AI's forces at the site) fields with its principal, as one force.
export const SUPPORT_BARRAGES = 1;

export interface TheaterBattle {
  sim: Sim;
  commander: RedCommander;
  blueCommander: RedCommander;
  name: string;
  companyIndex: number;
  battleClass: BattleClass;
  siteKey: number;
}

// Stage a tactical battle for a pending theater battle. The adapter front
// carries exactly what the staging path reads: two chits, two cells (the
// attacker's cell terrain encodes the ford-assault spawn rule; the defended
// cell's terrain IS the MapKind), and the clock.
export function makeTheaterBattle(c: Campaign, front: FrontV2, battle: CoarseBattle): TheaterBattle {
  const atk = forceById(front, battle.attackerId);
  const def = forceById(front, battle.defenderId);
  const { battleClass, siteKey } = battleSiteOf(front.theater, battle.site, battle.approachEdgeId ?? undefined);
  const kind = BATTLE_CLASS_TO_MAPKIND[battleClass];
  const seed = (battle.startMin * 7919 + siteKey) >>> 0; // un-xor'd tactical form (R4)

  // A side's whole stack stages as one force (makeStrategicBattle caps what
  // it fields: the men past the cap sit the battle out, as they did for one
  // force too strong for the field).
  const sides = battleSides(front, battle);
  const chitOf = (f: typeof atk, id: number, cell: number): Chit => ({
    id,
    side: f.side,
    name: f.name,
    cell,
    path: [],
    progress: 0,
    strength: f === atk ? sides.atkStrength : sides.defStrength,
    companyIndex: f.companyIndex,
  });
  const adapter = {
    clockMin: front.clockMin,
    chits: [chitOf(atk, 0, 0), chitOf(def, 1, 1)],
    sector: {
      w: 2,
      h: 1,
      name: front.theater.name,
      cells: [
        // Attacker cell: 'river' triggers the ford-assault spawn doctrine
        // (suppressed, mid-crossing); anything else is inert.
        { terrain: battleClass === 'ford-assault' ? 'river' : 'open', owner: atk.side, objective: false },
        { terrain: kind, owner: def.side, objective: true },
      ],
    },
  } as unknown as Front;

  // Requisition: an armour section attached to the attacking company fights
  // on ground a hull can fight over, and that is one of its attacks spent.
  const armour = atk.armorAttacks > 0 && ARMOR_KINDS.has(battleClass === 'ford-assault' ? 'river' : kind);
  if (armour) atk.armorAttacks--;
  const staged = makeStrategicBattle(c, adapter, { attackerId: 0, defenderId: 1, cell: 1 }, seed, armour ? { extraArmor: REQ_ARMOR } : {});
  // S50 supply: staging ammo scales 100/50/25 by each side's OWN tier, ammo
  // AND ammoStart together — ammoStart is areaFire's discipline denominator,
  // and scaling only the pool would silently kill MG suppression (hazard R1).
  // Zero rng, post-staging, full tier returns untouched — the pinned staging
  // path stays byte-identical when nobody is cut off.
  for (const f of [atk, def]) {
    const mult = SUPPLY_AMMO_MULT[supplyTierOf(f.untracedMin)];
    if (mult >= 1) continue;
    for (const s of staged.sim.soldiers) {
      if (s.side !== f.side) continue;
      let start = 0;
      for (const k of Object.keys(s.ammo) as (keyof typeof s.ammo)[]) {
        if (s.ammo[k]) s.ammo[k] = Math.max(1, Math.floor(s.ammo[k]! * mult));
        start += s.ammo[k] ?? 0;
      }
      s.ammoStart = start;
    }
  }
  // S51 fatigue: a worn force fields tired men — stamina capped at
  // 1 - 0.5 x fatigue, the exact FORD_STAMINA shape (min, never set), zero
  // rng, fresh forces untouched.
  for (const f of [atk, def]) {
    const cap = 1 - FATIGUE_STAMINA_SLOPE * f.fatigue;
    if (cap >= 1) continue;
    for (const s of staged.sim.soldiers) {
      if (s.side === f.side) s.stamina = Math.min(s.stamina, cap);
    }
  }
  // Postures (jtbug #786): a dug-in defender has registered its supporting
  // fire, so it fights with DIG_BARRAGES more barrages. A counter set after
  // staging: no rng, and a force that is not dug in stages as before.
  if (dugIn(def)) staged.sim.barragesLeft[def.side] += DIG_BARRAGES;
  // The same list the contact card names. A counter set after staging: no
  // rng, and a fight with nobody in range stages byte for byte as before.
  for (const f of supportersOf(front, battle.site, [atk.id, def.id])) staged.sim.barragesLeft[f.side] += SUPPORT_BARRAGES;
  // Requisition: artillery allotted to the operation for this cycle.
  if (barrageRunning(front)) staged.sim.barragesLeft.blue += REQ_BARRAGES;
  const siteName =
    battle.site.kind === 'node'
      ? front.theater.nodes[battle.site.nodeId].name
      : front.theater.regions[front.theater.nodes[edgeById(front.theater, battle.site.edgeId).a].regionId]?.name ?? 'the road';
  return {
    ...staged,
    name: `Day ${front.day} — ${siteName}`,
    battleClass,
    siteKey,
  };
}

// A fought battle's return to the theater: same mutation rules as the coarse
// resolver — roster reconciliation, red attrition, control paint, §3.6
// retreat, crossing setback for beaten assaults.
export function applyTheaterOutcome(
  c: Campaign,
  front: FrontV2,
  battle: CoarseBattle,
  battleClass: BattleClass,
  sim: Sim,
): { record: BattleRecord; redLosses: number; nodeTaken: number | null; breaches: BreachEvent[] } {
  const atk = forceById(front, battle.attackerId);
  const def = forceById(front, battle.defenderId);
  const sides = battleSides(front, battle);
  const attackerWon = sim.winner === atk.side;
  const record = applyBattleResults(c, sim, sim.winner === 'blue');
  // Red's dead and downed come off the red forces that fought, in proportion
  // to what each brought (the coarse resolver's rule).
  const redLosses = sim.soldiers.filter((s) => s.side === 'red' && (!s.alive || s.downed)).length;
  const reds = atk.side === 'red' ? sides.attackers : sides.defenders;
  const brought = reds.reduce((a, f) => a + f.strength, 0);
  let remaining = redLosses;
  reds.forEach((f, i) => {
    const share = i === reds.length - 1 ? remaining : Math.min(remaining, Math.round((redLosses * f.strength) / Math.max(1, brought)));
    f.strength = Math.max(0, f.strength - share);
    remaining -= share;
  });

  // S51: a fought battle wears harder than a coarse one.
  for (const f of [...sides.attackers, ...sides.defenders]) {
    f.fatigue = Math.min(1, f.fatigue + FOUGHT_BATTLE_FATIGUE);
    f.engagedIn = null;
  }
  const idx = front.battles.indexOf(battle);
  if (idx >= 0) front.battles.splice(idx, 1);

  const winners = attackerWon ? sides.attackers : sides.defenders;
  const losers = attackerWon ? sides.defenders : sides.attackers;
  let nodeTaken: number | null = null;
  if (battle.site.kind === 'node') {
    const nodeId = battle.site.nodeId;
    for (const w of winners) if (w.strength > 0) w.pos = { kind: 'node', nodeId };
    if (front.controlByNode[nodeId] !== winners[0].side) {
      front.controlByNode[nodeId] = winners[0].side;
      nodeTaken = nodeId;
      pushEvent(front, {
        min: front.clockMin,
        kind: 'capture',
        text: `${front.theater.nodes[nodeId].name} taken`,
        forceIds: winners.map((f) => f.id),
        nodeId,
      });
    }
  }
  for (const loser of losers) {
    if (loser.strength <= 0) {
      pushEvent(front, { min: front.clockMin, kind: 'overrun', text: `${loser.name} is destroyed`, forceIds: [loser.id] });
      continue;
    }
    loser.repulsedAtMin = front.clockMin;
    const beatenAssault = !attackerWon && (battleClass === 'bridge-assault' || battleClass === 'ford-assault');
    if (beatenAssault && battle.approachEdgeId !== null && battle.site.kind === 'node') {
      throwBack(front, loser, edgeById(front.theater, battle.approachEdgeId), battle.site.nodeId);
    } else {
      retreatForce(front, loser, battle.approachEdgeId);
    }
  }
  pushEvent(front, {
    min: front.clockMin,
    kind: 'battle-resolved',
    text: `${attackerWon ? 'Attack succeeds' : 'Defence holds'}${battle.site.kind === 'node' ? ` at ${front.theater.nodes[battle.site.nodeId].name}` : ''}`,
    forceIds: [...sides.attackers, ...sides.defenders].map((f) => f.id),
    nodeId: battle.site.kind === 'node' ? battle.site.nodeId : undefined,
  });
  syncStrengthsV2(c, front);
  return { record, redLosses, nodeTaken, breaches: sim.breachLog };
}
