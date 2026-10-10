import { describe, expect, it } from 'vitest';
import { BOOM } from '../src/render/audio';
import { BLAST, BLAST_FLOOR, blastOf, blastScale, FX_FLOOR, fxScale, type BlastKind } from '../src/render/fx';

// The sim names a blast (`kind`) and sizes it (`r`) on output-only fields that
// older builds and the harness may not send. Every consumer has to survive
// both being absent, and garbage in either must never reach a draw call or an
// AudioParam: cosmetic code cannot be allowed to throw in the frame loop.
describe('blastOf', () => {
  it('draws a boom with no kind and no radius as the reference mortar', () => {
    const b = blastOf({ x: 1, y: 2 });
    expect(b.kind).toBe('mortar');
    expect(b.spec).toBe(BLAST.mortar);
    expect(b.k).toBe(1);
  });

  it('falls back to the mortar row for a kind this build does not know', () => {
    const b = blastOf({ x: 0, y: 0, kind: 'nuke' as BlastKind });
    expect(b.kind).toBe('mortar');
  });

  it('draws at the reference size when the radius is unusable', () => {
    for (const r of [Number.NaN, 0, -3]) expect(blastOf({ x: 0, y: 0, kind: 'shell', r }).k, String(r)).toBe(1);
  });

  it('is 1 at the reference radius, grows with it, and stays inside its clamp', () => {
    for (const kind of Object.keys(BLAST) as BlastKind[]) {
      const ref = BLAST[kind].ref;
      expect(blastOf({ x: 0, y: 0, kind, r: ref }).k, kind).toBeCloseTo(1, 10);
      expect(blastOf({ x: 0, y: 0, kind, r: ref * 2 }).k, kind).toBeGreaterThan(1);
      expect(blastOf({ x: 0, y: 0, kind, r: ref / 2 }).k, kind).toBeLessThan(1);
      for (const r of [1e-9, 1e9, Infinity]) {
        const k = blastOf({ x: 0, y: 0, kind, r }).k;
        expect(k, `${kind} @ ${r}`).toBeGreaterThanOrEqual(0.45);
        expect(k, `${kind} @ ${r}`).toBeLessThanOrEqual(1.6);
      }
    }
  });
});

describe('BLAST recipes', () => {
  const kinds = Object.keys(BLAST) as BlastKind[];

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
