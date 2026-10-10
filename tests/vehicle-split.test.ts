import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleKey } from '../src/sim/data';
import type { VehiclePart } from '../src/render/vehicles';

// The hull/turret split bake (vehicles.ts VehiclePart). A turreted tank bakes
// as one sprite ('all') or as two ('hull' + 'turret'), and the two are made by
// muting spans of the SAME drawing function with an empty clip. The contract
// that makes that safe: every mark the whole sprite makes is made by exactly
// one of the halves — nothing lost when the turret turns, nothing drawn twice.
//
// There is no canvas under vitest, so this bakes into a recording context: it
// keeps the save/restore stack, knows that a clip to an empty rect mutes what
// follows, and logs every paint that gets through with the state it was
// painted in.

let ops: string[] = [];

function recorder(): CanvasRenderingContext2D {
  interface State {
    muted: boolean;
    xf: string;
    fill: unknown;
    stroke: unknown;
    alpha: unknown;
    lw: unknown;
  }
  let st: State = { muted: false, xf: '', fill: '#000', stroke: '#000', alpha: 1, lw: 1 };
  const stack: State[] = [];
  let path: string[] = [];
  let emptyClipArmed = false;
  const num = (v: unknown): string => (typeof v === 'number' ? v.toFixed(4) : String(v));
  const PAINT = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText']);
  const PATH = new Set(['moveTo', 'lineTo', 'arc', 'ellipse', 'rect', 'closePath', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'roundRect']);
  const XF = new Set(['translate', 'rotate', 'scale', 'transform', 'setTransform']);
  const gradient = { addColorStop: (): void => {} };
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_t, key: string) {
      if (key === 'fillStyle') return st.fill;
      if (key === 'strokeStyle') return st.stroke;
      if (key === 'globalAlpha') return st.alpha;
      if (key === 'lineWidth') return st.lw;
      if (key in target) return target[key];
      return (...a: unknown[]): unknown => {
        if (key === 'save') return void stack.push({ ...st });
        if (key === 'restore') return void (st = stack.pop() ?? st);
        if (key === 'beginPath') {
          path = [];
          emptyClipArmed = false;
          return;
        }
        if (XF.has(key)) return void (st.xf += `${key}(${a.map(num)})`);
        if (PATH.has(key)) {
          path.push(`${key}(${a.map(num)})`);
          emptyClipArmed = key === 'rect' && a[2] === 0 && a[3] === 0 && path.length === 1;
          return;
        }
        if (key === 'clip') {
          if (emptyClipArmed) st.muted = true;
          return;
        }
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return gradient;
        if (key === 'measureText') return { width: 10 };
        if (PAINT.has(key)) {
          if (st.muted) return;
          const args = key === 'drawImage' ? a.slice(1).map(num) : a.map(num);
          const shape = key === 'fill' || key === 'stroke' ? path.join(';') : '';
          // Only the state the paint actually reads. A muted span restores the
          // state it found, so the halves legitimately differ in what is left
          // lying in a style nobody uses — and must NOT differ in one a mark
          // depends on: a turret stroke leaning on a width the hull span set
          // would paint differently once split, and this is what catches it.
          const ink = key.startsWith('stroke') ? `${String(st.stroke)}|${num(st.lw)}` : key === 'drawImage' ? '' : String(st.fill);
          ops.push(`${key}(${args})|${ink}|${num(st.alpha)}|${st.xf}|${shape}`);
        }
        return undefined;
      };
    },
    set(_t, key: string, v: unknown) {
      if (key === 'fillStyle') st.fill = v;
      else if (key === 'strokeStyle') st.stroke = v;
      else if (key === 'globalAlpha') st.alpha = v;
      else if (key === 'lineWidth') st.lw = v;
      else target[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let getVehicleSprite: typeof import('../src/render/vehicles').getVehicleSprite;
let turretCenter: typeof import('../src/render/vehicles').turretCenter;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => recorder() }),
  };
  ({ getVehicleSprite, turretCenter } = await import('../src/render/vehicles'));
});

// Every band is its own cache key, so each call here is a fresh bake.
const bake = (kind: VehicleKey, band: number, part: VehiclePart): string[] => {
  ops = [];
  getVehicleSprite(kind, 'blue', 'ok', band, 0, 0, part);
  return ops;
};
const tally = (list: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const o of list) m.set(o, (m.get(o) ?? 0) + 1);
  return m;
};

describe('hull/turret split bake', () => {
  for (const kind of ['sherman', 'panzer4'] as const) {
    for (const band of [12, 24, 48]) {
      it(`${kind} @ band ${band}: hull + turret make exactly the marks the whole sprite makes`, () => {
        const all = bake(kind, band, 'all');
        const hull = bake(kind, band, 'hull');
        const turret = bake(kind, band, 'turret');
        expect(all.length).toBeGreaterThan(20);
        expect(turret.length).toBeGreaterThan(3);
        expect(hull.length).toBeGreaterThan(turret.length); // the hull is most of a tank
        expect(hull.length + turret.length).toBe(all.length); // nothing lost, nothing twice
        const want = tally(all);
        const got = tally([...hull, ...turret]);
        expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
        for (const [op, n] of want) expect(got.get(op), op.slice(0, 80)).toBe(n);
      });
    }

    it(`${kind}: the hull half keeps the order the whole sprite paints in`, () => {
      // Painter's order is the picture: a muted span must drop marks, never
      // move the ones that stay.
      const all = bake(kind, 24, 'all');
      const hull = bake(kind, 24, 'hull');
      let i = 0;
      for (const op of all) if (i < hull.length && hull[i] === op) i++;
      expect(i).toBe(hull.length); // hull is a subsequence of all
    });

    it(`${kind}: has a turret ring for the renderer to turn the turret half about`, () => {
      const tc = turretCenter(kind);
      expect(tc).not.toBeNull();
      expect(tc![2]).toBeGreaterThan(0.5);
    });
  }

  it('has no turret half to split off on a casemate or an open top', () => {
    expect(turretCenter('stug3')).toBeNull();
    expect(turretCenter('m3_halftrack')).toBeNull();
    // and asking for the halves of one changes nothing: the whole sprite is the hull
    const all = bake('stug3', 24, 'all');
    const hull = bake('stug3', 24, 'hull');
    expect(hull).toEqual(all);
  });

  it('a wreck is never split: its bake is one sprite, turret jolted where it fell', () => {
    ops = [];
    getVehicleSprite('sherman', 'blue', 'dead', 24, 0, 0);
    expect(ops.length).toBeGreaterThan(20);
  });
});
