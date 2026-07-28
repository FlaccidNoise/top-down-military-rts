import { buildObjectives } from './bourg/objectives';
import { planBourg, stampBourg, type BourgPlan } from './bourg/plan';
import { PROFILES, type KindProfile } from './bourg/profile';
import { zoneOf } from './bourg/rural';
import { stampStructure } from './bourg/stamp';
import { subStream, TAG } from './bourg/streets';
import { furnishInteriors } from './interiors/furnish';
import { EDGE, GameMap } from './map';
import { applyRelief, laneRuns, NO_RELIEF, planHalt, stampHalt, type FlatZone, type ReliefProfile } from './relief';
import { mulberry32, type Rng } from './rng';

// Normandy map generation. ONE generator — the organic pipeline in
// src/sim/bourg/* — run against a per-kind parameter set (bourg/profile.ts).
// This file owns the public surface (MapPlan, MapKind, the relief wiring, the
// shared validation gate) and the shell that drives the pipeline against a
// GameMap; every stage of the layout itself lives under bourg/.
// Deterministic: all randomness flows through the seeded rng; no Math.hypot
// (not guaranteed correctly-rounded across engines).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// What a structure is, for renderers and dressing passes. Absent means
// 'house': every legacy kind emits bare footprints and must keep reading back
// as a plain house.
export type BuildingRole =
  | 'house'
  | 'townhouse'
  | 'shop'
  | 'bakery' // a shop with an oven — a terrace trade, footprints.ts tradeRole
  | 'forge' // a shop with an anvil and a fire
  | 'farmhouse'
  | 'barn'
  | 'civic'
  | 'halle'
  | 'church'
  | 'church_tower'
  | 'church_apse'
  | 'halt'; // V5: the railway halt beside the embankment (bourg only)

// A door opening on one face of a structure: the DOOR edge on `side` of tile
// (x,y). (x,y) is the structure's OWN floor tile and `side` faces outward, so
// the edge is hEdge(x,y) for 'n', hEdge(x,y+1) for 's', vEdge(x,y) for 'w' and
// vEdge(x+1,y) for 'e'. width 2 writes two adjacent DOOR edges (cart entry,
// halle opening) — the second runs +x for 'n'/'s' and +y for 'e'/'w'.
export interface DoorEdge {
  x: number;
  y: number;
  side: 'n' | 's' | 'e' | 'w';
  width: 1 | 2;
}

// Every field past {x,y,w,h} is optional and additive: legacy kinds emit none
// of them, every existing reader destructures only the primary mass, and the
// fields sit outside the map-array fingerprint. See §3.1 of
// docs/plans/2026-07-26-town-gen-design.md — frozen at T2.
export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  role?: BuildingRole;
  // Multi-rect mass under ONE roof plane (an L with a rear wing, a church
  // nave+tower+apse). parts[0] MUST deep-equal {x,y,w,h} so buildingCenter
  // (bridge.ts:63) still lands on a real floor tile. Rects abut or are
  // disjoint — never overlapping (an overlapped rect strands the earlier
  // structure's wall inside the later one's interior and breaks pathing).
  parts?: Rect[];
  // Shared buildingId key across the masses of one structure. floormenu and
  // patches both group by buildingId, so a church whose tower carries its own
  // id splits into three buildings in every UI that reads it.
  groupId?: number;
  doors?: DoorEdge[]; // absent = legacy single door mid-span on the road-facing side
  frontage?: 'n' | 's' | 'e' | 'w'; // the street side; the roof ridge runs parallel to it
  terraceRun?: number; // shared id across the units of one continuous frontage
}

export interface Vec {
  x: number;
  y: number;
}

// What each objective IS, so tooling stops index-guessing. Parallel to
// MapPlan.objectives.
export type ObjectiveKind = 'place' | 'woods' | 'faubourg' | 'church' | 'street' | 'halt' | 'bridge';

