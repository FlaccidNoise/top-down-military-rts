import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { makeTheater } from '../src/strategic/theatergen';
import { orderMove, stepMovement } from '../src/strategic/theater/step';
import { addForce, type Force, type FrontV2 } from '../src/strategic/theater/force';
import { battleDuration, joinBattle, openBattle, resolveBattleV2, retreatForce, stepWar } from '../src/strategic/theater/war';
import type { WarGoals } from '../src/strategic/goals';
import { OmniscientIntel } from '../src/strategic/intel';
import { BLUE_V2, Commander2, REORG_MIN } from '../src/strategic/planner';
import { battleSiteOf, MOVE_MPM, type Theater, type TheaterEdge, type Vec } from '../src/strategic/theater';

// Corridor fixture with a bridge site for crossing-assault mechanics.
//   0 --e0(3000m)-- 1(bridge) --e1(3000m)-- 2 --e2(3000m)-- 3
const N = (id: number, x: number, kind: Theater['nodes'][number]['kind'], crossing: Theater['nodes'][number]['crossing'] = null): Theater['nodes'][number] => ({
  id, pos: { x, y: 1000 }, kind, name: `n${id}`, regionId: 0, crossing, rank: 2,
});
const E = (id: number, a: number, b: number, lengthM: number, pa: Vec, pb: Vec): TheaterEdge => ({
  id, a, b, kind: 'road', moveClass: 'road', polyline: [pa, pb], lengthM, paceMpm: MOVE_MPM.road, rank: 1,
});
const FIX: Theater = {
  version: 1, seed: 0, name: 'war fixture', boundsM: { w: 12000, h: 2000 },
  nodes: [N(0, 0, 'town'), N(1, 3000, 'bridge', { riverId: 0, kind: 'bridge' }), N(2, 6000, 'village'), N(3, 9000, 'town')],
  edges: [
    E(0, 0, 1, 3000, { x: 0, y: 1000 }, { x: 3000, y: 1000 }),
    E(1, 1, 2, 3000, { x: 3000, y: 1000 }, { x: 6000, y: 1000 }),
    E(2, 2, 3, 3000, { x: 6000, y: 1000 }, { x: 9000, y: 1000 }),
  ],
  regions: [{ id: 0, polygon: [{ x: 0, y: 0 }, { x: 12000, y: 0 }, { x: 12000, y: 2000 }, { x: 0, y: 2000 }], centroid: { x: 6000, y: 1000 }, bbox: { x0: 0, y0: 0, x1: 12000, y1: 2000 }, areaM2: 2.4e7, terrainClass: 'farmland', name: 'r0', seatNodeId: null }],
  rivers: [{ id: 0, name: 'La Guerre', polyline: [{ x: 3000, y: 0 }, { x: 3000, y: 2000 }], widthClass: 'river' }],
  objectiveNodes: [3], sources: { blue: [0], red: [3] },
};

const front = (theater: Theater = FIX): FrontV2 => ({
  theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
  controlByNode: theater.nodes.map(() => null), battles: [], events: [], defileQueues: {},
});
const mk = (fr: FrontV2, side: 'blue' | 'red', nodeId: number, name: string, strength = 100, companyIndex = -1): Force =>
  addForce(fr, { side, name, pos: { kind: 'node', nodeId }, path: [], dwellMin: 0, strength, companyIndex, role: 'line', engagedIn: null, queuedAt: null });

