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

  scorch(x: number, y: number): void {
    const g = this.g;
    const r = 1.2 + Math.random() * 0.6;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(22,18,14,0.8)');
    grad.addColorStop(0.55, 'rgba(30,24,18,0.45)');
    grad.addColorStop(1, 'rgba(30,24,18,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    // blast streaks
    g.strokeStyle = 'rgba(25,20,15,0.35)';
    g.lineWidth = 0.12;
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const l = r * (0.8 + Math.random() * 0.7);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    // ash center
    g.fillStyle = 'rgba(72,62,50,0.5)';
    g.beginPath();
    g.arc(x, y, 0.35, 0, Math.PI * 2);
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
