import { buildObjectives } from './bourg/objectives';
import { planBourg, stampBourg, type BourgPlan } from './bourg/plan';
import { PROFILES, type KindProfile } from './bourg/profile';
import { partsOf, stampStructure } from './bourg/stamp';
import { generateHeightField, townWeightField } from './bourg/height';
import { subStream, TAG } from './bourg/streets';
import { furnishInteriors } from './interiors/furnish';
import { EDGE, GameMap } from './map';
import { applyRelief, laneRuns, NO_RELIEF, planHalt, stampHalt, type ReliefProfile } from './relief';
import { mulberry32, type Rng } from './rng';
import { openSightlines } from './sightlines';

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
  open:   { hedgeBanks: true, rail: true,  sunken: 0 },
  road:   { hedgeBanks: true, rail: false, sunken: 0 },
  woods:  { hedgeBanks: true, rail: false, sunken: 2 },
  river:  { hedgeBanks: true, rail: false, sunken: 0 },
  bridge: { hedgeBanks: true, rail: false, sunken: 0 },
  bourg:  { hedgeBanks: true, rail: true,  sunken: 0 },
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

const reliefActive = (p: ReliefProfile): boolean => p.hedgeBanks || p.rail || p.sunken > 0;

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

  // ── S0 · Height field ──────────────────────────────────────────────────
  const heightRng = subStream(bourgBase, TAG.HEIGHT);
  const heightSeed = heightRng.int(0x7fffffff);
  const height = generateHeightField(heightSeed, w, h, profile.height.amp);
  // R-H2: height is generated (draws happen, stream stable) regardless.
  // For relief-'none' we zero AFTER planBourg so the valley and slope
  // gates see the same height as relief-on — building lists stay identical.

  const plan = planBourg(bourgBase, w, h, profile, height);
  if (plan.fp.buildings.length < profile.minBuildings) return null;

  // R-H2 · Zero height AFTER planBourg for relief-off.
  if (relief === NO_RELIEF) height.fill(0);

  // ── Feathered town weight (R-H3) ───────────────────────────────────────
  // Built from plan data (zone + compounds + occ) so it can scale the height
  // field BEFORE stamp. The wall check from the old bourgFlatMask is dropped —
  // with feathered scaling (not binary skip) a wall on the boundary gets
  // partial scaling and the square cliff is gone by construction.
  const townW = buildTownWeight(plan, w, h);

  // ── Scale height by town weight ─────────────────────────────────────────
  // Inside the town core (townW[i]=255), height → 0 (R-H3: core stays flat).
  // Outside (townW[i]=0), height unchanged. The ~8-tile feathered band blends.
  if (relief !== NO_RELIEF) {
    for (let i = 0; i < w * h; i++) {
      height[i] = Math.round(height[i] * (256 - townW[i]) / 256);
    }
  }

  const map = new GameMap(w, h);

  // ── Write height field into the GameMap ─────────────────────────────────
  for (let i = 0; i < w * h; i++) {
    if (height[i] > map.elev[i]) map.elev[i] = height[i];
  }

  const st = stampBourg(map, plan);
  map.maxStories = st.maxStories;
  const { objectives, objectiveKinds } = buildObjectives(plan.sk, plan.land, plan.fp, st.woodsStands);

  // ── R-H4 · Road grade relaxation ────────────────────────────────────────
  relaxRoadGrades(map);

  // ── R-H5 · Per-building local flatten ───────────────────────────────────
  let buildings = plan.fp.buildings;
  flattenBuildings(map, buildings);

  if (reliefActive(relief)) {
    const reliefBase = rng.int(0x7fffffff);
    const S = reliefStreams(reliefBase);
    const res = applyRelief(map, relief, S, townW, {
      crossX: Math.round(plan.sk.place.x),
      lanes: relief.sunken > 0 ? laneRuns(map, townW) : undefined,
      spawns: plan.spawns,
    });
    if (res.rail) {
      const halt = planHalt(map, res.rail, plan.sk.env.x + plan.sk.env.w / 2, S(23), townW);
      if (halt) {
        stampHalt(map, halt);
        const b: Building = {
          ...halt.rect,
          role: 'halt',
          frontage: halt.side < 0 ? 'e' : 'w',
        };
        map.maxStories = Math.max(map.maxStories, stampStructure(map, b, buildings.length));
        buildings = [...buildings, b];
        objectives.push(halt.centre);
        objectiveKinds.push('halt');
      }
    }
    // Relief (especially the embankment's level-crossing writes to road tiles)
    // can break road grades. Re-run road grade relaxation after relief.
    relaxRoadGrades(map);
  }

  // §2.5 · the crossing (unchanged)
  if (plan.sk.profile.water) {
    if (!st.crossing) return null;
    objectives.push(st.crossing);
    objectiveKinds.push('bridge');
  }

  // Sightlines (unchanged)
  openSightlines(map, objectives, subStream(bourgBase, TAG.SIGHTLINE));

  // Interiors (unchanged)
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

