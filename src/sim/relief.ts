import type { TerrainKey } from './data';
import { EDGE, GameMap } from './map';
import type { Rng } from './rng';

// Micro-relief: the pure-geometry half of the verticality work (design
// docs/plans/2026-07-26-verticality-design.md §1). Everything here is a
// function over a GameMap plus a profile, a sub-stream and a flatZone
// predicate — no mapgen import, no MapPlan knowledge — so the module is
// unit-testable against hand-built maps before any generator wiring exists.
//
// Determinism: + − × ÷ and Math.round/Math.floor only (no Math.hypot, exp or
// pow — same rule as mapgen.ts). Every draw comes out of a per-tag sub-stream,
// so perturbing one stage provably cannot move another.
//
// Elevation is an integer metre field (GameMap.elev is Uint8Array), so slopes
// are terraces of 1 m per tile and there is no representation for "below
// datum": a cutting is modelled as raised shoulders around a lane left at
// elev 0, never as lowered ground (design H2/H3).

export interface Pt {
  x: number;
  y: number;
}

// undulation is the amplitude in metres, not a flag. hedgeBanks/rail are
// on/off; sunken is how many lane runs get raised shoulders.
export interface ReliefProfile {
  undulation: 0 | 1 | 2;
  hedgeBanks: boolean;
  rail: boolean;
  sunken: 0 | 1 | 2;
}

export const NO_RELIEF: ReliefProfile = { undulation: 0, hedgeBanks: false, rail: false, sunken: 0 };

// True where relief must not touch the ground at all (the bourg envelope).
export type FlatZone = (x: number, y: number) => boolean;

// Everything relief needs to know about the map that is NOT readable off the
// GameMap itself. Plain data + closures: no mapgen types cross this boundary.
export interface ReliefContext {
  crossX: number; // village junction column — the railway stays 40 tiles clear of it
  hamletX?: number; // second hamlet junction (large maps only), 30 tiles of clearance
  nearBuilding: (x: number, y: number) => boolean; // mapgen's own predicate (dome-pass skip set)
  lanes?: readonly (readonly Pt[])[]; // candidate sunken-lane runs, ordered tile lists
  spawns?: { west: Pt; east: Pt }; // vehicle-connectivity check for the embankment revert
}

export interface RailLine {
  railX: number; // seed column of the centreline
  H: number; // crest height, m
  Wt: number; // flat top, tiles
  centreline: Int32Array; // per-row centre column (length map.h)
}

export interface ReliefResult {
  rail: RailLine | null; // null when no candidate column existed, or the carve was reverted
  reverted: boolean; // the embankment cut the vehicle route west→east and was replayed away
  writes: number; // journaled writes surviving in the map (embankment only)
}

// Every embankment write goes through the journal so the whole carve can be
// dropped if it severs the vehicle route (design §1.6): deterministic, bounded,
// zero rng, and it never rerolls a whole map because a decoration cut it in
// half. Each entry snapshots the FULL prior tile state, so replaying the
// entries in reverse restores byte-identical tiles/elev/crossings even when a
// tile was written more than once.
export class ReliefJournal {
  private readonly idx: number[] = [];
  private readonly tile: number[] = [];
  private readonly elev: number[] = [];
  private readonly cross: number[] = [];

  constructor(private readonly map: GameMap) {}

  get length(): number {
    return this.idx.length;
  }

  mark(): number {
    return this.idx.length;
  }

  write(i: number, terrain: TerrainKey | null, elev: number | null, crossing = false): void {
    this.idx.push(i);
    this.tile.push(this.map.tiles[i]);
    this.elev.push(this.map.elev[i]);
    this.cross.push(this.map.crossings[i]);
    if (terrain !== null) this.map.setTerrain(i % this.map.w, (i / this.map.w) | 0, terrain);
    if (elev !== null) this.map.elev[i] = elev < 255 ? elev : 255;
    if (crossing) this.map.crossings[i] = 1;
  }

