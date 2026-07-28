import { describe, expect, it } from 'vitest';
import { generateMap, reachField, type MapKind } from '../src/sim/mapgen';
import { astar } from '../src/sim/path';

// FNV-1a over the map's raw arrays — a compact geometry + elevation fingerprint.
function fingerprint(seed: number): string {
  const { map } = generateMap(seed);
  let h = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges, map.elev, map.stories, map.buildingId, map.stairs]) {
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

// I12 · the furnished configuration's own drift tripwire.
//
// A DIFFERENT hash from the one above on purpose, and not comparable with it:
// it adds `hEdgeTops`/`vEdgeTops` to the seven arrays. Interiors writes wall
// tops (every partition it cuts is stamped at the mass's storey height), and
// the seven-array hash is blind to them — a partitioner that silently started
// emitting top 0 instead of top 6 would sail straight through it.
function furnishedFingerprint(seed: number, w: number, h: number, kind: MapKind): string {
  const { map } = generateMap(seed, w, h, kind, { interiors: true });
  let x = 0x811c9dc5;
  for (const a of [map.tiles, map.hEdges, map.vEdges, map.hEdgeTops, map.vEdgeTops, map.elev, map.stories, map.buildingId, map.stairs]) {
    for (let i = 0; i < a.length; i++) {
      x ^= a[i];
      x = Math.imul(x, 0x01000193);
    }
  }
  return (x >>> 0).toString(16);
}

describe('mapgen', () => {
  it('is deterministic: same seed → identical map and plan', () => {
    const a = generateMap(7);
    const b = generateMap(7);
    expect(fingerprint(7)).toBe(fingerprint(7));
    expect(a.map.tiles).toEqual(b.map.tiles);
    expect(a.map.hEdges).toEqual(b.map.hEdges);
    expect(a.map.vEdges).toEqual(b.map.vEdges);
    expect(a.buildings).toEqual(b.buildings);
    expect(a.spawns).toEqual(b.spawns);
    expect(a.objectives).toEqual(b.objectives);
  });

  it('rejects maps too small for the layout', () => {
    expect(() => generateMap(1, 59, 120)).toThrow(/too small/);
    expect(() => generateMap(1, 160, 39)).toThrow(/too small/);
  });

  // Re-frozen at the mapgen-v3 P3 cutover: `generateMap(seed)` defaults to
  // 'open', which is the organic pipeline now (8105059f/d2a77805 were the
  // legacy blob village).
  it('matches known snapshots (catches accidental generator drift)', () => {
    expect(fingerprint(1)).toMatchInlineSnapshot(`"768c6c15"`);
    expect(fingerprint(2)).toMatchInlineSnapshot(`"14d954d5"`);
  });

  // I12 · interiors §6.2. The answer to "you only fingerprint the config you do
  // not ship": bridge.ts and scenario.ts both pass `{ interiors: true }`, so
  // these four are the shipped path's tripwire and the two above are the
  // flag-off one. THE TWO ARE INDEPENDENT — an interiors change moves these and
  // must leave those alone, and a change that moves BOTH is a generator change
  // that has leaked out of the interiors module.
  //
  // The two bourg lines also move legitimately when the BOURG layout is meant
  // to change, in which case tests/bourg.test.ts's 97b5bca / eb9a14e6 move in
  // the same commit. One of them moving alone is a bug.
  it('pins the furnished configuration (interiors: true)', () => {
    // The two open lines re-froze at the P3 cutover with the geometry under
    // them (8ab735cc/d6cff694 were the legacy blob village); the two bourg
    // lines did not move, and are P3's leak control on the interiors side.
    expect(furnishedFingerprint(1, 160, 120, 'open')).toMatchInlineSnapshot(`"d796a7cf"`);
    expect(furnishedFingerprint(2, 160, 120, 'open')).toMatchInlineSnapshot(`"a7569fd7"`);
    expect(furnishedFingerprint(1, 320, 240, 'bourg')).toMatchInlineSnapshot(`"f3c5a70"`);
    expect(furnishedFingerprint(2, 320, 240, 'bourg')).toMatchInlineSnapshot(`"2f746b24"`);
  });

  // The validation gate inlines canStep (mapgen.ts reachField) for speed, so it
  // is a copy of map.ts:112-125 + path.ts:108-114 that can drift. This compares
  // it against astar exhaustively — every tile of a 60x40 map, both modes, on a
  // 'bridge' layout (water, hedges, doors, windows, floors) and an 'open' one.
  it('the flood-fill reach field agrees with astar on every tile (60x40)', () => {
    const mismatches: string[] = [];
    for (const kind of ['open', 'bridge'] as const) {
      const p = generateMap(4, 60, 40, kind);
      const { map } = p;
      const { x: sx, y: sy } = p.spawns.west;
      for (const mode of ['foot', 'vehicle'] as const) {
        const field = reachField(map, sx, sy, mode);
        for (let y = 0; y < map.h; y++)
          for (let x = 0; x < map.w; x++) {
            const flood = map.terrainAt(x, y).passable && field[y * map.w + x] === 1;
            if (flood !== (astar(map, sx, sy, x, y, mode) !== null)) mismatches.push(`${kind}/${mode} @${x},${y}`);
          }
      }
    }
    expect(mismatches).toEqual([]);
    // 20 s, not the 5 s default: 'open' runs the organic pipeline since P3, so
    // its 60x40 map carries hedges, gates and enclosure walls that the blob
    // village did not, and 9600 astar calls over that took the default timeout
    // under a full parallel suite while running 1.8 s standalone.
  }, 20_000);

  it('spawns reach objectives and buildings on foot; the road carries vehicles (seeds 1-30)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = generateMap(seed);
      expect(p.buildings.length).toBeGreaterThanOrEqual(4);
      const { west, east } = p.spawns;
      for (const o of p.objectives) {
        expect(astar(p.map, west.x, west.y, o.x, o.y)).not.toBeNull();
        expect(astar(p.map, east.x, east.y, o.x, o.y)).not.toBeNull();
      }
      for (const b of p.buildings) {
        expect(astar(p.map, west.x, west.y, b.x + (b.w >> 1), b.y + (b.h >> 1))).not.toBeNull();
      }
      expect(astar(p.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
      expect(p.woodsStands.length).toBeGreaterThan(0);
      for (const s of p.woodsStands) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(p.map.w);
        expect(s.y).toBeLessThan(p.map.h);
      }
    }
  });

  // mapgen-v3 §2.3's compatibility battery for the quick-battle path. These
  // are the four things src/sim/scenario.ts reads off a default 'open' map,
  // and nothing else about the generator is a contract to it:
  //   - `const [b0, , b2] = plan.buildings` garrisons two Gruppen, so the list
  //     needs three entries and the first and third have to be nucleus plots,
  //     not outlying farms 90 tiles from the fight;
  //   - the MG42 is emplaced on objectives[0], which patches.ts also needs
  //     road under for the cobbles;
  //   - a red squad spawns on objectives[1], so it has to be standable.
  // The old form of this test bounded the first three buildings at 30 tiles
  // from the crossroads. That measured the legacy blob cluster's own 24-tile
  // span rather than the property: the v3 hamlet envelope is 34-45 wide, and a
  // plot at its far corner is legitimately 40 tiles out. Measured over seeds
  // 1-200 at 160x120: buildings[0] 5-32, buildings[2] 3-40, 10-25 buildings
  // inside 30 tiles, and never fewer than the four minBuildings guarantees.
  it("the quick-battle scenario's reads hold on the default map (seeds 1-30)", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = generateMap(seed);
      const o0 = p.objectives[0];
      const dist = (b: { x: number; y: number; w: number; h: number }) =>
        Math.hypot(b.x + b.w / 2 - o0.x, b.y + b.h / 2 - o0.y);
      expect([seed, p.buildings.length >= 3]).toEqual([seed, true]);
      expect([seed, dist(p.buildings[0]) <= 48, dist(p.buildings[2]) <= 48]).toEqual([seed, true, true]);
      expect([seed, p.buildings.filter((b) => dist(b) < 30).length >= 3]).toEqual([seed, true]);
      expect([seed, p.map.terrainKeyAt(o0.x, o0.y)]).toEqual([seed, 'road']);
      expect([seed, p.map.terrainAt(p.objectives[1].x, p.objectives[1].y).passable]).toEqual([seed, true]);
    }
  });

  it('hedgerows block vehicles but not infantry', () => {
    const p = generateMap(3);
    let hx = -1, hy = -1;
    for (let y = 1; y < p.map.h - 1 && hx < 0; y++)
      for (let x = 1; x < p.map.w - 1 && hx < 0; x++)
        if (p.map.terrainKeyAt(x, y) === 'hedge') { hx = x; hy = y; }
    expect(hx).toBeGreaterThanOrEqual(0);
    expect(p.map.canStep(hx - 1, hy, hx, hy, 'vehicle')).toBe(false);
    expect(p.map.canStep(hx - 1, hy, hx, hy)).toBe(true);
  });

  it('orchards plant isolated trees (seeds 1-5)', () => {
    let isolatedTrees = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const p = generateMap(seed);
      for (let y = 1; y < p.map.h - 1; y++)
        for (let x = 1; x < p.map.w - 1; x++) {
          if (p.map.terrainKeyAt(x, y) !== 'woods') continue;
          if (
            p.map.terrainKeyAt(x - 1, y) !== 'woods' &&
            p.map.terrainKeyAt(x + 1, y) !== 'woods' &&
            p.map.terrainKeyAt(x, y - 1) !== 'woods' &&
            p.map.terrainKeyAt(x, y + 1) !== 'woods'
          ) isolatedTrees++;
        }
    }
    // woods-stand fringe alone yields ~95 across seeds 1-5; orchards push it
    // ~192. Measured 325 since P3 put 'open' on the organic pipeline, whose
    // stand pass runs 4-6 extra stands over the same country — the bound is
    // left where it is, because what it catches is the orchard pass going
    // silent, not the exact count.
    expect(isolatedTrees).toBeGreaterThan(150);
  });

  // ── the water battery ────────────────────────────────────────────────────
  //
  // Written against the legacy blob pipeline and UNEDITED at the mapgen-v3 P5
  // cutover, which is the point of leaving them alone: §2.5 reordered the
  // whole generator around the band — the water is carved in the skeleton now,
  // the town is placed clear of it, and streets, lanes, parcels and hedges all
  // refuse it — and the deck rule these five tests describe came through it
  // byte for byte. A band over 500 tiles, a crossing on road with the river
  // within 2 either side, both spawns connected across it on foot and by
  // vehicle, river wider than bridge, and generation at the 60x40 floor: all
  // still true, none of it re-stated to suit the new implementation.
  //
  // The organic pipeline's own claims — one deck, nothing built in the river,
  // the town clear of the bank, and the crossing as the ONLY way over — are in
  // tests/bourg.test.ts under §2.5, because they are new properties rather
  // than preserved ones.
  it('bridge maps: water river, road bridge objective, spawns connected across it (320x240)', () => {
    for (const seed of [1, 5, 9]) {
      const p = generateMap(seed, 320, 240, 'bridge');
      let water = 0;
      for (let y = 0; y < p.map.h; y++)
        for (let x = 0; x < p.map.w; x++) if (p.map.terrainKeyAt(x, y) === 'water') water++;
      expect(water).toBeGreaterThan(500); // 3-wide band over 240 rows, minus road crossings
      const bridge = p.objectives[p.objectives.length - 1];
      expect(p.map.terrainKeyAt(bridge.x, bridge.y)).toBe('road');
      const { west, east } = p.spawns;
      for (const o of p.objectives) {
        expect(astar(p.map, west.x, west.y, o.x, o.y)).not.toBeNull();
        expect(astar(p.map, east.x, east.y, o.x, o.y)).not.toBeNull();
      }
      expect(astar(p.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
    }
  });

  it('bridge maps are deterministic per seed', () => {
    const a = generateMap(5, 320, 240, 'bridge');
    const b = generateMap(5, 320, 240, 'bridge');
    expect(a.map.tiles).toEqual(b.map.tiles);
    expect(a.objectives).toEqual(b.objectives);
    expect(a.spawns).toEqual(b.spawns);
  });

  it('water blocks foot and vehicle movement', () => {
    const p = generateMap(1, 320, 240, 'bridge');
    let wx = -1, wy = -1;
    for (let y = 1; y < p.map.h - 1 && wx < 0; y++)
      for (let x = 1; x < p.map.w - 1 && wx < 0; x++)
        if (p.map.terrainKeyAt(x, y) === 'water' && p.map.terrainAt(x - 1, y).passable) { wx = x; wy = y; }
    expect(wx).toBeGreaterThanOrEqual(0);
    expect(p.map.canStep(wx - 1, wy, wx, wy)).toBe(false);
    expect(p.map.canStep(wx - 1, wy, wx, wy, 'vehicle')).toBe(false);
  });

  it('bridge/river maps generate at the 60x40 floor; woods-stand anchors stay passable (seeds 1-15)', () => {
    for (const kind of ['bridge', 'river'] as const) {
      for (let seed = 1; seed <= 15; seed++) {
        const p = generateMap(seed, 60, 40, kind);
        const { west, east } = p.spawns;
        expect(astar(p.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
        const big = generateMap(seed, 320, 240, kind);
        for (const s of big.woodsStands) expect(big.map.terrainAt(s.x, s.y).passable).toBe(true);
      }
    }
  });

  // DELETED at the mapgen-v3 P3 cutover: 'town maps pack a denser village
  // around the crossroads'. It asserted near(town) >= near(open) + 6 within 40
  // tiles of the crossroads, and that is now false — measured deltas +4, -2, -6
  // on seeds 1, 5, 9, because the organic hamlet packs its carrefour harder
  // than the legacy blob cluster ever did. The half of it worth keeping (the
  // open nucleus IS dense) is asserted directly by the scenario battery above
  // and by the open structure battery in tests/bourg.test.ts; the other half
  // compared two different generators and dies with 'town' at P6 anyway.

  it('bridge objective sits on the carved road-water crossing (seeds 1-15)', () => {
    for (const kind of ['bridge', 'river'] as const) {
      for (let seed = 1; seed <= 15; seed++) {
        const p = generateMap(seed, 320, 240, kind);
        const b = p.objectives[p.objectives.length - 1];
        expect(p.map.terrainKeyAt(b.x, b.y)).toBe('road');
        // the road span is 3 rows; the band must flank it both sides nearby
        let north = 99;
        let south = 99;
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) {
            if (p.map.terrainKeyAt(b.x + dx, b.y + dy) !== 'water') continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            if (dy < 0) north = Math.min(north, d);
            else if (dy > 0) south = Math.min(south, d);
          }
        expect(north).toBeLessThanOrEqual(2);
        expect(south).toBeLessThanOrEqual(2);
      }
    }
  });

  it('river maps carve a wider band than bridge maps', () => {
    const count = (kind: 'bridge' | 'river') => {
      const p = generateMap(2, 320, 240, kind);
      let n = 0;
      for (let y = 0; y < p.map.h; y++)
        for (let x = 0; x < p.map.w; x++) if (p.map.terrainKeyAt(x, y) === 'water') n++;
      return n;
    };
    expect(count('river')).toBeGreaterThan(count('bridge'));
  });

  it('large maps keep the second-settlement objective slot and stay connected (320x240)', () => {
    for (const seed of [1, 5, 9]) {
      const a = generateMap(seed, 320, 240);
      const b = generateMap(seed, 320, 240);
      expect(a.map.tiles).toEqual(b.map.tiles);
      // The w >= 240 slot survived the P3 cutover, but the list around it did
      // not stay three long: the organic pipeline appends a greedy garrison
      // fill and, on 'open', a railway halt, so it runs 6-10 objectives.
      // objectiveKinds is what pins the slot now — measured 'street' on all 60
      // seeds, because 'open' weights no 'faubourg' archetype.
      expect(a.objectives.length).toBeGreaterThanOrEqual(3);
      expect(a.objectiveKinds?.slice(0, 3)).toEqual(['place', 'woods', 'street']);
      expect(a.buildings.length).toBeGreaterThanOrEqual(7);
      const hamlet = a.objectives[2];
      const hamletBuildings = a.buildings.filter(
        (b) => (b.x - hamlet.x) ** 2 + (b.y - hamlet.y) ** 2 < 22 * 22,
      ).length;
      expect(hamletBuildings).toBeGreaterThanOrEqual(3);
      const { west, east } = a.spawns;
      for (const o of a.objectives) expect(astar(a.map, west.x, west.y, o.x, o.y)).not.toBeNull();
      expect(astar(a.map, west.x, west.y, east.x, east.y, 'vehicle')).not.toBeNull();
      expect(a.woodsStands.length).toBeGreaterThan(0);
      for (const s of a.woodsStands) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(a.map.w);
        expect(s.y).toBeLessThan(a.map.h);
      }
    }
  });
});
