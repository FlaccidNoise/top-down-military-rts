import { TERRAIN, type TerrainDef, type TerrainKey } from './data';

// Walls live on tile EDGES (thin walls, Door Kickers-style) so building
// interiors are ordinary walkable space. This is load-bearing for room-by-room
// clearing later — do not convert to solid wall tiles.
// BREACH is a hole blown (or crushed) through a wall mid-battle. Deliberately
// NOT EDGE.NONE: a rubble lip still grants cover to whoever fights across it
// (los() below), still costs a vehicle something to cross (canStep, and only
// when it is wide), and still has to be distinguishable from "no wall was ever
// here" by the renderer and by the campaign scar record.
export const EDGE = { NONE: 0, WALL: 1, DOOR: 2, WINDOW: 3, BREACH: 4 } as const;
export type EdgeType = (typeof EDGE)[keyof typeof EDGE];

// On a BREACH edge the (otherwise always-zero) top byte is reused as a width
// class — the same "the top byte is a class code" idiom the free-standing wall
// tops already use. Wide breaches come from tank HE, deliberate AT wall shots
// and tank crush; everything smaller leaves a foot-only lip.
export const BREACH_LIP = 1;
export const BREACH_WIDE = 2;

// Derived edge classes. Nothing stores these — every input is already on the
// map (edge byte + top byte + buildingId on the two flanking tiles), so a
// breach needs no new array and no re-index.
export const ECLASS = { NONE: 0, GATE: 1, FENCE: 2, WALL_LOW: 3, WALL_HIGH: 4, WINDOW: 5, DOOR: 6, MASONRY: 7 } as const;

// Blast energy needed to open each class, indexed by ECLASS. A gate is a
// timber leaf in a hinge; a waist wall is one course of dry stone; a head-high
// enclosure wall is two; a blown window IS a man-sized hole, which is why it
// sits below a door and well below masonry; a house wall is half a metre of
// rubble-filled masonry and wants a direct AT round.
// FENCE is reserved: no generator emits a distinct picket top code yet, so
// WALL_LOW stands in for both the garden wall and the fence. Adding one later
// is a row here plus a mask value in render/enclos.ts.
export const BREACH_THRESH: readonly number[] = [Infinity, 1.5, 1.0, 3.0, 5.0, 4.0, 4.5, 9.0];

// Cover granted by a rubble lip crossed within 2 m of the target — the same
// channel windows and hedgerow banks already use in los().
export const BREACH_COVER = 0.35;

// How a mover treats edges. The two crush tiers are a hull that will drive
// THROUGH something rather than round it — one boolean's worth of difference,
// expressed as two modes rather than by threading a vehicle class into canStep.
export type StepMode = 'foot' | 'vehicle' | 'crush_light' | 'crush_heavy';

const TERRAIN_KEYS = Object.keys(TERRAIN) as TerrainKey[];

export const FLOOR_H = 3; // m per story
export const EYE_H = 1.6; // m eye height above feet

