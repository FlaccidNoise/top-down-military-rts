// T1 gate: the flood-fill validate() must return exactly the verdict the
// 36-A*-call version returned, for every legacy kind at every size.
//
//   npx vite-node scripts/validate-parity.mjs [--seeds 60] [--kinds open,town,...]
//
// Two halves, because generateMap only ever hands back ACCEPTED plans and the
// reroll path is dormant in the field (1080 maps instrumented, attempt 0 won
// every time):
//   1. positive parity — 60 seeds x 6 kinds x 3 sizes, both gates agree (true)
//   2. negative parity — each accepted plan is then deliberately broken four
//      ways (moat the west spawn, seal a building, hedge a vehicle wall across
//      the map, drown an objective) and both gates must still agree, which is
//      the half that actually exercises `false`.
import { EDGE } from '../src/sim/map';
import { generateMap, validate } from '../src/sim/mapgen';
import { astar } from '../src/sim/path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const SEEDS = Number(arg('seeds', '60'));
const KINDS = arg('kinds', 'open,woods,town,river,bridge,road').split(',');
const SIZES = [
  [60, 40],
  [160, 120],
  [320, 240],
];

// The pre-T1 gate, verbatim (mapgen.ts@9c1ec62:371-380). Kept only here: this
// script is the sole reason the A* formulation still exists anywhere.
function validateAStar(plan) {
  const { map, buildings, spawns, objectives } = plan;
  const foot = (a, b) => astar(map, a.x, a.y, b.x, b.y) !== null;
  for (const o of objectives) if (!foot(spawns.west, o) || !foot(spawns.east, o)) return false;
  for (const b of buildings) if (!foot(spawns.west, { x: b.x + (b.w >> 1), y: b.y + (b.h >> 1) })) return false;
  for (let i = 0; i < map.stairs.length; i++)
    if (map.stairs[i] === 1 && map.stories[i] === 2 && !foot(spawns.west, { x: i % map.w, y: (i / map.w) | 0 })) return false;
  return astar(map, spawns.west.x, spawns.west.y, spawns.east.x, spawns.east.y, 'vehicle') !== null;
}

// Perturbations: each takes an accepted plan and breaks it in place.
const BREAKS = {
  // ring of water two tiles out from the west spawn: nothing is foot- or
  // vehicle-reachable any more, so every question flips at once
  moat(plan) {
    const { map, spawns } = plan;
    for (let d = 2; d <= 3; d++)
      for (let k = -d; k <= d; k++)
        for (const [x, y] of [
          [spawns.west.x + k, spawns.west.y - d],
          [spawns.west.x + k, spawns.west.y + d],
          [spawns.west.x - d, spawns.west.y + k],
          [spawns.west.x + d, spawns.west.y + k],
        ])
          if (map.inBounds(x, y)) map.setTerrain(x, y, 'water');
  },
  // seal building 0: its door becomes WALL, so its interior (and its stair, if
  // 2-story) is an isolated component while the rest of the map is untouched
  sealBuilding(plan) {
    const { map, buildings } = plan;
    const b = buildings[0];
    for (let x = b.x; x < b.x + b.w; x++) {
      map.setHEdge(x, b.y, EDGE.WALL);
      map.setHEdge(x, b.y + b.h, EDGE.WALL);
    }
    for (let y = b.y; y < b.y + b.h; y++) {
      map.setVEdge(b.x, y, EDGE.WALL);
      map.setVEdge(b.x + b.w, y, EDGE.WALL);
    }
  },
  // full-height hedge column: foot pushes through, vehicles never do, so only
  // the west→east vehicle verdict may flip
  hedgeWall(plan) {
    const { map } = plan;
    const x = Math.floor(map.w * 0.5);
    for (let y = 0; y < map.h; y++) if (map.terrainAt(x, y).passable) map.setTerrain(x, y, 'hedge');
  },
  // impassable goal: astar bails on the goal-passability test up front, the
  // flood fill answers by never marking the tile — same verdict, different route
  drownObjective(plan) {
    const o = plan.objectives[0];
    plan.map.setTerrain(o.x, o.y, 'water');
  },
};

let checked = 0;
let failed = 0;
const verdicts = { true: 0, false: 0 };
const t0 = performance.now();

for (const kind of KINDS) {
  for (const [w, h] of SIZES) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const cases = [['clean', null], ...Object.entries(BREAKS)];
      for (const [label, brk] of cases) {
        let plan;
        try {
          plan = generateMap(seed, w, h, kind);
        } catch (e) {
          console.error(`generateMap threw for ${kind} ${w}x${h} seed ${seed}: ${e.message}`);
          failed++;
          continue;
        }
        if (brk) brk(plan);
        const a = validateAStar(plan);
        const b = validate(plan);
        checked++;
        verdicts[String(b)]++;
        if (a !== b) {
          failed++;
          console.error(`MISMATCH ${kind} ${w}x${h} seed ${seed} [${label}]: astar=${a} flood=${b}`);
        }
      }
    }
  }
  process.stdout.write(`${kind} ok (${checked} cases)\n`);
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(
  `\n${checked} cases in ${secs}s — verdicts: ${verdicts.true} accept / ${verdicts.false} reject — ${failed} mismatches`,
);
if (verdicts.false === 0) {
  console.error('no rejecting case ran: the negative half of the parity check proved nothing');
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
