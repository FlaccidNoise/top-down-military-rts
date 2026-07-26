import { TERRAIN, type TerrainKey } from '../sim/data';
import { EDGE, type GameMap } from '../sim/map';
import type { Camera } from './camera';
import { AO_ALPHA, SHADOW_ALPHA, SHADOW_SOFT_ALPHA, SUN, shadowOffset } from './light';
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

import { hash, vec } from './noise';
import { stamp, stampRect } from './stamps';
import { canopySprite, drawLog } from './canopy';
import { PatchIndex, type BuildingBox } from './patches';

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
const FIELD_VARIANTS: [number, number, number][] = [
  [96, 84, 58], // turned earth
  [142, 124, 71], // wheat
  [107, 111, 62], // green cover crop
];

type Ctx = CanvasRenderingContext2D;

// Grass is the largest surface in the frame, so its cost per tile has to be
// one blit. A tuft stamp carries everything the old 5-rect speckle loop could
// not afford: soft mottle bands running along the local mowing direction,
// 3-4 clumps of tapered blades leaning the same way, and a dark contact tick
// under each clump so tufts sit ON the ground instead of floating. All
// geometry stays inside 0.05..0.95 m — a blade crossing the stamp edge would
// make the 1 m lattice visible as a grid, which rule 3 forbids.
const GRASS_VARIANTS = 12;

