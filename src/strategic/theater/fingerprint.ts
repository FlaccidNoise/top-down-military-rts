// Theater fingerprints (S12): ONE hash implementation for the pins, the
// version-bump tripwire and the fp script. Per-field hashes localize a drift
// to the stage that moved it.
import type { Theater } from '../theater';

export const fnv = (nums: (number | string)[]): number => {
  let h = 2166136261;
  for (const n of nums) {
    for (const ch of String(n)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    h ^= 44;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export function perFieldFingerprint(t: Theater): Record<string, number> {
  return {
    name: fnv([t.name]),
    nodes: fnv(t.nodes.flatMap((n) => [n.id, n.kind, n.name, n.pos.x, n.pos.y, n.regionId, n.crossing ? n.crossing.kind : '-'])),
    edges: fnv(t.edges.flatMap((e) => [e.id, e.a, e.b, e.moveClass, e.lengthM, e.paceMpm])),
    regions: fnv(t.regions.flatMap((r) => [r.id, r.terrainClass, r.name, r.areaM2])),
    rivers: fnv(t.rivers.flatMap((r) => [r.id, r.name, r.polyline.length])),
    objectives: fnv(t.objectiveNodes),
    sources: fnv([...t.sources.blue, ...t.sources.red]),
  };
}

export function theaterFingerprint(t: Theater): number {
  const f = perFieldFingerprint(t);
  return fnv([t.name, f.nodes, f.edges, f.regions, f.rivers, f.objectives, f.sources]);
}
