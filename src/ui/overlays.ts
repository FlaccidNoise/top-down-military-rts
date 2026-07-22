import type { Camera } from '../render/camera';
import { OFFSETS, type Sim, type UnitEvent } from '../sim/sim';
import type { Pick, ShotSolution } from './tooltip';

export interface OverlayState {
  pick: Pick;
  shot: ShotSolution | null;
  selectedSquad: number;
  targetMode: string;
}

// World-anchored order feedback, drawn on the canvas after the scene.
export function drawOverlays(ctx: CanvasRenderingContext2D, cam: Camera, sim: Sim, st: OverlayState, pings: EventPings): void {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  // Route preview for the selected squad: current leg, then queued waypoints.
  if (st.selectedSquad >= 0) {
    const sq = sim.squads[st.selectedSquad];
    const dest = sim.squadDest[st.selectedSquad];
    const queue = sim.squadWaypoints[st.selectedSquad] ?? [];
    if (sq && dest) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const sid of sq.soldierIds) {
        const s = sim.soldiers[sid];
        if (!s.alive || s.downed) continue;
        cx += s.x;
        cy += s.y;
        n++;
      }
      if (n > 0) {
        const pts = [{ x: cx / n, y: cy / n }, dest, ...queue];
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,202,106,0.55)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        pts.forEach((p, i) => {
          const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        pts.slice(1).forEach((p, i) => {
          const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
          ctx.fillStyle = i === 0 ? 'rgba(255,202,106,0.9)' : 'rgba(255,202,106,0.6)';
          ctx.beginPath();
          ctx.arc(sx, sy, i === 0 ? 4 : 6, 0, Math.PI * 2);
          ctx.fill();
          if (i > 0) {
            ctx.fillStyle = '#12160f';
            ctx.font = '8px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), sx, sy);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
          }
        });
      }
    }
  }

  // Move-order preview: the actual formation spots, green where they have cover.
  if (!st.targetMode && st.selectedSquad >= 0 && st.pick?.kind === 'terrain') {
    for (const [ox, oy] of OFFSETS) {
      const tx = Math.floor(st.pick.x + ox);
      const ty = Math.floor(st.pick.y + oy);
      if (!sim.map.inBounds(tx, ty)) continue;
      const covered = sim.inCover(tx + 0.5, ty + 0.5);
      const [sx, sy] = cam.worldToScreen(tx + 0.5, ty + 0.5, cw, ch);
      ctx.fillStyle = covered ? 'rgba(127,191,106,0.9)' : 'rgba(232,228,216,0.5)';
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, cam.scale * 0.18), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (st.shot) {
    const [x0, y0] = cam.worldToScreen(st.shot.fx, st.shot.fy, cw, ch);
    const [x1, y1] = cam.worldToScreen(st.shot.tx, st.shot.ty, cw, ch);
    ctx.lineWidth = 1.5;
    if (st.shot.ok) {
      ctx.strokeStyle = 'rgba(255,202,106,0.8)';
    } else {
      ctx.strokeStyle = 'rgba(150,150,140,0.6)';
      ctx.setLineDash([4, 6]);
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    chip(ctx, (x0 + x1) / 2, (y0 + y1) / 2, st.shot.ok ? `${Math.round(st.shot.acc * 100)}%` : '✕', st.shot.ok ? '#ffe9a0' : '#a0a090');
  }

  pings.draw(ctx, cam, sim, cw, ch);
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(18,22,15,0.85)';
  ctx.fillRect(x - w / 2, y - 8, w, 16);
  ctx.strokeStyle = 'rgba(74,82,64,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2, y - 8, w, 16);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

interface Ping {
  x: number;
  y: number;
  label: string;
  color: string;
  tick: number;
}

const PING_TICKS = 8 * 30;

// Pings sim-emitted unit events the player must not miss — with edge arrows
// when they happen off-screen. Sim-tick expiry: pause-safe.
export class EventPings {
  private pings: Ping[] = [];

  add(events: UnitEvent[], tick: number): void {
    for (const e of events) {
      if (e.kind === 'vehicle-destroyed') {
        this.push(e.x, e.y, `${e.name} DESTROYED`, e.side === 'blue' ? '#d05c50' : '#ffca6a', tick);
      } else if (e.side === 'blue') {
        const label = e.kind === 'kia' ? 'KIA' : e.kind === 'downed' ? 'DOWN' : 'BROKE';
        this.push(e.x, e.y, `${e.name} ${label}`, e.kind === 'downed' ? '#e08a3c' : '#d05c50', tick);
      }
    }
  }

  reset(): void {
    this.pings = [];
  }

  private push(x: number, y: number, label: string, color: string, tick: number): void {
    this.pings.push({ x, y, label, color, tick });
    if (this.pings.length > 12) this.pings.shift();
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, sim: Sim, cw: number, ch: number): void {
    this.pings = this.pings.filter((p) => sim.tick - p.tick < PING_TICKS);
    const placed: { x: number; y: number; w: number }[] = []; // stack co-located chips instead of occluding
    for (const p of this.pings) {
      const a = 1 - (sim.tick - p.tick) / PING_TICKS;
      const [x, y] = cam.worldToScreen(p.x, p.y, cw, ch);
      const m = 30;
      const top = 60; // keep clear of the top bar
      ctx.globalAlpha = a;
      if (x < m || x > cw - m || y < top || y > ch - m) {
        const cx = Math.min(Math.max(x, m), cw - m);
        const cy = Math.min(Math.max(y, top), ch - m);
        const ang = Math.atan2(y - cy, x - cx);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(11, 0);
        ctx.lineTo(0, -5);
        ctx.lineTo(0, 5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.font = '11px ui-monospace, Menlo, monospace';
        const half = ctx.measureText(p.label).width / 2 + 16;
        chip(ctx, cx - Math.cos(ang) * half, cy - Math.sin(ang) * half, p.label, p.color);
      } else {
        ctx.font = '11px ui-monospace, Menlo, monospace';
        const w = ctx.measureText(p.label).width + 10;
        let cy = y - cam.scale * 0.9 - 10;
        while (placed.some((q) => Math.abs(q.y - cy) < 18 && Math.abs(q.x - x) < (q.w + w) / 2)) cy -= 18;
        placed.push({ x, y: cy, w });
        chip(ctx, x, cy, p.label, p.color);
      }
      ctx.globalAlpha = 1;
    }
  }
}
