import { EDGE, type GameMap } from '../sim/map';
import type { Camera } from './camera';
import { AO_ALPHA, SHADOW_ALPHA, SHADOW_SOFT_ALPHA, SUN, shadowOffset } from './light';

// Terrain is rendered lazily into 16x16-tile chunk canvases at the nearest
// zoom band >= camera scale (so it is only ever downscaled — always crisp),
// with an LRU pixel budget. Replaces the single fixed-resolution prerender,
// which could not survive the 2-48 px/m zoom range or 500x500 m maps.

const CHUNK = 16; // tiles per side
const BANDS = [4, 8, 16, 32, 48];
const PIXEL_BUDGET = 24_000_000; // ~96 MB of cached RGBA

import { hash } from './noise';

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
const CANOPY_A: [number, number, number] = [52, 78, 42];
const CANOPY_B: [number, number, number] = [44, 68, 46];
const FLOOR: [number, number, number] = [160, 145, 122];
const FLOOR_DARK: [number, number, number] = [141, 120, 95];
const WATER: [number, number, number] = [70, 90, 99]; // desaturated slate, muted-Normandy — not postcard blue
const FIELD_VARIANTS: [number, number, number][] = [
  [96, 84, 58], // turned earth
  [142, 124, 71], // wheat
  [107, 111, 62], // green cover crop
];

type Ctx = CanvasRenderingContext2D;

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