  revertTo(mark: number): void {
    for (let k = this.idx.length - 1; k >= mark; k--) {
      const i = this.idx[k];
      this.map.tiles[i] = this.tile[k];
      this.map.elev[i] = this.elev[k];
      this.map.crossings[i] = this.cross[k];
    }
    this.idx.length = mark;
    this.tile.length = mark;
    this.elev.length = mark;
    this.cross.length = mark;
  }
}

// R-A · Hedge banks. `hedge` already carries opacity 0.5, coverBehind 0.5 and
// featureHeight 2, so the "hedgerow lip" cover abstraction becomes physically
// true once the hedge stands on a 1 m bank: a prone man (eye 0.4) hugging the
// far side is invisible, a standing one (1.6) is not. Zero draws, one O(w·h)
// pass, no passability change (hedge is already vehicle-blocked).
//
// The shoulder goes up on ONE flank only, so the bank is asymmetric like a real
// Norman one. The design words that as "the side with the lower (x*7919+y) hash
// parity"; PARITY is degenerate here — 7919 is odd, so the two flanks of a
// straight line differ by 2*7919, an even number, and always share a parity.
// The lower hash VALUE is well defined and is what is implemented: west beats
// east, north beats south. A N→S hedge line therefore banks on its west flank
// and a W→E line on its north flank (its west neighbour is the next hedge tile,
// which is not grass/field and is skipped).
export function hedgeBanks(map: GameMap, flatZone: FlatZone): number {
  const { w, h } = map;
  let raised = 0;
  const lift = (x: number, y: number): void => {
    const i = y * w + x;
    if (map.elev[i] < 1) {
      map.elev[i] = 1;
      raised++;
    }
  };
  const shoulder = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h || flatZone(x, y)) return;
    const k = map.terrainKeyAt(x, y);
    if (k === 'grass' || k === 'field') lift(x, y);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (map.terrainKeyAt(x, y) !== 'hedge' || flatZone(x, y)) continue;
      lift(x, y);
      shoulder(x - 1, y);
      shoulder(x, y - 1);
    }
  return raised;
}

// Deterministic bilinear sample of a value lattice. + − × only.
function lerp2(L: Float64Array, nx: number, u: number, v: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const i = y0 * nx + x0;
  const top = L[i] + (L[i + 1] - L[i]) * fx;
  const bot = L[i + nx] + (L[i + nx + 1] - L[i + nx]) * fx;
  return top + (bot - top) * fy;
}

// R-B · Low-frequency undulation: 2-octave integer value noise on lattices of
// 48 and 19 tiles, added UNDER the domes (min 255). The lattice is drawn in
// full before any tile is tested, so the draw count is a pure function of map
// size — a skipped tile never moves the stream.
//
// Skips match the dome pass (road/water/floor, near a building) plus rail, and
// feathers to at most 1 m beside a road or a building floor: a 1 m step at the
// verge is a roadside ditch a prone man can use, a 2 m step there is a wall.
export function undulate(map: GameMap, amp: number, S: Rng, flatZone: FlatZone, nearBuilding: (x: number, y: number) => boolean): void {
  const { w, h } = map;
  const n48x = Math.ceil(w / 48) + 2;
  const n48y = Math.ceil(h / 48) + 2;
  const n19x = Math.ceil(w / 19) + 2;
  const n19y = Math.ceil(h / 19) + 2;
  const L48 = new Float64Array(n48x * n48y);
  for (let i = 0; i < L48.length; i++) L48[i] = S.next();
  const L19 = new Float64Array(n19x * n19y);
  for (let i = 0; i < L19.length; i++) L19[i] = S.next();

  // Feather mask: 1 where an 8-neighbour is road or floor.
  const verge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = map.terrainKeyAt(x, y);
      if (k !== 'road' && k !== 'floor') continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) verge[ny * w + nx] = 1;
        }
    }

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (flatZone(x, y)) continue;
      const k = map.terrainKeyAt(x, y);
      if (k === 'road' || k === 'water' || k === 'floor' || k === 'rail') continue;
      if (nearBuilding(x, y)) continue;
      const i = y * w + x;
      let u = Math.round(amp * (0.7 * lerp2(L48, n48x, x / 48, y / 48) + 0.3 * lerp2(L19, n19x, x / 19, y / 19)));
      if (verge[i] === 1 && u > 1) u = 1;
      if (u <= 0) continue;
      const e = map.elev[i] + u;
      map.elev[i] = e < 255 ? e : 255;
    }
}

