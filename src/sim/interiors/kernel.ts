import { partsOf } from '../bourg/stamp';
import { TERRAIN } from '../data';
import { EDGE, FLOOR_H, type EdgeType, type GameMap } from '../map';
import type { Building } from '../mapgen';
import type { FurnitureKey, Structure } from './types';

// ═══ INTERIORS — THE KERNEL (I3) ════════════════════════════════════════════
//
// docs/plans/2026-07-26-interiors-design.md §3.1, §4.1, §4.2 and D10, against
// the contract frozen in ./types.ts. Nothing here decides what a room IS — that
// is I4/I5/I6. This file owns the five primitives every partitioner and the
// furnishing pass share, and it is where a bug corrupts the far side of the map
// silently, so every one of them is bounds-checked or mask-checked:
//
//   structuresOf   grouping Buildings into Structures (types.ts §B)
//   interiorOf     the mass read OFF THE MAP, the exterior doors, the stairs
//   resetInterior  D10: this pass owns interior edges and clears them first
//   wallRun        one straight partition line, with the deterministic door rule
//   reachInterior  the 8-connected BFS that mirrors path.ts's corner rule
//   keepClear      the mask K of §4.1
//   Furnisher      the commit rule of §4.2 — the non-sealing guarantee
//
// ORDER OF OPERATIONS, per structure. It is not interchangeable:
//
//   1. interiorOf     — reads the mass, the exterior doors and the stairs
//   2. resetInterior  — D10; every later step assumes a clean interior
//   3. planRooms      — rooms.ts / church.ts; writes the partition walls AND
//                       the interior doors
//   4. keepClear      — must run AFTER 3, because seed 2 reads the interior
//                       doors the partitioner just wrote and seed 6 needs its
//                       RoomPlan.spine
//   5. new Furnisher  — snapshots reachability from the primary door as it
//                       stands after 3, then guards every candidate group

// The working form of a Structure: its mass as a local-frame bitmask over the
// bbox of its rects, plus everything the partitioners and the mask builder need
// to read. Built once per structure by `interiorOf`.
//
// NOT part of the I2 freeze — I3 adds it. The local frame is
// `(y - y0) * w + (x - x0)` over the bbox, which is the frame `keepClear` and
// `reachInterior` both return their masks in.
export interface Interior {
  struct: Structure;
  id: number; // the shared map.buildingId of every tile of the mass
  x0: number;
  y0: number;
  w: number; // bbox extent, NOT the tile count
  h: number;
  mask: Uint8Array; // w*h; 1 = a tile of this mass
  tiles: number[]; // map tile indices (y * map.w + x), ASCENDING
  doors: ExteriorDoor[]; // §D order: by interior tile index, then side
  stairs: number[]; // map tile indices of this mass's stair tiles, ascending
  // Wall-top height (m) for every interior partition this pass writes: the
  // MAXIMUM storey count over the mass * FLOOR_H. Max rather than per-edge
  // because the only mass where the two flanks disagree is a church group
  // (nave 2, tower 4), where the design's rule for the shared span is
  // explicitly `max` anyway. All partition edges of a single-storey-count mass
  // get exactly what stampStructure would have given them.
  top: number;
}

// An EDGE.DOOR with exactly one flanking tile in the mass (types.ts §D). `x,y`
// is the INTERIOR tile; `side` is the outward face, so the edge itself is
// hEdge(x,y) for 'n', hEdge(x,y+1) for 's', vEdge(x,y) for 'w', vEdge(x+1,y)
// for 'e' — the same convention as mapgen's DoorEdge.
export interface ExteriorDoor {
  x: number;
  y: number;
  side: 'n' | 's' | 'e' | 'w';
}

const SIDE_RANK: Record<ExteriorDoor['side'], number> = { n: 0, s: 1, e: 2, w: 3 };

export const inMass = (it: Interior, x: number, y: number): boolean =>
  x >= it.x0 && y >= it.y0 && x < it.x0 + it.w && y < it.y0 + it.h && it.mask[(y - it.y0) * it.w + (x - it.x0)] === 1;

