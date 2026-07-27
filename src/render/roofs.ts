import type { Building } from '../sim/mapgen';
import { EDGE } from '../sim/map';
import type { GameMap } from '../sim/map';
import type { Sim, Soldier } from '../sim/sim';
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
// A church is masonry to the eaves: a domestic 0.35 m timber overhang on a
// nave reads as a barn, and on a tower it buries the parapet the spire sits in.
const CHURCH_OVERHANG = 0.16;
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
const BAKES_PER_FRAME = 2; // floor: a frame always makes at least this much progress
// T22. The budget is TIME, not a sprite count: one building costs ~4 ms at
// band 32 and a fraction of that at band 8, so a fixed count is either a stall
// at the top band or a crawl at the bottom. A still camera is an inspection
// rather than play — nothing else is asking for the frame, and every frame
// spent trickling is a frame of visible pop-in in a paused screenshot. Two
// identical poses is enough to call it still; one is a scroll-wheel notch
// landing between two frames.
const BAKE_MS = 4;
const BAKE_MS_STATIC = 16;
const STILL_FRAMES = 2;
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

// --- impact damage (B8) ------------------------------------------------------
// The sim has no building HP and must not gain one, so damage is purely a
// render-side record of detonations the player watched land: Renderer.addBooms
// forwards every boom to noteImpact, which files it against a footprint and
// bumps that building's bake version. The next amortized bake paints the hole.
const DMG_CAP = 3; // holes per building — past three a house reads as rubble the sim will not honour
const DMG_MERGE = 0.8; // m — a second round in the same crater adds nothing
const DMG_NEAR = 1.5; // m outside the footprint that still counts as a near miss
const DMG_SOOT = 'rgba(24,20,16,0.30)';
const DMG_VOID = '#16130f';

interface Damage {
  x: number; // quantized to 0.25 m: the hole must not shimmer when the band rebakes
  y: number;
  direct: boolean; // inside the footprint → hole; outside → scorch and slipped tiles only
}

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

type RoofPlan = 'gable' | 'hip' | 'cross' | 'catslide' | 'spire';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Which sides of a footprint are butted against another mass of the SAME
// structure — a party wall in a terrace, or the nave a tower stands against.
// Those sides grow no overhang: two 0.35 m eaves meeting in the middle of a
// party wall is the double eave-line that makes a range read as five houses
// that happen to be touching.
interface Sides {
  n: boolean;
  s: boolean;
  e: boolean;
  w: boolean;
}
type Side = keyof Sides;

// Everything buildArt needs that is not the building itself. `alongX` and
// `ridge` are how a party-wall range (or a church's nave + apse) ends up under
// ONE roof instead of a row of competing ones; `runKey` is how it ends up in
// one material.
export interface ArtCtx {
  butt: Sides;
  alongX: boolean | null; // forced ridge axis (terrace frontage, church group)
  ridge: number | null; // shared ridge, world coord on the cross axis
  runKey: number | null; // shared material key for a whole range
  runStories: number;
}

const NO_BUTT: Sides = { n: false, s: false, e: false, w: false };
const SOLO: ArtCtx = { butt: NO_BUTT, alongX: null, ridge: null, runKey: null, runStories: 0 };

