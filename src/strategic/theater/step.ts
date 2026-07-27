// Movement step (S13, §3.1/3.3/3.5): one strategic minute of continuous
// motion. Time-budgeted, not distance-budgeted — a force gets 1.0 minutes and
// spends them on edge metres (pace), ford dwell, or bridge defile, with
// fractional carry across boundaries so forceEtaMinutes mirrors this
// arithmetic EXACTLY. Forces advance in ascending id whatever the array
// order (the order-independence gate); friendlies stack freely (§3.5) — the
// one defile is the bridge, capacity 1, FIFO.
import type { Side } from '../../sim/sim';
import {
  BRIDGE_DWELL_MIN,
  edgeById,
  FORD_CROSS_MIN,
  otherEnd,
  pushEvent,
  type Force,
  type FrontV2,
  type TheaterEvent,
} from './force';

// Is any live enemy force standing at this node?
function enemyAt(front: FrontV2, nodeId: number, side: Side): boolean {
  return front.forces.some(
    (f) => f.side !== side && f.strength > 0 && f.pos.kind === 'node' && f.pos.nodeId === nodeId,
  );
}

function paintCapture(front: FrontV2, f: Force, nodeId: number): void {
  if (front.controlByNode[nodeId] !== f.side && !enemyAt(front, nodeId, f.side)) {
    front.controlByNode[nodeId] = f.side; // entry-paint, unconditional (OQ11)
    pushEvent(front, {
      min: front.clockMin,
      kind: 'capture',
      text: `${f.name} takes ${front.theater.nodes[nodeId].name}`,
      forceIds: [f.id],
      nodeId,
    });
  }
}

// The crossing dwell a node charges a force that intends to CONTINUE through
// it. A destination charges nothing (and ford destinations are refused at
// the order layer anyway).
function crossingDwell(front: FrontV2, nodeId: number, continuing: boolean): number {
  if (!continuing) return 0;
  const c = front.theater.nodes[nodeId].crossing;
  if (!c) return 0;
  return c.kind === 'ford' ? FORD_CROSS_MIN : BRIDGE_DWELL_MIN;
}

// Bridge defile: capacity 1. True if this force may occupy the crossing now.
function defileFree(front: FrontV2, nodeId: number, forceId: number): boolean {
  const queue = front.defileQueues[nodeId] ?? [];
  const occupied = front.forces.some(
    (g) => g.id !== forceId && g.pos.kind === 'node' && g.pos.nodeId === nodeId && g.dwellMin > 0 && g.path.length > 0,
  );
  return !occupied && (queue.length === 0 || queue[0] === forceId);
}

// Advance one force by `budget` minutes. Mutates pos/path/dwell; returns
// events. Recursion depth is bounded by path length per minute.
function advanceForce(front: FrontV2, f: Force, budget: number, out: TheaterEvent[]): void {
  if (budget <= 1e-9 || f.engagedIn !== null) return;

  if (f.pos.kind === 'node') {
    const nodeId = f.pos.nodeId;
    const node = front.theater.nodes[nodeId];
    if (f.path.length === 0) {
      f.dwellMin = 0;
      return; // at rest
    }
    const dwellNeed = crossingDwell(front, nodeId, true);
    if (dwellNeed > 0 && f.dwellMin < dwellNeed) {
      // Bridge defile gates entry to the dwell; fords are open water — no
      // capacity, only time.
      if (node.crossing!.kind === 'bridge') {
        const q = (front.defileQueues[nodeId] ??= []);
        if (!q.includes(f.id)) q.push(f.id);
        if (!defileFree(front, nodeId, f.id)) {
          f.queuedAt = nodeId;
          return; // waiting at the defile — budget forfeits (a queue is a queue)
        }
        f.queuedAt = null;
      }
      const spend = Math.min(budget, dwellNeed - f.dwellMin);
      f.dwellMin += spend;
      budget -= spend;
      if (f.dwellMin < dwellNeed - 1e-9 || budget <= 1e-9) return;
    }
    // Dwell (if any) complete: release the defile slot and step onto the edge.
    if (node.crossing?.kind === 'bridge') {
      const q = front.defileQueues[nodeId] ?? [];
      const i = q.indexOf(f.id);
      if (i >= 0) q.splice(i, 1);
    }
    f.dwellMin = 0;
    const e = edgeById(front.theater, f.path[0]);
    const dir: 1 | -1 = e.a === nodeId ? 1 : -1;
    f.pos = { kind: 'edge', edgeId: e.id, s: dir === 1 ? 0 : e.lengthM, dir };
    advanceForce(front, f, budget, out);
    return;
  }

  // Mid-edge: spend budget as metres.
  const e = edgeById(front.theater, f.pos.edgeId);
  const remainM = f.pos.dir === 1 ? e.lengthM - f.pos.s : f.pos.s;
  const stepM = Math.min(remainM, budget * e.paceMpm);
  const newS = f.pos.s + f.pos.dir * stepM;
  const spent = stepM / e.paceMpm;
  f.pos = { ...f.pos, s: newS };
  if (stepM < remainM - 1e-6) return; // still travelling

  // Edge end reached: arrive at the far node.
  const arriveId = f.pos.dir === 1 ? e.b : e.a;
  f.pos = { kind: 'node', nodeId: arriveId };
  if (f.path[0] === e.id) f.path.shift();
  paintCapture(front, f, arriveId);
  if (f.path.length === 0) {
    const ev: TheaterEvent = {
      min: front.clockMin,
      kind: 'arrival',
      text: `${f.name} arrives at ${front.theater.nodes[arriveId].name}`,
      forceIds: [f.id],
      nodeId: arriveId,
    };
    pushEvent(front, ev); // the ring is the record; the return is the frame's delta
    out.push(ev);
    f.dwellMin = 0;
    return;
  }
  advanceForce(front, f, budget - spent, out);
}

// One strategic minute of movement for every unengaged force, ascending id.
export function stepMovement(front: FrontV2): TheaterEvent[] {
  const out: TheaterEvent[] = [];
  const byId = [...front.forces].sort((a, b) => a.id - b.id);
  for (const f of byId) {
    if (f.strength <= 0) continue;
    advanceForce(front, f, 1, out);
  }
  return out;
}
