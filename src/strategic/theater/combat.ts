// combatMult (§4.4): THE one place supply and fatigue debuffs compose into
// effective strength. Every strength read on both sides — planner belief and
// resolver truth — flows through here, so the debuffs cannot desync them.
// The joint cap is load-bearing: two uncapped debuffs on one score is an
// unrecoverable death spiral (§5d).
import type { Force } from './force';
import { SUPPLY_COMBAT_MULT, supplyTierOf } from './supply';

export const COMBAT_MULT_FLOOR = 0.4;
// S51: fatigue debuff slope — a fully spent force fights at 70%.
export const FATIGUE_COMBAT_SLOPE = 0.3;

export function combatMult(f: Force): number {
  const supplyMult = SUPPLY_COMBAT_MULT[supplyTierOf(f.untracedMin)];
  const fatigueMult = 1 - FATIGUE_COMBAT_SLOPE * f.fatigue;
  return Math.max(COMBAT_MULT_FLOOR, supplyMult * fatigueMult);
}

export function effStrength(f: Force): number {
  return f.strength * combatMult(f);
}
