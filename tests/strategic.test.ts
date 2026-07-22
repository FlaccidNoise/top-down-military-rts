import { describe, expect, it } from 'vitest';
import { cellIndex, makeDefaultSector, parseSector } from '../src/strategic/sector';

describe('sector', () => {
  it('parses the default sector: 40×30, river neutral, bridges, objective town', () => {
    const s = makeDefaultSector();
    expect(s.w).toBe(40);
    expect(s.h).toBe(30);
    expect(s.cells[cellIndex(s, 20, 9)].terrain).toBe('river');
    expect(s.cells[cellIndex(s, 20, 9)].owner).toBeNull();
    expect(s.cells[cellIndex(s, 20, 15)].terrain).toBe('bridge');
    expect(s.cells[cellIndex(s, 20, 7)].terrain).toBe('bridge');
    expect(s.cells[cellIndex(s, 4, 15)].terrain).toBe('road');
    expect(s.cells[cellIndex(s, 4, 15)].owner).toBe('blue');
    const objectives = s.cells.filter((c) => c.objective);
    expect(objectives.length).toBe(9); // St-Aubin, 3×3
    expect(objectives.every((c) => c.owner === 'red')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => parseSector(['..', '.'], 1, 'bad')).toThrow(/length/);
    expect(() => parseSector(['.x'], 1, 'bad')).toThrow(/unknown sector char/);
  });
});
