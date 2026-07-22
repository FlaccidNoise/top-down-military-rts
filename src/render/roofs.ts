import type { Building } from '../sim/mapgen';
import type { Sim } from '../sim/sim';
import type { Camera } from './camera';

// Gable roofs drawn over building footprints (sim.buildings, from the map
// plan). A roof fades out when the camera is zoomed in close or a friendly
// soldier is inside, revealing the interior (interiors are ordinary walkable
// sim space).

const OVERHANG = 0.35; // meters past the walls
const FADE_SCALE = 14; // px/m at which zoom alone reveals interiors
const PALETTES = ['#8a4b37', '#77503c', '#5a5e65'];

export class RoofLayer {
  private buildings: Building[] = [];
  private alphas: number[] = [];

  update(sim: Sim, cam: Camera, dt: number): void {
    if (this.buildings !== sim.buildings) {
      this.buildings = sim.buildings;
      this.alphas = this.buildings.map(() => 1);
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
      this.buildings.forEach((b, i) => {
        ctx.fillStyle = `rgba(12,15,10,${0.3 * this.alphas[i]})`;
        ctx.fillRect(b.x - OVERHANG + 0.45, b.y - OVERHANG + 0.55, b.w + OVERHANG * 2, b.h + OVERHANG * 2);
      });
    });
  }

  drawTops(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    this.withWorldTransform(ctx, cam, cw, ch, () => {
      this.buildings.forEach((b, i) => {
        const a = this.alphas[i];
        if (a < 0.01) return;
        ctx.globalAlpha = a;
        const x = b.x - OVERHANG;
        const y = b.y - OVERHANG;
        const w = b.w + OVERHANG * 2;
        const h = b.h + OVERHANG * 2;
        const base = PALETTES[i % PALETTES.length];
        const ridgeAlongX = w >= h;
        // two slopes, lit side lighter
        ctx.fillStyle = base;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        if (ridgeAlongX) ctx.fillRect(x, y, w, h / 2);
        else ctx.fillRect(x, y, w / 2, h);
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
        // eave outline
        ctx.strokeStyle = 'rgba(20,16,12,0.6)';
        ctx.lineWidth = 0.08;
        ctx.strokeRect(x, y, w, h);
        ctx.globalAlpha = 1;
      });
    });
  }
}
