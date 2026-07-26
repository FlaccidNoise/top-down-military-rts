// Boot framing, extracted from main.ts so it can be tested without a DOM.
// main.ts owns the measurement (`viewportInset()`); this owns the arithmetic.

// Boot framing: fit the whole map when the *unobstructed* viewport allows
// ≥WHOLE_MAP_PX_M; otherwise frame ~FRAME_M across around the blue spawn
// centroid. Both branches frame against the clear region rather than the raw
// canvas: fitting the raw canvas put 122 of 138 blue soldiers behind the
// roster panel at T+0:00 — the player opened a battle unable to see their own
// company.
//
// The threshold is 2.5, not the 3 px/m ui.md quotes, precisely because it is
// now measured against the clear region instead of the whole canvas — the same
// 1280x800 viewport that fits 3.33 px/m of canvas only fits 2.87 of clear
// space. Holding the old number here would flip every 320x240 map into the
// zoomed branch, and near a west-edge spawn that branch cannot win: blue sits
// at world x≈7, so no camera both clears the 266px panel and avoids showing
// off-map void. The whole-map fit has no such tension.
export const WHOLE_MAP_PX_M = 2.5;

// 120m across encodes a desktop viewing distance. On a ~374px clear region
// that is 3.1 px/m — below the 5 px/m dot-LOD threshold, i.e. the player's
// opening shot of their own company is a field of dots. 70m lands at ~5.3.
export const FRAME_M_DESKTOP = 120;
export const FRAME_M_MOBILE = 70;

export interface Inset {
  left: number;
  top: number;
  bottom: number;
}

// Chrome that eats more than `frac` of an axis is a drawer, not a border, and
// insetting the camera against it is worse than ignoring it: a full-width
// bottom sheet would collapse the clear region to nothing and open the battle
// at 2 px/m looking at empty ground.
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

export function bootCamera(
  map: { w: number; h: number },
  blue: { x: number; y: number }[],
  cw: number,
  ch: number,
  raw: Inset,
  opts: { frameM?: number; capFrac?: number; minScale?: number; maxScale?: number } = {},
): { x: number; y: number; scale: number } {
  const { frameM = FRAME_M_DESKTOP, capFrac, minScale = 2, maxScale = 48 } = opts;
  const cap = (v: number, extent: number): number => (capFrac === undefined ? v : capInset(v, extent, capFrac));
  const inset: Inset = { left: cap(raw.left, cw), top: cap(raw.top, ch), bottom: cap(raw.bottom, ch) };
  const vw = Math.max(1, cw - inset.left);
  const vh = Math.max(1, ch - inset.top - inset.bottom);
  const fit = Math.min(vw / map.w, vh / map.h);
  let scale: number;
  let cx: number;
  let cy: number;
  if (fit >= WHOLE_MAP_PX_M) {
    scale = fit;
    cx = map.w / 2;
    cy = map.h / 2;
  } else {
    cx = blue.length ? blue.reduce((a, sd) => a + sd.x, 0) / blue.length : map.w / 2;
    cy = blue.length ? blue.reduce((a, sd) => a + sd.y, 0) / blue.length : map.h / 2;
    scale = Math.min(maxScale, Math.max(minScale, vw / frameM));
  }
  return {
    x: frameAxis(cx, (cw / 2 - inset.left) / scale, cw / 2 / scale, map.w),
    y: frameAxis(cy, (ch / 2 - inset.top) / scale, (ch / 2 - inset.bottom) / scale, map.h),
    scale,
  };
}
