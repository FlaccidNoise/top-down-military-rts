// Force + Front V2 state + routing (S13, design doc §1/§3): the mutable war
// over an immutable Theater. Positions are metres on the network (NetPos);
// routing is Dijkstra over <= 60 nodes (linear scan is fine — 3.6k ops);
// forceEtaMinutes MIRRORS the step arithmetic exactly, the pinned
// chitEtaMinutes lockstep rule carried over.
import type { Side } from '../../sim/sim';
import type { NetPos, Theater, TheaterEdge } from '../theater';

export type ForceRole = 'line' | 'garrison' | 'reserve';

export interface Force {
  id: number;
  side: Side;
  name: string;
  pos: NetPos;
  path: number[]; // remaining EDGE ids (parallel road/rail disambiguation)
  dwellMin: number; // ford/bridge dwell elapsed
  strength: number;
  companyIndex: number; // blue roster / red counter — unchanged contract
  role: ForceRole;
  engagedIn: number | null; // CoarseBattle id
  queuedAt: number | null; // bridge node id while waiting at the defile
  untracedMin: number; // S50 supply: minutes since a road last traced to a friendly source
  fatigue: number; // S51: 0..1 march/combat fatigue
}

// Creation shape: the realism fields default to fresh at the ONE chokepoint
// (addForce), so disposition and test literals never carry boilerplate zeros.
export type ForceInit = Omit<Force, 'id' | 'untracedMin' | 'fatigue'> &
  Partial<Pick<Force, 'untracedMin' | 'fatigue'>>;

export interface CoarseBattle {
  id: number;
  site: NetPos;
  attackerId: number;
  defenderId: number;
  joined: number[]; // reinforcements folded in (§3.4)
  startMin: number;
  endMin: number;
  forced: 'attacker' | 'defender' | null;
  approachEdgeId: number | null; // the attacker's approach — crossing-assault classification + setback axis
}

export interface TheaterEvent {
  min: number;
  kind: 'contact' | 'battle-resolved' | 'capture' | 'arrival' | 'retreat' | 'overrun' | 'stall';
  text: string;
  forceIds: number[];
  nodeId?: number;
}

// S53 FOW: a last-seen enemy snapshot. Confidence is DERIVED from seenMin +
// the clock (linear decay over STRAT_CONTACT_TTL) so a save needs no timer.
export interface StratContact {
  forceId: number;
  pos: NetPos;
  strength: number;
  seenMin: number;
}

export const EVENT_LOG_CAP = 64;
export const MAX_FORCES = 24;
export const FORD_CROSS_MIN = 45; // CELL_MINUTES river 60 - open 15 — the ford premium
export const BRIDGE_DWELL_MIN = 15;
export const CONTACT_M = 300;

export interface FrontV2 {
  theater: Theater;
  clockMin: number;
  day: number;
  nextForceId: number;
  nextBattleId: number;
  forces: Force[];
  controlByNode: (Side | null)[];
  battles: CoarseBattle[];
  events: TheaterEvent[]; // bounded ring, EVENT_LOG_CAP
  defileQueues: Record<number, number[]>; // bridge nodeId -> FIFO of force ids
  // S53: per-side contact maps, present when the campaign runs recon:
  // 'contacts' (lazily initialized by updateIntelMinute, persisted in v4).
  intel?: Record<Side, StratContact[]>;
}

export function pushEvent(front: FrontV2, e: TheaterEvent): void {
  front.events.push(e);
  if (front.events.length > EVENT_LOG_CAP) front.events.splice(0, front.events.length - EVENT_LOG_CAP);
}

export function addForce(front: FrontV2, f: ForceInit): Force {
  if (front.forces.length >= MAX_FORCES) {
    throw new Error(`addForce: MAX_FORCES (${MAX_FORCES}) reached — the force cap is asserted here and in makeDisposition, never at generation`);
  }
  const force: Force = { untracedMin: 0, fatigue: 0, ...f, id: front.nextForceId++ };
  front.forces.push(force);
  return force;
}

// -- Graph helpers ---------------------------------------------------------

export function edgeById(t: Theater, id: number): TheaterEdge {
  const e = t.edges[id];
  if (!e || e.id !== id) {
    const found = t.edges.find((x) => x.id === id);
    if (!found) throw new Error(`edgeById: unknown edge ${id}`);
    return found;
  }
  return e;
}

export function otherEnd(e: TheaterEdge, nodeId: number): number {
  if (e.a === nodeId) return e.b;
  if (e.b === nodeId) return e.a;
  throw new Error(`otherEnd: node ${nodeId} is not an endpoint of edge ${e.id}`);
}

// Foot edges incident to a node, ascending edge id (deterministic).
export function incidentFoot(t: Theater, nodeId: number): TheaterEdge[] {
  return t.edges.filter((e) => e.moveClass !== 'rail' && (e.a === nodeId || e.b === nodeId)).sort((a, b) => a.id - b.id);
}

// Traversal minutes for a full edge, plus the crossing dwell its FAR node
// charges on entry (bridge defile is a queue, not a dwell — handled in step).
export function edgeMinutes(e: TheaterEdge): number {
  return e.lengthM / e.paceMpm;
}

interface RouteResult {
  edges: number[]; // edge ids in walk order
  minutes: number; // arrival minute mirror — dwell included
}

