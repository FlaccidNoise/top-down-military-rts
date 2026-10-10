import { hash, soft } from './noise';

// A hedgerow is a line; the sim stores it as tiles. Drawn tile by tile, a hedge
// that crosses the map on a diagonal is a staircase, and two tiles that touch
// only at a corner are two separate bushes with daylight between them. This
// turns the hedge tiles into what they stand for: a graph of runs with a
// smoothed centreline, and the lobes of foliage strung along it. No canvas in
// here — terrain.ts draws the lobes, this decides where they are, so the one
// rule that matters can be pinned by a test:
//
// THE PICTURE MUST NOT LIE ABOUT COVER. The sim still blocks sight and
// vehicles tile by tile, so every node stays within TETHER of its own tile
// centre, a run that ends keeps its end ON the last tile's centre, and nothing
// is drawn across a tile that is not hedge.

// Each link is owned by its north/west end, so it is stored and drawn once.
export const LINK_E = 1;
export const LINK_S = 2;
export const LINK_SE = 4;
export const LINK_SW = 8;
const FWD: [number, number, number][] = [
  [1, 0, LINK_E],
  [0, 1, LINK_S],
  [1, 1, LINK_SE],
  [-1, 1, LINK_SW],
];

// How far a node may sit from its tile centre, in tiles. A one-for-one
// staircase smooths to a line 0.354 off every centre, so anything under that
// would put the steps back.
export const TETHER = 0.4;
const SMOOTH_PASSES = 4;
// A long straight run is a ruler line however lumpy its foliage; this is the
// slow wander a planted line really has. Metres either side, over ~7 tiles.
const MEANDER = 0.12;
const MEANDER_CELL = 7;

export interface Hedgerows {
  w: number;
  h: number;
  deg: Int8Array; // links at this tile, -1 where there is no hedge
  link: Uint8Array; // forward LINK_* bits
  px: Float32Array; // smoothed node position, world metres
  py: Float32Array;
}

export function buildHedgerows(isHedge: (x: number, y: number) => boolean, w: number, h: number): Hedgerows {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && isHedge(x, y);
  const deg = new Int8Array(w * h).fill(-1);
  const link = new Uint8Array(w * h);
  const px = new Float32Array(w * h);
  const py = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      const i = y * w + x;
      deg[i] = 0;
      px[i] = x + 0.5;
      py[i] = y + 0.5;
      let m = 0;
      if (on(x + 1, y)) m |= LINK_E;
      if (on(x, y + 1)) m |= LINK_S;
      // Corner to corner counts as joined only when there is no way round
      // through a shared neighbour. It is the honest reading: the sight ray
      // walks every tile it crosses, so it cannot pass between the two, and a
      // vehicle may not cut the corner. The 0.7 m of daylight the per-tile
      // capsules left there was a gap that did not exist.
      if (on(x + 1, y + 1) && !on(x + 1, y) && !on(x, y + 1)) m |= LINK_SE;
      if (on(x - 1, y + 1) && !on(x - 1, y) && !on(x, y + 1)) m |= LINK_SW;
      link[i] = m;
    }
  }
  const nbrs = new Map<number, number[]>();
  const join = (i: number, j: number): void => {
    const n = nbrs.get(i);
    if (n) n.push(j);
    else nbrs.set(i, [j]);
  };
  for (let i = 0; i < link.length; i++) {
    for (const [dx, dy, bit] of FWD) {
      if (!(link[i] & bit)) continue;
      join(i, i + dy * w + dx);
      join(i + dy * w + dx, i);
    }
  }
  for (const [i, n] of nbrs) deg[i] = n.length;
  // A run's end stays put (deg 1): that is where the gap starts. Everything
  // else relaxes toward its neighbours, which is what rounds a corner and
  // lays a staircase down into the diagonal it was approximating.
  const free = [...nbrs].filter(([, n]) => n.length >= 2);
  const tether = (i: number, x: number, y: number): void => {
    const cx = (i % w) + 0.5;
    const cy = ((i / w) | 0) + 0.5;
    const d = Math.hypot(x - cx, y - cy);
    const k = d > TETHER ? TETHER / d : 1;
    px[i] = cx + (x - cx) * k;
    py[i] = cy + (y - cy) * k;
  };
  const q = new Float32Array(free.length * 2);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    free.forEach(([i, n], f) => {
      let sx = 2 * px[i];
      let sy = 2 * py[i];
      for (const j of n) {
        sx += px[j];
        sy += py[j];
      }
      q[f * 2] = sx / (2 + n.length);
      q[f * 2 + 1] = sy / (2 + n.length);
    });
    free.forEach(([i], f) => tether(i, q[f * 2], q[f * 2 + 1]));
  }
  for (const [i] of free) {
    const x = i % w;
    const y = (i / w) | 0;
    tether(i, px[i] + (soft(x, y, MEANDER_CELL, 601) - 0.5) * 2 * MEANDER, py[i] + (soft(x, y, MEANDER_CELL, 602) - 0.5) * 2 * MEANDER);
  }
  return { w, h, deg, link, px, py };
}

