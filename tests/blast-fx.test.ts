import { describe, expect, it } from 'vitest';
import { BOOM } from '../src/render/audio';
import { BLAST, BLAST_FLOOR, blastOf, blastScale, FX_FLOOR, fxScale, lobHeight, throwShownFrom } from '../src/render/fx';
import type { BoomKind } from '../src/sim/sim';

// The sim names a blast (`kind`) and sizes most of them (`r`; a brew-up has
// none). The harness stages booms with neither. Every consumer has to survive
// both being absent, and garbage in either must never reach a draw call or an
// AudioParam: cosmetic code cannot be allowed to throw in the frame loop.
describe('blastOf', () => {
  it('draws a boom with no kind and no radius as the reference mortar', () => {
    const b = blastOf({});
    expect(b.kind).toBe('mortar');
    expect(b.spec).toBe(BLAST.mortar);
    expect(b.k).toBe(1);
  });

  it('falls back to the mortar row for a kind this build does not know', () => {
    const b = blastOf({ kind: 'nuke' as BoomKind });
    expect(b.kind).toBe('mortar');
  });

  it('draws at the reference size when the radius is unusable', () => {
    for (const r of [Number.NaN, 0, -3]) expect(blastOf({ kind: 'shell', r }).k, String(r)).toBe(1);
  });

  it('is 1 at the reference radius, grows with it, and stays inside its clamp', () => {
    for (const kind of Object.keys(BLAST) as BoomKind[]) {
      const ref = BLAST[kind].ref;
      expect(blastOf({ kind, r: ref }).k, kind).toBeCloseTo(1, 10);
      expect(blastOf({ kind, r: ref * 2 }).k, kind).toBeGreaterThan(1);
      expect(blastOf({ kind, r: ref / 2 }).k, kind).toBeLessThan(1);
      for (const r of [1e-9, 1e9, Infinity]) {
        const k = blastOf({ kind, r }).k;
        expect(k, `${kind} @ ${r}`).toBeGreaterThanOrEqual(0.45);
        expect(k, `${kind} @ ${r}`).toBeLessThanOrEqual(1.6);
      }
    }
  });
});

describe('BLAST recipes', () => {
  const kinds = Object.keys(BLAST) as BoomKind[];

  it('makes the tank kill the biggest fire on the field and the grenade the smallest', () => {
    for (const k of kinds) {
      expect(BLAST.brewup.fire, k).toBeGreaterThanOrEqual(BLAST[k].fire);
      expect(BLAST.grenade.fire, k).toBeLessThanOrEqual(BLAST[k].fire);
    }
  });

  it('keeps the smoke that a blast leaves behind alive longer than its fire', () => {
    for (const k of kinds) expect(BLAST[k].hang, k).toBeGreaterThan(BLAST[k].burn * 3);
  });

  it('gives every kind a voice, and leaves the unnamed blast the voice it always had', () => {
    expect(Object.keys(BOOM).sort()).toEqual([...kinds].sort());
    expect(BOOM.mortar).toMatchObject({ body: 200, bodyDecay: 0.55, bodyGain: 1.1, sub: 64, subDecay: 0.6, subGain: 0.9, crack: 1400, crackGain: 0.35 });
  });
});

describe('legibility floors', () => {
  it('never draws an effect smaller than true scale', () => {
    for (const s of [1.2, 2, 4, 8, 14, 20, 24, 48]) {
      expect(fxScale(s), String(s)).toBeGreaterThanOrEqual(s);
      expect(blastScale(s), String(s)).toBeGreaterThanOrEqual(s);
    }
  });

  it('holds the floor across the play zooms and lets go above it', () => {
    for (const s of [8, 10, 14, 20]) expect(fxScale(s), String(s)).toBe(FX_FLOOR);
    for (const s of [24, 32, 48]) expect(fxScale(s), String(s)).toBe(s);
    expect(blastScale(1.2)).toBe(BLAST_FLOOR);
  });

  it('eases down toward the whole-map view without ever stepping', () => {
    let prev = 0;
    for (let s = 1; s <= 48; s += 0.25) {
      const f = fxScale(s);
      expect(f, String(s)).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(fxScale(2)).toBeLessThan(FX_FLOOR);
  });
});

// A thrown grenade (fx.ts). Strict plan view: the renderer never lifts it up
// the screen, so its height exists only as how far its shadow stands off it.
describe('grenade throw', () => {
  it('leaves the hand and reaches the ground at height 0, highest at the middle', () => {
    expect(lobHeight(0, 10)).toBe(0);
    expect(lobHeight(1, 10)).toBe(0);
    expect(lobHeight(0.5, 10)).toBeCloseTo(2, 10); // 0.2 of a 10 m throw
    for (const t of [0.1, 0.3, 0.45]) {
      expect(lobHeight(t, 10)).toBeCloseTo(lobHeight(1 - t, 10), 10); // the shadow rejoins as it parted
      expect(lobHeight(t, 10)).toBeLessThan(lobHeight(0.5, 10));
    }
  });

  it('holds the apex between a reach and a rooftop', () => {
    expect(lobHeight(0.5, 1)).toBeCloseTo(1.2, 10); // a toss through a window still arcs
    expect(lobHeight(0.5, 12)).toBeCloseTo(2.4, 10);
    expect(lobHeight(0.5, 400)).toBe(4);
  });

  it('is 0 outside the flight and for garbage, so nothing non-finite reaches a draw call', () => {
    for (const t of [-0.2, 1.4, Number.NaN, Infinity]) expect(lobHeight(t, 10), String(t)).toBe(0);
    expect(lobHeight(0.5, Number.NaN)).toBe(0);
  });

  it('shows the player his own throws whole, and never an arc that points at a man he cannot see', () => {
    expect(throwShownFrom(true, false, false)).toBe(0);
    expect(throwShownFrom(false, true, false)).toBe(0); // he saw it leave
    expect(throwShownFrom(false, true, true)).toBe(0);
    const late = throwShownFrom(false, false, true); // he sees only where it lands
    expect(late).toBeGreaterThan(0.5);
    expect(late).toBeLessThan(1);
    expect(throwShownFrom(false, false, false)).toBe(1); // none of it
  });
});
