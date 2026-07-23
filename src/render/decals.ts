import type { Camera } from './camera';

// Persistent battle scarring — mortar scorches, blood smears from dragged
// casualties. Drawn once into a world-aligned offscreen canvas and blitted
// each frame between terrain and soldiers. Render-only; Math.random is fine.

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
  scorch(x: number, y: number): void {
    const g = this.g;
    const r = 0.8 + Math.random() * 0.4; // outer radius incl. rim — smaller than the old 1.2-1.8 blob

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
    const n = 4 + Math.floor(Math.random() * 3); // 4-6
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const l = r * (0.9 + Math.random() * 0.5);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * coreR, y + Math.sin(a) * coreR);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }

    // ash center
    g.fillStyle = 'rgba(60,52,42,0.45)';
    g.beginPath();
    g.arc(x, y, 0.22, 0, Math.PI * 2);
    g.fill();
  }

  // Permanent blood pool stamped once at death — earth-dark red, soft edge.
  pool(x: number, y: number, r: number): void {
    const g = this.g;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(58,10,8,0.55)');
    grad.addColorStop(0.7, 'rgba(70,14,10,0.4)');
    grad.addColorStop(1, 'rgba(70,14,10,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
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
