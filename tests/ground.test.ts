import { describe, expect, it } from 'vitest';
import { cornerCuts, cutOnH, cutOnV, HARD, RELIEF_MAX, reliefShade, smoothElev, type ReliefLight } from '../src/render/ground';

// The ground's two anti-lattice passes (src/render/ground.ts). The tile grid
// showed through in two ways: a hillshade taken off whole-metre terraces, and
// staircase boundaries between kinds of ground. These pin the arithmetic that
// removes both, without a canvas.

const W = 64;
const H = 48;
// A hill as the sim stores it: whole metres, a step every 8 tiles going east.
const terraced = (): Uint8Array => {
  const e = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) e[y * W + x] = Math.min(4, Math.floor(x / 8));
  return e;
};
const LIGHT: ReliefLight = (() => {
  const len = Math.hypot(-0.6, -0.6, 0.84);
  return { x: -0.6 / len, y: -0.6 / len, z: 0.84 / len, flat: 0.84 / len };
})();

describe('smoothElev', () => {
  it('turns whole-metre terraces back into a slope: no tile-to-tile step survives', () => {
    const raw = terraced();
    const sm = smoothElev(raw, W, H);
    let rawStep = 0;
    let smStep = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W - 1; x++) {
        rawStep = Math.max(rawStep, Math.abs(raw[y * W + x + 1] - raw[y * W + x]));
        smStep = Math.max(smStep, Math.abs(sm[y * W + x + 1] - sm[y * W + x]));
      }
    expect(rawStep).toBe(1);
    expect(smStep).toBeLessThan(0.16);
  });

  it('leaves flat ground exactly flat, at any height', () => {
    for (const h of [0, 3]) {
      const sm = smoothElev(new Uint8Array(W * H).fill(h), W, H);
      for (const v of sm) expect(v).toBeCloseTo(h, 5);
    }
  });

  it('does not let a hill fall away at the map edge', () => {
    const sm = smoothElev(new Uint8Array(W * H).fill(2), W, H);
    expect(sm[0]).toBeCloseTo(2, 5);
    expect(sm[W * H - 1]).toBeCloseTo(2, 5);
  });

  it('keeps the hill where it was: the slope still climbs east', () => {
    const sm = smoothElev(terraced(), W, H);
    const row = 24 * W;
    for (let x = 1; x < W; x++) expect(sm[row + x]).toBeGreaterThanOrEqual(sm[row + x - 1] - 1e-6);
    expect(sm[row + W - 1] - sm[row]).toBeGreaterThan(3);
  });
});

describe('reliefShade', () => {
  it('is zero on level ground', () => {
    const sm = smoothElev(new Uint8Array(W * H).fill(1), W, H);
    expect(reliefShade(sm, W, H, 20, 20, LIGHT)).toBeCloseTo(0, 6);
  });

  it('lights the slope that faces the light and darkens the one that faces away', () => {
    // LIGHT comes from the north-west. Ground that climbs to the east tilts
    // its face west, toward it; the mirror-image hill tilts away.
    const east = smoothElev(terraced(), W, H);
    expect(reliefShade(east, W, H, 30, 24, LIGHT)).toBeGreaterThan(0);
    const west = Float32Array.from(east, (_, i) => east[Math.floor(i / W) * W + (W - 1 - (i % W))]);
    expect(reliefShade(west, W, H, 30, 24, LIGHT)).toBeLessThan(0);
  });

  it('varies smoothly across a terrace step instead of flashing one tile', () => {
    const sm = smoothElev(terraced(), W, H);
    for (let x = 9; x < 30; x++) {
      const d = Math.abs(reliefShade(sm, W, H, x + 1, 24, LIGHT) - reliefShade(sm, W, H, x, 24, LIGHT));
      expect(d, `x=${x}`).toBeLessThan(0.04);
    }
  });

  it('clamps past the map edge and never exceeds its ceiling', () => {
    const cliff = new Float32Array(W * H);
    for (let i = 0; i < cliff.length; i++) cliff[i] = (i % W) * 50;
    expect(Math.abs(reliefShade(cliff, W, H, 30, 24, LIGHT))).toBeLessThanOrEqual(RELIEF_MAX);
    for (const [x, y] of [[-3, -3], [W + 2, H + 2], [-1, 20]]) expect(Number.isFinite(reliefShade(cliff, W, H, x, y, LIGHT))).toBe(true);
  });
});

describe('cornerCuts', () => {
  const A = 1;
  const B = 2;
  it('cuts nothing on a straight boundary or inside one kind of ground', () => {
    expect(cornerCuts(A, A, A, A)).toBe(0);
    expect(cornerCuts(A, A, B, B)).toBe(0); // horizontal
    expect(cornerCuts(A, B, A, B)).toBe(0); // vertical
  });

  it('cuts the one tile that stands alone against the two beside it', () => {
    expect(cornerCuts(B, A, A, A)).toBe(1); // NW
    expect(cornerCuts(A, B, A, A)).toBe(2); // NE
    expect(cornerCuts(A, A, B, A)).toBe(4); // SW
    expect(cornerCuts(A, A, A, B)).toBe(8); // SE
  });

  it('leaves a saddle alone', () => {
    expect(cornerCuts(A, B, B, A)).toBe(0);
  });

  it('never cuts hard ground and never lets hard ground cut a neighbour', () => {
    expect(cornerCuts(HARD, A, A, A)).toBe(0); // a floor corner stays square
    expect(cornerCuts(A, HARD, HARD, A)).toBe(0);
    expect(cornerCuts(B, HARD, HARD, HARD)).toBe(0); // grass against a building
  });

  it('turns a staircase into one line: both ends of an edge cut it at the same point', () => {
    // The cut at corner (x, y) and the cut at corner (x+1, y) both end on the
    // horizontal edge between them, at cutOnH(x, y). One function, one point.
    for (let i = 0; i < 50; i++) {
      const h = cutOnH(i, i * 3);
      const v = cutOnV(i * 2, i);
      expect(h).toBe(cutOnH(i, i * 3));
      expect(h - i).toBeGreaterThanOrEqual(0.32);
      expect(h - i).toBeLessThanOrEqual(0.68);
      expect(v - i).toBeGreaterThanOrEqual(0.32);
      expect(v - i).toBeLessThanOrEqual(0.68);
    }
  });
});
