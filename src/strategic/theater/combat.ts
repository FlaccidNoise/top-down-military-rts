// combatMult (§4.4): THE one place supply and fatigue debuffs compose into
// effective strength. Every strength read on both sides — planner belief and
// resolver truth — flows through here, so the debuffs cannot desync them.
// The joint cap is load-bearing: two uncapped debuffs on one score is an
// unrecoverable death spiral (§5d).
import type { Force } from './force';
import { dugIn } from './step';
import { SUPPLY_COMBAT_MULT, supplyTierOf } from './supply';

export const COMBAT_MULT_FLOOR = 0.4;
// S51: fatigue debuff slope — a fully spent force fights at 70%.
export const FATIGUE_COMBAT_SLOPE = 0.3;

// Postures (jtbug #786): a force caught at rest fights below strength, and a
// dug-in force is that much harder to shift when it DEFENDS.
export const REST_COMBAT_MULT = 0.8;
export const DIG_DEF_MULT = 1.5;

export function combatMult(f: Force): number {
  const supplyMult = SUPPLY_COMBAT_MULT[supplyTierOf(f.untracedMin)];
  const fatigueMult = 1 - FATIGUE_COMBAT_SLOPE * f.fatigue;
  const base = supplyMult * fatigueMult;
  return Math.max(COMBAT_MULT_FLOOR, f.posture === 'rest' ? base * REST_COMBAT_MULT : base);
}

// Effective strength on the defence: the dug-in multiplier sits outside the
// joint floor, because it is a bonus and the floor guards debuffs.
export function defStrength(f: Force): number {
  return dugIn(f) ? effStrength(f) * DIG_DEF_MULT : effStrength(f);
}

export function effStrength(f: Force): number {
  return f.strength * combatMult(f);
}
