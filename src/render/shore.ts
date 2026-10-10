import { soft } from './noise';

// A bank is a line; the sim stores water as tiles. Drawn tile by tile, a river
// that wanders is a staircase down both sides. This is the hedgerow treatment
// for an AREA: the outline of the water is walked as closed loops of tile
// corners, and the corners are relaxed toward their neighbours along the
// loop, which lays a staircase down into the diagonal it stood for. No canvas
// in here — terrain.ts draws the loops, this decides where they run.
//
// THE PICTURE MUST NOT LIE ABOUT WHERE A MAN CAN STAND. Water is impassable
// tile by tile, so no corner moves further than SHORE_TETHER from where the
// tiles put it. And a corner does not move at all where anything made stands
// beside it — a road, a bridge end, a floor, a rail, the map edge — so a deck
// still meets its bank square and water never laps over a kerb.

export const SHORE_TETHER = 0.4;
const SMOOTH_PASSES = 4;
// The slow wander a real bank has, so a river that runs straight down the
// tiles is not ruled. Metres either side, over ~9 tiles.
const MEANDER = 0.14;
const MEANDER_CELL = 9;

export interface Shore {
  // One entry per closed loop of the outline, water on the right hand walking
  // it. `xy` is the relaxed corners (x0, y0, x1, y1, ...). `free[i]` is 1
  // where corner i was allowed to move. `soft[i]` is 1 where the edge from
  // corner i to corner i+1 has open ground on its land side: a bank, not a
  // wall or a deck end.
  loops: { xy: Float32Array; free: Uint8Array; soft: Uint8Array }[];
  maxOffset: number; // the furthest any corner sits from its tile corner, metres
}

// `isWater`: the tile is under water (a bridge deck counts: the river runs on
// beneath it). `isSoft`: open ground a bank can be drawn on.
export function buildShore(isWater: (x: number, y: number) => boolean, isSoft: (x: number, y: number) => boolean, w: number, h: number): Shore {
  const wet = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && isWater(x, y);
  const open = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && isSoft(x, y);
  // Directed boundary edges, clockwise round each water tile (y runs down), so
  // the water is always on the right hand. Keyed by the corner they start at;
  // a corner where two water tiles touch only diagonally starts two.
  const W1 = w + 1;
  const out = new Map<number, { to: number; tile: number; soft: boolean }[]>();
  const edge = (ax: number, ay: number, bx: number, by: number, tile: number, lx: number, ly: number): void => {
    const k = ay * W1 + ax;
    const e = { to: by * W1 + bx, tile, soft: open(lx, ly) };
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!wet(x, y)) continue;
      const t = y * w + x;
      if (!wet(x, y - 1)) edge(x, y, x + 1, y, t, x, y - 1);
      if (!wet(x + 1, y)) edge(x + 1, y, x + 1, y + 1, t, x + 1, y);
      if (!wet(x, y + 1)) edge(x + 1, y + 1, x, y + 1, t, x, y + 1);
      if (!wet(x - 1, y)) edge(x, y + 1, x, y, t, x - 1, y);
    }
  }
  const loops: Shore['loops'] = [];
  let maxOffset = 0;
  for (const [start, first] of out) {
    while (first.length > 0) {
      // walk one loop
      const cs: number[] = [];
      const sf: number[] = [];
      let at = start;
      let e = first.pop()!;
      for (;;) {
        cs.push(at);
        sf.push(e.soft ? 1 : 0);
        at = e.to;
        if (at === start) break;
        const next = out.get(at)!;
        // at a corner two tiles share, stay with the tile being walked round:
        // the two bodies of water touch there, they do not join
        const j = next.length > 1 ? Math.max(0, next.findIndex((n) => n.tile === e.tile)) : 0;
        e = next.splice(j, 1)[0];
      }
      const n = cs.length;
      const cx = cs.map((c) => c % W1);
      const cy = cs.map((c) => (c / W1) | 0);
      const xy = new Float32Array(n * 2);
      const free = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        xy[i * 2] = cx[i];
        xy[i * 2 + 1] = cy[i];
        // free only where everything round the corner is water or open ground
        let ok = true;
        for (let dy = -1; dy <= 0 && ok; dy++) for (let dx = -1; dx <= 0 && ok; dx++) ok = wet(cx[i] + dx, cy[i] + dy) || open(cx[i] + dx, cy[i] + dy);
        free[i] = ok ? 1 : 0;
      }
      const tether = (i: number, x: number, y: number): void => {
        const d = Math.hypot(x - cx[i], y - cy[i]);
        const k = d > SHORE_TETHER ? SHORE_TETHER / d : 1;
        xy[i * 2] = cx[i] + (x - cx[i]) * k;
        xy[i * 2 + 1] = cy[i] + (y - cy[i]) * k;
      };
      const q = new Float32Array(n * 2);
      for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
        for (let i = 0; i < n; i++) {
          const a = ((i + n - 1) % n) * 2;
          const b = ((i + 1) % n) * 2;
          q[i * 2] = (2 * xy[i * 2] + xy[a] + xy[b]) / 4;
          q[i * 2 + 1] = (2 * xy[i * 2 + 1] + xy[a + 1] + xy[b + 1]) / 4;
        }
        for (let i = 0; i < n; i++) if (free[i]) tether(i, q[i * 2], q[i * 2 + 1]);
      }
      for (let i = 0; i < n; i++) {
        if (!free[i]) continue;
        tether(i, xy[i * 2] + (soft(cx[i], cy[i], MEANDER_CELL, 640) - 0.5) * 2 * MEANDER, xy[i * 2 + 1] + (soft(cx[i], cy[i], MEANDER_CELL, 641) - 0.5) * 2 * MEANDER);
        maxOffset = Math.max(maxOffset, Math.hypot(xy[i * 2] - cx[i], xy[i * 2 + 1] - cy[i]));
      }
      loops.push({ xy, free, soft: Uint8Array.from(sf) });
    }
  }
  return { loops, maxOffset };
}

