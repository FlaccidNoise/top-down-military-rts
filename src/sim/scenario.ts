import { DE_NAMES, US_NAMES, type WeaponKey } from './data';
import { EDGE, GameMap } from './map';
import { Sim, type Side } from './sim';
import { mulberry32 } from './rng';

export const MAP_W = 160;
export const MAP_H = 120;

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Perimeter walls with a south door, windows every 3 tiles, floor interior,
// and an interior partition with a door when wide enough.
function addBuilding(map: GameMap, b: Building): void {
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      map.setTerrain(x, y, 'floor');
    }
  }
  const doorX = b.x + Math.floor(b.w / 2);
  for (let x = b.x; x < b.x + b.w; x++) {
    map.setHEdge(x, b.y, (x - b.x) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
    map.setHEdge(x, b.y + b.h, x === doorX ? EDGE.DOOR : (x - b.x) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
  }
  for (let y = b.y; y < b.y + b.h; y++) {
    map.setVEdge(b.x, y, (y - b.y) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
    map.setVEdge(b.x + b.w, y, (y - b.y) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
  }
  if (b.w >= 8) {
    const px = b.x + Math.floor(b.w / 2);
    const pDoorY = b.y + Math.floor(b.h / 2);
    for (let y = b.y; y < b.y + b.h; y++) {
      map.setVEdge(px, y, y === pDoorY ? EDGE.DOOR : EDGE.WALL);
    }
  }
}

export const BUILDINGS: Building[] = [
  { x: 92, y: 48, w: 10, h: 8 },
  { x: 106, y: 64, w: 12, h: 9 },
  { x: 94, y: 76, w: 9, h: 7 },
];

export function makeMap(seed: number): GameMap {
  const map = new GameMap(MAP_W, MAP_H);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  // road
  for (let x = 0; x < MAP_W; x++) {
    for (let y = 60; y < 64; y++) map.setTerrain(x, y, 'road');
  }
  // woods blobs
  const blobs = [
    { x: 118, y: 36, w: 22, h: 18 },
    { x: 124, y: 82, w: 26, h: 22 },
    { x: 40, y: 20, w: 20, h: 14 },
    { x: 30, y: 90, w: 24, h: 16 },
  ];
  for (const b of blobs) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (map.inBounds(x, y) && rng.next() < 0.85 && map.terrainKeyAt(x, y) === 'grass') {
          map.setTerrain(x, y, 'woods');
        }
      }
    }
  }
  for (const b of BUILDINGS) addBuilding(map, b);
  return map;
}

function squadMembers(sim: Sim, side: Side, cx: number, cy: number, spread: number): { name: string; weapon: WeaponKey; x: number; y: number }[] {
  const names = side === 'blue' ? US_NAMES : DE_NAMES;
  const members: { name: string; weapon: WeaponKey; x: number; y: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const weapon: WeaponKey = i === 0 ? 'smg' : i === 1 ? 'mg' : 'rifle';
    members.push({
      name: names[sim.rng.int(names.length)],
      weapon,
      x: cx + sim.rng.range(-spread, spread),
      y: cy + sim.rng.range(-spread, spread),
    });
  }
  return members;
}

function placeInBuilding(sim: Sim, b: Building, count: number): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    spots.push({
      x: b.x + 1 + sim.rng.int(b.w - 2) + 0.5,
      y: b.y + 1 + sim.rng.int(b.h - 2) + 0.5,
    });
  }
  return spots;
}

export function makeScenario(seed: number): Sim {
  const map = makeMap(seed);
  const sim = new Sim(map, seed);

  sim.addSquad('blue', '1st Squad', squadMembers(sim, 'blue', 10, 44, 3));
  sim.addSquad('blue', '2nd Squad', squadMembers(sim, 'blue', 10, 76, 3));

  // red defends: one squad split across two buildings, one in woods + third building
  const g1 = squadMembers(sim, 'red', 0, 0, 0);
  const spots1 = [...placeInBuilding(sim, BUILDINGS[0], 5), ...placeInBuilding(sim, BUILDINGS[1], 4)];
  g1.forEach((m, i) => {
    m.x = spots1[i].x;
    m.y = spots1[i].y;
  });
  sim.addSquad('red', '1. Gruppe', g1);

  const g2 = squadMembers(sim, 'red', 0, 0, 0);
  const spots2 = [
    ...placeInBuilding(sim, BUILDINGS[2], 4),
    ...Array.from({ length: 5 }, () => ({
      x: 122 + sim.rng.range(0, 12),
      y: 40 + sim.rng.range(0, 12),
    })),
  ];
  g2.forEach((m, i) => {
    m.x = spots2[i].x;
    m.y = spots2[i].y;
  });
  sim.addSquad('red', '2. Gruppe', g2);

  return sim;
}
