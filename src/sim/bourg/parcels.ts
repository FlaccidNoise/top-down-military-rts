import type { Rect } from '../mapgen';
import type { Rng } from '../rng';
import { DENS_CORE, DENS_FRINGE, TAG, type Skeleton } from './streets';

// Stages 6, 7 and 8 — blocks, depth field, frontage runs, burgage parcels
// (docs/plans/2026-07-26-town-gen-design.md, T6). Pure geometry: reads the
// carved `road` bitmap and stage 4's `resv`, writes neither. Output is Plot[].
//
// Stage 6 is the free lunch the polygon literature does not get: on a tile grid
// BLOCKS ARE CONNECTED COMPONENTS. No planar-graph face traversal, no half-edge
// structure, no degenerate-polygon handling — one O(N) scanline BFS.
//
// Stage 7 is the grid analogue of a straight skeleton, and deliberately so: the
// polygon straight-skeleton algorithm is 500+ lines of edge/split-event ordering
// and float-epsilon soup whose output *will* differ under different rounding.
// The BFS is integer and exact.

export interface Block {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  ridgeDepth: number; // max depth inside the block — its rear boundary
}

export interface FrontageRun {
  x0: number;
  y0: number; // for axis 'h' this is the flank ROW; for 'v' the flank COLUMN
  len: number;
  axis: 'h' | 'v';
  side: -1 | 1; // direction from the street INTO the block
  blockId: number;
  rank: number;
}

// A burgage strip. (fx,fy) is the plot's frontage corner — the tile on the
// frontage line at the run-start end. The plot then extends `w` along the run
// axis and `d` tiles in direction `side`, so for axis 'h', side -1 it occupies
// x in [fx, fx+w), y in (fy-d, fy]. Use plotRect() rather than re-deriving it.
export interface Plot {
  fx: number;
  fy: number;
  w: number; // frontage width, along the run axis
  d: number; // depth, perpendicular, in direction `side`
  axis: 'h' | 'v';
  side: -1 | 1;
  // §1.2's density scalar in Q8 FIXED POINT, 0..256 — NOT the doc's 0..1 float.
  // `densQ8 > 154` is the doc's `dens > 0.60`; comparing it against 0.60 is
  // always true and would make every plot core. Named for the trap.
  densQ8: number;
  setback: number; // tiles of front garden; 0 in the core (the front wall IS the street edge)
  runIndex: number;
  indexInRun: number; // party-wall/wing-pairing identity for T7's left/right neighbour logic
  blockId: number;
}

export interface Interior {
  rect: Rect;
  blockId: number;
  densQ8: number;
}

export interface Parcels {
  blockId: Int32Array; // -1 on road / reserved / back lane
  depth: Int16Array; // 4-BFS distance from the nearest road or back lane tile
  lane: Uint8Array; // 1 = back lane (venelle de derrière). NOT road: a grass corridor.
  laneCount: number;
  claimed: Uint8Array; // 1 = a plot owns this tile
  blocks: Block[];
  runs: FrontageRun[];
  plots: Plot[];
  interiors: Interior[];
}

const MIN_RUN = 6; // §2.2 stage 8: runs shorter than this carry no frontage
const MIN_PLOT = 4; // the jitter and the runt rule both clamp against this
const BACK_LANE_DEPTH = 26; // §2.2 stage 7: deeper than this and the block gets a rear lane
const MIN_LANE_LEN = 10;

export function plotRect(p: Plot): Rect {
  if (p.axis === 'h')
    return { x: p.fx, y: p.side < 0 ? p.fy - p.d + 1 : p.fy, w: p.w, h: p.d };
  return { x: p.side < 0 ? p.fx - p.d + 1 : p.fx, y: p.fy, w: p.d, h: p.w };
}

