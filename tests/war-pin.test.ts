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
// Recorded 2026-10-09 at the jtbug #760 commit (bridge defile fix, on top of
// 8a90968), warsweep-v2 seeds 1..16, recon omniscient, DEFAULT_PRESET, no
// doctrine override. Gates green: 0 hung, 4/16 blue wins, red retook
// objectives on 15/16 seeds. Seeds 12, 13 and 16 moved from the 2026-08-05
// freeze: those wars had forces deadlocked at a bridge for 10-12 days.
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
  { status: 'lost', day: 15, logLen: 18 },
  { status: 'won', day: 8, logLen: 19 },
  { status: 'lost', day: 15, logLen: 54 },
  { status: 'lost', day: 15, logLen: 24 },
  { status: 'won', day: 12, logLen: 21 },
  { status: 'lost', day: 15, logLen: 32 },
  { status: 'lost', day: 15, logLen: 16 },
  { status: 'lost', day: 15, logLen: 118 },
  { status: 'lost', day: 15, logLen: 37 },
  { status: 'won', day: 12, logLen: 33 },
  { status: 'lost', day: 15, logLen: 55 },
  { status: 'lost', day: 15, logLen: 55 },
  { status: 'lost', day: 15, logLen: 37 },
  { status: 'won', day: 6, logLen: 21 },
  { status: 'lost', day: 10, logLen: 23 },
  { status: 'lost', day: 15, logLen: 36 },
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