function grassStamp(v: number, axis: number, bloom: boolean, band: number): HTMLCanvasElement {
  return stamp(`grass:${bloom ? 'bloom' : 'tuft'}:${v}:${axis}`, band, 1, (g) => {
    const ax = axis === 0 ? 1 : 0;
    const ay = axis === 0 ? 0 : 1;
    // Bands sit anywhere across the stamp, not on a fixed pitch: three evenly
    // spaced bands per tile line up tile-to-tile into a visible 0.3 m stripe
    // rhythm across a whole field, which is the grid rule 3 forbids.
    const bands = 2 + ((hash(v, 1, 207) * 2) | 0);
    for (let i = 0; i < bands; i++) {
      const len = 0.5 + hash(v * 5 + i, 1, 206) * 0.4;
      const wid = 0.1 + hash(v * 5 + i, 2, 206) * 0.08;
      const off = 0.05 + hash(v * 5 + i, 3, 206) * (0.9 - len);
      const t = 0.1 + hash(v * 5 + i, 0, 206) * 0.8;
      const a = 0.05 + hash(v * 5 + i, 4, 206) * 0.04;
      g.fillStyle = i % 2 ? `rgba(206,216,164,${a.toFixed(3)})` : `rgba(26,34,18,${a.toFixed(3)})`;
      g.fillRect(ax * off + ay * (t - wid / 2), ay * off + ax * (t - wid / 2), ax * len + ay * wid, ay * len + ax * wid);
    }
    const clumps = 3 + ((hash(v, 0, 207) * 2) | 0);
    for (let c = 0; c < clumps; c++) {
      const cx = 0.16 + hash(v * 7 + c, 0, 208) * 0.68;
      const cy = 0.16 + hash(v * 7 + c, 1, 208) * 0.68;
      g.fillStyle = 'rgba(18,22,14,0.25)';
      g.fillRect(cx - 0.05, cy - 0.014, 0.1, 0.028);
      const n = 4 + ((hash(v * 7 + c, 2, 208) * 3) | 0);
      for (let i = 0; i < n; i++) {
        const k = v * 97 + c * 11 + i;
        const ang = (axis === 0 ? 0 : Math.PI / 2) + (hash(k, 0, 209) - 0.5) * 0.7;
        const len = 0.1 + hash(k, 1, 209) * 0.12;
        const sx = Math.min(0.9, Math.max(0.08, cx + (hash(k, 2, 209) - 0.5) * 0.18));
        const sy = Math.min(0.9, Math.max(0.08, cy + (hash(k, 3, 209) - 0.5) * 0.18));
        const tone = hash(k, 4, 209);
        g.strokeStyle = tone > 0.66 ? shade(GRASS, 1.22) : tone > 0.33 ? shade(GRASS_DRY, 1.1) : shade(GRASS, 0.72);
        g.lineWidth = 0.03 + hash(k, 5, 209) * 0.025;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(Math.min(0.95, Math.max(0.05, sx + Math.cos(ang) * len)), Math.min(0.95, Math.max(0.05, sy + Math.sin(ang) * len)));
        g.stroke();
      }
    }
    if (!bloom) return;
    // Meadow bloom: cream / pale ochre / dusty mauve, all under the muted
    // ceiling. Deliberately tiny and never at d<2 — a red dot at mid zoom
    // reads as a unit marker.
    const petals = 5 + ((hash(v, 0, 215) * 5) | 0);
    for (let i = 0; i < petals; i++) {
      const k = v * 13 + i;
      const px = 0.1 + hash(k, 0, 215) * 0.8;
      const py = 0.1 + hash(k, 1, 215) * 0.8;
      const t = hash(k, 2, 215);
      g.fillStyle = t > 0.6 ? 'rgba(228,224,198,0.60)' : t > 0.3 ? 'rgba(208,188,122,0.50)' : 'rgba(162,142,158,0.45)';
      g.beginPath();
      g.arc(px, py, 0.015 + hash(k, 3, 215) * 0.01, 0, Math.PI * 2);
      g.fill();
    }
  });
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

// One-sun hillshade (height phase D): lambertian shade per elev tile from the
// shared NW sun. Direction TO the sun is the opposite of the SE shadow
// direction in light.ts; sun elevation ~40° (tan ≈ 0.84). Shade is expressed
// as a delta from the flat-surface lambert term so perfectly flat ground is
// untouched even before the hasElev early-out.
const SUN_Z = 0.84;
const LIGHT_LEN = Math.hypot(SUN.dx, SUN.dy, SUN_Z);
const LIGHT = { x: -SUN.dx / LIGHT_LEN, y: -SUN.dy / LIGHT_LEN, z: SUN_Z / LIGHT_LEN };
const FLAT_DOT = LIGHT.z; // n·L for n = (0,0,1)
const HILLSHADE = 0.45; // subtle multiply/overlay strength

// Lambertian shade overlay for one tile: central differences on elev
// (clamped) give the normal; the dot delta from FLAT_DOT lights NW-facing
// slopes and darkens SE-facing ones.
function drawHillshade(g: Ctx, map: GameMap, x: number, y: number): void {
  const dzdx = Math.max(-8, Math.min(8, (map.elevAt(x + 1, y) - map.elevAt(x - 1, y)) / 2));
  const dzdy = Math.max(-8, Math.min(8, (map.elevAt(x, y + 1) - map.elevAt(x, y - 1)) / 2));
  if (dzdx === 0 && dzdy === 0) return;
  const nl = Math.hypot(dzdx, dzdy, 1);
  const dot = (-dzdx * LIGHT.x + -dzdy * LIGHT.y + LIGHT.z) / nl;
  const d = (dot - FLAT_DOT) * HILLSHADE;
  if (Math.abs(d) < 0.004) return;
  g.fillStyle = d > 0 ? `rgba(255,250,235,${Math.min(0.5, d)})` : `rgba(8,10,14,${Math.min(0.5, -d)})`;
  g.fillRect(x, y, 1, 1);
}

// Path for a hedge tile's continuous mass: a stroke segment toward each
// hedge-tagged neighbor (round line caps turn a zero-length segment into a
// dot), so adjacent hedge tiles fuse into one capsule instead of four gappy
// pompoms. `odx/ody` offsets the whole path (used to draw the shadow/AO
// passes without rebuilding the neighbor logic).
function hedgePath(g: Ctx, x: number, y: number, n: boolean, s: boolean, w: boolean, e: boolean, odx: number, ody: number): void {
  const cx = x + 0.5 + odx;
  const cy = y + 0.5 + ody;
  g.beginPath();
  if (!n && !s && !w && !e) {
    g.moveTo(cx, cy);
    g.lineTo(cx, cy);
    return;
  }
  if (n) {
    g.moveTo(cx, cy);
    g.lineTo(x + 0.5 + odx, y + ody);
  }
  if (s) {
    g.moveTo(cx, cy);
    g.lineTo(x + 0.5 + odx, y + 1 + ody);
  }
  if (w) {
    g.moveTo(cx, cy);
    g.lineTo(x + odx, y + 0.5 + ody);
  }
  if (e) {
    g.moveTo(cx, cy);
    g.lineTo(x + 1 + odx, y + 0.5 + ody);
  }
}

// Hedge capsule strokes for a tile range, one visual layer at a time across
// ALL hedge tiles (AO → cast shadow → green mass → sun rim → foliage dabs).
// Width/shade vary via the smooth 8m/28m noise fields, not per-tile hash, so
// adjacent tiles never show a width or value step at the boundary.
function drawHedgeRun(g: Ctx, map: GameMap, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  const isHedge = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'hedge';
  const tiles: { x: number; y: number; n: boolean; s: boolean; w: boolean; e: boolean; width: number }[] = [];
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (!isHedge(x, y)) continue;
      tiles.push({ x, y, n: isHedge(x, y - 1), s: isHedge(x, y + 1), w: isHedge(x - 1, y), e: isHedge(x + 1, y), width: 0.58 + coarse(x, y) * 0.3 });
    }
  }
  if (tiles.length === 0) return;
  const [sdx, sdy] = shadowOffset(0.4);
  const pass = (widthOf: (t: (typeof tiles)[0]) => number, styleOf: (t: (typeof tiles)[0]) => string, odx: number, ody: number) => {
    for (const t of tiles) {
      g.lineWidth = widthOf(t);
      g.strokeStyle = styleOf(t);
      hedgePath(g, t.x, t.y, t.n, t.s, t.w, t.e, odx, ody);
      g.stroke();
    }
  };
  // base AO: subtle all-around ground darkening at the hedge's foot
  pass((t) => t.width * 1.3, () => `rgba(8,10,7,${AO_ALPHA * 0.6})`, 0, 0);
  // soft two-layer SE cast shadow
  pass((t) => t.width * 1.15, () => `rgba(10,14,8,${SHADOW_SOFT_ALPHA})`, sdx * 1.6, sdy * 1.6);
  pass((t) => t.width * 1.1, () => `rgba(10,14,8,${SHADOW_ALPHA})`, sdx, sdy);
  // earth bank under the foliage: a bocage hedge grows out of a raised bank,
  // and without it the run reads as a green sausage lying on the lawn
  pass((t) => t.width * 1.25, () => 'rgba(72,58,38,0.35)', 0.06, 0.08);
  pass((t) => 0.05, () => 'rgba(14,18,10,0.4)', 0.06 + sdx * 0.5, 0.08 + sdy * 0.5);
  // hedge mass — yellower, denser green than woods
  pass((t) => t.width, (t) => shade(HEDGE_GREEN, 0.82 + macro(t.x, t.y) * 0.3), 0, 0);
  // NW rim catching the sun
  pass((t) => t.width * 0.3, (t) => `rgba(190,215,150,${0.1 + coarse(t.x, t.y) * 0.12})`, -sdx * 0.3, -sdy * 0.3);
  // foliage dabs: the per-tile lumpiness the old hash width/shade jitter gave,
  // without the boundary steps — small blobs never cross a tile seam visibly
  const dabs = d === 0 ? 0 : d === 1 ? 3 : 6;
  for (const t of tiles) {
    const vertical = (t.n || t.s) && !(t.w || t.e);
    for (let i = 0; i < dabs; i++) {
      const k = t.x * 8 + i;
      let dx = t.x + 0.28 + hash(k, t.y, 54) * 0.44;
      let dy = t.y + 0.28 + hash(k, t.y, 55) * 0.44;
      // two dabs ride the silhouette so the run's outline goes ragged instead
      // of staying a smooth capsule; they stay near the mass tone, because a
      // dark blob half-off the hedge reads as a floating speck on the grass
      const rim = i < 2;
      if (rim) {
        const s = i === 0 ? 1 : -1;
        const u = 0.2 + hash(k, t.y, 58) * 0.6;
        dx = vertical ? t.x + 0.5 + s * t.width * 0.5 : t.x + u;
        dy = vertical ? t.y + u : t.y + 0.5 + s * t.width * 0.5;
      }
      const light = hash(k, t.y, 56) > 0.5;
      g.fillStyle = shade(HEDGE_GREEN, rim ? (light ? 1.05 : 0.78) : light ? 1.22 : 0.64);
      g.beginPath();
      g.arc(dx, dy, 0.06 + hash(k, t.y, 57) * 0.08, 0, Math.PI * 2);
      g.fill();
    }
  }
  if (d < 2) return;
  // bare twigs where a run stops — the cut end of a hedgerow is sticks, not foliage
  g.strokeStyle = 'rgba(58,50,34,0.5)';
  g.lineWidth = 0.035;
  for (const t of tiles) {
    if (Number(t.n) + Number(t.s) + Number(t.w) + Number(t.e) > 1) continue;
    for (let i = 0; i < 3; i++) {
      const k = t.x * 4 + i;
      const a = hash(k, t.y, 59) * Math.PI * 2;
      const sx = t.x + 0.35 + hash(k, t.y, 60) * 0.3;
      const sy = t.y + 0.35 + hash(k, t.y, 61) * 0.3;
      const l = 0.2 + hash(k, t.y, 62) * 0.2;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
      g.stroke();
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
function drawPaving(g: Ctx, map: GameMap, patches: PatchIndex, tx0: number, ty0: number, tx1: number, ty1: number, band: number, d: Detail): void {
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
  if (patches.squares.length === 0) return;
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
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const a = weight(x, y);
      if (a <= 0.01) continue;
      g.globalAlpha = a;
      if (d >= 1) g.drawImage(cobbleStamp((hash(x, y, 278) * 6) | 0, band), x, y, 1, 1);
      else {
        g.fillStyle = 'rgb(122,115,102)';
        g.fillRect(x, y, 1, 1);
      }
      g.globalAlpha = 1;
    }
  }
  // kerb: hard civic boundary wherever paving meets unpaved ground
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (weight(x, y) <= 0.35) continue;
      const sides: [number, number, number, number, number, number][] = [
        [0, -1, x, y, 1, 0.1],
        [0, 1, x, y + 0.9, 1, 0.1],
        [-1, 0, x, y, 0.1, 1],
        [1, 0, x + 0.9, y, 0.1, 1],
      ];
      for (const [dx, dy, rx, ry, rw, rh] of sides) {
        if (weight(x + dx, y + dy) > 0.35) continue;
        // only where paving meets soft ground — a kerb across the open road
        // where the ramp happens to fade would cut the run in half
        if (roadAt(x + dx, y + dy)) continue;
        g.fillStyle = 'rgba(158,150,132,0.50)';
        g.fillRect(rx, ry, rw, rh);
        g.fillStyle = 'rgba(30,26,20,0.30)';
        g.fillRect(rx + dx * 0.1, ry + dy * 0.1, dx !== 0 ? 0.04 : rw, dy !== 0 ? 0.04 : rh);
      }
    }
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

