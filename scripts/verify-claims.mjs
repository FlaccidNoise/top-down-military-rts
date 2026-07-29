// Empirical verification script: generate seeded maps, dump evidence for all 6 claims.
// Run: npx vite-node scripts/verify-claims.mjs -- --seeds 1,2,3,7,13 [--claim 1-6]
import { generateMap } from '../src/sim/mapgen';
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { buildObjectives } from '../src/sim/bourg/objectives';
import { zoneOf } from '../src/sim/bourg/rural';
import { GameMap } from '../src/sim/map';
import { mulberry32 } from '../src/sim/rng';
import { BOURG } from '../src/sim/bourg/profile';
import { TERRAIN } from '../src/sim/data';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? (isNaN(Number(process.argv[i + 1])) ? process.argv[i + 1] : Number(process.argv[i + 1]))
    : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const SEEDS = String(arg('seeds', '1,2,3,7,13')).split(',').map(Number);
const W = arg('w', 320);
const H = arg('h', 240);
const CLAIM = arg('claim', null); // single claim to verify, or all

function key(map, x, y) { return map.terrainKeyAt(x, y); }
const TERRAIN_KEYS = Object.keys(TERRAIN);

const results = {};

// ══════════════════════════════════════════════════════════════════════════
// GENERATE MAPS (bourg kind)
// ══════════════════════════════════════════════════════════════════════════
console.log('=== Generating maps ===');
const maps = [];
const timings = [];
for (const seed of SEEDS) {
  const t0 = performance.now();
  const plan = generateMap(seed, W, H, 'bourg');
  const ms = performance.now() - t0;
  maps.push({ seed, plan });
  timings.push(ms);
  console.log(`seed ${seed}: ${plan.buildings.length} buildings, ${plan.woodsStands.length} stands, ${ms.toFixed(1)}ms`);
}
console.log(`timing: min=${Math.min(...timings).toFixed(1)}ms max=${Math.max(...timings).toFixed(1)}ms mean=${(timings.reduce((a,b)=>a+b,0)/timings.length).toFixed(1)}ms`);

