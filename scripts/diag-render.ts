#!/usr/bin/env -S npx tsx
/**
 * Diagnostic: dump all render features (enclosure walls, yard fences, props)
 * in a region of interest on bourg seed 7.
 */
import { planBourg, stampBourg } from '../src/sim/bourg/plan.js';
import { BOURG } from '../src/sim/bourg/profile.js';
import { PatchIndex } from '../src/render/patches.js';
import { EnclosureIndex } from '../src/render/enclos.js';
import { buildYards } from '../src/render/yards.js';
import { propsFor } from '../src/render/props.js';
import { GameMap, EDGE } from '../src/sim/map.js';
import { mulberry32 } from '../src/sim/rng.js';

const SEED = parseInt(process.argv[2] || '7');
const W = 320;
const H = 240;

const base = mulberry32((SEED ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
const height = new Uint8Array(W * H);
const plan = planBourg(base, W, H, BOURG, height);
const map = new GameMap(W, H);
stampBourg(map, plan);
const buildings = plan.fp.buildings;

// Render indices
const patches = new PatchIndex(map);
const churchTiles = new Uint8Array(W * H);
for (const b of buildings) {
  if (b.role !== 'church' && b.role !== 'church_tower' && b.role !== 'church_apse') continue;
  for (const p of (b as any).parts ?? [{ x: b.x, y: b.y, w: b.w, h: b.h }]) {
    for (let y = Math.max(0, p.y); y < Math.min(H, p.y + p.h); y++)
      for (let x = Math.max(0, p.x); x < Math.min(W, p.x + p.w); x++)
        churchTiles[y * W + x] = 1;
  }
}
const enclos = new EnclosureIndex(map, churchTiles);
const yards = buildYards(map, patches, (wx, wy) => {
  const id = enclos.enclosureIdAt(Math.floor(wx), Math.floor(wy));
  return id >= 0 ? enclos.enclosures[id].kind : null;
});
const allProps = propsFor(map, patches, enclos);

// Region of interest
const ROIS = [
  { name: 'terrace', cx: 142, cy: 132, span: 20 },
  { name: 'terrace-north', cx: 142, cy: 100, span: 20 },
  { name: 'cour-se', cx: 265, cy: 53, span: 20 },
  { name: 'pasture-se', cx: 290, cy: 80, span: 20 },
  { name: 'place', cx: 176, cy: 122, span: 18 },
];

for (const roi of ROIS) {
  const { name, cx, cy, span } = roi;
  console.log(`\n=== ${name} (cx=${cx}, cy=${cy}, span=${span}) ===`);

  // Build per-tile grid
  const grid: string[][] = [];
  for (let y = cy - span; y < cy + span; y++) {
    const row: string[] = [];
    for (let x = cx - span; x < cx + span; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) { row.push('  '); continue; }
      const tk = map.terrainKeyAt(x, y);
      const t = tk === 'grass' ? 'Gr' : tk === 'hedge' ? 'He' : tk === 'field' ? 'Fi' : tk === 'road' ? 'Rd' : tk === 'woods' ? 'Wo' : tk === 'water' ? 'Wa' : tk === 'floor' ? 'Fl' : tk.slice(0, 2);
      row.push(t);
    }
    grid.push(row);
  }

  // Mark enclosure wall edges
  for (const r of enclos.runs) {
    markRun(grid, r.ax, r.ay, r.bx, r.by, cx, cy, span, r.top === 2 ? 'W2' : 'W1');
  }

  // Mark yard fence/wall edges
  for (const y of yards) {
    for (const [ax, ay, bx, by] of y.runs) {
      markRun(grid, ax, ay, bx, by, cx, cy, span, y.wall ? 'YW' : 'YF');
    }
  }

  // Mark fencepost props — also mark the rail lines
  for (const p of allProps) {
    if (p.kind !== 'fencepost' && p.kind !== 'gate') continue;
    const gx = Math.floor(p.x);
    const gy = Math.floor(p.y);
    const ri = gy - (cy - span);
    const ci = gx - (cx - span);
    if (ri >= 0 && ri < grid.length && ci >= 0 && ci < grid[0].length) {
      const tag = p.kind === 'gate' ? 'G' : 'p';
      if (!grid[ri][ci].includes(tag)) grid[ri][ci] += tag;
    }
    // Also mark the rail to the next linked post
    if (p.link) {
      const ax = p.axis === 0 ? 1 : 0;
      const ay = p.axis === 0 ? 0 : 1;
      const ex = p.x + ax * 1.6;
      const ey = p.y + ay * 1.6;
      markRun(grid, p.x, p.y, ex, ey, cx, cy, span, 'r');
    }
  }

  // Print grid
  for (const row of grid) {
    console.log(row.map(c => c.padEnd(5)).join(''));
  }

  // Summary
  let nEnclosWalls = 0, nYardWalls = 0, nFenceposts = 0, nGates = 0;
  for (const r of enclos.runs) {
    if (bboxOverlap(r.ax, r.ay, r.bx, r.by, cx, cy, span)) nEnclosWalls++;
  }
  for (const y of yards) {
    for (const [ax, ay, bx, by] of y.runs) {
      if (bboxOverlap(ax, ay, bx, by, cx, cy, span)) nYardWalls++;
    }
  }
  for (const p of allProps) {
    if (!bboxOverlap(p.x, p.y, p.x, p.y, cx, cy, span)) continue;
    if (p.kind === 'fencepost') nFenceposts++;
    if (p.kind === 'gate') nGates++;
  }
  console.log(`  enclos walls: ${nEnclosWalls}  yard walls: ${nYardWalls}  fenceposts: ${nFenceposts}  gates: ${nGates}`);
}

// Full-map audit
console.log('\n=== Full Map Audit ===');
let totalWallEdges = 0, top1Edges = 0, top2Edges = 0;
for (let y = 0; y <= H; y++) {
  for (let x = 0; x < W; x++) {
    if (map.hEdge(x, y) === EDGE.WALL) {
      totalWallEdges++;
      const t = map.hEdgeTops[y * W + x];
      if (t === 1) top1Edges++;
      else if (t === 2) top2Edges++;
    }
  }
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x <= W; x++) {
    if (map.vEdge(x, y) === EDGE.WALL) {
      totalWallEdges++;
      const t = map.vEdgeTops[y * (W + 1) + x];
      if (t === 1) top1Edges++;
      else if (t === 2) top2Edges++;
    }
  }
}
console.log(`  WALL edges (free-standing): ${totalWallEdges} (top1=${top1Edges}, top2=${top2Edges})`);
console.log(`  EnclosureIndex runs: ${enclos.runs.length}`);
let totalYardRuns = 0;
for (const y of yards) totalYardRuns += y.runs.length;
console.log(`  Yard runs: ${totalYardRuns}`);
console.log(`  Yards total: ${yards.length}`);
console.log(`  Fencepost props: ${allProps.filter(p => p.kind === 'fencepost').length}`);
console.log(`  Gate props: ${allProps.filter(p => p.kind === 'gate').length}`);

