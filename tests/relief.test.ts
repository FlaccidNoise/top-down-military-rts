import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import {
  applyRelief,
  embankment,
  hedgeBanks,
  NO_RELIEF,
  ReliefJournal,
  sunkenLane,
  vehicleReaches,
  type ReliefContext,
  type ReliefProfile,
} from '../src/sim/relief';
import { mulberry32, type Rng } from '../src/sim/rng';

// V2: relief.ts is pure geometry over a hand-built GameMap — no mapgen, no
// MapPlan. This is where a bug silently corrupts elevation across the whole
// map, so every element is tested standalone before any generator wiring
// exists (V3). Nothing in this file touches generateMap.

function zeroWt(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h);
}

function townMask(w: number, h: number, pred: (x: number, y: number) => boolean): Uint8Array {
  const tw = new Uint8Array(w * h);
  for (let y = 0, i = 0; y < h; y++)
    for (let x = 0; x < w; x++, i++)
      if (pred(x, y)) tw[i] = 255;
  return tw;
}

function subStreams(base: number): (tag: number) => Rng {
  return (tag) => mulberry32((base ^ Math.imul(tag, 0x9e3779b1)) >>> 0);
}

function countingRng(inner: Rng): { rng: Rng; draws: () => number } {
  let n = 0;
  return {
    rng: {
      next: () => {
        n++;
        return inner.next();
      },
      range: (a, b) => a + inner.next() * (b - a),
      int: (k) => {
        n++;
        return Math.floor(inner.next() * k);
      },
    },
    draws: () => n,
  };
}

function snap(map: GameMap): string {
  return `${map.tiles.join(',')}|${map.elev.join(',')}|${map.crossings.join(',')}`;
}

// A 320x240 map shaped like a generated one: a 3-tile arterial across the
// middle, a water column in the west, a building block, and two hedge lines.
function stagedMap(): GameMap {
  const map = new GameMap(320, 240);
  // water first, then the arterial over it — mapgen's order, so the crossing
  // tiles are road-with-bridges rather than an impassable water plug
  for (let y = 0; y < 240; y++) for (let dx = 0; dx < 3; dx++) map.setTerrain(40 + dx, y, 'water');
  for (let x = 0; x < 320; x++)
    for (let dy = -1; dy <= 1; dy++) {
      if (map.terrainKeyAt(x, 120 + dy) === 'water') map.bridges[(120 + dy) * 320 + x] = 1;
      map.setTerrain(x, 120 + dy, 'road');
    }
  for (let y = 60; y < 68; y++) for (let x = 150; x < 160; x++) map.setTerrain(x, y, 'floor');
  // hedges only on grass, like the generator's bocage — a hedge across the
  // arterial would wall the map off for vehicles all by itself
  const hedge = (x: number, y: number) => {
    if (map.terrainKeyAt(x, y) === 'grass') map.setTerrain(x, y, 'hedge');
  };
  for (let y = 0; y < 240; y++) hedge(200, y);
  for (let x = 220; x < 300; x++) hedge(x, 40);
  return map;
}

const stagedCtx: ReliefContext = {
  crossX: 160,
  spawns: { west: { x: 3, y: 120 }, east: { x: 316, y: 120 } },
};

