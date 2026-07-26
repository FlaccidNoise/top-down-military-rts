import { describe, expect, it } from 'vitest';
import { classify, HOLD_MS, TAP_SLOP, TWO_TAP_MS } from '../src/ui/touch';

const g = (dt: number, dist: number, fingers = 1, maxFingers = 1) => classify({ dt, dist, fingers, maxFingers });

describe('classify', () => {
  it('reads a quick still touch as a tap', () => {
    expect(g(80, 0, 0, 1)).toBe('tap');
    expect(g(HOLD_MS - 1, TAP_SLOP, 0, 1)).toBe('tap');
  });

  it('reads a still touch past HOLD_MS as a hold', () => {
    expect(g(HOLD_MS, 0, 0, 1)).toBe('hold');
    expect(g(900, TAP_SLOP, 0, 1)).toBe('hold');
  });

  it('reads movement past the slop before HOLD_MS as a pan', () => {
    expect(g(60, TAP_SLOP + 1)).toBe('pan');
    expect(g(HOLD_MS - 1, 400)).toBe('pan');
  });

  it('reads movement after the hold armed as a formation drag', () => {
    expect(g(HOLD_MS, TAP_SLOP + 1)).toBe('holdDrag');
    expect(g(1200, 90)).toBe('holdDrag');
  });

  it('reads two live fingers as a pinch regardless of timing', () => {
    expect(g(10, 0, 2, 2)).toBe('pinch');
    expect(g(5000, 300, 2, 3)).toBe('pinch');
  });

  it('reads a quick, still two-finger touch as the escape gesture', () => {
    expect(g(TWO_TAP_MS, TAP_SLOP, 0, 2)).toBe('twoTap');
  });

  it('does not mistake a slow or smeared two-finger release for the escape gesture', () => {
    expect(g(TWO_TAP_MS + 1, 0, 0, 2)).toBe('pinch');
    expect(g(100, TAP_SLOP + 1, 0, 2)).toBe('pinch');
  });

  it('never reports a single-finger gesture once a second finger has landed', () => {
    expect(g(1000, 200, 0, 2)).not.toBe('pan');
    expect(g(1000, 0, 0, 2)).not.toBe('hold');
  });
});
