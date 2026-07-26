import type { Building } from '../sim/mapgen';
import type { Sim } from '../sim/sim';
import type { Camera } from './camera';
import { AO_ALPHA, SHADOW_ALPHA, SHADOW_SOFT_ALPHA, shadowOffset } from './light';

// Gable roofs drawn over building footprints (sim.buildings, from the map
// plan). A roof fades out when the camera is zoomed in close or a soldier the
// player can see is inside, revealing the interior (interiors are ordinary
// walkable sim space).
//
// Everything expensive — shingle courses, ridge caps, weathering — is baked
// once per (building, zoom band) into a sprite; the frame loop is a view cull
// plus one drawImage and one silhouette stroke per visible building.

const OVERHANG = 0.35; // meters past the walls
const PAD_NW = 0.35; // sprite margin past the overhang (dormer / lean-to spill)
const PAD_SE = 0.35;
// Zoom-alone reveal is the CLOSE-INSPECTION band, not the tactical one: 24-32
// px/m is normal play, so a 14 px/m trigger ghosted every roof exactly where
// the player spends their time. Occupancy is the primary reveal; the 2 px/m
// hysteresis band keeps scroll-wheel zoom from flickering a whole village.
const FADE_SCALE = 26; // px/m at which zoom alone reveals interiors
const FADE_SCALE_RESTORE = 24;
const FADED_ALPHA = 0.18; // revealed roofs keep a readable ghost of the mass

// Bake resolutions (px/m). No 48 band: above FADE_SCALE every roof is at
// FADED_ALPHA, so a 32 px/m sprite upscaled there is invisible loss.
const ROOF_BANDS = [8, 16, 32];
const BAKES_PER_FRAME = 2; // amortized so a band change never stalls a frame
const TAU = Math.PI * 2;
const TONE_STEPS = 9; // per-tile value ramp, precomputed so the bake builds no strings

function roofBandFor(scale: number): number {
  return ROOF_BANDS.find((b) => b >= scale) ?? 32;
}

type RoofMat = 'tile' | 'slate' | 'thatch' | 'iron';

// hueAmp is the ±warmth jitter each base tolerates: terracotta can swing warm,
// but slate swung the same distance turns frankly blue, which is a hue
// statement the palette does not make.
const MAT_BASES: Record<RoofMat, string[]> = {
  tile: ['#6f4a3c', '#6b5342'], // tuile, weathered tuile
  slate: ['#4f545b', '#474e56'], // ardoise, cool ardoise
  thatch: ['#7e7053', '#6f664c'],
  iron: ['#5d5f58', '#54574f'],
};
// amp is the jitter width, bias the centre: slate and iron are only ever
// allowed to drift cool, or a warm draw turns an ardoise roof into concrete.
const MAT_HUE: Record<RoofMat, { amp: number; bias: number }> = {
  tile: { amp: 11, bias: 0 },
  slate: { amp: 5, bias: -4 },
  thatch: { amp: 7, bias: 2 },
  iron: { amp: 5, bias: -3 },
};
const MAX_SAT = 0.46; // HSV ceiling on the weathered base → lit slope stays ≤52%
// Lit/shade value multipliers per material. The ratio stays near 1.6 — value
// separation is how the two slopes read — but the pair is centred where the
// material actually sits: ardoise is a dark, low-contrast surface, corrugated
// iron a bright specular one, and pinning them all to tile's numbers made
// every slate roof the palest thing on screen.
const MAT_SLOPE: Record<RoofMat, [number, number]> = {
  tile: [1.14, 0.72],
  slate: [1.06, 0.74],
  thatch: [1.1, 0.76],
  iron: [1.1, 0.72],
};
// [lit, shade] warmth. Shaded straw is warm brown, not olive, so thatch does
// not take the cool shade shift the mineral roofs do.
const MAT_WARM: Record<RoofMat, [number, number]> = {
  tile: [5, -7],
  slate: [4, -3],
  thatch: [6, -1],
  iron: [4, -4],
};

// Course geometry for the two shingled materials. Jitter above ±8% fizzes into
// noise when a band-32 bake is downscaled to the 24 px/m tactical view.
const MAT_SPEC: Record<'tile' | 'slate', { course: number; tileW: number; jitter: number; patch: [number, number] }> = {
  tile: { course: 0.34, tileW: 0.3, jitter: 0.07, patch: [0.86, 6] },
  slate: { course: 0.24, tileW: 0.22, jitter: 0.04, patch: [0.88, -5] },
};

