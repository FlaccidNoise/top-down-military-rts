import { describe, expect, it } from 'vitest';
import { PARTS, woundLabel } from '../src/sim/body';
import { partSeverity } from '../src/ui/health-panel';

describe('partSeverity', () => {
  it('names an untouched part ok and a wiped one destroyed', () => {
    expect(partSeverity(1)).toBe('ok');
    expect(partSeverity(0)).toBe('destroyed');
  });

  it('speaks woundLabel language on the same damage thresholds', () => {
    const hp = PARTS[0].hp;
    for (const dmg of [0.1, 0.3, 0.31, 0.6, 0.61, 0.9]) {
      const sev = woundLabel({ part: 0, dmg: dmg * hp }).split(': ')[1];
      expect(partSeverity(1 - dmg)).toBe(sev);
    }
  });
});
