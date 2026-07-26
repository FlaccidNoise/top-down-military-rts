import type { Building } from '../sim/mapgen';
import { EDGE } from '../sim/map';
import type { GameMap } from '../sim/map';
import type { Sim } from '../sim/sim';
import type { Camera } from './camera';
import { AO_ALPHA, SHADOW_ALPHA, SHADOW_SOFT_ALPHA, SUN, WIND, shadowOffset } from './light';

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

// Fake-oblique mass. The roof blits PARALLAX metres up-sun of the footprint so
// the SE wall face is uncovered; it stays well under OVERHANG, or the roof
// would pull back off the NW footprint edge and break the wall-line read.
const PARALLAX = 0.26;
const H_PROJ = 0.5; // metres of wall face shown per storey
type WallMat = 'rubble' | 'colombage' | 'brick';
const WALL_BASES: Record<WallMat, string> = { rubble: '#8d867a', colombage: '#9a917c', brick: '#6f5041' };
const FACE_S = 0.56; // the south face is the more backlit of the two visible sides
const FACE_E = 0.66;

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

type RoofPlan = 'gable' | 'hip' | 'cross' | 'catslide';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RoofArt {
  mat: RoofMat;
  ridgeAlongX: boolean;
  plan: RoofPlan;
  rr: Rect; // roof rect, after any catslide eave extension
  fracNW: number; // ridge position across the span, from the NW eave
  hipInset: number; // metres the ridge is pulled back from each end; 0 unless hipped
  wing: Rect | null;
  lean: (Rect & { side: 'n' | 's' | 'e' | 'w' }) | null;
  dormers: Rect[];
  ridgeU0: number; // ridge extent along its own axis, world coords (B6 clamps to it)
  ridgeU1: number;
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
  ox: number; // roof sprite origin / span, world meters
  oy: number;
  ow: number;
  oh: number;
  sx: number; // shadow sprite rect — grown SE by the cast offset plus blur margin
  sy: number;
  sw: number;
  sh: number;
  hp: number; // wall-face projection depth, metres
  wall: WallMat;
  wallS: string; // the two visible faces, both in shade under a NW sun
  wallE: string;
  wallSTones: string[];
  wallETones: string[];
  openS: Uint8Array; // per-tile edge type along the south / east walls
  openE: Uint8Array;
  chimneys: Rect[];
  smoke: boolean;
}

function roofRect(b: Building): Rect {
  return { x: b.x - OVERHANG, y: b.y - OVERHANG, w: b.w + OVERHANG * 2, h: b.h + OVERHANG * 2 };
}

