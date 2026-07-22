import { TERRAIN } from '../sim/data';
import { EDGE } from '../sim/map';
import type { ShotEvent, Sim } from '../sim/sim';
import type { Camera } from './camera';

const PPM = 8; // px per meter in the prerendered map image

interface Tracer extends ShotEvent {
  at: number; // ms timestamp
}

export class Renderer {
  private mapImage: HTMLCanvasElement;
  private tracers: Tracer[] = [];

  constructor(private sim: Sim) {
    this.mapImage = this.prerenderMap();
  }

  private prerenderMap(): HTMLCanvasElement {
    const { map } = this.sim;
    const c = document.createElement('canvas');
    c.width = map.w * PPM;
    c.height = map.h * PPM;
    const g = c.getContext('2d')!;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        g.fillStyle = TERRAIN[map.terrainKeyAt(x, y)].color;
        g.fillRect(x * PPM, y * PPM, PPM, PPM);
      }
    }
    const drawEdge = (x0: number, y0: number, x1: number, y1: number, e: number) => {
      if (e === EDGE.NONE) return;
      g.strokeStyle = e === EDGE.WALL ? '#26221c' : e === EDGE.DOOR ? '#b5885a' : '#9ecfe0';
      g.lineWidth = e === EDGE.WALL ? PPM * 0.28 : PPM * 0.18;
      g.beginPath();
      g.moveTo(x0 * PPM, y0 * PPM);
      g.lineTo(x1 * PPM, y1 * PPM);
      g.stroke();
    };
    for (let y = 0; y <= map.h; y++) {
      for (let x = 0; x < map.w; x++) drawEdge(x, y, x + 1, y, map.hEdge(x, y));
    }
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x <= map.w; x++) drawEdge(x, y, x, y + 1, map.vEdge(x, y));
    }
    return c;
  }

  addEvents(events: ShotEvent[], now: number): void {
    for (const e of events) this.tracers.push({ ...e, at: now });
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, selectedSquad: number, paused: boolean, now: number): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    ctx.fillStyle = '#1a1d1a';
    ctx.fillRect(0, 0, cw, ch);

    const [ox, oy] = cam.worldToScreen(0, 0, cw, ch);
    const s = cam.scale / PPM;
    ctx.imageSmoothingEnabled = cam.scale < PPM;
    ctx.drawImage(this.mapImage, ox, oy, this.mapImage.width * s, this.mapImage.height * s);

    // tracers (last 150 ms)
    this.tracers = this.tracers.filter((t) => now - t.at < 150);
    for (const t of this.tracers) {
      const a = 1 - (now - t.at) / 150;
      const [x0, y0] = cam.worldToScreen(t.fx, t.fy, cw, ch);
      const [x1, y1] = cam.worldToScreen(t.tx, t.ty, cw, ch);
      ctx.strokeStyle = t.hit ? `rgba(255, 205, 90, ${a})` : `rgba(255, 255, 255, ${0.35 * a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (t.kill) {
        ctx.fillStyle = `rgba(220, 60, 40, ${a * 0.6})`;
        ctx.beginPath();
        ctx.arc(x1, y1, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // soldiers
    const r = Math.max(2.5, 0.35 * cam.scale);
    for (const sol of this.sim.soldiers) {
      const [x, y] = cam.worldToScreen(sol.x, sol.y, cw, ch);
      if (x < -20 || y < -20 || x > cw + 20 || y > ch + 20) continue;
      if (!sol.alive) {
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - r * 0.7, y - r * 0.7);
        ctx.lineTo(x + r * 0.7, y + r * 0.7);
        ctx.moveTo(x + r * 0.7, y - r * 0.7);
        ctx.lineTo(x - r * 0.7, y + r * 0.7);
        ctx.stroke();
        continue;
      }
      if (sol.squadId === selectedSquad) {
        ctx.strokeStyle = '#ffe9a0';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
        if (sol.path) {
          ctx.strokeStyle = 'rgba(255, 233, 160, 0.25)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          for (let i = sol.pathI; i < sol.path.length; i++) {
            const [px, py] = cam.worldToScreen(sol.path[i].x, sol.path[i].y, cw, ch);
            ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
      ctx.fillStyle = sol.side === 'blue' ? '#5b9bd5' : '#d05c50';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawHud(ctx, selectedSquad, paused);
  }

  private drawHud(ctx: CanvasRenderingContext2D, selectedSquad: number, paused: boolean): void {
    const lines: string[] = [];
    let blue = 0;
    let red = 0;
    for (const s of this.sim.soldiers) {
      if (!s.alive) continue;
      if (s.side === 'blue') blue++;
      else red++;
    }
    lines.push(`T+${Math.floor((this.sim.tick / 30 / 60) | 0)}:${String(Math.floor(this.sim.tick / 30) % 60).padStart(2, '0')}  US ${blue} | GE ${red}`);
    if (paused) lines.push('PAUSED — space to resume');
    lines.push('click: select squad   right-click: move   wheel: zoom   drag: pan');
    const squad = this.sim.squads[selectedSquad];
    if (squad) {
      lines.push(`— ${squad.name} —`);
      for (const sid of squad.soldierIds) {
        const s = this.sim.soldiers[sid];
        lines.push(`${s.alive ? Math.ceil(s.hp).toString().padStart(3) : 'KIA'} ${s.name} (${s.weapon})`);
      }
    }
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(8, 8, 300, 18 * lines.length + 8);
    ctx.fillStyle = '#e8e4d8';
    lines.forEach((l, i) => ctx.fillText(l, 16, 26 + i * 18));

    if (this.sim.winner) {
      ctx.font = 'bold 36px monospace';
      ctx.fillStyle = this.sim.winner === 'blue' ? '#5b9bd5' : '#d05c50';
      ctx.textAlign = 'center';
      ctx.fillText(this.sim.winner === 'blue' ? 'US VICTORY' : 'GERMAN VICTORY', ctx.canvas.width / 2, 80);
      ctx.textAlign = 'left';
    }
  }
}
