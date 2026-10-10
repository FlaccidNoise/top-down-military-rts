import { describe, expect, it } from 'vitest';
import { awningStripes } from '../src/render/shops';

// The palette rule (docs/decisions, "Muted Normandy"): an awning reads by
// shape and shadow, not colour. The first cut alternated the brightest pixel
// in a town with a stripe more saturated than the roofs beside it.

const hsv = (css: string): { s: number; v: number } => {
  const [r, g, b] = css.match(/\d+/g)!.map(Number);
  const hi = Math.max(r, g, b);
  return { s: hi === 0 ? 0 : (hi - Math.min(r, g, b)) / hi, v: hi / 255 };
};
const TUILE_SAT = 0.46; // roofs.ts tile '#6f4a3c'

describe('awningStripes', () => {
  it('keeps both stripes under the roofs: no stripe more saturated than tuile, no pale stripe a highlight', () => {
    for (let seed = 0; seed < 400; seed++) {
      const [dyed, pale] = awningStripes(seed * 131);
      expect(hsv(dyed).s).toBeLessThanOrEqual(TUILE_SAT);
      expect(hsv(pale).s).toBeLessThan(0.2);
      expect(hsv(pale).v).toBeLessThan(0.64);
      // still two stripes: the dyed one is the darker
      expect(hsv(pale).v - hsv(dyed).v).toBeGreaterThan(0.07);
    }
  });

  it('varies by shop, in dye and in fade, and is the same for a shop every time', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) seen.add(awningStripes(seed * 977)[0]);
    expect(seen.size).toBeGreaterThan(30);
    expect(awningStripes(4578)).toEqual(awningStripes(4578));
  });
});
