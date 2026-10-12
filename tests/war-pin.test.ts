// THE war pin (S59). The V2 theater graph is the war representation, so the
// bit-for-bit outcome pin lives here, over src/strategic/headless.ts — the ONE
// headless loop main.ts's strategic tick mirrors. The old V1 grid pin in
// tests/strategic-command.test.ts guarded a legacy representation and is gone;
// what remains there are V1 property tests, because ?camp=N still boots the
// grid war for the art path (src/main.ts:985).
//
// Refreeze protocol: run
//   npx vite-node scripts/warsweep2.mjs -- --seeds 16 --gate
// and paste its `PIN seed N {status, day, logLen}` lines into PINNED below,
// recording the commit here. Never hand-edit a tuple.
//
// Recorded 2026-10-11 at the commit that varied the hour red's spoiling
// attacks may start by the war's seed (jtbug #808), at enemy strength 3 with
// garrisons that give up a post, on the calibrated resolver and four red
// battlegroups, warsweep-v2 seeds 1..16, recon contacts (the DEFAULT_PRESET
// value), no doctrine override. Gates green: 0 hung, 78/128 blue wins over
// 128 seeds, 12/16 on these sixteen, 1.06 red attacks per day.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeHeadlessWorld, runHeadlessWar } from '../src/strategic/headless';

const CFG = DEFAULT_PRESET.theater;
const CAMP = DEFAULT_PRESET.campaign;

interface Tuple {
  status: 'won' | 'lost' | 'HUNG';
  day: number;
  logLen: number;
}

// Same composition as scripts/warsweep2.mjs — drift between the two makes the
// refreeze protocol a lie.
const runWar = (seed: number): Tuple => {
  const run = runHeadlessWar(makeHeadlessWorld(seed, CFG, CAMP), 60 * 24 * 45);
  return {
    status: run.status.state === 'decided' ? (run.status.winner === 'blue' ? 'won' : 'lost') : 'HUNG',
    day: run.day,
    logLen: run.logLen,
  };
};

const PINNED: Tuple[] = [
  { status: 'lost', day: 2, logLen: 6 },
  { status: 'lost', day: 15, logLen: 8 },
  { status: 'won', day: 6, logLen: 30 },
  { status: 'won', day: 8, logLen: 37 },
  { status: 'lost', day: 2, logLen: 11 },
  { status: 'won', day: 7, logLen: 38 },
  { status: 'won', day: 7, logLen: 24 },
  { status: 'won', day: 8, logLen: 40 },
  { status: 'won', day: 9, logLen: 44 },
  { status: 'won', day: 12, logLen: 44 },
  { status: 'won', day: 12, logLen: 58 },
  { status: 'won', day: 7, logLen: 37 },
  { status: 'lost', day: 2, logLen: 6 },
  { status: 'won', day: 4, logLen: 22 },
  { status: 'won', day: 2, logLen: 5 },
  { status: 'won', day: 13, logLen: 51 },
];

describe('war pin (S59)', () => {
  let outcomes: Tuple[] = [];
  beforeAll(() => {
    outcomes = PINNED.map((_, i) => runWar(i + 1));
  }, 120_000);

  it('16 theater wars reproduce their frozen tuples bit-for-bit', () => {
    // Red means a tuned constant moved. Re-run warsweep-v2, read the table,
    // then decide whether the move was intended before refreezing.
    expect(outcomes).toEqual(PINNED);
  }, 120_000);

  it('the same seed reproduces the same war', () => {
    expect(runWar(1)).toEqual(outcomes[0]);
  }, 60_000);

  it('every war terminates by the deadline, both outcomes occur, tuples vary', () => {
    for (const o of outcomes) {
      expect(o.status).not.toBe('HUNG');
      expect(o.day).toBeLessThanOrEqual(CAMP.warDays + 1);
    }
    expect(outcomes.some((o) => o.status === 'won')).toBe(true);
    expect(outcomes.some((o) => o.status === 'lost')).toBe(true);
    expect(new Set(outcomes.map((o) => `${o.status}:${o.day}:${o.logLen}`)).size).toBeGreaterThan(1);
  });
});