// Dijkstra from a node to a node over foot edges. Ford nodes charge
// FORD_CROSS_MIN on PASSING (entering and leaving through a ford), so a ford
// beats a detour longer than 45 road-minutes and loses to a bridge inside it.
export function route(t: Theater, from: number, to: number): RouteResult | null {
  const distMin = new Map<number, number>();
  const prevEdge = new Map<number, number>();
  const done = new Set<number>();
  distMin.set(from, 0);
  for (;;) {
    let cur = -1;
    let curD = Infinity;
    for (const [n, d] of distMin) {
      if (!done.has(n) && d < curD) {
        cur = n;
        curD = d;
      }
    }
    if (cur < 0) return null;
    if (cur === to) break;
    done.add(cur);
    for (const e of incidentFoot(t, cur)) {
      const nxt = otherEnd(e, cur);
      if (done.has(nxt)) continue;
      const nxtNode = t.nodes[nxt];
      // Passing THROUGH a crossing charges its dwell (ford 45, bridge 15) —
      // the SAME numbers step() spends, so the ETA mirror holds. Net ford
      // premium over a bridge is therefore 30 minutes; the doc's prose quotes
      // the raw 45, but mirror consistency wins over the prose figure.
      // Arriving AT a crossing as the destination charges nothing (ford
      // destinations are refused at the order layer anyway).
      const dwell =
        nxtNode.crossing && nxt !== to ? (nxtNode.crossing.kind === 'ford' ? FORD_CROSS_MIN : BRIDGE_DWELL_MIN) : 0;
      const cand = curD + edgeMinutes(e) + dwell;
      if (cand < (distMin.get(nxt) ?? Infinity)) {
        distMin.set(nxt, cand);
        prevEdge.set(nxt, e.id);
      }
    }
  }
  const edges: number[] = [];
  let walk = to;
  while (walk !== from) {
    const eid = prevEdge.get(walk);
    if (eid === undefined) return null;
    edges.unshift(eid);
    walk = otherEnd(edgeById(t, eid), walk);
  }
  return { edges, minutes: distMin.get(to)! };
}

// The node a force's position resolves to for routing: at a node, that node;
// mid-edge, the endpoint AHEAD of it on its direction of travel.
export function anchorNode(t: Theater, pos: NetPos): number {
  if (pos.kind === 'node') return pos.nodeId;
  const e = edgeById(t, pos.edgeId);
  return pos.dir === 1 ? e.b : e.a;
}

export type MoveReject =
  | 'unknown-force'
  | 'engaged'
  | 'queued-at-defile'
  | 'already-there'
  | 'no-route'
  | 'destination-unholdable';

export type MoveOrder = { ok: true; etaMin: number } | { ok: false; reason: MoveReject };

// §3.7: every arm maps to a visible flash string at the UI layer; silent
// returns die here.
export function orderMove(front: FrontV2, forceId: number, destNodeId: number): MoveOrder {
  const f = front.forces.find((x) => x.id === forceId);
  if (!f) return { ok: false, reason: 'unknown-force' };
  if (f.engagedIn !== null) return { ok: false, reason: 'engaged' };
  if (f.queuedAt !== null) return { ok: false, reason: 'queued-at-defile' };
  const dest = front.theater.nodes[destNodeId];
  if (!dest) return { ok: false, reason: 'no-route' };
  // Rivers are transit, never a destination (standing doctrine): PURE ford
  // nodes refuse. A town or village that carries ford metadata (a crossing
  // merged into a settlement) is dry ground and a legal destination — found
  // live: 'Gué-de-Ifs', a town objective the player could not order onto.
  if (dest.kind === 'ford') return { ok: false, reason: 'destination-unholdable' };
  if (f.pos.kind === 'node' && f.pos.nodeId === destNodeId) return { ok: false, reason: 'already-there' };

  const start = anchorNode(front.theater, f.pos);
  const r = route(front.theater, start, destNodeId);
  if (!r) return { ok: false, reason: 'no-route' };
  // Mid-edge: the remaining metres of the current edge precede the route.
  f.path = f.pos.kind === 'edge' ? [f.pos.edgeId, ...r.edges] : [...r.edges];
  // A force already mid-edge keeps its position; its first path entry is its
  // own edge, consumed as it reaches the anchor node.
  return { ok: true, etaMin: forceEtaMinutes(front, f, destNodeId) };
}

// ETA mirrors step() arithmetic EXACTLY (the chitEtaMinutes lockstep rule):
// remaining metres of the current edge at paceMpm, then each path edge, plus
// ford dwell at each passed ford, plus the force's own already-elapsed dwell.
export function forceEtaMinutes(front: FrontV2, f: Force, destNodeId: number): number {
  const t = front.theater;
  let min = 0;
  let at: number;
  if (f.pos.kind === 'edge') {
    const e = edgeById(t, f.pos.edgeId);
    const remain = f.pos.dir === 1 ? e.lengthM - f.pos.s : f.pos.s;
    min += remain / e.paceMpm;
    at = anchorNode(t, f.pos);
  } else {
    at = f.pos.nodeId;
  }
  const pathFrom = f.pos.kind === 'edge' ? f.path.slice(1) : f.path;
  for (const eid of pathFrom) {
    const e = edgeById(t, eid);
    const c = t.nodes[at].crossing;
    if (c) {
      const need = c.kind === 'ford' ? FORD_CROSS_MIN : BRIDGE_DWELL_MIN;
      min += Math.max(0, need - (at === anchorNode(t, f.pos) ? f.dwellMin : 0));
    }
    at = otherEnd(e, at);
    min += edgeMinutes(e);
  }
  // ETA is unopposed-march time: defile QUEUE waits are other forces'
  // behavior, not this force's arithmetic, and are deliberately excluded.
  if (at !== destNodeId && !(f.pos.kind === 'node' && f.pos.nodeId === destNodeId && pathFrom.length === 0)) {
    // The path must end at the destination — a mismatch is a routing bug.
    if (pathFrom.length > 0) throw new Error(`forceEtaMinutes: path ends at ${at}, not ${destNodeId}`);
  }
  return Math.ceil(min);
}
