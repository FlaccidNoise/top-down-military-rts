import { EDGE, type GameMap } from '../sim/map';
import type { Camera } from './camera';

// Terrain is rendered lazily into 16x16-tile chunk canvases at the nearest
// zoom band >= camera scale (so it is only ever downscaled — always crisp),
// with an LRU pixel budget. Replaces the single fixed-resolution prerender,
// which could not survive the 2-48 px/m zoom range or 500x500 m maps.

const CHUNK = 16; // tiles per side
const BANDS = [4, 8, 16, 32, 48];
const PIXEL_BUDGET = 24_000_000; // ~96 MB of cached RGBA

// Deterministic per-tile hash, 0..1. Salt picks independent streams.
function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) ^ 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

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

function shade(base: [number, number, number], f: number): string {
  return `rgb(${Math.round(base[0] * f)},${Math.round(base[1] * f)},${Math.round(base[2] * f)})`;
}

const GRASS: [number, number, number] = [78, 107, 63];
const ROAD: [number, number, number] = [138, 129, 114];
const WOODS_GROUND: [number, number, number] = [56, 76, 48];
const FLOOR: [number, number, number] = [160, 145, 122];
const FIELD: [number, number, number] = [106, 114, 69];

type Ctx = CanvasRenderingContext2D;

function drawTileBase(g: Ctx, map: GameMap, x: number, y: number): void {
  const t = map.terrainKeyAt(x, y);
  const v = 0.93 + coarse(x, y) * 0.1 + hash(x, y) * 0.04;
  if (t === 'grass') {
    g.fillStyle = shade(GRASS, v);
    g.fillRect(x, y, 1, 1);
    for (let i = 0; i < 3; i++) {
      const h1 = hash(x, y, 10 + i);
      const h2 = hash(x, y, 20 + i);
      g.fillStyle = shade(GRASS, h1 > 0.5 ? 1.18 : 0.8);
      g.fillRect(x + h1, y + h2, 0.07, 0.07);
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
    // shoulder where road meets non-road
    g.fillStyle = 'rgba(0,0,0,0.15)';
    if (map.terrainKeyAt(x, y - 1) !== 'road' && map.inBounds(x, y - 1)) g.fillRect(x, y, 1, 0.12);
    if (map.terrainKeyAt(x, y + 1) !== 'road' && map.inBounds(x, y + 1)) g.fillRect(x, y + 0.88, 1, 0.12);
  } else if (t === 'woods') {
    g.fillStyle = shade(WOODS_GROUND, v);
    g.fillRect(x, y, 1, 1);
  } else if (t === 'hedge') {
    g.fillStyle = shade(WOODS_GROUND, v * 0.92);
    g.fillRect(x, y, 1, 1);
    for (let i = 0; i < 3; i++) {
      const cx = x + 0.2 + hash(x, y, 50 + i) * 0.6;
      const cy = y + 0.2 + hash(x, y, 55 + i) * 0.6;
      const r = 0.28 + hash(x, y, 60 + i) * 0.2;
      g.fillStyle = shade([52, 82, 44], 0.8 + hash(x, y, 65 + i) * 0.4);
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
  } else if (t === 'field') {
    g.fillStyle = shade(FIELD, v);
    g.fillRect(x, y, 1, 1);
    g.fillStyle = 'rgba(0,0,0,0.10)';
    g.fillRect(x, y + 0.15, 1, 0.12);
    g.fillRect(x, y + 0.65, 1, 0.12);
  } else {
    // floor: plank shading per row, seams between rows, staggered butt joints
    g.fillStyle = shade(FLOOR, 0.92 + hash(0, y, 7) * 0.14);
    g.fillRect(x, y, 1, 1);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(x, y, 1, 0.035);
    if (hash(x, y, 8) < 0.3) g.fillRect(x + hash(x, y, 9), y, 0.035, 1);
  }
}

function drawTree(g: Ctx, map: GameMap, x: number, y: number): void {
  const wooded = (tx: number, ty: number) => map.inBounds(tx, ty) && map.terrainKeyAt(tx, ty) === 'woods';
  const isolated = !wooded(x - 1, y) && !wooded(x + 1, y) && !wooded(x, y - 1) && !wooded(x, y + 1);
  if (!isolated && hash(x, y, 40) >= 0.55) return;
  const cx = x + 0.3 + hash(x, y, 41) * 0.4;
  const cy = y + 0.3 + hash(x, y, 42) * 0.4;
  const r = 0.55 + hash(x, y, 43) * 0.4;
  g.fillStyle = 'rgba(10,16,8,0.3)';
  g.beginPath();
  g.ellipse(cx + 0.18, cy + 0.22, r, r * 0.9, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = shade([46, 74, 40], 0.85 + hash(x, y, 44) * 0.35);
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
    line(0.16, '#8a5a30', 0.12, 0.88); // door leaf
  } else {
    line(0.26, '#2c241a');
    line(0.11, '#a8ccd8', 0.2, 0.8); // glass
  }
}

export class TerrainLayer {
  private cache = new Map<string, HTMLCanvasElement>();
  private pixels = 0;

  constructor(private map: GameMap) {}

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
}