export interface MapPlan {
  map: GameMap;
  buildings: Building[];
  spawns: { west: Vec; east: Vec }; // arterial road entry points, vehicle-reachable
  objectives: Vec[]; // [0] village crossroads, [1] east woods anchor, [2] second hamlet (w >= 240 only); bridge/river maps append the bridge crossing last
  objectiveKinds?: ObjectiveKind[]; // parallel to objectives; absent on legacy kinds
  woodsStands: Vec[]; // center of every placed woods stand (guaranteed east stand + extras)
}

// Battle-map archetype, mirroring the strategic cell terrain. Every kind is one
// KindProfile over the same pipeline: 'bourg' is the full Normandy town, 'road'
// its linear village-rue, 'open' and 'woods' hamlets in bocage and in forest,
// 'river'/'bridge' those hamlets composed with a N→S water band whose only
// crossing is the arterial. The legacy blob generator and the 'town' kind it
// alone drew were retired at mapgen-v3 P6.
export type MapKind = 'open' | 'woods' | 'river' | 'bridge' | 'road' | 'bourg';

// ── Wall-top code table — the sim↔render interface ────────────────────────
//
// hEdgeTops/vEdgeTops carry the height in metres of the top of a WALL edge.
// los() blocks only while the eye-line is BELOW that top (map.ts:210-213,
// 219-222) and eye height is 1.6 m (EYE_H), so the code chooses what sees over
// what. canStep blocks every WALL regardless of top, so nothing here is
// walkable. Frozen at T2 — the renderer keys free-standing walls off it.
//
//   top | meaning                     | movement | standing LOS | cover
//   ----+-----------------------------+----------+--------------+----------------
//    0  | full-height block (legacy)  | blocked  | blocked      | none
//    1  | low garden / front wall     | blocked  | PASSES       | none
//    2  | stone yard / churchyard     | blocked  | blocked      | none (conceal only)
//    3  | 1-storey building           | blocked  | blocked      | —
//    6  | 2-storey building           | blocked  | blocked      | —
//   12  | church tower (4 storeys)    | blocked  | blocked      | —
//
// Known gap: a 1 m wall grants no cover. los() sources cover from
// TerrainDef.cover, WINDOW crossings and coverBehind only (map.ts:151,
// 273-274); low-wall cover would need a new edgeCover array and is out of scope.
//
// The renderer identifies a FREE-STANDING wall as: edge === EDGE.WALL &&
// top ∈ {1,2} && buildingId < 0 on both flanking tiles. No new map array.
// A gate is EDGE.DOOR in such a run: canStep passes foot through DOOR and
// blocks vehicles on anything but NONE (map.ts:123-124) — infantry-permeable,
// vehicle-proof, zero new sim surface.

// ── micro-relief (docs/plans/2026-07-26-verticality-design.md §1.4) ─────────
//
// Which archetype gets what. The whole table is gated on RELIEF_MIN_W/H below,
// so the 160x120 default and the 60x40 floor make ZERO relief draws and ZERO
// relief writes — which is what keeps the two inline fingerprints in
// tests/mapgen.test.ts byte-identical with no argument.
export const RELIEF_BY_KIND: Record<MapKind, ReliefProfile> = {
  open: { undulation: 2, hedgeBanks: true, rail: true, sunken: 0 },
  road: { undulation: 1, hedgeBanks: true, rail: false, sunken: 0 },
  woods: { undulation: 2, hedgeBanks: true, rail: false, sunken: 2 },
  river: { undulation: 1, hedgeBanks: true, rail: false, sunken: 0 },
  bridge: { undulation: 1, hedgeBanks: true, rail: false, sunken: 0 },
  // DEVIATION from §1.4, which asks for sunken: 1 here. The bourg's farm tracks
  // are recoverable off the finished map by relief's laneRuns() exactly as
  // mapgen's are, so the wiring is identical — but a bourg's tracks run right up
  // to the outlying compounds' yards, and a bank thrown against a barn wall is
  // the seam the flat zone exists to prevent. Left at 0 until the bourg's own
  // lane inventory (rural.ts growFarmLanes) is exposed with its compound
  // approaches trimmed. Everything else in the profile is as specified.
  bourg: { undulation: 2, hedgeBanks: true, rail: true, sunken: 0 },
};

