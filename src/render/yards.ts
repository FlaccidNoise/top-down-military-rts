import { EDGE, type GameMap } from '../sim/map';
import { AO_ALPHA, SHADOW_ALPHA, SHADOW_SOFT_ALPHA, WIND, shadowOffset } from './light';
import { hash } from './noise';
import type { BuildingBox, PatchIndex } from './patches';
import type { Detail } from './terrain';

// Yards (B7). A building with nothing around it is a box on a lawn; a
// building with a wall, a gate on the path out of its own door, a gravel
// apron and a cabbage patch is a house. Everything here is world-space and
// deterministic, so it goes in the terrain chunk bake and costs nothing at
// frame time — and because both neighbouring chunks paint identical pixels in
// their shared gutter, features that cross a chunk seam stay seamless.
//
// The runs are derived ONCE per map (`buildYards`), not per chunk: a wall's
// block/tone indices have to be stable no matter which chunk is painting it.
// Chunks cull by bounds and let the canvas clip the rest.

type Ctx = CanvasRenderingContext2D;
type Seg = [number, number, number, number];

// 0 = N, 1 = S, 2 = W, 3 = E — the side of the building the door is on, and
// therefore the side the yard is on. `side ^ 1` is the opposite side.
type Side = 0 | 1 | 2 | 3;

const YARD_REACH = 6; // metres of influence past a footprint — chunks cull on this
const GATE_HALF = 0.65; // the 1.3 m gate gap, centred on the door
const WALL_W = 0.32;
const STEP = 0.2; // legality sampling pitch along a run

export interface Yard {
  b: BuildingBox;
  doorSide: Side;
  door: number; // world coord of the door centre along the door wall's axis
  side: Side; // side the boundary encloses — the door side when it fits, else the back
  depth: number;
  wall: boolean; // wall vs picket fence
  runs: Seg[];
  gate: [number, number][]; // gate post centres
  leaf: Seg | null; // open gate leaf, or null
  paired: boolean; // shares a farm yard with a neighbouring footprint
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Door side + the door's centre along that wall. Same perimeter scan roofs.ts
// uses for its wall faces, so the yard's gate and the roof's door agree.
function doorOf(map: GameMap, b: BuildingBox): [Side, number] | null {
  for (let x = b.minX; x < b.maxX; x++) {
    if (map.hEdge(x, b.minY) === EDGE.DOOR) return [0, x + 0.5];
    if (map.hEdge(x, b.maxY) === EDGE.DOOR) return [1, x + 0.5];
  }
  for (let y = b.minY; y < b.maxY; y++) {
    if (map.vEdge(b.minX, y) === EDGE.DOOR) return [2, y + 0.5];
    if (map.vEdge(b.maxX, y) === EDGE.DOOR) return [3, y + 0.5];
  }
  return null;
}

// (u, t) → world, where u runs along the wall the door is in and t runs
// outward from that wall face. Every yard feature is authored in (u, t) so the
// same code serves all four sides without a rotate at draw time.
function px(b: BuildingBox, side: Side, u: number, t: number): number {
  return side === 0 || side === 1 ? u : side === 2 ? b.minX - t : b.maxX + t;
}
function py(b: BuildingBox, side: Side, u: number, t: number): number {
  return side === 0 ? b.minY - t : side === 1 ? b.maxY + t : u;
}

// Ground a yard feature may paint on. Roads, water, interiors and floors are
// out — a wall across the arterial would imply a block the sim's canStep does
// not have, and the village square owns its own cobbles.
function paintable(map: GameMap, patches: PatchIndex, wx: number, wy: number): boolean {
  const tx = Math.floor(wx);
  const ty = Math.floor(wy);
  if (!map.inBounds(tx, ty)) return false;
  if (map.buildingIdAt(tx, ty) >= 0) return false;
  const k = map.terrainKeyAt(tx, ty);
  if (k !== 'grass' && k !== 'field') return false;
  return patches.pavedAt(tx, ty) <= 0.3;
}

// Walk a leg in STEP samples and keep the stretches whose ground is legal and
// which are not inside the gate gap. Splitting rather than skipping is what
// lets a wall stop cleanly at a road instead of jumping it.
function legalise(map: GameMap, patches: PatchIndex, b: BuildingBox, side: Side, u0: number, t0: number, u1: number, t1: number, gateAt: number | null, out: Seg[]): void {
  const n = Math.max(1, Math.round(Math.hypot(u1 - u0, t1 - t0) / STEP));
  const uAt = (f: number) => u0 + (u1 - u0) * f;
  const tAt = (f: number) => t0 + (t1 - t0) * f;
  const wx = (f: number) => px(b, side, uAt(f), tAt(f));
  const wy = (f: number) => py(b, side, uAt(f), tAt(f));
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const mid = (i + 0.5) / n;
    let ok = i < n && paintable(map, patches, wx(mid), wy(mid));
    if (ok && gateAt !== null && Math.abs(uAt(mid) - gateAt) < GATE_HALF) ok = false;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      out.push([wx(start / n), wy(start / n), wx(i / n), wy(i / n)]);
      start = -1;
    }
  }
}

