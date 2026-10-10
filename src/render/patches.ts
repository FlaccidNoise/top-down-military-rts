import type { TerrainKey } from '../sim/data';
import type { GameMap } from '../sim/map';
import { hash } from './noise';

// Render-side map structure derived once at load, purely from GameMap — the
// battle map has no civic data on the Sim, so "where is the village square"
// has to be inferred from road topology and building density.

export interface BuildingBox {
  id: number;
  minX: number;
  minY: number;
  maxX: number; // exclusive
  maxY: number;
  cx: number;
  cy: number;
}

// The paved civic surface around a crossing. Axis half-extents, not one
// radius (T19/N5): a bourg place is a street WIDENING, 30-40 m along the
// Grande Rue by 10-14 m across, and a disc capped at 11 m leaves its two ends
// bare. `pavedAt` ramps off a rounded rectangle of these half-extents, whose
// corner radius is min(rx, ry) — so a square one (rx === ry, every legacy
// crossing) is the same disc, to the bit, that it was before.
export interface Square {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

// A parcel: one 4-connected region of field or woods. Field art is keyed on
// this rather than on an 8 m block, which is what stops adjacent blocks of the
// same farmed field disagreeing about which way the rows run (the graph-paper
// patchwork base-farm used to show).
export interface Patch {
  kind: TerrainKey;
  tiles: number;
  minX: number;
  minY: number;
  maxX: number; // exclusive
  maxY: number;
  cx: number;
  cy: number;
  seed: number;
}

// Tiles of road that must sit between a tile and the nearest non-road ground
// before that tile counts as a place rather than a street. 3 is the first
// value no legacy map reaches (measured: town/road/bridge/river all top out
// at 2), which is what makes T19 additive.
const PLACE_DEPTH = 3;
// The deep core stops 2 tiles short of the road's edge, plus a half tile of
// spill onto the frontage where the setts run up to the doorsteps.
const PLACE_PAD = 2.6;
const PLACE_SNAP = 3;

interface PlaceBox {
  minX: number;
  minY: number;
  maxX: number; // exclusive
  maxY: number;
}

export interface Junction {
  x: number;
  y: number;
  degree: number; // orthogonal road neighbours at the cluster centroid
  buildings: number; // distinct footprints within 22 m
}

export class PatchIndex {
  readonly buildings: BuildingBox[] = [];
  readonly squares: Square[] = [];
  // parcel id per tile, -1 for anything that is neither field nor woods
  readonly id: Int16Array;
  readonly patches: Patch[] = [];
  readonly junctions: Junction[] = [];
  private readonly w: number;
  private readonly h: number;

  constructor(map: GameMap) {
    this.w = map.w;
    this.h = map.h;
    this.id = new Int16Array(map.w * map.h).fill(-1);
    const byId = new Map<number, BuildingBox>();
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const id = map.buildingIdAt(x, y);
        if (id < 0) continue;
        const b = byId.get(id);
        if (!b) byId.set(id, { id, minX: x, minY: y, maxX: x + 1, maxY: y + 1, cx: 0, cy: 0 });
        else {
          b.minX = Math.min(b.minX, x);
          b.minY = Math.min(b.minY, y);
          b.maxX = Math.max(b.maxX, x + 1);
          b.maxY = Math.max(b.maxY, y + 1);
        }
      }
    }
    for (const b of byId.values()) {
      b.cx = (b.minX + b.maxX) / 2;
      b.cy = (b.minY + b.maxY) / 2;
      this.buildings.push(b);
    }