describe('battle lifecycle', () => {
  it('duration is strength-scaled with the 240 cap and the trivial-15 collapse', () => {
    expect(battleDuration(138, 36, false)).toBe(45 + Math.round(1.4 * 36));
    expect(battleDuration(300, 300, false)).toBe(240);
    expect(battleDuration(200, 10, true)).toBe(15);
  });

  it('opening a battle pins both forces; orderMove refuses them as engaged', () => {
    const fr = front();
    const a = mk(fr, 'blue', 2, 'Able');
    const w = mk(fr, 'red', 2, 'Wache');
    const b = openBattle(fr, { attackerId: a.id, defenderId: w.id, site: w.pos, gapM: 0 });
    expect(a.engagedIn).toBe(b.id);
    expect(orderMove(fr, a.id, 3)).toEqual({ ok: false, reason: 'engaged' });
  });

  it('a reinforcement join adds strength, refloors endMin, and re-evaluates forced', () => {
    const fr = front();
    const a = mk(fr, 'blue', 2, 'Able', 200);
    const w = mk(fr, 'red', 2, 'Wache', 30); // 6.7:1 — forced walkover
    const b = openBattle(fr, { attackerId: a.id, defenderId: w.id, site: w.pos, gapM: 0 });
    expect(b.forced).toBe('attacker');
    expect(b.endMin - b.startMin).toBe(15);
    const relief = mk(fr, 'red', 2, 'Verstärkung', 80); // 200 vs 110 — 1.8:1
    fr.clockMin += 5;
    joinBattle(fr, b, relief);
    expect(b.forced).toBeNull();
    expect(b.endMin).toBeGreaterThanOrEqual(fr.clockMin + 15);
    expect(relief.engagedIn).toBe(b.id);
  });

  it('resolution: winner occupies and paints the node, loser retreats with an event', () => {
    const fr = front();
    const a = mk(fr, 'blue', 2, 'Able', 400, 0);
    const w = mk(fr, 'red', 2, 'Wache', 30);
    const c = newCampaign(7);
    const b = openBattle(fr, { attackerId: a.id, defenderId: w.id, site: { kind: 'node', nodeId: 2 }, gapM: 0 });
    fr.clockMin = b.endMin;
    const r = resolveBattleV2(fr, c, b);
    expect(r.attackerWon).toBe(true); // forced 13:1 walkover
    expect(fr.controlByNode[2]).toBe('blue');
    expect(a.pos).toEqual({ kind: 'node', nodeId: 2 });
    expect(a.engagedIn).toBeNull();
    expect(fr.battles).toHaveLength(0);
    expect(fr.events.some((e) => e.kind === 'battle-resolved')).toBe(true);
    if (w.strength > 0) expect(fr.events.some((e) => e.kind === 'retreat' || e.kind === 'overrun')).toBe(true);
  });

  it('a mid-battle save resumes identically: resolution depends on startMin, not on when it runs', () => {
    const build = () => {
      const fr = front();
      const a = mk(fr, 'blue', 2, 'Able', 150, 0);
      const w = mk(fr, 'red', 2, 'Wache', 100);
      const c = newCampaign(7);
      const b = openBattle(fr, { attackerId: a.id, defenderId: w.id, site: { kind: 'node', nodeId: 2 }, gapM: 0 });
      return { fr, c, b };
    };
    const live = build();
    live.fr.clockMin = live.b.endMin;
    const r1 = resolveBattleV2(live.fr, live.c, live.b);
    // "Loaded save": identical state, resolved at a LATER clock.
    const loaded = build();
    loaded.fr.clockMin = loaded.b.endMin + 37;
    const r2 = resolveBattleV2(loaded.fr, loaded.c, loaded.b);
    expect(r2.attackerWon).toBe(r1.attackerWon);
    expect(loaded.fr.forces.map((f) => f.strength)).toEqual(live.fr.forces.map((f) => f.strength));
  });

  it('a beaten crossing assault is thrown back down its approach edge', () => {
    const fr = front();
    const a = mk(fr, 'blue', 0, 'Able', 100, 0);
    a.pos = { kind: 'edge', edgeId: 0, s: 2900, dir: 1 }; // closing on the bridge
    a.path = [0];
    const w = mk(fr, 'red', 1, 'Brückenwache', 90);
    const b = openBattle(fr, { attackerId: a.id, defenderId: w.id, site: { kind: 'node', nodeId: 1 }, gapM: 100 });
    expect(b.approachEdgeId).toBe(0);
    // Force the defender to win regardless of the roll.
    b.forced = 'defender';
    fr.clockMin = b.endMin;
    resolveBattleV2(fr, newCampaign(7), b);
    expect(a.pos.kind).toBe('edge');
    if (a.pos.kind === 'edge') {
      expect(a.pos.edgeId).toBe(0);
      expect(Math.abs(a.pos.s - 1500)).toBeLessThanOrEqual(1); // RETREAT_SETBACK_M from the bridge
    }
    expect(fr.events.some((e) => e.text.includes('thrown back'))).toBe(true);
    // The loser is marked for the planner's reorganisation pause; the winner is not.
    expect(a.repulsedAtMin).toBe(fr.clockMin);
    expect(w.repulsedAtMin).toBeNull();
  });

  it('retreat: never down the approach axis, prefers friendly ground; cornered red is overrun', () => {
    const fr = front();
    const w = mk(fr, 'red', 2, 'Wache', 50);
    fr.controlByNode[3] = 'red';
    retreatForce(fr, w, 1); // approach from the west edge e1
    expect(w.pos.kind).toBe('edge');
    if (w.pos.kind === 'edge') expect(w.pos.edgeId).toBe(2); // east, toward friendly n3
    // Cornered: enemies on every side.
    const fr2 = front();
    const w2 = mk(fr2, 'red', 2, 'Umzingelt', 50);
    mk(fr2, 'blue', 1, 'West', 100);
    mk(fr2, 'blue', 3, 'East', 100);
    retreatForce(fr2, w2, null);
    expect(w2.strength).toBe(0);
    expect(fr2.events.some((e) => e.kind === 'overrun')).toBe(true);
  });
});

