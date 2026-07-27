import { describe, expect, it } from 'vitest';
import { generateMap, type Building } from '../src/sim/mapgen';
import { artContexts, artKey, pickMat } from '../src/render/roofs';

// Lane B, T15 / T17. Everything here is the PURE half of roofs.ts — the
// decisions the bake reads off, with no canvas in sight. The pixels are judged
// through scripts/sweep.mjs; what a unit test can hold down is that the church
// is always a church and that a party-wall range agrees with itself.

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

  it('leaves a legacy building with no group, no run and no butted side', () => {
    const town = generateMap(7, W, H, 'town');
    const legacy = artContexts(town.buildings, town.buildings.map(() => 1));
    for (const c of legacy) {
      expect(c.runKey).toBeNull();
      expect(c.ridge).toBeNull();
      expect(c.alongX).toBeNull();
      expect(c.butt).toEqual({ n: false, s: false, e: false, w: false });
    }
  });
});
