// War goals (S19, §4.2): both sides hold victory conditions as DATA. Goals
// are not part of the theater and never reach the generator — a war-length
// change must not move the map (§9.2). makeTheater emits geography;
// makeWarGoals binds the war to it.
import type { CampaignConfig } from '../campaign/spec';
import type { Theater } from './theater';
import type { FrontV2 } from './theater/force';
import type { Side } from '../sim/sim';

export class TheaterGoalsError extends Error {
  constructor(detail: string) {
    super(`makeWarGoals: ${detail}`);
    this.name = 'TheaterGoalsError';
  }
}

export type WinCondition =
  | { kind: 'control'; nodeIds: number[]; need: number; byDay?: number }
  | { kind: 'deadline'; day: number }
  | { kind: 'annihilate'; enemyBelowStrength: number };

export interface WarGoals {
  blue: WinCondition[];
  red: WinCondition[];
}

export type WarState = { state: 'ongoing' } | { state: 'decided'; winner: Side; reason: string };

export function makeWarGoals(theater: Theater, cfg: CampaignConfig): WarGoals {
  if (theater.objectiveNodes.length === 0) {
    throw new TheaterGoalsError('theater emits no objectives — a war nobody can win never ends');
  }
  if (cfg.warDays <= 0) throw new TheaterGoalsError(`warDays ${cfg.warDays} is degenerate`);
  const need = cfg.victory === 'objectives' ? theater.objectiveNodes.length : Math.floor(theater.objectiveNodes.length / 2) + 1;
  return {
    blue: [{ kind: 'control', nodeIds: [...theater.objectiveNodes], need }],
    red: [
      { kind: 'deadline', day: cfg.warDays },
      { kind: 'annihilate', enemyBelowStrength: 1 },
    ],
  };
}

function met(front: FrontV2, side: Side, c: WinCondition): string | null {
  switch (c.kind) {
    case 'control': {
      const held = c.nodeIds.filter((n) => front.controlByNode[n] === side).length;
      if (c.byDay !== undefined && front.day > c.byDay) return null;
      return held >= c.need ? `controls ${held}/${c.nodeIds.length} objectives` : null;
    }
    case 'deadline':
      return front.day > c.day ? `the day-${c.day} deadline passed` : null;
    case 'annihilate': {
      const enemy: Side = side === 'blue' ? 'red' : 'blue';
      const strength = front.forces.filter((f) => f.side === enemy).reduce((a, f) => a + f.strength, 0);
      return strength < c.enemyBelowStrength ? 'the enemy has no fighting strength left' : null;
    }
  }
}

// Blue conditions first — 'won' beats 'lost' on the same evaluation.
export function warStatus(front: FrontV2, goals: WarGoals): WarState {
  for (const c of goals.blue) {
    const reason = met(front, 'blue', c);
    if (reason) return { state: 'decided', winner: 'blue', reason };
  }
  for (const c of goals.red) {
    const reason = met(front, 'red', c);
    if (reason) return { state: 'decided', winner: 'red', reason };
  }
  return { state: 'ongoing' };
}
