import { hash, soft } from './noise';

// The three places the 1 m tile grid used to show through the ground, and the
// pure arithmetic that takes it out again. No canvas in here: terrain.ts does
// the drawing, this decides what to draw, so it can be pinned by a test.
//
// 1. RELIEF. Elevation is stored in whole metres (map.elev is a Uint8Array),
//    so a hill is a stack of terraces: flat for a dozen tiles, then one step.
//    A hillshade taken straight off that field is zero almost everywhere and
//    a hard light or dark tile wherever a terrace ends — the pale squares and
//    stair-stepped ribbons across every field. The slope the eye should see is
//    the hill's, not the terraces'. So the field is smoothed first, wide enough
//    to turn the steps back into a gradient, and shaded from that.
//
// 2. BOUNDARIES. Where two kinds of soft ground meet on a diagonal the tile map
//    gives a staircase. Marching squares over the tile centres gives the line
//    the staircase was approximating: at every tile corner where one tile
//    stands alone against the two beside it, that tile's corner is cut off and
//    given to its neighbours.
//
// 3. GRASS. One tuft stamp to the tile, every tile as full as the next, is a
//    1 m lattice of clumps however the clumps are drawn. The tiles now only
//    say how many tufts they throw, and that number follows a slow field.

// Half-width of the box the elevation is blurred with, twice over. Two passes
// of a box are a triangle roughly 4R wide: 24 tiles, which spans the terraces
// of the gentlest hill the generator makes.
export const RELIEF_BLUR = 6;
// Shade per unit of slope against the light. The terrace steps were steep and
// narrow; the smoothed slope is shallow and everywhere, so the gain is higher
// and the alpha it produces is about what the old ribbons peaked at.
export const RELIEF_GAIN = 2.2;
export const RELIEF_MAX = 0.3;

function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean): void {
  const n = horiz ? w : h;
  const lines = horiz ? h : w;
  const step = horiz ? 1 : w;
  const span = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w : l;
    // edges replicate: a hill does not fall away because the map stops
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[base + Math.min(n - 1, Math.max(0, k)) * step];
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = sum / span;
      sum += src[base + Math.min(n - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step];
    }
  }
}

// The elevation field with its terraces smoothed back into slopes.
export function smoothElev(elev: ArrayLike<number>, w: number, h: number, r = RELIEF_BLUR): Float32Array {
  const a = Float32Array.from(elev);
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    boxBlur(a, b, w, h, r, true);
    boxBlur(b, a, w, h, r, false);
  }
  return a;
}

export interface ReliefLight {
  x: number; // unit vector toward the light
  y: number;
  z: number;
  flat: number; // n·L for level ground
}

// Signed shade for the tile at (x, y): above 0 the slope faces the light, below
// it faces away. Coordinates past the map edge clamp, because a chunk bakes a
// gutter of tiles that are not there.
export function reliefShade(sm: Float32Array, w: number, h: number, x: number, y: number, L: ReliefLight): number {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const dzdx = (sm[cy * w + Math.min(w - 1, cx + 1)] - sm[cy * w + Math.max(0, cx - 1)]) / 2;
  const dzdy = (sm[Math.min(h - 1, cy + 1) * w + cx] - sm[Math.max(0, cy - 1) * w + cx]) / 2;
  const dot = (-dzdx * L.x - dzdy * L.y + L.z) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
  return Math.max(-RELIEF_MAX, Math.min(RELIEF_MAX, (dot - L.flat) * RELIEF_GAIN));
}

// Ground classes for the boundary pass. 0 is HARD: anything with an edge that
// has to stay ruled (a floor, water and its banks, the railway) is never cut
// and never cuts a neighbour.
export const HARD = 0;

// Which of the four tiles round a tile corner lose that corner. Bit 0 is the
// NW tile, 1 NE, 2 SW, 3 SE. A tile is cut when the two tiles beside it agree
// with each other and not with it. Two cases cut nothing: a straight boundary
// (no tile stands alone), and a saddle, where the diagonals pair off and
// either reading of it is as good as the other.
export function cornerCuts(nw: number, ne: number, sw: number, se: number): number {
  if (nw === se && ne === sw) return 0;
  let m = 0;
  if (nw !== HARD && ne !== HARD && ne === sw && nw !== ne) m |= 1;
  if (ne !== HARD && nw !== HARD && nw === se && ne !== nw) m |= 2;
  if (sw !== HARD && nw !== HARD && nw === se && sw !== nw) m |= 4;
  if (se !== HARD && ne !== HARD && ne === sw && se !== ne) m |= 8;
  return m;
}

// Where a cut crosses a tile edge: a point somewhere about the middle of it,
// fixed per EDGE, so the cuts at both ends of one edge meet at the same point
// and a staircase becomes one unbroken line with a little wander in it. The
// horizontal edge is the one along y between tiles (x, y-1) and (x, y); the
// vertical edge is the one along x between (x-1, y) and (x, y).
export function cutOnH(x: number, y: number): number {
  return x + 0.32 + hash(x, y, 811) * 0.36;
}
export function cutOnV(x: number, y: number): number {
  return y + 0.32 + hash(x, y, 812) * 0.36;
}

// How many tufts a grass tile throws, 0 to 4. The square of a slow field
// TUFT_PATCH metres across, so thin ground is properly thin and a meadow has
// thick and bare patches, dithered per tile so a contour of the field is not
// a contour of the count.
export const TUFT_PATCH = 11;
export function tuftCount(x: number, y: number): number {
  const f = soft(x, y, TUFT_PATCH, 620);
  return Math.min(4, Math.floor(0.4 + f * f * 6 + hash(x, y, 621)));
}
