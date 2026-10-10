// Force + Front V2 state + routing (S13, design doc §1/§3): the mutable war
// over an immutable Theater. Positions are metres on the network (NetPos);
// routing is Dijkstra over <= 60 nodes (linear scan is fine — 3.6k ops);
// forceEtaMinutes MIRRORS the step arithmetic exactly, the pinned
// chitEtaMinutes lockstep rule carried over.
import type { Side } from '../../sim/sim';
import type { NetPos, Theater, TheaterEdge } from '../theater';

export type ForceRole = 'line' | 'garrison' | 'reserve';
// How a force carries itself (jtbug #786). March, forced march and screen are
// ways of moving. Rest and dig in are ways of standing: a move order ends them.
export type Posture = 'march' | 'forced' | 'rest' | 'dig' | 'screen';

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
  // The edge this force last WALKED (set on arrival at a node). A contact at
  // a crossing node classifies bridge/ford-assault from the attacker's
  // approach; a force standing ON the node would otherwise have forgotten
  // which bank it came from.
  lastEdgeId: number | null;
  // The minute this force last LOST a battle and lived. The planner keeps it
  // off the attack while it reorganises (REORG_MIN). Player orders ignore it.
  repulsedAtMin: number | null;
  // Strength at muster. The counter's bar reads strength against it.
  establishment: number;
  // A garrison's post: the node it sorties from and comes back to. Null for
  // every other role.
  homeNode: number | null;
  posture: Posture;
  // Minutes spent digging in at this spot. The position is done at DIG_IN_MIN.
  dugMin: number;
}

// Creation shape: the realism fields default to fresh at the ONE chokepoint
// (addForce), so disposition and test literals never carry boilerplate zeros.
type ForceDefaulted = 'untracedMin' | 'fatigue' | 'lastEdgeId' | 'repulsedAtMin' | 'establishment' | 'homeNode' | 'posture' | 'dugMin';
export type ForceInit = Omit<Force, 'id' | ForceDefaulted> & Partial<Pick<Force, ForceDefaulted>>;

export const garrisonPost = (f: Pick<Force, 'role' | 'pos'>): number | null => (f.role === 'garrison' && f.pos.kind === 'node' ? f.pos.nodeId : null);

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
  kind: 'contact' | 'battle-resolved' | 'capture' | 'arrival' | 'retreat' | 'overrun' | 'stall' | 'replacements';
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
  moving: boolean; // seen on the march: pos.dir is then its heading
  dug: boolean; // seen dug in
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
  const force: Force = { untracedMin: 0, fatigue: 0, lastEdgeId: null, repulsedAtMin: null, establishment: f.strength, homeNode: garrisonPost(f), posture: 'march', dugMin: 0, ...f, id: front.nextForceId++ };
  front.forces.push(force);
  return force;
}

// A force lets go of the bridge defile: off the FIFO, no longer waiting.
export function leaveDefile(front: FrontV2, f: Force): void {
  f.queuedAt = null;
  for (const q of Object.values(front.defileQueues)) {
    const i = q.indexOf(f.id);
    if (i >= 0) q.splice(i, 1);
  }
}

// The ONE way a force stops marching: contact, battle join, retreat, crossing
// setback. Path and dwell clear AND the defile lets go. The force mid-crossing
// heads its queue with queuedAt null, so a dequeue keyed on queuedAt left it
// there and the bridge stayed shut for the rest of the war (jtbug #760).
export function standForce(front: FrontV2, f: Force): void {
  f.path = [];
  f.dwellMin = 0;
  leaveDefile(front, f);
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
  | 'not-moving'
  | 'no-route'
  | 'destination-unholdable';

export type MoveOrder = { ok: true; etaMin: number } | { ok: false; reason: MoveReject };

// orderMove and forceEtaMinutes live in step.ts beside the march kernel
// (S51/S52): the ETA is a SHADOW run of the same per-minute arithmetic the
// live step executes — a closed form here would lie across dusk and fatigue.

// The nodes a march from `pos` along `path` reaches, in order. Empty when it
// stands.
export function pathNodes(t: Theater, pos: NetPos, path: number[]): number[] {
  if (path.length === 0) return [];
  let at = anchorNode(t, pos);
  const out = pos.kind === 'edge' ? [at] : [];
  for (const eid of pos.kind === 'edge' ? path.slice(1) : path) out.push((at = otherEnd(edgeById(t, eid), at)));
  return out;
}

// Where a force's current path ends, or null when it stands.
export function pathDestination(t: Theater, f: Force): number | null {
  return pathNodes(t, f.pos, f.path).at(-1) ?? null;
}
