import { describe, expect, it } from 'vitest';
import { formatContextChip, type ChipInput } from '../src/ui/overlays';

// The chip reports the resolver's own numbers (M4): how many men land in
// cover, how many have no footing at all. `danger`/`verdict` are null on an
// unarmed hover, where no LOS raycast was spent.
const chip = (o: Partial<ChipInput> = {}) =>
  formatContextChip({ danger: null, covered: 0, placed: 0, refused: 0, eta: null, verdict: null, ...o });

describe('formatContextChip', () => {
  it('danger below 0.2 → LOW', () => {
    expect(chip({ danger: 0.1 }).lines[0]).toBe('RISK LOW 0.10');
  });

  it('danger 0.2..<0.5 → MED', () => {
    expect(chip({ danger: 0.2 }).lines[0]).toBe('RISK MED 0.20');
    expect(chip({ danger: 0.49 }).lines[0]).toBe('RISK MED 0.49');
  });

  it('danger >= 0.5 → HIGH', () => {
    expect(chip({ danger: 0.5 }).lines[0]).toBe('RISK HIGH 0.50');
    expect(chip({ danger: 1.8 }).lines[0]).toBe('RISK HIGH 1.80');
  });

  it('unarmed hover: no danger, no verdict, just the cover count', () => {
    expect(chip({ covered: 4, placed: 6 })).toEqual({ lines: ['4/6 COVERED'], color: '#b8b4a4' });
    expect(chip({ covered: 6, placed: 6 }).color).toBe('#7fbf6a'); // every man covered reads green
  });

  it('cover line counts resolved spots, not the tile under the cursor', () => {
    expect(chip({ covered: 0, placed: 8 }).lines[0]).toBe('0/8 COVERED');
    expect(chip({ covered: 3, placed: 8 }).lines[0]).toBe('3/8 COVERED');
  });

  it('eta number → rounded seconds appended, min 1s', () => {
    expect(chip({ covered: 1, placed: 2, eta: 14.4 }).lines[0]).toBe('1/2 COVERED · ~14s');
    expect(chip({ covered: 1, placed: 2, eta: 0.2 }).lines[0]).toBe('1/2 COVERED · ~1s');
  });

  it('verdict → label + color', () => {
    expect(chip({ danger: 0, covered: 0, placed: 2, verdict: 'comply' })).toEqual({
      lines: ['RISK LOW 0.00', '0/2 COVERED', 'COMPLY'],
      color: '#7fbf6a',
    });
    expect(chip({ danger: 0.3, covered: 2, placed: 2, eta: 5, verdict: 'cautious' })).toEqual({
      lines: ['RISK MED 0.30', '2/2 COVERED · ~5s', 'CAUTIOUS'],
      color: '#e0c060',
    });
    expect(chip({ danger: 0.9, covered: 0, placed: 2, verdict: 'balk' })).toEqual({
      lines: ['RISK HIGH 0.90', '0/2 COVERED', 'BALK'],
      color: '#d05c50',
    });
  });

  it('refusal is surfaced as its own line and outranks the verdict color', () => {
    expect(chip({ covered: 2, placed: 4, refused: 2 })).toEqual({
      lines: ['2/4 COVERED', '2 NO FOOTING'],
      color: '#d05c50',
    });
    expect(chip({ danger: 0.1, covered: 4, placed: 4, refused: 1, verdict: 'comply' })).toEqual({
      lines: ['RISK LOW 0.10', '4/4 COVERED', 'COMPLY', '1 NO FOOTING'],
      color: '#d05c50',
    });
  });

  it('nobody placed at all → the bare NO FOOTING refusal, no cover line', () => {
    expect(chip({ placed: 0, refused: 6 })).toEqual({ lines: ['NO FOOTING'], color: '#d05c50' });
  });
});
