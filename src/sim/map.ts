import { TERRAIN, type TerrainDef, type TerrainKey } from './data';

// Walls live on tile EDGES (thin walls, Door Kickers-style) so building
// interiors are ordinary walkable space. This is load-bearing for room-by-room
// clearing later — do not convert to solid wall tiles.
export const EDGE = { NONE: 0, WALL: 1, DOOR: 2, WINDOW: 3 } as const;
export type EdgeType = (typeof EDGE)[keyof typeof EDGE];

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
  // Vehicles can't enter buildings or woods and never pass any edge feature.
  canStep(x0: number, y0: number, x1: number, y1: number, mode: 'foot' | 'vehicle' = 'foot'): boolean {
    if (!this.inBounds(x1, y1) || !this.terrainAt(x1, y1).passable) return false;
    if (mode === 'vehicle') {
      const k = this.terrainKeyAt(x1, y1);
      if (k === 'floor' || k === 'woods' || k === 'hedge') return false;
    }
    let e: EdgeType = EDGE.NONE;
    if (x1 === x0 + 1) e = this.vEdge(x1, y0);
    else if (x1 === x0 - 1) e = this.vEdge(x0, y0);
    else if (y1 === y0 + 1) e = this.hEdge(x0, y1);
    else if (y1 === y0 - 1) e = this.hEdge(x0, y0);
    if (mode === 'vehicle') return e === EDGE.NONE;
    return e === EDGE.NONE || e === EDGE.DOOR; // walls and windows block movement
  }
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
export function los(map: GameMap, x0: number, y0: number, x1: number, y1: number, l0 = 0, l1 = 0): LosResult {
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
  const z0 = map.elevAt(tx0, ty0) + l0 * FLOOR_H + EYE_H;
  const z1 = map.elevAt(tx1, ty1) + l1 * FLOOR_H + EYE_H;
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
  if (lastLipT >= 0 && (1 - lastLipT) * len <= 2) cover = Math.max(cover, lastLip);
  return { visible: true, cover, conceal: Math.min(1, opacity) };
}
