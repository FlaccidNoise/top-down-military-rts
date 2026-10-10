import { TERRAIN, type TerrainKey } from '../sim/data';
import { BREACH_WIDE, EDGE, type GameMap } from '../sim/map';
import type { Building } from '../sim/mapgen';
import type { Camera } from './camera';
import { AO_ALPHA, SUN, SUN_PIN_BAND, capsulePath, shadowAlpha, shadowOffset, shadowOffsetLegible, shadowSoftAlpha, sun, sunStepFor } from './light';
import { MOBILE } from './view';

// Terrain is rendered lazily into 16x16-tile chunk canvases at the nearest
// zoom band >= camera scale (so it is only ever downscaled — always crisp),
// with an LRU pixel budget. Replaces the single fixed-resolution prerender,
// which could not survive the 2-48 px/m zoom range or 500x500 m maps.

const CHUNK = 16; // tiles per side
// Drop the top band on a phone: cam.maxScale is 32 there, so band 48 could
// only ever be baked and never displayed, and its chunk canvas is (48+2)*32 =
// 1600^2 = 2.6 Mpx against band 32's 1.1 Mpx.
const BANDS = MOBILE ? [4, 8, 16, 32] : [4, 8, 16, 32, 48];
// 24M px of cached RGBA is ~96 MB, on top of the dudes sprite cache and the
// decal atlas — over iOS Safari's practical canvas-memory tolerance and the
// most likely single cause of a killed tab.
const PIXEL_BUDGET = MOBILE ? 6_000_000 : 24_000_000;

// Detail tier per zoom band. A band-4 chunk covers 4x the ground of a band-16
// one, so drawing the same micro-detail there is pure waste that also aliases
// into fizz; a band-48 chunk starves without it. Every pass takes `d` and
// scales its op count off it — this is the budget lever the ground detail
// below is paid for with.
export type Detail = 0 | 1 | 2;
const detailFor = (band: number): Detail => (band >= 32 ? 2 : band >= 16 ? 1 : 0);

// A chunk bake costs 2-5 ms and a band change invalidates the whole keyspace,
// so one zoom step used to rebake every visible chunk in a single frame (~70
// chunks, ~300 ms). Amortization is only free when there is something correct
// to show meanwhile: a chunk already baked at another band downscales/upscales
// to the right content at the wrong sharpness. So the budget throttles only
// the chunks that HAVE such a fallback — which is exactly the band-change
// case — and a chunk with nothing cached at any band still bakes immediately
// rather than flashing a hole.
const BAKES_PER_FRAME = 3;

// The first battle frame is the one that kills a phone: nothing is cached, so
// the visible-chunk loop below runs an unbudgeted bake per chunk — at a mobile
// boot zoom that is ~50 chunks of hedge-capsule, tree, water-bank and
// hillshade passes in a single frame, i.e. seconds of frozen white screen.
// A phone therefore gets a hard per-frame cap and paints the rest flat until
// later frames finish them. Desktop is deliberately excluded: the art gate
// screenshots frame 1, so a desktop budget would reshoot every baseline.
const MOBILE_BAKES_PER_FRAME = 12;

// Tiles of overscan a chunk bakes beyond its own 16x16 (a tree planted in the
// next chunk overhangs into this one). It is also what makes invalidation
// non-local: an edge at tile x is DRAWN by every chunk whose padded range
// reaches it, so a breach at a chunk boundary dirties two chunks per axis.
const CHUNK_PAD = 2;

// Chunk indices along one axis whose padded bake range covers tiles [t0, t1].
// Chunk c bakes [c*CHUNK - PAD, c*CHUNK + CHUNK + PAD] INCLUSIVE — the edge
// loops in `chunk()` run to the inclusive bound on one axis each, so taking the
// inclusive bound on both is correct on one and one chunk conservative on the
// other, which costs a spare rebake and never a stale wall stub.
// Pure and exported so the neighbourhood arithmetic can be pinned without a
// canvas: getting it wrong leaves the old wall alive in a neighbour's gutter.
export function chunkSpan(t0: number, t1: number, n: number): [number, number] {
  return [
    Math.max(0, Math.ceil((t0 - CHUNK - CHUNK_PAD) / CHUNK)),
    Math.min(n - 1, Math.floor((t1 + CHUNK_PAD) / CHUNK)),
  ];
}

import { cornerCuts, cutOnH, cutOnV, HARD, reliefShade, smoothElev, tuftCount, type ReliefLight } from './ground';
import { buildHedgerows, hedgeLobes, type Hedgerows } from './hedgerow';
import { hash, soft, vec } from './noise';
import { stamp, stampRect } from './stamps';
import { SPRITE as CANOPY_SPRITE, canopySprite, drawLog } from './canopy';
import { PatchIndex, type BuildingBox, type Patch } from './patches';
import { buildYards, drawYardGround, drawYardStructures, type Yard } from './yards';
import { drawProp, propExtent, propsFor, type Prop } from './props';
import { EnclosureIndex, drawEnclosureGround, drawEnclosurePlanting, drawEnclosureWalls } from './enclos';
import { drawShopfronts, shopfrontsFor, type Shopfront } from './shops';
import { ROLE, buildingIndex, drawFurniture, drawHearthGlow, drawRugs, hearthTiles } from './furniture';
import { Versions } from './versions';

// Bilinear value noise on an 8m lattice — smooth patches, no hard square edges.
function coarse(x: number, y: number): number {
  const cx = x >> 3;
  const cy = y >> 3;
  const fx = (x & 7) / 8;
  const fy = (y & 7) / 8;
  const a = hash(cx, cy, 1) * (1 - fx) + hash(cx + 1, cy, 1) * fx;
  const b = hash(cx, cy + 1, 1) * (1 - fx) + hash(cx + 1, cy + 1, 1) * fx;
  return a * (1 - fy) + b * fy;
}

// Second octave on a ~28m lattice — macro patch/hue drift so no two fields or
// lawns match, per architecture.md rule 3 ("never grid-visible").
function macro(x: number, y: number): number {
  const cx = x / 28;
  const cy = y / 28;
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  const fx = cx - ix;
  const fy = cy - iy;
  const a = hash(ix, iy, 2) * (1 - fx) + hash(ix + 1, iy, 2) * fx;
  const b = hash(ix, iy + 1, 2) * (1 - fx) + hash(ix + 1, iy + 1, 2) * fx;
  return a * (1 - fy) + b * fy;
}

function shade(base: [number, number, number], f: number): string {
  return `rgb(${Math.round(base[0] * f)},${Math.round(base[1] * f)},${Math.round(base[2] * f)})`;
}

// Smooth interpolation across a palette ramp, 0..1 — used for macro-driven
// hue drift instead of a hard per-block color swap (stays "never grid-visible").
function blendPalette(stops: [number, number, number][], t: number): [number, number, number] {
  const n = stops.length - 1;
  const ft = Math.max(0, Math.min(1, t)) * n;
  const i = Math.min(n - 1, Math.floor(ft));
  const f = ft - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const GRASS: [number, number, number] = [85, 99, 64]; // #556340
const GRASS_DRY: [number, number, number] = [104, 108, 66]; // macro-drift patch variant
const ROAD: [number, number, number] = [124, 103, 76]; // warm dirt
const WOODS_GROUND: [number, number, number] = [61, 74, 51]; // #3d4a33
const HEDGE_GREEN: [number, number, number] = [72, 90, 48]; // yellower, denser than woods
const FLOOR: [number, number, number] = [160, 145, 122];
const FLOOR_DARK: [number, number, number] = [141, 120, 95];
const WATER: [number, number, number] = [70, 90, 99]; // desaturated slate, muted-Normandy — not postcard blue
// A bank is turf, so it draws the ordinary grass base and adds erosion — there
// is no BANK_EARTH tone any more. Ballast is its own material: TERRAIN.rail's
// colour as a triple, so the flat far-LOD fill and the drawn crest agree.
const RAIL_BALLAST: [number, number, number] = [107, 100, 89]; // #6b6459
const FIELD_VARIANTS: [number, number, number][] = [
  [96, 84, 58], // turned earth
  [142, 124, 71], // wheat
  [107, 111, 62], // green cover crop
];

type Ctx = CanvasRenderingContext2D;

// Grass is the largest surface in the frame, so its detail has to be blits.
// It used to be ONE stamp to the tile, square on the tile, every tile as full
// as the next and every blade held 5 cm inside its own edge "so the lattice
// would not show": which is the lattice. Rows and columns of clumps at a 1 m
// pitch, with a gutter down every seam.
//
// A tuft is now its own small stamp, and the tiles only say how many: each
// grass tile throws 0 to 4 of them anywhere on itself, at their own size,
// free to lie across a seam onto the next tile of grass. How many follows a
// slow field (ground.ts tuftCount), so a meadow has thick ground and thin
// ground. The lean is baked into the stamp, a sixth of a half-turn apart, and
// picked off the same combing field as before, so nothing rotates at bake.
const TUFT_VARIANTS = 8;
const TUFT_LEANS = 6; // over a half turn: grass has a direction, not a heading
const TUFT_REACH = 0.42; // how far from its centre a size-1 tuft paints, metres

function tuftStamp(v: number, lean: number, band: number): HTMLCanvasElement {
  return stamp(`grass:tuft:${v}:${lean}`, band, 1, (g) => {
    const ang = (lean / TUFT_LEANS) * Math.PI;
    const k0 = v * 31 + lean;
    // a soft patch of lighter or darker sward, laid along the lean
    const a = 0.05 + hash(k0, 4, 206) * 0.04;
    g.fillStyle = hash(k0, 5, 206) > 0.5 ? `rgba(206,216,164,${a.toFixed(3)})` : `rgba(26,34,18,${a.toFixed(3)})`;
    g.beginPath();
    g.ellipse(0.5, 0.5, 0.22 + hash(k0, 1, 206) * 0.18, 0.06 + hash(k0, 2, 206) * 0.06, ang, 0, Math.PI * 2);
    g.fill();
    const clumps = 1 + ((hash(k0, 0, 207) * 2) | 0);
    for (let c = 0; c < clumps; c++) {
      const cx = 0.5 + (hash(k0 * 7 + c, 0, 208) - 0.5) * 0.4;
      const cy = 0.5 + (hash(k0 * 7 + c, 1, 208) - 0.5) * 0.4;
      // the dark tick a clump stands on, so it sits ON the ground
      g.strokeStyle = 'rgba(18,22,14,0.25)';
      g.lineWidth = 0.028;
      g.beginPath();
      g.moveTo(cx - Math.cos(ang) * 0.05, cy - Math.sin(ang) * 0.05);
      g.lineTo(cx + Math.cos(ang) * 0.05, cy + Math.sin(ang) * 0.05);
      g.stroke();
      const n = 4 + ((hash(k0 * 7 + c, 2, 208) * 3) | 0);
      for (let i = 0; i < n; i++) {
        const k = k0 * 97 + c * 11 + i;
        const ba = ang + (hash(k, 0, 209) - 0.5) * 0.7;
        const len = 0.1 + hash(k, 1, 209) * 0.12;
        const sx = cx + (hash(k, 2, 209) - 0.5) * 0.18;
        const sy = cy + (hash(k, 3, 209) - 0.5) * 0.18;
        const tone = hash(k, 4, 209);
        g.strokeStyle = tone > 0.66 ? shade(GRASS, 1.22) : tone > 0.33 ? shade(GRASS_DRY, 1.1) : shade(GRASS, 0.72);
        g.lineWidth = 0.03 + hash(k, 5, 209) * 0.025;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx + Math.cos(ba) * len, sy + Math.sin(ba) * len);
        g.stroke();
      }
    }
  });
}

// Meadow bloom: cream / pale ochre / dusty mauve, all under the muted
// ceiling. Deliberately tiny and never at d<2 — a red dot at mid zoom reads
// as a unit marker.
function bloomStamp(v: number, band: number): HTMLCanvasElement {
  return stamp(`grass:bloom:${v}`, band, 1, (g) => {
    const petals = 5 + ((hash(v, 0, 215) * 5) | 0);
    for (let i = 0; i < petals; i++) {
      const k = v * 13 + i;
      const t = hash(k, 2, 215);
      g.fillStyle = t > 0.6 ? 'rgba(228,224,198,0.60)' : t > 0.3 ? 'rgba(208,188,122,0.50)' : 'rgba(162,142,158,0.45)';
      g.beginPath();
      g.arc(0.14 + hash(k, 0, 215) * 0.72, 0.14 + hash(k, 1, 215) * 0.72, 0.015 + hash(k, 3, 215) * 0.01, 0, Math.PI * 2);
      g.fill();
    }
  });
}

// The grass, over the finished tile bases (a tuft that lies across a seam
// would be painted out by the next tile's base if it went down with its own).
// It lies across a seam only onto more grass, or the grass a hedge stands on:
// along anything else — a floor, a lane, a field, water — it is held inside
// its own tile, because a blade drawn 30 cm into a kitchen is a bug.
function drawGrassTufts(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number, band: number, d: Detail): void {
  if (d === 0) return;
  const sward = (x: number, y: number): boolean => {
    if (!map.inBounds(x, y)) return false;
    const k = map.terrainKeyAt(x, y);
    return k === 'grass' || (k === 'hedge' && !hedgeHost(map, x, y));
  };
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (map.terrainKeyAt(x, y) !== 'grass') continue;
      const n = tuftCount(x, y);
      const bloom = d >= 2 && macro(x + 411, y + 87) > 0.63; // offset lattice so flower patches are uncorrelated with the hue drift
      if (n === 0 && !bloom) continue;
      const [fdx, fdy] = vec(x + 0.5, y + 0.5, 205, 34);
      const lean0 = Math.round((Math.atan2(fdy, fdx) / Math.PI + 1) * TUFT_LEANS);
      const w = sward(x - 1, y);
      const e = sward(x + 1, y);
      const no = sward(x, y - 1);
      const so = sward(x, y + 1);
      const put = (c: HTMLCanvasElement, k: number, s: number): void => {
        const r = Math.min(0.5, TUFT_REACH * s);
        const px = Math.min(e ? 1 : 1 - r, Math.max(w ? 0 : r, hash(k, 0, 622)));
        const py = Math.min(so ? 1 : 1 - r, Math.max(no ? 0 : r, hash(k, 1, 622)));
        g.drawImage(c, x + px - s / 2, y + py - s / 2, s, s);
      };
      for (let i = 0; i < n; i++) {
        const k = (x * 73 + y * 151) * 4 + i;
        // one in four leans a notch off its neighbours, so the combing is a tendency
        const lean = (lean0 + (hash(k, 2, 622) < 0.25 ? 1 : 0)) % TUFT_LEANS;
        put(tuftStamp((hash(k, 3, 622) * TUFT_VARIANTS) | 0, lean, band), k, 0.7 + hash(k, 4, 622) * 0.7);
      }
      if (bloom) put(bloomStamp((hash(x, y, 201) * 6) | 0, band), (x * 73 + y * 151) * 4 + 3, 1);
    }
  }
}

// Verge strip for the grass side of a road edge: tufts leaning out over the
// running surface plus a couple of bare-earth scuffs, which is what breaks the
// razor-straight tile boundary the road used to end on. Baked per side so the
// frame loop never rotates. `side` 0/1/2/3 = road to the N/S/W/E; (u, t) is
// canonical — u runs along the edge, t runs from the grass side (0) to the
// road side (0.5).
function vergeStamp(v: number, side: number, band: number): HTMLCanvasElement {
  const horiz = side < 2;
  return stampRect(`grass:verge:${v}:${side}`, band, horiz ? 1 : 0.5, horiz ? 0.5 : 1, (g) => {
    const px = (u: number, t: number) => (side === 0 ? u : side === 1 ? u : side === 2 ? 0.5 - t : t);
    const py = (u: number, t: number) => (side === 0 ? 0.5 - t : side === 1 ? t : u);
    for (let i = 0; i < 2; i++) {
      const k = v * 11 + i;
      const u = 0.15 + hash(k, 0, 218) * 0.7;
      const t = 0.22 + hash(k, 1, 218) * 0.2;
      const r = 0.075 + hash(k, 2, 218) * 0.075;
      g.fillStyle = 'rgba(146,122,84,0.22)';
      g.beginPath();
      g.ellipse(px(u, t), py(u, t), r * (horiz ? 1.5 : 1), r * (horiz ? 1 : 1.5), 0, 0, Math.PI * 2);
      g.fill();
    }
    const n = 3 + ((hash(v, 0, 219) * 3) | 0);
    for (let i = 0; i < n; i++) {
      const k = v * 11 + i;
      const u = 0.1 + hash(k, 0, 219) * 0.8;
      const t0 = 0.06 + hash(k, 1, 219) * 0.1;
      const dl = 0.14 + hash(k, 2, 219) * 0.16;
      const du = (hash(k, 3, 219) - 0.5) * 0.16;
      g.strokeStyle = hash(k, 4, 219) > 0.5 ? shade(GRASS, 1.15) : shade(GRASS_DRY, 0.95);
      g.lineWidth = 0.035 + hash(k, 5, 219) * 0.02;
      g.beginPath();
      g.moveTo(px(u, t0), py(u, t0));
      g.lineTo(px(u + du, Math.min(0.48, t0 + dl)), py(u + du, Math.min(0.48, t0 + dl)));
      g.stroke();
    }
  });
}

