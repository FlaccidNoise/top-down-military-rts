import { EDGE, type GameMap } from '../sim/map';
import { AO_ALPHA, shadowAlpha, shadowOffset, shadowSoftAlpha, sun, sunStepFor } from './light';
import { hash } from './noise';
import { stamp } from './stamps';
import type { Detail } from './terrain';

// Free-standing masonry (T18/N4) and what stands inside it (T20/N6).
//
// `drawEdge` draws every wall edge the same thin dark line, so a churchyard
// enclosure, a garden boundary and a house wall are indistinguishable today.
// The bourg generator marks the difference in data and nothing read it: a
// free-standing wall is an EDGE.WALL whose top code is 1 (waist, see over) or
// 2 (head, blocks LOS both ways) with NO building on either side of it —
// docs/plans/2026-07-26-town-gen-design.md §3.2's wall-top table. A gate is an
// EDGE.DOOR in such a run.
//
// Everything here is derived from the GameMap alone (plus `role` for telling a
// churchyard from a farm cour) and every legacy kind produces an empty index:
// measured over town/road/bridge/river, no legacy map writes a single non-zero
// edge top. Salts 320-339.

export type Top = 1 | 2;

// Edge codes in the two masks. Deliberately not the EDGE.* values — a gate
// here is a DOOR that belongs to a wall WE own, which is a different fact
// from "this edge is a door".
const NONE = 0;
const LOW = 1; // top 1 — waist-high plot boundary
const HIGH = 2; // top 2 — head-high enclosure, churchyard, rear boundary, yard
const GATE = 3;

export interface WallRun {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  top: Top;
}

export interface GateRun {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  top: Top; // inherited from the run it was punched in
}

// What an enclosed pocket of ground is for. Everything the generator walls in
// is one of three things, and each wants completely different ground.
export type EnclosureKind = 'churchyard' | 'yard' | 'garden';

export interface Enclosure {
  kind: EnclosureKind;
  minX: number;
  minY: number;
  maxX: number; // exclusive
  maxY: number;
  tiles: number;
  seed: number;
}

// A pocket has to be worth dressing. Under 8 tiles is a gap between two
// buildings, over 700 is the open country behind the last garden wall.
const MIN_POCKET = 8;
const MAX_POCKET = 700;
// A working yard is trodden bare; a back garden is grass with a bed in it, and
// putting beaten earth over 300 tiles of block interior gives the town a mud
// lake. Enclosure alone does not separate them — measured over bourg seeds
// 10-12, the garden band behind a terrace is 34-50% building perimeter, the
// same as a cour, because a terrace IS a wall of buildings along one side.
// Size does: §1.3 builds a cour round a 9-13 tile yard, while a block interior
// runs 19-24 tiles across whatever its perimeter says.
const YARD_BUILT = 0.35;
const YARD_MAX_TILES = 110;
const YARD_MAX_SPAN = 14;

export class EnclosureIndex {
  readonly hFree: Uint8Array; // (h+1) * w
  readonly vFree: Uint8Array; // h * (w+1)
  readonly runs: WallRun[] = [];
  readonly gates: GateRun[] = [];
  readonly enclosures: Enclosure[] = [];
  readonly enclosureAt: Int32Array; // per tile, -1 outside every pocket
  private readonly map: GameMap;
  private readonly w: number;
  private readonly h: number;

  get any(): boolean {
    return this.runs.length > 0;
  }

  constructor(map: GameMap, churchTiles: Uint8Array) {
    const w = map.w;
    const h = map.h;
    this.map = map;
    this.w = w;
    this.h = h;
    this.hFree = new Uint8Array((h + 1) * w);
    this.vFree = new Uint8Array(h * (w + 1));
    this.enclosureAt = new Int32Array(w * h).fill(-1);
    this.derive();
    if (this.any) this.pockets(map, churchTiles);
  }

  // Masks and runs, from the map's edge bytes alone. Re-runnable, because the
  // sim mutates those bytes mid-battle (D1/D2 breaching) — see `refresh()`.
  // `pockets()` is deliberately NOT part of it: a garden with a hole in its
  // wall is still a garden, and re-flooding would move the ground dressing
  // under the player's feet.
  private derive(): void {
    const map = this.map;
    const w = this.w;
    const h = this.h;
    this.hFree.fill(0);
    this.vFree.fill(0);
    this.runs.length = 0;
    this.gates.length = 0;
    const built = (x: number, y: number) => map.buildingIdAt(x, y) >= 0;

    for (let y = 0; y <= h; y++) {
      for (let x = 0; x < w; x++) {
        const e = map.hEdges[y * w + x];
        if (e !== EDGE.WALL && e !== EDGE.DOOR) continue;
        if (built(x, y - 1) || built(x, y)) continue;
        const t = map.hEdgeTops[y * w + x];
        if (e === EDGE.WALL && (t === 1 || t === 2)) this.hFree[y * w + x] = t;
        else if (e === EDGE.DOOR) this.hFree[y * w + x] = GATE;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x <= w; x++) {
        const e = map.vEdges[y * (w + 1) + x];
        if (e !== EDGE.WALL && e !== EDGE.DOOR) continue;
        if (built(x - 1, y) || built(x, y)) continue;
        const t = map.vEdgeTops[y * (w + 1) + x];
        if (e === EDGE.WALL && (t === 1 || t === 2)) this.vFree[y * (w + 1) + x] = t;
        else if (e === EDGE.DOOR) this.vFree[y * (w + 1) + x] = GATE;
      }
    }

    // A DOOR with no building either side is only OUR gate if it interrupts a
    // wall we own. A rear door onto a garden already fails the building test;
    // this catches the rest — a lone DOOR in open ground is somebody else's
    // and keeps the generic edge art.
    const inherit = (mask: Uint8Array, i: number, stride: number, lo: number, hi: number): void => {
      if (mask[i] !== GATE) return;
      for (let k = 1; k <= 3; k++) {
        for (const j of [i - k * stride, i + k * stride]) {
          if (j < lo || j >= hi) continue;
          const m = mask[j];
          if (m === LOW || m === HIGH) {
            mask[i] = GATE + m; // 4 = gate in a waist wall, 5 = gate in a head wall
            return;
          }
          // a 2-tile cart gate: the neighbour is the other leaf, already resolved
          if (m === GATE + LOW || m === GATE + HIGH) {
            mask[i] = m;
            return;
          }
        }
      }
      mask[i] = NONE;
    };
    // A run is collinear with its own axis: horizontal edges neighbour along x
    // (stride 1, clamped to the row), vertical edges along y (stride w+1).
    for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) inherit(this.hFree, y * w + x, 1, y * w, y * w + w);
    for (let x = 0; x <= w; x++) for (let y = 0; y < h; y++) inherit(this.vFree, y * (w + 1) + x, w + 1, 0, h * (w + 1));

