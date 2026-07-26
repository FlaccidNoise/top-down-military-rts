import type { Camera } from '../render/camera';
import { view } from '../render/view';
import { compliance, dangerSamples, dangerScore, type OrderKind } from '../sim/orders';
import { fanOffsets, formationSlots, OFFSETS, TEAM_FAN, SQUAD_FAN, type Side, type Sim, type UnitEvent } from '../sim/sim';
import { TEAM } from './hud';
import type { Pick, ShotSolution } from './tooltip';

export interface OverlayState {
  pick: Pick;
  shot: ShotSolution | null;
  selectedSquad: number;
  targetMode: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke';
  focusTeams: number[]; // the selected squad's teams, or one narrowed team
  armedOrder: OrderKind | null;
  cursor: { x: number; y: number } | null; // world position, for the danger preview
  selectedSquads: number[]
  selectRect: { x: number; y: number; w: number; h: number } | null
  formationDrag: { ax: number; ay: number; facing: number; width: number } | null
}

function teamCentroid(sim: Sim, soldierIds: number[]): { x: number; y: number } | null {
  const alive = soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
  if (alive.length === 0) return null;
  return { x: alive.reduce((a, s) => a + s.x, 0) / alive.length, y: alive.reduce((a, s) => a + s.y, 0) / alive.length };
}

