// Contact detection (S14, §3.2): graphGap(a, b) returns metres when two
// positions are CO-LOCATED on the graph — same edge, same node, an edge and
// an incident node, or two edges sharing a node — else Infinity. Forces on
// parallel non-incident roads never fight: the negative the old grid could
// not express. Contact fires at graphGap <= CONTACT_M over FINAL positions
// each minute, pairing deterministic lower-id-first.
import { CONTACT_M, edgeById, pushEvent, type Force, type FrontV2, type TheaterEvent } from './force';
import type { NetPos, Theater } from '../theater';

// Distance from a position to a NODE along its own edge (or 0/∞ at nodes).
function toNode(t: Theater, pos: NetPos, nodeId: number): number {
  if (pos.kind === 'node') return pos.nodeId === nodeId ? 0 : Infinity;
  const e = edgeById(t, pos.edgeId);
  if (e.a === nodeId) return pos.s;
  if (e.b === nodeId) return e.lengthM - pos.s;
  return Infinity;
}

export function graphGap(t: Theater, a: NetPos, b: NetPos): number {
  if (a.kind === 'node' && b.kind === 'node') {
    return a.nodeId === b.nodeId ? 0 : Infinity;
  }
  if (a.kind === 'edge' && b.kind === 'edge' && a.edgeId === b.edgeId) {
    return Math.abs(a.s - b.s);
  }
  if (a.kind === 'node') return toNode(t, b, a.nodeId);
  if (b.kind === 'node') return toNode(t, a, b.nodeId);
  // Two different edges: co-located only through a SHARED endpoint.
  const ea = edgeById(t, a.edgeId);
  const eb = edgeById(t, b.edgeId);
  let best = Infinity;
  for (const n of [ea.a, ea.b]) {
    if (n === eb.a || n === eb.b) best = Math.min(best, toNode(t, a, n) + toNode(t, b, n));
  }
  return best;
}

export interface Contact {
  attackerId: number;
  defenderId: number;
  site: NetPos;
  gapM: number;
}

// The engagement site: the defender's position — mid-edge fights happen
// where the defender stands, node fights at the node (§3.2/§6). The MOVING
// force is the attacker; two movers meeting head-on attack the lower id
// (deterministic). Two static forces in gap (post-retreat placement) attack
// by the newer arrival — approximated as the higher id, still deterministic.
function orient(a: Force, b: Force): { attacker: Force; defender: Force } {
  const aMoving = a.path.length > 0;
  const bMoving = b.path.length > 0;
  if (aMoving && !bMoving) return { attacker: a, defender: b };
  if (!aMoving && bMoving) return { attacker: b, defender: a };
  if (aMoving && bMoving) return a.id < b.id ? { attacker: a, defender: b } : { attacker: b, defender: a };
  return a.id > b.id ? { attacker: a, defender: b } : { attacker: b, defender: a };
}

// Detect new contacts over final positions. Already-engaged forces are
// skipped (§3.4 pins them); each force joins at most one NEW contact per
// minute, lower-id pairs first.
export function detectContacts(front: FrontV2): Contact[] {
  const out: Contact[] = [];
  const taken = new Set<number>();
  const live = front.forces.filter((f) => f.strength > 0 && f.engagedIn === null).sort((a, b) => a.id - b.id);
  for (let i = 0; i < live.length; i++) {
    if (taken.has(live[i].id)) continue;
    for (let j = i + 1; j < live.length; j++) {
      if (taken.has(live[j].id)) continue;
      const a = live[i];
      const b = live[j];
      if (a.side === b.side) continue;
      const gap = graphGap(front.theater, a.pos, b.pos);
      if (gap > CONTACT_M) continue;
      const { attacker, defender } = orient(a, b);
      out.push({ attackerId: attacker.id, defenderId: defender.id, site: defender.pos, gapM: gap });
      taken.add(a.id);
      taken.add(b.id);
      const ev: TheaterEvent = {
        min: front.clockMin,
        kind: 'contact',
        text: `${attacker.name} contacts ${defender.name}`,
        forceIds: [attacker.id, defender.id],
        nodeId: defender.pos.kind === 'node' ? defender.pos.nodeId : undefined,
      };
      pushEvent(front, ev);
      break;
    }
  }
  return out;
}

// Halt an attacker at contact range on its approach: movement stops, the
// battle machinery (S16) owns what happens next.
export function haltAtContact(front: FrontV2, c: Contact): void {
  for (const id of [c.attackerId, c.defenderId]) {
    const f = front.forces.find((x) => x.id === id)!;
    f.path = [];
    f.dwellMin = 0;
    if (f.queuedAt !== null) {
      const q = front.defileQueues[f.queuedAt] ?? [];
      const i = q.indexOf(f.id);
      if (i >= 0) q.splice(i, 1);
      f.queuedAt = null;
    }
  }
}

export { CONTACT_M };
