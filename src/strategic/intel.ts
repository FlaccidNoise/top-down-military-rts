// Intel honesty (§4.3): IntelView is the planner's ONLY enemy-read surface.
// A grep gate keeps cross-side front.forces reads out of the planner. Launch
// intel is omniscient (exact, ageMin 0) per OQ6; ContactIntel ships with the
// FOW menu pick.
import type { Side } from '../sim/sim';
import type { Force, FrontV2 } from './theater/force';

export interface EnemyContact {
  forceId: number;
  pos: Force['pos'];
  strength: number;
  ageMin: number;
}

export interface IntelView {
  readonly side: Side;
  own(): Force[];
  contacts(): EnemyContact[];
  control(nodeId: number): Side | null;
}

export class OmniscientIntel implements IntelView {
  constructor(
    private readonly front: FrontV2,
    public readonly side: Side,
  ) {}

  own(): Force[] {
    return this.front.forces.filter((f) => f.side === this.side && f.strength > 0);
  }

  contacts(): EnemyContact[] {
    return this.front.forces
      .filter((f) => f.side !== this.side && f.strength > 0)
      .map((f) => ({ forceId: f.id, pos: f.pos, strength: f.strength, ageMin: 0 }));
  }

  control(nodeId: number): Side | null {
    return this.front.controlByNode[nodeId] ?? null;
  }
}
