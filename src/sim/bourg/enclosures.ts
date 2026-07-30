import { EDGE, type GameMap } from '../map';
import type { Rect } from '../mapgen';
import type { Face, Footprints } from './footprints';
import { RESV, type Landmarks } from './landmarks';
import { TAG, type Skeleton } from './streets';

// Stage 10 — enclosures and the back network (T8).
//
// The only module in the bourg pipeline that writes to the GameMap without
// going through stampStructure, and the only one that must run AFTER the
// buildings are stamped: every wall here is written into an edge that is still
// EDGE.NONE, so a house wall, a window or a door is never overwritten and the
// enclosure closes around whatever the stamper already built.
//
// §3.2's wall-top code table is the whole contract with the renderer:
//   top 1 — plot-to-plot garden wall. Blocks movement, PASSES standing LOS.
//   top 2 — rear boundary, churchyard, farm yard, venelle mouth. Blocks both.
// Neither grants cover (D7). A gate is EDGE.DOOR in such a run: canStep passes
// foot through DOOR and blocks vehicles on anything but NONE (map.ts:123-124),
// which is §1.4's asymmetry with no new sim surface.

export const WALL_LOW = 1;
export const WALL_HIGH = 2;

export interface Enclosures {
  walls: number; // free-standing WALL edges written
  gates: number; // DOOR edges punched in them
  // Gardens and yards with no foot route out to a road. A walled garden you
  // cannot reach is not a flanking route, and if a farm cour is orphaned its
  // buildings' doors are unreachable and §5.3's "west reaches every door tile"
  // fails on a map that otherwise looks perfect.
  orphans: number;
  // Gates the churchyard pass itself opened (§1.3 asks for two). Counted rather
  // than inferred from the map: a garden backing onto the enclosure shares its
  // boundary edge, so its own gate reads as a churchyard gate from outside.
  churchGates: number;
  // §1.4's rear network: the widest x-span of garden ground inside one
  // road-free foot component, as a fraction of the envelope width, in Q8.
  rearSpanQ8: number;
  rearConnected: boolean; // rearSpanQ8 >= MIN_REAR_SPAN_Q8
  rerolled: boolean;
}

// §1.4's "end to end on at least one side of the Grande Rue", as a fraction of
// the envelope width in Q8. NOT the whole width, and deliberately not close to
// it: the band is cut by every cross street, and crossing a street on foot is
// legitimate, so a component measured over non-road ground can never span the
// town. Measured over seeds 1-20 at 320x240 the best component spans 112-256
// (median 180). The gate sits at 96 so it catches a regression that COLLAPSES
// the band — walls with no gates, gardens sealed off — rather than grading it.
export const MIN_REAR_SPAN_Q8 = 96;

type EdgeVisit = (ex: number, ey: number, horizontal: boolean, ox: number, oy: number) => void;

// Walk one face of a rect, reporting the grid edge and the tile OUTSIDE it.
function eachFaceEdge(r: Rect, f: Face, visit: EdgeVisit): void {
  if (f === 'n') for (let x = r.x; x < r.x + r.w; x++) visit(x, r.y, true, x, r.y - 1);
  else if (f === 's') for (let x = r.x; x < r.x + r.w; x++) visit(x, r.y + r.h, true, x, r.y + r.h);
  else if (f === 'w') for (let y = r.y; y < r.y + r.h; y++) visit(r.x, y, false, r.x - 1, y);
  else for (let y = r.y; y < r.y + r.h; y++) visit(r.x + r.w, y, false, r.x + r.w, y);
}

const lateralsOf = (f: Face): [Face, Face] => (f === 'n' || f === 's' ? ['w', 'e'] : ['n', 's']);
const opposite = (f: Face): Face => (f === 'n' ? 's' : f === 's' ? 'n' : f === 'e' ? 'w' : 'e');

