// "One sun" the same way there is one wind — but this one moves.
//
// Solar geometry for a single fixed high-summer day over Normandy, reduced to
// the four quantities the art actually consumes: a shadow DIRECTION, a length
// multiplier, an alpha/softness pair, and an ambient grade.
//
// It lives sim-side, next to wind.ts and for the same reason: the sim needs the
// light level (night shortens spotting and cheapens concealment) and
// src/sim/* must never import src/render/*. The dependency arrow is
// render -> sim: src/render/light.ts re-exports SUN/shadowOffset from here, so
// ~45 call sites across nine render files are untouched and there is still
// exactly one definition of where the sun is.
//
// Normalized with Math.sqrt, not Math.hypot — same rule as wind.ts and
// mapgen.ts. Math.sqrt is required by IEEE-754 to be correctly rounded;
// Math.hypot is not specified that tightly and differs across engines. (For
// (0.45, 0.55) the two agree bit-for-bit today; tests/light.test.ts pins that,
// because the shipped art baselines were baked against the Math.hypot value.)
//
// ---------------------------------------------------------------------------
// The load-bearing trick: map-north is DEFINED as today's shadow direction.
//
// Nothing in the sim says which way is north — GameMap has no compass, spawns
// are tagged west/east and those are tactical names for the start edges. So we
// choose: N = the unit vector today's shadows already fall along. At solar noon
// the sun is due south and shadows fall due north, which is therefore exactly
// today's SUN. The canonical hour reproduces the shipped art byte-for-byte, and
// the whole day/night feature becomes a deviation from a fixed point rather
// than a rewrite. tests/light.test.ts is the guard on that identity; if it goes
// red, every art baseline in the repo is invalid.
// ---------------------------------------------------------------------------

const D = Math.PI / 180;

const NX = 0.45;
const NY = 0.55;
const NL = Math.sqrt(NX * NX + NY * NY);
// Map-north in screen space. This IS the shipped SUN vector; see above.
export const MAP_N = { dx: NX / NL, dy: NY / NL };
// Map-east: north turned a quarter turn. Only used to build the azimuth frame.
const EX = -MAP_N.dy;
const EY = MAP_N.dx;

export const LAT = 49.2; // Caen
export const DECL = 21; // one fixed high-summer declination — no date, no seasons, no equation of time
export const DBST_MIN = 120; // the campaign clock is Double British Summer Time, as it was in June 1944

// 14:00 DBST = solar noon = the fixed point. Every art baseline is shot here.
export const CANON_CLOCK_MIN = 840;

const SIN_LAT = Math.sin(LAT * D);
const COS_LAT = Math.cos(LAT * D);
const SIN_DECL = Math.sin(DECL * D);
const COS_DECL = Math.cos(DECL * D);

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
// Hermite ease, clamped at both ends. smoothstep(e0, e1, e1) is exactly 1.
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Hour angle in radians: 0 at solar noon, negative before, positive after.
function hourAngle(clockMin: number): number {
  return ((((clockMin - DBST_MIN) / 60) % 24) - 12) * 15 * D;
}

/** Solar elevation in degrees. Negative below the horizon. */
export function elevationAt(clockMin: number): number {
  const H = hourAngle(clockMin);
  return Math.asin(clamp(SIN_LAT * SIN_DECL + COS_LAT * COS_DECL * Math.cos(H), -1, 1)) / D;
}

/** Solar azimuth in degrees, measured from map-north, clockwise. 180 = due south = solar noon. */
export function azimuthAt(clockMin: number): number {
  const H = hourAngle(clockMin);
  const el = elevationAt(clockMin) * D;
  const c = clamp((SIN_DECL - Math.sin(el) * SIN_LAT) / (Math.cos(el) * COS_LAT), -1, 1);
  const a = Math.acos(c) / D;
  return Math.sin(H) > 0 ? 360 - a : a;
}

// --- Quantization -----------------------------------------------------------
//
// Quantize on the SOLAR quantities, not on the clock: the azimuth rate varies
// 3x over the day (28 deg/h near noon, 11 deg/h at dawn), so a fixed-minutes
// bucket would be too coarse at noon and wastefully fine at dawn.
//
// Everything a SunState exposes is derived from the bucket CENTRE, never from
// the raw hour. That is what makes the bake key sound: two clock times in the
// same bucket produce bit-identical art.
//
// Azimuth buckets ROUND rather than floor, so the centres land on multiples of
// 18 degrees and 180 is itself a centre. This is not cosmetic: flooring would
// put solar noon in the bucket [180, 198) whose centre is 189, rotating every
// shadow in the game 9 degrees off the shipped art and voiding every baseline.
const AZ_STEP = 18; // 20 buckets; ~38 min of clock at noon, ~100 min at dawn/dusk
const AZ_BUCKETS = 20;
// Elevation buckets are 5 degrees off a -90 origin, so no clamp is needed
// across the real arc (-19.8 .. +61.8 => buckets 14..30) and solar midnight
// still reaches a centre below -12, where the ambient ramp bottoms out.
const EL_STEP = 5;
const EL_ORIGIN = -90;
const EL_BUCKETS = 32; // also the stride that folds both buckets into one int

const azBucketOf = (az: number): number => ((Math.round(az / AZ_STEP) % AZ_BUCKETS) + AZ_BUCKETS) % AZ_BUCKETS;
const azCentreOf = (b: number): number => b * AZ_STEP;
const elBucketOf = (el: number): number => clamp(Math.floor((el - EL_ORIGIN) / EL_STEP), 0, EL_BUCKETS - 1);
const elCentreOf = (b: number): number => EL_ORIGIN + (b + 0.5) * EL_STEP;

