// T_REGIONS (stage 45, S9): jittered-grid nearest-site partition + terrain
// paint — integer-only, no Voronoi library (the bourg precedent: nearest-site
// over a lattice in one pass has no cocircular degeneracy and no float
// predicates). The lattice is LAT_M-resolution; polygons are rectilinear
// boundary traces of the label raster, scaled to metres. Rendering smooths;
// the sim never needs smoother truth than the lattice.
//
// Paint rules (§2 bands, default preset): settlement = regions seated by a
// town; marsh only within MARSH_RIVER_M of a river; forest 1-3 contiguous
// massifs; farmland/bocage split the remainder toward the area bands.
import type { Region, River, TheaterNode, Vec } from '../theater';
import type { Rng } from '../../sim/rng';
import { stageStream, T_TAG } from './streams';

export const LAT_M = 250; // label-raster resolution
const SITE_SPACING_M = 4600; // base grid + town satellites -> regions band 25-40
const SITE_JITTER_M = 1100;
export const MARSH_RIVER_M = 600;

export interface RegionPlan {
  regions: Region[];
  // Label raster lookup for later stages (paceMpm baking, S11): lattice
  // coordinates, returns a region id for any point inside bounds.
  regionIdAt: (x: number, y: number) => number;
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

export function planRegions(
  base: number,
  cfg: { terrainMix: 'bocage' | 'open' | 'wooded' | 'marshland'; woodsShare: number },
  boundsM: { w: number; h: number },
  rivers: River[],
  nodes: TheaterNode[],
): RegionPlan {
  const rng: Rng = stageStream(base, T_TAG.REGIONS);
  const { w, h } = boundsM;
  const W = Math.ceil(w / LAT_M);
  const H = Math.ceil(h / LAT_M);

  // -- Sites: jittered grid, integer metres --
  const sites: Vec[] = [];
  for (let gy = SITE_SPACING_M / 2; gy < h; gy += SITE_SPACING_M) {
    for (let gx = SITE_SPACING_M / 2; gx < w; gx += SITE_SPACING_M) {
      sites.push({
        x: clampInt(gx + rng.range(-SITE_JITTER_M, SITE_JITTER_M), 0, w),
        y: clampInt(gy + rng.range(-SITE_JITTER_M, SITE_JITTER_M), 0, h),
      });
    }
  }
  // Satellite sites ring each town so the town's own region shrinks to its
  // built-up surroundings — the settlement area band (3-6%) is impossible if
  // one town owns a whole grid cell of countryside.
  const townCount = nodes.filter((n) => n.kind === 'town').length;
  // Adaptive ring: town regions must jointly land the settlement area band
  // (3-6%) whatever the town count, so each ring solves for ~4.5% / towns.
  const ringR = Math.round(Math.sqrt((0.045 * w * h) / (Math.max(1, townCount) * Math.PI)));
  for (const n of nodes) {
    if (n.kind !== 'town') continue;
    const spokes = 5;
    const phase = rng.range(0, Math.PI * 2);
    for (let k = 0; k < spokes; k++) {
      const a = phase + (k * 2 * Math.PI) / spokes;
      sites.push({
        x: clampInt(n.pos.x + Math.cos(a) * ringR, 0, w),
        y: clampInt(n.pos.y + Math.sin(a) * ringR, 0, h),
      });
    }
  }

  // -- Label raster: nearest site by squared integer distance, ties lowest id --
  const label = new Int16Array(W * H);
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const px = cx * LAT_M + LAT_M / 2;
      const py = cy * LAT_M + LAT_M / 2;
      let best = 0;
      let bestD = Infinity;
      for (let s = 0; s < sites.length; s++) {
        const dx = sites[s].x - px;
        const dy = sites[s].y - py;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      label[cy * W + cx] = best;
    }
  }

  // -- Per-site cell stats --
  const cellsOf: number[][] = sites.map(() => []);
  for (let i = 0; i < label.length; i++) cellsOf[label[i]].push(i);
  const live = sites.map((_, s) => cellsOf[s].length > 0);

