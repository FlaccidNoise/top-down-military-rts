import { generateMap } from '../../src/sim/mapgen';
import { EnclosureIndex } from '../../src/render/enclos';
const { map } = generateMap(7, 320, 240, 'bourg', { interiors: true });
const idx = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
for (const [x, y] of [[150, 105], [155, 108], [160, 110], [148, 112], [158, 115], [152, 117]]) {
  const id = idx.enclosureAt[y * map.w + x];
  console.log(`${x},${y}: terrain=${map.terrainKeyAt(x, y)} enclosure=${id}${id >= 0 ? ' kind=' + idx.enclosures[id].kind + ' tiles=' + idx.enclosures[id].tiles : ''}`);
}