function doorSideOf(b: Building, map: GameMap): 'n' | 's' | 'e' | 'w' | null {
  for (let k = 0; k < b.w; k++) {
    if (map.hEdge(b.x + k, b.y) === EDGE.DOOR) return 'n';
    if (map.hEdge(b.x + k, b.y + b.h) === EDGE.DOOR) return 's';
  }
  for (let k = 0; k < b.h; k++) {
    if (map.vEdge(b.x, b.y + k) === EDGE.DOOR) return 'w';
    if (map.vEdge(b.x + b.w, b.y + k) === EDGE.DOOR) return 'e';
  }
  return null;
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
function buildArt(b: Building, i: number, stories: number, smallOfPair: boolean, map: GameMap): RoofArt {
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

  // --- roof PLAN. Footprints come from the sim and never move; what varies is
  // where the ridge sits inside one, which is what stops a village reading as
  // the same house stamped twenty times.
  const short = Math.min(b.w, b.h);
  const pr = hash(i, 240);
  let plan: RoofPlan;
  if (mat === 'iron') plan = pr < 0.72 ? 'gable' : 'catslide'; // a hipped tin barn is not a thing
  else if (pr < 0.35) plan = 'gable';
  else if (pr < 0.6) plan = 'hip';
  else if (pr < 0.8 && short >= 6) plan = 'cross';
  else plan = 'catslide';

  const rr: Rect = { x, y, w, h };
  const span0 = ridgeAlongX ? h : w;
  const base0 = ridgeAlongX ? y : x;
  let ridgeCross = base0 + span0 * 0.5;
  if (plan === 'catslide') {
    const f = hash(i, 241) < 0.5 ? 0.4 : 0.6;
    ridgeCross = base0 + span0 * f;
    // the long shallow slope reaches further out — the Normandy catslide read
    const ext = 0.25;
    if (f > 0.5) {
      if (ridgeAlongX) {
        rr.y -= ext;
        rr.h += ext;
      } else {
        rr.x -= ext;
        rr.w += ext;
      }
    } else if (ridgeAlongX) rr.h += ext;
    else rr.w += ext;
  }
  const spanLen = ridgeAlongX ? rr.h : rr.w;
  const fracNW = (ridgeCross - (ridgeAlongX ? rr.y : rr.x)) / spanLen;
  const ridgeLen = ridgeAlongX ? rr.w : rr.h;
  const hipInset = plan === 'hip' ? Math.min(spanLen / 2, 1.8, ridgeLen * 0.35) : 0;

  let wing: Rect | null = null;
  if (plan === 'cross') {
    const wl = ridgeLen * (0.3 + hash(i, 242) * 0.15);
    const start = ridgeAlongX ? rr.x : rr.y;
    const c = start + ridgeLen * (0.28 + hash(i, 243) * 0.44);
    const w0 = Math.max(start + 0.3, Math.min(start + ridgeLen - wl - 0.3, c - wl / 2));
    wing = ridgeAlongX ? { x: w0, y: rr.y, w: wl, h: rr.h } : { x: rr.x, y: w0, w: rr.w, h: wl };
  }

  // lean-to annex against a wall that is not the door wall
  let lean: (Rect & { side: 'n' | 's' | 'e' | 'w' }) | null = null;
  if (hash(i, 244) < 0.3) {
    const doorSide = doorSideOf(b, map);
    const sides: ('n' | 's' | 'e' | 'w')[] = (['n', 's', 'e', 'w'] as const).filter((sd) => sd !== doorSide);
    const side = sides[(hash(i, 246) * sides.length) | 0];
    const d = 1.4 + hash(i, 245) * 0.8;
    const horiz = side === 'n' || side === 's';
    const along = horiz ? rr.w : rr.h;
    const ll = along * (0.5 + hash(i, 247) * 0.4);
    const l0 = (horiz ? rr.x : rr.y) + (along - ll) * hash(i, 248);
    lean = horiz
      ? { x: l0, y: side === 'n' ? rr.y - d : rr.y + rr.h, w: ll, h: d, side }
      : { x: side === 'w' ? rr.x - d : rr.x + rr.w, y: l0, w: d, h: ll, side };
  }

  // dormers on the sun slope, where a real one would be
  const dormers: Rect[] = [];
  const nwDepth = spanLen * fracNW;
  if (plan !== 'cross' && mat !== 'iron' && nwDepth >= 2.2 && b.w * b.h >= 45) {
    const usable = ridgeLen - 2.4 - hipInset * 2;
    const n = Math.min(3, 1 + ((hash(i, 250) * 3) | 0));
    if (usable > 1.6) {
      const v0 = nwDepth * 0.32;
      for (let k = 0; k < n; k++) {
        const off = 1.2 + hipInset + usable * ((k + 0.5) / n) + (hash(i, 251 + k) - 0.5) * 0.5;
        dormers.push(
          ridgeAlongX
            ? { x: rr.x + off - 0.55, y: rr.y + nwDepth - v0 - 0.8, w: 1.1, h: 0.8 }
            : { x: rr.x + nwDepth - v0 - 0.8, y: rr.y + off - 0.55, w: 0.8, h: 1.1 },
        );
      }
    }
  }

  // Normandy stacks sit at the gable ends, so bias there and only sometimes
  // land mid-ridge. A hipped roof's ridge is shorter, and the clamp is what
  // keeps the stack off the hip end plane.
  const ridgeStart = (ridgeAlongX ? rr.x : rr.y) + hipInset;
  const ridgeEnd = (ridgeAlongX ? rr.x + rr.w : rr.y + rr.h) - hipInset;
  const po = (hash(i, 63) - 0.5) * 0.2;
  const cross = (ridgeAlongX ? rr.y : rr.x) + spanLen * fracNW + po;
  const t0 =
    hash(i, 271) < 0.7
      ? hash(i, 62) < 0.5
        ? 0.06 + hash(i, 275) * 0.14
        : 0.8 + hash(i, 275) * 0.14
      : 0.32 + hash(i, 275) * 0.36;
  const stackW = ridgeAlongX ? 0.5 : 0.4;
  const stackH = ridgeAlongX ? 0.4 : 0.5;
  const stackAt = (t: number): Rect => {
    const p = ridgeStart + (ridgeEnd - ridgeStart) * t;
    return ridgeAlongX
      ? { x: p - stackW / 2, y: cross - stackH / 2, w: stackW, h: stackH }
      : { x: cross - stackW / 2, y: p - stackH / 2, w: stackW, h: stackH };
  };
  const chimneys = [stackAt(t0)];
  if (b.w * b.h >= 70) chimneys.push(stackAt(1 - t0));

  const wr = hash(i, 260);
  const wall: WallMat = wr < 0.15 ? 'brick' : wr < 0.5 ? 'colombage' : 'rubble';
  const wbase = hexToRgb(WALL_BASES[wall]);
  // Openings come from the map, not from decoration: mapgen puts a window at
  // every third edge tile and the door mid-span, which is what terrain.ts
  // already strokes, so the face lines up with the walls the player sees.
  const openS = new Uint8Array(b.w);
  for (let k = 0; k < b.w; k++) openS[k] = map.hEdge(b.x + k, b.y + b.h);
  const openE = new Uint8Array(b.h);
  for (let k = 0; k < b.h; k++) openE[k] = map.vEdge(b.x + b.w, b.y + k);

  const [csdx, csdy] = shadowOffset(1.1 * stories);
  const blurPad = 0.6;

  // The sprite must contain every plan feature or wings and lean-tos clip.
  let nx = rr.x;
  let ny = rr.y;
  let mx = rr.x + rr.w;
  let my = rr.y + rr.h;
  if (lean) {
    nx = Math.min(nx, lean.x);
    ny = Math.min(ny, lean.y);
    mx = Math.max(mx, lean.x + lean.w);
    my = Math.max(my, lean.y + lean.h);
  }

  return {
    mat,
    ridgeAlongX,
    plan,
    rr,
    fracNW,
    hipInset,
    wing,
    lean,
    dormers,
    ridgeU0: ridgeStart,
    ridgeU1: ridgeEnd,
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
    ox: nx - PAD_NW,
    oy: ny - PAD_NW,
    ow: mx - nx + PAD_NW + PAD_SE,
    oh: my - ny + PAD_NW + PAD_SE,
    sx: nx - blurPad,
    sy: ny - blurPad,
    sw: mx - nx + csdx + blurPad * 2,
    sh: my - ny + csdy + blurPad * 2,
    hp: H_PROJ * stories,
    wall,
    wallS: rgbStr(tint(wbase, FACE_S, -3)),
    wallE: rgbStr(tint(wbase, FACE_E, -1)),
    wallSTones: ramp(wbase, FACE_S, -3, 0.09),
    wallETones: ramp(wbase, FACE_E, -1, 0.09),
    openS,
    openE,
    chimneys,
    // hash-driven ambience only — never garrison state, which would leak intel
    smoke: mat !== 'iron' && hash(i, 272) < 0.45,
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
    for (let k = 0; k < n; k++) {
      const u = atEnd ? uLen - 0.15 - k * sp.tileW * 1.2 : 0.15 + k * sp.tileW * 1.2;
      const ci = (hash(i, 3 + k, 219) * 2) | 0;
      const gv = vLen - (ci + 1) * sp.course + 0.03;
      g.fillStyle = '#241f19';
      g.fillRect(u, gv, sp.tileW * 0.8, sp.course - 0.06);
      // the batten showing through the gap, so it is a hole and not a blot
      g.fillStyle = 'rgba(126,104,74,0.45)';
      g.fillRect(u, gv + (sp.course - 0.06) * 0.45, sp.tileW * 0.8, 0.04);
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

// One slope, in the (u, v) frame with v=0 at the ridge and v=vLen at the eave.
function slopeInto(g: CanvasRenderingContext2D, art: RoofArt, i: number, band: number, uLen: number, vLen: number, lit: boolean): void {
  if (vLen <= 0.02 || uLen <= 0.02) return;
  if (art.mat === 'thatch') slopeThatch(g, art, i, band, uLen, vLen, lit);
  else if (art.mat === 'iron') slopeIron(g, art, i, band, uLen, vLen, lit);
  else slopeShingle(g, art, i, band, uLen, vLen, lit);
  if (!lit && band >= 16) slopeWeather(g, i, uLen, vLen);
}

// A ridged pair of slopes over `r`. `along` picks the ridge axis, `frac` where
// the ridge sits across the span — 0.5 is a plain gable, anything else the
// catslide's long-and-short pair.
function gablePair(g: CanvasRenderingContext2D, art: RoofArt, i: number, band: number, r: Rect, along: boolean, frac: number, verge: boolean): void {
  const uLen = along ? r.w : r.h;
  const span = along ? r.h : r.w;
  const vNW = span * frac;
  const vSE = span - vNW;
  for (const lit of [true, false]) {
    g.save();
    if (along) {
      g.translate(r.x, r.y + vNW);
      g.transform(1, 0, 0, lit ? -1 : 1, 0, 0);
    } else {
      g.translate(r.x + vNW, r.y);
      g.transform(0, 1, lit ? -1 : 1, 0, 0, 0);
    }
    slopeInto(g, art, i + (along ? 0 : 7), band, uLen, lit ? vNW : vSE, lit);
    g.restore();
  }
  if (verge) {
    // the barge board along each ridge end, not a dark triangle notch
    g.fillStyle = art.gable;
    const vg = 0.16;
    if (along) {
      g.fillRect(r.x, r.y, vg, r.h);
      g.fillRect(r.x + r.w - vg, r.y, vg, r.h);
    } else {
      g.fillRect(r.x, r.y, r.w, vg);
      g.fillRect(r.x, r.y + r.h - vg, r.w, vg);
    }
  }
  g.save();
  if (along) g.translate(r.x, r.y + vNW);
  else {
    g.translate(r.x + vNW, r.y);
    g.transform(0, 1, 1, 0, 0, 0);
  }
  ridgeRun(g, art, band, uLen);
  g.restore();
}

// A gabled dormer box on the sun slope: two cheeks, a window facing down-slope,
// a valley tick where it cuts the main plane, and its own cast shadow.
function dormerInto(g: CanvasRenderingContext2D, art: RoofArt, d: Rect, along: boolean, band: number): void {
  const [dx, dy] = shadowOffset(0.5);
  g.fillStyle = 'rgba(14,12,9,0.35)';
  g.fillRect(d.x + dx, d.y + dy, d.w, d.h);
  if (band < 16) {
    g.fillStyle = art.shade;
    g.fillRect(d.x, d.y, d.w, d.h);
    g.fillStyle = art.lit;
    if (along) g.fillRect(d.x, d.y, d.w, d.h * 0.4);
    else g.fillRect(d.x, d.y, d.w * 0.4, d.h);
    return;
  }
  // The down-slope end is the rendered FACE (it points NW, into the sun); the
  // rest is the dormer's own little roof, split by its down-slope ridge.
  const face = (along ? d.h : d.w) * 0.42;
  const cheek: Rect = along ? { x: d.x, y: d.y + face, w: d.w, h: d.h - face } : { x: d.x + face, y: d.y, w: d.w - face, h: d.h };
  g.fillStyle = art.litTones[TONE_STEPS - 3];
  g.fillRect(cheek.x, cheek.y, cheek.w, cheek.h);
  g.fillStyle = art.shadeTones[TONE_STEPS - 2];
  if (along) g.fillRect(cheek.x + cheek.w / 2, cheek.y, cheek.w / 2, cheek.h);
  else g.fillRect(cheek.x, cheek.y + cheek.h / 2, cheek.w, cheek.h / 2);
  g.fillStyle = 'rgba(226,214,196,0.22)';
  if (along) g.fillRect(cheek.x + cheek.w / 2 - 0.03, cheek.y, 0.06, cheek.h);
  else g.fillRect(cheek.x, cheek.y + cheek.h / 2 - 0.03, cheek.w, 0.06);
  g.fillStyle = '#8d8577';
  if (along) g.fillRect(d.x, d.y, d.w, face);
  else g.fillRect(d.x, d.y, face, d.h);
  g.fillStyle = '#39424a';
  const pane = along
    ? { x: d.x + 0.16, y: d.y + 0.06, w: d.w - 0.32, h: face - 0.14 }
    : { x: d.x + 0.06, y: d.y + 0.16, w: face - 0.14, h: d.h - 0.32 };
  g.fillRect(pane.x, pane.y, pane.w, pane.h);
  g.fillStyle = 'rgba(232,222,198,0.32)';
  if (along) g.fillRect(d.x, d.y, d.w, 0.05);
  else g.fillRect(d.x, d.y, 0.05, d.h);
  g.strokeStyle = 'rgba(20,16,12,0.6)';
  g.lineWidth = Math.max(0.04, 1.1 / band);
  g.strokeRect(d.x, d.y, d.w, d.h);
}

// A stack with mass: the body's SE faces peek out from under an overhanging
// cap slab, lit on its NW lip and undercut on the SE, with pots on top.
function chimneyInto(g: CanvasRenderingContext2D, st: Rect, i: number, k: number, band: number): void {
  const [ox, oy] = shadowOffset(0.16);
  g.fillStyle = '#39312b';
  g.fillRect(st.x + ox, st.y + oy, st.w, st.h);
  if (band >= 16) {
    g.fillStyle = 'rgba(20,17,13,0.45)';
    for (let v = st.y + oy + 0.11; v < st.y + st.h + oy; v += 0.11) g.fillRect(st.x + ox, v, st.w, 0.022);
    const jog = hash(i, 270 + k) * 0.08;
    for (let u = st.x + ox + 0.12 + jog; u < st.x + st.w + ox; u += 0.17) g.fillRect(u, st.y + oy, 0.022, st.h);
  }
  const cap = 0.06;
  g.fillStyle = '#4a4038';
  g.fillRect(st.x - cap, st.y - cap, st.w + cap * 2, st.h + cap * 2);
  g.fillStyle = 'rgba(226,214,196,0.28)';
  g.fillRect(st.x - cap, st.y - cap, st.w + cap * 2, 0.04);
  g.fillRect(st.x - cap, st.y - cap, 0.04, st.h + cap * 2);
  g.fillStyle = 'rgba(12,10,8,0.45)';
  g.fillRect(st.x - cap, st.y + st.h + cap - 0.04, st.w + cap * 2, 0.04);
  g.fillRect(st.x + st.w + cap - 0.04, st.y - cap, 0.04, st.h + cap * 2);
  if (band < 16) return;
  const pots = hash(i, 276 + k) < 0.5 ? 1 : 2;
  for (let p = 0; p < pots; p++) {
    const px = st.x + st.w * ((p + 0.5) / pots);
    const py = st.y + st.h / 2;
    g.fillStyle = 'rgba(24,20,16,0.5)';
    g.beginPath();
    g.arc(px, py, 0.105, 0, TAU);
    g.fill();
    g.fillStyle = '#2a241e';
    g.beginPath();
    g.arc(px, py, 0.07, 0, TAU);
    g.fill();
  }
}

function drawRoof(g: CanvasRenderingContext2D, art: RoofArt, i: number, band: number): void {
  const r = art.rr;
  const along = art.ridgeAlongX;

  // lean-to first: it tucks under the main eave, so the main roof paints over
  // the joint rather than the other way round
  if (art.lean) {
    const l = art.lean;
    const lit = l.side === 'n' || l.side === 'w';
    const uLen = l.side === 'n' || l.side === 's' ? l.w : l.h;
    g.save();
    if (l.side === 'n') {
      g.translate(l.x, l.y + l.h);
      g.transform(1, 0, 0, -1, 0, 0);
    } else if (l.side === 's') g.translate(l.x, l.y);
    else if (l.side === 'w') {
      g.translate(l.x + l.w, l.y);
      g.transform(0, 1, -1, 0, 0, 0);
    } else {
      g.translate(l.x, l.y);
      g.transform(0, 1, 1, 0, 0, 0);
    }
    slopeInto(g, art, i + 13, band, uLen, l.side === 'n' || l.side === 's' ? l.h : l.w, lit);
    g.restore();
    g.strokeStyle = 'rgba(20,16,12,0.55)';
    g.lineWidth = Math.max(0.06, 1.2 / band);
    g.strokeRect(l.x, l.y, l.w, l.h);
  }

  gablePair(g, art, i, band, r, along, art.fracNW, art.plan !== 'hip');

  if (art.plan === 'hip') {
    // Two end planes replace the gables. They carry the same courses as the
    // main slopes — a flat fill next to a shingled one reads as a hole — and
    // a scrim pulls each to a value between lit and shade so four planes read.
    const inset = art.hipInset;
    const vNW = (along ? r.h : r.w) * art.fracNW;
    const ends: { tri: [number, number][]; tx: number; ty: number; m: [number, number, number, number]; lit: boolean; scrim: string }[] = along
      ? [
          {
            tri: [[r.x, r.y], [r.x, r.y + r.h], [r.x + inset, r.y + vNW]],
            tx: r.x + inset,
            ty: r.y,
            m: [0, 1, -1, 0],
            lit: true,
            scrim: 'rgba(10,10,12,0.12)',
          },
          {
            tri: [[r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x + r.w - inset, r.y + vNW]],
            tx: r.x + r.w - inset,
            ty: r.y,
            m: [0, 1, 1, 0],
            lit: false,
            scrim: 'rgba(250,246,238,0.09)',
          },
        ]
      : [
          {
            tri: [[r.x, r.y], [r.x + r.w, r.y], [r.x + vNW, r.y + inset]],
            tx: r.x,
            ty: r.y + inset,
            m: [1, 0, 0, -1],
            lit: true,
            scrim: 'rgba(10,10,12,0.12)',
          },
          {
            tri: [[r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + vNW, r.y + r.h - inset]],
            tx: r.x,
            ty: r.y + r.h - inset,
            m: [1, 0, 0, 1],
            lit: false,
            scrim: 'rgba(250,246,238,0.09)',
          },
        ];
    for (const e of ends) {
      g.save();
      g.beginPath();
      g.moveTo(e.tri[0][0], e.tri[0][1]);
      g.lineTo(e.tri[1][0], e.tri[1][1]);
      g.lineTo(e.tri[2][0], e.tri[2][1]);
      g.closePath();
      g.clip();
      g.save();
      g.translate(e.tx, e.ty);
      g.transform(e.m[0], e.m[1], e.m[2], e.m[3], 0, 0);
      slopeInto(g, art, i + (e.lit ? 21 : 29), band, along ? r.h : r.w, inset, e.lit);
      g.restore();
      g.fillStyle = e.scrim;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.restore();
      // hip rafters
      g.strokeStyle = 'rgba(226,214,196,0.18)';
      g.lineWidth = 0.07;
      g.beginPath();
      g.moveTo(e.tri[0][0], e.tri[0][1]);
      g.lineTo(e.tri[2][0], e.tri[2][1]);
      g.moveTo(e.tri[1][0], e.tri[1][1]);
      g.lineTo(e.tri[2][0], e.tri[2][1]);
      g.stroke();
    }
  }

  if (art.wing) {
    const wg = art.wing;
    gablePair(g, art, i + 3, band, wg, !along, 0.5, true);
    g.strokeStyle = 'rgba(16,14,10,0.30)';
    g.lineWidth = 0.1;
    g.beginPath();
    if (along) {
      g.moveTo(wg.x, wg.y);
      g.lineTo(wg.x, wg.y + wg.h);
      g.moveTo(wg.x + wg.w, wg.y);
      g.lineTo(wg.x + wg.w, wg.y + wg.h);
    } else {
      g.moveTo(wg.x, wg.y);
      g.lineTo(wg.x + wg.w, wg.y);
      g.moveTo(wg.x, wg.y + wg.h);
      g.lineTo(wg.x + wg.w, wg.y + wg.h);
    }
    g.stroke();
  }

  for (const d of art.dormers) dormerInto(g, art, d, along, band);

  // barns vent the ridge instead of dormering it, and get one roof hatch
  if (art.mat === 'iron' && band >= 16) {
    const uLen = along ? r.w : r.h;
    g.save();
    if (along) g.translate(r.x, r.y + r.h * art.fracNW);
    else {
      g.translate(r.x + r.w * art.fracNW, r.y);
      g.transform(0, 1, 1, 0, 0, 0);
    }
    g.fillStyle = art.litTones[TONE_STEPS - 1];
    g.fillRect(uLen * 0.22, -0.14, uLen * 0.56, 0.28);
    g.fillStyle = 'rgba(10,12,10,0.6)';
    for (let u = uLen * 0.24; u < uLen * 0.76; u += 0.2) g.fillRect(u, -0.11, 0.08, 0.22);
    g.fillStyle = 'rgba(12,14,12,0.5)';
    g.fillRect(uLen * 0.22, 0.1, uLen * 0.56, 0.05);
    g.restore();
    const hx = along ? r.x + r.w * 0.7 : r.x + r.w * (art.fracNW + 0.22);
    const hy = along ? r.y + r.h * (art.fracNW + 0.22) : r.y + r.h * 0.7;
    g.fillStyle = 'rgba(28,26,22,0.85)';
    g.fillRect(hx, hy, 0.5, 0.5);
    g.fillStyle = 'rgba(226,214,196,0.16)';
    g.fillRect(hx, hy, 0.5, 0.07);
  }

  // Chimney shadows are clipped to the roof planes: a stack sits 1.2 m above
  // the slope, so its shadow is long, and unclipped it hangs off the eave onto
  // the ground where nothing is casting it.
  g.save();
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  if (art.wing) g.rect(art.wing.x, art.wing.y, art.wing.w, art.wing.h);
  if (art.lean) g.rect(art.lean.x, art.lean.y, art.lean.w, art.lean.h);
  g.clip();
  const [kdx, kdy] = shadowOffset(1.2);
  g.fillStyle = 'rgba(14,12,9,0.38)';
  for (const st of art.chimneys) {
    g.beginPath();
    g.moveTo(st.x, st.y);
    g.lineTo(st.x + st.w, st.y);
    g.lineTo(st.x + st.w + kdx, st.y + kdy);
    g.lineTo(st.x + st.w + kdx, st.y + st.h + kdy);
    g.lineTo(st.x + kdx, st.y + st.h + kdy);
    g.lineTo(st.x, st.y + st.h);
    g.closePath();
    g.fill();
  }
  g.restore();
  for (let k = 0; k < art.chimneys.length; k++) chimneyInto(g, art.chimneys[k], i, k, band);

  // eave outline in metres-per-band so it survives the downscale; thatch gets
  // a wider, weaker one because a hard black edge is exactly what straw isn't
  const soft = art.mat === 'thatch';
  g.strokeStyle = soft ? 'rgba(28,22,14,0.34)' : 'rgba(20,16,12,0.6)';
  g.lineWidth = Math.max(0.06, 1.3 / band) * (soft ? 1.8 : 1);
  g.strokeRect(r.x, r.y, r.w, r.h);

  // The eave's own shadow onto the wall below it. It belongs to the roof, so
  // it lives here and fades with the roof rather than sticking to the wall.
  g.fillStyle = 'rgba(14,12,9,0.4)';
  g.fillRect(r.x, r.y + r.h, r.w + 0.08, 0.08);
  g.fillRect(r.x + r.w, r.y, 0.08, r.h);
}

function bakeRoof(art: RoofArt, i: number, band: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(art.ow * band));
  c.height = Math.max(1, Math.round(art.oh * band));
  const g = c.getContext('2d')!;
  g.scale(band, band);
  g.translate(-art.ox, -art.oy);
  drawRoof(g, art, i, band);
  return c;
}

// Soft one-sun drop shadow. ctx.filter is a bake-time nicety — where it is
// unsupported the assignment is a no-op and the edges simply stay hard, so
// there is nothing to guard.
function bakeShadow(b: Building, art: RoofArt, stories: number, band: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(art.sw * band));
  c.height = Math.max(1, Math.round(art.sh * band));
  const g = c.getContext('2d')!;
  g.scale(band, band);
  g.translate(-art.sx, -art.sy);
  const r = art.rr;
  const l = art.lean;
  const [sdx, sdy] = shadowOffset(0.71 * stories);
  const [fdx, fdy] = shadowOffset(1.1 * stories);
  // the silhouette is whatever the roof actually is, lean-to included
  const cast = (ox: number, oy: number): void => {
    g.fillRect(r.x + ox, r.y + oy, r.w, r.h);
    if (l) g.fillRect(l.x + ox, l.y + oy, l.w, l.h);
  };
  g.filter = `blur(${(0.28 * band).toFixed(2)}px)`;
  g.fillStyle = `rgba(12,15,10,${SHADOW_SOFT_ALPHA})`;
  cast(fdx, fdy);
  g.filter = `blur(${(0.12 * band).toFixed(2)}px)`;
  g.fillStyle = `rgba(12,15,10,${SHADOW_ALPHA})`;
  cast(sdx, sdy);
  g.filter = 'none';
  // contact occlusion sits on the true footprint and stays crisp
  const aoW = 0.22;
  g.strokeStyle = `rgba(8,10,7,${AO_ALPHA})`;
  g.lineWidth = aoW;
  g.strokeRect(b.x + aoW / 2, b.y + aoW / 2, b.w - aoW, b.h - aoW);
  return c;
}

// One wall face in a local frame: u runs along the wall, v runs outward from
// the footprint edge to the bottom of the projected face.
function wallFace(
  g: CanvasRenderingContext2D,
  art: RoofArt,
  i: number,
  band: number,
  uLen: number,
  hp: number,
  tones: string[],
  flat: string,
  open: Uint8Array,
  openAt: number,
  salt: number,
): void {
  g.fillStyle = flat;
  g.fillRect(0, 0, uLen, hp);
  if (art.wall === 'rubble') {
    const row = hp / Math.max(2, Math.round(hp / 0.28));
    for (let v = 0, r = 0; v < hp - 0.001; v += row, r++) {
      const stag = (r & 1) * 0.22;
      for (let u = -stag, k = 0; u < uLen; u += 0.45, k++) {
        const u0 = Math.max(0, u);
        const u1 = Math.min(uLen, u + 0.45 - 0.04);
        if (u1 - u0 <= 0.001) continue;
        g.fillStyle = tones[Math.min(TONE_STEPS - 1, (hash(i, r * 131 + k, salt) * TONE_STEPS) | 0)];
        g.fillRect(u0, v, u1 - u0, row - 0.035);
      }
    }
    g.fillStyle = 'rgba(60,54,44,0.35)';
    for (let v = row; v < hp - 0.001; v += row) g.fillRect(0, v - 0.03, uLen, 0.03);
  } else if (art.wall === 'colombage') {
    g.fillStyle = '#4a3c2c';
    for (let u = 0; u < uLen; u += 0.7) g.fillRect(u, 0, 0.1, hp);
    g.fillRect(0, hp * 0.45, uLen, 0.08);
  } else {
    const row = 0.22;
    for (let v = 0, r = 0; v < hp - 0.001; v += row, r++) {
      const stag = (r & 1) * 0.11;
      for (let u = -stag, k = 0; u < uLen; u += 0.22, k++) {
        const u0 = Math.max(0, u);
        const u1 = Math.min(uLen, u + 0.22 - 0.03);
        if (u1 - u0 <= 0.001) continue;
        g.fillStyle = tones[Math.min(TONE_STEPS - 1, (hash(i, r * 131 + k, salt) * TONE_STEPS) | 0)];
        g.fillRect(u0, v, u1 - u0, row - 0.03);
      }
    }
  }
  // openings, straight off the map's edge types
  for (let k = 0; k < open.length; k++) {
    const e = open[k];
    if (e !== EDGE.WINDOW && e !== EDGE.DOOR) continue;
    const u = openAt + k;
    if (e === EDGE.DOOR) {
      g.fillStyle = '#5f4426';
      g.fillRect(u + 0.18, 0, 0.64, hp);
      g.fillStyle = 'rgba(14,11,7,0.5)';
      g.fillRect(u + 0.18, 0, 0.64, hp * 0.28);
      g.strokeStyle = '#3a3128';
      g.lineWidth = Math.max(0.03, 1 / band);
      g.strokeRect(u + 0.18, 0, 0.64, hp);
      continue;
    }
    const py = hp * 0.22;
    const ph = hp * 0.5;
    g.fillStyle = '#39424a';
    g.fillRect(u + 0.2, py, 0.6, ph);
    g.fillStyle = 'rgba(226,214,190,0.35)';
    g.fillRect(u + 0.17, py + ph, 0.66, Math.max(0.045, hp * 0.1));
    g.strokeStyle = '#3a3128';
    g.lineWidth = Math.max(0.03, 1 / band);
    g.strokeRect(u + 0.2, py, 0.6, ph);
  }
  // the wall meets the ground here
  g.fillStyle = 'rgba(10,12,8,0.45)';
  g.fillRect(0, hp - 0.06, uLen, 0.06);
}

function bakeWall(b: Building, art: RoofArt, i: number, band: number, south: boolean): HTMLCanvasElement {
  const hp = art.hp;
  const uLen = south ? b.w + hp : b.h;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((south ? uLen : hp) * band));
  c.height = Math.max(1, Math.round((south ? hp : uLen) * band));
  const g = c.getContext('2d')!;
  g.scale(band, band);
  if (south) g.translate(0, 0);
  else g.transform(0, 1, 1, 0, 0, 0);
  wallFace(
    g,
    art,
    i,
    band,
    uLen,
    hp,
    south ? art.wallSTones : art.wallETones,
    south ? art.wallS : art.wallE,
    south ? art.openS : art.openE,
    0,
    south ? 261 : 262,
  );
  return c;
}

interface Baked {
  roof: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
  wallS: HTMLCanvasElement;
  wallE: HTMLCanvasElement;
}

export class RoofLayer {
  private buildings: Building[] = [];
  private alphas: number[] = [];
  private art: RoofArt[] = [];
  private stories: number[] = []; // per-building story count for shadow length, min 1
  private zoomFaded = false;
  private sprites = new Map<number, (Baked | null)[]>();
  private band = 0;
  private prevBand = 0;
  private queue: number[] = [];
  private prewarm = true;
  private tick = 0;

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
      this.art = this.buildings.map((b, i) => buildArt(b, i, this.stories[i], this.smallOfPair(i), sim.map));
      this.sprites.clear();
      this.band = 0;
      this.prevBand = 0;
      this.queue = [];
      this.prewarm = true;
    }
    this.tick = sim.tick;
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
    // the shadow is blurred to begin with, so half resolution is free
    const sBand = Math.max(8, this.band / 2);
    for (let k = 0; k < n && this.queue.length; k++) {
      const i = this.queue.shift()!;
      const b = this.buildings[i];
      const art = this.art[i];
      cur[i] = {
        roof: bakeRoof(art, i, this.band),
        shadow: bakeShadow(b, art, this.stories[i], sBand),
        wallS: bakeWall(b, art, i, this.band, true),
        wallE: bakeWall(b, art, i, this.band, false),
      };
    }
    if (this.queue.length) return;
    this.prewarm = false;
    // the previous band was only ever a stand-in while this one baked
    if (this.prevBand && this.prevBand !== this.band) {
      this.sprites.delete(this.prevBand);
      this.prevBand = 0;
    }
  }

  private serving(i: number): Baked | null {
    return this.sprites.get(this.band)?.[i] ?? (this.prevBand ? this.sprites.get(this.prevBand)?.[i] ?? null : null);
  }

  drawShadows(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.setBand(roofBandFor(cam.scale));
    this.pump();
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      this.buildings.forEach((b, i) => {
        if (!this.onScreen(cam, i, cw, ch, 2 * this.stories[i])) return;
        // shadow tracks the roof fade: a faded roof (zoomed-in interior reveal)
        // must not leave a full-footprint shadow rect stranded on the ground
        // with no roof above it — it reads as a dark terrain stain.
        const a = this.alphas[i];
        const spr = this.serving(i);
        if (!spr) return;
        const art = this.art[i];
        ctx.globalAlpha = a;
        ctx.drawImage(spr.shadow, art.sx, art.sy, art.sw, art.sh);
      });
      ctx.globalAlpha = 1;
    });
  }

  // Wall faces, drawn in the shadow slot so soldiers pass in front of them.
  // Always opaque: a revealed interior does not remove the building's walls.
  drawWalls(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      for (let i = 0; i < this.buildings.length; i++) {
        if (!this.onScreen(cam, i, cw, ch)) continue;
        const spr = this.serving(i);
        if (!spr) continue;
        const b = this.buildings[i];
        const hp = this.art[i].hp;
        ctx.drawImage(spr.wallE, b.x + b.w, b.y, hp, b.h);
        ctx.drawImage(spr.wallS, b.x, b.y + b.h, b.w + hp, hp);
      }
    });
  }

  drawTops(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.setBand(roofBandFor(cam.scale));
    this.pump();
    const px = -SUN.dx * PARALLAX;
    const py = -SUN.dy * PARALLAX;
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      for (let i = 0; i < this.buildings.length; i++) {
        if (!this.onScreen(cam, i, cw, ch)) continue;
        const a = this.alphas[i];
        const art = this.art[i];
        const spr = this.serving(i);
        if (spr && a >= 0.01) {
          ctx.globalAlpha = a;
          ctx.drawImage(spr.roof, art.ox + px, art.oy + py, art.ow, art.oh);
        }
        // The silhouette is gameplay, not decoration. It sits on the true
        // footprint (the parallax has moved the baked eave line off it) and
        // rises as the roof fades, so a revealed building still reads as one.
        const ghost = 0.6 * (1 - Math.min(1, a / 0.85));
        if (ghost > 0.02) {
          const b = this.buildings[i];
          ctx.globalAlpha = 1;
          ctx.strokeStyle = `rgba(20,16,12,${ghost.toFixed(3)})`;
          ctx.lineWidth = 0.09;
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
      }
      ctx.globalAlpha = 1;
    });
  }

  // Hearth wisps on the shared wind. Phase comes off the sim tick, never
  // wall-clock, so they freeze under pause exactly like sim smoke does; alpha
  // rides the roof's own so a revealed interior gets no smoke floating over it.
  drawChimneySmoke(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    if (cam.scale < 6) return;
    const t = this.tick / 30;
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      for (let i = 0; i < this.buildings.length; i++) {
        const art = this.art[i];
        if (!art.smoke) continue;
        if (!this.onScreen(cam, i, cw, ch, 4)) continue;
        const a = this.alphas[i];
        if (a < 0.05) continue;
        const n = 3 + ((hash(i, 274) * 2) | 0);
        for (const st of art.chimneys) {
          const cx = st.x + st.w / 2;
          const cy = st.y + st.h / 2;
          for (let k = 0; k < n; k++) {
            const life = (t * 0.45 + k / n + hash(i, 273 + k)) % 1;
            const wob = Math.sin(life * 6 + k) * 0.25 * life;
            const px = cx + WIND.dx * life * 3.2 - WIND.dy * wob;
            const py = cy + WIND.dy * life * 3.2 + WIND.dx * wob;
            const rad = 0.18 + life * 0.7;
            // a soft core, not a disc — this has to read as haze over a roof,
            // never as a sprite that got its ordering wrong
            const gr = ctx.createRadialGradient(px, py, 0, px, py, rad);
            gr.addColorStop(0, `rgba(196,190,178,${(0.26 * (1 - life) * a).toFixed(3)})`);
            gr.addColorStop(1, 'rgba(196,190,178,0)');
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.arc(px, py, rad, 0, TAU);
            ctx.fill();
          }
        }
      }
    });
  }
}
