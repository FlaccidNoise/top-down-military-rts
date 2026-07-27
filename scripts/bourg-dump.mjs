// ASCII dump of the bourg street/landmark/parcel pipeline (T4-T6), before any
// GameMap exists. Run with:
//   npx vite-node scripts/bourg-dump.mjs -- --seed 1 --w 320 --h 240 [--zoom]
// Legend: '.' open  '#' road  'C' churchyard  'M' market island  'V' civic
//         'l' back lane  'p' plot (frontage)  'i' interior parcel  '+' place
import { buildSkeleton, growMinorStreets } from '../src/sim/bourg/streets';
import { reserveLandmarks, RESV } from '../src/sim/bourg/landmarks';
import { buildParcels, plotRect } from '../src/sim/bourg/parcels';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const seed = arg('seed', 1);
const W = arg('w', 320);
const H = arg('h', 240);

const base = (seed * 0x9e3779b1) >>> 1;
const sk = buildSkeleton(base, W, H);
const land = reserveLandmarks(sk);
growMinorStreets(sk, { resv: land.resv });
const pc = buildParcels(sk, land.resv);

const grid = new Array(W * H).fill('.');
for (let i = 0; i < W * H; i++) {
  if (land.resv[i] === RESV.CHURCHYARD) grid[i] = 'C';
  else if (land.resv[i] === RESV.MARKET) grid[i] = 'M';
  else if (land.resv[i] === RESV.CIVIC) grid[i] = 'V';
}
for (let i = 0; i < W * H; i++) if (pc.lane[i]) grid[i] = 'l';
for (const p of pc.plots) {
  const r = plotRect(p);
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === '.') grid[y * W + x] = 'p';
}
for (const it of pc.interiors) {
  const r = it.rect;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === '.') grid[y * W + x] = 'i';
}
for (let i = 0; i < W * H; i++) if (sk.road[i]) grid[i] = '#';
grid[sk.place.y * W + sk.place.x] = '+';

const e = sk.env;
const x0 = has('zoom') ? Math.max(0, e.x - 6) : 0;
const x1 = has('zoom') ? Math.min(W, e.x + e.w + 6) : W;
const y0 = has('zoom') ? Math.max(0, e.y - 6) : 0;
const y1 = has('zoom') ? Math.min(H, e.y + e.h + 6) : H;
const lines = [];
for (let y = y0; y < y1; y++) lines.push(grid.slice(y * W + x0, y * W + x1).join(''));

console.log(lines.join('\n'));
console.log(
  `seed ${seed} ${W}x${H} archetype=${sk.archetype} env=${e.x},${e.y} ${e.w}x${e.h} place=${sk.place.x},${sk.place.y}` +
    ` streets=${sk.streets.length} segs=${sk.segs.length}` +
    ` churchyard=${land.churchyard ? `${land.churchyard.x},${land.churchyard.y} ${land.churchyard.w}x${land.churchyard.h}` : 'none'}` +
    ` place=${land.place.w}x${land.place.h} market=${land.market ? 'yes' : 'no'} civic=${land.forecourt ? 'yes' : 'no'}` +
    ` blocks=${pc.blocks.length} lanes=${pc.laneCount} runs=${pc.runs.length} plots=${pc.plots.length} interiors=${pc.interiors.length}`,
);
