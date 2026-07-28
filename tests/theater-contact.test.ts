import { describe, expect, it } from 'vitest';
import { addForce, CONTACT_M, orderMove, type Force, type FrontV2 } from '../src/strategic/theater/force';
import { stepMovement } from '../src/strategic/theater/step';
import { detectContacts, graphGap, haltAtContact } from '../src/strategic/theater/contact';
import { MOVE_MPM, type Theater, type TheaterEdge, type Vec } from '../src/strategic/theater';

// Fixture: a corridor plus two PARALLEL non-incident roads.
//   0 --e0(6000m)-- 1        (the corridor)
//   2 --e1(6000m)-- 3        (parallel road, no shared node)
//   0 --e2(2000m)-- 2, 1 --e3(2000m)-- 3 (connectors so the graph is whole)
const N = (id: number, x: number, y: number): Theater['nodes'][number] => ({
  id, pos: { x, y }, kind: 'junction', name: `n${id}`, regionId: 0, crossing: null, rank: 2,
});
const E = (id: number, a: number, b: number, lengthM: number, pa: Vec, pb: Vec): TheaterEdge => ({
  id, a, b, kind: 'road', moveClass: 'road', polyline: [pa, pb], lengthM, paceMpm: MOVE_MPM.road, rank: 1,
});
const FIX: Theater = {
  version: 1, seed: 0, name: 'contact fixture', boundsM: { w: 10000, h: 4000 },
  nodes: [N(0, 0, 0), N(1, 6000, 0), N(2, 0, 2000), N(3, 6000, 2000)],
  edges: [
    E(0, 0, 1, 6000, { x: 0, y: 0 }, { x: 6000, y: 0 }),
    E(1, 2, 3, 6000, { x: 0, y: 2000 }, { x: 6000, y: 2000 }),
    E(2, 0, 2, 2000, { x: 0, y: 0 }, { x: 0, y: 2000 }),
    E(3, 1, 3, 2000, { x: 6000, y: 0 }, { x: 6000, y: 2000 }),
  ],
  regions: [{ id: 0, polygon: [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 4000 }, { x: 0, y: 4000 }], centroid: { x: 5000, y: 2000 }, bbox: { x0: 0, y0: 0, x1: 10000, y1: 4000 }, areaM2: 4e7, terrainClass: 'farmland', name: 'r0', seatNodeId: null }],
  rivers: [], objectiveNodes: [1], sources: { blue: [0], red: [1] },
};

const front = (): FrontV2 => ({
  theater: FIX, clockMin: 0, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
  controlByNode: FIX.nodes.map(() => null), battles: [], events: [], defileQueues: {},
});
const mk = (fr: FrontV2, side: 'blue' | 'red', nodeId: number, name: string): Force =>
  addForce(fr, { side, name, pos: { kind: 'node', nodeId }, path: [], dwellMin: 0, strength: 100, companyIndex: side === 'blue' ? 0 : -1, role: 'line', engagedIn: null, queuedAt: null });

describe('graphGap', () => {
  it('same edge = |Δs|; edge to incident node = distance along; else Infinity', () => {
    expect(graphGap(FIX, { kind: 'edge', edgeId: 0, s: 1000, dir: 1 }, { kind: 'edge', edgeId: 0, s: 1400, dir: -1 })).toBe(400);
    expect(graphGap(FIX, { kind: 'edge', edgeId: 0, s: 5800, dir: 1 }, { kind: 'node', nodeId: 1 })).toBe(200);
    expect(graphGap(FIX, { kind: 'edge', edgeId: 0, s: 3000, dir: 1 }, { kind: 'edge', edgeId: 1, s: 3000, dir: 1 })).toBe(Infinity);
    // two edges sharing node 1: e0 end + e3 start
    expect(graphGap(FIX, { kind: 'edge', edgeId: 0, s: 5900, dir: 1 }, { kind: 'edge', edgeId: 3, s: 150, dir: 1 })).toBe(250);
  });
});

