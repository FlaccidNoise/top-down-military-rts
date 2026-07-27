import { EDGE, type GameMap } from '../sim/map';
import { AO_ALPHA, SUN, shadowOffset } from './light';
import { hash } from './noise';
import type { PatchIndex } from './patches';
import { stamp } from './stamps';
import type { Detail } from './terrain';

// Environmental clutter (G6). Until now nothing man-made existed anywhere
// outside hedges and buildings, which is why an empty corner of the map read
// as a lawn rather than as farmland somebody works. Every prop is decoration —
// the sim has no collision for any of it — so placement is conservative:
// nothing on a road surface, nothing on a door approach, nothing inside a
// footprint, and the big items stay clear of the lanes units actually walk.
//
// The list is built ONCE from the map and bucketed per chunk, so a chunk bake
// pays only for the props it shows. Salts 260-299.

export type PropKind = 'haystack' | 'cart' | 'barrels' | 'crates' | 'well' | 'trough' | 'muckheap' | 'fencepost' | 'gate' | 'telegraph';

export interface Prop {
  x: number;
  y: number;
  kind: PropKind;
  seed: number;
  axis: 0 | 1; // 0 = runs east-west, 1 = runs north-south
  // "the next member of this run stands one spacing along +axis" — fence
  // rails and telegraph wires are drawn forward from a post, and without this
  // the last post of a run trails a rail into empty grass.
  link?: boolean;
}

type Ctx = CanvasRenderingContext2D;

const MIN_GAP = 0.8;
const POLE_SPACING = 6;
const POST_SPACING = 1.6;

// The height a prop's cast shadow is thrown from. Under strict plan projection
// this is the ONLY place a prop's verticality shows, so a telegraph pole's
// reach SE is a real part of its footprint on the map.
const POLE_H = 6.5;
const WELL_FRAME_H = 1.8;
const POST_H = 1;

// How far a prop's ink reaches from its anchor — the chunk bucketing uses it,
// so a telegraph wire or a pole's shadow is never clipped off at a seam.
export function propExtent(p: Prop): [number, number, number, number] {
  const ax = p.axis === 0 ? 1 : 0;
  const ay = p.axis === 0 ? 0 : 1;
  const fwd = p.link ? (p.kind === 'telegraph' ? POLE_SPACING : POST_SPACING) : 0;
  const r = p.kind === 'haystack' ? 2.4 : p.kind === 'telegraph' ? 3 : p.kind === 'cart' || p.kind === 'well' || p.kind === 'gate' ? 2 : 1.4;
  const cast = p.kind === 'telegraph' ? POLE_H : p.kind === 'well' ? WELL_FRAME_H : 0;
  return [p.x - r, p.y - r, p.x + r + ax * fwd + SUN.dx * cast, p.y + r + ay * fwd + SUN.dy * cast];
}

function doorNear(map: GameMap, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ax = tx + dx;
      const ay = ty + dy;
      if (map.hEdge(ax, ay) === EDGE.DOOR && Math.hypot(ax + 0.5 - x, ay - y) < 1.2) return true;
      if (map.hEdge(ax, ay + 1) === EDGE.DOOR && Math.hypot(ax + 0.5 - x, ay + 1 - y) < 1.2) return true;
      if (map.vEdge(ax, ay) === EDGE.DOOR && Math.hypot(ax - x, ay + 0.5 - y) < 1.2) return true;
      if (map.vEdge(ax + 1, ay) === EDGE.DOOR && Math.hypot(ax + 1 - x, ay + 0.5 - y) < 1.2) return true;
    }
  }
  return false;
}

export function canPlace(map: GameMap, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!map.inBounds(tx, ty)) return false;
  if (map.buildingIdAt(tx, ty) >= 0) return false;
  if (map.isBridge(tx, ty)) return false;
  const k = map.terrainKeyAt(tx, ty);
  if (k !== 'grass' && k !== 'field') return false;
  return !doorNear(map, x, y);
}

class Placer {
  readonly out: Prop[] = [];
  private cells = new Map<number, [number, number][]>();

