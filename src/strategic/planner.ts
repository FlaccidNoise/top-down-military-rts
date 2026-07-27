// The goal-driven opponent (§4.1): a two-tier planner. TIER 1 (operational,
// 360-min cadence) reads its OWN WarGoals through IntelView, ranks objective
// nodes by value/ETA/opposition, picks 1..maxAxes graph axes weighted by
// chokepoints (Tarjan articulation nodes, computed once per theater), masses
// toward concentrationRatio and holds an explicit reserve echelon. TIER 2
// (force ladder, 60-min cadence): withdraw → veto → attack → advance → hold.
// Garrisons never take maneuver orders — doctrine as a FIELD, not terrain
// inference. Zero RNG anywhere; ties break lowest node id → force id.
import { lightAt } from '../sim/solar';
import type { Side } from '../sim/sim';
import { coarseOdds, TRIVIAL_RATIO } from './bridge';
import { battleSiteOf, COARSE_DEF_MULT, CROSSING_ASSAULT_MULT, type Theater } from './theater';
import { CONTACT_M, orderMove, route, type Force, type FrontV2 } from './theater/force';
import { graphGap } from './theater/contact';
import { combatMult, effStrength } from './theater/combat';
import type { IntelView } from './intel';
import type { WarGoals, WinCondition } from './goals';

export interface DoctrineV2 {
  planMinutes: number;
  evalMinutes: number;
  maxAxes: number;
  concentrationRatio: number; // mass this multiple of estimated defenders on the main axis
  reserveFrac: number;
  withdrawRatio: number;
  attackOdds: number; // floor to order an attack
  suicideOdds: number; // absolute veto floor — deadline pressure never crosses it
  deadlinePressure: number; // OQ14: attackOdds decays toward suicideOdds as the deadline nears
}

export const RED_V2: DoctrineV2 = {
  planMinutes: 360,
  evalMinutes: 60,
  maxAxes: 2,
  concentrationRatio: 1.3,
  reserveFrac: 0.25,
  withdrawRatio: 3,
  attackOdds: 0.35,
  suicideOdds: 0.12,
  deadlinePressure: 0.15,
};
export const BLUE_V2: DoctrineV2 = { ...RED_V2, attackOdds: 0.3, deadlinePressure: 0.18 };

export interface Axis {
  objective: number; // node id
  assigned: number[]; // force ids
}
export interface OperationalPlan {
  atMin: number;
  axes: Axis[];
  reserveIds: number[];
}

export type StallCode = 'no-forces' | 'no-reachable-objective' | 'no-viable-attack' | 'goals-met-holding';
export interface PlannerReport {
  orders: { forceId: number; dest: number; why: string }[];
  stall: StallCode | null;
}

// Tarjan articulation nodes over the foot graph — the chokepoints. Computed
// once per theater and cached on the instance.
export function articulationNodes(t: Theater): Set<number> {
  const adj = new Map<number, number[]>();
  for (const e of t.edges) {
    if (e.moveClass === 'rail') continue;
    adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
    adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
  }
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const out = new Set<number>();
  let timer = 0;
  const dfs = (u: number, parent: number): void => {
    disc.set(u, ++timer);
    low.set(u, timer);
    let children = 0;
    for (const v of (adj.get(u) ?? []).slice().sort((a, b) => a - b)) {
      if (v === parent) continue;
      if (disc.has(v)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        continue;
      }
      children++;
      dfs(v, u);
      low.set(u, Math.min(low.get(u)!, low.get(v)!));
      if (parent !== -1 && low.get(v)! >= disc.get(u)!) out.add(u);
    }
    if (parent === -1 && children > 1) out.add(u);
  };
  for (const n of t.nodes) if (!disc.has(n.id) && (adj.get(n.id) ?? []).length > 0) dfs(n.id, -1);
  return out;
}

const controlNodes = (goals: WinCondition[]): number[] =>
  goals.flatMap((c) => (c.kind === 'control' ? c.nodeIds : []));

export class Commander2 {
  plan: OperationalPlan | null = null;
  lastEvalMin = -Infinity;
  private chokepoints: Set<number> | null = null;

  constructor(
    public readonly side: Side,
    public readonly doctrine: DoctrineV2,
    private readonly goals: WarGoals,
    private readonly deadlineDay: number,
  ) {}

  // Estimated effective enemy strength within contact range of a node.
  private defendersAt(front: FrontV2, intel: IntelView, nodeId: number): number {
    let eff = 0;
    for (const c of intel.contacts()) {
      if (graphGap(front.theater, { kind: 'node', nodeId }, c.pos) <= CONTACT_M) eff += c.strength;
    }
    return eff;
  }