export function buildParcels(sk: Skeleton, resv: Uint8Array): Parcels {
  const { w, h, road } = sk;
  const r8 = sk.S(TAG.PARCEL);
  const lane = new Uint8Array(w * h);

  let blockId = label(w, h, road, resv, lane);
  let depth = depthField(w, h, road, resv, lane);
  let blocks = summarise(w, h, blockId, depth);

  // The parcel zone: R_env expanded by 6 (the same town/country line stage 11
  // uses in place of `nearVillage`), plus a disc around the detached 'faubourg'
  // cluster. Everything outside it belongs to T9's rural fabric — without this
  // gate the frontage extractor walks the arterial out to the map edge and
  // parcels the entire 320x240 map into 50-deep strips.
  const zone = new Uint8Array(w * h);
  const fillZone = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) zone[y * w + x] = 1;
  };
  fillZone(sk.env.x - 6, sk.env.y - 6, sk.env.x + sk.env.w + 5, sk.env.y + sk.env.h + 5);
  if (sk.faubourg) fillZone(sk.faubourg.x - 22, sk.faubourg.y - 22, sk.faubourg.x + 22, sk.faubourg.y + 22);
  const inZone = (b: Block): boolean =>
    b.maxX >= sk.env.x - 6 && b.minX <= sk.env.x + sk.env.w + 5 && b.maxY >= sk.env.y - 6 && b.minY <= sk.env.y + sk.env.h + 5;

  // ── back lanes ──────────────────────────────────────────────────────────
  // Any core block deeper than 26 tiles gets a 1-tile corridor along its ridge.
  // Recomputing the two fields globally afterwards is one extra CCL + one extra
  // BFS (~3 ms) and replaces the doc's local re-CCL: the lane is also a depth
  // SOURCE, so a local relabel would leave the rest of the field describing a
  // block that no longer exists.
  let laneCount = 0;
  for (const b of blocks) {
    if (b.ridgeDepth <= BACK_LANE_DEPTH || !inZone(b)) continue;
    laneCount += carveBackLane(w, h, blockId, depth, lane, b, zone);
  }
  if (laneCount > 0) {
    blockId = label(w, h, road, resv, lane);
    depth = depthField(w, h, road, resv, lane);
    blocks = summarise(w, h, blockId, depth);
  }
  // ── frontage runs ───────────────────────────────────────────────────────
  // Maximal runs of tiles that (a) are the first non-road tile out from the
  // segment's centreline on this side, at a CONSTANT offset, (b) are in a
  // block, and (c) have their away-from-road neighbour in the same block —
  // i.e. there is at least one tile of depth to build into.
  //
  // The offset is scanned rather than derived from `s.width`: the place
  // widening (stage 4) and every crossing street make the carved band locally
  // wider than the segment that owns it, and a nominal ±2 flank would land
  // inside the place and yield no frontage exactly where frontage matters most.
  // A change of offset closes the run — the frontage genuinely steps back
  // there, and a FrontageRun is by definition straight.
  const fmark = new Uint8Array(w * h); // a tile belongs to at most one run
  const runs: FrontageRun[] = [];
  const MAX_FLANK = 14;
  for (const s of sk.segs) {
    const lo = s.axis === 'h' ? Math.min(s.ax, s.bx) : Math.min(s.ay, s.by);
    const hi = s.axis === 'h' ? Math.max(s.ax, s.bx) : Math.max(s.ay, s.by);
    for (const side of [-1, 1] as const) {
      let runStart = -1;
      let runBlock = -1;
      let runOff = 0;
      const close = (end: number): void => {
        const len = end - runStart;
        if (runStart >= 0 && len >= MIN_RUN) {
          const rx = s.axis === 'h' ? runStart : s.ax + runOff;
          const ry = s.axis === 'h' ? s.ay + runOff : runStart;
          for (let k = 0; k < len; k++) fmark[(s.axis === 'h' ? ry : ry + k) * w + (s.axis === 'h' ? rx + k : rx)] = 1;
          runs.push({ x0: rx, y0: ry, len, axis: s.axis, side, blockId: runBlock, rank: s.rank });
        }
        runStart = -1;
        runBlock = -1;
      };
      for (let p = lo; p <= hi + 1; p++) {
        let off = 0;
        let id = -1;
        if (p <= hi) {
          for (let k = 1; k <= MAX_FLANK; k++) {
            const o = side * k;
            const x = s.axis === 'h' ? p : s.ax + o;
            const y = s.axis === 'h' ? s.ay + o : p;
            if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) break;
            const i = y * w + x;
            if (road[i]) continue;
            if (!zone[i]) break;
            if (fmark[i] || blockId[i] < 0) break;
            const bx = s.axis === 'h' ? x : x + side;
            const by = s.axis === 'h' ? y + side : y;
            if (blockId[by * w + bx] !== blockId[i]) break;
            off = o;
            id = blockId[i];
            break;
          }
        }
        if (id >= 0 && runStart >= 0 && (id !== runBlock || off !== runOff)) close(p);
        if (id < 0) {
          close(p);
          continue;
        }
        if (runStart < 0) {
          runStart = p;
          runBlock = id;
          runOff = off;
        }
      }
    }
  }

  // ── burgage strip subdivision ───────────────────────────────────────────
  const claimed = new Uint8Array(w * h);
  const plots: Plot[] = [];
  runs.forEach((run, runIndex) => {
    const widths = burgageWidths(sk, r8, run);
    let pos = 0;
    let indexInRun = 0;
    for (const pw of widths) {
      const fx = run.axis === 'h' ? run.x0 + pos : run.x0;
      const fy = run.axis === 'h' ? run.y0 : run.y0 + pos;
      pos += pw;
      const dq = sk.densQ8(run.axis === 'h' ? fx + (pw >> 1) : fx, run.axis === 'h' ? fy : fy + (pw >> 1));
      const core = dq > DENS_CORE;
      const setback = dq > DENS_CORE ? 0 : dq > DENS_FRINGE ? 1 : 2 + r8.int(3);
      // Depth runs to the LOCAL ridge, capped at 34 core / 50 fringe. The doc's
      // `min(ridgeDepth - 1, cap)` uses the block's global maximum, which is
      // right only for a block bounded by streets on every side; the two
      // countryside components here are 13k-23k tiles with a ridge of 89-131,
      // and that rule gave a rank-2 side street 41-tile-deep burgage plots that
      // swallowed the opposite frontage's ground before it was even extracted.
      // The per-column walk is the same quantity computed locally, and it is
      // what the depth field was built for.
      const cap = core ? 34 : 50;
      const probe = availableDepth(w, h, blockId, depth, claimed, zone, run, fx, fy, pw, cap);
      if (probe.geo < 5) continue; // a strip with no room behind it is not a plot
      // Terminating at the zone edge is not a rear boundary, it is the edge of
      // town: clamp to the floor depth rather than sprawling into T9's fields.
      // Otherwise stop at the ridge, so the block splits between its two
      // frontages regardless of which one the extractor reached first.
      const soft = probe.open ? (core ? 10 : 14) : probe.ridge >= 5 ? probe.ridge : cap;
      const d = Math.min(probe.geo, soft);
      const p: Plot = {
        fx,
        fy,
        w: pw,
        d,
        axis: run.axis,
        side: run.side,
        densQ8: dq,
        setback: Math.min(setback, d - 4),
        runIndex,
        indexInRun: indexInRun++,
        blockId: run.blockId,
      };
      const r = plotRect(p);
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) claimed[y * w + x] = 1;
      plots.push(p);
    }
  });

  // ── non-frontage interiors ──────────────────────────────────────────────
  const interiors: Interior[] = [];
  for (const b of blocks) {
    if (b.area < 120 || !inZone(b)) continue;
    splitInterior(sk, r8, blockId, claimed, zone, b, { x: b.minX, y: b.minY, w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1 }, 0, interiors);
  }

  return { blockId, depth, lane, laneCount, claimed, blocks, runs, plots, interiors };
}