  constructor(private map: GameMap) {}

  add(x: number, y: number, kind: PropKind, seed: number, axis: 0 | 1 = 0, link = false): boolean {
    if (!canPlace(this.map, x, y)) return false;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.cells.get((cy + dy) * 4096 + cx + dx);
        if (!c) continue;
        for (const [px, py] of c) if (Math.hypot(px - x, py - y) < MIN_GAP) return false;
      }
    }
    const key = cy * 4096 + cx;
    const arr = this.cells.get(key) ?? [];
    arr.push([x, y]);
    this.cells.set(key, arr);
    this.out.push(link ? { x, y, kind, seed, axis, link } : { x, y, kind, seed, axis });
    return true;
  }
}

// Crop type has to agree with terrain.ts's own read of the parcel seed —
// haystacks belong on cereal, not on a ploughed field.
const isCereal = (seed: number) => {
  const t = hash(seed, 0, 244);
  return t >= 0.4 && t < 0.75;
};

export function propsFor(map: GameMap, patches: PatchIndex): Prop[] {
  const p = new Placer(map);
  const roadAt = (x: number, y: number) => map.inBounds(x, y) && map.terrainKeyAt(x, y) === 'road' && !map.isBridge(x, y);

  // (1) Haystacks on cereal parcels, one per 60 tiles, well inside the parcel
  // so a stack never straddles the headland.
  for (let i = 0; i < patches.patches.length; i++) {
    const q = patches.patches[i];
    if (q.kind !== 'field' || !isCereal(q.seed)) continue;
    const n = Math.floor(q.tiles / 60);
    for (let k = 0; k < n; k++) {
      const hx = q.minX + hash(q.seed + k, 0, 260) * (q.maxX - q.minX);
      const hy = q.minY + hash(q.seed + k, 1, 260) * (q.maxY - q.minY);
      const inside =
        patches.id[Math.floor(hy) * map.w + Math.floor(hx)] === i &&
        [[3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dy]) => {
          const ax = Math.floor(hx) + dx;
          const ay = Math.floor(hy) + dy;
          return map.inBounds(ax, ay) && patches.id[ay * map.w + ax] === i;
        });
      if (inside) p.add(hx, hy, 'haystack', (hash(q.seed + k, 2, 260) * 4096) | 0);
    }
  }

  // (2-3) Farm courts: the house/barn pair mapgen drops a few metres apart is
  // a working yard, and a working yard has a muck heap, a trough, a cart and
  // a well. Wall-huggers (barrels, crates) go on the shaded N or W face.
  const yards: [number, number, number][] = []; // cx, cy, seed
  for (let i = 0; i < patches.buildings.length; i++) {
    for (let k = i + 1; k < patches.buildings.length; k++) {
      const a = patches.buildings[i];
      const b = patches.buildings[k];
      const gx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
      const gy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
      if (Math.hypot(gx, gy) > 4) continue;
      yards.push([(a.cx + b.cx) / 2, (a.cy + b.cy) / 2, a.id * 71 + b.id]);
    }
  }
  // A farm court is mostly roof and door approach, so a single sample almost
  // always lands somewhere illegal: walk a jittered ring until something
  // sticks, or accept that this yard has no room for the prop.
  const near = (cx: number, cy: number, seed: number, salt: number, kind: PropKind, axis: 0 | 1 = 0): boolean => {
    for (let k = 0; k < 12; k++) {
      const a = hash(seed, k, salt) * Math.PI * 2;
      const r = 2.5 + hash(seed, k + 16, salt) * 5;
      if (p.add(cx + Math.cos(a) * r, cy + Math.sin(a) * r, kind, (hash(seed, 2, salt) * 4096) | 0, axis)) return true;
    }
    return false;
  };
  for (const [yx, yy, seed] of yards) {
    near(yx, yy, seed, 261, 'muckheap');
    near(yx, yy, seed, 262, 'trough', hash(seed, 3, 262) < 0.5 ? 0 : 1);
    if (hash(seed, 0, 263) < 0.7) near(yx, yy, seed, 263, 'cart', hash(seed, 3, 263) < 0.5 ? 0 : 1);
    if (hash(seed, 0, 264) < 0.45) near(yx, yy, seed, 264, 'well');
  }
  // (4) One well per settlement, not per junction: mapgen's 3-tile arterial
  // splits a single village crossroads into several crossing clusters, and a
  // well on each of them turns the square into a well farm.
  const wells: [number, number][] = [];
  for (let i = 0; i < patches.junctions.length; i++) {
    const j = patches.junctions[i];
    if (j.buildings < 4) continue;
    if (wells.some(([wx, wy]) => Math.hypot(wx - j.x, wy - j.y) < 28)) continue;
    for (let k = 0; k < 12; k++) {
      const a = hash(i, k, 265) * Math.PI * 2;
      const r = 7 + hash(i, k, 266) * 7;
      if (p.add(j.x + Math.cos(a) * r, j.y + Math.sin(a) * r, 'well', (hash(i, 0, 265) * 4096) | 0)) {
        wells.push([j.x, j.y]);
        break;
      }
    }
  }
  // (5) Barrels and crates against a building's north or west outside face.
  for (const b of patches.buildings) {
    const n = (hash(b.id, 0, 267) * 3.4) | 0;
    for (let k = 0; k < n; k++) {
      const west = hash(b.id * 5 + k, 0, 268) < 0.5;
      const u = 0.5 + hash(b.id * 5 + k, 1, 268) * ((west ? b.maxY - b.minY : b.maxX - b.minX) - 1);
      const x = west ? b.minX - 0.45 : b.minX + u;
      const y = west ? b.minY + u : b.minY - 0.45;
      p.add(x, y, hash(b.id * 5 + k, 2, 268) < 0.55 ? 'barrels' : 'crates', (hash(b.id * 5 + k, 3, 268) * 4096) | 0);
    }
  }

  // (6) Post-and-rail where an enclosure meets a lane — a field parcel's
  // border, or a hedged pasture panel whose hedge stops short of the road.
  // This is what gives the open bocage man-made structure where the hedges
  // are absent. Posts are placed on the world coordinate lattice, not per
  // tile, so the 1.6 m rhythm is unbroken along the whole border.
  const hedgeAt = (x: number, y: number) => map.inBounds(x, y) && map.terrainKeyAt(x, y) === 'hedge';
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const k = map.terrainKeyAt(x, y);
      if (k !== 'field' && k !== 'grass') continue;
      const parcel = k === 'field' && patches.id[y * map.w + x] >= 0;
      for (const [dx, dy] of [[0, -1], [-1, 0], [0, 1], [1, 0]] as [number, number][]) {
        const nx = x + dx;
        const ny = y + dy;
        if (!map.inBounds(nx, ny)) continue;
        const nk = map.terrainKeyAt(nx, ny);
        // `buildingIdAt` rather than the `floor` key alone: with interiors on
        // (I9) the tile behind an exterior wall can be a hearth or a dresser
        // instead of bare floor, and the key test alone then plants a fence
        // panel flat against the house. Identical on an unfurnished map, where
        // every building interior tile is `floor`.
        if (nk === k || nk === 'hedge' || nk === 'water' || nk === 'floor' || map.buildingIdAt(nx, ny) >= 0) continue;
        // only a border a lane actually runs past
        let lane = false;
        for (let i = 0; i <= 3 && !lane; i++) lane = roadAt(nx + dx * i, ny + dy * i);
        if (!lane) continue;
        // a pasture only counts as enclosed if a hedge run stands behind it —
        // otherwise every metre of open verge on the map grows a fence
        if (!parcel && !(hedgeAt(x - dx * 2, y - dy * 2) || hedgeAt(x - dx * 3, y - dy * 3) || hedgeAt(x - dx * 4, y - dy * 4))) continue;
        const axis: 0 | 1 = dy ? 0 : 1;
        const u = axis === 0 ? x : y;
        const slot = Math.ceil(u / POST_SPACING) * POST_SPACING;
        if (slot >= u + 1) continue;
        const t = dy < 0 || dx < 0 ? 0.08 : 0.92;
        const px2 = axis === 0 ? slot : x + t;
        const py2 = axis === 0 ? y + t : slot;
        const kind: PropKind = hash(Math.round(slot), axis === 0 ? y : x, 269) < 0.06 ? 'gate' : 'fencepost';
        p.add(px2, py2, kind, (hash(Math.round(slot), axis === 0 ? y : x, 270) * 4096) | 0, axis, true);
      }
    }
  }

  // (7) Telegraph poles on the verge of a long straight road run, every 6 m,
  // one side only (the low-coordinate verge) so a lane never grows two rows
  // of poles. The wire runs forward to the next pole and no further.
  const runLen = (x: number, y: number, dx: number, dy: number) => {
    let n = 1;
    for (let i = 1; i <= 10 && roadAt(x - dx * i, y - dy * i); i++) n++;
    for (let i = 1; i <= 10 && roadAt(x + dx * i, y + dy * i); i++) n++;
    return n;
  };
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const k = map.terrainKeyAt(x, y);
      if (k !== 'grass' && k !== 'field') continue;
      // verge tile: the road is immediately east or south of it
      for (const [dx, dy] of [[1, 0], [0, 1]] as [number, number][]) {
        if (!roadAt(x + dx, y + dy)) continue;
        const axis: 0 | 1 = dx ? 1 : 0; // pole line runs along the road, i.e. across dx/dy
        const along = axis === 0 ? runLen(x + dx, y + dy, 1, 0) : runLen(x + dx, y + dy, 0, 1);
        const across = axis === 0 ? runLen(x + dx, y + dy, 0, 1) : runLen(x + dx, y + dy, 1, 0);
        if (along < 6 || across >= along) continue;
        const u = axis === 0 ? x : y;
        if (u % POLE_SPACING !== 0) continue;
        const nu = u + POLE_SPACING;
        const nx = axis === 0 ? nu : x;
        const ny = axis === 0 ? y : nu;
        const link = map.inBounds(nx, ny) && roadAt(nx + dx, ny + dy) && canPlace(map, nx + 0.5, ny + 0.5);
        p.add(x + 0.5, y + 0.5, 'telegraph', (hash(x, y, 271) * 4096) | 0, axis, link);
      }
    }
  }
  return p.out;
}

