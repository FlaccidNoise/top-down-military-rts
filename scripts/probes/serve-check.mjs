// For seeds 1,2,3,5: every rural compound — gate, road-adjacency, nearest road
import { generateMap } from '../../src/sim/mapgen';
import { EDGE } from '../../src/sim/map';

for (const seed of [1, 2, 3, 5]) {
  const plan = generateMap(seed, 320, 240, 'bourg', { interiors: true });
  const { map, buildings } = plan;
  // rebuild compounds from building clusters: find farmhouse+barn pairs via yard pockets — simpler: scan all DOOR edges not adjacent to a building
  const doors = [];
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 320; x++) {
      if (map.hEdge(x, y) === EDGE.DOOR && map.buildingIdAt(x, y) < 0 && map.buildingIdAt(x, y - 1) < 0) {
        const road = map.terrainKeyAt(x, y) === 'road' || map.terrainKeyAt(x, y - 1) === 'road' ||
          map.terrainKeyAt(x - 1, y) === 'road' || map.terrainKeyAt(x + 1, y) === 'road' ||
          map.terrainKeyAt(x - 1, y - 1) === 'road' || map.terrainKeyAt(x + 1, y - 1) === 'road' ||
          (x > 0 && map.terrainKeyAt(x - 1, y) === 'road');
        doors.push(`h(${x},${y}) roadAdj=${road}`);
      }
      if (map.vEdge(x, y) === EDGE.DOOR && map.buildingIdAt(x, y) < 0 && map.buildingIdAt(x - 1, y) < 0) {
        const road = map.terrainKeyAt(x, y) === 'road' || map.terrainKeyAt(x - 1, y) === 'road' ||
          map.terrainKeyAt(x, y - 1) === 'road' || map.terrainKeyAt(x, y + 1) === 'road' ||
          map.terrainKeyAt(x - 1, y - 1) === 'road' || map.terrainKeyAt(x - 1, y + 1) === 'road';
        doors.push(`v(${x},${y}) roadAdj=${road}`);
      }
    }
  }
  // filter to doors far from town (rural gates): keep all, tag
  console.log(`seed ${seed}: ${doors.filter((d) => d.includes('false')).length} unserved free gates, ${doors.length} total free gates`);
  for (const d of doors.filter((d) => d.includes('false'))) console.log('  ', d);
}