// H7's size gate. 320x240 is the design scale; 240x180 is the smallest map that
// still holds a 7-10 tile embankment footprint clear of everything else.
const RELIEF_MIN_W = 240;
const RELIEF_MIN_H = 180;

export interface GenerateOpts {
  // 'none' forces the null profile at any size; an explicit profile forces that
  // profile at any size (the per-element guards inside relief.ts still apply, so
  // a 60x40 map with rail: true simply grows no embankment). Absent = the table.
  relief?: ReliefProfile | 'none';
  // I9 / interiors D2. Default FALSE, and the guard sits in front of the single
  // shared-stream draw, so a map generated without it takes zero extra draws and
  // zero extra writes: every pinned fingerprint holds by construction rather
  // than by care. Production opts in (bridge.ts, scenario.ts); every pinned test
  // calls the <=4-argument form or passes only `relief`.
  //
  // DEVIATION from the design's §2.3, which spells this as a new fifth
  // parameter `opts: { interiors?: boolean }`. `GenerateOpts` already IS the
  // fifth parameter (H7's relief switch got there first), so this is a field on
  // it, not a sixth argument.
  interiors?: boolean;
}

const reliefActive = (p: ReliefProfile): boolean => p.undulation > 0 || p.hedgeBanks || p.rail || p.sunken > 0;

function reliefFor(kind: MapKind, w: number, h: number, opts?: GenerateOpts): ReliefProfile {
  if (opts?.relief === 'none') return NO_RELIEF;
  if (opts?.relief) return opts.relief;
  return w >= RELIEF_MIN_W && h >= RELIEF_MIN_H ? RELIEF_BY_KIND[kind] : NO_RELIEF;
}

// §1.5's sub-stream factory, spelled out rather than imported from
// bourg/streets so the relief stage carries no bourg dependency. Same formula,
// disjoint tag space: relief owns 20-29, the bourg owns 1-14.
const reliefStreams = (base: number) => (tag: number): Rng => mulberry32((base ^ Math.imul(tag, 0x9e3779b1)) >>> 0);

export function generateMap(seed: number, w = 160, h = 120, kind: MapKind = 'open', opts?: GenerateOpts): MapPlan {
  // village clearing radius + road margins need real space; below this the
  // clamp bounds invert and the layout degenerates
  if (w < 60 || h < 40) throw new Error(`mapgen: map ${w}x${h} too small (min 60x40)`);
  const relief = reliefFor(kind, w, h, opts);
  const interiors = opts?.interiors === true;
  const profile = PROFILES[kind];
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = mulberry32((seed ^ 0x51ab3fc7) + attempt * 0x9e3779b9);
    const plan = tryGenerateV3(rng, w, h, profile, relief, interiors);
    if (plan && validate(plan)) return plan;
  }
  throw new Error(`mapgen: no valid layout for seed ${seed}`);
}

// I9 · the interiors wiring, kept out of the pipeline shell so the draw
// discipline is written down once.
//
//  - Flag OFF: not one draw, not one write. `8105059f` / `d2a77805`, both bourg
//    fingerprints and every ≤4-arg pinned test hold by construction (D2a).
//  - Flag ON: the ONE shared-stream draw is the LAST draw of the attempt, taken
//    strictly AFTER the relief stage's own `reliefBase` draw. That ordering is
//    load-bearing and the design doc's §6.1 predates it: relief (H7b) was added
//    after the interiors design was written and now owns the last draw, so
//    taking the interiors draw first would shift `reliefBase` and move every
//    embankment, bank and cutting on the map.
//  - Nothing downstream consumes the draw, so with the flag on the pre-existing
//    arrays are bit-identical to the same seed's unfurnished map: only furniture
//    tiles, interior edges and at most one added exterior DOOR per mass differ
//    (§6.2's delta invariant).
//  - It runs inside the attempt, so it is before `validate` (D2) — a furnished
//    map is validated as furnished, and a rejected attempt is refurnished from
//    scratch on the next one.
function furnishHere(on: boolean, rng: Rng, map: GameMap, buildings: readonly Building[], objective?: Vec): void {
  if (!on) return;
  const furnBase = rng.int(0x7fffffff); // ONE draw on the shared stream (§6.1)
  furnishInteriors(map, buildings, furnBase, objective);
}

