import { buildSkeleton, growMinorStreets } from '../src/sim/bourg/streets';
import { reserveLandmarks } from '../src/sim/bourg/landmarks';
import { buildParcels } from '../src/sim/bourg/parcels';
import { buildFootprints } from '../src/sim/bourg/footprints';
import { stampEnclosures } from '../src/sim/bourg/enclosures';
import { stampStructure } from '../src/sim/bourg/stamp';
import { GameMap } from '../src/sim/map';
const base = (s) => (s * 0x9e3779b1) >>> 1;
const W = 320, H = 240;
let t0 = Date.now();
for (let s = 1; s <= 20; s++) {
  const sk = buildSkeleton(base(s), W, H);
  const land = reserveLandmarks(sk);
  growMinorStreets(sk, { resv: land.resv });
  const pc = buildParcels(sk, land.resv);
  const fp = buildFootprints(sk, land, pc);
  const map = new GameMap(W, H);
  for (let i = 0; i < W * H; i++) if (sk.road[i]) map.setTerrain(i % W, (i / W) | 0, 'road');
  fp.buildings.forEach((b, i) => stampStructure(map, b, i));
  const en = stampEnclosures(map, sk, land, fp);
  console.log(`seed ${s} gardens=${fp.gardens.length} yards=${fp.compounds.length} venelles=${fp.venelles.length} walls=${en.walls} gates=${en.gates} orphans=${en.orphans} span=${en.rearSpanQ8} conn=${en.rearConnected} reroll=${en.rerolled}`);
}
console.log('total ms', Date.now() - t0);
