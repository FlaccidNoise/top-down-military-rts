// The tutorial driver: a sequenced, contextual, skippable teaching layer over
// the LIVE game. Every step is fired by a real game event, never by a timer and
// never by a scripted sandbox. The state machine (advance) is pure and lives
// beside the storage helpers so it tests without a DOM, the way coach.ts does.
//
// The driver never blocks a veteran: every bubble carries ✕ (retire this step)
// and "Skip tutorial" (retire every step, forever), and the briefing card
// carries both plus a Field Manual door.
import { visibleRect, type Coach, type Rect } from './coach';
import { esc } from './mainmenu';
import { MANUAL } from './manual-data';
import { SPEED_LABELS } from './strat-hud';

export const TUTORIAL_STORAGE_KEY = 'rts.tutorial.v1';

export type TutorialEvent =
  | 'campaign-start'
  | 'briefing-begun'
  | 'force-selected'
  | 'move-ordered'
  | 'speed-changed'
  | 'contact-open'
  | 'contact-closed'
  | 'deploy-start'
  | 'deploy-commit'
  | 'squad-selected'
  | 'order-issued'
  | 'debrief-open'
  | 'debrief-closed';

export type StepId =
  | 'briefing'
  | 'select-force'
  | 'march'
  | 'speed'
  | 'contact'
  | 'deploy'
  | 'battle-select'
  | 'battle-order'
  | 'debrief';

export interface TutorialState {
  skipped: boolean;
  done: StepId[];
}

/** A place in the game world a step can ring. The game resolves it per frame. */
export type WorldMark = 'squad';

/** A world mark on screen: centre and ring radius, in CSS px. */
export interface Circle {
  x: number;
  y: number;
  r: number;
}

interface Step {
  id: StepId;
  /** Events that put this step on screen. More than one keeps it resumable. */
  showOn: readonly TutorialEvent[];
  /** The event that retires it. */
  doneOn: TutorialEvent;
  /** A step that must already be done before this one may show. */
  requires?: StepId;
  /** CSS selector the bubble points at. A step has this or `mark`; the briefing card has neither. */
  anchor?: { desktop: string; touch: string };
  /** The world point the bubble points at, drawn as a pulsing ring. */
  mark?: WorldMark;
  text?: { desktop: string; touch: string };
}

// Every number the copy states is imported from the constant that owns it —
// the manual-data drift tripwire does not watch this file.
const TOP_SPEED = SPEED_LABELS[SPEED_LABELS.length - 1];

const GOAL_CHAPTER = MANUAL.find((c) => c.id === 'goal');
if (!GOAL_CHAPTER) throw new Error("tutorial: MANUAL has no 'goal' chapter — the briefing card reads its first three entries");
const BRIEFING_ENTRIES = GOAL_CHAPTER.entries.slice(0, 3);

/** Teaching order. The array order decides which step wins a shared event. */
export const STEPS: readonly Step[] = [
  {
    id: 'briefing',
    showOn: ['campaign-start'],
    doneOn: 'briefing-begun',
  },
  {
    id: 'select-force',
    showOn: ['briefing-begun', 'campaign-start'],
    doneOn: 'force-selected',
    requires: 'briefing',
    // The HUD root is a full-viewport fixed layer; only its panels have a rect
    // a bubble can point at.
    anchor: { desktop: '#theater-hud .th-top', touch: '#theater-hud .th-top' },
    text: {
      desktop: 'Click one of your blue companies to select it.',
      touch: 'Tap a blue company to select it.',
    },
  },
  {
    id: 'march',
    showOn: ['force-selected'],
    doneOn: 'move-ordered',
    requires: 'select-force',
    // The HUD root is a full-viewport fixed layer; only its panels have a rect
    // a bubble can point at.
    anchor: { desktop: '#theater-hud .th-top', touch: '#theater-hud .th-top' },
    text: {
      desktop: 'Point at a gold-ringed town: the route and the ETA show. Right-click to march there.',
      touch: 'Press and hold a gold-ringed town: the route and the ETA show. Let go to march there.',
    },
  },
  {
    id: 'speed',
    showOn: ['move-ordered'],
    doneOn: 'speed-changed',
    requires: 'march',
    anchor: { desktop: '#theater-hud .st-speed', touch: '#theater-hud .st-speed' },
    text: {
      desktop: `March at ${TOP_SPEED}. Pause any time — the war waits for your orders.`,
      touch: `March at ${TOP_SPEED}. Pause any time — the war waits for your orders.`,
    },
  },
  {
    id: 'contact',
    showOn: ['contact-open'],
    doneOn: 'contact-closed',
    anchor: { desktop: '#fight', touch: '#fight' },
    text: {
      desktop: 'Attack stages the real battle. Read the odds line first.',
      touch: 'Attack stages the real battle. Read the odds line first.',
    },
  },
  {
    id: 'deploy',
    showOn: ['deploy-start'],
    doneOn: 'deploy-commit',
    anchor: { desktop: '[data-act="pause"]', touch: '[data-tb="pause"]' },
    text: {
      desktop: 'Press Play to start.',
      touch: 'Tap Play to start.',
    },
  },
  {
    id: 'battle-select',
    showOn: ['deploy-commit'],
    doneOn: 'squad-selected',
    mark: 'squad',
    text: {
      desktop: 'Click a squad.',
      touch: 'Tap a squad.',
    },
  },
  {
    id: 'battle-order',
    showOn: ['squad-selected'],
    doneOn: 'order-issued',
    mark: 'squad',
    text: {
      desktop: 'Right-click the ground to send them.',
      touch: 'Press and hold the ground to send them.',
    },
  },
  {
    id: 'debrief',
    showOn: ['debrief-open'],
    doneOn: 'debrief-closed',
    anchor: { desktop: '#next', touch: '#next' },
    text: {
      desktop: 'These men persist. Wounds carry between battles and a KIA is forever. Read your roster before the next fight.',
      touch: 'These men persist. Wounds carry between battles and a KIA is forever. Read your roster before the next fight.',
    },
  },
];