const BIG_ROOF_AREA = 45; // w*h threshold for weathering patch runs

// Keyed on (building index, salt) — same arithmetic as the old local copy.
import { hash } from './noise';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Scales value (brightness) and shifts warmth (+red/-blue; negative warmth
// cools toward blue) — used for lit/shade roof slopes and weathering jitter.
function tint(rgb: [number, number, number], value: number, warmth: number): [number, number, number] {
  const [r, g, b] = rgb;
  return [clamp255(r * value + warmth), clamp255(g * value), clamp255(b * value - warmth)];
}

function rgbStr([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

// Pull a color toward its own value-grey until HSV saturation is at most
// maxS. Value is untouched, so the lit/shade separation the roof reads by
// survives — only the chroma the muted palette caps gets spent.
function mute(rgb: [number, number, number], maxS: number): [number, number, number] {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  const mn = Math.min(rgb[0], rgb[1], rgb[2]);
  if (mx <= 0 || mx - mn <= mx * maxS) return rgb;
  const t = (mx * (1 - maxS) - mn) / (mx - mn);
  return [clamp255(rgb[0] + (mx - rgb[0]) * t), clamp255(rgb[1] + (mx - rgb[1]) * t), clamp255(rgb[2] + (mx - rgb[2]) * t)];
}

// TONE_STEPS strings spanning ±amp around one slope tone, so the per-tile
// loop indexes a table instead of building a color per fillRect.
function ramp(rgb: [number, number, number], value: number, warmth: number, amp: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < TONE_STEPS; k++) {
    const f = 1 + (k / (TONE_STEPS - 1) - 0.5) * 2 * amp;
    out.push(rgbStr(tint(rgb, value * f, warmth)));
  }
  return out;
}

interface RoofArt {
  mat: RoofMat;
  ridgeAlongX: boolean;
  lit: string;
  shade: string;
  litDeep: string; // batten gap under the tiles, so vertical seams read
  shadeDeep: string;
  gable: string;
  litTones: string[];
  shadeTones: string[];
  litPatch: string;
  shadePatch: string;
  ridgeBody: string;
  courseAlpha: number;
  ox: number; // sprite origin / span, world meters
  oy: number;
  ow: number;
  oh: number;
  chimney: { x: number; y: number; s: number };
  chimneyShadow: { x: number; y: number };
}

function roofRect(b: Building): { x: number; y: number; w: number; h: number } {
  return { x: b.x - OVERHANG, y: b.y - OVERHANG, w: b.w + OVERHANG * 2, h: b.h + OVERHANG * 2 };
}

// Material from footprint + neighbours, not from the index: two-story town
// houses are never thatched, and the smaller half of a close pair (mapgen's
// farm house+barn) is usually the outbuilding, so it gets thatch or iron.
function pickMat(i: number, stories: number, smallOfPair: boolean): RoofMat {
  const r = hash(i, 201);
  if (stories >= 2) return r < 0.62 ? 'tile' : 'slate';
  if (smallOfPair) {
    if (r < 0.42) return 'thatch';
    if (r < 0.7) return 'iron';
    return r < 0.86 ? 'tile' : 'slate';
  }
  if (r < 0.48) return 'tile';
  if (r < 0.78) return 'slate';
  if (r < 0.92) return 'thatch';
  return 'iron';
}

// Per-building roof look, computed once when the buildings list changes (not
// per frame): material, weathering jitter, lit/shade slope tints and ramps,
// and the hash-placed chimney, so identical materials don't look cloned.
function buildArt(b: Building, i: number, stories: number, smallOfPair: boolean): RoofArt {
  const ridgeAlongX = b.w >= b.h;
  const { x, y, w, h } = roofRect(b);

  const mat = pickMat(i, stories, smallOfPair);
  const bases = MAT_BASES[mat];
  const valueJitter = 1 + (hash(i, 60) - 0.5) * 0.18; // ±9%
  const hue = MAT_HUE[mat];
  const hueJitter = hue.bias + (hash(i, 61) - 0.5) * 2 * hue.amp;
  const weathered = mute(tint(hexToRgb(bases[i % bases.length]), valueJitter, hueJitter), MAX_SAT);
  // lit/shade value ratio stays ~1.6 — value separation is the legibility
  // mechanism; only the hue is pulled back toward the muted ceiling.
  const [litV, shadeV] = MAT_SLOPE[mat];
  const [litW, shadeW] = MAT_WARM[mat];
  const amp = mat === 'tile' ? MAT_SPEC.tile.jitter : mat === 'slate' ? MAT_SPEC.slate.jitter : mat === 'thatch' ? 0.11 : 0.05;
  const patchV = mat === 'slate' ? MAT_SPEC.slate.patch : MAT_SPEC.tile.patch;

  const t = 0.22 + hash(i, 62) * 0.56;
  const po = (hash(i, 63) - 0.5) * 0.25;
  const s = 0.32 + hash(i, 64) * 0.14;
  const cx = ridgeAlongX ? x + t * w : x + w / 2 + po;
  const cy = ridgeAlongX ? y + h / 2 + po : y + t * h;
  const [sdx, sdy] = shadowOffset(0.18);
  const chimney = { x: cx - s / 2, y: cy - s / 2, s };

  return {
    mat,
    ridgeAlongX,
    lit: rgbStr(tint(weathered, litV, litW)),
    shade: rgbStr(tint(weathered, shadeV, shadeW)),
    litDeep: rgbStr(tint(weathered, litV * 0.78, litW * 0.6)),
    shadeDeep: rgbStr(tint(weathered, shadeV * 0.78, shadeW * 0.7)),
    gable: rgbStr(tint(weathered, 0.55, -9)),
    litTones: ramp(weathered, litV, litW, amp),
    shadeTones: ramp(weathered, shadeV, shadeW, amp),
    litPatch: rgbStr(tint(weathered, litV * patchV[0], patchV[1])),
    shadePatch: rgbStr(tint(weathered, shadeV * patchV[0], patchV[1])),
    ridgeBody: rgbStr(tint(weathered, mat === 'thatch' ? 1.05 : 0.95, 3)),
    courseAlpha: 0.1 + (hash(i, 200) - 0.5) * 0.06,
    ox: x - PAD_NW,
    oy: y - PAD_NW,
    ow: w + PAD_NW + PAD_SE,
    oh: h + PAD_NW + PAD_SE,
    chimney,
    chimneyShadow: { x: chimney.x + sdx, y: chimney.y + sdy },
  };
}

// --- bake -------------------------------------------------------------------
// Every slope is drawn in a local frame where u runs along the ridge and v
// runs from the ridge (v=0) out to the eave (v=vLen), so one body of material
// code serves all four slope orientations.

function slopeShingle(
  g: CanvasRenderingContext2D,
  art: RoofArt,
  i: number,
  band: number,
  uLen: number,
  vLen: number,
  lit: boolean,
): void {
  const sp = MAT_SPEC[art.mat === 'slate' ? 'slate' : 'tile'];
  const tones = lit ? art.litTones : art.shadeTones;
  const patch = lit ? art.litPatch : art.shadePatch;
  const salt = lit ? 210 : 211;
  const coarse = band < 16; // per-tile geometry is sub-pixel at 8 px/m
  const step = coarse ? sp.tileW * 3 : sp.tileW;
  const gapU = coarse ? 0 : 0.03;
  g.fillStyle = lit ? art.litDeep : art.shadeDeep;
  g.fillRect(0, 0, uLen, vLen);
  const nC = Math.max(1, Math.ceil(vLen / sp.course));
  const butt = `rgba(0,0,0,${(art.courseAlpha + 0.03).toFixed(3)})`;
  for (let ci = 0; ci < nC; ci++) {
    const vBot = vLen - ci * sp.course;
    const vTop = Math.max(0, vBot - sp.course);
    const stag = (ci & 1) * step * 0.5;
    let t = 0;
    for (let u = -stag; u < uLen; u += step, t++) {
      const u0 = Math.max(0, u);
      const u1 = Math.min(uLen, u + step - gapU);
      if (u1 - u0 <= 0.001) continue;
      const patched = !coarse && (ci * 5 + t + i) % 9 === 0;
      g.fillStyle = patched ? patch : tones[Math.min(TONE_STEPS - 1, (hash(i, ci * 97 + t, salt) * TONE_STEPS) | 0)];
      g.fillRect(u0, vTop, u1 - u0, vBot - vTop);
    }
    g.fillStyle = butt;
    g.fillRect(0, vBot - 0.035, uLen, 0.035);
  }
  // Course-aligned patch runs: whole replaced sections, which is how a real
  // roof is mended — the old free-floating dark squares read as dirt.
  if (!coarse && uLen * vLen * 2 >= BIG_ROOF_AREA) {
    const runs = hash(i, 0, 218) < 0.5 ? 1 : 2;
    for (let k = 0; k < runs; k++) {
      const ci = Math.floor(hash(i, k * 4 + 1, 218) * nC);
      const u0 = hash(i, k * 4 + 2, 218) * Math.max(0, uLen - 1.2);
      const len = (3 + Math.floor(hash(i, k * 4 + 3, 218) * 4)) * sp.tileW;
      g.fillStyle = patch;
      g.fillRect(u0, Math.max(0, vLen - (ci + 1) * sp.course), Math.min(len, uLen - u0), sp.course - 0.035);
    }
  }
  // A few tiles gone at one eave corner — the cheapest read of age there is.
  if (!coarse && hash(i, 1, 219) < 0.45) {
    const atEnd = hash(i, 2, 219) < 0.5;
    const n = 2 + ((hash(i, 0, 219) * 2) | 0);
    g.fillStyle = '#211d17';
    for (let k = 0; k < n; k++) {
      const u = atEnd ? uLen - 0.15 - k * sp.tileW * 1.2 : 0.15 + k * sp.tileW * 1.2;
      const ci = (hash(i, 3 + k, 219) * 2) | 0;
      g.fillRect(u, vLen - (ci + 1) * sp.course + 0.03, sp.tileW * 0.8, sp.course - 0.06);
    }
  }
  if (art.mat === 'slate' && !coarse) {
    // wet-slate specular — a handful of flecks, never a sheen
    g.fillStyle = 'rgba(232,238,244,0.10)';
    for (let k = 0; k < 5; k++) {
      const u = hash(i, k, lit ? 212 : 213) * uLen;
      const v = hash(i, k + 8, lit ? 212 : 213) * vLen;
      g.fillRect(u, v, sp.tileW * 0.7, sp.course * 0.4);
    }
  }
}

function slopeThatch(g: CanvasRenderingContext2D, art: RoofArt, i: number, band: number, uLen: number, vLen: number, lit: boolean): void {
  const tones = lit ? art.litTones : art.shadeTones;
  const salt = lit ? 214 : 215;
  g.fillStyle = lit ? art.lit : art.shade;
  g.fillRect(0, 0, uLen, vLen);
  // laid courses read as shallow horizontal sways under the combing
  g.fillStyle = 'rgba(24,18,10,0.10)';
  for (let v = vLen - 0.55; v > 0; v -= 0.55) g.fillRect(0, v, uLen, 0.06);
  const step = band < 16 ? 0.24 : 0.12;
  for (let u = 0, k = 0; u < uLen; u += step, k++) {
    const v0 = vLen * (0.04 + hash(i, k, salt) * 0.3);
    g.fillStyle = tones[Math.min(TONE_STEPS - 1, (hash(i, k + 4096, salt) * TONE_STEPS) | 0)];
    g.fillRect(u, v0, step * 0.55, vLen - v0);
    g.fillStyle = 'rgba(26,20,12,0.16)';
    g.fillRect(u + step * 0.62, v0, step * 0.16, vLen - v0);
  }
  // trimmed, rolled eave — arcTo corners (roundRect is not everywhere yet)
  const r = 0.3;
  const v0 = vLen - 0.5;
  g.fillStyle = lit ? art.lit : art.shade;
  g.beginPath();
  g.moveTo(r, v0);
  g.lineTo(uLen - r, v0);
  g.arcTo(uLen, v0, uLen, v0 + r, r);
  g.lineTo(uLen, vLen - r);
  g.arcTo(uLen, vLen, uLen - r, vLen, r);
  g.lineTo(r, vLen);
  g.arcTo(0, vLen, 0, vLen - r, r);
  g.lineTo(0, v0 + r);
  g.arcTo(0, v0, r, v0, r);
  g.closePath();
  g.fill();
  // the roll has thickness: lit crown, dark cut underside
  g.fillStyle = 'rgba(232,222,196,0.16)';
  g.fillRect(r * 0.6, v0, uLen - r * 1.2, 0.1);
  g.fillStyle = 'rgba(28,22,14,0.30)';
  g.fillRect(r * 0.6, vLen - 0.16, uLen - r * 1.2, 0.09);
  g.fillStyle = 'rgba(20,15,9,0.45)';
  g.fillRect(0, vLen - 0.06, uLen, 0.06);
}

function slopeIron(g: CanvasRenderingContext2D, art: RoofArt, i: number, band: number, uLen: number, vLen: number, lit: boolean): void {
  const salt = lit ? 216 : 217;
  g.fillStyle = lit ? art.lit : art.shade;
  g.fillRect(0, 0, uLen, vLen);
  const rib = band < 16 ? 0.56 : 0.28;
  for (let u = 0; u < uLen; u += rib) {
    g.fillStyle = 'rgba(255,252,244,0.10)';
    g.fillRect(u, 0, 0.04, vLen);
    g.fillStyle = 'rgba(14,16,14,0.22)';
    g.fillRect(Math.min(uLen - 0.04, u + rib * 0.5), 0, 0.04, vLen);
  }
  // sheet laps run parallel to the ridge, one every ~1.8 m
  for (let v = vLen - 1.8; v > 0.1; v -= 1.8) {
    g.fillStyle = 'rgba(12,14,12,0.28)';
    g.fillRect(0, v, uLen, 0.05);
    g.fillStyle = 'rgba(255,252,244,0.08)';
    g.fillRect(0, v + 0.05, uLen, 0.04);
  }
  // rust bleeds from the ridge: narrow streaks, never a blot
  const n = 2 + ((hash(i, 0, salt) * 3) | 0);
  for (let k = 0; k < n; k++) {
    const cu = uLen * (0.1 + hash(i, k + 1, salt) * 0.8);
    const rv = vLen * (0.3 + hash(i, k + 9, salt) * 0.5);
    g.save();
    g.translate(cu, 0);
    g.scale(0.18, 1);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rv);
    gr.addColorStop(0, 'rgba(122,74,44,0.26)');
    gr.addColorStop(1, 'rgba(122,74,44,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, rv, 0, TAU);
    g.fill();
    g.restore();
  }
}

// Moss and drip stains live on the shaded SE slope, where they would be.
function slopeWeather(g: CanvasRenderingContext2D, i: number, uLen: number, vLen: number): void {
  const nm = 2 + ((hash(i, 220) * 3) | 0);
  for (let k = 0; k < nm; k++) {
    const cu = uLen * (0.08 + hash(i, 221 + k) * 0.84);
    const cv = vLen * (0.62 + hash(i, 225 + k) * 0.36);
    const r = 0.25 + hash(i, 229 + k) * 0.45;
    const gr = g.createRadialGradient(cu, cv, 0, cu, cv, r);
    gr.addColorStop(0, 'rgba(96,112,64,0.30)');
    gr.addColorStop(1, 'rgba(96,112,64,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(cu, cv, r, 0, TAU);
    g.fill();
  }
  g.fillStyle = 'rgba(30,26,20,0.14)';
  const nd = hash(i, 233) < 0.5 ? 2 : 3;
  for (let k = 0; k < nd; k++) {
    g.fillRect(uLen * (0.1 + hash(i, 234 + k) * 0.8), 0, 0.08, vLen * (0.3 + hash(i, 237 + k) * 0.3));
  }
}

function ridgeRun(g: CanvasRenderingContext2D, art: RoofArt, band: number, uLen: number): void {
  if (art.mat === 'thatch') {
    g.fillStyle = art.ridgeBody;
    g.fillRect(0.05, -0.17, uLen - 0.1, 0.34);
    g.fillStyle = 'rgba(60,48,30,0.45)';
    g.fillRect(0.05, -0.03, uLen - 0.1, 0.06);
    g.fillStyle = 'rgba(52,42,26,0.5)';
    for (let u = 0.3; u < uLen - 0.2; u += 0.5) g.fillRect(u, -0.17, 0.05, 0.34);
    return;
  }
  if (art.mat === 'iron') {
    g.fillStyle = art.ridgeBody;
    g.fillRect(0.02, -0.12, uLen - 0.04, 0.24);
    g.fillStyle = 'rgba(255,252,244,0.10)';
    g.fillRect(0.02, -0.12, uLen - 0.04, 0.05);
    g.fillStyle = 'rgba(14,16,14,0.28)';
    g.fillRect(0.02, 0.07, uLen - 0.04, 0.05);
    return;
  }
  // Half-round ridge caps with a mortar gap. The lit/shade strips are drawn
  // PER CAP, not as one continuous rect — a full-length highlight is exactly
  // the hairline this replaces.
  if (band < 16) {
    g.fillStyle = art.ridgeBody;
    g.fillRect(0.05, -0.09, uLen - 0.1, 0.18);
    g.fillStyle = 'rgba(226,214,196,0.16)';
    g.fillRect(0.05, -0.09, uLen - 0.1, 0.05);
    g.fillStyle = 'rgba(18,15,12,0.32)';
    g.fillRect(0.05, 0.04, uLen - 0.1, 0.05);
    return;
  }
  for (let u = 0.05; u < uLen - 0.1; u += 0.35) {
    const cu = Math.min(u + 0.165, uLen - 0.15);
    g.fillStyle = art.ridgeBody;
    g.beginPath();
    g.ellipse(cu, 0, 0.165, 0.09, 0, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(226,214,196,0.22)';
    g.beginPath();
    g.ellipse(cu, -0.028, 0.145, 0.05, 0, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(18,15,12,0.35)';
    g.beginPath();
    g.ellipse(cu, 0.042, 0.15, 0.045, 0, 0, TAU);
    g.fill();
  }
}

function drawRoof(g: CanvasRenderingContext2D, b: Building, art: RoofArt, i: number, band: number): void {
  const { x, y, w, h } = roofRect(b);
  const along = art.ridgeAlongX;
  const uLen = along ? w : h;
  const vLen = (along ? h : w) / 2;

  for (const lit of [true, false]) {
    g.save();
    if (along) {
      g.translate(x, y + h / 2);
      g.transform(1, 0, 0, lit ? -1 : 1, 0, 0);
    } else {
      g.translate(x + w / 2, y);
      g.transform(0, 1, lit ? -1 : 1, 0, 0, 0);
    }
    if (art.mat === 'thatch') slopeThatch(g, art, i, band, uLen, vLen, lit);
    else if (art.mat === 'iron') slopeIron(g, art, i, band, uLen, vLen, lit);
    else slopeShingle(g, art, i, band, uLen, vLen, lit);
    if (!lit && band >= 16) slopeWeather(g, i, uLen, vLen);
    g.restore();
  }

  // gable verge: the barge board along each ridge end, not the old dark
  // triangle notch cut out of the slope
  g.fillStyle = art.gable;
  const verge = 0.16;
  if (along) {
    g.fillRect(x, y, verge, h);
    g.fillRect(x + w - verge, y, verge, h);
  } else {
    g.fillRect(x, y, w, verge);
    g.fillRect(x, y + h - verge, w, verge);
  }

  g.save();
  if (along) g.translate(x, y + h / 2);
  else {
    g.translate(x + w / 2, y);
    g.transform(0, 1, 1, 0, 0, 0);
  }
  ridgeRun(g, art, band, uLen);
  g.restore();

  // chimney, above the courses, with its own short SE shadow
  const c = art.chimney;
  g.fillStyle = `rgba(10,12,8,${SHADOW_ALPHA})`;
  g.fillRect(art.chimneyShadow.x, art.chimneyShadow.y, c.s, c.s);
  g.fillStyle = '#4a4038';
  g.fillRect(c.x, c.y, c.s, c.s);
  g.strokeStyle = 'rgba(20,16,12,0.5)';
  g.lineWidth = 0.02;
  g.strokeRect(c.x, c.y, c.s, c.s);

  // eave outline in metres-per-band so it survives the downscale; thatch gets
  // a wider, weaker one because a hard black edge is exactly what straw isn't
  const soft = art.mat === 'thatch';
  g.strokeStyle = soft ? 'rgba(28,22,14,0.34)' : 'rgba(20,16,12,0.6)';
  g.lineWidth = Math.max(0.06, 1.3 / band) * (soft ? 1.8 : 1);
  g.strokeRect(x, y, w, h);
}

function bakeRoof(b: Building, art: RoofArt, i: number, band: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(art.ow * band));
  c.height = Math.max(1, Math.round(art.oh * band));
  const g = c.getContext('2d')!;
  g.scale(band, band);
  g.translate(-art.ox, -art.oy);
  drawRoof(g, b, art, i, band);
  return c;
}

export class RoofLayer {
  private buildings: Building[] = [];
  private alphas: number[] = [];
  private art: RoofArt[] = [];
  private stories: number[] = []; // per-building story count for shadow length, min 1
  private zoomFaded = false;
  private sprites = new Map<number, (HTMLCanvasElement | null)[]>();
  private band = 0;
  private prevBand = 0;
  private queue: number[] = [];
  private prewarm = true;

  update(sim: Sim, cam: Camera, dt: number): void {
    if (this.buildings !== sim.buildings) {
      this.buildings = sim.buildings;
      this.alphas = this.buildings.map(() => 1);
      // stories from the map's per-tile story counts (max over footprint).
      // Flat maps have stories all 0 → 1 → shadow length identical to before.
      this.stories = this.buildings.map((b) => {
        let m = 0;
        for (let y = b.y; y < b.y + b.h; y++) {
          for (let x = b.x; x < b.x + b.w; x++) m = Math.max(m, sim.map.storiesAt(x, y));
        }
        return Math.max(1, m);
      });
      this.art = this.buildings.map((b, i) => buildArt(b, i, this.stories[i], this.smallOfPair(i)));
      this.sprites.clear();
      this.band = 0;
      this.prevBand = 0;
      this.queue = [];
      this.prewarm = true;
    }
    if (cam.scale > FADE_SCALE) this.zoomFaded = true;
    else if (cam.scale < FADE_SCALE_RESTORE) this.zoomFaded = false;
    this.buildings.forEach((b, i) => {
      // Occupancy reveal on every floor, gated on the sim's own visibility
      // helper — the same rule upper floors already used, extended down to the
      // ground floor. The renderer still never re-derives vision, so a house
      // only opens for a soldier the player can already see.
      const inside = sim.soldiers.some(
        (s) =>
          s.alive &&
          s.x >= b.x && s.x < b.x + b.w &&
          s.y >= b.y && s.y < b.y + b.h &&
          sim.soldierVisibleTo('blue', s),
      );
      const target = this.zoomFaded || inside ? FADED_ALPHA : 1;
      const a = this.alphas[i];
      this.alphas[i] = a + (target - a) * Math.min(1, dt * 6);
    });
  }

  // True when building i is the smaller half of a pair standing within 4 m —
  // mapgen's farm house+barn, where the small one is the outbuilding.
  private smallOfPair(i: number): boolean {
    const b = this.buildings[i];
    const area = b.w * b.h;
    for (let j = 0; j < this.buildings.length; j++) {
      if (j === i) continue;
      const o = this.buildings[j];
      const gx = Math.max(0, Math.max(b.x - (o.x + o.w), o.x - (b.x + b.w)));
      const gy = Math.max(0, Math.max(b.y - (o.y + o.h), o.y - (b.y + b.h)));
      if (Math.hypot(gx, gy) <= 4 && o.w * o.h > area) return true;
    }
    return false;
  }

  // True when the building interior at (x, y) is revealed (its roof is fading
  // or gone) — lets terrain draw stair glyphs only into visible interiors.
  interiorVisibleAt(x: number, y: number): boolean {
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return this.alphas[i] < 0.5;
    }
    return false;
  }

  private withWorldTransform(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number, f: () => void): void {
    ctx.save();
    const [ox, oy] = cam.worldToScreen(0, 0, cw, ch);
    ctx.translate(ox, oy);
    ctx.scale(cam.scale, cam.scale);
    f();
    ctx.restore();
  }

  // Screen-rect reject. The pad covers camera shake, which is applied outside
  // this transform and never exceeds a few px.
  private onScreen(cam: Camera, i: number, cw: number, ch: number, grow = 0): boolean {
    const a = this.art[i];
    const [sx, sy] = cam.worldToScreen(a.ox - grow, a.oy - grow, cw, ch);
    const sw = (a.ow + grow * 2) * cam.scale;
    const sh = (a.oh + grow * 2) * cam.scale;
    return sx + sw >= -24 && sy + sh >= -24 && sx <= cw + 24 && sy <= ch + 24;
  }

  private setBand(band: number): void {
    if (band === this.band) return;
    if (this.band) this.prevBand = this.band;
    this.band = band;
    if (!this.sprites.has(band)) this.sprites.set(band, this.buildings.map(() => null));
    for (const k of [...this.sprites.keys()]) if (k !== this.band && k !== this.prevBand) this.sprites.delete(k);
    const cur = this.sprites.get(band)!;
    this.queue = [];
    for (let i = 0; i < this.buildings.length; i++) if (!cur[i]) this.queue.push(i);
  }

  // Amortized bake. The first band after a buildings change drains in one go —
  // that lands on the paused boot frame, where a stall costs nothing; every
  // later band change trickles while the previous band keeps serving.
  private pump(): void {
    if (!this.queue.length) return;
    const cur = this.sprites.get(this.band)!;
    const n = this.prewarm ? this.queue.length : BAKES_PER_FRAME;
    for (let k = 0; k < n && this.queue.length; k++) {
      const i = this.queue.shift()!;
      cur[i] = bakeRoof(this.buildings[i], this.art[i], i, this.band);
    }
    if (!this.queue.length) this.prewarm = false;
  }

  drawShadows(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      // core offset (0.71m) matches the old fixed (0.45,0.55) rect offset in
      // magnitude; the soft layer extends further along the same sun direction.
      this.buildings.forEach((b, i) => {
        if (!this.onScreen(cam, i, cw, ch, 2 * this.stories[i])) return;
        // shadow tracks the roof fade: a faded roof (zoomed-in interior reveal)
        // must not leave a full-footprint shadow rect stranded on the ground
        // with no roof above it — it reads as a dark terrain stain.
        const a = this.alphas[i];
        // drop shadow lengthens with height: taller building, longer shadow.
        // stories is min 1, so 1-story/flat maps keep the old 0.71/1.1 offsets.
        const [sdx, sdy] = shadowOffset(0.71 * this.stories[i]);
        const [sdxSoft, sdySoft] = shadowOffset(1.1 * this.stories[i]);
        const x = b.x - OVERHANG;
        const y = b.y - OVERHANG;
        const w = b.w + OVERHANG * 2;
        const h = b.h + OVERHANG * 2;
        // soft SE cast shadow — two nested alpha rects along the shared sun direction
        ctx.fillStyle = `rgba(12,15,10,${SHADOW_SOFT_ALPHA * a})`;
        ctx.fillRect(x + sdxSoft, y + sdySoft, w, h);
        ctx.fillStyle = `rgba(12,15,10,${SHADOW_ALPHA * a})`;
        ctx.fillRect(x + sdx, y + sdy, w, h);
        // tight ambient-occlusion ring at the wall base — not sun-directional
        const aoW = 0.22;
        ctx.strokeStyle = `rgba(8,10,7,${AO_ALPHA * a})`;
        ctx.lineWidth = aoW;
        ctx.strokeRect(x + aoW / 2, y + aoW / 2, w - aoW, h - aoW);
      });
    });
  }

  drawTops(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.setBand(roofBandFor(cam.scale));
    this.pump();
    const cur = this.sprites.get(this.band);
    const prev = this.prevBand ? this.sprites.get(this.prevBand) : undefined;
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      for (let i = 0; i < this.buildings.length; i++) {
        if (!this.onScreen(cam, i, cw, ch)) continue;
        const a = this.alphas[i];
        const art = this.art[i];
        const spr = cur?.[i] ?? prev?.[i] ?? null;
        if (spr && a >= 0.01) {
          ctx.globalAlpha = a;
          ctx.drawImage(spr, art.ox, art.oy, art.ow, art.oh);
        }
        // The silhouette is gameplay, not decoration: a revealed roof must
        // still show where the building is, so the outline never fades out.
        const b = this.buildings[i];
        ctx.globalAlpha = Math.max(a, 0.45);
        ctx.strokeStyle = 'rgba(20,16,12,0.55)';
        ctx.lineWidth = 0.08;
        ctx.strokeRect(b.x - OVERHANG, b.y - OVERHANG, b.w + OVERHANG * 2, b.h + OVERHANG * 2);
      }
      ctx.globalAlpha = 1;
    });
  }
}
