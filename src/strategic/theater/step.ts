// Movement step (S13, §3.1/3.3/3.5) + the march kernel (S51/S52): one
// strategic minute of continuous motion. Time-budgeted, not distance-
// budgeted — a force gets 1.0 minutes and spends them on edge metres (pace x
// the per-minute multiplier), ford dwell, or bridge defile, with fractional
// carry across boundaries. forceEtaMinutes runs a SHADOW copy of a force
// through the SAME advance arithmetic minute by minute — the only mirror
// that stays exact once fatigue and light make speed time-varying. Forces
// advance in ascending id whatever the array order; friendlies stack freely
// (§3.5) — the one defile is the bridge, capacity 1, FIFO.
import type { Side } from '../../sim/sim';
import { lightAt } from '../../sim/solar';
import {
  BRIDGE_DWELL_MIN,
  edgeById,
  FORD_CROSS_MIN,
  otherEnd,
  pushEvent,
  route,
  anchorNode,
  type Force,
  type FrontV2,
  type MoveOrder,
  type TheaterEvent,
} from './force';
import { supplyTierOf } from './supply';

// -- March kernel constants (S51 fatigue / S52 night tempo) ----------------
export const FATIGUE_SPEED_SLOPE = 0.35; // speed x (1 - 0.35 x fatigue)
export const MARCH_FATIGUE_MIN = 1080; // 18 h of marching = fatigue 1.0
export const NIGHT_MARCH_FATIGUE_MULT = 1.5; // marching in the dark wears harder
export const REST_RECOVER_MIN = 600; // 10 h stationary = full recovery
export const BILLET_RECOVER_MULT = 2; // roofed, friendly, fed: twice the rest
export const NIGHT_LIGHT_FLOOR = 0.25; // the lightAt threshold every night rule keys on
export const FATIGUE_STAMINA_SLOPE = 0.5; // staging: stamina cap 1 - 0.5 x fatigue

export interface MoveKernelOpts {
  nightTempo?: boolean; // S52: CampaignConfig.nightTempo gates the pace ramp
}

// §5(e): movement ramp 0.7 + 0.3·min(1, light/0.25) — full darkness costs
// 30% of pace; at OP_START twilight (light 0.419) it is exactly 1.0.
export function nightRamp(clockMin: number): number {
  return 0.7 + 0.3 * Math.min(1, lightAt(clockMin) / NIGHT_LIGHT_FLOOR);
}

// The per-minute pace multiplier — ONE function read by the live step and
// the ETA shadow, so they cannot disagree.
export function paceMult(fatigue: number, clockMin: number, opts: MoveKernelOpts): number {
  const fat = 1 - FATIGUE_SPEED_SLOPE * fatigue;
  return opts.nightTempo ? fat * nightRamp(clockMin) : fat;
}

// A friendly, in-supply settlement node is a billet: recovery runs double.
function billeted(front: FrontV2, f: Force): boolean {
  if (f.pos.kind !== 'node') return false;
  const n = front.theater.nodes[f.pos.nodeId];
  return (
    (n.kind === 'town' || n.kind === 'village') &&
    front.controlByNode[n.id] === f.side &&
    supplyTierOf(f.untracedMin) === 'full'
  );
}

// One minute of fatigue for one force (S51). Marching accrues (x1.5 in the
// dark — the accrual is physiology, not doctrine, so it ignores the
// nightTempo toggle); resting recovers (x2 billeted); an engaged force
// holds — combat fatigue lands as a lump at resolution.
export function fatigueMinute(front: FrontV2, f: Force, clockMin = front.clockMin): void {
  if (f.engagedIn !== null) return;
  if (f.path.length > 0) {
    const mult = lightAt(clockMin) < NIGHT_LIGHT_FLOOR ? NIGHT_MARCH_FATIGUE_MULT : 1;
    f.fatigue = Math.min(1, f.fatigue + mult / MARCH_FATIGUE_MIN);
  } else {
    f.fatigue = Math.max(0, f.fatigue - (billeted(front, f) ? BILLET_RECOVER_MULT : 1) / REST_RECOVER_MIN);
  }
}

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

