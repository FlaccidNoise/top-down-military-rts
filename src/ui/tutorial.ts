// The tutorial driver: a sequenced, contextual, skippable teaching layer over
// the LIVE game. Every step is fired by a real game event, never by a timer and
// never by a scripted sandbox. The state machine (advance) is pure and lives
// beside the storage helpers so it tests without a DOM, the way coach.ts does.
//
// The driver never blocks a veteran: every bubble carries ✕ (retire this step)
// and "Skip tutorial" (retire every step, forever), and the briefing card
// carries both plus a Field Manual door.
import type { Coach } from './coach';
import { esc } from './mainmenu';
import { MANUAL } from './manual-data';
import { ORDER_AFFORDANCE } from './order-data';
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
  | 'debrief-open'
  | 'debrief-closed';

export type StepId =
  | 'briefing'
  | 'select-force'
  | 'march'
  | 'speed'
  | 'contact'
  | 'deploy'
  | 'battle-orders'
  | 'debrief';

export interface TutorialState {
  skipped: boolean;
  done: StepId[];
}

interface Step {
  id: StepId;
  /** Events that put this step on screen. More than one keeps it resumable. */
  showOn: readonly TutorialEvent[];
  /** The event that retires it. null retires it the moment it shows. */
  doneOn: TutorialEvent | null;
  /** A step that must already be done before this one may show. */
  requires?: StepId;
  /** CSS selector for the bubble anchor. Absent on the briefing card. */
  anchor?: { desktop: string; touch: string };
  text?: { desktop: string; touch: string };
}

// Every number the copy states is imported from the constant that owns it —
// the manual-data drift tripwire does not watch this file.
const TOP_SPEED = SPEED_LABELS[SPEED_LABELS.length - 1];
const ORDER_KEYS = Object.values(ORDER_AFFORDANCE).map((o) => o.hotkey);
const ORDER_KEY_RANGE = `${ORDER_KEYS[0]}–${ORDER_KEYS[ORDER_KEYS.length - 1]}`;

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
      desktop: 'Right-click a gold-ringed town to march there. The path and the ETA preview before you commit.',
      touch: 'Press and hold a gold-ringed town to march there. The path and the ETA preview before you commit.',
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
      desktop: 'Deployment. Select squads and right-click inside your zone to reposition them. Resume commits and begins the fight.',
      touch: 'Deployment. Tap a squad, then press and hold inside your zone to reposition it. Resume commits and begins the fight.',
    },
  },
  {
    id: 'battle-orders',
    showOn: ['deploy-commit'],
    doneOn: null,
    requires: 'deploy',
    // The desktop anchor is the key-hint bar, not the roster panel: #squads is
    // full-viewport-height chrome, so a bubble hung off it has nowhere to sit,
    // and #hint is where the ⇧1–⇧8 bindings this step names are already listed.
    anchor: { desktop: '#hint', touch: '#touchbar' },
    text: {
      desktop: `Your orders arm with ${ORDER_KEY_RANGE}. The menu holds the Field Manual — it explains when each order is right.`,
      touch: 'Tap a squad, then an order chip. The ⚙ menu holds the Field Manual — it explains when each order is right.',
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
    if (s.doneOn === null) done.add(s.id);
    break;
  }
  return { state: { skipped: false, done: [...done] }, show };
}

export class Tutorial {
  private state: TutorialState;
  private shown: StepId | null = null;
  private card: HTMLDivElement | null = null;

  constructor(
    private readonly coach: Coach,
    private readonly touch: boolean,
    private readonly openManual: (chapterId: string) => void,
    private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>,
  ) {
    this.state = loadState(storage);
  }

  get isSkipped(): boolean {
    return this.state.skipped;
  }

  /** The only entry point the game calls. */
  notify(event: TutorialEvent): void {
    if (this.state.skipped) return;
    const r = advance(this.state, event);
    this.state = r.state;
    if (this.shown && this.state.done.includes(this.shown)) {
      this.coach.hide();
      this.shown = null;
    }
    if (r.show) this.present(r.show);
    saveState(this.state, this.storage);
  }

  /** The briefing card's Begin: retires the card and starts the chain. */
  begin(): void {
    this.closeCard();
    this.notify('briefing-begun');
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
    const target = document.querySelector<HTMLElement>(this.touch ? step.anchor!.touch : step.anchor!.desktop);
    if (!target) return; // anchor not on screen — the step re-arms on its next trigger
    this.coach.showStep(
      target,
      this.touch ? step.text!.touch : step.text!.desktop,
      () => this.markDone(id),
      () => this.skip(),
    );
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
  }

  private closeCard(): void {
    if (this.card) {
      this.card.remove();
      this.card = null;
    }
  }
}