// R-D · Sunken lanes (H2: raised shoulders, the lane itself left at elev 0).
// A run is an ordered tile list — mapgen's farm lanes are the natural input.
// bank is vehicle-impassable, so a sunken lane is an infantry highway armour
// can neither follow nor fire into: the bocage asymmetry, outside the town.
//
// The shoulder is raised with max(), never set: the lane may run across ground
// the undulation pass already lifted, and lowering it would dig a hole into the
// hillside rather than throw up a bank.
export function sunkenLane(map: GameMap, run: readonly Pt[], Hs: number, flatZone: FlatZone): void {
  if (run.length < 2 || Hs < 1) return;
  const { w, h } = map;
  // One perpendicular for the whole run: mapgen's lanes are straight column or
  // row segments, and a per-tile normal would fray the shoulder at every kink.
  const span = { x: run[run.length - 1].x - run[0].x, y: run[run.length - 1].y - run[0].y };
  const vertical = Math.abs(span.y) >= Math.abs(span.x);
  const px = vertical ? 1 : 0;
  const py = vertical ? 0 : 1;
  for (const t of run) {
    for (let s = -1; s <= 1; s += 2)
      for (let k = 1; k <= Hs; k++) {
        const x = t.x + px * s * k;
        const y = t.y + py * s * k;
        if (x < 0 || y < 0 || x >= w || y >= h || flatZone(x, y)) continue;
        const key = map.terrainKeyAt(x, y);
        if (key === 'road' || key === 'water' || key === 'floor' || key === 'rail') continue;
        const i = y * w + x;
        const e = Hs + 1 - k;
        if (map.elev[i] < e) map.elev[i] = e;
        if (key !== 'hedge') map.setTerrain(x, y, 'bank');
      }
  }
}

// The farm-track inventory R-D consumes. Both generators carve their lanes as
// 1-tile-wide road into open country — mapgen's compound lane (mapgen.ts, the
// outlying-farm loop) and the bourg's space-colonisation tracks (rural.ts
// growFarmLanes) — and neither keeps a tile list, so the runs are recovered off
// the FINISHED map by one rule: a road tile whose two perpendicular neighbours
// are not road. The arterial (3 wide), the cross lane (2 wide) and every town
// street therefore fail it by construction, which is exactly the intent — a
// sunken high street would wall the map off.
//
// A dogleg's corner tile fails the rule on both axes, so a bent track comes out
// as its two straight legs. That matters: sunkenLane takes ONE perpendicular
// per run and would fray a shoulder across a kink.
export function laneRuns(map: GameMap, flatZone: FlatZone, minLen = 8): Pt[][] {
  const { w, h } = map;
  const road = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && map.terrainKeyAt(x, y) === 'road';
  const runs: Pt[][] = [];
  const sweep = (n: number, m: number, at: (a: number, b: number) => Pt, thin: (p: Pt) => boolean): void => {
    for (let a = 0; a < n; a++) {
      let run: Pt[] = [];
      for (let b = 0; b <= m; b++) {
        const p = b < m ? at(a, b) : null;
        if (p && road(p.x, p.y) && thin(p) && !flatZone(p.x, p.y)) {
          run.push(p);
          continue;
        }
        if (run.length >= minLen) runs.push(run);
        run = [];
      }
    }
  };
  sweep(w, h, (x, y) => ({ x, y }), (p) => !road(p.x - 1, p.y) && !road(p.x + 1, p.y));
  sweep(h, w, (y, x) => ({ x, y }), (p) => !road(p.x, p.y - 1) && !road(p.x, p.y + 1));
  return runs;
}

