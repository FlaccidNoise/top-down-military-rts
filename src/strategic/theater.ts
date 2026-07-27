// Strategic Layer V2 spine (S5, design doc §1/§3.1/§6): the immutable Theater
// types, the movement constants, and battle-site resolution — the contract
// that keeps makeStrategicBattle's map regeneration alive on a graph.
//
// The Theater is IMMUTABLE after generation: zero owner fields, zero scars.
// Every mutable field (control, forces, battles) lives in Front V2.
import { GEN_VERSION } from '../campaign/spec';
import type { MapKind } from '../sim/mapgen';
import type { Side } from '../sim/sim';

// One version, two readers, never two constants (§9.2): saves persist it via
// CampaignSpec.genVersion; a mismatch rejects as 'stale-generator'.
export const THEATER_VERSION = GEN_VERSION;

export type Vec = { x: number; y: number }; // integer metres
export type TerrainClass = 'farmland' | 'bocage' | 'forest' | 'marsh' | 'settlement';
export type NodeKind = 'town' | 'village' | 'crossroads' | 'junction' | 'bridge' | 'ford' | 'halt';
export type MoveClass = 'highway' | 'road' | 'track' | 'rail';
export type Rank = 0 | 1 | 2; // derived: display weight / label priority

export interface TheaterNode {
  id: number; // dense 0..n-1, generation-ordered, frozen
  pos: Vec;
  kind: NodeKind;
  name: string; // deterministic Norman toponym (T_NAMES)
  regionId: number;
  crossing: { riverId: number; kind: 'bridge' | 'ford' } | null; // viaFord re-roots here
  rank: Rank; // town 0, village 1, rest 2
}

export interface TheaterEdge {
  id: number;
  a: number;
  b: number; // polyline runs a -> b
  kind: 'road' | 'rail';
  moveClass: MoveClass;
  polyline: Vec[];
  lengthM: number; // integer metres along polyline; >= MIN_EDGE_M
  paceMpm: number; // baked: MOVE_MPM[moveClass] * length-weighted region pace mult
  rank: Rank; // highway 0, road 1, track 2
}

export interface Region {
  id: number;
  polygon: Vec[];
  holes?: Vec[][];
  centroid: Vec;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  areaM2: number;
  terrainClass: TerrainClass;
  name: string;
  seatNodeId: number | null; // naming + derived-control anchor
}

export interface River {
  id: number;
  name: string;
  polyline: Vec[];
  widthClass: 'stream' | 'river';
}

export interface Theater {
  version: number; // === THEATER_VERSION at generation
  seed: number;
  name: string; // '{principal town} sector'
  boundsM: { w: number; h: number }; // default 24000 x 18000
  nodes: TheaterNode[];
  edges: TheaterEdge[];
  regions: Region[];
  rivers: River[];
  objectiveNodes: number[]; // semantics owned by WarGoals (§4)
  sources: Record<Side, number[]>; // supply source nodes (validated iff supply ships)
}

// R1: force positions are metres on the network, tagged.
export type NetPos =
  | { kind: 'node'; nodeId: number }
  | { kind: 'edge'; edgeId: number; s: number /* metres from edge.a */; dir: 1 | -1 };

// §3.1 — m/min (= 15/20/30 min per km). road:track is today's CELL_MINUTES
// road:open (10:15). Rail carries no columns at launch (OQ9: geometry only).
export const MOVE_MPM: Record<Exclude<MoveClass, 'rail'>, number> = {
  highway: 66.7,
  road: 50,
  track: 33.3,
};

// Applied to the moveClass base when paceMpm is baked at generation. Forest
// 0.5 is the specified value: TRACK x FOREST (16.65) vs road (50) reproduces
// the pinned 3:1 road:woods ratio; ROAD x FOREST (25) is 2:1 by design — a
// metalled road through woods is not a forest track, and the 3:1 figure is a
// track-class claim, never a whole-class invariant. The other classes are
// neutral until a generation task tunes them with evidence.
export const REGION_PACE_MULT: Record<TerrainClass, number> = {
  farmland: 1,
  bocage: 1,
  forest: 0.5,
  marsh: 1,
  settlement: 1,
};

// §6 — the Region→MapKind contract.
export type BattleClass =
  | 'settlement'
  | 'hamlet'
  | 'forest'
  | 'farmland'
  | 'marsh'
  | 'roadside'
  | 'bridge-assault'
  | 'ford-assault';

