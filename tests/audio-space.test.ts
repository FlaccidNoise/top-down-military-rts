import { beforeEach, describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/render/audio';
import {
  ACTIVITY_PER_BOOM,
  ACTIVITY_PER_SHOT,
  AIR_FLOOR_HZ,
  AIR_OPEN_HZ,
  airCutoff,
  arrivalDelay,
  decayActivity,
  DELAY_MAX_S,
  DELAY_NEAR_M,
  ENGINE_MAX,
  engineGain,
  listenDist,
  RUMBLE_MAX,
  rumbleGain,
} from '../src/render/audiospace';
import { Camera } from '../src/render/camera';

// Audio space cannot be checked by ear in a test, so it is checked by
// structure: the arithmetic that feeds every AudioParam, and the shape of the
// graph — that it builds once, that nothing in the frame loop makes a node,
// and that no garbage a frame can hand it reaches a param.

describe('distance: duller and later', () => {
  it('puts the listener over the view centre, as high as the view is tall', () => {
    expect(listenDist(0, 30)).toBe(30);
    expect(listenDist(40, 30)).toBe(50);
    expect(listenDist(Number.NaN, 30)).toBe(0);
    expect(listenDist(40, Number.NaN)).toBe(0);
  });

  it('leaves a close sound open and takes the top off a far one, monotonically', () => {
    expect(airCutoff(0)).toBe(AIR_OPEN_HZ);
    let prev = airCutoff(0);
    for (let d = 10; d <= 600; d += 10) {
      const hz = airCutoff(d);
      expect(hz, `d=${d}`).toBeLessThanOrEqual(prev);
      expect(hz, `d=${d}`).toBeGreaterThanOrEqual(AIR_FLOOR_HZ);
      prev = hz;
    }
    expect(airCutoff(60)).toBeGreaterThan(9000); // the fight under the cursor keeps its crack
    expect(airCutoff(300)).toBeLessThan(1500); // the far one is a thump
    expect(airCutoff(5000)).toBe(AIR_FLOOR_HZ);
  });

  it('never hands a filter a frequency it cannot take', () => {
    for (const d of [Number.NaN, -50, Infinity, -Infinity]) {
      const hz = airCutoff(d);
      expect(Number.isFinite(hz), String(d)).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(AIR_FLOOR_HZ);
      expect(hz).toBeLessThanOrEqual(AIR_OPEN_HZ);
    }
  });

  it('keeps a flash and its bang together up close, and caps how late a far one is', () => {
    expect(arrivalDelay(0)).toBe(0);
    expect(arrivalDelay(DELAY_NEAR_M)).toBe(0);
    expect(arrivalDelay(DELAY_NEAR_M + 343 * 0.1)).toBeCloseTo(0.1, 6);
    expect(arrivalDelay(10000)).toBe(DELAY_MAX_S);
    for (const d of [Number.NaN, -10, -Infinity]) expect(arrivalDelay(d)).toBe(0);
    expect(arrivalDelay(Infinity)).toBe(DELAY_MAX_S);
  });
});

describe('the bed', () => {
  it('drains activity on a few seconds and is silent on garbage', () => {
    expect(decayActivity(10, 0)).toBe(10);
    expect(decayActivity(10, 3.5)).toBeCloseTo(10 / Math.E, 6);
    expect(decayActivity(10, 60)).toBeLessThan(1e-5);
    expect(decayActivity(10, -5)).toBe(10); // a clock that went backwards drains nothing
    for (const a of [Number.NaN, -1, Infinity]) expect(decayActivity(a, 1)).toBe(0);
    expect(decayActivity(1, Number.NaN)).toBe(0);
  });

  it('raises the rumble with the firing and saturates', () => {
    expect(rumbleGain(0)).toBe(0);
    const squad = rumbleGain(8 * ACTIVITY_PER_SHOT * 3); // a squad firing for three seconds
    const barrage = rumbleGain(12 * ACTIVITY_PER_BOOM);
    expect(squad).toBeGreaterThan(0.02);
    expect(barrage).toBeGreaterThan(squad);
    expect(barrage).toBeLessThanOrEqual(RUMBLE_MAX);
    expect(rumbleGain(1e9)).toBeLessThanOrEqual(RUMBLE_MAX);
    expect(rumbleGain(Number.NaN)).toBe(0);
    expect(rumbleGain(-3)).toBe(0);
  });

  it('gives one hull most of the engine and a column no more than the ceiling', () => {
    expect(engineGain(0)).toBe(0);
    expect(engineGain(1)).toBeGreaterThan(ENGINE_MAX * 0.6);
    expect(engineGain(20)).toBeLessThanOrEqual(ENGINE_MAX);
    expect(engineGain(Number.NaN)).toBe(0);
  });
});

// A WebAudio stand-in that counts what is made and throws exactly where the
// real one does: a non-finite value into an AudioParam.
let made = 0;
let starts: number[] = [];
let paramCalls = 0;
const finite = (v: number): void => {
  if (!Number.isFinite(v)) throw new TypeError(`non-finite AudioParam value: ${v}`);
};
class FakeParam {
  private v = 0;
  get value(): number {
    return this.v;
  }
  set value(v: number) {
    finite(v);
    this.v = v;
  }
  setValueAtTime(v: number, t: number): void {
    finite(v);
    finite(t);
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    finite(v);
    finite(t);
    if (!(v > 0)) throw new RangeError('exponential ramp to a non-positive value');
  }
  setTargetAtTime(v: number, t: number, tau: number): void {
    finite(v);
    finite(t);
    finite(tau);
    paramCalls++;
  }
}
class FakeNode {
  gain = new FakeParam();
  pan = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  delayTime = new FakeParam();
  playbackRate = new FakeParam();
  threshold = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  type = '';
  loop = false;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  constructor() {
    made++;
  }
  connect(): void {}
  disconnect(): void {}
  start(t = 0): void {
    finite(t);
    starts.push(t);
  }
  stop(t = 0): void {
    finite(t);
  }
}
class FakeContext {
  currentTime = 10;
  state = 'running';
  sampleRate = 2000;
  destination = {};
  createGain = (): FakeNode => new FakeNode();
  createBiquadFilter = (): FakeNode => new FakeNode();
  createStereoPanner = (): FakeNode => new FakeNode();
  createDynamicsCompressor = (): FakeNode => new FakeNode();
  createOscillator = (): FakeNode => new FakeNode();
  createBufferSource = (): FakeNode => new FakeNode();
  createDelay = (): FakeNode => new FakeNode();
  createBuffer = (_ch: number, len: number): { getChannelData: () => Float32Array } => {
    const d = new Float32Array(len);
    return { getChannelData: () => d };
  };
  resume = async (): Promise<void> => {};
}

const boot = (): { audio: AudioEngine; ctx: FakeContext } => {
  let ctx!: FakeContext;
  (globalThis as unknown as { window: unknown }).window = {
    AudioContext: class extends FakeContext {
      constructor() {
        super();
        ctx = this;
      }
    },
  };
  const audio = new AudioEngine();
  audio.unlock();
  return { audio, ctx };
};
const cam = (): Camera => {
  const c = new Camera(100, 100);
  c.scale = 14;
  return c;
};
const shot = (fx: number, fy: number): { fx: number; fy: number; tx: number; ty: number; hit: boolean; kill: boolean; weapon: 'garand' } => ({ fx, fy, tx: fx + 20, ty: fy, hit: true, kill: false, weapon: 'garand' });

describe('the graph', () => {
  beforeEach(() => {
    made = 0;
    starts = [];
    paramCalls = 0;
  });

  it('builds once: a second unlock makes nothing', () => {
    const { audio } = boot();
    expect(made).toBeGreaterThan(20); // compressor, master, two reverb loops, wind, rumble, engine
    const built = made;
    audio.unlock();
    expect(made).toBe(built);
  });

  it('makes no node in the frame loop: ten seconds of ambience with hulls in view', () => {
    const { audio, ctx } = boot();
    const built = made;
    const c = cam();
    for (let f = 0; f < 600; f++) {
      ctx.currentTime += 1 / 60;
      audio.ambience([{ x: 100, y: 100 }, { x: 130, y: 90 }], c, 1280, 800, false);
    }
    expect(made).toBe(built);
    // and it does not queue an event a frame either: steady hulls are set once
    expect(paramCalls).toBeLessThan(10);
  });

  it('sends nothing at all for a quiet field', () => {
    const { audio, ctx } = boot();
    for (let f = 0; f < 600; f++) {
      ctx.currentTime += 1 / 60;
      audio.ambience([], cam(), 1280, 800, true);
    }
    expect(paramCalls).toBe(0);
  });

  it('brings the rumble up after firing and lets it fall away', () => {
    const { audio, ctx } = boot();
    const c = cam();
    const far = Array.from({ length: 40 }, (_, i) => shot(100 + i, 100));
    audio.addShots(far, c, 1280, 800);
    audio.ambience([], c, 1280, 800, false);
    const up = paramCalls;
    expect(up).toBeGreaterThan(0); // the rumble was given a level
    ctx.currentTime += 30;
    audio.ambience([], c, 1280, 800, false);
    expect(paramCalls).toBeGreaterThan(up); // and taken back down
  });

  it('holds the voice budget: two hundred shots in one frame start a bounded number of sources', () => {
    const { audio } = boot();
    const built = made;
    audio.addShots(Array.from({ length: 200 }, (_, i) => shot(100 + (i % 20), 100 + ((i / 20) | 0))), cam(), 1280, 800);
    // 12 voices a batch; a rifle voice is a gain, a panner, a tap (3) and a
    // body (2), plus at most one air filter
    expect(made - built).toBeLessThanOrEqual(12 * 8);
  });

  it('starts a near report at once and a far one late', () => {
    const { audio, ctx } = boot();
    const c = cam();
    starts = [];
    audio.addBooms([{ x: 100, y: 100, kind: 'grenade', r: 3 }], c, 1280, 800);
    expect(Math.min(...starts)).toBe(ctx.currentTime);
    starts = [];
    audio.addBooms([{ x: 100 + 115, y: 100, kind: 'grenade', r: 3 }], c, 1280, 800); // off the right edge, still inside the cull
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.min(...starts)).toBeCloseTo(ctx.currentTime + (115 - DELAY_NEAR_M) / 343, 6);
  });

  it('gives the interface its two sounds, dry and immediate', () => {
    const { audio, ctx } = boot();
    const built = made;
    audio.uiSelect();
    expect(made).toBeGreaterThan(built);
    expect(starts.at(-1)).toBe(ctx.currentTime);
    starts = [];
    audio.uiOrder();
    expect(starts).toEqual([ctx.currentTime, ctx.currentTime + 0.07]);
  });

  it('cannot be made to throw by anything a frame can hand it', () => {
    const { audio, ctx } = boot();
    const bad = cam();
    bad.scale = Number.NaN;
    const zero = cam();
    zero.scale = 0;
    for (const c of [cam(), bad, zero]) {
      for (const [w, h] of [[1280, 800], [0, 0], [Number.NaN, 800]]) {
        expect(() => {
          audio.ambience([{ x: Number.NaN, y: 3 }, { x: 100, y: 100 }], c, w, h, false);
          audio.addShots([shot(Number.NaN, 5), shot(100, 100), shot(Infinity, 0)], c, w, h);
          audio.addBooms([{ x: Number.NaN, y: 1, kind: 'shell', r: Number.NaN }, { x: 100, y: 100, kind: 'bomb', r: 5 }], c, w, h);
          audio.addBreaches([{ x: Number.NaN, y: 2, horiz: true }], c, w, h);
          audio.uiSelect();
          audio.uiOrder();
        }).not.toThrow();
      }
    }
    ctx.currentTime = Number.NaN; // a context that has lost its clock
    expect(() => audio.ambience([{ x: 100, y: 100 }], cam(), 1280, 800, false)).not.toThrow();
  });

  it('is inert before the first gesture: no context, no nodes, no throw', () => {
    (globalThis as unknown as { window: unknown }).window = {};
    const audio = new AudioEngine();
    audio.unlock(); // no AudioContext to make
    expect(() => {
      audio.ambience([{ x: 1, y: 1 }], cam(), 1280, 800, false);
      audio.uiSelect();
      audio.uiOrder();
    }).not.toThrow();
    expect(made).toBe(0);
  });
});