export class GameMap {
  readonly tiles: Uint8Array; // index into TERRAIN_KEYS
  readonly hEdges: Uint8Array; // hEdge(x,y): edge on north side of tile (x,y); y in 0..h
  readonly vEdges: Uint8Array; // vEdge(x,y): edge on west side of tile (x,y); x in 0..w
  // height system
  readonly elev: Uint8Array; // terrain elevation, meters. 0 = flat
  readonly stories: Uint8Array; // building story count on floor tiles, else 0
  readonly buildingId: Int16Array; // -1 outside buildings; same id = same building
  readonly stairs: Uint8Array; // 1 = stair tile (inside a building, connects levels)
  readonly hEdgeTops: Uint8Array; // top height (m) of a horizontal wall edge; 0 = full-height block
  readonly vEdgeTops: Uint8Array; // top height (m) of a vertical wall edge; 0 = full-height block
  maxStories = 0;
  // Set by the interiors pass when it writes its first furniture tile. Same
  // pattern as maxStories above (which gates the whole slab-LOS path in los()):
  // every interiors-aware behaviour change in sim.ts is guarded on it, so an
  // unfurnished map executes zero new instructions and is provably unchanged.
  hasFurniture = false;
  // Set by the first breach of the battle. Purely a "is there any point
  // looking?" hint — the edge arrays remain the only source of truth for where
  // the holes are. It exists so A* and advance() run zero extra instructions on
  // the overwhelmingly common unbreached map (astar is ~98 % of the order-burst
  // tick; see memory perf-order-burst-profile).
  hasBreach = false;
  // Road tiles carved over the water band — passable road to the sim (no
  // separate terrain kind), a plank deck to the renderer. Recorded by mapgen
  // because the road overwrites the water, destroying the overlap the renderer
  // would otherwise have to re-guess from proximity (which mislabels roads
  // merely running alongside a river as bridges).
  readonly bridges: Uint8Array;
  // Road tiles carved through a railway embankment's footprint — same precedent
  // as bridges. The road wins the tile (terrain stays 'road', so vehicles and
  // A* treat a level crossing as ordinary road), which destroys the rail/road
  // overlap the renderer needs to draw sleepers and warning posts over the
  // deck. The sim never reads this array.
  readonly crossings: Uint8Array;

  constructor(readonly w: number, readonly h: number, fill: TerrainKey = 'grass') {
    this.tiles = new Uint8Array(w * h).fill(TERRAIN_KEYS.indexOf(fill));
    this.hEdges = new Uint8Array((h + 1) * w);
    this.vEdges = new Uint8Array(h * (w + 1));
    this.elev = new Uint8Array(w * h);
    this.stories = new Uint8Array(w * h);
    this.buildingId = new Int16Array(w * h).fill(-1);
    this.stairs = new Uint8Array(w * h);
    this.hEdgeTops = new Uint8Array((h + 1) * w);
    this.vEdgeTops = new Uint8Array(h * (w + 1));
    this.bridges = new Uint8Array(w * h);
    this.crossings = new Uint8Array(w * h);
  }

  isBridge(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.bridges[y * this.w + x] === 1;
  }

