// Boot framing, extracted from main.ts so it can be tested without a DOM.
// main.ts owns the measurement (`viewportInset()`); this owns the arithmetic.

// A battle opens ON THE PLAYER'S MEN, at a zoom where a man reads as a man.
//
// It used to open on the whole map whenever the clear viewport could fit it at
// 2.5 px/m, which on a desktop it always can: 140 men as specks down the west
// edge, under the 5 px/m sprite threshold, with nothing to say which way the
// war was. A company deploys in a line some 220 m long, so the whole force and
// a readable man do not fit one screen together. The force wins the frame only
// when it fits at a readable zoom; otherwise the frame is the densest part of
// it, and the roster and the enemy pointer carry the rest.
//
// Everything is measured against the CLEAR region (the canvas less the opaque
// HUD), never the raw canvas: fitting the raw canvas once put 122 of 138 men
// behind the roster panel at T+0:00.

/** px/m at which a soldier sprite reads as a man, not a mark. Sprites start at 5 (dudes.ts). */
export const READ_PX_M = 10;
/** A small force is framed whole, but never closer than this. */
export const BOOT_MAX_PX_M = 16;
/** Ground kept clear around the force when it is framed whole, in meters. */
export const FORCE_MARGIN_M = 8;

export interface Inset {
  left: number;
  top: number;
  bottom: number;
}

// Chrome that eats more than `frac` of an axis is a drawer, not a border, and
// insetting the camera against it is worse than ignoring it: a full-width
// bottom sheet would collapse the clear region to nothing and open the battle
// looking at empty ground.
export function capInset(v: number, extent: number, frac = 0.35): number {
  return v > extent * frac ? 0 : v;
}

// Place `want` at the center of the clear span, then slide it back so the
// clear span shows no off-map void. `a`/`b` are the world distances from the
// camera to the near/far edge of the clear span. If the map is smaller than
// the span there is nothing to clamp against — center it instead.
export function frameAxis(want: number, a: number, b: number, worldMax: number): number {
  const centered = worldMax / 2 + (a - b) / 2;
  if (a > worldMax - b) return centered;
  return Math.max(a, Math.min(worldMax - b, want + (a - b) / 2));
}

/**
 * The point to aim a camera at so that its frame holds the most of `pts`.
 * `count(x, y)` says how many a camera aimed there really shows (the caller
 * knows the clamp at the map edge; this does not). Candidates are each point
 * and, for each, the mean of what it shows, which pulls the frame off a
 * straggler and onto the group. Ties go to the candidate nearest the centroid,
 * so an evenly spread force is framed on its middle.
 */
export function densestAim(pts: { x: number; y: number }[], count: (x: number, y: number) => { x: number; y: number }[]): { x: number; y: number; count: number } | null {
  if (pts.length === 0) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  let best: { x: number; y: number; count: number } | null = null;
  let bestD = Infinity;
  const offer = (x: number, y: number): { x: number; y: number }[] => {
    const seen = count(x, y);
    const d = Math.hypot(x - mx, y - my);
    if (!best || seen.length > best.count || (seen.length === best.count && d < bestD)) {
      best = { x, y, count: seen.length };
      bestD = d;
    }
    return seen;
  };
  for (const c of pts) {
    const seen = offer(c.x, c.y);
    if (seen.length > 0) offer(seen.reduce((a, p) => a + p.x, 0) / seen.length, seen.reduce((a, p) => a + p.y, 0) / seen.length);
  }
  return best;
}

export function bootCamera(
  map: { w: number; h: number },
  blue: { x: number; y: number }[],
  cw: number,
  ch: number,
  raw: Inset,
  opts: { capFrac?: number; minScale?: number; maxScale?: number } = {},
): { x: number; y: number; scale: number } {
  const { capFrac, minScale = 2, maxScale = 48 } = opts;
  const cap = (v: number, extent: number): number => (capFrac === undefined ? v : capInset(v, extent, capFrac));
  const inset: Inset = { left: cap(raw.left, cw), top: cap(raw.top, ch), bottom: cap(raw.bottom, ch) };
  const vw = Math.max(1, cw - inset.left);
  const vh = Math.max(1, ch - inset.top - inset.bottom);
  let scale = READ_PX_M;
  let cx = map.w / 2;
  let cy = map.h / 2;
  // The camera that puts a world point at the centre of the clear region,
  // slid back so the region shows no ground off the map.
  const aim = (x: number, y: number, s: number): { x: number; y: number } => ({
    x: frameAxis(x, (cw / 2 - inset.left) / s, cw / 2 / s, map.w),
    y: frameAxis(y, (ch / 2 - inset.top) / s, (ch / 2 - inset.bottom) / s, map.h),
  });
  if (blue.length > 0) {
    const x0 = Math.min(...blue.map((p) => p.x));
    const x1 = Math.max(...blue.map((p) => p.x));
    const y0 = Math.min(...blue.map((p) => p.y));
    const y1 = Math.max(...blue.map((p) => p.y));
    // The scale that fills the clear region with the whole force.
    const whole = Math.min(vw / (x1 - x0 + FORCE_MARGIN_M * 2), vh / (y1 - y0 + FORCE_MARGIN_M * 2));
    if (whole >= READ_PX_M) {
      scale = Math.min(whole, BOOT_MAX_PX_M);
      cx = (x0 + x1) / 2;
      cy = (y0 + y1) / 2;
    } else {
      const s = Math.min(maxScale, Math.max(minScale, READ_PX_M));
      const shown = (x: number, y: number): { x: number; y: number }[] => {
        const c = aim(x, y, s);
        return blue.filter((p) => {
          const sx = (p.x - c.x) * s + cw / 2;
          const sy = (p.y - c.y) * s + ch / 2;
          return sx >= inset.left && sx <= cw && sy >= inset.top && sy <= ch - inset.bottom;
        });
      };
      const at = densestAim(blue, shown)!;
      cx = at.x;
      cy = at.y;
    }
  }
  scale = Math.min(maxScale, Math.max(minScale, scale));
  return { ...aim(cx, cy, scale), scale };
}
