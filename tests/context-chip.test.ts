import { describe, expect, it } from 'vitest';
import { formatContextChip } from '../src/ui/overlays';

describe('formatContextChip', () => {
  it('danger below 0.2 → LOW', () => {
    expect(formatContextChip(0.1, false, null, 'comply').lines[0]).toBe('RISK LOW 0.10');
  });

  it('danger 0.2..<0.5 → MED', () => {
    expect(formatContextChip(0.2, false, null, 'comply').lines[0]).toBe('RISK MED 0.20');
    expect(formatContextChip(0.49, false, null, 'comply').lines[0]).toBe('RISK MED 0.49');
  });

  it('danger >= 0.5 → HIGH', () => {
    expect(formatContextChip(0.5, false, null, 'balk').lines[0]).toBe('RISK HIGH 0.50');
    expect(formatContextChip(1.8, false, null, 'balk').lines[0]).toBe('RISK HIGH 1.80');
  });

  it('cover true → COVER, false → OPEN', () => {
    expect(formatContextChip(0, true, null, 'comply').lines[1]).toBe('COVER');
    expect(formatContextChip(0, false, null, 'comply').lines[1]).toBe('OPEN');
  });

  it('eta null → no ETA on the env line', () => {
    expect(formatContextChip(0, true, null, 'comply').lines[1]).toBe('COVER');
  });

  it('eta number → rounded seconds appended, min 1s', () => {
    expect(formatContextChip(0, false, 14.4, 'comply').lines[1]).toBe('OPEN · ~14s');
    expect(formatContextChip(0, false, 0.2, 'comply').lines[1]).toBe('OPEN · ~1s');
  });

  it('verdict → label + color', () => {
    expect(formatContextChip(0, false, null, 'comply')).toEqual({
      lines: ['RISK LOW 0.00', 'OPEN', 'COMPLY'],
      color: '#7fbf6a',
    });
    expect(formatContextChip(0.3, true, 5, 'cautious')).toEqual({
      lines: ['RISK MED 0.30', 'COVER · ~5s', 'CAUTIOUS'],
      color: '#e0c060',
    });
    expect(formatContextChip(0.9, false, null, 'balk')).toEqual({
      lines: ['RISK HIGH 0.90', 'OPEN', 'BALK'],
      color: '#d05c50',
    });
  });
});
