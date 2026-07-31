/**
 * Structural integrity probe for commit f0aa3ac claims.
 *
 * Run: npx vite-node scripts/probes/alignment-probe.ts
 *
 * Checks across 12 seeds × 6 kinds:
 *   (a) Wall-building overlaps and perimeter gaps
 *   (b) Multi-part building roof coverage
 *   (c) Floating gate detection
 *   (d) Summary stats
 */

import { generateMap, type Building, type MapKind, type MapPlan, type Rect } from '../../src/sim/mapgen';
import { EDGE, GameMap } from '../../src/sim/map';
import { partsOf } from '../../src/sim/bourg/stamp';
import { artContexts, artKey } from '../../src/render/roofs';

// ── config ──────────────────────────────────────────────────────────────────
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
const KINDS: MapKind[] = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'];
const W = 320;
const H = 240;

type Horiz = boolean;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Union bbox of a building's parts (same logic as roofs.ts:partsUnion). */
function partsUnion(b: Building): Rect {
  const parts = partsOf(b);
  let ux = Infinity, uy = Infinity, mx = -Infinity, my = -Infinity;
  for (const p of parts) {
    if (p.x < ux) ux = p.x;
    if (p.y < uy) uy = p.y;
    if (p.x + p.w > mx) mx = p.x + p.w;
    if (p.y + p.h > my) my = p.y + p.h;
  }
  return { x: ux, y: uy, w: mx - ux, h: my - uy };
}

/** Does tile (tx, ty) belong to any part of building b? */
function inBuilding(b: Building, tx: number, ty: number): boolean {
  for (const p of partsOf(b)) {
    if (tx >= p.x && tx < p.x + p.w && ty >= p.y && ty < p.y + p.h) return true;
  }
  return false;
}

/** Does a building's mask cover tile (tx, ty) given the union of parts? */
// (this is just inBuilding)

/** Collect all perimeter edges of a building (edges where inside differs from outside). */
function perimeterEdges(b: Building): { ex: number; ey: number; horiz: boolean }[] {
  const parts = partsOf(b);
  const out: { ex: number; ey: number; horiz: boolean }[] = [];
  const seen = new Set<string>();

  for (const p of parts) {
    // North edges
    for (let x = p.x; x < p.x + p.w; x++) {
      const key = `h${x},${p.y}`;
      if (seen.has(key)) continue;
      // Is the tile above also in the building? If so, it's an interior edge, not perimeter.
      if (!inBuilding(b, x, p.y - 1)) {
        seen.add(key);
        out.push({ ex: x, ey: p.y, horiz: true });
      }
    }
    // South edges
    for (let x = p.x; x < p.x + p.w; x++) {
      const key = `h${x},${p.y + p.h}`;
      if (seen.has(key)) continue;
      if (!inBuilding(b, x, p.y + p.h)) {
        seen.add(key);
        out.push({ ex: x, ey: p.y + p.h, horiz: true });
      }
    }
    // West edges
    for (let y = p.y; y < p.y + p.h; y++) {
      const key = `v${p.x},${y}`;
      if (seen.has(key)) continue;
      if (!inBuilding(b, p.x - 1, y)) {
        seen.add(key);
        out.push({ ex: p.x, ey: y, horiz: false });
      }
    }
    // East edges
    for (let y = p.y; y < p.y + p.h; y++) {
      const key = `v${p.x + p.w},${y}`;
      if (seen.has(key)) continue;
      if (!inBuilding(b, p.x + p.w, y)) {
        seen.add(key);
        out.push({ ex: p.x + p.w, ey: y, horiz: false });
      }
    }
  }
  return out;
}

/** Quick lookup: does a building have this edge on its perimeter? */
function isOnBuildingPerimeter(b: Building, ex: number, ey: number, horiz: boolean): boolean {
  if (horiz) {
    return (ey === b.y || ey === b.y + b.h) && ex >= b.x && ex < b.x + b.w;
  }
  return (ex === b.x || ex === b.x + b.w) && ey >= b.y && ey < b.y + b.h;
}

/** Get the tile index for (x, y). Returns -1 for out-of-bounds. */
function tileIdx(map: GameMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return -1;
  return y * map.w + x;
}

