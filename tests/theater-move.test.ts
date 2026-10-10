import { describe, expect, it } from 'vitest';
import { makeTheater } from '../src/strategic/theatergen';
import {
  addForce,
  BRIDGE_DWELL_MIN,
  FORD_CROSS_MIN,
  MAX_FORCES,
  route,
  type Force,
  type FrontV2,
} from '../src/strategic/theater/force';
import { forceEtaMinutes, orderHalt, orderMove, previewMove, stepMovement } from '../src/strategic/theater/step';
import { MOVE_MPM, type Theater, type TheaterEdge, type Vec } from '../src/strategic/theater';

// Synthetic fixture: precise control over lengths and crossings.
//   0 --e0(3000m road)-- 1(bridge) --e1(3000m road)-- 2
//   0 --e2(2000m road)-- 3(ford)   --e3(2000m road)-- 2   (ford shortcut)
//   0 --e4(9000m road)-- 2                                 (long detour)
const N = (id: number, x: number, kind: Theater['nodes'][number]['kind'], crossing: Theater['nodes'][number]['crossing'] = null): Theater['nodes'][number] => ({
  id, pos: { x, y: 1000 }, kind, name: `n${id}`, regionId: 0, crossing, rank: 2,
});
const E = (id: number, a: number, b: number, lengthM: number, aPos: Vec, bPos: Vec): TheaterEdge => ({
  id, a, b, kind: 'road', moveClass: 'road', polyline: [aPos, bPos], lengthM, paceMpm: MOVE_MPM.road, rank: 1,
});
const FIX: Theater = {
  version: 1, seed: 0, name: 'fixture sector', boundsM: { w: 20000, h: 2000 },
  nodes: [
    N(0, 0, 'town'),
    N(1, 3000, 'bridge', { riverId: 0, kind: 'bridge' }),
    N(2, 6000, 'town'),
    N(3, 2000, 'ford', { riverId: 0, kind: 'ford' }),
    N(4, 9000, 'village'),
  ],
  edges: [
    E(0, 0, 1, 3000, { x: 0, y: 1000 }, { x: 3000, y: 1000 }),
    E(1, 1, 2, 3000, { x: 3000, y: 1000 }, { x: 6000, y: 1000 }),
    E(2, 0, 3, 2000, { x: 0, y: 1000 }, { x: 2000, y: 500 }),
    E(3, 3, 2, 2000, { x: 2000, y: 500 }, { x: 6000, y: 1000 }),
    E(4, 0, 2, 9000, { x: 0, y: 1000 }, { x: 6000, y: 2000 }),
    E(5, 2, 4, 3000, { x: 6000, y: 1000 }, { x: 9000, y: 1000 }),
  ],
  regions: [{ id: 0, polygon: [{ x: 0, y: 0 }, { x: 20000, y: 0 }, { x: 20000, y: 2000 }, { x: 0, y: 2000 }], centroid: { x: 10000, y: 1000 }, bbox: { x0: 0, y0: 0, x1: 20000, y1: 2000 }, areaM2: 4e7, terrainClass: 'farmland', name: 'r0', seatNodeId: null }],
  rivers: [{ id: 0, name: 'La Fixture', polyline: [{ x: 2500, y: 0 }, { x: 2500, y: 2000 }], widthClass: 'river' }],
  objectiveNodes: [2],
  sources: { blue: [0], red: [2] },
};

const front = (): FrontV2 => ({
  theater: FIX,
  clockMin: 0,
  day: 1,
  nextForceId: 0,
  nextBattleId: 0,
  forces: [],
  controlByNode: FIX.nodes.map(() => null),
  battles: [],
  events: [],
  defileQueues: {},
});

const blue = (fr: FrontV2, nodeId = 0): Force =>
  addForce(fr, { side: 'blue', name: 'Able', pos: { kind: 'node', nodeId }, path: [], dwellMin: 0, strength: 100, companyIndex: 0, role: 'line', engagedIn: null, queuedAt: null });

