// Lane survey: how far can a defender standing ON an objective see, along his
// best bearing? Read-only — it measures the shipped generator, including
// src/sim/sightlines.ts, and prints the table quoted in that file's header.
//
//   npx vite-node scripts/sightlines.mjs
//   SEEDS=16 npx vite-node scripts/sightlines.mjs
import { los } from '../src/sim/map';
import { generateMap } from '../src/sim/mapgen';

const MAX = 60;
const SEEDS = Number(process.env.SEEDS ?? 8);
const KINDS = ['bourg', 'road', 'open', 'river', 'bridge', 'woods'];

// The longest bearing, measured the way sightlines.ts defines a lane: every
// step of it visible, and the far end standable.
function laneOf(map, ox, oy) {
  let best = 0;
  for (let b = 0; b < 120; b++) {
    const a = (b * 2 * Math.PI) / 120;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let far = 0;
    for (let d = 2; d <= MAX; d++) {
      const x = ox + 0.5 + dx * d;
      const y = oy + 0.5 + dy * d;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (!map.inBounds(tx, ty)) break;
      if (!map.terrainAt(tx, ty).passable) continue;
      if (!los(map, ox + 0.5, oy + 0.5, x, y).visible) break;
      far = d;
    }
    if (far > best) best = far;
  }
  return best;
}

const all = [];
for (const kind of KINDS) {
  const lanes = [];
  const short = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const p = generateMap(seed, 320, 240, kind, { interiors: true });
    p.objectives.forEach((o, i) => {
      const v = laneOf(p.map, o.x, o.y);
      lanes.push(v);
      all.push(v);
      if (v < 15) short.push(`${p.objectiveKinds[i]}/s${seed}@${o.x},${o.y}=${v}`);
    });
  }
  lanes.sort((a, b) => a - b);
  const q = (f) => lanes[Math.min(lanes.length - 1, Math.floor(f * lanes.length))];
  console.log(
    kind.padEnd(7),
    'n', String(lanes.length).padStart(3),
    'min', String(q(0)).padStart(2),
    'p10', String(q(0.1)).padStart(2),
    'median', String(q(0.5)).padStart(2),
    'max', String(lanes[lanes.length - 1]).padStart(2),
    '| under 15:', short.length,
    short.join(' '),
  );
}
all.sort((a, b) => a - b);
console.log('ALL n', all.length, 'min', all[0], 'p10', all[Math.floor(all.length * 0.1)], 'median', all[all.length >> 1], 'under 15', all.filter((v) => v < 15).length);
