import { describe, expect, it } from 'vitest';
import { PALL_CAP, PALL_MAX_MS, PALL_MIN_MS, PallLayer, pallLeft, pallLife } from '../src/render/pall';

// Battle pall is fed, not spawned: a shot or a blast tops up the nearest puff.
// These pin the three things that keep it cheap and honest — the cap, the
// lifetime band the design asks for (8 to 20 s), and the fog gate.

describe('pall lifetime', () => {
  it('hangs for 8 s as a wisp and 20 s at full density', () => {
    expect(pallLife(0)).toBe(PALL_MIN_MS);
    expect(pallLife(1)).toBe(PALL_MAX_MS);
    expect(PALL_MIN_MS).toBe(8000);
    expect(PALL_MAX_MS).toBe(20000);
  });

  it('holds for the first half of its life, then fades to nothing', () => {
    const life = pallLife(0.6);
    expect(pallLeft(0.6, 0)).toBe(0.6);
    expect(pallLeft(0.6, life * 0.5)).toBeCloseTo(0.6, 10);
    expect(pallLeft(0.6, life * 0.75)).toBeCloseTo(0.3, 10);
    expect(pallLeft(0.6, life)).toBe(0);
    expect(pallLeft(0.6, life * 3)).toBe(0);
  });
});

describe('PallLayer.feed', () => {
  it('tops up the puff in reach instead of starting another', () => {
    const p = new PallLayer();
    for (let i = 0; i < 30; i++) p.feed(50 + (i % 3) * 0.5, 50, 0.03, i * 100, 0);
    expect(p.puffs).toHaveLength(1);
    expect(p.puffs[0].d).toBeCloseTo(0.9, 6);
  });

  it('never lets density pass 1 however long a position fires', () => {
    const p = new PallLayer();
    for (let i = 0; i < 500; i++) p.feed(50, 50, 0.15, i * 50, 0);
    expect(p.puffs[0].d).toBe(1);
  });

  it('starts a new puff out of reach, and lays a trail as the old one drifts off its source', () => {
    const p = new PallLayer();
    p.feed(50, 50, 0.3, 0, 0);
    p.feed(60, 50, 0.3, 0, 0);
    expect(p.puffs).toHaveLength(2);
    // Same source, 19 s on: the first puff has drifted metres downwind, so the
    // feed no longer reaches it.
    p.feed(50, 50, 0.3, 19000, 0);
    expect(p.puffs).toHaveLength(3);
  });

  it('holds the cap by giving up the thinnest puff', () => {
    const p = new PallLayer();
    for (let i = 0; i < PALL_CAP; i++) p.feed(10 + i * 10, 10, i === 7 ? 0.01 : 0.5, 0, 0);
    expect(p.puffs).toHaveLength(PALL_CAP);
    const thin = p.puffs[7].k;
    p.feed(10, 200, 0.5, 0, 0);
    expect(p.puffs).toHaveLength(PALL_CAP);
    expect(p.puffs.some((q) => q.k === thin)).toBe(false);
  });

  it('draws nothing for a source the player cannot see, and asks the fog once per throttle window', () => {
    const p = new PallLayer();
    p.feed(50, 50, 0.3, 0, 0, () => false);
    expect(p.puffs).toHaveLength(0);

    let asked = 0;
    const seen = (): boolean => {
      asked++;
      return true;
    };
    p.feed(50, 50, 0.1, 0, 100, seen); // creates: one test
    for (let tick = 101; tick < 110; tick++) p.feed(50, 50, 0.1, 0, tick, seen); // inside the window: none
    expect(asked).toBe(1);
    p.feed(50, 50, 0.1, 0, 115, seen); // stale: one more
    expect(asked).toBe(2);
  });

  it('stops feeding a puff whose source has gone out of sight', () => {
    const p = new PallLayer();
    p.feed(50, 50, 0.2, 0, 0, () => true);
    p.feed(50, 50, 0.5, 0, 100, () => false);
    expect(p.puffs[0].d).toBeCloseTo(0.2, 10);
  });

  it('ignores a feed that is not a number, so nothing non-finite reaches a draw call', () => {
    const p = new PallLayer();
    p.feed(Number.NaN, 50, 0.3, 0, 0);
    p.feed(50, Number.POSITIVE_INFINITY, 0.3, 0, 0);
    p.feed(50, 50, Number.NaN, 0, 0);
    p.feed(50, 50, 0, 0, 0);
    expect(p.puffs).toHaveLength(0);
  });
});
