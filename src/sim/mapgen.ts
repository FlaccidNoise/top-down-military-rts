import { EDGE, FLOOR_H, GameMap } from './map';
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
  objectives: Vec[]; // [0] village crossroads, [1] east woods anchor, [2] second hamlet (w >= 240 only); bridge/river maps append the bridge crossing last
  woodsStands: Vec[]; // center of every placed woods stand (guaranteed east stand + extras)
}

// Battle-map archetype, mirroring the strategic cell terrain. 'bridge'/'river'
// carve a N→S water band crossed by the arterial on a bridge; 'woods'/'town'
// bias stand and building counts; 'open'/'road' are the base layout.
export type MapKind = 'open' | 'woods' | 'town' | 'river' | 'bridge' | 'road';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function generateMap(seed: number, w = 160, h = 120, kind: MapKind = 'open'): MapPlan {
  // village clearing radius + road margins need real space; below this the
  // clamp bounds invert and the layout degenerates
  if (w < 60 || h < 40) throw new Error(`mapgen: map ${w}x${h} too small (min 60x40)`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = mulberry32((seed ^ 0x51ab3fc7) + attempt * 0x9e3779b9);
    const plan = tryGenerate(rng, w, h, kind);
    if (plan && validate(plan)) return plan;
  }
  throw new Error(`mapgen: no valid layout for seed ${seed}`);
}