describe('R-A hedge banks', () => {
  it('lifts every hedge tile to 1 m and banks exactly one flank', () => {
    const map = new GameMap(12, 12);
    for (let y = 2; y < 10; y++) map.setTerrain(6, y, 'hedge');
    hedgeBanks(map, zeroWt(map.w, map.h));
    for (let y = 2; y < 10; y++) {
      expect(map.elevAt(6, y), `hedge (6,${y})`).toBe(1);
      expect(map.elevAt(5, y), `west shoulder (5,${y})`).toBe(1);
      expect(map.elevAt(7, y), `east flank must stay flat (7,${y})`).toBe(0);
    }
  });

  it('a W→E line banks its north flank (its west neighbour is the next hedge tile)', () => {
    const map = new GameMap(12, 12);
    for (let x = 2; x < 10; x++) map.setTerrain(x, 6, 'hedge');
    hedgeBanks(map, zeroWt(map.w, map.h));
    for (let x = 3; x < 10; x++) {
      expect(map.elevAt(x, 5), `north shoulder (${x},5)`).toBe(1);
      expect(map.elevAt(x, 7), `south flank (${x},7)`).toBe(0);
    }
  });

  it('shoulders only grass and field, never road/water/floor/hedge', () => {
    const map = new GameMap(12, 12);
    map.setTerrain(6, 6, 'hedge');
    map.setTerrain(5, 6, 'road');
    map.setTerrain(6, 5, 'field');
    hedgeBanks(map, zeroWt(map.w, map.h));
    expect(map.elevAt(6, 6)).toBe(1);
    expect(map.elevAt(5, 6)).toBe(0); // road untouched
    expect(map.elevAt(6, 5)).toBe(1); // field takes the bank
  });

  it('never lowers ground that is already higher', () => {
    const map = new GameMap(12, 12);
    map.setTerrain(6, 6, 'hedge');
    map.elev[6 * 12 + 6] = 4;
    map.elev[6 * 12 + 5] = 3;
    hedgeBanks(map, zeroWt(map.w, map.h));
    expect(map.elevAt(6, 6)).toBe(4);
    expect(map.elevAt(5, 6)).toBe(3);
  });

  it('skips the flat zone entirely', () => {
    const map = new GameMap(12, 12);
    for (let y = 2; y < 10; y++) map.setTerrain(6, y, 'hedge');
    hedgeBanks(map, townMask(map.w, map.h, (x, y) => y >= 5 && y < 8));
    expect(map.elevAt(6, 4)).toBe(1);
    expect(map.elevAt(6, 6)).toBe(0);
    expect(map.elevAt(5, 6)).toBe(0);
  });

  it('draws nothing (zero rng, one pass)', () => {
    const map = stagedMap();
    const before = snap(map);
    hedgeBanks(map, zeroWt(map.w, map.h));
    expect(snap(map)).not.toBe(before); // it did something...
    const again = new GameMap(320, 240);
    expect(again.elev.some((v) => v !== 0)).toBe(false); // ...without a stream to perturb
  });
});

describe('R-D sunken lanes', () => {
  it('raises a terraced shoulder on both flanks and leaves the lane at elev 0', () => {
    const map = new GameMap(30, 30);
    const run: { x: number; y: number }[] = [];
    for (let y = 5; y < 25; y++) {
      map.setTerrain(15, y, 'road');
      run.push({ x: 15, y });
    }
    sunkenLane(map, run, 2, zeroWt(map.w, map.h));
    for (let y = 6; y < 24; y++) {
      expect(map.elevAt(15, y), 'the lane itself').toBe(0);
      expect(map.elevAt(14, y)).toBe(2);
      expect(map.elevAt(13, y)).toBe(1);
      expect(map.elevAt(16, y)).toBe(2);
      expect(map.elevAt(17, y)).toBe(1);
      expect(map.terrainKeyAt(14, y)).toBe('bank');
      expect(map.terrainKeyAt(17, y)).toBe('bank');
    }
  });

  it('a bank shoulder is vehicle-impassable but infantry scramble it', () => {
    const map = new GameMap(30, 30);
    const run = Array.from({ length: 30 }, (_, i) => ({ x: 15, y: i }));
    for (const t of run) map.setTerrain(t.x, t.y, 'road');
    sunkenLane(map, run, 1, zeroWt(map.w, map.h));
    expect(map.canStep(13, 15, 14, 15, 'vehicle')).toBe(false);
    expect(map.canStep(13, 15, 14, 15, 'foot')).toBe(true);
    // the point of the feature: armour can neither follow the lane nor cross it
    expect(vehicleReaches(map, { x: 5, y: 15 }, { x: 15, y: 15 })).toBe(false);
    expect(vehicleReaches(map, { x: 5, y: 15 }, { x: 25, y: 15 })).toBe(false);
  });

  it('never overwrites road, water or floor, and never lowers ground', () => {
    const map = new GameMap(30, 30);
    const run = Array.from({ length: 20 }, (_, i) => ({ x: 15, y: 5 + i }));
    for (const t of run) map.setTerrain(t.x, t.y, 'road');
    map.setTerrain(14, 10, 'water');
    map.setTerrain(16, 11, 'floor');
    map.elev[12 * 30 + 14] = 6;
    sunkenLane(map, run, 2, zeroWt(map.w, map.h));
    expect(map.terrainKeyAt(14, 10)).toBe('water');
    expect(map.elevAt(14, 10)).toBe(0);
    expect(map.terrainKeyAt(16, 11)).toBe('floor');
    expect(map.elevAt(14, 12)).toBe(6);
  });

  it('picks the perpendicular from the run direction', () => {
    const map = new GameMap(30, 30);
    const run = Array.from({ length: 20 }, (_, i) => ({ x: 5 + i, y: 15 }));
    for (const t of run) map.setTerrain(t.x, t.y, 'road');
    sunkenLane(map, run, 1, zeroWt(map.w, map.h));
    expect(map.elevAt(10, 14)).toBe(1);
    expect(map.elevAt(10, 16)).toBe(1);
    expect(map.elevAt(10, 15)).toBe(0);
  });
});

