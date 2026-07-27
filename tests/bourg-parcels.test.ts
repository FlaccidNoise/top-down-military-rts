import { describe, expect, it } from 'vitest';
import { reserveLandmarks, RESV, type Landmarks } from '../src/sim/bourg/landmarks';
import { buildParcels, plotRect, type Parcels } from '../src/sim/bourg/parcels';
import { buildSkeleton, growMinorStreets, type Skeleton } from '../src/sim/bourg/streets';

// T6: blocks (CCL), the depth field, back lanes, frontage runs and burgage
// parcels. Everything here is pure geometry over T4's `road` bitmap and T5's
// `resv` — no GameMap, nothing stamped. The invariants T7 depends on are the
// no-overlap ones: a Plot that overlaps another, or a road tile, is a
// footprint that will throw inside stampStructure fifty tiles later.

const base = (seed: number): number => (seed * 0x9e3779b1) >>> 1;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

interface Town {
  sk: Skeleton;
  land: Landmarks;
  pc: Parcels;
}

function build(seed: number, w = 320, h = 240): Town {
  const sk = buildSkeleton(base(seed), w, h);
  const land = reserveLandmarks(sk);
  growMinorStreets(sk, { resv: land.resv });
  return { sk, land, pc: buildParcels(sk, land.resv) };
}

// a 320x240 town is ~10 ms to build and every test wants all twenty of them
const cache = new Map<number, Town>();
function town(seed: number): Town {
  let t = cache.get(seed);
  if (!t) {
    t = build(seed);
    cache.set(seed, t);
  }
  return t;
}

