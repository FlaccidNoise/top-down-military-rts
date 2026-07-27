import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/sim/rng';
import { planRivers } from '../src/strategic/theatergen/rivers';
import { stageBase, stageStream, T_TAG, type StageTag } from '../src/strategic/theatergen/streams';

const B = { w: 24000, h: 18000 };

describe('stage-stream harness (D2)', () => {
  it('tags are frozen, append-only, and inside the theater range 40-59', () => {
    expect(T_TAG).toEqual({ RIVER: 40, TOWNS: 41, ROADS: 42, CROSSINGS: 43, RAIL: 44, REGIONS: 45, NAMES: 46, OBJECTIVES: 47 });
    for (const tag of Object.values(T_TAG)) {
      expect(tag).toBeGreaterThanOrEqual(40);
      expect(tag).toBeLessThanOrEqual(59);
    }
  });

  it('stageBase consumes exactly ONE draw on the shared stream', () => {
    const shared = mulberry32(7);
    stageBase(shared);
    const control = mulberry32(7);
    control.next();
    expect(shared.next()).toBe(control.next());
  });

  it('stage isolation, directly: draining one stage does not move another', () => {
    const base = stageBase(mulberry32(1234));
    const control = Array.from({ length: 8 }, ((s) => () => s.next())(stageStream(base, T_TAG.TOWNS)));
    const river = stageStream(base, T_TAG.RIVER);
    for (let i = 0; i < 500; i++) river.next();
    const after = stageStream(base, T_TAG.TOWNS);
    expect(Array.from({ length: 8 }, () => after.next())).toEqual(control);
  });

  it('no two tags share a stream over 200 bases', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const base = stageBase(mulberry32(seed));
      const seen = new Map<string, string>();
      for (const [name, tag] of Object.entries(T_TAG) as [string, StageTag][]) {
        const s = stageStream(base, tag);
        const key = Array.from({ length: 6 }, () => s.next()).join(',');
        const prev = seen.get(key);
        expect(prev, `base ${base}: ${prev} and ${name} draw identically`).toBeUndefined();
        seen.set(key, name);
      }
    }
  });
});

const fnv = (nums: (number | string)[]): number => {
  let h = 2166136261;
  for (const n of nums) {
    for (const ch of String(n)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    h ^= 44;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const hashPlan = (rivers: ReturnType<typeof planRivers>): number =>
  fnv(rivers.flatMap((r) => [r.id, r.widthClass === 'river' ? 1 : 0, ...r.polyline.flatMap((p) => [p.x, p.y])]));

describe('T_RIVER', () => {
  it('pins 8 seeds — the polylines are frozen until a THEATER_VERSION bump', () => {
    const PINS: [number, number][] = [
      [7919, 2639127115],
      [15838, 3542962621],
      [23757, 1474489382],
      [31676, 377755694],
      [39595, 1407064749],
      [47514, 1970295962],
      [55433, 3865227822],
      [63352, 2446114249],
    ];
    for (const [base, hash] of PINS) expect(hashPlan(planRivers(base, 2, B)), `base ${base}`).toBe(hash);
  });

  it('regenerates byte-identically from the same base', () => {
    expect(planRivers(4242, 2, B)).toEqual(planRivers(4242, 2, B));
  });

  it('the main river spans the full height, stays inside the wander band, all integer metres', () => {
    for (let seed = 1; seed <= 32; seed++) {
      const [main] = planRivers(seed * 101, 2, B);
      expect(main.widthClass).toBe('river');
      expect(main.polyline[0].y).toBe(0);
      expect(main.polyline[main.polyline.length - 1].y).toBe(B.h);
      for (const p of main.polyline) {
        expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(0.2 * B.w);
        expect(p.x).toBeLessThanOrEqual(0.8 * B.w);
      }
    }
  });

  it('tributary count follows the density knob: 1→1-2, 2→2-3, 3→3-4', () => {
    for (const density of [1, 2, 3] as const) {
      for (let seed = 1; seed <= 32; seed++) {
        const tribs = planRivers(seed * 313, density, B).length - 1;
        expect(tribs, `density ${density} seed ${seed}`).toBeGreaterThanOrEqual(density);
        expect(tribs).toBeLessThanOrEqual(density + 1);
      }
    }
  });

  it('every tributary is a stream that rises at an exact main-river vertex', () => {
    for (let seed = 1; seed <= 32; seed++) {
      const [main, ...tribs] = planRivers(seed * 577, 3, B);
      const verts = new Set(main.polyline.map((p) => `${p.x},${p.y}`));
      for (const t of tribs) {
        expect(t.widthClass).toBe('stream');
        expect(verts.has(`${t.polyline[0].x},${t.polyline[0].y}`), `seed ${seed} trib ${t.id} joins mid-air`).toBe(true);
        expect(t.polyline.length).toBeGreaterThan(3);
        for (const p of t.polyline) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(B.w);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(B.h);
        }
      }
    }
  });

  it('names are empty — T_NAMES owns naming, keyed on geometry', () => {
    for (const r of planRivers(999, 2, B)) expect(r.name).toBe('');
  });
});
