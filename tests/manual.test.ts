import { describe, expect, it } from 'vitest';
import { MANUAL } from '../src/ui/manual-data';
import { filterManual } from '../src/ui/manual';

// manual.ts touches the DOM only inside ManualScreen's constructor, so the
// search filter is testable in the node env like the copy it searches.

const entryText = (e: { heading: string; body: string; keys?: { desktop: string; touch: string } }): string =>
  `${e.heading} ${e.body} ${e.keys ? `${e.keys.desktop} ${e.keys.touch}` : ''}`.toLowerCase();

const allEntries = (chapters: typeof MANUAL) => chapters.flatMap((c) => c.entries);

describe('filterManual', () => {
  it('returns the whole manual for an empty or blank term', () => {
    expect(filterManual('')).toBe(MANUAL);
    expect(filterManual('   ')).toBe(MANUAL);
  });

  it('returns only entries containing the term, case-insensitively', () => {
    for (const term of ['contact', 'CONTACT', 'Smoke', 'bridge']) {
      const hits = filterManual(term);
      expect(hits.length, term).toBeGreaterThan(0);
      for (const c of hits) {
        if (c.title.toLowerCase().includes(term.toLowerCase())) continue; // whole chapter, by title
        for (const e of c.entries) expect(entryText(e), `${term} / ${e.heading}`).toContain(term.toLowerCase());
      }
    }
  });

  // Three of the six titles appear in no entry ("Starting an Operation", "The
  // Theater Map", "Deployment"). Without this rule the player types a label
  // the rail is showing them and the manual answers that nothing matches.
  it('returns the whole chapter when the term matches its title', () => {
    for (const c of MANUAL) {
      const hits = filterManual(c.title);
      const chapter = hits.find((h) => h.id === c.id);
      expect(chapter, `title search found no chapter for '${c.title}'`).toBeTruthy();
      expect(chapter!.entries.length, c.title).toBe(c.entries.length);
    }
  });

  it('drops every chapter left with no entry, and keeps the chapter titles', () => {
    const hits = filterManual('smoke');
    expect(hits.length).toBeLessThan(MANUAL.length);
    for (const c of hits) {
      expect(c.entries.length, c.id).toBeGreaterThan(0);
      expect(c.title).toBe(MANUAL.find((m) => m.id === c.id)!.title);
    }
  });

  it('searches the key bindings, not only the prose', () => {
    const hits = allEntries(filterManual('mouse wheel'));
    expect(hits.length, 'no entry binds the mouse wheel — the fixture the test reads is gone').toBeGreaterThan(0);
    for (const e of hits) {
      expect(`${e.heading} ${e.body}`.toLowerCase(), e.heading).not.toContain('mouse wheel');
      expect(e.keys).toBeTruthy();
    }
  });

  it('returns nothing for a term the manual does not carry', () => {
    expect(filterManual('zzzz')).toEqual([]);
  });

  it('leaves MANUAL itself untouched', () => {
    const before = MANUAL.map((c) => c.entries.length);
    filterManual('smoke');
    expect(MANUAL.map((c) => c.entries.length)).toEqual(before);
  });
});
