import { EDGE, FLOOR_H, type EdgeType, type GameMap } from '../map';
import type { Building, DoorEdge, Rect } from '../mapgen';

// Mask-based structure stamper (docs/plans/2026-07-26-town-gen-design.md §3.3,
// T3). Where addBuilding walks the perimeter of one rect, this builds an
// occupancy mask over the union of a Building's `parts` and extracts the
// boundary as "the two tiles either side of this grid edge disagree". That is
// ~10 lines and it gets L, U, courtyard and church-with-tower for free, which
// a rect walker cannot express at all.
//
// Legacy addBuilding is deliberately left untouched and still serves every
// other map kind: refactoring it onto this path would risk a one-bit
// fingerprint drift for zero gain.

const MAX_PARTITION_DEPTH = 2; // §3.3 step 6
const MIN_PARTITION_SPAN = 8; // both halves must clear 4 tiles, matching addBuilding's `w >= 8`
const WINDOW_PERIOD = 3; // every 3rd position of an exterior run, phase 1 — as addBuilding's win()

// Boundary-edge classification, kept per grid edge over the mask's bbox.
const B_NONE = 0; // not a boundary of this mask
const B_EXTERIOR = 1; // faces open ground: windows may land here
const B_SHARED = 2; // faces an already-stamped structure: party wall or merged span
const B_DOOR = 3; // an opening from b.doors — part of a run for indexing, never a window

export const partsOf = (b: Building): Rect[] => b.parts ?? [{ x: b.x, y: b.y, w: b.w, h: b.h }];

// Storey count. There is no `stories` field in the frozen contract (§3.1), so
// it is derived: the >=56-tile 2-storey rule is the general case (pinned live
// by tests/perf.test.ts's height-stress scenario), and `role` overrides it only
// where the roll has to be forced — a 5x5 belfry is 25 tiles and must still be
// four storeys, a market halle is a roof on posts.
export function storiesOf(b: Building): number {
  if (b.role === 'church_tower') return 4;
  if (b.role === 'halle') return 1;
  // A nave and a mairie are two storeys because of what they ARE, not because
  // of their area: a 12x6 chapel on a tight churchyard is 72 tiles and would
  // clear the rule anyway, but a 7x6 one is 42 and would come out as a shed.
  if (b.role === 'church' || b.role === 'civic') return 2;
  let area = 0;
  for (const p of partsOf(b)) area += p.w * p.h;
  return area >= 56 ? 2 : 1;
}

const rectsOverlap = (a: Rect, c: Rect): boolean =>
  a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y;

const describe = (b: Building): string => `${b.role ?? 'house'}@${b.x},${b.y} ${b.w}x${b.h}`;

/**
 * Stamp one structure into the map and return its storey count.
 *
 * `id` is this call's index; the tiles get `buildingId = b.groupId ?? id`, so
 * the three masses of a church read as one building to floormenu, patches and
 * every other consumer that groups by buildingId.
 *
 * Shared spans are resolved AS THEY ARE MET rather than in a separate pass over
 * the finished map (a deviation from §3.3's post-pass — see the handoff): a
 * boundary edge's outside tile can only carry a buildingId if an EARLIER
 * stampStructure call claimed it, since this call's own tiles are all inside
 * the mask. So at the moment the edge is written we know exactly which case it
 * is, with no per-tile ownership array and no second traversal:
 *   - same buildingId  → EDGE.NONE, the interiors merge into one structure
 *   - different        → EDGE.WALL, top = max(their storeys, ours) * FLOOR_H,
 *                        which also overwrites any WINDOW the earlier
 *                        structure's run indexer left on what turned out to be
 *                        a party wall (a free LOS hole into the neighbour).
 */
