import { buildSkeleton, growMinorStreets } from '../src/sim/bourg/streets';
import { reserveLandmarks } from '../src/sim/bourg/landmarks';
import { buildParcels } from '../src/sim/bourg/parcels';
import { buildFootprints } from '../src/sim/bourg/footprints';
import { addRuralFabric, paintRural } from '../src/sim/bourg/rural';
import { stampEnclosures } from '../src/sim/bourg/enclosures';
import { stampStructure } from '../src/sim/bourg/stamp';
import { GameMap } from '../src/sim/map';
const base = (s) => (s * 0x9e3779b1) >>> 1;
const W = 320, H = 240;
const acc = {};
const mark = (k, t) => { acc[k] = (acc[k] ?? 0) + (performance.now() - t); };
for (let s = 1; s <= 50; s++) {
  let t = performance.now();
  const sk = buildSkeleton(base(s), W, H); const land = reserveLandmarks(sk); growMinorStreets(sk, { resv: land.resv });
  mark('skeleton', t); t = performance.now();
  const pc = buildParcels(sk, land.resv); mark('parcels', t); t = performance.now();
  const fp = buildFootprints(sk, land, pc); mark('footprints', t); t = performance.now();
  const ru = addRuralFabric(sk, land, pc, fp); mark('rural-plan', t); t = performance.now();
  const map = new GameMap(W, H);
  paintRural(map, sk, land, pc, fp, ru); mark('rural-paint', t); t = performance.now();
  for (let i = 0; i < W * H; i++) if (sk.road[i]) map.setTerrain(i % W, (i / W) | 0, 'road');
  fp.buildings.forEach((b, i) => stampStructure(map, b, i)); mark('stamp', t); t = performance.now();
  stampEnclosures(map, sk, land, fp); mark('enclosures', t);
}
for (const k of Object.keys(acc)) console.log(k, (acc[k] / 50).toFixed(2), 'ms');
console.log('total', (Object.values(acc).reduce((a,b)=>a+b,0)/50).toFixed(2), 'ms');
