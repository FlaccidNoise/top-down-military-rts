// Touch input: Pointer Events on the canvas, mapped onto the same intent
// functions the mouse drives. Two hard rules keep the desktop path untouched:
// pointerType 'mouse' is ignored outright (a touchscreen laptop stays on the
// mouse path), and a non-passive `touchstart` preventDefault suppresses the
// synthesized mousedown/mousemove/mouseup that would otherwise re-enter the
// desktop handlers and double-fire every gesture.

export const TAP_SLOP = 12; // px a finger may wander and still count as still
export const HOLD_MS = 420; // press duration that arms the right-click equivalent
export const TWO_TAP_MS = 260; // window for a two-finger tap to read as "escape"

export type Gesture = 'tap' | 'pan' | 'pinch' | 'hold' | 'holdDrag' | 'twoTap';

/**
 * Pure classifier, called at the moment a decision is forced: either the frame
 * a finger crosses TAP_SLOP, or the frame the last finger lifts. `dt` is ms
 * since the first finger landed, `dist` the furthest any finger has travelled
 * from where it landed, `fingers` how many are still down, `maxFingers` the
 * most that were down at once.
 */
export function classify(g: { dt: number; dist: number; fingers: number; maxFingers: number }): Gesture {
  if (g.fingers >= 2) return 'pinch';
  if (g.maxFingers >= 2) return g.dt <= TWO_TAP_MS && g.dist <= TAP_SLOP ? 'twoTap' : 'pinch';
  if (g.dist > TAP_SLOP) return g.dt >= HOLD_MS ? 'holdDrag' : 'pan';
  return g.dt >= HOLD_MS ? 'hold' : 'tap';
}

export interface TouchHandlers {
  /** First finger down — arm the growing hold ring. */
  press(x: number, y: number): void;
  /** Gesture over, whatever it was — drop the ring. */
  release(): void;
  tap(x: number, y: number): void;
  pan(dx: number, dy: number): void;
  /** HOLD_MS elapsed without moving: the right-mouse-down equivalent. */
  holdStart(x: number, y: number): void;
  /** Finger moved while the hold is live: formation drag + hover emulation. */
  holdMove(x: number, y: number): void;
  holdEnd(x: number, y: number): void;
  /** Hold abandoned (second finger, pointercancel) without issuing anything. */
  holdCancel(): void;
  pinch(factor: number, midX: number, midY: number, dMidX: number, dMidY: number): void;
  twoTap(): void;
}

interface Pt {
  x0: number;
  y0: number;
  x: number;
  y: number;
  px: number;
  py: number;
}

const mid = (a: Pt, b: Pt): { x: number; y: number } => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const gap = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function bindTouch(canvas: HTMLCanvasElement, active: () => TouchHandlers): void {
  const pts = new Map<number, Pt>();
  let maxFingers = 0;
  let t0 = 0;
  let moved = 0;
  let holdTimer = 0;
  let holding = false;
  let panning = false;
  let pinchGap = 0;
  let pinchMid = { x: 0, y: 0 };

  const clearHold = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = 0;
  };

  const endGesture = (): void => {
    clearHold();
    holding = false;
    panning = false;
    pts.clear();
    maxFingers = 0;
    moved = 0;
    active().release();
  };

  // The reliable cross-engine way to kill the compatibility mouse events.
  // A touch that lands while a list is still coasting from a flick cannot be
  // cancelled, and asking anyway only earns a browser warning.
  canvas.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      if (pts.size === 0) {
        t0 = performance.now();
        moved = 0;
        maxFingers = 0;
      }
      pts.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY });
      maxFingers = Math.max(maxFingers, pts.size);
      canvas.setPointerCapture(e.pointerId);

      if (pts.size === 1) {
        active().press(e.clientX, e.clientY);
        const px = e.clientX;
        const py = e.clientY;
        holdTimer = window.setTimeout(() => {
          holdTimer = 0;
          if (panning || pts.size !== 1) return;
          holding = true;
          active().holdStart(px, py);
        }, HOLD_MS);
      } else if (pts.size === 2) {
        clearHold();
        if (holding) active().holdCancel();
        active().release();
        holding = false;
        panning = false;
        const [a, b] = [...pts.values()];
        pinchGap = gap(a, b);
        pinchMid = mid(a, b);
      }
    },
    { passive: false },
  );

  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'mouse') return;
      const p = pts.get(e.pointerId);
      if (!p) return;
      e.preventDefault();
      p.px = p.x;
      p.py = p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      moved = Math.max(moved, Math.hypot(p.x - p.x0, p.y - p.y0));
      const h = active();

      if (pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const g = gap(a, b);
        const m = mid(a, b);
        if (pinchGap > 0) h.pinch(g / pinchGap, m.x, m.y, m.x - pinchMid.x, m.y - pinchMid.y);
        pinchGap = g;
        pinchMid = m;
        return;
      }

      if (holding) {
        h.holdMove(p.x, p.y);
        return;
      }
      if (panning) {
        h.pan(p.x - p.px, p.y - p.py);
        return;
      }
      const g = classify({ dt: performance.now() - t0, dist: moved, fingers: 1, maxFingers });
      if (g === 'pan') {
        clearHold();
        h.release();
        panning = true;
        h.pan(p.x - p.px, p.y - p.py);
      }
    },
    { passive: false },
  );

  const up = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerType === 'mouse') return;
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const h = active();

    if (cancelled) {
      if (holding) h.holdCancel();
      endGesture();
      return;
    }

    if (pts.size > 0) {
      // Lifting one of two fingers: the remaining finger must not become a
      // pan/tap mid-pinch, so re-seat the pinch and wait for the last release.
      clearHold();
      panning = false;
      return;
    }

    clearHold();
    const g = classify({ dt: performance.now() - t0, dist: moved, fingers: 0, maxFingers });
    if (g === 'twoTap') h.twoTap();
    else if (holding) h.holdEnd(p.x, p.y);
    else if (g === 'tap') h.tap(p.x, p.y);
    endGesture();
  };

  canvas.addEventListener('pointerup', (e) => up(e, false), { passive: false });
  canvas.addEventListener('pointercancel', (e) => up(e, true), { passive: false });
}

// Growing amber ring under the finger: the only feedback that a press is
// becoming an order. Completes (solid ring + centre dot) the instant the hold
// arms, which is also the instant the formation-drag preview lights up.
export function drawHoldRing(ctx: CanvasRenderingContext2D, hold: { x: number; y: number; t0: number }, now: number): void {
  const t = Math.min(1, (now - hold.t0) / HOLD_MS);
  if (t < 0.15) return;
  const r = 15 + 7 * t;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(18, 22, 15, 0.5)';
  ctx.beginPath();
  ctx.arc(hold.x, hold.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = t >= 1 ? '#ffe9a0' : 'rgba(255, 202, 106, 0.85)';
  ctx.beginPath();
  ctx.arc(hold.x, hold.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
  ctx.stroke();
  if (t >= 1) {
    ctx.fillStyle = 'rgba(255, 233, 160, 0.9)';
    ctx.beginPath();
    ctx.arc(hold.x, hold.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
