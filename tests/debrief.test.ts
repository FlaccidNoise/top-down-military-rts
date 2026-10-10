import { describe, expect, it } from 'vitest';
import { debriefHtml, FALLEN_SHOWN, fallenLine, type DebriefSummary } from '../src/ui/debrief';

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `Man${i + 1}`);
const summary = (o: Partial<DebriefSummary> = {}): DebriefSummary => ({ won: true, outcome: 'The ground is ours.', kia: [], wounded: 0, enemyLosses: 0, ...o });
const ACTIONS = [{ id: 'next', label: 'Return to the front', primary: true }, { id: 'db-show-roster', label: 'Show roster' }];
const words = (html: string): number => html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

describe('fallenLine', () => {
  it('says so when nobody died', () => {
    expect(fallenLine([])).toBe('No one died today.');
  });

  it('names every man while the list is short', () => {
    expect(fallenLine(['Sullivan', 'Webb'])).toBe('Sullivan, Webb');
    expect(fallenLine(names(FALLEN_SHOWN))).not.toContain('more');
  });

  it('names the first few and counts the rest', () => {
    expect(fallenLine(names(FALLEN_SHOWN + 1))).toBe(`${names(FALLEN_SHOWN).join(', ')} and 1 more`);
    expect(fallenLine(names(52))).toBe(`${names(FALLEN_SHOWN).join(', ')} and ${52 - FALLEN_SHOWN} more`);
  });
});

describe('debriefHtml', () => {
  it('leads with the result and three numbers', () => {
    const html = debriefHtml(summary({ kia: names(52), wounded: 17, enemyLosses: 72 }), ACTIONS);
    expect(html).toContain('VICTORY');
    const stats = [...html.matchAll(/<div class="db-stat[^"]*"><b>([^<]*)<\/b><span>([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(stats).toEqual(['52 killed', '17 wounded', '~72 enemy losses']);
  });

  it('stays short however bad the day was: no roster, no wall of names', () => {
    const heavy = debriefHtml(summary({ won: false, outcome: 'The attack failed; the line is unchanged.', kia: names(52), wounded: 17, enemyLosses: 72 }), ACTIONS);
    expect(heavy).toContain('DEFEAT');
    expect(words(heavy)).toBeLessThan(40);
    expect(heavy).not.toContain('<table');
    expect(heavy).toContain('id="db-roster"></div>');
  });

  it('has a sane card for a battle nobody was hurt in', () => {
    const quiet = debriefHtml(summary(), ACTIONS);
    const stats = [...quiet.matchAll(/<div class="db-stat[^"]*"><b>([^<]*)<\/b>/g)].map((m) => m[1]);
    expect(stats).toEqual(['0', '0', '0']);
    expect(quiet).toContain('No one died today.');
    expect(quiet).not.toContain('db-stat bad');
  });

  it('carries the buttons it is given, the first as the primary', () => {
    const html = debriefHtml(summary(), ACTIONS);
    expect(html).toContain('<button id="next" class="primary">Return to the front</button>');
    expect(html).toContain('<button id="db-show-roster">Show roster</button>');
  });

  it('escapes names from a save file', () => {
    expect(debriefHtml(summary({ kia: ['<img src=x>'] }), ACTIONS)).not.toContain('<img');
  });
});