// One-sun hillshade (height phase D): lambertian shade off the elevation, from the
// shared sun. Direction TO the sun is the opposite of the shadow direction in
// light.ts; the art convention's sun height stays fixed (tan ≈ 0.84) — only
// the horizontal component rotates with the day. Shade is expressed as a
// delta from the flat-surface lambert term so perfectly flat ground is
// untouched even on a map that has relief.
//
// N4: the light vector is memoized PER SUN STEP, never a module constant — a
// module constant is exactly the "reader that caches across frames without
// the step in its key" that light.ts's header forbids. Callers sit inside
// chunk bakes whose key records the step, so a per-step memo is sound.
const SUN_Z = 0.84;
let hillStep = -1;
let hillLight: ReliefLight = { x: 0, y: 0, z: 0, flat: 0 };
function hillLightNow(): ReliefLight {
  const s = sun();
  if (s.step !== hillStep) {
    hillStep = s.step;
    const len = Math.hypot(s.dir[0], s.dir[1], SUN_Z);
    hillLight = { x: -s.dir[0] / len, y: -s.dir[1] / len, z: SUN_Z / len, flat: SUN_Z / len };
  }
  return hillLight;
}

// Relief shade for the whole map at one pixel per tile: warm light on the
// slopes that face the sun, cool dark on the ones that face away. A chunk
// bake draws its piece of this up to bake size with smoothing on, so the
// shade is interpolated between tile CENTRES and no tile has an edge. It used
// to be a filled square per tile, off an elevation field that only changes at
// terrace steps: that was the lattice (see ground.ts). One image for the map
// rather than one per chunk, because the upload of a fresh ImageData cost more
// per bake than the whole old pass.
function bakeRelief(sm: Float32Array, w: number, h: number, light: ReliefLight): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const sg = c.getContext('2d')!;
  const img = sg.createImageData(w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = reliefShade(sm, w, h, x, y, light);
      if (Math.abs(d) < 0.004) continue;
      const o = (y * w + x) * 4;
      if (d > 0) {
        px[o] = 255;
        px[o + 1] = 250;
        px[o + 2] = 235;
      } else {
        px[o] = 8;
        px[o + 1] = 10;
        px[o + 2] = 14;
      }
      px[o + 3] = Math.round(Math.abs(d) * 255);
    }
  }
  sg.putImageData(img, 0, 0);
  return c;
}

// Hedge tones, dark to light. The mass is opaque, so it can be filled a tone
// at a time: a handful of fills for the chunk instead of one per lobe.
const HEDGE_TONES = [0.8, 0.88, 0.96, 1.04, 1.12].map((f) => shade(HEDGE_GREEN, f));

// The hedgerows (see hedgerow.ts for where the lobes come from), one visual
// layer at a time across every lobe in range: AO → cast shadow → earth bank →
// rim → mass → shaded and lit flanks → flecks → twigs. Each translucent layer
// is ONE union fill. The lobes overlap by design, and filling them one by one
// would darken every overlap into a string of beads.
function drawHedgerows(g: Ctx, hr: Hedgerows, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  // One tile wider than the bake range: a link is owned by its north/west end,
  // and the lobes of one that starts just outside the range still reach in.
  const L = hedgeLobes(hr, tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1, d === 0 ? 0 : 2);
  if (L.length === 0) return;
  const TAU = Math.PI * 2;
  const [sdx, sdy] = shadowOffsetLegible(0.4);
  const discs = (k: number, ox: number, oy: number): void => {
    g.beginPath();
    for (let i = 0; i < L.length; i += 3) {
      g.moveTo(L[i] + ox + L[i + 2] * k, L[i + 1] + oy);
      g.arc(L[i] + ox, L[i + 1] + oy, L[i + 2] * k, 0, TAU);
    }
    g.fill();
  };
  // Every lobe SWEPT from its foot along the sun, as the canopies are: the
  // up-sun edge stays anchored under the hedge at any rake.
  const swept = (k: number, reach: number): void => {
    g.beginPath();
    for (let i = 0; i < L.length; i += 3) capsulePath(g, L[i], L[i + 1], L[i] + sdx * reach, L[i + 1] + sdy * reach, L[i + 2] * k);
    g.fill();
  };
  // base AO: subtle all-around ground darkening at the hedge's foot
  g.fillStyle = `rgba(8,10,7,${AO_ALPHA * 0.6})`;
  discs(1.3, 0, 0);
  g.fillStyle = `rgba(10,14,8,${shadowSoftAlpha()})`;
  swept(1.15, 1.6);
  g.fillStyle = `rgba(10,14,8,${shadowAlpha()})`;
  swept(1.1, 1);
  // earth bank under the foliage: a bocage hedge grows out of a raised bank,
  // and without it the run reads as a green sausage lying on the lawn
  g.fillStyle = 'rgba(72,58,38,0.35)';
  discs(1.25, 0.06, 0.08);
  // One silhouette pass gives the whole run a dark rim for a single fill. At
  // far zoom it is most of what separates a hedge from the pasture round it.
  g.fillStyle = 'rgba(0,0,0,0.22)';
  discs(1.07, 0, 0);
  // hedge mass — yellower, denser green than woods. Tone drifts along the run
  // on the macro field, with a per-lobe roll so neighbouring lobes separate.
  for (let t = 0; t < HEDGE_TONES.length; t++) {
    g.fillStyle = HEDGE_TONES[t];
    g.beginPath();
    for (let i = 0; i < L.length; i += 3) {
      const tone = macro(L[i], L[i + 1]) * 0.6 + hash(i, Math.round(L[i] * 16), 606) * 0.4;
      if (Math.min(HEDGE_TONES.length - 1, (tone * HEDGE_TONES.length) | 0) !== t) continue;
      g.moveTo(L[i] + L[i + 2], L[i + 1]);
      g.arc(L[i], L[i + 1], L[i + 2], 0, TAU);
    }
    g.fill();
  }
  // The flank away from the sun in shade, the flank toward it lit, and a small
  // hot spot on each lobe: what makes a row of discs read as a row of bushes.
  g.fillStyle = 'rgba(14,22,12,0.22)';
  discs(0.82, SUN.dx * 0.07, SUN.dy * 0.07);
  g.fillStyle = 'rgba(190,214,148,0.16)';
  discs(0.7, -SUN.dx * 0.08, -SUN.dy * 0.08);
  if (d === 0) return;
  // Leaf masses catching the light and the gaps between them. On some lobes
  // only: one on every lobe is a row of identical beads.
  const flecks = (style: string, salt: number, r0: number, r1: number): void => {
    g.fillStyle = style;
    g.beginPath();
    for (let i = 0; i < L.length; i += 3) {
      for (let k = 0; k < d; k++) {
        if (hash(i, k, salt) < 0.4) continue;
        const a = hash(i, k, salt + 1) * TAU;
        const rr = Math.sqrt(hash(i, k, salt + 2)) * L[i + 2] * 0.75;
        const fx = L[i] + Math.cos(a) * rr - SUN.dx * 0.05;
        const fy = L[i + 1] + Math.sin(a) * rr - SUN.dy * 0.05;
        const fr = r0 + hash(i, k, salt + 3) * (r1 - r0);
        g.moveTo(fx + fr, fy);
        g.arc(fx, fy, fr, 0, TAU);
      }
    }
    g.fill();
  };
  flecks('rgba(206,224,158,0.2)', 611, 0.05, 0.11);
  flecks('rgba(12,20,10,0.3)', 615, 0.025, 0.055);
  if (d < 2) return;
  // bare twigs where a run stops — the cut end of a hedgerow is sticks, not foliage
  g.strokeStyle = 'rgba(58,50,34,0.5)';
  g.lineWidth = 0.035;
  for (let y = Math.max(0, ty0); y < Math.min(hr.h, ty1); y++) {
    for (let x = Math.max(0, tx0); x < Math.min(hr.w, tx1); x++) {
      const deg = hr.deg[y * hr.w + x];
      if (deg < 0 || deg > 1) continue;
      for (let i = 0; i < 3; i++) {
        const k = x * 4 + i;
        const a = hash(k, y, 59) * Math.PI * 2;
        const sx = x + 0.35 + hash(k, y, 60) * 0.3;
        const sy = y + 0.35 + hash(k, y, 61) * 0.3;
        const l = 0.2 + hash(k, y, 62) * 0.2;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
        g.stroke();
      }
    }
  }
}