describe('routing + the crossing economy', () => {
  it('prefers the ford shortcut over a long detour, the bridge over the ford', () => {
    // 0->2 direct options: bridge path 6000m road (120min) + 15 dwell = 135;
    // ford path 4000m (80min) + 45 dwell = 125; detour 9000m = 180.
    const r = route(FIX, 0, 2)!;
    expect(r.edges).toEqual([2, 3]); // the ford wins by 10 minutes
    expect(Math.round(r.minutes)).toBe(125);
    // Shrink the ford advantage: with the bridge edges at 2500m each
    // (100min + 15 = 115), the bridge must win.
    const closer: Theater = JSON.parse(JSON.stringify(FIX));
    closer.edges[0].lengthM = 2500;
    closer.edges[1].lengthM = 2500;
    expect(route(closer, 0, 2)!.edges).toEqual([0, 1]);
  });

  it('a 3-edge route arrives when the ETA said it would; fatigue drags past the fresh nominal', () => {
    const fr = front();
    const f = blue(fr);
    const order = orderMove(fr, f.id, 4);
    expect(order.ok).toBe(true);
    // Fresh-force nominal: ford path 80min + 45 dwell + edge5 60min = 185.
    // S51 makes pace time-varying — a 3-hour march tires the column, so the
    // TRUE arrival sits a few minutes past the nominal and the ETA (a shadow
    // of the same kernel) predicts it exactly.
    const nominal = Math.ceil(2000 / 50 + FORD_CROSS_MIN + 2000 / 50 + 3000 / 50);
    const eta = order.ok ? order.etaMin : -1;
    expect(eta).toBeGreaterThanOrEqual(nominal);
    expect(eta).toBeLessThanOrEqual(Math.ceil(nominal * 1.1)); // drag is real but bounded
    let steps = 0;
    while (!(f.pos.kind === 'node' && f.pos.nodeId === 4) && steps < 1000) {
      stepMovement(fr);
      fr.clockMin++;
      steps++;
    }
    expect(steps).toBe(eta);
  });

  it('a path that ends short of the destination THROWS instead of spinning the 30-day cap', () => {
    const fr = front();
    const f = blue(fr);
    orderMove(fr, f.id, 1); // path ends at node 1
    expect(() => forceEtaMinutes(fr, f, 4)).toThrow(/ends short/);
  });

  it('the ETA mirror holds at 0/25/50/100% of the march', () => {
    const fr = front();
    const f = blue(fr);
    const order = orderMove(fr, f.id, 4);
    const eta0 = order.ok ? order.etaMin : -1;
    const checkpoints = [Math.floor(eta0 * 0.25), Math.floor(eta0 * 0.5), eta0];
    let elapsed = 0;
    for (const cp of checkpoints) {
      while (elapsed < cp) {
        stepMovement(fr);
        fr.clockMin++;
        elapsed++;
      }
      if (elapsed < eta0) {
        const remaining = forceEtaMinutes(fr, f, 4);
        expect(elapsed + remaining, `at minute ${elapsed}`).toBeGreaterThanOrEqual(eta0 - 1);
        expect(elapsed + remaining).toBeLessThanOrEqual(eta0 + 1);
      }
    }
    expect(f.pos).toEqual({ kind: 'node', nodeId: 4 });
  });

  it('orderMove walks every reject arm of the union', () => {
    const fr = front();
    const f = blue(fr);
    expect(orderMove(fr, 999, 2)).toEqual({ ok: false, reason: 'unknown-force' });
    expect(orderMove(fr, f.id, 0)).toEqual({ ok: false, reason: 'already-there' });
    expect(orderMove(fr, f.id, 3)).toEqual({ ok: false, reason: 'destination-unholdable' }); // ford
    // A settlement CARRYING ford metadata is dry ground — legal (Gué-de-Ifs).
    const fordTown: typeof fr.theater = JSON.parse(JSON.stringify(fr.theater));
    fordTown.nodes[2].crossing = { riverId: 0, kind: 'ford' };
    const fr2 = { ...fr, theater: fordTown };
    expect(orderMove(fr2, f.id, 2).ok).toBe(true);
    expect(orderMove(fr, f.id, 99)).toEqual({ ok: false, reason: 'no-route' });
    f.engagedIn = 1;
    expect(orderMove(fr, f.id, 2)).toEqual({ ok: false, reason: 'engaged' });
    f.engagedIn = null;
    f.queuedAt = 1;
    expect(orderMove(fr, f.id, 2)).toEqual({ ok: false, reason: 'queued-at-defile' });
  });
});

describe('bridge defile', () => {
  it('capacity 1, FIFO: the second force waits, order preserved', () => {
    const fr = front();
    const a = blue(fr);
    const b = addForce(fr, { side: 'blue', name: 'Baker', pos: { kind: 'node', nodeId: 0 }, path: [], dwellMin: 0, strength: 100, companyIndex: 1, role: 'line', engagedIn: null, queuedAt: null });
    // Route both across the BRIDGE (block the ford by making it unattractive).
    const bridged: Theater = JSON.parse(JSON.stringify(FIX));
    bridged.edges[2].lengthM = 20000;
    fr.theater = bridged;
    expect(orderMove(fr, a.id, 2).ok).toBe(true);
    expect(orderMove(fr, b.id, 2).ok).toBe(true);
    let queuedSeen = false;
    let crossedFirst = -1;
    for (let m = 0; m < 400; m++) {
      stepMovement(fr);
      fr.clockMin++;
      if (b.queuedAt !== null || a.queuedAt !== null) queuedSeen = true;
      if (crossedFirst < 0) {
        if (a.pos.kind === 'node' && a.pos.nodeId === 2) crossedFirst = a.id;
        if (b.pos.kind === 'node' && b.pos.nodeId === 2) crossedFirst = b.id;
      }
    }
    expect(queuedSeen, 'someone must have waited at the defile').toBe(true);
    expect(crossedFirst).toBe(a.id); // FIFO: lower id stepped first, arrived first
    expect(a.pos).toEqual({ kind: 'node', nodeId: 2 });
    expect(b.pos).toEqual({ kind: 'node', nodeId: 2 });
  });
});