function tryGenerate(rng: Rng, w: number, h: number, kind: MapKind): MapPlan | null {
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

  // cross lane north→south through a junction on the arterial, 2 tiles wide
  const carveCrossLane = (jx: number): Int32Array => {
    const laneX = new Int32Array(h);
    const jy = roadY[jx];
    let rx = jx;
    for (let y = jy; y < h; y++) {
      laneX[y] = rx;
      if (rng.next() < 0.18) rx = clamp(rx + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
    }
    rx = jx;
    for (let y = jy - 1; y >= 0; y--) {
      laneX[y] = rx;
      if (rng.next() < 0.18) rx = clamp(rx + (rng.next() < 0.5 ? -1 : 1), 6, w - 8);
    }
    for (let y = 0; y < h; y++) for (let dx = 0; dx <= 1; dx++) road[y * w + laneX[y] + dx] = 1;
    return laneX;
  };
  const crossX = Math.round(w * rng.range(0.45, 0.62));
  const cy = roadY[crossX];
  const roadX = carveCrossLane(crossX);

  // river ('bridge'/'river' cells): N→S water band west of the village
  // clearing (and east of the second hamlet's, by the crossX bounds). Roads
  // are carved last and win over water, so the arterial crossing becomes the
  // bridge — a chokepoint appended to objectives.
  const water = new Uint8Array(w * h);
  let bridgePt: Vec | null = null;
  if (kind === 'bridge' || kind === 'river') {
    const width = kind === 'river' ? 5 : 3;
    const base = clamp(crossX - 38 - rng.int(8), 6, w - width - 6);
    let rx = base;
    for (let y = 0; y < h; y++) {
      for (let dx = 0; dx < width; dx++) water[y * w + rx + dx] = 1;
      if (rng.next() < 0.15) rx = clamp(rx + (rng.next() < 0.5 ? -1 : 1), base - 3, base + 3);
    }
    for (let i = 0; i < water.length; i++) if (water[i]) map.setTerrain(i % w, (i / w) | 0, 'water');
    // the band random-walks ±3 off its seed column, so derive the bridge from
    // the actual arterial-centerline ∩ water overlap (middle column of it)
    const xs: number[] = [];
    for (let x = 0; x < w; x++) if (water[roadY[x] * w + x]) xs.push(x);
    if (xs.length === 0) return null; // no crossing carved: reroll rather than emit a NaN objective
    const bx = xs[xs.length >> 1];
    bridgePt = { x: bx, y: roadY[bx] };
  }

  // village: buildings snapped to road frontage near the crossroads
  const buildings: Building[] = [];
  const doorSides: ('n' | 's' | 'e' | 'w')[] = [];
  const target = 5 + rng.int(3) + (kind === 'town' ? 10 : 0);
  const overlaps = (b: Building) =>
    buildings.some((o) => b.x - 2 < o.x + o.w && b.x + b.w + 2 > o.x && b.y - 2 < o.y + o.h && b.y + b.h + 2 > o.y);
  const touchesRoadOrWater = (b: Building): boolean => {
    for (let y = b.y - 1; y < b.y + b.h + 1; y++)
      for (let x = b.x - 1; x < b.x + b.w + 1; x++) if (road[y * w + x] || water[y * w + x]) return true;
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
      if (touchesRoadOrWater(b) || overlaps(b)) continue;
      buildings.push(b);
      doorSides.push(door);
    }
  };
  placeCluster(crossX, cy, roadX, target, kind === 'town' ? 32 : 24);
  if (buildings.length < 4) return null;

  // second hamlet crossroads on large maps, further west along the arterial
  const settlements = [{ x: crossX, y: cy, r: 26 }];
  if (w >= 240) {
    const crossX2 = Math.round(w * (0.15 + rng.range(0, 0.08)));
    const cy2 = roadY[crossX2];
    const roadX2 = carveCrossLane(crossX2);
    placeCluster(crossX2, cy2, roadX2, buildings.length + 3 + rng.int(2), 14);
    settlements.push({ x: crossX2, y: cy2, r: 16 });
  }
  const nearVillage = (x: number, y: number) => settlements.some((s) => (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) < s.r * s.r);

  // outlying farm compounds: house + barn joined to the arterial by a lane
  for (let f = 0, n = 2 + rng.int(2); f < n; f++) {
    for (let tries = 0; tries < 60; tries++) {
      const fx = 8 + rng.int(w - 28);
      const fy = 8 + rng.int(h - 26);
      // stay outside every settlement's clearing plus a margin (village: 26+9=35)
      if (settlements.some((s) => (fx - s.x) * (fx - s.x) + (fy - s.y) * (fy - s.y) < (s.r + 9) * (s.r + 9))) continue;
      const house: Building = { x: fx, y: fy, w: 6 + rng.int(3), h: 5 + rng.int(2) };
      const barn: Building = { x: fx, y: fy + house.h + 3, w: 5 + rng.int(3), h: 4 + rng.int(2) };
      if (barn.y + barn.h > h - 3 || fx + Math.max(house.w, barn.w) > w - 4) continue;
      if (touchesRoadOrWater(house) || overlaps(house) || touchesRoadOrWater(barn) || overlaps(barn)) continue;
      const lx = Math.min(w - 3, fx + Math.max(house.w, barn.w) + 1);
      const laneTargetY = roadY[lx];
      const step = fy + house.h + 1 < laneTargetY ? 1 : -1;
      let laneBlocked = false;
      for (let yy = fy + house.h + 1; yy !== laneTargetY && !laneBlocked; yy += step)
        laneBlocked =
          water[yy * w + lx] !== 0 ||
          buildings.some((o) => lx >= o.x - 1 && lx < o.x + o.w + 1 && yy >= o.y - 1 && yy < o.y + o.h + 1);
      if (laneBlocked) continue;
      buildings.push(house, barn);
      doorSides.push('s', 'n'); // both doors open onto the shared yard row
      for (let yy = fy + house.h + 1; yy !== laneTargetY; yy += step) road[yy * w + lx] = 1;
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
  const woodsStands: Vec[] = [];
  const eastWoods = { x: clamp(crossX + 38 + rng.int(20), 20, w - 14), y: clamp(cy - 18 + rng.int(37), 12, h - 12) };
  stand(eastWoods.x, eastWoods.y, 9 + rng.int(4));
  woodsStands.push({ x: eastWoods.x, y: eastWoods.y });
  for (let i = 0, n = 2 + rng.int(3) + Math.max(0, Math.round((w * h) / 19200) - 1) + (kind === 'woods' ? 4 : 0); i < n; i++) {
    const sx = 10 + rng.int(w - 20);
    const sy = 8 + rng.int(h - 16);
    if ((sx - crossX) * (sx - crossX) + (sy - cy) * (sy - cy) < 34 * 34) continue;
    stand(sx, sy, 6 + rng.int(5) + (kind === 'woods' ? 3 : 0));
    // a stand centered in the river still carves bank trees, but its center is
    // no anchor: downstream consumers (garrison posts) order squads to it and
    // an impassable post can never be reached or settled on
    if (map.terrainAt(sx, sy).passable) woodsStands.push({ x: sx, y: sy });
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

  // roads carved last: the corridor is clear by construction. A road tile that
  // overwrites water is a bridge deck — record it before the water is lost.
  for (let i = 0; i < road.length; i++)
    if (road[i]) {
      map.setTerrain(i % w, (i / w) | 0, 'road');
      if (water[i]) map.bridges[i] = 1;
    }
  buildings.forEach((b, i) => {
    map.maxStories = Math.max(map.maxStories, addBuilding(map, b, doorSides[i], i));
  });

  const objectives: Vec[] = [{ x: crossX, y: cy }, eastWoods];
  if (settlements.length > 1) objectives.push({ x: settlements[1].x, y: settlements[1].y });
  if (bridgePt) objectives.push(bridgePt);

  // cosine hill domes: generated LAST so the rng position for all 2D geometry
  // above is untouched (byte-identical tiles/edges per seed). Domes never lift
  // structures: road/water/floor tiles and anything within 1 of a building
  // are skipped. Overlapping domes take the max elevation.
  for (let i = 0, n = 2 + rng.int(3); i < n; i++) {
    const cx = rng.int(w);
    const cy = rng.int(h);
    const r = 8 + rng.int(12);
    const peak = 3 + rng.int(6);
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++)
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > r2) continue;
        const k = map.terrainKeyAt(x, y);
        if (k === 'road' || k === 'water' || k === 'floor') continue;
        if (nearBuilding(x, y)) continue;
        const e = Math.round(peak * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.sqrt(d2) / r))));
        if (e > map.elev[y * w + x]) map.elev[y * w + x] = e;
      }
  }

  return {
    map,
    buildings,
    spawns: { west: { x: 3, y: roadY[3] }, east: { x: w - 4, y: roadY[w - 4] } },
    objectives,
    woodsStands,
  };
}

