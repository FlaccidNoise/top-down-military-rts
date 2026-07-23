import { describe, expect, it } from 'vitest';
import { Coach, COACH_STORAGE_KEY, loadDismissed, saveDismissed } from '../src/ui/coach';

// ---- helpers ----

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

// ---- loadDismissed ----

describe('loadDismissed', () => {
  it('returns empty set when storage has no key', () => {
    const s = makeStorage();
    expect(loadDismissed(s).size).toBe(0);
  });

  it('returns empty set with undefined storage', () => {
    expect(loadDismissed(undefined).size).toBe(0);
  });

  it('returns previously saved set', () => {
    const s = makeStorage();
    saveDismissed(new Set(['a', 'b']), s);
    const d = loadDismissed(s);
    expect(d.has('a')).toBe(true);
    expect(d.has('b')).toBe(true);
    expect(d.size).toBe(2);
  });

  it('returns empty set for corrupt JSON', () => {
    const s = makeStorage();
    s.setItem(COACH_STORAGE_KEY, 'not-json');
    expect(loadDismissed(s).size).toBe(0);
  });

  it('filters non-string array elements', () => {
    const s = makeStorage();
    s.setItem(COACH_STORAGE_KEY, JSON.stringify(['a', 1, null, 'b']));
    const d = loadDismissed(s);
    expect(d.has('a')).toBe(true);
    expect(d.has('b')).toBe(true);
    expect(d.has(1 as unknown as string)).toBe(false);
    expect(d.size).toBe(2);
  });
});

// ---- saveDismissed ----

describe('saveDismissed', () => {
  it('does not throw with undefined storage', () => {
    expect(() => saveDismissed(new Set(['x']), undefined)).not.toThrow();
  });

  it('round-trips through storage', () => {
    const s = makeStorage();
    saveDismissed(new Set(['a', 'b']), s);
    expect(loadDismissed(s)).toEqual(new Set(['a', 'b']));
  });
});

// ---- Coach ----

describe('Coach', () => {
  it('isDismissed is false for new ids', () => {
    const c = new Coach(makeStorage());
    expect(c.isDismissed('x')).toBe(false);
  });

  it('isDismissed true after recording via storage', () => {
    const s = makeStorage();
    saveDismissed(new Set(['x']), s);
    const c = new Coach(s);
    expect(c.isDismissed('x')).toBe(true);
    expect(c.isDismissed('y')).toBe(false);
  });

  it('maybeShow is no-op when already dismissed (no DOM required)', () => {
    const s = makeStorage();
    saveDismissed(new Set(['x']), s);
    const c = new Coach(s);
    // should not throw — early return before touching document
    expect(() => c.maybeShow('x', {} as HTMLElement, 'test')).not.toThrow();
  });

  it('dismissAll clears the set', () => {
    const s = makeStorage();
    saveDismissed(new Set(['a', 'b', 'c']), s);
    const c = new Coach(s);
    expect(c.isDismissed('a')).toBe(true);
    c.dismissAll();
    expect(c.isDismissed('a')).toBe(false);
    expect(c.isDismissed('b')).toBe(false);
    expect(loadDismissed(s).size).toBe(0);
  });
});