// combatMult (§4.4): THE one place supply and fatigue debuffs compose into
// effective strength. Both are 1.0 until their lanes land (S50/S51) — but
// every strength read on both sides already flows through here, so landing
// them cannot desync the planner from the resolver.
import type { Force } from './force';

export function combatMult(f: Force): number {
  void f;
  const supplyMult = 1.0;
  const fatigueMult = 1.0;
  return Math.max(0.4, supplyMult * fatigueMult);
}

export function effStrength(f: Force): number {
  return f.strength * combatMult(f);
}
