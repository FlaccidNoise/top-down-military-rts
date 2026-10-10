// How things react: the few numbers behind a man's recoil, a hit man's
// flinch, a falling man's slide, a turret coming round and a gun running back.
// Pure functions of an age in milliseconds on the fx clock, so the renderer
// only has to multiply by a direction, and so the shapes can be pinned by a
// test — none of this can be seen in a still.
//
// Every one returns 0 outside its window and for an age that is not a number:
// a draw offset is added to a position, and a NaN there is a man who is not
// drawn at all.

export const KICK_MS = 240; // a man's recoil, from the last round of his burst
export const JERK_MS = 280; // a hit man's flinch
export const FALL_MS = 250; // a falling man's slide
export const RECOIL_MS = 380; // the gun runs back and the hull rocks for this long
export const TURRET_SLEW = 0.7; // rad/s — about 40 degrees a second, a powered traverse

// Metres the firer is knocked back along his own bearing, `age` ms after the
// first round of a burst of `taps` rounds `gap` ms apart. He kicks once per
// round: the offset snaps out on each and decays before the next.
export function kickBack(age: number, taps: number, gap: number): number {
  if (!(age >= 0) || !(age < (taps - 1) * gap + KICK_MS)) return 0;
  const tap = gap > 0 ? Math.min(taps - 1, Math.floor(age / gap)) : 0;
  return 0.11 * Math.exp(-(age - tap * gap) / 55);
}

// Metres a man who is hit and lives is thrown along the round's path, `age`
// ms after it lands.
export function hitJerk(age: number): number {
  return age >= 0 && age < JERK_MS ? 0.2 * Math.exp(-age / 70) : 0;
}

// How much of his slide a man going down has done, 0 to 1: fast off the mark
// and easing to rest, where he stays.
export function fallSlide(age: number): number {
  if (!(age > 0)) return 0;
  return age >= FALL_MS ? 1 : 1 - (1 - age / FALL_MS) ** 3;
}

// An angle into (-PI, PI].
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

// One step of a turret coming round: from `cur` toward `want` (both radians
// off the hull's centreline) the short way, by at most what `dt` seconds of
// traverse allows. dt is fx-clock time, so a paused battle passes 0 and the
// turret stops where it is.
export function chase(cur: number, want: number, dt: number, slew = TURRET_SLEW): number {
  const diff = wrapAngle(want - cur);
  const step = slew * dt;
  if (!(step > 0)) return cur; // paused, or a clock that is not a number
  return wrapAngle(Math.abs(diff) <= step ? want : cur + Math.sign(diff) * step);
}

// How far back the gun has run in its cradle, 1 at the shot and decaying.
export function gunRecoil(age: number): number {
  return age >= 0 && age < RECOIL_MS ? Math.exp(-age / 80) : 0;
}

// Metres the hull is shoved back along the shot, `age` ms after it: back, a
// smaller rebound forward, and still.
export function hullRock(age: number): number {
  return age >= 0 && age < RECOIL_MS ? 0.11 * Math.exp(-age / 130) * Math.cos(age / 60) : 0;
}
