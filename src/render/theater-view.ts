// TheaterView (S23-S27): the organic strat map — terrain regions as painted
// areas, road/rail polylines with hierarchy weight, rivers, named places,
// forces as continuously positioned markers, timed-battle rings, node
// control tint. Camera mirrors StrategicView's pan/zoom interface so the
// existing touch grammar ports unchanged. Muted-Normandy palette shared in
// register with the grid view it replaces.
import { pointAlong, type Region, type TerrainClass, type Theater, type Vec } from '../strategic/theater';
import type { Force, FrontV2 } from '../strategic/theater/force';
import { forceEtaMinutes, type MoveKernelOpts } from '../strategic/theater/step';
import { supplyTierOf, type SupplyTier } from '../strategic/theater/supply';
import { contactConf } from '../strategic/intel';
import type { ReconMode } from '../campaign/spec';

import type { Side } from '../sim/sim';
import { MOBILE } from './view';

const REGION_STYLE: Record<TerrainClass, string> = {
  farmland: '#5a6b4c',
  bocage: '#4c5c40',
  forest: '#384630',
  marsh: '#48584f',
  settlement: '#7d6f5c',
};
const MAP_BG = '#211d16';
const WATER = '#46647a';
const ROAD: Record<0 | 1 | 2, { color: string; width: number }> = {
  0: { color: '#a89a7d', width: 3 }, // highway
  1: { color: '#8c8371', width: 2 }, // road
  2: { color: '#6e6757', width: 1.2 }, // track
};
const RAIL = '#3c3830';
const SIDE_COLOR: Record<Side, string> = { blue: '#3a5a9a', red: '#9a3a3a' };
// Objective designation: gold means take it, cool blue means we hold it.
const OBJ_TAKE = '#d8b25c';
const OBJ_HELD = '#7da0d8';
const OBJ_TICKS: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const OWNER_TINT: Record<Side, string> = { blue: 'rgba(70, 110, 180, 0.55)', red: 'rgba(180, 70, 70, 0.55)' };

const SUPPLY_TAG: Record<SupplyTier, { text: string; color: string } | null> = {
  full: null,
  low: { text: 'LOW', color: '#c9803c' },
  out: { text: 'OUT', color: '#b5533c' },
};

export class TheaterView {
  zoomMul = 1;
  panX = 0;
  panY = 0;
  supplyOn = false; // S50: gates cut hatching + tier tags (set from CampaignConfig)
  recon: ReconMode = 'omniscient'; // S53: 'contacts' fogs every enemy-derived mark
  private flashText = '';
  private flashUntil = 0;
  private readonly smoothed = new Map<number, Vec[]>();
  private readonly labelW = new Map<string, number>();

  constructor(private readonly theater: Theater) {}

  flash(text: string): void {
    this.flashText = text;
    this.flashUntil = performance.now() + 6000;
  }

  // Base fit: the whole theater inside the viewport with a margin.
  layout(w: number, h: number): { scale: number; ox: number; oy: number } {
    const m = MOBILE ? 8 : 40;
    const scale = (Math.min((w - m * 2) / this.theater.boundsM.w, (h - m * 2) / this.theater.boundsM.h)) * this.zoomMul;
    const ox = (w - this.theater.boundsM.w * scale) / 2 + this.panX;
    const oy = (h - this.theater.boundsM.h * scale) / 2 + this.panY;
    return { scale, ox, oy };
  }

  clampPan(w: number, h: number): void {
    const { scale } = this.layout(w, h);
    const mw = this.theater.boundsM.w * scale;
    const mh = this.theater.boundsM.h * scale;
    const slackX = Math.max(0, (mw - w) / 2 + 80);
    const slackY = Math.max(0, (mh - h) / 2 + 80);
    this.panX = Math.max(-slackX, Math.min(slackX, this.panX));
    this.panY = Math.max(-slackY, Math.min(slackY, this.panY));
  }

  toScreen(x: number, y: number, w: number, h: number): [number, number] {
    const { scale, ox, oy } = this.layout(w, h);
    return [ox + x * scale, oy + y * scale];
  }

  toWorld(sx: number, sy: number, w: number, h: number): [number, number] {
    const { scale, ox, oy } = this.layout(w, h);
    return [(sx - ox) / scale, (sy - oy) / scale];
  }