// `enclosed` vetoes ground that a generator-authored enclosure already walls
// (src/render/enclos.ts). Without it a bourg garden gets two boundaries — the
// map's own 1 m wall and this module's guessed one — crossing each other in
// the same tail, and a farm cour gets pale wall stubs standing in the middle
// of its beaten earth. Legacy kinds have no enclosures, so the predicate never
// fires there and their yards are unchanged.
export function buildYards(map: GameMap, patches: PatchIndex, enclosed: (wx: number, wy: number) => boolean = () => false): Yard[] {
  const out: Yard[] = [];
  for (const b of patches.buildings) {
    const dr = doorOf(map, b);
    if (!dr) continue;
    const [doorSide, door] = dr;
    const wall = hash(b.id, 0, 300) < 0.5;
    const uOf = (s: Side, lo: boolean) => (s === 0 || s === 1 ? (lo ? b.minX : b.maxX) : lo ? b.minY : b.maxY);

    // How far out this side can carry a boundary. Two limits: a footprint
    // standing opposite (that pair shares an open working court, so no wall
    // belongs between them), and the free ground itself — a village house
    // stands a couple of metres off the street and gets a shallow front
    // garden, where the full 3-5 m run would land in the arterial and
    // legalise would delete the whole front, leaving two orphan stubs.
    const fit = (s: Side): number => {
      const u0 = uOf(s, true) - 0.6;
      const u1 = uOf(s, false) + 0.6;
      for (const o of patches.buildings) {
        if (o.id === b.id) continue;
        const along = s === 0 || s === 1;
        if ((along ? o.maxX : o.maxY) <= u0 || (along ? o.minX : o.minY) >= u1) continue;
        const t = s === 0 ? b.minY - o.maxY : s === 1 ? o.minY - b.maxY : s === 2 ? b.minX - o.maxX : o.minX - b.maxX;
        if (t >= 0 && t < 6) return 0;
      }
      for (let t = 3 + hash(b.id, 0, 301) * 2; t >= 1.6; t -= 0.25) {
        let ok = 0;
        for (let i = 0; i < 9; i++) {
          const u = u0 + ((i + 0.5) / 9) * (u1 - u0);
          const wx = px(b, s, u, t);
          const wy = py(b, s, u, t);
          if (paintable(map, patches, wx, wy) && !enclosed(wx, wy)) ok++;
        }
        if (ok >= 7) return t;
      }
      return 0;
    };
    // Door side first — that is where the gate has to be. Failing that, the
    // back garden: a village terrace fronts straight onto the street and keeps
    // its walled ground behind, which is the case that fills the bare lawns.
    const back = (doorSide ^ 1) as Side;
    let side = doorSide;
    let depth = fit(doorSide);
    if (depth === 0) {
      side = back;
      depth = fit(back);
    }
    const along = side === 0 || side === 1;
    const u0 = uOf(side, true) - 0.6;
    const u1 = uOf(side, false) + 0.6;
    // gate on the door column when the boundary is the door's own; otherwise
    // a garden gate at the middle of the back wall
    const gateU = side === doorSide ? door : (u0 + u1) / 2;
    const runs: Seg[] = [];
    if (depth > 0) {
      legalise(map, patches, b, side, u0, 0.1, u0, depth, null, runs);
      legalise(map, patches, b, side, u0, depth, u1, depth, gateU, runs);
      legalise(map, patches, b, side, u1, depth, u1, 0.1, null, runs);
    }
    // Gate posts only where the front run actually reached the gap — a wall
    // that stopped at a road never had a gate to hang.
    const gate: [number, number][] = [];
    for (const s of runs.length ? [-1, 1] : []) {
      const gu = gateU + s * GATE_HALF;
      if (gu < u0 || gu > u1) continue;
      if (!paintable(map, patches, px(b, side, gu, depth), py(b, side, gu, depth))) continue;
      gate.push([px(b, side, gu, depth), py(b, side, gu, depth)]);
    }
    // Open leaf swung back along the shared wind, into the yard.
    let leaf: Seg | null = null;
    if (gate.length === 2 && hash(b.id, 0, 303) < 0.5) {
      const s = (along ? WIND.dx : WIND.dy) >= 0 ? 1 : -1;
      const hu = gateU + s * GATE_HALF;
      leaf = [px(b, side, hu, depth), py(b, side, hu, depth), px(b, side, hu - s * 0.42, depth - 1.1), py(b, side, hu - s * 0.42, depth - 1.1)];
    }
    // Tight reach, not the blanket YARD_REACH: the chunk loop tests every
    // footprint on the map, and in a village that decides whether eight yards
    // or three get painted into a chunk that only shows three.
    const reach = Math.min(YARD_REACH, Math.max(depth, 3.2) + 0.9);
    out.push({
      b, doorSide, door, side, depth, wall, runs, gate, leaf,
      paired: false,
      minX: b.minX - reach,
      minY: b.minY - reach,
      maxX: b.maxX + reach,
      maxY: b.maxY + reach,
    });
  }
  // Farm pairs — mapgen drops a house and a barn a few metres apart and they
  // share a working yard. Same <=4 m gap test drawPaving uses for the mud.
  for (let i = 0; i < out.length; i++) {
    for (let k = i + 1; k < out.length; k++) {
      const a = out[i].b;
      const c = out[k].b;
      const gx = Math.max(0, Math.max(a.minX - c.maxX, c.minX - a.maxX));
      const gy = Math.max(0, Math.max(a.minY - c.maxY, c.minY - a.maxY));
      if (Math.hypot(gx, gy) > 4) continue;
      out[i].paired = true;
      out[k].paired = true;
    }
  }
  return out;
}