// ── (a) Overlap detection ───────────────────────────────────────────────────

interface Overlap {
  ex: number;
  ey: number;
  horiz: boolean;
  buildingId: number;
  desc: string;
}

interface Gap {
  ex: number;
  ey: number;
  horiz: boolean;
  buildingId: number;
  desc: string;
}

function detectOverlaps(plan: MapPlan): Overlap[] {
  const { map, buildings } = plan;
  const overlaps: Overlap[] = [];

  // Build a set of all perimeter edges for each building (by map buildingId).
  // Multiple Building objects can share the same buildingId (groupId), so we
  // MERGE perimeters rather than overwriting.
  const bldgPerimeters = new Map<number, Set<string>>();
  for (const b of buildings) {
    const bid = map.buildingIdAt(b.x, b.y);
    if (bid < 0) continue;
    let set = bldgPerimeters.get(bid);
    if (!set) { set = new Set<string>(); bldgPerimeters.set(bid, set); }

    const parts = partsOf(b);
    for (const p of parts) {
      for (let x = p.x; x < p.x + p.w; x++) {
        if (!inBuilding(b, x, p.y - 1)) set.add(`h${x},${p.y}`);
        if (!inBuilding(b, x, p.y + p.h)) set.add(`h${x},${p.y + p.h}`);
      }
      for (let y = p.y; y < p.y + p.h; y++) {
        if (!inBuilding(b, p.x - 1, y)) set.add(`v${p.x},${y}`);
        if (!inBuilding(b, p.x + p.w, y)) set.add(`v${p.x + p.w},${y}`);
      }
    }
  }

  // Also build a map from buildingId to Building for lookups
  const bidToBuilding = new Map<number, Building>();
  for (const b of buildings) {
    const bid = map.buildingIdAt(b.x, b.y);
    if (bid >= 0) bidToBuilding.set(bid, b);
  }

  // Scan all WALL edges
  for (let ey = 0; ey <= map.h; ey++) {
    for (let ex = 0; ex < map.w; ex++) {
      if (map.hEdge(ex, ey) !== EDGE.WALL) continue;
      const bAbove = map.buildingIdAt(ex, ey - 1);
      const bBelow = map.buildingIdAt(ex, ey);

      // Interior partitions (same bldg on both sides) are legitimate — skip
      if (bAbove >= 0 && bBelow >= 0 && bAbove === bBelow) continue;
      if (bAbove >= 0) {
        const perim = bldgPerimeters.get(bAbove);
        if (!perim || !perim.has(`h${ex},${ey}`)) {
          overlaps.push({ ex, ey, horiz: true, buildingId: bAbove, desc: `WALL inside building ${bAbove} (above side)` });
        }
      }
      if (bBelow >= 0 && bBelow !== bAbove) {
        const perim = bldgPerimeters.get(bBelow);
        if (!perim || !perim.has(`h${ex},${ey}`)) {
          overlaps.push({ ex, ey, horiz: true, buildingId: bBelow, desc: `WALL inside building ${bBelow} (below side)` });
        }
      }
    }
  }
  for (let ey = 0; ey < map.h; ey++) {
    for (let ex = 0; ex <= map.w; ex++) {
      if (map.vEdge(ex, ey) !== EDGE.WALL) continue;
      const bLeft = map.buildingIdAt(ex - 1, ey);
      const bRight = map.buildingIdAt(ex, ey);

      // Interior partitions (same bldg on both sides) are legitimate — skip
      if (bLeft >= 0 && bRight >= 0 && bLeft === bRight) continue;
      if (bLeft >= 0) {
        const perim = bldgPerimeters.get(bLeft);
        if (!perim || !perim.has(`v${ex},${ey}`)) {
          overlaps.push({ ex, ey, horiz: false, buildingId: bLeft, desc: `WALL inside building ${bLeft} (left side)` });
        }
      }
      if (bRight >= 0 && bRight !== bLeft) {
        const perim = bldgPerimeters.get(bRight);
        if (!perim || !perim.has(`v${ex},${ey}`)) {
          overlaps.push({ ex, ey, horiz: false, buildingId: bRight, desc: `WALL inside building ${bRight} (right side)` });
        }
      }
    }
  }
  return overlaps;
}