function drawTileBase(g: Ctx, map: GameMap, x: number, y: number): void {
  const t = map.terrainKeyAt(x, y);
  const v = 0.93 + coarse(x, y) * 0.1 + hash(x, y) * 0.04;
  if (t === 'grass') {
    const base = blendPalette([GRASS, GRASS_DRY], macro(x, y));
    // 2x2 sub-tile sampling — each quadrant gets its own coarse() read
    // instead of one flat value per tile, which is what made the grass
    // read as a visible 1m checkerboard at high zoom.
    for (let sub = 0; sub < 4; sub++) {
      const ox = sub & 1;
      const oy = sub >> 1;
      const sx = x + ox * 0.5;
      const sy = y + oy * 0.5;
      const sv = 0.88 + coarse(sx + 0.25, sy + 0.25) * 0.16 + hash(x, y, sub) * 0.05;
      g.fillStyle = shade(base, sv);
      g.fillRect(sx, sy, 0.5, 0.5);
    }
    for (let i = 0; i < 5; i++) {
      const h1 = hash(x, y, 10 + i);
      const h2 = hash(x, y, 20 + i);
      const sz = 0.05 + hash(x, y, 35 + i) * 0.05;
      g.fillStyle = hash(x, y, 30 + i) > 0.7 ? shade(GRASS_DRY, 1.15) : shade(GRASS, h1 > 0.5 ? 1.18 : 0.78);
      g.fillRect(x + h1, y + h2, sz, sz);
    }
  } else if (t === 'road') {
    g.fillStyle = shade(ROAD, v);
    g.fillRect(x, y, 1, 1);
    g.fillStyle = 'rgba(0,0,0,0.07)';
    for (let i = 0; i < 2; i++) {
      g.beginPath();
      g.arc(x + hash(x, y, 3 + i), y + hash(x, y, 5 + i), 0.05 + hash(x, y, 7 + i) * 0.08, 0, Math.PI * 2);
      g.fill();
    }
    const roadAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'road';
    const n = roadAt(x, y - 1);
    const s = roadAt(x, y + 1);
    const w = roadAt(x - 1, y);
    const e = roadAt(x + 1, y);
    // shoulders on every edge that isn't road, dust-tan hue bleeding inward
    g.fillStyle = 'rgba(0,0,0,0.15)';
    if (!n) g.fillRect(x, y, 1, 0.12);
    if (!s) g.fillRect(x, y + 0.88, 1, 0.12);
    if (!w) g.fillRect(x, y, 0.12, 1);
    if (!e) g.fillRect(x + 0.88, y, 0.12, 1);
    g.fillStyle = 'rgba(168,140,92,0.12)';
    if (!n) g.fillRect(x, y + 0.12, 1, 0.1);
    if (!s) g.fillRect(x, y + 0.78, 1, 0.1);
    if (!w) g.fillRect(x + 0.12, y, 0.1, 1);
    if (!e) g.fillRect(x + 0.78, y, 0.1, 1);
    // twin wheel ruts along the road's running direction
    g.fillStyle = 'rgba(0,0,0,0.1)';
    if (w || e) {
      g.fillRect(x, y + 0.22, 1, 0.09);
      g.fillRect(x, y + 0.69, 1, 0.09);
    } else {
      g.fillRect(x + 0.22, y, 0.09, 1);
      g.fillRect(x + 0.69, y, 0.09, 1);
    }
  } else if (t === 'woods') {
    g.fillStyle = shade(WOODS_GROUND, v);
    g.fillRect(x, y, 1, 1);
    // leaf litter / undergrowth texture
    for (let i = 0; i < 4; i++) {
      const lx = x + hash(x, y, 80 + i);
      const ly = y + hash(x, y, 85 + i);
      g.fillStyle = hash(x, y, 90 + i) > 0.45 ? 'rgba(20,24,14,0.22)' : 'rgba(120,110,70,0.16)';
      g.beginPath();
      g.ellipse(lx, ly, 0.09 + hash(x, y, 95 + i) * 0.08, 0.05 + hash(x, y, 96 + i) * 0.05, hash(x, y, 97 + i) * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  } else if (t === 'hedge') {
    const isHedge = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'hedge';
    const n = isHedge(x, y - 1);
    const s = isHedge(x, y + 1);
    const w = isHedge(x - 1, y);
    const e = isHedge(x + 1, y);
    g.fillStyle = shade(WOODS_GROUND, v * 0.88);
    g.fillRect(x, y, 1, 1);
    const width = 0.58 + hash(x, y, 51) * 0.3;
    const [sdx, sdy] = shadowOffset(0.4);
    // base AO: subtle all-around ground darkening at the hedge's foot
    g.lineWidth = width * 1.3;
    g.strokeStyle = `rgba(8,10,7,${AO_ALPHA * 0.6})`;
    hedgePath(g, x, y, n, s, w, e, 0, 0);
    g.stroke();
    // soft two-layer SE cast shadow
    g.lineWidth = width * 1.15;
    g.strokeStyle = `rgba(10,14,8,${SHADOW_SOFT_ALPHA})`;
    hedgePath(g, x, y, n, s, w, e, sdx * 1.6, sdy * 1.6);
    g.stroke();
    g.lineWidth = width * 1.1;
    g.strokeStyle = `rgba(10,14,8,${SHADOW_ALPHA})`;
    hedgePath(g, x, y, n, s, w, e, sdx, sdy);
    g.stroke();
    // hedge mass — yellower, denser green than woods
    g.lineWidth = width;
    g.strokeStyle = shade(HEDGE_GREEN, 0.82 + hash(x, y, 52) * 0.3);
    hedgePath(g, x, y, n, s, w, e, 0, 0);
    g.stroke();
    // NW rim catching the sun
    g.lineWidth = width * 0.3;
    g.strokeStyle = `rgba(190,215,150,${0.1 + hash(x, y, 53) * 0.12})`;
    hedgePath(g, x, y, n, s, w, e, -sdx * 0.3, -sdy * 0.3);
    g.stroke();
  } else if (t === 'field') {
    const bx = x >> 3; // 8m parcel block — furrow geometry only, color stays smooth
    const by = y >> 3;
    const base = blendPalette(FIELD_VARIANTS, macro(x, y));
    g.fillStyle = shade(base, v);
    g.fillRect(x, y, 1, 1);
    const horizontal = hash(bx, by, 71) < 0.5;
    const spacing = 0.4 + hash(bx, by, 73) * 0.25;
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
    // dark bank line where water meets land
    const waterAt = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'water';
    g.fillStyle = 'rgba(30,38,32,0.35)';
    if (!waterAt(x, y - 1)) g.fillRect(x, y, 1, 0.12);
    if (!waterAt(x, y + 1)) g.fillRect(x, y + 0.88, 1, 0.12);
    if (!waterAt(x - 1, y)) g.fillRect(x, y, 0.12, 1);
    if (!waterAt(x + 1, y)) g.fillRect(x + 0.88, y, 0.12, 1);
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

function drawTree(g: Ctx, map: GameMap, x: number, y: number): void {
  const wooded = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'woods';
  const isolated = !wooded(x - 1, y) && !wooded(x + 1, y) && !wooded(x, y - 1) && !wooded(x, y + 1);
  if (!isolated && hash(x, y, 40) >= 0.55) return;
  const cx = x + 0.3 + hash(x, y, 41) * 0.4;
  const cy = y + 0.3 + hash(x, y, 42) * 0.4;
  const r = 0.55 + hash(x, y, 43) * 0.4; // may overhang up to ~1 tile — chunks overscan by `pad`, so this is safe
  g.fillStyle = 'rgba(10,16,8,0.3)';
  g.beginPath();
  g.ellipse(cx + 0.18, cy + 0.22, r, r * 0.9, 0, 0, Math.PI * 2);
  g.fill();
  const canopy = hash(x, y, 45) < 0.5 ? CANOPY_A : CANOPY_B;
  g.fillStyle = shade(canopy, 0.85 + hash(x, y, 44) * 0.35);
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 0.07;
  g.stroke();
  g.fillStyle = 'rgba(190,220,150,0.18)';
  g.beginPath();
  g.arc(cx - r * 0.25, cy - r * 0.25, r * 0.55, 0, Math.PI * 2);
  g.fill();
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

  constructor(private map: GameMap) {
    // Flat maps (all elev 0, no stairs) early-out everywhere below, so their
    // chunks stay byte-identical to the pre-height renderer.
    this.hasElev = map.elev.some((e) => e !== 0);
    this.hasStairs = map.stairs.some((s) => s !== 0);
  }

  private chunk(cx: number, cy: number, band: number): HTMLCanvasElement {
    const key = `${cx},${cy},${band}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit;
    }
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
      for (let x = tx0; x < tx1; x++) drawTileBase(g, this.map, x, y);
    }
    for (let y = ty0; y < ty1; y++) {
      for (let x = tx0; x < tx1; x++) {
        if (this.map.terrainKeyAt(x, y) === 'woods') drawTree(g, this.map, x, y);
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

  draw(ctx: Ctx, cam: Camera, cw: number, ch: number): void {
    const band = BANDS.find((b) => b >= cam.scale) ?? 48;
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    const cx0 = Math.max(0, Math.floor(wx0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(wy0 / CHUNK));
    const cx1 = Math.min(Math.ceil(this.map.w / CHUNK) - 1, Math.floor(wx1 / CHUNK));
    const cy1 = Math.min(Math.ceil(this.map.h / CHUNK) - 1, Math.floor(wy1 / CHUNK));
    const size = CHUNK * cam.scale;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [sx, sy] = cam.worldToScreen(cx * CHUNK, cy * CHUNK, cw, ch);
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
