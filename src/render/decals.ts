import type { Camera } from './camera';
import { hash } from './noise';

// Persistent battle scarring — mortar scorches, blood smears from dragged
// casualties. Drawn once into a world-aligned offscreen canvas and blitted
// each frame between terrain and soldiers. Render-only. Blast scars (scorch,
// grit) and blood (pool, spatter) take their variety from `hash`, so the VFX
// gate reshoots the same crater; the smears still use Math.random.

const PPM = 8; // px per meter; soft marks don't need more

export class DecalLayer {
  private c: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;

  constructor(w: number, h: number) {
    this.c = document.createElement('canvas');
    this.c.width = w * PPM;
    this.c.height = h * PPM;
    this.g = this.c.getContext('2d')!;
    this.g.scale(PPM, PPM);
    this.g.lineCap = 'round';
  }

  // Crater look (E6): small dark core + a distinct raised-earth rim ring,
  // short ejecta streaks, tight gradient falloff (no huge blurred starburst).
  scorch(x: number, y: number, mult = 1): void {
    const g = this.g;
    const hx = Math.round(x * 100);
    const hy = Math.round(y * 100);
    const r = (0.8 + hash(hx, hy, 290) * 0.4) * mult; // outer radius incl. rim — smaller than the old 1.2-1.8 blob

    // raised-earth rim: lighter earth tone ring just outside the core
    const rimR = r * 0.95;
    const rim = g.createRadialGradient(x, y, r * 0.35, x, y, rimR);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(0.55, 'rgba(96,78,52,0.4)');
    rim.addColorStop(0.85, 'rgba(120,98,64,0.3)');
    rim.addColorStop(1, 'rgba(120,98,64,0)');
    g.fillStyle = rim;
    g.beginPath();
    g.arc(x, y, rimR, 0, Math.PI * 2);
    g.fill();

    // dark core, tight falloff
    const coreR = r * 0.55;
    const core = g.createRadialGradient(x, y, 0, x, y, coreR);
    core.addColorStop(0, 'rgba(20,16,12,0.85)');
    core.addColorStop(0.7, 'rgba(24,19,14,0.6)');
    core.addColorStop(1, 'rgba(24,19,14,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(x, y, coreR, 0, Math.PI * 2);
    g.fill();

    // short ejecta streaks
    g.strokeStyle = 'rgba(90,72,48,0.4)';
    g.lineWidth = 0.1;
    const n = 4 + Math.floor(hash(hx, hy, 291) * 3); // 4-6
    for (let i = 0; i < n; i++) {
      const a = hash(hx, hy, 292 + i) * Math.PI * 2;
      const l = r * (0.9 + hash(hx, hy, 299 + i) * 0.5);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * coreR, y + Math.sin(a) * coreR);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }

    // ash center
    g.fillStyle = 'rgba(60,52,42,0.45)';
    g.beginPath();
    g.arc(x, y, 0.22 * Math.min(1.6, Math.max(0.6, mult)), 0, Math.PI * 2);
    g.fill();
  }

