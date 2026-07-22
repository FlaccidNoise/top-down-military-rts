import { TERRAIN, type TerrainDef, type TerrainKey } from './data';

// Walls live on tile EDGES (thin walls, Door Kickers-style) so building
// interiors are ordinary walkable space. This is load-bearing for room-by-room
// clearing later — do not convert to solid wall tiles.
export const EDGE = { NONE: 0, WALL: 1, DOOR: 2, WINDOW: 3 } as const;
export type EdgeType = (typeof EDGE)[keyof typeof EDGE];

const TERRAIN_KEYS = Object.keys(TERRAIN) as TerrainKey[];

export class GameMap {
  readonly tiles: Uint8Array; // index into TERRAIN_KEYS
  readonly hEdges: Uint8Array; // hEdge(x,y): edge on north side of tile (x,y); y in 0..h
  readonly vEdges: Uint8Array; // vEdge(x,y): edge on west side of tile (x,y); x in 0..w

  constructor(readonly w: number, readonly h: number, fill: TerrainKey = 'grass') {
    this.tiles = new Uint8Array(w * h).fill(TERRAIN_KEYS.indexOf(fill));
    this.hEdges = new Uint8Array((h + 1) * w);
    this.vEdges = new Uint8Array(h * (w + 1));
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

  // Can a unit step between two orthogonally adjacent tiles?
  // Vehicles can't enter buildings or woods and never pass any edge feature.
  canStep(x0: number, y0: number, x1: number, y1: number, mode: 'foot' | 'vehicle' = 'foot'): boolean {
    if (!this.inBounds(x1, y1) || !this.terrainAt(x1, y1).passable) return false;
    if (mode === 'vehicle') {
      const k = this.terrainKeyAt(x1, y1);
      if (k === 'floor' || k === 'woods') return false;
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
}

// Grid traversal (Amanatides & Woo). Walls block sight; doors and windows pass.
// Terrain opacity accumulates; a window crossed within 2m of the target grants
// window cover (the target is "at the window", exposed only through it).
export function los(map: GameMap, x0: number, y0: number, x1: number, y1: number): LosResult {
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  const tx1 = Math.floor(x1);
  const ty1 = Math.floor(y1);
  let cover = map.terrainAt(tx1, ty1).cover;
  if (tx === tx1 && ty === ty1) return { visible: true, cover };

  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = dx !== 0 ? (stepX > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY : Infinity;

  let opacity = 0;
  let lastWindowT = -1;
  let guard = map.w + map.h + 4;

  while ((tx !== tx1 || ty !== ty1) && guard-- > 0) {
    if (tMaxX < tMaxY) {
      const e = map.vEdge(stepX > 0 ? tx + 1 : tx, ty);
      if (e === EDGE.WALL) return { visible: false, cover: 0 };
      if (e === EDGE.WINDOW) lastWindowT = tMaxX;
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      const e = map.hEdge(tx, stepY > 0 ? ty + 1 : ty);
      if (e === EDGE.WALL) return { visible: false, cover: 0 };
      if (e === EDGE.WINDOW) lastWindowT = tMaxY;
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (tx !== tx1 || ty !== ty1) {
      opacity += map.terrainAt(tx, ty).opacity;
      if (opacity >= 1) return { visible: false, cover: 0 };
    }
  }

  if (lastWindowT >= 0 && (1 - lastWindowT) * len <= 2) cover = Math.max(cover, 0.5);
  return { visible: true, cover };
}
