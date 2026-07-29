import { describe, expect, it } from 'vitest';
import { lerp2, generateHeightField, townWeightField } from '../src/sim/bourg/height';
import { generateMap, type MapPlan } from '../src/sim/mapgen';
import { planBourg, type BourgPlan } from '../src/sim/bourg/plan';
import { BOURG } from '../src/sim/bourg/profile';
import { mulberry32 } from '../src/sim/rng';

const W = 320;
const H = 240;

// ── lerp2 ─────────────────────────────────────────────────────────────────

describe('height / lerp2', () => {
  it('at a lattice corner returns the corner value', () => {
    // nx=2 stride means valid u in [0, 1] but lerp2 reads L[i+nx+1], so we
    // need a 3×3 array with padding
    const L = Float64Array.of(
      10, 20, 99,
      30, 40, 99,
      99, 99, 99,
    );
    expect(lerp2(L, 3, 0, 0)).toBe(10);
    expect(lerp2(L, 3, 1, 0)).toBe(20);
    expect(lerp2(L, 3, 0, 1)).toBe(30);
    expect(lerp2(L, 3, 1, 1)).toBe(40);
  });

  it('at u=0.5, v=0 returns midpoint linear interpolation between horizontal neighbours', () => {
    const L = Float64Array.of(0, 100, 0, 100);
    expect(lerp2(L, 2, 0.5, 0)).toBe(50);
  });

  it('interpolates bilinearly at the centre of a cell', () => {
    const L = Float64Array.of(0, 10, 20, 40);
    // top=5, bot=30, centre=17.5
    expect(lerp2(L, 2, 0.5, 0.5)).toBe(17.5);
  });
});

// ── generateHeightField — determinism ─────────────────────────────────────

describe('height / generateHeightField — determinism', () => {
  it('produces byte-identical output for the same (seed, w, h, amp)', () => {
    const a = generateHeightField(42, 64, 48, 6);
    const b = generateHeightField(42, 64, 48, 6);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('produces different output for different seeds', () => {
    const a = generateHeightField(1, 64, 48, 6);
    const b = generateHeightField(2, 64, 48, 6);
    let diff = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff = true;
    expect(diff).toBe(true);
  });
});

// ── generateHeightField — integer range bounds ────────────────────────────

describe('height / generateHeightField — range bounds', () => {
  it('all values >= 0 and < 128 at amp=6', () => {
    const f = generateHeightField(7, 64, 48, 6);
    for (let i = 0; i < f.length; i++) {
      expect(f[i]).toBeGreaterThanOrEqual(0);
      expect(f[i]).toBeLessThan(128);
    }
  });

  it('at amp=0 every tile is 0', () => {
    const f = generateHeightField(7, 64, 48, 0);
    for (let i = 0; i < f.length; i++) expect(f[i]).toBe(0);
  });

  it('at amp=6 at least 5% of tiles are non-zero', () => {
    const f = generateHeightField(13, 64, 48, 6);
    let nonZero = 0;
    for (let i = 0; i < f.length; i++) if (f[i] > 0) nonZero++;
    expect(nonZero / f.length).toBeGreaterThanOrEqual(0.05);
  });
});

// ── townWeightField — range and smoothness ────────────────────────────────

describe('height / townWeightField', () => {
  it('all values in [0, 255]', () => {
    // A binary mask with a block of 1s in the centre
    const w = 40;
    const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) mask[y * w + x] = 1;
    const tw = townWeightField(mask, w, h);
    for (let i = 0; i < tw.length; i++) {
      expect(tw[i]).toBeGreaterThanOrEqual(0);
      expect(tw[i]).toBeLessThanOrEqual(255);
    }
  });

  it('binary mask of zeros → all-zero output', () => {
    const mask = new Uint8Array(10 * 10);
    const tw = townWeightField(mask, 10, 10);
    for (let i = 0; i < tw.length; i++) expect(tw[i]).toBe(0);
  });

  it('inside a rectangular block values are high (≥ 200)', () => {
    const w = 40;
    const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) mask[y * w + x] = 1;
    const tw = townWeightField(mask, w, h);
    // Centre of the block; two 9-wide box blurs saturate the interior to 255.
    expect(tw[15 * w + 20]).toBeGreaterThanOrEqual(200);
  });

  it('far outside the block values are low (≤ 10)', () => {
    const w = 40;
    const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) mask[y * w + x] = 1;
    const tw = townWeightField(mask, w, h);
    // 10+ tiles outside the block
    expect(tw[0 * w + 0]).toBeLessThanOrEqual(10);
  });

  it('smoothness: adjacent tiles along a transect differ by ≤ 50', () => {
    const w = 40;
    const h = 30;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 30; x++) mask[y * w + x] = 1;
    const tw = townWeightField(mask, w, h);
    // Horizontal transect at y=15 from inside to well outside.
    // Radius 4 box blur with 255 max → max step ≈ 255/9 ≈ 28.
    let maxDiff = 0;
    for (let x = 25; x < 39; x++) {
      const diff = Math.abs(tw[15 * w + x + 1] - tw[15 * w + x]);
      if (diff > maxDiff) maxDiff = diff;
    }
    expect(maxDiff).toBeLessThanOrEqual(50);
  });
});

