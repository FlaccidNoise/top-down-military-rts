import type { Building, ObjectiveKind, Vec } from '../mapgen';
import type { Footprints } from './footprints';
import type { Landmarks } from './landmarks';
import type { Skeleton } from './streets';

// §3.4 — the tagged objective list, the spawns, and the greedy garrison
// coverage fill (T10). No rng: every choice here is a deterministic function of
// the geometry, which is what lets §5.2 assert the tag prefix and lets tooling
// stop index-guessing.

// bridge.ts:86. A building centre farther than this from EVERY objective is
// dropped from the garrison, so a 110-tile-wide bourg with one central
// objective leaves its whole edge undefended.
export const GARRISON_RADIUS = 45;
// §3.4 caps the fill at 8. Measured, that leaves buildings uncovered on a
// 320x240 bourg: one objective covers a 45 m disc, the envelope alone needs
// three, and T9's outlying farms are each 60+ tiles from anything. 12 is the
// smallest cap that satisfies §5.2's "every building centre within 45 m", and
// the cost of the extra slots is only that bridge.ts:217 splits the garrison
// into more sectors — which is what a dispersed bourg should do.
const MAX_OBJECTIVES = 12;

export interface Objectives {
  objectives: Vec[];
  objectiveKinds: ObjectiveKind[];
}

const centreOf = (b: Building): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const d2 = (a: Vec, b: Vec): number => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

// Nearest free road tile by Chebyshev rings, scanned in a fixed order so ties
// break the same way on every run. Reservations are excluded: the market island
// had its road cleared under it and is about to carry a terrace.
export function nearestRoad(sk: Skeleton, land: Landmarks, from: Vec, limit = 60): Vec | null {
  const { w, h } = sk;
  const cx = Math.round(from.x);
  const cy = Math.round(from.y);
  for (let r = 0; r <= limit; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const i = y * w + x;
        if (sk.road[i] && !land.resv[i]) return { x, y };
      }
  return null;
}

export function bourgSpawns(sk: Skeleton): { west: Vec; east: Vec } {
  return { west: { x: 3, y: sk.roadY[3] }, east: { x: sk.w - 4, y: sk.roadY[sk.w - 4] } };
}

export function buildObjectives(sk: Skeleton, land: Landmarks, fp: Footprints, woodsStands: Vec[]): Objectives {
  const objectives: Vec[] = [];
  const objectiveKinds: ObjectiveKind[] = [];
  const push = (v: Vec | null, kind: ObjectiveKind): void => {
    if (!v) return;
    if (objectives.some((o) => o.x === v.x && o.y === v.y)) return;
    objectives.push(v);
    objectiveKinds.push(kind);
  };

  // [0] the place. land.anchor, not sk.place: sk.place is the density origin and
  // the market island can legitimately sit on top of it, while scenario.ts:49
  // emplaces the MG42 on objectives[0] and patches.ts needs road under it for
  // the cobbles. anchor is a guaranteed free road tile within Chebyshev 12.
  push(land.anchor, 'place');
  // [1] the east woods. A squad spawns on it (scenario.ts:48,52), so it has to
  // stay passable — paintRural nudges the anchor off anything that is not.
  push(woodsStands[0] ?? land.anchor, 'woods');
  // [2] the secondary cluster, on w >= 240 only, preserving the slot
  // stage.mjs:65 already reads. The 'faubourg' archetype has a real one; every
  // other archetype gets the far end of the Grande Rue, tagged for what it is.
  if (sk.w >= 240) {
    if (sk.faubourg) push(nearestRoad(sk, land, sk.faubourg), 'faubourg');
    else {
      const far = sk.place.x < sk.w >> 1 ? sk.env.x + sk.env.w - 4 : sk.env.x + 3;
      push(nearestRoad(sk, land, { x: far, y: sk.roadY[Math.max(0, Math.min(sk.w - 1, far))] }), 'street');
    }
  }
  // [n] the church. A road tile at the enclosure rather than the gate itself:
  // the gate is an EDGE, and an objective has to be a standable tile.
  if (fp.church) push(nearestRoad(sk, land, fp.church), 'church');

  // ── greedy coverage fill ────────────────────────────────────────────────
  // Deterministic, no rng, capped at 8 (§3.4). Rerolling a whole map because
  // one fringe farm sits 47 m from an objective is absurd, and coverage is
  // trivially constructible: take the worst-covered building, put an objective
  // on the nearest road tile to it, repeat.
  const centres = fp.buildings.map(centreOf);
  const r2 = GARRISON_RADIUS * GARRISON_RADIUS;
  const tried = new Uint8Array(centres.length);
  while (objectives.length < MAX_OBJECTIVES) {
    let worst = -1;
    let worstD2 = r2;
    for (let i = 0; i < centres.length; i++) {
      if (tried[i]) continue;
      let near = Infinity;
      for (const o of objectives) {
        const d = d2(centres[i], o);
        if (d < near) near = d;
      }
      // (dist², index) — a bare float key with ties is a non-deterministic
      // ordering the moment two buildings are equidistant, which on a grid of
      // mirrored terraces is not a rare event
      if (near > worstD2) {
        worstD2 = near;
        worst = i;
      }
    }
    if (worst < 0) break;
    tried[worst] = 1; // one attempt per building: the loop must terminate
    // The road tile has to be inside the radius or the objective does not cover
    // the building it was created for. An isolated farm whose lane never
    // reached it gets its own yard instead — a floor tile, passable, and the
    // only place a garrison of that farm could stand anyway.
    // The road tile must be inside the radius EUCLIDEAN — nearestRoad scans
    // Chebyshev rings, and a tile 40 rings out on the diagonal is 56 m away,
    // which does not cover the building the objective was created for.
    const spot = nearestRoad(sk, land, centres[worst], GARRISON_RADIUS - 1);
    const ok = spot !== null && d2(centres[worst], spot) <= r2;
    push(ok ? spot : { x: Math.round(centres[worst].x), y: Math.round(centres[worst].y) }, 'street');
  }

  return { objectives, objectiveKinds };
}
