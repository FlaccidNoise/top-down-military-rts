import { describe, expect, it } from 'vitest';
import {
  advance,
  loadState,
  saveState,
  STEPS,
  Tutorial,
  TUTORIAL_STORAGE_KEY,
  type Scene,
  type Step,
  type StepId,
  type TutorialEvent,
  type TutorialState,
} from '../src/ui/tutorial';

// tutorial.ts touches the DOM only inside the Tutorial class, so the state
// machine and its storage test in the node env, like coach.ts.

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => void m.clear(),
    get length() { return m.size; },
    key: (i) => { const keys = [...m.keys()]; return keys[i] ?? null; },
  } as Storage;
}

const fresh = (): TutorialState => ({ skipped: false, done: [], drilled: false });
const withDone = (...done: StepId[]): TutorialState => ({ ...fresh(), done });

/**
 * Feed a run of events the way the Tutorial class does: the step on screen is
 * carried from one event to the next. Returns every step shown, in order.
 */
function run(state: TutorialState, events: TutorialEvent[], scene: Scene = 'campaign'): { state: TutorialState; shown: StepId[]; on: StepId | null } {
  const shown: StepId[] = [];
  let s = state;
  let on: StepId | null = null;
  for (const e of events) {
    const r = advance(s, e, scene, on);
    s = r.state;
    if (r.hide) on = null;
    if (r.show && r.show !== on) {
      on = r.show;
      shown.push(r.show);
    }
  }
  return { state: s, shown, on };
}

const CAMPAIGN: TutorialEvent[] = [
  'campaign-start', 'force-selected', 'move-ordered', 'clock-advanced', 'contact-open', 'contact-closed',
  'deploy-start', 'deploy-commit', 'squad-selected', 'order-issued', 'debrief-open', 'debrief-closed',
  'objective-captured', 'posture-set',
];
const DRILL: TutorialEvent[] = [
  'drill-start', 'squad-selected', 'order-issued', 'enemy-seen', 'fire-armed', 'fire-ordered', 'house-quiet', 'squad-switched', 'assault-ordered', 'battle-won',
];
const ofScene = (scene: Scene): Step[] => STEPS.filter((s) => s.scene === scene);
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

// ---- storage ----

describe('loadState', () => {
  it('returns a fresh state with no storage and with an empty key', () => {
    expect(loadState(undefined)).toEqual(fresh());
    expect(loadState(makeStorage())).toEqual(fresh());
  });

  it('round-trips through storage', () => {
    const s = makeStorage();
    const state: TutorialState = { skipped: false, done: ['goal', 'select-force'], drilled: true };
    saveState(state, s);
    expect(loadState(s)).toEqual(state);
  });

  it('round-trips the skipped flag', () => {
    const s = makeStorage();
    saveState({ ...fresh(), skipped: true }, s);
    expect(loadState(s).skipped).toBe(true);
  });

  it('returns a fresh state for corrupt JSON', () => {
    const s = makeStorage();
    s.setItem(TUTORIAL_STORAGE_KEY, 'not-json{');
    expect(loadState(s)).toEqual(fresh());
  });

  it('returns a fresh state for the wrong shape', () => {
    const s = makeStorage();
    for (const raw of ['[]', '"goal"', 'null', '7']) {
      s.setItem(TUTORIAL_STORAGE_KEY, raw);
      expect(loadState(s)).toEqual(fresh());
    }
  });

  it('drops unknown and non-string step ids, a retired id among them', () => {
    const s = makeStorage();
    s.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify({ skipped: false, done: ['march', 'briefing', 'not-a-step', 3, null] }));
    expect(loadState(s).done).toEqual(['march']);
  });

  it('treats a non-boolean skipped or drilled as false', () => {
    const s = makeStorage();
    s.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify({ skipped: 'yes', drilled: 1, done: [] }));
    expect(loadState(s)).toEqual(fresh());
  });
});

describe('saveState', () => {
  it('does not throw with undefined storage', () => {
    expect(() => saveState(fresh(), undefined)).not.toThrow();
  });
});

// ---- advance: the campaign ----