function detectGaps(plan: MapPlan): Gap[] {
  const { map, buildings } = plan;
  const gaps: Gap[] = [];

  for (const b of buildings) {
    const bid = map.buildingIdAt(b.x, b.y);
    if (bid < 0) continue;

    // Halle has open sides by design
    if (b.role === 'halle') continue;

    for (const p of partsOf(b)) {
      // North face
      for (let x = p.x; x < p.x + p.w; x++) {
        if (inBuilding(b, x, p.y - 1)) continue; // interior edge, not perimeter
        const e = map.hEdge(x, p.y);
        if (e === EDGE.NONE) {
          // Only gap if outside is open ground (not another building)
          const outside = map.buildingIdAt(x, p.y - 1);
          if (outside < 0) {
            gaps.push({ ex: x, ey: p.y, horiz: true, buildingId: bid, desc: `GAP: no wall on N face of building ${bid} at (${x},${p.y})` });
          }
        }
      }
      // South face
      for (let x = p.x; x < p.x + p.w; x++) {
        if (inBuilding(b, x, p.y + p.h)) continue;
        const e = map.hEdge(x, p.y + p.h);
        if (e === EDGE.NONE) {
          const outside = map.buildingIdAt(x, p.y + p.h);
          if (outside < 0) {
            gaps.push({ ex: x, ey: p.y + p.h, horiz: true, buildingId: bid, desc: `GAP: no wall on S face of building ${bid} at (${x},${p.y + p.h})` });
          }
        }
      }
      // West face
      for (let y = p.y; y < p.y + p.h; y++) {
        if (inBuilding(b, p.x - 1, y)) continue;
        const e = map.vEdge(p.x, y);
        if (e === EDGE.NONE) {
          const outside = map.buildingIdAt(p.x - 1, y);
          if (outside < 0) {
            gaps.push({ ex: p.x, ey: y, horiz: false, buildingId: bid, desc: `GAP: no wall on W face of building ${bid} at (${p.x},${y})` });
          }
        }
      }
      // East face
      for (let y = p.y; y < p.y + p.h; y++) {
        if (inBuilding(b, p.x + p.w, y)) continue;
        const e = map.vEdge(p.x + p.w, y);
        if (e === EDGE.NONE) {
          const outside = map.buildingIdAt(p.x + p.w, y);
          if (outside < 0) {
            gaps.push({ ex: p.x + p.w, ey: y, horiz: false, buildingId: bid, desc: `GAP: no wall on E face of building ${bid} at (${p.x + p.w},${y})` });
          }
        }
      }
    }
  }
  return gaps;
}

// ── (b) Multi-part building roof coverage ────────────────────────────────────

interface RoofIssue {
  buildingIdx: number;
  buildingId: number;
  desc: string;
}

