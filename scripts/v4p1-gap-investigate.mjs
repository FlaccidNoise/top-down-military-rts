// Investigate the 3 "other" boundary gaps for bourg seed 1
import { planBourg, stampBourg } from '../src/sim/bourg/plan';
import { GameMap } from '../src/sim/map';
import { mulberry32 } from '../src/sim/rng';
import { PROFILES } from '../src/sim/bourg/profile';
import { zoneOf } from '../src/sim/bourg/rural';

const W = 320, H = 240;
const base = mulberry32(((1 ^ 0x51ab3fc7) >>> 0)).int(0x7fffffff);
const plan = planBourg(base, W, H, PROFILES['bourg']);
const map = new GameMap(W, H);
stampBourg(map, plan);

const { owner } = plan.rural;
const sk = plan.sk;
const zone = zoneOf(sk);

// Dump every boundary pair where hedge mask says hedge but neither side painted
const hedge = plan.rural.hedge;
let count = 0;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const me = owner[i];
    if (me < 0) continue;
    for (const n of [i + 1, i + W]) {
      if (n >= owner.length) continue;
      const them = owner[n];
      if (them < 0 || them === me) continue;
      if (!hedge[i]) continue; // hedge mask doesn't have it
      const hHere = map.terrainKeyAt(x, y) === 'hedge';
      const hThere = map.terrainKeyAt(n % W, (n / W) | 0) === 'hedge';
      if (!hHere && !hThere) {
        const nx = n % W, ny = (n / W) | 0;
        // Figure out WHY
        const reasons = [];
        if (sk.water[i] || sk.water[n]) reasons.push('water');
        if (sk.road[i] || sk.road[n]) reasons.push('road');
        if (plan.fp.occ[i] || plan.fp.occ[n]) reasons.push('fp_occ');
        if (zone(x, y) || zone(nx, ny)) reasons.push('zone');
        // Check plantable conditions
        const near = new Uint8Array(W * H);
        for (let yy = 0; yy < H; yy++)
          for (let xx = 0; xx < W; xx++)
            if (plan.fp.occ[yy * W + xx])
              for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                  const nnx = xx + dx, nny = yy + dy;
                  if (nnx >= 0 && nny >= 0 && nnx < W && nny < H) near[nny * W + nnx] = 1;
                }
        if (near[i]) reasons.push('near_building');
        if (near[n]) reasons.push('near_building');
        // Check terrain: paintRural only writes on 'grass'
        if (map.terrainKeyAt(x, y) !== 'grass') reasons.push(`terrain_here=${map.terrainKeyAt(x, y)}`);
        if (map.terrainKeyAt(nx, ny) !== 'grass') reasons.push(`terrain_there=${map.terrainKeyAt(nx, ny)}`);
        const r = reasons.length ? reasons.join(',') : 'NONE';
        if (r === 'NONE' || reasons.every(rr => !['water', 'road', 'fp_occ', 'zone', 'near_building'].includes(rr))) {
          console.log(`  GAP at (${x},${y})↔(${nx},${ny})  reasons: ${r || 'NONE'}`);
          console.log(`    owner: me=${me} them=${them}  hedge=${hedge[i]}`);
          // Dump 3x3 around
          for (let dy = -1; dy <= 1; dy++) {
            let row = '';
            for (let dx = -1; dx <= 1; dx++) {
              const cx = x + dx, cy = y + dy;
              if (cx < 0 || cy < 0 || cx >= W || cy >= H) { row += '##'; continue; }
              const ci = cy * W + cx;
              const tk = map.terrainKeyAt(cx, cy);
              row += tk === 'hedge' ? 'H ' : tk === 'field' ? 'F ' : tk === 'grass' ? '. ' : tk === 'road' ? '# ' :
                     tk === 'woods' ? 'W ' : tk === 'water' ? '~ ' : tk === 'floor' ? 'B ' : tk.slice(0, 2) + ' ';
            }
            console.log(`    ${row}`);
          }
          count++;
        }
      }
    }
  }
if (count === 0) console.log('  No unexplained gaps found — all gaps have known reasons');
else console.log(`  ${count} unexplained gaps`);