// ══════════════════════════════════════════════════════════════════════════
// CLAIM 1: Double-wide hedge walls
// Check two things: (a) are there adjacent hedge terrain tiles? 
// (b) do hedge boundary hEdges/vEdges show double WALL patterns?
// ══════════════════════════════════════════════════════════════════════════
if (!CLAIM || CLAIM === '1') {
  console.log('\n=== CLAIM 1: Double-wide hedge wall runs ===');
  const findings = [];
  for (const { seed, plan } of maps) {
    const { map } = plan;
    
    // (a) Adjacent hedge terrain tiles — check for 2-wide patches
    let adjacentHedgeTiles = 0;
    const visited = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (visited[y * W + x]) continue;
        if (key(map, x, y) !== 'hedge') continue;
        // Flood fill to find hedge cluster size
        let cluster = [];
        let head = 0;
        cluster.push(y * W + x);
        visited[y * W + x] = 1;
        while (head < cluster.length) {
          const i = cluster[head++];
          const cx = i % W, cy = (i / W) | 0;
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && !visited[ny * W + nx] && key(map, nx, ny) === 'hedge') {
              visited[ny * W + nx] = 1;
              cluster.push(ny * W + nx);
            }
          }
        }
        if (cluster.length === 2) {
          // Check if they're adjacent (same column or row)
          const c1 = cluster[0], c2 = cluster[1];
          const dx = Math.abs((c1 % W) - (c2 % W));
          const dy = Math.abs(((c1 / W) | 0) - ((c2 / W) | 0));
          if (dx + dy === 1) adjacentHedgeTiles++;
        }
      }
    }
    
    // (b) Check hEdges/vEdges for double WALL runs along bocage
    // The bocage hedge mask in rural.ts writes 'hedge' terrain; the enclosures
    // stage writes WALL edges. Check if there are WALL edges that are
    // adjacent and both part of the same hedge line.
    let doubleWalls = 0;
    // Check adjacent hEdge WALLs (same y, adjacent x)
    for (let y = 0; y <= H; y++) {
      let run = 0;
      for (let x = 0; x < W; x++) {
        if (map.hEdge(x, y) === 1) { // EDGE.WALL = 1
          run++;
        } else {
          if (run >= 2) doubleWalls += run - 1; // count extra-wide segments per pair
          run = 0;
        }
      }
      if (run >= 2) doubleWalls += run - 1;
    }
    // Check adjacent vEdge WALLs
    for (let x = 0; x <= W; x++) {
      let run = 0;
      for (let y = 0; y < H; y++) {
        if (map.vEdge(x, y) === 1) {
          run++;
        } else {
          if (run >= 2) doubleWalls += run - 1;
          run = 0;
        }
      }
      if (run >= 2) doubleWalls += run - 1;
    }
    
    // Count total hedge tiles and check for 2+ adjacent hedge clusters
    let totalHedge = 0;
    for (let i = 0; i < W * H; i++) if (map.tiles[i] === TERRAIN_KEYS.indexOf('hedge')) totalHedge++;
    
    findings.push({ seed, totalHedge, adjacentClusters: adjacentHedgeTiles, doubleWalls });
  }
  
  for (const f of findings) {
    console.log(`  seed ${f.seed}: ${f.totalHedge} hedge tiles, ${f.adjacentClusters} paired-adjacent clusters, ${f.doubleWalls} adjacent WALL edge pairs`);
  }
  
  // CODE PATH: the bocage hedge mask is written in rural.ts bocage() -> paintRural -> setTerrain('hedge')
  // Each hedge tile is a single cell. The WALL edges come from enclosures.ts which writes
  // around gardens/compounds, not from the hedge mask.
  // Let's verify: print a sample hedge boundary from seed 1
  const m0 = maps[0].plan.map;
  console.log('  Sample hedge tiles near (160,100) seed 1:');
  const samples = [];
  for (let y = 98; y < 112; y++) {
    let row = '';
    for (let x = 155; x < 170; x++) {
      if (x >= W || y >= H) continue;
      const k = key(m0, x, y);
      row += k === 'hedge' ? 'H' : k === 'field' ? 'F' : k === 'grass' ? '.' : k === 'road' ? '#' : k === 'woods' ? 'W' : k[0];
    }
    samples.push(`${String(y).padStart(3)}: ${row}`);
  }
  console.log(samples.join('\n'));
  
  results.claim1 = findings;
}

