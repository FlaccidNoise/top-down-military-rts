import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { generateMap, RELIEF_BY_KIND, type MapKind, type MapPlan, type Vec } from '../src/sim/mapgen';
import { PROFILES } from '../src/sim/bourg/profile';
import { astar } from '../src/sim/path';

// V3 (wiring micro-relief into generateMap) and V5 (the bourg halt) of
// docs/plans/2026-07-26-verticality-design.md. tests/relief.test.ts owns the
// geometry against hand-built maps; this file owns the GENERATOR contract:
// where the stage fires, what it is forbidden to move, and what the halt is.

const KINDS: MapKind[] = ['open', 'road', 'woods', 'town', 'river', 'bridge', 'bourg'];
const W = 320;
const H = 240;

// FNV-1a over the raw arrays, byte-for-byte the function in tests/mapgen.test.ts
// and tests/bourg.test.ts, so all three files' numbers are comparable.
function fingerprint(plan: MapPlan): string {
  const { map } = plan;
  let h = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges, map.elev, map.stories, map.buildingId, map.stairs]) {
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

// §5.2's "relief: 'none' parity" fixture, captured from the working tree at the
// merge of the bourg and verticality lanes — i.e. from the binary that had
// relief.ts but no call to it. Plain literals, never inline snapshots: an
// `-u` run must not be able to launder a regression into a new baseline.
const PRE_RELIEF: Record<MapKind, string[]> = {
  // Recaptured at the mapgen-v3 P3 cutover, when 'open' left the legacy
  // pipeline for the organic one (scripts/fp.mjs --kind open).
  open: ['4edf4a39', '19f92704', '282359e7', 'dad20c4a', '6acb50d4', '8814cb3e', '509acb34', 'e1066bdf'],
  // Recaptured at the mapgen-v3 P2 cutover, when 'road' left the legacy
  // pipeline for the organic one (scripts/fp.mjs --kind road). It shared the
  // 'open' row above until then, which is the clearest statement of what the
  // legacy generator did with the kind: nothing.
  road: ['58ca7432', '22bff2e4', '3d52bdb8', 'e4e97f2f', '3ded323c', 'ed38633c', '4d2e6f16', 'd4ab3dc0'],
  woods: ['be23a411', '5a98532c', 'c52c9047', '495360ad', '23933a75', 'f357e7dd', 'c08092d3', 'b00bdf46'],
  town: ['bcd466e9', '6553b8e2', '3a445204', '4c57c79f', 'acdb9db2', 'dd238bd7', 'ace5f889', 'e538b159'],
  river: ['c9eaae79', '8f53c2f7', '1960e94d', 'a8c59af', '56ad5890', 'bf06b29d', 'ae9aedd1', 'cdf8c519'],
  bridge: ['f06a37fd', '9372bb3f', '8f86ad51', 'caa32459', '19e12808', '1c7f8003', '8d190660', '63adc289'],
  bourg: ['cd8c2d19', '98495a59', 'ee37d24f', 'e958b91f', 'f91e2d3a', '3d001667', '2cb58b53', '6201baba'],
};

const cache = new Map<string, MapPlan>();
function gen(seed: number, w: number, h: number, kind: MapKind, off = false): MapPlan {
  const key = `${seed}:${w}:${h}:${kind}:${off}`;
  let p = cache.get(key);
  if (!p) {
    p = generateMap(seed, w, h, kind, off ? { relief: 'none' } : undefined);
    cache.set(key, p);
  }
  return p;
}

function tally(map: GameMap): { rail: number; bank: number; crossings: number } {
  let rail = 0;
  let bank = 0;
  let crossings = 0;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const k = map.terrainKeyAt(x, y);
      if (k === 'rail') rail++;
      else if (k === 'bank') bank++;
      if (map.crossings[y * map.w + x]) crossings++;
    }
  return { rail, bank, crossings };
}

