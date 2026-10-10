// Requisition (jtbug #793, tracker #133): at each reinforcement cycle the
// player picks ONE card in place of the automatic even fill. The AI's default
// stays the even fill (headless.ts, untouched), so the war pin does not move.
// Pure over the campaign and the front: the sheet's copy, what blocks a card
// and what a card does are all here, so each can be tested without a DOM.
import { fillReplacements, replacementRoom, type Campaign } from '../campaign/campaign';
import type { VehicleKey } from '../sim/data';
import { REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY } from './front';
import { DETECT_FORCE_M, SCREEN_DETECT_MULT } from './intel';
import { refitBlock, refitMult } from './refit';
import type { Force, FrontV2 } from './theater/force';

export type RequisitionCard = 'replacements' | 'armour' | 'barrage' | 'recon';

// Persisted on FrontV2. Absent on a save from before the cards: nothing due,
// nothing running.
export interface Requisition {
  due: boolean; // a choice is waiting: the clock holds until it is made
  barrageUntilDay: number; // the extra barrage runs while front.day is below this
}

export const REQ_ARMOR: VehicleKey[] = ['sherman']; // the section attached to one company
export const REQ_ARMOR_ATTACKS = 2; // attacks it stays for
export const REQ_BARRAGES = 1; // more barrages in every fought battle
export const REQ_DAYS = REINFORCE_CYCLE_DAYS; // how long the barrage and the recon detachment stay

export const requisitionDue = (front: FrontV2): boolean => front.requisition?.due === true;
export const barrageRunning = (front: FrontV2): boolean => (front.requisition?.barrageUntilDay ?? 0) > front.day;
export const reconRunning = (front: Pick<FrontV2, 'day'>, f: Pick<Force, 'reconUntilDay'>): boolean => f.reconUntilDay > front.day;

// The men one card can bring: the whole cycle's draft, to one company.
export const draftSize = (c: Campaign): number => REINFORCE_PER_COMPANY * c.companies.length;
// More of it reaches a billeted company (refit.ts).
export const draftFor = (front: FrontV2, c: Campaign, f: Force): number => Math.round(draftSize(c) * refitMult(front, f));

export interface CardOffer {
  id: RequisitionCard;
  glyph: string;
  name: string;
  effect: string; // six words at most, every number from its constant
  blocked: string | null; // why it cannot be picked now, in place of the effect
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const company = (front: FrontV2, forceId: number): Force | undefined => front.forces.find((f) => f.id === forceId && f.side === 'blue' && f.strength > 0);

// The four cards as they stand for one company. `fog` is whether the war
// runs under contacts intel: with full knowledge a recon detachment is idle.
export function requisitionOffer(front: FrontV2, c: Campaign, forceId: number, fog: boolean): CardOffer[] {
  const f = company(front, forceId);
  const none = f ? null : 'No company left.';
  const days = plural(REQ_DAYS, 'day');
  return [
    {
      id: 'replacements', glyph: '✚', name: 'Replacements',
      effect: `Up to ${f ? draftFor(front, c, f) : draftSize(c)} men.`,
      blocked: none ?? (replacementRoom(c, f!.companyIndex) === 0 ? 'Full strength.' : refitBlock(front, f!) === 'contact' ? 'In contact.' : refitBlock(front, f!) === 'supply' ? 'Out of supply.' : null),
    },
    { id: 'armour', glyph: '▣', name: 'Armour', effect: `A tank joins ${REQ_ARMOR_ATTACKS} attacks.`, blocked: none },
    { id: 'barrage', glyph: '✸', name: 'Barrage', effect: `+${REQ_BARRAGES} per battle, ${days}.`, blocked: null },
    {
      id: 'recon', glyph: '◉', name: 'Recon',
      effect: `Sees ${(DETECT_FORCE_M * SCREEN_DETECT_MULT) / 1000} km, ${days}.`,
      blocked: none ?? (fog ? null : 'Fog is off.'),
    },
  ];
}

export type RequisitionResult = { ok: true; text: string } | { ok: false; reason: string };

// Take one card. A blocked card changes nothing. The choice closes the cycle.
export function applyRequisition(front: FrontV2, c: Campaign, card: RequisitionCard, forceId: number, fog: boolean): RequisitionResult {
  if (!requisitionDue(front)) return { ok: false, reason: 'Nothing is due.' };
  const offer = requisitionOffer(front, c, forceId, fog).find((o) => o.id === card)!;
  if (offer.blocked) return { ok: false, reason: offer.blocked };
  const f = company(front, forceId);
  const req = front.requisition!;
  let text: string;
  switch (card) {
    case 'replacements': {
      // The even fill's own seed and its own function, aimed at one company.
      const n = fillReplacements(c, front.day * 31 + 7, draftFor(front, c, f!), f!.companyIndex);
      text = `${n} replacements join ${f!.name}`;
      break;
    }
    case 'armour':
      f!.armorAttacks = REQ_ARMOR_ATTACKS;
      text = `An armour section joins ${f!.name}`;
      break;
    case 'barrage':
      req.barrageUntilDay = front.day + REQ_DAYS;
      text = `Artillery allotted until Day ${req.barrageUntilDay}`;
      break;
    case 'recon':
      f!.reconUntilDay = front.day + REQ_DAYS;
      text = `A recon detachment joins ${f!.name}`;
      break;
  }
  req.due = false;
  return { ok: true, text };
}

// What a company has running, for its card: a few words each.
export function requisitionNotes(front: FrontV2, f: Force): string[] {
  const out: string[] = [];
  if (f.armorAttacks > 0) out.push(`Tank: ${plural(f.armorAttacks, 'attack')}`);
  if (reconRunning(front, f)) out.push(`Recon to Day ${f.reconUntilDay}`);
  if (f.side === 'blue' && barrageRunning(front)) out.push(`+${REQ_BARRAGES} barrage to Day ${front.requisition!.barrageUntilDay}`);
  return out;
}
