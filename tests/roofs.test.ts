import { describe, expect, it } from 'vitest';
import { generateMap, type Building } from '../src/sim/mapgen';
import { artContexts, artKey, bakeBudgetMs, nextBake, onOutline, pickMat } from '../src/render/roofs';

// Lane B, T15 / T17 / T22. Everything here is the PURE half of roofs.ts — the
// decisions the bake reads off, with no canvas in sight. The pixels are judged
// through scripts/sweep.mjs; what a unit test can hold down is that the church
// is always a church, that a party-wall range agrees with itself, and that the
// bake queue serves the camera before it serves the array.

const W = 320;
const H = 240;
const SEED = 10; // the seed sweep.mjs forces to 'bourg'

const bourg = generateMap(SEED, W, H, 'bourg');
const stories = bourg.buildings.map(() => 1);

function byRole(role: string): Building[] {
  return bourg.buildings.filter((b) => b.role === role);
}

function runsOf(buildings: Building[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  buildings.forEach((b, i) => {
    if (b.terraceRun === undefined) return;
    m.set(b.terraceRun, [...(m.get(b.terraceRun) ?? []), i]);
  });
  return m;
}

describe('roof art key (N8)', () => {
  it('is unique per building across a whole bourg', () => {
    const keys = bourg.buildings.map(artKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not move when the buildings list is reordered', () => {
    // The whole point: the bourg emits in geometric order, and the day that
    // order changes every roof in the town must NOT change material.
    const before = new Map(bourg.buildings.map((b) => [b, artKey(b)]));
    const shuffled = [...bourg.buildings].reverse();
    for (const b of shuffled) expect(artKey(b)).toBe(before.get(b));
  });

  it('is stable across two generations of the same seed', () => {
    const again = generateMap(SEED, W, H, 'bourg');
    expect(again.buildings.map(artKey)).toEqual(bourg.buildings.map(artKey));
  });
});

describe('pickMat roles (T15)', () => {
  const keys = Array.from({ length: 400 }, (_, i) => i * 7919);

  it('roofs every church mass in slate, whatever the key rolls', () => {
    for (const role of ['church', 'church_tower', 'church_apse']) {
      for (const k of keys) {
        expect(pickMat(k, 1, false, role)).toBe('slate');
        expect(pickMat(k, 4, true, role)).toBe('slate');
      }
    }
  });

  it('never thatches a street role or a civic one', () => {
    for (const role of ['townhouse', 'shop', 'civic', 'halle']) {
      for (const k of keys) expect(pickMat(k, 1, true, role)).not.toBe('thatch');
    }
  });

  it('leaves a bare footprint (every legacy kind) on the old house rules', () => {
    // legacy maps emit no role at all — the outbuilding heuristic must survive
    const mats = new Set(keys.map((k) => pickMat(k, 1, true, 'house')));
    expect(mats.has('thatch')).toBe(true);
    expect(mats.has('iron')).toBe(true);
  });
});

describe('artContexts: the church group (T15)', () => {
  const ctx = artContexts(bourg.buildings, stories);
  const idxOf = (role: string): number => bourg.buildings.findIndex((b) => b.role === role);

  it('emits a nave, a tower and an apse sharing one groupId', () => {
    expect(byRole('church')).toHaveLength(1);
    expect(byRole('church_tower')).toHaveLength(1);
    const gids = new Set(bourg.buildings.filter((b) => b.role?.startsWith('church')).map((b) => b.groupId));
    expect(gids.size).toBe(1);
  });

  it('runs the apse ridge on the nave axis and butts the two together', () => {
    const nave = bourg.buildings[idxOf('church')];
    const apse = idxOf('church_apse');
    if (apse < 0) return; // the apse only fits on a long enough churchyard
    expect(ctx[apse].alongX).toBe(nave.w >= nave.h);
    // the nave is west of the apse on a nave laid along x
    expect(ctx[apse].butt.w || ctx[apse].butt.n).toBe(true);
  });

  it('butts the tower against the nave so neither grows an eave into the other', () => {
    const t = idxOf('church_tower');
    const n = idxOf('church');
    expect(ctx[t].butt.e || ctx[t].butt.s || ctx[t].butt.w || ctx[t].butt.n).toBe(true);
    expect(ctx[n].butt.w || ctx[n].butt.e || ctx[n].butt.n || ctx[n].butt.s).toBe(true);
  });

  it('gives the church masses no terrace run', () => {
    for (const b of bourg.buildings) if (b.role?.startsWith('church')) expect(ctx[bourg.buildings.indexOf(b)].runKey).toBeNull();
  });
});

describe('artContexts: party-wall ranges (T17)', () => {
  const ctx = artContexts(bourg.buildings, stories);
  const runs = runsOf(bourg.buildings);
  const multi = [...runs.values()].filter((idx) => idx.length >= 2);

  it('finds at least one range of four or more units on this seed', () => {
    expect(Math.max(...multi.map((idx) => idx.length))).toBeGreaterThanOrEqual(4);
  });

  it('gives every unit of a range the same key, ridge and ridge axis', () => {
    for (const idx of multi) {
      const first = ctx[idx[0]];
      expect(first.runKey).not.toBeNull();
      for (const i of idx) {
        expect(ctx[i].runKey).toBe(first.runKey);
        expect(ctx[i].ridge).toBe(first.ridge);
        expect(ctx[i].alongX).toBe(first.alongX);
      }
    }
  });

  it('runs the ridge parallel to the frontage', () => {
    for (const idx of multi) {
      const f = bourg.buildings[idx[0]].frontage;
      if (!f) continue;
      expect(ctx[idx[0]].alongX).toBe(f === 'n' || f === 's');
    }
  });

  it('puts the shared ridge inside the span the range covers', () => {
    for (const idx of multi) {
      const along = ctx[idx[0]].alongX!;
      const lo = Math.min(...idx.map((i) => (along ? bourg.buildings[i].y : bourg.buildings[i].x)));
      const hi = Math.max(...idx.map((i) => (along ? bourg.buildings[i].y + bourg.buildings[i].h : bourg.buildings[i].x + bourg.buildings[i].w)));
      expect(ctx[idx[0]].ridge!).toBeGreaterThan(lo);
      expect(ctx[idx[0]].ridge!).toBeLessThan(hi);
    }
  });

  it('suppresses the overhang on both ridge ends of an interior unit', () => {
    const run = multi.sort((a, b) => b.length - a.length)[0];
    const along = ctx[run[0]].alongX!;
    const ordered = [...run].sort((a, b) => (along ? bourg.buildings[a].x - bourg.buildings[b].x : bourg.buildings[a].y - bourg.buildings[b].y));
    const butted = ordered.map((i) => {
      const s = ctx[i].butt;
      return along ? [s.w, s.e] : [s.n, s.s];
    });
    // the two ends of the range keep one free gable each; nothing in between does
    expect(butted[0][1]).toBe(true);
    expect(butted[butted.length - 1][0]).toBe(true);
    for (let k = 1; k < butted.length - 1; k++) expect(butted[k]).toEqual([true, true]);
  });

  it('leaves a one-unit run alone, so an isolated house keeps its variety', () => {
    for (const [, idx] of runs) if (idx.length === 1) expect(ctx[idx[0]].runKey).toBeNull();
  });

  it('leaves a bare footprint with no group, no run and no butted side', () => {
    // Read a whole legacy 'town' until the mapgen-v3 P6 retirement. Every kind
    // the generator still draws carries roles, terrace runs and frontages, so
    // the input that reaches this path is a plain footprint list — which is
    // what the optional half of the Building type is for, and stating it as a
    // literal says what the case IS rather than which generator happened to
    // produce it.
    const bare: Building[] = [
      { x: 10, y: 10, w: 8, h: 6 },
      { x: 30, y: 12, w: 7, h: 5 },
      { x: 30, y: 40, w: 6, h: 6 },
    ];
    for (const c of artContexts(bare, bare.map(() => 1))) {
      expect(c.runKey).toBeNull();
      expect(c.ridge).toBeNull();
      expect(c.alongX).toBeNull();
      expect(c.butt).toEqual({ n: false, s: false, e: false, w: false });
    }
  });
});

describe('bake queue (T22)', () => {
  it('takes the first on-screen entry, not the first entry', () => {
    const q = [7, 8, 9, 3, 4];
    expect(nextBake(q, (i) => i === 3)).toBe(3);
    expect(q).toEqual([7, 8, 9, 4]);
  });

  it('falls back to FIFO when nothing in the queue is on screen', () => {
    const q = [7, 8, 9];
    expect(nextBake(q, () => false)).toBe(7);
    expect(q).toEqual([8, 9]);
  });

  it('drains the whole first band in one go and trickles after it', () => {
    expect(bakeBudgetMs(true, 0)).toBe(Infinity);
    expect(bakeBudgetMs(false, 0)).toBeLessThanOrEqual(5);
  });

  it('raises the budget once the camera has held still, so a paused inspection settles', () => {
    const moving = bakeBudgetMs(false, 0);
    const still = bakeBudgetMs(false, 4);
    expect(still).toBeGreaterThan(moving);
    // §5.5: a 65-building bourg costs ~4 ms a building at the top band, so the
    // still budget has to settle one in the order of a dozen frames, and the
    // moving one must still fit inside a 60 Hz frame.
    expect(moving).toBeLessThan(16.7);
    expect(Math.ceil((65 * 4) / still)).toBeLessThanOrEqual(20);
  });
});

// D11. Which footprints a breached edge belongs to. This is the whole routing
// decision behind the wall-band rebake: miss a footprint and the band keeps
// drawing masonry across a hole the sim will happily walk a squad through.
describe('onOutline (D11)', () => {
  const b: Building = { x: 10, y: 20, w: 4, h: 3 } as Building;

  it('claims all four sides of its own outline', () => {
    expect(onOutline(b, 10, 20, true)).toBe(true); // N
    expect(onOutline(b, 13, 23, true)).toBe(true); // S, last column
    expect(onOutline(b, 10, 22, false)).toBe(true); // W, last row
    expect(onOutline(b, 14, 20, false)).toBe(true); // E
  });

  it('rejects the interior, the corners past the end, and the wrong axis', () => {
    expect(onOutline(b, 11, 21, true)).toBe(false); // an interior partition
    expect(onOutline(b, 14, 20, true)).toBe(false); // one past the N run
    expect(onOutline(b, 9, 20, true)).toBe(false);
    expect(onOutline(b, 10, 23, false)).toBe(false); // one past the W run
    expect(onOutline(b, 10, 19, false)).toBe(false);
  });

  it('puts a party wall on BOTH units, so a terrace rebakes as one', () => {
    const left: Building = { x: 10, y: 20, w: 4, h: 3 } as Building;
    const right: Building = { x: 14, y: 20, w: 4, h: 3 } as Building;
    expect(onOutline(left, 14, 21, false)).toBe(true); // left's E
    expect(onOutline(right, 14, 21, false)).toBe(true); // right's W
  });
});