// Foliage lobes, as [x, y, r] triples, for the nodes in [x0, x1) x [y0, y1).
// Two kinds. The SPINE is one lobe on every node and a string along every
// link, at most SPINE_STEP apart before the roll along the run: it is what
// makes the run continuous, so its radius never drops below half the widest
// spacing the roll can open. Its girth follows a slow field so a run swells
// and thins along its length. The SPRAYS are `sprays` smaller lobes per link
// thrown out to one flank or the other: they are what breaks the silhouette,
// and a row of spine lobes without them is a string of beads. A spray's far
// edge stays within 0.52 m of the centreline, no further out than the fattest
// spine lobe, and it never reaches past the end of its link.
const SPINE_STEP = 0.34;
export function hedgeLobes(hr: Hedgerows, x0: number, y0: number, x1: number, y1: number, sprays: number): number[] {
  const out: number[] = [];
  const girth = (x: number, y: number, roll: number): number => (0.31 + soft(x, y, 5, 603) * 0.11) * (0.85 + roll * 0.35);
  for (let y = Math.max(0, y0); y < Math.min(hr.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(hr.w, x1); x++) {
      const i = y * hr.w + x;
      if (hr.deg[i] < 0) continue;
      const ax = hr.px[i];
      const ay = hr.py[i];
      out.push(ax, ay, girth(ax, ay, hash(i, 0, 604)));
      for (const [dx, dy, bit] of FWD) {
        if (!(hr.link[i] & bit)) continue;
        const j = i + dy * hr.w + dx;
        const bx = hr.px[j] - ax;
        const by = hr.py[j] - ay;
        const len = Math.hypot(bx, by);
        const nx = -by / len;
        const ny = bx / len;
        const n = Math.ceil(len / SPINE_STEP);
        for (let k = 1; k < n; k++) {
          const t = (k + (hash(i, bit * 16 + k, 606) - 0.5) * 0.3) / n;
          const side = (hash(i, bit * 16 + k, 605) - 0.5) * 0.14;
          const lx = ax + bx * t + nx * side;
          const ly = ay + by * t + ny * side;
          out.push(lx, ly, girth(lx, ly, hash(i, bit * 16 + k, 604)));
        }
        for (let k = 0; k < sprays; k++) {
          const t = hash(i, bit * 16 + k, 607);
          const side = (hash(i, bit * 16 + k, 608) > 0.5 ? 1 : -1) * (0.18 + hash(i, bit * 16 + k, 609) * 0.1);
          out.push(ax + bx * t + nx * side, ay + by * t + ny * side, 0.14 + hash(i, bit * 16 + k, 610) * 0.1);
        }
      }
    }
  }
  return out;
}
