// T_ROADS (42) + T_CROSSINGS (43) + T_RAIL (44), S8: settlement sites become
// the node/edge graph. Topology: MST over towns ('road'), the farthest town
// pair's path upgraded to 'highway', villages joined by 'track' at the
// nearest point of the existing network (mid-edge joins mint 'junction'
// nodes). Every road-river intersection mints a crossing node — or, within
// MERGE_M of an existing node, attaches crossing metadata to that node (a
// bridge town), which is also what keeps MIN_EDGE_M true near river towns.
// Rail is geometry only (OQ9): one line with 1-2 halts, each halt spurred to
// the foot network by a station track.
//
// Draw discipline (D2): ROADS stream jitters polylines and picks topology
// extras; CROSSINGS stream draws main-river crossing kinds in downstream
// order (geometry-keyed, never array-index); RAIL stream places the line.
// Rail runs BEFORE the crossroads/crossings passes so its foot-class station
// spurs get junction and crossing coverage — stage streams are independent,
// so execution order is free to serve geometry.
// regionId stays -1 and names stay '' — later stages own them. paceMpm is
// the bare MOVE_MPM base here; makeTheater bakes the region mult (S11).
import type { River, TheaterEdge, TheaterNode, Vec } from '../theater';
import { MOVE_MPM } from '../theater';
import type { Rng } from '../../sim/rng';
import { stageStream, T_TAG } from './streams';
import type { SettlementPlan } from './settlements';

export const MIN_EDGE_M = 1200;
const MERGE_M = 1200; // a crossing this close to a node merges into it
const JITTER_STEP_M = 1000;
const JITTER_M = 150;
const RAIL_HALTS: [number, number] = [1, 2];
const HALT_OFFSET_M: [number, number] = [1300, 2200]; // spur >= MIN_EDGE_M by construction

export interface NetworkPlan {
  nodes: TheaterNode[];
  edges: TheaterEdge[];
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

const polylineLen = (pts: Vec[]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
};

// A wandering road between two points: straight line subdivided every
// ~JITTER_STEP_M with bounded lateral jitter, endpoints exact.
function jitteredPolyline(rng: Rng, a: Vec, b: Vec): Vec[] {
  const d = dist(a, b);
  const steps = Math.max(1, Math.round(d / JITTER_STEP_M));
  const nx = -(b.y - a.y) / d; // unit normal
  const ny = (b.x - a.x) / d;
  const pts: Vec[] = [{ x: a.x, y: a.y }];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const j = rng.range(-JITTER_M, JITTER_M);
    pts.push({ x: Math.round(a.x + (b.x - a.x) * t + nx * j), y: Math.round(a.y + (b.y - a.y) * t + ny * j) });
  }
  pts.push({ x: b.x, y: b.y });
  return pts;
}

function segIntersect(p1: Vec, p2: Vec, p3: Vec, p4: Vec): Vec | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: Math.round(p1.x + d1x * t), y: Math.round(p1.y + d1y * t) };
}

// Nearest point on a polyline: returns the vertex index it precedes and the
// projected point. Used for village joins.
function nearestOnPolyline(pts: Vec[], p: Vec): { at: Vec; segIdx: number; d: number } {
  let best = { at: pts[0], segIdx: 0, d: dist(pts[0], p) };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const at = { x: Math.round(a.x + dx * t), y: Math.round(a.y + dy * t) };
    const d = dist(at, p);
    if (d < best.d) best = { at, segIdx: i - 1, d };
  }
  return best;
}

interface Builder {
  nodes: TheaterNode[];
  edges: TheaterEdge[];
  nextEdgeId: number;
  boundsM: { w: number; h: number };
}

const NODE_MARGIN_M = 400; // no node on the exact frame

function mintNode(b: Builder, pos: Vec, kind: TheaterNode['kind']): TheaterNode {
  // Universal clamp: an off-map node (a rail halt offset past the frame,
  // seed 81) breaks region assignment downstream. In-bounds geometry is
  // untouched, so existing pins hold.
  const n: TheaterNode = {
    id: b.nodes.length,
    pos: {
      x: Math.max(NODE_MARGIN_M, Math.min(b.boundsM.w - NODE_MARGIN_M, Math.round(pos.x))),
      y: Math.max(NODE_MARGIN_M, Math.min(b.boundsM.h - NODE_MARGIN_M, Math.round(pos.y))),
    },
    kind,
    name: '',
    regionId: -1,
    crossing: null,
    rank: kind === 'town' ? 0 : kind === 'village' ? 1 : 2,
  };
  b.nodes.push(n);
  return n;
}

