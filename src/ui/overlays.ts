import type { Camera } from '../render/camera';
import { dangerSamples, type OrderKind } from '../sim/orders';
import { OFFSETS, type Sim, type UnitEvent } from '../sim/sim';
import type { Pick, ShotSolution } from './tooltip';

export interface OverlayState {
  pick: Pick;
  shot: ShotSolution | null;
  selectedSquad: number;
  targetMode: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke';
  focusTeams: number[]; // the selected squad's teams, or one narrowed team
  armedOrder: OrderKind | null;
  cursor: { x: number; y: number } | null; // world position, for the danger preview
}

function teamCentroid(sim: Sim, soldierIds: number[]): { x: number; y: number } | null {
  const alive = soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
  if (alive.length === 0) return null;
  return { x: alive.reduce((a, s) => a + s.x, 0) / alive.length, y: alive.reduce((a, s) => a + s.y, 0) / alive.length };
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
        ctx.beginPath();
        pts.forEach((p, i) => {
          const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.setLineDash([5, 5]);
        // dark halo pass first so the dashed line reads on light terrain (roads, sand), then the amber line on top
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(12,14,10,0.5)';
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,202,106,0.7)';
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
      const r = Math.max(2.5, cam.scale * 0.18);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = covered ? 'rgba(127,191,106,0.9)' : 'rgba(232,228,216,0.55)';
      ctx.fill();
      if (r > 3) {
        // outline for edge definition only once the dot is big enough that it doesn't eat the fill
        ctx.strokeStyle = 'rgba(18,22,15,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // Order-kind danger preview: while an order is armed, the same 8 points
  // dangerScore will sum over, colored green (safe) to red (0.2/point cap) —
  // the legibility contract: see the risk before you commit to the order.
  // Offsets match orderSquad's own team-fanout formula exactly (Sim.orderSquad,
  // sim.ts) so the preview lines up with where the order will actually land.
  if (st.armedOrder && st.cursor && !st.targetMode) {
    const n = st.focusTeams.length;
    st.focusTeams.forEach((tid, ti) => {
      const team = sim.teams[tid];
      if (!team) return;
      const oy = (ti - (n - 1) / 2) * 8;
      const dest = { x: st.cursor!.x, y: st.cursor!.y + oy };
      for (const p of dangerSamples(sim, team, dest)) {
        const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
        const t = Math.min(1, p.score / 0.2);
        const r = Math.round(127 + 128 * t);
        const g = Math.round(191 - 131 * t);
        ctx.fillStyle = `rgb(${r},${g},60)`;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(2, cam.scale * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // Selected team(s) show their OrderState above their soldiers: kind +
  // refusal reason. A balked team's chip pulses so a refusal is never missed.
  for (const tid of st.focusTeams) {
    const team = sim.teams[tid];
    if (!team) continue;
    const os = team.orderState;
    if (!os.order && os.phase === 'idle') continue;
    const centroid = teamCentroid(sim, team.soldierIds);
    if (!centroid) continue;
    const [sx, sy] = cam.worldToScreen(centroid.x, centroid.y, cw, ch);
    const label = os.order ? os.order.kind.toUpperCase() : '';
    const text = os.reason ? `${label} — ${os.reason}` : label;
    const balked = os.phase === 'balked';
    if (balked) ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(sim.tick / 12));
    chip(ctx, sx, sy - cam.scale * 1.1 - 10, text, balked ? '#ff8a5c' : '#ffe9a0');
    if (balked) ctx.globalAlpha = 1;
  }

  if (st.shot) {
    const [x0, y0] = cam.worldToScreen(st.shot.fx, st.shot.fy, cw, ch);
    const [x1, y1] = cam.worldToScreen(st.shot.tx, st.shot.ty, cw, ch);
    if (!st.shot.ok) ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    // dark halo pass first so the line reads over light terrain, matching the route preview
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(12,14,10,0.45)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = st.shot.ok ? 'rgba(255,202,106,0.85)' : 'rgba(150,150,140,0.7)';
    ctx.stroke();
    ctx.setLineDash([]);
    // blocked shots tell the player why, not just that — from the structured reason, never prose
    const blockedLabel = st.shot.reason === 'out-of-range' ? 'OUT OF RANGE' : st.shot.reason === 'no-los' ? 'NO LOS' : 'NO SHOT';
    chip(ctx, (x0 + x1) / 2, (y0 + y1) / 2, st.shot.ok ? `${Math.round(st.shot.acc * 100)}%` : blockedLabel, st.shot.ok ? '#ffe9a0' : '#a0a090');
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
    const edgeCounts = new Map<string, number>(); // stack off-screen arrow chips along the edge instead of overlapping
    for (const p of this.pings) {
      const life = (sim.tick - p.tick) / PING_TICKS; // 0..1
      const a = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4; // hold at full readability, ease out only over the tail
      const [x, y] = cam.worldToScreen(p.x, p.y, cw, ch);
      const m = 30;
      const top = 60; // keep clear of the top bar
      ctx.globalAlpha = a;
      if (x < m || x > cw - m || y < top || y > ch - m) {
        // corners fold into the L/R edge so adjacent buckets share one stacking counter
        const edgeKey = x < m ? 'L' : x > cw - m ? 'R' : y < top ? 'T' : 'B';
        const stack = edgeCounts.get(edgeKey) ?? 0;
        edgeCounts.set(edgeKey, stack + 1);
        let cx = Math.min(Math.max(x, m), cw - m);
        let cy = Math.min(Math.max(y, top), ch - m);
        if (edgeKey === 'L' || edgeKey === 'R') cy = Math.min(Math.max(cy + stack * 20, top), ch - m);
        else cx = Math.min(Math.max(cx + stack * 20, m), cw - m);
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
