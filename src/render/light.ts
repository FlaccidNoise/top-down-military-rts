// "One sun" model (architecture.md — Muted Normandy): every shadow in the
// scene falls the same direction, so the world reads as lit by a single source.
// Shared by terrain (hedges), roofs (building shadow + AO), props, yards,
// enclosures, shops, furniture and the unit shadow pass.
//
// The sun now MOVES. The geometry lives sim-side (src/sim/solar.ts) because the
// sim needs the light level and src/sim/* may not import src/render/*; this
// file is the render-side adapter, exactly as it already is for WIND. The
// exported surface below is unchanged from the fixed-sun build, so all ~45
// consumer call sites are untouched.
//
// THE INVARIANT, because a mutable module singleton is otherwise a smell:
// every consumer of SUN/shadowOffset reads it either (a) inside a bake whose
// cache key records the current sun step, or (b) inside a per-frame draw that
// re-reads it every frame. There is no third category. The singleton therefore
// cannot go stale relative to a cached artifact, because that artifact's key
// names the sun it was baked under. Adding a reader that caches across frames
// WITHOUT putting the sun step in its key breaks this file — put the step in
// the key or read it per frame.
//
// At CANON_CLOCK_MIN the state is the identity: dir is bit-for-bit the vector
// this file used to hard-code, and lenMul/alphaMul/softMul are exactly 1. An
// unwired build — nothing calling setSun — is the shipped build.
import { CANON_CLOCK_MIN, type SunState, sunAt, sunStepAt } from '../sim/solar';

let cur: SunState = sunAt(CANON_CLOCK_MIN);

/**
 * Move the sun to a wall-clock minute. Returns true when the quantization
 * STEP changed, i.e. when sun-keyed bakes are now stale — callers use that to
 * queue rebakes. Safe and near-free to call every frame.
 */
export function setSun(clockMin: number): boolean {
  if (sunStepAt(clockMin) === cur.step) return false;
  cur = sunAt(clockMin);
  return true;
}

/** The current sun state. Read `.step` for a bake key; the rest has accessors below. */
export function sun(): SunState {
  return cur;
}

/** Unit vector: the direction a shadow travels. Live getters — never snapshot it into a module constant. */
export const SUN = {
  get dx(): number {
    return cur.dir[0];
  },
  get dy(): number {
    return cur.dir[1];
  },
};

export { CANON_CLOCK_MIN } from '../sim/solar';

// Map-north — bit-for-bit the canonical shadow direction (see solar.ts §1).
// Exported for the few draws that are deliberately SUN-INDEPENDENT: interior
// furniture sits under a roof, so its contact shade keeps the house direction
// whatever the sky is doing outside.
export { MAP_N } from '../sim/solar';

// Far-LOD pin: at <= 8 px/m a hedge's 0.4 m cast is three pixels and its
// direction is not readable, so bands this coarse always bake under step 0 and
// NEVER rebake for the sun — rebaking 300 whole-map chunks to rotate a 3 px
// smudge is the one place the moving sun could genuinely hurt (design §2.3,
// §9.1). Day/night at far LOD is carried by the ambient grade alone.
export const SUN_PIN_BAND = 8;

/** The sun-step component of a bake key at `band` — pinned to 0 at far LOD. */
export function sunStepFor(band: number): number {
  return band <= SUN_PIN_BAND ? 0 : cur.step;
}

// The wind now lives sim-side (src/sim/wind.ts) because the smoke-column LOS
// test leans by it, and src/sim/* may not import src/render/*. Re-exported here
// so every render consumer keeps importing it from the light model.
export { WIND } from '../sim/wind';

export const SHADOW_ALPHA = 0.3; // core cast-shadow alpha, at full sun
export const SHADOW_SOFT_ALPHA = 0.14; // outer feathered layer, stacked under the core
export const AO_ALPHA = 0.32; // contact/base ambient occlusion, not sun-directional — never scaled by the sun

// Cast-shadow alphas at the current sun: 1x through the nine-hour core of the
// day, ramping to 0 through civil twilight. SHADOW_ALPHA / SHADOW_SOFT_ALPHA
// stay exported as the base constants because ~12 sites interpolate them into
// template strings; the CAST passes are the ones that switch to these.
export function shadowAlpha(): number {
  return SHADOW_ALPHA * cur.alphaMul;
}
export function shadowSoftAlpha(): number {
  return SHADOW_SOFT_ALPHA * cur.alphaMul;
}