export const localIndex = (it: Interior, x: number, y: number): number => (y - it.y0) * it.w + (x - it.x0);

// ── structures (types.ts §B) ────────────────────────────────────────────────
//
// Two Buildings are in the same Structure iff both carry `groupId` and the two
// values are equal; a Building without one is its own Structure. The id is read
// off the MAP at the leader's centre tile, never reconstructed — that is the
// one place a church's three masses agree.
export function structuresOf(map: GameMap, buildings: readonly Building[]): Structure[] {
  const out: Structure[] = [];
  const byGroup = new Map<number, Structure>();
  for (const b of buildings) {
    const gid = b.groupId;
    const existing = gid === undefined ? undefined : byGroup.get(gid);
    if (existing) {
      existing.buildings.push(b);
      for (const p of partsOf(b)) existing.rects.push(p);
      continue;
    }
    const s: Structure = { buildings: [b], id: -1, rects: partsOf(b).slice() };
    out.push(s);
    if (gid !== undefined) byGroup.set(gid, s);
  }
  for (const s of out) {
    const b0 = s.buildings[0];
    s.id = map.buildingIdAt(b0.x + (b0.w >> 1), b0.y + (b0.h >> 1));
  }
  return out;
}

// The mass, read off the map. Returns null when there is nothing to work with:
// no buildingId at the leader's centre (a `halle` stamps no interior the pass
// could own, and an unstamped Building has none at all), or an empty mass.
export function interiorOf(map: GameMap, struct: Structure): Interior | null {
  if (struct.id < 0 || struct.rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of struct.rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(map.w, x1);
  y1 = Math.min(map.h, y1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const mask = new Uint8Array(w * h);
  const tiles: number[] = [];
  const stairs: number[] = [];
  let maxStories = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * map.w + x;
      if (map.buildingId[i] !== struct.id) continue;
      mask[(y - y0) * w + (x - x0)] = 1;
      tiles.push(i);
      if (map.stairs[i] === 1) stairs.push(i);
      if (map.stories[i] > maxStories) maxStories = map.stories[i];
    }
  if (tiles.length === 0) return null;

  const it: Interior = {
    struct,
    id: struct.id,
    x0,
    y0,
    w,
    h,
    mask,
    tiles,
    doors: [],
    stairs,
    top: Math.max(1, maxStories) * FLOOR_H,
  };
  it.doors = exteriorDoors(map, it);
  return it;
}

// An exterior door is an EDGE.DOOR with exactly ONE flanking tile in the mass.
// Recovered from the map rather than from `Building.doors` because legacy kinds
// emit no `doors` at all and the map is what both stampers actually wrote.
function exteriorDoors(map: GameMap, it: Interior): ExteriorDoor[] {
  const out: ExteriorDoor[] = [];
  const x1 = it.x0 + it.w;
  const y1 = it.y0 + it.h;
  for (let y = it.y0; y <= y1; y++)
    for (let x = it.x0; x < x1; x++) {
      if (map.hEdge(x, y) !== EDGE.DOOR) continue;
      const north = inMass(it, x, y - 1);
      const south = inMass(it, x, y);
      if (north === south) continue; // interior door, or nothing to do with us
      out.push(north ? { x, y: y - 1, side: 's' } : { x, y, side: 'n' });
    }
  for (let y = it.y0; y < y1; y++)
    for (let x = it.x0; x <= x1; x++) {
      if (map.vEdge(x, y) !== EDGE.DOOR) continue;
      const west = inMass(it, x - 1, y);
      const east = inMass(it, x, y);
      if (west === east) continue;
      out.push(west ? { x: x - 1, y, side: 'e' } : { x, y, side: 'w' });
    }
  out.sort((a, b) => a.y * map.w + a.x - (b.y * map.w + b.x) || SIDE_RANK[a.side] - SIDE_RANK[b.side]);
  return out;
}

// ── D10 · this pass owns interior edges, and clears them first ──────────────
//
// Every edge whose two flanking tiles are BOTH in this mass becomes EDGE.NONE
// with top 0. Restricted to THIS mass rather than to the frozen contract's
// literal "both buildingId >= 0 and equal": a group's bbox can contain an
// abutting neighbour's tiles, and the literal predicate would wipe that
// neighbour's already-written partitions. Party walls between different
// buildingIds, and the whole exterior envelope, have one flank outside the mass
// and are therefore never touched.
export function resetInterior(map: GameMap, it: Interior): void {
  const x1 = it.x0 + it.w;
  const y1 = it.y0 + it.h;
  for (let y = it.y0 + 1; y < y1; y++)
    for (let x = it.x0; x < x1; x++) {
      if (!inMass(it, x, y - 1) || !inMass(it, x, y)) continue;
      map.setHEdge(x, y, EDGE.NONE);
      map.hEdgeTops[y * map.w + x] = 0;
    }
  for (let y = it.y0; y < y1; y++)
    for (let x = it.x0 + 1; x < x1; x++) {
      if (!inMass(it, x - 1, y) || !inMass(it, x, y)) continue;
      map.setVEdge(x, y, EDGE.NONE);
      map.vEdgeTops[y * (map.w + 1) + x] = 0;
    }
}

// ── edge writes, bounds-checked ─────────────────────────────────────────────
//
// `setHEdge`/`setVEdge` bounds-test NOTHING: a `setVEdge(w + 1, y)` silently
// lands on `vEdge(0, y + 1)`, which is a corruption on the far side of the map
// that no interiors test would ever look at. Valid domains are
// hEdge x ∈ [0,w) y ∈ [0,h] and vEdge x ∈ [0,w] y ∈ [0,h). Same throwing
// wrappers as stampStructure's putH/putV; exported because I6's arcades write
// WALL/NONE patterns that are not wall RUNS.
export function putH(map: GameMap, x: number, y: number, e: EdgeType, top: number): void {
  if (x < 0 || x >= map.w || y < 0 || y > map.h)
    throw new Error(`interiors: hEdge(${x},${y}) outside [0,${map.w}) x [0,${map.h}]`);
  map.setHEdge(x, y, e);
  map.hEdgeTops[y * map.w + x] = e === EDGE.WALL ? top : 0;
}

export function putV(map: GameMap, x: number, y: number, e: EdgeType, top: number): void {
  if (x < 0 || x > map.w || y < 0 || y >= map.h)
    throw new Error(`interiors: vEdge(${x},${y}) outside [0,${map.w}] x [0,${map.h})`);
  map.setVEdge(x, y, e);
  map.vEdgeTops[y * (map.w + 1) + x] = e === EDGE.WALL ? top : 0;
}

export interface WallRunOpts {
  doors?: boolean; // default true — false writes a solid line (tack-room L, arcade backing)
}

/**
 * One straight interior partition line.
 *
 * `axis: 'h'` writes hEdge(k, fixed) for k in [from, to), whose flanking tiles
 * are (k, fixed-1) and (k, fixed). `axis: 'v'` writes vEdge(fixed, k), flanks
 * (fixed-1, k) and (fixed, k). A position is written ONLY where both flanks are
 * in the mass, exactly as stampStructure's partition does, so the line can
 * never overwrite the envelope and an L whose cut crosses the waist twice does
 * not seal a wing off — each contiguous run gets its OWN door.
 *
 * DEVIATION from §3.1's `wallRun(axis, fixed, from, to, doorAt, top)`: the
 * `doorAt` parameter is replaced by `seed`, the circulation tile. §3.1 also
 * specifies the door rule ("the run position that is not the first or last of
 * the run and minimises Manhattan distance to the circulation seed, ties to the
 * lower index"), which makes `doorAt` redundant — and a single `doorAt` cannot
 * serve the several contiguous runs one line can break into.
 *
 * Returns the `along` coordinate of every door written, in ascending order.
 */
export function wallRun(
  map: GameMap,
  it: Interior,
  axis: 'h' | 'v',
  fixed: number,
  from: number,
  to: number,
  top: number,
  seed: { x: number; y: number } | null,
  opts: WallRunOpts = {},
): number[] {
  const doors = opts.doors !== false;
  const horizontal = axis === 'h';
  // Assert the whole run's domain up front, not just the positions that happen
  // to land on the mask. A run that is entirely off-mask writes nothing, so the
  // per-write guards in putH/putV would never fire and a transposed
  // (fixed, from) pair would look like a silently empty wall instead of a bug.
  const fixedMax = horizontal ? map.h : map.w;
  const alongMax = horizontal ? map.w : map.h;
  if (fixed < 0 || fixed > fixedMax)
    throw new Error(`interiors wallRun: ${axis}Edge line ${fixed} outside [0,${fixedMax}]`);
  if (from < 0 || to > alongMax)
    throw new Error(`interiors wallRun: ${axis}Edge span [${from},${to}) outside [0,${alongMax})`);
  const inside = (k: number): boolean =>
    horizontal
      ? inMass(it, k, fixed - 1) && inMass(it, k, fixed)
      : inMass(it, fixed - 1, k) && inMass(it, fixed, k);
  const put = (k: number, e: EdgeType, t: number): void =>
    horizontal ? putH(map, k, fixed, e, t) : putV(map, fixed, k, e, t);
  // Manhattan distance from the seed to the run position. The component
  // perpendicular to the run is constant across it, so this ranks exactly as
  // §3.1's rule does while staying a plain integer comparison.
  const dist = (k: number): number =>
    seed === null ? 0 : horizontal ? Math.abs(k - seed.x) + Math.abs(fixed - seed.y) : Math.abs(k - seed.y) + Math.abs(fixed - seed.x);

  const placed: number[] = [];
  let runStart = -1;
  for (let k = from; k <= to; k++) {
    if (k < to && inside(k)) {
      if (runStart < 0) runStart = k;
      put(k, EDGE.WALL, top);
      continue;
    }
    if (runStart < 0) continue;
    if (doors) {
      // never the first or last position of a run (a door in the corner of a
      // room is unusable); a 1- or 2-long run has no such position, so it takes
      // its whole span as candidates rather than going doorless.
      const len = k - runStart;
      const lo = len >= 3 ? runStart + 1 : runStart;
      const hi = len >= 3 ? k - 1 : k;
      let best = lo;
      let bestD = dist(lo);
      for (let c = lo + 1; c < hi; c++) {
        const d = dist(c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      put(best, EDGE.DOOR, 0);
      placed.push(best);
    }
    runStart = -1;
  }
  return placed;
}

// ── the connectivity BFS (§4.2) ─────────────────────────────────────────────
//
// 8-connected, mirroring path.ts's expansion EXACTLY: the same four
// `map.canStep` calls on a diagonal (no corner cutting), the same single call
// on an orthogonal, and — as astar and reachField both do — the start tile is
// seeded regardless of its own passability.
//
// One deliberate difference: every tile of every L-path must also be IN THE
// MASS. astar has no such restriction, so this BFS is strictly the more
// pessimistic of the two — two rects of one mass that touch only at a corner
// read as disconnected here even though the outside world may let a soldier
// walk round. Pessimistic is the safe direction for a non-sealing test: it can
// only refuse furniture that would in fact have been fine.
//
// `block` is an optional local-frame overlay of tiles to treat as impassable —
// the candidate group, which has not been written to the map yet.
export function reachInterior(
  map: GameMap,
  it: Interior,
  sx: number,
  sy: number,
  block: Uint8Array | null,
): Uint8Array {
  const reached = new Uint8Array(it.w * it.h);
  if (!inMass(it, sx, sy)) return reached;
  const step = (ax: number, ay: number, bx: number, by: number): boolean => {
    if (!inMass(it, bx, by)) return false;
    if (block !== null && block[localIndex(it, bx, by)] === 1) return false;
    return map.canStep(ax, ay, bx, by, 'foot');
  };
  const stack: number[] = [sy * map.w + sx];
  reached[localIndex(it, sx, sy)] = 1;
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const cx = cur % map.w;
    const cy = (cur / map.w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inMass(it, nx, ny)) continue;
        const li = localIndex(it, nx, ny);
        if (reached[li] === 1) continue;
        const ok =
          dx !== 0 && dy !== 0
            ? step(cx, cy, nx, cy) && step(nx, cy, nx, ny) && step(cx, cy, cx, ny) && step(cx, ny, nx, ny)
            : step(cx, cy, nx, ny);
        if (!ok) continue;
        reached[li] = 1;
        stack.push(ny * map.w + nx);
      }
  }
  return reached;
}

// Every passable tile of the mass that is NOT reachable from (sx,sy). The
// non-sealing invariant, stated as the thing a test can print.
export function unreachedFrom(map: GameMap, it: Interior, sx: number, sy: number): number[] {
  const reached = reachInterior(map, it, sx, sy, null);
  const out: number[] = [];
  for (const t of it.tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    if (!map.terrainAt(x, y).passable) continue;
    if (reached[localIndex(it, x, y)] !== 1) out.push(t);
  }
  return out;
}

// §4.2's post-pass assertion: BFS from EVERY exterior door reaches every
// passable interior tile. Returns the offending tiles (empty = clean).
export function sealedTiles(map: GameMap, it: Interior): number[] {
  const bad = new Set<number>();
  for (const d of it.doors) for (const t of unreachedFrom(map, it, d.x, d.y)) bad.add(t);
  return [...bad].sort((a, b) => a - b);
}

// ── §4.1 · the keep-clear mask K ────────────────────────────────────────────
//
// Deterministic, draws NO rng. Local frame, 1 = keep clear. A candidate
// furniture group intersecting K is rejected outright. `spine` is the
// partitioner's circulation tile list (RoomPlan.spine) — seed 6.
export function keepClear(map: GameMap, it: Interior, spine: readonly number[] = []): Uint8Array {
  const k = new Uint8Array(it.w * it.h);
  const mark = (x: number, y: number): void => {
    if (inMass(it, x, y)) k[localIndex(it, x, y)] = 1;
  };
  const x1 = it.x0 + it.w;
  const y1 = it.y0 + it.h;

  // 1+2. doors. Every flanking tile in the mass, and for an EXTERIOR door (one
  // flank only) one tile further in along the inward normal — the 2-tile apron.
  // The apron is correctness, not decoration: terrain.ts's drawDoorTrails
  // decides internal-vs-external by comparing `floor` on both flanks, so
  // furniture inside an exterior door deletes the door-wear trail.
  for (let y = it.y0; y <= y1; y++)
    for (let x = it.x0; x < x1; x++) {
      if (map.hEdge(x, y) !== EDGE.DOOR) continue;
      const north = inMass(it, x, y - 1);
      const south = inMass(it, x, y);
      if (north) mark(x, y - 1);
      if (south) mark(x, y);
      if (north !== south) mark(x, north ? y - 2 : y + 1);
    }
  for (let y = it.y0; y < y1; y++)
    for (let x = it.x0; x <= x1; x++) {
      if (map.vEdge(x, y) !== EDGE.DOOR) continue;
      const west = inMass(it, x - 1, y);
      const east = inMass(it, x, y);
      if (west) mark(x - 1, y);
      if (east) mark(x, y);
      if (west !== east) mark(west ? x - 2 : x + 1, y);
    }

  // 3. window nooks — 1-tile standing room behind every exterior window.
  for (let y = it.y0; y <= y1; y++)
    for (let x = it.x0; x < x1; x++) {
      if (map.hEdge(x, y) !== EDGE.WINDOW) continue;
      mark(x, y - 1);
      mark(x, y);
    }
  for (let y = it.y0; y < y1; y++)
    for (let x = it.x0; x <= x1; x++) {
      if (map.vEdge(x, y) !== EDGE.WINDOW) continue;
      mark(x - 1, y);
      mark(x, y);
    }

  // 4. stairs and their four orthogonal neighbours — validate requires stair
  // reachability, and the landing is the choke: it has to be fightable.
  for (const t of it.stairs) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    mark(x, y);
    mark(x - 1, y);
    mark(x + 1, y);
    mark(x, y - 1);
    mark(x, y + 1);
  }

  // 5. the centre tile of EVERY building of the structure, unconditionally, on
  // every kind: `validate` probes exactly this tile and astar returns null
  // immediately on an impassable goal, so one table there rejects the map.
  for (const b of it.struct.buildings) mark(b.x + (b.w >> 1), b.y + (b.h >> 1));

  // 6. the spine. Circulation is the plan.
  for (const t of spine) mark(t % map.w, (t / map.w) | 0);

  return k;
}

