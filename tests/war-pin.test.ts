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
// Recorded 2026-10-09 at the jtbug #762 commit (mid-road turn-round and halt,
// on top of the #760 defile fix and 8a90968), warsweep-v2 seeds 1..16, recon
// omniscient, DEFAULT_PRESET, no doctrine override. Gates green: 0 hung, 4/16
// blue wins, red retook objectives on 16/16 seeds. Every seed but 7 moved:
// the planner calls orderMove, and a force thrown back from a crossing now
// walks straight back instead of finishing its road first. AI blue re-attacks
// sooner and is destroyed on seeds 4, 5, 6, 13 and 14 (was seed 15 only).
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
  { status: 'lost', day: 15, logLen: 25 },
  { status: 'won', day: 12, logLen: 24 },
  { status: 'lost', day: 15, logLen: 27 },
  { status: 'lost', day: 11, logLen: 12 },
  { status: 'lost', day: 7, logLen: 36 },
  { status: 'lost', day: 6, logLen: 13 },
  { status: 'lost', day: 15, logLen: 16 },
  { status: 'lost', day: 15, logLen: 34 },
  { status: 'lost', day: 15, logLen: 15 },
  { status: 'won', day: 13, logLen: 26 },
  { status: 'lost', day: 15, logLen: 67 },
  { status: 'lost', day: 15, logLen: 58 },
  { status: 'lost', day: 2, logLen: 20 },
  { status: 'lost', day: 2, logLen: 27 },
  { status: 'won', day: 12, logLen: 27 },
  { status: 'won', day: 12, logLen: 28 },
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