describe('advance, the campaign', () => {
  it('walks the whole chain in teaching order', () => {
    const { state, shown } = run(fresh(), CAMPAIGN);
    expect(shown).toEqual(['select-force', 'march', 'play', 'contact', 'deploy', 'battle-select', 'battle-order', 'debrief', 'dig-in']);
    expect(new Set(state.done)).toEqual(new Set(ofScene('campaign').map((s) => s.id)));
  });

  it('never shows a step twice', () => {
    const first = run(fresh(), CAMPAIGN);
    expect(run(first.state, CAMPAIGN).shown).toEqual([]);
  });

  it('the goal line never takes a bubble’s turn, and goes when the first march is ordered', () => {
    const start = advance(fresh(), 'campaign-start');
    expect(start.show).toBe('select-force');
    expect(start.state.done).not.toContain('goal');
    expect(run(fresh(), ['campaign-start', 'force-selected', 'move-ordered']).state.done).toContain('goal');
  });

  it('opens the next step on the same event that retires the current one', () => {
    // The doing IS the learning: selecting a force both retires select-force
    // and opens march, so the bubble is replaced rather than queued.
    const r = advance(fresh(), 'force-selected');
    expect(r.state.done).toContain('select-force');
    expect(r.show).toBe('march');
  });

  it('marks only the step an out-of-order event names', () => {
    // The war moves fast: contact lands before the player has ever marched.
    const { state, shown } = run(fresh(), ['campaign-start', 'contact-open']);
    expect(shown).toEqual(['select-force', 'contact']);
    expect(state.done).not.toContain('march');
    expect(state.done).not.toContain('select-force');
  });

  it('retires a step whose completing event arrives without the bubble', () => {
    const r = advance(withDone('select-force'), 'move-ordered');
    expect(r.state.done).toContain('march');
    expect(r.show).toBe('play');
  });

  it('the Play step ends on the clock moving, not on a press', () => {
    expect(STEPS.find((s) => s.id === 'play')!.doneOn).toBe('clock-advanced');
  });

  it('teaches the battle by doing: pick a squad, then give it an order', () => {
    const r = advance(withDone('deploy'), 'deploy-commit');
    expect(r.show).toBe('battle-select');
    const picked = advance(r.state, 'squad-selected', 'campaign', 'battle-select');
    expect(picked.state.done).toContain('battle-select');
    expect(picked.show).toBe('battle-order');
    const ordered = advance(picked.state, 'order-issued', 'campaign', 'battle-order');
    expect(ordered.state.done).toContain('battle-order');
    expect(ordered.show).toBeNull();
    expect(ordered.hide).toBe(true);
  });

  it('a later squad pick does not bring the order step back once it is done', () => {
    expect(advance(withDone('battle-select', 'battle-order'), 'squad-selected').show).toBeNull();
  });

  it('teaches Dig in once, when there is an objective to hold, and not before', () => {
    expect(advance(fresh(), 'posture-set').show).toBeNull();
    const taken = advance(fresh(), 'objective-captured');
    expect(taken.show).toBe('dig-in');
    const dug = advance(taken.state, 'posture-set', 'campaign', 'dig-in');
    expect(dug.hide).toBe(true);
    expect(advance(dug.state, 'objective-captured').show).toBeNull();
    const step = STEPS.find((s) => s.id === 'dig-in')!;
    // The button is on a card that is not always up: the step can point at the company instead.
    expect(step.anchor && step.mark).toBeTruthy();
  });

  it('re-arms the next un-done step on campaign start, across a reload', () => {
    expect(advance(fresh(), 'campaign-start').show).toBe('select-force');
    expect(advance(withDone('select-force', 'march'), 'campaign-start').show).toBeNull();
    expect(advance(withDone('select-force'), 'force-selected').show).toBe('march');
  });
});

// ---- advance: the drill ----