function mintEdge(b: Builder, a: number, z: number, moveClass: TheaterEdge['moveClass'], polyline: Vec[]): TheaterEdge {
  const e: TheaterEdge = {
    id: b.nextEdgeId++,
    a,
    b: z,
    kind: moveClass === 'rail' ? 'rail' : 'road',
    moveClass,
    polyline,
    lengthM: Math.round(polylineLen(polyline)),
    paceMpm: moveClass === 'rail' ? 0 : MOVE_MPM[moveClass],
    rank: moveClass === 'highway' ? 0 : moveClass === 'road' ? 1 : 2,
  };
  b.edges.push(e);
  return e;
}

// Split an edge at a point known to sit on (or within rounding of) its
// polyline vertex chain index, minting nothing — the caller owns the node.
function splitEdge(b: Builder, edge: TheaterEdge, segIdx: number, at: Vec, nodeId: number): void {
  const head = edge.polyline.slice(0, segIdx + 1).concat([at]);
  const tail = [at].concat(edge.polyline.slice(segIdx + 1));
  const origB = edge.b;
  edge.b = nodeId;
  edge.polyline = head;
  edge.lengthM = Math.round(polylineLen(head));
  mintEdge(b, nodeId, origB, edge.moveClass, tail);
}

export function planNetwork(
  base: number,
  cfg: { roadDensity: number; railDensity: number },
  boundsM: { w: number; h: number },
  rivers: River[],
  settlements: SettlementPlan,
): NetworkPlan {
  const roadRng = stageStream(base, T_TAG.ROADS);
  const b: Builder = { nodes: [], edges: [], nextEdgeId: 0, boundsM };

  const townNodes = settlements.towns.map((p) => mintNode(b, p, 'town'));
  const villageNodes = settlements.villages.map((p) => mintNode(b, p, 'village'));

  // -- T_ROADS: MST over towns (Prim, deterministic lowest-id tie-break) --
  const inTree = new Set<number>([townNodes[0].id]);
  const links: [number, number][] = [];
  while (inTree.size < townNodes.length) {
    let best: [number, number, number] = [-1, -1, Infinity];
    for (const t of townNodes) {
      if (!inTree.has(t.id)) continue;
      for (const u of townNodes) {
        if (inTree.has(u.id)) continue;
        const d = dist(t.pos, u.pos);
        if (d < best[2]) best = [t.id, u.id, d];
      }
    }
    inTree.add(best[1]);
    links.push([best[0], best[1]]);
  }
  // Extra town-town links per roadDensity beyond 2 close the network into
  // cycles (mean-degree band): link the closest unlinked pair, repeatedly.
  const extra = Math.max(0, cfg.roadDensity);
  for (let i = 0; i < extra; i++) {
    const linked = new Set(links.map(([x, y]) => `${Math.min(x, y)}:${Math.max(x, y)}`));
    let best: [number, number, number] = [-1, -1, Infinity];
    for (const t of townNodes) {
      for (const u of townNodes) {
        if (u.id <= t.id) continue;
        if (linked.has(`${t.id}:${u.id}`)) continue;
        const d = dist(t.pos, u.pos);
        if (d < best[2]) best = [t.id, u.id, d];
      }
    }
    if (best[0] < 0) break;
    links.push([best[0], best[1]]);
  }

  // Highway: the MST path between the farthest town pair, upgraded.
  let far: [number, number, number] = [townNodes[0].id, townNodes[0].id, -1];
  for (const t of townNodes) {
    for (const u of townNodes) {
      const d = dist(t.pos, u.pos);
      if (d > far[2]) far = [t.id, u.id, d];
    }
  }
  const adj = new Map<number, number[]>();
  for (const [x, y] of links) {
    adj.set(x, [...(adj.get(x) ?? []), y]);
    adj.set(y, [...(adj.get(y) ?? []), x]);
  }
  const highwayPair = new Set<string>();
  const walk = (from: number, to: number, seen: Set<number>, trail: number[]): number[] | null => {
    if (from === to) return trail;
    seen.add(from);
    for (const nx of (adj.get(from) ?? []).slice().sort((p, q) => p - q)) {
      if (seen.has(nx)) continue;
      const r = walk(nx, to, seen, [...trail, nx]);
      if (r) return r;
    }
    return null;
  };
  const path = walk(far[0], far[1], new Set(), [far[0]]) ?? [];
  for (let i = 1; i < path.length; i++) highwayPair.add(`${Math.min(path[i - 1], path[i])}:${Math.max(path[i - 1], path[i])}`);

  for (const [x, y] of links) {
    const cls = highwayPair.has(`${Math.min(x, y)}:${Math.max(x, y)}`) ? 'highway' : 'road';
    mintEdge(b, x, y, cls, jitteredPolyline(roadRng, b.nodes[x].pos, b.nodes[y].pos));
  }

  // Villages join the nearest point of the network: at a node when close to
  // one, else mid-edge, minting a junction. Joins under MIN_EDGE_M are left
  // for validation ('disconnected') rather than silently bent.
  for (const v of villageNodes) {
    let bestNode: TheaterNode | null = null;
    for (const n of b.nodes) {
      if (n.id === v.id || n.kind === 'village') continue;
      if (!bestNode || dist(n.pos, v.pos) < dist(bestNode.pos, v.pos)) bestNode = n;
    }
    let bestEdge: { e: TheaterEdge; at: Vec; segIdx: number; d: number } | null = null;
    for (const e of b.edges) {
      if (e.moveClass === 'rail') continue;
      const hit = nearestOnPolyline(e.polyline, v.pos);
      if (!bestEdge || hit.d < bestEdge.d) bestEdge = { e, ...hit };
    }
    const endpointsClear =
      bestEdge !== null &&
      dist(bestEdge.at, b.nodes[bestEdge.e.a].pos) > MIN_EDGE_M &&
      dist(bestEdge.at, b.nodes[bestEdge.e.b].pos) > MIN_EDGE_M;
    if (bestEdge && bestEdge.d < MIN_EDGE_M && endpointsClear) {
      // A village hard against a road IS a through-village: bend the road
      // through it — split at the near point, re-anchor both halves on the
      // village node. No spur, no short edge.
      splitEdge(b, bestEdge.e, bestEdge.segIdx, v.pos, v.id);
    } else if (bestEdge && bestEdge.d < (bestNode ? dist(bestNode.pos, v.pos) : Infinity) && endpointsClear) {
      const j = mintNode(b, bestEdge.at, 'junction');
      splitEdge(b, bestEdge.e, bestEdge.segIdx, j.pos, j.id);
      mintEdge(b, v.id, j.id, 'track', jitteredPolyline(roadRng, v.pos, j.pos));
    } else {
      // Fallback node link — at range, like every other spur: a village too
      // close to the network for a legal lane takes the nearest node that IS
      // band-legal, never a short stub.
      let atRange: TheaterNode | null = null;
      for (const n of b.nodes) {
        if (n.id === v.id || n.kind === 'village') continue;
        if (dist(n.pos, v.pos) < MIN_EDGE_M) continue;
        if (!atRange || dist(n.pos, v.pos) < dist(atRange.pos, v.pos)) atRange = n;
      }
      if (atRange) mintEdge(b, v.id, atRange.id, 'track', jitteredPolyline(roadRng, v.pos, atRange.pos));
    }
  }

  // Village lanes: each village also links its nearest peer when the lane
  // is band-legal — the local-cycle layer (mean degree 2.6-3.2 is a cycled
  // web, not a tree).
  const laned = new Set<string>();
  for (const v of villageNodes) {
    const peers = villageNodes
      .filter((u) => u.id !== v.id)
      .sort((p, q) => dist(p.pos, v.pos) - dist(q.pos, v.pos) || p.id - q.id)
      .slice(0, 2);
    for (const peer of peers) {
      const key = `${Math.min(v.id, peer.id)}:${Math.max(v.id, peer.id)}`;
      const d = dist(v.pos, peer.pos);
      if (laned.has(key) || d < MIN_EDGE_M || d > 4500) continue;
      laned.add(key);
      mintEdge(b, v.id, peer.id, 'track', jitteredPolyline(roadRng, v.pos, peer.pos));
    }
  }

  // -- T_RAIL (OQ9: geometry + halts only, no movement) --
  if (cfg.railDensity > 0 && townNodes.length >= 2) {
    const railRng = stageStream(base, T_TAG.RAIL);
    const A = b.nodes[far[0]].pos;
    const Z = b.nodes[far[1]].pos;
    const haltCount = RAIL_HALTS[0] + (cfg.railDensity > 1 ? railRng.int(RAIL_HALTS[1]) : 0);
    // The line offsets from the highway corridor; halts sit on it and spur to
    // the nearest foot node by a station track (>= MIN_EDGE_M by placement).
    const off = railRng.range(HALT_OFFSET_M[0], HALT_OFFSET_M[1]) * (railRng.next() < 0.5 ? -1 : 1);
    const d = dist(A, Z);
    const nx = (-(Z.y - A.y) / d) * off;
    const ny = ((Z.x - A.x) / d) * off;
    const rA = mintNode(b, { x: A.x + nx, y: A.y + ny }, 'halt');
    let prev = rA;
    for (let i = 0; i < haltCount; i++) {
      const t = (i + 1) / (haltCount + 1);
      const at = { x: Math.round(A.x + (Z.x - A.x) * t + nx), y: Math.round(A.y + (Z.y - A.y) * t + ny) };
      const halt = mintNode(b, at, 'halt');
      mintEdge(b, prev.id, halt.id, 'rail', jitteredPolyline(railRng, prev.pos, halt.pos));
      let nearest: TheaterNode | null = null;
      for (const n of b.nodes) {
        if (n.kind === 'halt' || n.kind === 'junction') continue;
        if (dist(n.pos, halt.pos) < MIN_EDGE_M) continue; // spur must be band-legal
        if (!nearest || dist(n.pos, halt.pos) < dist(nearest.pos, halt.pos)) nearest = n;
      }
      if (nearest) mintEdge(b, halt.id, nearest.id, 'track', jitteredPolyline(railRng, halt.pos, nearest.pos));
      prev = halt;
    }
    const rZ = mintNode(b, { x: Z.x + nx, y: Z.y + ny }, 'halt');
    mintEdge(b, prev.id, rZ.id, 'rail', jitteredPolyline(railRng, prev.pos, rZ.pos));
    for (const term of [rA, rZ]) {
      let nearest: TheaterNode | null = null;
      for (const n of b.nodes) {
        if (n.kind === 'halt' || n.kind === 'junction') continue;
        if (dist(n.pos, term.pos) < MIN_EDGE_M) continue;
        if (!nearest || dist(n.pos, term.pos) < dist(nearest.pos, term.pos)) nearest = n;
      }
      if (nearest) mintEdge(b, term.id, nearest.id, 'track', jitteredPolyline(railRng, term.pos, nearest.pos));
    }
  }

  // -- Crossroads: road-road intersections become degree-4 nodes. Repeat
  // until no crossing pair remains (splits can expose new pairs). --
  for (let guard = 0; guard < 40; guard++) {
    let found: { e1: TheaterEdge; i1: number; e2: TheaterEdge; i2: number; at: Vec } | null = null;
    outer: for (const e1 of b.edges) {
      if (e1.moveClass === 'rail') continue;
      for (const e2 of b.edges) {
        if (e2.moveClass === 'rail' || e2.id <= e1.id) continue;
        if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
        for (let i = 1; i < e1.polyline.length; i++) {
          for (let k = 1; k < e2.polyline.length; k++) {
            const hit = segIntersect(e1.polyline[i - 1], e1.polyline[i], e2.polyline[k - 1], e2.polyline[k]);
            if (!hit) continue;
            const clear = [e1.a, e1.b, e2.a, e2.b].every((id) => dist(b.nodes[id].pos, hit) > MIN_EDGE_M);
            if (!clear) continue; // near-node crossings are absorbed by the endpoints' own geometry
            found = { e1, i1: i - 1, e2, i2: k - 1, at: hit };
            break outer;
          }
        }
      }
    }
    if (!found) break;
    const x = mintNode(b, found.at, 'crossroads');
    splitEdge(b, found.e1, found.i1, x.pos, x.id);
    splitEdge(b, found.e2, found.i2, x.pos, x.id);
  }

  // -- Crossings: every foot-edge x river intersection minted or merged --
  const crossRng = stageStream(base, T_TAG.CROSSINGS);
  const pending: { edge: TheaterEdge; at: Vec; segIdx: number; riverId: number; main: boolean }[] = [];
  for (const e of b.edges) {
    if (e.moveClass === 'rail') continue;
    for (const r of rivers) {
      for (let i = 1; i < e.polyline.length; i++) {
        for (let k = 1; k < r.polyline.length; k++) {
          const hit = segIntersect(e.polyline[i - 1], e.polyline[i], r.polyline[k - 1], r.polyline[k]);
          if (hit) pending.push({ edge: e, at: hit, segIdx: i - 1, riverId: r.id, main: r.id === 0 });
        }
      }
    }
  }
  // Downstream order on the MAIN river = ascending y (geometry-keyed draws).
  pending.sort((p, q) => p.at.y - q.at.y || p.at.x - q.at.x);
  for (const c of pending) {
    // Merge into a near node (bridge towns; also keeps sub-edges >= MIN_EDGE_M).
    let near: TheaterNode | null = null;
    for (const n of b.nodes) {
      if (dist(n.pos, c.at) <= MERGE_M && (!near || dist(n.pos, c.at) < dist(near.pos, c.at))) near = n;
    }
    // Main-river kind draws come from the CROSSINGS stream; tributary
    // crossings are culvert bridges and draw nothing.
    const kind: 'bridge' | 'ford' = c.main ? (crossRng.next() < 0.75 ? 'bridge' : 'ford') : 'bridge';
    if (near) {
      if (!near.crossing) near.crossing = { riverId: c.riverId, kind };
      continue;
    }
    const n = mintNode(b, c.at, kind);
    n.crossing = { riverId: c.riverId, kind };
    // The intersection was computed against a polyline an earlier crossing
    // may have split since; re-find the owning edge. Rounding at split points
    // shifts vertices by up to ~1 m per split, hence the loose tolerance.
    let owner: TheaterEdge | null = null;
    let ownerHit: { at: Vec; segIdx: number; d: number } | null = null;
    for (const e of b.edges) {
      if (e.moveClass === 'rail') continue;
      const hit = nearestOnPolyline(e.polyline, c.at);
      if (!ownerHit || hit.d < ownerHit.d) {
        owner = e;
        ownerHit = hit;
      }
    }
    if (!owner || !ownerHit || ownerHit.d > 10) {
      throw new Error(`planNetwork: crossing at ${c.at.x},${c.at.y} lost its owning edge (nearest ${ownerHit?.d.toFixed(1)} m)`);
    }
    splitEdge(b, owner, ownerHit.segIdx, n.pos, n.id);
  }

  // -- T_CROSSINGS audit: main-river BRIDGE band 2-4 by demotion/promotion --
  // Budgeted walk in downstream order: bridges <= 4, fords <= 2, then a
  // floor pass promotes fords until >= 2 bridges stand. More than 6 main
  // crossings exceeds both budgets — that is 'crossing-flooded', S11's
  // reject, and the overflow stays 'bridge' so the flood is visible.
  const mains = b.nodes.filter((n) => n.crossing?.riverId === 0).sort((p, q) => p.pos.y - q.pos.y);
  const setKind = (n: TheaterNode, k: 'bridge' | 'ford'): void => {
    n.crossing!.kind = k;
    if (n.kind === 'bridge' || n.kind === 'ford') n.kind = k;
  };
  let bridgeBudget = 4;
  let fordBudget = 2;
  for (const n of mains) {
    let k = n.crossing!.kind;
    if (k === 'bridge' && bridgeBudget === 0 && fordBudget > 0) k = 'ford';
    else if (k === 'ford' && fordBudget === 0) k = 'bridge';
    if (k === 'bridge') bridgeBudget = Math.max(0, bridgeBudget - 1);
    else fordBudget--;
    setKind(n, k);
  }
  let bridgeCount = mains.filter((n) => n.crossing!.kind === 'bridge').length;
  for (const n of mains) {
    if (bridgeCount >= 2) break;
    if (n.crossing!.kind === 'ford') {
      setKind(n, 'bridge');
      bridgeCount++;
    }
  }

  return { nodes: b.nodes, edges: b.edges };
}