  // River adjacency per site (marsh eligibility): any owned cell centre within
  // MARSH_RIVER_M of any river vertex. Vertex spacing (<= 1200 m) against a
  // 600 m radius + 250 m cells is fine-grained enough for the gate.
  const riverNear = sites.map(() => false);
  for (let s = 0; s < sites.length; s++) {
    if (!live[s]) continue;
    outer: for (const i of cellsOf[s]) {
      const px = (i % W) * LAT_M + LAT_M / 2;
      const py = Math.floor(i / W) * LAT_M + LAT_M / 2;
      for (const r of rivers) {
        for (const v of r.polyline) {
          const dx = v.x - px;
          const dy = v.y - py;
          if (dx * dx + dy * dy <= MARSH_RIVER_M * MARSH_RIVER_M) {
            riverNear[s] = true;
            break outer;
          }
        }
      }
    }
  }

  // Site adjacency (forest massif growth).
  const adjacent = sites.map(() => new Set<number>());
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const a = label[cy * W + cx];
      if (cx + 1 < W) {
        const b = label[cy * W + cx + 1];
        if (a !== b) {
          adjacent[a].add(b);
          adjacent[b].add(a);
        }
      }
      if (cy + 1 < H) {
        const b = label[(cy + 1) * W + cx];
        if (a !== b) {
          adjacent[a].add(b);
          adjacent[b].add(a);
        }
      }
    }
  }

  // -- Paint --
  const total = label.length;
  const share = (ids: number[]): number => ids.reduce((a, s) => a + cellsOf[s].length, 0) / total;
  const cls: (Region['terrainClass'] | null)[] = sites.map(() => null);

  // Settlement: the site under each town.
  const siteAt = (p: Vec): number => label[Math.min(H - 1, Math.floor(p.y / LAT_M)) * W + Math.min(W - 1, Math.floor(p.x / LAT_M))];
  for (const n of nodes) if (n.kind === 'town') cls[siteAt(n.pos)] = 'settlement';

  // Marsh: river-near sites until the 3-8% band (terrainMix 'marshland' aims
  // high, others low), never a settlement.
  const marshTarget = cfg.terrainMix === 'marshland' ? 0.07 : 0.04;
  const marshable = sites.map((_, s) => s).filter((s) => live[s] && riverNear[s] && cls[s] === null);
  const marsh: number[] = [];
  while (marshable.length > 0 && share(marsh) < marshTarget) {
    const s = marshable.splice(rng.int(marshable.length), 1)[0];
    if (share([...marsh, s]) > 0.08) continue; // never overshoot the band ceiling
    cls[s] = 'marsh';
    marsh.push(s);
  }

  // Forest: 1-3 massifs grown by adjacency until the 10-20% band; woodsShare
  // moves the target inside it.
  const forestTarget = 0.1 + 0.025 * (cfg.woodsShare - 1); // 1-4 -> 10-17.5%
  const massifs = 1 + rng.int(3);
  const forest: number[] = [];
  for (let m = 0; m < massifs && share(forest) < forestTarget; m++) {
    const open = sites.map((_, s) => s).filter((s) => live[s] && cls[s] === null);
    if (open.length === 0) break;
    let frontier = [open[rng.int(open.length)]];
    while (frontier.length > 0 && share(forest) < forestTarget) {
      const s = frontier.splice(rng.int(frontier.length), 1)[0];
      if (cls[s] !== null) continue;
      cls[s] = 'forest';
      forest.push(s);
      for (const nb of adjacent[s]) if (cls[nb] === null) frontier.push(nb);
    }
  }

  // Farmland / bocage split the rest toward a SHARE TARGET, not per-site
  // coin flips — iid draws overshoot the §2 bands on the tails. Deterministic
  // walk in shuffled order: assign bocage while its running share is below
  // target, farmland otherwise.
  const bocageLean = cfg.terrainMix === 'bocage' ? 0.45 : cfg.terrainMix === 'open' ? 0.38 : 0.43;
  const rest = sites.map((_, s) => s).filter((s) => live[s] && cls[s] === null);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const restCells = rest.reduce((a, s) => a + cellsOf[s].length, 0);
  let bocageCells = 0;
  for (const s of rest) {
    if (bocageCells / restCells < bocageLean) {
      cls[s] = 'bocage';
      bocageCells += cellsOf[s].length;
    } else {
      cls[s] = 'farmland';
    }
  }

  // -- Polygon extraction: rectilinear boundary trace per live site --
  const regions: Region[] = [];
  const remap = new Int16Array(sites.length).fill(-1);
  for (let s = 0; s < sites.length; s++) {
    if (!live[s]) continue;
    const id = regions.length;
    remap[s] = id;
    const cells = cellsOf[s];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let sx = 0;
    let sy = 0;
    for (const i of cells) {
      const cx = i % W;
      const cy = Math.floor(i / W);
      x0 = Math.min(x0, cx * LAT_M);
      y0 = Math.min(y0, cy * LAT_M);
      x1 = Math.max(x1, (cx + 1) * LAT_M);
      y1 = Math.max(y1, (cy + 1) * LAT_M);
      sx += cx * LAT_M + LAT_M / 2;
      sy += cy * LAT_M + LAT_M / 2;
    }
    regions.push({
      id,
      polygon: tracePolygon(label, W, H, s, cells),
      centroid: { x: Math.round(sx / cells.length), y: Math.round(sy / cells.length) },
      bbox: { x0, y0, x1: Math.min(x1, w), y1: Math.min(y1, h) },
      areaM2: cells.length * LAT_M * LAT_M,
      terrainClass: cls[s]!,
      name: '',
      seatNodeId: null,
    });
  }

  // Seats: towns first, then villages, one per region where present.
  for (const n of nodes) {
    const rid = remap[siteAt(n.pos)];
    if (rid < 0) continue;
    const r = regions[rid];
    const seated = r.seatNodeId === null ? null : nodes.find((m) => m.id === r.seatNodeId)!;
    if (!seated || (seated.kind !== 'town' && n.kind === 'town') || (seated.kind !== 'town' && seated.kind !== 'village' && n.kind === 'village')) {
      r.seatNodeId = n.id;
    }
  }

  const regionIdAt = (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(W - 1, Math.floor(x / LAT_M)));
    const cy = Math.max(0, Math.min(H - 1, Math.floor(y / LAT_M)));
    return remap[label[cy * W + cx]];
  };
  return { regions, regionIdAt };
}