function strokeSegs(g: Ctx, segs: Seg[], w: number, style: string, odx = 0, ody = 0): void {
  if (segs.length === 0) return;
  g.lineWidth = w;
  g.strokeStyle = style;
  g.beginPath();
  for (const [ax, ay, bx, by] of segs) {
    g.moveTo(ax + odx, ay + ody);
    g.lineTo(bx + odx, by + ody);
  }
  g.stroke();
}

// Limestone garden wall, built with the layer idiom drawHedgeRun uses: AO,
// two shadow layers, mass, NW rim. Deliberately knee-high in read (0.32 m
// stroke, short shadow) because soldiers walk straight through it — a
// waist-high wall would advertise cover the sim does not have.
// Limestone kept under the muted ceiling: the lit face is ~50 luma above the
// grass, which is all the separation a wall needs — the spec's raw #9a9285 at
// full strength was the brightest thing in the frame.
const WALL_TONES = ['rgb(128,122,110)', 'rgb(112,108,98)', 'rgb(140,132,118)', 'rgb(101,100,90)'];

function drawWallRun(g: Ctx, y: Yard, d: Detail): void {
  const [sdx, sdy] = shadowOffset(0.55);
  strokeSegs(g, y.runs, WALL_W * 1.5, `rgba(8,10,7,${(AO_ALPHA * 0.6).toFixed(3)})`);
  strokeSegs(g, y.runs, WALL_W * 1.25, `rgba(10,14,8,${SHADOW_SOFT_ALPHA})`, sdx * 1.6, sdy * 1.6);
  strokeSegs(g, y.runs, WALL_W * 1.15, `rgba(10,14,8,${SHADOW_ALPHA})`, sdx, sdy);
  // Mass in 0.45 m blocks with value jitter, bucketed into four tones so the
  // whole wall is four strokes rather than one per block.
  const buckets: Seg[][] = [[], [], [], []];
  const caps: Seg[] = [];
  let blk = 0;
  for (const [ax, ay, bx, by] of y.runs) {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / 0.45));
    for (let i = 0; i < n; i++) {
      const f0 = i / n;
      const f1 = (i + 1) / n;
      buckets[(hash(y.b.id * 97 + blk, 0, 302) * 4) | 0].push([ax + (bx - ax) * f0, ay + (by - ay) * f0, ax + (bx - ax) * f1, ay + (by - ay) * f1]);
      blk++;
    }
    if (d < 1) continue;
    const m = Math.max(1, Math.round(len / 0.5));
    for (let i = 0; i < m; i++) {
      const f = (i + 0.5) / m;
      const cx = ax + (bx - ax) * f;
      const cy = ay + (by - ay) * f;
      caps.push([cx - (by - ay) / len * 0.05, cy + (bx - ax) / len * 0.05, cx + (by - ay) / len * 0.05, cy - (bx - ax) / len * 0.05]);
    }
  }
  for (let i = 0; i < 4; i++) strokeSegs(g, buckets[i], WALL_W, WALL_TONES[i]);
  strokeSegs(g, y.runs, WALL_W * 0.3, 'rgba(214,206,186,0.22)', -sdx * 0.3, -sdy * 0.3);
  // capstones read as a coping course; mortar ticks only at the closest tier
  strokeSegs(g, caps, WALL_W * 0.92, 'rgba(206,198,178,0.16)', -sdx * 0.12, -sdy * 0.12);
  if (d < 2) return;
  const ticks: Seg[] = [];
  for (const [ax, ay, bx, by] of y.runs) {
    const len = Math.hypot(bx - ax, by - ay);
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    const n = Math.max(1, Math.round(len / 0.45));
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const cx = ax + (bx - ax) * f;
      const cy = ay + (by - ay) * f;
      ticks.push([cx + nx * WALL_W * 0.42, cy + ny * WALL_W * 0.42, cx - nx * WALL_W * 0.42, cy - ny * WALL_W * 0.42]);
    }
  }
  strokeSegs(g, ticks, 0.035, 'rgba(74,70,62,0.30)');
}