    this.collect(this.hFree, true);
    this.collect(this.vFree, false);
  }

  /**
   * Re-derive after the sim breached something, and report the tile box the
   * art moved in — or null if nothing changed.
   *
   * Re-derives WHOLE, not per-row, and that is the point: a fresh index of the
   * mutated map is the definition of correct here, so producing it by the same
   * code path is the only version that cannot drift. It is ~0.5 ms on a 320x240
   * bourg and it runs once per breach BATCH, not once per edge.
   *
   * The box is the union of every run that appeared or vanished, because the
   * rubble coursing is phased ALONG a run: splitting a 20 m wall at its middle
   * re-phases the stones over its whole length, and invalidating only the metre
   * with the hole in it leaves a visible course jump at the next chunk seam.
   */
  refresh(): [number, number, number, number] | null {
    const key = (r: WallRun | GateRun): string => `${r.ax},${r.ay},${r.bx},${r.by},${r.top}`;
    const before = [...this.runs, ...this.gates];
    const beforeKeys = new Set(before.map(key));
    this.derive();
    const after = [...this.runs, ...this.gates];
    const afterKeys = new Set(after.map(key));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (r: WallRun | GateRun): void => {
      x0 = Math.min(x0, r.ax, r.bx);
      y0 = Math.min(y0, r.ay, r.by);
      x1 = Math.max(x1, r.ax, r.bx);
      y1 = Math.max(y1, r.ay, r.by);
    };
    for (const r of before) if (!afterKeys.has(key(r))) grow(r);
    for (const r of after) if (!beforeKeys.has(key(r))) grow(r);
    // one tile of slack: a wall STRADDLES its edge, so a run along y = 12 paints
    // into the tiles above and below it
    return x0 === Infinity ? null : [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  }

  // Maximal collinear runs of the same code, so a 30 m churchyard wall is one
  // stroke per layer rather than 30 overlapping ones — the layered idiom
  // (AO, shadow, mass, rim) only reads correctly on a continuous path.
  private collect(mask: Uint8Array, horizontal: boolean): void {
    const w = this.w;
    const h = this.h;
    const outer = horizontal ? h + 1 : w + 1;
    const inner = horizontal ? w : h;
    for (let o = 0; o < outer; o++) {
      let start = -1;
      let code = NONE;
      const flush = (end: number): void => {
        if (start < 0) return;
        const ax = horizontal ? start : o;
        const ay = horizontal ? o : start;
        const bx = horizontal ? end : o;
        const by = horizontal ? o : end;
        if (code === LOW || code === HIGH) this.runs.push({ ax, ay, bx, by, top: code });
        else this.gates.push({ ax, ay, bx, by, top: code === GATE + HIGH ? 2 : 1 });
        start = -1;
        code = NONE;
      };
      for (let i = 0; i < inner; i++) {
        const c = mask[horizontal ? o * w + i : i * (w + 1) + o];
        if (c !== code) {
          flush(i);
          if (c !== NONE) {
            start = i;
            code = c;
          }
        }
      }
      flush(inner);
    }
  }

  // Pockets of ground that free-standing masonry closes off from the street.
  // Roads block as well as walls: the flood is over BACK land, and a garden
  // that opens onto the Grande Rue through a gap in the frontage is still a
  // garden even though it is not sealed.
  private pockets(map: GameMap, churchTiles: Uint8Array): void {
    const w = this.w;
    const h = this.h;
    // Visited is separate from enclosureAt because most components are
    // REJECTED — the open country behind the last garden wall is one region of
    // tens of thousands of tiles. Marking membership in enclosureAt and
    // unwinding it on rejection leaves those tiles unvisited, so the outer
    // scan re-floods the whole region once per tile in it: quadratic, and on a
    // 320x240 map that is ~10^9 steps in a constructor.
    const seen = new Uint8Array(w * h);
    const cells: number[] = [];
    const stack: number[] = [];
    for (let s = 0; s < seen.length; s++) {
      if (seen[s]) continue;
      const sx = s % w;
      const sy = (s / w) | 0;
      if (map.buildingIdAt(sx, sy) >= 0 || map.terrainKeyAt(sx, sy) === 'road') continue;
      const id = this.enclosures.length;
      cells.length = 0;
      let tiles = 0;
      let minX = sx;
      let minY = sy;
      let maxX = sx + 1;
      let maxY = sy + 1;
      let perim = 0;
      let builtPerim = 0;
      let walled = 0;
      let church = false;
      let border = false;
      seen[s] = 1;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        const y = (i / w) | 0;
        tiles++;
        cells.push(i);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + 1 > maxX) maxX = x + 1;
        if (y + 1 > maxY) maxY = y + 1;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
        const step = (nx: number, ny: number, blocked: boolean): void => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            perim++;
            return;
          }
          const j = ny * w + nx;
          if (map.buildingIdAt(nx, ny) >= 0) {
            perim++;
            builtPerim++;
            if (churchTiles[j]) church = true;
            return;
          }
          if (blocked) {
            perim++;
            walled++;
            return;
          }
          if (map.terrainKeyAt(nx, ny) === 'road') {
            perim++;
            return;
          }
          if (seen[j]) return;
          seen[j] = 1;
          stack.push(j);
        };
        step(x + 1, y, this.vFree[y * (w + 1) + x + 1] !== NONE);
        step(x - 1, y, this.vFree[y * (w + 1) + x] !== NONE);
        step(x, y + 1, this.hFree[(y + 1) * w + x] !== NONE);
        step(x, y - 1, this.hFree[y * w + x] !== NONE);
      }
      if (border || tiles < MIN_POCKET || tiles > MAX_POCKET || walled === 0) continue;
      // enclosureAt only ever names a pocket we dress
      for (const i of cells) this.enclosureAt[i] = id;
      const compact = tiles <= YARD_MAX_TILES && Math.max(maxX - minX, maxY - minY) <= YARD_MAX_SPAN;
      const kind: EnclosureKind = church ? 'churchyard' : compact && builtPerim / perim >= YARD_BUILT ? 'yard' : 'garden';
      this.enclosures.push({ kind, minX, minY, maxX, maxY, tiles, seed: (hash(minX, minY, 320) * 65536) | 0 });
    }
  }

  enclosureIdAt(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.enclosureAt[y * this.w + x] : -1;
  }

  /** True when this horizontal edge is ours to draw — terrain skips it. */
  ownsH(x: number, y: number): boolean {
    return x >= 0 && x < this.w && y >= 0 && y <= this.h && this.hFree[y * this.w + x] !== NONE;
  }

  ownsV(x: number, y: number): boolean {
    return x >= 0 && x <= this.w && y >= 0 && y < this.h && this.vFree[y * (this.w + 1) + x] !== NONE;
  }
}

