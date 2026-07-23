import type { Building } from '../sim/mapgen';
import type { Sim } from '../sim/sim';
import type { Camera } from './camera';
import { AO_ALPHA, SHADOW_ALPHA, SHADOW_SOFT_ALPHA, shadowOffset } from './light';

// Gable roofs drawn over building footprints (sim.buildings, from the map
// plan). A roof fades out when the camera is zoomed in close or a friendly
// soldier is inside, revealing the interior (interiors are ordinary walkable
// sim space).

const OVERHANG = 0.35; // meters past the walls
const FADE_SCALE = 14; // px/m at which zoom alone reveals interiors
const PALETTES = ['#8a4b37', '#77503c', '#5a5e65'];
const BIG_ROOF_AREA = 45; // w*h threshold for weathering "patched tile" flecks

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

interface RoofArt {
  ridgeAlongX: boolean;
  lit: string;
  shade: string;
  gable: string;
  chimney: { x: number; y: number; s: number };
  chimneyShadow: { x: number; y: number };
  flecks: { x: number; y: number; s: number }[];
}

// Per-building roof look, computed once when the buildings list changes (not
// per frame): weathering jitter, lit/shade slope tints, and hash-placed
// chimney/patch positions so identical palette entries don't look cloned.
function buildArt(b: Building, i: number): RoofArt {
  const ridgeAlongX = b.w >= b.h;
  const x = b.x - OVERHANG;
  const y = b.y - OVERHANG;
  const w = b.w + OVERHANG * 2;
  const h = b.h + OVERHANG * 2;

  const valueJitter = 1 + (hash(i, 60) - 0.5) * 0.12; // ±6%
  const hueJitter = (hash(i, 61) - 0.5) * 16;
  const weathered = tint(hexToRgb(PALETTES[i % PALETTES.length]), valueJitter, hueJitter);
  const lit = rgbStr(tint(weathered, 1.22, 9));
  const shade = rgbStr(tint(weathered, 0.7, -9));
  const gable = rgbStr(tint(weathered, 0.5, -12));

  const t = 0.22 + hash(i, 62) * 0.56;
  const po = (hash(i, 63) - 0.5) * 0.25;
  const s = 0.32 + hash(i, 64) * 0.14;
  const cx = ridgeAlongX ? x + t * w : x + w / 2 + po;
  const cy = ridgeAlongX ? y + h / 2 + po : y + t * h;
  const [sdx, sdy] = shadowOffset(0.18);
  const chimney = { x: cx - s / 2, y: cy - s / 2, s };
  const chimneyShadow = { x: chimney.x + sdx, y: chimney.y + sdy };

  const flecks: { x: number; y: number; s: number }[] = [];
  if (b.w * b.h >= BIG_ROOF_AREA) {
    const n = hash(i, 65) < 0.5 ? 2 : 3;
    for (let f = 0; f < n; f++) {
      flecks.push({
        x: x + w * (0.15 + hash(i, 70 + f) * 0.7),
        y: y + h * (0.15 + hash(i, 75 + f) * 0.7),
        s: 0.25 + hash(i, 80 + f) * 0.2,
      });
    }
  }
  return { ridgeAlongX, lit, shade, gable, chimney, chimneyShadow, flecks };
}

export class RoofLayer {
  private buildings: Building[] = [];
  private alphas: number[] = [];
  private art: RoofArt[] = [];

  update(sim: Sim, cam: Camera, dt: number): void {
    if (this.buildings !== sim.buildings) {
      this.buildings = sim.buildings;
      this.alphas = this.buildings.map(() => 1);
      this.art = this.buildings.map(buildArt);
    }
    this.buildings.forEach((b, i) => {
      const inside = sim.soldiers.some(
        (s) => s.alive && s.side === 'blue' && s.x >= b.x && s.x < b.x + b.w && s.y >= b.y && s.y < b.y + b.h,
      );
      const target = cam.scale > FADE_SCALE || inside ? 0.12 : 1;
      const a = this.alphas[i];
      this.alphas[i] = a + (target - a) * Math.min(1, dt * 6);
    });
  }

  private withWorldTransform(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number, f: () => void): void {
    ctx.save();
    const [ox, oy] = cam.worldToScreen(0, 0, cw, ch);
    ctx.translate(ox, oy);
    ctx.scale(cam.scale, cam.scale);
    f();
    ctx.restore();
  }

