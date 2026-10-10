import { describe, expect, it } from 'vitest';
import { bootCamera, BOOT_MAX_PX_M, capInset, densestAim, READ_PX_M, type Inset } from '../src/render/framing';
import { SPRITE_MIN_SCALE } from '../src/render/dudes';

const MAP = { w: 320, h: 240 };

// A company as the theater stages it: nine rifle squads down the west edge,
// some 25 m apart, twelve men each. The line is far longer than any screen is
// tall at a zoom where a man can be read.
const COMPANY = Array.from({ length: 9 }, (_, q) => Array.from({ length: 12 }, (_, i) => ({ x: 6 + (i % 4) * 1.5, y: 14 + q * 26 + ((i / 4) | 0) * 1.5 }))).flat();
// The drill's platoon: three squads and a gun within sixty meters.
const PLATOON = Array.from({ length: 3 }, (_, q) => Array.from({ length: 12 }, (_, i) => ({ x: 8 + (i % 4) * 1.5, y: 40 + q * 18 + ((i / 4) | 0) * 1.5 }))).flat();

// The three form factors, with the chrome each really carries.
const SCREENS: { name: string; cw: number; ch: number; inset: Inset; capFrac?: number }[] = [
  { name: 'desktop 1280x800', cw: 1280, ch: 800, inset: { left: 266, top: 36, bottom: 0 } },
  { name: 'phone 390x844', cw: 390, ch: 844, inset: { left: 0, top: 58, bottom: 60 }, capFrac: 0.35 },
  { name: 'phone landscape 844x390', cw: 844, ch: 390, inset: { left: 0, top: 34, bottom: 60 }, capFrac: 0.35 },
];

/** How many of `pts` land inside the clear region for a camera. */
function inClear(pts: { x: number; y: number }[], cam: { x: number; y: number; scale: number }, s: (typeof SCREENS)[number]): number {
  return pts.filter((p) => {
    const sx = (p.x - cam.x) * cam.scale + s.cw / 2;
    const sy = (p.y - cam.y) * cam.scale + s.ch / 2;
    return sx >= s.inset.left && sx <= s.cw && sy >= s.inset.top && sy <= s.ch - s.inset.bottom;
  }).length;
}

describe('capInset', () => {
  it('leaves a border-sized inset alone', () => {
    expect(capInset(266, 1280)).toBe(266);
    expect(capInset(0, 390)).toBe(0);
  });

  it('drops an inset that eats more than a third of the axis', () => {
    expect(capInset(266, 390)).toBe(0);
  });

  it('switches exactly at the fraction boundary', () => {
    expect(capInset(35, 100, 0.35)).toBe(35);
    expect(capInset(35.0001, 100, 0.35)).toBe(0);
  });

  // 266/760 is exactly 0.35, so the 266px roster still insets a 760px window —
  // the narrowest desktop layout the cap could plausibly have broken.
  it('does not cap the 266px roster at the narrowest desktop width', () => {
    expect(capInset(266, 760, 0.35)).toBe(266);
  });
});

describe('densestAim', () => {
  // A plain w×h window, no map edge to clamp against.
  const box = (pts: { x: number; y: number }[], w: number, h: number) => (x: number, y: number) =>
    pts.filter((p) => Math.abs(p.x - x) <= w / 2 && Math.abs(p.y - y) <= h / 2);

  it('finds the cluster, not the middle of nowhere between two', () => {
    const pts = [...Array.from({ length: 5 }, (_, i) => ({ x: 10 + i, y: 10 })), ...Array.from({ length: 9 }, (_, i) => ({ x: 200 + i, y: 100 }))];
    const w = densestAim(pts, box(pts, 20, 20))!;
    expect(w.count).toBe(9);
    expect(Math.abs(w.x - 204)).toBeLessThanOrEqual(4);
    expect(w.y).toBeCloseTo(100, 0);
  });

  it('frames an evenly spread force on its middle', () => {
    const w = densestAim(COMPANY, box(COMPANY, 60, 60))!;
    const mid = COMPANY.reduce((a, p) => a + p.y, 0) / COMPANY.length;
    expect(Math.abs(w.y - mid)).toBeLessThan(15);
  });

  it('has nothing to frame with nobody fielded', () => {
    expect(densestAim([], () => [])).toBeNull();
  });
});

