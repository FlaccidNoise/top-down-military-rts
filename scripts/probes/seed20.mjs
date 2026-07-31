// Seed 20: dump the two stranded farmhouses' compounds
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
const sk = buildSkeleton(base(20), W, H, BOURG, new Uint8Array(W * H));
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

for (const [dx, dy] of [[49, 148], [292, 144]]) {
  console.log(`\n=== stranded door at ${dx},${dy} ===`);
  const b = fp.buildings.find((b) => b.x <= dx && b.x + b.w > dx && b.y <= dy && b.y + b.h > dy);
  console.log('building:', JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h, role: b.role, parts: b.parts, doors: b.doors }));
  const c = fp.compounds.find((c) => dx >= c.rect.x - 12 && dx <= c.rect.x + c.rect.w + 12 && dy >= c.rect.y - 12 && dy <= c.rect.y + c.rect.h + 12);
  if (c) {
    console.log('compound:', JSON.stringify(c.rect), 'open=' + c.open, 'predicted gate:', JSON.stringify(gateOutsideTile(c, fp, W, H)));
    const r = c.rect;
    for (const b2 of fp.buildings) {
      if (b2.x > r.x + r.w + 2 || b2.x + b2.w < r.x - 2 || b2.y > r.y + r.h + 2 || b2.y + b.h < r.y - 2) continue;
      console.log('  mass:', JSON.stringify({ x: b2.x, y: b2.y, w: b2.w, h: b2.h, role: b2.role, parts: b2.parts, doors: b2.doors }));
    }
    // ASCII: terrain + edges
    for (let y = r.y - 3; y < r.y + r.h + 3; y++) {
      let row = '';
      for (let x = r.x - 3; x < r.x + r.w + 3; x++) {
        const i = y * W + x;
        let ch = sk.road[i] ? '.' : fp.occ[i] ? '#' : map.terrainKeyAt(x, y) === 'hedge' ? 'H' : ' ';
        // overlay edge walls
        if (map.hEdge(x, y) === EDGE.WALL || map.vEdge(x, y) === EDGE.WALL) ch = ch === '#' ? '#' : '+';
        if (map.hEdge(x, y) === EDGE.DOOR || map.vEdge(x, y) === EDGE.DOOR) ch = 'D';
        row += ch;
      }
      console.log('  ' + String(y).padStart(3) + ' ' + row);
    }
  }
}