describe('V3 the size gate', () => {
  it('writes nothing at the 160x120 default or the 60x40 floor', () => {
    // H7a. This is why tests/mapgen.test.ts:37-38's inline fingerprints and
    // every 60x40 assertion hold with no argument and no re-snapshot.
    for (const kind of KINDS)
      for (const [w, h] of [
        [160, 120],
        [60, 40],
        [239, 240], // one tile under the width gate
        [320, 179], // one row under the height gate
      ] as [number, number][])
        for (const seed of [1, 4]) {
          const t = tally(gen(seed, w, h, kind).map);
          expect([kind, w, h, seed, t]).toEqual([kind, w, h, seed, { rail: 0, bank: 0, crossings: 0 }]);
        }
  });

  it('is byte-identical to relief: none below the gate', () => {
    for (const kind of KINDS)
      for (const seed of [1, 2, 3])
        expect([kind, seed, fingerprint(gen(seed, 160, 120, kind))]).toEqual([
          kind,
          seed,
          fingerprint(gen(seed, 160, 120, kind, true)),
        ]);
  });
});

describe('V3 additivity', () => {
  it('relief: none at 320x240 reproduces the pre-relief generator exactly', () => {
    // The single test that proves H7's "additive, guarded" claim end to end.
    for (const kind of KINDS)
      PRE_RELIEF[kind].forEach((want, i) =>
        expect([kind, i + 1, fingerprint(gen(i + 1, W, H, kind, true))]).toEqual([kind, i + 1, want]),
      );
  });

  it('moves no 2D geometry at 320x240: same buildings, objectives, spawns, woods stands', () => {
    // H7b. The stage runs after the dome pass, so it can only write elev, the
    // two new terrain keys and crossings. scripts/sweep.mjs derives its crops
    // from objectives and buildings, which is why this matters beyond tidiness:
    // the art baseline's crop windows do not move.
    for (const kind of KINDS)
      for (const seed of [1, 2, 5]) {
        const on = gen(seed, W, H, kind);
        const off = gen(seed, W, H, kind, true);
        // relief appends at most the halt; every earlier entry — and therefore
        // every buildingId already stamped into the map — is untouched
        expect([kind, seed, on.buildings.slice(0, off.buildings.length)]).toEqual([kind, seed, off.buildings]);
        expect([kind, seed, on.spawns]).toEqual([kind, seed, off.spawns]);
        expect([kind, seed, on.woodsStands]).toEqual([kind, seed, off.woodsStands]);
        // relief appends at most the halt objective; the prefix is untouched
        expect([kind, seed, on.objectives.slice(0, off.objectives.length)]).toEqual([kind, seed, off.objectives]);
      }
  });

  it("leaves 'town' byte-identical even with the stage switched on", () => {
    // H8: the bourg design freezes 'town' and every sweep crop depends on it,
    // so its profile is the null one and the guard never fires.
    PRE_RELIEF.town.forEach((want, i) => expect([i + 1, fingerprint(gen(i + 1, W, H, 'town'))]).toEqual([i + 1, want]));
  });

  it('applies the per-kind profile, not one global switch', () => {
    for (const kind of KINDS) {
      const p = RELIEF_BY_KIND[kind];
      for (const seed of [1, 3, 6]) {
        const t = tally(gen(seed, W, H, kind).map);
        expect([kind, seed, 'rail', t.rail > 0]).toEqual([kind, seed, 'rail', p.rail]);
        // crossings only ever come from an embankment carve
        expect([kind, seed, 'crossings', t.crossings > 0]).toEqual([kind, seed, 'crossings', p.rail]);
        // bank comes from the embankment batter OR a sunken lane's shoulders
        if (!p.rail && p.sunken === 0) expect([kind, seed, 'bank', t.bank]).toEqual([kind, seed, 'bank', 0]);
      }
    }
    // and 'woods' is the kind that gets its banks from sunken lanes alone
    for (const seed of [1, 3, 6]) expect([seed, tally(gen(seed, W, H, 'woods').map).bank > 0]).toEqual([seed, true]);
  });

  it('is deterministic per seed at 320x240, on every kind', () => {
    // The fingerprint already covers tiles and elev; `crossings` is the one
    // relief array it does NOT hash, so it is compared directly.
    for (const kind of KINDS)
      for (const seed of [2, 7]) {
        const a = generateMap(seed, W, H, kind);
        const b = generateMap(seed, W, H, kind);
        expect([kind, seed, fingerprint(a)]).toEqual([kind, seed, fingerprint(b)]);
        expect([kind, seed, a.map.crossings]).toEqual([kind, seed, b.map.crossings]);
        expect([kind, seed, a.buildings]).toEqual([kind, seed, b.buildings]);
        expect([kind, seed, a.objectives]).toEqual([kind, seed, b.objectives]);
      }
  }, 30_000);
});

