import { describe, expect, it } from 'vitest';
import { chunkSpan } from '../src/render/terrain';
import { Versions } from '../src/render/versions';

// D9. The two pure halves of the dirty-chunk mechanism: the staleness record
// the sun steps will reuse, and the neighbourhood arithmetic that decides which
// baked chunks a one-byte edge write invalidates. The pixels themselves are
// judged through scripts/shot.mjs; what a unit test can hold down is that the
// arithmetic covers every chunk that actually draws the edge — miss one and the
// old wall survives in a neighbour's overscan gutter as a floating stub.

const CHUNK = 16;
const PAD = 2;

// The bake range from terrain.ts's own `chunk()`: tiles [c*CHUNK - PAD,
// c*CHUNK + CHUNK + PAD], with the edge loops running to the inclusive bound.
function drawnBy(c: number, t: number): boolean {
  return t >= c * CHUNK - PAD && t <= c * CHUNK + CHUNK + PAD;
}

describe('Versions', () => {
  it('answers 0 everywhere until something is bumped', () => {
    const v = new Versions();
    expect(v.at(0)).toBe(0);
    expect(v.at(9999)).toBe(0);
  });

  it('bump moves one key and leaves every other alone', () => {
    const v = new Versions();
    v.bump(7);
    expect(v.at(7)).not.toBe(0);
    expect(v.at(8)).toBe(0);
    const seen = v.at(7);
    v.bump(8);
    expect(v.at(7)).toBe(seen); // a neighbour's breach does not restale mine
  });

  it('every bump is a fresh value, so a rebake cannot land on a stale stamp', () => {
    const v = new Versions();
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      v.bump(i % 5);
      seen.add(v.at(i % 5));
    }
    expect(seen.size).toBe(50);
  });

  it('bumpAll stales every key at once, including ones never touched', () => {
    const v = new Versions();
    v.bump(3);
    const before = [0, 1, 2, 3].map((k) => v.at(k));
    v.bumpAll();
    const after = [0, 1, 2, 3].map((k) => v.at(k));
    for (let i = 0; i < 4; i++) expect(after[i]).not.toBe(before[i]);
    expect(new Set(after).size).toBe(1); // one epoch, one stamp
  });

  it('a per-key bump after a global one still reads as newer', () => {
    const v = new Versions();
    v.bumpAll();
    const epoch = v.at(4);
    v.bump(4);
    expect(v.at(4)).not.toBe(epoch);
    expect(v.at(5)).toBe(epoch);
  });
});

describe('chunkSpan', () => {
  const N = 20; // chunks along the axis — 320 tiles

  it('covers every chunk whose overscan draws the tile', () => {
    for (let t = 0; t < N * CHUNK; t++) {
      const [lo, hi] = chunkSpan(t, t, N);
      for (let c = 0; c < N; c++) {
        if (drawnBy(c, t)) expect(c >= lo && c <= hi).toBe(true);
      }
    }
  });

  it('never invalidates more than two chunks per axis for one edge', () => {
    for (let t = 0; t < N * CHUNK; t++) {
      const [lo, hi] = chunkSpan(t, t, N);
      expect(hi - lo).toBeLessThanOrEqual(1);
    }
  });

  it('straddles the seam exactly at a chunk boundary and nowhere in the middle', () => {
    expect(chunkSpan(8, 8, N)).toEqual([0, 0]); // mid-chunk: one chunk only
    expect(chunkSpan(16, 16, N)).toEqual([0, 1]); // on the seam: both
    expect(chunkSpan(15, 15, N)).toEqual([0, 1]); // inside chunk 1's overscan
    expect(chunkSpan(13, 13, N)).toEqual([0, 0]); // just outside it
  });

  it('clamps to the map instead of naming chunks that do not exist', () => {
    expect(chunkSpan(0, 0, N)[0]).toBe(0);
    expect(chunkSpan(N * CHUNK - 1, N * CHUNK - 1, N)[1]).toBe(N - 1);
  });

  it('a tile range spans from its first chunk to its last', () => {
    expect(chunkSpan(40, 100, N)).toEqual([2, 6]);
  });
});