type Ctx = CanvasRenderingContext2D;
type Seg = [number, number, number, number];
const TAU = Math.PI * 2;

function strokeSegs(g: Ctx, segs: Seg[], width: number, style: string, odx = 0, ody = 0): void {
  if (segs.length === 0) return;
  g.lineWidth = width;
  g.strokeStyle = style;
  g.beginPath();
  for (const [ax, ay, bx, by] of segs) {
    g.moveTo(ax + odx, ay + ody);
    g.lineTo(bx + odx, by + ody);
  }
  g.stroke();
}

// Two builds of the same limestone. The waist-high plot wall keeps the warm
// tones the legacy yard walls already use (yards.ts WALL_TONES), so a bourg
// garden boundary and a 'town' farm boundary read as the same material on a
// map that has both.
//
// The head-high enclosure is wider, cooler and DARKER, not brighter. That is
// counter-intuitive and it is the whole trick: doubling the height doubles the
// mass in frame, so matching the low wall's value made a churchyard the
// lightest object on screen and broke the muted ceiling. A 2 m wall is mostly
// its own shaded flank with one lit course along the top — heavy body, thin
// highlight — which reads as tall without ever going pale.
const TONES: Record<Top, string[]> = {
  1: ['rgb(128,122,110)', 'rgb(112,108,98)', 'rgb(140,132,118)', 'rgb(101,100,90)'],
  2: ['rgb(105,106,100)', 'rgb(88,89,86)', 'rgb(124,125,119)', 'rgb(78,80,78)'],
};
const WIDTH: Record<Top, number> = { 1: 0.28, 2: 0.46 };
const RISE: Record<Top, number> = { 1: 0.6, 2: 1.25 }; // metres of fake height driving the shadow
const BLOCK: Record<Top, number> = { 1: 0.45, 2: 0.6 }; // rubble course length

const hits = (r: { ax: number; ay: number; bx: number; by: number }, tx0: number, ty0: number, tx1: number, ty1: number): boolean =>
  Math.max(r.ax, r.bx) >= tx0 - 1 && Math.min(r.ax, r.bx) <= tx1 + 1 && Math.max(r.ay, r.by) >= ty0 - 1 && Math.min(r.ay, r.by) <= ty1 + 1;

