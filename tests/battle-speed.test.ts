import { describe, expect, it } from 'vitest';
import { DT } from '../src/sim/sim';
import { BATTLE_SPEEDS, frameSteps, nextSpeed, stepCap, type BattleSpeed } from '../src/ui/battle-speed';

const STEP_MS = DT * 1000;

/** Feed a run of frame times and return the steps each frame ran. */
function run(frames: number[], speed: BattleSpeed, mobile: boolean): number[] {
  let acc = 0;
  return frames.map((dt) => {
    const f = frameSteps(acc, dt, speed, mobile, STEP_MS);
    acc = f.acc;
    return f.steps;
  });
}
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
const SIXTY = Array.from({ length: 600 }, () => 1000 / 60); // ten seconds at 60 Hz

describe('battle speed', () => {
  it('cycles 1× → 2× → 4× → 1×', () => {
    expect(BATTLE_SPEEDS).toEqual([1, 2, 4]);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(4);
    expect(nextSpeed(4)).toBe(1);
  });

  it('runs the sim at the speed asked for on a machine that keeps up', () => {
    for (const s of BATTLE_SPEEDS) {
      for (const mobile of [false, true]) {
        const steps = sum(run(SIXTY, s, mobile));
        expect(Math.abs(steps - 300 * s), `${s}× mobile=${mobile}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('leaves 1× exactly as it was: 3 steps a frame on a phone, uncapped on desktop', () => {
    expect(stepCap(1, true)).toBe(3);
    expect(stepCap(1, false)).toBe(Infinity);
    // A 250 ms hitch: desktop steps all of it, a phone steps three and drops the debt.
    expect(run([250], 1, false)).toEqual([7]);
    expect(run([250, 1000 / 60], 1, true)).toEqual([3, 0]);
  });

  it('caps a fast frame on both platforms and never banks the excess', () => {
    for (const s of [2, 4] as const) {
      for (const mobile of [false, true]) {
        const [hitch, next] = run([250, 1000 / 60], s, mobile);
        expect(hitch, `${s}× mobile=${mobile}`).toBe(stepCap(s, mobile));
        // The frame after a hitch runs an ordinary frame's worth, not the backlog.
        expect(next, `${s}× mobile=${mobile}`).toBeLessThanOrEqual(s);
      }
    }
  });

  it('always leaves room for the steps a 60 Hz frame needs', () => {
    for (const s of BATTLE_SPEEDS) for (const mobile of [false, true]) expect(stepCap(s, mobile)).toBeGreaterThanOrEqual(s);
  });
});
