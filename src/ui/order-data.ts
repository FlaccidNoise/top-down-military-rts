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

export const BALK_HINT: Record<OrderKind, string> = {
  move:    'Open ground under fire — suppress or smoke first, or pick a covered approach',
  fast:    'Open ground under fire — suppress or smoke first, or pick a covered approach',
  sneak:   'Open ground under fire — suppress or smoke first, or pick a covered approach',
  fire:    'Team refusing — rally or suppress the threat first',
  smoke:   'Team refusing — rally or suppress the threat first',
  defend:  'Team refusing to reposition — rally first',
  ambush:  'Team refusing — rally first',
  assault: 'Suppress or smoke the objective, then re-issue the assault',
};

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