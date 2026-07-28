import { EYE_H, los, type GameMap } from './map';
import type { Vec } from './mapgen';
import type { Rng } from './rng';

// ═══ SIGHTLINES — one lane per objective a defender can actually cover ══════
//
// Every other rule in generation is a CAP that PREVENTS a long lane: the street
// jogs 2-3 tiles (bourg/streets.ts), the arterial straight-run cap, the place
// widening clipped to the landmark. There is exactly one pass that deliberately
// CREATES a firing ground — the clearing guaranteed astride the arterial
// (bourg/rural.ts) — and this is the second, written to the same shape: measure
// first, act only where the measurement says the map failed, and guarantee the
// result rather than sample for it.
//
// WHAT THE MEASUREMENT SAID. 320x240, seeds 1-8, six kinds, 341 objectives;
// the longest bearing a standing eye on the objective can see continuously
// along, in tiles. scripts/sightlines.mjs prints this table.
//
//   kind     before: min p10 median under15   after: min p10 median under15
//   bourg             14  46     60       1           14  46     60       1
//   road              30  42     60       0           30  42     60       0
//   open               3  28     59       6           14  33     59       1
//   river              3  22     55       6           14  32     56       1
//   bridge             3  14     60       7           14  35     60       1
//   woods              3   3     45      12            7  17     45       2
//   ALL                3  21     60      32            7  32     60       6
//
// The bourg and the road were already fine and the pass writes NOT ONE TILE on
// either (measured: 0 of 413 cleared tiles): their worst objective already sees
// 14-30 tiles, and the street jogs that cap them there are a deliberate rule.
//
// The deficit was entirely rural and it was severe. 24 of the 32 short
// objectives were the WOODS STAND, where the canopy blocks a standing eye at 3
// tiles in EVERY direction: a squad on that objective cannot see its own
// approach, so the attack arrives by walking into it, which is the opposite of
// a firefight.
//
// 26 of the 32 are opened. The 6 left are all `street` objectives hemmed in by
// buildings and enclosure walls — the pass refusing, correctly, to do the one
// thing it must never do. Cost: 413 tiles over 48 maps (8.6 a map, 16.5 among
// the 25 maps that needed anything), every one of them woods (339) or hedge
// (74) going to grass. Nothing else on the map moves: not an edge, not an
// elevation, not a storey, not a buildingId, not a stair.
//
// THE RULES, and every one of them is a hard NEVER:
//  - a candidate bearing is abandoned outright if the line crosses a building
//    tile, an impassable tile, or an edge a soldier cannot step through. No
//    building is ever deleted, no wall is ever cut, no water is ever filled.
//  - only tiles with OPACITY are cleared, and only to `grass`: woods and hedge
//    are the only two (data.ts), so the pass thins canopy and nothing else. It
//    never writes over a road, a floor, a bank or a deck.
//  - clearing can only ADD passability (woods and hedge are noVehicle, grass is
//    not), so `validate`'s foot and vehicle gates and the rear-garden network's
//    single foot component cannot be broken by it — a pass that only opens
//    ground cannot disconnect any.
//  - the bourg's street rules are untouched because the bourg never qualifies.
//
// WHERE IT RUNS, and this is a deliberate DEVIATION from the brief's "after
// stampBourg, before elevateBourg". A standing eye-line is blocked by GROUND as
// well as by walls (map.ts's `elev >= lineZ` test), and elevation is written
// after both. Measured: short lanes exist whose bearing carries nothing opaque
// at all — they are cut by the GROUND, and no amount of thinning canopy would
// have found them. A pass that measured on the flat map would carve rides that
// a dome then closes and would be blind to the deficits the domes create. It
// therefore runs LAST, on the finished map, where what it measures is what the
// player gets. Wall tops — the brief's reason for the position — are equally
// final there.

const LANE = 15; // tiles: the lane a defender must be able to cover
const TRIES = 8; // cheapest candidate bearings actually attempted