// Picket fence: two rails carried 0.20/0.34 m "above" the post feet (the
// top-down fake-height convention the telegraph poles reuse) so the run has
// some elevation instead of lying flat on the grass.
function drawFenceRun(g: Ctx, y: Yard, d: Detail): void {
  const [sdx, sdy] = shadowOffset(0.4);
  strokeSegs(g, y.runs, 0.16, `rgba(10,12,8,${(AO_ALPHA * 0.45).toFixed(3)})`, sdx * 1.1, sdy * 1.1);
  strokeSegs(g, y.runs, 0.065, 'rgba(62,52,36,0.80)', 0, -0.33);
  strokeSegs(g, y.runs, 0.065, 'rgba(116,98,68,0.85)', 0, -0.35);
  strokeSegs(g, y.runs, 0.065, 'rgba(58,48,34,0.80)', 0, -0.18);
  strokeSegs(g, y.runs, 0.065, 'rgba(104,88,60,0.85)', 0, -0.2);
  const posts: [number, number][] = [];
  for (const [ax, ay, bx, by] of y.runs) {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / 1.2));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      posts.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
    }
  }
  for (const [x, py2] of posts) {
    g.fillStyle = 'rgba(18,20,14,0.26)';
    g.fillRect(x + sdx * 0.7 - 0.06, py2 + sdy * 0.7 - 0.28, 0.12, 0.36);
    g.fillStyle = 'rgb(72,60,42)';
    g.fillRect(x - 0.06, py2 - 0.4, 0.12, 0.46);
    if (d < 1) continue;
    g.fillStyle = 'rgba(186,172,140,0.26)';
    g.fillRect(x - 0.06, py2 - 0.4, 0.045, 0.46);
  }
}

