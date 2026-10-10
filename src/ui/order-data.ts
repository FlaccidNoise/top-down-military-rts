import type { OrderKind } from '../sim/orders';

export interface OrderAffordance {
  name: string;
  when: string;
  hotkey: string;
  complianceNote: string;
}

export const ORDER_AFFORDANCE: Record<OrderKind, OrderAffordance> = {
  move:    { name: 'Move',    when: 'Standard advance; covers ~2 m/s',              hotkey: '⇧1', complianceNote: 'Balks under fire across open ground' },
  fast:    { name: 'Fast',    when: 'Sprint across danger zone; tires men quickly', hotkey: '⇧2', complianceNote: 'Balks under fire across open ground' },
  sneak:   { name: 'Sneak',   when: 'Slow crawl; harder to spot while moving',      hotkey: '⇧3', complianceNote: 'Balks under fire across open ground' },
  fire:    { name: 'Fire',    when: 'Direct suppressive fire at a point',           hotkey: '⇧4', complianceNote: 'Immediate compliance' },
  smoke:   { name: 'Smoke',   when: 'Pop smoke grenades for visual cover; 2 uses',  hotkey: '⇧5', complianceNote: 'Immediate compliance' },
  defend:  { name: 'Defend',  when: 'Hold a line with a firing arc',                hotkey: '⇧6', complianceNote: 'Immediate compliance' },
  ambush:  { name: 'Ambush',  when: 'Hidden wait; free opening volley on contact',  hotkey: '⇧7', complianceNote: 'Immediate compliance' },
  assault: { name: 'Assault', when: 'Charge a suppressed position; pairs with smoke', hotkey: '⇧8', complianceNote: '×1.3 danger — balks on open ground' },
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