// ── one attempt of the pipeline (bourg stages, per-kind profile) ────────────
//
// D2: exactly ONE draw on the shared stream. Every stage below runs on a
// sub-stream derived from it (streets.ts subStream), so its draw count is
// independent of every other stage's — retuning stage 8 cannot move stage 9,
// and tuning one kind's profile cannot move another kind.
//
// The stage order is not negotiable and getting it wrong is silent; plan.ts
// documents why. What lives here is only what needs the shared rng, the
// GameMap, or the MapPlan: the base draw, maxStories, the objectives (which
// need stampBourg's woods stands) and elevation.
function tryGenerateV3(
  rng: Rng,
  w: number,
  h: number,
  profile: KindProfile,
  relief: ReliefProfile,
  interiors: boolean,
): MapPlan | null {
  const bourgBase = rng.int(0x7fffffff);
  const plan = planBourg(bourgBase, w, h, profile); // stages 1-11a, pure — no GameMap yet
  // The legacy pipeline's own floor (`if (buildings.length < 4) return null`),
  // carried onto the profiles: a hamlet that came out as three sheds is not a
  // hamlet, and scenario.ts destructures `[b0, , b2]` out of this list. Placed
  // here rather than in validate() because it is a per-KIND expectation and
  // validate is the shared gate; rejecting before the stamp also makes the
  // reroll free. profile.minBuildings 0 disables it, which is what keeps every
  // kind frozen before its own cutover.
  if (plan.fp.buildings.length < profile.minBuildings) return null;
  const map = new GameMap(w, h);
  const st = stampBourg(map, plan); // terrain → roads → buildings → enclosures
  // stampBourg RETURNS the story count rather than writing it. map.ts:156 gates
  // the entire slab-occlusion path on maxStories, so leaving it at 0 silently
  // disables occlusion for a map whose set-piece is a 4-storey tower.
  map.maxStories = st.maxStories;
  const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);
  // The flat mask is hoisted out of elevateBourg so the dome pass and the
  // relief stage share ONE definition of where the town is (§1.3's rule, read
  // onto this pipeline: T11's `expand(R_env, 4)` is not what the bourg
  // actually built — see bourgFlatMask). Two consumers, one region.
  const flat = bourgFlatMask(map, plan);
  elevateBourg(map, bourgBase, flat); // stage 13 — last, always
  let buildings = plan.fp.buildings;

  if (reliefActive(relief)) {
    const reliefBase = rng.int(0x7fffffff); // ONE draw on the shared stream (§1.5)
    const S = reliefStreams(reliefBase);
    const flatZone: FlatZone = (x, y) => flat[y * w + x] === 1;
    const res = applyRelief(map, relief, S, flatZone, {
      // The place is the bourg's junction; the railway keeps its 40 tiles of
      // clearance from it exactly as it does from a legacy village crossroads.
      // nearBuilding is already folded into `flat` (buildings dilated by 1),
      // so a second per-tile rect scan would be dead weight.
      crossX: Math.round(plan.sk.place.x),
      nearBuilding: () => false,
      lanes: relief.sunken > 0 ? laneRuns(map, flatZone) : undefined,
      spawns: plan.spawns,
    });
    // V5 · the halt. Strictly optional: no embankment or no candidate band
    // leaves the map exactly as the relief stage left it.
    if (res.rail) {
      const halt = planHalt(map, res.rail, plan.sk.env.x + plan.sk.env.w / 2, S(23), flatZone);
      if (halt) {
        stampHalt(map, halt);
        const b: Building = {
          ...halt.rect,
          role: 'halt',
          frontage: halt.side < 0 ? 'e' : 'w', // the booking hall faces its own platform
        };
        // Appended AFTER every bourg building, so the bourg's own emission
        // order — and therefore every buildingId it stamped — is untouched.
        map.maxStories = Math.max(map.maxStories, stampStructure(map, b, buildings.length));
        buildings = [...buildings, b];
        objectives.push(halt.centre);
        objectiveKinds.push('halt');
      }
    }
  }

  // §2.5 · the crossing, appended LAST — after the relief block, so V5's halt
  // can never end up behind it. Tooling reads the TAG and not an index
  // (stage.mjs deriveTargets), but "the last objective is the crossing" is a
  // contract of its own: the garrison splits by objective (bridge.ts), so the
  // bridge gets its own sector for free by being on the list at all.
  //
  // A water profile that recorded no deck is a layout with no crossing on it:
  // reroll, exactly as the legacy pipeline did rather than emit an objective
  // nothing can stand on.
  if (plan.sk.profile.water) {
    if (!st.crossing) return null;
    objectives.push(st.crossing);
    objectiveKinds.push('bridge');
  }

  // Interiors: LAST. After the relief block rather than inside it, because V5's
  // halt is APPENDED to `buildings` in there — furnishing before it would leave
  // the one building on the map that most wants a second door without one.
  furnishHere(interiors, rng, map, buildings, objectives[0]);

  return {
    map,
    buildings,
    spawns: plan.spawns,
    objectives,
    objectiveKinds,
    woodsStands: st.woodsStands,
  };
}