/** Build feathered town-weight field (R-H3). Same region as old bourgFlatMask. */
function buildTownWeight(plan: BourgPlan, w: number, h: number): Uint8Array {
  const binary = new Uint8Array(w * h);
  // Inline zoneOf(sk) — two direct rectangle fills instead of 76,800 closure calls.
  const zx0 = Math.max(0, plan.sk.env.x - 6);
  const zy0 = Math.max(0, plan.sk.env.y - 6);
  const zx1 = Math.min(w, plan.sk.env.x + plan.sk.env.w + 6); // +5 in zoneOf is inclusive — +6 for < bound
  const zy1 = Math.min(h, plan.sk.env.y + plan.sk.env.h + 6);
  for (let y = zy0; y < zy1; y++) {
    const row = y * w;
    for (let x = zx0; x < zx1; x++) binary[row + x] = 1;
  }
  if (plan.sk.faubourg) {
    const fx0 = Math.max(0, plan.sk.faubourg.x - 22);
    const fy0 = Math.max(0, plan.sk.faubourg.y - 22);
    const fx1 = Math.min(w, plan.sk.faubourg.x + 23);
    const fy1 = Math.min(h, plan.sk.faubourg.y + 23);
    for (let y = fy0; y < fy1; y++) {
      const row = y * w;
      for (let x = fx0; x < fx1; x++) binary[row + x] = 1;
    }
  }
  for (const c of plan.fp.compounds)
    for (let y = Math.max(0, c.rect.y - 2), y1 = Math.min(h, c.rect.y + c.rect.h + 2); y < y1; y++)
      for (let x = Math.max(0, c.rect.x - 2), x1 = Math.min(w, c.rect.x + c.rect.w + 2); x < x1; x++) binary[y * w + x] = 1;
  const occ = plan.fp.occ;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!occ[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) binary[ny * w + nx] = 1;
        }
    }
  return townWeightField(binary, w, h);
}

/**
 * R-H4 · Road grade relaxation.
 * After roads are stamped: iterative scan-order passes clamp each road tile
 * to within ±1 of EACH 4-neighbour road tile. Repeated until stable (max 6 passes).
 * Verges clamp delta vs nearest road to ±1.
 */
function relaxRoadGrades(map: GameMap): void {
  const { w, h, tiles } = map;
  const e = map.elev;
  // Each road tile clamps to within ±1 of each 4-neighbour road tile.
  // Alternating scan directions for two-way propagation. Capped at 50
  // passes — with the river valley carving, steep gradients near the
  // band may not fully converge, but the road network remains connected
  // and the game does not depend on perfect grade smoothing.
  //
  // Direct tiles[] byte reads replace terrainKeyAt calls throughout.
  // Tile indices (data.ts stable-order): road=1, water=6, floor=3.
  const maxPasses = 50;
  for (let pass = 0; pass < maxPasses; pass++) {
    const fwd = pass % 2 === 0;
    let changed = false;
    for (let yi = 0; yi < h; yi++) {
      const y = fwd ? yi : h - 1 - yi;
      const rowBase = y * w;
      for (let xi = 0; xi < w; xi++) {
        const x = fwd ? xi : w - 1 - xi;
        const i = rowBase + x;
        if (tiles[i] !== 1) continue;
        const nbrs: number[] = [];
        if (x > 0 && tiles[i - 1] === 1) nbrs.push(e[i - 1]);
        if (x + 1 < w && tiles[i + 1] === 1) nbrs.push(e[i + 1]);
        if (y > 0 && tiles[i - w] === 1) nbrs.push(e[i - w]);
        if (y + 1 < h && tiles[i + w] === 1) nbrs.push(e[i + w]);
        for (const nv of nbrs) {
          if (e[i] > nv + 1) { e[i] = nv + 1; changed = true; }
          if (e[i] < nv - 1) { e[i] = nv - 1; changed = true; }
        }
      }
    }
    if (!changed) break;
  }

  // Verge rule: non-road tile 8-adjacent to road clamps delta to ±1.
  const orig = new Uint8Array(e);
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      const i = rowBase + x;
      const t = tiles[i];
      if (t === 1 || t === 6 || t === 3) continue; // road=1, water=6, floor=3
      let minRoad = 255;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (tiles[ny * w + nx] === 1) minRoad = Math.min(minRoad, orig[ny * w + nx]);
        }
      if (minRoad < 255) {
        if (e[i] > minRoad + 1) e[i] = minRoad + 1;
        if (e[i] < minRoad - 1) e[i] = minRoad - 1;
      }
    }
  }
}

