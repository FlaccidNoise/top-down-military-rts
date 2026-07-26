import type { GameMap } from '../sim/map';

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

export interface Square {
  cx: number;
  cy: number;
  r: number;
}

export class PatchIndex {
  readonly buildings: BuildingBox[] = [];
  readonly squares: Square[] = [];

  constructor(map: GameMap) {
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
      if (near.size < 4) continue;
      this.squares.push({ cx, cy, r: Math.min(11, Math.max(8, 8 + 0.4 * Math.min(6, near.size))) });
    }
  }

  // 0..1 paving weight for a tile centre — a ramp, not a hard disc, so the
  // square never shows a drawn circular boundary.
  pavedAt(x: number, y: number): number {
    let a = 0;
    for (const s of this.squares) {
      const d = Math.hypot(x + 0.5 - s.cx, y + 0.5 - s.cy);
      // capped below 1 so the dirt base always reads through the setts and the
      // square never looks like a pasted-on layer
      a = Math.max(a, Math.min(0.88, (s.r - d) / 3.5));
    }
    return Math.max(0, a);
  }
}