// Weathered old craters — shell holes the fighting here did not make, so the
// ground already reads as contested before a single round lands. Returned as
// spots for DecalLayer rather than props: they belong under the fresh scorch
// marks, not in the terrain bake.
export function craterSpots(map: GameMap, patches: PatchIndex): [number, number, number][] {
  const out: [number, number, number][] = [];
  const anchors: [number, number][] = [
    ...patches.junctions.map((j) => [j.x, j.y] as [number, number]),
    ...patches.patches.filter((q) => q.tiles > 40).map((q) => [q.cx, q.cy] as [number, number]),
  ];
  for (let i = 0; i < anchors.length && out.length < 6; i++) {
    if (hash(i, 0, 272) > 0.35) continue;
    const a = hash(i, 1, 272) * Math.PI * 2;
    const r = 4 + hash(i, 2, 272) * 10;
    const x = anchors[i][0] + Math.cos(a) * r;
    const y = anchors[i][1] + Math.sin(a) * r;
    if (!canPlace(map, x, y)) continue;
    out.push([x, y, (hash(i, 3, 272) * 4096) | 0]);
  }
  return out;
}

function haystackStamp(v: number, band: number): HTMLCanvasElement {
  return stamp(`prop:hay:${v}`, band, 2.2, (g) => {
    const c = 1.1;
    g.fillStyle = 'rgb(126,110,74)';
    g.beginPath();
    g.ellipse(c, c, 0.92, 0.8, 0, 0, Math.PI * 2);
    g.fill();
    // thatch courses brightening toward the NW shoulder
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      g.strokeStyle = `rgba(${152 + i * 14},${138 + i * 13},${100 + i * 11},0.45)`;
      g.lineWidth = 0.1;
      g.beginPath();
      g.arc(c, c + 0.12, 0.78 - i * 0.2, Math.PI * 1.06, Math.PI * 1.94);
      g.stroke();
    }
    g.fillStyle = 'rgba(30,26,18,0.28)';
    g.beginPath();
    g.ellipse(c + 0.24, c + 0.22, 0.62, 0.5, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(190,174,130,0.5)';
    g.beginPath();
    g.ellipse(c - 0.16, c - 0.2, 0.34, 0.26, 0, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 5 + ((hash(v, 0, 273) * 4) | 0); i++) {
      const a = hash(v * 7 + i, 0, 273) * Math.PI * 2;
      const r = 0.7 + hash(v * 7 + i, 1, 273) * 0.24;
      g.strokeStyle = 'rgba(182,168,124,0.5)';
      g.lineWidth = 0.035;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * (r - 0.14), c + Math.sin(a) * (r - 0.14));
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      g.stroke();
    }
  });
}