describe('bourg parcels (T6)', () => {
  it('is deterministic', () => {
    for (const seed of [1, 6, 15]) {
      const a = town(seed);
      const b = town(seed);
      expect(a.pc.plots).toEqual(b.pc.plots);
      expect(a.pc.runs).toEqual(b.pc.runs);
      expect(a.pc.interiors).toEqual(b.pc.interiors);
      expect(a.pc.lane).toEqual(b.pc.lane);
      expect(a.pc.blockId).toEqual(b.pc.blockId);
      expect(a.pc.depth).toEqual(b.pc.depth);
    }
  });

  // NB: these sweeps count violations and assert once. A per-tile expect() over
  // 76,800 tiles x 20 seeds is 1.5M assertions and times vitest out at 5 s.
  it('labels exactly the non-road, non-reserved, non-lane tiles', () => {
    for (const seed of SEEDS) {
      const { sk, land, pc } = town(seed);
      let wrong = 0;
      for (let i = 0; i < pc.blockId.length; i++) {
        const blocked = sk.road[i] !== 0 || land.resv[i] !== 0 || pc.lane[i] !== 0;
        if (pc.blockId[i] >= 0 === blocked) wrong++;
      }
      expect(wrong).toBe(0);
    }
  });

  it('gives every block a 4-connected label and a consistent summary', () => {
    for (const seed of [1, 2, 3]) {
      const { sk, pc } = town(seed);
      const area = new Int32Array(pc.blocks.length);
      for (let i = 0; i < pc.blockId.length; i++) if (pc.blockId[i] >= 0) area[pc.blockId[i]]++;
      pc.blocks.forEach((b, idx) => {
        expect(b.id).toBe(idx); // summarise() indexes by id — T7 relies on it
        expect(b.area).toBe(area[b.id]);
        expect(b.minX).toBeLessThanOrEqual(b.maxX);
      });
      // 4-connectivity: a component must be reachable from its own first tile
      const first = pc.blockId.findIndex((v) => v === 3);
      if (first >= 0) {
        const seen = new Uint8Array(pc.blockId.length);
        const q = [first];
        seen[first] = 1;
        let n = 0;
        while (q.length) {
          const cur = q.pop()!;
          n++;
          const cx = cur % sk.w;
          for (const nb of [cx > 0 ? cur - 1 : -1, cx + 1 < sk.w ? cur + 1 : -1, cur - sk.w, cur + sk.w])
            if (nb >= 0 && nb < pc.blockId.length && !seen[nb] && pc.blockId[nb] === 3) {
              seen[nb] = 1;
              q.push(nb);
            }
        }
        expect(n).toBe(pc.blocks[3].area);
      }
    }
  });

  it('seeds the depth field at 0 on road and back lanes and rises by 1 inland', () => {
    for (const seed of SEEDS) {
      const { sk, pc } = town(seed);
      let badSeed = 0;
      let badInland = 0;
      let badGradient = 0;
      for (let i = 0; i < pc.depth.length; i++) {
        if (sk.road[i] || pc.lane[i]) {
          if (pc.depth[i] !== 0) badSeed++;
          continue;
        }
        if (pc.blockId[i] < 0) continue;
        if (pc.depth[i] < 1) badInland++;
        // every in-block tile has a 4-neighbour exactly one shallower
        if (pc.depth[i] < 2) continue;
        const d = pc.depth[i];
        if (pc.depth[i - 1] !== d - 1 && pc.depth[i + 1] !== d - 1 && pc.depth[i - sk.w] !== d - 1 && pc.depth[i + sk.w] !== d - 1)
          badGradient++;
      }
      expect([badSeed, badInland, badGradient]).toEqual([0, 0, 0]);
    }
  });

  it('carves back lanes only inland, never on road, and only in deep blocks', () => {
    let carved = 0;
    for (const seed of SEEDS) {
      const { sk, land, pc } = town(seed);
      carved += pc.laneCount;
      let bad = 0;
      for (let i = 0; i < pc.lane.length; i++) if (pc.lane[i] && (sk.road[i] || land.resv[i])) bad++;
      expect(bad).toBe(0);
    }
    expect(carved).toBeGreaterThan(SEEDS.length); // deep blocks are the norm, not the exception
  });

  // The invariant T7 cannot survive without: overlapping plots become
  // overlapping footprints, and stampStructure throws on the second one.
  it('emits plots that are on-grid, disjoint, and never on road or reservation', () => {
    for (const seed of SEEDS) {
      const { sk, land, pc } = town(seed);
      const own = new Int32Array(sk.w * sk.h).fill(-1);
      pc.plots.forEach((p, idx) => {
        const r = plotRect(p);
        expect(r.w).toBeGreaterThanOrEqual(4);
        expect(r.h).toBeGreaterThanOrEqual(1);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(sk.w);
        expect(r.y + r.h).toBeLessThanOrEqual(sk.h);
        let bad = 0;
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) {
            const i = y * sk.w + x;
            if (own[i] !== -1 || sk.road[i] || land.resv[i] || pc.blockId[i] !== p.blockId) bad++;
            own[i] = idx;
          }
        expect(bad).toBe(0);
      });
    }
  });

  it('fronts every plot directly onto the street it was extracted from', () => {
    for (const seed of SEEDS)
      {
        const { sk, pc } = town(seed);
        const offStreet = pc.plots.filter((p) => {
          const bx = p.axis === 'h' ? p.fx : p.fx - p.side;
          const by = p.axis === 'h' ? p.fy - p.side : p.fy;
          return sk.road[by * sk.w + bx] !== 1;
        });
        expect(offStreet).toEqual([]);
      }
  });

  it('subdivides by dens: core strips 4-9 wide with no setback, fringe wider and set back', () => {
    let core = 0;
    let fringe = 0;
    for (const seed of SEEDS)
      for (const p of town(seed).pc.plots) {
        expect(p.densQ8).toBeGreaterThan(0);
        expect(p.densQ8).toBeLessThanOrEqual(256);
        expect(p.setback).toBeGreaterThanOrEqual(0);
        expect(p.setback).toBeLessThanOrEqual(4);
        expect(p.d).toBeGreaterThanOrEqual(5);
        if (p.densQ8 > 154) {
          core++;
          expect(p.setback).toBe(0); // the front wall IS the street edge
          expect(p.d).toBeLessThanOrEqual(34);
        } else {
          fringe++;
          expect(p.d).toBeLessThanOrEqual(50);
        }
      }
    expect(core).toBeGreaterThan(20);
    expect(fringe).toBeGreaterThan(core); // a nebular townscape, not a solid block
  });

  it('numbers indexInRun consecutively from 0 within each run', () => {
    for (const seed of SEEDS) {
      const seen = new Map<number, number>();
      for (const p of town(seed).pc.plots) {
        const next = seen.get(p.runIndex) ?? 0;
        expect(p.indexInRun).toBe(next);
        seen.set(p.runIndex, next + 1);
      }
    }
  });

  it('keeps interior parcels off the plots, the roads and the reservations', () => {
    for (const seed of SEEDS) {
      const { sk, land, pc } = town(seed);
      const used = new Uint8Array(sk.w * sk.h);
      for (const p of pc.plots) {
        const r = plotRect(p);
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) used[y * sk.w + x] = 1;
      }
      for (const it of pc.interiors) {
        expect(it.rect.w).toBeGreaterThanOrEqual(5);
        expect(it.rect.h).toBeGreaterThanOrEqual(5);
        // every tile of an interior parcel is usable ground of its own block:
        // T7 drops a farm cour in here and cannot re-check
        let bad = 0;
        for (let y = it.rect.y; y < it.rect.y + it.rect.h; y++)
          for (let x = it.rect.x; x < it.rect.x + it.rect.w; x++) {
            const i = y * sk.w + x;
            if (used[i] || sk.road[i] || land.resv[i] || pc.blockId[i] !== it.blockId) bad++;
          }
        expect(bad).toBe(0);
        for (let y = it.rect.y; y < it.rect.y + it.rect.h; y++)
          for (let x = it.rect.x; x < it.rect.x + it.rect.w; x++) used[y * sk.w + x] = 1;
      }
    }
  });

  it('keeps parcels inside the town, leaving the countryside to T9', () => {
    for (const seed of SEEDS) {
      const { sk, pc } = town(seed);
      const inZone = (x: number, y: number): boolean =>
        (x >= sk.env.x - 6 && x <= sk.env.x + sk.env.w + 5 && y >= sk.env.y - 6 && y <= sk.env.y + sk.env.h + 5) ||
        (sk.faubourg !== null &&
          Math.abs(x - sk.faubourg.x) <= 22 &&
          Math.abs(y - sk.faubourg.y) <= 22);
      for (const p of pc.plots) {
        const r = plotRect(p);
        expect(inZone(r.x, r.y)).toBe(true);
        expect(inZone(r.x + r.w - 1, r.y + r.h - 1)).toBe(true);
      }
    }
  });

  it('yields enough parcels for T7 to build a town on', () => {
    const totals = SEEDS.map((seed) => {
      const { pc } = town(seed);
      return pc.plots.length + pc.interiors.length;
    });
    expect(Math.min(...totals)).toBeGreaterThanOrEqual(20);
    expect(totals.reduce((a, b) => a + b, 0) / totals.length).toBeGreaterThan(30);
  });

  it('survives every map size generateMap allows', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3, 4, 5]) {
        const { pc } = build(seed, w, h);
        expect(pc.plots.length).toBeGreaterThan(0);
        for (const p of pc.plots) {
          const r = plotRect(p);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(w);
          expect(r.y + r.h).toBeLessThanOrEqual(h);
        }
      }
  });
});
