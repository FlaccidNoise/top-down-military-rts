// Supply lines (S50, design §5a) — DEGRADE-ONLY. A force is in supply iff a
// path of traceable road edges reaches a friendly source node. One BFS per
// side per strategic hour; the trace is a pure function of front state and
// draws no rng. Exactly two effects, both at verified seams: staging ammo
// 100/50/25% (bridge2.ts) and a supplyMult into combatMult (combat.ts).
// Attrition and replacement throttling stay OUT (death-spiral class).
//
// What breaks a trace (the ZOC 5-line subset): an enemy-CONTROLLED node is
// untraversable, and a live enemy force standing ON an edge interdicts it —
// ~90% of interdiction's strategic payoff with none of the movement-resolver
// risk. Friendly and uncontrolled (null) nodes both pass: a lifeline through
// no-man's-land holds until the enemy actually stands on it.
import type { Side } from '../../sim/sim';
import type { NetPos, Theater } from '../theater';
import type { Force, FrontV2 } from './force';

export const SUPPLY_EVAL_MIN = 60; // trace cadence: each strategic hour
export const SUPPLY_LOW_MIN = 240; // untraced this long: low (ammo 50%)
export const SUPPLY_OUT_MIN = 720; // untraced this long: out (ammo 25%)

export type SupplyTier = 'full' | 'low' | 'out';

export function supplyTierOf(untracedMin: number): SupplyTier {
  if (untracedMin >= SUPPLY_OUT_MIN) return 'out';
  if (untracedMin >= SUPPLY_LOW_MIN) return 'low';
  return 'full';
}

// The logged 100/50/25 ammo doctrine (docs/decisions/units.md).
export const SUPPLY_AMMO_MULT: Record<SupplyTier, number> = { full: 1, low: 0.5, out: 0.25 };
// Coarse-score debuff, composed ONLY inside combatMult (§4.4). Loss bands
// keep reading raw strength — supply degrades odds, never deletes men.
export const SUPPLY_COMBAT_MULT: Record<SupplyTier, number> = { full: 1, low: 0.75, out: 0.5 };

export interface SupplyTrace {
  traced: Set<number>; // node ids reachable from a friendly source
  interdicted: Set<number>; // foot edge ids carrying a live enemy force
}

// `alter` asks a what-if of the same trace: `block` closes one more node to
// `side`, `open` hands one enemy node back. The planner weighs a cut and a
// relief with it. The live trace passes neither.
export function traceSupply(front: FrontV2, side: Side, alter: { block?: number; open?: number } = {}): SupplyTrace {
  const t = front.theater;
  const enemy: Side = side === 'blue' ? 'red' : 'blue';
  const interdicted = new Set<number>();
  for (const g of front.forces) {
    if (g.side === enemy && g.strength > 0 && g.pos.kind === 'edge') interdicted.add(g.pos.edgeId);
  }
  const blocked = (n: number): boolean => n !== alter.open && (n === alter.block || front.controlByNode[n] === enemy);
  const traced = new Set<number>();
  const queue: number[] = [];
  for (const s of t.sources[side]) {
    if (!blocked(s)) {
      traced.add(s);
      queue.push(s);
    }
  }
  while (queue.length > 0) {
    const n = queue.pop()!;
    for (const e of t.edges) {
      if (e.moveClass === 'rail' || interdicted.has(e.id)) continue;
      const far = e.a === n ? e.b : e.b === n ? e.a : -1;
      if (far < 0 || traced.has(far) || blocked(far)) continue;
      traced.add(far);
      queue.push(far);
    }
  }
  return { traced, interdicted };
}

// A force mid-edge is supplied through either end of its edge; the BFS has
// already refused ends only reachable over interdicted ground.
export function posSupplied(t: Theater, pos: NetPos, traced: Set<number>): boolean {
  if (pos.kind === 'node') return traced.has(pos.nodeId);
  const e = t.edges[pos.edgeId];
  return traced.has(e.a) || traced.has(e.b);
}
export const forceSupplied = (front: FrontV2, f: Force, traced: Set<number>): boolean => posSupplied(front.theater, f.pos, traced);

// Called every strategic minute by stepWar when the campaign runs supply;
// does work only on the hour boundary. untracedMin accrues in whole eval
// intervals, so a save at any minute replays identically.
export function updateSupplyMinute(front: FrontV2): void {
  if (front.clockMin % SUPPLY_EVAL_MIN !== 0) return;
  for (const side of ['blue', 'red'] as Side[]) {
    const { traced } = traceSupply(front, side);
    for (const f of front.forces) {
      if (f.side !== side || f.strength <= 0) continue;
      f.untracedMin = forceSupplied(front, f, traced) ? 0 : f.untracedMin + SUPPLY_EVAL_MIN;
    }
  }
}