export function stampStructure(map: GameMap, b: Building, id: number): number {
  const parts = partsOf(b);
  assertShape(b, parts);

  // bbox over parts with a 1-tile border, so every boundary edge has both of
  // its flanking tiles inside the mask array
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const p of parts) {
    if (p.x < bx0) bx0 = p.x;
    if (p.y < by0) by0 = p.y;
    if (p.x + p.w > bx1) bx1 = p.x + p.w;
    if (p.y + p.h > by1) by1 = p.y + p.h;
  }
  // hEdge is valid on x in [0,w) y in [0,h]; vEdge on x in [0,w] y in [0,h)
  // (map.ts:77-83 bounds-test neither, so a stray write silently lands on the
  // far side of the map). Keeping the whole footprint on-grid covers both.
  if (bx0 < 0 || by0 < 0 || bx1 > map.w || by1 > map.h)
    throw new Error(`stampStructure: ${describe(b)} extends outside the ${map.w}x${map.h} map`);

  const mx0 = bx0 - 1;
  const my0 = by0 - 1;
  const mw = bx1 - bx0 + 2;
  const mh = by1 - by0 + 2;
  const mask = new Uint8Array(mw * mh);
  for (const p of parts)
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) mask[(y - my0) * mw + (x - mx0)] = 1;
  const inMask = (x: number, y: number): boolean =>
    x >= mx0 && y >= my0 && x < mx0 + mw && y < my0 + mh && mask[(y - my0) * mw + (x - mx0)] === 1;

  const stories = storiesOf(b);
  const top = stories * FLOOR_H;
  const bid = b.groupId ?? id;
  if (bid < 0 || bid > 32767) throw new Error(`stampStructure: buildingId ${bid} does not fit map.buildingId (Int16Array)`);

  // ── interior ────────────────────────────────────────────────────────────
  for (let y = by0; y < by1; y++)
    for (let x = bx0; x < bx1; x++) {
      if (!inMask(x, y)) continue;
      const i = y * map.w + x;
      // Overlapping masses are the audit's confirmed corruption case: the
      // earlier structure's wall is stranded inside the later one's interior,
      // buildingIdAt resolves to the later mass only, and A* between them
      // returns null. Abutting or disjoint only.
      if (map.buildingId[i] >= 0)
        throw new Error(`stampStructure: ${describe(b)} overlaps building ${map.buildingId[i]} at ${x},${y}`);
      map.setTerrain(x, y, 'floor');
      map.stories[i] = stories;
      map.buildingId[i] = bid;
    }

  const putH = (x: number, y: number, e: EdgeType, t: number): void => {
    if (x < 0 || x >= map.w || y < 0 || y > map.h)
      throw new Error(`stampStructure: hEdge(${x},${y}) outside [0,${map.w}) x [0,${map.h}]`);
    map.setHEdge(x, y, e);
    map.hEdgeTops[y * map.w + x] = e === EDGE.WALL ? t : 0;
  };
  const putV = (x: number, y: number, e: EdgeType, t: number): void => {
    if (x < 0 || x > map.w || y < 0 || y >= map.h)
      throw new Error(`stampStructure: vEdge(${x},${y}) outside [0,${map.w}] x [0,${map.h})`);
    map.setVEdge(x, y, e);
    map.vEdgeTops[y * (map.w + 1) + x] = e === EDGE.WALL ? t : 0;
  };

  // A market halle is a roof on posts: floor, no envelope, no openings to cut
  // in one. Only the four corner posts are stamped, so the interior stays open
  // to foot from every side while the floor terrain keeps vehicles out.
  if (b.role === 'halle') {
    stampHalleCorners(putH, putV, bx0, by0, bx1, by1, top);
    return stories;
  }

  // ── boundary classification + walls ─────────────────────────────────────
  // hKind is indexed over grid lines y in [my0, my0+mh]; vKind over x in
  // [mx0, mx0+mw]. Both are local to this mask.
  const hKind = new Uint8Array(mw * (mh + 1));
  const vKind = new Uint8Array((mw + 1) * mh);
  const hAt = (x: number, y: number): number => (y - my0) * mw + (x - mx0);
  const vAt = (x: number, y: number): number => (y - my0) * (mw + 1) + (x - mx0);

  // `other` is the outside tile of a boundary edge: >= 0 means an earlier call
  // already owns it, which is the whole shared-span decision.
  const classify = (ox: number, oy: number): { kind: number; edge: EdgeType; t: number } => {
    const other = map.inBounds(ox, oy) ? map.buildingId[oy * map.w + ox] : -1;
    if (other < 0) return { kind: B_EXTERIOR, edge: EDGE.WALL, t: top };
    if (other === bid) return { kind: B_SHARED, edge: EDGE.NONE, t: 0 };
    const theirStories = map.stories[oy * map.w + ox];
    return { kind: B_SHARED, edge: EDGE.WALL, t: Math.max(theirStories, stories) * FLOOR_H };
  };

  for (let y = my0 + 1; y < my0 + mh; y++)
    for (let x = mx0; x < mx0 + mw; x++) {
      const above = inMask(x, y - 1);
      if (above === inMask(x, y)) continue;
      const c = classify(x, above ? y : y - 1);
      hKind[hAt(x, y)] = c.kind;
      putH(x, y, c.edge, c.t);
    }
  for (let y = my0; y < my0 + mh; y++)
    for (let x = mx0 + 1; x < mx0 + mw; x++) {
      const left = inMask(x - 1, y);
      if (left === inMask(x, y)) continue;
      const c = classify(left ? x : x - 1, y);
      vKind[vAt(x, y)] = c.kind;
      putV(x, y, c.edge, c.t);
    }

  // ── doors ───────────────────────────────────────────────────────────────
  const doors = resolveDoors(b, inMask);
  for (const d of doors)
    for (let k = 0; k < d.width; k++) {
      const dx = d.side === 'n' || d.side === 's' ? d.x + k : d.x;
      const dy = d.side === 'e' || d.side === 'w' ? d.y + k : d.y;
      if (!inMask(dx, dy)) throw new Error(`stampStructure: ${describe(b)} door at ${dx},${dy} is not a tile of the structure`);
      const horizontal = d.side === 'n' || d.side === 's';
      const ex = horizontal ? dx : d.side === 'e' ? dx + 1 : dx;
      const ey = horizontal ? (d.side === 's' ? dy + 1 : dy) : dy;
      const slot = horizontal ? hAt(ex, ey) : vAt(ex, ey);
      const kinds = horizontal ? hKind : vKind;
      if (kinds[slot] === B_NONE)
        throw new Error(`stampStructure: ${describe(b)} door ${d.side} of ${dx},${dy} is not on the structure's boundary`);
      if (kinds[slot] === B_SHARED)
        throw new Error(`stampStructure: ${describe(b)} door ${d.side} of ${dx},${dy} opens onto an abutting structure`);
      kinds[slot] = B_DOOR;
      if (horizontal) putH(ex, ey, EDGE.DOOR, 0);
      else putV(ex, ey, EDGE.DOOR, 0);
    }

  // ── windows, indexed per MAXIMAL EXTERIOR RUN ───────────────────────────
  // Per-run rather than per-rect is what stops a window landing on the joint
  // of an L. Doors stay inside the run so the rhythm is continuous; party-wall
  // spans break it, because a WINDOW there is a free LOS hole next door.
  const runWindows = (
    length: number,
    kindAt: (i: number) => number,
    place: (i: number) => void,
  ): void => {
    let runStart = -1;
    for (let i = 0; i <= length; i++) {
      const k = i < length ? kindAt(i) : B_NONE;
      if (k === B_EXTERIOR || k === B_DOOR) {
        if (runStart < 0) runStart = i;
        continue;
      }
      if (runStart >= 0) {
        for (let j = runStart; j < i; j++)
          if ((j - runStart) % WINDOW_PERIOD === 1 && kindAt(j) === B_EXTERIOR) place(j);
        runStart = -1;
      }
    }
  };
  for (let y = my0 + 1; y < my0 + mh; y++)
    runWindows(
      mw,
      (i) => hKind[hAt(mx0 + i, y)],
      (i) => putH(mx0 + i, y, EDGE.WINDOW, 0),
    );
  for (let x = mx0 + 1; x < mx0 + mw; x++)
    runWindows(
      mh,
      (i) => vKind[vAt(x, my0 + i)],
      (i) => putV(x, my0 + i, EDGE.WINDOW, 0),
    );

  // ── interior partitions ─────────────────────────────────────────────────
  partition(bx0, by0, bx1, by1, 0, inMask, putH, putV, top);

  // ── stair ───────────────────────────────────────────────────────────────
  // path.ts:132-155 treats a stair tile as connecting any adjacent pair of
  // levels, so one column serves all four floors of a tower.
  if (stories >= 2) {
    const anchor = doors[0];
    let bestI = -1;
    let bestD2 = -1;
    let fallbackI = -1;
    let fallbackD2 = -1;
    for (let y = by0; y < by1; y++)
      for (let x = bx0; x < bx1; x++) {
        if (!inMask(x, y)) continue;
        const d2 = (x - anchor.x) * (x - anchor.x) + (y - anchor.y) * (y - anchor.y);
        if (d2 > fallbackD2) {
          fallbackD2 = d2;
          fallbackI = y * map.w + x;
        }
        // an interior tile only: a stair in a 1-wide wing is walled off on
        // three sides and reads as a dead end
        if (!inMask(x - 1, y) || !inMask(x + 1, y) || !inMask(x, y - 1) || !inMask(x, y + 1)) continue;
        if (d2 > bestD2) {
          bestD2 = d2;
          bestI = y * map.w + x;
        }
      }
    map.stairs[bestI >= 0 ? bestI : fallbackI] = 1;
  }

  return stories;
}