describe('bridge defile under contact (jtbug #760)', () => {
  // Able is mid-crossing (head of the queue, queuedAt null), Baker waits.
  const twoAtTheBridge = (): { fr: FrontV2; a: Force; b: Force; w: Force } => {
    const fr = front();
    const a = mk(fr, 'blue', 1, 'Able', 100, 0);
    const b = mk(fr, 'blue', 1, 'Baker', 100, 1);
    const w = mk(fr, 'red', 2, 'Wache', 90);
    expect(orderMove(fr, a.id, 2).ok).toBe(true);
    expect(orderMove(fr, b.id, 2).ok).toBe(true);
    for (let m = 0; m < 3; m++) stepMovement(fr);
    expect(fr.defileQueues[1]).toEqual([a.id, b.id]);
    expect([a.queuedAt, b.queuedAt]).toEqual([null, 1]);
    return { fr, a, b, w };
  };

  it('a force halted by contact mid-crossing gives up the bridge', () => {
    const { fr, a, b, w } = twoAtTheBridge();
    openBattle(fr, { attackerId: a.id, defenderId: w.id, site: w.pos, gapM: 0 });
    expect(fr.defileQueues[1]).toEqual([b.id]);
    stepMovement(fr);
    expect(b.queuedAt).toBeNull(); // Baker crosses: the head is no longer a pinned force
    expect(b.dwellMin).toBeGreaterThan(0);
  });

  it('a force that joins a battle while it waits leaves the queue and takes orders afterwards', () => {
    const { fr, a, b, w } = twoAtTheBridge();
    const battle = openBattle(fr, { attackerId: a.id, defenderId: w.id, site: w.pos, gapM: 0 });
    joinBattle(fr, battle, b);
    expect(b.queuedAt).toBeNull();
    expect(fr.defileQueues[1]).toEqual([]);
    battle.forced = 'attacker';
    fr.clockMin = battle.endMin;
    resolveBattleV2(fr, newCampaign(7), battle);
    expect(orderMove(fr, b.id, 0).ok).toBe(true);
  });
});

