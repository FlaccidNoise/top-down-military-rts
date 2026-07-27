import { tier } from './dudes';

// Shared primitives for the hard-surface bakes (vehicles.ts, emplacements.ts).
// Everything here is bake-only and hairline-clamped: it is drawn once into a
// sprite canvas that is scaled by the zoom band, never per frame.
//
// The rule that makes a bevel legal in a rotating sprite: the light offset
// goes along +X of BAKE space, never along the world sun vector. A baked
// directional highlight would swing with the hull and break the one-sun
// contract the cast-shadow pass upholds; a rotation-invariant edge pair reads
// as "this is a plate with thickness" without claiming a light angle.

export type Ctx = CanvasRenderingContext2D;

export const TAU = Math.PI * 2;

// One device pixel in metres. These bake contexts are scaled by band alone (no
// DUDE_SCALE oversize), so panel lines clamp against this.
export function hair(band: number): number {
  return 1 / band;
}

// How much surface treatment a band can carry. `d1` is structure (welds,
// hatches, louvres, stowage); `d2` is grime and paint (bolts, mud, chipping,
// hand-painted numbers) — at band 12 a 0.035 m bolt is a third of a pixel.
export interface Detail {
  d1: boolean;
  d2: boolean;
  d3: boolean;
}

export function detailFor(band: number, on: boolean): Detail {
  const t = on ? tier(band) : 0;
  return { d1: t >= 1, d2: t >= 2, d3: t >= 3 };
}

export function roundRectPath(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

// A seam stroked dark, then re-stroked one hairline along +X in a whisper of
// white. Flat plates become plates.
export function weld(g: Ctx, band: number, path: () => void): void {
  const hw = Math.max(0.028, hair(band));
  g.lineWidth = hw;
  g.strokeStyle = 'rgba(0,0,0,0.30)';
  g.beginPath();
  path();
  g.stroke();
  g.save();
  g.translate(hw, 0);
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.beginPath();
  path();
  g.stroke();
  g.restore();
}

// Fill an armour facet and weld its outline in one call.
export function plate(g: Ctx, band: number, tone: string, d: Detail, path: () => void): void {
  g.fillStyle = tone;
  g.beginPath();
  path();
  g.fill();
  if (d.d1) weld(g, band, path);
}

export function bolts(g: Ctx, band: number, x0: number, y0: number, x1: number, y1: number, n: number, d: Detail): void {
  if (!d.d2) return;
  const r = Math.max(hair(band), 0.035);
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0.5 : i / (n - 1);
    const x = x0 + (x1 - x0) * u;
    const y = y0 + (y1 - y0) * u;
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    if (d.d3) {
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.beginPath();
      g.arc(x - r * 0.28, y - r * 0.28, r * 0.5, 0, TAU);
      g.fill();
    }
  }
}

// Team-color rim: strong at the close bake bands (6/12), a whisper at the far
// ones (24/48) — the same "everyone doesn't look selected" attenuation the
// soldiers use. Shared by every crewed thing on the field so a gun and a tank
// declare their side the same way.
export function teamRim(g: Ctx, x: number, y: number, w: number, h: number, band: number, color: string, pad = 0.14): void {
  g.save();
  rimStyle(g, band, color);
  roundRectPath(g, x - pad, y - pad, w + pad * 2, h + pad * 2, 0.4);
  g.stroke();
  g.restore();
}

// Same rim, hugging a round mount. A rounded BOX around something whose
// silhouette is a tripod and a barrel reads as a UI widget dropped in a field;
// a ring around the mount reads as the position the weapon is dug into.
export function teamRing(g: Ctx, x: number, y: number, r: number, band: number, color: string): void {
  g.save();
  rimStyle(g, band, color);
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.stroke();
  g.restore();
}

function rimStyle(g: Ctx, band: number, color: string): void {
  const strong = band <= 12;
  g.globalAlpha = strong ? 1 : 0.35;
  g.strokeStyle = color;
  g.lineWidth = strong ? 0.16 : 0.07;
}