// ── stage 6: connected-component labelling ───────────────────────────────────

function label(w: number, h: number, road: Uint8Array, resv: Uint8Array, lane: Uint8Array): Int32Array {
  const out = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < out.length; s++) {
    if (out[s] >= 0 || road[s] || resv[s] || lane[s]) continue;
    const id = next++;
    let head = 0;
    let tail = 0;
    out[s] = id;
    queue[tail++] = s;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      // inlined four ways rather than via a closure: this body runs once per
      // tile of a 76,800-tile map and a per-iteration closure is pure garbage
      let n = cur - 1;
      if (cx > 0 && out[n] < 0 && !road[n] && !resv[n] && !lane[n]) {
        out[n] = id;
        queue[tail++] = n;
      }
      n = cur + 1;
      if (cx + 1 < w && out[n] < 0 && !road[n] && !resv[n] && !lane[n]) {
        out[n] = id;
        queue[tail++] = n;
      }
      n = cur - w;
      if (cy > 0 && out[n] < 0 && !road[n] && !resv[n] && !lane[n]) {
        out[n] = id;
        queue[tail++] = n;
      }
      n = cur + w;
      if (cy + 1 < h && out[n] < 0 && !road[n] && !resv[n] && !lane[n]) {
        out[n] = id;
        queue[tail++] = n;
      }
    }
  }
  return out;
}