describe('R-C embankment', () => {
  const carve = (seedTag: number, map = stagedMap(), ctx = stagedCtx) => {
    const journal = new ReliefJournal(map);
    const out = embankment(map, mulberry32(seedTag), zeroWt(map.w, map.h), ctx, journal);
    return { map, journal, ...out };
  };

  it('carves a rail crest at elev H with bank batter stepping down 1 m per tile', () => {
    const { map, rail } = carve(5);
    expect(rail).not.toBeNull();
    const { H, Wt, centreline } = rail!;
    expect(H).toBeGreaterThanOrEqual(2);
    expect(H).toBeLessThanOrEqual(3);
    expect(Wt).toBeGreaterThanOrEqual(3);
    expect(Wt).toBeLessThanOrEqual(4);
    const half = (Wt - 1) >> 1;
    for (let y = 0; y < 240; y++) {
      const cx = centreline[y];
      const left = cx - half;
      const right = left + Wt - 1;
      for (let x = left; x <= right; x++) {
        if (map.terrainKeyAt(x, y) === 'road') continue; // the level crossing
        expect(map.terrainKeyAt(x, y), `crest (${x},${y})`).toBe('rail');
        expect(map.elevAt(x, y), `crest elev (${x},${y})`).toBe(H);
      }
      for (let k = 1; k < H; k++) {
        for (const x of [left - k, right + k]) {
          if (map.terrainKeyAt(x, y) === 'road') continue;
          expect(map.terrainKeyAt(x, y), `batter (${x},${y})`).toBe('bank');
          expect(map.elevAt(x, y), `batter elev (${x},${y})`).toBe(H - k);
        }
      }
      // the toe: one tile past the last batter step is untouched ground
      expect(map.terrainKeyAt(left - H, y)).not.toBe('bank');
      expect(map.terrainKeyAt(right + H, y)).not.toBe('bank');
    }
  });

  it('no elev step greater than 1 anywhere along the crest (the taper invariant)', () => {
    const { map, rail } = carve(5);
    const { centreline } = rail!;
    for (let y = 1; y < 240; y++) {
      expect(Math.abs(centreline[y] - centreline[y - 1])).toBeLessThanOrEqual(1);
      const a = map.elevAt(centreline[y - 1], y - 1);
      const b = map.elevAt(centreline[y], y);
      expect(Math.abs(a - b), `crest step at y=${y}`).toBeLessThanOrEqual(1);
    }
  });

  it('the centreline never leaves the cleared band', () => {
    const { rail } = carve(5);
    for (const cx of rail!.centreline) expect(Math.abs(cx - rail!.railX)).toBeLessThanOrEqual(2);
  });

  it('the road wins the level crossing: terrain stays road, crossings marks it, elev climbs the terrace', () => {
    const { map, rail } = carve(5);
    const { H, Wt, centreline } = rail!;
    const half = (Wt - 1) >> 1;
    let crossings = 0;
    for (let y = 119; y <= 121; y++) {
      const cx = centreline[y];
      for (let x = cx - half; x < cx - half + Wt; x++) {
        expect(map.terrainKeyAt(x, y)).toBe('road');
        expect(map.isCrossing(x, y)).toBe(true);
        expect(map.elevAt(x, y)).toBe(H);
        expect(map.canStep(x - 1, y, x, y, 'vehicle')).toBe(true);
        crossings++;
      }
    }
    expect(crossings).toBeGreaterThan(0);
    // and nothing outside the footprint was marked
    let marked = 0;
    for (let i = 0; i < map.crossings.length; i++) if (map.crossings[i]) marked++;
    expect(marked).toBe(3 * (Wt + 2 * (H - 1)));
  });

  it('no crossing tile is a bridge tile and no rail tile touches water', () => {
    const { map } = carve(5);
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++) {
        if (map.isCrossing(x, y)) expect(map.isBridge(x, y)).toBe(false);
        if (map.terrainKeyAt(x, y) !== 'rail') continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          expect(map.terrainKeyAt(x + dx, y + dy), `rail beside water at ${x},${y}`).not.toBe('water');
      }
  });

  it('keeps 40 tiles clear of the junction and 30 of the second hamlet', () => {
    for (let seed = 1; seed < 12; seed++) {
      const { rail } = carve(seed, stagedMap(), { ...stagedCtx, hamletX: 60 });
      if (!rail) continue;
      expect(Math.abs(rail.railX - 160), `seed ${seed}`).toBeGreaterThanOrEqual(40);
      expect(Math.abs(rail.railX - 60), `seed ${seed}`).toBeGreaterThanOrEqual(30);
    }
  });

  it('returns null without burning a draw when no column qualifies', () => {
    const map = new GameMap(320, 240);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) map.setTerrain(x, y, 'water');
    const counted = countingRng(mulberry32(5));
    const out = embankment(map, counted.rng, zeroWt(map.w, map.h), stagedCtx, new ReliefJournal(map));
    expect(out.rail).toBeNull();
    expect(out.reverted).toBe(false);
    expect(counted.draws()).toBe(2); // H and Wt only — never int(0) on an empty candidate list
    expect(map.elev.some((v) => v !== 0)).toBe(false);
  });

  it('is skipped on a map too small to hold a footprint', () => {
    const small = new GameMap(60, 40);
    const out = embankment(small, mulberry32(5), zeroWt(small.w, small.h), { crossX: 30 }, new ReliefJournal(small));
    expect(out.rail).toBeNull();
    expect(snap(small)).toBe(snap(new GameMap(60, 40)));
  });

  it('reverts byte-identically when the carve severs the vehicle route', () => {
    const map = stagedMap();
    // seal every level crossing: with the arterial fenced off, the embankment
    // is the only thing standing between west and east spawns
    for (let x = 0; x < 320; x++) for (let dy = -1; dy <= 1; dy++) map.setTerrain(x, 120 + dy, 'grass');
    const before = snap(map);
    const journal = new ReliefJournal(map);
    const out = embankment(map, mulberry32(5), zeroWt(map.w, map.h), stagedCtx, journal);
    expect(out.rail).toBeNull();
    expect(out.reverted).toBe(true);
    expect(snap(map)).toBe(before);
    expect(journal.length).toBe(0);
  });

  it('keeps the carve when the arterial crossing preserves the route', () => {
    const { map, rail, reverted } = carve(5);
    expect(reverted).toBe(false);
    expect(rail).not.toBeNull();
    expect(vehicleReaches(map, { x: 3, y: 120 }, { x: 316, y: 120 })).toBe(true);
  });
});