// 2x2 sub-tile sampling of the woods-ground tone (same fix grass got — a
// single flat per-tile value reads as a 1m checkerboard through canopy gaps
// at high zoom). `darken` dims it under hedges.
function drawSubTileGround(g: Ctx, x: number, y: number, darken = 1): void {
  for (let sub = 0; sub < 4; sub++) {
    const sx = x + (sub & 1) * 0.5;
    const sy = y + (sub >> 1) * 0.5;
    const sv = (0.9 + coarse(sx + 0.25, sy + 0.25) * 0.12 + hash(x, y, sub) * 0.04) * darken;
    g.fillStyle = shade(WOODS_GROUND, sv);
    g.fillRect(sx, sy, 0.5, 0.5);
  }
}

// 2x2 sub-tile sampling — each quadrant gets its own coarse() read instead of
// one flat value per tile, which is what made the grass read as a visible 1m
// checkerboard at high zoom.
function drawGrassBase(g: Ctx, x: number, y: number): void {
  const base = blendPalette([GRASS, GRASS_DRY], macro(x, y));
  for (let sub = 0; sub < 4; sub++) {
    const sx = x + (sub & 1) * 0.5;
    const sy = y + (sub >> 1) * 0.5;
    g.fillStyle = shade(base, 0.88 + coarse(sx + 0.25, sy + 0.25) * 0.16 + hash(x, y, sub) * 0.05);
    g.fillRect(sx, sy, 0.5, 0.5);
  }
}