  isCrossing(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.crossings[y * this.w + x] === 1;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  setTerrain(x: number, y: number, t: TerrainKey): void {
    this.tiles[y * this.w + x] = TERRAIN_KEYS.indexOf(t);
  }

  terrainAt(x: number, y: number): TerrainDef {
    if (!this.inBounds(x, y)) return TERRAIN.grass;
    return TERRAIN[TERRAIN_KEYS[this.tiles[y * this.w + x]]];
  }

  terrainKeyAt(x: number, y: number): TerrainKey {
    return TERRAIN_KEYS[this.tiles[y * this.w + x]];
  }

  hEdge(x: number, y: number): EdgeType {
    if (x < 0 || x >= this.w || y < 0 || y > this.h) return EDGE.NONE;
    return this.hEdges[y * this.w + x] as EdgeType;
  }

  vEdge(x: number, y: number): EdgeType {
    if (x < 0 || x > this.w || y < 0 || y >= this.h) return EDGE.NONE;
    return this.vEdges[y * (this.w + 1) + x] as EdgeType;
  }

  setHEdge(x: number, y: number, e: EdgeType): void {
    this.hEdges[y * this.w + x] = e;
  }

  setVEdge(x: number, y: number, e: EdgeType): void {
    this.vEdges[y * (this.w + 1) + x] = e;
  }

  elevAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.elev[y * this.w + x];
  }
  storiesAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.stories[y * this.w + x];
  }
  buildingIdAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return -1;
    return this.buildingId[y * this.w + x];
  }
  isStair(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.stairs[y * this.w + x] === 1;
  }
  hEdgeTop(x: number, y: number): number {
    if (x < 0 || x >= this.w || y < 0 || y > this.h) return 0;
    return this.hEdgeTops[y * this.w + x];
  }
  vEdgeTop(x: number, y: number): number {
    if (x < 0 || x > this.w || y < 0 || y >= this.h) return 0;
    return this.vEdgeTops[y * (this.w + 1) + x];
  }

  // Can a unit step between two orthogonally adjacent tiles?
  // Vehicles can't enter buildings, woods or the batter of an embankment, and
  // never pass any edge feature. Which terrain closes to vehicles is
  // TerrainDef.noVehicle (data.ts), not a key list here — the same rule is
  // inlined by mapgen's reachField and read by sim's findVehicleSpot, and three
  // hand-kept copies had already drifted. Slope is expressed as the 'bank'
  // terrain key rather than a grade rule over elev: every legacy map already
  // carries multi-metre elevation steps straight against its roads (the mapgen
  // dome pass skips road/water/floor tiles), so a global max-grade check would
  // wall off the arterial on maps that generate fine today.
  canStep(x0: number, y0: number, x1: number, y1: number, mode: StepMode = 'foot'): boolean {
    if (!this.inBounds(x1, y1)) return false;
    const t = this.terrainAt(x1, y1);
    if (!t.passable) return false;
    // noVehicle applies to a crushing hull exactly as it does to a careful one:
    // hedgerows are a 2 m earth bank with a root mat through them, not a hedge,
    // and a Sherman that climbs one shows its belly plate to the far side. The
    // bocage grid is the map's flanking layer and stays hard (design §2.3).
    if (mode !== 'foot' && t.noVehicle) return false;
    let e: EdgeType = EDGE.NONE;
    let ex = 0;
    let ey = 0;
    let horiz = false;
    if (x1 === x0 + 1) {
      ex = x1;
      ey = y0;
      e = this.vEdge(ex, ey);
    } else if (x1 === x0 - 1) {
      ex = x0;
      ey = y0;
      e = this.vEdge(ex, ey);
    } else if (y1 === y0 + 1) {
      ex = x0;
      ey = y1;
      horiz = true;
      e = this.hEdge(ex, ey);
    } else if (y1 === y0 - 1) {
      ex = x0;
      ey = y0;
      horiz = true;
      e = this.hEdge(ex, ey);
    }
    if (e === EDGE.NONE) return true;
    if (mode === 'foot') return e === EDGE.DOOR || e === EDGE.BREACH; // walls and windows block movement
    if (e === EDGE.BREACH) {
      // A careful hull needs the wide code; a crushing one widens a lip.
      if (mode !== 'vehicle') return true;
      return (horiz ? this.hEdgeTop(ex, ey) : this.vEdgeTop(ex, ey)) === BREACH_WIDE;
    }
    if (mode === 'vehicle') return false;
    // Crush tiers (§2.1). A window, a house door and masonry stop every hull:
    // the sim has no building HP and a tank that can drive through a house
    // makes every interior fight pointless.
    const cls = edgeClass(this, ex, ey, horiz);
    if (cls === ECLASS.GATE || cls === ECLASS.FENCE || cls === ECLASS.WALL_LOW) return true;
    return cls === ECLASS.WALL_HIGH && mode === 'crush_heavy';
  }

  // Which edge lies between two orthogonally adjacent tiles, addressed the way
  // hEdge/vEdge want it. Cold path only: canStep and crushesBetween inline the
  // same arithmetic because they run per A* expansion and must not allocate.
  edgeAddr(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; horiz: boolean } | null {
    if (x1 === x0 + 1) return { x: x1, y: y0, horiz: false };
    if (x1 === x0 - 1) return { x: x0, y: y0, horiz: false };
    if (y1 === y0 + 1) return { x: x0, y: y1, horiz: true };
    if (y1 === y0 - 1) return { x: x0, y: y0, horiz: true };
    return null;
  }

  // Does this step exist only because the hull is willing to flatten something?
  // Edge-only: terrain passability is canStep's job and is already settled by
  // the time A* asks for the surcharge.
  crushesBetween(x0: number, y0: number, x1: number, y1: number): boolean {
    let e: EdgeType = EDGE.NONE;
    let ex = 0;
    let ey = 0;
    let horiz = false;
    if (x1 === x0 + 1) {
      ex = x1;
      ey = y0;
      e = this.vEdge(ex, ey);
    } else if (x1 === x0 - 1) {
      ex = x0;
      ey = y0;
      e = this.vEdge(ex, ey);
    } else if (y1 === y0 + 1) {
      ex = x0;
      ey = y1;
      horiz = true;
      e = this.hEdge(ex, ey);
    } else if (y1 === y0 - 1) {
      ex = x0;
      ey = y0;
      horiz = true;
      e = this.hEdge(ex, ey);
    }
    if (e === EDGE.NONE) return false;
    if (e === EDGE.BREACH) return (horiz ? this.hEdgeTop(ex, ey) : this.vEdgeTop(ex, ey)) !== BREACH_WIDE;
    return true;
  }

  // Does a step between two orthogonally adjacent tiles cross a rubble lip?
  // Gate every call on `hasBreach`: on an unbreached map the answer is always
  // false and the lookup is pure waste.
  breachBetween(x0: number, y0: number, x1: number, y1: number): boolean {
    if (x1 === x0 + 1) return this.vEdge(x1, y0) === EDGE.BREACH;
    if (x1 === x0 - 1) return this.vEdge(x0, y0) === EDGE.BREACH;
    if (y1 === y0 + 1) return this.hEdge(x0, y1) === EDGE.BREACH;
    if (y1 === y0 - 1) return this.hEdge(x0, y0) === EDGE.BREACH;
    return false;
  }
}