describe('V3 the level crossing and the vehicle route', () => {
  it('marks only road tiles, never a bridge deck, and keeps rail out of the water', () => {
    for (const kind of ['open', 'bourg'] as MapKind[])
      for (let seed = 1; seed <= 6; seed++) {
        const { map } = gen(seed, W, H, kind);
        const bad: string[] = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            if (map.isCrossing(x, y)) {
              if (map.terrainKeyAt(x, y) !== 'road') bad.push(`crossing ${x},${y} is ${map.terrainKeyAt(x, y)}`);
              if (map.isBridge(x, y)) bad.push(`crossing ${x},${y} is also a bridge`);
            }
            if (map.terrainKeyAt(x, y) !== 'rail') continue;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ])
              if (map.terrainKeyAt(x + dx, y + dy) === 'water') bad.push(`rail ${x},${y} touches water`);
          }
        expect([kind, seed, bad]).toEqual([kind, seed, []]);
      }
  });

  it('keeps west→east drivable and forces armour over a crossing (open, seeds 1-10)', () => {
    // §1.6's revert is the safety net; this is the property it protects. The
    // embankment spans every row, its batter is vehicle-impassable and its
    // crest is only reachable off a crossing, so any vehicle route must use one.
    for (let seed = 1; seed <= 10; seed++) {
      const p = gen(seed, W, H, 'open');
      const path = astar(p.map, p.spawns.west.x, p.spawns.west.y, p.spawns.east.x, p.spawns.east.y, 'vehicle');
      expect([seed, path !== null]).toEqual([seed, true]);
      expect([seed, path!.some((t) => p.map.isCrossing(t.x, t.y))]).toEqual([seed, true]);
    }
  });

  it('reaches every objective from both spawns on foot (every relief-bearing kind)', () => {
    for (const kind of KINDS)
      for (const seed of [1, 4, 9]) {
        const p = gen(seed, W, H, kind);
        for (const o of p.objectives) {
          expect([kind, seed, o, astar(p.map, p.spawns.west.x, p.spawns.west.y, o.x, o.y) !== null]).toEqual([kind, seed, o, true]);
          expect([kind, seed, o, astar(p.map, p.spawns.east.x, p.spawns.east.y, o.x, o.y) !== null]).toEqual([kind, seed, o, true]);
        }
      }
  });
});

