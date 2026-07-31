// Seed 15 yard@212,171: predicted gate vs actual stamp gates vs carve result
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
const sk = buildSkeleton(base(15), W, H, BOURG, new Uint8Array(W * H));
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

const c = fp.compounds.find((c) => c.rect.x === 212 && c.rect.y === 171);
const r = c.rect;
console.log('rect', JSON.stringify(r), 'open=' + c.open);
console.log('predicted gate:', JSON.stringify(gateOutsideTile(c, fp, W, H)));
// every boundary edge with its type
for (let x = r.x; x < r.x + r.w; x++) {
  const n = map.hEdge(x, r.y), s = map.hEdge(x, r.y + r.h);
  if (n !== EDGE.NONE) console.log(`h(${x},${r.y}) e=${n} top=${map.hEdgeTops[r.y * W + x]} roadN=${!!sk.road[(r.y - 1) * W + x]} occN=${!!fp.occ[(r.y - 1) * W + x]} occS=${!!fp.occ[r.y * W + x]}`);
  if (s !== EDGE.NONE) console.log(`h(${x},${r.y + r.h}) e=${s} top=${map.hEdgeTops[(r.y + r.h) * W + x]} roadS=${!!sk.road[(r.y + r.h) * W + x]} occN=${!!fp.occ[(r.y + r.h - 1) * W + x]} occS=${!!fp.occ[(r.y + r.h) * W + x]}`);
}
for (let y = r.y; y < r.y + r.h; y++) {
  const wE = map.vEdge(r.x, y), eE = map.vEdge(r.x + r.w, y);
  if (wE !== EDGE.NONE) console.log(`v(${r.x},${y}) e=${wE} top=${map.vEdgeTops[y * (W + 1) + r.x]} roadW=${!!sk.road[y * W + r.x - 1]} occW=${!!fp.occ[y * W + r.x - 1]} occE=${!!fp.occ[y * W + r.x]}`);
  if (eE !== EDGE.NONE) console.log(`v(${r.x + r.w},${y}) e=${eE} top=${map.vEdgeTops[y * (W + 1) + r.x + r.w]} roadE=${!!sk.road[y * W + r.x + r.w]} occW=${!!fp.occ[y * W + r.x + r.w - 1]} occE=${!!fp.occ[y * W + r.x + r.w]}`);
}
// buildings around
for (const b of fp.buildings) {
  if (b.x > r.x + r.w + 3 || b.x + b.w < r.x - 3 || b.y > r.y + r.h + 3 || b.y + b.h < r.y - 3) continue;
  console.log('bldg', JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h, role: b.role }));
}