// Flood fill from `from` to `to` over canStep(..., 'vehicle'). 4-neighbour,
// bounded by the tile count, no allocation per step beyond one queue.
export function vehicleReaches(map: GameMap, from: Pt, to: Pt): boolean {
  const { w, h } = map;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const tx = Math.floor(to.x);
  const ty = Math.floor(to.y);
  if (!map.inBounds(sx, sy) || !map.inBounds(tx, ty)) return false;
  if (sx === tx && sy === ty) return true;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = sy * w + sx;
  seen[sy * w + sx] = 1;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j] || !map.canStep(x, y, nx, ny, 'vehicle')) continue;
      if (nx === tx && ny === ty) return true;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  return false;
}

// R-C · The linear embankment that carries the railway. Perpendicular to the
// west→east arterial, so a level crossing is guaranteed; the road wins the tile
// at the crossing (terrain stays 'road', map.crossings records the overlap for
// the renderer) but still climbs the terrace, or the crossing would be a 3 m
// cliff. Returns null when no column qualifies — deterministic, never a reroll.
export function embankment(
  map: GameMap,
  S: Rng,
  flatZone: FlatZone,
  ctx: ReliefContext,
  journal: ReliefJournal,
): { rail: RailLine | null; reverted: boolean } {
  const { w, h } = map;
  const H = 2 + S.int(2); // 2..3 m crest
  const Wt = 3 + S.int(2); // 3..4 tile flat top
  const pad = H + Wt; // conservative column band: footprint half-width + the ±2 wander
  if (w < 2 * pad + 26 || h < 8) return { rail: null, reverted: false };

  // A column is unusable if it holds water (no rail bridges), a building floor,
  // or any flatZone tile. Dilated by 1 to match "building rects inflated by 1".
  const raw = new Uint8Array(w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (raw[x]) continue;
      const k = map.terrainKeyAt(x, y);
      if (k === 'water' || k === 'floor' || flatZone(x, y)) raw[x] = 1;
    }
  const blocked = new Uint8Array(w);
  for (let x = 0; x < w; x++)
    if (raw[x]) {
      blocked[x] = 1;
      if (x > 0) blocked[x - 1] = 1;
      if (x + 1 < w) blocked[x + 1] = 1;
    }
  // prefix[x] = blocked columns strictly left of x, so a band test is O(1).
  const prefix = new Int32Array(w + 1);
  for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + blocked[x];

  const candidates: number[] = [];
  for (let x = 12; x <= w - 12; x++) {
    if (x - pad < 0 || x + pad >= w) continue;
    if (Math.abs(x - ctx.crossX) < 40) continue;
    if (ctx.hamletX !== undefined && Math.abs(x - ctx.hamletX) < 30) continue;
    if (prefix[x + pad + 1] - prefix[x - pad] > 0) continue;
    candidates.push(x);
  }
  if (candidates.length === 0) return { rail: null, reverted: false }; // never draw int(0) — rng.int(0) still burns a draw
  const railX = candidates[S.int(candidates.length)];

  const mark = journal.mark();
  const centreline = new Int32Array(h);
  const half = (Wt - 1) >> 1; // top spans [cx-half, cx-half+Wt-1]
  let cx = railX;
  for (let y = 0; y < h; y++) {
    centreline[y] = cx;
    const left = cx - half;
    const right = left + Wt - 1;
    for (let x = left; x <= right; x++) carve(map, journal, x, y, H, 'rail');
    for (let k = 1; k < H; k++) {
      carve(map, journal, left - k, y, H - k, 'bank');
      carve(map, journal, right + k, y, H - k, 'bank');
    }
    // A railway is straighter than the arterial (which wanders at p=0.18 per
    // column): p=0.08 per row, and clamped to ±2 of the seed column so the
    // carve provably stays inside the band the candidate test cleared.
    if (S.next() < 0.08) {
      const step = S.next() < 0.5 ? -1 : 1;
      const nx = cx + step;
      if (nx >= railX - 2 && nx <= railX + 2) cx = nx;
    }
  }

  if (ctx.spawns && !vehicleReaches(map, ctx.spawns.west, ctx.spawns.east)) {
    journal.revertTo(mark);
    return { rail: null, reverted: true };
  }
  return { rail: { railX, H, Wt, centreline }, reverted: false };
}