// Candidate bearings are the integer tiles at Euclidean distance LANE — the
// circle, not the square, so a diagonal lane is the same length as an axial
// one. No trigonometry anywhere: mapgen's header bans Math.hypot because it is
// not guaranteed correctly-rounded across engines and Math.cos/Math.sin carry
// exactly the same risk. Integer multiplies and comparisons carry none.
const RING: readonly [number, number][] = (() => {
  const out: [number, number][] = [];
  const lo = (LANE * 2 - 1) * (LANE * 2 - 1);
  const hi = (LANE * 2 + 1) * (LANE * 2 + 1);
  for (let y = -LANE; y <= LANE; y++)
    for (let x = -LANE; x <= LANE; x++) {
      const d4 = 4 * (x * x + y * y);
      if (d4 >= lo && d4 <= hi) out.push([x, y]);
    }
  return out;
})();

/**
 * The tiles a ray from the centre of the objective to the centre of
 * `(ox+ex, oy+ey)` crosses, in order, excluding the objective's own tile.
 *
 * Amanatides & Woo, stepping exactly as `los` does — same initial tMax off a
 * tile centre, same `tMaxX < tMaxY` tie-break — so this walks the same tiles
 * `los` walks and a tile it misses is one `los` never looks at either. It is
 * the traversal that is shared, never the RULES: what blocks a lane is `los`'s
 * business and is asked of `los` below.
 *
 * Divisions and comparisons only. IEEE-754 makes both exact, so this is
 * cross-engine deterministic in a way a `cos`-driven sweep would not be.
 */
function rayTiles(ex: number, ey: number): [number, number][] {
  const out: [number, number][] = [];
  let tx = 0;
  let ty = 0;
  const stepX = ex > 0 ? 1 : -1;
  const stepY = ey > 0 ? 1 : -1;
  const tDeltaX = ex !== 0 ? Math.abs(1 / ex) : Infinity;
  const tDeltaY = ey !== 0 ? Math.abs(1 / ey) : Infinity;
  let tMaxX = ex !== 0 ? 0.5 * tDeltaX : Infinity;
  let tMaxY = ey !== 0 ? 0.5 * tDeltaY : Infinity;
  while (tx !== ex || ty !== ey) {
    if (tMaxX < tMaxY) {
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      ty += stepY;
      tMaxY += tDeltaY;
    }
    out.push([tx, ty]);
  }
  return out;
}

// One traversal per bearing, shared by every objective on every map.
const RAYS: readonly (readonly [number, number][])[] = RING.map(([ex, ey]) => rayTiles(ex, ey));

/**
 * Can a standing eye on the objective see continuously out along this bearing?
 *
 * `los` is the authority on what blocks — opacity, wall tops, storey slabs and
 * ground — and it is called rather than reproduced. Every step is checked, not
 * just the far end: dead ground behind a crest hides an approach as completely
 * as a wall does, and a lane you can only see the last tile of is not a lane.
 */
function laneAt(map: GameMap, o: Vec, b: number): boolean {
  const ray = RAYS[b];
  const [lx, ly] = ray[ray.length - 1];
  if (!map.inBounds(o.x + lx, o.y + ly) || !map.terrainAt(o.x + lx, o.y + ly).passable) return false; // nowhere to come from
  for (const [dx, dy] of ray) {
    const x = o.x + dx;
    const y = o.y + dy;
    if (!map.inBounds(x, y)) return false;
    if (!map.terrainAt(x, y).passable) continue; // shooting over a pond is still shooting
    // Level 0 and EYE_H at BOTH ends, stated rather than defaulted (the sight
    // funnel rule, tests/sight-callers.test.ts): the lane this pass guarantees
    // is a STANDING man on the ground seeing another one, which is the eye a
    // rifle section actually fights at. A crouching or prone eye sees less and
    // an upper storey sees more; neither is what the guarantee is about.
    if (!los(map, o.x + 0.5, o.y + 0.5, x + 0.5, y + 0.5, 0, 0, EYE_H, EYE_H).visible) return false;
  }
  return true;
}

const hasLane = (map: GameMap, o: Vec, from: number): boolean =>
  RAYS.some((_, i) => laneAt(map, o, (from + i) % RAYS.length));

