import { describe, expect, it } from 'vitest';
import { RESV, reserveLandmarks, type Landmarks } from '../src/sim/bourg/landmarks';
import { buildSkeleton, growMinorStreets, type Skeleton } from '../src/sim/bourg/streets';

// T5: stage-4 landmark reservation. Runs between the skeleton and the growth
// loop, so every test here builds the skeleton, reserves, and only then grows —
// the order is the point: streets must route AROUND the landmarks.

const base = (seed: number): number => (seed * 0x9e3779b1) >>> 1;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function reserve(seed: number, w = 320, h = 240): { sk: Skeleton; land: Landmarks } {
  const sk = buildSkeleton(base(seed), w, h);
  const land = reserveLandmarks(sk);
  return { sk, land };
}

function grown(seed: number, w = 320, h = 240): { sk: Skeleton; land: Landmarks } {
  const r = reserve(seed, w, h);
  growMinorStreets(r.sk, { resv: r.land.resv });
  return r;
}

describe('bourg landmarks (T5)', () => {
  it('is deterministic', () => {
    for (const seed of [1, 9, 17]) {
      const a = reserve(seed);
      const b = reserve(seed);
      expect(a.land.resv).toEqual(b.land.resv);
      expect(a.land.churchyard).toEqual(b.land.churchyard);
      expect(a.land.place).toEqual(b.land.place);
      expect(a.land.market).toEqual(b.land.market);
      expect(a.land.forecourt).toEqual(b.land.forecourt);
      expect(a.land.anchor).toEqual(b.land.anchor);
    }
  });

  // An enclosure with a street through it is not an enclosure. The quadrant
  // search rejects any candidate containing road, which is also what keeps the
  // 'enclos' cross route (offset 12-20 from the place) out of the churchyard.
  it('reserves a churchyard clear of every carved road tile', () => {
    let found = 0;
    for (const seed of SEEDS) {
      const { sk, land } = reserve(seed);
      if (!land.churchyard) continue;
      found++;
      const c = land.churchyard;
      expect(c.w).toBeGreaterThanOrEqual(16);
      expect(c.w).toBeLessThanOrEqual(34);
      expect(c.w).toBe(c.h);
      expect(c.x).toBeGreaterThanOrEqual(3);
      expect(c.y).toBeGreaterThanOrEqual(3);
      expect(c.x + c.w).toBeLessThanOrEqual(sk.w - 3);
      expect(c.y + c.h).toBeLessThanOrEqual(sk.h - 3);
      // the chamfer notches are deliberately OUTSIDE the enclosure, so the
      // place widening may pave into them; the reserved core may not have road
      for (let y = c.y; y < c.y + c.h; y++)
        for (let x = c.x; x < c.x + c.w; x++) {
          const i = y * sk.w + x;
          if (land.resv[i] === RESV.CHURCHYARD) expect(sk.road[i]).toBe(0);
        }
      const inset = land.chamfer;
      for (let y = c.y + inset; y < c.y + c.h - inset; y++)
        for (let x = c.x + inset; x < c.x + c.w - inset; x++)
          expect(land.resv[y * sk.w + x]).toBe(RESV.CHURCHYARD);
    }
    expect(found).toBe(SEEDS.length);
  });

  it('chamfers the churchyard corners with a 3-5 step staircase', () => {
    for (const seed of SEEDS) {
      const { sk, land } = reserve(seed);
      const c = land.churchyard;
      if (!c) continue;
      expect(land.chamfer).toBeGreaterThanOrEqual(3);
      expect(land.chamfer).toBeLessThanOrEqual(5);
      // the extreme corner tile is always cut, the tile `chamfer` in never is
      expect(land.resv[c.y * sk.w + c.x]).toBe(RESV.NONE);
      expect(land.resv[(c.y + land.chamfer) * sk.w + c.x + land.chamfer]).toBe(RESV.CHURCHYARD);
      expect(land.resv[(c.y + c.h - 1) * sk.w + c.x + c.w - 1]).toBe(RESV.NONE);
      expect(land.resv[(c.y + (c.h >> 1)) * sk.w + c.x]).toBe(RESV.CHURCHYARD);
    }
  });

  it('widens the place into road, asymmetrically, without eating a reservation', () => {
    for (const seed of SEEDS) {
      const { sk, land } = reserve(seed);
      const p = land.place;
      expect(p.h).toBeGreaterThanOrEqual(11);
      expect(p.h).toBeLessThanOrEqual(17);
      expect(p.w).toBeGreaterThanOrEqual(11);
      expect(p.w).toBeLessThanOrEqual(42);
      // northShare = 3 + int(width - 5), so the shares run 3..width-3 north and
      // 2..width-4 south — asymmetric by construction, never degenerate
      expect(sk.place.y - p.y).toBeGreaterThanOrEqual(3);
      expect(p.y + p.h - 1 - sk.place.y).toBeGreaterThanOrEqual(2);
      let road = 0;
      for (let y = p.y; y < p.y + p.h; y++)
        for (let x = p.x; x < p.x + p.w; x++) {
          const i = y * sk.w + x;
          if (land.resv[i] === RESV.CHURCHYARD) expect(sk.road[i]).toBe(0);
          else if (land.resv[i] === RESV.NONE) road += sk.road[i];
        }
      expect(road).toBeGreaterThan(p.w * p.h * 0.5);
    }
  });

  it('never straddles a Grande Rue jog with the widening', () => {
    for (const seed of SEEDS) {
      const { sk, land } = reserve(seed);
      const run = sk.grandeRue.find(
        (s) => s.axis === 'h' && sk.place.x >= Math.min(s.ax, s.bx) && sk.place.x <= Math.max(s.ax, s.bx),
      );
      expect(run).toBeDefined();
      expect(land.place.x).toBeGreaterThanOrEqual(Math.min(run!.ax, run!.bx));
      expect(land.place.x + land.place.w - 1).toBeLessThanOrEqual(Math.max(run!.ax, run!.bx));
    }
  });

  it('drops the market island inside the place with >= 3 tiles of lane on both flanks', () => {
    let islands = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { sk, land } = reserve(seed);
      const m = land.market;
      if (!m) continue;
      islands++;
      expect(m.w).toBeGreaterThanOrEqual(6);
      expect(m.w).toBeLessThanOrEqual(11);
      expect(m.h).toBeGreaterThanOrEqual(5);
      expect(m.h).toBeLessThanOrEqual(8);
      const p = land.place;
      expect(m.x - p.x).toBeGreaterThanOrEqual(3);
      expect(p.x + p.w - (m.x + m.w)).toBeGreaterThanOrEqual(3);
      expect(m.y - p.y).toBeGreaterThanOrEqual(3);
      expect(p.y + p.h - (m.y + m.h)).toBeGreaterThanOrEqual(3);
      // the island is BUILT on in stage 9, so it must not stay paved
      for (let y = m.y; y < m.y + m.h; y++)
        for (let x = m.x; x < m.x + m.w; x++) {
          expect(sk.road[y * sk.w + x]).toBe(0);
          expect(land.resv[y * sk.w + x]).toBe(RESV.MARKET);
        }
    }
    expect(islands).toBeGreaterThan(10); // p 0.6, gated on the place being big enough
    expect(islands).toBeLessThan(60);
  });

  it('reserves a 10x8 civic forecourt on clear ground when one fits', () => {
    for (const seed of SEEDS) {
      const { sk, land } = reserve(seed);
      const f = land.forecourt;
      if (!f) continue;
      expect(f.w).toBe(10);
      expect(f.h).toBe(8);
      for (let y = f.y; y < f.y + f.h; y++)
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(sk.road[y * sk.w + x]).toBe(0);
          expect(land.resv[y * sk.w + x]).toBe(RESV.CIVIC);
        }
    }
  });

  // scenario.ts:49 emplaces the MG42 on objectives[0]; patches.ts needs road
  // under the cobbles. sk.place is the density origin and CAN be under the
  // market island, so T10 takes the anchor and not the carrefour itself.
  it('always yields a free road tile on the place as the objective anchor', () => {
    for (const seed of SEEDS) {
      const { sk, land } = reserve(seed);
      const i = land.anchor.y * sk.w + land.anchor.x;
      expect(sk.road[i]).toBe(1);
      expect(land.resv[i]).toBe(RESV.NONE);
      expect(Math.max(Math.abs(land.anchor.x - sk.place.x), Math.abs(land.anchor.y - sk.place.y))).toBeLessThan(12);
    }
  });

  // The growth loop truncates at reservations and emits a tangent street along
  // the boundary, so grown road may abut the churchyard but never enter it.
  it('minor streets route around the reservations, never through them', () => {
    for (const seed of SEEDS) {
      const { sk, land } = grown(seed);
      for (let i = 0; i < land.resv.length; i++)
        if (land.resv[i] === RESV.CHURCHYARD || land.resv[i] === RESV.CIVIC) expect(sk.road[i]).toBe(0);
    }
  });

  it('survives every map size generateMap allows', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3, 4, 5]) {
        const { sk, land } = grown(seed, w, h);
        expect(sk.road[land.anchor.y * w + land.anchor.x]).toBe(1);
        expect(land.place.x + land.place.w).toBeLessThanOrEqual(w);
        expect(land.place.y + land.place.h).toBeLessThanOrEqual(h);
      }
  });
});
