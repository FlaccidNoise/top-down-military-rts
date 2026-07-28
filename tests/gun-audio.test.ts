import { describe, expect, it } from 'vitest';
import { WEAPONS, type WeaponDef, type WeaponKey } from '../src/sim/data';
import { GUN } from '../src/render/audio';

// Drift tripwire for the gunfire layer. The audio table is keyed per weapon,
// so a new weapon that never reaches the table would fall back to silence-by-
// accident, and a small arm without a fireMode would be voiced as artillery.
//
// Small arms are the weapons with no `pen` and no `arc`: `class` is the
// silhouette bucket, and it calls the bazooka and both mortars 'rifle'.

const entries = Object.entries(WEAPONS) as [WeaponKey, WeaponDef][];
const smallArm = (w: WeaponDef): boolean => w.pen === undefined && w.arc === undefined;

describe('fireMode data', () => {
  it('every small arm declares a fireMode', () => {
    for (const [key, w] of entries) {
      if (smallArm(w)) expect(w.fireMode, key).toBeDefined();
    }
  });

  it('rockets, mortars and AT guns declare none — they keep the rocket/cannon presets', () => {
    for (const [key, w] of entries) {
      if (!smallArm(w)) expect(w.fireMode, key).toBeUndefined();
    }
  });
});

describe('GUN audio table', () => {
  it('covers every WeaponKey, and nothing else', () => {
    expect(Object.keys(GUN).sort()).toEqual(Object.keys(WEAPONS).sort());
  });

  it('voices burst and auto weapons as bursts at a cyclic spacing', () => {
    for (const [key, w] of entries) {
      if (w.fireMode !== 'burst' && w.fireMode !== 'auto') continue;
      expect(GUN[key].taps ?? 1, key).toBeGreaterThan(1);
      expect(GUN[key].spacing ?? 0, key).toBeGreaterThan(0);
    }
  });

  it('voices bolt and semi weapons as one report, and cycles the bolt-actions', () => {
    for (const [key, w] of entries) {
      if (w.fireMode !== 'bolt' && w.fireMode !== 'semi') continue;
      expect(GUN[key].taps ?? 1, key).toBe(1);
      expect(GUN[key].bolt ?? false, key).toBe(w.fireMode === 'bolt');
    }
  });

  it('gives the two scoped rifles a deeper, louder, longer report than a plain Kar98k', () => {
    for (const key of ['springfield', 'kar98k_scoped'] as const) {
      expect(GUN[key].freq, key).toBeLessThan(GUN.kar98k.freq);
      expect(GUN[key].gain, key).toBeGreaterThan(GUN.kar98k.gain);
      expect(GUN[key].decay, key).toBeGreaterThan(GUN.kar98k.decay);
      expect(GUN[key].tail, key).toBeGreaterThan(0);
    }
  });
});