function assertShape(b: Building, parts: Rect[]): void {
  if (parts.length === 0) throw new Error(`stampStructure: ${describe(b)} has an empty parts list`);
  const p0 = parts[0];
  // buildingCenter (bridge.ts:63) derives a garrison post from {x,y,w,h}; if
  // parts[0] is not that rect the post can land off the structure entirely.
  if (p0.x !== b.x || p0.y !== b.y || p0.w !== b.w || p0.h !== b.h)
    throw new Error(
      `stampStructure: ${describe(b)} parts[0] is ${p0.x},${p0.y} ${p0.w}x${p0.h} — it must equal the primary mass`,
    );
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].w < 1 || parts[i].h < 1) throw new Error(`stampStructure: ${describe(b)} part ${i} is degenerate`);
    for (let j = i + 1; j < parts.length; j++)
      if (rectsOverlap(parts[i], parts[j])) throw new Error(`stampStructure: ${describe(b)} parts ${i} and ${j} overlap`);
  }
}

// Fall back to addBuilding's convention when a caller supplies no doors: one
// opening mid-span on the street side. Scans outward from mid-span for the
// first position that is genuinely on the mask boundary, then tries the other
// faces, so a plot whose frontage face is entirely party wall still gets a way in.
function resolveDoors(b: Building, inMask: (x: number, y: number) => boolean): DoorEdge[] {
  if (b.doors && b.doors.length > 0) return b.doors;
  const sides: DoorEdge['side'][] = [b.frontage ?? 's', 's', 'n', 'e', 'w'];
  for (const side of sides) {
    const along = side === 'n' || side === 's' ? b.w : b.h;
    const mid = along >> 1;
    for (let step = 0; step < along; step++) {
      // walk mid, mid+1, mid-1, mid+2, … so the door stays as central as possible
      const k = mid + (step % 2 === 0 ? step >> 1 : -((step + 1) >> 1));
      if (k < 0 || k >= along) continue;
      const x = side === 'n' || side === 's' ? b.x + k : side === 'w' ? b.x : b.x + b.w - 1;
      const y = side === 'e' || side === 'w' ? b.y + k : side === 'n' ? b.y : b.y + b.h - 1;
      const ox = side === 'e' ? x + 1 : side === 'w' ? x - 1 : x;
      const oy = side === 's' ? y + 1 : side === 'n' ? y - 1 : y;
      if (inMask(x, y) && !inMask(ox, oy)) return [{ x, y, side, width: 1 }];
    }
  }
  throw new Error(`stampStructure: ${describe(b)} has no boundary face to put a door on`);
}