export function drawEnclosureWalls(g: Ctx, idx: EnclosureIndex, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  if (!idx.any) return;
  for (const top of [1, 2] as Top[]) {
    const segs: Seg[] = [];
    for (const r of idx.runs) if (r.top === top && hits(r, tx0, ty0, tx1, ty1)) segs.push([r.ax, r.ay, r.bx, r.by]);
    if (segs.length === 0) continue;
    const wd = WIDTH[top];
    const [sdx, sdy] = shadowOffset(RISE[top]);
    strokeSegs(g, segs, wd * 1.55, `rgba(8,10,7,${(AO_ALPHA * 0.6).toFixed(3)})`);
    strokeSegs(g, segs, wd * 1.3, `rgba(10,14,8,${shadowSoftAlpha()})`, sdx * 1.5, sdy * 1.5);
    strokeSegs(g, segs, wd * 1.15, `rgba(10,14,8,${shadowAlpha()})`, sdx, sdy);
    // A head-high wall is told from a waist-high one by its WIDTH (0.46 vs
    // 0.28 m of coping) and by how far its shadow reaches (RISE 1.25 vs 0.6) —
    // the two things a strict plan projection has. This used to paint the SE
    // flank as "a visible face", which is a side view of a wall.
    if (top === 2) strokeSegs(g, segs, wd * 1.15, `rgba(10,14,8,${(shadowAlpha() * 0.55).toFixed(3)})`, sdx * 0.55, sdy * 0.55);
    // Mass in rubble courses, value-jittered and bucketed into four tones so
    // the whole enclosure is four strokes rather than one per block.
    const buckets: Seg[][] = [[], [], [], []];
    const caps: Seg[] = [];
    let blk = 0;
    for (const [ax, ay, bx, by] of segs) {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(len / BLOCK[top]));
      for (let i = 0; i < n; i++) {
        const f0 = i / n;
        const f1 = (i + 1) / n;
        buckets[(hash(blk, top, 321) * 4) | 0].push([ax + (bx - ax) * f0, ay + (by - ay) * f0, ax + (bx - ax) * f1, ay + (by - ay) * f1]);
        blk++;
      }
      if (d < 1) continue;
      const m = Math.max(1, Math.round(len / (top === 2 ? 0.62 : 0.5)));
      for (let i = 0; i < m; i++) {
        const f = (i + 0.5) / m;
        const cx = ax + (bx - ax) * f;
        const cy = ay + (by - ay) * f;
        caps.push([cx - ((by - ay) / len) * 0.05, cy + ((bx - ax) / len) * 0.05, cx + ((by - ay) / len) * 0.05, cy - ((bx - ax) / len) * 0.05]);
      }
    }
    for (let i = 0; i < 4; i++) strokeSegs(g, buckets[i], wd, TONES[top][i]);
    strokeSegs(g, segs, wd * (top === 2 ? 0.2 : 0.28), top === 2 ? 'rgba(196,190,172,0.26)' : 'rgba(214,206,186,0.22)', -sdx * (top === 2 ? 0.4 : 0.3), -sdy * (top === 2 ? 0.4 : 0.3));
    if (d >= 1) strokeSegs(g, caps, wd * (top === 2 ? 0.6 : 0.9), 'rgba(196,190,172,0.14)', -sdx * 0.24, -sdy * 0.24);
    if (d < 2) continue;
    const ticks: Seg[] = [];
    for (const [ax, ay, bx, by] of segs) {
      const len = Math.hypot(bx - ax, by - ay);
      const nx = (by - ay) / len;
      const ny = -(bx - ax) / len;
      const n = Math.max(1, Math.round(len / BLOCK[top]));
      for (let i = 1; i < n; i++) {
        const f = i / n;
        const cx = ax + (bx - ax) * f;
        const cy = ay + (by - ay) * f;
        ticks.push([cx + nx * wd * 0.42, cy + ny * wd * 0.42, cx - nx * wd * 0.42, cy - ny * wd * 0.42]);
      }
    }
    strokeSegs(g, ticks, top === 2 ? 0.045 : 0.035, 'rgba(66,63,56,0.34)');
  }
  for (const gt of idx.gates) if (hits(gt, tx0, ty0, tx1, ty1)) drawGate(g, gt, d);
}