  drawShadows(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      // core offset (0.71m) matches the old fixed (0.45,0.55) rect offset in
      // magnitude; the soft layer extends further along the same sun direction.
      const [sdx, sdy] = shadowOffset(0.71);
      const [sdxSoft, sdySoft] = shadowOffset(1.1);
      this.buildings.forEach((b, i) => {
        // shadow tracks the roof fade: a faded roof (zoomed-in interior reveal)
        // must not leave a full-footprint shadow rect stranded on the ground
        // with no roof above it — it reads as a dark terrain stain.
        const a = this.alphas[i];
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
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      this.buildings.forEach((b, i) => {
        const a = this.alphas[i];
        if (a < 0.01) return;
        ctx.globalAlpha = a;
        const art = this.art[i];
        const x = b.x - OVERHANG;
        const y = b.y - OVERHANG;
        const w = b.w + OVERHANG * 2;
        const h = b.h + OVERHANG * 2;
        const ridgeAlongX = art.ridgeAlongX;
        // two slopes tinted off the per-building weathered base color: NW
        // slope lit (lighter + warm), SE slope shaded (darker + cool)
        ctx.fillStyle = art.shade;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = art.lit;
        if (ridgeAlongX) ctx.fillRect(x, y, w, h / 2);
        else ctx.fillRect(x, y, w / 2, h);
        // gable-end darker triangles at both ridge ends
        const gableDepth = ridgeAlongX ? Math.min(0.45, h * 0.4) : Math.min(0.45, w * 0.4);
        ctx.fillStyle = art.gable;
        ctx.beginPath();
        if (ridgeAlongX) {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + h);
          ctx.lineTo(x + gableDepth, y + h / 2);
          ctx.closePath();
          ctx.moveTo(x + w, y);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x + w - gableDepth, y + h / 2);
          ctx.closePath();
        } else {
          ctx.moveTo(x, y);
          ctx.lineTo(x + w, y);
          ctx.lineTo(x + w / 2, y + gableDepth);
          ctx.closePath();
          ctx.moveTo(x, y + h);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x + w / 2, y + h - gableDepth);
          ctx.closePath();
        }
        ctx.fill();
        // tile courses parallel to the ridge
        ctx.strokeStyle = 'rgba(0,0,0,0.14)';
        ctx.lineWidth = 0.045;
        ctx.beginPath();
        if (ridgeAlongX) {
          for (let ty = y + 0.4; ty < y + h; ty += 0.4) {
            ctx.moveTo(x, ty);
            ctx.lineTo(x + w, ty);
          }
        } else {
          for (let tx = x + 0.4; tx < x + w; tx += 0.4) {
            ctx.moveTo(tx, y);
            ctx.lineTo(tx, y + h);
          }
        }
        ctx.stroke();
        // ridge cap
        ctx.strokeStyle = 'rgba(255,235,210,0.35)';
        ctx.lineWidth = 0.12;
        ctx.beginPath();
        if (ridgeAlongX) {
          ctx.moveTo(x + 0.1, y + h / 2);
          ctx.lineTo(x + w - 0.1, y + h / 2);
        } else {
          ctx.moveTo(x + w / 2, y + 0.1);
          ctx.lineTo(x + w / 2, y + h - 0.1);
        }
        ctx.stroke();
        // weathering: darker "patched tile" flecks on big roofs
        if (art.flecks.length) {
          ctx.fillStyle = 'rgba(15,12,10,0.22)';
          for (const f of art.flecks) ctx.fillRect(f.x, f.y, f.s, f.s);
        }
        // chimney, drawn above the courses, with its own tiny SE shadow
        ctx.fillStyle = `rgba(10,12,8,${SHADOW_ALPHA})`;
        ctx.fillRect(art.chimneyShadow.x, art.chimneyShadow.y, art.chimney.s, art.chimney.s);
        ctx.fillStyle = '#3a342e';
        ctx.fillRect(art.chimney.x, art.chimney.y, art.chimney.s, art.chimney.s);
        ctx.strokeStyle = 'rgba(20,16,12,0.5)';
        ctx.lineWidth = 0.02;
        ctx.strokeRect(art.chimney.x, art.chimney.y, art.chimney.s, art.chimney.s);
        // eave outline
        ctx.strokeStyle = 'rgba(20,16,12,0.6)';
        ctx.lineWidth = 0.08;
        ctx.strokeRect(x, y, w, h);
        ctx.globalAlpha = 1;
      });
    });
  }
}
