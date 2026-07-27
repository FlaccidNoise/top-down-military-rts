import { describe, expect, it } from 'vitest';
import {
  CANON_CLOCK_MIN,
  EL_CANON,
  MAP_N,
  ambientAt,
  azimuthAt,
  elevationAt,
  sunAt,
  sunStepAt,
} from '../src/sim/solar';
import { SHADOW_ALPHA, SHADOW_SOFT_ALPHA, SUN, setSun, shadowAlpha, shadowOffset, shadowSoftAlpha } from '../src/render/light';

// This suite is the guard on the whole day/night design. Map-north is DEFINED
// as the direction today's shadows fall, which makes solar noon the fixed point
// where the sun model reproduces the shipped art byte-for-byte. If anything
// below goes red, every art baseline in the repo is invalid — do not "update
// the expectation", find what moved the sun.
describe('the canonical hour is the shipped art', () => {
  it('is 14:00 DBST = solar noon', () => {
    expect(CANON_CLOCK_MIN).toBe(14 * 60);
    expect(azimuthAt(CANON_CLOCK_MIN)).toBeCloseTo(180, 9); // due south
    expect(elevationAt(CANON_CLOCK_MIN)).toBeCloseTo(90 - 49.2 + 21, 9);
  });

  it('map-north is bit-identical to the SUN vector the baselines were baked with', () => {
    // Was `const SUN_LEN = Math.hypot(0.45, 0.55)` in render/light.ts. The sim
    // copy normalizes with Math.sqrt (correctly rounded per IEEE-754, unlike
    // Math.hypot) and must land on exactly the same doubles.
    const len = Math.hypot(0.45, 0.55);
    expect(MAP_N.dx).toBe(0.45 / len);
    expect(MAP_N.dy).toBe(0.55 / len);
    expect(MAP_N.dx * MAP_N.dx + MAP_N.dy * MAP_N.dy).toBeCloseTo(1, 12);
  });

  it('casts exactly along map-north at the canonical hour — no ULP drift', () => {
    const s = sunAt(CANON_CLOCK_MIN);
    expect(s.dir[0]).toBe(MAP_N.dx);
    expect(s.dir[1]).toBe(MAP_N.dy);
    expect(Math.abs(s.dir[0] - 0.45 / Math.hypot(0.45, 0.55))).toBeLessThan(1e-9);
    expect(Math.abs(s.dir[1] - 0.55 / Math.hypot(0.45, 0.55))).toBeLessThan(1e-9);
  });

  it('is the identity for every art multiplier', () => {
    const s = sunAt(CANON_CLOCK_MIN);
    expect(s.lenMul).toBe(1); // exactly — cot(EL_CANON)/cot(EL_CANON)
    expect(s.alphaMul).toBe(1);
    expect(s.softMul).toBe(1);
    expect(s.ambient[3]).toBe(0); // no grade drawn at all
  });

  it('derives EL_CANON from the bucket centre, not from 14:00 itself', () => {
    // lenMul divides cot(el) by cot(EL_CANON) and a SunState's el is always a
    // bucket centre, so EL_CANON must be that centre or the identity is only
    // approximate. 61.8 falls in the [60, 65) bucket.
    expect(EL_CANON).toBe(62.5);
    expect(EL_CANON).not.toBe(elevationAt(CANON_CLOCK_MIN));
    expect(sunAt(CANON_CLOCK_MIN).el).toBe(EL_CANON);
  });
});

describe('quantization', () => {
  it('holds the step steady across +/- 15 min of the canonical hour', () => {
    const step = sunStepAt(CANON_CLOCK_MIN);
    for (let d = -15; d <= 15; d++) expect(sunStepAt(CANON_CLOCK_MIN + d)).toBe(step);
  });

  it('makes two clock times in one bucket field-for-field identical', () => {
    const a = sunAt(CANON_CLOCK_MIN - 12);
    const b = sunAt(CANON_CLOCK_MIN + 12);
    expect(a).toEqual(b);
    expect(a.step).toBe(sunAt(CANON_CLOCK_MIN).step);
  });

  it('does step over the day — the bucket is a bucket, not a constant', () => {
    const steps = new Set<number>();
    for (let m = 0; m < 1440; m += 10) steps.add(sunStepAt(m));
    expect(steps.size).toBeGreaterThan(12);
  });

  it('repeats on the next campaign day — the clock runs past 1440', () => {
    for (const m of [0, 360, 840, 1200]) expect(sunStepAt(m + 1440)).toBe(sunStepAt(m));
  });
});

describe('the solar arc over Normandy', () => {
  // Cross-checked against the design's computed table (49.2 N, decl +21, DBST).
  const arc: [number, number, number][] = [
    [120, -19.8, 0], // 02:00 solar midnight, sun due north, darkest
    [330, -5.7, 48], // 05:30 civil dawn begins
    [375, 0.1, 57], // 06:15 sunrise
    [420, 6.5, 65], // 07:00
    [720, 53.1, 129], // 12:00
    [840, 61.8, 180], // 14:00 solar noon
    [1260, 6.5, 295], // 21:00
    [1305, 0.1, 303], // 21:45 sunset
    [1350, -5.7, 312], // 22:30 civil dusk ends
  ];
  it.each(arc)('at %i min the sun is at el %f az %f', (m, el, az) => {
    expect(elevationAt(m)).toBeCloseTo(el, 1);
    expect(azimuthAt(m)).toBeCloseTo(az, 0);
  });

  it('OP_START_MIN (06:00) is first light, not day — the campaign opens on a dawn fight', () => {
    const s = sunAt(6 * 60);
    expect(s.el).toBeLessThan(0);
    expect(s.alphaMul).toBeLessThan(0.1); // no readable cast shadow
    // Deep into the twilight band of the ramp. (The design's prose says ~0.40
    // here; its own ramp table says the 0->-6 band runs 0.10 -> 0.42, and the
    // table is the spec. At the -2.5 bucket centre that is 0.233.)
    expect(s.ambient[3]).toBeGreaterThan(0.2);
  });
});