  nodeAtScreen(sx: number, sy: number, w: number, h: number): number {
    const [wx, wy] = this.toWorld(sx, sy, w, h);
    const { scale } = this.layout(w, h);
    const rM = Math.max(500, (MOBILE ? 26 : 16) / scale);
    let best = -1;
    let bestD = rM;
    for (const n of this.theater.nodes) {
      const d = Math.hypot(n.pos.x - wx, n.pos.y - wy);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  forceAtScreen(front: FrontV2, side: Side | null, sx: number, sy: number, w: number, h: number): number {
    const [wx, wy] = this.toWorld(sx, sy, w, h);
    const { scale } = this.layout(w, h);
    const rM = Math.max(500, (MOBILE ? 28 : 18) / scale);
    let best = -1;
    let bestD = rM;
    for (const f of front.forces) {
      if (f.strength <= 0) continue;
      if (side !== null && f.side !== side) continue;
      const p = this.forceXY(f);
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d < bestD) {
        bestD = d;
        best = f.id;
      }
    }
    return best;
  }

  forceXY(f: Force): { x: number; y: number } {
    if (f.pos.kind === 'node') return this.theater.nodes[f.pos.nodeId].pos;
    return pointAlong(this.theater.edges[f.pos.edgeId], f.pos.s);
  }

  draw(ctx: CanvasRenderingContext2D, front: FrontV2, selectedForce: number, paused: boolean, speed: number, w: number, h: number): void {
    const { scale } = this.layout(w, h);
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, w, h);

    // Regions — the ground truth, painted as organic polygons.
    for (const r of this.theater.regions) {
      ctx.fillStyle = REGION_STYLE[r.terrainClass];
      this.tracePoly(ctx, r, w, h);
      ctx.fill();
    }

    // Rivers over ground, under roads.
    for (const rv of this.theater.rivers) {
      ctx.strokeStyle = WATER;
      ctx.lineWidth = Math.max(rv.widthClass === 'river' ? 4 : 2, (rv.widthClass === 'river' ? 90 : 45) * scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      rv.polyline.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p.x, p.y, w, h);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
    }

    // Rail then roads by ascending rank weight (tracks under highways).
    const edges = [...this.theater.edges].sort((a, b) => b.rank - a.rank);
    for (const e of edges) {
      ctx.beginPath();
      e.polyline.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p.x, p.y, w, h);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      if (e.moveClass === 'rail') {
        ctx.strokeStyle = RAIL;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const s = ROAD[e.rank];
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.stroke();
      }
    }

