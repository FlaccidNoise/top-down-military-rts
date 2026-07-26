import { describe, expect, it } from 'vitest';
import { bandFor, kitVariant, tier, weaponClass } from '../src/render/dudes';
import { SpriteCache } from '../src/render/spritecache';

// Guards for the bake scaffolding the unit art hangs off: the detail tier a
// band buys, the variant byte's tier gating (the thing that stops far bands
// multiplying the sprite keyspace), and the LRU's byte budget.

const canvas = (w: number, h: number): HTMLCanvasElement => ({ width: w, height: h }) as HTMLCanvasElement;

describe('detail tiers', () => {
  it('maps each bake band to its tier', () => {
    expect([6, 12, 24, 48].map(tier)).toEqual([0, 1, 2, 3]);
  });

  it('never bakes above the closest band', () => {
    expect(bandFor(3)).toBe(6);
    expect(bandFor(24)).toBe(24);
    expect(bandFor(25)).toBe(48);
    expect(bandFor(400)).toBe(48);
  });
});

describe('kitVariant', () => {
  it('is zero below tier 2, so far bands mint no extra cache entries', () => {
    for (const band of [6, 12]) {
      expect(kitVariant('leader', 9, band)).toBe(0);
      expect(kitVariant('aidman', 0, band)).toBe(0);
    }
  });

  it('carries the role bucket from tier 2', () => {
    expect(kitVariant('rifleman', 0, 24)).toBe(0);
    expect(kitVariant('aidman', 0, 24)).toBe(1);
    expect(kitVariant('leader', 0, 24)).toBe(2);
    expect(kitVariant('gunner', 0, 24)).toBe(3);
    expect(kitVariant('assistant', 0, 24)).toBe(3);
  });

  it('adds the veteran bit only at tier 3, and only with the xp for it', () => {
    expect(kitVariant('rifleman', 9, 24)).toBe(0); // band 24 draws no netting to tuck foliage under
    expect(kitVariant('rifleman', 2, 48)).toBe(0);
    expect(kitVariant('rifleman', 3, 48)).toBe(4);
    expect(kitVariant('gunner', 5, 48)).toBe(7);
  });
});

describe('weaponClass', () => {
  it('reports the sim silhouette bucket', () => {
    expect(weaponClass('garand')).toBe('rifle');
    expect(weaponClass('mp40')).toBe('smg');
    expect(weaponClass('mg42')).toBe('mg');
  });
});

describe('SpriteCache', () => {
  it('evicts by bytes, oldest first', () => {
    const c = new SpriteCache(4 * 100 * 100 * 4); // room for exactly four 100x100 canvases
    for (const k of ['a', 'b', 'c', 'd']) c.set(k, canvas(100, 100));
    expect(c.stats().entries).toBe(4);
    c.set('e', canvas(100, 100));
    expect(c.stats().entries).toBe(4);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('e')).toBeDefined();
    expect(c.stats().bytes).toBe(4 * 100 * 100 * 4);
  });

  it('a hit renews an entry, so the live set is not evicted under churn', () => {
    const c = new SpriteCache(2 * 10 * 10 * 4);
    c.set('a', canvas(10, 10));
    c.set('b', canvas(10, 10));
    c.get('a'); // 'a' is now the most recent, 'b' the oldest
    c.set('c', canvas(10, 10));
    expect(c.get('a')).toBeDefined();
    expect(c.get('b')).toBeUndefined();
  });

  it('counts big canvases against the budget, not entries', () => {
    const c = new SpriteCache(50_000);
    c.set('small', canvas(10, 10));
    c.set('huge', canvas(200, 200)); // 160 KB on its own
    expect(c.get('small')).toBeUndefined();
    expect(c.stats().entries).toBe(1); // the last entry is never evicted, oversized or not
  });
});
