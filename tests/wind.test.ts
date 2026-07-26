import { describe, expect, it } from 'vitest';
import { LEAN_K, WIND, WIND_SPEED } from '../src/sim/wind';
import { WIND as LIGHT_WIND } from '../src/render/light';
import { WIND as FX_WIND } from '../src/render/fx';

describe('the one wind', () => {
  it('is bit-identical to the render-side values it replaced', () => {
    // Was `const WIND_LEN = Math.hypot(0.82, -0.57)` in render/light.ts. The
    // sim copy normalizes with Math.sqrt (correctly rounded per IEEE-754,
    // unlike Math.hypot) and must land on exactly the same doubles, or every
    // baked smoke/leaf/chimney offset shifts.
    const len = Math.hypot(0.82, -0.57);
    expect(WIND.dx).toBe(0.82 / len);
    expect(WIND.dy).toBe(-0.57 / len);
  });

  it('is a unit vector', () => {
    expect(WIND.dx * WIND.dx + WIND.dy * WIND.dy).toBeCloseTo(1, 12);
  });

  it('render/light.ts re-exports the same object, not a copy', () => {
    expect(LIGHT_WIND).toBe(WIND);
  });

  it('fx.ts keeps its {dx, dy, speed} shape so renderer.ts and roofs.ts are untouched', () => {
    expect(FX_WIND.dx).toBe(WIND.dx);
    expect(FX_WIND.dy).toBe(WIND.dy);
    expect(FX_WIND.speed).toBe(WIND_SPEED);
    expect(WIND_SPEED).toBe(1.6);
  });

  it('publishes the plume lean constant', () => {
    expect(LEAN_K).toBe(0.35);
  });
});