// Which kind of thing is standing on this edge? Purely derived — see ECLASS.
// (x,y) addresses the edge the same way hEdge/vEdge do: a horizontal edge is
// the north side of tile (x,y) (flanked by (x,y-1) and (x,y)); a vertical edge
// is the west side of tile (x,y) (flanked by (x-1,y) and (x,y)).
// A WALL that is neither a top-1 nor a top-2 free-standing run falls to
// MASONRY, which is the conservative read: legacy maps stamp building walls
// with top 0 and no grenade should open one.
export function edgeClass(map: GameMap, x: number, y: number, horiz: boolean): number {
  const e = horiz ? map.hEdge(x, y) : map.vEdge(x, y);
  if (e === EDGE.NONE || e === EDGE.BREACH) return ECLASS.NONE;
  if (e === EDGE.WINDOW) return ECLASS.WINDOW;
  const built = horiz
    ? map.buildingIdAt(x, y - 1) >= 0 || map.buildingIdAt(x, y) >= 0
    : map.buildingIdAt(x - 1, y) >= 0 || map.buildingIdAt(x, y) >= 0;
  if (e === EDGE.DOOR) return built ? ECLASS.DOOR : ECLASS.GATE;
  if (!built) {
    const top = horiz ? map.hEdgeTop(x, y) : map.vEdgeTop(x, y);
    if (top === 1) return ECLASS.WALL_LOW; // waist-high garden wall
    if (top === 2) return ECLASS.WALL_HIGH; // head-high enclosure
  }
  return ECLASS.MASONRY;
}

// A single edge, addressed the way hEdge/vEdge and edgeClass want it. The
// player-directed wall target (design D5) is one of these, resolved once when
// the order is given rather than re-derived from the click point every tick —
// so the wall the player picked is the wall the gun shoots, even if he nudged
// the camera afterwards.
export interface EdgeRef {
  x: number;
  y: number;
  horiz: boolean;
}

// Midpoint of an edge's span, in world metres. A horizontal edge runs along
// the north side of its tile, a vertical one down the west side.
export function edgeMid(e: EdgeRef): { x: number; y: number } {
  return e.horiz ? { x: e.x + 0.5, y: e.y } : { x: e.x, y: e.y + 0.5 };
}

