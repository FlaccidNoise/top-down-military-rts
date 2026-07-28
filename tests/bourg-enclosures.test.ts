import { describe, expect, it } from 'vitest';
import { MIN_REAR_SPAN_Q8, stampEnclosures, WALL_HIGH, WALL_LOW, type Enclosures } from '../src/sim/bourg/enclosures';
import { buildFootprints, type Footprints } from '../src/sim/bourg/footprints';
import { reserveLandmarks, RESV, type Landmarks } from '../src/sim/bourg/landmarks';
import { buildParcels, type Parcels } from '../src/sim/bourg/parcels';
import { BOURG } from '../src/sim/bourg/profile';
import { stampStructure } from '../src/sim/bourg/stamp';
import { buildSkeleton, growMinorStreets, type Skeleton } from '../src/sim/bourg/streets';
import { EDGE, GameMap } from '../src/sim/map';

// T8: garden walls, gates, the churchyard enclosure and the rear network.
//
// The harness below is T11's stamp order minus the rural terrain and the
// elevation pass — roads painted, buildings stamped, enclosures last. Terrain
// is bare grass, which is the PERMISSIVE case: T9's woods and hedgerows only
// remove movement, never add it, so a reachability failure here is a real one.

const base = (seed: number): number => (seed * 0x9e3779b1) >>> 1;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const W = 320;
const H = 240;

interface Town {
  sk: Skeleton;
  land: Landmarks;
  pc: Parcels;
  fp: Footprints;
  map: GameMap;
  en: Enclosures;
}

function build(seed: number, w = W, h = H): Town {
  const sk = buildSkeleton(base(seed), w, h, BOURG);
  const land = reserveLandmarks(sk);
  growMinorStreets(sk, { resv: land.resv });
  const pc = buildParcels(sk, land.resv);
  const fp = buildFootprints(sk, land, pc);
  const map = new GameMap(w, h);
  for (let i = 0; i < w * h; i++) if (sk.road[i]) map.setTerrain(i % w, (i / w) | 0, 'road');
  fp.buildings.forEach((b, i) => {
    map.maxStories = Math.max(map.maxStories, stampStructure(map, b, i));
  });
  const en = stampEnclosures(map, sk, land, fp);
  return { sk, land, pc, fp, map, en };
}

const cache = new Map<number, Town>();
function town(seed: number): Town {
  let t = cache.get(seed);
  if (!t) {
    t = build(seed);
    cache.set(seed, t);
  }
  return t;
}

// 4-connected foot flood from the west arterial entry, over the finished map
function footReach(t: Town): Uint8Array {
  const { map, sk } = t;
  const seen = new Uint8Array(map.w * map.h);
  const q = new Int32Array(map.w * map.h);
  const sx = 3;
  const sy = sk.roadY[3];
  let head = 0;
  let tail = 0;
  seen[sy * map.w + sx] = 1;
  q[tail++] = sy * map.w + sx;
  while (head < tail) {
    const cur = q[head++];
    const cx = cur % map.w;
    const cy = (cur / map.w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni] || !map.canStep(cx, cy, nx, ny, 'foot')) continue;
      seen[ni] = 1;
      q[tail++] = ni;
    }
  }
  return seen;
}

