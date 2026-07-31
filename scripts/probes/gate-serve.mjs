// Why is seed 5's compound at 140,54 not gate-served?
import { buildFootprints } from '../../src/sim/bourg/footprints';
import { reserveLandmarks } from '../../src/sim/bourg/landmarks';
import { buildParcels } from '../../src/sim/bourg/parcels';
import { BOURG } from '../../src/sim/bourg/profile';
import { addRuralFabric, gateOutsideTile } from '../../src/sim/bourg/rural';
import { buildSkeleton, growMinorStreets } from '../../src/sim/bourg/streets';

const base = (seed) => (seed * 0x9e3779b1) >>> 1;
const W = 320, H = 240;
const sk = buildSkeleton(base(5), W, H, BOURG, new Uint8Array(W * H));
const land = reserveLandmarks(sk);
growMinorStreets(sk, { resv: land.resv, blocked: land.resv });
const pc = buildParcels(sk, land.resv);
const fp = buildFootprints(sk, land, pc);
addRuralFabric(sk, land, pc, fp);

for (const c of fp.compounds) {
  const cx = c.rect.x + (c.rect.w >> 1);
  const cy = c.rect.y + (c.rect.h >> 1);
  const inZ = (x, y) =>
    (x >= sk.env.x - 6 && x <= sk.env.x + sk.env.w + 5 && y >= sk.env.y - 6 && y <= sk.env.y + sk.env.h + 5) ||
    (sk.faubourg !== null && Math.abs(x - sk.faubourg.x) <= 22 && Math.abs(y - sk.faubourg.y) <= 22);
  if (inZ(cx, cy)) continue;
  const g = gateOutsideTile(c, fp, W, H);
  const served = g && (sk.road[g.y * W + g.x] ||
    [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => sk.road[(g.y+dy) * W + (g.x+dx)]));
  console.log(`yard@${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h} open=${c.rect ? '' : ''}${''} gate=${JSON.stringify(g)} served=${served}`);
  if (!served && g) {
    // dump the area: R=road #=bldg C=compound-claim G=gate
    for (let y = g.y - 12; y <= g.y + 12; y++) {
      let row = '';
      for (let x = g.x - 20; x <= g.x + 20; x++) {
        if (x === g.x && y === g.y) { row += 'G'; continue; }
        const i = y * W + x;
        row += sk.road[i] ? 'R' : fp.occ[i] ? '#' : pc.claimed[i] ? 'C' : sk.water[i] ? '~' : '.';
      }
      console.log(String(y).padStart(3) + ' ' + row);
    }
    // nearest road distance
    let best = Infinity;
    for (let i = 0; i < W * H; i++) if (sk.road[i]) {
      const d = Math.max(Math.abs((i % W) - g.x), Math.abs(((i / W) | 0) - g.y));
      if (d < best) best = d;
    }
    console.log('nearest road Chebyshev:', best);
  }
}
