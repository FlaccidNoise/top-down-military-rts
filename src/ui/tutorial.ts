// The tutorial driver: a sequenced, contextual, skippable teaching layer over
// the LIVE game. Every step is fired by a real game event, never by a timer.
// The state machine (advance) is pure and lives beside the storage helpers so
// it tests without a DOM, the way coach.ts does.
//
// Two scenes share the one driver. The drill (src/drill.ts) is a lesson: its
// steps come in order, each holds the battle until the player has done it, and
// it replays from the top every time it is started. The campaign steps teach
// over a war the player is already fighting: they never hold anything, and one
// arriving out of order retires only itself.
//
// The driver never blocks a veteran: every bubble carries ✕ (retire this step)
// and "Skip tutorial" (retire every step, for good).
import type { OrderKind } from '../sim/orders';
import { visibleRect, type Coach, type Rect } from './coach';
import { SPEED_LABELS } from './strat-hud';

export const TUTORIAL_STORAGE_KEY = 'rts.tutorial.v1';

export type TutorialEvent =
  // the campaign
  | 'campaign-start'
  | 'force-selected'
  | 'move-ordered'
  | 'clock-advanced'
  | 'contact-open'
  | 'contact-closed'
  | 'deploy-start'
  | 'deploy-commit'
  | 'debrief-open'
  | 'debrief-closed'
  // any battle
  | 'squad-selected'
  | 'order-issued'
  // the drill
  | 'drill-start'
  | 'enemy-seen'
  | 'fire-armed'
  | 'fire-ordered'
  | 'house-quiet'
  | 'squad-switched'
  | 'assault-ordered'
  | 'team-balked'
  | 'battle-won';

export type StepId =
  | 'drill-select'
  | 'drill-move'
  | 'drill-contact'
  | 'drill-fire'
  | 'drill-quiet'
  | 'drill-assault'
  | 'drill-balk'
  | 'goal'
  | 'select-force'
  | 'march'
  | 'play'
  | 'contact'
  | 'deploy'
  | 'battle-select'
  | 'battle-order'
  | 'debrief';

export type Scene = 'drill' | 'campaign';

export interface TutorialState {
  skipped: boolean;
  done: StepId[];
  /** The drill has been started on this profile: the menu stops opening on it. */
  drilled: boolean;
}

/**
 * A place in the game world a step can ring. The game resolves it per frame.
 * 'squad' is the selected squad, or one near the middle of the screen. The
 * rest of the battle marks are the drill's own ground and men. 'company' and
 * 'town' are on the theater map.
 */
export type WorldMark = 'squad' | 'lead' | 'hedge' | 'enemy' | 'other' | 'house' | 'company' | 'town';

/** A world mark on screen: centre and ring radius, in CSS px. */
export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface Step {
  id: StepId;
  scene: Scene;
  /** Events that put this step on screen. More than one keeps it resumable. */
  showOn: readonly TutorialEvent[];
  /** The event that retires it. */
  doneOn: TutorialEvent;
  /** A step that must already be done before this one may show. */
  requires?: StepId;
  /** CSS selector the bubble points at. Without one the bubble points at `mark`. */
  anchor?: string;
  /** A world point drawn as a pulsing ring. */
  mark?: WorldMark;
  /** The order chip that glows until the player has armed it. */
  chip?: OrderKind;
  /** The battle stops while this step waits for the player. */
  holds?: boolean;
  /** Never recorded as done: it shows every time its event comes. */
  repeats?: boolean;
  /** Steps this one makes showable again when it shows. */
  reopens?: readonly StepId[];
  /** A line over the map and not a bubble. It never takes the bubble's turn. */
  line?: boolean;
  /** A line step has no fixed text: the game supplies it from live state. */
  text?: { desktop: string; touch: string };
}

// Every number the copy states is imported from the constant that owns it —
// the manual-data drift tripwire does not watch this file.
const TOP_SPEED = SPEED_LABELS[SPEED_LABELS.length - 1];

const both = (text: string): { desktop: string; touch: string } => ({ desktop: text, touch: text });

