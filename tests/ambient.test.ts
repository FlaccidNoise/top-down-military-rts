import { beforeAll, describe, expect, it } from 'vitest';
import { Camera } from '../src/render/camera';
import { buildHedgerows } from '../src/render/hedgerow';
import { WIND } from '../src/render/light';
import { PatchIndex } from '../src/render/patches';
import { buildShore } from '../src/render/shore';
import { generateMap } from '../src/sim/mapgen';

// Ambient motion (src/render/ambient.ts): the gust arithmetic, and the two
// promises the pass makes about itself — it is capped, and it is a function
// of the clock it is handed and nothing else.

let amb: typeof import('../src/render/ambient');
beforeAll(async () => {
  // the three sprites are baked into canvases; nothing in the test reads them
  const g = new Proxy({}, { get: () => () => ({ addColorStop: () => {} }), set: () => true });
  (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => g }) };
  amb = await import('../src/render/ambient');
});

describe('gusts', () => {
  it('give every point a place in the cycle, 0 to 1', () => {
    for (let i = 0; i < 400; i++) {
      const p = amb.gustPhase(i * 3.7, i * 1.3);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('light a site for GUST_DEPTH of the cycle, running from 0 to 1 as the front goes over', () => {
    const period = amb.GUST_LEN / amb.GUST_SPEED;
    const phase = 0.4;
    let lit = 0;
    let last = -1;
    let rises = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const f = amb.gustThrough(phase, (i / N) * period);
      if (f < 0) {
        expect(f).toBe(-1);
        last = -1;
        continue;
      }
      lit++;
      expect(f).toBeLessThanOrEqual(1);
      if (last >= 0 && f > last) rises++;
      last = f;
    }
    expect(lit / N).toBeCloseTo(amb.GUST_DEPTH, 2);
    expect(rises).toBeGreaterThan(lit - 3); // it only ever runs forward
  });

  it('travel down the wind: with the raggedness taken out, a site further along is reached later', () => {
    // gustThrough is all that moves; phase differences ARE the travel
    const reach = (phase: number): number => {
      for (let t = 0; t < 60; t += 0.01) if (amb.gustThrough(phase, t) >= 0) return t;
      return -1;
    };
    const near = 0.3;
    const far = near + 10 / amb.GUST_LEN; // ten metres further down the wind
    expect(reach(far) - reach(near)).toBeCloseTo(10 / amb.GUST_SPEED, 1);
    expect(Math.hypot(WIND.dx, WIND.dy)).toBeCloseTo(1, 6);
  });
});

describe('Ambient.draw', () => {
  const map = generateMap(2, 160, 120, 'open').map;
  const make = (): InstanceType<typeof amb.Ambient> =>
    new amb.Ambient(map, buildHedgerows((x, y) => map.terrainKeyAt(x, y) === 'hedge', map.w, map.h), new PatchIndex(map), buildShore(() => false, () => true, map.w, map.h));
  const counter = (): { ctx: CanvasRenderingContext2D; ops: string[] } => {
    const ops: string[] = [];
    const ctx = { globalAlpha: 1, drawImage: (_c: unknown, ...a: number[]) => void ops.push(a.map((v) => v.toFixed(3)).join(',')) };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
  };
  const cam = (scale: number): Camera => {
    const c = new Camera(80, 60);
    c.scale = scale;
    return c;
  };

  it('lays sprites over a quiet map, and never many more than the cap however much of it is in view', () => {
    const a = make();
    let most = 0;
    let some = 0;
    for (const [scale, w, h] of [[14, 1280, 800], [9, 1280, 800], [9, 2560, 1440]]) {
      for (let t = 0; t < 14; t += 0.7) {
        const n = a.draw(counter().ctx, cam(scale), w, h, t);
        most = Math.max(most, n);
        some += n;
      }
    }
    expect(some).toBeGreaterThan(200);
    // the thinning is a roll per site, so the count scatters round the cap
    expect(most).toBeLessThan(amb.MAX_LIT * 1.35);
  });

  it('is a function of the map and the clock alone: the same instant is the same sprites, a later one is not', () => {
    const at = (t: number, a = make()): string[] => {
      const c = counter();
      a.draw(c.ctx, cam(14), 1280, 800, t);
      return c.ops;
    };
    const one = make();
    expect(at(0, one)).toEqual(at(0, one));
    expect(at(3.2, one)).toEqual(at(3.2)); // a second layer built from the same map agrees
    expect(at(3.2, one)).not.toEqual(at(3.6, one));
  });

  it('draws nothing below the zoom it is visible at, or on a clock that is not a number', () => {
    const a = make();
    expect(a.draw(counter().ctx, cam(5), 1280, 800, 1)).toBe(0);
    expect(a.draw(counter().ctx, cam(14), 1280, 800, NaN)).toBe(0);
    expect(a.draw(counter().ctx, cam(14), 1280, 800, -1)).toBe(0);
  });

  it('leaves the alpha it borrowed as it found it', () => {
    const c = counter();
    make().draw(c.ctx, cam(14), 1280, 800, 2);
    expect(c.ctx.globalAlpha).toBe(1);
  });
});
