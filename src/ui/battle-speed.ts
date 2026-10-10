// Battle speed: how many fixed sim steps one frame runs. Speed changes that
// count and nothing else, so a battle fought at 4× is the same battle, step
// for step, as the one fought at 1×.

export const BATTLE_SPEEDS = [1, 2, 4] as const;
export type BattleSpeed = (typeof BATTLE_SPEEDS)[number];

export function nextSpeed(s: BattleSpeed): BattleSpeed {
  return BATTLE_SPEEDS[(BATTLE_SPEEDS.indexOf(s) + 1) % BATTLE_SPEEDS.length];
}

/**
 * The most sim steps one frame may run. 1× keeps the limits it always had: a
 * phone that missed its budget runs three steps and drops the debt, and
 * desktop is uncapped (the caller caps the frame at 250 ms). Faster speeds are
 * capped on both, a little above what a 60 Hz frame needs: when the machine
 * cannot keep up the battle runs slower than asked instead of the frame.
 */
export function stepCap(speed: BattleSpeed, mobile: boolean): number {
  if (speed === 1) return mobile ? 3 : Infinity;
  return mobile ? speed + 2 : speed * 2;
}

/**
 * One frame of an unpaused battle. `acc` is real time not yet stepped, in ms.
 * Returns the steps to run now and the time carried to the next frame; time
 * past the cap is dropped, never banked.
 */
export function frameSteps(acc: number, dtRealMs: number, speed: BattleSpeed, mobile: boolean, stepMs: number): { steps: number; acc: number } {
  acc += dtRealMs * speed;
  const cap = stepCap(speed, mobile);
  let steps = 0;
  while (acc >= stepMs && steps < cap) {
    acc -= stepMs;
    steps++;
  }
  if (acc >= stepMs) acc = 0;
  return { steps, acc };
}
