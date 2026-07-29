import { buildSkeleton, growMinorStreets } from '../src/sim/bourg/streets';
import { reserveLandmarks, RESV } from '../src/sim/bourg/landmarks';
import { buildParcels, plotRect } from '../src/sim/bourg/parcels';
import { buildFootprints } from '../src/sim/bourg/footprints';
import { addRuralFabric } from '../src/sim/bourg/rural';
import { BOURG } from '../src/sim/bourg/profile';

const seed = 2;
const W = 320, H = 240;
const base = (seed * 0x9e3779b1) >>> 1;
const sk = buildSkeleton(base, W, H, BOURG);
const land = reserveLandmarks(sk);
growMinorStreets(sk, { resv: land.resv });
const pc = buildParcels(sk, land.resv);
const fp = buildFootprints(sk, land, pc);
const rural = addRuralFabric(sk, land, pc, fp);

for (const g of fp.gardens) {
  const gr = g.rect;
  for (const b of fp.buildings) {
    const parts = b.parts || [b];
    for (const r of parts) {
      if (r.x < gr.x + gr.w && r.x + r.w > gr.x && r.y < gr.y + gr.h && r.y + r.h > gr.y) {
        const trulyOverlap = r.x + 1 <= gr.x + gr.w && r.x + r.w - 1 > gr.x && r.y + 1 <= gr.y + gr.h && r.y + r.h - 1 > gr.y;
        if (trulyOverlap) {
          console.log('TRUE OVERLAP:');
          console.log('  Garden:', JSON.stringify(gr));
          console.log('  Building role:', b.role, 'x:', b.x, 'y:', b.y, 'w:', b.w, 'h:', b.h);
          console.log('  Overlapping part:', JSON.stringify(r));
          if (b.parts) console.log('  All parts:', JSON.stringify(b.parts));
          const p = pc.plots[g.plotIndex];
          if (p) console.log('  Plot:', JSON.stringify({fx:p.fx,fy:p.fy,w:p.w,d:p.d,axis:p.axis,side:p.side,setback:p.setback}));
        }
      }
    }
  }
}
console.log('Done.');
