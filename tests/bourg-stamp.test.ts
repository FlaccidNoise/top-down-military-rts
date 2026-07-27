import { describe, expect, it } from 'vitest';
import { partsOf, stampStructure, storiesOf } from '../src/sim/bourg/stamp';
import { EDGE, FLOOR_H, GameMap } from '../src/sim/map';
import { reachField, type Building } from '../src/sim/mapgen';
import { astar } from '../src/sim/path';

// T3: stampStructure exercised against hand-built masks, before any generator
// exists to feed it. This is the piece where a bug corrupts the far side of the
// map silently, so the shapes here are the awkward ones: L, U, courtyard,
// church-with-tower, and an abutting terrace pair.

const MAP = 40;
const fresh = (): GameMap => new GameMap(MAP, MAP);

// every tile the structure claims, from its parts
function tilesOf(b: Building): [number, number][] {
  const out: [number, number][] = [];
  for (const p of partsOf(b))
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) out.push([x, y]);
  return out;
}

// every tile is floor, carries the right storeys, and answers to one buildingId
function expectMassStamped(map: GameMap, b: Building, bid: number, stories: number): void {
  for (const [x, y] of tilesOf(b)) {
    expect(map.terrainKeyAt(x, y)).toBe('floor');
    expect(map.storiesAt(x, y)).toBe(stories);
    expect(map.buildingIdAt(x, y)).toBe(bid);
  }
}

// foot-reachability of every interior tile from the door's own tile, on the
// stamped map: the partition pass must never seal a room off
function expectInteriorConnected(map: GameMap, b: Building): void {
  const tiles = tilesOf(b);
  const from = b.doors?.[0] ?? { x: b.x + (b.w >> 1), y: b.y + (b.h >> 1) };
  const unreachable = tiles.filter(([x, y]) => astar(map, from.x, from.y, x, y) === null);
  expect(unreachable).toEqual([]);
}

function edgeCounts(map: GameMap): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const a of [map.hEdges, map.vEdges]) for (let i = 0; i < a.length; i++) counts[a[i]]++;
  return counts;
}

