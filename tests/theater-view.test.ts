// TheaterView camera arithmetic (jtbug #782). The HUD is opaque DOM, so every
// framing operation is checked against the CLEAR rectangle, not the canvas.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeHeadlessWorld, runHeadlessWar, stepWorldMinute } from '../src/strategic/headless';
import { minutesToReinforcement } from '../src/strategic/front';
import { otherEnd, pushEvent, route, type Force, type FrontV2 } from '../src/strategic/theater/force';
import { supplyCuts } from '../src/render/theater-supply';
import { fmtEta, THEATER_ZOOM_MAX, TheaterView } from '../src/render/theater-view';
import { COUNTER_W, counterRect, layoutCounters, type CounterSpec, type PlacedCounter } from '../src/render/theater-counters';

const world = makeHeadlessWorld(19440606, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
const { theater } = world.front;
// A phone in portrait: a two-row bar on top, the company card and log below.
const PHONE = { w: 390, h: 844, inset: { left: 0, top: 96, right: 0, bottom: 190 } };
const DESKTOP = { w: 1280, h: 800, inset: { left: 0, top: 54, right: 0, bottom: 72 } };

const view = (dev: typeof PHONE): TheaterView => Object.assign(new TheaterView(theater), { inset: dev.inset });
const inClear = (v: TheaterView, dev: typeof PHONE, x: number, y: number, slack = 0): boolean => {
  const [sx, sy] = v.toScreen(x, y, dev.w, dev.h);
  return sx >= dev.inset.left - slack && sx <= dev.w - dev.inset.right + slack && sy >= dev.inset.top - slack && sy <= dev.h - dev.inset.bottom + slack;
};

describe('counters', () => {
  it('every force musters with its establishment, the figure the strength bar reads against', () => {
    const fresh = makeHeadlessWorld(7, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    expect(fresh.front.forces.length).toBeGreaterThan(3);
    for (const f of fresh.front.forces) expect(f.establishment).toBe(f.strength);
  });

  const spec = (id: number, side: 'blue' | 'red', ax: number, ay: number, selected = false): CounterSpec => ({
    id, side, letter: side === 'blue' ? 'A' : null, role: 'line', strength: 100, frac: 1, supply: null, fatigue: 0, posture: 'march',
    selected, engaged: false, conf: 1, ghost: false, tag: null, ax, ay, drop: 12,
  });
  const overlap = (a: PlacedCounter, b: PlacedCounter): boolean => {
    const p = counterRect(a), q = counterRect(b);
    return p.x0 < q.x1 && p.x1 > q.x0 && p.y0 < q.y1 && p.y1 > q.y0;
  };

  it('counters on one point fan out in a row under it, own side first, none overlapping', () => {
    const placed = layoutCounters([spec(5, 'red', 200, 100), spec(1, 'blue', 200, 100), spec(2, 'blue', 203, 101)]);
    expect(placed.map((c) => c.id)).toEqual([1, 2, 5]);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(false);
    expect(new Set(placed.map((c) => c.y)).size).toBe(1); // one row
    expect(placed[0].y).toBeGreaterThanOrEqual(100 + 12); // clear of the point
    expect((placed[0].x + placed[2].x + COUNTER_W) / 2).toBeCloseTo(200, 0); // centred on it
  });

  it('a neighbouring stack drops a line instead of overprinting, and the selected stack keeps its place', () => {
    const alone = layoutCounters([spec(1, 'blue', 200, 100, true)])[0];
    const placed = layoutCounters([spec(0, 'red', 185, 100), spec(1, 'blue', 200, 100, true)]);
    const sel = placed.find((c) => c.id === 1)!;
    expect([sel.x, sel.y]).toEqual([alone.x, alone.y]);
    expect(overlap(placed[0], placed[1])).toBe(false);
  });
});

describe('territory and the front line', () => {
  const v = new TheaterView(theater);
  const control = world.front.controlByNode;
  const nearest = (side: 'blue' | 'red', ctl: readonly ('blue' | 'red' | null)[], p: { x: number; y: number }): number =>
    Math.min(...theater.nodes.filter((n) => ctl[n.id] === side).map((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y)));

  it('the front runs where a blue-held and a red-held node are equally near', () => {
    const { lines } = v.frontLayer(control);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const p of line) expect(Math.abs(nearest('blue', control, p) - nearest('red', control, p))).toBeLessThan(300); // two grid cells
    }
  });

  it('is rebuilt only when a node changes hands', () => {
    const a = v.frontLayer(control);
    expect(v.frontLayer([...control])).toBe(a);
    const taken = [...control];
    taken[theater.objectiveNodes[0]] = 'blue';
    const b = v.frontLayer(taken);
    expect(b).not.toBe(a);
    expect(JSON.stringify(b.lines)).not.toBe(JSON.stringify(a.lines));
  });

  it('one side holding everything leaves no front', () => {
    expect(v.frontLayer(control.map(() => 'blue')).lines).toEqual([]);
  });
});