// Gate posts and a plank leaf. A 2-tile cart gate (the farm cour's, §1.3) gets
// two leaves meeting in the middle; anything narrower gets one.
function drawGate(g: Ctx, gt: GateRun, d: Detail): void {
  const len = Math.hypot(gt.bx - gt.ax, gt.by - gt.ay);
  if (len <= 0) return;
  const ux = (gt.bx - gt.ax) / len;
  const uy = (gt.by - gt.ay) / len;
  const nx = -uy;
  const ny = ux;
  // The SAME throw as the run this gate is punched into — a gate that shades
  // 10% further than the wall on either side of it breaks the joint.
  const [sdx, sdy] = shadowOffset(RISE[gt.top]);
  const pr = WIDTH[gt.top] * 0.62; // pier half-size
  // leaf first, so the piers cap its ends
  const t0 = pr * 1.3;
  const t1 = len - pr * 1.3;
  if (t1 > t0) {
    const lx0 = gt.ax + ux * t0;
    const ly0 = gt.ay + uy * t0;
    const lx1 = gt.ax + ux * t1;
    const ly1 = gt.ay + uy * t1;
    g.lineCap = 'butt';
    strokeSegs(g, [[lx0, ly0, lx1, ly1]], 0.2, 'rgba(12,14,9,0.28)', sdx, sdy);
    strokeSegs(g, [[lx0, ly0, lx1, ly1]], 0.15, '#6b4c2a');
    strokeSegs(g, [[lx0, ly0, lx1, ly1]], 0.05, 'rgba(196,170,124,0.30)', -0.03, -0.04);
    if (d >= 1) {
      // ledge-and-brace: two rails across, and a diagonal per leaf
      const leaves = t1 - t0 > 1.6 ? 2 : 1;
      const braces: Seg[] = [];
      for (let k = 0; k < leaves; k++) {
        const a = t0 + ((t1 - t0) * k) / leaves;
        const b = t0 + ((t1 - t0) * (k + 1)) / leaves;
        braces.push([gt.ax + ux * a + nx * 0.11, gt.ay + uy * a + ny * 0.11, gt.ax + ux * b - nx * 0.11, gt.ay + uy * b - ny * 0.11]);
      }
      for (const f of [0.3, 0.72]) {
        const a = t0 + (t1 - t0) * f;
        braces.push([gt.ax + ux * a + nx * 0.13, gt.ay + uy * a + ny * 0.13, gt.ax + ux * a - nx * 0.13, gt.ay + uy * a - ny * 0.13]);
      }
      strokeSegs(g, braces, 0.045, 'rgba(46,34,20,0.55)');
    }
    g.lineCap = 'round';
  }
  for (const t of [0, len]) {
    const cx = gt.ax + ux * t;
    const cy = gt.ay + uy * t;
    g.lineCap = 'round'; // one connected finger, not a detached copy of the pier
    g.strokeStyle = 'rgba(12,14,9,0.30)';
    g.lineWidth = pr * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + sdx, cy + sdy);
    g.stroke();
    g.fillStyle = TONES[gt.top][2];
    g.fillRect(cx - pr, cy - pr, pr * 2, pr * 2);
    g.fillStyle = 'rgba(216,208,188,0.26)';
    g.fillRect(cx - pr, cy - pr, pr * 0.7, pr * 2);
    g.fillStyle = 'rgba(44,40,32,0.5)';
    g.fillRect(cx - pr * 1.14, cy - pr * 1.14, pr * 2.28, pr * 0.5);
  }
}

// ── T20: what stands inside the enclosure ────────────────────────────────
//
// The walls are only half the read. A churchyard that is bare lawn inside a
// 2 m wall still looks like a fenced-off field, and a farm cour with grass in
// it is not a cour. Everything below keys on the pocket flood in the index —
// nothing here re-derives geometry, and every branch is a no-op on a map with
// no free-standing masonry.

// The band the ground stamps are rasterised at. Beaten earth carries no fine
// line work, so one resolution serves every zoom and the stamp cache holds six
// canvases instead of thirty.
const GROUND_BAND = 32;

// A working yard is trodden bare and strawed over, never grass.
function yardStamp(v: number): HTMLCanvasElement {
  return stamp(`enclos:yard:${v}`, GROUND_BAND, 1, (g) => {
    g.fillStyle = 'rgb(122,105,76)';
    g.fillRect(0, 0, 1, 1);
    // scuffed patches, so a run of tiles does not read as one flat slab
    for (let i = 0; i < 5; i++) {
      const k = v * 23 + i;
      g.fillStyle = hash(k, 0, 322) > 0.5 ? 'rgba(96,80,56,0.35)' : 'rgba(148,130,96,0.28)';
      g.beginPath();
      g.ellipse(hash(k, 1, 322), hash(k, 2, 322), 0.16 + hash(k, 3, 322) * 0.22, 0.11 + hash(k, 4, 322) * 0.16, hash(k, 5, 322) * Math.PI, 0, TAU);
      g.fill();
    }
    g.fillStyle = 'rgba(204,186,132,0.34)';
    for (let i = 0; i < 7; i++) {
      const k = v * 31 + i;
      g.save();
      g.translate(hash(k, 1, 323), hash(k, 2, 323));
      g.rotate(hash(k, 0, 323) * Math.PI);
      g.fillRect(-0.055, -0.011, 0.11, 0.022);
      g.restore();
    }
    g.fillStyle = 'rgba(58,46,32,0.30)';
    for (let i = 0; i < 5; i++) {
      const k = v * 41 + i;
      g.fillRect(hash(k, 0, 324), hash(k, 1, 324), 0.035, 0.035);
    }
  });
}