describe('bourg stampStructure — single masses', () => {
  it('a plain rect stamps floor, a walled envelope, windows every 3rd bay and one door', () => {
    const map = fresh();
    const b: Building = { x: 10, y: 10, w: 7, h: 5, doors: [{ x: 13, y: 14, side: 's', width: 1 }] };
    expect(stampStructure(map, b, 0)).toBe(1);
    expectMassStamped(map, b, 0, 1);
    expect(map.hEdge(13, 15)).toBe(EDGE.DOOR);
    // north face is a 7-long exterior run: phase-1 windows at x=11 and x=14
    expect(map.hEdge(11, 10)).toBe(EDGE.WINDOW);
    expect(map.hEdge(14, 10)).toBe(EDGE.WINDOW);
    expect(map.hEdge(10, 10)).toBe(EDGE.WALL);
    // WALL edges carry the storey height; openings never do
    expect(map.hEdgeTop(10, 10)).toBe(FLOOR_H);
    expect(map.hEdgeTop(11, 10)).toBe(0);
    expect(map.hEdgeTop(13, 15)).toBe(0);
    expectInteriorConnected(map, b);
  });

  it('an L keeps its window rhythm per boundary run, not per rect, and never walls the joint', () => {
    const map = fresh();
    const b: Building = {
      x: 8,
      y: 8,
      w: 10,
      h: 5,
      parts: [
        { x: 8, y: 8, w: 10, h: 5 },
        { x: 8, y: 13, w: 4, h: 6 },
      ],
      doors: [{ x: 9, y: 18, side: 's', width: 1 }],
    };
    expect(stampStructure(map, b, 3)).toBe(2); // 50 + 24 = 74 tiles
    expectMassStamped(map, b, 3, 2);
    // The joint between the two rects is interior, so the boundary extractor
    // puts nothing there. The AABB partition pass then happens to cut along the
    // same line — legitimately, it is the waist of the L — but an interior cut
    // is distinguishable from an envelope wall: it carries a DOOR and no
    // WINDOW, where a 4-long exterior run would have windowed x=9.
    let jointDoors = 0;
    for (let x = 8; x < 12; x++) {
      expect(map.hEdge(x, 13)).not.toBe(EDGE.WINDOW);
      if (map.hEdge(x, 13) === EDGE.DOOR) jointDoors++;
    }
    expect(jointDoors).toBe(1);
    // …while the rest of that grid line is the primary mass's south envelope
    for (let x = 12; x < 18; x++) expect(map.hEdge(x, 13)).not.toBe(EDGE.NONE);
    // the concave corner's two faces are separate runs, so neither restarts
    // its phase mid-wall
    expect(map.vEdge(8, 8)).toBe(EDGE.WALL);
    expect(map.vEdge(8, 9)).toBe(EDGE.WINDOW);
    expectInteriorConnected(map, b);
  });

  it('a U and a closed courtyard both extract their inner boundary', () => {
    const map = fresh();
    const u: Building = {
      x: 4,
      y: 4,
      w: 12,
      h: 3,
      parts: [
        { x: 4, y: 4, w: 12, h: 3 },
        { x: 4, y: 7, w: 3, h: 8 },
        { x: 13, y: 7, w: 3, h: 8 },
      ],
      doors: [{ x: 5, y: 14, side: 's', width: 1 }],
    };
    stampStructure(map, u, 0);
    expectMassStamped(map, u, 0, 2);
    // the yard between the arms is NOT floor and is walled off from both
    expect(map.terrainKeyAt(9, 10)).toBe('grass');
    expect(map.vEdge(7, 10)).not.toBe(EDGE.NONE);
    expect(map.vEdge(13, 10)).not.toBe(EDGE.NONE);
    expectInteriorConnected(map, u);

    const map2 = fresh();
    const court: Building = {
      x: 4,
      y: 4,
      w: 12,
      h: 3,
      parts: [
        { x: 4, y: 4, w: 12, h: 3 },
        { x: 4, y: 7, w: 3, h: 8 },
        { x: 13, y: 7, w: 3, h: 8 },
        { x: 4, y: 15, w: 12, h: 3 },
      ],
      doors: [{ x: 5, y: 17, side: 's', width: 1 }],
    };
    stampStructure(map2, court, 0);
    expectMassStamped(map2, court, 0, 2);
    // a fully enclosed yard: grass ringed by the structure's inner boundary
    expect(map2.terrainKeyAt(9, 10)).toBe('grass');
    expect(map2.buildingIdAt(9, 10)).toBe(-1);
    for (let x = 7; x < 13; x++) expect(map2.hEdge(x, 7)).not.toBe(EDGE.NONE);
    for (let x = 7; x < 13; x++) expect(map2.hEdge(x, 15)).not.toBe(EDGE.NONE);
    expectInteriorConnected(map2, court);
  });

  it('a 2-wide door writes two adjacent DOOR edges', () => {
    const map = fresh();
    const b: Building = { x: 10, y: 10, w: 8, h: 6, doors: [{ x: 12, y: 15, side: 's', width: 2 }] };
    stampStructure(map, b, 0);
    expect(map.hEdge(12, 16)).toBe(EDGE.DOOR);
    expect(map.hEdge(13, 16)).toBe(EDGE.DOOR);
    expect(map.hEdge(14, 16)).not.toBe(EDGE.DOOR);
  });

  it('a porte-cochère punches straight through the body: two doors, foot passes, vehicles do not', () => {
    const map = fresh();
    const b: Building = {
      x: 10,
      y: 10,
      w: 6,
      h: 4,
      doors: [
        { x: 10, y: 11, side: 'w', width: 1 },
        { x: 15, y: 11, side: 'e', width: 1 },
      ],
    };
    stampStructure(map, b, 0);
    expect(map.canStep(9, 11, 10, 11)).toBe(true);
    expect(map.canStep(15, 11, 16, 11)).toBe(true);
    expect(map.canStep(9, 11, 10, 11, 'vehicle')).toBe(false); // floor terrain, not the edge
    expect(astar(map, 9, 11, 16, 11)).not.toBeNull();
  });

  it('a market halle is a roof on posts: floor, four corner posts, open sides', () => {
    const map = fresh();
    const b: Building = { x: 10, y: 10, w: 6, h: 5, role: 'halle' };
    expect(stampStructure(map, b, 0)).toBe(1);
    expectMassStamped(map, b, 0, 1);
    expect(map.hEdge(10, 10)).toBe(EDGE.WALL); // corner post
    expect(map.hEdge(12, 10)).toBe(EDGE.NONE); // open bay
    expect(map.canStep(12, 9, 12, 10)).toBe(true);
    expect(map.canStep(12, 9, 12, 10, 'vehicle')).toBe(false); // floor keeps vehicles out
  });
});