// Woods floor: leaf flecks, twigs, a surface root, and at the closest tier
// fern fronds and a moss patch. Replaces the four per-tile litter ellipses,
// which were the whole of the forest floor.
function litterStamp(v: number, d: Detail, band: number): HTMLCanvasElement {
  return stamp(`woods:litter:${v}:${d >= 2 ? 2 : 1}`, band, 1, (g) => {
    if (d >= 2) {
      g.fillStyle = 'rgba(74,92,56,0.18)';
      g.beginPath();
      g.ellipse(0.2 + hash(v, 0, 266) * 0.6, 0.2 + hash(v, 1, 266) * 0.6, 0.16, 0.12, hash(v, 2, 266) * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(58,44,28,0.35)';
    g.lineWidth = 0.05;
    g.beginPath();
    g.arc(0.5 + (hash(v, 0, 267) - 0.5) * 0.6, 1.1 + hash(v, 1, 267) * 0.3, 0.55, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
    for (let i = 0; i < 10; i++) {
      const k = v * 13 + i;
      g.fillStyle = hash(k, 0, 268) > 0.45 ? 'rgba(20,24,14,0.22)' : 'rgba(120,110,70,0.16)';
      g.beginPath();
      g.ellipse(0.08 + hash(k, 1, 268) * 0.84, 0.08 + hash(k, 2, 268) * 0.84, 0.03 + hash(k, 3, 268) * 0.025, 0.018 + hash(k, 4, 268) * 0.016, hash(k, 5, 268) * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(46,38,24,0.4)';
    g.lineWidth = 0.03;
    for (let i = 0; i < 3; i++) {
      const k = v * 7 + i;
      const sx = 0.1 + hash(k, 0, 269) * 0.7;
      const sy = 0.1 + hash(k, 1, 269) * 0.7;
      const a = hash(k, 2, 269) * Math.PI * 2;
      const l = 0.15 + hash(k, 3, 269) * 0.15;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
      g.stroke();
    }
    if (d < 2) return;
    const fx = 0.2 + hash(v, 3, 266) * 0.6;
    const fy = 0.2 + hash(v, 4, 266) * 0.6;
    g.strokeStyle = 'rgba(96,116,66,0.35)';
    g.lineWidth = 0.028;
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i - 1) * 0.6 + (hash(v, i, 266) - 0.5) * 0.3;
      g.beginPath();
      g.moveTo(fx, fy);
      g.lineTo(fx + Math.cos(a) * 0.2, fy + Math.sin(a) * 0.2);
      g.stroke();
    }
  });
}

function gravelStamp(v: number, band: number): HTMLCanvasElement {
  return stamp(`road:gravel:${v}`, band, 1, (g) => {
    const n = 12 + ((hash(v, 0, 236) * 5) | 0);
    for (let i = 0; i < n; i++) {
      const k = v * 17 + i;
      const t = hash(k, 3, 236);
      g.fillStyle = t > 0.66 ? 'rgba(198,186,158,0.35)' : t > 0.33 ? 'rgba(44,36,26,0.30)' : 'rgba(120,102,74,0.30)';
      const r = 0.0125 + hash(k, 2, 236) * 0.01;
      g.beginPath();
      g.ellipse(0.06 + hash(k, 0, 236) * 0.88, 0.06 + hash(k, 1, 236) * 0.88, r * 1.3, r, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
}

// Road wear as a whole-run post-pass over finished tile bases. A rut is built
// from each road tile's centre out to each orthogonal road neighbour's centre,
// which is what makes runs continuous across tile and chunk seams and makes
// corners bend — the old per-tile rut rects inferred the axis from `w || e`,
// which is simply wrong at every junction and every bend. Lateral wobble is
// averaged at the shared edge midpoint so neighbouring tiles agree on where
// the rut crosses, and the lateral basis is world-fixed (+y for E-W runs,
// +x for N-S) so the two tiles do not mirror each other's wobble.
function drawRoadWear(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail, paved: (x: number, y: number) => number): void {
  const roadAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'road' && !map.isBridge(tx, ty);
  const wob = (tx: number, ty: number) => (coarse(tx * 3, ty * 3) - 0.5) * 0.18;
  // How far the road reaches along one axis through this tile, capped — the
  // longer axis is the run direction.
  const extent = (tx: number, ty: number, dx: number, dy: number) => {
    let n = 1;
    for (let i = 1; i <= 8 && roadAt(tx - dx * i, ty - dy * i); i++) n++;
    for (let i = 1; i <= 8 && roadAt(tx + dx * i, ty + dy * i); i++) n++;
    return n;
  };
  // Perpendicular band through this tile: [centre in world m, width in tiles].
  const band = (tx: number, ty: number, ew: boolean): [number, number] => {
    const dx = ew ? 0 : 1;
    const dy = ew ? 1 : 0;
    let a = 0;
    let b = 0;
    while (a < 3 && roadAt(tx - dx * (a + 1), ty - dy * (a + 1))) a++;
    while (b < 3 && roadAt(tx + dx * (b + 1), ty + dy * (b + 1))) b++;
    const n = a + b + 1;
    return [(ew ? ty : tx) - a + n / 2, n];
  };
  type Seg = [number, number, number, number];
  const ruts: Seg[] = [];
  const crown: Seg[] = [];
  const turns: [number, number, number, number][] = []; // cx, cy, r, quadrant
  const worn: [number, number][] = [];
  const DIRS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      // Paved tiles keep no wear at all: cobbles own the surface, and the
      // square is a plaza rather than a lane, so the centreline every wear
      // feature is built from is not even well defined there.
      if (!roadAt(x, y) || paved(x, y) > 0.3) continue;
      worn.push([x, y]);
      const nbs = DIRS.filter(([dx, dy]) => roadAt(x + dx, y + dy));
      if (nbs.length >= 3) {
        // Traffic cuts the corner, so add one scuff arc round each inner
        // corner between two perpendicular arms. One jittered radius, not a
        // pair — concentric rings read as a crop circle. The corner only
        // exists where the DIAGONAL is off-road: mapgen's arterial is 3 tiles
        // wide, so every tile in its interior has 4 road neighbours and a
        // degree test alone would stamp arcs down the whole run.
        const has = (dx: number, dy: number) => nbs.some(([a, b]) => a === dx && b === dy);
        const quads: [number, number, number, boolean][] = [
          [x + 1, y, 0, has(0, -1) && has(1, 0) && !roadAt(x + 1, y - 1)],
          [x + 1, y + 1, 1, has(1, 0) && has(0, 1) && !roadAt(x + 1, y + 1)],
          [x, y + 1, 2, has(0, 1) && has(-1, 0) && !roadAt(x - 1, y + 1)],
          [x, y, 3, has(-1, 0) && has(0, -1) && !roadAt(x - 1, y - 1)],
        ];
        for (const [qx, qy, q, ok] of quads) {
          if (ok) turns.push([qx, qy, 0.72 + hash(x, y * 4 + q, 240) * 0.34, q]);
        }
      }
      // Which way does the run go, and where is its centreline? mapgen's
      // arterial is 3 tiles wide, so "one rut pair per tile toward every road
      // neighbour" lays down a 0.5 m mesh over the whole surface. Ruts belong
      // to the ROAD, not the tile: measure the run axis by which direction the
      // road reaches further, then let only the tile on the band's centreline
      // carry the pair, spread to suit the band's width.
      const extH = extent(x, y, 1, 0);
      const extV = extent(x, y, 0, 1);
      if (extH === extV) continue; // inside an intersection box (or a lone tile) — the turn arcs own it
      const ew = extH > extV;
      const [c, H] = band(x, y, ew);
      // mapgen never lays a road wider than 3 tiles, so a wider band means an
      // open paved area, not a lane. Its capped scan hands every interior row
      // its own "centreline" and the ruts come out as a mesh.
      if (H > 3) continue;
      if (Math.floor(c) !== (ew ? y : x)) continue;
      const sep = Math.min(0.72, 0.26 * H);
      const w0 = wob(x, y);
      for (const dir of [-1, 1]) {
        const nx = ew ? x + dir : x;
        const ny = ew ? y : y + dir;
        if (!roadAt(nx, ny)) continue;
        const cN = band(nx, ny, ew)[0];
        const wN = ew ? wob(nx, Math.floor(cN)) : wob(Math.floor(cN), ny);
        const cE = (c + cN) / 2;
        const wE = (w0 + wN) / 2;
        const a = ew ? x + 0.5 : c + w0;
        const b = ew ? c + w0 : y + 0.5;
        const ea = ew ? x + (dir > 0 ? 1 : 0) : cE + wE;
        const eb = ew ? cE + wE : y + (dir > 0 ? 1 : 0);
        for (const s of [-1, 1]) {
          if (ew) ruts.push([a, b + s * sep, ea, eb + s * sep]);
          else ruts.push([a + s * sep, b, ea + s * sep, eb]);
        }
        crown.push([a, b, ea, eb]);
      }
    }
  }
  const strokeAll = (segs: Seg[], width: number, style: string, odx = 0, ody = 0) => {
    if (segs.length === 0) return;
    g.lineWidth = width;
    g.strokeStyle = style;
    g.beginPath();
    for (const [ax, ay, bx, by] of segs) {
      g.moveTo(ax + odx, ay + ody);
      g.lineTo(bx + odx, by + ody);
    }
    g.stroke();
  };
  strokeAll(crown, 0.06, 'rgba(184,160,112,0.08)');
  strokeAll(ruts, 0.13, 'rgba(58,44,30,0.16)');
  strokeAll(ruts, 0.06, 'rgba(40,30,20,0.10)');
  strokeAll(ruts, 0.05, 'rgba(196,172,120,0.10)', -0.05, -0.06); // NW dust lip — the groove reads as a depression under the one sun
  if (turns.length) {
    g.lineWidth = 0.14;
    g.strokeStyle = 'rgba(52,40,26,0.09)';
    g.beginPath();
    for (const [ax, ay, r, q] of turns) {
      const a0 = (q * Math.PI) / 2 + Math.PI / 2;
      g.moveTo(ax + Math.cos(a0) * r, ay + Math.sin(a0) * r);
      g.arc(ax, ay, r, a0, a0 + Math.PI / 2);
    }
    g.stroke();
  }
  if (d < 1) return;
  for (const [x, y] of worn) {
    if (hash(x, y, 230) >= 0.13) continue;
    const px = x + 0.2 + hash(x, y, 237) * 0.6;
    const py = y + 0.2 + hash(x, y, 238) * 0.6;
    const rx = 0.1 + hash(x, y, 239) * 0.12;
    const puddle = d >= 2 && hash(x, y, 231) < 0.05;
    g.fillStyle = 'rgba(150,126,86,0.25)';
    g.beginPath();
    g.ellipse(px - 0.03, py - 0.035, rx, rx * 0.7, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = puddle ? 'rgba(92,104,104,0.50)' : 'rgba(34,26,18,0.40)';
    g.beginPath();
    g.ellipse(px, py, rx, rx * 0.7, 0, 0, Math.PI * 2);
    g.fill();
    if (!puddle) continue;
    // the frame's only specular, and it points at the same NW sun
    g.strokeStyle = 'rgba(228,232,224,0.30)';
    g.lineWidth = 0.04;
    g.beginPath();
    g.ellipse(px, py, rx * 0.66, rx * 0.46, 0, Math.PI * 1.11, Math.PI * 1.78);
    g.stroke();
  }
}

// Village cobbles: setts on a 3x3 cell grid with a running-bond stagger,
// jittered corners and sizes, desaturated grey-tan stone values kept near the
// road's own value (a brighter stone becomes the most luminous thing in the
// frame), dark joints, and a lit top edge on each stone's two NW sides so the
// whole surface catches the one sun.
//
// Coarse and irregular on purpose: a fine regular lattice beats against the
// screen pixel grid when the chunk is downscaled from its bake band and the
// joints turn into long diagonal moiré cracks.
const COBBLE_N = 3;

function cobbleStamp(v: number, band: number): HTMLCanvasElement {
  return stamp(`village:cobble:${v}`, band, 1, (g) => {
    g.fillStyle = 'rgba(40,34,26,0.45)';
    g.fillRect(0, 0, 1, 1);
    const cell = 1 / COBBLE_N;
    const j = (k: number, f: number) => (hash(k, f, 271) - 0.5) * 0.055;
    for (let r = 0; r < COBBLE_N; r++) {
      for (let c = 0; c < COBBLE_N; c++) {
        const k = v * 37 + r * COBBLE_N + c;
        const stagger = r % 2 ? cell * 0.28 : 0;
        const w = cell * (0.7 + hash(k, 9, 271) * 0.16);
        const h = cell * (0.7 + hash(k, 10, 271) * 0.16);
        const x0 = Math.min(1 - w - 0.01, c * cell + stagger + (cell - w) / 2 + j(k, 11) * 0.5);
        const y0 = r * cell + (cell - h) / 2 + j(k, 12) * 0.5;
        const x1 = x0 + w;
        const y1 = y0 + h;
        const pts: [number, number][] = [
          [x0 + j(k, 0), y0 + j(k, 1)],
          [x1 + j(k, 2), y0 + j(k, 3)],
          [x1 + j(k, 4), y1 + j(k, 5)],
          [x0 + j(k, 6), y1 + j(k, 7)],
        ];
        const t = 0.88 + hash(k, 8, 271) * 0.24;
        g.fillStyle = `rgb(${Math.round(112 * t)},${Math.round(106 * t)},${Math.round(95 * t)})`;
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 4; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(198,190,168,0.16)';
        g.lineWidth = 0.04;
        g.beginPath();
        g.moveTo(pts[3][0], pts[3][1]);
        g.lineTo(pts[0][0], pts[0][1]);
        g.lineTo(pts[1][0], pts[1][1]);
        g.stroke();
      }
    }
  });
}

// Civic and yard surfacing: a gravel apron round every building, packed earth
// in the yard between a close building pair, and cobbles over the village
// square with an alpha ramp at its rim. Buildings used to grow straight out of
// lawn and the crossroads was bare dirt road; this is what makes the village
// read as a built place.
// One scratch canvas for a pass that has to be composed before it goes down
// (the paving). A chunk bake is synchronous, so one is enough: it is sized to
// the chunk being baked, cleared, and given that chunk's transform.
let scratch: HTMLCanvasElement | null = null;
function scratchFor(g: Ctx): Ctx {
  scratch ??= document.createElement('canvas');
  if (scratch.width !== g.canvas.width || scratch.height !== g.canvas.height) {
    scratch.width = g.canvas.width;
    scratch.height = g.canvas.height;
  }
  const s = scratch.getContext('2d')!;
  s.globalCompositeOperation = 'source-over';
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, scratch.width, scratch.height);
  s.setTransform(g.getTransform());
  return s;
}

// The paving weight of every tile centre as the alpha of one pixel, so that
// drawn through with smoothing on it is the ramp itself and not a step a tile.
function bakePaveMask(patches: PatchIndex, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cg = c.getContext('2d')!;
  const img = cg.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(patches.pavedAt(x, y) * 255);
    }
  }
  cg.putImageData(img, 0, 0);
  return c;
}

function drawPaving(g: Ctx, map: GameMap, patches: PatchIndex, tx0: number, ty0: number, tx1: number, ty1: number, band: number, d: Detail, mask: HTMLCanvasElement | null): void {
  for (const b of patches.buildings) {
    if (b.maxX + 1 < tx0 || b.minX - 1 > tx1 || b.maxY + 1 < ty0 || b.minY - 1 > ty1) continue;
    g.strokeStyle = 'rgba(150,138,112,0.22)';
    g.lineWidth = 0.6;
    g.strokeRect(b.minX - 0.3, b.minY - 0.3, b.maxX - b.minX + 0.6, b.maxY - b.minY + 0.6);
    if (d < 2) continue;
    g.fillStyle = 'rgba(96,88,68,0.22)';
    const per = 2 * (b.maxX - b.minX + b.maxY - b.minY);
    for (let i = 0; i < per; i++) {
      const u = hash(b.id * 64 + i, 0, 272);
      const side = (hash(b.id * 64 + i, 1, 272) * 4) | 0;
      const t = 0.05 + hash(b.id * 64 + i, 2, 272) * 0.5;
      const px = side === 0 || side === 1 ? b.minX + u * (b.maxX - b.minX) : side === 2 ? b.minX - t : b.maxX + t;
      const py = side === 0 ? b.minY - t : side === 1 ? b.maxY + t : b.minY + u * (b.maxY - b.minY);
      g.fillRect(px, py, 0.05, 0.05);
    }
  }
  // farm yard: mapgen puts a house and a barn a few metres apart and they
  // share the ground between them
  for (let i = 0; i < patches.buildings.length; i++) {
    for (let k = i + 1; k < patches.buildings.length; k++) {
      const a = patches.buildings[i];
      const b = patches.buildings[k];
      const gapX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
      const gapY = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
      if (Math.hypot(gapX, gapY) > 4) continue;
      const x0 = Math.max(tx0, Math.min(a.minX, b.minX));
      const y0 = Math.max(ty0, Math.min(a.minY, b.minY));
      const x1 = Math.min(tx1, Math.max(a.maxX, b.maxX));
      const y1 = Math.min(ty1, Math.max(a.maxY, b.maxY));
      const outside = (bb: BuildingBox, x: number, y: number) =>
        Math.hypot(Math.max(bb.minX - x - 0.5, 0, x + 0.5 - bb.maxX), Math.max(bb.minY - y - 0.5, 0, y + 0.5 - bb.maxY));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (map.buildingIdAt(x, y) >= 0) continue;
          const key = map.terrainKeyAt(x, y);
          if (key !== 'grass' && key !== 'field' && key !== 'road') continue;
          const dist = Math.min(outside(a, x, y), outside(b, x, y));
          const al = 0.35 * (1 - dist / 2);
          if (al <= 0.01) continue;
          g.fillStyle = `rgba(128,110,80,${al.toFixed(3)})`;
          g.fillRect(x, y, 1, 1);
          if (d < 1) continue;
          g.fillStyle = 'rgba(196,178,124,0.28)';
          for (let s = 0; s < 4; s++) {
            const kk = x * 13 + y * 7 + s;
            g.fillRect(x + hash(kk, 0, 273) * 0.9, y + hash(kk, 1, 273) * 0.9, 0.07, 0.02);
          }
          if (hash(x, y, 274) > 0.7) {
            g.strokeStyle = 'rgba(70,56,36,0.14)';
            g.lineWidth = 0.07;
            g.beginPath();
            g.arc(x + hash(x, y, 275), y + hash(x, y, 276), 0.5 + hash(x, y, 277) * 0.4, 0, Math.PI);
            g.stroke();
          }
        }
      }
    }
  }
  if (patches.squares.length === 0 || !mask) return;
  const roadAt = (x: number, y: number) => map.inBounds(x, y) && map.terrainKeyAt(x, y) === 'road';
  const pavable = (x: number, y: number) => {
    if (!map.inBounds(x, y)) return false;
    const key = map.terrainKeyAt(x, y);
    if (map.isBridge(x, y)) return false;
    if (key === 'road') return true;
    if (key !== 'grass' && key !== 'field') return false;
    return roadAt(x - 1, y) || roadAt(x + 1, y) || roadAt(x, y - 1) || roadAt(x, y + 1);
  };
  const weight = (x: number, y: number) => (pavable(x, y) ? patches.pavedAt(x, y) : 0);
  // The setts used to go down a tile at a time, each at its own alpha: the
  // ramp at the rim of a square was a flight of 1 m steps, and its outline
  // followed the tiles. Both are now what softenGround does for the ground:
  // the WEIGHT is the ramp itself, drawn through a one-pixel-per-tile mask
  // with smoothing on, and the OUTLINE has its staircase corners cut
  // (ground.ts cornerCuts) so it runs on the diagonal it stood for. Built in a
  // scratch canvas because the two multiply: setts, minus the cut corners,
  // times the ramp.
  const cls = (x: number, y: number): number => (weight(x, y) > 0.01 ? 1 : groundClass(map, patches, x, y) === HARD ? HARD : 2);
  let any = false;
  for (let y = ty0; y < ty1 && !any; y++) for (let x = tx0; x < tx1 && !any; x++) any = cls(x, y) === 1;
  if (!any) return;
  const s = scratchFor(g);
  const sett = (x: number, y: number): void => {
    if (d >= 1) s.drawImage(cobbleStamp((hash(x, y, 278) * 6) | 0, band), x, y, 1, 1);
    else {
      s.fillStyle = 'rgb(122,115,102)';
      s.fillRect(x, y, 1, 1);
    }
  };
  for (let y = ty0; y < ty1; y++) for (let x = tx0; x < tx1; x++) if (cls(x, y) === 1) sett(x, y);
  // Corner cuts. `ends` records which end of which tile edge a cut took, so
  // the kerb below stops where the paving now does. A cut is [corner, point on
  // the horizontal edge, point on the vertical edge, the lone tile].
  const ends = new Set<string>();
  const cuts: [number, number, number, number, number, number][] = [];
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x <= tx1; x++) {
      const m = cornerCuts(cls(x - 1, y - 1), cls(x, y - 1), cls(x - 1, y), cls(x, y));
      if (m === 0) continue;
      for (let bit = 0; bit < 4; bit++) {
        if (!(m & (1 << bit))) continue;
        const lx = x - 1 + (bit & 1); // the tile that stands alone
        const ly = y - 1 + (bit >> 1);
        cuts.push([x, y, cutOnH(lx, y), cutOnV(x, ly), lx, ly]);
        ends.add(`h${lx},${y},${bit & 1 ? 0 : 1}`); // 0: the edge's west end, 1: its east end
        ends.add(`v${x},${ly},${bit >> 1 ? 0 : 1}`); // 0: north end, 1: south end
      }
    }
  }
  const tri = (c: (typeof cuts)[0]): void => {
    s.beginPath();
    s.moveTo(c[0], c[1]);
    s.lineTo(c[2], c[1]);
    s.lineTo(c[0], c[3]);
    s.closePath();
  };
  for (const c of cuts) {
    if (cls(c[4], c[5]) === 1) continue;
    // the lone tile is bare and the paving closes over its corner
    s.save();
    tri(c);
    s.clip();
    sett(c[4], c[5]);
    s.restore();
  }
  s.globalCompositeOperation = 'destination-out';
  s.fillStyle = '#000';
  for (const c of cuts) {
    if (cls(c[4], c[5]) !== 1) continue;
    tri(c);
    s.fill();
  }
  s.globalCompositeOperation = 'destination-in';
  s.imageSmoothingEnabled = true; // bilinear between tile centres: this IS the ramp
  const mx0 = Math.max(0, tx0);
  const my0 = Math.max(0, ty0);
  s.drawImage(mask, mx0, my0, tx1 - mx0, ty1 - my0, mx0, my0, tx1 - mx0, ty1 - my0);
  s.globalCompositeOperation = 'source-over';
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(s.canvas, 0, 0);
  g.restore();
  if (d === 0) return; // a 10 cm kerb is a tenth of a pixel out here
  // Kerb: hard civic boundary wherever paving meets unpaved ground. Only
  // where it meets SOFT ground — a kerb across the open road where the ramp
  // happens to fade would cut the run in half.
  const kerbed = (ax: number, ay: number, bx: number, by: number): boolean => weight(ax, ay) > 0.35 && weight(bx, by) <= 0.35 && !roadAt(bx, by);
  // One stone course along a boundary segment, with its shadow line on the
  // side (nx, ny) the bare ground is on.
  const light: Seg[] = [];
  const dark: Seg[] = [];
  const kerb = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number): void => {
    light.push([ax - nx * 0.05, ay - ny * 0.05, bx - nx * 0.05, by - ny * 0.05]);
    dark.push([ax + nx * 0.02, ay + ny * 0.02, bx + nx * 0.02, by + ny * 0.02]);
  };
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x <= tx1; x++) {
      // the edge along y between (x, y-1) and (x, y), then the one along x
      // between (x-1, y) and (x, y); each from whichever side is paved
      for (const horiz of [true, false]) {
        const [px, py] = horiz ? [x, y - 1] : [x - 1, y];
        const out = kerbed(px, py, x, y) ? 1 : kerbed(x, y, px, py) ? -1 : 0;
        if (out === 0) continue;
        const key = horiz ? `h${x},${y}` : `v${x},${y}`;
        const cut = horiz ? cutOnH(x, y) : cutOnV(x, y);
        const lo = ends.has(`${key},0`) ? cut : horiz ? x : y;
        const hi = ends.has(`${key},1`) ? cut : (horiz ? x : y) + 1;
        if (hi <= lo) continue;
        if (horiz) kerb(lo, y, hi, y, 0, out);
        else kerb(x, lo, x, hi, out, 0);
      }
    }
  }
  for (const c of cuts) {
    // the cut's own edge, where the paved party is paved enough to have a kerb
    const lonePaved = cls(c[4], c[5]) === 1;
    const sx = c[4] < c[0] ? c[4] + 1 : c[4] - 1; // the tile beside the lone one, across the corner
    const [pvx, bx] = lonePaved ? [c[4], sx] : [sx, c[4]];
    if (weight(pvx, c[5]) <= 0.35 || roadAt(bx, c[5])) continue;
    // Unit normal of the cut, turned toward the corner. The corner's side of
    // the cut is the piece that changed hands: bare ground if the lone tile
    // was the paved one, paving if it was not.
    const turn = ((c[0] - c[2]) * (c[1] - c[3]) > 0 ? 1 : -1) * (lonePaved ? 1 : -1);
    const len = Math.hypot(c[3] - c[1], c[0] - c[2]);
    kerb(c[2], c[1], c[0], c[3], (-(c[3] - c[1]) * turn) / len, ((c[0] - c[2]) * turn) / len);
  }
  g.lineCap = 'butt';
  strokeSegs(g, light, 0.1, 'rgba(158,150,132,0.50)');
  strokeSegs(g, dark, 0.04, 'rgba(30,26,20,0.30)');
  g.lineCap = 'round';
}

// Crop rows (G4). Everything is keyed on the PARCEL — one 4-connected field
// region from the PatchIndex — not on an 8 m block, which is what made
// base-farm read as graph paper: adjacent blocks of the same field disagreed
// about which way the rows ran and reset their phase at every seam. Row phase
// is measured from the parcel centroid, so a row is one continuous line from
// one end of the field to the other, across every tile and chunk boundary.
type Crop = 0 | 1 | 2; // plowed / cereal / roots
export const cropOf = (seed: number): Crop => {
  const t = hash(seed, 0, 244);
  return t < 0.4 ? 0 : t < 0.75 ? 1 : 2;
};
// Two tones per crop, drifted between by the 28 m macro field: the crop
// decides the family, the noise keeps the parcel from reading as one flat
// slab and keeps two neighbouring parcels of the same crop apart. Straw is
// deliberately desaturated to ~36% — the raw wheat variant at this area was
// the brightest, most saturated thing in the frame.
// Roots sit on BARE EARTH with green rosettes down the rows — a green base
// put the parcel at the same value as the surrounding grass and the whole
// field disappeared.
const CROP_A: [number, number, number][] = [[92, 80, 58], [134, 122, 82], [110, 98, 66]];
const CROP_B: [number, number, number][] = [[114, 98, 66], [116, 108, 76], [92, 86, 60]];

interface RowGeom {
  crop: Crop;
  a: number;
  s: number;
  c0: number;
}

function rowGeom(p: Patch, d: Detail): RowGeom {
  const crop = cropOf(p.seed);
  // rows within +-14 deg of an axis: a slight diagonal is what reads
  // agricultural, but at d=0 the pitch aliases into moire so it snaps square
  const axis = hash(p.seed, 0, 242) < 0.5 ? 0 : Math.PI / 2;
  const a = d === 0 ? axis : axis + (hash(p.seed, 0, 241) - 0.5) * 0.5;
  const s = (0.34 + hash(p.seed, 0, 243) * 0.36) * (d === 0 ? 3 : 1);
  return { crop, a, s, c0: Math.sin(a) * p.cx - Math.cos(a) * p.cy };
}