describe('turning and halting (jtbug #762)', () => {
  const walk = (fr: FrontV2, minutes: number): void => {
    for (let m = 0; m < minutes; m++) {
      stepMovement(fr);
      fr.clockMin++;
    }
  };
  const arriveIn = (fr: FrontV2, f: Force, nodeId: number): number => {
    let steps = 0;
    while (!(f.pos.kind === 'node' && f.pos.nodeId === nodeId) && steps < 1000) {
      walk(fr, 1);
      steps++;
    }
    return steps;
  };

  it('ten minutes out is about ten minutes back: a turn-round walks its own edge', () => {
    const fr = front();
    const f = blue(fr);
    expect(orderMove(fr, f.id, 4).ok).toBe(true); // the ford route: e2, e3, e5
    walk(fr, 10);
    expect(f.pos).toMatchObject({ kind: 'edge', edgeId: 2, dir: 1 });
    const back = orderMove(fr, f.id, 0);
    // Before the fix this routed from the node AHEAD: finish the road, wade
    // the ford twice, walk the road again (measured live: 155 min for 10).
    expect(back).toMatchObject({ ok: true });
    const eta = back.ok ? back.etaMin : -1;
    expect(eta).toBeGreaterThanOrEqual(10);
    expect(eta).toBeLessThanOrEqual(11);
    expect(f.path).toEqual([2]);
    expect(f.pos).toMatchObject({ kind: 'edge', edgeId: 2, dir: -1 });
    expect(arriveIn(fr, f, 0)).toBe(eta); // the shadow march stays exact
  });

  it('a mid-road order leaves by whichever end is faster, even onto another road', () => {
    const fr = front();
    const f = blue(fr);
    f.path = [4]; // the 9 km detour toward node 2
    walk(fr, 10);
    // To the bridge: behind is 10 min + e0 (60). Ahead is 170 min + e1 (60).
    const order = orderMove(fr, f.id, 1);
    expect(f.path).toEqual([4, 0]);
    const eta = order.ok ? order.etaMin : -1;
    expect(eta).toBeLessThanOrEqual(72);
    expect(arriveIn(fr, f, 1)).toBe(eta);
  });

  it('a mid-road order keeps going when the node ahead is the faster end', () => {
    const fr = front();
    const f = blue(fr);
    f.pos = { kind: 'edge', edgeId: 4, s: 8500, dir: 1 }; // 10 min short of node 2
    f.path = [4];
    expect(orderMove(fr, f.id, 4).ok).toBe(true);
    expect(f.path).toEqual([4, 5]);
    expect(f.pos).toMatchObject({ dir: 1 });
  });

  it('previewMove changes nothing and promises exactly what orderMove then does', () => {
    const fr = front();
    const f = blue(fr);
    orderMove(fr, f.id, 4);
    walk(fr, 10);
    const snapshot = JSON.stringify(fr);
    const p = previewMove(fr, f.id, 0); // a turn-round: the plan flips the direction
    expect(JSON.stringify(fr)).toBe(snapshot);
    expect(p).toMatchObject({ ok: true, path: [2], pos: { edgeId: 2, dir: -1 } });
    const o = orderMove(fr, f.id, 0);
    expect(o).toEqual({ ok: true, etaMin: p.ok ? p.etaMin : -1 });
    expect([f.path, f.pos]).toEqual(p.ok ? [p.path, p.pos] : []);
    // The reject ladder is the same one.
    expect(previewMove(fr, f.id, 3)).toEqual({ ok: false, reason: 'destination-unholdable' });
    expect(previewMove(fr, 999, 0)).toEqual({ ok: false, reason: 'unknown-force' });
  });

  it('halt stops a company on the road; it stands there and takes a new order', () => {
    const fr = front();
    const f = blue(fr);
    orderMove(fr, f.id, 4);
    walk(fr, 10);
    expect(orderHalt(fr, f.id)).toEqual({ ok: true });
    const stood = { ...f.pos };
    walk(fr, 30);
    expect(f.pos).toEqual(stood);
    expect(f.path).toEqual([]);
    expect(orderHalt(fr, f.id)).toEqual({ ok: false, reason: 'not-moving' });
    const again = orderMove(fr, f.id, 4);
    expect(again.ok).toBe(true);
    expect(arriveIn(fr, f, 4)).toBe(again.ok ? again.etaMin : -1);
  });

  it('halt gives up the bridge, mid-crossing or queued, and refuses the engaged', () => {
    const fr = front();
    const a = blue(fr, 1);
    const b = blue(fr, 1);
    orderMove(fr, a.id, 2);
    orderMove(fr, b.id, 2);
    walk(fr, 3);
    expect(fr.defileQueues[1]).toEqual([a.id, b.id]);
    expect(orderHalt(fr, a.id)).toEqual({ ok: true });
    expect(fr.defileQueues[1]).toEqual([b.id]);
    expect(orderHalt(fr, b.id)).toEqual({ ok: true }); // the one order a queued force takes
    expect(b.queuedAt).toBeNull();
    expect(fr.defileQueues[1]).toEqual([]);
    a.engagedIn = 1;
    expect(orderHalt(fr, a.id)).toEqual({ ok: false, reason: 'engaged' });
    expect(orderHalt(fr, 999)).toEqual({ ok: false, reason: 'unknown-force' });
  });
});