    // Supply cut lines (S50): a live enemy force standing ON a road cuts the
    // trace under it — hatch the edge so the interdiction reads at a glance.
    // Drawn from the player's (blue) perspective; the FOW lane gates this on
    // contact visibility when recon: 'contacts' ships.
    if (this.supplyOn) {
      // Under fog the hatch derives from KNOWN contacts, never truth — a cut
      // you have not seen is a cut you have not seen.
      const interdictors: { pos: Force['pos'] }[] =
        this.recon === 'contacts'
          ? (front.intel?.blue ?? [])
          : front.forces.filter((f) => f.side === 'red' && f.strength > 0);
      for (const f of interdictors) {
        if (f.pos.kind !== 'edge') continue;
        const e = this.theater.edges[f.pos.edgeId];
        ctx.strokeStyle = 'rgba(181, 83, 60, 0.85)';
        ctx.lineWidth = 3;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        e.polyline.forEach((p, i) => {
          const [sx, sy] = this.toScreen(p.x, p.y, w, h);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Nodes: control tint ring, kind glyph; labels collected for a
    // declutter pass — towns first, then villages/crossings, greedy cull on
    // screen-space overlap so a dense cluster reads as its principal name.
    // Objectives always carry a ticked designation ring and a starred name —
    // the win condition has to read off the map itself.
    const labels: { sx: number; sy: number; text: string; rank: number; id: number; px: number }[] = [];
    const objectives = new Set(this.theater.objectiveNodes);
    for (const n of this.theater.nodes) {
      const [sx, sy] = this.toScreen(n.pos.x, n.pos.y, w, h);
      const owner = front.controlByNode[n.id];
      const r = n.rank === 0 ? 7 : n.rank === 1 ? 5 : 3.5;
      if (owner) {
        ctx.fillStyle = OWNER_TINT[owner];
        ctx.beginPath();
        ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = n.crossing ? '#c2b391' : n.rank === 0 ? '#d8cbb0' : '#b3a88f';
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      const objective = objectives.has(n.id);
      if (objective) {
        ctx.strokeStyle = owner === 'blue' ? OBJ_HELD : OBJ_TAKE;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        for (const [dx, dy] of OBJ_TICKS) {
          ctx.moveTo(sx + dx * (r + 7), sy + dy * (r + 7));
          ctx.lineTo(sx + dx * (r + 11), sy + dy * (r + 11));
        }
        ctx.stroke();
      }
      if (objective || n.rank <= 1 || n.crossing || this.zoomMul > 1.8) {
        // An objective label always draws: rank -1 places it before every
        // ordinary name in the declutter, the ★ marks it, and the lifted
        // baseline clears the north tick.
        labels.push(objective
          ? { sx, sy: sy - r - 14, text: `★ ${n.name}`, rank: -1, id: n.id, px: n.rank === 0 ? 12 : 10 }
          : { sx, sy: sy - r - 5, text: n.name, rank: n.rank, id: n.id, px: n.rank === 0 ? 12 : 10 });
      }
    }
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    ctx.textAlign = 'center';
    for (const l of labels.sort((a, b) => a.rank - b.rank || a.id - b.id)) {
      ctx.font = `${l.px}px ui-monospace, monospace`;
      const key = `${l.px}:${l.text}`;
      let tw = this.labelW.get(key);
      if (tw === undefined) {
        tw = ctx.measureText(l.text).width;
        this.labelW.set(key, tw);
      }
      const rect = { x0: l.sx - tw / 2 - 2, y0: l.sy - l.px, x1: l.sx + tw / 2 + 2, y1: l.sy + 2 };
      if (placed.some((p) => rect.x0 < p.x1 && rect.x1 > p.x0 && rect.y0 < p.y1 && rect.y1 > p.y0)) continue;
      placed.push(rect);
      ctx.fillStyle = 'rgba(230, 220, 200, 0.85)';
      ctx.fillText(l.text, l.sx, l.sy);
    }

    // Battles: a pulsing ring at the site (deterministic phase from clock).
    // Under fog only battles with an OWN participant ring — an AI-vs-AI
    // fight behind the line would leak positions the sweep never earned.
    for (const b of front.battles) {
      if (this.recon === 'contacts') {
        const ids = [b.attackerId, b.defenderId, ...b.joined];
        if (!front.forces.some((f) => ids.includes(f.id) && f.side === 'blue')) continue;
      }
      const p = b.site.kind === 'node' ? this.theater.nodes[b.site.nodeId].pos : pointAlong(this.theater.edges[b.site.edgeId], b.site.s);
      const [sx, sy] = this.toScreen(p.x, p.y, w, h);
      const pulse = 8 + 3 * Math.sin((front.clockMin % 8) / 8 * Math.PI * 2);
      ctx.strokeStyle = '#c9803c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    // FOW ghosts (S53): the enemy is drawn from the contact map, aged — a
    // hollow outline that fades as confidence decays. Rendered BEFORE own
    // forces so live friendly markers always read on top.
    if (this.recon === 'contacts') {
      for (const c of front.intel?.blue ?? []) {
        const conf = contactConf(c, front.clockMin);
        const p = c.pos.kind === 'node' ? this.theater.nodes[c.pos.nodeId].pos : pointAlong(this.theater.edges[c.pos.edgeId], c.pos.s);
        const [sx, sy] = this.toScreen(p.x, p.y, w, h);
        ctx.globalAlpha = 0.3 + 0.7 * conf;
        ctx.strokeStyle = SIDE_COLOR.red;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx - 7, sy - 5, 14, 10);
        ctx.fillStyle = 'rgba(230, 200, 190, 0.9)';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`~${c.strength}`, sx, sy + 15);
        ctx.globalAlpha = 1;
      }
    }

    // Forces: rectangles at continuous positions, strength bar underneath.
    for (const f of [...front.forces].sort((a, b) => a.id - b.id)) {
      if (f.strength <= 0) continue;
      if (this.recon === 'contacts' && f.side === 'red') continue; // ghosts own the enemy picture
      const p = this.forceXY(f);
      const [sx, sy] = this.toScreen(p.x, p.y, w, h);
      const sel = f.id === selectedForce;
      const bw = f.side === 'blue' ? 16 : 14;
      ctx.fillStyle = SIDE_COLOR[f.side];
      ctx.strokeStyle = sel ? '#e8dcc4' : 'rgba(20, 18, 12, 0.8)';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.fillRect(sx - bw / 2, sy - 5, bw, 10);
      ctx.strokeRect(sx - bw / 2, sy - 5, bw, 10);
      if (f.engagedIn !== null) {
        ctx.fillStyle = '#c9803c';
        ctx.fillRect(sx - 2, sy - 9, 4, 3);
      }
      ctx.fillStyle = 'rgba(230, 220, 200, 0.9)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${f.strength}`, sx, sy + 15);
      if (this.supplyOn) {
        const tag = SUPPLY_TAG[supplyTierOf(f.untracedMin)];
        if (tag) {
          ctx.fillStyle = tag.color;
          ctx.font = 'bold 8px ui-monospace, monospace';
          ctx.fillText(tag.text, sx, sy + 24);
        }
      }
    }

    // Path preview for the selection.
    const sel = front.forces.find((f) => f.id === selectedForce);
    if (sel && sel.path.length > 0) {
      ctx.strokeStyle = 'rgba(230, 220, 200, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const start = this.forceXY(sel);
      let [px, py] = this.toScreen(start.x, start.y, w, h);
      ctx.moveTo(px, py);
      // Walk from the anchor node ahead of the force through each path edge.
      let at = sel.pos.kind === 'edge'
        ? (sel.pos.dir === 1 ? this.theater.edges[sel.pos.edgeId].b : this.theater.edges[sel.pos.edgeId].a)
        : sel.pos.nodeId;
      {
        const ap = this.theater.nodes[at].pos;
        [px, py] = this.toScreen(ap.x, ap.y, w, h);
        ctx.lineTo(px, py);
      }
      for (const eid of sel.path) {
        if (sel.pos.kind === 'edge' && eid === sel.pos.edgeId) continue; // own edge already drawn
        const e = this.theater.edges[eid];
        at = e.a === at ? e.b : e.a;
        const fp = this.theater.nodes[at].pos;
        [px, py] = this.toScreen(fp.x, fp.y, w, h);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Chrome lives in the TheaterHud DOM; the canvas keeps only the flash.
    void paused;
    void speed;
    if (this.flashText && performance.now() < this.flashUntil) {
      // Under the top bar is unreadable, and that bar wraps to two rows on a
      // phone — so its height is measured, never assumed.
      const bar = typeof document === 'undefined' ? null : document.querySelector('#theater-hud .th-top')?.getBoundingClientRect();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8dcc4';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText(this.flashText, w / 2, bar && bar.height > 0 ? bar.bottom + 20 : 24);
    }
  }

  // ETA readout for the HUD: the S13 mirror, kernel opts threaded (S52).
  etaFor(front: FrontV2, forceId: number, dest: number, opts: MoveKernelOpts = {}): number | null {
    const f = front.forces.find((x) => x.id === forceId);
    if (!f) return null;
    try {
      return forceEtaMinutes(front, f, dest, opts);
    } catch {
      return null;
    }
  }

  // Two rounds of Chaikin corner-cutting, cached per region — RENDER ONLY:
  // regionAt and every classifier still read the raw lattice polygon, so a
  // battle classifies identically while the map loses its stair-steps.
  private smoothPoly(r: Region): Vec[] {
    let pts = this.smoothed.get(r.id);
    if (!pts) {
      pts = r.polygon;
      for (let round = 0; round < 2; round++) {
        const out: Vec[] = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
          out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
        }
        pts = out;
      }
      this.smoothed.set(r.id, pts);
    }
    return pts;
  }

  private tracePoly(ctx: CanvasRenderingContext2D, r: Region, w: number, h: number): void {
    ctx.beginPath();
    this.smoothPoly(r).forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.x, p.y, w, h);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
  }
}
