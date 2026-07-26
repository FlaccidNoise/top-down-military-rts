import { describe, expect, it } from 'vitest';
import { bootCamera, capInset, FRAME_M_MOBILE, WHOLE_MAP_PX_M } from '../src/render/framing';

const MAP = { w: 320, h: 240 };
// West-attack spawn: the case the original clear-viewport framing fix was
// measured against — blue sits at x≈7, exactly behind the roster panel.
const BLUE = Array.from({ length: 138 }, (_, i) => ({ x: 5 + (i % 9), y: 100 + ((i / 9) | 0) * 0.4 }));

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

  it('honours a custom fraction', () => {
    expect(capInset(266, 750, 0.35)).toBe(0);
    expect(capInset(266, 750, 0.5)).toBe(266);
  });

  // 266/760 is exactly 0.35, so the 266px roster still insets a 760px window —
  // the narrowest desktop layout the cap could plausibly have broken.
  it('does not cap the 266px roster at the narrowest desktop width', () => {
    expect(capInset(266, 760, 0.35)).toBe(266);
  });
});

describe('bootCamera', () => {
  const DESKTOP_INSET = { left: 266, top: 60, bottom: 52 };

  it('desktop 1280x800 takes the whole-map branch and keeps blue in the clear span', () => {
    const b = bootCamera(MAP, BLUE, 1280, 800, DESKTOP_INSET);
    expect(b.scale).toBeGreaterThanOrEqual(WHOLE_MAP_PX_M);
    const clearLeft = (266 - 1280 / 2) / b.scale + b.x;
    expect(clearLeft).toBeLessThanOrEqual(BLUE[0].x);
  });

  it('without the cap, a full-width sheet collapses the phone view to the 2 px/m floor', () => {
    const sheet = { left: 380, top: 76, bottom: 120 };
    const b = bootCamera(MAP, BLUE, 390, 844, sheet, { frameM: FRAME_M_MOBILE });
    expect(b.scale).toBe(2);
  });

  it('capInset rescues that same phone frame: >3 px/m and the blue centroid on screen', () => {
    const sheet = { left: 380, top: 76, bottom: 120 };
    const b = bootCamera(MAP, BLUE, 390, 844, sheet, { frameM: FRAME_M_MOBILE, capFrac: 0.35 });
    expect(b.scale).toBeGreaterThan(3);
    const cx = BLUE.reduce((a, s) => a + s.x, 0) / BLUE.length;
    const cy = BLUE.reduce((a, s) => a + s.y, 0) / BLUE.length;
    // clear rect = whole canvas once the drawer insets are dropped
    const sx = (cx - b.x) * b.scale + 390 / 2;
    const sy = (cy - b.y) * b.scale + 844 / 2;
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sx).toBeLessThanOrEqual(390);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sy).toBeLessThanOrEqual(844);
  });

  it('FRAME_M 70 clears the 5 px/m dot-LOD threshold where 120 does not', () => {
    const sheet = { left: 380, top: 76, bottom: 120 };
    const desktopDistance = bootCamera(MAP, BLUE, 390, 844, sheet, { capFrac: 0.35 });
    const mobileDistance = bootCamera(MAP, BLUE, 390, 844, sheet, { frameM: FRAME_M_MOBILE, capFrac: 0.35 });
    expect(desktopDistance.scale).toBeLessThan(5);
    expect(mobileDistance.scale).toBeGreaterThan(5);
  });

  it('capFrac left undefined never changes a desktop frame', () => {
    const capped = bootCamera(MAP, BLUE, 1280, 800, DESKTOP_INSET, { capFrac: 0.35 });
    const plain = bootCamera(MAP, BLUE, 1280, 800, DESKTOP_INSET);
    expect(capped).toEqual(plain); // 266/1280 = 21%, under the threshold either way
  });

  it('honours a lowered maxScale', () => {
    const tiny = { w: 40, h: 30 };
    const b = bootCamera(tiny, BLUE, 390, 844, { left: 0, top: 0, bottom: 0 }, { frameM: FRAME_M_MOBILE, maxScale: 32 });
    expect(b.scale).toBeLessThanOrEqual(32);
  });
});