const STEP_IDS = new Set<string>(STEPS.map((s) => s.id));

export function loadState(storage?: Pick<Storage, 'getItem'>): TutorialState {
  const fresh: TutorialState = { skipped: false, done: [] };
  if (!storage) return fresh;
  try {
    const raw = storage.getItem(TUTORIAL_STORAGE_KEY);
    if (!raw) return fresh;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fresh;
    const o = v as { skipped?: unknown; done?: unknown };
    return {
      skipped: o.skipped === true,
      done: Array.isArray(o.done) ? (o.done.filter((d) => typeof d === 'string' && STEP_IDS.has(d)) as StepId[]) : [],
    };
  } catch {
    return fresh; // corrupt = fresh
  }
}

export function saveState(state: TutorialState, storage?: Pick<Storage, 'setItem'>): void {
  if (!storage) return;
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota */ }
}

/**
 * The state machine. Retires every step this event completes, then picks the
 * one step this event puts on screen. Skipped is terminal. Out-of-order arrival
 * retires only the step the event names — a player who marches before the
 * bubble arrives has learnt marching, not the whole chain.
 */
export function advance(state: TutorialState, event: TutorialEvent): { state: TutorialState; show: StepId | null } {
  if (state.skipped) return { state, show: null };
  const done = new Set<StepId>(state.done);
  for (const s of STEPS) if (s.doneOn === event) done.add(s.id);
  let show: StepId | null = null;
  for (const s of STEPS) {
    if (!s.showOn.includes(event) || done.has(s.id)) continue;
    if (s.requires && !done.has(s.requires)) continue;
    show = s.id;
    break;
  }
  return { state: { skipped: false, done: [...done] }, show };
}

const circleRect = (c: Circle): Rect => ({ left: c.x - c.r, top: c.y - c.r, right: c.x + c.r, bottom: c.y + c.r });

const RING_PERIOD_MS = 1100;

/**
 * The pulsing ring on a world mark. Wall clock, not the battle clock: the sim
 * is often paused while a step waits, and a ring that stops pulsing reads as
 * part of the map.
 */