type Seg = [number, number, number, number];

function strokeSegs(g: Ctx, segs: Seg[], w: number, style: string, odx = 0, ody = 0): void {
  if (segs.length === 0) return;
  g.lineWidth = w;
  g.strokeStyle = style;
  g.beginPath();
  for (const [ax, ay, bx, by] of segs) {
    g.moveTo(ax + odx, ay + ody);
    g.lineTo(bx + odx, by + ody);
  }
  g.stroke();
}

function drawCropRows(g: Ctx, map: GameMap, patches: PatchIndex, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  const rows: Seg[][] = [[], [], []]; // per crop
  const tram: Seg[] = [];
  const roots: [number, number][][] = [[], []];
  const turn: Seg[] = [];
  const geom = new Map<number, RowGeom>();
  // A hedge counts as field here, twice over. Its tile carries its host
  // parcel's rows (hedgeHost), and a field tile beside it gets no headland:
  // both the bare tile and the headland row ran down the tile staircase, in
  // plain view beside a hedgerow that no longer follows it.
  const fieldAt = (tx: number, ty: number) => map.inBounds(tx, ty) && (map.terrainKeyAt(tx, ty) === 'field' || map.terrainKeyAt(tx, ty) === 'hedge');
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const host = map.terrainKeyAt(x, y) === 'hedge' ? hedgeHost(map, x, y) : null;
      const pid = host ? patches.id[host[1] * map.w + host[0]] : patches.id[y * map.w + x];
      if (pid < 0) continue;
      const p = patches.patches[pid];
      if (p.kind !== 'field') continue;
      let gm = geom.get(pid);
      if (!gm) {
        gm = rowGeom(p, d);
        geom.set(pid, gm);
      }
      // Headlands: a real field turns at its edge, so the outer 0.35 m of a
      // border tile carries a row PARALLEL to that border over a bare turning
      // strip, and the angled rows are clipped out of it.
      let lx = x;
      let ly = y;
      let hx = x + 1;
      let hy = y + 1;
      const edges: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      for (const [dx, dy] of edges) {
        if (fieldAt(x + dx, y + dy)) continue;
        if (dy < 0) {
          ly = y + 0.35;
          turn.push([x, y + 0.12, x + 1, y + 0.12]);
          rows[gm.crop].push([x, y + 0.2, x + 1, y + 0.2]);
        } else if (dy > 0) {
          hy = y + 0.65;
          turn.push([x, y + 0.88, x + 1, y + 0.88]);
          rows[gm.crop].push([x, y + 0.8, x + 1, y + 0.8]);
        } else if (dx < 0) {
          lx = x + 0.35;
          turn.push([x + 0.12, y, x + 0.12, y + 1]);
          rows[gm.crop].push([x + 0.2, y, x + 0.2, y + 1]);
        } else {
          hx = x + 0.65;
          turn.push([x + 0.88, y, x + 0.88, y + 1]);
          rows[gm.crop].push([x + 0.8, y, x + 0.8, y + 1]);
        }
      }
      if (hx - lx < 0.05 || hy - ly < 0.05) continue;
      // n.p = c is the row line; clip it to the tile with a 4-plane
      // parametric clip. No clip(), no per-tile save/restore, no overdraw.
      const nx = Math.sin(gm.a);
      const ny = -Math.cos(gm.a);
      const dxr = Math.cos(gm.a);
      const dyr = Math.sin(gm.a);
      const c1 = nx * lx + ny * ly;
      const c2 = nx * hx + ny * ly;
      const c3 = nx * lx + ny * hy;
      const c4 = nx * hx + ny * hy;
      const kMin = Math.ceil((Math.min(c1, c2, c3, c4) - gm.c0) / gm.s);
      const kMax = Math.floor((Math.max(c1, c2, c3, c4) - gm.c0) / gm.s);
      for (let k = kMin; k <= kMax; k++) {
        const c = gm.c0 + k * gm.s;
        const ox = nx * c;
        const oy = ny * c;
        let t0 = -1e3;
        let t1 = 1e3;
        for (let ax = 0; ax < 2; ax++) {
          const o = ax ? oy : ox;
          const dd = ax ? dyr : dxr;
          const lo = ax ? ly : lx;
          const hi = ax ? hy : hx;
          if (Math.abs(dd) < 1e-6) {
            if (o < lo || o > hi) {
              t0 = 1;
              t1 = 0;
              break;
            }
            continue;
          }
          const a0 = (lo - o) / dd;
          const a1 = (hi - o) / dd;
          t0 = Math.max(t0, Math.min(a0, a1));
          t1 = Math.min(t1, Math.max(a0, a1));
        }
        if (t1 - t0 < 0.02) continue;
        const seg: Seg = [ox + dxr * t0, oy + dyr * t0, ox + dxr * t1, oy + dyr * t1];
        rows[gm.crop].push(seg);
        if (gm.crop === 1 && d >= 1 && k % 12 === 0) tram.push(seg);
        if (gm.crop === 2 && d >= 2) {
          // roots: rosettes along the row. fillRect, not arc — at 3 rows a
          // tile the arc count alone would eat the whole chunk budget.
          for (let t = t0 + 0.1; t < t1; t += 0.42) {
            const rx = ox + dxr * t;
            const ry = oy + dyr * t;
            const j = hash((rx * 7) | 0, (ry * 7) | 0, 245);
            roots[j > 0.5 ? 0 : 1].push([rx + (j - 0.5) * 0.1, ry + (hash((ry * 7) | 0, (rx * 7) | 0, 245) - 0.5) * 0.1]);
          }
        }
      }
    }
  }
  strokeSegs(g, turn, 0.25, 'rgba(112,94,62,0.18)');
  // plowed: a trough with a sunlit ridge crest offset NW — genuine
  // corrugation under the shared sun, and the biggest payoff in the pass
  strokeSegs(g, rows[0], 0.1, 'rgba(38,28,18,0.22)');
  strokeSegs(g, rows[0], 0.06, 'rgba(196,176,132,0.13)', -0.045, -0.055);
  // cereal: the drill line is the dark gap between two rows of straw, and the
  // NW crest is the straw itself catching the sun — the light-only stroke the
  // spec asked for vanished against a straw base
  strokeSegs(g, rows[1], 0.09, 'rgba(66,56,34,0.16)');
  strokeSegs(g, rows[1], 0.06, 'rgba(206,192,142,0.15)', -0.04, -0.05);
  strokeSegs(g, tram, 0.14, 'rgba(64,52,32,0.20)');
  strokeSegs(g, rows[2], 0.1, 'rgba(64,80,46,0.28)');
  for (let i = 0; i < 2; i++) {
    if (roots[i].length === 0) continue;
    g.fillStyle = i ? 'rgba(52,68,40,0.5)' : 'rgba(74,92,52,0.55)';
    for (const [rx, ry] of roots[i]) g.fillRect(rx - 0.06, ry - 0.05, 0.12, 0.1);
  }
}

const DECK: [number, number, number] = [118, 96, 68]; // weathered plank
const DECK_DARK: [number, number, number] = [94, 76, 54];

// Plank deck laid across the direction of travel, curb rails on edges that
// meet water. `ew` = the crossing runs east-west (water band is N→S).
function drawBridgeDeck(g: Ctx, x: number, y: number, ew: boolean, waterAt: (tx: number, ty: number) => boolean): void {
  for (let p = 0; p < 3; p++) {
    const idx = (ew ? x : y) * 3 + p; // world-space so seams don't repeat tile to tile
    g.fillStyle = shade(p % 2 ? DECK_DARK : DECK, 0.9 + hash(ew ? idx : x, ew ? y : idx, 110) * 0.16);
    if (ew) g.fillRect(x + p / 3, y, 1 / 3, 1);
    else g.fillRect(x, y + p / 3, 1, 1 / 3);
    g.fillStyle = 'rgba(0,0,0,0.15)';
    if (ew) g.fillRect(x + p / 3, y, 0.03, 1);
    else g.fillRect(x, y + p / 3, 1, 0.03);
  }
  g.fillStyle = 'rgba(40,34,24,0.9)';
  if (waterAt(x, y - 1)) g.fillRect(x, y, 1, 0.13);
  if (waterAt(x, y + 1)) g.fillRect(x, y + 0.87, 1, 0.13);
  if (waterAt(x - 1, y)) g.fillRect(x, y, 0.13, 1);
  if (waterAt(x + 1, y)) g.fillRect(x + 0.87, y, 0.13, 1);
  // sun catches the NW-facing rail tops
  g.fillStyle = 'rgba(205,195,165,0.3)';
  if (waterAt(x, y - 1)) g.fillRect(x, y, 1, 0.04);
  if (waterAt(x - 1, y)) g.fillRect(x, y, 0.04, 1);
}

// Water banks in a post-pass over finished tile bases: a mud fringe painted
// onto the LAND side of each bank edge (raster order would overpaint an E/S
// fringe drawn from the water tile), depth jittered per half-tile so the
// tile-quantized bank edge stops reading as a hard staircase; then the dark
// waterline and a few ripple dashes inside the water.
function drawWaterBanks(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number): void {
  const waterAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'water';
  const mudAt = (tx: number, ty: number) => {
    if (!map.inBounds(tx, ty)) return false;
    const k = map.terrainKeyAt(tx, ty);
    return k === 'grass' || k === 'field' || k === 'woods' || k === 'hedge'; // roads keep a clean edge (bridge rails own it)
  };
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (!waterAt(x, y)) continue;
      for (let h = 0; h < 2; h++) {
        if (mudAt(x, y - 1)) {
          const d = 0.1 + hash(x * 2 + h, y, 120) * 0.22;
          g.fillStyle = 'rgba(88,76,52,0.5)';
          g.fillRect(x + h * 0.5, y - d, 0.5, d);
          g.fillStyle = 'rgba(50,48,38,0.45)';
          g.fillRect(x + h * 0.5, y - d * 0.45, 0.5, d * 0.45);
        }
        if (mudAt(x, y + 1)) {
          const d2 = 0.1 + hash(x * 2 + h, y, 121) * 0.22;
          g.fillStyle = 'rgba(88,76,52,0.5)';
          g.fillRect(x + h * 0.5, y + 1, 0.5, d2);
          g.fillStyle = 'rgba(50,48,38,0.45)';
          g.fillRect(x + h * 0.5, y + 1, 0.5, d2 * 0.45);
        }
        if (mudAt(x - 1, y)) {
          const d3 = 0.1 + hash(x, y * 2 + h, 122) * 0.22;
          g.fillStyle = 'rgba(88,76,52,0.5)';
          g.fillRect(x - d3, y + h * 0.5, d3, 0.5);
          g.fillStyle = 'rgba(50,48,38,0.45)';
          g.fillRect(x - d3 * 0.45, y + h * 0.5, d3 * 0.45, 0.5);
        }
        if (mudAt(x + 1, y)) {
          const d4 = 0.1 + hash(x, y * 2 + h, 123) * 0.22;
          g.fillStyle = 'rgba(88,76,52,0.5)';
          g.fillRect(x + 1, y + h * 0.5, d4, 0.5);
          g.fillStyle = 'rgba(50,48,38,0.45)';
          g.fillRect(x + 1, y + h * 0.5, d4 * 0.45, 0.5);
        }
      }
      // dark waterline inside the water tile on every land edge
      g.fillStyle = 'rgba(30,38,32,0.35)';
      if (!waterAt(x, y - 1)) g.fillRect(x, y, 1, 0.12);
      if (!waterAt(x, y + 1)) g.fillRect(x, y + 0.88, 1, 0.12);
      if (!waterAt(x - 1, y)) g.fillRect(x, y, 0.12, 1);
      if (!waterAt(x + 1, y)) g.fillRect(x + 0.88, y, 0.12, 1);
      // ripple dashes just inside the banks
      g.fillStyle = 'rgba(200,220,225,0.1)';
      if (!waterAt(x, y - 1) && hash(x, y, 124) < 0.6) g.fillRect(x + hash(x, y, 125) * 0.5, y + 0.2 + hash(x, y, 126) * 0.15, 0.4, 0.05);
      if (!waterAt(x, y + 1) && hash(x, y, 127) < 0.6) g.fillRect(x + hash(x, y, 128) * 0.5, y + 0.65 + hash(x, y, 129) * 0.15, 0.4, 0.05);
      if (!waterAt(x - 1, y) && hash(x, y, 130) < 0.6) g.fillRect(x + 0.2 + hash(x, y, 131) * 0.15, y + hash(x, y, 132) * 0.5, 0.05, 0.4);
      if (!waterAt(x + 1, y) && hash(x, y, 133) < 0.6) g.fillRect(x + 0.65 + hash(x, y, 134) * 0.15, y + hash(x, y, 135) * 0.5, 0.05, 0.4);
    }
  }
}

// Worn dirt trail out from each exterior building door — overlapping ellipses
// shrinking and fading with distance, wobbled off the straight line. Trails
// cross tile boundaries, so they run as a post-pass over the finished bases.
function drawDoorTrails(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number): void {
  const floorAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'floor';
  const trail = (px: number, py: number, dx: number, dy: number) => {
    for (let i = 0; i < 7; i++) {
      const t = 0.3 + i * 0.42;
      const wob = (hash(Math.round(px * 4), Math.round(py * 4), 145 + i) - 0.5) * 0.6 * (i / 7);
      const r = 0.36 - i * 0.028;
      g.fillStyle = `rgba(139,116,84,${(0.36 - i * 0.045).toFixed(3)})`;
      g.beginPath();
      g.ellipse(px + dx * t - dy * wob, py + dy * t + dx * wob, r * (1 + Math.abs(dx) * 0.35), r * (1 + Math.abs(dy) * 0.35), 0, 0, Math.PI * 2);
      g.fill();
    }
  };
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (map.hEdge(x, y) !== EDGE.DOOR) continue;
      const inSouth = floorAt(x, y); // hEdge(x,y) sits on the north side of tile (x,y)
      if (inSouth === floorAt(x, y - 1)) continue; // internal door (or floating edge)
      trail(x + 0.5, y, 0, inSouth ? -1 : 1);
    }
  }
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x <= tx1; x++) {
      if (map.vEdge(x, y) !== EDGE.DOOR) continue;
      const inEast = floorAt(x, y); // vEdge(x,y) sits on the west side of tile (x,y)
      if (inEast === floorAt(x - 1, y)) continue;
      trail(x, y + 0.5, inEast ? -1 : 1, 0);
    }
  }
}

// The woods floor's tone: drift only, for the reason drawGrassBase gives. Its
// four random quadrants were a 0.5 m checkerboard through every canopy gap.
function drawWoodsBase(g: Ctx, x: number, y: number): void {
  g.fillStyle = shade(WOODS_GROUND, 0.92 + coarse(x, y) * 0.12);
  g.fillRect(x, y, 1, 1);
}

// Tone drift only, off the two smooth fields. This drew four quadrants a
// tile, each with a 5% random step, to break up a 1 m checkerboard: `coarse`
// reads whole metres, so the quadrants differed by the random step alone and
// the result was a 0.5 m checkerboard. The tufts are the texture.
function drawGrassBase(g: Ctx, x: number, y: number): void {
  g.fillStyle = shade(blendPalette([GRASS, GRASS_DRY], macro(x, y)), 0.905 + coarse(x, y) * 0.16);
  g.fillRect(x, y, 1, 1);
}

// ── Railway: ballast, sleepers, rails, embankment batter (V4) ──────────────
//
// The sim gives the renderer two keys and an elevation field, and nothing else:
// `rail` is the ballasted crest, `bank` the batter either side, and
// map.crossings marks the road tiles the arterial carved through the footprint
// (verticality design §2.2 — the road wins the tile, so a crossing is ordinary
// road to A* and to every vehicle). Run direction, which tile of a 3-wide crest
// carries the track, and which way a batter falls are all re-derived here.

const RAIL_STEEL: [number, number, number] = [74, 72, 68];
const SLEEPER: [number, number, number] = [64, 52, 40];
const SLEEPER_PITCH = 0.6; // m — verticality design §2.5
const GAUGE = 0.24; // m from the track centreline to each rail
const SLEEPER_HALF = 0.42;

export interface RailIndex {
  /** 0 = the line runs along world x, 1 = along world y */
  axis: number;
  /** track centreline in world metres on the ACROSS axis, per ALONG tile */
  centre: Float32Array;
}