describe('bourg stampStructure — storeys and stairs', () => {
  it('derives storeys from area, with role overriding for the belfry and the halle', () => {
    expect(storiesOf({ x: 0, y: 0, w: 7, h: 5 })).toBe(1); // 35
    expect(storiesOf({ x: 0, y: 0, w: 8, h: 7 })).toBe(2); // 56 — the pinned threshold
    expect(storiesOf({ x: 0, y: 0, w: 5, h: 5, role: 'church_tower' })).toBe(4);
    expect(storiesOf({ x: 0, y: 0, w: 12, h: 8, role: 'halle' })).toBe(1);
    // parts count toward the area, so an L of two small wings can clear 56
    expect(
      storiesOf({ x: 0, y: 0, w: 6, h: 5, parts: [{ x: 0, y: 0, w: 6, h: 5 }, { x: 0, y: 5, w: 6, h: 5 }] }),
    ).toBe(2);
  });

  it('puts the stair on an interior tile far from the door, never in a 1-wide wing', () => {
    const map = fresh();
    // the wing is 1 tile wide and is the farthest thing from the door, so the
    // 4-neighbour guard is what keeps the stair out of it
    const b: Building = {
      x: 8,
      y: 8,
      w: 9,
      h: 7,
      parts: [
        { x: 8, y: 8, w: 9, h: 7 },
        { x: 17, y: 10, w: 5, h: 1 },
      ],
      doors: [{ x: 8, y: 8, side: 'n', width: 1 }],
    };
    stampStructure(map, b, 0);
    const stairs: [number, number][] = [];
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) if (map.isStair(x, y)) stairs.push([x, y]);
    expect(stairs).toHaveLength(1);
    const [sx, sy] = stairs[0];
    expect(sy).toBeGreaterThan(10); // not in the wing row, which is nearer the door in y
    expect(map.buildingIdAt(sx - 1, sy)).toBe(0);
    expect(map.buildingIdAt(sx + 1, sy)).toBe(0);
    expect(map.buildingIdAt(sx, sy - 1)).toBe(0);
    expect(map.buildingIdAt(sx, sy + 1)).toBe(0);
    // and it is climbable end to end: ground → first floor
    expect(astar(map, sx, sy, sx, sy, 'foot', 0, 1)).not.toBeNull();
  });

  it('a four-storey tower is clearable floor by floor off one stair column', () => {
    const map = fresh();
    map.maxStories = 4;
    const tower: Building = { x: 10, y: 10, w: 5, h: 5, role: 'church_tower', doors: [{ x: 12, y: 14, side: 's', width: 1 }] };
    expect(stampStructure(map, tower, 0)).toBe(4);
    expectMassStamped(map, tower, 0, 4);
    let stair: [number, number] | null = null;
    for (let y = 10; y < 15; y++) for (let x = 10; x < 15; x++) if (map.isStair(x, y)) stair = [x, y];
    expect(stair).not.toBeNull();
    const [sx, sy] = stair!;
    expect(astar(map, 12, 15, sx, sy)).not.toBeNull(); // street → stair
    expect(astar(map, sx, sy, sx, sy, 'foot', 0, 3)).not.toBeNull(); // stair → belfry
    // the belfry sees over a 2 m churchyard wall: top 12 on every WALL edge
    expect(map.hEdgeTop(10, 10)).toBe(4 * FLOOR_H);
  });
});

