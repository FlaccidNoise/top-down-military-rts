import type { Camera } from './camera';
import { blit, fxDetail, type FxKind } from './fx';
import { hash } from './noise';
import { MOBILE } from './view';

// Fine-detail world stamps — the crisp complement to DecalLayer. Decals bake
// into a world canvas at PPM=8, which makes a 0.11 m pockmark under a pixel
// wide; a canvas fine enough for them would be hundreds of MB over a 320x240
// map. So these stay as a capped list of positions and blit a baked sprite per
// mark instead, culled to the viewport.
//
// Two guards keep a long firefight from either tanking the frame or turning a
// contested wall solid black: a fixed-capacity ring buffer, and a per-0.5 m
// cell quota so strikes cluster rather than cake.

const CAP = 640;
const CELL = 0.5;
const PER_CELL = 6;
const MARK_R = 0.075; // meters — half of the 0.15 m draw size
const POCKS: FxKind[] = ['pock0', 'pock1', 'pock2', 'pock3'];

interface Mark {
  x: number;
  y: number;
  variant: number;
}

export class MarkLayer {
  private marks: Mark[] = [];
  private next = 0;
  private density = new Map<number, number>();

  // A bullet strike in masonry. Deliberately unrotated: the pock bake throws
  // its spall crescent opposite SUN, and spinning the sprite would break the
  // one-sun rule for the sake of variety the four variants already provide.
  add(x: number, y: number): void {
    const key = (Math.floor(y / CELL) << 10) + Math.floor(x / CELL);
    const n = this.density.get(key) ?? 0;
    if (n >= PER_CELL) return;
    this.density.set(key, n + 1);
    const m: Mark = { x, y, variant: Math.floor(hash(Math.round(x * 100), Math.round(y * 100), 5) * 4) };
    if (this.marks.length < CAP) this.marks.push(m);
    else {
      this.marks[this.next] = m;
      this.next = (this.next + 1) % CAP;
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    if (fxDetail(cam.scale) < 1) return; // sub-10 px/m: a 0.11 m chip is not a pixel
    const r = MARK_R * cam.scale;
    const pad = cam.scale;
    for (const m of this.marks) {
      const [x, y] = cam.worldToScreen(m.x, m.y, cw, ch);
      if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) continue;
      blit(ctx, POCKS[m.variant], x, y, r, 0.85);
    }
  }
}

// Spent brass. An automatic weapon throws a case per round out to its right,
// and they stay where they fall: the mark that says a gun worked from here.
// The same capped list of positions as the pockmarks above, for the same
// reason — a case is far too small for the 8 px/m decal layer. Drawn twice
// life size (a real .30 case is 6 cm, which is one pixel at 24 px/m), and only
// at close zoom; they are recorded at any zoom, so they are there to zoom in on.

const BRASS_CAP = MOBILE ? 160 : 480;
const BRASS_MIN_SCALE = 20; // px/m
const BRASS_R = 0.07; // meters — half the drawn length

export class BrassLayer {
  private xs = new Float32Array(BRASS_CAP);
  private ys = new Float32Array(BRASS_CAP);
  private n = 0; // cases ever dropped; the ring index is n % BRASS_CAP

  add(x: number, y: number): void {
    this.xs[this.n % BRASS_CAP] = x;
    this.ys[this.n % BRASS_CAP] = y;
    this.n++;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    if (cam.scale < BRASS_MIN_SCALE || this.n === 0) return;
    const r = BRASS_R * cam.scale;
    const live = Math.min(this.n, BRASS_CAP);
    for (let i = 0; i < live; i++) {
      const [x, y] = cam.worldToScreen(this.xs[i], this.ys[i], cw, ch);
      if (x < -r || y < -r || x > cw + r || y > ch + r) continue;
      blit(ctx, 'brass', x, y, r, 0.9, hash(i, 0, 640) * Math.PI);
    }
  }
}