/** Teaching order. The array order decides which step wins a shared event. */
export const STEPS: readonly Step[] = [
  // ── the drill: one line a step, at most eight words ──
  {
    id: 'drill-select',
    scene: 'drill',
    showOn: ['drill-start'],
    doneOn: 'squad-selected',
    mark: 'lead',
    holds: true,
    text: { desktop: 'Click your squad.', touch: 'Tap your squad.' },
  },
  {
    id: 'drill-move',
    scene: 'drill',
    showOn: ['squad-selected'],
    doneOn: 'order-issued',
    requires: 'drill-select',
    mark: 'hedge',
    holds: true,
    text: { desktop: 'Right-click the hedge. Green dots mean cover.', touch: 'Hold on the hedge. Green dots mean cover.' },
  },
  {
    id: 'drill-contact',
    scene: 'drill',
    showOn: ['enemy-seen'],
    doneOn: 'fire-armed',
    anchor: '#orderbar [data-order="fire"]',
    mark: 'enemy',
    chip: 'fire',
    holds: true,
    text: { desktop: 'Enemy seen. Click Fire.', touch: 'Enemy seen. Tap Fire.' },
  },
  {
    id: 'drill-fire',
    scene: 'drill',
    showOn: ['fire-armed'],
    doneOn: 'fire-ordered',
    requires: 'drill-contact',
    mark: 'enemy',
    chip: 'fire',
    holds: true,
    text: { desktop: 'Now right-click the enemy.', touch: 'Now hold on the enemy.' },
  },
  {
    id: 'drill-quiet',
    scene: 'drill',
    showOn: ['house-quiet'],
    doneOn: 'squad-switched',
    requires: 'drill-fire',
    mark: 'other',
    holds: true,
    text: { desktop: 'They stopped shooting. Click another squad.', touch: 'They stopped shooting. Tap another squad.' },
  },
  {
    id: 'drill-assault',
    scene: 'drill',
    // 'house-quiet' brings it back after a refusal: see drill-balk.
    showOn: ['squad-switched', 'house-quiet'],
    doneOn: 'assault-ordered',
    requires: 'drill-quiet',
    anchor: '#orderbar [data-order="assault"]',
    mark: 'house',
    chip: 'assault',
    holds: true,
    text: { desktop: 'Click Assault, then right-click the house.', touch: 'Tap Assault, then hold on the house.' },
  },
  {
    id: 'drill-balk',
    scene: 'drill',
    showOn: ['team-balked'],
    doneOn: 'fire-ordered',
    mark: 'enemy',
    chip: 'fire',
    holds: true,
    repeats: true,
    reopens: ['drill-assault'],
    text: both("They won't go. Fire on the enemy first."),
  },
  // ── the campaign ──
  {
    id: 'goal',
    scene: 'campaign',
    showOn: ['campaign-start'],
    doneOn: 'move-ordered',
    line: true,
  },
  {
    id: 'select-force',
    scene: 'campaign',
    showOn: ['campaign-start'],
    doneOn: 'force-selected',
    mark: 'company',
    text: { desktop: 'Click a company.', touch: 'Tap a company.' },
  },
  {
    id: 'march',
    scene: 'campaign',
    showOn: ['force-selected'],
    doneOn: 'move-ordered',
    requires: 'select-force',
    mark: 'town',
    text: { desktop: 'Right-click a gold-ringed town. The route shows first.', touch: 'Hold a gold-ringed town. The route shows first.' },
  },
  {
    id: 'play',
    scene: 'campaign',
    showOn: ['move-ordered'],
    doneOn: 'clock-advanced',
    requires: 'march',
    anchor: '#theater-hud .st-pause',
    text: { desktop: `Press Play. ${TOP_SPEED} is faster.`, touch: `Tap Play. ${TOP_SPEED} is faster.` },
  },
  {
    id: 'contact',
    scene: 'campaign',
    showOn: ['contact-open'],
    doneOn: 'contact-closed',
    anchor: '#fight',
    text: both('This starts the battle.'),
  },
  {
    id: 'deploy',
    scene: 'campaign',
    showOn: ['deploy-start'],
    doneOn: 'deploy-commit',
    anchor: '[data-act="pause"], [data-tb="pause"]',
    text: { desktop: 'Press Play to start.', touch: 'Tap Play to start.' },
  },
  {
    id: 'battle-select',
    scene: 'campaign',
    showOn: ['deploy-commit'],
    doneOn: 'squad-selected',
    mark: 'squad',
    text: { desktop: 'Click a squad.', touch: 'Tap a squad.' },
  },
  {
    id: 'battle-order',
    scene: 'campaign',
    showOn: ['squad-selected'],
    doneOn: 'order-issued',
    mark: 'squad',
    text: { desktop: 'Right-click the ground to send them.', touch: 'Press and hold the ground to send them.' },
  },
  {
    id: 'debrief',
    scene: 'campaign',
    showOn: ['debrief-open'],
    doneOn: 'debrief-closed',
    anchor: '#next',
    text: both('Your men carry over. The dead do not.'),
  },
];

