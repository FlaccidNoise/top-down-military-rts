import { describe, expect, it } from 'vitest';
import { chase, FALL_MS, fallSlide, gunRecoil, hitJerk, hullRock, JERK_MS, KICK_MS, kickBack, RECOIL_MS, TURRET_SLEW, wrapAngle } from '../src/render/react';

// The reaction step (src/render/react.ts): none of it shows in a still, so
// its shape is pinned here. Each function is an offset or a fraction that the
// renderer adds to a draw position, which makes one rule absolute: outside its
// window, and for garbage, it is exactly 0.

const BAD = [Number.NaN, -1, -1e9, Number.NEGATIVE_INFINITY];

describe('shooter kick', () => {
  it('snaps out on the shot and has gone by the end of its window', () => {
    expect(kickBack(0, 1, 0)).toBeCloseTo(0.11, 10);
    expect(kickBack(60, 1, 0)).toBeLessThan(0.11 / 2.5);
    expect(kickBack(KICK_MS - 1, 1, 0)).toBeLessThan(0.002);
    expect(kickBack(KICK_MS, 1, 0)).toBe(0);
  });

  it('kicks once per round of a burst, at the burst spacing', () => {
    // MG42: five rounds 50 ms apart. The offset is back at its peak on each.
    for (let tap = 0; tap < 5; tap++) expect(kickBack(tap * 50, 5, 50), `tap ${tap}`).toBeCloseTo(0.11, 10);
    // and has decayed between them
    expect(kickBack(45, 5, 50)).toBeLessThan(0.06);
    // no sixth kick: after the last round it only decays
    expect(kickBack(5 * 50, 5, 50)).toBeLessThan(kickBack(4 * 50, 5, 50));
    expect(kickBack(4 * 50 + KICK_MS, 5, 50)).toBe(0);
  });

  it('is 0 before the shot and for an age that is not a number', () => {
    for (const a of BAD) expect(kickBack(a, 3, 100), String(a)).toBe(0);
    expect(kickBack(10, Number.NaN, 50)).toBe(0);
  });
});

describe('hit jerk', () => {
  it('is largest when the round lands and dies inside its window', () => {
    expect(hitJerk(0)).toBeCloseTo(0.2, 10);
    let prev = hitJerk(0);
    for (let a = 10; a < JERK_MS; a += 10) {
      const j = hitJerk(a);
      expect(j, `a=${a}`).toBeLessThan(prev);
      prev = j;
    }
    expect(hitJerk(JERK_MS)).toBe(0);
  });

  it('does nothing while the round is still in the air', () => {
    for (const a of BAD) expect(hitJerk(a), String(a)).toBe(0);
  });
});

describe('death slide', () => {
  it('runs 0 to 1, fast off the mark, and stays at 1', () => {
    expect(fallSlide(0)).toBe(0);
    expect(fallSlide(FALL_MS / 2)).toBeGreaterThan(0.8); // most of the way in half the time
    expect(fallSlide(FALL_MS)).toBe(1);
    expect(fallSlide(1e9)).toBe(1); // he settles there: the pool is stamped on that spot
    let prev = 0;
    for (let a = 0; a <= FALL_MS; a += 5) {
      const s = fallSlide(a);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('is 0 for a man who has not fallen', () => {
    for (const a of BAD) expect(fallSlide(a), String(a)).toBe(0);
  });
});

describe('turret chase', () => {
  const DT = 1 / 60;

  it('turns at the traverse rate and stops on the target', () => {
    let a = 0;
    const want = 1.2;
    let frames = 0;
    while (a !== want && frames < 1000) {
      const next = chase(a, want, DT);
      expect(next - a).toBeLessThanOrEqual(TURRET_SLEW * DT + 1e-12);
      a = next;
      frames++;
    }
    expect(a).toBe(want);
    expect(frames).toBe(Math.ceil(want / (TURRET_SLEW * DT)));
    expect(chase(a, want, DT)).toBe(want); // and holds
  });

  it('goes the short way round, across the back of the hull', () => {
    // from 170 degrees to -170: 20 degrees through the rear, not 340 the other way
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const next = chase(from, to, DT);
    expect(wrapAngle(next - from)).toBeGreaterThan(0);
    let a = from;
    let frames = 0;
    while (a !== to && frames < 1000) {
      a = chase(a, to, DT);
      frames++;
    }
    expect(frames).toBe(Math.ceil(((20 * Math.PI) / 180) / (TURRET_SLEW * DT)));
  });

  it('does not move while the fx clock is stopped', () => {
    expect(chase(0.3, 1.2, 0)).toBe(0.3);
    expect(chase(0.3, 1.2, Number.NaN)).toBe(0.3);
    expect(chase(0.3, 1.2, -1)).toBe(0.3);
  });

  it('stays inside (-PI, PI] whatever it is given', () => {
    for (const [c, w] of [[10, -10], [-7, 3], [Math.PI, -Math.PI], [0, Number.NaN], [0, Infinity]]) {
      const a = chase(c, w, DT);
      expect(a, `${c} -> ${w}`).toBeGreaterThan(-Math.PI - 1e-9);
      expect(a, `${c} -> ${w}`).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
    expect(wrapAngle(Number.NaN)).toBe(0);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
  });
});

describe('gun recoil and hull rock', () => {
  it('runs the gun back on the shot and returns it', () => {
    expect(gunRecoil(0)).toBe(1);
    expect(gunRecoil(160)).toBeLessThan(0.15);
    expect(gunRecoil(RECOIL_MS)).toBe(0);
    for (const a of BAD) expect(gunRecoil(a), String(a)).toBe(0);
  });

  it('shoves the hull back, rebounds it a little, and leaves it where it was', () => {
    expect(hullRock(0)).toBeCloseTo(0.11, 10);
    const samples = Array.from({ length: RECOIL_MS / 5 }, (_, i) => hullRock(i * 5));
    expect(Math.min(...samples)).toBeLessThan(0); // it comes forward past rest
    expect(Math.abs(Math.min(...samples))).toBeLessThan(0.11 / 2); // by less than it went back
    expect(Math.abs(hullRock(RECOIL_MS - 1))).toBeLessThan(0.01); // no visible snap when the window shuts
    expect(hullRock(RECOIL_MS)).toBe(0);
    for (const a of BAD) expect(hullRock(a), String(a)).toBe(0);
  });
});
