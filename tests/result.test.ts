// Tiered victory (jtbug #793): a label and a target. It grades a win by the
// day it came and the men it cost, and it never decides who wins.
import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeWarGoals, warStatus } from '../src/strategic/goals';
import { makeHeadlessWorld } from '../src/strategic/headless';
import { DECISIVE_DAY_FRAC, DECISIVE_LOSS_FRAC, decisiveByDay, lossesOf, PYRRHIC_LOSS_FRAC, resultOfWin, resultTarget, tierOf } from '../src/strategic/result';
import { lineFront, place } from './lib/line-theater';

const WAR = 14;
const words = (s: string): number => s.trim().split(/\s+/).length;

describe('the grade', () => {
  it('decisive is early AND cheap; pyrrhic is costly whenever; the rest is marginal', () => {
    const by = decisiveByDay(WAR);
    expect(by).toBe(Math.floor(WAR * DECISIVE_DAY_FRAC));
    expect(tierOf(by, DECISIVE_LOSS_FRAC, WAR)).toBe('decisive');
    expect(tierOf(by + 1, 0, WAR)).toBe('marginal'); // late
    expect(tierOf(1, DECISIVE_LOSS_FRAC + 0.01, WAR)).toBe('marginal'); // early but dear
    expect(tierOf(1, PYRRHIC_LOSS_FRAC, WAR)).toBe('pyrrhic');
    expect(tierOf(WAR, PYRRHIC_LOSS_FRAC + 0.2, WAR)).toBe('pyrrhic');
  });

  it('losses are the men killed against the strength at muster', () => {
    const fr = lineFront();
    const c = newCampaign(1, 1);
    const f = place(fr, 'blue', 1, 100);
    place(fr, 'red', 2, 500); // red does not count
    expect(lossesOf(fr, c)).toEqual({ killed: 0, establishment: 100, frac: 0 });
    Object.values(c.soldiers).slice(0, 30).forEach((s) => (s.status = 'kia'));
    f.strength = 70; // the bar falls, the establishment does not
    expect(lossesOf(fr, c)).toEqual({ killed: 30, establishment: 100, frac: 0.3 });
  });
});

describe('the top bar: the thing to beat', () => {
  const at = (day: number, killed: number): string => {
    const fr = lineFront();
    fr.day = day;
    const c = newCampaign(1, 1);
    place(fr, 'blue', 1, 100);
    Object.values(c.soldiers).slice(0, killed).forEach((s) => (s.status = 'kia'));
    return resultTarget(fr, c, WAR);
  };

  it('names the best result still open, in four words at most', () => {
    expect(at(1, 0)).toBe(`Decisive by Day ${decisiveByDay(WAR)}`);
    expect(at(decisiveByDay(WAR), 25)).toBe(`Decisive by Day ${decisiveByDay(WAR)}`);
    expect(at(decisiveByDay(WAR) + 1, 0)).toBe('Marginal at best');
    expect(at(1, 26)).toBe('Marginal at best');
    expect(at(1, 60)).toBe('Pyrrhic: 60% killed');
    for (const s of [at(1, 0), at(12, 0), at(1, 60)]) expect(words(s)).toBeLessThanOrEqual(4);
  });
});

describe('the end screen', () => {
  it('gives the grade and the numbers that decided it', () => {
    const fr = lineFront();
    fr.day = 8;
    const c = newCampaign(1, 1);
    place(fr, 'blue', 1, 100);
    Object.values(c.soldiers).slice(0, 7).forEach((s) => (s.status = 'kia'));
    expect(resultOfWin(fr, c, WAR)).toEqual({ tier: 'decisive', title: 'Decisive victory', why: 'Won on Day 8 of 14 · 7 of 100 men killed (7%)' });
    fr.day = 13;
    expect(resultOfWin(fr, c, WAR).title).toBe('Marginal victory');
    Object.values(c.soldiers).slice(0, 55).forEach((s) => (s.status = 'kia'));
    expect(resultOfWin(fr, c, WAR)).toMatchObject({ tier: 'pyrrhic', title: 'Pyrrhic victory' });
  });
});

describe('who wins is not touched', () => {
  it('the win conditions carry no day of their own: a win on the last day is a win', () => {
    const w = makeHeadlessWorld(1, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    const goals = makeWarGoals(w.front.theater, DEFAULT_PRESET.campaign);
    expect(goals.blue).toEqual([{ kind: 'control', nodeIds: w.front.theater.objectiveNodes, need: w.front.theater.objectiveNodes.length }]);
    w.front.day = DEFAULT_PRESET.campaign.warDays; // long past "decisive by"
    for (const n of w.front.theater.objectiveNodes) w.front.controlByNode[n] = 'blue';
    expect(warStatus(w.front, goals)).toMatchObject({ state: 'decided', winner: 'blue' });
  });
});