/** Blur-radius multiplier for a soft shadow — a low sun is diffuse. 1 at full sun, up to 3. */
export function shadowSoft(): number {
  return cur.softMul;
}

// World-space [dx, dy] offset for a shadow cast by something `len` meters tall/long.
export function shadowOffset(len: number): [number, number] {
  const l = len * cur.lenMul;
  return [cur.dir[0] * l, cur.dir[1] * l];
}

// Legibility clamp for the big baked casters (buildings, enclosure masonry,
// graves, canopies) at a low sun. solar.ts already clamps lenMul at 3 for
// everything; these casters clamp tighter because a game map is not a
// photograph — at 3x a two-storey house drags a smear across half a street
// and the alpha ramp carries the "low sun" story anyway. Per-caster on
// purpose: unit/vehicle/pole shadows keep the full rake deliberately.
export const SHADOW_LEN_LEGIBLE = 2.4;

/** shadowOffset with lenMul clamped to SHADOW_LEN_LEGIBLE — for the big baked casters. */
export function shadowOffsetLegible(len: number): [number, number] {
  const l = len * Math.min(cur.lenMul, SHADOW_LEN_LEGIBLE);
  return [cur.dir[0] * l, cur.dir[1] * l];
}

// The plan-projection rule for cast shadows: a shadow STARTS at the caster's
// base and travels the sun direction in ONE CONNECTED piece — the hull of the
// footprint and its down-sun copy, the way the pole shadows sweep. A
// silhouette merely TRANSLATED by shadowOffset overlaps its caster at noon
// and passes, then detaches into a floating gray copy at dawn/dusk when
// lenMul stretches the offset past the footprint.
//
// Appends (no beginPath/fill) the swept hull of an axis-aligned rect along
// (dx, dy): a 6-point polygon under a diagonal offset. Callers batch several
// casters into one path and fill once — under nonzero winding the union fills
// uniformly, so overlapping masses never double-darken.
export function sweptRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dx: number, dy: number): void {
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  g.moveTo(cx - hw * sx, cy - hh * sy);
  g.lineTo(cx + hw * sx, cy - hh * sy);
  g.lineTo(cx + hw * sx + dx, cy - hh * sy + dy);
  g.lineTo(cx + hw * sx + dx, cy + hh * sy + dy);
  g.lineTo(cx - hw * sx + dx, cy + hh * sy + dy);
  g.lineTo(cx - hw * sx, cy + hh * sy);
  g.closePath();
}

/**
 * Appends the swept hull of a THICK LINE SEGMENT (butt caps) along (dx, dy) —
 * the wall-run / lying-log counterpart of sweptRectPath, for casters that are
 * not axis-aligned rects. Convex hull of the segment's four corners and their
 * down-sun copies.
 */
export function sweptStrokePath(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number, dx: number, dy: number): void {
  const len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  const px = len > 0 ? (-(y1 - y0) / len) * (width / 2) : width / 2;
  const py = len > 0 ? ((x1 - x0) / len) * (width / 2) : 0;
  const pts: [number, number][] = [
    [x0 + px, y0 + py],
    [x0 - px, y0 - py],
    [x1 + px, y1 + py],
    [x1 - px, y1 - py],
    [x0 + px + dx, y0 + py + dy],
    [x0 - px + dx, y0 - py + dy],
    [x1 + px + dx, y1 + py + dy],
    [x1 - px + dx, y1 - py + dy],
  ];
  // monotone chain over 8 points; collinear points drop out
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  const hi: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
  g.moveTo(hull[0][0], hull[0][1]);
  for (let i = 1; i < hull.length; i++) g.lineTo(hull[i][0], hull[i][1]);
  g.closePath();
}

/**
 * Appends a capsule from (x0, y0) to (x1, y1) of radius r — the sweep of a
 * round caster (a canopy lobe) from its base along the sun. Degenerates to a
 * circle at zero length. Same use pattern as the other two: batch subpaths,
 * fill once.
 */
export function capsulePath(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, r: number): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  g.moveTo(x0 + Math.cos(a + Math.PI / 2) * r, y0 + Math.sin(a + Math.PI / 2) * r);
  g.arc(x0, y0, r, a + Math.PI / 2, a - Math.PI / 2);
  g.arc(x1, y1, r, a - Math.PI / 2, a + Math.PI / 2);
  g.closePath();
}