// World-anchored order feedback, drawn on the canvas after the scene.
export function drawOverlays(ctx: CanvasRenderingContext2D, cam: Camera, sim: Sim, st: OverlayState, pings: EventPings): void {
  const cw = view.w;
  const ch = view.h;

  // Selection rectangle (screen-space, normalized so w/h always positive).
  if (st.selectRect) {
    const rr = st.selectRect;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,202,106,0.7)';
    ctx.strokeRect(rr.x, rr.y, rr.w, rr.h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,202,106,0.08)';
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
  }

  // Route preview for selected squads: current leg, then queued waypoints.
  if (st.selectedSquads.length > 0) {
    for (const squadId of st.selectedSquads) {
    const sq = sim.squads[squadId];
    const dest = sim.squadDest[squadId];
    const queue = sim.squadWaypoints[squadId] ?? [];
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
  }

  // Move-order preview: formation spots computed exactly as orderSquad does.
  if (!st.targetMode && st.selectedSquads.length > 0 && st.pick?.kind === 'terrain') {
    const pick = st.pick
    const nSquads = st.selectedSquads.length;
    const seg = st.formationDrag ? st.formationDrag.width / nSquads : SQUAD_FAN;
    const squadOffs = fanOffsets(nSquads, seg);
    st.selectedSquads.forEach((squadId, si) => {
      const squad = sim.squads[squadId];
      if (!squad) return;
      let ax = pick.x;
      let ay = pick.y;
      if (st.formationDrag) {
        ax = st.formationDrag.ax + Math.cos(st.formationDrag.facing) * squadOffs[si];
        ay = st.formationDrag.ay + Math.sin(st.formationDrag.facing) * squadOffs[si];
      } else {
        ay += squadOffs[si];
      }
      const nTeams = squad.teamIds.length;
      const teamSpacing = st.formationDrag ? (st.formationDrag.width / nSquads) / nTeams : TEAM_FAN;
      const teamOffs = fanOffsets(nTeams, teamSpacing);
      squad.teamIds.forEach((tid, ti) => {
        const team = sim.teams[tid];
        if (!team) return;
        const eligible = team.soldierIds.filter((id) => {
          const s = sim.soldiers[id];
          return s && s.alive && !s.downed && s.mental !== 'broken';
        });
        if (eligible.length === 0) return;
        let tx = ax;
        let ty = ay;
        if (st.formationDrag) {
          tx += Math.cos(st.formationDrag.facing) * teamOffs[ti];
          ty += Math.sin(st.formationDrag.facing) * teamOffs[ti];
        } else {
          ty += teamOffs[ti];
        }
        const slots = formationSlots(eligible.length, st.formationDrag?.facing, st.formationDrag ? teamSpacing : undefined);
        for (const [ox, oy] of slots) {
          const px = tx + ox;
          const py = ty + oy;
          if (!sim.map.inBounds(Math.floor(px), Math.floor(py))) continue;
          const covered = sim.inCover(px, py);
          const [sx, sy] = cam.worldToScreen(px, py, cw, ch);
          const r = Math.max(2.5, cam.scale * 0.18);
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fillStyle = covered ? 'rgba(127,191,106,0.9)' : 'rgba(232,228,216,0.55)';
          ctx.fill();
          if (r > 3) {
            ctx.strokeStyle = 'rgba(18,22,15,0.6)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      });
    });
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
      const oy = fanOffsets(n, TEAM_FAN)[ti];
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

  // Armed-order context chip: the per-point dots' one-glance summary —
  // worst-case danger across focus teams, cover at the cursor, ETA from the
  // slowest eligible soldier's own moveSpeed, and the compliance verdict the
  // team will actually run. Static (no tick-driven animation): pause- and
  // reduced-motion-safe by construction. Only while an order is armed.
  if (st.armedOrder && st.cursor && !st.targetMode && st.focusTeams.length > 0) {
    const n = st.focusTeams.length;
    let danger = 0;
    let verdict: ChipVerdict = 'comply';
    let eta: number | null = null;
    st.focusTeams.forEach((tid, ti) => {
      const team = sim.teams[tid];
      if (!team) return;
      const dest = { x: st.cursor!.x, y: st.cursor!.y + fanOffsets(n, TEAM_FAN)[ti] };
      const d = dangerScore(sim, team, dest);
      danger = Math.max(danger, d);
      const v = compliance(sim, team, d);
      if (v === 'balk' || (v === 'cautious' && verdict !== 'balk')) verdict = v;
      const centroid = teamCentroid(sim, team.soldierIds);
      if (!centroid) return;
      const eligible = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed && s.mental !== 'broken');
      const speed = eligible.length > 0 ? Math.min(...eligible.map((s) => sim.moveSpeed(s))) : 0;
      if (speed > 0.01) {
        const t = Math.hypot(st.cursor!.x - centroid.x, st.cursor!.y - centroid.y) / speed;
        eta = eta === null ? t : Math.max(eta, t);
      }
    });
    const fmt = formatContextChip(danger, sim.inCover(st.cursor.x, st.cursor.y), eta, verdict);
    const [sx, sy] = cam.worldToScreen(st.cursor.x, st.cursor.y, cw, ch);
    contextChip(ctx, sx, sy, cw, ch, fmt.lines, fmt.color);
  }

  // Formation drag preview: anchor-to-cursor line + squad segment centers.
  if (st.formationDrag && st.cursor) {
    const [ax, ay] = cam.worldToScreen(st.formationDrag.ax, st.formationDrag.ay, cw, ch);
    const [cx, cy] = cam.worldToScreen(st.cursor.x, st.cursor.y, cw, ch);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(cx, cy);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,202,106,0.9)';
    ctx.stroke();
    ctx.lineWidth = 1;
    // Squad segment centers.
    const nSquads = st.selectedSquads.length;
    if (nSquads > 0) {
      const squadOffs = fanOffsets(nSquads, SQUAD_FAN);
      const cos = Math.cos(st.formationDrag.facing);
      const sin = Math.sin(st.formationDrag.facing);
      st.selectedSquads.forEach((_sid, si) => {
        const scx = st.formationDrag!.ax + cos * squadOffs[si];
        const scy = st.formationDrag!.ay + sin * squadOffs[si];
        const [sx, sy] = cam.worldToScreen(scx, scy, cw, ch);
        ctx.fillStyle = 'rgba(255,202,106,0.5)';
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
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
    const blockedLabel =
      st.shot.reason === 'out-of-range' ? 'OUT OF RANGE' : st.shot.reason === 'no-los' ? 'NO LOS' : st.shot.reason === 'concealed' ? 'CONCEALED' : st.shot.reason === 'floor-blocked' ? 'FLOOR' : 'NO SHOT';
    chip(ctx, (x0 + x1) / 2, (y0 + y1) / 2, st.shot.ok ? `${Math.round(st.shot.acc * 100)}%` : blockedLabel, st.shot.ok ? '#ffe9a0' : '#a0a090');
  }

  pings.draw(ctx, sim, cam, cw, ch);
}

export type ChipVerdict = 'comply' | 'cautious' | 'balk';

const VERDICT_LABEL: Record<ChipVerdict, string> = { comply: 'COMPLY', cautious: 'CAUTIOUS', balk: 'BALK' };
const VERDICT_COLOR: Record<ChipVerdict, string> = { comply: '#7fbf6a', cautious: '#e0c060', balk: '#d05c50' };

// Pure formatting for the armed-order context chip, exported for tests —
// canvas drawing (contextChip) consumes this and stays untested.
export function formatContextChip(
  danger: number,
  cover: boolean,
  eta: number | null,
  verdict: ChipVerdict,
): { lines: string[]; color: string } {
  const risk = danger < 0.2 ? 'LOW' : danger < 0.5 ? 'MED' : 'HIGH';
  let env = cover ? 'COVER' : 'OPEN';
  if (eta !== null) env += ` · ~${Math.max(1, Math.round(eta))}s`;
  return { lines: [`RISK ${risk} ${danger.toFixed(2)}`, env, VERDICT_LABEL[verdict]], color: VERDICT_COLOR[verdict] };
}

function contextChip(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  cw: number,
  ch: number,
  lines: string[],
  color: string,
): void {
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const lh = 14;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const h = lines.length * lh + 8;
  let x = sx + 16; // up-right of the cursor so the chip never occludes it or the dots
  let y = sy - 16 - h;
  if (x + w > cw - 4) x = sx - 16 - w; // flip left at the right edge
  if (y < 4) y = sy + 16; // flip below at the top edge
  const r = 3;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(18,22,15,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,82,64,0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.fillStyle = i === lines.length - 1 ? color : '#b8b4a4'; // verdict line carries the state color, the rest stay muted
    ctx.fillText(line, x + 6, y + 4 + lh * i + lh / 2);
  });
  ctx.textBaseline = 'alphabetic';
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
  side: Side;
  label: string;
  color: string;
  tick: number;
}

interface WorldKia {
  x: number;
  y: number;
  label: string;
  tick: number;
}

const PING_TICKS = 8 * 30;
const MAX_VISIBLE = 5;
const MAX_KIAS = 12;
const KIA_CELL = 8; // world meters — casualties inside a cell share one stack
const KIA_LINE_H = 11;
const ROW_W = 190;
const ROW_H = 20;
const ROW_GAP = 3;

// Pings sim-emitted unit events the player must not miss, as a fixed
// right-edge feed column (screen-space only — never anchored to world
// position, so entries can never overlap). Sim-tick expiry: pause-safe.
export class EventPings {
  private pings: Ping[] = [];
  private kias: WorldKia[] = [];

  add(events: UnitEvent[], tick: number): void {
    for (const e of events) {
      if (e.kind === 'vehicle-destroyed') {
        this.push(e.side, `${e.name} — DESTROYED`, e.side === 'blue' ? '#d05c50' : '#ffca6a', tick);
      } else if (e.side === 'blue') {
        const label = e.kind === 'kia' ? 'KIA' : e.kind === 'downed' ? 'DOWN' : e.kind === 'broken' ? 'BROKE' : null;
        if (label) this.push(e.side, `${e.name} — ${label}`, e.kind === 'downed' ? '#e08a3c' : '#d05c50', tick);
        if (e.kind === 'kia') {
          this.kias.push({ x: e.x, y: e.y, label: e.name, tick });
          if (this.kias.length > MAX_KIAS) this.kias.shift();
        }
      }
    }
  }

  reset(): void {
    this.pings = [];
    this.kias = [];
  }

  private push(side: Side, label: string, color: string, tick: number): void {
    this.pings.push({ side, label, color, tick });
    if (this.pings.length > MAX_VISIBLE) this.pings.shift(); // never more stored than are ever drawn
  }

  draw(ctx: CanvasRenderingContext2D, sim: Sim, cam: Camera, cw: number, ch: number): void {
    this.pings = this.pings.filter((p) => sim.tick - p.tick < PING_TICKS);
    const visible = this.pings.slice(-MAX_VISIBLE).reverse(); // newest at top
    const x = cw - ROW_W - 12;
    let y = 60; // keep clear of the top bar
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const p of visible) {
      const life = (sim.tick - p.tick) / PING_TICKS; // 0..1
      ctx.globalAlpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4; // hold at full readability, ease out only over the tail
      ctx.fillStyle = 'rgba(18,22,15,0.85)';
      ctx.fillRect(x, y, ROW_W, ROW_H);
      ctx.fillStyle = TEAM[p.side]; // side-colored left border
      ctx.fillRect(x, y, 3, ROW_H);
      ctx.fillStyle = p.color;
      ctx.fillText(clipToWidth(ctx, p.label, ROW_W - 16), x + 10, y + ROW_H / 2 + 1);
      y += ROW_H + ROW_GAP;
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';

    // World-anchored KIA labels. Co-located casualties (same KIA_CELL bucket)
    // stack with a deterministic vertical offset: stable sort by (tick, name),
    // offset = index * KIA_LINE_H — no Math.random, no wall clock; expiry on
    // sim ticks, so pause freezes them.
    this.kias = this.kias.filter((k) => sim.tick - k.tick < PING_TICKS);
    if (this.kias.length > 0) {
      const cells = new Map<string, WorldKia[]>();
      for (const k of this.kias) {
        const key = `${Math.floor(k.x / KIA_CELL)},${Math.floor(k.y / KIA_CELL)}`;
        const g = cells.get(key);
        if (g) g.push(k);
        else cells.set(key, [k]);
      }
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const group of cells.values()) {
        group.sort((a, b) => a.tick - b.tick || a.label.localeCompare(b.label));
        group.forEach((k, i) => {
          const life = (sim.tick - k.tick) / PING_TICKS;
          ctx.globalAlpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4;
          const [sx, sy] = cam.worldToScreen(k.x, k.y, cw, ch);
          ctx.fillStyle = '#d05c50';
          ctx.fillText(`${k.label} KIA`, sx, sy - 10 - i * KIA_LINE_H);
        });
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }
}

function clipToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}