// A round-capped finger from an upright's foot to where its top lands. One
// connected shape, so a post keeps its shadow instead of standing beside a
// detached copy of itself.
function finger(g: Ctx, x: number, y: number, dx: number, dy: number, w: number, alpha: number): void {
  g.lineCap = 'round';
  g.strokeStyle = `rgba(16,18,12,${alpha})`;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + dx, y + dy);
  g.stroke();
  g.lineCap = 'butt';
}

// A fence post from directly above is its 0.11 m section and a finger of
// shade — not the 0.4 m of side elevation this used to draw standing north of
// its own base. The stamp is 1.4 m so the throw has somewhere to land.
const POST_SPRITE = 1.4;

function postStamp(v: number, band: number): HTMLCanvasElement {
  return stamp(`prop:post:${v}`, band, POST_SPRITE, (g) => {
    const [sx, sy] = shadowOffset(POST_H);
    finger(g, 0.4, 0.4, sx, sy, 0.13, 0.18);
    g.fillStyle = hash(v, 0, 274) > 0.5 ? 'rgb(72,60,42)' : 'rgb(60,50,36)';
    g.fillRect(0.345, 0.345, 0.11, 0.11);
    g.fillStyle = 'rgba(178,164,132,0.22)';
    g.fillRect(0.345, 0.345, 0.11, 0.035);
  });
}

