import { generateMap } from '../../src/sim/mapgen';
function fingerprint(plan) {
  const { map } = plan;
  let h = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges, map.elev, map.stories, map.buildingId, map.stairs]) {
    for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193); }
  }
  return (h >>> 0).toString(16);
}
console.log('open/7 furnished:', fingerprint(generateMap(7, 320, 240, 'open', { interiors: true })));
console.log('open/7 plain:', fingerprint(generateMap(7, 320, 240, 'open')));