describe('advance, the drill', () => {
  it('walks its steps in order and ends with every one retired', () => {
    const { state, shown, on } = run(fresh(), DRILL, 'drill');
    expect(shown).toEqual(['drill-select', 'drill-move', 'drill-contact', 'drill-fire', 'drill-quiet', 'drill-assault']);
    expect(on).toBeNull();
    for (const s of ofScene('drill')) expect(state.done, s.id).toContain(s.id);
  });

  it('shows no campaign step, and the campaign shows no drill step', () => {
    for (const e of [...CAMPAIGN, ...DRILL]) {
      const inDrill = advance(fresh(), e, 'drill').show;
      const inWar = advance(fresh(), e, 'campaign').show;
      if (inDrill) expect(STEPS.find((s) => s.id === inDrill)!.scene, e).toBe('drill');
      if (inWar) expect(STEPS.find((s) => s.id === inWar)!.scene, e).toBe('campaign');
    }
  });

  it('retires a step only while it is the one on screen', () => {
    // Fire armed before any enemy is seen is a player trying a button.
    const early = advance(fresh(), 'fire-armed', 'drill', 'drill-move');
    expect(early.state.done).not.toContain('drill-contact');
    expect(early.show).toBeNull();
    expect(early.hide).toBe(false);
    const seen = advance(early.state, 'enemy-seen', 'drill', null);
    expect(seen.show).toBe('drill-contact');
  });

  it('what the drill teaches is not taught again in the first battle', () => {
    const { state } = run(fresh(), DRILL, 'drill');
    expect(state.done).toContain('battle-select');
    expect(state.done).toContain('battle-order');
    expect(run(state, ['deploy-commit', 'squad-selected']).shown).toEqual([]);
  });

  it('a refusal brings the recovery step, every time, and the assault step after it', () => {
    const upTo = run(fresh(), DRILL.slice(0, 9), 'drill'); // through assault-ordered
    expect(upTo.state.done).toContain('drill-assault');
    const balk = advance(upTo.state, 'team-balked', 'drill', null);
    expect(balk.show).toBe('drill-balk');
    expect(balk.state.done).not.toContain('drill-assault');
    const fired = advance(balk.state, 'fire-ordered', 'drill', 'drill-balk');
    expect(fired.hide).toBe(true);
    expect(fired.state.done).not.toContain('drill-balk');
    const quiet = advance(fired.state, 'house-quiet', 'drill', null);
    expect(quiet.show).toBe('drill-assault');
    const again = advance(advance(quiet.state, 'assault-ordered', 'drill', 'drill-assault').state, 'team-balked', 'drill', null);
    expect(again.show).toBe('drill-balk');
  });

  it('ends on the battle being won, whatever step was waiting', () => {
    const mid = run(fresh(), DRILL.slice(0, 4), 'drill');
    expect(mid.on).toBe('drill-contact');
    const won = advance(mid.state, 'battle-won', 'drill', mid.on);
    expect(won.hide).toBe(true);
    expect(won.show).toBeNull();
    expect(advance(won.state, 'team-balked', 'drill', null).show).toBeNull();
  });
});

// ---- advance: skip is terminal ----

describe('advance when skipped', () => {
  it('shows nothing and records nothing, for every event in both scenes', () => {
    const skipped: TutorialState = { ...fresh(), skipped: true };
    for (const s of STEPS) {
      for (const e of s.showOn) {
        const r = advance(skipped, e, s.scene);
        expect(r.show).toBeNull();
        expect(r.state).toBe(skipped);
      }
    }
  });
});

// ---- the step table itself ----

describe('STEPS', () => {
  it('gives every bubble something to point at and both copy variants', () => {
    for (const s of STEPS) {
      if (s.line) continue;
      expect(Boolean(s.anchor) || Boolean(s.mark), s.id).toBe(true);
      expect(s.text!.desktop.length, s.id).toBeGreaterThan(0);
      expect(s.text!.touch.length, s.id).toBeGreaterThan(0);
    }
  });

  it('says every step in one line of at most eight words', () => {
    for (const s of STEPS) {
      if (!s.text) continue;
      expect(words(s.text.desktop), `${s.id}: ${s.text.desktop}`).toBeLessThanOrEqual(8);
      expect(words(s.text.touch), `${s.id}: ${s.text.touch}`).toBeLessThanOrEqual(8);
    }
  });

  it('tells a phone to tap and hold, never to click', () => {
    for (const s of STEPS) if (s.text) expect(s.text.touch, s.id).not.toMatch(/click/i);
  });

  it('holds the battle on every drill step and on no campaign step', () => {
    for (const s of STEPS) expect(Boolean(s.holds), s.id).toBe(s.scene === 'drill');
  });

  it('every step is retired by a real event, never by merely showing', () => {
    for (const s of STEPS) expect(typeof s.doneOn, s.id).toBe('string');
  });

  it('names only prerequisites that exist earlier in the same scene', () => {
    const seen = new Map<StepId, Scene>();
    for (const s of STEPS) {
      if (s.requires) expect(seen.get(s.requires), s.id).toBe(s.scene);
      seen.set(s.id, s.scene);
    }
  });

  it('states the top speed from its constant', () => {
    expect(STEPS.find((s) => s.id === 'play')!.text!.desktop).toContain('60×');
  });
});

// ---- the Tutorial class: state, storage and the host callbacks ----

