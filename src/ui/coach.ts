// One-time contextual coachmarks. localStorage-gated, no forced tutorial.
// Pure logic (loadDismissed, saveDismissed) extractable for testing.

export const COACH_STORAGE_KEY = 'rts.coach.v1';

export function loadDismissed(storage?: Pick<Storage, 'getItem'>): Set<string> {
  const s = new Set<string>();
  if (!storage) return s;
  try {
    const raw = storage.getItem(COACH_STORAGE_KEY);
    if (raw) {
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string') s.add(v);
    }
  } catch { /* corrupt */ }
  return s;
}

export function saveDismissed(dismissed: ReadonlySet<string>, storage?: Pick<Storage, 'setItem'>): void {
  if (!storage) return;
  try { storage.setItem(COACH_STORAGE_KEY, JSON.stringify([...dismissed])); } catch { /* quota */ }
}

export class Coach {
  private dismissed: Set<string>;
  private storage?: Pick<Storage, 'setItem'>;
  private currentEl: HTMLDivElement | null = null;

  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.storage = storage;
    this.dismissed = loadDismissed(storage);
  }

  isDismissed(id: string): boolean {
    return this.dismissed.has(id);
  }

  maybeShow(id: string, target: HTMLElement, text: string): void {
    if (this.dismissed.has(id) || typeof document === 'undefined') return;
    this.bubble(target, text, () => this.dismiss(id), null);
  }

  /**
   * A tutorial-driver bubble: the same chrome plus a "Skip tutorial" link. The
   * driver owns its own gating and its own storage, so nothing here reads or
   * writes the coach dismissed set.
   */
  showStep(target: HTMLElement, text: string, onDismiss: () => void, onSkip: () => void): void {
    if (typeof document === 'undefined') return;
    this.bubble(target, text, onDismiss, onSkip);
  }

  hide(): void {
    this.hideCurrent();
  }

  private bubble(target: HTMLElement, text: string, onDismiss: () => void, onSkip: (() => void) | null): void {
    this.hideCurrent();
    const el = document.createElement('div');
    el.className = 'coach';
    const skip = onSkip ? '<button class="coach-skip">Skip tutorial</button>' : '';
    el.innerHTML = `<span class="coach-text">${text}</span>${skip}<button class="coach-x" aria-label="Dismiss" title="Dismiss">\u2715</button>`;
    el.querySelector('.coach-x')!.addEventListener('click', () => { this.hideCurrent(); onDismiss(); });
    if (onSkip) el.querySelector('.coach-skip')!.addEventListener('click', () => { this.hideCurrent(); onSkip(); });
    const r = target.getBoundingClientRect();
    el.style.position = 'absolute';
    el.style.top = `${r.bottom + window.scrollY + 8}px`;
    el.style.left = `${r.left + window.scrollX + r.width / 2}px`;
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '20';
    document.body.appendChild(el);
    // clamp horizontally, and flip above the target when anchoring below would
    // push the bubble off the bottom — which is every coachmark on a phone,
    // where the thing being explained is the bottom touch bar.
    requestAnimationFrame(() => {
      const cr = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const l = parseFloat(el.style.left);
      if (cr.left < 8) el.style.left = `${l + 8 - cr.left}px`;
      if (cr.right > vw - 8) el.style.left = `${l - (cr.right - (vw - 8))}px`;
      if (cr.bottom > window.innerHeight - 8) {
        el.classList.add('above');
        el.style.top = `${r.top + window.scrollY - cr.height - 8}px`;
      }
    });
    this.currentEl = el;
  }

  dismissAll(): void {
    this.dismissed.clear();
    this.store();
    this.hideCurrent();
  }

  private dismiss(id: string): void {
    this.dismissed.add(id);
    this.store();
    this.hideCurrent();
  }

  private hideCurrent(): void {
    if (this.currentEl) { this.currentEl.remove(); this.currentEl = null; }
  }

  private store(): void {
    if (this.storage) saveDismissed(this.dismissed, this.storage);
  }
}

export const coach = new Coach(typeof localStorage !== 'undefined' ? localStorage : undefined);