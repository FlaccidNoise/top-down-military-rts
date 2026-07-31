// Detect geometric overlaps between enclosure wall runs and yard wall/fence runs.
// npx vite-node scripts/wall-overlap-probe.mjs [--seeds 10]
import { generateMap } from '../src/sim/mapgen';
import { buildYards } from '../src/render/yards';
import { PatchIndex } from '../src/render/patches';
import { EnclosureIndex } from '../src/render/enclos';

const N = Number(process.argv[process.argv.indexOf('--seeds') + 1] || 10);
const KINDS = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'];

function segOverlap(a, b) {
  // returns overlap length if collinear & overlapping, or 'X' if properly crossing
  const [ax, ay, bx, by] = a, [cx, cy, dx, dy] = b;
  const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) > 1e-9) {
    // proper intersection test
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross;
    if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) return 'X';
    return 0;
  }
  // parallel: collinear?
  if (Math.abs((cx - ax) * d1y - (cy - ay) * d1x) > 1e-6) return 0;
  const len2 = d1x * d1x + d1y * d1y;
  if (len2 < 1e-12) return 0;
  const t0 = ((cx - ax) * d1x + (cy - ay) * d1y) / len2;
  const t1 = ((dx - ax) * d1x + (dy - ay) * d1y) / len2;
  const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
  return hi > lo + 1e-6 ? (hi - lo) * Math.sqrt(len2) : 0;
}

let grand = 0;
for (const kind of KINDS) {
  for (let seed = 1; seed <= N; seed++) {
    const plan = generateMap(seed, 320, 240, kind, { interiors: true });
    const { map } = plan;
    const patches = new PatchIndex(map);
    const enc = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
    const encKind = (wx, wy) => {
      const id = enc.enclosureIdAt(Math.floor(wx), Math.floor(wy));
      return id >= 0 ? enc.enclosures[id].kind : null;
    };
    const yards = buildYards(map, patches, encKind, enc.runs.map((r) => [r.ax, r.ay, r.bx, r.by]));
    const encSegs = enc.runs.map((r) => [r.ax, r.ay, r.bx, r.by]);
    const hits = [];
    for (const yd of yards) {
      for (const yr of yd.runs) {
        for (const es of encSegs) {
          const o = segOverlap(yr, es);
          if (o) hits.push({ yard: yd.b.id, yr, es, o });
        }
        for (const yd2 of yards) {
          if (yd2.b.id <= yd.b.id) continue;
          for (const yr2 of yd2.runs) {
            const o = segOverlap(yr, yr2);
            if (o) hits.push({ yard: yd.b.id, other: yd2.b.id, yr, yr2, o });
          }
        }
      }
    }
    if (hits.length) {
      grand += hits.length;
      console.log(`${kind} seed ${seed}: ${hits.length} overlaps`);
      for (const h of hits.slice(0, 4)) console.log('  ', JSON.stringify(h));
    }
  }
}
console.log(grand === 0 ? 'CLEAN: no overlaps' : `TOTAL ${grand} overlaps`);