// One index for the whole map, built once, because the track has to be
// CONTINUOUS. Two facts about the generated line force this:
//
//   1. The line MEANDERS. R-C's crest is a constant 3 tiles wide but it drifts
//      across the map (seed 7: x=290..292 at y=56, x=294..296 at y=208), so a
//      single centreline column is wrong everywhere except the middle.
//   2. Its width is NOT locally trustworthy. The level crossing eats a column
//      out of the crest (verticality §2.2 — the road wins the tile) and the end
//      taper narrows it, so measuring "middle of the band" at a tile put the
//      rails at x=293 north of the road and x=294 south of it, and the line
//      visibly jogged sideways as it crossed.
//
// So: measure the crest per ALONG tile, keep only the readings whose width
// matches the line's modal width, interpolate across the rest, then box-smooth.
// The smoothing is what turns the generator's whole-tile jogs into a drift of
// ~0.2 m per tile, which is a railway curve rather than a kink. Half-tile
// precision throughout: an even crest has its centreline on a tile boundary,
// and forcing it onto a tile index would push the track off its own ballast.
// Returns null on every map with no railway, which is every legacy kind.
function railIndex(map: GameMap): RailIndex | null {
  // one pass over the map, because this runs in the TerrainLayer ctor on every
  // battle boot and a 320x240 scan is 76,800 terrainKeyAt calls
  const xs: number[] = [];
  const ys: number[] = [];
  let minX = 1e9;
  let maxX = -1e9;
  let minY = 1e9;
  let maxY = -1e9;
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (map.terrainKeyAt(x, y) !== 'rail') continue;
      xs.push(x);
      ys.push(y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (xs.length === 0) return null;
  const axis = maxX - minX >= maxY - minY ? 0 : 1;
  const nU = axis === 0 ? map.w : map.h;
  const lo = new Int16Array(nU).fill(-1);
  const hi = new Int16Array(nU).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    const u = axis === 0 ? xs[i] : ys[i];
    const t = axis === 0 ? ys[i] : xs[i];
    if (lo[u] < 0 || t < lo[u]) lo[u] = t;
    if (t > hi[u]) hi[u] = t;
  }
  const widths = new Map<number, number>();
  for (let u = 0; u < nU; u++) if (lo[u] >= 0) widths.set(hi[u] - lo[u] + 1, (widths.get(hi[u] - lo[u] + 1) ?? 0) + 1);
  let modeW = 3;
  let modeN = -1;
  for (const [w, c] of widths) if (c > modeN) { modeW = w; modeN = c; }
  const centre = new Float32Array(nU);
  const good: number[] = [];
  for (let u = 0; u < nU; u++) {
    if (lo[u] < 0 || hi[u] - lo[u] + 1 !== modeW) continue;
    centre[u] = (lo[u] + hi[u] + 1) / 2;
    good.push(u);
  }
  if (good.length === 0) return null;
  for (let i = 0, u = 0; u < nU; u++) {
    while (i + 1 < good.length && good[i + 1] < u) i++;
    const a = good[i];
    const b = i + 1 < good.length ? good[i + 1] : a;
    if (u === a || u === b) continue;
    centre[u] = u < a || b === a ? centre[a] : centre[a] + ((centre[b] - centre[a]) * (u - a)) / (b - a);
  }
  const smooth = new Float32Array(nU);
  for (let u = 0; u < nU; u++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += centre[Math.max(0, Math.min(nU - 1, u + k))];
    smooth[u] = s / 5;
  }
  return { axis, centre: smooth };
}

// Sleepers on their world-space pitch, then the two rails over them. World
// phase, not per-tile phase: a sleeper rhythm that restarts at every tile seam
// is the single most obvious way to make a railway look tiled.
function drawTrack(g: Ctx, along0: number, c: number, axis: number, d: Detail, sunk: boolean): void {
  const [sdx, sdy] = shadowOffset(0.14);
  if (d >= 1) {
    for (let k = Math.ceil(along0 / SLEEPER_PITCH); k * SLEEPER_PITCH < along0 + 1; k++) {
      const u = k * SLEEPER_PITCH;
      g.fillStyle = shade(SLEEPER, 0.9 + hash(k, Math.round(c), 470) * 0.26);
      if (axis === 0) g.fillRect(u - 0.11, c - SLEEPER_HALF, 0.22, SLEEPER_HALF * 2);
      else g.fillRect(c - SLEEPER_HALF, u - 0.11, SLEEPER_HALF * 2, 0.22);
      g.fillStyle = 'rgba(226,214,186,0.12)'; // NW lip — creosoted timber still catches the sun
      if (axis === 0) g.fillRect(u - 0.11, c - SLEEPER_HALF, 0.05, SLEEPER_HALF * 2);
      else g.fillRect(c - SLEEPER_HALF, u - 0.11, SLEEPER_HALF * 2, 0.05);
    }
  }
  for (const s of [-1, 1]) {
    const p = c + s * GAUGE;
    if (!sunk) {
      g.fillStyle = 'rgba(16,14,11,0.42)';
      if (axis === 0) g.fillRect(along0 + sdx, p - 0.037 + sdy, 1, 0.075);
      else g.fillRect(p - 0.037 + sdx, along0 + sdy, 0.075, 1);
    }
    g.fillStyle = shade(RAIL_STEEL, 1);
    if (axis === 0) g.fillRect(along0, p - 0.037, 1, 0.075);
    else g.fillRect(p - 0.037, along0, 0.075, 1);
    // the frame's other specular, pointing at the same NW sun as the puddles
    g.fillStyle = 'rgba(214,216,212,0.36)';
    if (axis === 0) g.fillRect(along0, p - 0.037, 1, 0.026);
    else g.fillRect(p - 0.037, along0, 0.026, 1);
  }
}

function drawRailTile(g: Ctx, map: GameMap, x: number, y: number, band: number, d: Detail, rail: RailIndex): void {
  g.fillStyle = shade(RAIL_BALLAST, 0.82 + coarse(x, y) * 0.24 + hash(x, y, 471) * 0.08);
  g.fillRect(x, y, 1, 1);
  // crushed stone, not a poured slab: the road's own gravel scatter is exactly
  // the right grain, and it earns its place a band earlier here because
  // unbroken ballast is the flattest surface on the map.
  if (d >= 1) g.drawImage(gravelStamp((hash(x, y, 472) * 8) | 0, band), x, y, 1, 1);
  // The ballast trapezoid: where the crest stops, its shoulder falls away. Only
  // across the run — along it the ballast simply continues.
  const isRail = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'rail';
  const sides: [number, number, number, number, number, number][] = rail.axis === 0
    ? [[0, -1, x, y, 1, 0.2], [0, 1, x, y + 0.8, 1, 0.2]]
    : [[-1, 0, x, y, 0.2, 1], [1, 0, x + 0.8, y, 0.2, 1]];
  for (const [dx, dy, rx, ry, rw, rh] of sides) {
    if (isRail(x + dx, y + dy)) continue;
    g.fillStyle = 'rgba(28,24,18,0.34)';
    g.fillRect(rx, ry, rw, rh);
    g.fillStyle = 'rgba(206,196,172,0.12)';
    g.fillRect(rx + (dx > 0 ? rw - 0.05 : 0), ry + (dy > 0 ? rh - 0.05 : 0), dx !== 0 ? 0.05 : rw, dy !== 0 ? 0.05 : rh);
  }
}

// Embankment batter. The grass base is the ordinary field grass — a bank is
// turf, not a new material — and everything added on top is derived from the
// local elev gradient so the slope reads as a slope. Deliberately NOT
// sun-directional: drawHillshade already lays the lambertian term over this
// tile from the shared sun, and a second directional pass here would either
// double it or fight it. What goes down instead is contact darkening at the
// toe, which is ambient, plus the erosion a worked earth bank actually shows.
function drawBankTile(g: Ctx, map: GameMap, x: number, y: number, d: Detail): void {
  drawGrassBase(g, x, y);
  const dzdx = map.elevAt(x + 1, y) - map.elevAt(x - 1, y);
  const dzdy = map.elevAt(x, y + 1) - map.elevAt(x, y - 1);
  const m = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
  if (m < 0.01 || d < 1) return;
  const ux = dzdx / m; // unit vector pointing UPHILL
  const uy = dzdy / m;
  // toe shading, on the downhill edge
  g.fillStyle = `rgba(22,26,16,${(AO_ALPHA * 0.6).toFixed(3)})`;
  if (Math.abs(ux) > Math.abs(uy)) g.fillRect(ux > 0 ? x : x + 0.74, y, 0.26, 1);
  else g.fillRect(x, uy > 0 ? y : y + 0.74, 1, 0.26);
  // bare earth scoured through the turf, elongated ALONG the contour
  for (let i = 0; i < 2; i++) {
    const k = x * 5 + i;
    g.fillStyle = `rgba(146,124,88,${(0.1 + hash(k, y, 473) * 0.14).toFixed(3)})`;
    g.beginPath();
    g.ellipse(x + 0.2 + hash(k, y, 474) * 0.6, y + 0.2 + hash(k, y, 475) * 0.6, 0.26, 0.1, Math.atan2(ux, -uy), 0, Math.PI * 2);
    g.fill();
  }
  if (d < 2) return;
  // grass combed down the fall line — the tell that this is a graded batter
  g.lineWidth = 0.035;
  for (let i = 0; i < 4; i++) {
    const k = x * 7 + i;
    const px = x + 0.15 + hash(k, y, 476) * 0.7;
    const py = y + 0.15 + hash(k, y, 477) * 0.7;
    const l = 0.1 + hash(k, y, 478) * 0.1;
    g.strokeStyle = hash(k, y, 479) > 0.5 ? 'rgba(150,166,110,0.30)' : 'rgba(46,54,32,0.30)';
    g.beginPath();
    g.moveTo(px + ux * l, py + uy * l);
    g.lineTo(px - ux * l, py - uy * l);
    g.stroke();
  }
}

// Level crossing, as a post-pass over the finished road (it has to run after
// drawRoadWear, which would otherwise lay ruts over the timbers). Only the
// track centreline gets a deck; the rest of the carved band is ordinary road
// with a dust of ballast tracked onto it.
function drawCrossings(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail, rail: RailIndex): void {
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (!map.isCrossing(x, y)) continue;
      g.fillStyle = `rgba(120,112,98,${(0.07 + hash(x, y, 480) * 0.07).toFixed(3)})`;
      g.fillRect(x, y, 1, 1);
      const c = rail.centre[rail.axis === 0 ? x : y];
      if (Math.floor(c) !== (rail.axis === 0 ? y : x)) continue;
      // timber baulks laid PARALLEL to the rails, between them and outside
      // them — what a cart actually crosses on
      for (let p = -3; p <= 2; p++) {
        const t0 = c + p * 0.16 + 0.01;
        g.fillStyle = shade(DECK, 0.8 + hash(x * 7 + p, y, 481) * 0.22);
        if (rail.axis === 0) g.fillRect(x, t0, 1, 0.14);
        else g.fillRect(t0, y, 0.14, 1);
        if (d < 1) continue; // a 0.03 m joint is sub-pixel below band 16
        g.fillStyle = 'rgba(24,20,14,0.30)';
        if (rail.axis === 0) g.fillRect(x, t0, 1, 0.03);
        else g.fillRect(t0, y, 0.03, 1);
      }
    }
  }
}

// Sleepers and rails for a whole visible stretch of line, laid AFTER every
// per-tile base and after the crossing deck. It cannot be a drawTileBase
// branch: the track straddles a tile boundary wherever the crest is an even
// number of tiles wide, and whichever tile owned it would have its spill
// painted over by the neighbour the base loop reaches next.
function drawTrackRun(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail, rail: RailIndex): void {
  const a0 = rail.axis === 0 ? ty0 : tx0;
  const a1 = rail.axis === 0 ? ty1 : tx1;
  const laid = (u: number, c: number): number => {
    // the line exists at this along-coordinate if either column under the
    // sleeper is ballast or carved crossing; 1 = crossing (rails set into the
    // road deck, so no cast shadow under the foot)
    for (const t of [Math.floor(c - 0.3), Math.floor(c + 0.3)]) {
      const x = rail.axis === 0 ? u : t;
      const y = rail.axis === 0 ? t : u;
      if (!map.inBounds(x, y)) continue;
      if (map.isCrossing(x, y)) return 1;
      if (map.terrainKeyAt(x, y) === 'rail') return 2;
    }
    return 0;
  };
  for (let u = rail.axis === 0 ? tx0 : ty0, uEnd = rail.axis === 0 ? tx1 : ty1; u < uEnd; u++) {
    const c = rail.centre[u];
    if (c + SLEEPER_HALF < a0 || c - SLEEPER_HALF > a1) continue;
    const state = laid(u, c);
    if (state !== 0) drawTrack(g, u, c, rail.axis, d, state === 1);
  }
}

// ── Interior floor materials (interiors design R1) ─────────────────────────
// The material is the BUILDING's, from Building.role, not the room's: rooms are
// not persisted (D8) and a role plus one hearth-proximity test already
// separates every surface the eye needs — cold flags in a church, quarry tile
// in a shop, beaten earth in a barn, boards in a dwelling, and a flagstone
// apron round the fire that makes the kitchen read differently from the parlor
// off the terrain grid alone.
const FLAG_STONE: [number, number, number] = [106, 106, 102]; // church: cool, blue-grey
const FLAG_WARM: [number, number, number] = [132, 122, 106]; // hearth apron: warmer, so the two never read as the same floor
const QUARRY: [number, number, number] = [134, 104, 82];
const QUARRY_DARK: [number, number, number] = [113, 88, 72];
const EARTH_FLOOR: [number, number, number] = [116, 100, 76];

// Irregular slabs on a 2x2 sub-grid: joints land on the 0.5 m lattice (flags
// ARE laid regularly) but every corner is jittered and every slab has its own
// value, so a nave floor never reads as graph paper.
function flagStamp(v: number, warm: boolean, band: number): HTMLCanvasElement {
  const base = warm ? FLAG_WARM : FLAG_STONE;
  return stamp(`floor:flag:${warm ? 'w' : 'c'}:${v}`, band, 1, (g) => {
    // A heavy joint turns a nave into graph paper at every zoom: the mortar is
    // a low-alpha wash under slabs whose value spread is narrow on purpose.
    g.fillStyle = shade(base, 0.72);
    g.fillRect(0, 0, 1, 1);
    const j = (k: number, f: number) => (hash(k, f, 440) - 0.5) * 0.045;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const k = v * 11 + r * 2 + c;
        const x0 = c * 0.5 + 0.022 + j(k, 0);
        const y0 = r * 0.5 + 0.022 + j(k, 1);
        const x1 = c * 0.5 + 0.478 + j(k, 2);
        const y1 = r * 0.5 + 0.478 + j(k, 3);
        g.fillStyle = shade(base, 0.94 + hash(k, 4, 440) * 0.14);
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
        g.fillStyle = 'rgba(226,224,214,0.09)';
        g.fillRect(x0, y0, x1 - x0, 0.03);
        g.fillRect(x0, y0, 0.03, y1 - y0);
      }
    }
  });
}

// Shop floor: small square quarry tiles on a 3x3 grid, alternating two warm
// tones with pale lime joints. Regular on purpose — it is a laid floor, and its
// regularity is exactly what separates a shop from a boarded parlor at a glance.
function quarryStamp(v: number, band: number): HTMLCanvasElement {
  return stamp(`floor:quarry:${v}`, band, 1, (g) => {
    g.fillStyle = 'rgba(178,168,150,0.30)'; // lime grout
    g.fillRect(0, 0, 1, 1);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const k = v * 17 + r * 3 + c;
        g.fillStyle = shade((r + c) % 2 ? QUARRY_DARK : QUARRY, 0.92 + hash(k, 0, 441) * 0.18);
        g.fillRect(c / 3 + 0.022, r / 3 + 0.022, 1 / 3 - 0.044, 1 / 3 - 0.044);
      }
    }
  });
}