export function drawEnclosureGround(g: Ctx, map: GameMap, idx: EnclosureIndex, tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  if (idx.enclosures.length === 0) return;
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const id = idx.enclosureAt[y * map.w + x];
      if (id < 0) continue;
      const key = map.terrainKeyAt(x, y);
      if (key !== 'grass' && key !== 'field') continue;
      const e = idx.enclosures[id];
      if (e.kind === 'yard') {
        g.globalAlpha = 0.9;
        if (d >= 1) g.drawImage(yardStamp((hash(x, y, 325) * 6) | 0), x, y, 1, 1);
        else {
          g.fillStyle = 'rgb(122,105,76)';
          g.fillRect(x, y, 1, 1);
        }
        g.globalAlpha = 1;
        // Trodden dark down the middle of the yard and mud in the gateway:
        // a flat slab of earth reads as a texture swatch, and the thing that
        // makes a cour a cour is that the traffic has worn a shape into it.
        const fx = (x + 0.5 - (e.minX + e.maxX) / 2) / Math.max(1, (e.maxX - e.minX) / 2);
        const fy = (y + 0.5 - (e.minY + e.maxY) / 2) / Math.max(1, (e.maxY - e.minY) / 2);
        const wear = 1 - Math.min(1, Math.hypot(fx, fy));
        if (wear > 0.05) {
          g.fillStyle = `rgba(70,58,40,${(0.26 * wear).toFixed(3)})`;
          g.fillRect(x, y, 1, 1);
        }
        if (d >= 2 && hash(x, y, 339) > 0.72) {
          g.strokeStyle = 'rgba(58,46,30,0.22)';
          g.lineWidth = 0.08;
          g.beginPath();
          g.arc(x + hash(x + 1, y, 339), y + hash(x, y + 1, 339), 0.6 + hash(x + 2, y, 339) * 0.5, 0.4, 2.4);
          g.stroke();
        }
        continue;
      }
      if (e.kind !== 'churchyard') continue;
      // God's acre: coarser and greyer than pasture...
      g.fillStyle = 'rgba(104,110,84,0.26)';
      g.fillRect(x, y, 1, 1);
      // ...and scuffed to bare chalk on the trodden line round the church,
      // which is what stops it reading as a lawn somebody dropped a nave onto.
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (map.buildingIdAt(x + dx, y + dy) >= 0) { near = true; break; }
      if (near) {
        g.fillStyle = 'rgba(168,158,132,0.34)';
        g.fillRect(x, y, 1, 1);
        if (d >= 1) {
          g.fillStyle = 'rgba(212,204,180,0.26)';
          for (let i = 0; i < 6; i++) g.fillRect(x + hash(x * 7 + i, y, 326), y + hash(x, y * 7 + i, 326), 0.05, 0.05);
        }
        continue;
      }
      if (d < 1) continue;
      g.fillStyle = 'rgba(72,84,56,0.30)';
      for (let i = 0; i < 3; i++) {
        const k = x * 13 + y * 5 + i;
        if (hash(k, 0, 327) > 0.55) continue;
        g.fillRect(x + hash(k, 1, 327) * 0.9, y + hash(k, 2, 327) * 0.9, 0.09, 0.05);
      }
    }
  }
}

// A churchyard yew: darker, denser and rounder than anything in the hedgerow
// families, because it is the one tree that is always planted, never grown.
function yewSprite(variant: number, band: number): HTMLCanvasElement {
  // shadowOffset below makes the stamp sun-dependent — the key carries the step
  return stamp(`enclos:yew:${variant}:${sunStepFor(band)}`, band, 3, (g) => {
    const C = 1.5;
    const R = 0.82;
    const [sx, sy] = shadowOffset(0.85);
    const lobes: [number, number, number][] = [];
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (hash(variant, i, 328) - 0.5) * 0.7;
      const dist = (0.26 + hash(variant, i, 329) * 0.18) * R;
      lobes.push([C + Math.cos(a) * dist, C + Math.sin(a) * dist, (0.4 + hash(variant, i, 330) * 0.2) * R]);
    }
    const blob = (x: number, y: number, r: number): void => {
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    };
    g.fillStyle = `rgba(8,14,8,${0.34 * sun().alphaMul})`;
    for (const [x, y, r] of lobes) blob(x + sx, y + sy, r);
    g.fillStyle = 'rgba(0,0,0,0.30)';
    for (const [x, y, r] of lobes) blob(C + (x - C) * 1.05, C + (y - C) * 1.05, r * 1.05);
    for (let i = 0; i < lobes.length; i++) {
      const [x, y, r] = lobes[i];
      const f = 0.82 + hash(variant, i, 331) * 0.2;
      g.fillStyle = `rgb(${Math.round(38 * f)},${Math.round(58 * f)},${Math.round(42 * f)})`;
      blob(x, y, r);
    }
    g.fillStyle = 'rgba(104,132,90,0.20)';
    for (const [x, y, r] of lobes) blob(x - r * 0.24, y - r * 0.3, r * 0.55);
    g.fillStyle = 'rgba(6,12,8,0.28)';
    for (const [x, y, r] of lobes) blob(x + r * 0.2, y + r * 0.26, r * 0.62);
  });
}

const GRAVE_ALONG = 1.05; // m between stones in a row
const GRAVE_ROW = 1.7; // m between rows
const GRAVE_KEEP = 0.62;
const HEADSTONE_H = 0.8; // implied height, and the only thing that says "upright"
const TOMB_H = 0.45;

// The shade a standing block throws, as the convex sweep of its own footprint
// along the sun vector: one connected slab that LEAVES the stone. Two detached
// rectangles — the footprint and a copy of it offset SE — read as two objects
// lying on the grass, which is what the churchyard used to look like.
function castSlab(g: Ctx, hw: number, hh: number, dx: number, dy: number): void {
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  const c: [number, number][] = [[-hw * sx, -hh * sy], [hw * sx, -hh * sy], [hw * sx, hh * sy], [-hw * sx, hh * sy]];
  g.beginPath();
  g.moveTo(c[0][0], c[0][1]);
  g.lineTo(c[1][0], c[1][1]);
  g.lineTo(c[1][0] + dx, c[1][1] + dy);
  g.lineTo(c[2][0] + dx, c[2][1] + dy);
  g.lineTo(c[3][0] + dx, c[3][1] + dy);
  g.lineTo(c[3][0], c[3][1]);
  g.closePath();
  g.fill();
}