function drawGate(g: Ctx, y: Yard): void {
  const [sdx, sdy] = shadowOffset(0.6);
  for (const [gx, gy] of y.gate) {
    g.fillStyle = 'rgba(14,16,10,0.30)';
    g.fillRect(gx + sdx * 0.8 - 0.1, gy + sdy * 0.8 - 0.1, 0.24, 0.24);
    g.fillStyle = y.wall ? 'rgb(120,113,102)' : 'rgb(74,62,44)';
    g.fillRect(gx - 0.11, gy - 0.5, 0.22, 0.6);
    g.fillStyle = 'rgba(212,204,184,0.22)';
    g.fillRect(gx - 0.11, gy - 0.5, 0.07, 0.6);
    // dark cap so the pier reads as a post and not just more wall
    g.fillStyle = 'rgba(44,40,32,0.55)';
    g.fillRect(gx - 0.13, gy - 0.54, 0.26, 0.09);
  }
  if (!y.leaf) return;
  const [ax, ay, bx, by] = y.leaf;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(14,16,10,0.20)';
  g.lineWidth = 0.12;
  g.beginPath();
  g.moveTo(ax + sdx * 0.5, ay + sdy * 0.5);
  g.lineTo(bx + sdx * 0.5, by + sdy * 0.5);
  g.stroke();
  g.strokeStyle = '#5f4426';
  g.lineWidth = 0.09;
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bx, by);
  // two slats across the leaf so it reads as a gate, not a stick
  for (const f of [0.35, 0.7]) {
    const cx = ax + (bx - ax) * f;
    const cy = ay + (by - ay) * f;
    g.moveTo(cx - (by - ay) * 0.06, cy + (bx - ax) * 0.06);
    g.lineTo(cx + (by - ay) * 0.06, cy - (bx - ax) * 0.06);
  }
  g.stroke();
}

