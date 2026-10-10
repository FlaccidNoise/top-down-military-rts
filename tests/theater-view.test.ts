// TheaterView camera arithmetic (jtbug #782). The HUD is opaque DOM, so every
// framing operation is checked against the CLEAR rectangle, not the canvas.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeHeadlessWorld } from '../src/strategic/headless';
import { THEATER_ZOOM_MAX, TheaterView } from '../src/render/theater-view';

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