describe('bourg stampStructure — shared spans', () => {
  it('a terrace pair gets a party WALL, never a WINDOW, at the top of both storeys', () => {
    const map = fresh();
    const left: Building = { x: 10, y: 10, w: 6, h: 10, terraceRun: 0, doors: [{ x: 12, y: 19, side: 's', width: 1 }] };
    const right: Building = { x: 16, y: 10, w: 6, h: 6, terraceRun: 0, doors: [{ x: 18, y: 15, side: 's', width: 1 }] };
    expect(stampStructure(map, left, 0)).toBe(2); // 60 tiles
    expect(stampStructure(map, right, 1)).toBe(1); // 36 tiles
    // left's east face laid windows on what the right unit then claimed as a
    // party wall — every shared position must have come back as WALL
    for (let y = 10; y < 16; y++) {
      expect(map.vEdge(16, y)).toBe(EDGE.WALL);
      expect(map.vEdgeTop(16, y)).toBe(2 * FLOOR_H); // max(2,1) storeys
    }
    // the part of left's east face with no neighbour keeps its windows
    let windows = 0;
    for (let y = 16; y < 20; y++) if (map.vEdge(16, y) === EDGE.WINDOW) windows++;
    expect(windows).toBeGreaterThan(0);
    // and the two interiors stay separate
    expect(map.buildingIdAt(15, 12)).toBe(0);
    expect(map.buildingIdAt(16, 12)).toBe(1);
    expect(map.canStep(15, 12, 16, 12)).toBe(false);
  });

  it('a church nave, tower and apse share one groupId and merge into one interior', () => {
    const map = fresh();
    map.maxStories = 4;
    const nave: Building = { x: 10, y: 10, w: 9, h: 22, role: 'church', groupId: 7, doors: [{ x: 14, y: 31, side: 's', width: 2 }] };
    const tower: Building = { x: 5, y: 18, w: 5, h: 5, role: 'church_tower', groupId: 7, doors: [{ x: 5, y: 20, side: 'w', width: 1 }] };
    const apse: Building = { x: 19, y: 19, w: 5, h: 4, role: 'church_apse', groupId: 7 };
    expect(stampStructure(map, nave, 0)).toBe(2);
    expect(stampStructure(map, tower, 1)).toBe(4);
    expect(stampStructure(map, apse, 2)).toBe(1);
    for (const b of [nave, tower, apse]) for (const [x, y] of tilesOf(b)) expect(map.buildingIdAt(x, y)).toBe(7);

    // every shared span inside the group is EDGE.NONE with no stale top
    for (let y = 18; y < 23; y++) {
      expect(map.vEdge(10, y)).toBe(EDGE.NONE);
      expect(map.vEdgeTop(10, y)).toBe(0);
    }
    for (let y = 19; y < 23; y++) expect(map.vEdge(19, y)).toBe(EDGE.NONE);

    // …so a path from inside the tower to inside the apse never leaves floor
    const path = astar(map, 7, 20, 21, 20);
    expect(path).not.toBeNull();
    for (const p of path!) expect(map.terrainKeyAt(p.x, p.y)).toBe('floor');

    // storeys stay per-mass even though the id is shared
    expect(map.storiesAt(7, 20)).toBe(4);
    expect(map.storiesAt(14, 20)).toBe(2);
    expect(map.storiesAt(21, 20)).toBe(1);
  });

  it('a terrace of five reads as five roofs and one continuous frontage', () => {
    const map = fresh();
    const units: Building[] = [];
    for (let i = 0; i < 5; i++)
      units.push({ x: 6 + i * 5, y: 10, w: 5, h: 8, terraceRun: 1, frontage: 's', doors: [{ x: 8 + i * 5, y: 17, side: 's', width: 1 }] });
    units.forEach((u, i) => stampStructure(map, u, i));
    units.forEach((u, i) => expectMassStamped(map, u, i, 1));
    // four party walls, all WALL, none passable, none a window
    for (let k = 1; k < 5; k++)
      for (let y = 10; y < 18; y++) {
        expect(map.vEdge(6 + k * 5, y)).toBe(EDGE.WALL);
        expect(map.canStep(5 + k * 5, y, 6 + k * 5, y)).toBe(false);
      }
    // every unit is entered from the street and no unit reaches its neighbour
    for (let i = 0; i < 5; i++) {
      expect(astar(map, 8 + i * 5, 18, 8 + i * 5, 11)).not.toBeNull();
      if (i > 0) expect(map.buildingIdAt(8 + i * 5, 12)).not.toBe(map.buildingIdAt(3 + i * 5, 12));
    }
  });
});