function drawTileBase(g: Ctx, map: GameMap, x: number, y: number, band: number, d: Detail): void {
  const t = map.terrainKeyAt(x, y);
  const v = 0.93 + coarse(x, y) * 0.1 + hash(x, y) * 0.04;
  if (t === 'grass') {
    drawGrassBase(g, x, y);
    if (d >= 1) {
      const [fdx, fdy] = vec(x + 0.5, y + 0.5, 205, 34);
      const axis = Math.abs(fdx) > Math.abs(fdy) ? 0 : 1;
      // offset lattice so flower patches are uncorrelated with the hue drift
      const bloom = d >= 2 && macro(x + 411, y + 87) > 0.63;
      g.drawImage(grassStamp((hash(x, y, 201) * GRASS_VARIANTS) | 0, axis, bloom, band), x, y, 1, 1);
    }
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
    drawSubTileGround(g, x, y);
    if (d >= 1) g.drawImage(litterStamp((hash(x, y, 265) * 8) | 0, d, band), x, y, 1, 1);
  } else if (t === 'hedge') {
    // Ground under the hedge only — the capsule strokes are drawn by
    // drawHedgeRun in whole-run passes (per-tile stroke stacks let a tile's
    // dark AO/shadow overpaint the neighbor's green mass, which is what read
    // as per-tile capsule segmentation at 24 px/m). It is the ordinary grass
    // base, not the dark woods floor: a hedge run is narrower than its tiles,
    // and the dark tone left a 1 m square halo around every hedge tile.
    drawGrassBase(g, x, y);
  } else if (t === 'field') {
    const bx = x >> 3; // 8m parcel block — furrow geometry only, color stays smooth
    const by = y >> 3;
    const base = blendPalette(FIELD_VARIANTS, macro(x, y));
    g.fillStyle = shade(base, v);
    g.fillRect(x, y, 1, 1);
    const horizontal = hash(bx, by, 71) < 0.5;
    // far LOD keeps the macro row structure but at <=1 row/tile — the full
    // 0.4-0.65 m pitch aliases into moiré below 8 px/m
    const spacing = (0.4 + hash(bx, by, 73) * 0.25) * (d === 0 ? 2.6 : 1);
    const phase = hash(bx, by, 72) * spacing;
    g.fillStyle = 'rgba(0,0,0,0.1)';
    if (horizontal) {
      for (let fy = Math.ceil((y - phase) / spacing) * spacing + phase; fy < y + 1; fy += spacing) {
        g.fillRect(x, fy - 0.045, 1, 0.09);
      }
    } else {
      for (let fx = Math.ceil((x - phase) / spacing) * spacing + phase; fx < x + 1; fx += spacing) {
        g.fillRect(fx - 0.045, y, 0.09, 1);
      }
    }
    // darker boundary strip where the field meets non-field
    const fieldAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'field';
    g.fillStyle = 'rgba(40,32,20,0.18)';
    if (!fieldAt(x, y - 1)) g.fillRect(x, y, 1, 0.08);
    if (!fieldAt(x, y + 1)) g.fillRect(x, y + 0.92, 1, 0.08);
    if (!fieldAt(x - 1, y)) g.fillRect(x, y, 0.08, 1);
    if (!fieldAt(x + 1, y)) g.fillRect(x + 0.92, y, 0.08, 1);
  } else if (t === 'water') {
    g.fillStyle = shade(WATER, 0.9 + coarse(x, y) * 0.12 + hash(x, y, 91) * 0.05);
    g.fillRect(x, y, 1, 1);
    // faint N→S drift streaks with the current
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 2; i++) {
      if (hash(x, y, 92 + i) < 0.35)
        g.fillRect(x + hash(x, y, 94 + i) * 0.9, y + hash(x, y, 96 + i) * 0.6, 0.06, 0.3 + hash(x, y, 98 + i) * 0.3);
    }
    // bank treatment lives in drawWaterBanks (post-pass — the mud fringe
    // paints onto neighboring land tiles, which raster order would overpaint)
  } else {
    // floor: plank rows every 0.33m, two wood tones, staggered butt joints.
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
}