// A canvas that accepts every call and draws nothing: enough to run the whole
// frame headless. A throw in the theater frame loop does not crash the game,
// it leaves a wrong picture, so the frame is run here for real.
const fakeCtx = (): CanvasRenderingContext2D =>
  new Proxy({} as Record<string, unknown>, {
    get: (store, key: string) =>
      key in store ? store[key] : key === 'measureText' ? () => ({ width: 40 }) : key === 'createPattern' ? () => null : () => undefined,
    set: (store, key: string, value) => {
      store[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
interface Inner { fx: { kind: string }[]; flashText: string }

describe('the frame, and what just happened', () => {
  it('draws a whole war without a throw: day, night, marches, battles, captures, retreats', () => {
    const w = makeHeadlessWorld(3, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    const v = Object.assign(new TheaterView(w.front.theater), { supplyOn: true, inset: DESKTOP.inset });
    const ctx = fakeCtx();
    let frames = 0;
    let news = 0;
    runHeadlessWar(w, 60 * 24 * 4, () => {
      if (w.front.clockMin % 7 !== 0) return;
      v.draw(ctx, w.front, w.front.forces[0].id, false, 60, DESKTOP.w, DESKTOP.h);
      frames++;
      news += (v as unknown as Inner).fx.length;
    });
    expect(frames).toBeGreaterThan(500);
    expect(news).toBeGreaterThan(0); // captures and retreats became marks
  });

  it('a capture or a retreat in the log becomes a mark; the log a war was loaded with does not', () => {
    const fresh = makeHeadlessWorld(19440606, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    const fr = fresh.front;
    const town = fr.theater.objectiveNodes[0];
    pushEvent(fr, { min: fr.clockMin, kind: 'capture', text: 'old news', forceIds: [], nodeId: town });
    const v = Object.assign(new TheaterView(fr.theater), { frozenAt: 1000 });
    const inner = v as unknown as Inner;
    const frame = (): void => v.draw(fakeCtx(), fr, -1, true, 10, DESKTOP.w, DESKTOP.h);
    frame();
    expect(inner.fx).toEqual([]);

    fr.controlByNode[town] = 'blue';
    pushEvent(fr, { min: fr.clockMin, kind: 'capture', text: 'taken', forceIds: [], nodeId: town });
    const b = fr.forces.find((f) => f.side === 'blue')!;
    const e = fr.theater.edges.find((x) => x.moveClass !== 'rail' && b.pos.kind === 'node' && (x.a === b.pos.nodeId || x.b === b.pos.nodeId))!;
    b.pos = { kind: 'edge', edgeId: e.id, s: e.lengthM / 2, dir: 1 };
    pushEvent(fr, { min: fr.clockMin, kind: 'retreat', text: `${b.name} falls back`, forceIds: [b.id] });
    frame();
    expect(inner.fx.map((x) => x.kind).sort()).toEqual(['capture', 'retreat']);
    v.frozenAt = 1000 + 60_000; // long after: the marks are gone
    frame();
    expect(inner.fx).toEqual([]);
  });

  it('the order flash clears on the next theater event', () => {
    const fresh = makeHeadlessWorld(19440606, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    const v = new TheaterView(fresh.front.theater);
    const inner = v as unknown as Inner;
    const frame = (): void => v.draw(fakeCtx(), fresh.front, -1, true, 10, DESKTOP.w, DESKTOP.h);
    v.flash('Able moving');
    frame();
    frame();
    expect(inner.flashText).toBe('Able moving');
    pushEvent(fresh.front, { min: fresh.front.clockMin, kind: 'arrival', text: 'Able arrives', forceIds: [] });
    frame();
    expect(inner.flashText).toBe('');
  });
});

describe('where supply is cut', () => {
  // Able stands on the nearest objective, which he holds, deep in red ground.
  const forward = (objective = 0): { fr: FrontV2; able: Force; path: number[]; nodes: number[] } => {
    const fr = makeHeadlessWorld(19440606, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign).front;
    const able = fr.forces.find((f) => f.side === 'blue')!;
    const from = fr.theater.sources.blue
      .map((s) => ({ s, r: route(fr.theater, s, fr.theater.objectiveNodes[objective])! }))
      .sort((a, b) => a.r.minutes - b.r.minutes)[0];
    const nodes = [from.s];
    for (const eid of from.r.edges) nodes.push(otherEnd(fr.theater.edges[eid], nodes[nodes.length - 1]));
    able.pos = { kind: 'node', nodeId: fr.theater.objectiveNodes[objective] };
    return { fr, able, path: from.r.edges, nodes };
  };

  it('nothing is marked while every company is in supply', () => {
    const fr = makeHeadlessWorld(19440606, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign).front;
    expect(supplyCuts(fr)).toEqual([]);
  });

  it('an enemy-held town on the road from the depot is the cut: the first one the trace stops at', () => {
    const { fr, nodes } = forward();
    const firstRed = nodes.find((n) => fr.controlByNode[n] === 'red')!;
    expect(supplyCuts(fr)).toEqual([{ kind: 'node', nodeId: firstRed }]);
  });

  it('with the road in our hands, the enemy column standing on it is the cut', () => {
    // On an objective with one road in from our ground (the first one tried has a way round).
    let found = false;
    for (let i = 0; i < theater.objectiveNodes.length && !found; i++) {
      const { fr, path, nodes } = forward(i);
      for (const n of nodes) fr.controlByNode[n] = 'blue';
      for (const f of fr.forces) if (f.side === 'red' && f.pos.kind === 'node' && nodes.includes(f.pos.nodeId)) f.strength = 0;
      expect(supplyCuts(fr)).toEqual([]); // the road is open: no cut
      const column = fr.forces.find((f) => f.side === 'red' && f.role === 'line')!;
      for (const eid of path) {
        const road = fr.theater.edges[eid];
        column.pos = { kind: 'edge', edgeId: road.id, s: road.lengthM / 2, dir: 1 };
        const cuts = supplyCuts(fr);
        if (cuts.length === 0) continue;
        expect(cuts).toEqual([column.pos]);
        found = true;
        break;
      }
    }
    expect(found, 'no objective on this seed has a single road in').toBe(true);
  });
});

describe('the replacements clock', () => {
  it('counts down to the minute the replacements land', () => {
    const w = makeHeadlessWorld(5, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    // Leave gaps in the ranks so that an arrival shows as new men on the roll.
    for (const cs of Object.values(w.campaign.soldiers).slice(0, 6)) cs.status = 'kia';
    let saidBefore = -1;
    for (let i = 0; i < 1440 * 3 && saidBefore < 0; i++) {
      const eta = minutesToReinforcement(w.front);
      const roll = Object.keys(w.campaign.soldiers).length;
      stepWorldMinute(w);
      if (Object.keys(w.campaign.soldiers).length > roll) saidBefore = eta;
    }
    expect(saidBefore).toBe(1); // the minute before they landed, the clock said one minute
  });
});

describe('one ETA format', () => {
  it('reads the same on the card, the preview chip and the order flash', () => {
    expect([5, 59, 60, 120, 285].map(fmtEta)).toEqual(['5m', '59m', '1h00m', '2h00m', '4h45m']);
  });
});

describe('theater camera', () => {
  for (const [name, dev] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
    it(`${name}: fitAll puts the whole theater inside the clear rectangle`, () => {
      const v = view(dev);
      v.fitAll(dev.w, dev.h);
      expect(inClear(v, dev, 0, 0)).toBe(true);
      expect(inClear(v, dev, theater.boundsM.w, theater.boundsM.h)).toBe(true);
      expect(v.zoomMul).toBe(v.minZoom(dev.w, dev.h));
    });

    it(`${name}: the war opens on the player's companies and the nearest objective, all in the clear`, () => {
      const v = view(dev);
      v.frameStart(world.front, dev.w, dev.h);
      const own = world.front.forces.filter((f) => f.side === 'blue').map((f) => v.forceXY(f));
      for (const p of own) expect(inClear(v, dev, p.x, p.y)).toBe(true);
      expect(theater.objectiveNodes.some((n) => inClear(v, dev, theater.nodes[n].pos.x, theater.nodes[n].pos.y))).toBe(true);
      expect(v.zoomMul).toBeGreaterThan(1); // larger than the whole-theater fit
    });
  }

  it('a phone opens with the map wider than the screen, not a third of it tall', () => {
    const v = view(PHONE);
    v.frameStart(world.front, PHONE.w, PHONE.h);
    expect(theater.boundsM.w * v.layout(PHONE.w, PHONE.h).scale).toBeGreaterThan(PHONE.w);
  });

  it('zoomAt keeps the ground under the cursor where it is, and clamps both ends', () => {
    const v = view(DESKTOP);
    v.fitAll(DESKTOP.w, DESKTOP.h);
    const before = v.toWorld(700, 420, DESKTOP.w, DESKTOP.h);
    v.zoomAt(2.5, 700, 420, DESKTOP.w, DESKTOP.h);
    const after = v.toWorld(700, 420, DESKTOP.w, DESKTOP.h);
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(1);
    v.zoomAt(1000, 700, 420, DESKTOP.w, DESKTOP.h);
    expect(v.zoomMul).toBe(THEATER_ZOOM_MAX);
    v.zoomAt(1e-6, 700, 420, DESKTOP.w, DESKTOP.h);
    expect(v.zoomMul).toBe(v.minZoom(DESKTOP.w, DESKTOP.h));
  });

  it('the map cannot be dragged out of the clear rectangle', () => {
    const v = view(PHONE);
    v.frameStart(world.front, PHONE.w, PHONE.h);
    v.panX += 1e6;
    v.panY -= 1e6;
    v.clampPan(PHONE.w, PHONE.h);
    // West edge at most the slack inside the left border; south edge at most the slack above the bottom one.
    expect(v.toScreen(0, 0, PHONE.w, PHONE.h)[0]).toBeLessThanOrEqual(PHONE.inset.left + 80);
    expect(v.toScreen(0, theater.boundsM.h, PHONE.w, PHONE.h)[1]).toBeGreaterThanOrEqual(PHONE.h - PHONE.inset.bottom - 80);
  });

  it('centerOn brings a point to the middle of the clear rectangle at the same zoom', () => {
    const v = view(DESKTOP);
    v.zoomMul = 3;
    const p = theater.nodes[theater.objectiveNodes[0]].pos;
    v.centerOn(p, DESKTOP.w, DESKTOP.h);
    expect(v.zoomMul).toBe(3);
    expect(inClear(v, DESKTOP, p.x, p.y)).toBe(true);
  });
});
