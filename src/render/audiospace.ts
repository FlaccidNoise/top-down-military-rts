// The arithmetic of where a sound is, for audio.ts: how dull and how late a
// far event arrives, how much of it goes to the reverb, and how loud the
// battle's own bed (rumble, engines) should sit. No WebAudio in here, so every
// number that ends up in an AudioParam can be pinned by a test.
//
// Every function is written so a NaN input falls to the SAFE value (an open
// filter, no delay, silence), the rule audio.ts place() set: a non-finite
// value reaching AudioParam.value throws inside the frame loop.

// The listener is the camera: above the middle of the view, as high as the
// view is tall. `dm` is metres along the ground from the view centre to the
// event; `alt` is metres from the view centre to its top edge (h / 2 / scale).
// Zooming out lifts the listener, so the whole battle dulls a little; an event
// off to one side at close zoom dulls for the same reason and by the same sum.
export function listenDist(dm: number, alt: number): number {
  const d = Math.hypot(dm, alt);
  return d >= 0 ? d : 0; // NaN fails the test
}

export const AIR_OPEN_HZ = 18000; // nothing taken off
export const AIR_FLOOR_HZ = 700; // the thump that is all that carries
const AIR_M = 110; // metres per e-fold of cutoff

// Air eats the top of a sound first. The low-pass corner for an event `d`
// metres from the listener: open up close, the crack gone by a couple of
// hundred metres, a far battle only its thump.
export function airCutoff(d: number): number {
  const hz = AIR_OPEN_HZ * Math.exp(-d / AIR_M);
  if (hz < AIR_FLOOR_HZ) return AIR_FLOOR_HZ;
  return hz <= AIR_OPEN_HZ ? hz : AIR_OPEN_HZ; // NaN, or a negative distance: open
}

const SOUND_M_S = 343;
export const DELAY_NEAR_M = 40; // inside this a flash and its bang stay together
export const DELAY_MAX_S = 0.35;

// Sound is slower than the picture. Seconds a report trails its flash, for an
// event `dm` metres along the ground from where the player is looking. Short
// on purpose and zero up close: the delay is there to place a far gun, never
// to make the fight under the cursor feel late.
export function arrivalDelay(dm: number): number {
  const s = (dm - DELAY_NEAR_M) / SOUND_M_S;
  return s > 0 ? Math.min(DELAY_MAX_S, s) : 0; // NaN: none
}

// Which reverb send an event feeds: the far one past this many metres. A
// distant shot is mostly the valley answering.
export const WET_FAR_M = 90;

// How much is going on, as one number: every shot and blast adds to it and it
// drains on a few seconds' constant. It drives the far rumble.
export const ACTIVITY_PER_SHOT = 0.035;
export const ACTIVITY_PER_BOOM = 0.3;
const ACTIVITY_TAU_S = 3.5;
export function decayActivity(a: number, dt: number): number {
  const v = a * Math.exp(-Math.max(0, dt) / ACTIVITY_TAU_S);
  return v > 0 && v < 1e6 ? v : 0; // NaN, negative, runaway: silence
}

export const RUMBLE_MAX = 0.085;
// Gain of the far rumble for that much activity: nothing for a quiet field,
// most of the way up for a platoon firefight, and it saturates — a barrage is
// not ten times a firefight, it is a firefight that does not stop.
export function rumbleGain(activity: number): number {
  const g = RUMBLE_MAX * (1 - Math.exp(-activity / 1.6));
  return g > 0 ? g : 0;
}

export const ENGINE_MAX = 0.11;
// Gain of the one shared engine voice for the live hulls in view. `sum` is
// their placement gains added up (place() in audio.ts: 1 at the view centre,
// falling off toward the edge): one tank under the cursor is most of it, and
// a column does not get louder without limit.
export function engineGain(sum: number): number {
  const g = ENGINE_MAX * (1 - Math.exp(-sum / 0.9));
  return g > 0 ? g : 0;
}