// ── stage 7: multi-source depth field ────────────────────────────────────────

function depthField(w: number, h: number, road: Uint8Array, resv: Uint8Array, lane: Uint8Array): Int16Array {
  const out = new Int16Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < out.length; i++)
    if (road[i] || lane[i]) {
      out[i] = 0;
      queue[tail++] = i;
    }
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    const nd = out[cur] + 1;
    if (cx > 0) step(cur - 1, nd);
    if (cx + 1 < w) step(cur + 1, nd);
    if (cy > 0) step(cur - w, nd);
    if (cy + 1 < h) step(cur + w, nd);
  }
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  return out;

  function step(i: number, d: number): void {
    if (out[i] >= 0 || resv[i]) return;
    out[i] = d;
    queue[tail++] = i;
  }
}

function summarise(w: number, h: number, blockId: Int32Array, depth: Int16Array): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < blockId.length; i++) {
    const id = blockId[i];
    if (id < 0) continue;
    let b = blocks[id];
    if (!b) {
      b = { id, minX: w, minY: h, maxX: -1, maxY: -1, area: 0, ridgeDepth: 0 };
      blocks[id] = b;
    }
    const x = i % w;
    const y = (i / w) | 0;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
    b.area++;
    if (depth[i] > b.ridgeDepth) b.ridgeDepth = depth[i];
  }
  return blocks;
}

