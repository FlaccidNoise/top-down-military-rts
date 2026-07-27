import { describe, expect, it } from 'vitest';
import { LEAN_K, smokeAxisAt, WIND, WIND_SPEED } from '../src/sim/wind';
import { grow, smokePuff } from '../src/sim/sim';
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

// V12 WYSIWYG. The renderer stacks its puff sprites up the column with
// smokeAxisAt and sightBetween re-projects its ray against smokeAxisAt, so the
// drawn cloud and the blocking cloud are the same object BY CONSTRUCTION.
// These pin the two ends of that claim: the shared formula, and the fact that
// the renderer needs no private state to know a puff's age — the sim carries
// both halves of the fraction.
describe('smokeAxisAt is the one plume axis (V12)', () => {
  it('is the identity at the column base and leans LEAN_K per metre of rise', () => {
    const p = { x: 40, y: 60, z0: 2 };
    expect(smokeAxisAt(p, 2)).toEqual([40, 60]);
    for (const dz of [1, 4, 9.5, 18]) {
      const [ax, ay] = smokeAxisAt(p, 2 + dz);
      expect(ax).toBeCloseTo(40 + WIND.dx * LEAN_K * dz, 12);
      expect(ay).toBeCloseTo(60 + WIND.dy * LEAN_K * dz, 12);
    }
  });

  // sightBetween clamps the eye-line to `top = p.z0 + p.h` and re-projects
  // there; the renderer's last sample is u = 1, i.e. the same z. Same input,
  // same function, so the agreement is exact rather than "< 0.01 m".
  it('puts the drawn column top exactly where the blocking column top is, at every age', () => {
    for (const age of [0, 5, 30, 60]) {
      const p = smokePuff(10, 20, 1.5, 60 - age, 0, age);
      const top = p.z0 + p.h;
      const [ax, ay] = smokeAxisAt(p, top);
      // what sightBetween computes inline for the clamped height
      const off = LEAN_K * (top - p.z0);
      expect(ax).toBe(p.x + WIND.dx * off);
      expect(ay).toBe(p.y + WIND.dy * off);
      expect(p.h).toBe(grow(age, 1.5, 10, 10));
      expect(p.r).toBe(grow(age, 1.5, 3.0, 10));
    }
  });

  // The renderer's alpha envelope is age / (age + ttl). That denominator has
  // to BE the spawn ttl, or the fade is wrong — and it is the identity that
  // let smokeMaxTtl (a per-entry Map keyed on x,y) be deleted outright.
  it('age + ttl is the spawn ttl, which is what the envelope needs and the Map used to guess', () => {
    for (const age of [0, 5, 30, 59]) {
      const p = smokePuff(10, 20, 0, 60 - age, 0, age);
      expect(p.age + p.ttl).toBe(60);
    }
  });
});