// ══════════════════════════════════════════════════════════════════════════
// CLAIM 2: Building/compound overlaps
// ══════════════════════════════════════════════════════════════════════════
if (!CLAIM || CLAIM === '2') {
  console.log('\n=== CLAIM 2: Building compound overlaps ===');
  // We need the internal footprint data which isn't exposed on MapPlan directly.
  // Re-run planBourg to get the Footprints object.
  for (const seed of SEEDS) {
    const base = (seed * 0x9e3779b1) >>> 1;
    const plan = planBourg(base, W, H, BOURG);
    const { fp } = plan;
    
    // Check building-building overlaps
    let buildingOverlaps = [];
    for (let i = 0; i < fp.buildings.length; i++) {
      const a = fp.buildings[i];
      const aRects = a.parts || [a];
      for (let j = i + 1; j < fp.buildings.length; j++) {
        const b = fp.buildings[j];
        const bRects = b.parts || [b];
        for (const ra of aRects) {
          for (const rb of bRects) {
            if (ra.x < rb.x + rb.w && ra.x + ra.w > rb.x && ra.y < rb.y + rb.h && ra.y + ra.h > rb.y) {
              buildingOverlaps.push({
                a: `${a.role || 'house'}@${ra.x},${ra.y} ${ra.w}x${ra.h}`,
                b: `${b.role || 'house'}@${rb.x},${rb.y} ${rb.w}x${rb.h}`,
              });
            }
          }
        }
      }
    }
    
    // Check building vs compound overlaps
    let compoundOverlaps = [];
    for (const c of fp.compounds) {
      for (const b of fp.buildings) {
        const rects = b.parts || [b];
        for (const r of rects) {
          if (r.x < c.rect.x + c.rect.w && r.x + r.w > c.rect.x && r.y < c.rect.y + c.rect.h && r.y + r.h > c.rect.y) {
            // Buildings are supposed to be on the *boundary* of compounds, not overlapping.
            // A building that sits entirely on the edge/perimeter is part of the yard.
            // Check if it's entirely within the compound (true overlap) or just on boundary.
            const fullyInside = 
              r.x >= c.rect.x && r.y >= c.rect.y && 
              r.x + r.w <= c.rect.x + c.rect.w && 
              r.y + r.h <= c.rect.y + c.rect.h;
            compoundOverlaps.push({
              compound: `${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h} open=${c.open}`,
              building: `${b.role || 'house'}@${r.x},${r.y} ${r.w}x${r.h}`,
              fullyInside,
            });
          }
        }
      }
    }
    
    // Check compound vs compound overlaps
    let compoundCompoundOverlaps = [];
    for (let i = 0; i < fp.compounds.length; i++) {
      const a = fp.compounds[i].rect;
      for (let j = i + 1; j < fp.compounds.length; j++) {
        const b = fp.compounds[j].rect;
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          compoundCompoundOverlaps.push({
            a: `${a.x},${a.y} ${a.w}x${a.h}`,
            b: `${b.x},${b.y} ${b.w}x${b.h}`,
          });
        }
      }
    }
    
    // Check building vs garden overlaps (should NEVER happen since gardens are behind buildings)
    let buildingGardenOverlaps = [];
    for (const g of fp.gardens) {
      for (const b of fp.buildings) {
        const rects = b.parts || [b];
        for (const r of rects) {
          if (r.x < g.rect.x + g.rect.w && r.x + r.w > g.rect.x && r.y < g.rect.y + g.rect.h && r.y + r.h > g.rect.y) {
            buildingGardenOverlaps.push({
              garden: `${g.rect.x},${g.rect.y} ${g.rect.w}x${g.rect.h}`,
              building: `${b.role || 'house'}@${r.x},${r.y} ${r.w}x${r.h}`,
            });
          }
        }
      }
    }
    
    console.log(`  seed ${seed}: ${fp.buildings.length} buildings, ${fp.compounds.length} compounds, ${fp.gardens.length} gardens`);
    if (buildingOverlaps.length > 0) {
      console.log(`    BUILDING-BUILDING OVERLAPS: ${buildingOverlaps.length}`);
      for (const o of buildingOverlaps.slice(0, 5)) console.log(`      ${o.a} ⇔ ${o.b}`);
    }
    if (compoundOverlaps.length > 0) {
      console.log(`    COMPOUND-BUILDING overlaps: ${compoundOverlaps.length}`);
      for (const o of compoundOverlaps.slice(0, 5)) console.log(`      compound ${o.compound} ⇔ building ${o.building} fullyInside=${o.fullyInside}`);
    }
    if (compoundCompoundOverlaps.length > 0) {
      console.log(`    COMPOUND-COMPOUND OVERLAPS: ${compoundCompoundOverlaps.length}`);
      for (const o of compoundCompoundOverlaps.slice(0, 5)) console.log(`      ${o.a} ⇔ ${o.b}`);
    }
    if (buildingGardenOverlaps.length > 0) {
      console.log(`    BUILDING-GARDEN OVERLAPS: ${buildingGardenOverlaps.length}`);
      for (const o of buildingGardenOverlaps.slice(0, 5)) console.log(`      ${o.building} ⇔ garden ${o.garden}`);
    }
    if (buildingOverlaps.length === 0 && compoundOverlaps.length === 0 && compoundCompoundOverlaps.length === 0 && buildingGardenOverlaps.length === 0) {
      console.log('    ✓ No overlaps detected');
    }
    
    results[`claim2_seed${seed}`] = { buildingOverlaps, compoundOverlaps, compoundCompoundOverlaps, buildingGardenOverlaps };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CLAIM 3: Square/flat town plateau edge
// Dump elev[] around the bourg envelope boundary
// ══════════════════════════════════════════════════════════════════════════
if (!CLAIM || CLAIM === '3') {
  console.log('\n=== CLAIM 3: Town plateau elevation ===');
  for (const { seed, plan } of maps) {
    const { map } = plan;
    // Recompute the flat mask to find the envelope
    const base = (seed * 0x9e3779b1) >>> 1;
    const bourgPlan = planBourg(base, W, H, BOURG);
    const inZone = zoneOf(bourgPlan.sk);
    const env = bourgPlan.sk.env;
    
    // Find the boundary tiles: inside zone but adjacent to outside
    const boundary = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!inZone(x, y)) continue;
        let isBoundary = false;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (!inZone(nx, ny)) { isBoundary = true; break; }
        }
        if (isBoundary) boundary.push({ x, y, elev: map.elev[y * W + x], terrain: key(map, x, y) });
      }
    }
    
    // Count elevations on boundary vs interior
    const boundaryElevs = {};
    const interiorElevs = {};
    for (const b of boundary) {
      boundaryElevs[b.elev] = (boundaryElevs[b.elev] || 0) + 1;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!inZone(x, y)) continue;
        const e = map.elev[y * W + x];
        interiorElevs[e] = (interiorElevs[e] || 0) + 1;
      }
    }
    
    console.log(`  seed ${seed}: envelope ${env.x},${env.y} ${env.w}x${env.h}`);
    console.log(`    Boundary elev distribution: ${JSON.stringify(boundaryElevs)}`);
    console.log(`    Interior elev distribution: ${JSON.stringify(interiorElevs)}`);
    
    // Sample a transect across the north edge of the envelope
    const ty = Math.max(0, env.y - 1);
    if (ty < H) {
      let transect = '';
      for (let x = Math.max(0, env.x - 5); x < Math.min(W, env.x + env.w + 5); x++) {
        if (inZone(x, ty)) transect += String(map.elev[ty * W + x]);
        else transect += '_';
      }
      console.log(`    Transect y=${ty} (N edge): ${transect}`);
    }
    // Sample a transect across the south edge
    const sy = Math.min(H - 1, env.y + env.h);
    if (sy >= 0) {
      let transect = '';
      for (let x = Math.max(0, env.x - 5); x < Math.min(W, env.x + env.w + 5); x++) {
        if (inZone(x, sy)) transect += String(map.elev[sy * W + x]);
        else transect += '_';
      }
      console.log(`    Transect y=${sy} (S edge): ${transect}`);
    }
    
    // Check: are there ANY non-zero elevations inside the zone?
    let nonZeroInside = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (inZone(x, y) && map.elev[y * W + x] > 0) {
          nonZeroInside.push({ x, y, elev: map.elev[y * W + x] });
        }
      }
    }
    if (nonZeroInside.length > 0) {
      console.log(`    ⚠ ${nonZeroInside.length} non-zero elevation tiles INSIDE town zone (first 10):`);
      for (const t of nonZeroInside.slice(0, 10)) 
        console.log(`      (${t.x},${t.y}) elev=${t.elev} terrain=${key(map, t.x, t.y)}`);
    } else {
      console.log('    ✓ All town zone tiles at elev 0 (flat plateau)');
    }
    
    results[`claim3_seed${seed}`] = { boundaryElevs, interiorElevs, nonZeroInside: nonZeroInside.length };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CLAIM 4: Farm fields vs bocage alignment