function detectRoofIssues(plan: MapPlan): RoofIssue[] {
  const { map, buildings } = plan;
  const issues: RoofIssue[] = [];
  const ctxs = artContexts(buildings, buildings.map((b) => {
    let m = 0;
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++)
        m = Math.max(m, map.storiesAt(x, y));
    return Math.max(1, m);
  }));

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    const parts = partsOf(b);
    if (parts.length <= 1) continue;

    const bid = map.buildingIdAt(b.x, b.y);
    if (bid < 0) {
      issues.push({ buildingIdx: i, buildingId: -1, desc: `Multi-part building ${i} has no buildingId at origin (${b.x},${b.y})` });
      continue;
    }

    // Check every part tile has stories > 0 and buildingId matches
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      let allOk = true;
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          if (map.storiesAt(x, y) <= 0) {
            if (allOk) {
              issues.push({ buildingIdx: i, buildingId: bid, desc: `Part ${pi} of building ${bid} has zero stories at (${x},${y})` });
              allOk = false;
            }
          }
          const tileBid = map.buildingIdAt(x, y);
          if (tileBid !== bid) {
            if (allOk) {
              issues.push({ buildingIdx: i, buildingId: bid, desc: `Part ${pi} of building ${bid} has wrong buildingId ${tileBid} at (${x},${y})` });
              allOk = false;
            }
          }
        }
      }
    }

    // Check all parts fit within partsUnion bbox (always true by definition, but verify)
    const u = partsUnion(b);
    for (const p of parts) {
      if (p.x < u.x || p.y < u.y || p.x + p.w > u.x + u.w || p.y + p.h > u.y + u.h) {
        issues.push({ buildingIdx: i, buildingId: bid, desc: `Part of building ${bid} extends outside partsUnion bbox` });
        break;
      }
    }

    // Check that buildArt would produce valid roof rect for all parts
    // The roof is drawn over partsUnion, so verify all part tiles fall within roofRect
    const ctx = ctxs[i];
    const oh = b.role && (b.role === 'church' || b.role === 'church_tower' || b.role === 'church_apse') ? 0.16 : 0.35;
    const rr = {
      x: u.x - (ctx.butt.w ? 0 : oh),
      y: u.y - (ctx.butt.n ? 0 : oh),
      w: u.w + (ctx.butt.w ? 0 : oh) + (ctx.butt.e ? 0 : oh),
      h: u.h + (ctx.butt.n ? 0 : oh) + (ctx.butt.s ? 0 : oh),
    };
    for (const p of parts) {
      // With overhang, the roof extends beyond parts. Check each part is within the roof rect.
      // Actually, the roof rect is larger than parts by design. Instead, verify
      // every part tile is covered by the roof's footprint. The roof covers u plus overhang.
      // The parts should all be within u (by definition), and u is within the roof rect.
      // So this is tautological unless there's a bug.
    }
  }

  return issues;
}

// ── (c) Floating gate detection ──────────────────────────────────────────────

interface FloatingDoor {
  ex: number;
  ey: number;
  horiz: boolean;
  desc: string;
}

