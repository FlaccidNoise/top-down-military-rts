// Theater validation (S11, design doc §2): ELEVEN unconditional named reject
// reasons, each a THROW — a generator that ships a degenerate theater is a
// worse bug than one that rejects. Validation draws ZERO rng: it reads the
// assembled theater and nothing else, so it cannot shift any stage's stream.
import type { Theater, Vec } from '../theater';
import { MIN_EDGE_M } from './roads';
import { TOWN_SPACING_M, VILLAGE_SPACING_M } from './settlements';

export type RejectReason =
  | 'disconnected'
  | 'no-objectives'
  | 'objectives-unreachable'
  | 'crossing-starved'
  | 'crossing-flooded'
  | 'front-degenerate'
  | 'region-sliver'
  | 'orphan-node'
  | 'spacing'
  | 'name-collision'
  | 'short-edge'
  | 'no-supply-source'; // S50: supply ships, so an unsourceable side rejects

export const REGION_SLIVER_M2 = 250_000;
const FRONT_MIN_SHARE = 0.25;

// Reason -> the TheaterConfig knob most likely responsible (R12): the
// customize screen's reject card names a knob, not a stack trace.
export const REJECT_KNOB: Record<RejectReason, string | null> = {
  disconnected: 'roadDensity',
  'no-objectives': 'townDensity',
  'objectives-unreachable': 'roadDensity',
  'crossing-starved': 'riverDensity',
  'crossing-flooded': 'crossingScarcity',
  'front-degenerate': 'riverDensity',
  'region-sliver': 'townDensity',
  'orphan-node': 'roadDensity',
  spacing: 'townSpacingMinKm',
  'name-collision': null,
  'short-edge': 'townDensity',
  'no-supply-source': 'riverDensity', // sources derive from the river-anchored partition
};

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

// Returns the FIRST failing reason, or null for a valid theater. One reason
// per pass keeps reject accounting unambiguous; the attempt loop tallies.
export function validateTheater(t: Theater, controlByNode: ('blue' | 'red')[]): RejectReason | null {
  const foot = t.edges.filter((e) => e.moveClass !== 'rail');

  // orphan-node: every node carries at least one foot edge.
  const deg = new Map<number, number>();
  for (const e of foot) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  if (t.nodes.some((n) => !deg.has(n.id))) return 'orphan-node';

  if (t.nodes.length > 0) {
    const adj = new Map<number, number[]>();
    for (const e of foot) {
      adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
      adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
    }

    // no-objectives: closes the operationStatus permanent-'ongoing' stall.
    if (t.objectiveNodes.length === 0) return 'no-objectives';

    // objectives-unreachable BEFORE disconnected: a stranded objective is the
    // more specific finding (a connected graph cannot strand one, so checked
    // second it would be unreachable dead code).
    const sources = t.sources.blue;
    if (sources.length > 0) {
      const reach = new Set<number>(sources);
      const q2 = [...sources];
      while (q2.length > 0) {
        const x = q2.pop()!;
        for (const m of adj.get(x) ?? []) {
          if (!reach.has(m)) {
            reach.add(m);
            q2.push(m);
          }
        }
      }
      if (t.objectiveNodes.some((o) => !reach.has(o))) return 'objectives-unreachable';
    }

    // disconnected: one foot component.
    const seen = new Set<number>([t.nodes[0].id]);
    const q = [t.nodes[0].id];
    while (q.length > 0) {
      const x = q.pop()!;
      for (const m of adj.get(x) ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          q.push(m);
        }
      }
    }
    if (seen.size !== t.nodes.length) return 'disconnected';
  }

  // crossing bands on the MAIN river.
  const mains = t.nodes.filter((n) => n.crossing?.riverId === 0);
  if (mains.length < 2) return 'crossing-starved';
  if (mains.length > 5) return 'crossing-flooded';

  // front-degenerate: either side under 25% of nodes.
  const blue = controlByNode.filter((s) => s === 'blue').length;
  const share = blue / Math.max(1, t.nodes.length);
  if (share < FRONT_MIN_SHARE || share > 1 - FRONT_MIN_SHARE) return 'front-degenerate';

  // no-supply-source (S50): supply is a live system — a side with no source
  // node starts the war cut off by construction. Subsumed by front-degenerate
  // on generated seeds; named so a doctored theater rejects by its real cause.
  if (t.sources.blue.length === 0 || t.sources.red.length === 0) return 'no-supply-source';

  // region-sliver.
  if (t.regions.some((r) => r.areaM2 < REGION_SLIVER_M2)) return 'region-sliver';

  // spacing: towns and villages hold their bands.
  const towns = t.nodes.filter((n) => n.kind === 'town');
  for (let i = 0; i < towns.length; i++)
    for (let j = i + 1; j < towns.length; j++)
      if (dist(towns[i].pos, towns[j].pos) < TOWN_SPACING_M) return 'spacing';
  const villages = t.nodes.filter((n) => n.kind === 'village');
  for (const v of villages)
    for (const o of [...towns, ...villages])
      if (o.id !== v.id && dist(v.pos, o.pos) < VILLAGE_SPACING_M) return 'spacing';

  // name-collision among nodes (rivers/regions collide legitimately with
  // their seats — node names are the player-facing unique namespace).
  const names = t.nodes.map((n) => n.name);
  if (new Set(names).size !== names.length) return 'name-collision';

  // short-edge on the foot network.
  if (foot.some((e) => e.lengthM < MIN_EDGE_M)) return 'short-edge';

  return null;
}
