import { EDGE, GameMap } from './map';
import { astar } from './path';
import { mulberry32, type Rng } from './rng';

// Roads-first Normandy generator: a wandering arterial road west→east, a
// cross lane, a village clustered on the crossroads, hedgerow-bounded farm
// parcels, and woods stands (one guaranteed east, the far objective).
// Hedgerows are 1-tile woods lines: vehicles are already blocked by woods,
// infantry pushes through slowly with cover — no new sim surface needed.
// Deterministic: all randomness flows through the seeded rng; no Math.hypot
// (not guaranteed correctly-rounded across engines).

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Vec {
  x: number;
  y: number;
}

export interface MapPlan {
  map: GameMap;
  buildings: Building[];
  spawns: { west: Vec; east: Vec }; // arterial road entry points, vehicle-reachable
  objectives: Vec[]; // [0] village crossroads, [1] east woods anchor, [2] second hamlet (w >= 240 only)
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function generateMap(seed: number, w = 160, h = 120): MapPlan {
  // village clearing radius + road margins need real space; below this the
  // clamp bounds invert and the layout degenerates
  if (w < 60 || h < 40) throw new Error(`mapgen: map ${w}x${h} too small (min 60x40)`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = mulberry32((seed ^ 0x51ab3fc7) + attempt * 0x9e3779b9);
    const plan = tryGenerate(rng, w, h);
    if (plan && validate(plan)) return plan;
  }
  throw new Error(`mapgen: no valid layout for seed ${seed}`);
}

function tryGenerate(rng: Rng, w: number, h: number): MapPlan | null {
  const map = new GameMap(w, h);
  const road = new Uint8Array(w * h);

  // arterial road west→east, gently wandering, 3 tiles wide
  const roadY = new Int32Array(w);
  let ry = Math.round(h * rng.range(0.4, 0.6));
  for (let x = 0; x < w; x++) {
    roadY[x] = ry;
    if (rng.next() < 0.18) ry = clamp(ry + (rng.next() < 0.5 ? -1 : 1), 10, h - 11);
  }
  for (let x = 0; x < w; x++) for (let dy = -1; dy <= 1; dy++) road[(roadY[x] + dy) * w + x] = 1;

  // cross lane north→south through the crossroads, 2 tiles wide
  const crossX = Math.round(w * rng.range(0.45, 0.62));
  const cy = roadY[crossX];
  const roadX = new Int32Array(h);
  let rx = crossX;
  for (let y = cy; y < h; y++) {
    roadX[y] = rx;
    if (rng.next() < 0.18) rx = clamp(rx + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
  }
  rx = crossX;
  for (let y = cy - 1; y >= 0; y--) {
    roadX[y] = rx;
    if (rng.next() < 0.18) rx = clamp(rx + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
  }
  for (let y = 0; y < h; y++) for (let dx = 0; dx <= 1; dx++) road[y * w + roadX[y] + dx] = 1;

  // village: buildings snapped to road frontage near the crossroads
  const buildings: Building[] = [];
  const doorSides: ('n' | 's' | 'e' | 'w')[] = [];
  const target = 5 + rng.int(3);
  const overlaps = (b: Building) =>
    buildings.some((o) => b.x - 2 < o.x + o.w && b.x + b.w + 2 > o.x && b.y - 2 < o.y + o.h && b.y + b.h + 2 > o.y);
  const touchesRoad = (b: Building): boolean => {
    for (let y = b.y - 1; y < b.y + b.h + 1; y++)
      for (let x = b.x - 1; x < b.x + b.w + 1; x++) if (road[y * w + x]) return true;
    return false;
  };
  const placeCluster = (jx: number, jy: number, laneX: Int32Array, count: number, span: number): void => {
    for (let tries = 0; tries < 300 && buildings.length < count; tries++) {
      const bw = 6 + rng.int(7);
      const bh = 5 + rng.int(5);
      let b: Building;
      let door: 'n' | 's' | 'e' | 'w';
      if (rng.next() < 0.6) {
        // along the arterial
        const bx = clamp(jx - span + rng.int(Math.max(1, span * 2 + 1 - bw)), 2, w - bw - 3);
        const north = rng.next() < 0.5;
        let edge = north ? h : 0;
        for (let x = bx; x < bx + bw; x++) edge = north ? Math.min(edge, roadY[x] - 1) : Math.max(edge, roadY[x] + 1);
        b = { x: bx, y: north ? edge - bh - 1 : edge + 2, w: bw, h: bh };
        door = north ? 's' : 'n';
      } else {
        // along the cross lane
        const by = clamp(jy - span + 2 + rng.int(Math.max(1, span * 2 - 3 - bh)), 2, h - bh - 3);
        const west = rng.next() < 0.5;
        let edge = west ? w : 0;
        for (let y = by; y < by + bh; y++) edge = west ? Math.min(edge, laneX[y]) : Math.max(edge, laneX[y] + 1);
        b = { x: west ? edge - bw - 1 : edge + 2, y: by, w: bw, h: bh };
        door = west ? 'e' : 'w';
      }
      if (b.x < 2 || b.y < 2 || b.x + b.w > w - 2 || b.y + b.h > h - 2) continue;
      if (touchesRoad(b) || overlaps(b)) continue;
      buildings.push(b);
      doorSides.push(door);
    }
  };
  placeCluster(crossX, cy, roadX, target, 24);
  if (buildings.length < 4) return null;

  // second hamlet crossroads on large maps, further west along the arterial
  const settlements = [{ x: crossX, y: cy, r: 26 }];
  if (w >= 240) {
    const crossX2 = Math.round(w * (0.15 + rng.range(0, 0.08)));
    const cy2 = roadY[crossX2];
    const roadX2 = new Int32Array(h);
    let rx2 = crossX2;
    for (let y = cy2; y < h; y++) {
      roadX2[y] = rx2;
      if (rng.next() < 0.18) rx2 = clamp(rx2 + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
    }
    rx2 = crossX2;
    for (let y = cy2 - 1; y >= 0; y--) {
      roadX2[y] = rx2;
      if (rng.next() < 0.18) rx2 = clamp(rx2 + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
    }
    for (let y = 0; y < h; y++) for (let dx = 0; dx <= 1; dx++) road[y * w + roadX2[y] + dx] = 1;
    placeCluster(crossX2, cy2, roadX2, buildings.length + 3 + rng.int(2), 14);
    settlements.push({ x: crossX2, y: cy2, r: 16 });
  }
  const nearVillage = (x: number, y: number) => settlements.some((s) => (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) < s.r * s.r);

  // outlying farm compounds: house + barn joined to the arterial by a lane
  for (let f = 0, n = 2 + rng.int(2); f < n; f++) {
    for (let tries = 0; tries < 60; tries++) {
      const fx = 8 + rng.int(w - 28);
      const fy = 8 + rng.int(h - 26);
      if ((fx - crossX) * (fx - crossX) + (fy - cy) * (fy - cy) < 35 * 35) continue;
      const house: Building = { x: fx, y: fy, w: 6 + rng.int(3), h: 5 + rng.int(2) };
      const barn: Building = { x: fx, y: fy + house.h + 3, w: 5 + rng.int(3), h: 4 + rng.int(2) };
      if (barn.y + barn.h > h - 3 || fx + Math.max(house.w, barn.w) > w - 4) continue;
      if (touchesRoad(house) || overlaps(house) || touchesRoad(barn) || overlaps(barn)) continue;
      const lx = Math.min(w - 3, fx + Math.max(house.w, barn.w) + 1);
      const target = roadY[lx];
      const step = fy + house.h + 1 < target ? 1 : -1;
      let laneBlocked = false;
      for (let yy = fy + house.h + 1; yy !== target && !laneBlocked; yy += step)
        laneBlocked = buildings.some((o) => lx >= o.x - 1 && lx < o.x + o.w + 1 && yy >= o.y - 1 && yy < o.y + o.h + 1);
      if (laneBlocked) continue;
      buildings.push(house, barn);
      doorSides.push('s', 'n'); // both doors open onto the shared yard row
      for (let yy = fy + house.h + 1; yy !== target; yy += step) road[yy * w + lx] = 1;
      break;
    }
  }

  const nearBuilding = (x: number, y: number) =>
    buildings.some((b) => x >= b.x - 1 && x < b.x + b.w + 1 && y >= b.y - 1 && y < b.y + b.h + 1);

  // hedgerow parcel borders: 1-tile woods lines that drift, with gates
  const hedgeLine = (len: number, at: (i: number, off: number) => [number, number]) => {
    let gate = 6 + rng.int(10);
    let off = 0;
    let i = 0;
    while (i < len) {
      if (i >= gate) {
        i += 2 + rng.int(2);
        gate = i + 8 + rng.int(12);
        continue;
      }
      if (rng.next() < 0.12) off = clamp(off + (rng.next() < 0.5 ? -1 : 1), -3, 3);
      const [x, y] = at(i, off);
      if (x >= 1 && y >= 1 && x < w - 1 && y < h - 1 && !road[y * w + x] && !nearVillage(x, y) && !nearBuilding(x, y) && map.terrainKeyAt(x, y) === 'grass') {
        map.setTerrain(x, y, 'hedge');
      }
      i++;
    }
  };
  for (let px = 12 + rng.int(12); px < w - 8; px += 16 + rng.int(16)) hedgeLine(h, (i, off) => [px + off, i]);
  for (let py = 10 + rng.int(12); py < h - 6; py += 14 + rng.int(14)) hedgeLine(w, (i, off) => [i, py + off]);

  // woods stands; the first, east of the village, is the far objective
  const stand = (cx0: number, cy0: number, r: number) => {
    for (let y = Math.max(1, cy0 - r); y <= Math.min(h - 2, cy0 + r); y++)
      for (let x = Math.max(1, cx0 - r); x <= Math.min(w - 2, cx0 + r); x++) {
        const d2 = (x - cx0) * (x - cx0) + (y - cy0) * (y - cy0);
        const rr = r * (0.55 + rng.next() * 0.45);
        if (d2 < rr * rr && !road[y * w + x] && !nearVillage(x, y) && !nearBuilding(x, y) && map.terrainKeyAt(x, y) === 'grass') {
          map.setTerrain(x, y, 'woods');
        }
      }
  };
  const eastWoods = { x: clamp(crossX + 38 + rng.int(20), 20, w - 14), y: clamp(cy - 18 + rng.int(37), 12, h - 12) };
  stand(eastWoods.x, eastWoods.y, 9 + rng.int(4));
  for (let i = 0, n = 2 + rng.int(3) + Math.max(0, Math.round((w * h) / 19200) - 1); i < n; i++) {
    const sx = 10 + rng.int(w - 20);
    const sy = 8 + rng.int(h - 16);
    if ((sx - crossX) * (sx - crossX) + (sy - cy) * (sy - cy) < 34 * 34) continue;
    stand(sx, sy, 6 + rng.int(5));
  }

  // orchards: staggered tree rows near the village
  for (let i = 0, n = 1 + rng.int(2); i < n; i++) {
    const ow = 8 + rng.int(7);
    const oh = 6 + rng.int(5);
    const ox = clamp(crossX - 30 + rng.int(Math.max(1, 60 - ow)), 2, w - ow - 2);
    const oy = clamp(cy - 26 + rng.int(Math.max(1, 52 - oh)), 2, h - oh - 2);
    for (let y = oy; y < oy + oh; y += 2)
      for (let x = ox + (((y - oy) >> 1) % 2); x < ox + ow; x += 2)
        if (!road[y * w + x] && !nearBuilding(x, y) && map.terrainKeyAt(x, y) === 'grass') map.setTerrain(x, y, 'woods');
  }

  // plowed fields: rect patches on remaining grass
  for (let i = 0, n = 4 + rng.int(4); i < n; i++) {
    const fw = 12 + rng.int(14);
    const fh = 8 + rng.int(10);
    const fx = 2 + rng.int(Math.max(1, w - fw - 4));
    const fy = 2 + rng.int(Math.max(1, h - fh - 4));
    for (let y = fy; y < fy + fh; y++)
      for (let x = fx; x < fx + fw; x++)
        if (!road[y * w + x] && !nearBuilding(x, y) && map.terrainKeyAt(x, y) === 'grass') map.setTerrain(x, y, 'field');
  }

  // roads carved last: the corridor is clear by construction
  for (let i = 0; i < road.length; i++) if (road[i]) map.setTerrain(i % w, (i / w) | 0, 'road');
  buildings.forEach((b, i) => addBuilding(map, b, doorSides[i]));

  const objectives: Vec[] = [{ x: crossX, y: cy }, eastWoods];
  if (settlements.length > 1) objectives.push({ x: settlements[1].x, y: settlements[1].y });

  return {
    map,
    buildings,
    spawns: { west: { x: 3, y: roadY[3] }, east: { x: w - 4, y: roadY[w - 4] } },
    objectives,
  };
}

// Perimeter walls with windows every 3 tiles, a door mid-span on the
// road-facing side, floor interior, and a partitioned second room when wide
// enough (partition door aligned with the entrance row/column).
function addBuilding(map: GameMap, b: Building, door: 'n' | 's' | 'e' | 'w'): void {
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) map.setTerrain(x, y, 'floor');
  const doorX = b.x + Math.floor(b.w / 2);
  const doorY = b.y + Math.floor(b.h / 2);
  const win = (i: number) => (i % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
  for (let x = b.x; x < b.x + b.w; x++) {
    map.setHEdge(x, b.y, door === 'n' && x === doorX ? EDGE.DOOR : win(x - b.x));
    map.setHEdge(x, b.y + b.h, door === 's' && x === doorX ? EDGE.DOOR : win(x - b.x));
  }
  for (let y = b.y; y < b.y + b.h; y++) {
    map.setVEdge(b.x, y, door === 'w' && y === doorY ? EDGE.DOOR : win(y - b.y));
    map.setVEdge(b.x + b.w, y, door === 'e' && y === doorY ? EDGE.DOOR : win(y - b.y));
  }
  if (b.w >= 8) {
    for (let y = b.y; y < b.y + b.h; y++) map.setVEdge(doorX, y, y === doorY ? EDGE.DOOR : EDGE.WALL);
  }
}

function validate(plan: MapPlan): boolean {
  const { map, buildings, spawns, objectives } = plan;
  const foot = (a: Vec, b: Vec) => astar(map, a.x, a.y, b.x, b.y) !== null;
  for (const o of objectives) if (!foot(spawns.west, o) || !foot(spawns.east, o)) return false;
  for (const b of buildings) if (!foot(spawns.west, { x: b.x + (b.w >> 1), y: b.y + (b.h >> 1) })) return false;
  return astar(map, spawns.west.x, spawns.west.y, spawns.east.x, spawns.east.y, 'vehicle') !== null;
}