// Advance one force by `budget` minutes at `mult` x pace. Mutates
// pos/path/dwell; returns events. `shadow` runs the identical arithmetic
// with ZERO side effects — no capture paint, no events, no defile queue (ETA
// excludes queue waits by contract: other forces' behaviour, not this
// force's arithmetic). Recursion depth is bounded by path length per minute.
function advanceForce(front: FrontV2, f: Force, budget: number, out: TheaterEvent[], mult = 1, shadow = false): void {
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
      if (!shadow && node.crossing!.kind === 'bridge') {
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
    if (!shadow && node.crossing?.kind === 'bridge') {
      const q = front.defileQueues[nodeId] ?? [];
      const i = q.indexOf(f.id);
      if (i >= 0) q.splice(i, 1);
    }
    f.dwellMin = 0;
    const e = edgeById(front.theater, f.path[0]);
    const dir: 1 | -1 = e.a === nodeId ? 1 : -1;
    f.pos = { kind: 'edge', edgeId: e.id, s: dir === 1 ? 0 : e.lengthM, dir };
    advanceForce(front, f, budget, out, mult, shadow);
    return;
  }

  // Mid-edge with NO path = parked (a halted defender, a retreat setback):
  // it stands, it never drifts to the edge end. Movement requires a path.
  if (f.path.length === 0) return;

  // Mid-edge: spend budget as metres at the minute's effective pace.
  const e = edgeById(front.theater, f.pos.edgeId);
  const pace = e.paceMpm * mult;
  const remainM = f.pos.dir === 1 ? e.lengthM - f.pos.s : f.pos.s;
  const stepM = Math.min(remainM, budget * pace);
  const newS = f.pos.s + f.pos.dir * stepM;
  const spent = stepM / pace;
  f.pos = { ...f.pos, s: newS };
  if (stepM < remainM - 1e-6) return; // still travelling

  // Edge end reached: arrive at the far node.
  const arriveId = f.pos.dir === 1 ? e.b : e.a;
  f.pos = { kind: 'node', nodeId: arriveId };
  if (f.path[0] === e.id) f.path.shift();
  if (!shadow) paintCapture(front, f, arriveId);
  if (f.path.length === 0) {
    if (!shadow) {
      const ev: TheaterEvent = {
        min: front.clockMin,
        kind: 'arrival',
        text: `${f.name} arrives at ${front.theater.nodes[arriveId].name}`,
        forceIds: [f.id],
        nodeId: arriveId,
      };
      pushEvent(front, ev); // the ring is the record; the return is the frame's delta
      out.push(ev);
    }
    f.dwellMin = 0;
    return;
  }
  advanceForce(front, f, budget - spent, out, mult, shadow);
}

// One strategic minute for every force, ascending id: fatigue first (the
// minute's pace reads the minute's fatigue), then movement.
export function stepMovement(front: FrontV2, opts: MoveKernelOpts = {}): TheaterEvent[] {
  const out: TheaterEvent[] = [];
  const byId = [...front.forces].sort((a, b) => a.id - b.id);
  for (const f of byId) {
    if (f.strength <= 0) continue;
    fatigueMinute(front, f);
    advanceForce(front, f, 1, out, paceMult(f.fatigue, front.clockMin, opts));
  }
  return out;
}

// ETA mirror (S13 rule, S51/S52 form): a SHADOW copy of the force marches
// the same per-minute arithmetic the live step runs — fatigue accrues,
// light ramps, dwell charges — so predicted === simulated to the minute
// across dusk and exhaustion. Queue waits excluded by contract.
export function forceEtaMinutes(front: FrontV2, f: Force, destNodeId: number, opts: MoveKernelOpts = {}): number {
  if (f.pos.kind === 'node' && f.pos.nodeId === destNodeId && f.path.length === 0) return 0;
  const clone: Force = { ...f, pos: { ...f.pos }, path: [...f.path] };
  const cap = 43200; // 30 days of marching means the route is wrong
  for (let min = 1; min <= cap; min++) {
    const clock = front.clockMin + min;
    fatigueMinute(front, clone, clock);
    advanceForce(front, clone, 1, [], paceMult(clone.fatigue, clock, opts), true);
    if (clone.path.length === 0 && clone.pos.kind === 'node' && clone.pos.nodeId === destNodeId) return min;
  }
  return cap;
}

// §3.7: every arm maps to a visible flash string at the UI layer; silent
// returns die here. Lives beside the kernel because the returned ETA runs
// the shadow march.
export function orderMove(front: FrontV2, forceId: number, destNodeId: number, opts: MoveKernelOpts = {}): MoveOrder {
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
  return { ok: true, etaMin: forceEtaMinutes(front, f, destNodeId, opts) };
}
