// Region probe: hedge components in a box, road seed 11.
import { mulberry32 } from '../../src/sim/rng';
import { planBourg, stampBourg } from '../../src/sim/bourg/plan';
import { ROAD } from '../../src/sim/bourg/profile';
import { GameMap } from '../../src/sim/map';
import { TERRAIN } from '../../src/sim/data';

const W = 320, H = 240;
const HEDGE = Object.keys(TERRAIN).indexOf('hedge');
const base = mulberry32((11 ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
const plan = planBourg(base, W, H, ROAD, new Uint8Array(W * H));
const map = new GameMap(W, H);
stampBourg(map, plan);
const tiles = map.tiles;

const seen = new Uint8Array(W * H);
const q = new Int32Array(W * H);
for (let i = 0; i < W * H; i++) {
  if (tiles[i] !== HEDGE || seen[i]) continue;
  let head = 0, toe = 0;
  seen[i] = 1; q[toe++] = i;
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  while (head < toe) {
    const c = q[head++];
    const cx = c % W, cy = (c / W) | 0;
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
    y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!seen[ni] && tiles[ni] === HEDGE) { seen[ni] = 1; q[toe++] = ni; }
      }
  }
  // report components intersecting x 180-220, y 120-150
  if (x1 >= 180 && x0 <= 220 && y1 >= 120 && y0 <= 150)
    console.log(`comp len=${toe} bbox x${x0}-${x1} y${y0}-${y1}`);
}
