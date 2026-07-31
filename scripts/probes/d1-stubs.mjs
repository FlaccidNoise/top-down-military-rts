// D1 stub categorizer — at STAMPED-TERRAIN level, flood 8-connected hedge
// components and classify each: size, and whether it touches a protected
// feature (road / claimed parcel / building-dilated-1 / water / town zone).
// Answers: how many ISOLATED stubs (<8 tiles, unprotected) exist per map,
// and which protection class the rest fall into.
//
//   npx vite-node scripts/probes/d1-stubs.mjs
import { mulberry32 } from '../../src/sim/rng';
import { planBourg, stampBourg } from '../../src/sim/bourg/plan';
import { PROFILES } from '../../src/sim/bourg/profile';
import { zoneOf } from '../../src/sim/bourg/rural';
import { GameMap } from '../../src/sim/map';
import { TERRAIN } from '../../src/sim/data';

const KINDS = ['open', 'road', 'woods', 'river', 'bridge', 'bourg'];
const W = 320;
const H = 240;
const HEDGE = Object.keys(TERRAIN).indexOf('hedge');

const totals = {};
for (const kind of KINDS) {
  const agg = { comps: 0, small: 0, isolated: 0, prot: { road: 0, claimed: 0, bldg: 0, water: 0, zone: 0 } };
  for (let seed = 1; seed <= 13; seed++) {
    const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
    const plan = planBourg(base, W, H, PROFILES[kind], new Uint8Array(W * H));
    const map = new GameMap(W, H);
    stampBourg(map, plan);
    const { sk, pc, fp } = plan;
    const inZone = zoneOf(sk);
    const tiles = map.tiles;

    const nearBldg = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (!fp.occ[i]) continue;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) nearBldg[ny * W + nx] = 1;
        }
    }

    const seen = new Uint8Array(W * H);
    const q = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (tiles[i] !== HEDGE || seen[i]) continue;
      let head = 0, toe = 0;
      seen[i] = 1;
      q[toe++] = i;
      let tRoad = false, tClaimed = false, tBldg = false, tWater = false, tZone = false;
      while (head < toe) {
        const cur = q[head++];
        const cx = cur % W, cy = (cur / W) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = ny * W + nx;
            if (sk.road[ni]) tRoad = true;
            if (pc.claimed[ni]) tClaimed = true;
            if (nearBldg[ni]) tBldg = true;
            if (sk.water[ni]) tWater = true;
            if (inZone(nx, ny)) tZone = true;
            if (!seen[ni] && tiles[ni] === HEDGE) { seen[ni] = 1; q[toe++] = ni; }
          }
      }
      agg.comps++;
      if (toe < 8) {
        agg.small++;
        const prot = tBldg || tWater; // mirror cleanHedgeStubs: only building + water protect
        if (!prot) agg.isolated++;
        else {
          if (tRoad) agg.prot.road++;
          if (tClaimed) agg.prot.claimed++;
          if (tBldg) agg.prot.bldg++;
          if (tWater) agg.prot.water++;
          if (tZone) agg.prot.zone++;
        }
      }
    }
  }
  totals[kind] = agg;
  console.log(
    `${kind.padEnd(7)} comps=${String(agg.comps).padStart(5)}  <8=${String(agg.small).padStart(4)}  isolated=${String(agg.isolated).padStart(4)}  ` +
    `protected: road=${agg.prot.road} claimed=${agg.prot.claimed} bldg=${agg.prot.bldg} water=${agg.prot.water} zone=${agg.prot.zone}`,
  );
}