// The opaque tiles on this bearing, or null when the ray crosses something the
// pass may not touch. Nothing is written here — this only prices a candidate.
function cutFor(map: GameMap, o: Vec, b: number): [number, number][] | null {
  const cut: [number, number][] = [];
  let px = o.x;
  let py = o.y;
  for (const [dx, dy] of RAYS[b]) {
    const x = o.x + dx;
    const y = o.y + dy;
    if (!map.inBounds(x, y)) return null;
    if (!map.canStep(px, py, x, y, 'foot')) return null; // a wall, a gate post, a bank edge
    px = x;
    py = y;
    if (map.buildingIdAt(x, y) >= 0) return null;
    const t = map.terrainAt(x, y);
    if (!t.passable) return null; // water, and anything else nobody can stand in
    if (t.opacity > 0) cut.push([x, y]);
  }
  return cut;
}

/**
 * The whole ride a candidate would cut: the opaque tiles on the ray, widened to
 * three across the MINOR axis.
 *
 * A one-tile slot through a wood is a peephole, not a lane — and the width is
 * not decoration either. `laneAt` checks the eye against EVERY tile of the ray,
 * and the sub-ray to a near tile is not the same line as the ray to the far
 * one, so a one-tile cut leaves those sub-rays clipping the canopy on either
 * side. The ride is what makes the lane hold along its whole length.
 *
 * Widening never relaxes a rule: it takes only tiles that are opaque, passable
 * and outside every building, so a ride narrows against a wall, a road or a
 * pond rather than eating it.
 */
function rideOf(map: GameMap, cut: readonly [number, number][], b: number): [number, number][] {
  const [ex, ey] = RING[b];
  const px = Math.abs(ex) >= Math.abs(ey) ? 0 : 1;
  const py = 1 - px;
  const out: [number, number][] = [...cut];
  const seen = new Set(cut.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of cut)
    for (const s of [-1, 1]) {
      const wx = x + px * s;
      const wy = y + py * s;
      if (seen.has(`${wx},${wy}`) || !map.inBounds(wx, wy) || map.buildingIdAt(wx, wy) >= 0) continue;
      const t = map.terrainAt(wx, wy);
      if (t.opacity === 0 || !t.passable) continue;
      seen.add(`${wx},${wy}`);
      out.push([wx, wy]);
    }
  return out;
}

/**
 * Open ONE lane out of an objective, or leave the map exactly as it was.
 *
 * Candidates are priced by how many tiles they cost and the cheapest are tried
 * in turn; a ride that still does not read clear is UNDONE tile for tile before
 * the next is tried, so a refusal costs nothing. The verify is `laneAt` itself —
 * the predicate the whole pass is defined by — which is what makes the ray
 * walker above safe even where it disagrees with `los` by a corner tile: a
 * disagreement can only ever cost a candidate, never ship a lane that is not
 * there.
 */
function openOne(map: GameMap, o: Vec, from: number): number {
  const cands: { b: number; cut: [number, number][] }[] = [];
  for (let i = 0; i < RAYS.length; i++) {
    const b = (from + i) % RAYS.length;
    const cut = cutFor(map, o, b);
    if (cut !== null && cut.length > 0) cands.push({ b, cut });
  }
  // Fewest tiles cut wins. Array#sort is stable, so ties keep the ROTATED scan
  // order and the rides do not all point the same way across a campaign.
  cands.sort((p, q) => p.cut.length - q.cut.length);

  for (const c of cands.slice(0, TRIES)) {
    const ride = rideOf(map, c.cut, c.b);
    const was = ride.map(([x, y]) => map.terrainKeyAt(x, y));
    for (const [x, y] of ride) map.setTerrain(x, y, 'grass');
    if (laneAt(map, o, c.b)) return ride.length;
    ride.forEach(([x, y], i) => map.setTerrain(x, y, was[i]));
  }
  return 0;
}

/**
 * Give every objective one lane a defender can cover, where the map allows it.
 *
 * Returns the number of tiles cleared — 0 on a map that already had its lanes,
 * which is the answer for every bourg and every road map measured.
 *
 * Draws exactly ONE integer per objective, unconditionally and before any
 * geometry is inspected, so the stream has the same shape whether or not an
 * objective needed opening.
 */
export function openSightlines(map: GameMap, objectives: readonly Vec[], s17: Rng): number {
  let cleared = 0;
  for (const o of objectives) {
    const from = s17.int(RING.length);
    if (hasLane(map, o, from)) continue;
    cleared += openOne(map, o, from);
  }
  return cleared;
}
