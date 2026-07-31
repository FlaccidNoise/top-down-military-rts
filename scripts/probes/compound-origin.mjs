// What produced the buildingless compound at seed 5 yard@140,54?
import { buildFootprints } from '../../src/sim/bourg/footprints';
import { reserveLandmarks } from '../../src/sim/bourg/landmarks';
import { buildParcels } from '../../src/sim/bourg/parcels';
import { BOURG } from '../../src/sim/bourg/profile';
import { addRuralFabric } from '../../src/sim/bourg/rural';
import { buildSkeleton, growMinorStreets } from '../../src/sim/bourg/streets';

const base = (seed) => (seed * 0x9e3779b1) >>> 1;
const W = 320, H = 240;
const sk = buildSkeleton(base(5), W, H, BOURG, new Uint8Array(W * H));
const land = reserveLandmarks(sk);
growMinorStreets(sk, { resv: land.resv, blocked: land.resv });
const pc = buildParcels(sk, land.resv);
const fpBefore = buildFootprints(sk, land, pc);
console.log('compounds BEFORE rural:');
fpBefore.compounds.forEach((c, i) => console.log(' ', i, JSON.stringify(c.rect), 'open=' + c.open));
console.log('env', JSON.stringify(sk.env), 'faubourg', JSON.stringify(sk.faubourg));
const ru = addRuralFabric(sk, land, pc, fpBefore);
console.log('compounds AFTER rural (appended):');
fpBefore.compounds.forEach((c, i) => console.log(' ', i, JSON.stringify(c.rect), 'open=' + c.open));

// buildings near 140,54
console.log('\nbuildings within 12 of (143,58):');
for (const b of fpBefore.buildings) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (Math.max(Math.abs(cx - 143), Math.abs(cy - 58)) <= 14)
    console.log(' ', JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h, role: b.role, doors: b.doors }));
}
