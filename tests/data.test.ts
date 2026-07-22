import { describe, expect, it } from 'vitest';
import { WEAPONS, type AmmoKey, type WeaponDef } from '../src/sim/data';

describe('weapon data', () => {
  const entries: [string, WeaponDef][] = Object.entries(WEAPONS);

  it('every ammo.type is a valid AmmoKey', () => {
    // compile-time check: this assignment fails to typecheck if a weapon's
    // ammo.type ever falls outside AmmoKey.
    for (const [, w] of entries) {
      const t: AmmoKey = w.ammo.type;
      expect(typeof t).toBe('string');
    }
  });

  it('damage ranges are ordered low <= high', () => {
    for (const [key, w] of entries) {
      expect(w.damage[0], key).toBeLessThanOrEqual(w.damage[1]);
    }
  });

  it('cooldown is positive', () => {
    for (const [key, w] of entries) {
      expect(w.cooldown, key).toBeGreaterThan(0);
    }
  });

  it('belt-fed weapons (perUnit >= 50) declare a heat model', () => {
    for (const [key, w] of entries) {
      if (w.ammo.perUnit >= 50) expect(w.heat, key).toBeDefined();
    }
  });

  it('mortars (arc) never carry a pen rating', () => {
    for (const [key, w] of entries) {
      if (w.arc) expect(w.pen, key).toBeUndefined();
    }
  });
});