/** The bake-key component: one integer folding the azimuth and elevation buckets. */
export function sunStepAt(clockMin: number): number {
  return azBucketOf(azimuthAt(clockMin)) * EL_BUCKETS + elBucketOf(elevationAt(clockMin));
}

// --- The three art quantities ----------------------------------------------

/**
 * Elevation of the canonical bucket's CENTRE, not of 14:00 itself. lenMul
 * divides by cot() of this, so a state built at the canonical step divides a
 * number by itself and lands on exactly 1.
 */
export const EL_CANON = elCentreOf(elBucketOf(elevationAt(CANON_CLOCK_MIN)));

const cot = (elDeg: number): number => 1 / Math.tan(elDeg * D);
const COT_CANON = cot(EL_CANON);
// Geometric cast is height * cot(el), but the house convention is heavily
// foreshortened on purpose (roofs.ts casts 0.71 m per 3 m storey). Length is
// therefore RELATIVE to the canonical hour, and clamped: ungated, 07:00 would
// ask for 16x and a three-storey house would throw a 35 m finger across two
// chunks. Past the clamp the alpha ramp carries the story, which is both the
// honest read and the thing that bounds the roof shadow's bounding box.
const LEN_MAX = 3.0;

function alphaMulOf(el: number): number {
  return smoothstep(-6, 25, el);
}

function lenMulOf(el: number): number {
  // Below civil twilight there is no cast pass at all, so the length must be 0
  // too — a nonzero lenMul at night would inflate every baked shadow bbox for
  // a shadow nobody draws.
  if (alphaMulOf(el) <= 0) return 0;
  // On or just below the horizon cot() is infinite or negative; hold the clamp
  // so the shadow fades out at full rake instead of snapping to zero length.
  if (el <= 0) return LEN_MAX;
  return clamp(cot(el) / COT_CANON, 0, LEN_MAX);
}

const GOLD: readonly [number, number, number] = [255, 196, 132];
const DUSK: readonly [number, number, number] = [38, 52, 92];
const NIGHT: readonly [number, number, number] = [26, 36, 68];

/**
 * World grade for an elevation: [r, g, b, a], to be composited SOURCE-OVER.
 * Never multiply — multiply crushes blacks to black, source-over is a lerp
 * toward the tint, so at the night floor a black pixel rises to (10, 14, 26)
 * and a white one falls to (113, 120, 143). Dark blue and low-contrast, never
 * black, from the cheapest composite mode there is. a === 0 above +25 degrees,
 * so the nine-hour core of the day draws no grade at all.
 */
export function ambientAt(el: number): readonly [number, number, number, number] {
  if (el >= 25) return [GOLD[0], GOLD[1], GOLD[2], 0];
  if (el >= 0) {
    const t = 1 - el / 25;
    return [GOLD[0], GOLD[1], GOLD[2], 0.1 * t];
  }
  if (el >= -6) {
    const t = -el / 6;
    return [lerp(GOLD[0], DUSK[0], t), lerp(GOLD[1], DUSK[1], t), lerp(GOLD[2], DUSK[2], t), lerp(0.1, 0.42, t)];
  }
  const t = clamp((-el - 6) / 6, 0, 1);
  return [lerp(DUSK[0], NIGHT[0], t), lerp(DUSK[1], NIGHT[1], t), lerp(DUSK[2], NIGHT[2], t), lerp(0.42, 0.62, t)];
}

export interface SunState {
  /** Quantization bucket — the ONLY thing that enters a bake key. */
  step: number;
  /** Unit vector: the direction a shadow travels. */
  dir: readonly [number, number];
  /** Multiplier on every shadowOffset()/SHADOW_OFF distance. 1 at the canonical hour. */
  lenMul: number;
  /** Multiplier on SHADOW_ALPHA / SHADOW_SOFT_ALPHA (never on AO_ALPHA). 1 at the canonical hour. */
  alphaMul: number;
  /** Multiplier on bakeShadow's blur radii — a low sun is diffuse. 1 at the canonical hour. */
  softMul: number;
  /** Source-over world grade [r, g, b, a]. a === 0 through the core of the day. */
  ambient: readonly [number, number, number, number];
  /** Bucket-centre solar elevation in degrees. Handy for callers that ramp on light. */
  el: number;
  /** Bucket-centre solar azimuth in degrees from map-north. */
  az: number;
}

/**
 * The sun at a wall-clock minute, quantized. Everything below is derived from
 * bucket centres, so `sunAt(t).step === sunAt(u).step` implies the two states
 * are field-for-field identical.
 */
export function sunAt(clockMin: number): SunState {
  const azb = azBucketOf(azimuthAt(clockMin));
  const elb = elBucketOf(elevationAt(clockMin));
  const az = azCentreOf(azb);
  const el = elCentreOf(elb);

  // Toward-sun horizontal is N*cos(az) + E*sin(az); a shadow travels the other
  // way, so dir = -(that) = N*cos(az - 180) + E*sin(az - 180). Written as the
  // deviation from due south on purpose: at solar noon the deviation is exactly
  // 0, cos(0) is exactly 1 and sin(0) is exactly 0, so dir is bit-for-bit
  // MAP_N. Feeding acos's output through cos/sin instead would land a ULP away.
  const d = (az - 180) * D;
  const c = Math.cos(d);
  const s = Math.sin(d);
  const alphaMul = alphaMulOf(el);
  return {
    step: azb * EL_BUCKETS + elb,
    dir: [MAP_N.dx * c + EX * s, MAP_N.dy * c + EY * s],
    lenMul: lenMulOf(el),
    alphaMul,
    softMul: 1 + 2 * (1 - alphaMul),
    ambient: ambientAt(el),
    el,
    az,
  };
}