// Stage 13 · tag 14. Structurally the dome pass above, with one added skip mask.
//
// §2.2 specifies `flatZone = expand(R_env, 4)` and that number is wrong for
// this pipeline. The parcel zone is R_env + 6, so plots, gardens and their
// walls reach two tiles OUTSIDE a +4 box, and T9's outlying farms have walled
// yards in open country far beyond it. A 5 m dome running under a 2 m garden
// wall next to a floor tile at elev 0 is exactly the seam and the LOS anomaly
// the flat zone exists to prevent.
//
// The mask is therefore: the parcel zone itself (rural.ts's own zoneOf, so the
// flat region and the region rural fabric refuses to enter cannot drift apart);
// every compound rect dilated by 2, which is what catches the outlying farms;
// every building mass dilated by 1, which is mapgen's `nearBuilding` rule read
// off the authoritative footprint mask instead of an O(n) rect scan per tile;
// and, as a backstop for anything the first three miss, every tile carrying a
// free-standing wall edge. Region-shaped rather than per-wall on purpose:
// skipping only the wall tiles would leave each garden's interior domed and its
// own boundary flat, i.e. a cliff inside every garden.
function elevateBourg(map: GameMap, base: number, flat: Uint8Array): void {
  const { w, h } = map;
  const r14 = subStream(base, TAG.ELEV);
  for (let i = 0, n = 2 + r14.int(3); i < n; i++) {
    const cx = r14.int(w);
    const cy = r14.int(h);
    const r = 8 + r14.int(12);
    const peak = 3 + r14.int(6);
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++)
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > r2 || flat[y * w + x]) continue;
        const k = map.terrainKeyAt(x, y);
        if (k === 'road' || k === 'water' || k === 'floor') continue;
        const e = Math.round(peak * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.sqrt(d2) / r))));
        if (e > map.elev[y * w + x]) map.elev[y * w + x] = e;
      }
  }
}

