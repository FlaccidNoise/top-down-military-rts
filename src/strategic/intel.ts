// Intel honesty (§4.3): IntelView is the planner's ONLY enemy-read surface —
// a grep gate keeps cross-side front.forces reads out of the planner.
// OmniscientIntel is the recon: 'omniscient' arm; ContactIntel (S53) is the
// FOW arm: last-seen contacts with linear confidence decay over
// STRAT_CONTACT_TTL, graph-METRE detection from own forces and owned nodes
// on a 15-minute cadence. The AI plays under the SAME fog (OQ6) —
// difficulty is doctrine, never sight.
import type { Side } from '../sim/sim';
import { graphGap } from './theater/contact';
import type { Force, FrontV2, StratContact } from './theater/force';

export interface EnemyContact {
  forceId: number;
  pos: Force['pos'];
  strength: number;
  ageMin: number;
}

export interface IntelView {
  readonly side: Side;
  own(): Force[];
  contacts(): EnemyContact[];
  control(nodeId: number): Side | null;
}

export class OmniscientIntel implements IntelView {
  constructor(
    private readonly front: FrontV2,
    public readonly side: Side,
  ) {}

  own(): Force[] {
    return this.front.forces.filter((f) => f.side === this.side && f.strength > 0);
  }

  contacts(): EnemyContact[] {
    return this.front.forces
      .filter((f) => f.side !== this.side && f.strength > 0)
      .map((f) => ({ forceId: f.id, pos: f.pos, strength: f.strength, ageMin: 0 }));
  }

  control(nodeId: number): Side | null {
    return this.front.controlByNode[nodeId] ?? null;
  }
}

// -- S53: the contact model ------------------------------------------------

export const STRAT_CONTACT_TTL = 360; // minutes: conf decays linearly to 0
export const INTEL_EVAL_MIN = 15; // detection sweep cadence
export const DETECT_FORCE_M = 3000; // graph metres from a live own force
export const DETECT_NODE_M = 1500; // graph metres from an owned node

export function contactConf(c: StratContact, clockMin: number): number {
  return Math.max(0, 1 - (clockMin - c.seenMin) / STRAT_CONTACT_TTL);
}

// Multi-source Dijkstra in metres over the foot graph. One field serves both
// radii: forces seed at cost 0, owned nodes at (FORCE - NODE), and anything
// under DETECT_FORCE_M in the field is seen. Pure, zero rng, <= 60 nodes.
function detectionDist(front: FrontV2, side: Side): Map<number, number> {
  const t = front.theater;
  const dist = new Map<number, number>();
  const seed = (n: number, d: number): void => {
    if (d < (dist.get(n) ?? Infinity)) dist.set(n, d);
  };
  for (const f of front.forces) {
    if (f.side !== side || f.strength <= 0) continue;
    if (f.pos.kind === 'node') seed(f.pos.nodeId, 0);
    else {
      const e = t.edges[f.pos.edgeId];
      seed(e.a, f.pos.s);
      seed(e.b, e.lengthM - f.pos.s);
    }
  }
  for (const n of t.nodes) {
    if (front.controlByNode[n.id] === side) seed(n.id, DETECT_FORCE_M - DETECT_NODE_M);
  }
  const done = new Set<number>();
  for (;;) {
    let cur = -1;
    let curD = Infinity;
    for (const [n, d] of dist) {
      if (!done.has(n) && d < curD) {
        cur = n;
        curD = d;
      }
    }
    if (cur < 0 || curD > DETECT_FORCE_M) break;
    done.add(cur);
    for (const e of t.edges) {
      if (e.moveClass === 'rail') continue;
      const far = e.a === cur ? e.b : e.b === cur ? e.a : -1;
      if (far < 0 || done.has(far)) continue;
      seed(far, curD + e.lengthM);
    }
  }
  return dist;
}

function isDetected(front: FrontV2, side: Side, dist: Map<number, number>, g: Force): boolean {
  const t = front.theater;
  if (g.pos.kind === 'node') {
    if ((dist.get(g.pos.nodeId) ?? Infinity) <= DETECT_FORCE_M) return true;
  } else {
    const e = t.edges[g.pos.edgeId];
    const via = Math.min(
      (dist.get(e.a) ?? Infinity) + g.pos.s,
      (dist.get(e.b) ?? Infinity) + (e.lengthM - g.pos.s),
    );
    if (via <= DETECT_FORCE_M) return true;
  }
  // Same-edge / incident geometry the endpoint field can overshoot.
  for (const f of front.forces) {
    if (f.side !== side || f.strength <= 0) continue;
    if (graphGap(t, f.pos, g.pos) <= DETECT_FORCE_M) return true;
  }
  return false;
}

// Called every strategic minute by stepWar when the campaign runs contacts;
// does work only on the 15-minute boundary. Upserts a fresh snapshot per
// detected enemy, expires ghosts whose confidence reached zero. Pure
// function of front state — a mid-sweep save replays identically.
export function updateIntelMinute(front: FrontV2): void {
  if (front.clockMin % INTEL_EVAL_MIN !== 0) return;
  const intel = (front.intel ??= { blue: [], red: [] });
  for (const side of ['blue', 'red'] as Side[]) {
    const dist = detectionDist(front, side);
    const list: StratContact[] = intel[side];
    for (const g of front.forces) {
      if (g.side === side || g.strength <= 0) continue;
      if (!isDetected(front, side, dist, g)) continue;
      const snap: StratContact = { forceId: g.id, pos: { ...g.pos }, strength: g.strength, seenMin: front.clockMin };
      const i = list.findIndex((c) => c.forceId === g.id);
      if (i >= 0) list[i] = snap;
      else list.push(snap);
    }
    intel[side] = list
      .filter((c) => contactConf(c, front.clockMin) > 0)
      .sort((a, b) => a.forceId - b.forceId);
  }
}

// The FOW arm of IntelView: the planner reads ghosts, not truth. Contacts
// carry their age; a stale ghost is the caller's risk to weigh.
export class ContactIntel implements IntelView {
  constructor(
    private readonly front: FrontV2,
    public readonly side: Side,
  ) {}

  own(): Force[] {
    return this.front.forces.filter((f) => f.side === this.side && f.strength > 0);
  }

  contacts(): EnemyContact[] {
    return (this.front.intel?.[this.side] ?? []).map((c) => ({
      forceId: c.forceId,
      pos: c.pos,
      strength: c.strength,
      ageMin: this.front.clockMin - c.seenMin,
    }));
  }

  control(nodeId: number): Side | null {
    return this.front.controlByNode[nodeId] ?? null;
  }
}