describe('the write journal', () => {
  it('restores byte-identical state even when a tile is written twice', () => {
    const map = stagedMap();
    const before = snap(map);
    const j = new ReliefJournal(map);
    const mark = j.mark();
    j.write(50 * 320 + 50, 'bank', 3);
    j.write(50 * 320 + 50, 'rail', 7);
    j.write(120 * 320 + 90, null, 2, true);
    expect(map.terrainKeyAt(50, 50)).toBe('rail');
    expect(map.isCrossing(90, 120)).toBe(true);
    j.revertTo(mark);
    expect(snap(map)).toBe(before);
  });

  it('reverts only back to the mark', () => {
    const map = new GameMap(20, 20);
    const j = new ReliefJournal(map);
    j.write(5, 'bank', 1);
    const mark = j.mark();
    j.write(6, 'rail', 2);
    j.revertTo(mark);
    expect(map.terrainKeyAt(5, 0)).toBe('bank');
    expect(map.terrainKeyAt(6, 0)).toBe('grass');
  });
});

describe('vehicleReaches', () => {
  it('sees a bank wall and the gap in it', () => {
    const map = new GameMap(40, 20);
    for (let y = 0; y < 20; y++) map.setTerrain(20, y, 'bank');
    expect(vehicleReaches(map, { x: 2, y: 10 }, { x: 37, y: 10 })).toBe(false);
    map.setTerrain(20, 10, 'road');
    expect(vehicleReaches(map, { x: 2, y: 10 }, { x: 37, y: 10 })).toBe(true);
  });
});

