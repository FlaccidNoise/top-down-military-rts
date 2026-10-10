import { describe, expect, it } from 'vitest';
import { placeAvoiding, placeBubble, type Rect } from '../src/ui/coach';

const rect = (left: number, top: number, w: number, h: number): Rect => ({ left, top, right: left + w, bottom: top + h });
const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const box = (p: { left: number; top: number }, w: number, h: number): Rect => rect(p.left, p.top, w, h);

// The phone the defect was found on, and the desktop profile.
const PHONE = { ...rect(0, 0, 390, 844), w: 390, h: 844 };
const DESK = { ...rect(0, 0, 1280, 800), w: 1280, h: 800 };
const BUBBLE = { w: 300, h: 60 };

describe('placeBubble', () => {
  it('sits below a control at the top of the screen and points at it', () => {
    const anchor = rect(1160, 8, 112, 26);
    const p = placeBubble(anchor, anchor, BUBBLE.w, BUBBLE.h, DESK);
    expect(p.side).toBe('below');
    expect(p.top).toBeGreaterThanOrEqual(anchor.bottom);
    expect(p.left + BUBBLE.w).toBeLessThanOrEqual(DESK.w);
    // The pointer lands on the anchor's centre even though the box was pushed left.
    expect(p.left + p.arrow).toBeCloseTo(1216, 0);
  });

  it('flips above a control at the bottom of the screen', () => {
    const anchor = rect(280, 790, 100, 44);
    const p = placeBubble(anchor, anchor, BUBBLE.w, BUBBLE.h, PHONE);
    expect(p.side).toBe('above');
    expect(p.top + BUBBLE.h).toBeLessThanOrEqual(anchor.top);
  });

  it('clears the whole touch bar, not only the chip it names', () => {
    // Play sits in the bar's second row; the order chips are the row above it.
    const play = rect(280, 794, 60, 44);
    const bar = rect(0, 740, 390, 104);
    const p = placeBubble(play, bar, BUBBLE.w, BUBBLE.h, PHONE);
    expect(overlaps(box(p, BUBBLE.w, BUBBLE.h), bar)).toBe(false);
  });

  it('goes beside full-height chrome that leaves no room above or below', () => {
    const roster = rect(8, 48, 258, 700);
    const p = placeBubble(roster, roster, BUBBLE.w, BUBBLE.h, rect(0, 0, 1280, 760));
    expect(p.side).toBe('right');
    expect(overlaps(box(p, BUBBLE.w, BUBBLE.h), roster)).toBe(false);
  });

  it('never covers the control it names when any side has room', () => {
    const anchors = [rect(20, 20, 80, 30), rect(600, 380, 60, 60), rect(1180, 740, 80, 40), rect(4, 400, 120, 44)];
    for (const a of anchors) {
      const p = placeBubble(a, a, BUBBLE.w, BUBBLE.h, DESK);
      expect(overlaps(box(p, BUBBLE.w, BUBBLE.h), a), JSON.stringify(a)).toBe(false);
    }
  });

  // jtbug #783: the anchor was a chip at x = 569 in a scrolling row on a 390 px
  // screen. Wherever the anchor is, the box stays inside the viewport.
  it('stays inside the viewport for an anchor that is off screen', () => {
    const anchors = [rect(569, 794, 71, 44), rect(-200, 300, 50, 50), rect(100, 2000, 50, 50), rect(100, -500, 50, 50)];
    for (const a of anchors) {
      const p = placeBubble(a, a, BUBBLE.w, BUBBLE.h, PHONE);
      expect(p.left, JSON.stringify(a)).toBeGreaterThanOrEqual(0);
      expect(p.top, JSON.stringify(a)).toBeGreaterThanOrEqual(0);
      expect(p.left + BUBBLE.w, JSON.stringify(a)).toBeLessThanOrEqual(PHONE.w);
      expect(p.top + BUBBLE.h, JSON.stringify(a)).toBeLessThanOrEqual(PHONE.h);
    }
  });

  it('stays on screen when the thing to clear fills the viewport', () => {
    const all = rect(0, 0, PHONE.w, PHONE.h);
    const p = placeBubble(rect(150, 400, 90, 44), all, BUBBLE.w, BUBBLE.h, PHONE);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + BUBBLE.h).toBeLessThanOrEqual(PHONE.h);
  });

  it('keeps a world bubble on the map, clear of the HUD around it', () => {
    // Roster on the left, top bar above, key legend below.
    const stage = rect(274, 40, 1006, 700);
    for (const a of [rect(280, 10, 50, 50), rect(290, 690, 60, 60), rect(1230, 300, 44, 44)]) {
      const p = placeBubble(a, a, BUBBLE.w, BUBBLE.h, stage);
      expect(p.left, JSON.stringify(a)).toBeGreaterThanOrEqual(stage.left);
      expect(p.top, JSON.stringify(a)).toBeGreaterThanOrEqual(stage.top);
      expect(p.left + BUBBLE.w, JSON.stringify(a)).toBeLessThanOrEqual(stage.right);
      expect(p.top + BUBBLE.h, JSON.stringify(a)).toBeLessThanOrEqual(stage.bottom);
    }
  });

  it('keeps the pointer on the bubble when the anchor is past its end', () => {
    const p = placeBubble(rect(0, 100, 10, 10), rect(0, 100, 10, 10), BUBBLE.w, BUBBLE.h, DESK);
    expect(p.arrow).toBeGreaterThan(0);
    expect(p.arrow).toBeLessThan(BUBBLE.w);
  });
});

describe('placeAvoiding', () => {
  const PHONE: Rect = { left: 0, top: 0, right: 390, bottom: 844 };
  const play: Rect = { left: 35, top: 36, right: 105, bottom: 80 };
  const head: Rect = { left: 4, top: 8, right: 386, bottom: 86 };
  const strip: Rect = { left: 4, top: 92, right: 386, bottom: 170 };
  const hit = (p: { left: number; top: number }, w: number, h: number, r: Rect): boolean => p.left < r.right && p.left + w > r.left && p.top < r.bottom && p.top + h > r.top;

  it('is placeBubble when nothing is in the way', () => {
    expect(placeAvoiding(play, play, 374, 58, PHONE, [])).toEqual(placeBubble(play, play, 374, 58, PHONE));
    const far: Rect = { left: 4, top: 700, right: 386, bottom: 800 };
    expect(placeAvoiding(play, play, 374, 58, PHONE, [far])).toEqual(placeBubble(play, play, 374, 58, PHONE));
  });

  it('goes past a panel stacked under the control, and still points at the control', () => {
    const plain = placeBubble(play, play, 374, 58, PHONE);
    expect(hit(plain, 374, 58, strip)).toBe(true); // the defect this fixes
    const p = placeAvoiding(play, play, 374, 58, PHONE, [head, strip]);
    expect(hit(p, 374, 58, strip)).toBe(false);
    expect(hit(p, 374, 58, head)).toBe(false);
    expect(p.side).toBe('below');
    expect(p.top).toBeGreaterThanOrEqual(strip.bottom);
    expect(p.left + p.arrow).toBeCloseTo((play.left + play.right) / 2, 0);
  });

  it('stays on screen when the panels leave no room at all', () => {
    const wall: Rect = { left: 0, top: 0, right: 390, bottom: 844 };
    const p = placeAvoiding(play, play, 374, 58, PHONE, [wall]);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.left + 374).toBeLessThanOrEqual(390);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + 58).toBeLessThanOrEqual(844);
  });
});