export function drawEnclosurePlanting(
  g: Ctx,
  map: GameMap,
  idx: EnclosureIndex,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  band: number,
  d: Detail,
): void {
  if (idx.enclosures.length === 0 || d < 1) return;
  for (let id = 0; id < idx.enclosures.length; id++) {
    const e = idx.enclosures[id];
    if (e.maxX < tx0 - 3 || e.minX > tx1 + 3 || e.maxY < ty0 - 3 || e.minY > ty1 + 3) continue;
    if (e.kind === 'churchyard') churchyardInto(g, map, idx, id, e, tx0, ty0, tx1, ty1, band, d);
    else if (e.kind === 'garden') gardenInto(g, map, idx, id, e, tx0, ty0, tx1, ty1, d);
  }
}

// Free ground inside this pocket, clear of any building by `pad` metres. Used
// for both the graves and the beds: a stone planted against the nave wall or a
// cabbage row under a barn eave both read as a placement bug.
function clearAt(map: GameMap, idx: EnclosureIndex, id: number, x: number, y: number, pad: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (idx.enclosureIdAt(tx, ty) !== id) return false;
  const r = Math.ceil(pad);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (map.buildingIdAt(tx + dx, ty + dy) >= 0) return false;
  return true;
}

function churchyardInto(
  g: Ctx,
  map: GameMap,
  idx: EnclosureIndex,
  id: number,
  e: Enclosure,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  band: number,
  d: Detail,
): void {
  const wide = e.maxX - e.minX >= e.maxY - e.minY;
  // Strict plan projection: a headstone is a 0.3 x 0.15 m footprint from up
  // here, not a card with its inscription facing the camera. All the height is
  // in the cast shadow, which uses the same SUN every other shadow in the
  // scene does — the graves used to throw theirs off a hand-rolled offset and
  // read as a field of detached grey flakes.
  const [hdx, hdy] = shadowOffset(HEADSTONE_H);
  const [tdx, tdy] = shadowOffset(TOMB_H);
  // Rows run across the churchyard's short axis and every stone faces the same
  // way, because a graveyard is the one place in the town that is laid out.
  const rows = Math.floor((wide ? e.maxY - e.minY : e.maxX - e.minX) / GRAVE_ROW);
  const along = Math.floor((wide ? e.maxX - e.minX : e.maxY - e.minY) / GRAVE_ALONG);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < along; i++) {
      const k = e.seed + r * 211 + i;
      if (hash(k, 0, 332) > GRAVE_KEEP) continue;
      const u = (wide ? e.minX : e.minY) + (i + 0.5) * GRAVE_ALONG + (hash(k, 1, 332) - 0.5) * 0.22;
      const v = (wide ? e.minY : e.minX) + (r + 0.6) * GRAVE_ROW + (hash(k, 2, 332) - 0.5) * 0.3;
      const gx = wide ? u : v;
      const gy = wide ? v : u;
      if (gx < tx0 - 1 || gx > tx1 + 1 || gy < ty0 - 1 || gy > ty1 + 1) continue;
      if (!clearAt(map, idx, id, gx, gy, 1)) continue;
      // A chest tomb is a low box lying on the plot; everything else is an
      // upright slab whose plan footprint is its thickness, not its face.
      const tomb = d >= 2 && hash(k, 3, 332) > 0.9;
      const hw = tomb ? 0.4 : 0.15;
      const hh = tomb ? 0.28 : 0.07;
      const rot = (hash(k, 4, 332) - 0.5) * (tomb ? 0.1 : 0.26) + (wide ? 0 : Math.PI / 2);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const [wdx, wdy] = tomb ? [tdx, tdy] : [hdx, hdy];
      const lx = wdx * cos + wdy * sin; // the one sun, rotated into stone space
      const ly = -wdx * sin + wdy * cos;
      g.save();
      g.translate(gx, gy);
      g.rotate(rot);
      // The plot the stone stands at the head of: turned earth going down the
      // row, faint enough that sixty of them stay ground texture.
      if (d >= 2 && !tomb && hash(k, 6, 332) > 0.45) {
        g.fillStyle = 'rgba(96,100,68,0.16)';
        g.beginPath();
        g.ellipse(0, 0.72, 0.34, 0.6, 0, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(48,54,38,0.18)';
        g.lineWidth = 0.035;
        g.stroke();
      }
      g.fillStyle = 'rgba(10,14,8,0.34)';
      castSlab(g, hw, hh, lx, ly);
      g.fillStyle = tomb ? 'rgb(142,138,124)' : hash(k, 5, 332) > 0.6 ? 'rgb(150,146,132)' : 'rgb(132,128,116)';
      g.fillRect(-hw, -hh, hw * 2, hh * 2);
      // NW arris: the lit edge of the top surface, the same rim every other
      // masonry top in the town carries
      g.fillStyle = 'rgba(214,210,192,0.34)';
      g.fillRect(-hw, -hh, hw * 2, Math.min(0.04, hh * 0.5));
      if (d >= 2 && tomb) {
        g.fillStyle = 'rgba(58,60,52,0.28)';
        g.fillRect(-hw * 0.72, -hh * 0.34, hw * 1.44, hh * 0.68); // ledger panel
      }
      g.restore();
    }
  }
  // Two to four yews, spaced round the wall line rather than scattered.
  const n = 2 + ((hash(e.seed, 0, 333) * 3) | 0);
  for (let i = 0; i < n; i++) {
    const k = e.seed * 7 + i;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = ((i + 0.5) / n) * TAU + hash(k, attempt, 334) * 0.9;
      const rad = 0.32 + hash(k, attempt + 40, 334) * 0.14;
      const yx = (e.minX + e.maxX) / 2 + Math.cos(a) * (e.maxX - e.minX) * rad;
      const yy = (e.minY + e.maxY) / 2 + Math.sin(a) * (e.maxY - e.minY) * rad;
      if (!clearAt(map, idx, id, yx, yy, 1.5)) continue;
      if (yx >= tx0 - 3 && yx <= tx1 + 3 && yy >= ty0 - 3 && yy <= ty1 + 3) {
        const s = 2.3 + hash(k, 1, 335) * 0.8;
        g.drawImage(yewSprite((hash(k, 2, 335) * 6) | 0, band), yx - s / 2, yy - s / 2, s, s);
      }
      break;
    }
  }
}