// EDGE.WALL only at the four corner posts (§1.3 / §3.3): each corner gets its
// two meeting boundary edges, everything else on the perimeter stays open.
function stampHalleCorners(
  putH: (x: number, y: number, e: EdgeType, t: number) => void,
  putV: (x: number, y: number, e: EdgeType, t: number) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  top: number,
): void {
  for (const [cx, cy, sx, sy] of [
    [x0, y0, 0, 0],
    [x1 - 1, y0, 1, 0],
    [x0, y1 - 1, 0, 1],
    [x1 - 1, y1 - 1, 1, 1],
  ]) {
    putH(cx, sy ? y1 : y0, EDGE.WALL, top);
    putV(sx ? x1 : x0, cy, EDGE.WALL, top);
  }
}

// Recursive AABB split of the mask, depth <= 2. The wall line is written only
// where BOTH flanking tiles are inside the mask, so it can never overwrite the
// envelope, and each contiguous run of it gets its own door — an L whose waist
// the cut crosses twice would otherwise seal a wing off.
function partition(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  depth: number,
  inMask: (x: number, y: number) => boolean,
  putH: (x: number, y: number, e: EdgeType, t: number) => void,
  putV: (x: number, y: number, e: EdgeType, t: number) => void,
  top: number,
): void {
  if (depth >= MAX_PARTITION_DEPTH) return;
  const rw = x1 - x0;
  const rh = y1 - y0;
  const vertical = rw >= rh;
  const span = vertical ? rw : rh;
  if (span < MIN_PARTITION_SPAN) return;
  const cut = (vertical ? x0 : y0) + (span >> 1);

  const lo = vertical ? y0 : x0;
  const hi = vertical ? y1 : x1;
  const inside = (k: number): boolean =>
    vertical ? inMask(cut - 1, k) && inMask(cut, k) : inMask(k, cut - 1) && inMask(k, cut);
  const put = (k: number, e: EdgeType, t: number): void =>
    vertical ? putV(cut, k, e, t) : putH(k, cut, e, t);

  let runStart = -1;
  for (let k = lo; k <= hi; k++) {
    if (k < hi && inside(k)) {
      if (runStart < 0) runStart = k;
      put(k, EDGE.WALL, top);
      continue;
    }
    if (runStart >= 0) {
      put((runStart + k - 1) >> 1, EDGE.DOOR, 0); // one door per contiguous run, mid-run
      runStart = -1;
    }
  }

  if (vertical) {
    partition(x0, y0, cut, y1, depth + 1, inMask, putH, putV, top);
    partition(cut, y0, x1, y1, depth + 1, inMask, putH, putV, top);
  } else {
    partition(x0, y0, x1, cut, depth + 1, inMask, putH, putV, top);
    partition(x0, cut, x1, y1, depth + 1, inMask, putH, putV, top);
  }
}