  private replan(front: FrontV2, intel: IntelView): void {
    const t = front.theater;
    this.chokepoints ??= articulationNodes(t);
    // Targets: the contested control nodes of BOTH sides' goals — for the
    // deadline side, retaking what the enemy needs IS the goal (denial), so
    // a defender with a deadline attacks lost ground instead of waiting.
    const mobiles = intel
      .own()
      .filter((f) => f.role !== 'garrison' && f.engagedIn === null)
      .sort((a, b) => a.id - b.id);
    const targets = [...new Set([...controlNodes(this.goals.blue), ...controlNodes(this.goals.red)])]
      .filter((n) => intel.control(n) !== this.side)
      .sort((a, b) => a - b);
    const scored: { axis: Axis; score: number }[] = [];
    for (const target of targets) {
      // Nearest mobile force's route minutes seed the axis score; targets no
      // force can reach drop out.
      let bestMin = Infinity;
      for (const f of mobiles) {
        const from = f.pos.kind === 'node' ? f.pos.nodeId : t.edges[f.pos.edgeId].a;
        const r = route(t, from, target);
        if (r && r.minutes < bestMin) bestMin = r.minutes;
      }
      if (!Number.isFinite(bestMin)) continue;
      const defEff = this.defendersAt(front, intel, target);
      const choke = this.chokepoints.has(target) ? 0.85 : 1; // chokepoint objectives are worth more
      scored.push({ axis: { objective: target, assigned: [] }, score: bestMin * choke + defEff * 2 });
    }
    scored.sort((a, b) => a.score - b.score || a.axis.objective - b.axis.objective);
    const axes: Axis[] = scored.slice(0, this.doctrine.maxAxes).map((s) => s.axis);

    // Reserve echelon: role 'reserve' first, else the largest force, until
    // reserveFrac of total mobile strength is held back.
    const totalEff = mobiles.reduce((a, f) => a + effStrength(f), 0);
    const reserveIds: number[] = [];
    let reserved = 0;
    const reservePool = [...mobiles].sort((a, b) => (a.role === 'reserve' ? -1 : 1) - (b.role === 'reserve' ? -1 : 1) || effStrength(b) - effStrength(a) || a.id - b.id);
    for (const f of reservePool) {
      if (reserved >= this.doctrine.reserveFrac * totalEff) break;
      if (axes.length > 0 && mobiles.length - reserveIds.length <= axes.length) break; // never reserve the last attackers
      reserveIds.push(f.id);
      reserved += effStrength(f);
    }

    // Assignment: nearest axis by route minutes; concentration check folds
    // the weakest axis into the strongest when the mass isn't there.
    const assignable = mobiles.filter((f) => !reserveIds.includes(f.id));
    for (const f of assignable) {
      let best: { axis: Axis; min: number } | null = null;
      for (const axis of axes) {
        const from = f.pos.kind === 'node' ? f.pos.nodeId : t.edges[f.pos.edgeId].a;
        const r = route(t, from, axis.objective);
        if (!r) continue;
        if (!best || r.minutes < best.min) best = { axis, min: r.minutes };
      }
      best?.axis.assigned.push(f.id);
    }
    if (axes.length > 1) {
      const mass = (axis: Axis): number =>
        axis.assigned.reduce((a, id) => a + effStrength(front.forces.find((f) => f.id === id)!), 0);
      const need = (axis: Axis): number => this.doctrine.concentrationRatio * Math.max(1, this.defendersAt(front, intel, axis.objective));
      const weak = axes.filter((ax) => mass(ax) < need(ax));
      if (weak.length === axes.length) {
        // Nobody has the mass: concentrate everything on the best axis.
        const main = axes[0];
        for (const ax of axes.slice(1)) main.assigned.push(...ax.assigned);
        axes.length = 1;
      }
    }
    this.plan = { atMin: front.clockMin, axes, reserveIds };
  }

