// TheaterView camera arithmetic (jtbug #782). The HUD is opaque DOM, so every
// framing operation is checked against the CLEAR rectangle, not the canvas.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeHeadlessWorld } from '../src/strategic/headless';
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
    id, side, letter: side === 'blue' ? 'A' : null, role: 'line', strength: 100, frac: 1, supply: null, fatigue: 0,
    selected, engaged: false, conf: 1, ghost: false, ax, ay, drop: 12,
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