function bourgFlatMask(map: GameMap, plan: BourgPlan): Uint8Array {
  const { w, h } = map;
  const flat = new Uint8Array(w * h);
  const inZone = zoneOf(plan.sk);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inZone(x, y)) flat[y * w + x] = 1;
  for (const c of plan.fp.compounds)
    for (let y = Math.max(0, c.rect.y - 2), y1 = Math.min(h, c.rect.y + c.rect.h + 2); y < y1; y++)
      for (let x = Math.max(0, c.rect.x - 2), x1 = Math.min(w, c.rect.x + c.rect.w + 2); x < x1; x++) flat[y * w + x] = 1;
  const occ = plan.fp.occ;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!occ[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) flat[ny * w + nx] = 1;
        }
    }
  // A free-standing wall is WALL with a top of 1 or 2 (§3.2); a building wall
  // is stories*FLOOR_H, i.e. >= 3. Four edge reads per tile, once.
  const freeTop = (t: number) => t === 1 || t === 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (flat[i]) continue;
      const vRow = y * (w + 1);
      if (
        (map.hEdge(x, y) === EDGE.WALL && freeTop(map.hEdgeTops[i])) ||
        (map.hEdge(x, y + 1) === EDGE.WALL && freeTop(map.hEdgeTops[i + w])) ||
        (map.vEdge(x, y) === EDGE.WALL && freeTop(map.vEdgeTops[vRow + x])) ||
        (map.vEdge(x + 1, y) === EDGE.WALL && freeTop(map.vEdgeTops[vRow + x + 1]))
      )
        flat[i] = 1;
    }
  return flat;
}

// Ground-level reachability field: one 8-connected BFS from (sx,sy) whose step
// rules mirror astar (path.ts:102-118) exactly — the same map.canStep calls,
// the same "all four L-paths must be steppable" no-corner-cutting rule, no
// stair/level axis (astar's default sl=gl=0 keeps needLevels at 1). So
// `field[i] === 1` is precisely the relation `astar(map, sx, sy, x, y, mode)
// !== null` tests, answered once per SOURCE instead of once per query.
//
// Two astar quirks are reproduced deliberately:
//  - the start tile is seeded regardless of its own passability (astar gates
//    only on the GOAL's passability, then expands via canStep);
//  - goal passability is therefore re-tested at lookup time, in reaches().
//
// canStep is INLINED here rather than called: at ~12 step tests per tile over
// 76,800 tiles the two property chains inside terrainAt (TERRAIN[KEYS[byte]])
// dominate, and hoisting them into a per-tile `open` bitmap plus raw edge-array
// reads is the difference between ~8 ms and ~2 ms per pass. map.ts canStep is
// the authority for the rule; `tests/mapgen.test.ts` asserts reachField against
// astar directly so the copy cannot drift silently. It HAD drifted: this copy
// carried its own 'floor'/'woods'/'hedge' vehicle blacklist and V1's 'bank'
// never reached it, so validate believed vehicles could climb an embankment
// batter that canStep forbids. Both now read TerrainDef.noVehicle, which is
// what makes the drift structurally impossible rather than merely tested for.
//
// The four orthogonal steps out of the popped tile are evaluated once and
// reused as the first leg of each diagonal's corner test.
export function reachField(map: GameMap, sx: number, sy: number, mode: 'foot' | 'vehicle'): Uint8Array {
  const { w, h, hEdges, vEdges } = map;
  const field = new Uint8Array(w * h);
  if (!map.inBounds(sx, sy)) return field;

  // per-tile enterability, memoised on the raw terrain byte (≈10 distinct values)
  const veh = mode === 'vehicle';
  const open = new Uint8Array(w * h);
  const byTile = new Int8Array(256).fill(-1);
  for (let i = 0; i < open.length; i++) {
    const t = map.tiles[i];
    let e = byTile[t];
    if (e < 0) {
      const x = i % w;
      const y = (i / w) | 0;
      const d = map.terrainAt(x, y);
      e = d.passable && (!veh || !d.noVehicle) ? 1 : 0;
      byTile[t] = e;
    }
    open[i] = e;
  }
  // edge transit by EDGE code: vehicles pass NONE only, foot also passes DOOR.
  // BREACH is in the table purely so the array covers every EDGE value (an
  // out-of-range index reads undefined and silently blocks); reachField only
  // ever runs at mapgen time, before anything has been breached, and a wide
  // breach is a runtime fact a generated map never carries.
  const passEdge = new Uint8Array(5);
  passEdge[EDGE.NONE] = 1;
  if (!veh) {
    passEdge[EDGE.DOOR] = 1;
    passEdge[EDGE.BREACH] = 1;
  }

  const queue = new Int32Array(w * h); // each tile is enqueued at most once
  let head = 0;
  let tail = 0;
  const start = sy * w + sx;
  field[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    const vRow = cy * (w + 1);
    // hEdge(x,y) = hEdges[y*w + x] → north side of (cx,cy) is hEdges[cur];
    // vEdge(x,y) = vEdges[y*(w+1) + x] → west side of (cx,cy) is vEdges[vRow+cx].
    const okW = cx > 0 && open[cur - 1] === 1 && passEdge[vEdges[vRow + cx]] === 1;
    const okE = cx + 1 < w && open[cur + 1] === 1 && passEdge[vEdges[vRow + cx + 1]] === 1;
    const okN = cy > 0 && open[cur - w] === 1 && passEdge[hEdges[cur]] === 1;
    const okS = cy + 1 < h && open[cur + w] === 1 && passEdge[hEdges[cur + w]] === 1;
    if (okW && !field[cur - 1]) {
      field[cur - 1] = 1;
      queue[tail++] = cur - 1;
    }
    if (okE && !field[cur + 1]) {
      field[cur + 1] = 1;
      queue[tail++] = cur + 1;
    }
    if (okN && !field[cur - w]) {
      field[cur - w] = 1;
      queue[tail++] = cur - w;
    }
    if (okS && !field[cur + w]) {
      field[cur + w] = 1;
      queue[tail++] = cur + w;
    }
    // diagonals: astar requires BOTH L-paths fully steppable (path.ts:108-114).
    // okH/okV are the first leg of each; the two remaining legs both land on
    // (nx,ny), so they share the one `open` test.
    for (let dy = -1; dy <= 1; dy += 2) {
      if (!(dy < 0 ? okN : okS)) continue;
      for (let dx = -1; dx <= 1; dx += 2) {
        if (!(dx < 0 ? okW : okE)) continue;
        const ni = cur + dy * w + dx;
        if (field[ni] || open[ni] !== 1) continue;
        // vertical leg in column nx, then horizontal leg in row ny
        if (passEdge[hEdges[dy > 0 ? cur + w + dx : cur + dx]] !== 1) continue;
        if (passEdge[vEdges[(cy + dy) * (w + 1) + (dx > 0 ? cx + 1 : cx)]] !== 1) continue;
        field[ni] = 1;
        queue[tail++] = ni;
      }
    }
  }
  return field;
}

