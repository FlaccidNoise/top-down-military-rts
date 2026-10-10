// How well an operation was won (jtbug #793). A label and a target: it never
// decides who wins (goals.ts does), it grades a win by the day it came and the
// men it cost. Pure over the campaign roster and the front.
import type { Campaign } from '../campaign/campaign';
import type { FrontV2 } from './theater/force';

export type VictoryTier = 'decisive' | 'marginal' | 'pyrrhic';

// Decisive: won in the first two thirds of the days allowed, with a quarter
// of the force or less killed. Pyrrhic: half the force or more killed,
// whenever it was won. Marginal: every other win.
export const DECISIVE_DAY_FRAC = 2 / 3;
export const DECISIVE_LOSS_FRAC = 0.25;
export const PYRRHIC_LOSS_FRAC = 0.5;

export const decisiveByDay = (warDays: number): number => Math.max(1, Math.floor(warDays * DECISIVE_DAY_FRAC));

export interface Losses {
  killed: number;
  establishment: number; // the companies' strength at muster
  frac: number;
}

export function lossesOf(front: FrontV2, c: Campaign): Losses {
  const killed = Object.values(c.soldiers).filter((s) => s.status === 'kia').length;
  const establishment = front.forces.filter((f) => f.side === 'blue').reduce((a, f) => a + f.establishment, 0);
  return { killed, establishment, frac: establishment > 0 ? killed / establishment : 0 };
}

export function tierOf(day: number, lossFrac: number, warDays: number): VictoryTier {
  if (lossFrac >= PYRRHIC_LOSS_FRAC) return 'pyrrhic';
  return day <= decisiveByDay(warDays) && lossFrac <= DECISIVE_LOSS_FRAC ? 'decisive' : 'marginal';
}

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;

// The best result still open, for the top bar: the thing to beat.
export function resultTarget(front: FrontV2, c: Campaign, warDays: number): string {
  const { frac } = lossesOf(front, c);
  const tier = tierOf(front.day, frac, warDays);
  if (tier === 'decisive') return `Decisive by Day ${decisiveByDay(warDays)}`;
  return tier === 'pyrrhic' ? `Pyrrhic: ${pct(frac)} killed` : 'Marginal at best';
}

// The end screen: the grade, and the numbers that decided it.
export function resultOfWin(front: FrontV2, c: Campaign, warDays: number): { tier: VictoryTier; title: string; why: string } {
  const l = lossesOf(front, c);
  const tier = tierOf(front.day, l.frac, warDays);
  const title = { decisive: 'Decisive victory', marginal: 'Marginal victory', pyrrhic: 'Pyrrhic victory' }[tier];
  return { tier, title, why: `Won on Day ${front.day} of ${warDays} · ${l.killed} of ${l.establishment} men killed (${pct(l.frac)})` };
}