// Perimeter walls with windows every 3 tiles, a door mid-span on the
// road-facing side, floor interior, and a partitioned second room when wide
// enough (partition door aligned with the entrance row/column).
// Height: every building gets buildingId = id (assigned incrementally by call
// order) and WALL edge tops stamped at stories*FLOOR_H (exterior + partition;
// doors/windows pass sight and keep top 0). Footprints >= 56 tiles are
// 2-story: their back corner (interior corner farthest from the door) gets a
// stair tile. Returns the story count.
function addBuilding(map: GameMap, b: Building, door: 'n' | 's' | 'e' | 'w', id: number): number {
  const stories = b.w * b.h >= 56 ? 2 : 1;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      map.setTerrain(x, y, 'floor');
      const i = y * map.w + x;
      map.stories[i] = stories;
      map.buildingId[i] = id;
    }
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
  // stamp WALL edge tops (exterior + partition)
  const top = stories * FLOOR_H;
  for (let y = b.y; y <= b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) if (map.hEdge(x, y) === EDGE.WALL) map.hEdgeTops[y * map.w + x] = top;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x <= b.x + b.w; x++) if (map.vEdge(x, y) === EDGE.WALL) map.vEdgeTops[y * (map.w + 1) + x] = top;
  if (stories === 2) {
    // stair in the interior corner farthest from the door
    const drX = door === 'w' ? b.x : door === 'e' ? b.x + b.w - 1 : doorX;
    const drY = door === 'n' ? b.y : door === 's' ? b.y + b.h - 1 : doorY;
    let best = 0;
    let bestD2 = -1;
    const corners: [number, number][] = [
      [b.x + 1, b.y + 1],
      [b.x + b.w - 2, b.y + 1],
      [b.x + 1, b.y + b.h - 2],
      [b.x + b.w - 2, b.y + b.h - 2],
    ];
    for (let i = 0; i < corners.length; i++) {
      const d2 = (corners[i][0] - drX) * (corners[i][0] - drX) + (corners[i][1] - drY) * (corners[i][1] - drY);
      if (d2 > bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    map.stairs[corners[best][1] * map.w + corners[best][0]] = 1;
  }
  return stories;
}

// Ground-level reachability field: one 8-connected BFS from (sx,sy) whose step
// rules mirror astar (path.ts:102-118) exactly — the same map.canStep calls,
// the same "all four L-paths must be steppable" no-corner-cutting rule, no
// stair/level axis (astar's default sl=gl=0 keeps needLevels at 1). So
// `field[i] === 1` is precisely the relation `astar(map, sx, sy, x, y, mode)
// !== null` tests, answered once per SOURCE instead of once per query.
//
// Two astar quirks are reproduced deliberately:
//  - the start tile is seeded regardless of its own passability (astar gates
//    only on the GOAL's passability, then expands via canStep);
//  - goal passability is therefore re-tested at lookup time, in reaches().
//
// canStep is INLINED here rather than called: at ~12 step tests per tile over
// 76,800 tiles the two property chains inside terrainAt (TERRAIN[KEYS[byte]])
// dominate, and hoisting them into a per-tile `open` bitmap plus raw edge-array
// reads is the difference between ~8 ms and ~2 ms per pass. map.ts:112-125 is
// the authority for the rule; `tests/mapgen.test.ts` asserts reachField against
// astar directly so the copy cannot drift silently.
//
// The four orthogonal steps out of the popped tile are evaluated once and
// reused as the first leg of each diagonal's corner test.
export function reachField(map: GameMap, sx: number, sy: number, mode: 'foot' | 'vehicle'): Uint8Array {
  const { w, h, hEdges, vEdges } = map;
  const field = new Uint8Array(w * h);
  if (!map.inBounds(sx, sy)) return field;

  // per-tile enterability, memoised on the raw terrain byte (≈10 distinct values)
  const veh = mode === 'vehicle';
  const open = new Uint8Array(w * h);
  const byTile = new Int8Array(256).fill(-1);
  for (let i = 0; i < open.length; i++) {
    const t = map.tiles[i];
    let e = byTile[t];
    if (e < 0) {
      const x = i % w;
      const y = (i / w) | 0;
      const k = map.terrainKeyAt(x, y);
      e = map.terrainAt(x, y).passable && (!veh || (k !== 'floor' && k !== 'woods' && k !== 'hedge')) ? 1 : 0;
      byTile[t] = e;
    }
    open[i] = e;
  }
  // edge transit by EDGE code: vehicles pass NONE only, foot also passes DOOR
  const passEdge = new Uint8Array(4);
  passEdge[EDGE.NONE] = 1;
  if (!veh) passEdge[EDGE.DOOR] = 1;

  const queue = new Int32Array(w * h); // each tile is enqueued at most once
  let head = 0;
  let tail = 0;
  const start = sy * w + sx;
  field[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    const vRow = cy * (w + 1);
    // hEdge(x,y) = hEdges[y*w + x] → north side of (cx,cy) is hEdges[cur];
    // vEdge(x,y) = vEdges[y*(w+1) + x] → west side of (cx,cy) is vEdges[vRow+cx].
    const okW = cx > 0 && open[cur - 1] === 1 && passEdge[vEdges[vRow + cx]] === 1;
    const okE = cx + 1 < w && open[cur + 1] === 1 && passEdge[vEdges[vRow + cx + 1]] === 1;
    const okN = cy > 0 && open[cur - w] === 1 && passEdge[hEdges[cur]] === 1;
    const okS = cy + 1 < h && open[cur + w] === 1 && passEdge[hEdges[cur + w]] === 1;
    if (okW && !field[cur - 1]) {
      field[cur - 1] = 1;
      queue[tail++] = cur - 1;
    }
    if (okE && !field[cur + 1]) {
      field[cur + 1] = 1;
      queue[tail++] = cur + 1;
    }
    if (okN && !field[cur - w]) {
      field[cur - w] = 1;
      queue[tail++] = cur - w;
    }
    if (okS && !field[cur + w]) {
      field[cur + w] = 1;
      queue[tail++] = cur + w;
    }
    // diagonals: astar requires BOTH L-paths fully steppable (path.ts:108-114).
    // okH/okV are the first leg of each; the two remaining legs both land on
    // (nx,ny), so they share the one `open` test.
    for (let dy = -1; dy <= 1; dy += 2) {
      if (!(dy < 0 ? okN : okS)) continue;
      for (let dx = -1; dx <= 1; dx += 2) {
        if (!(dx < 0 ? okW : okE)) continue;
        const ni = cur + dy * w + dx;
        if (field[ni] || open[ni] !== 1) continue;
        // vertical leg in column nx, then horizontal leg in row ny
        if (passEdge[hEdges[dy > 0 ? cur + w + dx : cur + dx]] !== 1) continue;
        if (passEdge[vEdges[(cy + dy) * (w + 1) + (dx > 0 ? cx + 1 : cx)]] !== 1) continue;
        field[ni] = 1;
        queue[tail++] = ni;
      }
    }
  }
  return field;
}

const reaches = (map: GameMap, field: Uint8Array, x: number, y: number): boolean =>
  map.inBounds(x, y) && map.terrainAt(x, y).passable && field[y * map.w + x] === 1;

// Layout gate. Semantically identical to the 36-A*-call version it replaced —
// same questions, same step function — but O(1) in building count instead of
// linear, which is what makes a 65-building bourg affordable. Draws no rng and
// mutates nothing, so every kind's fingerprint is untouched.
// Parity with the A* formulation is re-checkable via scripts/validate-parity.mjs.
export function validate(plan: MapPlan): boolean {
  const { map, buildings, spawns, objectives } = plan;
  const west = reachField(map, spawns.west.x, spawns.west.y, 'foot');
  for (const o of objectives) if (!reaches(map, west, o.x, o.y)) return false;
  for (const b of buildings) if (!reaches(map, west, b.x + (b.w >> 1), b.y + (b.h >> 1))) return false;
  // every stair tile (2-story buildings) must be foot-reachable at ground level
  for (let i = 0; i < map.stairs.length; i++)
    if (map.stairs[i] === 1 && map.stories[i] === 2 && !reaches(map, west, i % map.w, (i / map.w) | 0)) return false;
  const east = reachField(map, spawns.east.x, spawns.east.y, 'foot');
  for (const o of objectives) if (!reaches(map, east, o.x, o.y)) return false;
  const veh = reachField(map, spawns.west.x, spawns.west.y, 'vehicle');
  return reaches(map, veh, spawns.east.x, spawns.east.y);
}
