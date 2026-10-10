import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/campaign/presets';
import { makeWarGoals, type WarGoals } from '../src/strategic/goals';
import { makeTheater } from '../src/strategic/theatergen';
import { goalLine } from '../src/ui/goal-line';

const goals = (need: number, total: number, day: number | null): WarGoals => ({
  blue: [{ kind: 'control', nodeIds: Array.from({ length: total }, (_, i) => i), need }],
  red: day === null ? [] : [{ kind: 'deadline', day }],
});

describe('goalLine', () => {
  it('says every town when every town is needed, with the day from the goals', () => {
    expect(goalLine(goals(5, 5, 14))).toBe('Take the gold-ringed towns before Day 14.');
  });

  it('says how many when a majority wins', () => {
    expect(goalLine(goals(3, 4, 7))).toBe('Take 3 of the 4 gold-ringed towns before Day 7.');
  });

  it('names no day when the war has no deadline', () => {
    expect(goalLine(goals(2, 2, null))).toBe('Take the gold-ringed towns.');
  });

  it('says nothing when there is nothing to take', () => {
    expect(goalLine({ blue: [], red: [] })).toBeNull();
    expect(goalLine(goals(0, 0, 7))).toBeNull();
  });

  it('is one short line on every preset, with the numbers the war runs on', () => {
    for (const p of PRESETS) {
      const g = makeWarGoals(makeTheater(7, p.theater).theater, p.campaign);
      const line = goalLine(g)!;
      expect(line.split(' ').length, `${p.name}: ${line}`).toBeLessThanOrEqual(10);
      expect(line, p.name).toContain(`Day ${p.campaign.warDays}`);
      const control = g.blue.find((c) => c.kind === 'control');
      if (control && control.kind === 'control' && control.need < control.nodeIds.length) expect(line, p.name).toContain(`${control.need} of the ${control.nodeIds.length}`);
    }
  });
});
