import { beforeAll, describe, expect, it } from 'vitest';
import type { Pose } from '../src/render/dudes';

// Pose variety (src/render/dudes.ts): which figure a man at rest is drawn as,
// and the one property the kneel pose exists for — that from straight above it
// is not the standing pose.
//
// There is no canvas under vitest, so a figure is baked into a context that
// keeps the transform stack and records how far behind the man (-X, in bake
// pixels from the sprite centre) anything is painted.

let rear = Infinity;

function measurer(): CanvasRenderingContext2D {
  type M = [number, number, number, number, number, number];
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let lw = 1;
  let pts: [number, number, number][] = []; // x, y, reach round the point, in the current path
  const X = (x: number, y: number): number => m[0] * x + m[2] * y + m[4];
  const unit = (): number => Math.hypot(m[0], m[1]);
  const note = (reach: number): void => {
    for (const [x, y, r] of pts) rear = Math.min(rear, X(x, y) - (r + reach) * unit());
  };
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_t, key: string) {
      if (key === 'lineWidth') return lw;
      if (key in target) return target[key];
      return (...a: number[]): unknown => {
        if (key === 'save') return void stack.push([...m] as M);
        if (key === 'restore') return void (m = stack.pop() ?? m);
        if (key === 'translate') return void (m = [m[0], m[1], m[2], m[3], m[0] * a[0] + m[2] * a[1] + m[4], m[1] * a[0] + m[3] * a[1] + m[5]]);
        if (key === 'scale') return void (m = [m[0] * a[0], m[1] * a[0], m[2] * a[1], m[3] * a[1], m[4], m[5]]);
        if (key === 'rotate') {
          const c = Math.cos(a[0]);
          const s = Math.sin(a[0]);
          return void (m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, -m[0] * s + m[2] * c, -m[1] * s + m[3] * c, m[4], m[5]]);
        }
        if (key === 'beginPath') return void (pts = []);
        if (key === 'moveTo' || key === 'lineTo') return void pts.push([a[0], a[1], 0]);
        if (key === 'arc') return void pts.push([a[0], a[1], a[2]]);
        if (key === 'ellipse') return void pts.push([a[0], a[1], Math.max(a[2], a[3])]);
        if (key === 'stroke') return note(lw / 2);
        if (key === 'fill') return note(0);
        if (key === 'createRadialGradient') return { addColorStop: (): void => {} };
        return undefined;
      };
    },
    set(_t, key: string, v: unknown) {
      if (key === 'lineWidth') lw = v as number;
      else target[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let dudes: typeof import('../src/render/dudes');
beforeAll(async () => {
  (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: measurer }) };
  dudes = await import('../src/render/dudes');
});

// How far behind his own centre a pose reaches, in body units. Memoised: the
// sprite caches bake a key once, and a second ask would measure nothing.
const reaches = new Map<string, number>();
function reach(pose: Pose, frame: number, shadow = false): number {
  const key = `${pose}|${frame}|${shadow}`;
  let v = reaches.get(key);
  if (v === undefined) {
    rear = Infinity;
    const band = 24;
    if (shadow) dudes.getShadowSprite(pose, frame, 'rifle', band);
    else dudes.getSprite('blue', 'garand', pose, frame, band);
    v = (Math.ceil(dudes.SPRITE_SPAN * band) / 2 - rear) / (band * dudes.DUDE_SCALE);
    reaches.set(key, v);
  }
  return v;
}

describe('the kneel pose', () => {
  it('reaches well behind a standing man, and well short of a prone one, in every kneel frame', () => {
    const stand = reach('idle', 0);
    const prone = reach('prone', 0);
    expect(stand).toBeLessThan(0.4); // shoulders, pack and rim: nothing trails
    for (const f of [dudes.KNEEL_AIM, dudes.KNEEL_RELOAD, dudes.KNEEL_REST, dudes.KNEEL_REST + 1]) {
      const k = reach('kneel', f);
      expect(k).toBeGreaterThan(stand + 0.25);
      expect(k).toBeLessThan(prone - 0.25);
    }
  });

  it('casts the same footprint: the shadow has the trailing leg too', () => {
    expect(reach('kneel', dudes.KNEEL_AIM, true)).toBeGreaterThan(reach('idle', 0, true) + 0.25);
  });
});

describe('restPose', () => {
  it('kneels a crouched man whatever else he is doing, with the frame saying what', () => {
    expect(dudes.restPose(true, true, true, 5)).toEqual(['kneel', dudes.KNEEL_RELOAD]);
    expect(dudes.restPose(true, false, true, 5)).toEqual(['kneel', dudes.KNEEL_AIM]);
    const rests = new Set<number>();
    for (let id = 0; id < 40; id++) {
      const [pose, frame] = dudes.restPose(true, false, false, id);
      expect(pose).toBe('kneel');
      rests.add(frame);
    }
    expect([...rests].sort()).toEqual([dudes.KNEEL_REST, dudes.KNEEL_REST + 1]);
  });

  it('stands a man reloading, aiming or idle, in that order', () => {
    expect(dudes.restPose(false, true, true, 5)).toEqual(['reload', 0]);
    expect(dudes.restPose(false, false, true, 5)).toEqual(['aim', 0]);
    expect(dudes.restPose(false, false, false, 5)[0]).toBe('idle');
  });

  it('spreads a squad at rest over every way of carrying the weapon, the same way every time', () => {
    const carries = new Set<number>();
    for (let id = 0; id < 60; id++) {
      const [, frame] = dudes.restPose(false, false, false, id);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(dudes.IDLE_CARRIES);
      expect(dudes.restPose(false, false, false, id)[1]).toBe(frame);
      carries.add(frame);
    }
    expect(carries.size).toBe(dudes.IDLE_CARRIES);
  });
});

describe('restTurn', () => {
  it('turns only a man at rest, by less than half REST_TURN, and never one with a target', () => {
    let spread = 0;
    for (let id = 0; id < 60; id++) {
      const t = dudes.restTurn('idle', false, id);
      expect(Math.abs(t)).toBeLessThanOrEqual(dudes.REST_TURN / 2);
      expect(dudes.restTurn('kneel', false, id)).toBe(t);
      expect(dudes.restTurn('kneel', true, id)).toBe(0);
      for (const p of ['walk', 'run', 'aim', 'reload', 'prone', 'dead'] as Pose[]) expect(dudes.restTurn(p, false, id)).toBe(0);
      spread = Math.max(spread, Math.abs(t));
    }
    expect(spread).toBeGreaterThan(dudes.REST_TURN / 4);
  });
});