// Which breachable edge is this click nearest to? Row-major, h before v — the
// same fixed scan order breachScan uses, so a tie between two equidistant
// edges resolves identically everywhere. Cold path (once per order), so it may
// allocate. Returns null when nothing standing is within `radius`.
export function nearestBreachable(map: GameMap, x: number, y: number, radius: number): EdgeRef | null {
  let best: EdgeRef | null = null;
  let bestD = radius;
  const x0 = Math.floor(x - radius);
  const x1 = Math.floor(x + radius) + 1;
  const y0 = Math.floor(y - radius);
  const y1 = Math.floor(y + radius) + 1;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      for (let k = 0; k < 2; k++) {
        const horiz = k === 0;
        if (edgeClass(map, tx, ty, horiz) === ECLASS.NONE) continue;
        const mx = horiz ? tx + 0.5 : tx;
        const my = horiz ? ty : ty + 0.5;
        const d = Math.hypot(mx - x, my - y);
        if (d < bestD) {
          bestD = d;
          best = { x: tx, y: ty, horiz };
        }
      }
    }
  }
  return best;
}

export interface LosResult {
  visible: boolean;
  cover: number;
  conceal: number; // 0..1 accumulated opacity along the ray (1 when blocked)
  concealed?: boolean; // invisible due to a sneaking target's concealment, not blocked LOS (set by sightToSoldier)
}