describe('bourg enclosures (T8)', () => {
  it('is deterministic', () => {
    for (const seed of [4, 13]) {
      const a = build(seed);
      const b = build(seed);
      expect(a.map.hEdges).toEqual(b.map.hEdges);
      expect(a.map.vEdges).toEqual(b.map.vEdges);
      expect(a.map.hEdgeTops).toEqual(b.map.hEdgeTops);
      expect(a.map.vEdgeTops).toEqual(b.map.vEdgeTops);
      expect(a.en).toEqual(b.en);
    }
  });

  it('never leaves a garden or a yard sealed off from the street', () => {
    for (const seed of SEEDS) expect([seed, town(seed).en.orphans]).toEqual([seed, 0]);
  });

  it('runs a rear network across the envelope', () => {
    for (const seed of SEEDS) {
      const { en } = town(seed);
      expect([seed, en.rearSpanQ8 >= MIN_REAR_SPAN_Q8]).toEqual([seed, true]);
    }
  });

  it('writes free-standing walls only at top 1 or 2, and only on empty edges', () => {
    for (const seed of SEEDS) {
      const { map, en } = town(seed);
      let free = 0;
      let bad = 0;
      const scan = (horizontal: boolean): void => {
        const wide = horizontal ? map.w : map.w + 1;
        const tall = horizontal ? map.h + 1 : map.h;
        for (let y = 0; y < tall; y++)
          for (let x = 0; x < wide; x++) {
            const e = horizontal ? map.hEdge(x, y) : map.vEdge(x, y);
            if (e !== EDGE.WALL) continue;
            const top = horizontal ? map.hEdgeTop(x, y) : map.vEdgeTop(x, y);
            if (top !== WALL_LOW && top !== WALL_HIGH) continue;
            free++;
            // §3.2's renderer predicate: a free-standing wall has no building
            // on either flank. A top-1 edge on a house wall would be a hole in
            // the LOS model, since los() only blocks below the top.
            const [ax, ay, bx, by] = horizontal ? [x, y - 1, x, y] : [x - 1, y, x, y];
            if (map.buildingIdAt(ax, ay) >= 0 || map.buildingIdAt(bx, by) >= 0) bad++;
          }
      };
      scan(true);
      scan(false);
      expect(bad).toBe(0);
      expect(free).toBe(en.walls);
    }
  });

  it('makes every gate infantry-permeable and vehicle-proof', () => {
    // D6: canStep passes foot through DOOR and blocks vehicles on anything but
    // NONE. This is the entire justification for using DOOR as a gate, so it is
    // asserted directly rather than inferred from the edge type.
    for (const seed of [1, 5, 9, 14, 20]) {
      const { map } = town(seed);
      let checked = 0;
      let leaks = 0;
      for (let y = 1; y < map.h - 1; y++)
        for (let x = 1; x < map.w - 1; x++) {
          for (const horizontal of [true, false]) {
            const e = horizontal ? map.hEdge(x, y) : map.vEdge(x, y);
            if (e !== EDGE.DOOR) continue;
            const [ax, ay, bx, by] = horizontal ? [x, y - 1, x, y] : [x - 1, y, x, y];
            if (map.buildingIdAt(ax, ay) >= 0 || map.buildingIdAt(bx, by) >= 0) continue; // a house door
            checked++;
            if (!map.canStep(ax, ay, bx, by, 'foot')) leaks++;
            if (map.canStep(ax, ay, bx, by, 'vehicle')) leaks++;
          }
        }
      expect(leaks).toBe(0);
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('walls the churchyard on its reservation, not on its bounding rect, and gates it', () => {
    for (const seed of SEEDS) {
      const { sk, land, map } = town(seed);
      if (!land.churchyard) continue;
      let unwalled = 0;
      const c = land.churchyard;
      for (let y = c.y; y < c.y + c.h; y++)
        for (let x = c.x; x < c.x + c.w; x++) {
          if (land.resv[y * sk.w + x] !== RESV.CHURCHYARD) continue;
          const check = (dx: number, dy: number, e: number): void => {
            const ox = x + dx;
            const oy = y + dy;
            if (ox >= 0 && oy >= 0 && ox < sk.w && oy < sk.h && land.resv[oy * sk.w + ox] === RESV.CHURCHYARD) return;
            if (e === EDGE.NONE) unwalled++;
          };
          check(0, -1, map.hEdge(x, y));
          check(0, 1, map.hEdge(x, y + 1));
          check(-1, 0, map.vEdge(x, y));
          check(1, 0, map.vEdge(x + 1, y));
        }
      expect([seed, unwalled]).toEqual([seed, 0]);
      // §1.3: one gate onto the place, one round the far side. The second is
      // dropped when the reservation is too small for the two to be six tiles
      // apart, which is the shrunk-to-16 churchyard.
      expect(town(seed).en.churchGates).toBeGreaterThanOrEqual(1);
      expect(town(seed).en.churchGates).toBeLessThanOrEqual(2);
    }
  });

  it('leaves every building door tile reachable on foot from the west arterial', () => {
    for (const seed of SEEDS) {
      const { fp, map, sk } = town(seed);
      const seen = footReach(town(seed));
      const stranded = fp.buildings.filter((b) => {
        const d = b.doors?.[0];
        if (!d) return false;
        return !seen[d.y * map.w + d.x];
      });
      expect([seed, stranded.map((b) => `${b.role}@${b.x},${b.y}`)]).toEqual([seed, []]);
      expect(seen[sk.place.y * map.w + sk.place.x]).toBe(1);
    }
  });

  it('survives every map size generateMap allows', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3, 4, 5]) {
        const t = build(seed, w, h);
        expect(t.en.orphans).toBe(0);
      }
  });
});
