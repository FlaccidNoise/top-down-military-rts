import { describe, expect, it } from 'vitest';
import { WEAPONS, type WeaponDef, type WeaponKey } from '../src/sim/data';
import { GUN, gunOf, tapsOf } from '../src/render/audio';
import { FLASH, flashClass } from '../src/render/fx';

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

// The renderer strobes one muzzle flash per tap off gunOf/tapsOf, the same two
// functions gunshot() voices a burst with. These pin the contract between the
// ear and the eye: what a ShotEvent sounds like is what it looks like.
describe('burst timing shared by the audio and the muzzle flashes', () => {
  it('reads a burst straight off the GUN table', () => {
    for (const [key] of entries) {
      expect(gunOf(key), key).toBe(GUN[key]);
      expect(tapsOf(GUN[key]), key).toBe(GUN[key].taps ?? 1);
    }
    expect(tapsOf(GUN.mg42)).toBe(5);
    expect(GUN.mg42.spacing).toBe(0.05);
  });

  it('gives a vehicle main gun, which carries no weapon key, one report', () => {
    expect(tapsOf(gunOf(undefined))).toBe(1);
  });

  it('never strobes a weapon whose flash is a single-shot signature', () => {
    // A back-blast or a muzzle wash repeated five times a burst would be a
    // different weapon. Only plain flashes may belong to a multi-tap gun.
    for (const [key] of entries) {
      if (tapsOf(GUN[key]) > 1) expect(FLASH[flashClass(key)].extra, key).toBeUndefined();
    }
  });

  it('keeps a burst short enough that its last flash is out before the next attack', () => {
    // Longest burst in the table: taps * spacing. Past ~half a second the
    // strobe of one ShotEvent would run into the next.
    for (const [key] of entries) expect((tapsOf(GUN[key]) - 1) * (GUN[key].spacing ?? 0), key).toBeLessThan(0.45);
  });
});

// A crash reported from production: a non-finite gain reached AudioParam.value
// and threw INSIDE the frame loop, which aborts the rest of the frame — so it
// cost the game its drawing and HUD update too (seen as high-speed flicker)
// before it died. Sound is cosmetic; it must never be able to throw.
describe('placement never yields a non-finite AudioParam value', () => {
  // place() is private, so drive the arithmetic it does, with the same
  // NaN-safe comparisons. This pins the SHAPE of the fix: a comparison that
  // culls on NaN rather than one NaN slips through.
  const place = (sx: number, sy: number, cw: number, ch: number): [number, number] | null => {
    if (!(cw > 0) || !(ch > 0)) return null;
    const half = Math.hypot(cw, ch) / 2;
    const nd = Math.hypot(sx - cw / 2, sy - ch / 2) / half;
    if (!(nd <= 2.6)) return null;
    const gain = Math.max(0.08, 1 - nd * 0.62);
    const pan = Math.max(-1, Math.min(1, (sx - cw / 2) / (cw / 2)));
    return Number.isFinite(gain) && Number.isFinite(pan) ? [gain, pan] : null;
  };

  it('culls a zero-area viewport instead of producing NaN', () => {
    // `view` starts {w:0,h:0} and a frame can run before the first resize.
    // The old cull was `nd > 2.6`, which is FALSE for NaN — the whole bug.
    expect(place(0, 0, 0, 0)).toBeNull();
    expect(place(100, 100, 0, 800)).toBeNull();
  });

  it('culls NaN screen coordinates (a NaN camera or a NaN world position)', () => {
    expect(place(NaN, 400, 1280, 800)).toBeNull();
    expect(place(640, NaN, 1280, 800)).toBeNull();
  });

  it('still places an ordinary on-screen shot, and still culls a far off-screen one', () => {
    const centre = place(640, 400, 1280, 800)!;
    expect(centre[0]).toBeCloseTo(1, 6); // dead centre = full gain
    expect(centre[1]).toBeCloseTo(0, 6);
    const edge = place(1280, 400, 1280, 800)!;
    expect(edge[1]).toBeCloseTo(1, 6); // hard right
    expect(place(99999, 99999, 1280, 800)).toBeNull();
  });
});