function drawTree(g: Ctx, map: GameMap, x: number, y: number, band: number, d: Detail): void {
  const wooded = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'woods';
  // Canopy-gap culling is only safe deep inside a stand, where the bare (darker)
  // woods floor sits under surrounding canopy. On an edge tile — any non-woods
  // orthogonal neighbor — a culled tree exposes the dark floor square against
  // the lighter grass, which reads as a hard dark rectangle. Keep edge trees.
  const interior = wooded(x - 1, y) && wooded(x + 1, y) && wooded(x, y - 1) && wooded(x, y + 1);
  if (interior && hash(x, y, 40) >= 0.55) return;
  const cx = x + 0.3 + hash(x, y, 41) * 0.4;
  const cy = y + 0.3 + hash(x, y, 42) * 0.4;
  const r = 0.55 + hash(x, y, 43) * 0.4; // may overhang up to ~1 tile — chunks overscan by `pad`, so this is safe
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
  g.drawImage(canopySprite(fam, (hash(x, y, 46) * 12) | 0, band, d), cx - 1.5 * k, cy - 1.5 * k, 3 * k, 3 * k);
}

function drawEdge(g: Ctx, e: number, x0: number, y0: number, x1: number, y1: number): void {
  if (e === EDGE.NONE) return;
  const line = (w: number, color: string, t0 = 0, t1 = 1) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
    g.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
    g.stroke();
  };
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