// Grid traversal (Amanatides & Woo). Walls block sight; doors and windows pass.
// Terrain opacity accumulates; a window crossed within 2m of the target grants
// window cover (the target is "at the window", exposed only through it).
// Terrain with coverBehind (hedgerows) works the same way directionally: a
// shot crossing it within 2m of the target grants that cover — hugging the far
// side of a hedgerow bank; shots that don't cross the hedge get none.
// 2.5D LOS: extends Amanatides & Woo with elevation profile check.
// l0,l1 are floor levels (0-based). With all elev=0 and l0=l1=0, behavior
// is byte-identical to the legacy los() — edge tops of 0 mean full-height block.
// e0,e1 are eye/target heights above the feet in metres (see sim.ts's
// EYE_STAND/EYE_CROUCH/EYE_PRONE and EYE_VEHICLE/HULL_VEHICLE). They enter the
// z-line only, outside the traversal loop: defaulting both to EYE_H reproduces
// the legacy result instruction-for-instruction.
export function los(map: GameMap, x0: number, y0: number, x1: number, y1: number, l0 = 0, l1 = 0, e0 = EYE_H, e1 = EYE_H): LosResult {
  const tx0 = Math.floor(x0);
  const ty0 = Math.floor(y0);
  let tx = tx0;
  let ty = ty0;
  const tx1 = Math.floor(x1);
  const ty1 = Math.floor(y1);
  let cover = map.terrainAt(tx1, ty1).cover;
  if (tx === tx1 && ty === ty1) return { visible: true, cover, conceal: 0 };

  // Slab occlusion gate: flat maps (maxStories === 0) execute zero new
  // instructions below — byte-identical to the legacy los().
  const slabs = map.maxStories > 0;
  const storiesArr = map.stories;
  const stairsArr = map.stairs;
  const elevArr = map.elev;
  const w = map.w;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { visible: true, cover, conceal: 0 };
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (stepX > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY : Infinity;

  // eye-to-eye z line
  const z0 = map.elevAt(tx0, ty0) + l0 * FLOOR_H + e0;
  const z1 = map.elevAt(tx1, ty1) + l1 * FLOOR_H + e1;
  const dz = z1 - z0;

  // Slab test for the observer's own tile (never "entered" by the traversal
  // below). The eye sits between slabs, so this only blocks when the ray
  // genuinely crosses a slab before leaving the tile — e.g. a downstairs eye
  // whose ray to an upstairs target rises through the floor slab of his own
  // room. An upstairs eye firing along/out of his floor never straddles.
  if (slabs) {
    const i = ty * w + tx;
    const s = storiesArr[i];
    if (s > 0 && stairsArr[i] === 0) {
      const tExit = tMaxX < tMaxY ? tMaxX : tMaxY;
      const zB = z0 + dz * tExit;
      const zLo = z0 < zB ? z0 : zB;
      const zHi = z0 < zB ? zB : z0;
      const base = elevArr[i];
      for (let k = 1; k <= s; k++) {
        const zk = base + k * FLOOR_H;
        if (zLo < zk && zk <= zHi) return { visible: false, cover: 0, conceal: 1 };
      }
    }
  }

  let opacity = 0;
  let lastWindowT = -1;
  let lastBreachT = -1;
  let lastLip = 0;
  let lastLipT = -1;
  let guard = map.w + map.h + 4;

  while ((tx !== tx1 || ty !== ty1) && guard-- > 0) {
    let tEntry: number;
    let edgeTop: number;
    if (tMaxX < tMaxY) {
      const e = map.vEdge(stepX > 0 ? tx + 1 : tx, ty);
      if (e === EDGE.WALL) {
        edgeTop = map.vEdgeTop(stepX > 0 ? tx + 1 : tx, ty);
        if (edgeTop === 0 || z0 + dz * tMaxX < edgeTop) return { visible: false, cover: 0, conceal: 1 };
      }
      if (e === EDGE.WINDOW) lastWindowT = tMaxX;
      else if (e === EDGE.BREACH) lastBreachT = tMaxX;
      tEntry = tMaxX;
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      const e = map.hEdge(tx, stepY > 0 ? ty + 1 : ty);
      if (e === EDGE.WALL) {
        edgeTop = map.hEdgeTop(tx, stepY > 0 ? ty + 1 : ty);
        if (edgeTop === 0 || z0 + dz * tMaxY < edgeTop) return { visible: false, cover: 0, conceal: 1 };
      }
      if (e === EDGE.WINDOW) lastWindowT = tMaxY;
      else if (e === EDGE.BREACH) lastBreachT = tMaxY;
      tEntry = tMaxY;
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (slabs) {
      // Floor/ceiling slabs: a building tile (stories > 0) that is not a
      // stairwell implicitly contains horizontal slab planes at
      // z_k = elev + k*FLOOR_H for k = 1..stories. If the eye-line segment
      // across this tile straddles any slab plane, the ray passes through a
      // floor/ceiling — blocked. Stair tiles are the opening in the slab and
      // skip the test. Applied to every ENTERED tile including the target
      // tile (a straddle there means the ray genuinely crosses a slab inside
      // it — eyes sit between slabs, so they never straddle on their own).
      // +−× comparisons only (§7 determinism).
      const i = ty * w + tx;
      const s = storiesArr[i];
      if (s > 0 && stairsArr[i] === 0) {
        const tExit = tx === tx1 && ty === ty1 ? 1 : tMaxX < tMaxY ? tMaxX : tMaxY;
        const zA = z0 + dz * tEntry;
        const zB = z0 + dz * tExit;
        const zLo = zA < zB ? zA : zB;
        const zHi = zA < zB ? zB : zA;
        const base = elevArr[i];
        for (let k = 1; k <= s; k++) {
          const zk = base + k * FLOOR_H;
          if (zLo < zk && zk <= zHi) return { visible: false, cover: 0, conceal: 1 };
        }
      }
    }
    if (tx !== tx1 || ty !== ty1) {
      const t = map.terrainAt(tx, ty);
      const lineZ = z0 + dz * tEntry;
      // ground occlusion
      if (map.elevAt(tx, ty) >= lineZ) return { visible: false, cover: 0, conceal: 1 };
      // feature skip: shooting over canopy
      if (t.featureHeight !== undefined && lineZ >= map.elevAt(tx, ty) + t.featureHeight) {
        // over the canopy — no opacity or cover-behind from this tile
      } else {
        opacity += t.opacity;
        if (opacity >= 1) return { visible: false, cover: 0, conceal: 1 };
        if (t.coverBehind !== undefined) {
          lastLip = t.coverBehind;
          lastLipT = tEntry;
        }
      }
    }
  }

  if (lastWindowT >= 0 && (1 - lastWindowT) * len <= 2) cover = Math.max(cover, 0.5);
  if (lastBreachT >= 0 && (1 - lastBreachT) * len <= 2) cover = Math.max(cover, BREACH_COVER);
  if (lastLipT >= 0 && (1 - lastLipT) * len <= 2) cover = Math.max(cover, lastLip);
  return { visible: true, cover, conceal: Math.min(1, opacity) };
}