// Every prop shares the one sun: a single SE lobe under the mass, and at the
// far tier nothing BUT that lobe plus a base colour, so a distant field shows
// readable specks instead of mush.
function lobe(g: Ctx, x: number, y: number, rx: number, ry: number, len: number, alpha: number): void {
  const [sx, sy] = shadowOffset(len);
  g.fillStyle = `rgba(18,20,14,${alpha})`;
  g.beginPath();
  g.ellipse(x + sx, y + sy, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
}

const SILHOUETTE: Record<PropKind, [string, number]> = {
  haystack: ['rgb(126,110,74)', 0.8],
  cart: ['#5f4e34', 0.7],
  barrels: ['#5a4a34', 0.28],
  crates: ['#6b5940', 0.34],
  well: ['#7d786c', 0.6],
  trough: ['#4c4a42', 0.4],
  muckheap: ['#4a3c26', 0.6],
  fencepost: ['#4a3e2c', 0.1],
  gate: ['#5f4426', 0.14],
  telegraph: ['#3f362a', 0.14],
};

export function drawProp(g: Ctx, p: Prop, band: number, d: Detail): void {
  const { x, y, seed } = p;
  const ax = p.axis === 0 ? 1 : 0;
  const ay = p.axis === 0 ? 0 : 1;
  if (d === 0) {
    const [col, r] = SILHOUETTE[p.kind];
    if (r < 0.2) return; // posts and poles are sub-pixel at this band — noise, not detail
    lobe(g, x, y, r * 1.1, r * 0.85, r * 0.9, 0.26);
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.82, 0, 0, Math.PI * 2);
    g.fill();
    return;
  }
  switch (p.kind) {
    case 'haystack': {
      lobe(g, x, y, 1.05, 0.78, 1.2, 0.3);
      g.fillStyle = `rgba(12,14,10,${(AO_ALPHA * 0.5).toFixed(3)})`;
      g.beginPath();
      g.ellipse(x, y + 0.06, 0.98, 0.86, 0, 0, Math.PI * 2);
      g.fill();
      g.drawImage(haystackStamp(seed & 7, band), x - 1.1, y - 1.1, 2.2, 2.2);
      return;
    }
    case 'cart': {
      const w = 2.2;
      const h = 1.1;
      const [sx, sy] = shadowOffset(0.7);
      const rx = (u: number, v: number) => x + (ax ? u : v);
      const ry = (u: number, v: number) => y + (ax ? v : u);
      g.fillStyle = 'rgba(18,20,14,0.28)';
      g.fillRect(rx(-w / 2, -h / 2) + sx, ry(-w / 2, -h / 2) + sy, ax ? w : h, ax ? h : w);
      g.fillStyle = '#6e5a3c';
      g.fillRect(rx(-w / 2, -h / 2), ry(-w / 2, -h / 2), ax ? w : h, ax ? h : w);
      g.fillStyle = '#5a4830';
      g.fillRect(rx(-w / 2, -0.04), ry(-w / 2, -0.04), ax ? w : 0.08, ax ? 0.08 : w);
      // Solid wheels with a hub dot. A ring with crossing spokes is correct
      // side-on and reads as a crosshair from above — the one silhouette a
      // wargame must never draw by accident.
      for (const su of [-0.72, 0.72]) {
        for (const sv of [-1, 1]) {
          const wx = rx(su, (sv * h) / 2);
          const wy = ry(su, (sv * h) / 2);
          g.fillStyle = '#332a1f';
          g.beginPath();
          g.ellipse(wx, wy, ax ? 0.24 : 0.14, ax ? 0.14 : 0.24, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = 'rgba(146,130,98,0.5)';
          g.beginPath();
          g.arc(wx, wy, 0.055, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.strokeStyle = '#5a4830';
      g.lineWidth = 0.07;
      g.beginPath();
      for (const sv of [-0.3, 0.3]) {
        g.moveTo(rx(w / 2, sv), ry(w / 2, sv));
        g.lineTo(rx(w / 2 + 1, sv * 0.5), ry(w / 2 + 1, sv * 0.5));
      }
      g.stroke();
      return;
    }
    case 'barrels': {
      lobe(g, x, y, 0.3, 0.24, 0.35, 0.26);
      g.fillStyle = '#5a4a34';
      g.beginPath();
      g.arc(x, y, 0.25, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(190,176,140,0.25)';
      g.lineWidth = 0.07;
      g.beginPath();
      g.arc(x, y, 0.19, Math.PI * 1.05, Math.PI * 1.95);
      g.stroke();
      g.strokeStyle = 'rgba(34,28,20,0.45)';
      g.lineWidth = 0.05;
      g.beginPath();
      g.arc(x, y, 0.13, 0, Math.PI * 2);
      g.stroke();
      return;
    }
    case 'crates': {
      const [sx, sy] = shadowOffset(0.45);
      g.fillStyle = 'rgba(18,20,14,0.26)';
      g.fillRect(x - 0.35 + sx, y - 0.35 + sy, 0.7, 0.7);
      g.fillStyle = '#6b5940';
      g.fillRect(x - 0.35, y - 0.35, 0.7, 0.7);
      g.strokeStyle = 'rgba(40,32,22,0.5)';
      g.lineWidth = 0.05;
      g.beginPath();
      g.moveTo(x - 0.35, y - 0.1);
      g.lineTo(x + 0.35, y - 0.1);
      g.moveTo(x - 0.35, y + 0.15);
      g.lineTo(x + 0.35, y + 0.15);
      g.stroke();
      g.fillStyle = 'rgba(190,176,140,0.2)';
      g.fillRect(x - 0.35, y - 0.35, 0.7, 0.07);
      return;
    }
    case 'well': {
      lobe(g, x, y, 0.78, 0.6, 0.8, 0.28);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const t = 0.86 + hash(seed + i, 0, 275) * 0.22;
        g.fillStyle = `rgb(${Math.round(126 * t)},${Math.round(120 * t)},${Math.round(108 * t)})`;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * 0.5, y + Math.sin(a) * 0.42, 0.22, 0.19, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(16,18,16,0.75)';
      g.beginPath();
      g.ellipse(x, y, 0.33, 0.27, 0, 0, Math.PI * 2);
      g.fill();
      if (d < 2) return;
      // The frame in plan: two uprights on the rim (0.09 m squares), the
      // windlass beam spanning them at 1.8 m — which from directly above lies
      // on the SAME line as their feet — and the beam's shadow thrown clear of
      // the whole thing. The old version drew 0.74 m of upright standing north
      // of the rim, which is the side of the well.
      const [sx, sy] = shadowOffset(WELL_FRAME_H);
      finger(g, x - 0.52, y, sx, sy, 0.11, 0.2);
      finger(g, x + 0.52, y, sx, sy, 0.11, 0.2);
      g.strokeStyle = 'rgba(18,20,14,0.20)';
      g.lineWidth = 0.09;
      g.beginPath();
      g.moveTo(x - 0.52 + sx, y + sy);
      g.lineTo(x + 0.52 + sx, y + sy);
      g.stroke();
      g.strokeStyle = '#42351f';
      g.lineWidth = 0.085;
      g.beginPath();
      g.moveTo(x - 0.52, y);
      g.lineTo(x + 0.52, y);
      g.stroke();
      g.strokeStyle = 'rgba(174,160,126,0.22)';
      g.lineWidth = 0.028;
      g.beginPath();
      g.moveTo(x - 0.52, y - 0.03);
      g.lineTo(x + 0.52, y - 0.03);
      g.stroke();
      g.fillStyle = '#4a3c26';
      g.fillRect(x - 0.565, y - 0.045, 0.09, 0.09);
      g.fillRect(x + 0.475, y - 0.045, 0.09, 0.09);
      g.fillStyle = '#5a4a34'; // the bucket, hanging over the shaft
      g.beginPath();
      g.arc(x + 0.12, y, 0.1, 0, Math.PI * 2);
      g.fill();
      return;
    }
    case 'trough': {
      const w = 1.6;
      const h = 0.5;
      const [sx, sy] = shadowOffset(0.4);
      const rw = ax ? w : h;
      const rh = ax ? h : w;
      g.fillStyle = 'rgba(18,20,14,0.26)';
      g.fillRect(x - rw / 2 + sx, y - rh / 2 + sy, rw, rh);
      g.fillStyle = '#4c4a42';
      g.fillRect(x - rw / 2, y - rh / 2, rw, rh);
      g.fillStyle = 'rgba(92,104,104,0.50)';
      g.fillRect(x - rw / 2 + 0.08, y - rh / 2 + 0.08, rw - 0.16, rh - 0.16);
      g.fillStyle = 'rgba(206,214,208,0.28)';
      g.fillRect(x - rw / 2 + 0.12, y - rh / 2 + 0.12, (rw - 0.24) * 0.5, 0.06);
      return;
    }
    case 'muckheap': {
      lobe(g, x, y, 0.78, 0.58, 0.6, 0.26);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const t = 0.84 + hash(seed + i, 0, 276) * 0.3;
        g.fillStyle = `rgb(${Math.round(74 * t)},${Math.round(60 * t)},${Math.round(38 * t)})`;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * 0.3, y + Math.sin(a) * 0.24, 0.36, 0.3, 0, 0, Math.PI * 2);
        g.fill();
      }
      if (d < 2) return;
      g.strokeStyle = 'rgba(178,160,110,0.4)';
      g.lineWidth = 0.035;
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = hash(seed + i, 0, 277) * Math.PI * 2;
        const r = 0.2 + hash(seed + i, 1, 277) * 0.4;
        g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        g.lineTo(x + Math.cos(a) * r + 0.16, y + Math.sin(a) * r - 0.06);
      }
      g.stroke();
      return;
    }
    case 'fencepost':
    case 'gate': {
      if (p.link) {
        const ex = x + ax * POST_SPACING;
        const ey = y + ay * POST_SPACING;
        // Two rails at two heights, and a gate's diagonal brace, all live in
        // the fence's vertical plane — from directly above they project onto
        // the SAME line. One rail band plus the run's own shadow, then; the
        // old pair of lines offset north was an elevation of the panel.
        const [rdx, rdy] = shadowOffset(POST_H * (p.kind === 'gate' ? 1.1 : 0.85));
        const bar = (odx: number, ody: number, w: number, style: string): void => {
          g.strokeStyle = style;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(x + odx, y + ody);
          g.lineTo(ex + odx, ey + ody);
          g.stroke();
        };
        bar(rdx, rdy, p.kind === 'gate' ? 0.08 : 0.05, 'rgba(16,18,12,0.16)');
        bar(0, 0, p.kind === 'gate' ? 0.1 : 0.06, p.kind === 'gate' ? 'rgba(112,88,54,0.80)' : 'rgba(96,80,56,0.70)');
        bar(-0.02, -0.025, 0.02, 'rgba(186,172,140,0.24)');
      }
      g.drawImage(postStamp(seed & 3, band), x - 0.4, y - 0.4, POST_SPRITE, POST_SPRITE);
      return;
    }
    case 'telegraph': {
      // Strict plan. The pole is vertical, so it is a 0.16 m disc; the arm is
      // horizontal, so it projects true and runs ACROSS the wire line (it used
      // to be x-aligned whichever way the road ran). A catenary sags in a
      // vertical plane and therefore projects to a straight line, so the wires
      // are straight — the old northward dip was a side view of the sag. All
      // 6.5 m of pole is in the shadow, which is what makes the road read as
      // having something tall beside it.
      const [sx, sy] = shadowOffset(POLE_H);
      const arm = 0.45;
      const px2 = ay * arm; // perpendicular to the pole line
      const py2 = ax * arm;
      if (p.link && d >= 1) {
        const ex = x + ax * POLE_SPACING;
        const ey = y + ay * POLE_SPACING;
        g.strokeStyle = 'rgba(28,26,22,0.30)';
        g.lineWidth = 0.04;
        g.beginPath();
        for (const s of [-1, 1]) {
          g.moveTo(x + px2 * s * 0.82, y + py2 * s * 0.82);
          g.lineTo(ex + px2 * s * 0.82, ey + py2 * s * 0.82);
        }
        g.stroke();
      }
      finger(g, x, y, sx, sy, 0.17, 0.2);
      // the arm's own shadow, laid parallel to itself out at the arm's height
      const [adx, ady] = shadowOffset(POLE_H * 0.94);
      g.strokeStyle = 'rgba(16,18,12,0.18)';
      g.lineWidth = 0.1;
      g.beginPath();
      g.moveTo(x + adx - px2, y + ady - py2);
      g.lineTo(x + adx + px2, y + ady + py2);
      g.stroke();
      g.fillStyle = 'rgba(14,16,10,0.3)';
      g.beginPath();
      g.ellipse(x, y, 0.2, 0.16, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#463c2e';
      g.lineWidth = 0.1;
      g.beginPath();
      g.moveTo(x - px2, y - py2);
      g.lineTo(x + px2, y + py2);
      g.stroke();
      g.fillStyle = '#3f362a';
      g.beginPath();
      g.arc(x, y, 0.115, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(180,168,140,0.30)';
      g.beginPath();
      g.arc(x - 0.03, y - 0.035, 0.055, 0, Math.PI * 2);
      g.fill();
      if (d < 2) return;
      g.fillStyle = 'rgba(198,190,166,0.50)';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.arc(x + px2 * s * 0.82, y + py2 * s * 0.82, 0.05, 0, Math.PI * 2);
        g.fill();
      }
      return;
    }
  }
}