describe('V5 the railway halt', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const haltOf = (p: MapPlan) => p.buildings.filter((b) => b.role === 'halt');
  // Who gets a halt is not a kind name and never was: it is `rail` on the
  // relief profile, read by a kind that reaches the v3 pipeline (mapgen.ts
  // tryGenerateV3 — planHalt hangs off the relief stage's embankment). The
  // bourg was the only such kind until the mapgen-v3 P3 cutover put 'open'
  // there, and RELIEF_BY_KIND.open has carried rail: true since V3. §2.3 of
  // the v3 design accepts it explicitly — a rural halt is a good fight — so
  // this is derived rather than listed, and P4-P6 need not touch it.
  const RAIL_KINDS = KINDS.filter((k) => PROFILES[k] !== undefined && RELIEF_BY_KIND[k].rail);

  it('stands exactly one 7x4 halt on every rail-kind seed, appended after the village', () => {
    expect(RAIL_KINDS).toEqual(['open', 'bourg']);
    for (const kind of RAIL_KINDS)
      for (const seed of SEEDS) {
        const p = gen(seed, W, H, kind);
        const halts = haltOf(p);
        expect([kind, seed, halts.length]).toEqual([kind, seed, 1]);
        expect([kind, seed, halts[0].w, halts[0].h]).toEqual([kind, seed, 7, 4]);
        // appended LAST, so every buildingId the pipeline stamped is exactly
        // the index it had before V5
        expect([kind, seed, p.buildings[p.buildings.length - 1].role]).toEqual([kind, seed, 'halt']);
        const off = gen(seed, W, H, kind, true);
        expect([kind, seed, p.buildings.slice(0, -1)]).toEqual([kind, seed, off.buildings]);
      }
  });

  it('no other kind gets one, and no kind gets one with relief off', () => {
    for (const kind of KINDS)
      for (const seed of [1, 5]) {
        expect([kind, seed, haltOf(gen(seed, W, H, kind, true)).length]).toEqual([kind, seed, 0]);
        if (!RAIL_KINDS.includes(kind)) expect([kind, seed, haltOf(gen(seed, W, H, kind)).length]).toEqual([kind, seed, 0]);
      }
  });

  it('tags a passable road platform objective one metre under the crest', () => {
    for (const seed of SEEDS) {
      const p = gen(seed, W, H, 'bourg');
      const i = (p.objectiveKinds ?? []).indexOf('halt');
      expect([seed, i >= 0]).toEqual([seed, true]);
      const o = p.objectives[i];
      expect([seed, p.objectiveKinds!.length]).toEqual([seed, p.objectives.length]);
      expect([seed, p.map.terrainKeyAt(o.x, o.y)]).toEqual([seed, 'road']);
      expect([seed, p.map.terrainAt(o.x, o.y).passable]).toEqual([seed, true]);
      expect([seed, p.map.isCrossing(o.x, o.y)]).toEqual([seed, false]);
      // the deck sits against the crest, exactly one terrace below it
      const deck = p.map.elevAt(o.x, o.y);
      const crest = [
        [1, 0],
        [-1, 0],
      ]
        .map(([dx]) => ({ k: p.map.terrainKeyAt(o.x + dx, o.y), e: p.map.elevAt(o.x + dx, o.y) }))
        .find((n) => n.k === 'rail');
      expect([seed, crest !== undefined]).toEqual([seed, true]);
      expect([seed, crest!.e - deck]).toEqual([seed, 1]);
    }
  });

  it('puts the halt on the town side of the line, and garrisons it', () => {
    for (const seed of SEEDS) {
      const p = gen(seed, W, H, 'bourg');
      const b = haltOf(p)[0];
      const row = b.y + (b.h >> 1);
      const crest: number[] = [];
      for (let x = 0; x < W; x++) if (p.map.terrainKeyAt(x, row) === 'rail') crest.push(x);
      expect([seed, crest.length > 0]).toEqual([seed, true]);
      const west = (v: Vec | { x: number }) => v.x < crest[0];
      expect([seed, west({ x: b.x })]).toEqual([seed, west(p.objectives[0])]);
      // bridge.ts drops a building centre farther than GARRISON_RADIUS from
      // every objective, so an ungarrisoned halt is a strongpoint nobody holds
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const near = p.objectives.some((o) => (c.x - o.x) ** 2 + (c.y - o.y) ** 2 <= 45 * 45);
      expect([seed, near]).toEqual([seed, true]);
    }
  });

  it('stands on level ground and is clearable from the west spawn', () => {
    for (const seed of SEEDS) {
      const p = gen(seed, W, H, 'bourg');
      const b = haltOf(p)[0];
      const e = p.map.elevAt(b.x, b.y);
      const bad: string[] = [];
      for (let y = b.y; y < b.y + b.h; y++)
        for (let x = b.x; x < b.x + b.w; x++) {
          if (p.map.terrainKeyAt(x, y) !== 'floor') bad.push(`${x},${y} is ${p.map.terrainKeyAt(x, y)}`);
          if (p.map.elevAt(x, y) !== e) bad.push(`${x},${y} elev ${p.map.elevAt(x, y)} != ${e}`);
          if (p.map.buildingIdAt(x, y) !== p.buildings.length - 1) bad.push(`${x},${y} wrong buildingId`);
        }
      expect([seed, bad]).toEqual([seed, []]);
      const c = { x: b.x + (b.w >> 1), y: b.y + (b.h >> 1) };
      expect([seed, astar(p.map, p.spawns.west.x, p.spawns.west.y, c.x, c.y) !== null]).toEqual([seed, true]);
    }
  });
});