// Barn / farmhouse: beaten earth, scuffed, with loose straw. No boards — a
// Normandy farm ground floor is packed dirt, and the value drop is what makes
// the barn read as an outbuilding from across the yard.
function earthFloorStamp(v: number, band: number, d: Detail): HTMLCanvasElement {
  return stamp(`floor:earth:${v}:${d}`, band, 1, (g) => {
    for (let sub = 0; sub < 4; sub++) {
      g.fillStyle = shade(EARTH_FLOOR, 0.9 + hash(v * 5 + sub, 0, 442) * 0.2);
      g.fillRect((sub & 1) * 0.5, (sub >> 1) * 0.5, 0.5, 0.5);
    }
    if (d < 1) return;
    for (let i = 0; i < 3; i++) {
      const k = v * 7 + i;
      g.fillStyle = `rgba(72,60,42,${(0.1 + hash(k, 0, 443) * 0.1).toFixed(3)})`;
      g.beginPath();
      g.ellipse(0.15 + hash(k, 1, 443) * 0.7, 0.15 + hash(k, 2, 443) * 0.7, 0.16, 0.11, hash(k, 3, 443) * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    // Loose straw, kept quiet: at 0.42 alpha the wisps read as pale scratches
    // across the floor rather than as chaff on it.
    g.lineWidth = 0.03;
    for (let i = 0; i < 5; i++) {
      const k = v * 13 + i;
      const a = hash(k, 0, 444) * Math.PI;
      const px = 0.1 + hash(k, 1, 444) * 0.8;
      const py = 0.1 + hash(k, 2, 444) * 0.8;
      const l = 0.06 + hash(k, 3, 444) * 0.12;
      g.strokeStyle = hash(k, 4, 444) > 0.5 ? 'rgba(170,152,106,0.22)' : 'rgba(126,110,72,0.20)';
      g.beginPath();
      g.moveTo(px - Math.cos(a) * l, py - Math.sin(a) * l);
      g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
      g.stroke();
    }
  });
}

function drawPlankFloor(g: Ctx, x: number, y: number): void {
  // plank rows every 0.33m, two wood tones, staggered butt joints.
  // rowIdx is world-space (y*3+r) so joints don't repeat identically tile to tile.
  for (let r = 0; r < 3; r++) {
    const ry = y + r / 3;
    const rowIdx = y * 3 + r;
    const tone = rowIdx % 2 === 0 ? FLOOR : FLOOR_DARK;
    g.fillStyle = shade(tone, 0.92 + hash(x, rowIdx, 7) * 0.14);
    g.fillRect(x, ry, 1, 1 / 3);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(x, ry, 1, 0.03);
    if (hash(x, rowIdx, 8) < 0.3) g.fillRect(x + hash(x, rowIdx, 9), ry, 0.03, 1 / 3);
  }
}

function drawFloorTile(g: Ctx, x: number, y: number, role: number, apron: number, band: number, d: Detail): void {
  if (role === ROLE.CHURCH) g.drawImage(flagStamp((hash(x, y, 445) * 8) | 0, false, band), x, y, 1, 1);
  else if (role === ROLE.SHOP || role === ROLE.HALLE) g.drawImage(quarryStamp((hash(x, y, 446) * 6) | 0, band), x, y, 1, 1);
  else if (role === ROLE.BARN || role === ROLE.FARMHOUSE) g.drawImage(earthFloorStamp((hash(x, y, 447) * 8) | 0, band, d), x, y, 1, 1);
  else drawPlankFloor(g, x, y);
  if (apron === 0) return;
  // hearthstone: warm flags laid round the fire, thinning at the second ring.
  // Drawn OVER the building's own floor so the two materials meet in a ragged
  // alpha edge rather than a ruled one.
  g.globalAlpha = apron === 2 ? 0.80 : 0.25;
  g.drawImage(flagStamp((hash(x, y, 448) * 8) | 0, true, band), x, y, 1, 1);
  g.globalAlpha = 1;
}

function drawTileBase(
  g: Ctx,
  map: GameMap,
  patches: PatchIndex,
  x: number,
  y: number,
  band: number,
  d: Detail,
  roleAt: (x: number, y: number) => number,
  apron: Uint8Array | null,
  rail: RailIndex | null,
): void {
  const t = map.terrainKeyAt(x, y);
  // Tone drift only, off the smooth 8 m lattice. This used to carry a 4%
  // random step per tile as well: on a field or a lane, which have no stamp
  // over them to hide it, that was a 1 m checkerboard.
  const v = 0.95 + coarse(x, y) * 0.1;
  const host = t === 'hedge' ? hedgeHost(map, x, y) : null;
  if (t === 'grass') {
    drawGrassBase(g, x, y); // the tufts are a post-pass: drawGrassTufts
    // dusty verge where grass meets road: half-tile strips of jittered depth,
    // so traffic wear bleeds past the road's own shoulder without a hard line
    const roadAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'road';
    for (let h = 0; h < 2; h++) {
      const dp = 0.14 + hash(x * 2 + h, y, 140) * 0.24;
      g.fillStyle = `rgba(168,140,92,${0.1 + hash(x * 2 + h, y, 141) * 0.1})`;
      if (roadAt(x, y - 1)) g.fillRect(x + h * 0.5, y, 0.5, dp);
      if (roadAt(x, y + 1)) g.fillRect(x + h * 0.5, y + 1 - dp, 0.5, dp);
      const dv = 0.14 + hash(x, y * 2 + h, 142) * 0.24;
      g.fillStyle = `rgba(168,140,92,${0.1 + hash(x, y * 2 + h, 143) * 0.1})`;
      if (roadAt(x - 1, y)) g.fillRect(x, y + h * 0.5, dv, 0.5);
      if (roadAt(x + 1, y)) g.fillRect(x + 1 - dv, y + h * 0.5, dv, 0.5);
    }
    if (d >= 1) {
      const vv = (hash(x, y, 202) * 6) | 0;
      if (roadAt(x, y - 1)) g.drawImage(vergeStamp(vv, 0, band), x, y, 1, 0.5);
      if (roadAt(x, y + 1)) g.drawImage(vergeStamp(vv, 1, band), x, y + 0.5, 1, 0.5);
      if (roadAt(x - 1, y)) g.drawImage(vergeStamp(vv, 2, band), x, y, 0.5, 1);
      if (roadAt(x + 1, y)) g.drawImage(vergeStamp(vv, 3, band), x + 0.5, y, 0.5, 1);
    }
  } else if (t === 'road') {
    // a road tile that overwrote water is a bridge deck (map.bridges, set by
    // mapgen — NOT re-guessed from proximity, which mislabels roads merely
    // running alongside a river). Orientation/rails read the real water band.
    if (map.isBridge(x, y)) {
      const waterAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'water';
      const ew = waterAt(x, y - 1) || waterAt(x, y - 2) || waterAt(x, y + 1) || waterAt(x, y + 2); // band is N→S ⇒ crossing runs E→W
      drawBridgeDeck(g, x, y, ew, waterAt);
      return;
    }
    g.fillStyle = shade(ROAD, v);
    g.fillRect(x, y, 1, 1);
    if (d >= 2) g.drawImage(gravelStamp((hash(x, y, 233) * 8) | 0, band), x, y, 1, 1);
    const roadAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'road';
    // Crumbled shoulder on every edge that isn't road: four 0.25 m sub-steps
    // of jittered depth instead of one straight strip, plus a couple of grass
    // scallops biting inward. A dirt lane never ends on a ruled line, and the
    // straight version was the most synthetic edge in the frame.
    const edgeRect = (s: number, u0: number, du: number, t0: number, dt: number) => {
      if (s === 0) g.fillRect(x + u0, y + t0, du, dt);
      else if (s === 1) g.fillRect(x + u0, y + 1 - t0 - dt, du, dt);
      else if (s === 2) g.fillRect(x + t0, y + u0, dt, du);
      else g.fillRect(x + 1 - t0 - dt, y + u0, dt, du);
    };
    const nb: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (let s = 0; s < 4; s++) {
      const [nx, ny] = [x + nb[s][0], y + nb[s][1]];
      if (roadAt(nx, ny)) continue;
      for (let i = 0; i < 4; i++) {
        const dep = 0.06 + hash(x * 4 + i, y * 4 + s, 232) * 0.14;
        g.fillStyle = 'rgba(0,0,0,0.15)';
        edgeRect(s, i * 0.25, 0.25, 0, dep);
        g.fillStyle = 'rgba(168,140,92,0.12)';
        edgeRect(s, i * 0.25, 0.25, dep, 0.1);
      }
      const nk = map.inBounds(nx, ny) ? map.terrainKeyAt(nx, ny) : 'grass';
      const tone =
        nk === 'grass' ? shade(blendPalette([GRASS, GRASS_DRY], macro(nx, ny)), 0.95)
        : nk === 'field' ? shade(blendPalette(FIELD_VARIANTS, macro(nx, ny)), 0.95)
        : null;
      if (!tone || d < 1) continue;
      g.fillStyle = tone;
      for (let i = 0; i < 2; i++) {
        const u = 0.15 + hash(x * 2 + i, y * 4 + s, 234) * 0.7;
        const r = 0.09 + hash(x * 2 + i, y * 4 + s, 235) * 0.02;
        const cx = s === 0 ? x + u : s === 1 ? x + u : s === 2 ? x : x + 1;
        const cy = s === 0 ? y : s === 1 ? y + 1 : y + u;
        g.beginPath();
        g.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else if (t === 'woods') {
    drawWoodsBase(g, x, y);
    if (d >= 1) g.drawImage(litterStamp((hash(x, y, 265) * 8) | 0, d, band), x, y, 1, 1);
  } else if (t === 'hedge' && !host) {
    // Ground under the hedge only: the hedgerow itself is drawn by
    // drawHedgerows in whole-run passes. It is the ordinary grass base —
    // never a tone of its own, which leaves a 1 m square halo around every
    // hedge tile.
    drawGrassBase(g, x, y);
  } else if (t === 'field' || t === 'hedge') {
    // The crop the parcel is under picks the palette family; macro drift still
    // separates two neighbouring parcels of the same crop. Row geometry is a
    // whole-parcel post-pass (drawCropRows) — per-tile furrows could never be
    // continuous across a tile seam. A hedge beside a field is that field's
    // earth to the far edge of its tile (hedgeHost).
    const p = host ? patches.patchAt(host[0], host[1]) : patches.patchAt(x, y);
    const c = p ? cropOf(p.seed) : 1;
    g.fillStyle = shade(blendPalette([CROP_A[c], CROP_B[c]], macro(x, y)), v);
    g.fillRect(x, y, 1, 1);
    if (host) return;
    // Darker boundary strip where the field meets non-field. A hedge is not
    // such a meeting: the strip would rule the tile staircase down the flank
    // of a hedgerow that no longer follows it.
    const fieldAt = (tx: number, ty: number) => map.inBounds(tx, ty) && (map.terrainKeyAt(tx, ty) === 'field' || map.terrainKeyAt(tx, ty) === 'hedge');
    g.fillStyle = 'rgba(40,32,20,0.18)';
    if (!fieldAt(x, y - 1)) g.fillRect(x, y, 1, 0.08);
    if (!fieldAt(x, y + 1)) g.fillRect(x, y + 0.92, 1, 0.08);
    if (!fieldAt(x - 1, y)) g.fillRect(x, y, 0.08, 1);
    if (!fieldAt(x + 1, y)) g.fillRect(x + 0.92, y, 0.08, 1);
  } else if (t === 'water') {
    // drift only: a random step a tile is a checkerboard, on water more than anywhere
    g.fillStyle = shade(WATER, 0.925 + coarse(x, y) * 0.12);
    g.fillRect(x, y, 1, 1);
    // faint N→S drift streaks with the current
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 2; i++) {
      if (hash(x, y, 92 + i) < 0.35)
        g.fillRect(x + hash(x, y, 94 + i) * 0.9, y + hash(x, y, 96 + i) * 0.6, 0.06, 0.3 + hash(x, y, 98 + i) * 0.3);
    }
    // bank treatment lives in drawWaterBanks (post-pass — the mud fringe
    // paints onto neighboring land tiles, which raster order would overpaint)
  } else if (t === 'rail' && rail) {
    drawRailTile(g, map, x, y, band, d, rail);
  } else if (t === 'bank') {
    drawBankTile(g, map, x, y, d);
  } else {
    // floor, and every furniture key — a table stands ON a floor, so the four
    // interior keys share this branch and the piece itself goes down later, in
    // drawFurniture's post-pass.
    drawFloorTile(g, x, y, roleAt(x, y), apron ? apron[y * map.w + x] : 0, band, d);
  }
}

// The class a tile's ground belongs to for the boundary pass (ground.ts): two
// tiles of one class have nothing between them to soften. Fields are classed
// by parcel, so two crops side by side get a boundary too. A hedge stands on
// its host's ground. Everything with an edge that must stay ruled is HARD.
function groundClass(map: GameMap, patches: PatchIndex, x: number, y: number): number {
  if (!map.inBounds(x, y)) return HARD;
  switch (map.terrainKeyAt(x, y)) {
    case 'hedge': {
      const host = hedgeHost(map, x, y);
      return host ? 16 + patches.patchIdAt(host[0], host[1]) : 1;
    }
    case 'grass':
      return 1;
    case 'woods':
      return 2;
    case 'road':
      return map.isBridge(x, y) ? HARD : 3;
    case 'field':
      return 16 + patches.patchIdAt(x, y);
    default:
      return HARD;
  }
}

// The field a hedge tile stands in: its first field neighbour, or null where
// it stands on grass. The tile used to be a square of grass whatever was round
// it, which nobody saw while the hedge was drawn square on its tile. A
// hedgerow that crosses its tiles on the diagonal uncovers their corners, and
// between two fields those corners were a green staircase down both flanks.
function hedgeHost(map: GameMap, x: number, y: number): [number, number] | null {
  for (const [dx, dy] of [[0, -1], [-1, 0], [0, 1], [1, 0]]) {
    if (map.inBounds(x + dx, y + dy) && map.terrainKeyAt(x + dx, y + dy) === 'field') return [x + dx, y + dy];
  }
  return null;
}

// The flat tone of a tile's ground: what its neighbour is given where the
// boundary between them moves. The same palettes drawTileBase reads, without
// the per-tile jitter.
function groundTone(map: GameMap, patches: PatchIndex, x: number, y: number): string {
  if (map.terrainKeyAt(x, y) === 'hedge') {
    const host = hedgeHost(map, x, y);
    if (host) return groundTone(map, patches, host[0], host[1]);
  }
  switch (map.terrainKeyAt(x, y)) {
    case 'woods':
      return shade(WOODS_GROUND, 0.96);
    case 'road':
      return shade(ROAD, 0.98);
    case 'field': {
      const p = patches.patchAt(x, y);
      const c = p ? cropOf(p.seed) : 1;
      return shade(blendPalette([CROP_A[c], CROP_B[c]], macro(x, y)), 0.98);
    }
    default:
      return shade(blendPalette([GRASS, GRASS_DRY], macro(x, y)), 0.96);
  }
}

// Soft ground boundaries. Two things, both over the finished tile bases:
//
// The CUT. At every tile corner where one tile stands alone against the two
// beside it, its corner is given to them (ground.ts cornerCuts). A boundary
// that ran as a staircase becomes the diagonal it stood for. This is geometry,
// not blur: the new edge is as crisp as the old one, so it is applied to roads
// too, with the shoulder line drawn down the cut.
//
// The FRAY. Along every edge between two kinds of open ground, a few tufts of
// each side's tone are thrown a little way over the line, so a field does not
// end on a ruled edge. Not on a road: a lane keeps its shoulder.
function softenGround(g: Ctx, map: GameMap, patches: PatchIndex, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  const cw = tx1 - tx0 + 2;
  const chh = ty1 - ty0 + 2;
  // classes for the block plus a one-tile ring, so every corner sees four
  const cls = new Int32Array(cw * chh);
  let mixed = false;
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const c = groundClass(map, patches, tx0 - 1 + x, ty0 - 1 + y);
      cls[y * cw + x] = c;
      if (c !== cls[0]) mixed = true;
    }
  }
  if (!mixed) return; // one kind of ground from edge to edge: nothing to do
  const at = (x: number, y: number): number => cls[(y - ty0 + 1) * cw + (x - tx0 + 1)];
  const tone = (x: number, y: number): string => groundTone(map, patches, x, y);
  const tri = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, fill: string, lined: boolean): void => {
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.lineTo(cx, cy);
    g.closePath();
    g.fill();
    if (!lined) return;
    // the edge line the tile bases draw along a straight boundary, carried
    // down the cut so it does not stop at every corner
    g.strokeStyle = 'rgba(30,24,14,0.2)';
    g.lineWidth = 0.08;
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(cx, cy);
    g.stroke();
  };
  const lined = (a: number, b: number): boolean => a === 3 || b === 3 || a >= 16 || b >= 16;
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x <= tx1; x++) {
      const nw = at(x - 1, y - 1);
      const ne = at(x, y - 1);
      const sw = at(x - 1, y);
      const se = at(x, y);
      const m = cornerCuts(nw, ne, sw, se);
      if (m === 0) continue;
      if (m & 1) tri(x, y, cutOnH(x - 1, y), y, x, cutOnV(x, y - 1), tone(x, y - 1), lined(nw, ne));
      if (m & 2) tri(x, y, cutOnH(x, y), y, x, cutOnV(x, y - 1), tone(x - 1, y - 1), lined(ne, nw));
      if (m & 4) tri(x, y, cutOnH(x - 1, y), y, x, cutOnV(x, y), tone(x - 1, y - 1), lined(sw, nw));
      if (m & 8) tri(x, y, cutOnH(x, y), y, x, cutOnV(x, y), tone(x, y - 1), lined(se, ne));
    }
  }
  // The fray. `open` is ground with no made edge: grass, woods floor, a field.
  const open = (c: number): boolean => c === 1 || c === 2 || c >= 16;
  const n = d >= 1 ? 3 : 2;
  const tuft = (cx: number, cy: number, r: number, fill: string): void => {
    g.fillStyle = fill;
    g.beginPath();
    g.ellipse(cx, cy, r, r * 0.8, 0, 0, Math.PI * 2);
    g.fill();
  };
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const c = at(x, y);
      if (!open(c)) continue;
      // each boundary edge once, from the tile on its low side: east and south
      for (let s = 0; s < 2; s++) {
        const ox = x + (s === 0 ? 1 : 0);
        const oy = y + (s === 0 ? 0 : 1);
        const o = at(ox, oy);
        if (o === c || !open(o)) continue;
        // not round a hedge: it stands on a strip of grass, and tufts thrown
        // off that strip were a green fuzz down both sides of every hedgerow
        if (map.terrainKeyAt(x, y) === 'hedge' || map.terrainKeyAt(ox, oy) === 'hedge') continue;
        const mine = tone(x, y);
        const theirs = tone(ox, oy);
        for (let i = 0; i < n * 2; i++) {
          const k = (x * 73 + y * 151 + s) * 8 + i;
          const along = hash(k, 0, 813);
          const over = (0.04 + hash(k, 0, 814) * 0.2) * (i & 1 ? 1 : -1); // odd tufts are mine, thrown their way
          const r = 0.1 + hash(k, 0, 815) * 0.17;
          if (s === 0) tuft(x + 1 + over, y + along, r, i & 1 ? mine : theirs);
          else tuft(x + along, y + 1 + over, r, i & 1 ? mine : theirs);
        }
      }
    }
  }
}

// The country past the edge of the map. The battle map is a window on a
// landscape, and its edge used to be a hole: a flat near-black plate. This is
// what is out there instead — the same fields and pasture in the same
// palette, out of focus and falling away into the dark. Baked once per map at
// one pixel per SURROUND_Q metres and stretched up with smoothing on, which is
// the out-of-focus: there is deliberately nothing in it sharp enough to be
// mistaken for ground a unit could stand on.
export const SURROUND_M = 160; // metres of it on every side
const SURROUND_Q = 4; // metres per baked pixel
export const SURROUND_FAR: [number, number, number] = [22, 21, 16]; // what it fades to, and what the renderer fills the rest of the view with
function bakeSurround(w: number, h: number): HTMLCanvasElement {
  const cw = Math.ceil((w + SURROUND_M * 2) / SURROUND_Q);
  const chh = Math.ceil((h + SURROUND_M * 2) / SURROUND_Q);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = chh;
  const sg = c.getContext('2d')!;
  const img = sg.createImageData(cw, chh);
  const px = img.data;
  for (let j = 0; j < chh; j++) {
    for (let i = 0; i < cw; i++) {
      const wx = (i + 0.5) * SURROUND_Q - SURROUND_M;
      const wy = (j + 0.5) * SURROUND_Q - SURROUND_M;
      // how far outside the map this pixel is, in metres
      const out = Math.hypot(Math.max(0, -wx, wx - w), Math.max(0, -wy, wy - h));
      // pasture, drifting toward plough on one lattice and toward woods on
      // another, with a slower swell of value under both
      const t = blendPalette([blendPalette([GRASS, FIELD_VARIANTS[0]], soft(wx, wy, 46, 401)), WOODS_GROUND], soft(wx, wy, 70, 402) * 0.6);
      // (one level of noise per pixel: eight bits across a ramp this long band without it)
      const v = 0.84 + 0.14 * soft(wx, wy, 90, 403) + (hash(i, j, 404) - 0.5) * 0.02;
      // Falling away: a step down at the edge itself, so the limit of the map
      // still reads as one, then a long tail to the dark.
      const far = 1 - Math.exp(-out / 60);
      const f = Math.min(1, 0.22 + 0.78 * far);
      const o = (j * cw + i) * 4;
      px[o] = t[0] * v + (SURROUND_FAR[0] - t[0] * v) * f;
      px[o + 1] = t[1] * v + (SURROUND_FAR[1] - t[1] * v) * f;
      px[o + 2] = t[2] * v + (SURROUND_FAR[2] - t[2] * v) * f;
      px[o + 3] = 255;
    }
  }
  sg.putImageData(img, 0, 0);
  return c;
}

