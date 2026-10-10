// The one teaching bubble. The tutorial driver is its only owner: nothing else
// may put text in this slot, so a step is never evicted by a second system.
//
// The bubble is `position: fixed` and is re-placed every frame against the
// LAYOUT viewport. An absolutely positioned bubble hung off a chip that had
// scrolled out of its row once grew the document, Chrome grew innerWidth to
// match, and every fixed HUD layer laid out against the larger viewport
// (jtbug #783). A fixed box cannot grow the document, and the clamp reads
// documentElement.clientWidth/Height, which the document cannot inflate.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  side: 'below' | 'above' | 'right' | 'left';
  /** Offset of the pointer along the bubble's near edge, in px. */
  arrow: number;
}

const GAP = 10; // bubble to the thing it points at
const EDGE = 8; // bubble to the viewport edge
const ARROW_INSET = 14;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Where a w×h bubble goes so that it points at `anchor`, stays inside `bounds`
 * and covers no part of `clear` (the control the step names). `bounds` is the
 * layout viewport for a control, and the map clear of the HUD for a point in
 * the world. Pure. Sides are tried below, above, right, left; the first that
 * fits whole wins. When none fits the bubble takes the roomier of below and
 * above and is clamped inside the bounds — a bubble the player can read beats
 * one that is correct and clipped.
 */
export function placeBubble(anchor: Rect, clear: Rect, w: number, h: number, bounds: Rect): Placement {
  const cx = (anchor.left + anchor.right) / 2;
  const cy = (anchor.top + anchor.bottom) / 2;
  const minLeft = bounds.left + EDGE;
  const minTop = bounds.top + EDGE;
  const maxLeft = Math.max(minLeft, bounds.right - EDGE - w);
  const maxTop = Math.max(minTop, bounds.bottom - EDGE - h);
  const across = clamp(cx - w / 2, minLeft, maxLeft);
  const down = clamp(cy - h / 2, minTop, maxTop);
  const arrowX = (left: number): number => clamp(cx - left, ARROW_INSET, Math.max(ARROW_INSET, w - ARROW_INSET));
  const arrowY = (top: number): number => clamp(cy - top, ARROW_INSET, Math.max(ARROW_INSET, h - ARROW_INSET));
  // A side fits only if the box lands whole inside the bounds there: an
  // anchor that is itself off screen must not carry the bubble off with it.
  const fitsY = (top: number): boolean => top >= minTop && top <= maxTop;
  const fitsX = (left: number): boolean => left >= minLeft && left <= maxLeft;
  const below = clear.bottom + GAP;
  const above = clear.top - GAP - h;
  if (fitsY(below)) return { left: across, top: below, side: 'below', arrow: arrowX(across) };
  if (fitsY(above)) return { left: across, top: above, side: 'above', arrow: arrowX(across) };
  const right = clear.right + GAP;
  const left = clear.left - GAP - w;
  if (fitsX(right)) return { left: right, top: down, side: 'right', arrow: arrowY(down) };
  if (fitsX(left)) return { left, top: down, side: 'left', arrow: arrowY(down) };
  const roomBelow = bounds.bottom - clear.bottom;
  const roomAbove = clear.top - bounds.top;
  return roomBelow >= roomAbove
    ? { left: across, top: clamp(below, minTop, maxTop), side: 'below', arrow: arrowX(across) }
    : { left: across, top: clamp(above, minTop, maxTop), side: 'above', arrow: arrowX(across) };
}

/**
 * An element's rect as far as the player can see it: clipped by every
 * scrolling ancestor. A chip scrolled out of its row resolves to the row, so a
 * bubble can never be anchored to a point that is off screen. null = the
 * element is not laid out at all.
 */
export function visibleRect(el: Element): Rect | null {
  const b = el.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return null;
  let r: Rect = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const c = p.getBoundingClientRect();
    const cut: Rect = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
    r = cut.right > cut.left && cut.bottom > cut.top ? cut : { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
  }
  return r;
}

export interface BubbleSpec {
  text: string;
  /**
   * Read every frame. The anchor moves with the camera, is replaced when the
   * HUD re-renders, or is not laid out yet; null hides the bubble for that
   * frame instead of leaving it pointing at nothing.
   */
  locate(): { anchor: Rect; clear: Rect; bounds?: Rect } | null;
  onDismiss(): void;
  onSkip(): void;
}

export class Coach {
  private el: HTMLDivElement | null = null;
  private spec: BubbleSpec | null = null;
  private placed = '';

  show(spec: BubbleSpec): void {
    if (typeof document === 'undefined') return;
    this.hide();
    const el = document.createElement('div');
    el.className = 'coach';
    const text = document.createElement('span');
    text.className = 'coach-text';
    text.textContent = spec.text;
    const skip = document.createElement('button');
    skip.className = 'coach-skip';
    skip.textContent = 'Skip tutorial';
    skip.addEventListener('click', () => { this.hide(); spec.onSkip(); });
    const x = document.createElement('button');
    x.className = 'coach-x';
    x.textContent = '✕';
    x.title = 'Dismiss';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', () => { this.hide(); spec.onDismiss(); });
    el.append(text, skip, x);
    document.body.appendChild(el);
    this.el = el;
    this.spec = spec;
    // Placed in the same task as the append: a bubble corrected one frame
    // later renders once in the wrong place.
    this.reflow(false);
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
    this.spec = null;
    this.placed = '';
  }

  /** Once per frame. `suppressed` = a full-screen menu owns the screen. */
  reflow(suppressed: boolean): void {
    const el = this.el;
    if (!el || !this.spec) return;
    const at = suppressed ? null : this.spec.locate();
    if (!at) {
      if (this.placed !== 'hidden') {
        el.style.display = 'none';
        this.placed = 'hidden';
      }
      return;
    }
    if (this.placed === 'hidden') el.style.display = '';
    // The layout viewport, which the document cannot inflate. `bounds` only
    // ever narrows it.
    const root = document.documentElement;
    const vp: Rect = { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight };
    const b = at.bounds;
    const bounds: Rect = b
      ? { left: Math.max(vp.left, b.left), top: Math.max(vp.top, b.top), right: Math.min(vp.right, b.right), bottom: Math.min(vp.bottom, b.bottom) }
      : vp;
    const p = placeBubble(at.anchor, at.clear, el.offsetWidth, el.offsetHeight, bounds);
    const key = `${Math.round(p.left)},${Math.round(p.top)},${p.side},${Math.round(p.arrow)}`;
    if (key === this.placed) return;
    this.placed = key;
    el.style.left = `${Math.round(p.left)}px`;
    el.style.top = `${Math.round(p.top)}px`;
    el.dataset.side = p.side;
    el.style.setProperty('--coach-arrow', `${Math.round(p.arrow)}px`);
  }
}
