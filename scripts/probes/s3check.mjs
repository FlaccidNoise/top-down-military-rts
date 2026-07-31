// seed 3 shipped map: compound near (245,214) — gate and lane check
import { generateMap } from '../../src/sim/mapgen';
import { EDGE } from '../../src/sim/map';

const { map } = generateMap(3, 320, 240, 'bourg', { interiors: true });
const x0 = 225, x1 = 270, y0 = 195, y1 = 232;
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
