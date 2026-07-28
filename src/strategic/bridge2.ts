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
import { makeStrategicBattle } from './bridge';
import type { Chit, Front } from './front';
import { battleSiteOf, BATTLE_CLASS_TO_MAPKIND, type BattleClass } from './theater';
import { pushEvent, type CoarseBattle, type FrontV2 } from './theater/force';
import { forceById, retreatForce, RETREAT_SETBACK_M } from './theater/war';
import { edgeById } from './theater/force';
import { syncStrengthsV2 } from './theater/sync';

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

  const chitOf = (f: typeof atk, id: number, cell: number): Chit => ({
    id,
    side: f.side,
    name: f.name,
    cell,
    path: [],
    progress: 0,
    strength: f.strength,
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

  const staged = makeStrategicBattle(c, adapter, { attackerId: 0, defenderId: 1, cell: 1 }, seed);
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
  const attackerWon = sim.winner === atk.side;
  const record = applyBattleResults(c, sim, sim.winner === 'blue');
  const redLosses = sim.soldiers.filter((s) => s.side === 'red' && (!s.alive || s.downed)).length;
  const redForce = atk.side === 'red' ? atk : def;
  redForce.strength = Math.max(0, redForce.strength - redLosses);

  atk.engagedIn = null;
  def.engagedIn = null;
  const idx = front.battles.indexOf(battle);
  if (idx >= 0) front.battles.splice(idx, 1);

  const winner = attackerWon ? atk : def;
  const loser = attackerWon ? def : atk;
  let nodeTaken: number | null = null;
  if (battle.site.kind === 'node') {
    const nodeId = battle.site.nodeId;
    if (winner.strength > 0) winner.pos = { kind: 'node', nodeId };
    if (front.controlByNode[nodeId] !== winner.side) {
      front.controlByNode[nodeId] = winner.side;
      nodeTaken = nodeId;
      pushEvent(front, {
        min: front.clockMin,
        kind: 'capture',
        text: `${front.theater.nodes[nodeId].name} taken`,
        forceIds: [winner.id],
        nodeId,
      });
    }
  }
  if (loser.strength > 0) {
    const beatenAssault = !attackerWon && (battleClass === 'bridge-assault' || battleClass === 'ford-assault');
    if (beatenAssault && battle.approachEdgeId !== null && battle.site.kind === 'node') {
      const e = edgeById(front.theater, battle.approachEdgeId);
      const dir: 1 | -1 = e.a === battle.site.nodeId ? 1 : -1;
      const s = dir === 1 ? Math.min(e.lengthM, RETREAT_SETBACK_M) : Math.max(0, e.lengthM - RETREAT_SETBACK_M);
      loser.pos = { kind: 'edge', edgeId: e.id, s, dir };
      loser.path = [];
      loser.dwellMin = 0;
      pushEvent(front, { min: front.clockMin, kind: 'retreat', text: `${loser.name} thrown back from the crossing`, forceIds: [loser.id] });
    } else {
      retreatForce(front, loser, battle.approachEdgeId);
    }
  } else {
    pushEvent(front, { min: front.clockMin, kind: 'overrun', text: `${loser.name} is destroyed`, forceIds: [loser.id] });
  }
  pushEvent(front, {
    min: front.clockMin,
    kind: 'battle-resolved',
    text: `${attackerWon ? 'Attack succeeds' : 'Defence holds'}${battle.site.kind === 'node' ? ` at ${front.theater.nodes[battle.site.nodeId].name}` : ''}`,
    forceIds: [atk.id, def.id],
    nodeId: battle.site.kind === 'node' ? battle.site.nodeId : undefined,
  });
  syncStrengthsV2(c, front);
  return { record, redLosses, nodeTaken, breaches: sim.breachLog };
}