export class TerrainLayer {
  private cache = new Map<string, HTMLCanvasElement>();
  private pixels = 0;
  private hasElev: boolean;
  private hasStairs: boolean;
  private bakeBudget = 0;
  private patches: PatchIndex;
  /** Chunks painted flat this frame because the bake budget ran out (mobile). */
  readonly pending = new Set<string>();
  private flat = new Map<string, string>();

  constructor(private map: GameMap) {
    // Flat maps (all elev 0, no stairs) early-out everywhere below, so their
    // chunks stay byte-identical to the pre-height renderer.
    this.hasElev = map.elev.some((e) => e !== 0);
    this.hasStairs = map.stairs.some((s) => s !== 0);
    this.patches = new PatchIndex(map);
  }

  private chunk(cx: number, cy: number, band: number): HTMLCanvasElement {
    const key = `${cx},${cy},${band}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit;
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
      for (let x = tx0; x < tx1; x++) drawTileBase(g, this.map, x, y, band, d);
    }
    drawPaving(g, this.map, this.patches, tx0, ty0, tx1, ty1, band, d);
    drawRoadWear(g, this.map, tx0, ty0, tx1, ty1, d, (x, y) => this.patches.pavedAt(x, y));
    drawWaterBanks(g, this.map, tx0, ty0, tx1, ty1);
    drawDoorTrails(g, this.map, tx0, ty0, tx1, ty1);
    drawHedgeRun(g, this.map, tx0, ty0, tx1, ty1, d);
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
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x < tx1; x++) drawEdge(g, this.map.hEdge(x, y), x, y, x + 1, y);
    }
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x <= tx1; x++) drawEdge(g, this.map.vEdge(x, y), x, y, x, y + 1);
    }
    if (this.hasElev) {
      for (let y = ty0; y < ty1; y++) {
        for (let x = tx0; x < tx1; x++) drawHillshade(g, this.map, x, y);
      }
    }
    this.cache.set(key, c);
    this.pixels += c.width * c.height;
    for (const [k, v] of this.cache) {
      if (this.pixels <= PIXEL_BUDGET) break;
      this.cache.delete(k);
      this.pixels -= v.width * v.height;
    }
    return c;
  }

  // Same chunk baked at some other band — same content, wrong sharpness. Walk
  // from the crispest down; source rect origin is always that band's own
  // 1-tile gutter, which is what keeps the blit aligned.
  private fallback(cx: number, cy: number, band: number): [HTMLCanvasElement, number] | null {
    for (let i = BANDS.length - 1; i >= 0; i--) {
      const b = BANDS[i];
      if (b === band) continue;
      const c = this.cache.get(`${cx},${cy},${b}`);
      if (c) return [c, b];
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

  draw(ctx: Ctx, cam: Camera, cw: number, ch: number): void {
    this.bakeBudget = MOBILE ? MOBILE_BAKES_PER_FRAME : BAKES_PER_FRAME;
    const band = BANDS.find((b) => b >= cam.scale) ?? BANDS[BANDS.length - 1];
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    const cx0 = Math.max(0, Math.floor(wx0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(wy0 / CHUNK));
    const cx1 = Math.min(Math.ceil(this.map.w / CHUNK) - 1, Math.floor(wx1 / CHUNK));
    const cy1 = Math.min(Math.ceil(this.map.h / CHUNK) - 1, Math.floor(wy1 / CHUNK));
    const size = CHUNK * cam.scale;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy},${band}`;
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
        ctx.drawImage(this.chunk(cx, cy, band), band, band, CHUNK * band, CHUNK * band, sx, sy, size, size);
      }
    }
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
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.map.isStair(x, y) || !visible(x, y)) continue;
        // steps: three ascending treads, dark with a lit NW lip (same sun)
        for (let i = 0; i < 3; i++) {
          const t = y + 0.2 + i * 0.2;
          ctx.fillStyle = 'rgba(20,16,12,0.55)';
          ctx.fillRect(x + 0.18 + i * 0.06, t, 0.64 - i * 0.12, 0.12);
          ctx.fillStyle = 'rgba(255,250,235,0.35)';
          ctx.fillRect(x + 0.18 + i * 0.06, t, 0.64 - i * 0.12, 0.03);
        }
      }
    }
    ctx.restore();
  }
}