// The tree on a woods tile: where its crown is centred and its radius, or null
// where the stand has a gap. One rule for the bake and for anything laid over
// the baked crown afterwards (ambient.ts).
export function treeAt(map: GameMap, x: number, y: number): [number, number, number] | null {
  const wooded = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'woods';
  // Canopy-gap culling is only safe deep inside a stand, where the bare (darker)
  // woods floor sits under surrounding canopy. On an edge tile — any non-woods
  // orthogonal neighbor — a culled tree exposes the dark floor square against
  // the lighter grass, which reads as a hard dark rectangle. Keep edge trees.
  const interior = wooded(x - 1, y) && wooded(x + 1, y) && wooded(x, y - 1) && wooded(x, y + 1);
  if (interior && hash(x, y, 40) >= 0.55) return null;
  // the crown may overhang up to ~1 tile — chunks overscan by `pad`, so this is safe
  return [x + 0.3 + hash(x, y, 41) * 0.4, y + 0.3 + hash(x, y, 42) * 0.4, 0.55 + hash(x, y, 43) * 0.4];
}

function drawTree(g: Ctx, map: GameMap, x: number, y: number, band: number, d: Detail): void {
  const tree = treeAt(map, x, y);
  if (!tree) return;
  const [cx, cy, r] = tree;
  const wooded = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'woods';
  // mapgen plants orchards on a staggered 2-tile spacing, so a woods tile with
  // no orthogonal woods neighbour but woods two tiles out is a fruit tree, not
  // a forest tree
  const orchard =
    !wooded(x - 1, y) && !wooded(x + 1, y) && !wooded(x, y - 1) && !wooded(x, y + 1) &&
    (wooded(x - 2, y) || wooded(x + 2, y) || wooded(x, y - 2) || wooded(x, y + 2));
  const fam: 0 | 1 | 2 = orchard ? 2 : hash(x, y, 45) < 0.5 ? 0 : 1;
  // quantized so repeated trees reuse the same destination scale and the
  // browser's resample of the sprite stays predictable
  const k = Math.round((r / 0.75) * 8) / 8;
  const half = (CANOPY_SPRITE / 2) * k;
  g.drawImage(canopySprite(fam, (hash(x, y, 46) * 12) | 0, band, d), cx - half, cy - half, CANOPY_SPRITE * k, CANOPY_SPRITE * k);
}

// Interior partitions are not masonry (interiors R4). An exterior wall is
// 0.5-0.7 m of Norman rubble stone and a partition is 100 mm of lath and
// plaster, and drawing them with the same hairline pair was the reason a
// revealed interior read as a grid of cells rather than as rooms. Thinner,
// lighter, warmer — and legible as "you can hear through this".
//
// `pier` is the arcade case: a WALL stub with EDGE.NONE on both collinear
// sides is not a partition at all, it is one of the piers a nave arcade is
// made of (interiors §3.6 draws arcades as pier-and-gap runs so a squad can
// move through them). It is drawn as a blob of masonry on the edge midpoint
// with its own cast shadow. Restricted to churches by the caller, because the
// same geometry test also matches a barn's stall stubs and a one-tile partition
// in a small house, and turning either of those into a free-standing column
// would be a lie about the building.
//
// A church is also the one role that keeps MASONRY on its interior edges: a
// chancel wall is 0.6 m of the same stone as the nave's outside, and drawing it
// as a stud partition made the arch read like a bedroom door.
// Broken limestone, in the same family as the enclosure walls' TONES but a
// shade dirtier: a stone that has just come out of a wall carries its mortar.
const RUBBLE = ['rgb(134,127,113)', 'rgb(117,111,100)', 'rgb(146,138,122)', 'rgb(104,100,91)'];

function drawEdge(g: Ctx, e: number, x0: number, y0: number, x1: number, y1: number, interior = false, pier = false, top = 0): void {
  if (e === EDGE.NONE) return;
  const line = (w: number, color: string, t0 = 0, t1 = 1) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
    g.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
    g.stroke();
  };
  // A hole blown or crushed through masonry (D10). Strict plan projection: from
  // up here a breach is the two broken ends of the wall, the stone that came
  // out of it lying on the ground, and the shadow that stone throws. There is
  // no elevation view of a hole.
  //
  // The width code is the SIM's, not decoration — `map.ts` reads the same byte
  // to decide who can cross. BREACH_LIP keeps a knee-high ridge of spoil across
  // the gap (which is what BREACH_COVER is cover behind, and what SCRAMBLE
  // costs time to climb); BREACH_WIDE is what a tank drove through, swept clear
  // down the middle with the stone shouldered out to the sides.
  if (e === EDGE.BREACH) {
    const ux = x1 - x0;
    const uy = y1 - y0;
    const nx = -uy;
    const ny = ux;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const wide = top === BREACH_WIDE;
    const k = x0 * 2 + uy; // h and v edges on the same tile are different walls
    const [rdx, rdy] = shadowOffset(0.28);
    const spread = wide ? 0.6 : 0.46;
    const bar = (w: number, color: string, t0: number, t1: number, ox = 0, oy = 0) => {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x0 + ux * t0 + ox, y0 + uy * t0 + oy);
      g.lineTo(x0 + ux * t1 + ox, y0 + uy * t1 + oy);
      g.stroke();
    };
    // pulverised mortar on the ground, under everything: the pale halo that
    // says a wall came down here rather than never having been built
    g.fillStyle = 'rgba(198,188,164,0.18)';
    g.beginPath();
    g.ellipse(cx, cy, Math.abs(ux) * 0.5 + Math.abs(nx) * spread, Math.abs(uy) * 0.5 + Math.abs(ny) * spread, 0, 0, Math.PI * 2);
    g.fill();
    // the wall did not vanish, it BROKE — two stubs, in EDGE.WALL's own pair
    const stub = wide ? 0.1 : 0.2;
    for (const [t0, t1] of [[0, stub], [1 - stub, 1]] as const) {
      bar(0.3, '#2c241a', t0, t1);
      bar(0.14, '#4a4034', t0, t1);
    }
    if (!wide) {
      // the lip: spoil heaped across the opening, lower and wider than the wall
      bar(0.34, `rgba(12,14,9,${shadowSoftAlpha()})`, 0.24, 0.76, rdx * 1.3, rdy * 1.3);
      bar(0.3, `rgba(12,14,9,${shadowAlpha()})`, 0.26, 0.74, rdx * 0.7, rdy * 0.7);
      bar(0.26, RUBBLE[1], 0.26, 0.74);
      bar(0.1, 'rgba(224,216,194,0.24)', 0.3, 0.7, -rdx * 0.5, -rdy * 0.5);
    }
    const n = wide ? 9 : 11;
    const st: [number, number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      // Along the gap for a lip, shouldered out of it for a wide breach — the
      // scatter has to agree with what the sim says can drive through.
      const a = (hash(k, y0, 350 + i) - 0.5) * (wide ? 1.1 : 0.72);
      const off = wide ? 0.3 + hash(k, y0, 362 + i) * 0.48 : hash(k, y0, 362 + i) * 0.42;
      const b = (i & 1 ? off : -off) * (wide ? 1 : 0.9);
      st.push([
        cx + ux * a + nx * b,
        cy + uy * a + ny * b,
        0.05 + hash(k, y0, 374 + i) * 0.07,
        (hash(k, y0, 386 + i) - 0.5) * Math.PI,
      ]);
    }
    g.fillStyle = `rgba(12,14,9,${shadowAlpha()})`;
    for (const [sx, sy, r] of st) {
      g.beginPath();
      g.ellipse(sx + rdx, sy + rdy, r * 1.2, r * 0.86, 0, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < st.length; i++) {
      const [sx, sy, r, rot] = st[i];
      g.save();
      g.translate(sx, sy);
      g.rotate(rot);
      g.fillStyle = RUBBLE[i & 3];
      g.fillRect(-r, -r * 0.7, r * 2, r * 1.4);
      g.restore();
      // lit crown: the same footprint again, smaller and up-sun. Never a
      // rotated highlight — that would give every stone its own sun.
      g.save();
      g.translate(sx - rdx * 0.5, sy - rdy * 0.5);
      g.rotate(rot);
      g.fillStyle = 'rgba(228,220,198,0.26)';
      g.fillRect(-r * 0.66, -r * 0.46, r * 1.32, r * 0.92);
      g.restore();
    }
    return;
  }
  if (e === EDGE.WALL && pier) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const [sdx, sdy] = shadowOffset(0.3);
    const r = 0.22;
    g.fillStyle = `rgba(14,12,9,${shadowSoftAlpha()})`;
    g.fillRect(cx - r + sdx * 1.7, cy - r + sdy * 1.7, r * 2, r * 2);
    g.fillStyle = `rgba(14,12,9,${shadowAlpha()})`;
    g.fillRect(cx - r + sdx, cy - r + sdy, r * 2, r * 2);
    g.fillStyle = '#8a8073'; // dressed ashlar, warmer and lighter than the nave flags
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = 'rgba(234,228,208,0.24)';
    g.fillRect(cx - r, cy - r, r * 2, 0.06);
    g.fillRect(cx - r, cy - r, 0.06, r * 2);
    g.fillStyle = 'rgba(18,14,10,0.45)';
    g.fillRect(cx - r, cy + r - 0.06, r * 2, 0.06);
    g.fillRect(cx + r - 0.06, cy - r, 0.06, r * 2);
    return;
  }
  if (e === EDGE.WALL && interior) {
    line(0.18, 'rgba(46,38,28,0.85)');
    line(0.085, '#8d8271'); // plaster face
    return;
  }
  if (e === EDGE.WALL) {
    line(0.3, '#2c241a');
    line(0.14, '#4a4034');
  } else if (e === EDGE.DOOR) {
    line(0.3, '#2c241a', 0, 0.15);
    line(0.3, '#2c241a', 0.85, 1);
    line(0.16, '#7d5028', 0.12, 0.88); // door leaf
  } else {
    line(0.26, '#2c241a');
    line(0.11, '#7d8a8f', 0.2, 0.8); // glass
  }
}

// A baked chunk plus the staleness stamp it was baked at. Stale chunks keep
// serving until the rebake lands — see versions.ts.
interface Chunk {
  c: HTMLCanvasElement;
  ver: number;
}

export class TerrainLayer {
  private cache = new Map<string, Chunk>();
  private pixels = 0;
  private vers = new Versions();
  private chunksW: number;
  // Elevation with its whole-metre terraces smoothed back into slopes, for
  // the relief shade (ground.ts). Null on a flat map, whose chunks then take
  // exactly the path they took before there was any height.
  private relief: Float32Array | null;
  private reliefImg: HTMLCanvasElement | null = null; // its shade at one pixel per tile, under `reliefFor`
  private reliefFor: ReliefLight | null = null; // hillLightNow() hands out a new object per sun step
  private surround: HTMLCanvasElement | null = null; // the country past the map edge (bakeSurround), built on first draw
  private hasStairs: boolean;
  private bakeBudget = 0;
  private patches: PatchIndex;
  readonly hedges: Hedgerows;
  private paveMask: HTMLCanvasElement | null = null; // bakePaveMask, built on the first chunk of a map that has a square
  private yards: Yard[];
  // props bucketed by chunk key on their DRAWN extent (a telegraph wire spans
  // 6 m past its pole), so a chunk bake pays only for the clutter it shows and
  // nothing is ever clipped off at a seam
  private props = new Map<string, Prop[]>();
  // Free-standing masonry and the pockets it encloses (T18/T20). Empty on
  // every legacy kind — no legacy map writes a non-zero edge top — so those
  // chunks stay byte-identical.
  private enclos: EnclosureIndex;
  // Storefront dressing (T21) — likewise empty without building roles.
  private shops: Shopfront[];
  // Building role per buildingId (interiors R1/R2). Legacy maps carry no roles,
  // so every lookup returns ROLE.OTHER and every branch keyed on it takes the
  // plank/house default the renderer already had.
  private roles: Uint8Array;
  private across: Uint8Array;
  private hearths: number[];
  // Chebyshev ring round every hearth: 2 = touching, 1 = one out, 0 = no apron.
  // Null on any map without a hearth, which is every legacy map — the floor
  // branch then takes exactly the pre-interiors path.
  private apron: Uint8Array | null;
  // Railway line axis + track centreline (V4). Null on every kind without an
  // embankment, so the two new drawTileBase branches are unreachable there.
  private rail: RailIndex | null;
  /** Chunks painted flat this frame because the bake budget ran out (mobile). */
  readonly pending = new Set<string>();
  private flat = new Map<string, string>();
  // The sun step the current frame keys on, and the one before it. A sun step
  // is invalidation BY KEY — the old step's chunks stay in the cache, serve
  // through fallback() tier 2 while the new step bakes under the frame budget,
  // and age out of the LRU untouched. Versions stays breach-only: bumping it
  // for the sun would also dirty the pinned far-LOD bands, which must never
  // rebake for the sun (light.ts SUN_PIN_BAND).
  private curStep = sun().step;
  private prevStep = sun().step;