    // 4-connected flood over field and woods only. Grass is one region and has
    // nothing keyed on it; roads and water break parcels apart, which is
    // exactly the boundary a real hedged field has.
    const fill: number[] = [];
    for (let y0 = 0; y0 < map.h; y0++) {
      for (let x0 = 0; x0 < map.w; x0++) {
        const i0 = y0 * map.w + x0;
        if (this.id[i0] >= 0) continue;
        const kind = map.terrainKeyAt(x0, y0);
        if (kind !== 'field' && kind !== 'woods') continue;
        const pid = this.patches.length;
        const p: Patch = { kind, tiles: 0, minX: x0, minY: y0, maxX: x0 + 1, maxY: y0 + 1, cx: 0, cy: 0, seed: 0 };
        this.id[i0] = pid;
        fill.push(i0);
        let sx = 0;
        let sy = 0;
        while (fill.length) {
          const i = fill.pop()!;
          const x = i % map.w;
          const y = (i / map.w) | 0;
          p.tiles++;
          sx += x + 0.5;
          sy += y + 0.5;
          if (x < p.minX) p.minX = x;
          if (y < p.minY) p.minY = y;
          if (x + 1 > p.maxX) p.maxX = x + 1;
          if (y + 1 > p.maxY) p.maxY = y + 1;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
            const qx = x + dx;
            const qy = y + dy;
            if (qx < 0 || qy < 0 || qx >= map.w || qy >= map.h) continue;
            const q = qy * map.w + qx;
            if (this.id[q] >= 0 || map.terrainKeyAt(qx, qy) !== kind) continue;
            this.id[q] = pid;
            fill.push(q);
          }
        }
        p.cx = sx / p.tiles;
        p.cy = sy / p.tiles;
        // seeded off the parcel's top-left corner, not its index, so a parcel
        // keeps its crop when an unrelated parcel elsewhere changes
        p.seed = (hash(p.minX, p.minY, 240) * 65536) | 0;
        this.patches.push(p);
      }
    }

    // A crossing is where the road reaches far along BOTH axes. Counting
    // orthogonal road neighbours does not work here: mapgen's arterial is 3
    // tiles wide, so every tile in its interior has four of them.
    const roadAt = (x: number, y: number) => map.inBounds(x, y) && map.terrainKeyAt(x, y) === 'road' && !map.isBridge(x, y);
    const reach = (x: number, y: number, dx: number, dy: number) => {
      let n = 1;
      for (let i = 1; i <= 8 && roadAt(x - dx * i, y - dy * i); i++) n++;
      for (let i = 1; i <= 8 && roadAt(x + dx * i, y + dy * i); i++) n++;
      return n;
    };
    const cross = new Uint8Array(map.w * map.h);
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (!roadAt(x, y)) continue;
        const h = reach(x, y, 1, 0);
        if (h > 1 && h === reach(x, y, 0, 1)) cross[y * map.w + x] = 1;
      }
    }
    const [placeId, places] = this.findPlaces(map, roadAt);
    // one square per connected crossing box, kept only where enough buildings
    // stand around it — the >= 4 test is what stops a lone farm lane junction
    // getting cobbled
    const seen = new Uint8Array(map.w * map.h);
    const stack: number[] = [];
    for (let i = 0; i < cross.length; i++) {
      if (!cross[i] || seen[i]) continue;
      stack.push(i);
      seen[i] = 1;
      let sx = 0;
      let sy = 0;
      let n = 0;
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % map.w;
        const py = (p / map.w) | 0;
        sx += px + 0.5;
        sy += py + 0.5;
        n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
          const qx = px + dx;
          const qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= map.w || qy >= map.h) continue;
          const q = qy * map.w + qx;
          if (cross[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      const cx = sx / n;
      const cy = sy / n;
      const near = new Set<number>();
      for (const b of this.buildings) {
        if (Math.hypot(b.cx - cx, b.cy - cy) <= 22) near.add(b.id);
      }
      const jx = Math.floor(cx);
      const jy = Math.floor(cy);
      this.junctions.push({
        x: cx,
        y: cy,
        degree: Number(roadAt(jx - 1, jy)) + Number(roadAt(jx + 1, jy)) + Number(roadAt(jx, jy - 1)) + Number(roadAt(jx, jy + 1)),
        buildings: near.size,
      });
      if (near.size < 4) continue;
      const r = Math.min(11, Math.max(8, 8 + 0.4 * Math.min(6, near.size)));
      // A crossing standing in a place takes the place's own outline instead
      // of its disc. Every crossing inside one widening resolves to the SAME
      // rectangle, so the twenty-odd junctions a bourg place throws off
      // collapse to one square rather than paving a lumpy union of discs.
      const p = places[this.placeNear(placeId, map.w, map.h, cx, cy)] ?? null;
      const sq: Square = p
        ? { cx: (p.minX + p.maxX) / 2, cy: (p.minY + p.maxY) / 2, rx: (p.maxX - p.minX) / 2 + PLACE_PAD, ry: (p.maxY - p.minY) / 2 + PLACE_PAD }
        : { cx, cy, rx: r, ry: r };
      if (!this.squares.some((s) => s.cx === sq.cx && s.cy === sq.cy && s.rx === sq.rx && s.ry === sq.ry)) this.squares.push(sq);
    }
  }

  // Chebyshev depth into the road surface, then the 4-connected components of
  // everything at least PLACE_DEPTH deep. Depth is what separates a market
  // place from a crossroads: a 3-tile arterial tops out at depth 1 and a
  // legacy crossing box at 2, measured over town/road/bridge/river, so no
  // legacy map has a place and every legacy square keeps its disc. A bourg
  // place, 11-17 tiles across, reaches 5-8.
  private findPlaces(map: GameMap, roadAt: (x: number, y: number) => boolean): [Int32Array, PlaceBox[]] {
    const w = map.w;
    const h = map.h;
    const id = new Int32Array(w * h).fill(-1);
    const out: PlaceBox[] = [];
    // BFS seeded on road tiles that touch anything else — only road tiles are
    // ever enqueued, so this walks the road network (~3k tiles), not the map.
    const depth = new Int16Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let toe = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!roadAt(x, y)) continue;
        let rim = false;
        for (let dy = -1; dy <= 1 && !rim; dy++) for (let dx = -1; dx <= 1; dx++) if (!roadAt(x + dx, y + dy)) { rim = true; break; }
        if (!rim) continue;
        depth[y * w + x] = 1;
        queue[toe++] = y * w + x;
      }
    }
    while (head < toe) {
      const i = queue[head++];
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!roadAt(nx, ny) || depth[ny * w + nx]) continue;
          depth[ny * w + nx] = depth[i] + 1;
          queue[toe++] = ny * w + nx;
        }
      }
    }
    const stack: number[] = [];
    for (let s = 0; s < depth.length; s++) {
      if (depth[s] < PLACE_DEPTH || id[s] >= 0) continue;
      const pid = out.length;
      const box: PlaceBox = { minX: s % w, minY: (s / w) | 0, maxX: (s % w) + 1, maxY: ((s / w) | 0) + 1 };
      id[s] = pid;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        const y = (i / w) | 0;
        if (x < box.minX) box.minX = x;
        if (y < box.minY) box.minY = y;
        if (x + 1 > box.maxX) box.maxX = x + 1;
        if (y + 1 > box.maxY) box.maxY = y + 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (id[j] >= 0 || depth[j] < PLACE_DEPTH) continue;
          id[j] = pid;
          stack.push(j);
        }
      }
      out.push(box);
    }
    return [id, out];
  }

  // Nearest place within PLACE_SNAP of a crossing centroid, or -1. The snap
  // exists because the crossing test fires on a diagonal ridge across a
  // widening, and the ridge runs a couple of tiles outside the deep core at
  // its ends.
  private placeNear(id: Int32Array, w: number, h: number, cx: number, cy: number): number {
    const jx = Math.floor(cx);
    const jy = Math.floor(cy);
    for (let ring = 0; ring <= PLACE_SNAP; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (id[ny * w + nx] >= 0) return id[ny * w + nx];
        }
      }
    }
    return -1;
  }

  // The parcel a tile belongs to, as a number: -1 for none. Two tiles are in
  // the same parcel exactly when this agrees.
  patchIdAt(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : this.id[y * this.w + x];
  }

  patchAt(x: number, y: number): Patch | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = this.id[y * this.w + x];
    return i < 0 ? null : this.patches[i];
  }

  // 0..1 paving weight for a tile centre — a ramp, not a hard disc, so the
  // square never shows a drawn circular boundary.
  pavedAt(x: number, y: number): number {
    let a = 0;
    for (const s of this.squares) {
      // Signed distance to a rounded rectangle of half-extents (rx, ry) with
      // corner radius min(rx, ry). On a square one both q terms are exactly
      // |offset|, so `d` is the plain radial distance and the whole expression
      // reduces to the disc ramp this was before T19.
      const cr = Math.min(s.rx, s.ry);
      const qx = Math.abs(x + 0.5 - s.cx) - (s.rx - cr);
      const qy = Math.abs(y + 0.5 - s.cy) - (s.ry - cr);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cr;
      // capped below 1 so the dirt base always reads through the setts and the
      // square never looks like a pasted-on layer
      a = Math.max(a, Math.min(0.88, -d / 3.5));
    }
    return Math.max(0, a);
  }
}