// Gravel/cobble apron worn into the ground outside the door. Drawn under the
// door trail so the trail wears over it, exactly like a real threshold.
function drawApron(g: Ctx, map: GameMap, patches: PatchIndex, y: Yard, d: Detail): void {
  const { b, door } = y;
  const side = y.doorSide;
  const cx = px(b, side, door, 0.85);
  const cy = py(b, side, door, 0.85);
  if (!paintable(map, patches, cx, cy)) return;
  const along = side === 0 || side === 1;
  g.fillStyle = 'rgba(150,140,120,0.35)';
  g.beginPath();
  g.ellipse(cx, cy, along ? 1 : 0.8, along ? 0.8 : 1, 0, 0, Math.PI * 2);
  g.fill();
  if (d < 1) return;
  const n = 14 + ((hash(b.id, 0, 304) * 7) | 0);
  for (let i = 0; i < n; i++) {
    const k = b.id * 41 + i;
    const u = door + (hash(k, 0, 305) - 0.5) * 1.9;
    const t = 0.08 + hash(k, 1, 305) * 1.5;
    const wx = px(b, side, u, t);
    const wy = py(b, side, u, t);
    if (!paintable(map, patches, wx, wy)) continue;
    const tone = hash(k, 2, 305);
    g.fillStyle = tone > 0.66 ? 'rgba(178,170,152,0.55)' : tone > 0.33 ? 'rgba(138,130,112,0.55)' : 'rgba(102,94,78,0.45)';
    const r = 0.09 + hash(k, 3, 305) * 0.04;
    g.beginPath();
    g.ellipse(wx, wy, r * 1.25, r, hash(k, 4, 305) * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
}

// Kitchen garden on the blind side of the house — dug rows, cabbages, a
// couple of bean poles. Only where the ground behind is actually grass.
function drawGarden(g: Ctx, map: GameMap, patches: PatchIndex, y: Yard, d: Detail): void {
  if (d < 1) return;
  const { b } = y;
  const side = (y.doorSide ^ 1) as Side;
  const along = side === 0 || side === 1;
  const uMid = along ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
  const span = Math.min(2.5, (along ? b.maxX - b.minX : b.maxY - b.minY) - 0.4);
  if (span < 1.2) return;
  const t0 = 0.7;
  // when the boundary also encloses this side the garden sits inside it
  const t1 = Math.min(t0 + 2.4, y.side === side ? y.depth - 0.35 : Infinity);
  if (t1 - t0 < 1.4) return;
  for (const [cu, ct] of [[uMid - span / 2, t0], [uMid + span / 2, t0], [uMid - span / 2, t1], [uMid + span / 2, t1], [uMid, (t0 + t1) / 2]] as [number, number][]) {
    if (!paintable(map, patches, px(b, side, cu, ct), py(b, side, cu, ct))) return;
    if (map.terrainKeyAt(Math.floor(px(b, side, cu, ct)), Math.floor(py(b, side, cu, ct))) !== 'grass') return;
  }
  // dug earth first, then the rows on top — rows alone on grass read as
  // scratches rather than a worked plot
  const c0x = px(b, side, uMid, (t0 + t1) / 2);
  const c0y = py(b, side, uMid, (t0 + t1) / 2);
  g.fillStyle = 'rgba(78,64,44,0.26)';
  g.beginPath();
  g.ellipse(c0x, c0y, along ? span / 2 + 0.15 : 1.35, along ? 1.35 : span / 2 + 0.15, 0, 0, Math.PI * 2);
  g.fill();
  const rows = 4 + ((hash(b.id, 0, 306) * 3) | 0);
  g.lineWidth = 0.09;
  g.strokeStyle = 'rgba(52,40,26,0.40)';
  g.beginPath();
  for (let i = 0; i < rows; i++) {
    const t = t0 + ((i + 0.5) / rows) * (t1 - t0);
    g.moveTo(px(b, side, uMid - span / 2, t), py(b, side, uMid - span / 2, t));
    g.lineTo(px(b, side, uMid + span / 2, t), py(b, side, uMid + span / 2, t));
  }
  g.stroke();
  const heads = 5 + ((hash(b.id, 1, 306) * 5) | 0);
  for (let i = 0; i < heads; i++) {
    const k = b.id * 29 + i;
    const row = (hash(k, 0, 307) * rows) | 0;
    const t = t0 + ((row + 0.5) / rows) * (t1 - t0);
    const u = uMid - span / 2 + hash(k, 1, 307) * span;
    g.fillStyle = hash(k, 2, 307) > 0.5 ? '#4c5c38' : '#3f4e2e';
    g.beginPath();
    g.arc(px(b, side, u, t), py(b, side, u, t), 0.14, 0, Math.PI * 2);
    g.fill();
  }
  if (d < 2) return;
  // bean poles: fake height, so they lean north out of the last row
  g.strokeStyle = 'rgba(126,108,74,0.55)';
  g.lineWidth = 0.04;
  g.beginPath();
  for (let i = 0; i < 2; i++) {
    const u = uMid - span / 2 + (0.3 + i * 0.4) * span;
    const bx = px(b, side, u, t1 - 0.2);
    const by = py(b, side, u, t1 - 0.2);
    g.moveTo(bx, by);
    g.lineTo(bx + 0.08, by - 0.5);
  }
  g.stroke();
}

// Ivy taking one exterior corner. Blobs sit just outside the footprint so the
// interior stays clean for room clearing.
function drawIvy(g: Ctx, map: GameMap, patches: PatchIndex, y: Yard, d: Detail): void {
  if (d < 1) return;
  const { b } = y;
  const c = (hash(b.id, 0, 308) * 4) | 0;
  const cx = c & 1 ? b.maxX : b.minX;
  const cy = c & 2 ? b.maxY : b.minY;
  const sx = c & 1 ? 1 : -1;
  const sy = c & 2 ? 1 : -1;
  const n = 3 + ((hash(b.id, 1, 308) * 3) | 0);
  for (let i = 0; i < n; i++) {
    const k = b.id * 17 + i;
    const wx = cx + sx * (0.05 + hash(k, 0, 309) * 0.3);
    const wy = cy + sy * (0.05 + hash(k, 1, 309) * 1.6);
    if (!paintable(map, patches, wx, wy)) continue;
    g.fillStyle = 'rgba(52,68,40,0.5)';
    g.beginPath();
    g.ellipse(wx, wy, 0.16 + hash(k, 2, 309) * 0.12, 0.22 + hash(k, 3, 309) * 0.14, hash(k, 4, 309) * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
}

// Woodpile against a farm building's SE wall — split logs seen end-on, two
// tones, with the shared SE shadow at their foot.
function drawWoodpile(g: Ctx, map: GameMap, patches: PatchIndex, y: Yard, d: Detail): void {
  if (d < 2 || !y.paired) return;
  const { b } = y;
  if (hash(b.id, 0, 310) < 0.45) return;
  const along = hash(b.id, 1, 310) < 0.5;
  const x0 = along ? b.minX + 0.4 : b.maxX + 0.12;
  const y0 = along ? b.maxY + 0.12 : b.minY + 0.4;
  const [sdx, sdy] = shadowOffset(0.5);
  const cols = 9;
  const rows = 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u = (c + (r % 2) * 0.5) * 0.16;
        const t = r * 0.15;
        const wx = x0 + (along ? u : t);
        const wy = y0 + (along ? t : u);
        if (!paintable(map, patches, wx, wy)) continue;
        if (pass === 0) {
          g.fillStyle = 'rgba(16,18,12,0.22)';
          g.beginPath();
          g.arc(wx + sdx * 0.5, wy + sdy * 0.5, 0.09, 0, Math.PI * 2);
          g.fill();
          continue;
        }
        g.fillStyle = hash(b.id * 7 + r * 13 + c, 0, 311) > 0.5 ? 'rgb(126,104,72)' : 'rgb(96,78,54)';
        g.beginPath();
        g.arc(wx, wy, 0.08, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(46,36,24,0.45)';
        g.beginPath();
        g.arc(wx, wy, 0.032, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

const hits = (y: Yard, tx0: number, ty0: number, tx1: number, ty1: number) => y.maxX >= tx0 && y.minX <= tx1 && y.maxY >= ty0 && y.minY <= ty1;

// Ground-level yard dressing: apron, kitchen garden. Runs BEFORE the door
// trails so the trail wears over the gravel.
export function drawYardGround(g: Ctx, map: GameMap, patches: PatchIndex, yards: Yard[], tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  for (const y of yards) {
    if (!hits(y, tx0, ty0, tx1, ty1)) continue;
    drawApron(g, map, patches, y, d);
    drawGarden(g, map, patches, y, d);
  }
}

// Everything with a shadow: boundary walls/fences, gates, ivy, woodpiles.
export function drawYardStructures(g: Ctx, map: GameMap, patches: PatchIndex, yards: Yard[], tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  for (const y of yards) {
    if (!hits(y, tx0, ty0, tx1, ty1)) continue;
    if (y.wall) drawWallRun(g, y, d);
    else drawFenceRun(g, y, d);
    drawGate(g, y);
    drawIvy(g, map, patches, y, d);
    drawWoodpile(g, map, patches, y, d);
  }
}