describe('bootCamera: the battle opens on the player\'s men', () => {
  for (const s of SCREENS) {
    it(`${s.name}: a company opens at a zoom where a man reads as a man`, () => {
      const cam = bootCamera(MAP, COMPANY, s.cw, s.ch, s.inset, { capFrac: s.capFrac });
      expect(cam.scale).toBeGreaterThanOrEqual(READ_PX_M);
      expect(cam.scale).toBeGreaterThan(SPRITE_MIN_SCALE);
    });

    it(`${s.name}: the frame holds as many of the company as any frame that size could`, () => {
      const cam = bootCamera(MAP, COMPANY, s.cw, s.ch, s.inset, { capFrac: s.capFrac });
      const got = inClear(COMPANY, cam, s);
      // The best any camera at this scale can do, by brute force over every man.
      let best = 0;
      for (const c of COMPANY) best = Math.max(best, inClear(COMPANY, { x: c.x + (s.cw / 2 - (s.inset.left + s.cw) / 2) / cam.scale, y: c.y + (s.ch / 2 - (s.inset.top + s.ch - s.inset.bottom) / 2) / cam.scale, scale: cam.scale }, s));
      expect(got).toBeGreaterThanOrEqual(12); // one whole squad, on every screen
      expect(got).toBeGreaterThanOrEqual(best * 0.9);
    });

    it(`${s.name}: a platoon small enough to fit is framed whole`, () => {
      const cam = bootCamera(MAP, PLATOON, s.cw, s.ch, s.inset, { capFrac: s.capFrac });
      if (cam.scale > READ_PX_M) expect(inClear(PLATOON, cam, s)).toBe(PLATOON.length);
      expect(cam.scale).toBeLessThanOrEqual(BOOT_MAX_PX_M);
      expect(inClear(PLATOON, cam, s)).toBeGreaterThanOrEqual(12);
    });

    it(`${s.name}: the clear region shows no ground off the map`, () => {
      const cam = bootCamera(MAP, COMPANY, s.cw, s.ch, s.inset, { capFrac: s.capFrac });
      const left = (s.inset.left - s.cw / 2) / cam.scale + cam.x;
      const top = (s.inset.top - s.ch / 2) / cam.scale + cam.y;
      const bottom = (s.ch - s.inset.bottom - s.ch / 2) / cam.scale + cam.y;
      expect(left).toBeGreaterThanOrEqual(-0.001);
      expect(top).toBeGreaterThanOrEqual(-0.001);
      expect(bottom).toBeLessThanOrEqual(MAP.h + 0.001);
    });
  }

  it('never frames the men behind the desktop roster', () => {
    const s = SCREENS[0];
    const cam = bootCamera(MAP, COMPANY, s.cw, s.ch, s.inset);
    const xs = COMPANY.map((p) => (p.x - cam.x) * cam.scale + s.cw / 2);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(s.inset.left);
  });

  it('a full-width phone sheet is a drawer, not a border: the cap keeps the frame on the men', () => {
    const sheet = { left: 380, top: 76, bottom: 120 };
    const cam = bootCamera(MAP, COMPANY, 390, 844, sheet, { capFrac: 0.35 });
    expect(cam.scale).toBeGreaterThanOrEqual(READ_PX_M);
    expect(inClear(COMPANY, cam, { name: '', cw: 390, ch: 844, inset: { left: 0, top: 76, bottom: 120 } })).toBeGreaterThanOrEqual(12);
  });

  it('opens on the middle of the map with nobody fielded', () => {
    const cam = bootCamera(MAP, [], 1280, 800, { left: 0, top: 0, bottom: 0 });
    expect(cam.scale).toBe(READ_PX_M);
    expect(cam.x).toBeCloseTo(MAP.w / 2);
    expect(cam.y).toBeCloseTo(MAP.h / 2);
  });

  it('honours a lowered maxScale', () => {
    const cam = bootCamera(MAP, PLATOON.slice(0, 2), 1280, 800, { left: 0, top: 0, bottom: 0 }, { maxScale: 8 });
    expect(cam.scale).toBe(8);
  });
});