describe('applyRelief', () => {
  const profile: ReliefProfile = { hedgeBanks: true, rail: true, sunken: 2 };
  const lanes = [
    Array.from({ length: 20 }, (_, i) => ({ x: 250, y: 150 + i })),
    Array.from({ length: 20 }, (_, i) => ({ x: 270, y: 150 + i })),
    Array.from({ length: 20 }, (_, i) => ({ x: 290, y: 150 + i })),
  ];

  it('the null profile is inert', () => {
    const map = stagedMap();
    const before = snap(map);
    const out = applyRelief(map, NO_RELIEF, subStreams(1234), zeroWt(map.w, map.h), stagedCtx);
    expect(out.rail).toBeNull();
    expect(snap(map)).toBe(before);
  });

  it('is deterministic for a given base seed', () => {
    const a = stagedMap();
    const b = stagedMap();
    applyRelief(a, profile, subStreams(1234), zeroWt(a.w, a.h), { ...stagedCtx, lanes });
    applyRelief(b, profile, subStreams(1234), zeroWt(b.w, b.h), { ...stagedCtx, lanes });
    expect(snap(a)).toBe(snap(b));
  });

  it('sub-streams are independent: perturbing tag 21 moves only the embankment', () => {
    const a = stagedMap();
    const b = stagedMap();
    const base = 1234;
    const S21 = (seed: number) => (tag: number) =>
      tag === 21 ? mulberry32(seed) : mulberry32((base ^ Math.imul(tag, 0x9e3779b1)) >>> 0);
    const ra = applyRelief(a, profile, S21(1), zeroWt(a.w, a.h), { ...stagedCtx, lanes });
    const rb = applyRelief(b, profile, S21(2), zeroWt(b.w, b.h), { ...stagedCtx, lanes });
    expect(ra.rail!.railX).not.toBe(rb.rail!.railX); // the perturbation really landed
    // everything outside both footprints — the undulation field, the hedge
    // banks and the sunken lanes — is bit-identical
    const inFootprint = (r: typeof ra, x: number, y: number) =>
      r.rail !== null && Math.abs(x - r.rail.centreline[y]) <= r.rail.Wt + r.rail.H;
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++) {
        if (inFootprint(ra, x, y) || inFootprint(rb, x, y)) continue;
        const i = y * 320 + x;
        expect(a.elev[i], `elev at ${x},${y}`).toBe(b.elev[i]);
        expect(a.tiles[i], `tile at ${x},${y}`).toBe(b.tiles[i]);
      }
  });

  it('hedge banks survive the embankment and the undulation (the stance payload is 1 m)', () => {
    const map = stagedMap();
    applyRelief(map, profile, subStreams(1234), zeroWt(map.w, map.h), { ...stagedCtx, lanes });
    let banked = 0;
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++)
        if (map.terrainKeyAt(x, y) === 'hedge' && map.elevAt(x, y) >= 1) banked++;
    expect(banked).toBeGreaterThan(200);
  });

  it('the flat zone comes out of every stage untouched', () => {
    const map = stagedMap();
    const flat = (x: number, y: number) => x >= 230 && x < 260 && y >= 30 && y < 60;
    const before = new GameMap(320, 240);
    for (let i = 0; i < map.tiles.length; i++) before.tiles[i] = map.tiles[i];
    applyRelief(map, profile, subStreams(1234), townMask(map.w, map.h, flat), { ...stagedCtx, lanes });
    for (let y = 30; y < 60; y++)
      for (let x = 230; x < 260; x++) {
        expect(map.elevAt(x, y), `elev at ${x},${y}`).toBe(0);
        expect(map.tiles[y * 320 + x], `tile at ${x},${y}`).toBe(before.tiles[y * 320 + x]);
      }
  });
});
