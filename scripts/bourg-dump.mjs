// ASCII dump of the bourg pipeline. Run with:
//   npx vite-node scripts/bourg-dump.mjs -- --seed 1 --w 320 --h 240 [--zoom] [--built]
// Parcel view (default) — '.' open  '#' road  'C' churchyard  'M' market island
//         'V' civic  'l' back lane  'p' plot (frontage)  'i' interior parcel  '+' place
// Built view (--built) — 'B' building mass  'g' garden tail  'y' walled yard
//         'v' venelle  'O' objective
import { buildSkeleton, growMinorStreets } from '../src/sim/bourg/streets';
import { reserveLandmarks, RESV } from '../src/sim/bourg/landmarks';
import { buildParcels, plotRect } from '../src/sim/bourg/parcels';
import { buildFootprints } from '../src/sim/bourg/footprints';
import { addRuralFabric } from '../src/sim/bourg/rural';
import { BOURG } from '../src/sim/bourg/profile';
import { buildObjectives } from '../src/sim/bourg/objectives';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const seed = arg('seed', 1);
const W = arg('w', 320);
const H = arg('h', 240);

const base = (seed * 0x9e3779b1) >>> 1;
const sk = buildSkeleton(base, W, H, BOURG);
const land = reserveLandmarks(sk);
growMinorStreets(sk, { resv: land.resv });
const pc = buildParcels(sk, land.resv);
const built = has('built');
const fp = built ? buildFootprints(sk, land, pc) : null;
const rural = built ? addRuralFabric(sk, land, pc, fp) : null;
const objectives = built ? buildObjectives(sk, land, fp, [sk.place]).objectives : [];

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
if (fp) {
  for (const g of fp.gardens) fill(g.rect, 'g');
  for (const c of fp.compounds) fill(c.rect, 'y');
  for (const v of fp.venelles) fill(v.rect, 'v');
  for (let i = 0; i < W * H; i++) if (rural.hedge[i]) grid[i] = ',';
}
for (let i = 0; i < W * H; i++) if (sk.road[i]) grid[i] = '#';
if (fp) for (const b of fp.buildings) for (const p of b.parts ?? [b]) fill(p, 'B', true);
grid[sk.place.y * W + sk.place.x] = '+';
for (const o of objectives) grid[o.y * W + o.x] = 'O';

function fill(r, ch, force) {
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      if (x >= 0 && y >= 0 && x < W && y < H && (force || grid[y * W + x] === '.' || grid[y * W + x] === 'p' || grid[y * W + x] === 'i'))
        grid[y * W + x] = ch;
}

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
    ` blocks=${pc.blocks.length} lanes=${pc.laneCount} runs=${pc.runs.length} plots=${pc.plots.length} interiors=${pc.interiors.length}` +
    (fp
      ? ` buildings=${fp.buildings.length} gardens=${fp.gardens.length} yards=${fp.compounds.length}` +
        ` venelles=${fp.venelles.length} farms=${rural.farms.length} farmLane=${rural.lanes} objectives=${objectives.length}`
      : ''),
);