export function drawMarkRing(ctx: CanvasRenderingContext2D, c: Circle, now: number): void {
  const t = (now % RING_PERIOD_MS) / RING_PERIOD_MS;
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(18, 22, 15, 0.55)';
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffe9a0';
  ctx.stroke();
  ctx.globalAlpha = 1 - t;
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r + 14 * t, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export class Tutorial {
  private state: TutorialState;
  private shown: StepId | null = null;
  private card: HTMLDivElement | null = null;

  constructor(
    private readonly coach: Pick<Coach, 'show' | 'hide' | 'reflow'>,
    private readonly touch: boolean,
    private readonly openManual: (chapterId: string) => void,
    private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>,
    /** Where a world mark is on screen right now. null = not in this scene. */
    private readonly world: (mark: WorldMark) => Circle | null = () => null,
    /** The part of the screen that is map: a world bubble never sits on the HUD. */
    private readonly stage: () => Rect | undefined = () => undefined,
  ) {
    this.state = loadState(storage);
  }

  get isSkipped(): boolean {
    return this.state.skipped;
  }

  /** A step is on screen. The game keeps its own hover card quiet meanwhile. */
  get isShowing(): boolean {
    return this.shown !== null;
  }

  /** The game reports what happened. Called from many sites, some every input. */
  notify(event: TutorialEvent): void {
    if (this.state.skipped) return;
    const r = advance(this.state, event);
    const progressed = r.state.done.length !== this.state.done.length;
    this.state = r.state;
    if (this.shown && this.state.done.includes(this.shown)) {
      this.coach.hide();
      this.shown = null;
    }
    if (r.show) this.present(r.show);
    if (progressed) saveState(this.state, this.storage);
  }

  /**
   * Once per frame, in every mode. `suppressed` = a full-screen menu owns the
   * screen, so the bubble stands down until it closes.
   */
  frame(suppressed: boolean): void {
    this.coach.reflow(suppressed);
  }

  /** The ring the game draws on its canvas for the step on screen, if any. */
  ring(): Circle | null {
    const mark = this.shown ? STEPS.find((s) => s.id === this.shown)!.mark : undefined;
    return mark ? this.world(mark) : null;
  }

  /** The briefing card's Begin: retires the card and starts the chain. */
  begin(): void {
    this.closeCard();
    this.notify('briefing-begun');
  }

  /**
   * The menu switch. Turning it ON clears progress as well as the skip, so the
   * chain replays from the briefing — which is the whole point of the control:
   * a player who has finished the tutorial turns it back on to show somebody
   * else, and "on but already completed" would teach them nothing. Turning it
   * OFF is exactly the Skip button.
   */
  setEnabled(on: boolean): void {
    if (!on) {
      this.skip();
      return;
    }
    this.state = { skipped: false, done: [] };
    this.shown = null;
    saveState(this.state, this.storage);
  }

  /** Terminal. Nothing tutorial-ish appears again on this profile. */
  skip(): void {
    this.state = { ...this.state, skipped: true };
    this.shown = null;
    this.coach.hide();
    this.closeCard();
    saveState(this.state, this.storage);
  }

  private present(id: StepId): void {
    if (id === 'briefing') {
      this.showBriefing();
      return;
    }
    if (typeof document === 'undefined') return;
    const step = STEPS.find((s) => s.id === id)!;
    const sel = step.anchor ? (this.touch ? step.anchor.touch : step.anchor.desktop) : null;
    this.coach.show({
      text: this.touch ? step.text!.touch : step.text!.desktop,
      locate: () => {
        if (step.mark) {
          const c = this.world(step.mark);
          if (!c) return null;
          const r = circleRect(c);
          return { anchor: r, clear: r, bounds: this.stage() };
        }
        const target = document.querySelector(sel!);
        const anchor = target && visibleRect(target);
        if (!anchor) return null;
        // A bubble pointing into the touch bar clears the whole bar: the order
        // row sits right above the chip it names.
        const bar = target!.closest('#touchbar');
        return { anchor, clear: (bar && visibleRect(bar)) ?? anchor };
      },
      onDismiss: () => this.markDone(id),
      onSkip: () => this.skip(),
    });
    this.shown = id;
  }

  private markDone(id: StepId): void {
    if (!this.state.done.includes(id)) this.state = { ...this.state, done: [...this.state.done, id] };
    if (this.shown === id) this.shown = null;
    saveState(this.state, this.storage);
  }

  private showBriefing(): void {
    if (typeof document === 'undefined' || this.card) return;
    const el = document.createElement('div');
    el.id = 'briefing';
    el.innerHTML = `<div class="bf-scroll"><div class="bf">
      <h1>YOUR ORDERS</h1>
      ${BRIEFING_ENTRIES.map((e) => `<article class="bf-entry"><h3>${esc(e.heading)}</h3><p>${esc(e.body)}</p></article>`).join('')}
      </div></div>
      <div class="bf-actions">
        <button id="bf-begin" class="primary">Begin</button>
        <button id="bf-manual">Field Manual</button>
        <button id="bf-skip">Skip tutorial</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#bf-begin')!.addEventListener('click', () => this.begin());
    el.querySelector('#bf-manual')!.addEventListener('click', () => this.openManual('goal'));
    el.querySelector('#bf-skip')!.addEventListener('click', () => this.skip());
    this.card = el;
    // Esc dismisses the card (= Begin). Without this it falls through to the
    // game and opens the pause menu INVISIBLY under the card (z 11 over 10).
    window.addEventListener('keydown', this.onCardKey, true);
  }

  private onCardKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    this.begin();
  };

  private closeCard(): void {
    if (this.card) {
      this.card.remove();
      this.card = null;
      window.removeEventListener('keydown', this.onCardKey, true);
    }
  }
}
