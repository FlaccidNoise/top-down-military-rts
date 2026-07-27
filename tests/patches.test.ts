import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/mapgen';
import { PatchIndex } from '../src/render/patches';

// The parcel index is the data every piece of field, clutter and civic art is
// keyed on, so it has to be exactly reproducible: the art regression sweep
// compares renders across builds and a parcel that renumbers itself would
// rotate every crop on the map.
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23];

describe('PatchIndex', () => {
  it('gives every field and woods tile a parcel id', () => {
    for (const seed of SEEDS) {
      const { map } = generateMap(seed, 320, 240, 'town');
      const pi = new PatchIndex(map);
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          const k = map.terrainKeyAt(x, y);
          const id = pi.id[y * map.w + x];
          if (k === 'field' || k === 'woods') {
            expect(id).toBeGreaterThanOrEqual(0);
            expect(pi.patches[id].kind).toBe(k);
          } else expect(id).toBe(-1);
        }
      }
    }
    // 10 x (320x240 generateMap + a full-map flood fill + 76,800 assertions):
    // ~3.3s standalone, past the 5s default under full-suite CPU contention.
    // Explicit budget, same as the other heavy suites in this repo.
  }, 20_000);

  it('parcels are 4-connected and their bounds/centroids fit their tiles', () => {
    for (const seed of SEEDS) {
      const { map } = generateMap(seed, 320, 240, 'town');
      const pi = new PatchIndex(map);
      const tilesOf = new Map<number, [number, number][]>();
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          const id = pi.id[y * map.w + x];
          if (id < 0) continue;
          const a = tilesOf.get(id) ?? [];
          a.push([x, y]);
          tilesOf.set(id, a);
        }
      }
      for (const [id, tiles] of tilesOf) {
        const p = pi.patches[id];
        expect(p.tiles).toBe(tiles.length);
        // flood the recorded tiles from the first one; a disconnected parcel
        // would leave some unreached
        const set = new Set(tiles.map(([x, y]) => y * map.w + x));
        const seen = new Set<number>([tiles[0][1] * map.w + tiles[0][0]]);
        const stack = [tiles[0][1] * map.w + tiles[0][0]];
        while (stack.length) {
          const i = stack.pop()!;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
            const q = i + dy * map.w + dx;
            const qx = (i % map.w) + dx;
            if (qx < 0 || qx >= map.w || !set.has(q) || seen.has(q)) continue;
            seen.add(q);
            stack.push(q);
          }
        }
        expect(seen.size).toBe(tiles.length);
        expect(p.minX).toBe(Math.min(...tiles.map((t) => t[0])));
        expect(p.maxX).toBe(Math.max(...tiles.map((t) => t[0])) + 1);
        expect(p.cx).toBeGreaterThanOrEqual(p.minX);
        expect(p.cx).toBeLessThanOrEqual(p.maxX);
      }
    }
  });

  it('is byte-identical across two constructions of the same map', () => {
    for (const seed of SEEDS) {
      const { map } = generateMap(seed, 320, 240, 'town');
      const a = new PatchIndex(map);
      const b = new PatchIndex(map);
      expect(a.id).toEqual(b.id);
      expect(a.patches).toEqual(b.patches);
      expect(a.junctions).toEqual(b.junctions);
      expect(a.buildings).toEqual(b.buildings);
    }
  });

  it('junctions sit on road tiles and the squares are exactly the built-up ones', () => {
    for (const seed of SEEDS) {
      const { map } = generateMap(seed, 320, 240, 'town');
      const pi = new PatchIndex(map);
      for (const j of pi.junctions) {
        expect(map.terrainKeyAt(Math.floor(j.x), Math.floor(j.y))).toBe('road');
        expect(map.isBridge(Math.floor(j.x), Math.floor(j.y))).toBe(false);
      }
      expect(pi.squares.length).toBe(pi.junctions.filter((j) => j.buildings >= 4).length);
    }
  });

  it('finds a built-up junction on the village crossroads', () => {
    // 5 m, not 3: mapgen's arterial is 3 tiles wide, so the crossing box is
    // asymmetric about the plan's nominal crossroads and its centroid lands a
    // couple of metres off. Not every seed qualifies — on some the village
    // anchor is a T or a lane offset from the arterial and the crossing test
    // (road reaching along BOTH axes) correctly finds nothing there — so this
    // asserts the common case, not all ten.
    let hit = 0;
    for (const seed of SEEDS) {
      const plan = generateMap(seed, 320, 240, 'town');
      const pi = new PatchIndex(plan.map);
      const cross = plan.objectives[0];
      const near = pi.junctions.filter((j) => Math.hypot(j.x - cross.x, j.y - cross.y) <= 5);
      if (near.length && Math.max(...near.map((j) => j.buildings)) >= 4) hit++;
    }
    expect(hit).toBeGreaterThanOrEqual(7);
  });

  // T19. The place ramp is a rounded rectangle whose corner radius is
  // min(rx, ry), so a square square is the disc it always was. That is the
  // whole legacy-safety argument and it is worth an exact assertion rather
  // than an art baseline: a re-snapshotted crop is an invisible regression.
  it('leaves every legacy kind paving exactly the disc it did before T19', () => {
    const disc = (sq: { cx: number; cy: number; rx: number }[], x: number, y: number) => {
      let a = 0;
      for (const s of sq) a = Math.max(a, Math.min(0.88, (s.rx - Math.hypot(x + 0.5 - s.cx, y + 0.5 - s.cy)) / 3.5));
      return Math.max(0, a);
    };
    for (const kind of ['town', 'road', 'bridge', 'river'] as const) {
      for (const seed of [1, 3, 7, 11]) {
        const { map } = generateMap(seed, 320, 240, kind);
        const pi = new PatchIndex(map);
        for (const s of pi.squares) expect(s.rx).toBe(s.ry);
        for (let y = 0; y < map.h; y += 3) {
          for (let x = 0; x < map.w; x += 3) expect(pi.pavedAt(x, y)).toBe(disc(pi.squares, x, y));
        }
      }
    }
  }, 20_000);

  it('gives the bourg place one elongated square instead of a chain of discs', () => {
    for (const seed of [10, 11, 12]) {
      const { map } = generateMap(seed, 320, 240, 'bourg');
      const pi = new PatchIndex(map);
      const wide = pi.squares.filter((s) => s.rx !== s.ry);
      // exactly one widening per bourg, and every crossing inside it collapses
      // onto the same rectangle rather than paving its own disc
      expect(wide.length).toBe(1);
      const [s] = wide;
      expect(Math.max(s.rx, s.ry) / Math.min(s.rx, s.ry)).toBeGreaterThan(1.3);
      // the ends of the widening are paved, which is the defect T19 exists
      // for: the pre-T19 11 m cap could not reach past 22 m of frontage
      let span = 0;
      for (let x = 0; x < map.w; x++) if (pi.pavedAt(x, Math.round(s.cy)) > 0.3) span++;
      expect(span).toBeGreaterThan(24);
    }
  }, 20_000);

  it('building boxes match buildingIdAt bounds exactly', () => {
    for (const seed of SEEDS) {
      const { map } = generateMap(seed, 320, 240, 'town');
      const pi = new PatchIndex(map);
      const seen = new Map<number, [number, number, number, number]>();
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          const id = map.buildingIdAt(x, y);
          if (id < 0) continue;
          const b = seen.get(id);
          if (!b) seen.set(id, [x, y, x + 1, y + 1]);
          else seen.set(id, [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x + 1), Math.max(b[3], y + 1)]);
        }
      }
      expect(pi.buildings.length).toBe(seen.size);
      for (const b of pi.buildings) {
        expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual(seen.get(b.id));
      }
    }
  });
});