// The ridge of a block is its locus of maximal depth. Rather than extract that
// locus (which on a ragged block is a scattered set that needs connecting), the
// lane is carved along the single row or column whose accumulated depth is
// greatest — for the convex, two-frontage block this rule is meant for, that IS
// the ridge, and it is straight, which a venelle de derrière has to be.
function carveBackLane(w: number, h: number, blockId: Int32Array, depth: Int16Array, lane: Uint8Array, b: Block, zone: Uint8Array): number {
  // bbox over the block's tiles INSIDE the zone: a block reaching into open
  // country has its deepest row at the zone edge, and a "back lane" carved
  // along the town boundary is not a venelle de derrière, it is a fence line
  let zx0 = Infinity;
  let zy0 = Infinity;
  let zx1 = -Infinity;
  let zy1 = -Infinity;
  for (let y = b.minY; y <= b.maxY; y++)
    for (let x = b.minX; x <= b.maxX; x++) {
      const i = y * w + x;
      if (blockId[i] !== b.id || !zone[i]) continue;
      if (x < zx0) zx0 = x;
      if (x > zx1) zx1 = x;
      if (y < zy0) zy0 = y;
      if (y > zy1) zy1 = y;
    }
  if (zx1 < zx0) return 0;
  const horizontal = zx1 - zx0 >= zy1 - zy0;
  const lo = (horizontal ? zy0 : zx0) + 4;
  const hi = (horizontal ? zy1 : zx1) - 4;
  if (hi < lo) return 0;
  let bestK = -1;
  let bestScore = -1;
  for (let k = lo; k <= hi; k++) {
    let score = 0;
    let count = 0;
    const along = horizontal ? zx1 - zx0 : zy1 - zy0;
    const step = horizontal ? w : 1;
    for (let j = 0; j <= along; j++) {
      const x = horizontal ? zx0 + j : k;
      const y = horizontal ? k : zy0 + j;
      const i = y * w + x;
      if (blockId[i] !== b.id || !zone[i]) continue;
      // ridge means LOCAL MAXIMUM of the depth field across the line, not just
      // "deep". Without this the deepest line of a block that reaches into open
      // country is its outermost one, and the "back lane" is carved along the
      // town boundary — a fence line, not a venelle de derrière.
      if (depth[i] < depth[i - step] || depth[i] < depth[i + step]) continue;
      if (depth[i] === depth[i - step] && depth[i] === depth[i + step]) continue;
      score += depth[i];
      count++;
    }
    if (count >= MIN_LANE_LEN && score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  if (bestK < 0) return 0;
  const along = horizontal ? zx1 - zx0 : zy1 - zy0;
  for (let j = 0; j <= along; j++) {
    const x = horizontal ? zx0 + j : bestK;
    const y = horizontal ? bestK : zy0 + j;
    const i = y * w + x;
    if (blockId[i] === b.id && zone[i]) lane[i] = 1;
  }
  return 1;
}

// ── stage 8: burgage strips ──────────────────────────────────────────────────
//
// The only subdivision scheme that is natively axis-aligned when the street is,
// and the historically correct generator for this settlement type (a real
// English burgage frontage is 28-32 ft ≈ 8.5-9.7 m — 5-9 tiles in the core).
function burgageWidths(sk: Skeleton, r8: Rng, run: FrontageRun): number[] {
  const widths: number[] = [];
  let pos = 0;
  while (run.len - pos >= MIN_PLOT) {
    const cx = run.axis === 'h' ? run.x0 + pos : run.x0;
    const cy = run.axis === 'h' ? run.y0 : run.y0 + pos;
    const core = r8.int(256) < sk.densQ8(cx, cy);
    let pw = core ? 5 + r8.int(5) : 9 + r8.int(8);
    pw = Math.min(pw, run.len - pos);
    if (run.len - pos - pw < MIN_PLOT) pw = run.len - pos; // runt absorbed, never emitted
    widths.push(pw);
    pos += pw;
  }
  // jitter each interior party-wall position, clamped so no plot drops below 4
  for (let i = 1; i < widths.length; i++) {
    const delta = r8.int(3) - 1;
    if (widths[i - 1] + delta < MIN_PLOT || widths[i] - delta < MIN_PLOT) continue;
    widths[i - 1] += delta;
    widths[i] -= delta;
  }
  return widths;
}

// How deep the block actually is behind this strip: the minimum, over the
// strip's frontage tiles, of the unclaimed in-block run away from the street.
function availableDepth(
  w: number,
  h: number,
  blockId: Int32Array,
  depth: Int16Array,
  claimed: Uint8Array,
  zone: Uint8Array,
  run: FrontageRun,
  fx: number,
  fy: number,
  pw: number,
  cap: number,
): { geo: number; open: boolean; ridge: number } {
  // walk one column away from the street; `ridge` is where the depth field
  // stops rising (the block's rear), `geo` where the ground actually runs out
  const walk = (k: number): { geo: number; open: boolean; ridge: number } => {
    const x = run.axis === 'h' ? fx + k : fx;
    const y = run.axis === 'h' ? fy : fy + k;
    let d = 0;
    let ridge = 0;
    let last = 0;
    let open = false;
    while (d < cap) {
      const nx = run.axis === 'h' ? x : x + run.side * d;
      const ny = run.axis === 'h' ? y + run.side * d : y;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) break;
      const i = ny * w + nx;
      if (blockId[i] !== run.blockId || claimed[i]) break;
      if (!zone[i]) {
        open = true;
        break;
      }
      if (ridge === 0 && d > 0 && depth[i] <= last) ridge = d;
      last = depth[i];
      d++;
    }
    if (d === cap) open = true;
    return { geo: d, open, ridge: ridge === 0 ? d : ridge };
  };

  // `geo` is the MINIMUM over the strip's columns — the plot rect has to fit,
  // and one shallow column at a street corner means the whole strip is shallow.
  // The ridge is read at the CENTRE column instead: taking its minimum too
  // would let a single corner column, whose depth field peaks two tiles out,
  // veto every plot within a burgage width of a junction.
  let geo = cap;
  let open = true;
  for (let k = 0; k < pw; k++) {
    const c = walk(k);
    if (c.geo < geo) {
      geo = c.geo;
      open = c.open;
    }
    if (geo < 5) return { geo, open, ridge: 0 };
  }
  return { geo, open, ridge: walk(pw >> 1).ridge };
}

// Non-frontage block interiors (garden cores, farm yards, the churchyard's
// internal division) get a recursive AABB split, depth <= 3. With rotation off
// the table an OBB split degenerates to AABB, which is fine HERE precisely
// because these parcels carry no frontage — never use it where the burgage
// subdivider applies, because pure recursive splitting reads as a BSP dungeon.
function splitInterior(
  sk: Skeleton,
  r8: Rng,
  blockId: Int32Array,
  claimed: Uint8Array,
  zone: Uint8Array,
  b: Block,
  rect: Rect,
  depth: number,
  out: Interior[],
): void {
  const trimmed = trimToFree(sk.w, blockId, claimed, zone, b.id, rect);
  if (!trimmed) return;
  if (depth >= 3 || (trimmed.w < 14 && trimmed.h < 12)) {
    if (trimmed.w >= 5 && trimmed.h >= 5)
      out.push({ rect: trimmed, blockId: b.id, densQ8: sk.densQ8(trimmed.x + (trimmed.w >> 1), trimmed.y + (trimmed.h >> 1)) });
    return;
  }
  const vertical = trimmed.w >= trimmed.h;
  const span = vertical ? trimmed.w : trimmed.h;
  const cut = Math.max(4, Math.min(span - 4, Math.round(span * r8.range(0.35, 0.65))));
  if (vertical) {
    splitInterior(sk, r8, blockId, claimed, zone, b, { x: trimmed.x, y: trimmed.y, w: cut, h: trimmed.h }, depth + 1, out);
    splitInterior(sk, r8, blockId, claimed, zone, b, { x: trimmed.x + cut, y: trimmed.y, w: trimmed.w - cut, h: trimmed.h }, depth + 1, out);
  } else {
    splitInterior(sk, r8, blockId, claimed, zone, b, { x: trimmed.x, y: trimmed.y, w: trimmed.w, h: cut }, depth + 1, out);
    splitInterior(sk, r8, blockId, claimed, zone, b, { x: trimmed.x, y: trimmed.y + cut, w: trimmed.w, h: trimmed.h - cut }, depth + 1, out);
  }
}

// Shrink a rect until every tile in it is usable ground of THIS block: trim to
// the bbox of the free tiles, then peel whichever edge carries the most
// unusable ones until none are left. A leaf that merely mostly-avoids the plot
// tails is not a parcel — T7 drops a farm cour into these, and one claimed tile
// inside the rect is a farm stamped through a burgage house.
function trimToFree(w: number, blockId: Int32Array, claimed: Uint8Array, zone: Uint8Array, id: number, rect: Rect): Rect | null {
  const bad = (x: number, y: number): number => {
    const i = y * w + x;
    return blockId[i] !== id || claimed[i] || !zone[i] ? 1 : 0;
  };
  let x0 = rect.x + rect.w;
  let y0 = rect.y + rect.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (bad(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;

  const edge = (kind: number): number => {
    let n = 0;
    if (kind < 2) for (let y = y0; y <= y1; y++) n += bad(kind === 0 ? x0 : x1, y);
    else for (let x = x0; x <= x1; x++) n += bad(x, kind === 2 ? y0 : y1);
    return n;
  };
  while (x1 - x0 >= 4 && y1 - y0 >= 4) {
    const counts = [edge(0), edge(1), edge(2), edge(3)];
    let worst = 0;
    for (let k = 1; k < 4; k++) if (counts[k] > counts[worst]) worst = k;
    if (counts[worst] === 0) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (worst === 0) x0++;
    else if (worst === 1) x1--;
    else if (worst === 2) y0++;
    else y1--;
  }
  return null;
}
