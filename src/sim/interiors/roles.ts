import { EDGE, type GameMap } from '../map';
import type { Building, Vec } from '../mapgen';
import type { Rng } from '../rng';
import { inMass, putH, putV, type ExteriorDoor, type Interior } from './kernel';

// ═══ INTERIORS — REAR DOORS AND LEGACY ROLES (I8) ═══════════════════════════
//
// docs/plans/2026-07-26-interiors-design.md D11 and §3.7, against the freeze in
// ./types.ts §E. Two small passes that the furnishing pass (I7) drives:
//
//   inferRoles    once per map, BEFORE anything is partitioned — the role picks
//                 the plan and the furniture table, so it has to exist first.
//   addRearDoor   once per structure, AFTER its partitioner has run. Order
//                 matters and is not a preference: `frameOf` takes the frontage
//                 from the LOWEST-indexed exterior door, so a rear door cut
//                 before partitioning can flip a house's frontage and put the
//                 hall across the back of the building.

// ── §3.7 · role inference for legacy kinds ──────────────────────────────────

const SHOP_MIN_AREA = 40;
const SHOP_COUNT = 2;

/**
 * Give every roleless building a deterministic role, written back onto
 * `Building.role`.
 *
 * Safe to mutate: `role` is outside the map-array fingerprint, and
 * `tests/mapgen.test.ts` only requires the buildings list to be DETERMINISTIC,
 * which this is (no rng at all). Runs only on buildings whose `role` is
 * undefined, so a bourg building keeps the role its generator gave it and this
 * whole function is a no-op on the bourg.
 *
 * The bonus D11's write-back buys, per §3.7: Lane B can delete `roofs.ts`'
 * geometric `smallOfPair` guess for any map that carries roles, because the
 * rule below IS that guess.
 */
export function inferRoles(buildings: readonly Building[], objective?: Vec): void {
  const area = (b: Building): number => b.w * b.h;
  // roofs.ts' smallOfPair, reproduced exactly — including its error mode.
  // mapgen's farm loop emits a house of 30-48 tiles and a barn of 20-35, so a
  // 6x5 house beside a 7x5 barn is labelled the wrong way round. The true
  // pairing is not recoverable from the emitted data and agreeing with the roof
  // material is worth more than being right 3 % more often.
  //
  // `gx*gx + gy*gy <= 16` rather than roofs.ts' `Math.hypot(gx, gy) <= 4`:
  // identical for integer gaps, and mapgen's header rules Math.hypot out of the
  // sim on determinism grounds (not guaranteed correctly-rounded across
  // engines). This function has to give the same answer in every browser.
  const pairedWith = (b: Building, cmp: (other: number, mine: number) => boolean): boolean => {
    for (const o of buildings) {
      if (o === b) continue;
      const gx = Math.max(0, Math.max(b.x - (o.x + o.w), o.x - (b.x + b.w)));
      const gy = Math.max(0, Math.max(b.y - (o.y + o.h), o.y - (b.y + b.h)));
      if (gx * gx + gy * gy <= 16 && cmp(area(o), area(b))) return true;
    }
    return false;
  };

  for (const b of buildings) {
    if (b.role !== undefined) continue;
    if (pairedWith(b, (o, m) => o > m)) b.role = 'barn';
    else if (pairedWith(b, (o, m) => o < m)) b.role = 'farmhouse';
  }

  // "Among the buildings STILL UNLABELLED" is types.ts §E's clarification of a
  // doc that does not say: without it an outlying farmhouse could be relabelled
  // a shop, and with it the cascade is a partition.
  if (objective) {
    const d2 = (b: Building): number => {
      const dx = b.x + (b.w >> 1) - objective.x;
      const dy = b.y + (b.h >> 1) - objective.y;
      return dx * dx + dy * dy;
    };
    const near = buildings
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.role === undefined && area(b) >= SHOP_MIN_AREA)
      .sort((p, q) => d2(p.b) - d2(q.b) || p.i - q.i);
    for (const { b } of near.slice(0, SHOP_COUNT)) b.role = 'shop';
  }

  for (const b of buildings) if (b.role === undefined) b.role = 'house';
}

// ── D11 · the second exterior door ──────────────────────────────────────────

const REAR_MIN_AREA = 20;
const OPPOSITE: Record<ExteriorDoor['side'], ExteriorDoor['side']> = { n: 's', s: 'n', e: 'w', w: 'e' };
const SX: Record<ExteriorDoor['side'], number> = { n: 0, s: 0, w: -1, e: 1 };
const SY: Record<ExteriorDoor['side'], number> = { n: -1, s: 1, w: 0, e: 0 };

