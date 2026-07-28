// syncStrengths V2 (§2.5): the blue roster <-> Force.strength mirror, keyed
// by companyIndex — called on every day roll and after every battle, exactly
// as the V1 chit mirror was. Red forces are attrition counters and never
// sync; a blue company at zero fit men stays on the map at strength 0 (the
// pinned persistence asymmetry).
import { fitStrength, type Campaign } from '../../campaign/campaign';
import type { FrontV2 } from './force';

export function syncStrengthsV2(c: Campaign, front: FrontV2): void {
  for (const f of front.forces) {
    if (f.side !== 'blue' || f.companyIndex < 0) continue;
    f.strength = fitStrength(c, f.companyIndex);
  }
}
