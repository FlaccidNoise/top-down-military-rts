import type { GameMap } from './map';

// Scratch buffers shared across calls (sim is single-threaded, astar never
// re-enters): a company-wide move order issues ~140 astar calls in one tick,
// and per-call allocation of three w*h arrays (~1 MB each at 320x240) was
// pure GC churn.
let g = new Float64Array(0);
let from = new Int32Array(0);
let closed = new Uint8Array(0);
const heap: number[] = []; // binary heap of [f, node]

// A* on the tile grid, 8-directional, edge-aware (doors pass, walls/windows
// don't), no corner cutting. Returns tile coords start→goal inclusive, or null.
export function astar(
  map: GameMap,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  mode: 'foot' | 'vehicle' = 'foot',
): { x: number; y: number }[] | null {
  const { w, h } = map;
  if (!map.inBounds(gx, gy) || !map.terrainAt(gx, gy).passable) return null;
  const n = w * h;
  if (g.length < n) {
    g = new Float64Array(n);
    from = new Int32Array(n);
    closed = new Uint8Array(n);
  }
  g.fill(Infinity, 0, n);
  from.fill(-1, 0, n);
  closed.fill(0, 0, n);
  heap.length = 0;
  const start = sy * w + sx;
  const goal = gy * w + gx;
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

  while (heap.length > 0) {
    const cur = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur / w) | 0;
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
        const ni = ny * w + nx;
        if (closed[ni]) continue;
        const stepCost = (dx !== 0 && dy !== 0 ? 1.414 : 1) * map.terrainAt(nx, ny).moveCost;
        const ng = g[cur] + stepCost;
        if (ng < g[ni]) {
          g[ni] = ng;
          from[ni] = cur;
          push(ng + hCost(nx, ny), ni);
        }
      }
    }
  }

  if (from[goal] === -1 && goal !== start) return null;
  const out: { x: number; y: number }[] = [];
  for (let node = goal; node !== -1; node = from[node]) {
    out.push({ x: node % w, y: (node / w) | 0 });
    if (node === start) break;
  }
  return out.reverse();
}