  // Called every strategic minute; internally cadenced. Zero RNG.
  evaluate(front: FrontV2, intel: IntelView): PlannerReport | null {
    if (front.clockMin - this.lastEvalMin < this.doctrine.evalMinutes) return null;
    this.lastEvalMin = front.clockMin;
    if (!this.plan || front.clockMin - this.plan.atMin >= this.doctrine.planMinutes) this.replan(front, intel);

    const t = front.theater;
    const own = intel.own().sort((a, b) => a.id - b.id);
    if (own.length === 0) return { orders: [], stall: 'no-forces' };
    const plan = this.plan!;
    if (plan.axes.length === 0) {
      const anyTarget = controlNodes(this.goals[this.side]).some((n) => intel.control(n) !== this.side);
      return { orders: [], stall: anyTarget ? 'no-reachable-objective' : 'goals-met-holding' };
    }

    // Deadline pressure (OQ14): the attack floor decays toward suicideOdds —
    // which is absolute — as the deadline closes.
    const press = Math.min(1, front.day / Math.max(1, this.deadlineDay));
    const attackFloor = Math.max(this.doctrine.suicideOdds, this.doctrine.attackOdds - this.doctrine.deadlinePressure * press);

    const orders: PlannerReport['orders'] = [];
    let viableSeen = false;
    let attackConsidered = false;

    for (const f of own) {
      if (f.role === 'garrison' || f.engagedIn !== null || f.queuedAt !== null) continue;

      // Withdraw arm: local enemies overwhelm.
      const localEnemy = intel
        .contacts()
        .filter((c) => graphGap(t, f.pos, c.pos) <= 1500)
        .reduce((a, c) => a + c.strength, 0);
      if (localEnemy > this.doctrine.withdrawRatio * effStrength(f)) {
        const rear = t.nodes
          .filter((n) => intel.control(n.id) === this.side)
          .filter((n) => intel.contacts().every((c) => graphGap(t, { kind: 'node', nodeId: n.id }, c.pos) > 1500))
          .sort((a, b) => a.id - b.id);
        for (const n of rear) {
          const r = orderMove(front, f.id, n.id);
          if (r.ok) {
            orders.push({ forceId: f.id, dest: n.id, why: 'withdraw' });
            break;
          }
        }
        continue;
      }

      if (plan.reserveIds.includes(f.id)) {
        // Reserves answer only to commit triggers: a friendly battle going bad.
        for (const b of [...front.battles].sort((p, q) => p.id - q.id)) {
          const mine = front.forces.filter((x) => [b.attackerId, b.defenderId, ...b.joined].includes(x.id) && x.side === this.side);
          const theirs = front.forces.filter((x) => [b.attackerId, b.defenderId, ...b.joined].includes(x.id) && x.side !== this.side);
          const mineEff = mine.reduce((a, x) => a + effStrength(x), 0);
          const theirsEff = theirs.reduce((a, x) => a + effStrength(x), 0);
          if (mine.length > 0 && mineEff < theirsEff && b.site.kind === 'node') {
            const r = orderMove(front, f.id, b.site.nodeId);
            if (r.ok) orders.push({ forceId: f.id, dest: b.site.nodeId, why: 'commit-reserve' });
            break;
          }
        }
        continue;
      }

      const axis = plan.axes.find((ax) => ax.assigned.includes(f.id)) ?? plan.axes[0];
      const target = axis.objective;
      const here = f.pos.kind === 'node' && f.pos.nodeId === target;
      if (here) continue; // holding the objective

      const defEff = this.defendersAt(front, intel, target);
      if (defEff > 0) {
        attackConsidered = true;
        // The attack decision weighs the AXIS'S MASS — concentration is the
        // point: individual companies advance because the mass they belong
        // to clears the floor, and the reinforcement-join machinery stacks
        // them at the site.
        const axisEff = axis.assigned.reduce((a, id) => {
          const g = front.forces.find((x) => x.id === id);
          return g && g.strength > 0 ? a + effStrength(g) : a;
        }, 0);
        const ownEff = Math.max(axisEff, effStrength(f));
        // Trivial doctrine: never attack INTO a trivial defender.
        if (defEff >= ownEff * TRIVIAL_RATIO) continue;
        const { battleClass } = battleSiteOf(t, { kind: 'node', nodeId: target });
        let mult = COARSE_DEF_MULT[battleClass];
        if (battleClass === 'bridge-assault' || battleClass === 'ford-assault') mult *= CROSSING_ASSAULT_MULT;
        if (lightAt(front.clockMin) < 0.25) mult *= 1.0; // nightMult 1.0 until OQ7 lands a value
        const odds = coarseOdds(ownEff, defEff, mult);
        if (odds < attackFloor) continue; // held: not viable (yet)
        viableSeen = true;
      }
      const r = orderMove(front, f.id, target);
      if (r.ok) orders.push({ forceId: f.id, dest: target, why: defEff > 0 ? 'attack' : 'advance' });
      else if (r.reason === 'already-there' || r.reason === 'engaged') continue;
      else viableSeen = viableSeen || false;
    }

    const stall: StallCode | null =
      orders.length > 0 ? null : attackConsidered && !viableSeen ? 'no-viable-attack' : null;
    return { orders, stall };
  }
}

// combatMult re-exported so integration reads ONE module for effective
// strength composition (§4.4).
export { combatMult };
