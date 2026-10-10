// Refit (jtbug #793): replacements reach a company only when it is supplied
// and out of contact, and a billeted company takes more of them.
//
// The design kept replacement THROTTLING out (v2 design §5a, "death-spiral
// class"), and the decision log rejected a per-day trickle for the same
// reason. This respects both. The cycle keeps its rhythm, and a draft that
// cannot be delivered is not lost: it waits at the depot, up to
// REFIT_OWED_CYCLES cycles of it, and arrives at the first cycle the company
// can take it. So a mauled company that pulls back gets its men, with
// interest, and one that stays in the fight does not bleed its draft away.
import { fillReplacements, type Campaign } from '../campaign/campaign';
import { REINFORCE_PER_COMPANY } from './front';
import { graphGap } from './theater/contact';
import type { Force, FrontV2 } from './theater/force';
import { billeted } from './theater/step';
import { THREAT_M } from './theater/war';

export const REFIT_BILLET_MULT = 1.5; // a billeted company takes this much of a draft
export const REFIT_OWED_CYCLES = 2; // drafts the depot holds for a company that cannot take them

export type RefitBlock = 'contact' | 'supply';

// Why a company cannot take replacements now, or null when it can. Contact
// is an enemy inside threat range, or a battle: nobody marches a draft into
// that. Supply is the trace the draft would walk up.
export function refitBlock(front: FrontV2, f: Force): RefitBlock | null {
  if (f.engagedIn !== null || front.forces.some((g) => g.side !== f.side && g.strength > 0 && graphGap(front.theater, f.pos, g.pos) <= THREAT_M)) return 'contact';
  return f.untracedMin > 0 ? 'supply' : null;
}

export const refitMult = (front: FrontV2, f: Force): number => (billeted(front, f) ? REFIT_BILLET_MULT : 1);

// The force card's line, five words at most.
export function refitNote(front: FrontV2, f: Force): string {
  const block = refitBlock(front, f);
  if (block) return block === 'contact' ? 'No refit: in contact.' : 'No refit: out of supply.';
  return billeted(front, f) ? `Refit ×${REFIT_BILLET_MULT}: billeted.` : 'Refit ready.';
}

// The automatic cycle (the AI's, and the player's before requisition): every
// company is owed a draft. One that can refit takes what it is owed, times
// the billet bonus. One that cannot keeps it owed, up to the cap. Returns the
// men delivered.
export function cycleRefit(c: Campaign, front: FrontV2, seed: number): number {
  let total = 0;
  for (const f of [...front.forces].sort((a, b) => a.id - b.id)) {
    if (f.side !== 'blue' || f.companyIndex < 0 || f.strength <= 0) continue;
    f.owedMen = Math.min(REINFORCE_PER_COMPANY * REFIT_OWED_CYCLES, f.owedMen + REINFORCE_PER_COMPANY);
    if (refitBlock(front, f)) continue;
    // One stream per company: a shared seed would give every company the
    // same new names.
    total += fillReplacements(c, seed + f.companyIndex * 7919, Math.round(f.owedMen * refitMult(front, f)), f.companyIndex);
    f.owedMen = 0;
  }
  return total;
}
