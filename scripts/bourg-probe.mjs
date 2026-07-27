// Every §5.2/§5.3 quantity, measured through generateMap (NOT through
// planBourg with a synthetic base — the survey script's seeds are a different
// mapping and its numbers do not transfer). Run before touching the
// assertions in tests/bourg.test.ts:
//   npx vite-node scripts/bourg-probe.mjs -- [--seeds 20] [--w 320] [--h 240]
import { generateMap } from '../src/sim/mapgen';
import { EDGE } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { partsOf } from '../src/sim/bourg/stamp';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const N = arg('seeds', 20);
const W = arg('w', 320);
const H = arg('h', 240);

const rows = [];
for (let seed = 1; seed <= N; seed++) {
  const p = generateMap(seed, W, H, 'bourg');
  const { map, buildings, objectives, objectiveKinds, woodsStands, spawns } = p;

  const chains = new Map();
  for (const b of buildings) if (b.terraceRun !== undefined && b.terraceRun >= 0) chains.set(b.terraceRun, (chains.get(b.terraceRun) ?? 0) + 1);
  const terrace = Math.max(0, ...chains.values());

  const towers = buildings.filter((b) => b.role === 'church_tower');
  const towerStories = towers.map((b) => map.storiesAt(Math.floor(b.x + b.w / 2), Math.floor(b.y + b.h / 2)));

  // longest straight 3-wide road band, whole map
  const isRoad = (x, y) => x >= 0 && y >= 0 && x < W && y < H && map.terrainKeyAt(x, y) === 'road';
  let run3 = 0;
  for (let y = 1; y < H - 1; y++) {
    let run = 0;
    for (let x = 0; x < W; x++) {
      run = isRoad(x, y - 1) && isRoad(x, y) && isRoad(x, y + 1) ? run + 1 : 0;
      if (run > run3) run3 = run;
    }
  }
  for (let x = 1; x < W - 1; x++) {
    let run = 0;
    for (let y = 0; y < H; y++) {
      run = isRoad(x - 1, y) && isRoad(x, y) && isRoad(x + 1, y) ? run + 1 : 0;
      if (run > run3) run3 = run;
    }
  }

  // garrison coverage
  let worstCover = 0;
  for (const b of buildings) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    let near = Infinity;
    for (const o of objectives) near = Math.min(near, Math.hypot(cx - o.x, cy - o.y));
    worstCover = Math.max(worstCover, near);
  }

  // free-standing walls and their gates
  let lowWalls = 0;
  let highWalls = 0;
  let freeGates = 0;
  let badGate = 0;
  const freeRun = (a, b) => a === EDGE.WALL && (b === 1 || b === 2);
  for (let y = 0; y <= H; y++)
    for (let x = 0; x < W; x++) {
      const e = map.hEdge(x, y);
      const t = map.hEdgeTops[y * W + x];
      if (freeRun(e, t)) (t === 1 ? lowWalls++ : highWalls++);
      if (e === EDGE.DOOR && y > 0 && y < H && map.buildingIdAt(x, y - 1) < 0 && map.buildingIdAt(x, y) < 0) {
        freeGates++;
        if (!map.canStep(x, y - 1, x, y, 'foot') || map.canStep(x, y - 1, x, y, 'vehicle')) badGate++;
      }
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x <= W; x++) {
      const e = map.vEdge(x, y);
      const t = map.vEdgeTops[y * (W + 1) + x];
      if (freeRun(e, t)) (t === 1 ? lowWalls++ : highWalls++);
      if (e === EDGE.DOOR && x > 0 && x < W && map.buildingIdAt(x - 1, y) < 0 && map.buildingIdAt(x, y) < 0) {
        freeGates++;
        if (!map.canStep(x - 1, y, x, y, 'foot') || map.canStep(x - 1, y, x, y, 'vehicle')) badGate++;
      }
    }

  // parts invariants
  let partsBad = 0;
  let overlapBad = 0;
  for (const b of buildings) {
    const ps = partsOf(b);
    if (ps[0].x !== b.x || ps[0].y !== b.y || ps[0].w !== b.w || ps[0].h !== b.h) partsBad++;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const c = ps[j];
        if (a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) overlapBad++;
      }
  }

  // party walls: WINDOW between two different buildingIds
  let windowParty = 0;
  let groupSeam = 0;
  for (let y = 1; y < H; y++)
    for (let x = 0; x < W; x++) {
      const a = map.buildingIdAt(x, y - 1);
      const b = map.buildingIdAt(x, y);
      if (a < 0 || b < 0) continue;
      const e = map.hEdge(x, y);
      if (a !== b && e === EDGE.WINDOW) windowParty++;
      if (a === b && e !== EDGE.NONE && e !== EDGE.DOOR) groupSeam++;
    }
  for (let y = 0; y < H; y++)
    for (let x = 1; x < W; x++) {
      const a = map.buildingIdAt(x - 1, y);
      const b = map.buildingIdAt(x, y);
      if (a < 0 || b < 0) continue;
      const e = map.vEdge(x, y);
      if (a !== b && e === EDGE.WINDOW) windowParty++;
      if (a === b && e !== EDGE.NONE && e !== EDGE.DOOR) groupSeam++;
    }

  // tower clearance
  let towerOk = 'n/a';
  if (towers.length) {
    const t = towers[0];
    let stair = null;
    for (const r of partsOf(t))
      for (let y = r.y; y < r.y + r.h && !stair; y++) for (let x = r.x; x < r.x + r.w; x++) if (map.isStair(x, y)) { stair = { x, y }; break; }
    if (!stair) towerOk = 'NO-STAIR';
    else {
      const up = astar(map, spawns.west.x, spawns.west.y, stair.x, stair.y, 'foot', 0, 0);
      const top = astar(map, stair.x, stair.y, stair.x, stair.y, 'foot', 0, 3);
      towerOk = `${up ? 'reach' : 'UNREACHABLE'}/${top ? 'l3' : 'NO-L3'}`;
    }
  }

  let standsBad = 0;
  for (const s of woodsStands) if (!map.terrainAt(s.x, s.y).passable) standsBad++;

  rows.push({
    seed,
    bld: buildings.length,
    terrace,
    obj: objectives.length,
    kind0: objectiveKinds?.[0],
    kind1: objectiveKinds?.[1],
    o0terrain: map.terrainKeyAt(objectives[0].x, objectives[0].y),
    towers: towers.length,
    towerStories: towerStories.join('/'),
    maxStories: map.maxStories,
    run3,
    cover: Math.round(worstCover * 10) / 10,
    lowWalls,
    highWalls,
    freeGates,
    badGate,
    partsBad,
    overlapBad,
    windowParty,
    groupSeam,
    towerOk,
    standsBad,
    stands: woodsStands.length,
  });
  console.log(Object.entries(rows[rows.length - 1]).map(([k, v]) => `${k}=${v}`).join(' '));
}
console.log('---');
for (const k of Object.keys(rows[0])) {
  const v = rows.map((r) => r[k]);
  if (typeof v[0] === 'number') {
    const s = [...v].sort((a, b) => a - b);
    console.log(`${k.padEnd(13)} min=${s[0]} med=${s[s.length >> 1]} max=${s[s.length - 1]}`);
  } else {
    console.log(`${k.padEnd(13)} ${[...new Set(v)].join(',')}`);
  }
}