// ── §4.2 · the commit rule ──────────────────────────────────────────────────
//
// Furniture is emitted as GROUPS and each is accepted or refused by geometry
// alone: rejection consumes NO rng, because the draws happen when the candidate
// is GENERATED. Never re-roll on reject — it desynchronises every later
// structure.
//
// The invariant is stated against the CURRENT reachable set rather than against
// "every open tile", which is what makes it robust: a mass whose two rects meet
// only at a corner is already disconnected under this BFS (see reachInterior)
// through no fault of any furniture, and comparing against `mass \ impassable`
// there would reject every candidate forever and silently leave the building
// bare. Comparing against the current set says exactly what the design promises
// — furniture never cuts anything off from anything — and says it for a
// disconnected mass too.
export class Furnisher {
  readonly start: { x: number; y: number };
  readonly placed: number[] = [];
  private reach: Uint8Array;
  private readonly scratch: Uint8Array;

  constructor(
    private readonly map: GameMap,
    readonly it: Interior,
    readonly keep: Uint8Array,
  ) {
    const d = it.doors[0];
    this.start = d ? { x: d.x, y: d.y } : { x: it.tiles[0] % map.w, y: (it.tiles[0] / map.w) | 0 };
    this.reach = reachInterior(map, it, this.start.x, this.start.y, null);
    this.scratch = new Uint8Array(it.w * it.h);
  }