function makeTutorial(storage: Storage = makeStorage()) {
  const steps: (StepId | null)[] = [];
  const t = new Tutorial({ hide() {}, show() {}, reflow() {}, rect: null }, false, { storage, onStep: (s) => steps.push(s ? s.id : null) });
  return { t, steps, storage };
}

describe('Tutorial.setEnabled (the menu toggle)', () => {
  it('turning it OFF is exactly Skip, and survives a reload', () => {
    const { t, storage } = makeTutorial();
    t.setEnabled(false);
    expect(t.isSkipped).toBe(true);
    expect(loadState(storage).skipped).toBe(true);
  });

  it('turning it ON clears the skip AND the progress, so the campaign steps replay', () => {
    const storage = makeStorage();
    saveState({ skipped: true, done: ['goal', 'select-force', 'march'], drilled: true }, storage);
    const { t } = makeTutorial(storage);
    expect(t.isSkipped).toBe(true);
    t.setEnabled(true);
    expect(t.isSkipped).toBe(false);
    const reloaded = loadState(storage);
    // The drill has still been played: the menu does not go back to its first-run shape.
    expect(reloaded).toEqual({ skipped: false, done: [], drilled: true });
    expect(advance(reloaded, 'campaign-start').show).toBe('select-force');
  });

  it('is idempotent both ways', () => {
    const { t, storage } = makeTutorial();
    t.setEnabled(true);
    t.setEnabled(true);
    expect(loadState(storage)).toEqual(fresh());
    t.setEnabled(false);
    t.setEnabled(false);
    expect(loadState(storage).skipped).toBe(true);
  });
});

describe('Tutorial, the drill', () => {
  it('holds the battle from the first step and tells the game each time the step changes', () => {
    const { t, steps } = makeTutorial();
    t.startDrill();
    t.notify('drill-start');
    expect(t.step?.id).toBe('drill-select');
    expect(t.step?.holds).toBe(true);
    t.notify('squad-selected');
    t.notify('order-issued');
    expect(steps).toEqual(['drill-select', 'drill-move', null]);
    expect(t.isShowing).toBe(false);
  });

  it('answers what it is waiting for and what would move it on', () => {
    const { t } = makeTutorial();
    t.startDrill();
    expect(t.wants('drill-start')).toBe(true);
    t.notify('drill-start');
    expect(t.wants('drill-start')).toBe(false); // already on screen
    expect(t.awaits('squad-selected')).toBe(true);
    expect(t.awaits('order-issued')).toBe(false);
    expect(t.wants('enemy-seen')).toBe(true);
  });

  it('marks the profile as drilled the moment it starts, and saves it', () => {
    const { t, storage } = makeTutorial();
    expect(t.drilled).toBe(false);
    t.startDrill();
    expect(t.drilled).toBe(true);
    expect(loadState(storage).drilled).toBe(true);
  });

  it('replays from the top every time it is started', () => {
    const { t } = makeTutorial();
    t.startDrill();
    for (const e of DRILL) t.notify(e);
    expect(t.wants('drill-start')).toBe(false);
    t.endDrill();
    t.startDrill();
    expect(t.wants('drill-start')).toBe(true);
  });

  it('Skip inside the drill silences that run and everything after it', () => {
    const { t, steps, storage } = makeTutorial();
    t.startDrill();
    t.notify('drill-start');
    t.skip();
    expect(t.isShowing).toBe(false);
    expect(steps[steps.length - 1]).toBeNull();
    t.notify('squad-selected');
    expect(t.isShowing).toBe(false);
    expect(t.wants('enemy-seen')).toBe(false);
    t.endDrill();
    t.notify('campaign-start');
    expect(t.isShowing).toBe(false);
    expect(loadState(storage).skipped).toBe(true);
  });

  it('teaches when asked for, on a profile that skipped, and leaves the skip in place', () => {
    const storage = makeStorage();
    saveState({ ...fresh(), skipped: true }, storage);
    const { t } = makeTutorial(storage);
    t.startDrill();
    t.notify('drill-start');
    expect(t.step?.id).toBe('drill-select');
    t.endDrill();
    expect(t.isSkipped).toBe(true);
    t.notify('campaign-start');
    expect(t.isShowing).toBe(false);
  });

  it('leaving the drill clears the screen and goes back to the campaign', () => {
    const { t, steps } = makeTutorial();
    t.startDrill();
    t.notify('drill-start');
    t.endDrill();
    expect(t.isShowing).toBe(false);
    expect(steps).toEqual(['drill-select', null]);
    t.notify('campaign-start');
    expect(t.step?.id).toBe('select-force');
  });
});