// A worked plot tail: two or three dug beds, rows and cabbage heads on bare
// earth. Deliberately sparse — a Norman back garden is mostly rough grass with
// a vegetable patch in it, not an allotment.
function gardenInto(
  g: Ctx,
  map: GameMap,
  idx: EnclosureIndex,
  id: number,
  e: Enclosure,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  d: Detail,
): void {
  const beds = Math.max(1, Math.min(4, Math.floor(e.tiles / 26)));
  const wide = e.maxX - e.minX >= e.maxY - e.minY;
  const bw = wide ? 2.5 : 1.4;
  const bh = wide ? 1.4 : 2.5;
  for (let i = 0; i < beds; i++) {
    const k = e.seed * 13 + i;
    let cx = 0;
    let cy = 0;
    let ok = false;
    for (let attempt = 0; attempt < 10 && !ok; attempt++) {
      cx = e.minX + 1 + hash(k, attempt, 336) * Math.max(0.001, e.maxX - e.minX - 2);
      cy = e.minY + 1 + hash(k, attempt + 30, 336) * Math.max(0.001, e.maxY - e.minY - 2);
      ok =
        clearAt(map, idx, id, cx - bw / 2, cy - bh / 2, 0) &&
        clearAt(map, idx, id, cx + bw / 2, cy - bh / 2, 0) &&
        clearAt(map, idx, id, cx - bw / 2, cy + bh / 2, 0) &&
        clearAt(map, idx, id, cx + bw / 2, cy + bh / 2, 0) &&
        clearAt(map, idx, id, cx, cy, 0);
    }
    if (!ok || cx + bw < tx0 || cx - bw > tx1 || cy + bh < ty0 || cy - bh > ty1) continue;
    g.fillStyle = 'rgba(72,58,38,0.44)';
    g.beginPath();
    g.ellipse(cx, cy, bw / 2 + 0.12, bh / 2 + 0.12, 0, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(150,132,96,0.20)';
    g.beginPath();
    g.ellipse(cx - 0.07, cy - 0.09, bw / 2 + 0.04, bh / 2 + 0.04, 0, 0, TAU);
    g.fill();
    const rows = 4 + ((hash(k, 1, 337) * 3) | 0);
    g.strokeStyle = 'rgba(44,33,20,0.52)';
    g.lineWidth = 0.08;
    g.beginPath();
    for (let r = 0; r < rows; r++) {
      const t = -0.5 + (r + 0.5) / rows;
      if (wide) {
        g.moveTo(cx - bw / 2 + 0.1, cy + t * bh);
        g.lineTo(cx + bw / 2 - 0.1, cy + t * bh);
      } else {
        g.moveTo(cx + t * bw, cy - bh / 2 + 0.1);
        g.lineTo(cx + t * bw, cy + bh / 2 - 0.1);
      }
    }
    g.stroke();
    const heads = 6 + ((hash(k, 2, 337) * 5) | 0);
    for (let n = 0; n < heads; n++) {
      const kk = k * 17 + n;
      const r = (hash(kk, 0, 338) * rows) | 0;
      const t = -0.5 + (r + 0.5) / rows;
      const u = (hash(kk, 1, 338) - 0.5) * 0.82;
      g.fillStyle = hash(kk, 2, 338) > 0.5 ? '#4c5c38' : '#3f4e2e';
      g.beginPath();
      g.arc(wide ? cx + u * bw : cx + t * bw, wide ? cy + t * bh : cy + u * bh, 0.15, 0, TAU);
      g.fill();
    }
    if (d < 2) continue;
    // Bean canes: a 1.8 m stick is a dot from up here and a long thin line of
    // shade on the ground. It used to lean north out of the last row, which is
    // a side view of the cane.
    const [pdx, pdy] = shadowOffset(1.8);
    for (let p = 0; p < 2; p++) {
      const px = wide ? cx - bw / 2 + (0.3 + p * 0.4) * bw : cx + bw / 2 - 0.15;
      const py = wide ? cy + bh / 2 - 0.15 : cy - bh / 2 + (0.3 + p * 0.4) * bh;
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(14,16,10,0.22)';
      g.lineWidth = 0.05;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + pdx, py + pdy);
      g.stroke();
      g.lineCap = 'butt';
      g.fillStyle = 'rgba(126,108,74,0.7)';
      g.beginPath();
      g.arc(px, py, 0.05, 0, TAU);
      g.fill();
    }
  }
}