// Check: which terrain types get fencepost rails?
console.log('\n=== Fencepost placement by terrain ===');
const fpostTerrain: Record<string, number> = {};
for (const p of allProps) {
  if (p.kind !== 'fencepost' && p.kind !== 'gate') continue;
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  if (!map.inBounds(tx, ty)) continue;
  const tk = map.terrainKeyAt(tx, ty);
  fpostTerrain[tk] = (fpostTerrain[tk] || 0) + 1;
}
console.log(fpostTerrain);

// Check: which enclosure walls sit on which terrain?
console.log('\n=== Enclosure walls by terrain ===');
const enclosTerrain: Record<string, number> = {};
for (const r of enclos.runs) {
  const mx = (r.ax + r.bx) / 2;
  const my = (r.ay + r.by) / 2;
  const tx = Math.floor(mx);
  const ty = Math.floor(my);
  if (tx < 0 || ty < 0) continue;
  // Check terrain on both sides of the edge
  const samples = [];
  if (r.ax === r.bx) { // vertical
    if (map.inBounds(tx - 1, ty)) samples.push(map.terrainKeyAt(tx - 1, ty));
    if (map.inBounds(tx, ty)) samples.push(map.terrainKeyAt(tx, ty));
  } else { // horizontal
    if (map.inBounds(tx, ty - 1)) samples.push(map.terrainKeyAt(tx, ty - 1));
    if (map.inBounds(tx, ty)) samples.push(map.terrainKeyAt(tx, ty));
  }
  for (const k of samples) {
    enclosTerrain[k] = (enclosTerrain[k] || 0) + 1;
  }
}
console.log(enclosTerrain);

function markRun(
  grid: string[][], ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, span: number, tag: string
) {
  const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const ri = Math.round(py) - (cy - span);
    const ci = Math.round(px) - (cx - span);
    if (ri >= 0 && ri < grid.length && ci >= 0 && ci < grid[0].length) {
      if (!grid[ri][ci].includes(tag)) grid[ri][ci] += tag;
    }
  }
}

function bboxOverlap(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, span: number): boolean {
  const x0 = cx - span - 1, y0 = cy - span - 1, x1 = cx + span + 1, y1 = cy + span + 1;
  return Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1;
}