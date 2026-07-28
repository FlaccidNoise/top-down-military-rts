// TheaterView (S23-S27): the organic strat map — terrain regions as painted
// areas, road/rail polylines with hierarchy weight, rivers, named places,
// forces as continuously positioned markers, timed-battle rings, node
// control tint. Camera mirrors StrategicView's pan/zoom interface so the
// existing touch grammar ports unchanged. Muted-Normandy palette shared in
// register with the grid view it replaces.
import { pointAlong, type Region, type TerrainClass, type Theater, type TheaterNode, type Vec } from '../strategic/theater';
import type { Force, FrontV2 } from '../strategic/theater/force';
import { forceEtaMinutes, type MoveKernelOpts } from '../strategic/theater/step';
import { supplyTierOf, type SupplyTier } from '../strategic/theater/supply';
import { contactConf } from '../strategic/intel';
import type { ReconMode } from '../campaign/spec';

import type { Side } from '../sim/sim';
import { MOBILE } from './view';

// Terrain separates by VALUE, not hue (the Muted-Normandy rule): a luma ladder
// from forest floor up to rooftops, every rung a clear step. The old palette
// packed farmland, bocage and marsh into one narrow band, which is why the
// theater read as a single green mass.
const REGION_STYLE: Record<TerrainClass, string> = {
  farmland: '#6d7a57',
  bocage: '#46543a',
  forest: '#2f3b28',
  marsh: '#4f6360',
  settlement: '#8f8068',
};
// Value is still one channel. Bocage and marsh carry a texture as well, so the
// pair a red-green eye collapses stays separable.
const REGION_TEXTURE: Partial<Record<TerrainClass, 'hedge' | 'reed'>> = { bocage: 'hedge', marsh: 'reed' };
// Without a boundary, two same-class neighbours are one shape.
const REGION_EDGE = 'rgba(26, 22, 16, 0.55)';
const MAP_BG = '#211d16';
const WATER = '#46647a';
const ROAD: Record<0 | 1 | 2, { color: string; width: number }> = {
  0: { color: '#cbbb94', width: 3 }, // highway
  1: { color: '#ab9d82', width: 2.1 }, // road
  2: { color: '#8b8269', width: 1.5 }, // track
};
// A dark shoulder under a lighter surface is what lets a 2px line read over
// farmland at fit-to-screen; rail is the same trick with the ties on top. The
// shoulder is a fixed 1.8px so it never swallows the surface it frames.
const ROAD_CASE = 'rgba(24, 20, 14, 0.8)';
const ROAD_SHOULDER = 1.8;
const RAIL_CASE = '#2b2620';
const RAIL_TIE = '#7b7364'; // dimmer than any road: rail carries no companies
const INK = 'rgba(20, 17, 11, 0.85)'; // glyph outline / label halo
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
  private readonly patterns = new Map<string, CanvasPattern | null>();

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
    const { scale, ox, oy } = this.layout(w, h);
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const trace = (poly: readonly Vec[]): void => {
      ctx.beginPath();
      poly.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p.x, p.y, w, h);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
    };

    // Regions — the ground truth, painted as organic polygons: fill, then any
    // terrain texture, then a boundary so neighbours never merge.
    for (const r of this.theater.regions) {
      this.tracePoly(ctx, r, w, h);
      ctx.fillStyle = REGION_STYLE[r.terrainClass];
      ctx.fill();
      const tex = REGION_TEXTURE[r.terrainClass];
      const pat = tex ? this.texture(ctx, tex) : null;
      if (pat) {
        // A pattern is screen-space, so anchor it to the map origin — else the
        // texture swims over the ground as the camera pans.
        pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: ox, f: oy });
        ctx.fillStyle = pat;
        ctx.fill();
      }
      ctx.strokeStyle = REGION_EDGE;
      ctx.lineWidth = Math.min(2, 1 + this.zoomMul * 0.25);
      ctx.stroke();
    }

    // Rivers over ground, under roads.
    for (const rv of this.theater.rivers) {
      ctx.strokeStyle = WATER;
      ctx.lineWidth = Math.max(rv.widthClass === 'river' ? 4 : 2, (rv.widthClass === 'river' ? 90 : 45) * scale);
      trace(rv.polyline);
      ctx.stroke();
    }

    // Rail and roads by ascending rank weight (tracks under highways), in two
    // passes: every casing, then every surface. One pass per edge would let a
    // junction show one road's shoulder cutting across another's surface.
    const edges = [...this.theater.edges].sort((a, b) => b.rank - a.rank);
    const zw = Math.min(1.8, Math.sqrt(this.zoomMul));
    for (const core of [false, true]) {
      for (const e of edges) {
        trace(e.polyline);
        if (e.moveClass === 'rail') {
          ctx.strokeStyle = core ? RAIL_TIE : RAIL_CASE;
          ctx.lineWidth = 2.4 * zw;
          if (core) ctx.setLineDash([2, 4.5]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const s = ROAD[e.rank];
          ctx.strokeStyle = core ? s.color : ROAD_CASE;
          ctx.lineWidth = (core ? s.width : s.width + ROAD_SHOULDER) * zw;
          ctx.stroke();
        }
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
        trace(e.polyline);
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
        ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = n.crossing ? '#d6c9a4' : n.rank === 0 ? '#e2d6ba' : '#b9ae94';
      this.glyph(ctx, n, sx, sy, r);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.stroke();
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
    // A halo, not a drop shadow: a name has to read over rooftops and forest
    // alike, and the map has no single background to tune against.
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
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
      ctx.strokeText(l.text, l.sx, l.sy);
      ctx.fillStyle = 'rgba(238, 230, 212, 0.95)';
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

  // ONE round of Chaikin corner-cutting, cached per region — RENDER ONLY:
  // regionAt and every classifier still read the raw lattice polygon, so a
  // battle classifies identically while the map loses its stair-steps. A
  // second round rounded every corner into a blob and pulled each polygon far
  // enough off the lattice to open background gaps between neighbours.
  private smoothPoly(r: Region): Vec[] {
    let pts = this.smoothed.get(r.id);
    if (!pts) {
      const src = r.polygon;
      pts = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i];
        const b = src[(i + 1) % src.length];
        pts.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
        pts.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
      }
      this.smoothed.set(r.id, pts);
    }
    return pts;
  }

  // Node shape carries kind, so the network reads without colour: towns and
  // villages are squares, river crossings diamonds, plain junctions dots.
  // Crossing wins over settlement — a crossing is usually MINTED ON a town or
  // village, which keeps its own `kind`, so `kind` alone never sees a bridge.
  private glyph(ctx: CanvasRenderingContext2D, n: TheaterNode, sx: number, sy: number, r: number): void {
    ctx.beginPath();
    if (n.crossing) {
      const d = r * 1.35;
      ctx.moveTo(sx, sy - d);
      ctx.lineTo(sx + d, sy);
      ctx.lineTo(sx, sy + d);
      ctx.lineTo(sx - d, sy);
      ctx.closePath();
    } else if (n.kind === 'town' || n.kind === 'village') {
      ctx.rect(sx - r, sy - r, r * 2, r * 2);
    } else {
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
    }
  }

  // An 8px tile of terrain texture, built once per class and cached. Null in a
  // headless context, where the caller falls back to the flat fill.
  private texture(ctx: CanvasRenderingContext2D, kind: 'hedge' | 'reed'): CanvasPattern | null {
    let pat = this.patterns.get(kind);
    if (pat === undefined) {
      const c = typeof document === 'undefined' ? null : document.createElement('canvas');
      if (c) {
        c.width = 8;
        c.height = 8;
      }
      const g = c?.getContext('2d') ?? null;
      if (c && g) {
        g.strokeStyle = g.fillStyle = 'rgba(232, 224, 200, 0.14)';
        if (kind === 'hedge') {
          // Diagonal ticks: the hedgerow grain, wrapped across the tile seam.
          g.beginPath();
          for (const o of [-6, 2, 10]) {
            g.moveTo(o, 8);
            g.lineTo(o + 8, 0);
          }
          g.stroke();
        } else {
          g.fillRect(1, 1, 1.5, 1.5);
          g.fillRect(5, 5, 1.5, 1.5);
        }
      }
      pat = c && g ? ctx.createPattern(c, 'repeat') : null;
      this.patterns.set(kind, pat);
    }
    return pat;
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