describe('the three art quantities', () => {
  it('rakes the shadow out at a low sun and clamps it at 3x', () => {
    const dawn = sunAt(7 * 60);
    expect(dawn.lenMul).toBe(3);
    expect(dawn.alphaMul).toBeGreaterThan(0.2);
    expect(dawn.alphaMul).toBeLessThan(0.6);
    expect(dawn.softMul).toBeGreaterThan(2); // long, faint, soft
  });

  it('never exceeds the clamp and never goes negative, at any minute of the day', () => {
    for (let m = 0; m < 1440; m++) {
      const s = sunAt(m);
      expect(s.lenMul).toBeGreaterThanOrEqual(0);
      expect(s.lenMul).toBeLessThanOrEqual(3);
      expect(s.alphaMul).toBeGreaterThanOrEqual(0);
      expect(s.alphaMul).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s.dir[0]) && Number.isFinite(s.dir[1])).toBe(true);
      expect(s.dir[0] * s.dir[0] + s.dir[1] * s.dir[1]).toBeCloseTo(1, 12);
    }
  });

  it('switches the cast pass off entirely below civil twilight', () => {
    const night = sunAt(2 * 60);
    expect(night.alphaMul).toBe(0);
    expect(night.lenMul).toBe(0); // no cast => no bbox to bake either
  });

  it('rotates the cast clockwise from morning through noon to evening', () => {
    // The shipped screen basis: map-north is SE-ish, so a morning sun in the
    // east throws shadows up-and-right and an evening sun throws them
    // down-and-left. Signed angle must decrease monotonically... in screen
    // terms, sweep clockwise.
    const ang = (m: number): number => {
      const s = sunAt(m);
      return Math.atan2(s.dir[1], s.dir[0]);
    };
    expect(ang(9 * 60)).toBeLessThan(ang(14 * 60));
    expect(ang(14 * 60)).toBeLessThan(ang(18 * 60));
    expect(sunAt(9 * 60).dir[1]).toBeLessThan(0); // morning shadow points screen-up
    expect(sunAt(18 * 60).dir[0]).toBeLessThan(0); // evening shadow points screen-left
  });
});

describe('the ambient ramp', () => {
  it('draws nothing through the core of the day', () => {
    for (let m = 9 * 60; m <= 19 * 60; m += 15) expect(sunAt(m).ambient[3]).toBe(0);
  });

  it('is monotone in darkness as the sun goes down', () => {
    let prev = -1;
    for (let el = 30; el >= -20; el -= 0.5) {
      const a = ambientAt(el)[3];
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it('is continuous across every band boundary', () => {
    for (const e of [25, 0, -6, -12]) {
      const hi = ambientAt(e + 1e-6);
      const lo = ambientAt(e - 1e-6);
      for (let i = 0; i < 4; i++) expect(lo[i]).toBeCloseTo(hi[i], 4);
    }
  });

  it('floors at 0.62 so night lifts blacks instead of crushing them', () => {
    expect(ambientAt(-12)[3]).toBeCloseTo(0.62, 9);
    expect(ambientAt(-40)[3]).toBe(ambientAt(-12)[3]);
    // source-over at a=0.62 over black: 0.62 * (26,36,68) = (16,22,42)
    const [r, g, b, a] = ambientAt(-20);
    expect(r * a).toBeGreaterThan(8);
    expect(b * a).toBeGreaterThan(20);
    expect(g * a).toBeLessThan(40); // still unmistakably dark
  });

  it('reaches the floor at solar midnight — the darkest bucket is actually dark', () => {
    expect(sunAt(2 * 60).ambient[3]).toBeCloseTo(0.62, 9);
  });
});

describe('render/light.ts adapter', () => {
  it('re-exports the canonical sun with the exact values it used to hard-code', () => {
    const len = Math.hypot(0.45, 0.55);
    expect(SUN.dx).toBe(0.45 / len);
    expect(SUN.dy).toBe(0.55 / len);
    expect(shadowOffset(1)).toEqual([SUN.dx, SUN.dy]);
    expect(shadowOffset(2.5)).toEqual([SUN.dx * 2.5, SUN.dy * 2.5]);
  });

  it('starts at the canonical hour so an unwired build is the shipped build', () => {
    expect(shadowAlpha()).toBe(SHADOW_ALPHA);
    expect(shadowSoftAlpha()).toBe(SHADOW_SOFT_ALPHA);
  });

  it('setSun reports only real step changes, and reverts exactly', () => {
    expect(setSun(CANON_CLOCK_MIN)).toBe(false); // already there
    expect(setSun(CANON_CLOCK_MIN + 10)).toBe(false); // same bucket
    expect(setSun(7 * 60)).toBe(true);
    expect(SUN.dx).not.toBe(0.45 / Math.hypot(0.45, 0.55));
    expect(shadowOffset(1)[0]).toBeCloseTo(SUN.dx * 3, 12); // lenMul 3 at dawn
    expect(shadowAlpha()).toBeLessThan(SHADOW_ALPHA);

    expect(setSun(CANON_CLOCK_MIN)).toBe(true);
    expect(SUN.dx).toBe(0.45 / Math.hypot(0.45, 0.55));
    expect(SUN.dy).toBe(0.55 / Math.hypot(0.45, 0.55));
    expect(shadowOffset(0.71)).toEqual([SUN.dx * 0.71, SUN.dy * 0.71]);
    expect(shadowAlpha()).toBe(SHADOW_ALPHA);
  });
});
