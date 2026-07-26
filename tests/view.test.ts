import { describe, expect, it } from 'vitest';
import { viewSize } from '../src/render/view';

describe('viewSize', () => {
  it('passes a 1× desktop viewport through untouched', () => {
    const v = viewSize(1280, 800, 1);
    expect(v).toEqual({ w: 1280, h: 800, dpr: 1 });
  });

  it('clamps a 3× phone to the 2× ratio cap', () => {
    expect(viewSize(390, 844, 3).dpr).toBe(2);
  });

  it('clamps a large 2× viewport by total area, not by ratio', () => {
    const v = viewSize(1440, 900, 2);
    expect(v.dpr).toBeLessThan(2);
    expect(v.w * v.dpr * v.h * v.dpr).toBeCloseTo(2_600_000, -1);
  });

  it('drops a 2× 1440p viewport all the way to 1 — the area cap alone exceeds it', () => {
    expect(viewSize(2560, 1440, 2).dpr).toBe(1);
  });

  it('never returns a dpr below 1, even on an absurd viewport', () => {
    expect(viewSize(7680, 4320, 3).dpr).toBe(1);
    expect(viewSize(1280, 800, 0.5).dpr).toBe(1);
  });

  it('keeps CSS dimensions verbatim', () => {
    const v = viewSize(393, 852, 3);
    expect(v.w).toBe(393);
    expect(v.h).toBe(852);
  });
});