// One tile of the embankment cross-section. Road wins the tile — it keeps its
// terrain and becomes a level crossing — but takes the terrace elevation
// anyway, which is the one place relief deliberately departs from the dome
// pass's unconditional road skip (design §2.2).
function carve(map: GameMap, journal: ReliefJournal, x: number, y: number, elev: number, key: 'rail' | 'bank'): void {
  if (!map.inBounds(x, y)) return;
  const i = y * map.w + x;
  if (map.terrainKeyAt(x, y) === 'road') journal.write(i, null, elev, true);
  else journal.write(i, key, elev);
}

// The whole stage, in the order the geometry requires:
//   undulation (additive swell) → hedge banks (max 1 m) → sunken lanes (max
//   shoulders) → embankment (ABSOLUTE terrace, journaled, revertible).
// The embankment writes absolute elevations, so it must run last or the terrace
// invariant (every bank tile exactly 1 m below its inward neighbour) would be
// broken by a later additive pass.
export function applyRelief(map: GameMap, profile: ReliefProfile, S: (tag: number) => Rng, flatZone: FlatZone, ctx: ReliefContext): ReliefResult {
  const journal = new ReliefJournal(map);
  if (profile.undulation > 0) undulate(map, profile.undulation, S(20), flatZone, ctx.nearBuilding);
  if (profile.hedgeBanks) hedgeBanks(map, flatZone);
  if (profile.sunken > 0 && ctx.lanes && ctx.lanes.length > 0) {
    const s22 = S(22);
    const pool = ctx.lanes.slice();
    for (let n = 0; n < profile.sunken && pool.length > 0; n++) {
      const run = pool.splice(s22.int(pool.length), 1)[0];
      sunkenLane(map, run, 1 + s22.int(2), flatZone);
    }
  }
  let rail: RailLine | null = null;
  let reverted = false;
  if (profile.rail) ({ rail, reverted } = embankment(map, S(21), flatZone, ctx, journal));
  return { rail, reverted, writes: journal.length };
}

// ── V5 · the halt / station (design §2.4) ───────────────────────────────────
//
// A 7x4 structure on the town side of the embankment toe, a 2x10 road platform
// deck laid on the flank at crest-minus-one, and the platform centre as an
// objective. The whole thing is optional by construction: no candidate band, no
// halt, and nothing downstream depends on one existing.

const HALT_W = 7;
const HALT_H = 4;
const PLATFORM_LEN = 10;
const PLATFORM_W = 2;
// Columns from the crest edge to the building's near face. The platform owns
// offsets 1..PLATFORM_W and stampHalt levels a 1-tile border around the rect,
// so the building has to start at PLATFORM_W + 2 or the levelling pass would
// flatten the platform deck it just laid.
const HALT_GAP = PLATFORM_W + 2;

export interface Halt {
  rect: { x: number; y: number; w: number; h: number }; // the structure's mass
  platform: Pt[]; // deck tiles, written as road at platformElev
  platformElev: number; // H - 1: a platform is level with the carriage floor
  centre: Pt; // deck centre — the objective candidate
  side: -1 | 1; // -1 = the town lies west of the line, +1 = east
}