/**
 * R-H5 · Building/compound flatten.
 * Per structure: find min height over the footprint + 1-tile border,
 * write that to footprint + border, blend linearly to field height over 2 tiles.
 */
function flattenBuildings(map: GameMap, buildings: readonly Building[]): void {
  const { w, h } = map;
  const e = map.elev;
  const done = new Uint8Array(w * h);

  for (const b of buildings) {
    const parts = partsOf(b);
    // Compute bbox with 2-tile border for the blend zone
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of parts) {
      if (p.x < bx0) bx0 = p.x;
      if (p.y < by0) by0 = p.y;
      if (p.x + p.w > bx1) bx1 = p.x + p.w;
      if (p.y + p.h > by1) by1 = p.y + p.h;
    }
    const fx0 = Math.max(0, bx0 - 1);
    const fy0 = Math.max(0, by0 - 1);
    const fx1 = Math.min(w, bx1 + 1);
    const fy1 = Math.min(h, by1 + 1);

    // Find min elevation over footprint + 1-border
    let e0 = 255;
    for (let y = fy0; y < fy1; y++)
      for (let x = fx0; x < fx1; x++) {
        const v = e[y * w + x];
        if (v < e0) e0 = v;
      }

    // Write flat elevation to footprint
    for (const p of parts)
      for (let y = p.y; y < p.y + p.h; y++)
        for (let x = p.x; x < p.x + p.w; x++) {
          e[y * w + x] = e0;
          done[y * w + x] = 1;
        }
    // Write flat elevation to 1-tile border (skip infrastructure tiles)
    const skipBorder = (x: number, y: number): boolean => {
      const k = map.terrainKeyAt(x, y);
      return k === 'road' || k === 'water' || k === 'floor' || k === 'rail' || k === 'hedge';
    };
    for (let y = fy0; y < fy1; y++)
      for (let x = fx0; x < fx1; x++) {
        const i = y * w + x;
        if (!done[i] && !skipBorder(x, y)) { e[i] = e0; done[i] = 1; }
      }

    // Blend zone: next 2 tiles outside the 1-tile border, ramp from e0 to field.
    // Skip infrastructure tiles (roads, water, etc.).
    const bz0 = Math.max(0, fx0 - 2);
    const bz1 = Math.min(w, fx1 + 2);
    const bzY0 = Math.max(0, fy0 - 2);
    const bzY1 = Math.min(h, fy1 + 2);
    for (let y = bzY0; y < bzY1; y++)
      for (let x = bz0; x < bz1; x++) {
        const i = y * w + x;
        if (done[i]) continue;
        if (skipBorder(x, y)) continue;
        const dx = x < fx0 ? fx0 - x : x >= fx1 ? x - fx1 + 1 : 0;
        const dy = y < fy0 ? fy0 - y : y >= fy1 ? y - fy1 + 1 : 0;
        const d = Math.max(dx, dy);
        if (d <= 0 || d > 3) continue;
        const t = (d - 1) / 2;
        const fieldH = e[i];
        e[i] = Math.round(e0 + (fieldH - e0) * t);
        done[i] = 1;
      }
  }
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
