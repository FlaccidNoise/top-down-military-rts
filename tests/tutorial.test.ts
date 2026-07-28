import { describe, expect, it } from 'vitest';
import {
  advance,
  loadState,
  saveState,
  STEPS,
  TUTORIAL_STORAGE_KEY,
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

const fresh = (): TutorialState => ({ skipped: false, done: [] });

/** Feed a run of events and return the final state plus the shown steps in order. */
function run(state: TutorialState, events: TutorialEvent[]): { state: TutorialState; shown: StepId[] } {
  const shown: StepId[] = [];
  let s = state;
  for (const e of events) {
    const r = advance(s, e);
    s = r.state;
    if (r.show) shown.push(r.show);
  }
  return { state: s, shown };
}

// ---- storage ----

describe('loadState', () => {
  it('returns a fresh state with no storage and with an empty key', () => {
    expect(loadState(undefined)).toEqual(fresh());
    expect(loadState(makeStorage())).toEqual(fresh());
  });

  it('round-trips through storage', () => {
    const s = makeStorage();
    saveState({ skipped: false, done: ['briefing', 'select-force'] }, s);
    expect(loadState(s)).toEqual({ skipped: false, done: ['briefing', 'select-force'] });
  });

  it('round-trips the skipped flag', () => {
    const s = makeStorage();
    saveState({ skipped: true, done: [] }, s);
    expect(loadState(s).skipped).toBe(true);
  });

  it('returns a fresh state for corrupt JSON', () => {
    const s = makeStorage();
    s.setItem(TUTORIAL_STORAGE_KEY, 'not-json{');
    expect(loadState(s)).toEqual(fresh());
  });

  it('returns a fresh state for the wrong shape', () => {
    const s = makeStorage();
    for (const raw of ['[]', '"briefing"', 'null', '7']) {
      s.setItem(TUTORIAL_STORAGE_KEY, raw);
      expect(loadState(s)).toEqual(fresh());
    }
  });

  it('drops unknown and non-string step ids', () => {
    const s = makeStorage();
    s.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify({ skipped: false, done: ['march', 'not-a-step', 3, null] }));
    expect(loadState(s).done).toEqual(['march']);
  });

  it('treats a non-boolean skipped as not skipped', () => {
    const s = makeStorage();
    s.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify({ skipped: 'yes', done: [] }));
    expect(loadState(s).skipped).toBe(false);
  });
});

describe('saveState', () => {
  it('does not throw with undefined storage', () => {
    expect(() => saveState(fresh(), undefined)).not.toThrow();
  });
});

// ---- advance: the taught sequence ----

describe('advance', () => {
  it('shows the briefing on campaign start, and only the briefing', () => {
    const r = advance(fresh(), 'campaign-start');
    expect(r.show).toBe('briefing');
    expect(r.state.done).toEqual([]);
  });

  it('walks the whole chain in teaching order', () => {
    const { state, shown } = run(fresh(), [
      'campaign-start',
      'briefing-begun',
      'force-selected',
      'move-ordered',
      'speed-changed',
      'contact-open',
      'contact-closed',
      'deploy-start',
      'deploy-commit',
      'debrief-open',
      'debrief-closed',
    ]);
    expect(shown).toEqual([
      'briefing',
      'select-force',
      'march',
      'speed',
      'contact',
      'deploy',
      'battle-orders',
      'debrief',
    ]);
    expect(new Set(state.done)).toEqual(new Set(STEPS.map((s) => s.id)));
  });

  it('never shows a step twice', () => {
    const events: TutorialEvent[] = [
      'campaign-start', 'briefing-begun', 'force-selected', 'move-ordered', 'speed-changed',
      'contact-open', 'contact-closed', 'deploy-start', 'deploy-commit', 'debrief-open', 'debrief-closed',
    ];
    const first = run(fresh(), events);
    const second = run(first.state, events);
    expect(second.shown).toEqual([]);
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
    const { state, shown } = run(fresh(), ['campaign-start', 'briefing-begun', 'contact-open']);
    expect(shown).toEqual(['briefing', 'select-force', 'contact']);
    expect(state.done).toContain('briefing');
    expect(state.done).not.toContain('march');
    expect(state.done).not.toContain('select-force');
  });

  it('retires a step whose completing event arrives without the bubble', () => {
    const r = advance({ skipped: false, done: ['briefing', 'select-force'] }, 'move-ordered');
    expect(r.state.done).toContain('march');
    expect(r.show).toBe('speed');
  });

  it('battle-orders retires the moment it shows', () => {
    const r = advance({ skipped: false, done: ['deploy'] }, 'deploy-commit');
    expect(r.show).toBe('battle-orders');
    expect(r.state.done).toContain('battle-orders');
  });
});

// ---- advance: resumability ----

describe('advance across a reload', () => {
  it('re-arms select-force on campaign start when the briefing is already done', () => {
    const r = advance({ skipped: false, done: ['briefing'] }, 'campaign-start');
    expect(r.show).toBe('select-force');
  });

  it('never re-fires the briefing once it is done', () => {
    const r = advance({ skipped: false, done: ['briefing', 'select-force', 'march'] }, 'campaign-start');
    expect(r.show).toBeNull();
  });

  it('fires the next un-done step when its trigger next occurs', () => {
    const mid: TutorialState = { skipped: false, done: ['briefing', 'select-force'] };
    expect(advance(mid, 'campaign-start').show).toBeNull();
    expect(advance(mid, 'force-selected').show).toBe('march');
  });
});

// ---- advance: skip is terminal ----

describe('advance when skipped', () => {
  it('shows nothing and records nothing, for every event', () => {
    const skipped: TutorialState = { skipped: true, done: [] };
    for (const s of STEPS) {
      for (const e of s.showOn) {
        const r = advance(skipped, e);
        expect(r.show).toBeNull();
        expect(r.state).toBe(skipped);
      }
    }
  });

  it('stays skipped through a full run', () => {
    const { state, shown } = run({ skipped: true, done: [] }, [
      'campaign-start', 'briefing-begun', 'force-selected', 'move-ordered', 'contact-open', 'deploy-start', 'deploy-commit',
    ]);
    expect(shown).toEqual([]);
    expect(state).toEqual({ skipped: true, done: [] });
  });
});

// ---- the step table itself ----

describe('STEPS', () => {
  it('gives every bubble step an anchor and both copy variants', () => {
    for (const s of STEPS) {
      if (s.id === 'briefing') continue; // rendered as a card, not a bubble
      expect(s.anchor, s.id).toBeDefined();
      expect(s.text!.desktop.length, s.id).toBeGreaterThan(0);
      expect(s.text!.touch.length, s.id).toBeGreaterThan(0);
    }
  });

  it('names only prerequisites that exist earlier in the sequence', () => {
    const seen = new Set<StepId>();
    for (const s of STEPS) {
      if (s.requires) expect(seen.has(s.requires), s.id).toBe(true);
      seen.add(s.id);
    }
  });

  it('states the top speed and the order-key range from their constants', () => {
    const speed = STEPS.find((s) => s.id === 'speed')!;
    expect(speed.text!.desktop).toContain('60×');
    const orders = STEPS.find((s) => s.id === 'battle-orders')!;
    expect(orders.text!.desktop).toContain('⇧1–⇧8');
  });
});