// Enumerate-then-draw, exactly as the railX selection does: every 10-row band
// is tested, the qualifying starts are collected, and ONE draw picks among
// them. An empty list returns null without touching the stream — S.int(0) still
// burns a draw (rng.ts).
export function planHalt(map: GameMap, rail: RailLine, townX: number, S: Rng, flatZone: FlatZone): Halt | null {
  const { w, h } = map;
  const { H, Wt, centreline } = rail;
  const half = (Wt - 1) >> 1;
  const side: -1 | 1 = townX < rail.railX ? -1 : 1;
  // The column `off` tiles outboard of the crest edge, on the town side.
  const col = (y: number, off: number): number => {
    const left = centreline[y] - half;
    return side < 0 ? left - off : left + Wt - 1 + off;
  };
  const clear = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return false;
    if (flatZone(x, y) || map.buildingId[y * w + x] >= 0) return false;
    const k = map.terrainKeyAt(x, y);
    // road excludes the level crossing (a platform across the arterial is a
    // level crossing with a building on it); water/floor exclude anything the
    // embankment's column test somehow let through.
    return k !== 'road' && k !== 'water' && k !== 'floor';
  };
  const openEdges = (x: number, y: number): boolean =>
    map.hEdge(x, y) === EDGE.NONE &&
    map.hEdge(x, y + 1) === EDGE.NONE &&
    map.vEdge(x, y) === EDGE.NONE &&
    map.vEdge(x + 1, y) === EDGE.NONE;

  // The rect hangs off the band's OUTERMOST gap column, so the wander (±2) can
  // never push a platform tile into the building or its levelled border.
  const rectX = (y0: number): number => {
    let edge = col(y0, HALT_GAP);
    for (let y = y0; y < y0 + PLATFORM_LEN; y++) {
      const c = col(y, HALT_GAP);
      if (side < 0 ? c < edge : c > edge) edge = c;
    }
    return side < 0 ? edge - HALT_W + 1 : edge;
  };

  const fits = (y0: number): boolean => {
    for (let y = y0; y < y0 + PLATFORM_LEN; y++)
      for (let k = 1; k <= PLATFORM_W; k++) {
        const x = col(y, k);
        if (!clear(x, y) || map.crossings[y * w + x] === 1) return false;
      }
    const rx = rectX(y0);
    const ry = y0 + ((PLATFORM_LEN - HALT_H) >> 1);
    for (let y = ry - 1; y <= ry + HALT_H; y++)
      for (let x = rx - 1; x <= rx + HALT_W; x++) {
        if (!clear(x, y) || !openEdges(x, y)) return false;
        const k = map.terrainKeyAt(x, y);
        if (k === 'bank' || k === 'rail') return false; // keep the mass off the batter
      }
    return true;
  };

  const candidates: number[] = [];
  for (let y0 = 1; y0 + PLATFORM_LEN < h - 1; y0++) if (fits(y0)) candidates.push(y0);
  if (candidates.length === 0) return null;
  const y0 = candidates[S.int(candidates.length)];

  const platform: Pt[] = [];
  for (let y = y0; y < y0 + PLATFORM_LEN; y++)
    for (let k = 1; k <= PLATFORM_W; k++) platform.push({ x: col(y, k), y });
  const cy = y0 + (PLATFORM_LEN >> 1);
  return {
    rect: { x: rectX(y0), y: y0 + ((PLATFORM_LEN - HALT_H) >> 1), w: HALT_W, h: HALT_H },
    platform,
    platformElev: H - 1,
    centre: { x: col(cy, 1), y: cy },
    side,
  };
}

// Write the halt's GROUND: the deck, and a level forecourt under the mass.
// The structure itself is stamped by the caller (stampStructure is bourg
// vocabulary and relief.ts knows nothing about Buildings).
//
// The levelling is not cosmetic. Every other building on the map predates the
// elevation passes and is skipped by them (mapgen's dome pass and undulate both
// honour nearBuilding), so no legacy floor slab straddles an elevation step.
// The halt is placed after undulation ran over ground it did not yet own, so
// without this its four floor tiles could sit on three different heights — an
// LOS anomaly inside the one structure §2.4 calls a strongpoint.
export function stampHalt(map: GameMap, halt: Halt): void {
  const { w } = map;
  for (const p of halt.platform) {
    map.setTerrain(p.x, p.y, 'road');
    map.elev[p.y * w + p.x] = halt.platformElev < 255 ? halt.platformElev : 255;
  }
  const { x, y, w: rw, h: rh } = halt.rect;
  let e = 255;
  for (let yy = y - 1; yy <= y + rh; yy++)
    for (let xx = x - 1; xx <= x + rw; xx++) {
      if (!map.inBounds(xx, yy)) continue;
      const v = map.elev[yy * w + xx];
      if (v < e) e = v;
    }
  for (let yy = y - 1; yy <= y + rh; yy++)
    for (let xx = x - 1; xx <= x + rw; xx++) if (map.inBounds(xx, yy)) map.elev[yy * w + xx] = e;
}