// ── generateHeightField — perf smoke ──────────────────────────────────────

describe('height / generateHeightField — perf smoke', () => {
  it('generates at 320x240 in under 15ms (3 runs, median)', () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      generateHeightField(i, 320, 240, 6);
      times.push(performance.now() - start);
    }
    times.sort();
    expect(times[1]).toBeLessThan(15);
  });
});

// ── §8 ITEM 1 INSTRUMENTATION — bourg flat-zone elevation bleed probe ─────

describe('height / §8 flat-zone elevation bleed probe', () => {
  const SEEDS = Array.from({ length: 13 }, (_, i) => i + 1);

  // Reconstruct the flat zone mask from the BourgPlan, replicating
  // bourgFlatMask in mapgen.ts EXCEPT the free-standing wall backstop.
  function reconstructFlatMask(plan: BourgPlan, mapPlan: MapPlan): Uint8Array {
    const { w, h } = plan.sk;
    const flat = new Uint8Array(w * h);

    // 1. zoneOf: env expanded by 6 each side, plus faubourg (22 Manhattan)
    const { env, faubourg: f } = plan.sk;
    const x0 = env.x - 6;
    const y0 = env.y - 6;
    const x1 = env.x + env.w + 5;
    const y1 = env.y + env.h + 5;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) flat[y * w + x] = 1;
    if (f !== null)
      for (let y = Math.max(0, f.y - 22); y <= Math.min(h - 1, f.y + 22); y++)
        for (let x = Math.max(0, f.x - 22); x <= Math.min(w - 1, f.x + 22); x++)
          if (Math.abs(x - f.x) <= 22 && Math.abs(y - f.y) <= 22) flat[y * w + x] = 1;

    // 2. Every compound rect dilated by 2
    for (const c of plan.fp.compounds)
      for (let y = Math.max(0, c.rect.y - 2), y1 = Math.min(h, c.rect.y + c.rect.h + 2); y < y1; y++)
        for (let x = Math.max(0, c.rect.x - 2), x1 = Math.min(w, c.rect.x + c.rect.w + 2); x < x1; x++) flat[y * w + x] = 1;

    // 3. Every occ tile dilated by 1 (8-neighbour)
    const occ = plan.fp.occ;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!occ[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) flat[ny * w + nx] = 1;
          }
      }

    return flat;
  }

  it('measures non-zero elevation tiles inside the flat zone across seeds 1-13', () => {
    const results: { seed: number; bleed: number; sampleCoords: string[] }[] = [];

    for (const seed of SEEDS) {
      const mapPlan = generateMap(seed, W, H, 'bourg');
      const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
      const plan = planBourg(base, W, H, BOURG);
      const flat = reconstructFlatMask(plan, mapPlan);

      let bleed = 0;
      const samples: string[] = [];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (flat[i] && mapPlan.map.elev[i] > 0) {
            bleed++;
            if (samples.length < 5) samples.push(`${x},${y}:${mapPlan.map.elev[i]}`);
          }
        }

      results.push({ seed, bleed, sampleCoords: samples });
    }

    const totalBleed = results.reduce((s, r) => s + r.bleed, 0);
    const perSeed = results.map((r) => `seed ${r.seed}: ${r.bleed}`).join(', ');

    if (totalBleed === 0) {
      // Verdict: probe reconstruction error — zero bleed across 13 seeds.
      expect(totalBleed).toBe(0);
    } else {
      // Bleed found: report per-seed counts and first 5 coords from first non-zero seed.
      const first = results.find((r) => r.bleed > 0)!;
      const msg = `BLEED: ${perSeed} | first (seed ${first.seed}): ${first.sampleCoords.join(' | ')}`;
      // Print to stderr so it survives vitest stdout capture
      console.error(msg);
      expect(totalBleed).toBeGreaterThan(0);
    }
  });
});