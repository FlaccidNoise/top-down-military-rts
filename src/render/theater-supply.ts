// Where the player's supply is cut (jtbug #782). RENDER ONLY: it reads the
// strategic layer's own trace and changes nothing. The trace says WHICH
// companies are cut off; this says WHERE, so the map can mark the place the
// player has to deal with.
//
// For each company the trace does not reach: take the shortest road route
// from the nearest depot and walk it from the depot. The first thing the
// trace could not pass is the cut: an enemy-held node, or a road with an
// enemy force standing on it. (Every route is blocked, or the company would
// be traced. The shortest one names the block the player most likely means
// to clear.)
import type { NetPos } from '../strategic/theater';
import { otherEnd, route, type FrontV2 } from '../strategic/theater/force';
import { forceSupplied, traceSupply } from '../strategic/theater/supply';

export function supplyCuts(front: FrontV2): NetPos[] {
  const t = front.theater;
  const { traced, interdicted } = traceSupply(front, 'blue');
  const cuts = new Map<string, NetPos>();
  for (const f of front.forces) {
    if (f.side !== 'blue' || f.strength <= 0 || forceSupplied(front, f, traced)) continue;
    const at = f.pos.kind === 'node' ? f.pos.nodeId : t.edges[f.pos.edgeId].a;
    let best: { from: number; edges: number[]; minutes: number } | null = null;
    for (const s of t.sources.blue) {
      const r = route(t, s, at);
      if (r && (!best || r.minutes < best.minutes)) best = { from: s, edges: r.edges, minutes: r.minutes };
    }
    if (!best) continue;
    let n = best.from;
    let cut: NetPos | null = front.controlByNode[n] === 'red' ? { kind: 'node', nodeId: n } : null;
    for (const eid of best.edges) {
      if (cut) break;
      if (interdicted.has(eid)) {
        const on = front.forces.filter((g) => g.side === 'red' && g.strength > 0 && g.pos.kind === 'edge' && g.pos.edgeId === eid).sort((a, b) => a.id - b.id)[0];
        cut = on.pos;
        break;
      }
      n = otherEnd(t.edges[eid], n);
      if (front.controlByNode[n] === 'red') cut = { kind: 'node', nodeId: n };
    }
    if (cut) cuts.set(cut.kind === 'node' ? `n${cut.nodeId}` : `e${cut.edgeId}`, cut);
  }
  return [...cuts.values()];
}