  constructor(private map: GameMap, buildings: readonly Building[] = []) {
    this.relief = map.elev.some((e) => e !== 0) ? smoothElev(map.elev, map.w, map.h) : null;
    this.hasStairs = map.stairs.some((s) => s !== 0);
    this.chunksW = Math.ceil(map.w / CHUNK);
    this.patches = new PatchIndex(map);
    this.hedges = buildHedgerows((x, y) => map.terrainKeyAt(x, y) === 'hedge', map.w, map.h);
    this.rail = railIndex(map);
    const churchTiles = new Uint8Array(map.w * map.h);
    for (const b of buildings) {
      if (b.role !== 'church' && b.role !== 'church_tower' && b.role !== 'church_apse') continue;
      for (const p of b.parts ?? [b]) {
        for (let y = Math.max(0, p.y); y < Math.min(map.h, p.y + p.h); y++)
          for (let x = Math.max(0, p.x); x < Math.min(map.w, p.x + p.w); x++) churchTiles[y * map.w + x] = 1;
      }
    }
    this.enclos = new EnclosureIndex(map, churchTiles);
    this.shops = shopfrontsFor(map, buildings);
    const bidx = buildingIndex(map, buildings);
    this.roles = bidx.role;
    this.across = bidx.across;
    this.hearths = hearthTiles(map);
    this.apron = null;
    if (this.hearths.length > 0) {
      const a = new Uint8Array(map.w * map.h);
      for (const i of this.hearths) {
        const hx = i % map.w;
        const hy = (i / map.w) | 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = hx + dx;
            const y = hy + dy;
            if (!map.inBounds(x, y) || map.buildingIdAt(x, y) !== map.buildingIdAt(hx, hy)) continue;
            const ring = Math.max(Math.abs(dx), Math.abs(dy)) <= 1 ? 2 : 1;
            const k = y * map.w + x;
            if (a[k] < ring) a[k] = ring;
          }
        }
      }
      this.apron = a;
    }
    this.yards = buildYards(
      map,
      this.patches,
      (wx, wy) => {
        const id = this.enclos.enclosureIdAt(Math.floor(wx), Math.floor(wy));
        return id >= 0 ? this.enclos.enclosures[id].kind : null;
      },
      // The generator's enclosure walls stand already: no yard run may cross
      // or double them.
      this.enclos.runs.map((r) => [r.ax, r.ay, r.bx, r.by]),
    );
    for (const p of propsFor(map, this.patches, this.enclos)) {
      const [ex0, ey0, ex1, ey1] = propExtent(p);
      for (let cy = Math.floor(ey0 / CHUNK); cy <= Math.floor(ey1 / CHUNK); cy++) {
        for (let cx = Math.floor(ex0 / CHUNK); cx <= Math.floor(ex1 / CHUNK); cx++) {
          const k = `${cx},${cy}`;
          const arr = this.props.get(k);
          if (arr) arr.push(p);
          else this.props.set(k, [p]);
        }
      }
    }
  }

  // The parcel/junction index is built here and nowhere else — it costs ~1 ms
  // per map, so anything else that needs it (old-crater picks in the renderer)
  // borrows this instance rather than rebuilding one.
  get index(): PatchIndex {
    return this.patches;
  }

  private roleAt = (x: number, y: number): number => {
    const id = this.map.buildingIdAt(x, y);
    return id < 0 ? ROLE.OTHER : (this.roles[id] ?? ROLE.OTHER);
  };

  // An edge is INTERIOR when both flanking tiles belong to the same building —
  // the same test drawDoorTrails uses to tell an internal door from an external
  // one, and the rule interiors D10 gives the generator for which edges the
  // furnishing pass owns. A party wall between two terraced units has two
  // different ids on its flanks and stays masonry, which is right: it is.
  private sameBuilding(ax: number, ay: number, bx: number, by: number): boolean {
    const a = this.map.buildingIdAt(ax, ay);
    return a >= 0 && a === this.map.buildingIdAt(bx, by);
  }

  private acrossAt = (x: number, y: number): number => {
    const id = this.map.buildingIdAt(x, y);
    return id < 0 ? 0 : (this.across[id] ?? 0);
  };

  private chunk(cx: number, cy: number, band: number, step: number): HTMLCanvasElement {
    const key = `${cx},${cy},${band},${step}`;
    const ver = this.vers.at(cy * this.chunksW + cx);
    const hit = this.cache.get(key);
    // A stale chunk is not a missing one: it holds the right ground with the
    // wrong wall in it, so it keeps drawing until there is budget to redo it.
    // Rebaking every dirtied chunk the frame it is dirtied is the stall the
    // whole amortization exists to prevent, and a sun step dirties all of them.
    if (hit && (hit.ver === ver || this.bakeBudget <= 0)) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit.c;
    }
    if (hit) {
      this.cache.delete(key);
      this.pixels -= hit.c.width * hit.c.height;
    }
    this.bakeBudget--;
    const d = detailFor(band);
    const c = document.createElement('canvas');
    // 1-tile gutter on all sides so downscale sampling never bleeds past the edge
    c.width = c.height = (CHUNK + 2) * band;
    const g = c.getContext('2d')!;
    g.scale(band, band);
    g.translate(1 - cx * CHUNK, 1 - cy * CHUNK);
    g.lineCap = 'round';
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const pad = 2; // overscan so trees from neighbor tiles spill in correctly
    const tx0 = Math.max(0, x0 - pad);
    const ty0 = Math.max(0, y0 - pad);
    const tx1 = Math.min(this.map.w, x0 + CHUNK + pad);
    const ty1 = Math.min(this.map.h, y0 + CHUNK + pad);
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) drawTileBase(g, this.map, this.patches, x, y, band, d, this.roleAt, this.apron, this.rail);
    }
    drawGrassTufts(g, this.map, tx0, ty0, tx1, ty1, band, d);
    drawCropRows(g, this.map, this.patches, tx0, ty0, tx1, ty1, d);
    // after the rows, so a cut corner is not ruled with its old parcel's
    // furrows; before the paving and the wear, which lie on top of the ground
    softenGround(g, this.map, this.patches, tx0, ty0, tx1, ty1, d);
    if (this.patches.squares.length > 0) this.paveMask ??= bakePaveMask(this.patches, this.map.w, this.map.h);
    drawPaving(g, this.map, this.patches, tx0, ty0, tx1, ty1, band, d, this.paveMask);
    drawRoadWear(g, this.map, tx0, ty0, tx1, ty1, d, (x, y) => this.patches.pavedAt(x, y));
    // after the wear pass, which would otherwise lay ruts across the timbers
    if (this.rail) {
      drawCrossings(g, this.map, tx0, ty0, tx1, ty1, d, this.rail);
      drawTrackRun(g, this.map, tx0, ty0, tx1, ty1, d, this.rail);
    }
    drawWaterBanks(g, this.map, tx0, ty0, tx1, ty1);
    drawYardGround(g, this.map, this.patches, this.yards, tx0, ty0, tx1, ty1, d);
    drawEnclosureGround(g, this.map, this.enclos, tx0, ty0, tx1, ty1, d);
    drawDoorTrails(g, this.map, tx0, ty0, tx1, ty1);
    // Interiors, under the roof: rugs lie on the floor, furniture stands on the
    // rug, and both are post-passes because a piece's contact shadow spills
    // into the tile SE of it — the base loop would paint the next floor over it.
    drawRugs(g, this.map, this.roleAt, tx0, ty0, tx1, ty1, d);
    drawFurniture(g, this.map, this.roleAt, this.acrossAt, tx0, ty0, tx1, ty1, band);
    drawYardStructures(g, this.map, this.patches, this.yards, tx0, ty0, tx1, ty1, d);
    drawHedgerows(g, this.hedges, tx0, ty0, tx1, ty1, d);
    if (d >= 1) {
      // Fallen trunks, deep inside a stand only, ~1 per 50 woods tiles. Drawn
      // before the canopies so a tree overlaps the log rather than the log
      // sitting on top of the leaves.
      for (let y = ty0; y < ty1; y++) {
        for (let x = tx0; x < tx1; x++) {
          if (this.map.terrainKeyAt(x, y) !== 'woods' || hash(x, y, 270) >= 0.02) continue;
          const wooded = (tx: number, ty: number) => this.map.inBounds(tx, ty) && this.map.terrainKeyAt(tx, ty) === 'woods';
          if (!wooded(x - 1, y) || !wooded(x + 1, y) || !wooded(x, y - 1) || !wooded(x, y + 1)) continue;
          drawLog(g, x + 0.5, y + 0.5, x * 977 + y);
        }
      }
    }
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        if (this.map.terrainKeyAt(x, y) === 'woods') drawTree(g, this.map, x, y, band, d);
      }
    }
    for (const p of this.props.get(`${cx},${cy}`) ?? []) drawProp(g, p, band, d);
    drawEnclosurePlanting(g, this.map, this.enclos, tx0, ty0, tx1, ty1, band, d);
    drawShopfronts(g, this.shops, tx0, ty0, tx1, ty1, d);
    // Free-standing masonry owns its own edges — drawEdge's generic hairline
    // would sit under the rubble as a dark seam and, on a gate, draw a second
    // door leaf across the plank one.
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        if (this.enclos.ownsH(x, y)) continue;
        const church = this.roleAt(x, y) === ROLE.CHURCH;
        const inside = this.sameBuilding(x, y - 1, x, y);
        const pier = inside && church && this.map.hEdge(x - 1, y) === EDGE.NONE && this.map.hEdge(x + 1, y) === EDGE.NONE;
        drawEdge(g, this.map.hEdge(x, y), x, y, x + 1, y, inside && !church, pier, this.map.hEdgeTop(x, y));
      }
    }
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x <= tx1; x++) {
        if (this.enclos.ownsV(x, y)) continue;
        const church = this.roleAt(x, y) === ROLE.CHURCH;
        const inside = this.sameBuilding(x - 1, y, x, y);
        const pier = inside && church && this.map.vEdge(x, y - 1) === EDGE.NONE && this.map.vEdge(x, y + 1) === EDGE.NONE;
        drawEdge(g, this.map.vEdge(x, y), x, y, x, y + 1, inside && !church, pier, this.map.vEdgeTop(x, y));
      }
    }
    drawEnclosureWalls(g, this.enclos, tx0, ty0, tx1, ty1, d);
    if (this.relief) {
      const light = hillLightNow();
      if (!this.reliefImg || this.reliefFor !== light) {
        this.reliefImg = bakeRelief(this.relief, this.map.w, this.map.h, light);
        this.reliefFor = light;
      }
      // Two tiles of margin: one for the chunk's gutter, one so the
      // interpolation at the gutter's edge has a real neighbour to read
      // rather than the clamped edge of the source rect, which would show as
      // a seam between chunks.
      const rx0 = Math.max(0, x0 - 2);
      const ry0 = Math.max(0, y0 - 2);
      const rw = Math.min(this.map.w, x0 + CHUNK + 2) - rx0;
      const rh = Math.min(this.map.h, y0 + CHUNK + 2) - ry0;
      g.imageSmoothingEnabled = true; // bilinear between tile centres: this IS the softening
      g.drawImage(this.reliefImg, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
    }
    this.cache.set(key, { c, ver });
    this.pixels += c.width * c.height;
    for (const [k, v] of this.cache) {
      if (this.pixels <= PIXEL_BUDGET) break;
      this.cache.delete(k);
      this.pixels -= v.c.width * v.c.height;
    }
    return c;
  }

  // --- invalidation (D9) -----------------------------------------------------
  //
  // The sim mutates edge bytes mid-battle (a breach) and the sun will start
  // moving (N4/N5). Both are the same question — "which baked chunks no longer
  // match their inputs" — and both are answered by bumping a version rather
  // than by deleting a canvas: see versions.ts for why deletion is the wrong
  // tool. Callers are the renderer's breach drain and, later, its sun step.

  /** Chunks that draw tiles [x0,x1]x[y0,y1] are stale. */
  invalidateTiles(x0: number, y0: number, x1: number, y1: number): void {
    const [cx0, cx1] = chunkSpan(x0, x1, this.chunksW);
    const [cy0, cy1] = chunkSpan(y0, y1, Math.ceil(this.map.h / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.vers.bump(cy * this.chunksW + cx);
  }

  /**
   * A single edge byte changed. One tile of slack around it, because the
   * rubble tumble and the spall a breach draws overhang the edge itself.
   */
  invalidateEdge(x: number, y: number): void {
    this.invalidateTiles(x - 1, y - 1, x + 1, y + 1);
  }

  /**
   * Re-derive the free-standing masonry index against the mutated map and
   * invalidate whatever its runs moved under. A breach splits one wall run into
   * two, and the rubble coursing is phased along a run, so the whole run
   * repaints — not just the metre with the hole in it.
   */
  breachEnclosures(): void {
    const box = this.enclos.refresh();
    if (box) this.invalidateTiles(box[0], box[1], box[2], box[3]);
  }

  // Per-band sun-step key components. Bands at or under the pin always key on
  // step 0 (light.ts SUN_PIN_BAND), so for them "previous" IS "current".
  private stepFor(band: number): number {
    return band <= SUN_PIN_BAND ? 0 : this.curStep;
  }
  private prevStepFor(band: number): number {
    return band <= SUN_PIN_BAND ? 0 : this.prevStep;
  }

  // Same chunk baked under some other key — three tiers, in the order the
  // design argues (§5.1):
  //   1. current sun step, another band — right shadows, wrong sharpness
  //   2. previous sun step, same band  — right sharpness, shadows one 18°
  //      bucket stale (far less visible than a resolution drop: the shadow is
  //      a fraction of the frame's ink, the resolution is all of it)
  //   3. previous sun step, another band
  // Only the previous step is searched, not every step that ever existed: sun
  // steps are monotone through a battle and a typical engagement crosses at
  // most one boundary, so cur+prev covers the cache's real population.
  // Source rect origin is always that band's own 1-tile gutter, which is what
  // keeps the blit aligned.
  private fallback(cx: number, cy: number, band: number): [HTMLCanvasElement, number] | null {
    for (let i = BANDS.length - 1; i >= 0; i--) {
      const b = BANDS[i];
      if (b === band) continue;
      const c = this.cache.get(`${cx},${cy},${b},${this.stepFor(b)}`);
      if (c) return [c.c, b];
    }
    if (this.prevStep === this.curStep) return null;
    const pb = this.prevStepFor(band);
    if (pb !== this.stepFor(band)) {
      const c = this.cache.get(`${cx},${cy},${band},${pb}`);
      if (c) return [c.c, band];
    }
    for (let i = BANDS.length - 1; i >= 0; i--) {
      const b = BANDS[i];
      if (b === band) continue;
      const p = this.prevStepFor(b);
      if (p === this.stepFor(b)) continue; // pinned band: already tried in tier 1
      const c = this.cache.get(`${cx},${cy},${b},${p}`);
      if (c) return [c.c, b];
    }
    return null;
  }

  // Flat stand-in for a chunk that has nothing cached at any band and no
  // budget left to bake: the chunk's dominant terrain colour, so the hole
  // reads as ground rather than as a white square. Tallied once per chunk.
  private flatColor(cx: number, cy: number): string {
    const key = `${cx},${cy}`;
    const hit = this.flat.get(key);
    if (hit) return hit;
    const tally = new Map<TerrainKey, number>();
    const x1 = Math.min(this.map.w, (cx + 1) * CHUNK);
    const y1 = Math.min(this.map.h, (cy + 1) * CHUNK);
    for (let y = cy * CHUNK; y < y1; y++) {
      for (let x = cx * CHUNK; x < x1; x++) {
        const k = this.map.terrainKeyAt(x, y);
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
    }
    let best: TerrainKey = 'grass';
    let bestN = -1;
    for (const [k, n] of tally) if (n > bestN) { best = k; bestN = n; }
    const c = TERRAIN[best].color;
    this.flat.set(key, c);
    return c;
  }

  // The out-of-focus country round the map, under the terrain. One blit, and
  // none at all while the view is wholly inside the map.
  drawSurround(ctx: Ctx, cam: Camera, cw: number, ch: number): void {
    const [x0, y0] = cam.worldToScreen(0, 0, cw, ch);
    const [x1, y1] = cam.worldToScreen(this.map.w, this.map.h, cw, ch);
    if (x0 <= 0 && y0 <= 0 && x1 >= cw && y1 >= ch) return;
    this.surround ??= bakeSurround(this.map.w, this.map.h);
    const [sx, sy] = cam.worldToScreen(-SURROUND_M, -SURROUND_M, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.surround, sx, sy, (this.map.w + SURROUND_M * 2) * cam.scale, (this.map.h + SURROUND_M * 2) * cam.scale);
  }

  draw(ctx: Ctx, cam: Camera, cw: number, ch: number): void {
    this.bakeBudget = MOBILE ? MOBILE_BAKES_PER_FRAME : BAKES_PER_FRAME;
    const band = BANDS.find((b) => b >= cam.scale) ?? BANDS[BANDS.length - 1];
    const live = sun().step;
    if (live !== this.curStep) {
      this.prevStep = this.curStep;
      this.curStep = live;
    }
    const step = this.stepFor(band);
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    const cx0 = Math.max(0, Math.floor(wx0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(wy0 / CHUNK));
    const cx1 = Math.min(Math.ceil(this.map.w / CHUNK) - 1, Math.floor(wx1 / CHUNK));
    const cy1 = Math.min(Math.ceil(this.map.h / CHUNK) - 1, Math.floor(wy1 / CHUNK));
    const size = CHUNK * cam.scale;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy},${band},${step}`;
        const [sx, sy] = cam.worldToScreen(cx * CHUNK, cy * CHUNK, cw, ch);
        if (this.bakeBudget <= 0 && !this.cache.has(key)) {
          const fb = this.fallback(cx, cy, band);
          if (fb) {
            ctx.drawImage(fb[0], fb[1], fb[1], CHUNK * fb[1], CHUNK * fb[1], sx, sy, size, size);
            continue;
          }
          if (MOBILE) {
            this.pending.add(key);
            ctx.fillStyle = this.flatColor(cx, cy);
            ctx.fillRect(sx, sy, size, size);
            continue;
          }
        }
        this.pending.delete(key);
        ctx.drawImage(this.chunk(cx, cy, band, step), band, band, CHUNK * band, CHUNK * band, sx, sy, size, size);
      }
    }
  }

  // Firelight from every revealed hearth. Same gating as drawStairs and for the
  // same reason, plus one of its own: a flicker cannot be baked, and rebaking a
  // chunk per frame is 2-5 ms of chunk work every frame.
  drawHearthGlow(ctx: Ctx, cam: Camera, cw: number, ch: number, now: number, visible: (x: number, y: number) => boolean): void {
    if (this.hearths.length === 0) return;
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    ctx.save();
    const [ox, oy] = cam.worldToScreen(0, 0, cw, ch);
    ctx.translate(ox, oy);
    ctx.scale(cam.scale, cam.scale);
    drawHearthGlow(ctx, this.map, this.hearths, Math.floor(wx0) - 2, Math.floor(wy0) - 2, Math.ceil(wx1) + 2, Math.ceil(wy1) + 2, now, visible);
    ctx.restore();
  }

  // Stair glyphs over the visible window only — a dynamic pass (not baked
  // into chunks) because visibility depends on the roof-fade state: a glyph
  // shows only when its building's interior is revealed (`visible` predicate,
  // supplied by the renderer from RoofLayer).
  drawStairs(ctx: Ctx, cam: Camera, cw: number, ch: number, visible: (x: number, y: number) => boolean): void {
    if (!this.hasStairs) return;
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    const x0 = Math.max(0, Math.floor(wx0));
    const y0 = Math.max(0, Math.floor(wy0));
    const x1 = Math.min(this.map.w - 1, Math.ceil(wx1));
    const y1 = Math.min(this.map.h - 1, Math.ceil(wy1));
    ctx.save();
    const [ox, oy] = cam.worldToScreen(0, 0, cw, ch);
    ctx.translate(ox, oy);
    ctx.scale(cam.scale, cam.scale);
    ctx.lineCap = 'round';
    // The lit lip on each tread sits on the tread's up-sun edge and fades with
    // the cast ramp — a bright lip on the wrong side of every step at 07:00 is
    // exactly the kind of thing plan view has no other cue to hide, and at
    // night there is no sun to catch. This is a per-frame pass, so it reads
    // the live sun; at the canonical hour it is the shipped hard-coded lip.
    const s = sun();
    const lip = s.alphaMul >= 0.02 ? `rgba(255,250,235,${0.35 * s.alphaMul})` : null;
    const lipN = SUN.dy >= 0; // shadows travel +y => the north edge catches the light
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.map.isStair(x, y) || !visible(x, y)) continue;
        // steps: three ascending treads, dark with a lit up-sun lip (same sun)
        for (let i = 0; i < 3; i++) {
          const t = y + 0.2 + i * 0.2;
          ctx.fillStyle = 'rgba(20,16,12,0.55)';
          ctx.fillRect(x + 0.18 + i * 0.06, t, 0.64 - i * 0.12, 0.12);
          if (!lip) continue;
          ctx.fillStyle = lip;
          ctx.fillRect(x + 0.18 + i * 0.06, lipN ? t : t + 0.09, 0.64 - i * 0.12, 0.03);
        }
      }
    }
    ctx.restore();
  }
}
