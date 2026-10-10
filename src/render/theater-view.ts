// TheaterView (S23-S27): the organic strat map — terrain regions as painted
// areas, road/rail polylines with hierarchy weight, rivers, named places,
// forces as continuously positioned markers, timed-battle rings, node
// control tint. Camera mirrors StrategicView's pan/zoom interface so the
// existing touch grammar ports unchanged. Muted-Normandy palette shared in
// register with the grid view it replaces.
import { pointAlong, type Region, type TerrainClass, type Theater, type TheaterNode, type Vec } from '../strategic/theater';
import type { Force, FrontV2 } from '../strategic/theater/force';
import { forceEtaMinutes, type MoveKernelOpts } from '../strategic/theater/step';
import { supplyTierOf } from '../strategic/theater/supply';
import { contactConf } from '../strategic/intel';
import type { ReconMode } from '../campaign/spec';

import type { Side } from '../sim/sim';
import { MOBILE } from './view';
import { buildFrontLayer, controlKey, washRectM, type FrontLayer } from './theater-front';
import { counterRect, drawCounter, layoutCounters, type CounterSpec, type PlacedCounter } from './theater-counters';

// Terrain separates by VALUE, not hue (the Muted-Normandy rule): a luma ladder
// from forest floor up to rooftops, every rung a clear step. The old palette
// packed farmland, bocage and marsh into one narrow band, which is why the
// theater read as a single green mass.
// The ladder is deliberately SHORT: this is an operational map, and the
// loudest marks on it are forces and the front. The wider ladder it replaces
// made the forest masses and the tan settlement regions the first thing the
// eye found, and neither is something to act on.
const REGION_STYLE: Record<TerrainClass, string> = {
  farmland: '#5b6550',
  bocage: '#4a5443',
  forest: '#3a4437',
  marsh: '#4a5856',
  settlement: '#6c6557',
};
// Value is still one channel. Bocage and marsh carry a texture as well, so the
// pair a red-green eye collapses stays separable.
const REGION_TEXTURE: Partial<Record<TerrainClass, 'hedge' | 'reed'>> = { bocage: 'hedge', marsh: 'reed' };
// Without a boundary, two same-class neighbours are one shape.
const REGION_EDGE = 'rgba(26, 22, 16, 0.32)';
const MAP_BG = '#211d16';
// Under the regions, to the theater bounds. The region polygons stop short of
// the bounds and leave wedges between each other; over the bare background
// those read as holes in the map.
const GROUND = '#525b49';
const FRAME = '#b9ae94';
const WATER = '#3f5d73';
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
// The wash says whose ground it is; a node only needs a rim in its holder's
// colour so a town that changes hands reads at the town as well.
const OWNER_RIM: Record<Side, string> = { blue: '#7fa6ee', red: '#e2796c' };
const WASH_ALPHA = 0.26;
const FRONT_LINE = '#f4ead0';

// The HUD is opaque DOM over the canvas, so the canvas is not what the player
// can see. main.ts measures the panels and hands the borders in; every
// framing operation works against the clear rectangle they leave.
export interface ViewInset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
// zoomMul is relative to the whole theater fitted to the raw canvas. The
// floor is whatever fits the theater into the CLEAR rectangle (at most 1).
export const THEATER_ZOOM_MAX = 8;
// Boot framing stops here: three companies in one town must not open the war
// on a close-up of a road junction.
const FRAME_ZOOM_MAX = 3;
const PAN_SLACK_PX = 80;