/**
 * D11: every structure with interior area >= 20 whose exterior doors are all on
 * ONE face gets another on the opposite face.
 *
 * DEVIATION, and it is the doc contradicting itself rather than a preference.
 * D11's rule is written "only adds one when `b.doors.length === 1`", but §6.3's
 * test 4 requires "≥ 2 exterior EDGE.DOORs on ≥ 2 DISTINCT SIDES", and the two
 * do not agree on the bourg: seed 4's church carries three doors — nave, tower
 * and apse — and all three face south, because each mass resolved its own
 * default door independently. Three doors on one wall is not "front + back
 * doors give assault entry choice", which is the requirement both clauses are
 * serving. Keying on the SIDE SET rather than the count satisfies the
 * requirement and the test, subsumes the doc's `length === 1` case exactly, and
 * can only ever add connectivity.
 *
 * This is the highest-value composition point in the interiors programme: on
 * the bourg it turns T8's rear-garden network from a bypass into an ENTRY
 * network, and it is what "front + back doors give assault entry choice"
 * actually means. Legacy `addBuilding` emits exactly one door, so it fires on
 * every legacy building of any size.
 *
 * On success the door is APPENDED to `it.doors` rather than merged in sorted
 * order. That is deliberate: `it.doors[0]` must stay the stamper's primary
 * door, because `frameOf` and `Furnisher`'s BFS start both read it and both
 * have already been used by the time this runs. Everything else that touches
 * the list (`sealedTiles`, the barn's door clearance) iterates it whole.
 * `keepClear` does not read the list at all — it scans the map for DOOR edges,
 * so the new door gets its 2-tile apron for free as long as this runs first.
 *
 * Draws exactly ONE integer, unconditionally, before any geometry test, so a
 * structure's `doors` stream has the same shape whether or not it earns a door.
 */
export function addRearDoor(map: GameMap, it: Interior, s2: Rng): ExteriorDoor | null {
  const r = s2.int(0x40000000);
  if (it.tiles.length < REAR_MIN_AREA) return null;
  if (it.doors.length === 0) return null;
  if (new Set(it.doors.map((d) => d.side)).size !== 1) return null;
  const side = OPPOSITE[it.doors[0].side];
  const dx = SX[side];
  const dy = SY[side];
  const alongX = side === 'n' || side === 's';

  // Every position of the mass's face on that side, whether or not it can carry
  // a door — this is what "corner" is measured against, so an L's short wing
  // does not read as the middle of a long wall.
  const face = new Set<number>();
  const cands: { k: number; x: number; y: number; wall: boolean }[] = [];
  for (const t of it.tiles) {
    const x = t % map.w;
    const y = (t / map.w) | 0;
    if (inMass(it, x + dx, y + dy)) continue;
    const e = side === 'n' ? map.hEdge(x, y) : side === 's' ? map.hEdge(x, y + 1) : side === 'w' ? map.vEdge(x, y) : map.vEdge(x + 1, y);
    if (e !== EDGE.WALL && e !== EDGE.WINDOW) continue;
    const k = alongX ? x : y;
    face.add(k);
    // A door has to lead somewhere: not off the map, not into a neighbour's
    // interior (stampStructure forbids that outright and D10 keeps party walls
    // untouched), and not into water.
    const ox = x + dx;
    const oy = y + dy;
    if (!map.inBounds(ox, oy) || map.buildingIdAt(ox, oy) >= 0 || !map.terrainAt(ox, oy).passable) continue;
    cands.push({ k, x, y, wall: e === EDGE.WALL });
  }
  if (cands.length === 0) return null;

  // §3.7's "at least 2 from any corner", relaxed in tiers rather than enforced
  // absolutely: on a 4-wide rear face no position clears a margin of 2, and
  // D11 says EVERY building of area >= 20 gets a door, so the margin gives way
  // before the door does. Within a tier, a WALL is preferred and a WINDOW is
  // "overwritten if needed", which is the doc's own phrasing.
  const clearsBy = (k: number, m: number): boolean => {
    for (let d = 1; d <= m; d++) if (!face.has(k - d) || !face.has(k + d)) return false;
    return true;
  };
  for (const margin of [2, 1, 0])
    for (const wall of [true, false]) {
      const pool = cands.filter((c) => c.wall === wall && clearsBy(c.k, margin)).sort((p, q) => p.k - q.k);
      if (pool.length === 0) continue;
      const c = pool[r % pool.length];
      if (side === 'n') putH(map, c.x, c.y, EDGE.DOOR, 0);
      else if (side === 's') putH(map, c.x, c.y + 1, EDGE.DOOR, 0);
      else if (side === 'w') putV(map, c.x, c.y, EDGE.DOOR, 0);
      else putV(map, c.x + 1, c.y, EDGE.DOOR, 0);
      const door: ExteriorDoor = { x: c.x, y: c.y, side };
      it.doors.push(door);
      return door;
    }
  return null;
}