// Moore boundary trace over the label raster, emitting lattice-corner
// points in metres. Nearest-site cells are connected, so one loop suffices.
function tracePolygon(label: Int16Array, W: number, H: number, site: number, cells: number[]): Vec[] {
  const at = (cx: number, cy: number): boolean =>
    cx >= 0 && cy >= 0 && cx < W && cy < H && label[cy * W + cx] === site;
  // Start: the lowest-index cell's top-left corner; walk edges keeping the
  // region on the right (clockwise in screen coordinates).
  const start = cells.reduce((a, b) => Math.min(a, b));
  const sx = start % W;
  const sy = Math.floor(start / W);
  const pts: Vec[] = [];
  // Edge walker over cell corners: direction 0=E 1=S 2=W 3=N.
  let cx = sx;
  let cy = sy;
  let dir = 0;
  let px = sx;
  let py = sy;
  const startKey = `${px},${py},0`;
  for (let guard = 0; guard < W * H * 8; guard++) {
    pts.push({ x: px * LAT_M, y: py * LAT_M });
    // At corner (px,py) heading dir: turn left if the left cell is ours,
    // straight if the ahead cell is ours, else turn right.
    const moves: Record<number, { left: [number, number]; ahead: [number, number]; d: [number, number] }> = {
      0: { left: [px, py - 1], ahead: [px, py], d: [1, 0] },
      1: { left: [px, py], ahead: [px - 1, py], d: [0, 1] },
      2: { left: [px - 1, py], ahead: [px - 1, py - 1], d: [-1, 0] },
      3: { left: [px - 1, py - 1], ahead: [px, py - 1], d: [0, -1] },
    };
    const m = moves[dir];
    if (at(m.left[0], m.left[1])) dir = (dir + 3) % 4;
    else if (!at(m.ahead[0], m.ahead[1])) dir = (dir + 1) % 4;
    const d = moves[dir].d;
    px += d[0];
    py += d[1];
    if (`${px},${py},${dir}` === startKey || (px === sx && py === sy && pts.length > 2)) break;
  }
  // Collapse collinear runs — the trace emits every lattice corner.
  const out: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    if (a && c && ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))) continue;
    out.push(b);
  }
  return out;
}
