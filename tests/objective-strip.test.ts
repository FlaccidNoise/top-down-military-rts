import { describe, expect, it } from 'vitest';
import { objectiveStripText, type ObjectiveData } from '../src/ui/objective-strip';

const BASE: ObjectiveData = {
  kind: 'attack',
  cellLabel: 'C4',
  isObjective: true,
  attackerName: 'Able Co',
  defenderName: '2. Zug',
  attackerStrength: 120,
  defenderStrength: 90,
};

describe('objectiveStripText', () => {
  it('returns null for null objective', () => {
    expect(objectiveStripText(null, 100, 80, 30, 25)).toBeNull();
  });

  it('attack: label includes ASSAULT + cell + objective star', () => {
    const r = objectiveStripText(BASE, 100, 60, 30, 25)!;
    expect(r.label).toBe('★ ASSAULT C4');
    expect(r.condition).toContain('Break the defense');
    expect(r.condition).toContain('⌊25⌋'); // red floor
  });

  it('attack: condition mentions staying at or above own floor', () => {
    const r = objectiveStripText(BASE, 100, 60, 30, 25)!;
    expect(r.condition).toContain('staying at or above ⌊30⌋'); // blue floor
  });

  it('attack: no star when not objective', () => {
    const r = objectiveStripText({ ...BASE, isObjective: false }, 100, 60, 30, 25)!;
    expect(r.label).toBe('ASSAULT C4');
  });

  it('defend: label includes DEFEND + correct condition text', () => {
    const r = objectiveStripText({ ...BASE, kind: 'defend' }, 35, 80, 30, 25)!;
    expect(r.label).toBe('★ DEFEND C4');
    expect(r.condition).toContain('Hold');
    expect(r.condition).toContain('⌊30⌋'); // blue floor
  });

  it('bars: values and max reflect alive/floors', () => {
    const r = objectiveStripText(BASE, 100, 60, 30, 25)!;
    expect(r.friendlyBar).toEqual({ value: 100, max: 60, state: 'steady' });
    expect(r.enemyBar).toEqual({ value: 60, max: 50, state: 'steady' });
  });

  it('friendly bar state: steady → shaken → pinned → broken', () => {
    const floor = 30;
    const cases: [number, string][] = [
      [100, 'steady'],
      [60, 'steady'],   // exactly 2x → steady
      [59, 'shaken'],   // below 2x
      [45, 'shaken'],   // exactly 1.5x → shaken
      [44, 'pinned'],   // below 1.5x
      [30, 'pinned'],   // exactly 1x → pinned
      [29, 'broken'],   // below 1x
      [10, 'broken'],
      [0, 'broken'],
    ];
    for (const [alive, expected] of cases) {
      const r = objectiveStripText(BASE, alive, 60, floor, 25)!;
      expect(r.friendlyBar.state, `blue=${alive}, floor=${floor}`).toBe(expected);
    }
  });

  it('enemy bar state: same thresholds', () => {
    const floor = 25;
    const r = objectiveStripText(BASE, 100, 50, 30, floor)!;
    expect(r.enemyBar.state).toBe('steady');
    const r2 = objectiveStripText(BASE, 100, 24, 30, floor)!;
    expect(r2!.enemyBar.state).toBe('broken');
  });
});