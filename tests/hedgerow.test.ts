import { describe, expect, it } from 'vitest';
import { buildHedgerows, hedgeLobes, LINK_E, LINK_S, LINK_SE, LINK_SW, TETHER, type Hedgerows } from '../src/render/hedgerow';
import { generateMap } from '../src/sim/mapgen';

// The hedgerow graph (src/render/hedgerow.ts). The sim blocks sight and
// vehicles tile by tile and the picture is a smoothed line through those
// tiles, so what is pinned here is that the line never lies about them.

const W = 24;
const H = 16;
const grid = (rows: string[]): ((x: number, y: number) => boolean) => (x, y) => rows[y]?.[x] === '#';
const build = (rows: string[]): Hedgerows => buildHedgerows(grid(rows), W, H);
const at = (x: number, y: number): number => y * W + x;
const offset = (hr: Hedgerows, i: number): number => Math.hypot(hr.px[i] - ((i % hr.w) + 0.5), hr.py[i] - (((i / hr.w) | 0) + 0.5));

// No daylight along a link: every point of the segment between two joined
// nodes is under some lobe.
function holes(hr: Hedgerows, lobes: number[]): number {
  let n = 0;
  const fwd: [number, number, number][] = [[1, 0, LINK_E], [0, 1, LINK_S], [1, 1, LINK_SE], [-1, 1, LINK_SW]];
  for (let i = 0; i < hr.link.length; i++) {
    for (const [dx, dy, bit] of fwd) {
      if (!(hr.link[i] & bit)) continue;
      const j = i + dy * hr.w + dx;
      for (let s = 0; s <= 20; s++) {
        const x = hr.px[i] + ((hr.px[j] - hr.px[i]) * s) / 20;
        const y = hr.py[i] + ((hr.py[j] - hr.py[i]) * s) / 20;
        let covered = false;
        for (let k = 0; k < lobes.length && !covered; k += 3) covered = Math.hypot(lobes[k] - x, lobes[k + 1] - y) <= lobes[k + 2];
        if (!covered) n++;
      }
    }
  }
  return n;
}

describe('buildHedgerows', () => {
  it('lays a one-for-one staircase down into a diagonal, inside the tether', () => {
    const rows = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (y >= 2 && y < 12 && (x === y || x === y + 1) ? '#' : '.')).join(''));
    const hr = build(rows);
    let worst = 0;
    let off = 0;
    for (let y = 4; y < 10; y++) {
      for (const x of [y, y + 1]) {
        const i = at(x, y);
        // the diagonal the staircase stands for runs through x - y = 0.5
        off = Math.max(off, Math.abs(hr.px[i] - hr.py[i] - 0.5) / Math.SQRT2);
        worst = Math.max(worst, offset(hr, i));
      }
    }
    // tile centres sit 0.354 either side of that line; the wander is 0.12
    expect(off).toBeLessThan(0.2);
    expect(worst).toBeLessThanOrEqual(TETHER + 1e-4);
  });

  it('keeps the end of a run, and a lone tile, exactly on its tile centre', () => {
    const hr = build(['........', '..####..#', '.....#..', '.....#..']);
    for (const [x, y] of [[2, 1], [5, 3], [8, 1]]) expect(offset(hr, at(x, y))).toBe(0);
    expect(hr.deg[at(8, 1)]).toBe(0);
    expect(hr.deg[at(0, 0)]).toBe(-1);
  });

  it('joins tiles that touch at a corner, but only where there is no way round', () => {
    const hr = build(['#....#..', '.#..##..']);
    expect(hr.link[at(0, 0)] & LINK_SE).toBe(LINK_SE);
    expect(hr.deg[at(1, 1)]).toBe(1);
    // (5,0)-(4,1) share the neighbour (5,1): linking them too would close a triangle
    expect(hr.link[at(5, 0)]).toBe(LINK_S);
    expect(hr.deg[at(5, 0)]).toBe(1);
  });

  it('never moves a node further than the tether on generated maps, and is deterministic', () => {
    for (const seed of [1, 2]) {
      const map = generateMap(seed, 160, 120, 'open').map;
      const is = (x: number, y: number) => map.terrainKeyAt(x, y) === 'hedge';
      const hr = buildHedgerows(is, map.w, map.h);
      let worst = 0;
      let nodes = 0;
      for (let i = 0; i < hr.deg.length; i++) {
        if (hr.deg[i] < 0) continue;
        nodes++;
        worst = Math.max(worst, offset(hr, i));
        if (hr.deg[i] < 2) expect(offset(hr, i)).toBe(0);
      }
      expect(nodes).toBeGreaterThan(300);
      expect(worst).toBeLessThanOrEqual(TETHER + 1e-4);
      expect(holes(hr, hedgeLobes(hr, 0, 0, map.w, map.h, 0))).toBe(0);
      const again = buildHedgerows(is, map.w, map.h);
      expect(Array.from(again.px)).toEqual(Array.from(hr.px));
      expect(hedgeLobes(again, 0, 0, map.w, map.h, 2)).toEqual(hedgeLobes(hr, 0, 0, map.w, map.h, 2));
    }
  });
});

describe('hedgeLobes', () => {
  it('leaves a one-tile gap open: nothing is drawn across a tile that is not hedge', () => {
    const hr = build(['........', '.####.####....']);
    for (const sprays of [0, 2]) {
      const lobes = hedgeLobes(hr, 0, 0, W, H, sprays);
      for (let k = 0; k < lobes.length; k += 3) {
        const near = Math.abs(lobes[k] - 5.5) - lobes[k + 2];
        // the gap tile spans x 5..6; a lobe may round the end of a run, not close the gap
        expect(near).toBeGreaterThan(0.45);
      }
    }
  });

  it('gives the same lobes whichever chunk asks for them', () => {
    const hr = build(['........', '.##########...', '......#.......', '......#.......']);
    const whole = hedgeLobes(hr, 0, 0, W, H, 2);
    const split = [...hedgeLobes(hr, 0, 0, 6, H, 2), ...hedgeLobes(hr, 6, 0, W, H, 2)];
    const key = (l: number[]) => {
      const out: string[] = [];
      for (let k = 0; k < l.length; k += 3) out.push(`${l[k]},${l[k + 1]},${l[k + 2]}`);
      return out.sort();
    };
    expect(key(split)).toEqual(key(whole));
  });

  it('stays within half a metre of the centreline, sprays included', () => {
    const hr = build(['........', '.##########...']);
    const lobes = hedgeLobes(hr, 0, 0, W, H, 2);
    for (let k = 0; k < lobes.length; k += 3) {
      // the run is a row, so the centreline is within the wander of y = 1.5
      expect(Math.abs(lobes[k + 1] - 1.5) + lobes[k + 2]).toBeLessThan(0.52 + 0.12 + 1e-6);
    }
  });
});
