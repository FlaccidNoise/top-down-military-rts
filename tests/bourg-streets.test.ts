import { describe, expect, it } from 'vitest';
import { BOURG } from '../src/sim/bourg/profile';
import {
  buildSkeleton,
  growMinorStreets,
  segsFromTiles,
  subStream,
  tilesFromVerts,
  type Skeleton,
} from '../src/sim/bourg/streets';

// T4: the bourg street skeleton, standalone. Nothing here touches a GameMap —
// the whole stage is a `road` bitmap plus a Seg list, which is exactly why it
// can be tested before the generator that consumes it exists.

const base = (seed: number): number => (seed * 0x9e3779b1) >>> 1;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function town(seed: number, w = 320, h = 240, resv?: Uint8Array): Skeleton {
  const sk = buildSkeleton(base(seed), w, h, BOURG);
  growMinorStreets(sk, { resv: resv ?? new Uint8Array(w * h) });
  return sk;
}

// longest run, inside R_env, of columns where a fixed 3-row band is all road:
// §5.2's MG-lane cap, measured on the carved bitmap rather than on the Segs
function longest3WideRun(sk: Skeleton): number {
  const { w, road, env } = sk;
  let best = 0;
  for (let y = env.y + 1; y < env.y + env.h - 1; y++) {
    let run = 0;
    for (let x = env.x; x < env.x + env.w; x++) {
      const solid = road[(y - 1) * w + x] && road[y * w + x] && road[(y + 1) * w + x];
      run = solid ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  for (let x = env.x + 1; x < env.x + env.w - 1; x++) {
    let run = 0;
    for (let y = env.y; y < env.y + env.h; y++) {
      const solid = road[y * w + x - 1] && road[y * w + x] && road[y * w + x + 1];
      run = solid ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  return best;
}

function roadComponents(sk: Skeleton): number {
  const { w, h, road } = sk;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let comps = 0;
  for (let s = 0; s < road.length; s++) {
    if (!road[s] || seen[s]) continue;
    comps++;
    let head = 0;
    let tail = 0;
    seen[s] = 1;
    queue[tail++] = s;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (const n of [cx > 0 ? cur - 1 : -1, cx + 1 < w ? cur + 1 : -1, cy > 0 ? cur - w : -1, cy + 1 < h ? cur + w : -1]) {
        if (n < 0 || seen[n] || !road[n]) continue;
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
  }
  return comps;
}

describe('bourg streets (T4)', () => {
  it('is deterministic: same base → identical segs, streets and road bitmap', () => {
    for (const seed of [1, 7, 13]) {
      const a = town(seed);
      const b = town(seed);
      expect(a.segs).toEqual(b.segs);
      expect(a.road).toEqual(b.road);
      expect(a.place).toEqual(b.place);
      expect(a.env).toEqual(b.env);
      expect(a.archetype).toBe(b.archetype);
    }
  });

  // D2 made real: the growth loop draws from S(5), so no amount of stage-5
  // work can move the skeleton stage 3 laid down. Two different reservation
  // masks make the growth loop take wildly different paths; the Grande Rue,
  // the envelope and the place must come out bit-identical anyway.
  it('stage 5 cannot move stage 3 (sub-stream independence)', () => {
    for (const seed of SEEDS) {
      const plain = buildSkeleton(base(seed), 320, 240, BOURG);
      const grande = JSON.stringify(plain.grandeRue);
      const rank0 = JSON.stringify(plain.segs.filter((s) => s.rank === 0));
      const blocked = new Uint8Array(320 * 240);
      for (let i = 0; i < blocked.length; i++) if (((i % 320) & 8) !== 0) blocked[i] = 1;
      const a = town(seed);
      const b = town(seed, 320, 240, blocked);
      expect(a.grandeRue).toEqual(plain.grandeRue);
      expect(JSON.stringify(b.grandeRue)).toBe(grande);
      expect(JSON.stringify(b.segs.filter((s) => s.rank === 0))).toBe(rank0);
      expect(b.place).toEqual(a.place);
      expect(b.env).toEqual(a.env);
    }
  });

  it('derives sub-streams by golden-ratio spacing, not by adding the tag', () => {
    // base + tag would give S(3) and S(4) the same generator for different
    // bases one apart; the xor-imul spacing must not.
    for (const b of [0, 1, 12345, 0x7ffffffe]) {
      const seen = new Set<number>();
      for (let tag = 1; tag <= 14; tag++) seen.add(subStream(b, tag).int(1 << 30));
      expect(seen.size).toBe(14);
    }
    expect(subStream(5, 3).next()).not.toBe(subStream(6, 2).next());
  });

  it('every segment is axis-aligned and agrees with its own axis field', () => {
    for (const seed of SEEDS)
      for (const s of town(seed).segs) {
        if (s.axis === 'h') expect(s.ay).toBe(s.by);
        else expect(s.ax).toBe(s.bx);
      }
  });

  it('no straight run of the Grande Rue exceeds 45 tiles (§1.4 MG-lane cap)', () => {
    for (const seed of SEEDS)
      for (const s of town(seed).grandeRue) {
        const len = s.axis === 'h' ? Math.abs(s.bx - s.ax) : Math.abs(s.by - s.ay);
        expect(len).toBeLessThanOrEqual(45);
      }
  });

  // §5.2's bitmap proxy for the same cap. It over-counts by the width of
  // whatever street T-joins at the end of a run: a 45-tile Grande Rue run
  // meeting a 2-wide side street reads as 47, because the side street's own
  // columns continue all three of the Grande Rue's rows through the junction.
  // The DESIGN constraint (§1.4) is the Seg cap asserted above and it holds
  // exactly; 48 = 45 + the widest possible crossing is the honest bound on the
  // proxy. Measured over 500 seeds: worst 47, and only 5 seeds exceed 45 at all.
  it('no 3-wide straight road band inside R_env exceeds 45 + one crossing', () => {
    for (const seed of SEEDS) expect(longest3WideRun(town(seed))).toBeLessThanOrEqual(48);
  });

  // A tangent street that does not touch what it grew from, or an approach
  // route whose staircase falls off the carve, shows up here and nowhere else.
  it('the carved network is a single 4-connected component', () => {
    for (const seed of SEEDS) expect(roadComponents(town(seed))).toBe(1);
  });

  it('the place is on the carved road, inside R_env, and on the Grande Rue', () => {
    for (const seed of SEEDS) {
      const sk = town(seed);
      expect(sk.road[sk.place.y * sk.w + sk.place.x]).toBe(1);
      expect(sk.place.x).toBeGreaterThanOrEqual(sk.env.x);
      expect(sk.place.x).toBeLessThan(sk.env.x + sk.env.w);
      expect(sk.place.y).toBeGreaterThanOrEqual(sk.env.y);
      expect(sk.place.y).toBeLessThan(sk.env.y + sk.env.h);
      const run = sk.grandeRue.find((s) => s.axis === 'h' && sk.place.x >= Math.min(s.ax, s.bx) && sk.place.x <= Math.max(s.ax, s.bx));
      expect(run?.ay).toBe(sk.place.y);
    }
  });

  it('respects the growth cap and reaches the growth floor on all but tiny maps', () => {
    for (const seed of SEEDS) {
      const sk = town(seed);
      expect(sk.streets.length).toBeGreaterThanOrEqual(2);
      expect(sk.streets.length).toBeLessThanOrEqual(24);
    }
  });

  it('produces all four archetypes at roughly the documented weights', () => {
    const count: Record<string, number> = { carrefour: 0, bourgRue: 0, enclos: 0, faubourg: 0 };
    for (let seed = 1; seed <= 200; seed++) count[buildSkeleton(base(seed), 320, 240, BOURG).archetype]++;
    for (const k of Object.keys(count)) expect(count[k]).toBeGreaterThan(0);
    expect(count.carrefour + count.bourgRue).toBeGreaterThan(100); // 0.70 of 200
    expect(count.faubourg).toBeLessThan(40); // 0.10 of 200
  });

  it('survives the smallest map generateMap allows, and the mid size', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3, 4, 5]) {
        const sk = town(seed, w, h);
        expect(sk.env.x).toBeGreaterThanOrEqual(6);
        expect(sk.env.x + sk.env.w).toBeLessThanOrEqual(w - 6);
        expect(sk.env.y + sk.env.h).toBeLessThanOrEqual(h - 6);
        expect(roadComponents(sk)).toBe(1);
      }
  });

  it('tilesFromVerts and segsFromTiles round-trip a jogged polyline', () => {
    const verts = [
      { x: 4, y: 4 },
      { x: 12, y: 4 },
      { x: 12, y: 7 },
      { x: 20, y: 7 },
    ];
    const tiles = tilesFromVerts(verts);
    expect(tiles.length).toBe(8 + 3 + 8 + 1);
    const segs = segsFromTiles(tiles, 3, 1, 0);
    expect(segs.map((s) => `${s.axis}${s.ax},${s.ay}→${s.bx},${s.by}`)).toEqual([
      'h4,4→12,4',
      'v12,4→12,7',
      'h12,7→20,7',
    ]);
    expect(() => tilesFromVerts([{ x: 0, y: 0 }, { x: 3, y: 3 }])).toThrow(/diagonal/);
  });
});
