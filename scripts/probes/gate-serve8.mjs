// Seed 8 yard@82,185: why unserved? And which seed has orphans=2?
import { buildFootprints } from '../../src/sim/bourg/footprints';
import { reserveLandmarks } from '../../src/sim/bourg/landmarks';
import { buildParcels } from '../../src/sim/bourg/parcels';
import { BOURG } from '../../src/sim/bourg/profile';
import { addRuralFabric, gateOutsideTile } from '../../src/sim/bourg/rural';
import { buildSkeleton, growMinorStreets } from '../../src/sim/bourg/streets';
import { stampEnclosures } from '../../src/sim/bourg/enclosures';
import { stampStructure } from '../../src/sim/bourg/stamp';
import { paintRural } from '../../src/sim/bourg/rural';
import { GameMap } from '../../src/sim/map';

const base = (seed) => (seed * 0x9e3779b1) >>> 1;
const W = 320, H = 240;
const inZ = (sk, x, y) =>
  (x >= sk.env.x - 6 && x <= sk.env.x + sk.env.w + 5 && y >= sk.env.y - 6 && y <= sk.env.y + sk.env.h + 5) ||
  (sk.faubourg !== null && Math.abs(x - sk.faubourg.x) <= 22 && Math.abs(y - sk.faubourg.y) <= 22);

for (const seed of [8]) {
  const sk = buildSkeleton(base(seed), W, H, BOURG, new Uint8Array(W * H));
  const land = reserveLandmarks(sk);
  growMinorStreets(sk, { resv: land.resv, blocked: land.resv });
  const pc = buildParcels(sk, land.resv);
  const fp = buildFootprints(sk, land, pc);
  const ru = addRuralFabric(sk, land, pc, fp);
  const map = new GameMap(W, H);
  paintRural(map, sk, land, pc, fp, ru);
  for (let i = 0; i < W * H; i++) if (sk.road[i]) map.setTerrain(i % W, (i / W) | 0, 'road');
  fp.buildings.forEach((b, i) => stampStructure(map, b, i));
  const en = stampEnclosures(map, sk, land, fp);
  console.log(`seed ${seed}: orphans=${en.orphans}`);

  for (const c of fp.compounds) {
    const r = c.rect;
    if (inZ(sk, r.x + (r.w >> 1), r.y + (r.h >> 1))) continue;
    const g = gateOutsideTile(c, fp, W, H);
    const served = g && (sk.road[g.y * W + g.x] ||
      [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => g.x+dx >= 0 && g.y+dy >= 0 && g.x+dx < W && g.y+dy < H && sk.road[(g.y+dy) * W + (g.x+dx)]));
    if (served) continue;
    let nearest = Infinity, ni = -1;
    for (let i = 0; i < W * H; i++) if (sk.road[i]) {
      const d = Math.max(Math.abs((i % W) - g.x), Math.abs(((i / W) | 0) - g.y));
      if (d < nearest) { nearest = d; ni = i; }
    }
    console.log(`  yard@${r.x},${r.y} ${r.w}x${r.h} open=${c.open} gate=${JSON.stringify(g)} nearest=${nearest} at ${ni % W},${(ni / W) | 0}`);
    // why did carve fail? trace both legs to the nearest road tile
    const tx = ni % W, ty = (ni / W) | 0;
    const legal = (x, y) => {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return 'bounds';
      if (fp.occ[y * W + x]) return 'occ';
      if (sk.water[y * W + x]) return 'water';
      if (inZ(sk, x, y)) return 'zone';
      for (const c2 of fp.compounds) if (x >= c2.rect.x && x < c2.rect.x + c2.rect.w && y >= c2.rect.y && y < c2.rect.y + c2.rect.h) return 'compound';
      return null;
    };
    for (const hf of [true, false]) {
      let px = g.x, py = g.y, fail = null;
      const step = (x, y) => { const r2 = legal(x, y); if (r2 && !(x === tx && y === ty)) fail = `${r2}@${x},${y}`; return !fail; };
      if (!step(px, py)) {} else if (hf) {
        while (px !== tx && !fail) { px += Math.sign(tx - px); step(px, py); }
        while (py !== ty && !fail) { py += Math.sign(ty - py); step(px, py); }
      } else {
        while (py !== ty && !fail) { py += Math.sign(ty - py); step(px, py); }
        while (px !== tx && !fail) { px += Math.sign(tx - px); step(px, py); }
      }
      console.log(`    hFirst=${hf} → ${fail ?? 'OK'}`);
    }
    // dump surroundings
    for (let y = g.y - 14; y <= g.y + 14; y++) {
      let row = '';
      for (let x = g.x - 24; x <= g.x + 24; x++) {
        if (x === g.x && y === g.y) { row += 'G'; continue; }
        const i = y * W + x;
        row += sk.road[i] ? 'R' : fp.occ[i] ? '#' : sk.water[i] ? '~' : inZ(sk, x, y) ? 'Z' : pc.claimed[i] ? 'C' : '.';
      }
      console.log('    ' + String(y).padStart(3) + ' ' + row);
    }
  }
}