  /** Tiles reachable from the primary door right now, local frame. */
  get reachable(): Uint8Array {
    return this.reach;
  }

  /**
   * Write one candidate group, or refuse it. Returns whether it landed.
   *
   * `tiles` are map tile indices. A passable key skips the BFS: it cannot
   * change the open set, only its move cost, so it can never seal.
   */
  place(tiles: readonly number[], key: FurnitureKey): boolean {
    const { map, it, keep } = this;
    if (tiles.length === 0) return false;
    this.scratch.fill(0);
    for (const t of tiles) {
      const x = t % map.w;
      const y = (t / map.w) | 0;
      if (!inMass(it, x, y)) return false;
      const li = localIndex(it, x, y);
      if (keep[li] === 1) return false;
      if (this.scratch[li] === 1) return false; // a tile listed twice
      if (map.terrainKeyAt(x, y) !== 'floor') return false; // already committed, or never floor
      this.scratch[li] = 1;
    }
    if (!TERRAIN[key].passable) {
      const next = reachInterior(map, it, this.start.x, this.start.y, this.scratch);
      for (let i = 0; i < this.reach.length; i++)
        if (this.reach[i] === 1 && this.scratch[i] === 0 && next[i] !== 1) return false;
      this.reach = next;
    }
    for (const t of tiles) {
      map.setTerrain(t % map.w, (t / map.w) | 0, key);
      this.placed.push(t);
    }
    map.hasFurniture = true;
    return true;
  }
}