describe('detectContacts', () => {
  it('head-on: fires exactly once, at the minute the gap first closes to 300m', () => {
    const fr = front();
    const a = mk(fr, 'blue', 0, 'Able');
    const w = mk(fr, 'red', 1, 'Wache');
    orderMove(fr, a.id, 1);
    orderMove(fr, w.id, 0);
    let fired = -1;
    let count = 0;
    for (let m = 0; m < 200; m++) {
      stepMovement(fr);
      fr.clockMin++;
      const cs = detectContacts(fr);
      if (cs.length > 0) {
        count += cs.length;
        if (fired < 0) {
          fired = m;
          expect(cs[0].gapM).toBeLessThanOrEqual(CONTACT_M);
          for (const c of cs) haltAtContact(fr, c);
          const att = fr.forces.find((f) => f.id === cs[0].attackerId)!;
          att.engagedIn = 0;
          fr.forces.find((f) => f.id === cs[0].defenderId)!.engagedIn = 0;
        }
      }
    }
    expect(count).toBe(1);
    // Closing 100 m/min from 6000m: gap reaches exactly 300 after 57 minutes,
    // which is loop index 56.
    expect(fired).toBe(56);
  });

  it('overtake: a faster-arriving force catches a static one mid-edge', () => {
    const fr = front();
    const a = mk(fr, 'blue', 0, 'Able');
    const w = mk(fr, 'red', 1, 'Wache');
    // Park red mid-corridor, static.
    w.pos = { kind: 'edge', edgeId: 0, s: 3000, dir: -1 };
    orderMove(fr, a.id, 1);
    let cs: ReturnType<typeof detectContacts> = [];
    let m = 0;
    for (; m < 200 && cs.length === 0; m++) {
      stepMovement(fr);
      fr.clockMin++;
      cs = detectContacts(fr);
    }
    expect(cs.length).toBe(1);
    expect(cs[0].attackerId).toBe(a.id); // the mover attacks
    expect(cs[0].defenderId).toBe(w.id);
    expect(cs[0].site).toEqual(w.pos); // the fight is where the defender stands
    // 2700m to cover at 50 m/min = 54 minutes; the for-loop increments m
    // before the check, so the firing iteration reads 54.
    expect(m).toBe(54);
  });

  it('parallel non-incident roads NEVER fight over 2000 steps', () => {
    const fr = front();
    const a = mk(fr, 'blue', 0, 'Able');
    const w = mk(fr, 'red', 3, 'Wache');
    a.pos = { kind: 'edge', edgeId: 0, s: 3000, dir: 1 };
    w.pos = { kind: 'edge', edgeId: 1, s: 3000, dir: -1 };
    for (let m = 0; m < 2000; m++) {
      stepMovement(fr);
      fr.clockMin++;
      expect(detectContacts(fr)).toEqual([]);
    }
  });

  it('a shuffled forces array produces an identical event sequence', () => {
    const run = (shuffle: boolean): string => {
      const fr = front();
      const a = mk(fr, 'blue', 0, 'Able');
      const b = mk(fr, 'blue', 2, 'Baker');
      const w = mk(fr, 'red', 1, 'Wache');
      const v = mk(fr, 'red', 3, 'Sperr');
      orderMove(fr, a.id, 1);
      orderMove(fr, b.id, 3);
      orderMove(fr, w.id, 0);
      orderMove(fr, v.id, 2);
      if (shuffle) fr.forces.reverse();
      const log: string[] = [];
      for (let m = 0; m < 300; m++) {
        stepMovement(fr);
        fr.clockMin++;
        for (const c of detectContacts(fr)) {
          log.push(`${m}:${c.attackerId}>${c.defenderId}@${JSON.stringify(c.site)}`);
          haltAtContact(fr, c);
          fr.forces.find((f) => f.id === c.attackerId)!.engagedIn = 9;
          fr.forces.find((f) => f.id === c.defenderId)!.engagedIn = 9;
        }
      }
      return log.join('|');
    };
    const plain = run(false);
    expect(plain.length).toBeGreaterThan(0);
    expect(run(true)).toBe(plain);
  });

  it('engaged forces are pinned: no second contact while a battle holds them', () => {
    const fr = front();
    const a = mk(fr, 'blue', 0, 'Able');
    const w = mk(fr, 'red', 0, 'Wache');
    a.engagedIn = 5;
    w.engagedIn = 5;
    expect(detectContacts(fr)).toEqual([]);
  });
});