interface RoofArt {
  key: number; // stable art-hash key (N8) — the footprint, never the array index
  mat: RoofMat;
  ridgeAlongX: boolean;
  plan: RoofPlan;
  hipEnds: [boolean, boolean]; // which ridge ends are hipped — a half-hip is [false, true]
  verge: [boolean, boolean]; // barge board at the lo / hi ridge end
  party: [boolean, boolean]; // party wall at the lo / hi ridge end (terrace)
  spireCast: number; // extra shadow length above the walls — a spire throws a long one
  spireCross: number; // gable-cross arm length, 0 on everything that is not a nave
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
  dmgTones: string[]; // displaced-tile ramp: parent material at ±25% value
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

function roofRect(b: Building, butt: Sides, oh: number): Rect {
  const n = butt.n ? 0 : oh;
  const s = butt.s ? 0 : oh;
  const e = butt.e ? 0 : oh;
  const w = butt.w ? 0 : oh;
  return { x: b.x - w, y: b.y - n, w: b.w + w + e, h: b.h + n + s };
}

// N8. Roof art is keyed on the FOOTPRINT, not on the array index: the bourg
// emits buildings in geometric order, and inserting one at the front of that
// list used to re-roll the material of every house in the town. (x, y) is
// unique within a map — two structures cannot share an origin tile — and
// groupId keeps a church's masses from colliding with anything else.
export function artKey(b: Building): number {
  return (b.groupId ?? 0) * 131 + b.x * 1021 + b.y * 7;
}

function sacredRole(role: string): boolean {
  return role === 'church' || role === 'church_tower' || role === 'church_apse';
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

// Material from role + footprint + neighbours, never from the index: two-story
// town houses are never thatched, and the smaller half of a close pair
// (mapgen's farm house+barn) is usually the outbuilding, so it gets thatch or
// iron. Role wins outright where it has to — a church whose roof changes
// denomination with the seed is not a landmark, it is a large house.
export function pickMat(key: number, stories: number, smallOfPair: boolean, role: string): RoofMat {
  if (sacredRole(role)) return 'slate';
  const r = hash(key, 201);
  // Civic stone and a market hall are built by the commune, not by a tenant:
  // both are mineral. A barn is the other way round and leans agricultural.
  if (role === 'civic' || role === 'halle') return r < 0.55 ? 'slate' : 'tile';
  if (role === 'barn') return r < 0.4 ? 'iron' : r < 0.74 ? 'thatch' : 'tile';
  if (role === 'townhouse' || role === 'shop') return r < 0.52 ? 'tile' : 'slate';
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
function buildArt(b: Building, stories: number, smallOfPair: boolean, map: GameMap, ctx: ArtCtx): RoofArt {
  const i = artKey(b);
  const role = b.role ?? 'house';
  const sacred = sacredRole(role);
  const terraced = ctx.runKey !== null;
  const ridgeAlongX = ctx.alongX ?? b.w >= b.h;
  const loSide: Side = ridgeAlongX ? 'w' : 'n';
  const hiSide: Side = ridgeAlongX ? 'e' : 's';
  const { x, y, w, h } = roofRect(b, ctx.butt, sacred ? CHURCH_OVERHANG : OVERHANG);

  // A party-wall range was built by one mason in one year: it takes ONE
  // material, off the run's own key. The per-unit value jitter below still
  // weathers each unit separately, which is the difference between a terrace
  // and a single roof 30 m long.
  const matKey = ctx.runKey ?? i;
  const mat = pickMat(matKey, Math.max(stories, ctx.runStories), smallOfPair, role);
  const bases = MAT_BASES[mat];
  const valueJitter = 1 + (hash(i, 60) - 0.5) * (terraced ? 0.1 : 0.18); // ±9%, tighter inside a range
  const hue = MAT_HUE[mat];
  const hueJitter = hue.bias + (hash(matKey, 61) - 0.5) * 2 * hue.amp;
  const weathered = mute(tint(hexToRgb(bases[matKey % bases.length]), valueJitter, hueJitter), MAX_SAT);
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
  // Role first, and unconditionally: the church is the one silhouette in the
  // town that has to be the same silhouette on every seed.
  if (role === 'church_tower') plan = 'spire';
  else if (role === 'church') plan = 'cross'; // nave + one crossing gable for the transept
  else if (role === 'church_apse') plan = 'hip'; // half-hipped, see hipEnds
  else if (terraced) plan = 'gable'; // a range is one continuous pitch, never five competing ones
  else if (mat === 'iron') plan = pr < 0.72 ? 'gable' : 'catslide'; // a hipped tin barn is not a thing
  else if (pr < 0.35) plan = 'gable';
  else if (pr < 0.6) plan = 'hip';
  else if (pr < 0.8 && short >= 6) plan = 'cross';
  else plan = 'catslide';

  const rr: Rect = { x, y, w, h };
  const span0 = ridgeAlongX ? h : w;
  const base0 = ridgeAlongX ? y : x;
  let ridgeCross = base0 + span0 * 0.5;
  if (ctx.ridge !== null) {
    // T17. The range's ridge is a single world line. Where a unit steps off
    // the common frontage the line is pulled back inside that unit's own span
    // — a ridge outside the roof plane inverts a slope — so the run reads as
    // one continuous pitch that jogs exactly where the footprints jog.
    const m = span0 * 0.3;
    ridgeCross = Math.max(base0 + m, Math.min(base0 + span0 - m, ctx.ridge));
  } else if (plan === 'catslide') {
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
  // A hip is dropped wherever the ridge end butts another mass of the same
  // structure — which is what turns the apse's full hip into the half-hip it
  // wants: hipped on the free end, running straight into the nave on the other.
  const hipEnds: [boolean, boolean] = plan === 'hip' ? [!ctx.butt[loSide], !ctx.butt[hiSide]] : [false, false];
  // Barge board wherever there is neither a hip nor a party wall to hide it.
  const verge: [boolean, boolean] = [
    plan !== 'hip' && plan !== 'spire' && !ctx.butt[loSide],
    plan !== 'hip' && plan !== 'spire' && !ctx.butt[hiSide],
  ];
  // Only the LO joint of each unit carries the drawn parapet, so a shared wall
  // gets exactly one band rather than two units each drawing half of it and
  // the later one overpainting the earlier.
  const party: [boolean, boolean] = [terraced && ctx.butt[loSide], terraced && ctx.butt[hiSide]];

  let wing: Rect | null = null;
  if (role === 'church') {
    // The transept: one crossing gable across the full nave depth, set toward
    // the chancel end. Forced, not rolled — the cross plan IS the church read
    // from the tactical camera, where the spire is only a few pixels wide.
    const wl = Math.max(2.4, Math.min(ridgeLen * 0.3, spanLen * 0.7));
    const start = ridgeAlongX ? rr.x : rr.y;
    const w0 = start + (ridgeLen - wl) * 0.58;
    wing = ridgeAlongX ? { x: w0, y: rr.y, w: wl, h: rr.h } : { x: rr.x, y: w0, w: rr.w, h: wl };
  } else if (plan === 'cross') {
    const wl = ridgeLen * (0.3 + hash(i, 242) * 0.15);
    const start = ridgeAlongX ? rr.x : rr.y;
    const c = start + ridgeLen * (0.28 + hash(i, 243) * 0.44);
    const w0 = Math.max(start + 0.3, Math.min(start + ridgeLen - wl - 0.3, c - wl / 2));
    wing = ridgeAlongX ? { x: w0, y: rr.y, w: wl, h: rr.h } : { x: rr.x, y: w0, w: rr.w, h: wl };
  }

  // lean-to annex against a wall that is not the door wall. Never on a church
  // and never inside a range: both are the shed that breaks the silhouette.
  let lean: (Rect & { side: 'n' | 's' | 'e' | 'w' }) | null = null;
  if (!sacred && !terraced && hash(i, 244) < 0.3) {
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
  if (!sacred && plan !== 'cross' && mat !== 'iron' && nwDepth >= 2.2 && b.w * b.h >= 45) {
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
  // A church has no hearth. A terrace stacks its flues ON the party wall, one
  // per joint, which is the rhythm that reads the range as separate dwellings
  // once the ridge below them has been made continuous.
  const chimneys: Rect[] = [];
  if (!sacred) {
    if (terraced) chimneys.push(stackAt(party[1] ? 0.9 : 0.5));
    else {
      chimneys.push(stackAt(t0));
      if (b.w * b.h >= 70) chimneys.push(stackAt(1 - t0));
    }
  }

  const wr = hash(i, 260);
  const wall: WallMat = sacred ? 'rubble' : wr < 0.15 ? 'brick' : wr < 0.5 ? 'colombage' : 'rubble';
  const wbase = hexToRgb(WALL_BASES[wall]);
  // Openings come from the map, not from decoration: mapgen puts a window at
  // every third edge tile and the door mid-span, which is what terrain.ts
  // already strokes, so the face lines up with the walls the player sees.
  const openS = new Uint8Array(b.w);
  for (let k = 0; k < b.w; k++) openS[k] = map.hEdge(b.x + k, b.y + b.h);
  const openE = new Uint8Array(b.h);
  for (let k = 0; k < b.h; k++) openE[k] = map.vEdge(b.x + b.w, b.y + k);

  // Belfry plus slate spire is ~12 m of stone above the eave the walls stop
  // at, so its shadow reaches far past the tower's own. That long finger
  // across the churchyard is the ONLY thing carrying the tower's height now
  // that the apex is drawn centred in plan — and at the far-LOD camera, where
  // the roof itself is 15 px wide, it is the whole church read.
  const spireCast = plan === 'spire' ? 12 : 0;
  const spireCross = role === 'church' ? Math.min(1.5, spanLen * 0.2) : 0;
  const [csdx, csdy] = shadowOffset(1.1 * stories + spireCast);
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
    key: i,
    mat,
    ridgeAlongX,
    plan,
    hipEnds,
    verge,
    party,
    spireCast,
    spireCross,
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
    // a thrown tile lands dirty side up and has no slope facing the sun, so the
    // ramp is centred BELOW the mean slope value — at the mean it read as pale
    // confetti scattered over a dark slate roof
    dmgTones: ramp(weathered, ((litV + shadeV) / 2) * 0.85, (litW + shadeW) / 2, 0.25),
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
    smoke: !sacred && mat !== 'iron' && hash(i, 272) < 0.45,
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
function gablePair(
  g: CanvasRenderingContext2D,
  art: RoofArt,
  i: number,
  band: number,
  r: Rect,
  along: boolean,
  frac: number,
  verge: [boolean, boolean],
): void {
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
  if (verge[0] || verge[1]) {
    // the barge board along each ridge end, not a dark triangle notch
    g.fillStyle = art.gable;
    const vg = 0.16;
    if (along) {
      if (verge[0]) g.fillRect(r.x, r.y, vg, r.h);
      if (verge[1]) g.fillRect(r.x + r.w - vg, r.y, vg, r.h);
    } else {
      if (verge[0]) g.fillRect(r.x, r.y, r.w, vg);
      if (verge[1]) g.fillRect(r.x, r.y + r.h - vg, r.w, vg);
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

// --- church tower (T15) ------------------------------------------------------
//
// The single highest-value crop in the town, so the tower is drawn as a TOWER
// rather than as a roof over a small square building: a stone belfry stage
// with louvred openings on all four faces, corner pinnacles, and a slate spire
// drawn in STRICT plan: the apex sits on the centre of the belfry square, so
// the pyramid is the X of four hip arrises you actually see from overhead. The
// height is sold entirely by the cast shadow — bakeShadow throws a long
// tapering finger with the finial cross at its tip — never by leaning the
// apex out of the footprint. Nothing here is rolled: the geometry is a
// function of the footprint alone, so the church is the same church on every
// seed and at every zoom band.
// Limestone, sitting a shade under the rubble wall base so the tower belongs
// to the same village. Brighter than this and the belfry reads as concrete.
const STONE_FACE = '#8f8879';
const STONE_LIT = '#a49c88';
const STONE_DEEP = '#645e51';
const STONE_VOID = '#1d1b17';

// A belfry opening: dressed surround, recessed void, and the louvre boards
// across it. `alongU` is true when the slats run along x (a north or south
// face) and false when they run along y. The void has to stay the darkest
// thing on the tower — a pale louvre is a vent, a black one is a bell.
function louvreInto(g: CanvasRenderingContext2D, r: Rect, alongU: boolean, band: number): void {
  const f = 0.06;
  g.fillStyle = STONE_LIT;
  g.fillRect(r.x - f, r.y - f, r.w + f * 2, r.h + f * 2);
  g.fillStyle = STONE_DEEP;
  g.fillRect(r.x - f, r.y + r.h, r.w + f * 2, f);
  g.fillStyle = STONE_VOID;
  g.fillRect(r.x, r.y, r.w, r.h);
  if (band < 16) return;
  // Three fat boards, not five hairlines: at 24 px/m the opening is fifteen
  // pixels deep and a fine louvre resolves as a solid black slot.
  g.fillStyle = 'rgba(158,150,131,0.5)';
  const n = 3;
  for (let k = 0; k < n; k++) {
    if (alongU) g.fillRect(r.x, r.y + (r.h * (k + 0.28)) / n, r.w, (r.h / n) * 0.44);
    else g.fillRect(r.x + (r.w * (k + 0.28)) / n, r.y, (r.w / n) * 0.44, r.h);
  }
}

// A cross seen from directly overhead. The staff is vertical in the world, so
// it projects to a POINT and the only limb with real length is the crossbar;
// the glyph is therefore a small world-axis `+` — a long stick leaning up-sun
// out of the roof, which is what this used to draw, is an elevation view.
// Everything that says "tall" is in the cast shadow, and that shadow is itself
// cross-shaped: the staff swept SE by shadowOffset(h), with the bar laid
// across it at the height the bar actually hangs. Outlined light and filled
// dark so it survives landing on a black belfry opening at 24 px/m and on pale
// limestone at 8.
function crossInto(g: CanvasRenderingContext2D, x: number, y: number, h: number, arm: number, barAlongX: boolean, band: number): void {
  const bx = barAlongX ? arm : 0;
  const by = barAlongX ? 0 : arm;
  const sx = barAlongX ? 0 : arm * 0.55; // the staff's token limb: no real plan length
  const sy = barAlongX ? arm * 0.55 : 0;
  const [fdx, fdy] = shadowOffset(h);
  const [bdx, bdy] = shadowOffset(h * 0.68);
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  g.lineCap = 'round';
  g.lineWidth = Math.max(0.09, 2.4 / band);
  g.strokeStyle = 'rgba(14,12,9,0.45)';
  line(x, y, x + fdx, y + fdy);
  line(x + bdx - bx, y + bdy - by, x + bdx + bx, y + bdy + by);
  g.lineWidth = Math.max(0.16, 4.2 / band); // the halo, so the dark core reads on anything
  g.strokeStyle = 'rgba(236,230,214,0.55)';
  line(x - bx, y - by, x + bx, y + by);
  line(x - sx, y - sy, x + sx, y + sy);
  g.lineWidth = Math.max(0.075, 2 / band);
  g.strokeStyle = '#241f1a';
  line(x - bx, y - by, x + bx, y + by);
  line(x - sx, y - sy, x + sx, y + sy);
  g.lineCap = 'butt';
}

function spireInto(g: CanvasRenderingContext2D, art: RoofArt, key: number, band: number): void {
  const r = art.rr;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const side = Math.min(r.w, r.h);
  const fine = band >= 16;

  // 1 — the belfry stage, as a stone slab with a lit NW lip and a SE undercut.
  // The gradient across it is what stops a big pale square reading as a card.
  g.fillStyle = STONE_FACE;
  g.fillRect(r.x, r.y, r.w, r.h);
  const wash = g.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  wash.addColorStop(0, 'rgba(238,232,216,0.24)');
  wash.addColorStop(0.55, 'rgba(238,232,216,0)');
  wash.addColorStop(1, 'rgba(18,17,14,0.26)');
  g.fillStyle = wash;
  g.fillRect(r.x, r.y, r.w, r.h);
  if (fine) {
    g.fillStyle = 'rgba(58,54,45,0.20)';
    for (let u = r.x + 0.55; u < r.x + r.w - 0.05; u += 0.55) g.fillRect(u, r.y, 0.035, r.h);
    for (let v = r.y + 0.55; v < r.y + r.h - 0.05; v += 0.55) g.fillRect(r.x, v, r.w, 0.035);
  }
  const lip = Math.max(0.1, side * 0.028);
  g.fillStyle = STONE_LIT;
  g.fillRect(r.x, r.y, r.w, lip);
  g.fillRect(r.x, r.y, lip, r.h);
  g.fillStyle = 'rgba(14,12,9,0.45)';
  g.fillRect(r.x, r.y + r.h - lip, r.w, lip);
  g.fillRect(r.x + r.w - lip, r.y, lip, r.h);

  // 2 — belfry openings on all four faces. Foreshortened from above, but all
  // four are there: a tower with two louvres reads as a shed with two vents.
  const lw = side * 0.4;
  const ld = side * 0.105;
  const inset = side * 0.032;
  louvreInto(g, { x: cx - lw / 2, y: r.y + inset, w: lw, h: ld }, true, band);
  louvreInto(g, { x: cx - lw / 2, y: r.y + r.h - inset - ld, w: lw, h: ld }, true, band);
  louvreInto(g, { x: r.x + inset, y: cy - lw / 2, w: ld, h: lw }, false, band);
  louvreInto(g, { x: r.x + r.w - inset - ld, y: cy - lw / 2, w: ld, h: lw }, false, band);

  // 3 — the spire. Four slated triangles meeting at an apex CENTRED on the
  // belfry square: from directly overhead a pyramid is an X of hip arrises and
  // nothing else. What separates the two sun-facing planes from the two shaded
  // ones is value, not a lean — the lean was an oblique projection, and the
  // height it was faking now lives in bakeShadow's spire finger.
  const ss = side * 0.7;
  const sp: Rect = { x: cx - ss / 2, y: cy - ss / 2, w: ss, h: ss };
  const ax = cx;
  const ay = cy;
  // The scrim is what separates the two lit faces from each other and the two
  // shaded ones from each other: four planes at two values reads as two.
  const faces: {
    tri: [number, number][];
    tx: number;
    ty: number;
    m: [number, number, number, number];
    u: number;
    v: number;
    lit: boolean;
    salt: number;
    scrim: string;
  }[] = [
    // north: v runs from the apex plane out to the base edge, i.e. -y
    { tri: [[sp.x, sp.y], [sp.x + ss, sp.y], [ax, ay]], tx: sp.x, ty: ay, m: [1, 0, 0, -1], u: ss, v: ay - sp.y, lit: true, salt: 31, scrim: 'rgba(252,248,238,0.22)' },
    { tri: [[sp.x, sp.y + ss], [sp.x + ss, sp.y + ss], [ax, ay]], tx: sp.x, ty: ay, m: [1, 0, 0, 1], u: ss, v: sp.y + ss - ay, lit: false, salt: 37, scrim: 'rgba(8,9,12,0.26)' },
    { tri: [[sp.x, sp.y], [sp.x, sp.y + ss], [ax, ay]], tx: ax, ty: sp.y, m: [0, 1, -1, 0], u: ss, v: ax - sp.x, lit: true, salt: 41, scrim: 'rgba(252,248,238,0.07)' },
    { tri: [[sp.x + ss, sp.y], [sp.x + ss, sp.y + ss], [ax, ay]], tx: ax, ty: sp.y, m: [0, 1, 1, 0], u: ss, v: sp.x + ss - ax, lit: false, salt: 43, scrim: 'rgba(8,9,12,0.09)' },
  ];
  for (const f of faces) {
    g.save();
    g.beginPath();
    g.moveTo(f.tri[0][0], f.tri[0][1]);
    g.lineTo(f.tri[1][0], f.tri[1][1]);
    g.lineTo(f.tri[2][0], f.tri[2][1]);
    g.closePath();
    g.clip();
    g.save();
    g.translate(f.tx, f.ty);
    g.transform(f.m[0], f.m[1], f.m[2], f.m[3], 0, 0);
    slopeInto(g, art, key + f.salt, band, f.u, f.v, f.lit);
    g.restore();
    g.fillStyle = f.scrim;
    g.fillRect(sp.x, sp.y, ss, ss);
    g.restore();
  }
  // the four hip arrises, dark-cored with a bone highlight so they read
  // whichever pair of faces they happen to divide
  g.lineWidth = Math.max(0.07, 2 / band);
  g.strokeStyle = 'rgba(16,15,14,0.5)';
  g.beginPath();
  for (const c of [[sp.x, sp.y], [sp.x + ss, sp.y], [sp.x, sp.y + ss], [sp.x + ss, sp.y + ss]]) {
    g.moveTo(c[0], c[1]);
    g.lineTo(ax, ay);
  }
  g.stroke();
  g.lineWidth = Math.max(0.035, 1 / band);
  g.strokeStyle = 'rgba(230,226,214,0.42)';
  g.beginPath();
  for (const c of [[sp.x, sp.y], [sp.x + ss, sp.y], [sp.x, sp.y + ss], [sp.x + ss, sp.y + ss]]) {
    g.moveTo(c[0] - 0.03, c[1] - 0.035);
    g.lineTo(ax - 0.03, ay - 0.035);
  }
  g.stroke();

  // 4 — corner pinnacles, after the spire so they stand in front of its base
  const pin = side * 0.13;
  const [px, py] = shadowOffset(0.55);
  for (const c of [
    [r.x, r.y],
    [r.x + r.w - pin, r.y],
    [r.x, r.y + r.h - pin],
    [r.x + r.w - pin, r.y + r.h - pin],
  ]) {
    g.fillStyle = 'rgba(14,12,9,0.40)';
    g.fillRect(c[0] + px, c[1] + py, pin, pin);
    g.fillStyle = STONE_FACE;
    g.fillRect(c[0], c[1], pin, pin);
    g.fillStyle = STONE_LIT;
    g.fillRect(c[0], c[1], pin, pin * 0.34);
    g.fillRect(c[0], c[1], pin * 0.34, pin);
    g.fillStyle = STONE_DEEP;
    g.fillRect(c[0], c[1] + pin * 0.72, pin, pin * 0.28);
    g.fillRect(c[0] + pin * 0.72, c[1], pin * 0.28, pin);
  }

  // 5 — the cross finial, in plan. Its real shadow is 20 m of churchyard and
  // belongs to the ground pass (bakeShadow), so the one drawn here is only the
  // short throw across the SE slope right beside it — anything longer walks
  // off the sprite.
  g.fillStyle = STONE_LIT;
  g.beginPath();
  g.arc(ax, ay, Math.max(0.08, side * 0.03), 0, TAU);
  g.fill();
  crossInto(g, ax, ay, side * 0.2, side * 0.13, art.ridgeAlongX, band);
}

// A party wall carried up through the roof. Drawn only at a unit's LO joint so
// each shared wall gets exactly one band, and with its own cast shadow falling
// INTO this unit — the SE neighbour is a separate sprite drawn later and would
// paint over anything thrown that way.
function parapetInto(g: CanvasRenderingContext2D, art: RoofArt, band: number): void {
  const r = art.rr;
  const along = art.ridgeAlongX;
  const t = 0.3;
  const [sdx, sdy] = shadowOffset(0.5);
  g.fillStyle = 'rgba(14,12,9,0.34)';
  if (along) g.fillRect(r.x + t, r.y + sdy, sdx, r.h - sdy);
  else g.fillRect(r.x + sdx, r.y + t, r.w - sdx, sdy);
  g.fillStyle = '#8a8374';
  if (along) g.fillRect(r.x, r.y, t, r.h);
  else g.fillRect(r.x, r.y, r.w, t);
  g.fillStyle = 'rgba(230,222,204,0.32)'; // coping, lit on its NW arris
  if (along) g.fillRect(r.x, r.y, t * 0.38, r.h);
  else g.fillRect(r.x, r.y, r.w, t * 0.38);
  g.fillStyle = 'rgba(16,13,10,0.42)';
  if (along) g.fillRect(r.x + t * 0.68, r.y, t * 0.32, r.h);
  else g.fillRect(r.x, r.y + t * 0.68, r.w, t * 0.32);
  if (band < 16) return;
  g.fillStyle = 'rgba(60,54,44,0.30)'; // coping joints
  if (along) for (let v = r.y + 0.5; v < r.y + r.h; v += 0.5) g.fillRect(r.x, v, t, 0.035);
  else for (let u = r.x + 0.5; u < r.x + r.w; u += 0.5) g.fillRect(u, r.y, 0.035, t);
}

// Impact damage, painted last so it cuts through courses, dormers and stacks
// alike. Hash keys are the quantized impact in quarter-metres, so the same
// crater comes back identical at every band and after every rebake.
function holeKeys(d: Damage): [number, number] {
  return [Math.round(d.x * 4), Math.round(d.y * 4)];
}

function holeRadius(d: Damage): number {
  const [hx, hy] = holeKeys(d);
  return 0.7 + hash(hx, hy, 289) * 0.5;
}

function holePath(g: CanvasRenderingContext2D, d: Damage): void {
  const [hx, hy] = holeKeys(d);
  g.beginPath();
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU;
    const rad = 0.7 + hash(hx, hy, 290 + k) * 0.5;
    const px = d.x + Math.cos(a) * rad;
    const py = d.y + Math.sin(a) * rad;
    if (k === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
}

// One flung tile/slate/straw wad: parent material, off-value, off-angle, with
// its own short contact shadow so it reads as lying ON the roof, not in it.
function shard(g: CanvasRenderingContext2D, art: RoofArt, x: number, y: number, rot: number, tone: string): void {
  const sp = MAT_SPEC[art.mat === 'slate' ? 'slate' : 'tile'];
  const tw = art.mat === 'thatch' || art.mat === 'iron' ? 0.26 : sp.tileW;
  const th = art.mat === 'thatch' || art.mat === 'iron' ? 0.2 : sp.course * 0.8;
  const [sx, sy] = shadowOffset(0.09);
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = 'rgba(16,13,10,0.45)';
  g.fillRect(-tw / 2 + sx, -th / 2 + sy, tw, th);
  g.fillStyle = tone;
  g.fillRect(-tw / 2, -th / 2, tw, th);
  g.fillStyle = 'rgba(226,214,196,0.12)';
  g.fillRect(-tw / 2, -th / 2, tw, Math.min(0.05, th * 0.3));
  g.restore();
}

function damageInto(g: CanvasRenderingContext2D, art: RoofArt, d: Damage, band: number): void {
  const [hx, hy] = holeKeys(d);
  const r0 = holeRadius(d);

  // soot first: it belongs under the ejecta, and it is the whole read at band 8
  const sr = r0 * 2;
  const soot = g.createRadialGradient(d.x, d.y, 0, d.x, d.y, sr);
  soot.addColorStop(0, DMG_SOOT);
  soot.addColorStop(1, 'rgba(24,20,16,0)');
  g.fillStyle = soot;
  g.beginPath();
  g.arc(d.x, d.y, sr, 0, TAU);
  g.fill();

  if (!d.direct) {
    // near miss: the blast lifted a few courses, it did not open the roof
    if (band < 16) return;
    const n = 3 + ((hash(hx, hy, 461) * 3) | 0);
    for (let k = 0; k < n; k++) {
      const a = hash(hx, hy, 300 + k) * TAU;
      const rad = r0 * (0.4 + hash(hx, hy, 310 + k) * 0.7);
      const sxp = d.x + Math.cos(a) * rad;
      const syp = d.y + Math.sin(a) * rad;
      g.fillStyle = 'rgba(20,16,12,0.5)'; // the gap the slate slid out of
      g.fillRect(sxp - 0.13, syp - 0.1, 0.26, 0.2);
      shard(g, art, sxp + 0.1, syp + 0.08, (10 + hash(hx, hy, 320 + k) * 15) * (Math.PI / 180), art.dmgTones[(hash(hx, hy, 330 + k) * TONE_STEPS) | 0]);
    }
    return;
  }

  holePath(g, d);
  g.fillStyle = DMG_VOID;
  g.fill();

  if (band >= 16) {
    // rafters, snapped off over the void — perpendicular to the ridge, on a
    // world-aligned grid so two holes in one roof show the same timber run
    g.save();
    holePath(g, d);
    g.clip();
    const along = art.ridgeAlongX; // ridge runs along x → rafters run along y
    const lo = (along ? d.x : d.y) - 1.3;
    const hi = (along ? d.x : d.y) + 1.3;
    const [rsx, rsy] = shadowOffset(0.18);
    const c = along ? d.y : d.x;
    for (let u = Math.ceil(lo / 0.42) * 0.42, j = 0; u < hi; u += 0.42, j++) {
      // One timber in three is snapped, and the break has to land INSIDE the
      // hole (scaled by its radius) or the clip eats it and the rank reads as
      // an unbroken floor grille rather than a roof that was blown open.
      const snap = hash(hx, hy, 440 + j);
      let v0 = c - 1.3;
      let v1 = c + 1.3;
      if (snap < 0.3) v0 = c - r0 * (0.1 + snap * 2);
      else if (snap > 0.8) v1 = c + r0 * (0.1 + (1 - snap) * 4);
      const len = v1 - v0;
      g.fillStyle = 'rgba(20,16,12,0.7)';
      if (along) g.fillRect(u + rsx, v0 + rsy, 0.06, len);
      else g.fillRect(v0 + rsx, u + rsy, len, 0.06);
      g.fillStyle = 'rgba(112,92,64,0.8)';
      if (along) g.fillRect(u, v0, 0.06, len);
      else g.fillRect(v0, u, len, 0.06);
    }
    g.restore();

    // the rim of tiles the blast threw clear
    const n = 8 + ((hash(hx, hy, 460) * 7) | 0); // 290..298 is the vertex-radius stream — do not reuse it here
    for (let k = 0; k < n; k++) {
      const a = hash(hx, hy, 340 + k) * TAU;
      const rad = r0 + 0.1 + hash(hx, hy, 360 + k) * 0.4;
      const rot = (10 + hash(hx, hy, 380 + k) * 15) * (Math.PI / 180) * (hash(hx, hy, 400 + k) < 0.5 ? -1 : 1);
      shard(g, art, d.x + Math.cos(a) * rad, d.y + Math.sin(a) * rad, rot, art.dmgTones[(hash(hx, hy, 420 + k) * TONE_STEPS) | 0]);
    }
  }

  // charred lip: the tiles that stayed put are burnt where the round went in
  g.strokeStyle = 'rgba(30,24,18,0.55)';
  g.lineWidth = Math.max(0.05, 2 / band);
  holePath(g, d);
  g.stroke();
}

function drawRoof(g: CanvasRenderingContext2D, art: RoofArt, band: number, damage: Damage[] = []): void {
  const i = art.key;
  const r = art.rr;
  const along = art.ridgeAlongX;
  if (art.plan === 'spire') {
    spireInto(g, art, i, band);
    drawRoofTrim(g, art, band, damage);
    return;
  }

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

  gablePair(g, art, i, band, r, along, art.fracNW, art.verge);

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
    for (let ei = 0; ei < ends.length; ei++) {
      // A half-hip: the end that butts another mass of the same structure gets
      // no hip plane at all, so an apse runs straight into its nave.
      if (!art.hipEnds[ei]) continue;
      const e = ends[ei];
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
    gablePair(g, art, i + 3, band, wg, !along, 0.5, [true, true]);
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

  // A gable cross on each free end of the transept. The nave's own gable ends
  // butt the tower and the apse, so these two are the only apexes the church
  // has left — and they are what keeps the nave reading as a nave at 24 px/m,
  // where the spire beside it is a dozen pixels of slate.
  if (art.wing && art.spireCross > 0) {
    const wg = art.wing;
    const fl = art.spireCross;
    // A gable cross stands a metre or so proud of the apex it sits on, so its
    // shadow is a short cross laid on the slope beside it — long enough to
    // read at 24 px/m, short enough to stay inside the eave and PAD_SE.
    const arm = fl * 0.42;
    if (along) {
      crossInto(g, wg.x + wg.w / 2, wg.y + 0.2, fl * 0.5, arm, true, band);
      crossInto(g, wg.x + wg.w / 2, wg.y + wg.h - 0.2, fl * 0.5, arm, true, band);
    } else {
      crossInto(g, wg.x + 0.2, wg.y + wg.h / 2, fl * 0.5, arm, false, band);
      crossInto(g, wg.x + wg.w - 0.2, wg.y + wg.h / 2, fl * 0.5, arm, false, band);
    }
  }

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

  // the party wall between this unit and its up-street neighbour, on top of
  // everything the two of them share
  if (art.party[0]) parapetInto(g, art, band);

  drawRoofTrim(g, art, band, damage);
}

// Damage, eave outline and the eave's own shadow — the part every plan ends
// with, spire included.
function drawRoofTrim(g: CanvasRenderingContext2D, art: RoofArt, band: number, damage: Damage[]): void {
  const r = art.rr;
  // Battle damage, clipped to the roof planes. A hole that spilled past the
  // eave would read as a breached WALL, which is a lie: the sim still gives
  // this building full cover and a soldier can still walk the ground floor.
  if (damage.length) {
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    if (art.wing) g.rect(art.wing.x, art.wing.y, art.wing.w, art.wing.h);
    if (art.lean) g.rect(art.lean.x, art.lean.y, art.lean.w, art.lean.h);
    g.clip();
    for (const d of damage) damageInto(g, art, d, band);
    g.restore();
  }

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

function bakeRoof(art: RoofArt, band: number, damage: Damage[]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(art.ow * band));
  c.height = Math.max(1, Math.round(art.oh * band));
  const g = c.getContext('2d')!;
  g.scale(band, band);
  g.translate(-art.ox, -art.oy);
  drawRoof(g, art, band, damage);
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
  if (art.spireCast > 0) {
    // A spire throws a tapering finger far past the tower's own shadow. At the
    // far-LOD camera the tower is fifteen pixels of dark slate and this is what
    // tells the player which fifteen pixels they are.
    const [tdx, tdy] = shadowOffset(1.1 * stories + art.spireCast);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const side = Math.min(r.w, r.h);
    // ACROSS the sun, not along it: the base of the finger is the spire's own
    // width seen square to the light.
    const px = -SUN.dy;
    const py = SUN.dx;
    // The tip keeps a little width instead of vanishing to a point — the top
    // courses and the finial are what the eye actually finds out here, and the
    // last third of a true cone taper is sub-metre and reads as nothing.
    const finger = (base: number, tip: number): void => {
      g.beginPath();
      g.moveTo(cx + sdx + px * base, cy + sdy + py * base);
      g.lineTo(cx + sdx - px * base, cy + sdy - py * base);
      g.lineTo(cx + tdx - px * tip, cy + tdy - py * tip);
      g.lineTo(cx + tdx + px * tip, cy + tdy + py * tip);
      g.closePath();
      g.fill();
    };
    g.filter = `blur(${(0.4 * band).toFixed(2)}px)`;
    g.fillStyle = `rgba(12,15,10,${SHADOW_SOFT_ALPHA})`;
    finger(side * 0.3, side * 0.14);
    g.filter = `blur(${(0.12 * band).toFixed(2)}px)`;
    g.fillStyle = `rgba(12,15,10,${SHADOW_ALPHA})`;
    finger(side * 0.24, side * 0.09);
    // The finial at the tip. A vertical cross throws a cross-shaped shadow,
    // and this one lands on open churchyard — which is what tells the player
    // the finger is a SPIRE and not a chimney or a wall.
    const arm = side * 0.18;
    const bx = art.ridgeAlongX ? arm : 0;
    const by = art.ridgeAlongX ? 0 : arm;
    const mx = cx + tdx - SUN.dx * arm * 0.7;
    const my = cy + tdy - SUN.dy * arm * 0.7;
    g.lineCap = 'round';
    g.lineWidth = Math.max(0.14, arm * 0.36);
    g.strokeStyle = `rgba(12,15,10,${SHADOW_ALPHA})`;
    g.beginPath();
    g.moveTo(mx - bx, my - by);
    g.lineTo(mx + bx, my + by);
    g.stroke();
    g.lineCap = 'butt';
  }
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

function bakeWall(b: Building, art: RoofArt, band: number, south: boolean): HTMLCanvasElement {
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
    art.key,
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

// --- structure grouping (T15 / T17) ------------------------------------------
//
// Two things in the contract mean "these masses are ONE structure": a
// `terraceRun` (a party-wall range along one frontage) and a `groupId` (a
// church's nave + tower + apse). Both want the same treatment where their
// masses touch — no overhang across the joint — and a terrace additionally
// wants one ridge, one axis and one material for the whole range.
//
// Pure and exported so the art gate can assert the grouping on a real bourg
// plan without a canvas: RoofLayer only ever consumes what this returns.
export function artContexts(buildings: Building[], stories: number[]): ArtCtx[] {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < buildings.length; i++) {
    const t = buildings[i].terraceRun;
    if (t === undefined) continue;
    const a = runs.get(t) ?? [];
    a.push(i);
    runs.set(t, a);
  }

  const info = new Map<number, { key: number; along: boolean; ridge: number; stories: number }>();
  for (const [t, idx] of runs) {
    if (idx.length < 2) continue; // a run of one is just a house — leave it its variety
    const first = buildings[idx[0]];
    // Ridge parallel to the street: a frontage on n/s puts the run along x.
    const along = first.frontage === 'n' || first.frontage === 's' ? true : first.frontage ? false : first.w >= first.h;
    // Median centre line, not mean: one unusually deep unit must not drag the
    // whole range's ridge off the frontage.
    const mid = idx
      .map((i) => (along ? buildings[i].y + buildings[i].h / 2 : buildings[i].x + buildings[i].w / 2))
      .sort((a, b) => a - b);
    let key = 0;
    let st = 0;
    for (const i of idx) {
      key += artKey(buildings[i]); // an order-independent sum, so the run key survives a reorder too
      st = Math.max(st, stories[i]);
    }
    info.set(t, { key, along, ridge: mid[mid.length >> 1], stories: st });
  }

  const kin = (a: Building, b: Building): boolean =>
    (a.terraceRun !== undefined && a.terraceRun === b.terraceRun) || (a.groupId !== undefined && a.groupId === b.groupId);

  return buildings.map((b) => {
    const butt: Sides = { n: false, s: false, e: false, w: false };
    for (const o of buildings) {
      if (o === b || !kin(b, o)) continue;
      const ovX = o.x < b.x + b.w && b.x < o.x + o.w;
      const ovY = o.y < b.y + b.h && b.y < o.y + o.h;
      if (ovY && o.x + o.w === b.x) butt.w = true;
      if (ovY && b.x + b.w === o.x) butt.e = true;
      if (ovX && o.y + o.h === b.y) butt.n = true;
      if (ovX && b.y + b.h === o.y) butt.s = true;
    }
    const run = b.terraceRun === undefined ? undefined : info.get(b.terraceRun);
    let alongX: boolean | null = run ? run.along : null;
    if (b.role === 'church_apse' || b.role === 'church_tower') {
      // the apse continues the nave's ridge, whichever way the nave was laid
      const nave = buildings.find((o) => o.role === 'church' && o.groupId !== undefined && o.groupId === b.groupId);
      if (nave) alongX = nave.w >= nave.h;
    }
    return {
      butt,
      alongX,
      ridge: run ? run.ridge : null,
      runKey: run ? run.key : null,
      runStories: run ? run.stories : 0,
    };
  });
}

// --- bake queue (T22) --------------------------------------------------------

// On-screen first. A band change queues every building in the town, and
// draining that in index order spends the first second baking roofs behind the
// camera while the ones the player is looking at hold the previous band.
export function nextBake(queue: number[], onScreen: (i: number) => boolean): number {
  for (let k = 0; k < queue.length; k++) if (onScreen(queue[k])) return queue.splice(k, 1)[0];
  return queue.shift()!;
}

// Milliseconds this frame may spend baking. The first band after a buildings
// change drains in one go (it lands on the paused boot frame, where a stall
// costs nothing); after that a moving camera gets the trickle and a still one
// gets the inspection budget. BAKES_PER_FRAME is a floor underneath this, so a
// band whose sprites each overrun the whole budget still drains.
export function bakeBudgetMs(prewarm: boolean, still: number): number {
  if (prewarm) return Infinity;
  return still >= STILL_FRAMES ? BAKE_MS_STATIC : BAKE_MS;
}

interface Baked {
  roof: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
  wallS: HTMLCanvasElement;
  wallE: HTMLCanvasElement;
  ver: number; // damage version this was baked at — stale sprites keep serving until the rebake lands
}

export class RoofLayer {
  private buildings: Building[] = [];
  private alphas: number[] = [];
  private art: RoofArt[] = [];
  private stories: number[] = []; // per-building story count for shadow length, min 1
  private zoomFaded = false;
  private damage: Damage[][] = [];
  private dmgVer: number[] = [];
  private sprites = new Map<number, (Baked | null)[]>();
  private band = 0;
  private prevBand = 0;
  private queue: number[] = [];
  private prewarm = true;
  private tick = 0;
  private frame = 0;
  private pumpedAt = -1; // the budget is per FRAME, not per draw call — two passes pump
  private camPose = Number.NaN;
  private still = 0;

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
      const ctx = artContexts(this.buildings, this.stories);
      this.art = this.buildings.map((b, i) => buildArt(b, this.stories[i], this.smallOfPair(i), sim.map, ctx[i] ?? SOLO));
      // Damage is per-battle render state and nothing else: a new buildings
      // list is a new battle, and every hole goes with it.
      this.damage = this.buildings.map(() => []);
      this.dmgVer = this.buildings.map(() => 0);
      this.sprites.clear();
      this.band = 0;
      this.prevBand = 0;
      this.queue = [];
      this.prewarm = true;
    }
    this.tick = sim.tick;
    this.frame++;
    // T22. Stillness is measured on the camera pose alone: a paused inspection
    // and an idle player both hold it, and both are frames with budget to burn.
    const pose = cam.x * 8192 + cam.y * 31 + cam.scale * 1e6;
    if (pose === this.camPose) this.still++;
    else {
      this.camPose = pose;
      this.still = 0;
    }
    if (cam.scale > FADE_SCALE) this.zoomFaded = true;
    else if (cam.scale < FADE_SCALE_RESTORE) this.zoomFaded = false;
    this.buildings.forEach((b, i) => {
      // Occupancy reveal on every floor, gated on the sim's own visibility
      // helper — the same rule upper floors already used, extended down to the
      // ground floor. The renderer still never re-derives vision, so a house
      // only opens for a soldier the player can already see.
      //
      // `?fow=0` is excluded for enemies on purpose: it is a debug switch, not
      // an observation, and letting it through turns the rule into "open every
      // occupied house", which is a different rule from the one designed here
      // and leaves nothing to look at in the art gate (which runs fog off).
      const seen = (s: Soldier): boolean => s.side === 'blue' || (!sim.fowDisabled && sim.soldierVisibleTo('blue', s));
      const inside = sim.soldiers.some(
        (s) => s.alive && s.x >= b.x && s.x < b.x + b.w && s.y >= b.y && s.y < b.y + b.h && seen(s),
      );
      const target = this.zoomFaded || inside ? FADED_ALPHA : 1;
      const a = this.alphas[i];
      this.alphas[i] = a + (target - a) * Math.min(1, dt * 6);
    });
  }

  // A detonation the player watched land, filed against the nearest roof.
  // Render-only: no sim state is read or written, nothing persists past the
  // battle, and the bake itself is deferred to the amortized queue — a barrage
  // that walks across four houses must never bake four roofs inside one frame.
  noteImpact(x: number, y: number): void {
    let hit = -1;
    let best = DMG_NEAR;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      const d = Math.hypot(dx, dy);
      if (d <= best) {
        best = d;
        hit = i;
      }
    }
    if (hit < 0) return;
    const list = this.damage[hit];
    if (list.length >= DMG_CAP) return;
    // A near miss is anchored on the roof edge nearest the blast, not at the
    // detonation itself: the damage pass is clipped to the roof planes, so a
    // point 1 m off the wall would paint its scorch entirely into the clip and
    // leave the roof pristine beside a crater. Clamping is also the truer
    // read — what the overpressure did was wash over that eave.
    const nb = this.buildings[hit];
    const qx = Math.round(Math.max(nb.x + 0.15, Math.min(nb.x + nb.w - 0.15, x)) * 4) / 4;
    const qy = Math.round(Math.max(nb.y + 0.15, Math.min(nb.y + nb.h - 0.15, y)) * 4) / 4;
    for (const d of list) if (Math.hypot(d.x - qx, d.y - qy) < DMG_MERGE) return;
    list.push({ x: qx, y: qy, direct: best === 0 });
    this.dmgVer[hit]++;
    if (!this.queue.includes(hit)) this.queue.push(hit);
  }

  // True when building i is the smaller half of a pair standing within 4 m —
  // mapgen's farm house+barn, where the small one is the outbuilding.
  private smallOfPair(i: number): boolean {
    const b = this.buildings[i];
    // N2. Inside a party-wall range EVERY unit stands within 4 m of a bigger
    // neighbour, so this heuristic would thatch the whole high street. A
    // terraced unit is a dwelling on the street, never an outbuilding.
    if (b.terraceRun !== undefined) return false;
    const area = b.w * b.h;
    for (let j = 0; j < this.buildings.length; j++) {
      if (j === i) continue;
      const o = this.buildings[j];
      // …and a church tower is not its own nave's shed
      if (b.groupId !== undefined && o.groupId === b.groupId) continue;
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
    // a sprite baked before this building took a hit is stale, not missing —
    // it keeps drawing (no blink) but has to be redrawn at the new band too
    for (let i = 0; i < this.buildings.length; i++) if (!cur[i] || cur[i]!.ver !== this.dmgVer[i]) this.queue.push(i);
  }

  // Amortized bake. The first band after a buildings change drains in one go —
  // that lands on the paused boot frame, where a stall costs nothing; every
  // later band change trickles while the previous band keeps serving. T22: the
  // trickle is ordered by on-screen-ness and widened while the camera is still,
  // because a 65-building bourg is 65 queue entries and draining that two a
  // frame in index order is two seconds of pop-in in the wrong half of town.
  private pump(cam: Camera, cw: number, ch: number): void {
    if (!this.queue.length || this.pumpedAt === this.frame) return;
    this.pumpedAt = this.frame;
    const cur = this.sprites.get(this.band)!;
    const budget = bakeBudgetMs(this.prewarm, this.still);
    const t0 = performance.now();
    // the shadow is blurred to begin with, so half resolution is free
    const sBand = Math.max(8, this.band / 2);
    for (let k = 0; this.queue.length; k++) {
      if (k >= BAKES_PER_FRAME && performance.now() - t0 >= budget) break;
      const i = nextBake(this.queue, (j) => this.onScreen(cam, j, cw, ch, 2));
      const b = this.buildings[i];
      const art = this.art[i];
      cur[i] = {
        roof: bakeRoof(art, this.band, this.damage[i]),
        // walls and shadow are damage-independent; a rebake driven by a hit
        // reuses them rather than redrawing masonry that did not change
        shadow: cur[i]?.shadow ?? bakeShadow(b, art, this.stories[i], sBand),
        wallS: cur[i]?.wallS ?? bakeWall(b, art, this.band, true),
        wallE: cur[i]?.wallE ?? bakeWall(b, art, this.band, false),
        ver: this.dmgVer[i],
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
    this.pump(cam, cw, ch);
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
    this.pump(cam, cw, ch);
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
    // one wisp writer for both sources: a hearth plume and a shell-hole plume
    // differ only in origin, tone and how far they get before they thin out
    const wisp = (cx: number, cy: number, life: number, k: number, reach: number, rad0: number, grow: number, rgb: string, peak: number): void => {
      const wob = Math.sin(life * 6 + k) * 0.25 * life;
      const px = cx + WIND.dx * life * reach - WIND.dy * wob;
      const py = cy + WIND.dy * life * reach + WIND.dx * wob;
      const rad = rad0 + life * grow;
      // a soft core, not a disc — this has to read as haze over a roof,
      // never as a sprite that got its ordering wrong
      const gr = ctx.createRadialGradient(px, py, 0, px, py, rad);
      gr.addColorStop(0, `rgba(${rgb},${(peak * (1 - life)).toFixed(3)})`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, TAU);
      ctx.fill();
    };
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      for (let i = 0; i < this.buildings.length; i++) {
        const art = this.art[i];
        const dmg = this.damage[i];
        if (!art.smoke && !dmg.length) continue;
        if (!this.onScreen(cam, i, cw, ch, 4)) continue;
        const a = this.alphas[i];
        if (a < 0.05) continue;
        if (art.smoke) {
          const n = 3 + ((hash(art.key, 274) * 2) | 0);
          for (const st of art.chimneys) {
            const cx = st.x + st.w / 2;
            const cy = st.y + st.h / 2;
            for (let k = 0; k < n; k++) {
              const life = (t * 0.45 + k / n + hash(art.key, 273 + k)) % 1;
              wisp(cx, cy, life, k, 3.2, 0.18, 0.7, '196,190,178', 0.26 * a);
            }
          }
        }
        // A holed roof smoulders. Greyer, fatter and slower than a hearth, so a
        // shelled village reads as damaged from across the field.
        for (let j = 0; j < dmg.length; j++) {
          const d = dmg[j];
          if (!d.direct) continue;
          for (let k = 0; k < 3; k++) {
            const life = (t * 0.3 + k / 3 + hash(art.key, j, 292 + k)) % 1;
            wisp(d.x, d.y, life, k + j * 3, 4.2, 0.4, 1.4, '140,132,120', 0.22 * a);
          }
        }
      }
    });
  }
}
