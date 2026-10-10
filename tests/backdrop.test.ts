import { beforeAll, describe, expect, it } from 'vitest';

// The battle behind the main menu (src/render/backdrop.ts). What can be
// pinned without a browser: which backdrop a page gets, that the fight is the
// same fight every time, and that a backdrop nobody wants costs nothing.

let bd: typeof import('../src/render/backdrop');
beforeAll(async () => {
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ getContext: () => null }) };
  bd = await import('../src/render/backdrop');
});

describe('backdropMode', () => {
  it('is live by default, still when the clock is pinned or motion is unwelcome, off when asked', () => {
    expect(bd.backdropMode(null, false, false)).toBe('live');
    expect(bd.backdropMode('1', false, false)).toBe('live');
    expect(bd.backdropMode(null, true, false)).toBe('still');
    expect(bd.backdropMode(null, false, true)).toBe('still');
    expect(bd.backdropMode('0', false, false)).toBe('off');
    expect(bd.backdropMode('0', true, true)).toBe('off');
  });
});

describe('the backdrop battle', () => {
  it('is the same fight, tick for tick, every time it is staged, and by its tick it is a fight', () => {
    for (const small of [false, true]) {
      const run = (): string => {
        const { sim, commanders } = bd.stageBackdrop(small);
        const until = small ? bd.BACKDROP_TICK.small : bd.BACKDROP_TICK.full;
        while (sim.tick < until) {
          for (const c of commanders) c.update(sim);
          sim.step();
        }
        // the tick a still frame is taken at: men on both sides have a target
        const firing = (side: string): number => sim.soldiers.filter((s) => s.side === side && s.alive && s.targetId >= 0).length;
        expect(firing('blue')).toBeGreaterThanOrEqual(3);
        expect(firing('red')).toBeGreaterThanOrEqual(3);
        expect(sim.winner).toBe(null);
        return sim.snapshot();
      };
      expect(run()).toBe(run());
    }
  }, 30000);

  it('gives a phone a battle on a third of the ground', () => {
    const full = bd.stageBackdrop(false).sim;
    const small = bd.stageBackdrop(true).sim;
    expect((small.map.w * small.map.h) / (full.map.w * full.map.h)).toBeLessThan(0.4);
    expect(small.soldiers.length).toBeLessThan(full.soldiers.length * 0.7);
    expect(small.vehicles.length).toBe(0);
  });
});

describe('drift and dim', () => {
  it('keeps the camera within a few metres of the fight, and moving', () => {
    let far = 0;
    for (let t = 0; t < 600; t += 0.5) far = Math.max(far, Math.hypot(...bd.drift(t)));
    expect(far).toBeLessThan(11);
    expect(far).toBeGreaterThan(8);
    const [x0, y0] = bd.drift(10);
    const [x1, y1] = bd.drift(11);
    // slow: under a metre a second
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeLessThan(1);
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeGreaterThan(0.05);
  });

  it('holds the battle darker under the title than at the foot of the page, and never brighter than half', () => {
    expect(bd.DIM_TOP).toBeGreaterThan(bd.DIM_FOOT);
    expect(bd.DIM_TOP).toBeGreaterThanOrEqual(0.7);
    expect(bd.DIM_FOOT).toBeGreaterThanOrEqual(0.4);
  });
});

describe('MenuBackdrop', () => {
  it('does nothing at all when it is off, and nothing until it is wanted', () => {
    let timers = 0;
    (globalThis as { window?: unknown }).window = { setTimeout: () => ++timers, clearTimeout: () => {} };
    const off = new bd.MenuBackdrop('off');
    off.want(true);
    off.frame(null as unknown as CanvasRenderingContext2D, 16);
    expect(timers).toBe(0);
    expect(off.shown).toBe(false);
    const live = new bd.MenuBackdrop('live');
    live.frame(null as unknown as CanvasRenderingContext2D, 16);
    live.want(false);
    expect(timers).toBe(0);
    live.want(true);
    live.want(true); // asked every frame: one boot, not one a frame
    expect(timers).toBe(1);
    expect(live.shown).toBe(false);
    expect(live.battle).toBe(null);
    live.want(false);
    expect(live.battle).toBe(null);
  });
});
