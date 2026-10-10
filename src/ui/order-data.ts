import type { OrderKind } from '../sim/orders';
import { SMOKE_THROW_M } from '../sim/sim';

export interface OrderAffordance {
  name: string;
  when: string;
  hotkey: string;
  complianceNote: string;
}

// Plain words, no numbers: what the order is (`when`) and when men will not
// carry it out (`complianceNote`). The sim's own rule is orders.ts: fire and
// smoke move nobody and are never refused, an order where the team already
// stands is never refused, and anything that crosses open ground under fire
// can be. A charge is refused first.
const REFUSED_IN_THE_OPEN = 'Refused under fire in the open';

export const ORDER_AFFORDANCE: Record<OrderKind, OrderAffordance> = {
  move:    { name: 'Move',    when: 'The standard advance',                       hotkey: '⇧1', complianceNote: REFUSED_IN_THE_OPEN },
  fast:    { name: 'Fast',    when: 'A sprint that tires the men',                hotkey: '⇧2', complianceNote: REFUSED_IN_THE_OPEN },
  sneak:   { name: 'Sneak',   when: 'A slow crawl that is hard to spot',          hotkey: '⇧3', complianceNote: REFUSED_IN_THE_OPEN },
  fire:    { name: 'Fire',    when: 'Shoot at a point to keep heads down',        hotkey: '⇧4', complianceNote: 'Never refused' },
  smoke:   { name: 'Smoke',   when: 'Throw smoke to block a sightline',           hotkey: '⇧5', complianceNote: `Thrown from within ${SMOKE_THROW_M} m` },
  defend:  { name: 'Defend',  when: 'Hold a line and watch an arc',               hotkey: '⇧6', complianceNote: 'Never refused where they stand' },
  ambush:  { name: 'Ambush',  when: 'Hide and wait for a free first volley',      hotkey: '⇧7', complianceNote: 'Never refused where they stand' },
  assault: { name: 'Assault', when: 'Charge a position that has stopped shooting', hotkey: '⇧8', complianceNote: 'Refused while the enemy can shoot back' },
};

// What the roster tells a player whose team refused an order. Every line names
// an order they can give next. 'fire' has no line: an order that moves nobody
// is never refused (orders.ts movesTeam). A smoke order that cannot be thrown
// carries the sim's own reason (too far, none left), which is already the fix.
const WONT_GO = "Won't go. Fire on the enemy or throw Smoke first.";
export const BALK_HINT: Record<Exclude<OrderKind, 'fire' | 'smoke'>, string> = {
  move: WONT_GO,
  fast: WONT_GO,
  sneak: WONT_GO,
  defend: WONT_GO,
  ambush: WONT_GO,
  assault: "Won't charge. Fire on the position or throw Smoke first.",
};

export function balkHint(kind: OrderKind, reason: string): string {
  if (kind === 'fire' || kind === 'smoke') return reason.charAt(0).toUpperCase() + reason.slice(1);
  return BALK_HINT[kind];
}

export type ArmTarget = 'squad' | 'vehicle' | 'crew';

const ARM_MATRIX: Record<OrderKind, Set<ArmTarget>> = {
  move:    new Set(['squad', 'vehicle', 'crew']),
  fast:    new Set(['squad', 'vehicle', 'crew']),
  sneak:   new Set(['squad', 'crew']),
  fire:    new Set(['squad', 'crew']),
  smoke:   new Set(['squad', 'crew']),
  defend:  new Set(['squad', 'crew']),
  ambush:  new Set(['squad']),
  assault: new Set(['squad']),
};

export function canArm(order: OrderKind, target: ArmTarget): boolean {
  return ARM_MATRIX[order].has(target);
}