describe('step mechanics', () => {
  it('entry-paint capture fires on arrival at an unheld, undefended node', () => {
    const fr = front();
    const f = blue(fr);
    orderMove(fr, f.id, 2);
    for (let m = 0; m < 200; m++) {
      stepMovement(fr);
      fr.clockMin++;
    }
    expect(fr.controlByNode[2]).toBe('blue');
    expect(fr.events.some((e) => e.kind === 'capture' && e.nodeId === 2)).toBe(true);
    expect(fr.events.some((e) => e.kind === 'arrival' && e.nodeId === 2)).toBe(true);
  });

  it('positions are order-independent over 500 steps', () => {
    const run = (shuffle: boolean): string => {
      const fr = front();
      const a = blue(fr);
      const b = addForce(fr, { side: 'blue', name: 'Baker', pos: { kind: 'node', nodeId: 2 }, path: [], dwellMin: 0, strength: 100, companyIndex: 1, role: 'line', engagedIn: null, queuedAt: null });
      const c = addForce(fr, { side: 'red', name: 'Wache', pos: { kind: 'node', nodeId: 4 }, path: [], dwellMin: 0, strength: 50, companyIndex: -1, role: 'garrison', engagedIn: null, queuedAt: null });
      orderMove(fr, a.id, 4);
      orderMove(fr, b.id, 0);
      orderMove(fr, c.id, 2);
      if (shuffle) fr.forces.reverse();
      for (let m = 0; m < 500; m++) {
        stepMovement(fr);
        fr.clockMin++;
      }
      return [a, b, c].map((f) => JSON.stringify(f.pos)).join('|');
    };
    expect(run(true)).toBe(run(false));
  });

  it('MAX_FORCES is asserted on addForce with a named error', () => {
    const fr = front();
    for (let i = 0; i < MAX_FORCES; i++) blue(fr);
    expect(() => blue(fr)).toThrow('MAX_FORCES');
  });
});

describe('on a generated theater', () => {
  it('routes exist between supply sources and every objective; marches complete', () => {
    const CFG = { sizeKm: 24, riverDensity: 2, crossingScarcity: 1, roadDensity: 2, railDensity: 1, townDensity: 1, townSpacingMinKm: 5, terrainMix: 'bocage', woodsShare: 2 } as const;
    for (let seed = 1; seed <= 4; seed++) {
      const { theater, initialControlByNode } = makeTheater(seed, CFG);
      const fr: FrontV2 = {
        theater,
        clockMin: 0,
        day: 1,
        nextForceId: 0,
        nextBattleId: 0,
        forces: [],
        controlByNode: [...initialControlByNode],
        battles: [],
        events: [],
        defileQueues: {},
      };
      const f = addForce(fr, { side: 'blue', name: 'Able', pos: { kind: 'node', nodeId: theater.sources.blue[0] }, path: [], dwellMin: 0, strength: 100, companyIndex: 0, role: 'line', engagedIn: null, queuedAt: null });
      const target = theater.objectiveNodes.find((o) => theater.nodes[o].crossing?.kind !== 'ford')!;
      const order = orderMove(fr, f.id, target);
      expect(order.ok, `seed ${seed} route to objective ${target}`).toBe(true);
      const eta = order.ok ? order.etaMin : 0;
      let steps = 0;
      while (!(f.pos.kind === 'node' && f.pos.nodeId === target) && steps < eta + 60) {
        stepMovement(fr);
        fr.clockMin++;
        steps++;
      }
      expect(f.pos, `seed ${seed} arrived`).toEqual({ kind: 'node', nodeId: target });
      expect(Math.abs(steps - eta), `seed ${seed} eta drift ${steps} vs ${eta}`).toBeLessThanOrEqual(1);
    }
  });
});
