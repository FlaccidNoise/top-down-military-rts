import { generateMap } from '../../src/sim/mapgen';
import { EDGE } from '../../src/sim/map';

const plan = generateMap(2, 320, 240, 'bourg', { interiors: true });
const { map } = plan;
const x0 = 28, x1 = 60, y0 = 198, y1 = 222;
for (let y = y0; y <= y1; y++) {
  let row = '';
  for (let x = x0; x <= x1; x++) {
    const k = map.terrainKeyAt(x, y);
    let c = k === 'floor' ? '#' : k === 'road' ? '.' : k === 'hedge' ? 'H' : k === 'field' ? 'F' : k === 'grass' ? '"' : k[0];
    if (map.hEdge(x, y) === EDGE.DOOR || map.vEdge(x, y) === EDGE.DOOR) c = 'D';
    row += c;
  }
  console.log(String(y).padStart(3) + ' ' + row);
}
console.log('\nbuildings:');
for (const b of plan.buildings)
  if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0)
    console.log(JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h, role: b.role, doors: b.doors }));