  // A shell hole from some earlier fight, stamped at construction: grass has
  // regrown over the rim and there is no ash left, so it never reads as a
  // fresh `scorch()`. Deterministic (hash, not Math.random) because this is
  // load-time art the static screenshot sweep compares across builds.
  oldCrater(x: number, y: number, seed: number): void {
    const g = this.g;
    const r = 1.4 + hash(seed, 0, 280) * 1.1;
    const rim = g.createRadialGradient(x, y, r * 0.4, x, y, r);
    rim.addColorStop(0, 'rgba(96,110,66,0)');
    rim.addColorStop(0.6, 'rgba(96,110,66,0.25)');
    rim.addColorStop(1, 'rgba(96,110,66,0)');
    g.fillStyle = rim;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    const core = g.createRadialGradient(x, y, 0, x, y, r * 0.55);
    core.addColorStop(0, 'rgba(40,34,26,0.35)');
    core.addColorStop(1, 'rgba(40,34,26,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(x, y, r * 0.55, 0, Math.PI * 2);
    g.fill();
    // weathered lip, brightest on the NW side under the shared sun
    g.strokeStyle = 'rgba(132,138,96,0.22)';
    g.lineWidth = 0.14;
    g.beginPath();
    g.arc(x, y, r * 0.62, Math.PI * 1.02, Math.PI * 1.98);
    g.stroke();
  }

  // Where a thrown debris chunk came down: one dark speck plus two flecks.
  grit(x: number, y: number): void {
    const g = this.g;
    const hx = Math.round(x * 100);
    const hy = Math.round(y * 100);
    g.fillStyle = 'rgba(38,32,24,0.5)';
    g.beginPath();
    g.arc(x, y, 0.12 + hash(hx, hy, 285) * 0.18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(52,44,33,0.35)';
    for (let i = 0; i < 2; i++) {
      const a = hash(hx, hy, 286 + i) * Math.PI * 2;
      const d = 0.2 + hash(hx, hy, 288 + i) * 0.3;
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.07, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Where armour has been (U7): two parallel ruts at the track centres,
  // stamped every 0.7 m of a vehicle's odometer. The alpha is deliberately low
  // — overlapping passes have to darken into a lane, not smear the field to
  // mud — and the ends jitter so a long straight run doesn't read as a stencil.
  trackMark(x: number, y: number, facing: number, gauge: number): void {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.rotate(facing);
    g.strokeStyle = 'rgba(58,48,34,0.3)';
    g.lineWidth = 0.5;
    g.beginPath();
    for (const s of [-1, 1]) {
      g.moveTo(-0.175, s * gauge);
      g.lineTo(0.175 + (Math.random() - 0.5) * 0.12, s * gauge);
    }
    g.stroke();
    g.restore();
  }

  // One layer of a blood pool. The renderer stamps a pool as several of these
  // at growing radii over a few seconds, so it spreads, and the layers add up
  // to a dark centre with a thin edge. Three offset lobes, not a disc: a pool
  // follows the ground. The red is deeper and less brown than it was — at the
  // old value a pool on ploughed earth was the earth.
  pool(x: number, y: number, r: number, seed: number): void {
    const g = this.g;
    for (let i = 0; i < 3; i++) {
      const a = hash(seed, i, 281) * Math.PI * 2;
      const d = i === 0 ? 0 : r * (0.25 + hash(seed, i, 282) * 0.3);
      const lr = r * (i === 0 ? 0.85 : 0.5 + hash(seed, i, 283) * 0.25);
      const cx = x + Math.cos(a) * d;
      const cy = y + Math.sin(a) * d;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, lr);
      grad.addColorStop(0, 'rgba(96,12,10,0.4)');
      grad.addColorStop(0.75, 'rgba(104,16,12,0.34)');
      grad.addColorStop(1, 'rgba(104,16,12,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, lr, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Spatter thrown past a man by the round that hit him: a few drops down the
  // shot's line, thinning with distance. `n` is how many.
  spatter(x: number, y: number, ux: number, uy: number, n: number, seed: number): void {
    const g = this.g;
    g.fillStyle = 'rgba(100,14,12,0.55)';
    for (let i = 0; i < n; i++) {
      const along = 0.25 + hash(seed, i, 284) ** 1.5 * 1.3;
      const lat = (hash(seed, i, 285) - 0.5) * 0.5 * along;
      g.beginPath();
      g.arc(x + ux * along - uy * lat, y + uy * along + ux * lat, 0.05 + hash(seed, i, 286) * 0.08 * (1.4 - along), 0, Math.PI * 2);
      g.fill();
    }
  }

  smear(x: number, y: number, angle: number): void {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.strokeStyle = 'rgba(95,16,10,0.3)';
    g.lineWidth = 0.2 + Math.random() * 0.08;
    g.beginPath();
    g.moveTo(-0.35, (Math.random() - 0.5) * 0.15);
    g.lineTo(0.35, (Math.random() - 0.5) * 0.15);
    g.stroke();
    g.restore();
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    const [ox, oy] = cam.worldToScreen(0, 0, cw, ch);
    const s = cam.scale / PPM;
    ctx.drawImage(this.c, ox, oy, this.c.width * s, this.c.height * s);
  }
}