const STEP_IDS = new Set<string>(STEPS.map((s) => s.id));
const stepOf = (id: StepId): Step => STEPS.find((s) => s.id === id)!;

/** The event that ends a scene's lesson: every step of the scene retires on it. */
const SCENE_END: Record<Scene, TutorialEvent | null> = { drill: 'battle-won', campaign: null };

export function loadState(storage?: Pick<Storage, 'getItem'>): TutorialState {
  const fresh: TutorialState = { skipped: false, done: [], drilled: false };
  if (!storage) return fresh;
  try {
    const raw = storage.getItem(TUTORIAL_STORAGE_KEY);
    if (!raw) return fresh;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fresh;
    const o = v as { skipped?: unknown; done?: unknown; drilled?: unknown };
    return {
      skipped: o.skipped === true,
      done: Array.isArray(o.done) ? (o.done.filter((d) => typeof d === 'string' && STEP_IDS.has(d)) as StepId[]) : [],
      drilled: o.drilled === true,
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
 * The state machine. Retires the steps this event completes, then picks the
 * one step of this scene the event puts on screen. Skipped is terminal.
 *
 * A campaign step retires whenever its event comes: a player who marches
 * before the bubble arrives has learnt marching. A drill step retires only
 * while it is the one on screen (`shown`): the drill is a sequence, and an
 * event that arrives early is the player trying a button, not the player done
 * with a step they have not been given. `hide` says the step on screen is
 * finished, which for a repeating step is not the same as done.
 */
export function advance(
  state: TutorialState,
  event: TutorialEvent,
  scene: Scene = 'campaign',
  shown: StepId | null = null,
): { state: TutorialState; show: StepId | null; hide: boolean } {
  if (state.skipped) return { state, show: null, hide: false };
  const done = new Set<StepId>(state.done);
  let hide = false;
  for (const s of STEPS) {
    if (s.doneOn !== event || (s.scene === 'drill' && s.id !== shown)) continue;
    if (!s.repeats) done.add(s.id);
    if (s.id === shown) hide = true;
  }
  if (SCENE_END[scene] === event) {
    for (const s of STEPS) if (s.scene === scene) done.add(s.id);
    hide = true;
  }
  let show: StepId | null = null;
  for (const s of STEPS) {
    if (s.line || s.scene !== scene || !s.showOn.includes(event) || done.has(s.id)) continue;
    if (s.requires && !done.has(s.requires)) continue;
    show = s.id;
    for (const r of s.reopens ?? []) done.delete(r);
    break;
  }
  return { state: { ...state, done: [...done] }, show, hide };
}

const circleRect = (c: Circle): Rect => ({ left: c.x - c.r, top: c.y - c.r, right: c.x + c.r, bottom: c.y + c.r });

const RING_PERIOD_MS = 1100;
const RING_PULSE_PX = 14;

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
  ctx.arc(c.x, c.y, c.r + RING_PULSE_PX * t, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** What the tutorial needs from the game it teaches over. All optional: a test passes none. */
export interface TutorialHost {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Where a world mark is on screen right now. null = not in this scene. */
  world?(mark: WorldMark): Circle | null;
  /** The part of the screen that is map: a world bubble never sits on the HUD. */
  stage?(): Rect | undefined;
  /**
   * The campaign's goal as one line, and the map it goes over. null = the
   * theater is not on screen, or the war has no goal to state.
   */
  goal?(): { text: string; over: Rect } | null;
  /** The step on screen changed. null = none. The game holds the battle and brings the mark into view. */
  onStep?(step: Step | null): void;
}

export class Tutorial {
  private state: TutorialState;
  private scene: Scene = 'campaign';
  private shown: StepId | null = null;
  /** "Skip tutorial" pressed during this run of the drill. */
  private drillOff = false;
  private line: HTMLDivElement | null = null;
  private linePlaced = '';

  constructor(
    private readonly coach: Pick<Coach, 'show' | 'hide' | 'reflow' | 'rect'>,
    private readonly touch: boolean,
    private readonly host: TutorialHost = {},
  ) {
    this.state = loadState(host.storage);
  }

  get isSkipped(): boolean {
    return this.state.skipped;
  }

  /** The drill has been started on this profile. */
  get drilled(): boolean {
    return this.state.drilled;
  }

  /** A step is on screen. The game keeps its own prompts quiet meanwhile. */
  get isShowing(): boolean {
    return this.shown !== null;
  }

  /** The step on screen, for what the game draws with it (the chip that glows). */
  get step(): Step | null {
    return this.shown ? stepOf(this.shown) : null;
  }

  // The drill teaches whenever it is started, skipped profile or not: asking
  // for training is asking to be taught. Skip pressed inside it silences that
  // run as well as everything after it.
  private get quiet(): boolean {
    return this.scene === 'drill' ? this.drillOff : this.state.skipped;
  }

  private run(event: TutorialEvent): ReturnType<typeof advance> {
    return advance({ ...this.state, skipped: false }, event, this.scene, this.shown);
  }

  /** This event would put a new step on screen. For conditions the game has to poll for. */
  wants(event: TutorialEvent): boolean {
    if (this.quiet) return false;
    const { show } = this.run(event);
    return show !== null && show !== this.shown;
  }

  /** The step on screen is waiting for this event. */
  awaits(event: TutorialEvent): boolean {
    return this.shown !== null && stepOf(this.shown).doneOn === event;
  }

  /** The game reports what happened. Called from many sites, some every input. */
  notify(event: TutorialEvent): void {
    if (this.quiet) return;
    const r = this.run(event);
    const progressed = r.state.done.length !== this.state.done.length || r.state.done.some((d) => !this.state.done.includes(d));
    this.state = { ...r.state, skipped: this.state.skipped };
    const before = this.shown;
    if (this.shown && r.hide) {
      this.coach.hide();
      this.shown = null;
    }
    if (r.show && r.show !== this.shown) this.present(r.show);
    this.syncLine(event);
    if (progressed) saveState(this.state, this.host.storage);
    if (this.shown !== before) this.host.onStep?.(this.step);
  }

  /**
   * Once per frame, in every mode. `suppressed` = a full-screen menu owns the
   * screen, so the bubble and the goal line stand down until it closes.
   */
  frame(suppressed: boolean): void {
    this.coach.reflow(suppressed);
    this.placeLine(suppressed);
  }

  /** The ring the game draws on its canvas for the step on screen, if any. */
  ring(): Circle | null {
    const mark = this.step?.mark;
    return mark ? this.host.world?.(mark) ?? null : null;
  }

  /** The screen the step on show is using: its bubble and its ring. The ticker keeps out. */
  occupied(): Rect[] {
    const out: Rect[] = [];
    if (this.coach.rect) out.push(this.coach.rect);
    const ring = this.ring();
    if (ring) out.push(circleRect({ ...ring, r: ring.r + RING_PULSE_PX }));
    return out;
  }

  /** The drill is starting: its steps replay from the top, whatever was done before. */
  startDrill(): void {
    this.clearScreen();
    this.scene = 'drill';
    this.drillOff = false;
    this.state = { ...this.state, drilled: true, done: this.state.done.filter((d) => stepOf(d).scene !== 'drill') };
    saveState(this.state, this.host.storage);
  }

  /** The drill is over, won, lost or left. */
  endDrill(): void {
    this.clearScreen();
    this.scene = 'campaign';
  }

  /**
   * The menu switch. Turning it ON clears progress as well as the skip, so the
   * campaign steps replay — which is the whole point of the control: a player
   * who has finished the tutorial turns it back on to show somebody else, and
   * "on but already completed" would teach them nothing. Turning it OFF is
   * exactly the Skip button.
   */
  setEnabled(on: boolean): void {
    if (!on) {
      this.skip();
      return;
    }
    this.state = { ...this.state, skipped: false, done: [] };
    saveState(this.state, this.host.storage);
  }

  /** Terminal. Nothing tutorial-ish appears again on this profile, short of asking for the drill. */
  skip(): void {
    this.state = { ...this.state, skipped: true };
    this.drillOff = true;
    this.clearScreen();
    saveState(this.state, this.host.storage);
  }

  private clearScreen(): void {
    const had = this.shown !== null;
    this.shown = null;
    this.coach.hide();
    this.removeLine();
    if (had) this.host.onStep?.(null);
  }

  private present(id: StepId): void {
    this.shown = id;
    if (typeof document === 'undefined') return;
    const step = stepOf(id);
    this.coach.show({
      text: this.touch ? step.text!.touch : step.text!.desktop,
      locate: () => {
        if (step.anchor) {
          // The selector may name the control on either platform: the first one laid out is it.
          for (const target of Array.from(document.querySelectorAll(step.anchor))) {
            const anchor = visibleRect(target);
            if (!anchor) continue;
            // A bubble pointing into the touch bar clears the whole bar: the
            // order row sits right above the chip it names.
            const bar = target.closest('#touchbar');
            return { anchor, clear: (bar && visibleRect(bar)) ?? anchor };
          }
          return null;
        }
        const c = step.mark ? this.host.world?.(step.mark) : null;
        if (!c) return null;
        const r = circleRect(c);
        return { anchor: r, clear: r, bounds: this.host.stage?.() };
      },
      onDismiss: () => this.dismiss(id),
      onSkip: () => this.skip(),
    });
  }

  private dismiss(id: StepId): void {
    if (!this.state.done.includes(id) && !stepOf(id).repeats) this.state = { ...this.state, done: [...this.state.done, id] };
    saveState(this.state, this.host.storage);
    if (this.shown !== id) return;
    this.shown = null;
    this.host.onStep?.(null);
  }

  // ── the goal line ──
  // One line over the theater map, from the first sight of it until the first
  // march is ordered. It is the whole of what the briefing card used to say.

  private syncLine(event: TutorialEvent): void {
    const goal = stepOf('goal');
    if (this.state.done.includes('goal') || this.quiet) this.removeLine();
    else if (goal.showOn.includes(event) && this.scene === goal.scene && !this.line && typeof document !== 'undefined') {
      const el = document.createElement('div');
      el.id = 'goal-line';
      el.className = 'panel';
      document.body.appendChild(el);
      this.line = el;
      this.placeLine(false);
    }
  }

  private placeLine(suppressed: boolean): void {
    const el = this.line;
    if (!el) return;
    const g = suppressed ? null : this.host.goal?.() ?? null;
    if (!g) {
      if (this.linePlaced !== 'hidden') {
        el.style.display = 'none';
        this.linePlaced = 'hidden';
      }
      return;
    }
    const key = `${g.text}|${Math.round(g.over.left)},${Math.round(g.over.top)},${Math.round(g.over.right)}`;
    if (key === this.linePlaced) return;
    this.linePlaced = key;
    el.textContent = g.text;
    el.style.display = '';
    el.style.maxWidth = `${Math.max(0, Math.round(g.over.right - g.over.left) - 16)}px`;
    el.style.left = `${Math.round((g.over.left + g.over.right) / 2)}px`;
    el.style.top = `${Math.round(g.over.top + 8)}px`;
  }

  private removeLine(): void {
    this.line?.remove();
    this.line = null;
    this.linePlaced = '';
  }
}