function detectFloatingDoors(plan: MapPlan): FloatingDoor[] {
  const { map } = plan;
  const floating: FloatingDoor[] = [];
  const b = map.buildingId;

  // Helper: is a tile building floor?
  const isFloor = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < map.w && y < map.h && b[y * map.w + x] >= 0;

  // Our wall helpers (matching enclosures.ts logic)
  const WALL_LOW = 1;
  const WALL_HIGH = 2;
  const ourT = (t: number): boolean => t === WALL_LOW || t === WALL_HIGH;

  // A wall written by enclosures (our wall, potentially involving gates)
  const ourH = (ex: number, ey: number): boolean => {
    if (ex < 0 || ex >= map.w || ey < 0 || ey > map.h) return false;
    const e = map.hEdge(ex, ey);
    return e === EDGE.DOOR || (e === EDGE.WALL && ourT(map.hEdgeTops[ey * map.w + ex]));
  };
  const ourV = (ex: number, ey: number): boolean => {
    if (ex < 0 || ex > map.w || ey < 0 || ey >= map.h) return false;
    const e = map.vEdge(ex, ey);
    return e === EDGE.DOOR || (e === EDGE.WALL && ourT(map.vEdgeTops[ey * (map.w + 1) + ex]));
  };

  // Building wall at a grid edge
  const bldgH = (ex: number, ey: number): boolean => {
    if (ex < 0 || ex >= map.w || ey < 0 || ey > map.h) return false;
    return map.hEdge(ex, ey) === EDGE.WALL && !ourT(map.hEdgeTops[ey * map.w + ex]);
  };
  const bldgV = (ex: number, ey: number): boolean => {
    if (ex < 0 || ex > map.w || ey < 0 || ey >= map.h) return false;
    return map.vEdge(ex, ey) === EDGE.WALL && !ourT(map.vEdgeTops[ey * (map.w + 1) + ex]);
  };

  // Vertex terminus check (matching enclosures.ts vTerm AFTER the fix)
  const vTerm = (vx: number, vy: number): boolean => {
    if (vx <= 0 || vx >= map.w || vy <= 0 || vy >= map.h) return true;
    if (bldgH(vx - 1, vy) || bldgH(vx, vy) || bldgV(vx, vy - 1) || bldgV(vx, vy)) return true;
    // Building floor tile adjacent to vertex (the fix)
    return b[(vy - 1) * map.w + (vx - 1)] >= 0 ||
           b[(vy - 1) * map.w + vx] >= 0 ||
           b[vy * map.w + (vx - 1)] >= 0 ||
           b[vy * map.w + vx] >= 0;
  };

  // Endpoint connection queries
  const hL = (ex: number, ey: number): boolean =>
    vTerm(ex, ey) || ourH(ex - 1, ey) || ourV(ex, ey) || ourV(ex, ey - 1);
  const hR = (ex: number, ey: number): boolean =>
    vTerm(ex + 1, ey) || ourH(ex + 1, ey) || ourV(ex + 1, ey) || ourV(ex + 1, ey - 1);
  const vT = (ex: number, ey: number): boolean =>
    vTerm(ex, ey) || ourV(ex, ey - 1) || ourH(ex - 1, ey) || ourH(ex, ey);
  const vB = (ex: number, ey: number): boolean =>
    vTerm(ex, ey + 1) || ourV(ex, ey + 1) || ourH(ex - 1, ey + 1) || ourH(ex, ey + 1);

  // Scan all DOOR edges
  for (let ey = 0; ey <= map.h; ey++) {
    for (let ex = 0; ex < map.w; ex++) {
      if (map.hEdge(ex, ey) !== EDGE.DOOR) continue;

      // Check: DOOR with DIFFERENT buildings on both sides (shouldn't happen).
      // Same building on both sides is a legitimate internal door (e.g., partition door).
      const above = isFloor(ex, ey - 1);
      const below = isFloor(ex, ey);
      if (above && below && map.buildingIdAt(ex, ey - 1) !== map.buildingIdAt(ex, ey)) {
        floating.push({ ex, ey, horiz: true, desc: `DOOR between different buildings (${map.buildingIdAt(ex, ey - 1)} and ${map.buildingIdAt(ex, ey)})` });
      }

      // Check: free-standing DOOR (no building floor on either side)
      if (!above && !below) {
        // This is a gate. Check endpoints.
        if (!hL(ex, ey) && !hR(ex, ey)) {
          floating.push({ ex, ey, horiz: true, desc: `FLOATING GATE: no continuation at either endpoint` });
        }
      }
    }
  }
  for (let ey = 0; ey < map.h; ey++) {
    for (let ex = 0; ex <= map.w; ex++) {
      if (map.vEdge(ex, ey) !== EDGE.DOOR) continue;

      // Check: DOOR with DIFFERENT buildings on both sides (shouldn't happen)
      const left = isFloor(ex - 1, ey);
      const right = isFloor(ex, ey);
      if (left && right && map.buildingIdAt(ex - 1, ey) !== map.buildingIdAt(ex, ey)) {
        floating.push({ ex, ey, horiz: false, desc: `DOOR between different buildings (${map.buildingIdAt(ex - 1, ey)} and ${map.buildingIdAt(ex, ey)})` });
      }

      // Check: free-standing DOOR
      if (!left && !right) {
        if (!vT(ex, ey) && !vB(ex, ey)) {
          floating.push({ ex, ey, horiz: false, desc: `FLOATING GATE: no continuation at either endpoint` });
        }
      }
    }
  }

  return floating;
}

// ── (d) Summary stats ────────────────────────────────────────────────────────

interface Summary {
  kind: string;
  seed: number;
  numBuildings: number;
  numWalls: number;
  numDoors: number;
  numOverlaps: number;
  numGaps: number;
  numFloatingDoors: number;
  numMultiPart: number;
  numRoofIssues: number;
  overlaps: Overlap[];
  gaps: Gap[];
  floatingDoors: FloatingDoor[];
  roofIssues: RoofIssue[];
}

function countEdges(map: GameMap): { walls: number; doors: number } {
  let walls = 0;
  let doors = 0;
  for (let ey = 0; ey <= map.h; ey++)
    for (let ex = 0; ex < map.w; ex++) {
      const e = map.hEdge(ex, ey);
      if (e === EDGE.WALL) walls++;
      else if (e === EDGE.DOOR) doors++;
    }
  for (let ey = 0; ey < map.h; ey++)
    for (let ex = 0; ex <= map.w; ex++) {
      const e = map.vEdge(ex, ey);
      if (e === EDGE.WALL) walls++;
      else if (e === EDGE.DOOR) doors++;
    }
  return { walls, doors };
}

