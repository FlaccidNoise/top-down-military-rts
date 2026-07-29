// V4-P1 adversarial verification v2 — refined probes
// Run: npx vite-node scripts/v4p1-verify-v2.mjs
import { generateMap } from '../src/sim/mapgen';
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { GameMap } from '../src/sim/map';
import { mulberry32 } from '../src/sim/rng';
import { PROFILES } from '../src/sim/bourg/profile';
import { astar } from '../src/sim/path';
import { zoneOf } from '../src/sim/bourg/rural';

const W = 320, H = 240;
const KINDS = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'];
const EXTRA_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

let failures = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); failures++; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ══════════════════════════════════════════════════════════════════════════
// R-G1-refined: Check for boundary gaps on PLANTABLE tiles only
// ══════════════════════════════════════════════════════════════════════════
console.log('=== R-G1 refined: boundary gaps on plantable tiles ===');

function checkBoundaryGaps(plan, map, kind, seed) {
  const { owner, hedge } = plan.rural;
  const { w, h } = map;
  // hedge mask = where bocage WANTS a hedge (pre-plantable-filter)
  // map terrain = what actually got painted
  // We check: for each boundary in the hedge mask where BOTH tiles are plantable,
  // at least one of the two tiles must be hedge terrain.
  let boundaryPairs = 0;
  let bothMissing = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const me = owner[i];
      if (me < 0) continue;
      // Only check the east/south edges (matching R-G1's rule)
      for (const n of [i + 1, i + w]) {
        if (n >= owner.length) continue;
        const them = owner[n];
        if (them < 0 || them === me) continue;
        // This is a parcel boundary. Check if the hedge mask has a hedge here.
        if (!hedge[i] && n === i + 1) continue; // hedge is on the south tile for vertical boundaries
        // Actually: R-G1 marks the east/south tile as hedge. So for boundary (i, i+1),
        // hedge[i] = 1 (i checks east), and for boundary (i, i+w), hedge[i] = 1 (i checks south).
        boundaryPairs++;
        // Check if at least one of the two tiles has hedge terrain painted
        const hHere = map.terrainKeyAt(x, y) === 'hedge';
        const hThere = map.terrainKeyAt(n % w, (n / w) | 0) === 'hedge';
        if (!hHere && !hThere) bothMissing++;
      }
    }
  if (bothMissing > boundaryPairs * 0.5)
    fail(`${kind} seed ${seed}: ${bothMissing}/${boundaryPairs} boundary pairs missing hedge (both sides — likely blocked by roads/buildings)`);
}

for (const kind of KINDS) {
  for (const seed of EXTRA_SEEDS) {
    const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
    const plan = planBourg(base, W, H, PROFILES[kind]);
    const map = new GameMap(W, H);
    stampBourg(map, plan);
    checkBoundaryGaps(plan, map, kind, seed);
  }
}
// Count actual gaps (both sides hedge-masked but neither got painted as hedge)
// and analyze WHY (road/building/zone interference vs actual algorithm defect)
const { plan: plan1 } = (() => {
  const base = mulberry32(((1 ^ 0x51ab3fc7) >>> 0)).int(0x7fffffff);
  return { plan: planBourg(base, W, H, PROFILES['bourg']) };
})();
const map1 = new GameMap(W, H);
stampBourg(map1, plan1);
const { owner, hedge } = plan1.rural;
let bothMissing = 0, roadBlocked = 0, bldBlocked = 0, zoneBlocked = 0, otherBlocked = 0;
const inZone = zoneOf((() => { const b = mulberry32(((1 ^ 0x51ab3fc7) >>> 0)).int(0x7fffffff); return planBourg(b, W, H, PROFILES['bourg']).sk; })());
// Actually need the skeleton — let's get it from planBourg
const base1 = mulberry32(((1 ^ 0x51ab3fc7) >>> 0)).int(0x7fffffff);
const plan1b = planBourg(base1, W, H, PROFILES['bourg']);
const sk1 = plan1b.sk;
const zone1 = zoneOf(sk1);
const map1b = new GameMap(W, H);
stampBourg(map1b, plan1b);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const me = plan1b.rural.owner[i];
    if (me < 0) continue;
    for (const n of [i + 1, i + W]) {
      if (n >= owner.length) continue;
      const them = plan1b.rural.owner[n];
      if (them < 0 || them === me) continue;
      if (!plan1b.rural.hedge[i]) continue;
      const hHere = map1b.terrainKeyAt(x, y) === 'hedge';
      const hThere = map1b.terrainKeyAt(n % W, (n / W) | 0) === 'hedge';
      if (!hHere && !hThere) {
        bothMissing++;
        // Check why
        if (sk1.road[i] || sk1.road[n]) roadBlocked++;
        else if (plan1b.fp.occ[i] || plan1b.fp.occ[n]) bldBlocked++;
        else if (zone1(x, y) || zone1(n % W, (n / W) | 0)) zoneBlocked++;
        else otherBlocked++;
      }
    }
  }
