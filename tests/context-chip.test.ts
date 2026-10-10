import { describe, expect, it } from 'vitest';
import { formatContextChip, type ChipInput } from '../src/ui/overlays';

// The chip reports the resolver's own numbers (M4) in one plain line: how many
// men land in cover and how long the move takes. Its colour is the verdict.
// `verdict` is null on an unarmed hover, where no LOS raycast was spent.
const chip = (o: Partial<ChipInput> = {}) =>
  formatContextChip({ covered: 0, placed: 0, refused: 0, eta: null, verdict: null, ...o });

const GREEN = '#7fbf6a';
const AMBER = '#e0c060';
const RED = '#d05c50';

describe('formatContextChip', () => {
  it('reads as one plain line: men in cover, and the seconds it takes', () => {
    expect(chip({ covered: 12, placed: 12, eta: 7.2, verdict: 'comply' })).toEqual({
      lines: ['12 of 12 in cover · 7 s'],
      color: GREEN,
      floorLine: false,
    });
  });

  it('prints no decimal, no ratio slash and no risk score', () => {
    for (const v of [null, 'comply', 'cautious', 'balk'] as const) {
      const text = chip({ covered: 3, placed: 8, eta: 14.4, verdict: v }).lines.join(' ');
      expect(text, String(v)).not.toMatch(/\d\.\d|\d\/\d|RISK|COMPLY|CAUTIOUS|BALK/);
    }
  });

  it('cover line counts resolved spots, not the tile under the cursor', () => {
    expect(chip({ covered: 0, placed: 8 }).lines[0]).toBe('0 of 8 in cover');
    expect(chip({ covered: 3, placed: 8 }).lines[0]).toBe('3 of 8 in cover');
  });

  it('eta is whole seconds, never under one', () => {
    expect(chip({ covered: 1, placed: 2, eta: 14.4 }).lines[0]).toBe('1 of 2 in cover · 14 s');
    expect(chip({ covered: 1, placed: 2, eta: 0.2 }).lines[0]).toBe('1 of 2 in cover · 1 s');
  });

  it('green: they go, and at least half of them end in cover', () => {
    expect(chip({ covered: 6, placed: 12, verdict: 'comply' }).color).toBe(GREEN);
    expect(chip({ covered: 6, placed: 6 }).color).toBe(GREEN);
  });

  it('amber: they go carefully, or most of them end in the open', () => {
    expect(chip({ covered: 12, placed: 12, verdict: 'cautious' }).color).toBe(AMBER);
    expect(chip({ covered: 5, placed: 12, verdict: 'comply' }).color).toBe(AMBER);
    expect(chip({ covered: 0, placed: 6 }).color).toBe(AMBER);
  });

  it("red: a team that will refuse reads Won't go, in place of the cover count", () => {
    expect(chip({ covered: 0, placed: 2, eta: 9, verdict: 'balk' })).toEqual({ lines: ["Won't go"], color: RED, floorLine: false });
  });

  it('men with no footing are their own line, and red outranks the verdict', () => {
    expect(chip({ covered: 2, placed: 4, refused: 2 })).toEqual({
      lines: ['2 of 4 in cover', '2 with no footing'],
      color: RED,
      floorLine: false,
    });
    expect(chip({ covered: 4, placed: 4, refused: 1, verdict: 'comply' }).color).toBe(RED);
  });

  it('nobody placed at all: the bare refusal, no cover line', () => {
    expect(chip({ placed: 0, refused: 6 })).toEqual({ lines: ['No footing'], color: RED, floorLine: false });
  });

  it('a floor pick leads, as a place and not a verdict', () => {
    const up = chip({ covered: 6, placed: 6, eta: 12, verdict: 'comply', level: 1 });
    expect(up.lines).toEqual(['Floor 2', '6 of 6 in cover · 12 s']);
    expect(up.floorLine).toBe(true);
    expect(chip({ covered: 6, placed: 6, level: 0 }).lines[0]).toBe('Ground floor');
  });

  it('has nothing to say when nobody would move and nobody is refused', () => {
    expect(chip().lines).toEqual([]);
  });
});