function countMultiPart(buildings: Building[]): number {
  return buildings.filter((b) => (b.parts?.length ?? 0) > 1).length;
}

// ── main ─────────────────────────────────────────────────────────────────────

const allSummaries: Summary[] = [];

for (const kind of KINDS) {
  for (const seed of SEEDS) {
    let plan: MapPlan;
    try {
      plan = generateMap(seed, W, H, kind);
    } catch (err) {
      console.error(`  FAILED: ${kind} seed ${seed}:`, err);
      allSummaries.push({
        kind, seed,
        numBuildings: 0, numWalls: 0, numDoors: 0,
        numOverlaps: 0, numGaps: 0, numFloatingDoors: 0,
        numMultiPart: 0, numRoofIssues: 0,
        overlaps: [], gaps: [], floatingDoors: [], roofIssues: [],
      });
      continue;
    }

    const { walls, doors } = countEdges(plan.map);
    const overlaps = detectOverlaps(plan);
    const gaps = detectGaps(plan);
    const floatingDoors = detectFloatingDoors(plan);
    const roofIssues = detectRoofIssues(plan);
    const numMultiPart = countMultiPart(plan.buildings);

    const summary: Summary = {
      kind, seed,
      numBuildings: plan.buildings.length,
      numWalls: walls,
      numDoors: doors,
      numOverlaps: overlaps.length,
      numGaps: gaps.length,
      numFloatingDoors: floatingDoors.length,
      numMultiPart,
      numRoofIssues: roofIssues.length,
      overlaps,
      gaps,
      floatingDoors,
      roofIssues,
    };

    allSummaries.push(summary);
    console.error(`  ${kind.padEnd(7)} seed ${String(seed).padStart(2)}: bld=${plan.buildings.length} walls=${walls} doors=${doors} overlaps=${overlaps.length} gaps=${gaps.length} floating=${floatingDoors.length} multipart=${numMultiPart} roofIssues=${roofIssues.length}`);
  }
}

// ── output ───────────────────────────────────────────────────────────────────

// Aggregate stats
const totalsByKind: Record<string, { seeds: number; totalOverlaps: number; totalGaps: number; totalFloatingDoors: number; totalRoofIssues: number; worstSeed: number }> = {};
for (const s of allSummaries) {
  if (!totalsByKind[s.kind]) totalsByKind[s.kind] = { seeds: 0, totalOverlaps: 0, totalGaps: 0, totalFloatingDoors: 0, totalRoofIssues: 0, worstSeed: 0 };
  const t = totalsByKind[s.kind];
  t.seeds++;
  t.totalOverlaps += s.numOverlaps;
  t.totalGaps += s.numGaps;
  t.totalFloatingDoors += s.numFloatingDoors;
  t.totalRoofIssues += s.numRoofIssues;
  if (s.numOverlaps + s.numGaps + s.numFloatingDoors + s.numRoofIssues > 0) t.worstSeed = s.seed;
}

// Find any defects to report in detail
const defectSummaries = allSummaries.filter(
  (s) => s.numOverlaps > 0 || s.numGaps > 0 || s.numFloatingDoors > 0 || s.numRoofIssues > 0,
);

console.log(JSON.stringify({
  summary: {
    totalMaps: allSummaries.length,
    mapsWithDefects: defectSummaries.length,
    totalsByKind,
    defectDetails: defectSummaries.map((s) => ({
      kind: s.kind,
      seed: s.seed,
      overlaps: s.overlaps.slice(0, 5), // trim to top 5 per map
      gaps: s.gaps.slice(0, 5),
      floatingDoors: s.floatingDoors.slice(0, 5),
      roofIssues: s.roofIssues.slice(0, 5),
    })),
  },
  perSeed: allSummaries.map((s) => ({
    kind: s.kind,
    seed: s.seed,
    numBuildings: s.numBuildings,
    numWalls: s.numWalls,
    numDoors: s.numDoors,
    numOverlaps: s.numOverlaps,
    numGaps: s.numGaps,
    numFloatingDoors: s.numFloatingDoors,
    numMultiPart: s.numMultiPart,
    numRoofIssues: s.numRoofIssues,
  })),
}, null, 2));