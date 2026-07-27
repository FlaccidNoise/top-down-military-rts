import { type GameMap } from './map';

// Scrambling a rubble lip costs about as much as a flight of stairs (the
// vertical step below charges a flat +2). Effect: A* prefers a door two tiles
// away over a hole in the wall, and prefers the hole over a six-tile detour.
export const BREACH_STEP = 2.5;

// Scratch buffers shared across calls (sim is single-threaded, astar never
// re-enters).
let g = new Float64Array(0);
let from = new Int32Array(0);
let closed = new Uint8Array(0);
const heap: number[] = []; // binary heap of [f, node]

// A* on the tile grid, 8-directional within a level + vertical step on
// stair tiles. No corner cutting. Returns tile coords start→goal inclusive
// with level, or null. New optional sl,gl level params (default 0).
// Level axis allocated lazily: ground-only searches keep single-layer perf.
export function astar(
  map: GameMap,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  mode: 'foot' | 'vehicle' = 'foot',
  sl = 0,
  gl = 0,
): { x: number; y: number; l: number }[] | null {
  const { w, h } = map;
  if (!map.inBounds(gx, gy) || !map.terrainAt(gx, gy).passable) return null;
  if (mode === 'vehicle' && (sl > 0 || gl > 0)) return null;

  const needLevels = Math.max(sl, gl) + 1;
  const layerSize = w * h;
  const n = layerSize * needLevels;
  if (g.length < n) {
    g = new Float64Array(n);
    from = new Int32Array(n);
    closed = new Uint8Array(n);
  }
  g.fill(Infinity, 0, n);
  from.fill(-1, 0, n);
  closed.fill(0, 0, n);
  heap.length = 0;
  const start = sl * layerSize + sy * w + sx;
  const goal = gl * layerSize + gy * w + gx;
  const push = (f: number, node: number) => {
    heap.push(f, node);
    let i = heap.length / 2 - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= heap[i * 2]) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[p * 2 + k];
        heap[p * 2 + k] = heap[i * 2 + k];
        heap[i * 2 + k] = t;
      }
      i = p;
    }
  };
  const pop = (): number => {
    const node = heap[1];
    const li = heap.length - 2;
    heap[0] = heap[li];
    heap[1] = heap[li + 1];
    heap.length = li;
    let i = 0;
    const size = heap.length / 2;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < size && heap[l * 2] < heap[m * 2]) m = l;
      if (r < size && heap[r * 2] < heap[m * 2]) m = r;
      if (m === i) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[m * 2 + k];
        heap[m * 2 + k] = heap[i * 2 + k];
        heap[i * 2 + k] = t;
      }
      i = m;
    }
    return node;
  };

  const hCost = (x: number, y: number) => {
    const ax = Math.abs(x - gx);
    const ay = Math.abs(y - gy);
    return Math.max(ax, ay) + 0.414 * Math.min(ax, ay);
  };

  g[start] = 0;
  push(hCost(sx, sy), start);

  const hasStairs = needLevels > 1; // only check stairs when levels are in play

  while (heap.length > 0) {
    const cur = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cl = (cur / layerSize) | 0;
    const ci = cur % layerSize;
    const cx = ci % w;
    const cy = (ci / w) | 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        let ok: boolean;
        if (dx !== 0 && dy !== 0) {
          // diagonal: both L-paths must be fully steppable (no corner cutting)
          ok =
            map.canStep(cx, cy, nx, cy, mode) &&
            map.canStep(nx, cy, nx, ny, mode) &&
            map.canStep(cx, cy, cx, ny, mode) &&
            map.canStep(cx, ny, nx, ny, mode);
        } else {
          ok = map.canStep(cx, cy, nx, ny, mode);
        }
        if (!ok) continue;
        const ni = cl * layerSize + ny * w + nx;
        if (closed[ni]) continue;
        let stepCost = (dx !== 0 && dy !== 0 ? 1.414 : 1) * map.terrainAt(nx, ny).moveCost;
        // A diagonal is charged only when BOTH L-paths go through a lip —
        // otherwise there is a clean way round the rubble inside the same move
        // and A* would be paying for a scramble nobody makes.
        if (map.hasBreach) {
          const lip =
            dx !== 0 && dy !== 0
              ? (map.breachBetween(cx, cy, nx, cy) || map.breachBetween(nx, cy, nx, ny)) &&
                (map.breachBetween(cx, cy, cx, ny) || map.breachBetween(cx, ny, nx, ny))
              : map.breachBetween(cx, cy, nx, ny);
          if (lip) stepCost += BREACH_STEP;
        }
        const ng = g[cur] + stepCost;
        if (ng < g[ni]) {
          g[ni] = ng;
          from[ni] = cur;
          push(ng + hCost(nx, ny), ni);
        }
      }
    }

    // vertical step on stair tiles (only checked when level axis is active)
    if (hasStairs && map.isStair(cx, cy)) {
      if (cl + 1 < needLevels) {
        const niUp = (cl + 1) * layerSize + cy * w + cx;
        if (!closed[niUp]) {
          const ng = g[cur] + 2;
          if (ng < g[niUp]) {
            g[niUp] = ng;
            from[niUp] = cur;
            push(ng + hCost(cx, cy), niUp);
          }
        }
      }
      if (cl - 1 >= 0) {
        const niDn = (cl - 1) * layerSize + cy * w + cx;
        if (!closed[niDn]) {
          const ng = g[cur] + 2;
          if (ng < g[niDn]) {
            g[niDn] = ng;
            from[niDn] = cur;
            push(ng + hCost(cx, cy), niDn);
          }
        }
      }
    }
  }

  if (from[goal] === -1 && goal !== start) return null;
  const out: { x: number; y: number; l?: number }[] = [];
  for (let node = goal; node !== -1; node = from[node]) {
    const l = (node / layerSize) | 0;
    const ci = node % layerSize;
    if (needLevels <= 1) out.push({ x: ci % w, y: (ci / w) | 0 });
    else out.push({ x: ci % w, y: (ci / w) | 0, l });
    if (node === start) break;
  }
  return out.reverse() as { x: number; y: number; l: number }[];
}