// ══════════════════════════════════════════════════════════════════════════
if (!CLAIM || CLAIM === '4') {
  console.log('\n=== CLAIM 4: Farm fields vs bocage hedge alignment ===');
  for (const { seed, plan } of maps) {
    const { map } = plan;
    const base = (seed * 0x9e3779b1) >>> 1;
    const bourgPlan = planBourg(base, W, H, BOURG);
    const inZone = zoneOf(bourgPlan.sk);
    
    // Find all field tiles
    let fields = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (key(map, x, y) === 'field') fields.push({ x, y });
      }
    }
    
    // For each field tile, check if any adjacent tile (4-way) is a hedge
    let fieldAdjacentToHedge = 0;
    let fieldIsolated = 0;
    for (const f of fields) {
      let hasHedgeNeighbor = false;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = f.x + dx, ny = f.y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && key(map, nx, ny) === 'hedge') {
          hasHedgeNeighbor = true;
          break;
        }
      }
      if (hasHedgeNeighbor) fieldAdjacentToHedge++;
      else fieldIsolated++;
    }
    
    // Get the hedge mask from rural to check bocage cell boundaries
    const hedgeMask = bourgPlan.rural.hedge;
    
    // Check if fields are painted inside bocage cells (hedge-parcel-bounded regions)
    // by checking if fields span across hedge boundaries
    let fieldsCrossingHedges = 0;
    for (const f of fields) {
      // Check the 4 edges of this field tile against hedge mask boundaries
      let crossesBoundary = false;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = f.x + dx, ny = f.y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
          // If the two tiles are on opposite sides of a hedge boundary in the mask
          if (hedgeMask[f.y * W + f.x] !== hedgeMask[ny * W + nx]) {
            // This is a bocage parcel boundary, but fields might still sit in open country
            // Only flag if both tiles are outside the town zone
            if (!inZone(f.x, f.y) && !inZone(nx, ny)) {
              crossesBoundary = true;
            }
          }
        }
      }
      if (crossesBoundary) fieldsCrossingHedges++;
    }
    
    // Check if fields are rectangular (painted independently) by examining field extent
    // Fields in paintRural are axis-aligned rectangles, so group tiles into clusters
    const fieldVisited = new Uint8Array(W * H);
    let fieldClusters = [];
    for (const f of fields) {
      if (fieldVisited[f.y * W + f.x]) continue;
      let cluster = [];
      let head = 0;
      cluster.push(f.y * W + f.x);
      fieldVisited[f.y * W + f.x] = 1;
      while (head < cluster.length) {
        const i = cluster[head++];
        const cx = i % W, cy = (i / W) | 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !fieldVisited[ny * W + nx] && key(map, nx, ny) === 'field') {
            fieldVisited[ny * W + nx] = 1;
            cluster.push(ny * W + nx);
          }
        }
      }
      fieldClusters.push(cluster);
    }
    
    console.log(`  seed ${seed}: ${fields.length} field tiles in ${fieldClusters.length} clusters`);
    console.log(`    Fields adjacent to hedge: ${fieldAdjacentToHedge}/${fields.length}`);
    console.log(`    Fields isolated (no hedge neighbor): ${fieldIsolated}/${fields.length}`);
    console.log(`    Fields crossing bocage parcel boundaries: ${fieldsCrossingHedges}`);
    
    // Find a sample field and its bounding bocage
    if (fieldClusters.length > 0) {
      const sample = fieldClusters[0];
      let minX = W, minY = H, maxX = 0, maxY = 0;
      for (const i of sample) {
        const x = i % W, y = (i / W) | 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      // Dump the area around the first field cluster
      console.log(`    Sample field cluster at ${minX},${minY} ${maxX-minX+1}x${maxY-minY+1}:`);
      for (let y = Math.max(0, minY - 2); y <= Math.min(H - 1, maxY + 2); y++) {
        let row = `${String(y).padStart(3)}: `;
        for (let x = Math.max(0, minX - 2); x <= Math.min(W - 1, maxX + 2); x++) {
          const k = key(map, x, y);
          row += k === 'hedge' ? 'H' : k === 'field' ? 'F' : k === 'grass' ? '.' : k === 'road' ? '#' : k === 'woods' ? 'W' : k[0];
        }
        console.log(row);
      }
    }
    
    results[`claim4_seed${seed}`] = { fieldCount: fields.length, clusters: fieldClusters.length, adjacentHedge: fieldAdjacentToHedge, crossingBocage: fieldsCrossingHedges };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CLAIM 5: Farmhouse footprint identity
// ══════════════════════════════════════════════════════════════════════════
if (!CLAIM || CLAIM === '5') {
  console.log('\n=== CLAIM 5: Farmhouse footprint variability ===');
  for (const seed of SEEDS) {
    const base = (seed * 0x9e3779b1) >>> 1;
    const plan = planBourg(base, W, H, BOURG);
    const { fp } = plan;
    
    const farmhouses = fp.buildings.filter(b => b.role === 'farmhouse');
    const outlyingFarms = []; // appended by addRuralFabric
    const inTownFarms = []; // from plot frontage
    
    // Separate: ones without compounds nearby are in-town plots; ones with compounds are outlying
    // Actually, easier: in-town farmhouses have frontage defined (from plot frontage in buildFootprints)
    // Outlying farmhouses come from placeFarms in rural.ts
    for (const f of farmhouses) {
      if (f.frontage) inTownFarms.push(f);
      else outlyingFarms.push(f);
    }
    
    console.log(`  seed ${seed}: ${farmhouses.length} farmhouses (${inTownFarms.length} in-town, ${outlyingFarms.length} outlying)`);
    
    // Compare all farmhouse dims
    const dims = farmhouses.map(f => `${f.w}x${f.h}`);
    const uniqueDims = [...new Set(dims)];
    console.log(`    Unique dims: ${uniqueDims.sort().join(', ')}`);
    
    // For outlying farmhouses, show their rects
    if (outlyingFarms.length >= 2) {
      for (const f of outlyingFarms) {
        console.log(`    Outlying farmhouse: ${f.x},${f.y} ${f.w}x${f.h} frontage=${f.frontage || 'none'} doors=${f.doors?.length || 0}`);
      }
      
      // Check if any two outlying farmhouses are identical
      let identical = 0;
      for (let i = 0; i < outlyingFarms.length; i++) {
        for (let j = i + 1; j < outlyingFarms.length; j++) {
          const a = outlyingFarms[i], b = outlyingFarms[j];
          if (a.w === b.w && a.h === b.h) identical++;
        }
      }
      console.log(`    Identical dim pairs among outlying: ${identical}`);
    }
    
    // For in-town farmhouses
    if (inTownFarms.length >= 2) {
      const inDims = inTownFarms.map(f => `${f.w}x${f.h}`);
      const inUnique = [...new Set(inDims)];
      console.log(`    In-town farmhouse unique dims: ${inUnique.sort().join(', ')}`);
    }
    
    results[`claim5_seed${seed}`] = { total: farmhouses.length, uniqueDims: uniqueDims.length, dims: uniqueDims };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CLAIM 6: Circular stepped mounds (cosine domes)
// ══════════════════════════════════════════════════════════════════════════
if (!CLAIM || CLAIM === '6') {
  console.log('\n=== CLAIM 6: Cosine dome elevation contours ===');
  for (const { seed, plan } of maps) {
    const { map } = plan;
    
    // Find the highest-elevation dome
    let maxElev = 0;
    let domeX = -1, domeY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const e = map.elev[y * W + x];
        if (e > maxElev) {
          maxElev = e;
          domeX = x;
          domeY = y;
        }
      }
    }
    
    if (domeX < 0) {
      console.log(`  seed ${seed}: no elevation (all flat)`);
      continue;
    }
    
    console.log(`  seed ${seed}: max elev ${maxElev} at (${domeX}, ${domeY})`);
    
    // Dump a 20x20 grid around the dome centre
    const r = 10;
    console.log(`    Elev contours around (${domeX}, ${domeY}):`);
    for (let y = Math.max(0, domeY - r); y <= Math.min(H - 1, domeY + r); y++) {
      let row = `${String(y).padStart(3)}: `;
      for (let x = Math.max(0, domeX - r); x <= Math.min(W - 1, domeX + r); x++) {
        const e = map.elev[y * W + x];
        row += e === 0 ? '.' : String(e);
      }
      console.log(row);
    }
    
    // Verify: is elev a decreasing function of distance from centre?
    // Check for non-monotonicity (violations of "farther from centre = same or lower")
    let nonMonotonic = 0;
    for (let y = Math.max(0, domeY - r); y <= Math.min(H - 1, domeY + r); y++) {
      for (let x = Math.max(0, domeX - r); x <= Math.min(W - 1, domeX + r); x++) {
        const d2 = (x - domeX) ** 2 + (y - domeY) ** 2;
        const e = map.elev[y * W + x];
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nd2 = (nx - domeX) ** 2 + (ny - domeY) ** 2;
          const ne = map.elev[ny * W + nx];
          // If a tile is closer to centre but has lower elevation: monotonicity violation
          if (nd2 < d2 && ne < e && ne > 0) nonMonotonic++;
        }
      }
    }
    console.log(`    Monotonicity violations (closer→lower): ${nonMonotonic}`);
    
    // Are the contours circular? Check: for each elevation level, compute the bbox
    // and its x/y extent ratio — a perfect circle has ratio ~1.0
    for (let lev = 1; lev <= maxElev; lev++) {
      let minX = W, minY = H, maxX = 0, maxY = 0;
      let count = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (map.elev[y * W + x] >= lev) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            count++;
          }
        }
      }
      if (count > 0) {
        const ew = maxX - minX + 1;
        const eh = maxY - minY + 1;
        console.log(`    Elev >= ${lev}: ${count} tiles, bbox ${minX},${minY} ${ew}x${eh}, ratio=${(ew/eh).toFixed(2)}`);
      }
    }
    
    results[`claim6_seed${seed}`] = { maxElev, domeX, domeY, nonMonotonic };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// CODE PATH ANALYSIS
// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== CODE PATH TRACE ===');
console.log('CLAIM 1 (hedge wideness):');
console.log('  bocage hedge mask → rural.ts bocage() → paintRural() → map.setTerrain("hedge")');
console.log('  Each hedge tile is a single 1x1 terrain cell. The bocage Voronoi sets');
console.log('  owner[y*w+x] per tile; hedge[y*w+x]=1 where any 4-neighbor has different owner.');
console.log('  Result: single-tile-wide hedge lines along Voronoi cell boundaries.');
console.log('  Garden/yard walls (enclosures.ts) write EDGE.WALL, NOT hedge terrain — these');
console.log('  are the free-standing walls, not the bocage hedge terrain.');
console.log('');
console.log('CLAIM 3 (town plateau):');
console.log('  elevateBourg (mapgen.ts) → bourgFlatMask → flat[y*w+x]=1 for all zoneOf tiles');
console.log('  flat[y*w+x]=1 for compound rects dilated by 2');
console.log('  flat[y*w+x]=1 for building occupancy dilated by 1');
console.log('  flat[y*w+x]=1 for free-standing wall edges');
console.log('  In elevateBourg: "if (d2>r2 || flat[y*w+x]) continue" — SKIPS flat tiles');
console.log('  Result: domes can only paint outside the zone → sharp boundary at town edge');
console.log('');
console.log('CLAIM 4 (farm fields):');
console.log('  paintRural() writes fields (tag 12): random axis-aligned rectangles of "field" terrain');
console.log('  plantable() check: !sk.road && !land.resv && !pc.claimed && !near && terrain=="grass"');
console.log('  Bocage hedges are written FIRST (from hedge mask), fields AFTER');
console.log('  plantable() forbids writing over non-grass, but hedge IS grass before painting');
console.log('  WAIT: hedge terrain IS written first, so after hedge painting, those tiles are "hedge"');
console.log('  plantable() checks map.terrainKeyAt(x,y)==="grass", so fields CANNOT write over hedges');
console.log('  But fields are placed BEFORE hedges? Let\'s check stampBourg order:');
console.log('    stampBourg: water → paintRural(hedges,woods,orchards,fields) → roads → buildings');
console.log('    paintRural writes hedges first, then orchards, then fields');
console.log('  So hedges ARE written before fields. A field cannot overwrite a hedge.');
console.log('  But the field placement does not respect bocage cell boundaries — fields are');
console.log('  placed anywhere plantable, so they can span across what would be bocage parcels.');
console.log('');

console.log('\nDone. Run with --claim N to verify a single claim.');