export function stampEnclosures(map: GameMap, sk: Skeleton, land: Landmarks, fp: Footprints): Enclosures {
  const w = map.w;
  const h = map.h;
  const r10 = sk.S(TAG.ENCLOSURE);
  let walls = 0;
  let gates = 0;

  const inH = (x: number, y: number): boolean => x >= 0 && x < w && y >= 0 && y <= h;
  const inV = (x: number, y: number): boolean => x >= 0 && x <= w && y >= 0 && y < h;

  // A wall lands only on an edge nothing else owns. That single rule is what
  // lets a garden be walled around a rear wing without knowing the wing is
  // there, and what stops a top-1 garden wall overwriting a 2-storey house wall
  // and opening standing LOS straight through the terrace.
  const putWall = (ex: number, ey: number, horizontal: boolean, top: number): boolean => {
    if (horizontal) {
      if (!inH(ex, ey) || map.hEdge(ex, ey) !== EDGE.NONE) return false;
      map.setHEdge(ex, ey, EDGE.WALL);
      map.hEdgeTops[ey * w + ex] = top;
    } else {
      if (!inV(ex, ey) || map.vEdge(ex, ey) !== EDGE.NONE) return false;
      map.setVEdge(ex, ey, EDGE.WALL);
      map.vEdgeTops[ey * (w + 1) + ex] = top;
    }
    walls++;
    return true;
  };

  // A gate replaces a wall WE wrote — never a house wall, and never an edge
  // that was already open (that would be a gate to nowhere and would count a
  // door the renderer then draws gate posts around).
  const ourWall = (t: number): boolean => t === WALL_LOW || t === WALL_HIGH;
  const putGate = (ex: number, ey: number, horizontal: boolean): boolean => {
    if (horizontal) {
      if (!inH(ex, ey) || map.hEdge(ex, ey) !== EDGE.WALL || !ourWall(map.hEdgeTops[ey * w + ex])) return false;
      map.setHEdge(ex, ey, EDGE.DOOR);
      map.hEdgeTops[ey * w + ex] = 0;
    } else {
      if (!inV(ex, ey) || map.vEdge(ex, ey) !== EDGE.WALL || !ourWall(map.vEdgeTops[ey * (w + 1) + ex])) return false;
      map.setVEdge(ex, ey, EDGE.DOOR);
      map.vEdgeTops[ey * (w + 1) + ex] = 0;
    }
    walls--;
    gates++;
    return true;
  };

  // ── garden walls ─────────────────────────────────────────────────────────
  // Which tile belongs to which tail, so a lateral boundary can tell a
  // neighbour's garden (wall it, gate it) from a gap in the frontage (leave it
  // open — a gap in a terrace is exactly where you get into the back gardens,
  // and sealing it makes the whole band unreachable except through a house).
  const tail = new Int32Array(w * h).fill(-1);
  fp.gardens.forEach((g, gi) => {
    for (let y = g.rect.y; y < g.rect.y + g.rect.h; y++)
      for (let x = g.rect.x; x < g.rect.x + g.rect.w; x++)
        if (x >= 0 && y >= 0 && x < w && y < h && !fp.occ[y * w + x]) tail[y * w + x] = gi;
  });

  // Tail depth: distance from street-facing edge to rear, measured along the
  // garden's own depth axis. Used to decide which of two adjacent gardens owns
  // their shared boundary wall.
  const gardenTail = (r: Rect, rear: Face): number =>
    rear === 'n' || rear === 's' ? r.h : r.w;

  // rear gates run on a per-street-run counter, so a terrace gets one back gate
  // every 2-3 houses rather than one per house (§2.2 stage 10)
  const rearCountdown = new Map<number, number>();
  const rearWalls: [number, number, boolean][][] = fp.gardens.map(() => []);

  fp.gardens.forEach((g, gi) => {
    eachFaceEdge(g.rect, g.rear, (ex, ey, horizontal, ox, oy) => {
      const other = ox >= 0 && oy >= 0 && ox < w && oy < h ? tail[oy * w + ox] : -1;
      if (other >= 0 && other !== gi) {
        const dA = gardenTail(g.rect, g.rear);
        const dB = gardenTail(fp.gardens[other].rect, fp.gardens[other].rear);
        if (dA < dB || (dA === dB && gi >= other)) return;
      }
      if (putWall(ex, ey, horizontal, WALL_HIGH)) rearWalls[gi].push([ex, ey, horizontal]);
    });
    for (const lat of lateralsOf(g.front)) {
      const run: [number, number, boolean][] = [];
      const flushRun = (): void => {
        if (run.length === 0) return;
        const mid = run[run.length >> 1];
        putGate(mid[0], mid[1], mid[2]);
        run.length = 0;
      };
      eachFaceEdge(g.rect, lat, (ex, ey, horizontal, ox, oy) => {
        const other = ox >= 0 && oy >= 0 && ox < w && oy < h ? tail[oy * w + ox] : -1;
        if (other < 0 || other === gi) {
          flushRun();
          return;
        }
        // Top 1: a garden wall you can see over but not cross. §1.4's flanking
        // premium is that a squad threading gardens goes single file through
        // gates (doors are orthogonal-only transits, path.ts:107-114) while
        // staying visible to anything upstairs.
        const dA = gardenTail(g.rect, g.rear);
        const dB = gardenTail(fp.gardens[other].rect, fp.gardens[other].rear);
        if (dA < dB || (dA === dB && gi >= other)) { flushRun(); }
        else if (putWall(ex, ey, horizontal, WALL_LOW)) run.push([ex, ey, horizontal]);
        else flushRun();
      });
      flushRun();
    }
    // one gate every 2-3 plots along the rear boundary
    let left = rearCountdown.get(g.runIndex) ?? 0;
    if (left <= 0) {
      gateOneOf(rearWalls[gi]);
      left = 2 + r10.int(2);
    }
    rearCountdown.set(g.runIndex, left - 1);
  });

  // mid-run first, then outward alternately: a gate in the middle of a wall
  // reads as a gate, one in the corner reads as a construction error
  function gateOneOf(list: [number, number, boolean][]): boolean {
    const mid = list.length >> 1;
    for (let k = 0; k < list.length; k++) {
      const i = mid + (k % 2 === 0 ? k >> 1 : -((k + 1) >> 1));
      if (i < 0 || i >= list.length) continue;
      const e = list[i];
      if (putGate(e[0], e[1], e[2])) return true;
    }
    return false;
  }

  // ── venelle mouths ───────────────────────────────────────────────────────
  // A wall across the passage where it meets the street, with one gate in it:
  // infantry-permeable, vehicle-proof, and invisible from the street until you
  // are level with it (§1.3).
  for (const v of fp.venelles) {
    const mouth: [number, number, boolean][] = [];
    eachFaceEdge(v.rect, v.mouth, (ex, ey, horizontal) => {
      if (putWall(ex, ey, horizontal, WALL_HIGH)) mouth.push([ex, ey, horizontal]);
    });
    gateOneOf(mouth);
  }

  // ── farm yards and the civic forecourt ───────────────────────────────────
  // All four faces, because the two-mass yard has buildings on two sides only
  // and a "yard" open on two sides is a field. Every face the buildings already
  // cover is a no-op — putWall refuses an edge that is not NONE.
  const yards: { rect: Rect; faces: Record<Face, [number, number, boolean][]> }[] = [];
  for (const c of fp.compounds) {
    const faces = { n: [], s: [], e: [], w: [] } as Record<Face, [number, number, boolean][]>;
    for (const f of ['n', 's', 'e', 'w'] as Face[])
      eachFaceEdge(c.rect, f, (ex, ey, horizontal) => {
        if (putWall(ex, ey, horizontal, WALL_HIGH)) faces[f].push([ex, ey, horizontal]);
      });
    // the cart gate goes on the open side; if that side turned out to be solid
    // building, any other face will do — a yard with no gate is a sealed farm
    let done = gateOneOf(faces[c.open]);
    if (c.gateWidth === 2 && done) widenGate(faces[c.open]);
    for (const f of [opposite(c.open), ...lateralsOf(c.open)]) if (!done) done = gateOneOf(faces[f]);
    yards.push({ rect: c.rect, faces });
  }

  function widenGate(list: [number, number, boolean][]): void {
    for (let i = 0; i < list.length - 1; i++) {
      const [ex, ey, horizontal] = list[i];
      const open = horizontal ? map.hEdge(ex, ey) === EDGE.DOOR : map.vEdge(ex, ey) === EDGE.DOOR;
      if (open) {
        putGate(list[i + 1][0], list[i + 1][1], list[i + 1][2]);
        return;
      }
    }
  }

  // ── the churchyard wall ──────────────────────────────────────────────────
  // Iterated over the RESERVATION, not over land.churchyard: the chamfer
  // notches inside that rect are not reserved and the place widening may have
  // paved into them, so the rect's perimeter is not the enclosure's.
  const churchWalls: [number, number, boolean, number, number][] = [];
  let churchGates = 0;
  if (land.churchyard) {
    const c = land.churchyard;
    for (let y = c.y; y < c.y + c.h; y++)
      for (let x = c.x; x < c.x + c.w; x++) {
        if (land.resv[y * w + x] !== RESV.CHURCHYARD) continue;
        const probe = (dx: number, dy: number, ex: number, ey: number, horizontal: boolean): void => {
          const ox = x + dx;
          const oy = y + dy;
          if (ox >= 0 && oy >= 0 && ox < w && oy < h && land.resv[oy * w + ox] === RESV.CHURCHYARD) return;
          if (putWall(ex, ey, horizontal, WALL_HIGH)) churchWalls.push([ex, ey, horizontal, ox, oy]);
        };
        probe(0, -1, x, y, true);
        probe(0, 1, x, y + 1, true);
        probe(-1, 0, x, y, false);
        probe(1, 0, x + 1, y, false);
      }
    // Two gates (§1.3): one onto the place, one as far round the wall as the
    // reservation reaches. Both must open onto ROAD — a gate into a hedge is
    // not a way in, and the church's doors are inside this wall.
    const onRoad = churchWalls.filter(([, , , ox, oy]) => ox >= 0 && oy >= 0 && ox < w && oy < h && sk.road[oy * w + ox]);
    const pool = onRoad.length > 0 ? onRoad : churchWalls;
    if (pool.length > 0) {
      let firstI = 0;
      let bestD = Infinity;
      pool.forEach(([, , , ox, oy], i) => {
        const d = Math.max(Math.abs(ox - land.anchor.x), Math.abs(oy - land.anchor.y));
        if (d < bestD) {
          bestD = d;
          firstI = i;
        }
      });
      const first = pool[firstI];
      if (putGate(first[0], first[1], first[2])) churchGates++;
      let secondI = -1;
      let far = -1;
      pool.forEach(([, , , ox, oy], i) => {
        const d = Math.max(Math.abs(ox - first[3]), Math.abs(oy - first[4]));
        if (d > far) {
          far = d;
          secondI = i;
        }
      });
      if (secondI >= 0 && far >= 6 && putGate(pool[secondI][0], pool[secondI][1], pool[secondI][2])) churchGates++;
    }
  }

  // ── wall fragment cleanup (M1) ─────────────────────────────────────────
  // Post-hoc: remove every free-standing wall segment that is neither part
  // of a closed perimeter nor terminated at a building corner. Iterative
  // sweep — deleting a spur exposes the next edge until the chain reaches
  // its building. Deterministic (no RNG).
  const removed = cleanWallFragments(map, w, h);
  walls -= removed;

  // ── connectivity, and the bounded gate reroll ────────────────────────────
  //
  // The property that must hold is not "the gardens look enclosed", it is that
  // every garden, every yard and every building DOOR has a foot route out to a
  // road. A sealed farm cour is a set of buildings whose doors §5.3's
  // west-reaches-every-door-tile check can never reach, on a map that looks
  // perfect from above.
  //
  // The repair is a targeted gate, not a re-siting: an enclosure sealed for
  // topological reasons stays sealed wherever its one gate is moved to. Each
  // round finds, for every stranded component, a wall WE wrote whose other side
  // is road or already road-connected, and opens it. Monotone — it only adds
  // DOOR edges, so nothing reachable can become unreachable — and bounded at
  // two rounds.
  let reach = label();
  let rerolled = false;
  for (let round = 0; round < 2 && reach.orphans > 0; round++) {
    if (!repair(reach)) break;
    rerolled = true;
    reach = label();
  }

  return {
    walls,
    gates,
    orphans: reach.orphans,
    churchGates,
    rearSpanQ8: reach.rearSpanQ8,
    rearConnected: reach.rearSpanQ8 >= MIN_REAR_SPAN_Q8,
    rerolled,
  };

  interface Reach {
    comp: Int32Array;
    touches: boolean[];
    stranded: boolean[]; // per component: cared about, and not road-connected
    orphans: number;
    rearSpanQ8: number;
  }

  // One 4-connected foot flood over the NON-ROAD tiles, recording for each
  // component whether it can step onto a road. Excluding road tiles from the
  // component graph is what makes the span measurement mean "behind the
  // frontage" rather than "down the street and back"; road adjacency is still
  // recorded, so reachability is unaffected.
  function label(): Reach {
    const comp = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    const touches: boolean[] = [];
    const spanLo: number[] = [];
    const spanHi: number[] = [];
    // Passability and the four edge lookups are inlined rather than routed
    // through map.canStep: this flood runs up to three times over 76,800 tiles
    // and the method call plus the TERRAIN object lookup is 5 ms of the 7 it
    // used to cost. Same rule — WALL and WINDOW block, NONE and DOOR pass.
    const pass = new Uint8Array(w * h);
    for (let i = 0; i < pass.length; i++) pass[i] = map.terrainAt(i % w, (i / w) | 0).passable ? 1 : 0;
    const open = (e: number): boolean => e === EDGE.NONE || e === EDGE.DOOR;
    let next = 0;
    for (let start = 0; start < comp.length; start++) {
      if (comp[start] >= 0 || sk.road[start] || !pass[start]) continue;
      const id = next++;
      touches.push(false);
      spanLo.push(w);
      spanHi.push(-1);
      let head = 0;
      let toe = 0;
      comp[start] = id;
      queue[toe++] = start;
      while (head < toe) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur / w) | 0;
        if (tail[cur] >= 0) {
          if (cx < spanLo[id]) spanLo[id] = cx;
          if (cx > spanHi[id]) spanHi[id] = cx;
        }
        const visit = (ni: number, passable: boolean): void => {
          if (!passable || !pass[ni]) return;
          if (sk.road[ni]) {
            touches[id] = true;
            return;
          }
          if (comp[ni] >= 0) return;
          comp[ni] = id;
          queue[toe++] = ni;
        };
        if (cx + 1 < w) visit(cur + 1, open(map.vEdges[cy * (w + 1) + cx + 1]));
        if (cx > 0) visit(cur - 1, open(map.vEdges[cy * (w + 1) + cx]));
        if (cy + 1 < h) visit(cur + w, open(map.hEdges[(cy + 1) * w + cx]));
        if (cy > 0) visit(cur - w, open(map.hEdges[cy * w + cx]));
      }
    }

    const stranded = new Array<boolean>(next).fill(false);
    let orphans = 0;
    const need = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const id = comp[y * w + x];
      if (id < 0 || touches[id]) return;
      stranded[id] = true;
    };
    const reaches = (r: Rect): boolean => {
      let any = false;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const id = comp[y * w + x];
          if (id >= 0 && touches[id]) any = true;
        }
      if (!any) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) need(x, y);
      return any;
    };
    for (const g of fp.gardens) if (!reaches(g.rect)) orphans++;
    for (const y of yards) if (!reaches(y.rect)) orphans++;
    // a door tile is the building's OWN floor tile: reaching it means the house
    // is enterable, which is what validate() asks of every door
    for (const b of fp.buildings) {
      const d = b.doors?.[0];
      if (!d) continue;
      const id = comp[d.y * w + d.x];
      if (id >= 0 && touches[id]) continue;
      need(d.x, d.y);
      orphans++;
    }

    let best = 0;
    for (let id = 0; id < next; id++)
      if (spanHi[id] >= spanLo[id] && touches[id] && spanHi[id] - spanLo[id] > best) best = spanHi[id] - spanLo[id];
    return { comp, touches, stranded, orphans, rearSpanQ8: Math.min(256, ((best * 256) / Math.max(1, sk.env.w)) | 0) };
  }

  // One gate per stranded component, at the lowest edge index that leads
  // somewhere road-connected — deterministic, and it never touches a wall the
  // stamper owns because putGate refuses anything but our own top-1/top-2 WALL.
  function repair(r: Reach): boolean {
    const picked = new Map<number, [number, number, boolean]>();
    const consider = (ex: number, ey: number, horizontal: boolean, ax: number, ay: number, bx: number, by: number): void => {
      const ai = ay * w + ax;
      const bi = by * w + bx;
      const aOut = sk.road[ai] || (r.comp[ai] >= 0 && r.touches[r.comp[ai]]);
      const bOut = sk.road[bi] || (r.comp[bi] >= 0 && r.touches[r.comp[bi]]);
      const aIn = r.comp[ai] >= 0 && r.stranded[r.comp[ai]];
      const bIn = r.comp[bi] >= 0 && r.stranded[r.comp[bi]];
      if (aIn && bOut && !picked.has(r.comp[ai])) picked.set(r.comp[ai], [ex, ey, horizontal]);
      else if (bIn && aOut && !picked.has(r.comp[bi])) picked.set(r.comp[bi], [ex, ey, horizontal]);
    };
    for (let y = 1; y < h; y++)
      for (let x = 0; x < w; x++)
        if (map.hEdge(x, y) === EDGE.WALL && ourWall(map.hEdgeTops[y * w + x])) consider(x, y, true, x, y - 1, x, y);
    for (let y = 0; y < h; y++)
      for (let x = 1; x < w; x++)
        if (map.vEdge(x, y) === EDGE.WALL && ourWall(map.vEdgeTops[y * (w + 1) + x])) consider(x, y, false, x - 1, y, x, y);
    let any = false;
    for (const e of picked.values()) if (putGate(e[0], e[1], e[2])) any = true;
    return any;
  }

  // ── M1 post-hoc wall fragment removal ───────────────────────────────────
  //
  // Every free-standing wall segment must belong to a closed perimeter OR
  // terminate at a building corner / another wall / a gate. An edge whose
  // endpoint has no colinear or perpendicular wall/gate continuation AND no
  // building wall at that vertex is a spur tip — delete it and iterate.
  function cleanWallFragments(map: GameMap, mw: number, mh: number): number {
    const ourT = (t: number): boolean => t === WALL_LOW || t === WALL_HIGH;

    // Our wall/gate at a grid edge. DOOR edges between our walls are gates;
    // building doors are never adjacent to our walls so including all DOOR
    // is safe and keeps wall runs connected through their own gates.
    const ourH = (ex: number, ey: number): boolean => {
      if (ex < 0 || ex >= mw || ey < 0 || ey > mh) return false;
      const e = map.hEdge(ex, ey);
      return e === EDGE.DOOR || (e === EDGE.WALL && ourT(map.hEdgeTops[ey * mw + ex]));
    };
    const ourV = (ex: number, ey: number): boolean => {
      if (ex < 0 || ex > mw || ey < 0 || ey >= mh) return false;
      const e = map.vEdge(ex, ey);
      return e === EDGE.DOOR || (e === EDGE.WALL && ourT(map.vEdgeTops[ey * (mw + 1) + ex]));
    };

    // Building wall at a grid edge (top >= 3, i.e. not WALL_LOW/WALL_HIGH).
    const bldgH = (ex: number, ey: number): boolean => {
      if (ex < 0 || ex >= mw || ey < 0 || ey > mh) return false;
      return map.hEdge(ex, ey) === EDGE.WALL && !ourT(map.hEdgeTops[ey * mw + ex]);
    };
    const bldgV = (ex: number, ey: number): boolean => {
      if (ex < 0 || ex > mw || ey < 0 || ey >= mh) return false;
      return map.vEdge(ex, ey) === EDGE.WALL && !ourT(map.vEdgeTops[ey * (mw + 1) + ex]);
    };

    // A grid vertex (vx, vy) terminates our wall if a building wall or map
    // edge lands on it.
    const vTerm = (vx: number, vy: number): boolean =>
      vx <= 0 || vx >= mw || vy <= 0 || vy >= mh ||
      bldgH(vx - 1, vy) || bldgH(vx, vy) ||
      bldgV(vx, vy - 1) || bldgV(vx, vy);

    // Endpoint connection queries for each wall orientation.
    const hL = (ex: number, ey: number): boolean =>
      vTerm(ex, ey) || ourH(ex - 1, ey) || ourV(ex, ey) || ourV(ex, ey - 1);
    const hR = (ex: number, ey: number): boolean =>
      vTerm(ex + 1, ey) || ourH(ex + 1, ey) || ourV(ex + 1, ey) || ourV(ex + 1, ey - 1);
    const vT = (ex: number, ey: number): boolean =>
      vTerm(ex, ey) || ourV(ex, ey - 1) || ourH(ex - 1, ey) || ourH(ex, ey);
    const vB = (ex: number, ey: number): boolean =>
      vTerm(ex, ey + 1) || ourV(ex, ey + 1) || ourH(ex - 1, ey + 1) || ourH(ex, ey + 1);

    // Collect our-wall edges once, then iteratively filter the live list.
    // This is O(walls * passes) instead of O(total_edges * passes).
    let hLive: [number, number][] = [];
    let vLive: [number, number][] = [];
    for (let ey = 0; ey <= mh; ey++)
      for (let ex = 0; ex < mw; ex++)
        if (map.hEdge(ex, ey) === EDGE.WALL && ourT(map.hEdgeTops[ey * mw + ex]))
          hLive.push([ex, ey]);
    for (let ey = 0; ey < mh; ey++)
      for (let ex = 0; ex <= mw; ex++)
        if (map.vEdge(ex, ey) === EDGE.WALL && ourT(map.vEdgeTops[ey * (mw + 1) + ex]))
          vLive.push([ex, ey]);

    let rem = 0;
    let pass = true;
    while (pass && (hLive.length > 0 || vLive.length > 0)) {
      pass = false;
      const hNext: [number, number][] = [];
      for (const [ex, ey] of hLive) {
        if (map.hEdge(ex, ey) !== EDGE.WALL || !ourT(map.hEdgeTops[ey * mw + ex])) continue;
        if (!hL(ex, ey) || !hR(ex, ey)) {
          map.setHEdge(ex, ey, EDGE.NONE);
          map.hEdgeTops[ey * mw + ex] = 0;
          rem++;
          pass = true;
        } else {
          hNext.push([ex, ey]);
        }
      }
      hLive = hNext;
      const vNext: [number, number][] = [];
      for (const [ex, ey] of vLive) {
        if (map.vEdge(ex, ey) !== EDGE.WALL || !ourT(map.vEdgeTops[ey * (mw + 1) + ex])) continue;
        if (!vT(ex, ey) || !vB(ex, ey)) {
          map.setVEdge(ex, ey, EDGE.NONE);
          map.vEdgeTops[ey * (mw + 1) + ex] = 0;
          rem++;
          pass = true;
        } else {
          vNext.push([ex, ey]);
        }
      }
      vLive = vNext;
    }
    return rem;
  }
}