describe('planner: march safety and reorganisation (jtbug #762)', () => {
  //   0 --e0-- 1(bridge) --e1-- 2 --e2-- 3(objective)
  //                             2 --e3-- 4
  const PLAN: Theater = {
    ...FIX,
    nodes: [...FIX.nodes, N(4, 6000, 'village')],
    edges: [...FIX.edges, E(3, 2, 4, 3000, { x: 6000, y: 1000 }, { x: 6000, y: 1900 })],
  };
  const GOALS: WarGoals = {
    blue: [{ kind: 'control', nodeIds: [3], need: 1 }],
    red: [{ kind: 'deadline', day: 14 }, { kind: 'annihilate', enemyBelowStrength: 1 }],
  };
  // A fresh commander each call: no cadence, no carried plan.
  const blueOrders = (fr: FrontV2) => new Commander2('blue', BLUE_V2, GOALS, 14).evaluate(fr, new OmniscientIntel(fr, 'blue'))!;

  it('a beaten force holds off the attack for REORG_MIN, then attacks', () => {
    const fr = front(PLAN);
    const a = mk(fr, 'blue', 2, 'Able', 600, 0);
    mk(fr, 'red', 3, 'Wache', 20);
    expect(blueOrders(fr).orders).toEqual([{ forceId: a.id, dest: 3, why: 'attack' }]);
    a.path = [];
    a.repulsedAtMin = fr.clockMin - (REORG_MIN - 1);
    const held = blueOrders(fr);
    expect(held.orders).toEqual([]);
    expect(held.stall).toBe('no-viable-attack');
    a.repulsedAtMin = fr.clockMin - REORG_MIN;
    expect(blueOrders(fr).orders).toEqual([{ forceId: a.id, dest: 3, why: 'attack' }]);
  });

  it('a force is not marched past an enemy it would have to withdraw from', () => {
    const fr = front(PLAN);
    const weak = mk(fr, 'blue', 0, 'Able', 20, 0);
    const stack = mk(fr, 'red', 2, 'Kampfgruppe', 200); // on the road to the open objective
    expect(blueOrders(fr).orders).toEqual([]); // 200 > withdrawRatio 3 x 20
    expect(weak.path).toEqual([]);
    stack.strength = 60; // exactly 3:1 is not overwhelming
    expect(blueOrders(fr).orders).toEqual([{ forceId: weak.id, dest: 3, why: 'advance' }]);
  });

  it('the same test sees an enemy standing mid-road, out of sight of both ends', () => {
    const fr = front(PLAN);
    const weak = mk(fr, 'blue', 0, 'Able', 20, 0);
    const stack = mk(fr, 'red', 1, 'Kampfgruppe', 200);
    stack.pos = { kind: 'edge', edgeId: 2, s: 1600, dir: 1 }; // 1,600 m from node 2 and from node 3
    fr.theater = { ...PLAN, edges: PLAN.edges.map((e) => (e.id === 2 ? { ...e, lengthM: 3200 } : e)) };
    expect(blueOrders(fr).orders).toEqual([]);
    expect(weak.path).toEqual([]);
  });

  it('a withdrawal goes to the nearest friendly node it can reach clear of the enemy', () => {
    const fr = front(PLAN);
    const weak = mk(fr, 'blue', 1, 'Able', 20, 0);
    weak.pos = { kind: 'edge', edgeId: 1, s: 1400, dir: -1 }; // 1,400 m short of the bridge, closing on it
    mk(fr, 'red', 1, 'Kampfgruppe', 200); // holds the bridge
    fr.controlByNode[0] = 'blue'; // lowest id, and behind the enemy
    fr.controlByNode[4] = 'blue';
    // Before the fix the rear node was picked by id: node 0, through the bridge.
    expect(blueOrders(fr).orders).toEqual([{ forceId: weak.id, dest: 4, why: 'withdraw' }]);
    expect(weak.pos).toMatchObject({ edgeId: 1, dir: 1 }); // turned away from the bridge
    expect(weak.path).toEqual([1, 3]);
  });
});

