// War goals (S19, §4.2): both sides hold victory conditions as DATA. Goals
// are not part of the theater and never reach the generator — a war-length
// change must not move the map (§9.2), so the seam is two functions:
// makeTheater emits geography, makeWarGoals binds the war to it.
import type { CampaignConfig } from '../campaign/spec';
import type { Theater } from './theater';
import type { FrontV2 } from './theater/force';

export class TheaterGoalsError extends Error {
  constructor(detail: string) {
    super(`makeWarGoals: ${detail}`);
    this.name = 'TheaterGoalsError';
  }
}

export interface WarGoals {
  deadlineDay: number; // red wins the war at day > deadlineDay
  victory: 'objectives' | 'majority';
  objectiveNodes: number[];
}

export function makeWarGoals(theater: Theater, cfg: CampaignConfig): WarGoals {
  if (theater.objectiveNodes.length === 0) {
    throw new TheaterGoalsError('theater emits no objectives — a war nobody can win never ends');
  }
  if (cfg.warDays <= 0) throw new TheaterGoalsError(`warDays ${cfg.warDays} is degenerate`);
  return { deadlineDay: cfg.warDays, victory: cfg.victory, objectiveNodes: [...theater.objectiveNodes] };
}

// Two-sided status, blue-first tie: a blue win evaluated on the deadline day
// itself is a blue win. 'red' covers both arms — deadline expiry and a blue
// side with no fighting strength left.
export function warStatus(front: FrontV2, goals: WarGoals): 'ongoing' | 'blue' | 'red' {
  const held = goals.objectiveNodes.filter((n) => front.controlByNode[n] === 'blue').length;
  const blueWon = goals.victory === 'objectives' ? held === goals.objectiveNodes.length : held > goals.objectiveNodes.length / 2;
  if (blueWon) return 'blue';
  const blueAlive = front.forces.some((f) => f.side === 'blue' && f.strength > 0);
  if (!blueAlive) return 'red';
  if (front.day > goals.deadlineDay) return 'red';
  return 'ongoing';
}