// One ETA format for the card, the preview chip and the order flash.
export function fmtEta(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// The march the player is pointing at, not yet ordered. `ok: false` is a
// place the selected company cannot be sent.
export type MarchPreview =
  | { ok: true; pos: Force['pos']; path: number[]; etaMin: number }
  | { ok: false; nodeId: number };

const ARROW_OWN = '#a9c4f5';
const ARROW_SEL = '#d4e3ff';
const ARROW_PREVIEW = '#ffe9a0';
const ARROW_CASE = 'rgba(12, 10, 6, 0.85)';

export class TheaterView {
  zoomMul = 1;
  panX = 0;
  panY = 0;
  inset: ViewInset = { left: 0, top: 0, right: 0, bottom: 0 };
  preview: MarchPreview | null = null; // set by main.ts from the hover or the hold
  supplyOn = false; // S50: gates cut hatching + tier tags (set from CampaignConfig)
  recon: ReconMode = 'omniscient'; // S53: 'contacts' fogs every enemy-derived mark
  private flashText = '';
  private flashUntil = 0;
  private readonly smoothed = new Map<number, Vec[]>();
  private readonly labelW = new Map<string, number>();
  private readonly patterns = new Map<string, CanvasPattern | null>();
  // The counters as last drawn. forceAtScreen reads them: a click lands on
  // what the player sees.
  private counters: PlacedCounter[] = [];
  private frontKey = '';
  private frontCache: FrontLayer | null = null;

  constructor(private readonly theater: Theater) {}

  flash(text: string): void {
    this.flashText = text;
    this.flashUntil = performance.now() + 6000;
  }

  // Base fit: the whole theater inside the viewport with a margin.
  layout(w: number, h: number): { scale: number; ox: number; oy: number } {
    const m = this.margin();
    const scale = (Math.min((w - m * 2) / this.theater.boundsM.w, (h - m * 2) / this.theater.boundsM.h)) * this.zoomMul;
    const ox = (w - this.theater.boundsM.w * scale) / 2 + this.panX;
    const oy = (h - this.theater.boundsM.h * scale) / 2 + this.panY;
    return { scale, ox, oy };
  }

  private clear(w: number, h: number): { x: number; y: number; w: number; h: number } {
    const i = this.inset;
    return { x: i.left, y: i.top, w: Math.max(1, w - i.left - i.right), h: Math.max(1, h - i.top - i.bottom) };
  }

  private margin(): number {
    return MOBILE ? 8 : 40;
  }

  // The zoom at which the whole theater sits inside the clear rectangle.
  minZoom(w: number, h: number): number {
    const m = this.margin();
    const c = this.clear(w, h);
    const { w: tw, h: th } = this.theater.boundsM;
    const fit = Math.min((c.w - m * 2) / tw, (c.h - m * 2) / th);
    const base = Math.min((w - m * 2) / tw, (h - m * 2) / th);
    return Math.max(0.2, Math.min(1, fit / base));
  }

  // The map may leave the clear rectangle by a thumb's width and no more: a
  // map smaller than the clear rectangle stays inside it, a larger one never
  // shows more than the slack of empty ground. A panel that appears later
  // (the company card) moves the map only if it would cover it.
  clampPan(w: number, h: number): void {
    this.zoomMul = Math.max(this.minZoom(w, h), Math.min(THEATER_ZOOM_MAX, this.zoomMul));
    const { scale } = this.layout(w, h);
    const c = this.clear(w, h);
    const axis = (pan: number, full: number, c0: number, cLen: number, mapLen: number): number => {
      const neutral = (full - mapLen) / 2; // the offset at pan 0
      const lo = Math.min(c0, c0 + cLen - mapLen) - PAN_SLACK_PX;
      const hi = Math.max(c0, c0 + cLen - mapLen) + PAN_SLACK_PX;
      return Math.max(lo, Math.min(hi, neutral + pan)) - neutral;
    };
    this.panX = axis(this.panX, w, c.x, c.w, this.theater.boundsM.w * scale);
    this.panY = axis(this.panY, h, c.y, c.h, this.theater.boundsM.h * scale);
  }

  // Put the bounding box of `pts` (theater metres) in the middle of the clear
  // rectangle, as large as it goes with `padPx` of room for counters and names.
  frame(pts: readonly Vec[], w: number, h: number, maxZoom = FRAME_ZOOM_MAX, padPx = MOBILE ? 48 : 72): void {
    if (pts.length === 0) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const c = this.clear(w, h);
    const base = this.layout(w, h).scale / this.zoomMul;
    const want = Math.min(Math.max(1, c.w - padPx * 2) / Math.max(1, x1 - x0), Math.max(1, c.h - padPx * 2) / Math.max(1, y1 - y0));
    this.zoomMul = Math.max(this.minZoom(w, h), Math.min(maxZoom, want / base));
    const scale = base * this.zoomMul;
    const { w: tw, h: th } = this.theater.boundsM;
    this.panX = c.x + c.w / 2 - ((x0 + x1) / 2) * scale - (w - tw * scale) / 2;
    this.panY = c.y + c.h / 2 - ((y0 + y1) / 2) * scale - (h - th * scale) / 2;
    this.clampPan(w, h);
  }

  // The whole theater, inside the clear rectangle.
  fitAll(w: number, h: number): void {
    const { w: tw, h: th } = this.theater.boundsM;
    this.frame([{ x: 0, y: 0 }, { x: tw, y: th }], w, h, 1, this.margin());
  }

  // How a war opens: the player's companies and the nearest objective they do
  // not hold, as large as they go. A phone fitted to the whole theater shows
  // a map a third of the screen tall with the player's sector an inch across.
  frameStart(front: FrontV2, w: number, h: number): void {
    const own = front.forces.filter((f) => f.side === 'blue' && f.strength > 0).map((f) => this.forceXY(f));
    if (own.length === 0) return this.fitAll(w, h);
    const cx = own.reduce((a, p) => a + p.x, 0) / own.length;
    const cy = own.reduce((a, p) => a + p.y, 0) / own.length;
    const goal = this.theater.objectiveNodes
      .filter((n) => front.controlByNode[n] !== 'blue')
      .map((n) => this.theater.nodes[n].pos)
      .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    this.frame(goal ? [...own, goal] : own, w, h);
  }

  // Centre a theater point in the clear rectangle without changing the zoom.
  centerOn(p: Vec, w: number, h: number): void {
    this.frame([p], w, h, this.zoomMul, 0);
  }

  // Zoom by `factor`, keeping the map point under (sx, sy) where it is.
  zoomAt(factor: number, sx: number, sy: number, w: number, h: number): void {
    const [wx, wy] = this.toWorld(sx, sy, w, h);
    this.zoomMul = Math.max(this.minZoom(w, h), Math.min(THEATER_ZOOM_MAX, this.zoomMul * factor));
    const [nx, ny] = this.toScreen(wx, wy, w, h);
    this.panX += sx - nx;
    this.panY += sy - ny;
    this.clampPan(w, h);
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
    const slop = MOBILE ? 8 : 2;
    const onCounter = this.counters.find((c) => {
      const f = front.forces.find((x) => x.id === c.id);
      if (!f || f.strength <= 0 || (side !== null && f.side !== side)) return false;
      const r = counterRect(c);
      return sx >= r.x0 - slop && sx <= r.x1 + slop && sy >= r.y0 - slop && sy <= r.y1 + slop;
    });
    if (onCounter) return onCounter.id;
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

    const mapW = this.theater.boundsM.w * scale;
    const mapH = this.theater.boundsM.h * scale;
    ctx.fillStyle = GROUND;
    ctx.fillRect(ox, oy, mapW, mapH);
    // Everything that is ground is drawn inside the bounds: smoothed region
    // corners and wide rivers would otherwise poke out past the frame.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, mapW, mapH);
    ctx.clip();

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

    // Whose ground: a soft wash, drawn stretched from one pixel per grid cell
    // so its edge is a gradient, not a border.
    const fl = this.frontLayer(front.controlByNode);
    if (fl.wash) {
      const r = washRectM(this.theater);
      ctx.save();
      ctx.globalAlpha = WASH_ALPHA;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fl.wash, ox + r.x * scale, oy + r.y * scale, r.w * scale, r.h * scale);
      ctx.restore();
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

    // The front: where the two washes meet. Over the roads, under the towns.
    for (const [style, lw] of [['rgba(12, 10, 6, 0.75)', 5.5], [FRONT_LINE, 2.5]] as const) {
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      ctx.setLineDash(style === FRONT_LINE ? [9, 5] : []);
      for (const line of fl.lines) {
        trace(line);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    ctx.restore(); // end of the bounds clip
    // A neatline: the map is a sheet with an edge, not a shape in a void.
    ctx.strokeStyle = 'rgba(12, 10, 6, 0.9)';
    ctx.lineWidth = 4;
    ctx.strokeRect(ox, oy, mapW, mapH);
    ctx.strokeStyle = FRAME;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, mapW, mapH);

    // Nodes: holder's rim, kind glyph; labels collected for a
    // declutter pass — towns first, then villages/crossings, greedy cull on
    // screen-space overlap so a dense cluster reads as its principal name.
    // Objectives always carry a ticked designation ring and a starred name —
    // the win condition has to read off the map itself.
    const labels: { sx: number; sy: number; text: string; rank: number; id: number; px: number; r: number }[] = [];
    const objectives = new Set(this.theater.objectiveNodes);
    this.counters = layoutCounters(this.counterSpecs(front, selectedForce, objectives, w, h));
    for (const n of this.theater.nodes) {
      const [sx, sy] = this.toScreen(n.pos.x, n.pos.y, w, h);
      const owner = front.controlByNode[n.id];
      const r = n.rank === 0 ? 7 : n.rank === 1 ? 5 : 3.5;
      ctx.fillStyle = n.crossing ? '#d6c9a4' : n.rank === 0 ? '#e2d6ba' : '#b9ae94';
      this.glyph(ctx, n, sx, sy, r);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = owner ? OWNER_RIM[owner] : INK;
      ctx.lineWidth = 1.5;
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
          ? { sx, sy: sy - r - 14, text: `★ ${n.name}`, rank: -1, id: n.id, px: n.rank === 0 ? 13 : 12, r }
          : { sx, sy: sy - r - 5, text: n.name, rank: n.rank, id: n.id, px: n.rank === 0 ? 12 : 10, r });
      }
    }
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = this.counters.map(counterRect);
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
      // Above the place, else beside it. An objective name is never dropped:
      // if every seat is taken it keeps the first.
      const seats = [
        { cx: l.sx, y: l.sy },
        { cx: l.sx + l.r + 12 + tw / 2, y: l.sy + l.r + 9 },
        { cx: l.sx - l.r - 12 - tw / 2, y: l.sy + l.r + 9 },
      ].map((s) => ({ ...s, rect: { x0: s.cx - tw / 2 - 2, y0: s.y - l.px, x1: s.cx + tw / 2 + 2, y1: s.y + 2 } }));
      const free = seats.find((s) => !placed.some((p) => s.rect.x0 < p.x1 && s.rect.x1 > p.x0 && s.rect.y0 < p.y1 && s.rect.y1 > p.y0));
      const seat = free ?? (l.rank < 0 ? seats[0] : null);
      if (!seat) continue;
      placed.push(seat.rect);
      ctx.strokeText(l.text, seat.cx, seat.y);
      ctx.fillStyle = l.rank < 0 ? '#f3e2ae' : 'rgba(238, 230, 212, 0.95)';
      ctx.fillText(l.text, seat.cx, seat.y);
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

    // Marches. Every moving company keeps a thin arrow to where it is going,
    // along the roads it will use. The selected one is brighter.
    for (const f of front.forces) {
      if (f.side !== 'blue' || f.strength <= 0 || f.path.length === 0 || f.engagedIn !== null) continue;
      const sel = f.id === selectedForce;
      this.arrow(ctx, this.routePts(f.pos, f.path), w, h, sel ? ARROW_SEL : ARROW_OWN, sel ? 3 : 1.8);
    }

    // Forces, on top of everything the map says about the ground.
    for (const c of this.counters) drawCounter(ctx, c);

    // The order preview: the real route, bright, with the time it will take.
    // Drawn over the counters, because it is what the player is looking at.
    if (this.preview?.ok) {
      const pts = this.routePts(this.preview.pos, this.preview.path);
      this.arrow(ctx, pts, w, h, ARROW_PREVIEW, 3.5);
      const end = pts[pts.length - 1];
      const [ex, ey] = this.toScreen(end.x, end.y, w, h);
      this.chip(ctx, fmtEta(this.preview.etaMin), ex, ey, w, ARROW_PREVIEW);
    } else if (this.preview) {
      const n = this.theater.nodes[this.preview.nodeId].pos;
      const [ex, ey] = this.toScreen(n.x, n.y, w, h);
      this.chip(ctx, '✕', ex, ey, w, '#e2543c');
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

  // The wash and the front, rebuilt only when a node changes hands.
  frontLayer(control: readonly (Side | null)[]): FrontLayer {
    const key = controlKey(control);
    if (!this.frontCache || key !== this.frontKey) {
      this.frontKey = key;
      this.frontCache = buildFrontLayer(this.theater, control);
    }
    return this.frontCache;
  }

  // The ground a march covers: the rest of the force's own road, then each
  // road of the path, following the road's own bends.
  private routePts(pos: Force['pos'], path: readonly number[]): Vec[] {
    const out: Vec[] = [];
    let at: number;
    let rest = path;
    if (pos.kind === 'edge') {
      const e = this.theater.edges[pos.edgeId];
      const s1 = pos.dir === 1 ? e.lengthM : 0;
      const lo = Math.min(pos.s, s1);
      const hi = Math.max(pos.s, s1);
      const span: Vec[] = [pointAlong(e, lo)];
      let d = 0;
      for (let i = 1; i < e.polyline.length; i++) {
        d += Math.hypot(e.polyline[i].x - e.polyline[i - 1].x, e.polyline[i].y - e.polyline[i - 1].y);
        if (d > lo && d < hi) span.push(e.polyline[i]);
      }
      span.push(pointAlong(e, hi));
      out.push(...(pos.dir === 1 ? span : span.reverse()));
      at = pos.dir === 1 ? e.b : e.a;
      if (path[0] === e.id) rest = path.slice(1);
    } else {
      at = pos.nodeId;
      out.push(this.theater.nodes[at].pos);
    }
    for (const eid of rest) {
      const e = this.theater.edges[eid];
      const fwd = e.a === at;
      out.push(...(fwd ? e.polyline : [...e.polyline].reverse()));
      at = fwd ? e.b : e.a;
    }
    return out;
  }

  // A cased line with an arrowhead at its end.
  private arrow(ctx: CanvasRenderingContext2D, pts: readonly Vec[], w: number, h: number, color: string, width: number): void {
    if (pts.length < 2) return;
    const s = pts.map((p) => this.toScreen(p.x, p.y, w, h));
    const tip = s[s.length - 1];
    // The direction at the tip, read a few pixels back so a kink at the last
    // vertex does not turn the head sideways.
    let back = s[s.length - 2];
    for (let i = s.length - 2; i >= 0 && Math.hypot(tip[0] - s[i][0], tip[1] - s[i][1]) < 10; i--) back = s[i];
    const a = Math.atan2(tip[1] - back[1], tip[0] - back[0]);
    const head = width * 3 + 4;
    for (const [style, lw] of [[ARROW_CASE, width + 2.5], [color, width]] as const) {
      ctx.strokeStyle = style;
      ctx.fillStyle = style;
      ctx.lineWidth = lw;
      ctx.beginPath();
      s.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
      const grow = style === ARROW_CASE ? 2 : 0;
      ctx.beginPath();
      ctx.moveTo(tip[0] + Math.cos(a) * grow, tip[1] + Math.sin(a) * grow);
      ctx.lineTo(tip[0] - Math.cos(a - 0.45) * (head + grow), tip[1] - Math.sin(a - 0.45) * (head + grow));
      ctx.lineTo(tip[0] - Math.cos(a + 0.45) * (head + grow), tip[1] - Math.sin(a + 0.45) * (head + grow));
      ctx.closePath();
      ctx.fill();
    }
  }

  // A small label on a dark plate beside a point, kept on screen. Beside, not
  // above: the place's own name sits above it.
  private chip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, color: string): void {
    ctx.font = 'bold 12px ui-monospace, monospace';
    const tw = ctx.measureText(text).width + 12;
    const bx = x + 20 + tw > w - 4 ? x - 20 - tw : x + 20;
    const by = Math.max(this.inset.top + 4, y - 10);
    ctx.beginPath();
    ctx.roundRect(bx, by, tw, 20, 4);
    ctx.fillStyle = 'rgba(14, 12, 8, 0.92)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 6, by + 14.5);
  }

  // One spec per force the player may see. Own forces are truth. Under fog
  // (S53) the enemy is drawn from the CONTACT map: a last-seen report, hollow
  // and fading, never the live force. A contact names the force, so its role
  // is known; a force with no contact is not drawn at all.
  private counterSpecs(front: FrontV2, selectedForce: number, objectives: Set<number>, w: number, h: number): CounterSpec[] {
    const at = (pos: Force['pos']): { ax: number; ay: number; drop: number } => {
      const p = pos.kind === 'node' ? this.theater.nodes[pos.nodeId].pos : pointAlong(this.theater.edges[pos.edgeId], pos.s);
      const [ax, ay] = this.toScreen(p.x, p.y, w, h);
      const n = pos.kind === 'node' ? this.theater.nodes[pos.nodeId] : null;
      const r = !n ? 0 : n.rank === 0 ? 7 : n.rank === 1 ? 5 : 3.5;
      return { ax, ay, drop: !n ? 10 : objectives.has(n.id) ? r + 16 : r + 9 };
    };
    const fogged = this.recon === 'contacts';
    const out: CounterSpec[] = [];
    for (const f of front.forces) {
      if (f.strength <= 0 || (fogged && f.side === 'red')) continue;
      out.push({
        id: f.id, side: f.side, letter: f.side === 'blue' ? f.name.charAt(0).toUpperCase() : null, role: f.role,
        strength: f.strength, frac: f.strength / Math.max(1, f.establishment),
        supply: this.supplyOn && f.side === 'blue' ? supplyTierOf(f.untracedMin) : null,
        fatigue: f.side === 'blue' ? f.fatigue : 0,
        selected: f.id === selectedForce, engaged: f.engagedIn !== null, conf: 1, ghost: false, ...at(f.pos),
      });
    }
    if (fogged) {
      for (const c of front.intel?.blue ?? []) {
        const f = front.forces.find((x) => x.id === c.forceId);
        if (!f) continue;
        out.push({
          id: c.forceId, side: 'red', letter: null, role: f.role, strength: c.strength, frac: c.strength / Math.max(1, f.establishment),
          supply: null, fatigue: 0, selected: false, engaged: false, conf: contactConf(c, front.clockMin), ghost: true, ...at(c.pos),
        });
      }
    }
    return out;
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