describe('stepWar composition', () => {
  it('a headless mini-war runs: march, contact, battle, resolution, capture', () => {
    const fr = front();
    const c = newCampaign(7);
    const a = mk(fr, 'blue', 0, 'Able', 300, 0);
    const w = mk(fr, 'red', 3, 'Wache', 40);
    fr.controlByNode[3] = 'red';
    orderMove(fr, a.id, 3);
    let resolved = 0;
    for (let m = 0; m < 600 && String(fr.controlByNode[3]) !== 'blue'; m++) {
      resolved += stepWar(fr, c).resolved.length;
    }
    expect(resolved).toBeGreaterThan(0);
    expect(fr.controlByNode[3]).toBe('blue');
    expect(w.strength).toBeLessThan(40);
  });

  it('§3.8: an unanswered pending contact stays halted forever — never auto-resolved', () => {
    const fr = front();
    const c = newCampaign(7);
    const a = mk(fr, 'blue', 0, 'Able', 300, 0);
    const w = mk(fr, 'red', 3, 'Wache', 40);
    orderMove(fr, a.id, 3);
    let pendingSeen = false;
    for (let m = 0; m < 500; m++) {
      const r = stepWar(fr, c, { autoBattle: () => false });
      if (r.pendingContacts.length > 0) pendingSeen = true;
      expect(r.resolved).toHaveLength(0);
    }
    expect(pendingSeen).toBe(true);
    expect(fr.battles).toHaveLength(0);
    expect(w.strength).toBe(40); // nobody fought anything
    expect(String(fr.controlByNode[3])).not.toBe('blue');
  });

  it('the same seeds replay the same war on a generated theater', () => {
    const CFG = { sizeKm: 24, riverDensity: 2, crossingScarcity: 1, roadDensity: 2, railDensity: 1, townDensity: 1, townSpacingMinKm: 5, terrainMix: 'bocage', woodsShare: 2 } as const;
    const run = (): string => {
      const { theater, initialControlByNode } = makeTheater(3, CFG);
      const fr: FrontV2 = {
        theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
        controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
      };
      const c = newCampaign(3);
      const blueSrc = theater.sources.blue[0];
      const redSrc = theater.sources.red[0];
      const a = mk(fr, 'blue', blueSrc, 'Able', 138, 0);
      const b = mk(fr, 'blue', blueSrc, 'Baker', 138, 1);
      const w = mk(fr, 'red', redSrc, 'Wache', 109);
      const target = theater.objectiveNodes.find((o) => theater.nodes[o].crossing?.kind !== 'ford')!;
      orderMove(fr, a.id, target);
      orderMove(fr, b.id, target);
      orderMove(fr, w.id, target);
      for (let m = 0; m < 1200; m++) stepWar(fr, c);
      return JSON.stringify([fr.forces.map((f) => [f.id, f.strength, f.pos]), fr.controlByNode, fr.clockMin]);
    };
    expect(run()).toBe(run());
  });
});

// Polish: the battle-site classifier takes the attacker's approach from the
// edge it last WALKED — an assault delivered standing ON a crossing node
// still classifies bridge-assault from the bank it came over.
describe('approach-edge classification', () => {
  it('a node-standing attacker who walked onto the bridge opens a crossing assault', () => {
    const fr = front();
    const atk = mk(fr, 'blue', 0, 'Able', 100, 0);
    const def = mk(fr, 'red', 1, 'Wache', 100);
    orderMove(fr, atk.id, 1); // 3000 m up e0 onto the bridge node
    for (let m = 0; m < 400 && !(atk.pos.kind === 'node' && atk.pos.nodeId === 1); m++) {
      fr.clockMin++;
      stepMovement(fr);
    }
    expect(atk.pos).toEqual({ kind: 'node', nodeId: 1 });
    expect(atk.lastEdgeId).toBe(0);
    atk.path = [];
    const battle = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 0 });
    expect(battle.approachEdgeId).toBe(0);
    expect(battleSiteOf(fr.theater, { kind: 'node', nodeId: 1 }, battle.approachEdgeId ?? undefined).battleClass).toBe('bridge-assault');
  });
});
