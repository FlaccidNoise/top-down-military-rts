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
    // 2.7 s standalone: ten 320x240 'town' generations plus a full PatchIndex
    // and a 76,800-tile sweep each. The 5 s default leaves nothing for a
    // parallel runner on a loaded box.
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
