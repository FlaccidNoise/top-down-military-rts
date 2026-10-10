import type { Camera } from './camera';
import { blit, WIND } from './fx';
import { hash } from './noise';
import { MOBILE } from './view';

// Battle pall: the powder smoke and dust that hang where the fighting is and
// drift off it on the wind. A flash is three frames and a blast's own smoke is
// gone in nine seconds; this is what makes a field look fought over a quarter
// of a minute later, and what shows where the fight is with the whole map on
// screen.
//
// It is NOT the sim's smoke and must never be mistaken for it. Sim smoke
// blocks sight, so the player plans round it; pall blocks nothing. The two are
// kept apart on every axis there is: pall is one pale warm layer capped at
// PALL_ALPHA where a smoke screen is a stack of mid-grey puffs several times
// that dense, it has no column and no lean, and it sits under the roofs while
// smoke sits over them.
//
// A capped list of puffs, fed rather than spawned: a shot or a blast tops up
// the nearest puff, and only starts a new one when none is in reach. A firing
// line therefore costs a handful of blits however long it fires, and because a
// puff drifts while its source stays put, a long fight lays a trail downwind.

export interface Puff {
  x0: number; // where it would be at `born` — the drift below is added to this
  y0: number;
  born: number; // ms, fx clock
  fed: number; // ms of the last top-up; the life below is counted from here
  d: number; // density at the last top-up, 0..1
  k: number; // hash key for its shape
  seen: boolean; // the fog answer it was created under
  seenTick: number;
}

export const PALL_CAP = MOBILE ? 20 : 48;
export const PALL_MIN_MS = 8000; // a wisp
export const PALL_MAX_MS = 20000; // a position that was fired from for a while
const PALL_ALPHA = 0.2;
const REACH = 4; // m — a feed this close to a puff tops it up
const DRIFT = 0.35; // of the wind speed: air this low is slower than a column
const SEEN_TICKS = 15; // 0.5 s between fog re-tests per puff, the fires' throttle

// How long a puff of this density outlives its last feed.
export function pallLife(d: number): number {
  return PALL_MIN_MS + (PALL_MAX_MS - PALL_MIN_MS) * d;
}

// What is left of a puff `age` ms after its last feed: all of it for the first
// half of its life, then a straight fade.
export function pallLeft(d: number, age: number): number {
  const e = 1 - age / pallLife(d);
  return e <= 0 ? 0 : d * Math.min(1, e / 0.5);
}

export class PallLayer {
  readonly puffs: Puff[] = [];
  private seq = 0;

  private at(p: Puff, now: number): [number, number] {
    const m = ((now - p.born) / 1000) * WIND.speed * DRIFT;
    return [p.x0 + WIND.dx * m, p.y0 + WIND.dy * m];
  }

  // Top up the pall at a world point. `amount` is density, 0..1. `seen` is the
  // fog test for something the player has no right to see for free; it is asked
  // only when a puff is created or its last answer has gone stale, never per
  // shot. Leave it out for a source that is drawn ungated anyway.
  feed(x: number, y: number, amount: number, now: number, tick: number, seen?: () => boolean): void {
    if (!(amount > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    let near: Puff | undefined;
    let nearD = REACH;
    for (const p of this.puffs) {
      const [px, py] = this.at(p, now);
      const d = Math.hypot(px - x, py - y);
      if (d < nearD) {
        nearD = d;
        near = p;
      }
    }
    if (near) {
      if (seen && tick - near.seenTick >= SEEN_TICKS) {
        near.seen = seen();
        near.seenTick = tick;
      }
      if (!near.seen) return;
      // Pull the puff toward what is feeding it, by how much of it is new.
      const left = pallLeft(near.d, now - near.fed);
      const d = Math.min(1, left + amount);
      const w = amount / (left + amount);
      const [px, py] = this.at(near, now);
      near.x0 += (x - px) * w;
      near.y0 += (y - py) * w;
      near.d = d;
      near.fed = now;
      return;
    }
    if (seen && !seen()) return;
    if (this.puffs.length >= PALL_CAP) {
      // Full: the thinnest puff makes room. A fight that has moved on gives up
      // its haze to the one still going.
      let thin = 0;
      let least = Infinity;
      for (let i = 0; i < this.puffs.length; i++) {
        const left = pallLeft(this.puffs[i].d, now - this.puffs[i].fed);
        if (left < least) {
          least = left;
          thin = i;
        }
      }
      this.puffs.splice(thin, 1);
    }
    this.puffs.push({ x0: x, y0: y, born: now, fed: now, d: Math.min(1, amount), k: this.seq++, seen: true, seenTick: tick });
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      const left = pallLeft(p.d, now - p.fed);
      if (left <= 0) {
        this.puffs.splice(i, 1);
        continue;
      }
      const [wx, wy] = this.at(p, now);
      const [x, y] = cam.worldToScreen(wx, wy, cw, ch);
      const secs = (now - p.born) / 1000;
      // It opens as it drifts. The 9 px floor is the whole-map read: a puff
      // that would be two pixels there is the mark that says "here".
      const r = Math.max(9, (2.6 + 2.2 * p.d) * (1 + Math.min(1, secs / 12) * 0.6) * cam.scale);
      if (x < -r * 2 || y < -r * 2 || x > cw + r * 2 || y > ch + r * 2) continue;
      const a = PALL_ALPHA * left * Math.min(1, secs / 0.6);
      blit(ctx, 'pall', x, y, r, a);
      // A second, offset lobe, so a puff is a patch of air and not a disc. A
      // phone keeps it: its saving is the smaller cap, and one lobe alone is
      // exactly the pale disc this layer must not look like.
      const ang = hash(p.k, 0, 610) * Math.PI * 2;
      blit(ctx, 'pall', x + Math.cos(ang) * r * 0.7, y + Math.sin(ang) * r * 0.7, r * (0.6 + hash(p.k, 0, 611) * 0.25), a * 0.8);
    }
  }
}
