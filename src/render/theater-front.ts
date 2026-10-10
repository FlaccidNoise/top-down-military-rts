// Territory wash and front line for the theater map (jtbug #782). RENDER
// ONLY: nothing here is read by src/strategic, and the war does not know it
// exists. Control lives on nodes; the ground between them belongs, for the
// eye, to whichever side holds the nearer node. The line where the two meet
// is the front.
//
// One scalar field does both jobs: at each grid vertex, distance to the
// nearest red-held node minus distance to the nearest blue-held one. Its sign
// colours the wash; its zero contour is the front line. Built once per change
// of control, never per frame.
import type { Side } from '../sim/sim';
import type { Theater, Vec } from '../strategic/theater';

const CELL_M = 150;
const WASH: Record<Side, [number, number, number]> = { blue: [72, 118, 205], red: [205, 74, 62] };

export interface FrontLayer {
  // The wash, one pixel per grid cell. Null headless.
  wash: HTMLCanvasElement | null;
  // The front, as polylines in theater metres.
  lines: Vec[][];
}

export const controlKey = (control: readonly (Side | null)[]): string => control.map((c) => (c === 'blue' ? 'b' : c === 'red' ? 'r' : '-')).join('');

// Positive where blue is nearer. Infinity signs are fine: a side with no
// node gives a field of one sign and no contour.
function field(t: Theater, control: readonly (Side | null)[], gw: number, gh: number): Float32Array {
  const held = (side: Side): Vec[] => t.nodes.filter((n) => control[n.id] === side).map((n) => n.pos);
  const blue = held('blue');
  const red = held('red');
  const near = (pts: Vec[], x: number, y: number): number => {
    let best = 1e9;
    for (const p of pts) best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    return best;
  };
  const f = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) f[j * gw + i] = near(red, i * CELL_M, j * CELL_M) - near(blue, i * CELL_M, j * CELL_M);
  }
  return f;
}

// Marching squares over the zero contour, linear interpolation on each edge,
// then the loose segments are chained into polylines.
function contour(f: Float32Array, gw: number, gh: number): Vec[][] {
  const segs: [Vec, Vec][] = [];
  const cross = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): Vec => {
    const k = v0 / (v0 - v1);
    return { x: (x0 + (x1 - x0) * k) * CELL_M, y: (y0 + (y1 - y0) * k) * CELL_M };
  };
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = f[j * gw + i], b = f[j * gw + i + 1], c = f[(j + 1) * gw + i + 1], d = f[(j + 1) * gw + i];
      const pts: Vec[] = [];
      if (a > 0 !== b > 0) pts.push(cross(i, j, a, i + 1, j, b));
      if (b > 0 !== c > 0) pts.push(cross(i + 1, j, b, i + 1, j + 1, c));
      if (c > 0 !== d > 0) pts.push(cross(i + 1, j + 1, c, i, j + 1, d));
      if (d > 0 !== a > 0) pts.push(cross(i, j + 1, d, i, j, a));
      if (pts.length === 2) segs.push([pts[0], pts[1]]);
      else if (pts.length === 4) segs.push([pts[0], pts[1]], [pts[2], pts[3]]); // a saddle: either pairing is honest
    }
  }
  const key = (p: Vec): string => `${Math.round(p.x)},${Math.round(p.y)}`;
  const at = new Map<string, number[]>();
  segs.forEach((s, n) => {
    for (const p of s) at.set(key(p), [...(at.get(key(p)) ?? []), n]);
  });
  const used = new Set<number>();
  const walk = (start: number, from: Vec): Vec[] => {
    const out: Vec[] = [];
    let n = start;
    let tail = from;
    for (;;) {
      used.add(n);
      const [p, q] = segs[n];
      tail = key(p) === key(tail) ? q : p;
      out.push(tail);
      const next = (at.get(key(tail)) ?? []).find((m) => !used.has(m));
      if (next === undefined) return out;
      n = next;
    }
  };
  const lines: Vec[][] = [];
  segs.forEach((s, n) => {
    if (used.has(n)) return;
    const fwd = walk(n, s[0]);
    const back = walk(n, s[1]).slice(1); // re-walks n from its other end: drop the repeated point
    lines.push([...back.reverse(), s[0], ...fwd]);
  });
  return lines.filter((l) => l.length >= 4).map(chaikin);
}

function chaikin(pts: Vec[]): Vec[] {
  const out: Vec[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function buildFrontLayer(t: Theater, control: readonly (Side | null)[]): FrontLayer {
  const gw = Math.ceil(t.boundsM.w / CELL_M) + 1;
  const gh = Math.ceil(t.boundsM.h / CELL_M) + 1;
  const f = field(t, control, gw, gh);
  const lines = contour(f, gw, gh);
  if (typeof document === 'undefined') return { wash: null, lines };

  const raw = document.createElement('canvas');
  raw.width = gw;
  raw.height = gh;
  const rg = raw.getContext('2d')!;
  const img = rg.createImageData(gw, gh);
  const any = (side: Side): boolean => control.some((c) => c === side);
  for (let n = 0; n < gw * gh; n++) {
    const side: Side | null = f[n] > 0 ? (any('blue') ? 'blue' : null) : f[n] < 0 ? (any('red') ? 'red' : null) : null;
    if (!side) continue;
    img.data.set([...WASH[side], 255], n * 4);
  }
  rg.putImageData(img, 0, 0);
  return { wash: raw, lines };
}

// The wash canvas covers grid vertices 0..gw-1, each pixel centred on its
// vertex: this is the theater-metre rectangle it must be drawn into.
export function washRectM(t: Theater): { x: number; y: number; w: number; h: number } {
  const gw = Math.ceil(t.boundsM.w / CELL_M) + 1;
  const gh = Math.ceil(t.boundsM.h / CELL_M) + 1;
  return { x: -CELL_M / 2, y: -CELL_M / 2, w: gw * CELL_M, h: gh * CELL_M };
}