// The drawn outline of one loop, as the pieces a canvas path is made of. Each
// corner gives one piece from the middle of the edge before it to the middle
// of the edge after: a curve round a corner that moved, two straight halves
// through one that did not. `piece` is called in order round the loop:
// terrain.ts builds a Path2D from it, shorePolygons builds points.
export function shorePieces(
  loop: Shore['loops'][0],
  piece: (i: number, mx0: number, my0: number, vx: number, vy: number, mx1: number, my1: number, curved: boolean) => void,
): void {
  const { xy, free } = loop;
  const n = free.length;
  for (let i = 0; i < n; i++) {
    const a = ((i + n - 1) % n) * 2;
    const b = ((i + 1) % n) * 2;
    const vx = xy[i * 2];
    const vy = xy[i * 2 + 1];
    piece(i, (xy[a] + vx) / 2, (xy[a + 1] + vy) / 2, vx, vy, (vx + xy[b]) / 2, (vy + xy[b + 1]) / 2, free[i] === 1);
  }
}

// The drawn outline as a closed polygon per loop, each curve cut into
// `steps` chords. For hit tests and for measuring, not for drawing.
export function shorePolygons(shore: Shore, steps = 4): Float32Array[] {
  return shore.loops.map((loop) => {
    const pts: number[] = [];
    shorePieces(loop, (_i, x0, y0, vx, vy, x1, y1, curved) => {
      if (!curved) {
        pts.push(x0, y0, vx, vy);
        return;
      }
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        pts.push(u * u * x0 + 2 * u * t * vx + t * t * x1, u * u * y0 + 2 * u * t * vy + t * t * y1);
      }
    });
    return Float32Array.from(pts);
  });
}

// Is a point inside the drawn water? Even-odd over every loop, so an island
// in a pond is land. `polys` is shorePolygons(shore).
export function inShore(polys: Float32Array[], x: number, y: number): boolean {
  let inside = false;
  for (const p of polys) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if (p[i + 1] > y !== p[j + 1] > y && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
    }
  }
  return inside;
}