const reaches = (map: GameMap, field: Uint8Array, x: number, y: number): boolean =>
  map.inBounds(x, y) && map.terrainAt(x, y).passable && field[y * map.w + x] === 1;

// Layout gate. Semantically identical to the 36-A*-call version it replaced —
// same questions, same step function — but O(1) in building count instead of
// linear, which is what makes a 65-building bourg affordable. Draws no rng and
// mutates nothing, so every kind's fingerprint is untouched.
// Parity with the A* formulation is re-checkable via scripts/validate-parity.mjs.
export function validate(plan: MapPlan): boolean {
  const { map, buildings, spawns, objectives } = plan;
  const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
  for (const o of objectives) if (!reaches(map, west, o.x, o.y)) return false;
  for (const b of buildings) if (!reaches(map, west, b.x + (b.w >> 1), b.y + (b.h >> 1))) return false;
  // every stair tile must be foot-reachable at ground level. `>= 2` rather than
  // `=== 2`: every legacy kind emits 1- or 2-storey buildings only, so this is
  // byte-identical for them, but a bourg's church tower is 4 and its stair was
  // silently exempt from the gate — the one object §1.4 calls the set-piece.
  for (let i = 0; i < map.stairs.length; i++)
    if (map.stairs[i] === 1 && map.stories[i] >= 2 && !reaches(map, west, i % map.w, (i / map.w) | 0)) return false;
  const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
  for (const o of objectives) if (!reaches(map, east, o.x, o.y)) return false;
  const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
  return reaches(map, veh, spawns.east.x, spawns.east.y);
}
