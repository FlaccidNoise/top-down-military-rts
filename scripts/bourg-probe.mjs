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
const t0 = Date.now();
const counts = [];
for (let s = 1; s <= 20; s++) {
  const sk = buildSkeleton(base(s), W, H);
  const land = reserveLandmarks(sk);
  growMinorStreets(sk, { resv: land.resv });
  const pc = buildParcels(sk, land.resv);
  const fp = buildFootprints(sk, land, pc);
  const ru = addRuralFabric(sk, land, pc, fp);
  const map = new GameMap(W, H);
  const stands = paintRural(map, sk, land, pc, fp, ru);
  for (let i = 0; i < W * H; i++) if (sk.road[i]) map.setTerrain(i % W, (i / W) | 0, 'road');
  fp.buildings.forEach((b, i) => { map.maxStories = Math.max(map.maxStories, stampStructure(map, b, i)); });
  const en = stampEnclosures(map, sk, land, fp);
  const t = { hedge: 0, woods: 0, field: 0, road: 0 };
  for (let i = 0; i < W * H; i++) { const k = map.terrainKeyAt(i % W, (i / W) | 0); if (t[k] !== undefined) t[k]++; }
  counts.push(fp.buildings.length);
  console.log(`seed ${s} bld=${fp.buildings.length} farms=${ru.farms.length} lanes=${ru.lanes} gaps=${ru.gaps} stands=${stands.length} hedge=${t.hedge} woods=${t.woods} field=${t.field} road=${t.road} orphans=${en.orphans} span=${en.rearSpanQ8}`);
}
console.log('bld min', Math.min(...counts), 'max', Math.max(...counts), 'total ms', Date.now() - t0);