// When mapgen-v3 lands, THIS TABLE changes and nothing else. It is the only
// exhaustive MapKind mapping in strategic code — grep-gated in tests.
export const BATTLE_CLASS_TO_MAPKIND: Record<BattleClass, MapKind> = {
  settlement: 'bourg',
  hamlet: 'open',
  forest: 'woods',
  farmland: 'open',
  marsh: 'open',
  roadside: 'road',
  'bridge-assault': 'bridge',
  'ford-assault': 'river', // preserves the viaFord map override
};

// The calibrated siege multiplier follows BattleClass so the town→bourg
// retirement cannot silently cheapen settlement fights. hamlet 3.0 = OQ8.
export const COARSE_DEF_MULT: Record<BattleClass, number> = {
  settlement: 7.0,
  hamlet: 3.0,
  forest: 1.5,
  farmland: 1.0,
  marsh: 1.0,
  roadside: 1.0,
  'bridge-assault': 1.0,
  'ford-assault': 1.0,
};

// Attacker multiplier on crossing-assault classes — today's
// attacker-cell-is-river semantics re-rooted onto the BattleClass.
export const CROSSING_ASSAULT_MULT = 2.0;

// R4: one site identity for the tactical seed, the coarse salt and the AI.
// 32-bit FNV-1a over a prefix-disjoint string; edge positions quantise to
// 100 m buckets (a bare edge id would give two fights at opposite ends of a
// 9 km edge identical battle maps). A fight within one bucket keys one site;
// the bucket edge is a deterministic function of exact s.
export function siteKeyOf(at: NetPos): number {
  const s = at.kind === 'node' ? `node:${at.nodeId}` : `edge:${at.edgeId}:${Math.round(at.s / 100)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Point s metres along an edge's polyline (clamped to its ends).
export function pointAlong(edge: TheaterEdge, s: number): Vec {
  const pts = edge.polyline;
  if (pts.length === 0) throw new Error(`pointAlong: edge ${edge.id} has an empty polyline`);
  let remain = Math.max(0, s);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const seg = Math.hypot(dx, dy);
    if (remain <= seg && seg > 0) {
      const t = remain / seg;
      return { x: pts[i - 1].x + dx * t, y: pts[i - 1].y + dy * t };
    }
    remain -= seg;
  }
  return pts[pts.length - 1];
}

function inPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Containing region (holes excluded), else nearest centroid; ties by lowest id.
export function regionAt(theater: Theater, p: Vec): Region {
  if (theater.regions.length === 0) throw new Error('regionAt: theater has no regions');
  for (const r of theater.regions) {
    if (p.x < r.bbox.x0 || p.x > r.bbox.x1 || p.y < r.bbox.y0 || p.y > r.bbox.y1) continue;
    if (!inPolygon(p, r.polygon)) continue;
    if (r.holes?.some((h) => inPolygon(p, h))) continue;
    return r;
  }
  let best = theater.regions[0];
  let bestD = Infinity;
  for (const r of theater.regions) {
    const d = Math.hypot(r.centroid.x - p.x, r.centroid.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

const TERRAIN_TO_BATTLE: Record<TerrainClass, BattleClass> = {
  forest: 'forest',
  marsh: 'marsh',
  settlement: 'settlement',
  farmland: 'farmland',
  bocage: 'farmland',
};

// §6 resolution ladder: crossing-assault first (crossing node + a known
// attacker approach), then node kind, then the region under the point —
// with 'roadside' for mid-edge fights on a metalled road through farmland.
export function battleSiteOf(
  theater: Theater,
  at: NetPos,
  approachEdgeId?: number,
): { battleClass: BattleClass; siteKey: number } {
  const key = siteKeyOf(at);
  if (at.kind === 'node') {
    const n = theater.nodes[at.nodeId];
    if (!n) throw new Error(`battleSiteOf: unknown node ${at.nodeId}`);
    if (n.crossing && approachEdgeId !== undefined) {
      return { battleClass: n.crossing.kind === 'bridge' ? 'bridge-assault' : 'ford-assault', siteKey: key };
    }
    if (n.kind === 'town') return { battleClass: 'settlement', siteKey: key };
    if (n.kind === 'village') return { battleClass: 'hamlet', siteKey: key };
    return { battleClass: TERRAIN_TO_BATTLE[regionAt(theater, n.pos).terrainClass], siteKey: key };
  }
  const e = theater.edges[at.edgeId];
  if (!e) throw new Error(`battleSiteOf: unknown edge ${at.edgeId}`);
  const cls = TERRAIN_TO_BATTLE[regionAt(theater, pointAlong(e, at.s)).terrainClass];
  if (cls === 'farmland' && (e.moveClass === 'highway' || e.moveClass === 'road')) {
    return { battleClass: 'roadside', siteKey: key };
  }
  return { battleClass: cls, siteKey: key };
}
