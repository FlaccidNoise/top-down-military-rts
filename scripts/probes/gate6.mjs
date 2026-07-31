// Seed 6 yard@137,123: predicted gate, carve outcome, and the carvable tile
import { buildFootprints } from '../../src/sim/bourg/footprints';
import { reserveLandmarks } from '../../src/sim/bourg/landmarks';
import { buildParcels } from '../../src/sim/bourg/parcels';
import { BOURG } from '../../src/sim/bourg/profile';
import { addRuralFabric, gateOutsideTile, paintRural } from '../../src/sim/bourg/rural';
import { buildSkeleton, growMinorStreets } from '../../src/sim/bourg/streets';
import { stampEnclosures } from '../../src/sim/bourg/enclosures';
import { stampStructure } from '../../src/sim/bourg/stamp';
import { GameMap, EDGE } from '../../src/sim/map';

const base = (seed) => (seed * 0x9e3779b1) >>> 1;
const W = 320, H = 240;
const inZ = (sk, x, y) =>
  (x >= sk.env.x - 6 && x <= sk.env.x + sk.env.w + 5 && y >= sk.env.y - 6 && y <= sk.env.y + sk.env.h + 5) ||
  (sk.faubourg !== null && Math.abs(x - sk.faubourg.x) <= 22 && Math.abs(y - sk.faubourg.y) <= 22);
const sk = buildSkeleton(base(6), W, H, BOURG, new Uint8Array(W * H));
const land = reserveLandmarks(sk);
growMinorStreets(sk, { resv: land.resv, blocked: land.resv });
const pc = buildParcels(sk, land.resv);
const fp = buildFootprints(sk, land, pc);
const ru = addRuralFabric(sk, land, pc, fp);
const map = new GameMap(W, H);
paintRural(map, sk, land, pc, fp, ru);
for (let i = 0; i < W * H; i++) if (sk.road[i]) map.setTerrain(i % W, (i / W) | 0, 'road');
fp.buildings.forEach((b, i) => stampStructure(map, b, i));
stampEnclosures(map, sk, land, fp);

const c = fp.compounds.find((c) => c.rect.x === 137 && c.rect.y === 123);
const r = c.rect;
const g = gateOutsideTile(c, fp, W, H);
console.log('rect', JSON.stringify(r), 'open=' + c.open, 'predicted gate:', JSON.stringify(g));
console.log('gate road?', sk.road[g.y * W + g.x], '4n:', [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => sk.road[(g.y+dy)*W+(g.x+dx)] ?? 'ob'));

// replicate the test's carvable scan, print the first carvable target
const inCompound = (x, y) => fp.compounds.some((c2) => x >= c2.rect.x && x < c2.rect.x + c2.rect.w && y >= c2.rect.y && y < c2.rect.y + c2.rect.h);
const legal = (x, y) =>
  x >= 1 && y >= 1 && x < W - 1 && y < H - 1 && !fp.occ[y * W + x] && !sk.water[y * W + x] && !inZ(sk, x, y) && !inCompound(x, y);
let found = false;
for (let i = 0; i < W * H && !found; i++) {
  if (!sk.road[i]) continue;
  const tx = i % W, ty = (i / W) | 0;
  if (Math.max(Math.abs(tx - g.x), Math.abs(ty - g.y)) > 96) continue;
  for (const hf of [true, false]) {
    let px = g.x, py = g.y, ok = legal(px, py);
    const legs = hf
      ? [[Math.sign(tx - px), 0, Math.abs(tx - px)], [0, Math.sign(ty - py), Math.abs(ty - py)]]
      : [[0, Math.sign(ty - py), Math.abs(ty - py)], [Math.sign(tx - px), 0, Math.abs(tx - px)]];
    for (const [dx, dy, n] of legs)
      for (let s = 0; s < n && ok; s++) {
        px += dx; py += dy;
        if (px === tx && py === ty) break;
        if (!legal(px, py)) ok = false;
      }
    if (ok) { console.log('carvable target:', tx, ty, 'hFirst=', hf); found=true; break; }
  }
}
console.log('no carvable target within 96');
// actual boundary doors
for (let x = r.x; x < r.x + r.w; x++) {
  if (map.hEdge(x, r.y) === EDGE.DOOR) console.log(`door h(${x},${r.y}) road-out=${!!sk.road[(r.y-1)*W+x]}`);
  if (map.hEdge(x, r.y + r.h) === EDGE.DOOR) console.log(`door h(${x},${r.y+r.h}) road-out=${!!sk.road[(r.y+r.h)*W+x]}`);
}
for (let y = r.y; y < r.y + r.h; y++) {
  if (map.vEdge(r.x, y) === EDGE.DOOR) console.log(`door v(${r.x},${y}) road-out=${!!sk.road[y*W+r.x-1]}`);
  if (map.vEdge(r.x + r.w, y) === EDGE.DOOR) console.log(`door v(${r.x+r.w},${y}) road-out=${!!sk.road[y*W+r.x+r.w]}`);
}

console.log('\nall boundary edges:');
for (let x = r.x; x < r.x + r.w; x++) {
  console.log(`h(${x},${r.y}) e=${map.hEdge(x, r.y)} top=${map.hEdgeTops[r.y * W + x]} occ-in=${!!fp.occ[r.y * W + x]} occ-out=${!!fp.occ[(r.y - 1) * W + x]}`);
}
for (let x = r.x; x < r.x + r.w; x++) {
  console.log(`h(${x},${r.y + r.h}) e=${map.hEdge(x, r.y + r.h)} top=${map.hEdgeTops[(r.y + r.h) * W + x]} occ-in=${!!fp.occ[(r.y + r.h - 1) * W + x]} occ-out=${!!fp.occ[(r.y + r.h) * W + x]}`);
}
for (let y = r.y; y < r.y + r.h; y++) {
  console.log(`v(${r.x},${y}) e=${map.vEdge(r.x, y)} occ-in=${!!fp.occ[y * W + r.x]} occ-out=${!!fp.occ[y * W + r.x - 1]} | v(${r.x + r.w},${y}) e=${map.vEdge(r.x + r.w, y)} occ-in=${!!fp.occ[y * W + r.x + r.w - 1]} occ-out=${!!fp.occ[y * W + r.x + r.w]}`);
}
console.log('\nbuildings near:');
for (const b of fp.buildings) {
  if (b.x > r.x + r.w + 2 || b.x + b.w < r.x - 2 || b.y > r.y + r.h + 2 || b.y + b.h < r.y - 2) continue;
  console.log(' ', JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h, role: b.role, parts: b.parts, doors: b.doors }));
}