describe('bourg stampStructure — shape sweep', () => {
  // The partition pass is the piece most likely to seal a room off on a shape
  // nobody hand-wrote a case for, so sweep every rect up to 16x16 plus L and T
  // variants and assert the whole interior is enterable from OUTSIDE the
  // structure — which covers "has a usable door" and "no room is walled in"
  // in one relation.
  it('every rect to 16x16 and every L/T variant is enterable and internally connected', () => {
    const shapes: Building[] = [];
    for (let w = 1; w <= 16; w++) for (let h = 1; h <= 16; h++) shapes.push({ x: 5, y: 5, w, h });
    for (let arm = 2; arm <= 10; arm += 2)
      for (let leg = 2; leg <= 10; leg += 2) {
        const head = { x: 5, y: 5, w: arm + 4, h: 4 };
        shapes.push({ ...head, parts: [head, { x: 5, y: 9, w: 3, h: leg }] }); // L
        shapes.push({ ...head, parts: [head, { x: 7, y: 9, w: 3, h: leg }] }); // T
      }

    const problems: string[] = [];
    for (const b of shapes) {
      const map = fresh();
      const stories = stampStructure(map, b, 0);
      const label = `${b.w}x${b.h}${b.parts ? `+${b.parts[1].w}x${b.parts[1].h}` : ''}`;

      const field = reachField(map, 0, 0, 'foot');
      for (const [x, y] of tilesOf(b)) if (field[y * map.w + x] !== 1) problems.push(`${label}: ${x},${y} unreachable`);

      // tops track EDGE.WALL exactly: a stale top on an opening would make
      // los() read a height off a door, a zero top on a wall is a full block
      for (let y = 0; y <= MAP; y++)
        for (let x = 0; x < MAP; x++) {
          const want = map.hEdge(x, y) === EDGE.WALL ? stories * FLOOR_H : 0;
          if (map.hEdgeTop(x, y) !== want) problems.push(`${label}: hEdgeTop(${x},${y}) ${map.hEdgeTop(x, y)} != ${want}`);
        }
      for (let y = 0; y < MAP; y++)
        for (let x = 0; x <= MAP; x++) {
          const want = map.vEdge(x, y) === EDGE.WALL ? stories * FLOOR_H : 0;
          if (map.vEdgeTop(x, y) !== want) problems.push(`${label}: vEdgeTop(${x},${y}) ${map.vEdgeTop(x, y)} != ${want}`);
        }

      let stairs = 0;
      for (let i = 0; i < map.stairs.length; i++) stairs += map.stairs[i];
      if (stairs !== (stories >= 2 ? 1 : 0)) problems.push(`${label}: ${stairs} stairs at ${stories} storeys`);
    }
    expect(problems).toEqual([]);
  });
});

describe('bourg stampStructure — invariants it refuses to break', () => {
  const base: Building = { x: 10, y: 10, w: 6, h: 5 };

  it('rejects parts[0] that is not the primary mass', () => {
    expect(() =>
      stampStructure(fresh(), { ...base, parts: [{ x: 11, y: 10, w: 6, h: 5 }] }, 0),
    ).toThrow(/parts\[0\]/);
  });

  it('rejects overlapping parts', () => {
    expect(() =>
      stampStructure(fresh(), { ...base, parts: [{ x: 10, y: 10, w: 6, h: 5 }, { x: 13, y: 12, w: 6, h: 5 }] }, 0),
    ).toThrow(/overlap/);
  });

  it('rejects a structure overlapping one already stamped', () => {
    const map = fresh();
    stampStructure(map, base, 0);
    expect(() => stampStructure(map, { x: 13, y: 12, w: 6, h: 5 }, 1)).toThrow(/overlaps building 0/);
  });

  it('rejects a footprint that would write an edge off-grid', () => {
    expect(() => stampStructure(fresh(), { x: MAP - 3, y: 10, w: 6, h: 5 }, 0)).toThrow(/outside the/);
    expect(() => stampStructure(fresh(), { x: -1, y: 10, w: 6, h: 5 }, 0)).toThrow(/outside the/);
  });

  it('rejects a door that is not on the structure boundary', () => {
    expect(() => stampStructure(fresh(), { ...base, doors: [{ x: 12, y: 12, side: 'n', width: 1 }] }, 0)).toThrow(
      /not on the structure's boundary/,
    );
  });

  it('rejects a door punched into an abutting neighbour', () => {
    const map = fresh();
    stampStructure(map, { x: 10, y: 10, w: 6, h: 5 }, 0);
    expect(() => stampStructure(map, { x: 16, y: 10, w: 6, h: 5, doors: [{ x: 16, y: 12, side: 'w', width: 1 }] }, 1)).toThrow(
      /abutting structure/,
    );
  });

  it('never writes an edge outside the structure bbox, and leaves the rest of the map pristine', () => {
    const map = fresh();
    const before = edgeCounts(map);
    expect(before[EDGE.WALL]).toBe(0);
    stampStructure(map, { x: 20, y: 20, w: 9, h: 9, doors: [{ x: 24, y: 28, side: 's', width: 1 }] }, 0);
    // no edge anywhere outside [19..30] x [19..30]
    for (let y = 0; y <= MAP; y++)
      for (let x = 0; x < MAP; x++)
        if (x < 19 || x > 30 || y < 19 || y > 30) expect(map.hEdge(x, y)).toBe(EDGE.NONE);
    for (let y = 0; y < MAP; y++)
      for (let x = 0; x <= MAP; x++)
        if (x < 19 || x > 30 || y < 19 || y > 30) expect(map.vEdge(x, y)).toBe(EDGE.NONE);
  });
});
