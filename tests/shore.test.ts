import { describe, expect, it } from 'vitest';
import { buildShore, inShore, SHORE_TETHER, shorePolygons, type Shore } from '../src/render/shore';
import { generateMap } from '../src/sim/mapgen';

// The water's drawn outline (src/render/shore.ts). Water is impassable tile by
// tile and the picture is a smoothed line round those tiles, so what is
// pinned here is that the line never lies about them.

const W = 20;
const H = 14;
// '~' water, '.' open ground, '=' something made (a road, a floor)
const build = (rows: string[]): Shore => buildShore((x, y) => rows[y]?.[x] === '~', (x, y) => rows[y]?.[x] === '.', W, H);
const pad = (rows: string[]): string[] => Array.from({ length: H }, (_, y) => (rows[y] ?? '').padEnd(W, '.'));
const corners = (s: Shore): [number, number, number][] => s.loops.flatMap((l) => Array.from(l.free, (f, i) => [l.xy[i * 2], l.xy[i * 2 + 1], f] as [number, number, number]));

describe('buildShore', () => {
  it('walks the outline as closed loops and lays a staircase bank down into a diagonal', () => {
    // a channel two tiles wide stepping one east every row
    const rows = pad(Array.from({ length: H }, (_, y) => (y >= 2 && y < 12 ? '.'.repeat(y) + '~~' : '')));
    const s = build(rows);
    expect(s.loops.length).toBe(1);
    let worst = 0;
    for (const [x, y, free] of corners(s)) {
      if (!free || y < 4 || y > 10) continue;
      // the west bank's corners sit on x - y = 0 and x - y = -1 alternately: its line is x - y = -0.5.
      // the east bank is the same line two tiles over
      const d = Math.min(Math.abs(x - y + 0.5), Math.abs(x - y - 1.5)) / Math.SQRT2;
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThan(0.2); // the tile corners sit 0.354 off those lines
    expect(s.maxOffset).toBeLessThanOrEqual(SHORE_TETHER + 1e-4);
  });

  it('does not move a corner that has anything made beside it, or the map edge', () => {
    // a channel running off the top of the map, with a road down its east bank
    const rows = pad(['...~~=', '...~~=', '....~~=', '....~~=', '...~~=', '...~~=']);
    const s = build(rows);
    for (const [x, y, free] of corners(s)) {
      const made = [[-1, -1], [0, -1], [-1, 0], [0, 0]].some(([dx, dy]) => rows[y + dy]?.[x + dx] === '=' || y + dy < 0);
      if (Number.isInteger(x) && Number.isInteger(y) && made) expect(free).toBe(0);
      if (!free) {
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
      }
    }
    // the edges along the road and along the map edge are not banks
    const loop = s.loops[0];
    for (let i = 0; i < loop.soft.length; i++) {
      const j = (i + 1) % loop.soft.length;
      const x = loop.xy[i * 2];
      const onEdge = loop.xy[i * 2 + 1] === 0 && loop.xy[j * 2 + 1] === 0;
      if (onEdge) expect(loop.soft[i]).toBe(0);
      if (x >= 5 && loop.xy[j * 2] >= 5 && x === loop.xy[j * 2]) expect(loop.soft[i]).toBe(0);
    }
    expect(corners(s).some(([, , f]) => f === 1)).toBe(true); // the west bank is free
  });

  it('keeps two ponds that touch at a corner as two ponds', () => {
    const s = build(pad(['', '.~~...', '.~~...', '...~~.', '...~~.']));
    expect(s.loops.length).toBe(2);
    for (const l of s.loops) expect(l.free.length).toBe(8);
  });
});

describe('inShore', () => {
  it('has an island in a pond as land', () => {
    const rows = pad(['', '.~~~~~.', '.~~~~~.', '.~~.~~.', '.~~~~~.', '.~~~~~.']);
    const polys = shorePolygons(build(rows));
    expect(inShore(polys, 2, 2)).toBe(true);
    expect(inShore(polys, 3.5, 3.5)).toBe(false); // the island
    expect(inShore(polys, 0.5, 0.5)).toBe(false);
    expect(inShore(polys, 9, 3)).toBe(false);
  });

  it('agrees with the tiles at every tile centre of a generated river and a bridge map', () => {
    for (const kind of ['river', 'bridge'] as const) {
      const map = generateMap(3, 240, 180, kind).map;
      const water = (x: number, y: number): boolean => map.terrainKeyAt(x, y) === 'water' || map.isBridge(x, y);
      const open = (x: number, y: number): boolean => ['grass', 'field', 'woods', 'hedge', 'bank'].includes(map.terrainKeyAt(x, y)) && !map.isBridge(x, y);
      const shore = buildShore(water, open, map.w, map.h);
      const polys = shorePolygons(shore);
      let wet = 0;
      let wrong = 0;
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) {
          if (water(x, y)) wet++;
          // a tile centre is half a metre from every edge of its tile, and the line moves at most 0.4
          if (inShore(polys, x + 0.5, y + 0.5) !== water(x, y)) wrong++;
        }
      expect(wet).toBeGreaterThan(300);
      expect(wrong).toBe(0);
      expect(shore.maxOffset).toBeGreaterThan(0.2); // the banks did move
      expect(shore.maxOffset).toBeLessThanOrEqual(SHORE_TETHER + 1e-4);
      // and it is the same outline every time
      expect(buildShore(water, open, map.w, map.h).loops.map((l) => Array.from(l.xy))).toEqual(shore.loops.map((l) => Array.from(l.xy)));
    }
  });
});