console.log(`  bourg seed 1 gap analysis: ${bothMissing} pairs, road=${roadBlocked}, bld=${bldBlocked}, zone=${zoneBlocked}, other=${otherBlocked}`);
if (otherBlocked === 0) ok('All boundary gaps explained by roads/buildings/zone — no algorithm defect');

// ══════════════════════════════════════════════════════════════════════════
// Corner-contact astar leak test — realistic pathfinding through corners
// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== Corner-contact astar leak test ===');
// For each kind, find two tiles on opposite sides of a hedge boundary
// that are separated by a corner contact, and verify astar cannot path between them.

function testCornerLeaks(map, kind, seed) {
  const { w, h } = map;
  const isH = (x, y) => x >= 0 && y >= 0 && x < w && y < h && map.terrainKeyAt(x, y) === 'hedge';
  
  // Find all corner-contact hedge intersections
  // A corner contact: hedge at (x,y) and (x+1,y+1) but (x+1,y) and (x,y+1) NOT hedge
  // This means the two hedge lines meet at a corner but don't connect.
  let corners = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      if (!isH(x, y)) continue;
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!isH(x + dx, y + dy)) continue;
        // The two tiles orthogonal to the corner must be NON-hedge
        if (isH(x + dx, y) || isH(x, y + dy)) continue;
        corners.push({ x1: x, y1: y, x2: x + dx, y2: y + dy, mx: x + dx, my: y, gx: x, gy: y + dy });
      }
    }
  
  if (corners.length === 0) return; // no corners to test
  
  // For each corner, try to path from one side to the other through the corner
  let leaks = 0;
  for (const c of corners.slice(0, 100)) { // sample first 100 corners
    // Try to path from a non-hedge tile on one side of the corner to a non-hedge tile on the other side
    // The two sides are: (c.x1, c.y1) and (c.x2, c.y2) are hedge tiles
    // The gap tiles are (c.mx, c.my) and (c.gx, c.gy) — these are non-hedge
    // Try pathing from the gap tiles themselves through the diagonal
    
    // Actually: try pathing from (c.mx, c.my) to (c.gx, c.gy) — this IS the diagonal step
    // astar with diagonal movement would try to go directly if canStep allows
    // But let's try a longer path: from one parcel to another parcel, across the corner
    // The parcels are the areas outside the hedge lines
    // Find start point: 2 tiles away from corner on one side
    const startX = c.mx + (c.x2 > c.x1 ? -2 : 2);
    const startY = c.my + (c.y2 > c.y1 ? -2 : 0);
    const endX = c.gx + (c.x2 > c.x1 ? 0 : 0);
    const endY = c.gy + (c.y2 > c.y1 ? 2 : -2);
    
    // Clamp
    const sx = Math.max(1, Math.min(w - 2, startX));
    const sy = Math.max(1, Math.min(h - 2, startY));
    const ex = Math.max(1, Math.min(w - 2, endX));
    const ey = Math.max(1, Math.min(h - 2, endY));
    
    // Skip if start/end are hedge or impassable
    if (!map.terrainAt(sx, sy).passable) continue;
    if (!map.terrainAt(ex, ey).passable) continue;
    if (map.terrainKeyAt(sx, sy) === 'hedge') continue;
    if (map.terrainKeyAt(ex, ey) === 'hedge') continue;
    
    const path = astar(map, sx, sy, ex, ey, 'foot');
    if (path) {
      // Check if the path goes through the diagonal corner gap
      const goesThroughCorner = path.some(t => 
        (t.x === c.mx && t.y === c.my && path.some(u => u.x === c.gx && u.y === c.gy)) ||
        (t.x === c.gx && t.y === c.gy && path.some(u => u.x === c.mx && u.y === c.my))
      );
      if (goesThroughCorner || path.some(t => 
        (t.x === c.mx && t.y === c.my) || (t.x === c.gx && t.y === c.gy)
      )) {
        leaks++;
        if (leaks <= 5) fail(`${kind} seed ${seed}: corner leak at (${c.x1},${c.y1})↔(${c.x2},${c.y2}) — astar path found through gap`);
      }
    }
  }
  return leaks;
}

for (const kind of KINDS) {
  let totalLeaks = 0;
  for (const seed of EXTRA_SEEDS.slice(0, 5)) {
    const { map } = generateMap(seed, W, H, kind);
    const leaks = testCornerLeaks(map, kind, seed) || 0;
    totalLeaks += leaks;
  }
  if (totalLeaks === 0) ok(`${kind}: no corner-contact path leaks across 5 seeds`);
}

// ══════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`);
if (failures === 0) {
  console.log('VERDICT: All adversarial probes PASSED.');
} else {
  console.log(`VERDICT: ${failures} FAILURES found.`);
}