import { describe, expect, it } from 'vitest';
import { BREACH_COVER, BREACH_LIP, BREACH_WIDE, ECLASS, EDGE, FLOOR_H, GameMap, edgeClass, los } from '../src/sim/map';

// Destructible terrain (docs/plans/2026-07-27-destructible-terrain-design.md).
// D1: the edge code, the derived class, the passage rules and the rubble-lip
// cover branch. Nothing here breaches anything — it pins the primitives.

function wallMap(): GameMap {
  const m = new GameMap(20, 20);
  // free-standing garden wall, waist high, on the west side of (10, 10)
  m.setVEdge(10, 10, EDGE.WALL);
  m.vEdgeTops[10 * (m.w + 1) + 10] = 1;
  // free-standing enclosure wall, head high, west side of (10, 11)
  m.setVEdge(10, 11, EDGE.WALL);
  m.vEdgeTops[11 * (m.w + 1) + 10] = 2;
  // gate in the run
  m.setVEdge(10, 12, EDGE.DOOR);
  return m;
}

// 4x4 one-story building at (5..8, 5..8), masonry perimeter, one window and
// one door on the west face.
function buildingMap(): GameMap {
  const m = new GameMap(20, 20);
  for (let y = 5; y <= 8; y++)
    for (let x = 5; x <= 8; x++) {
      m.setTerrain(x, y, 'floor');
      m.buildingId[y * m.w + x] = 0;
      m.stories[y * m.w + x] = 1;
    }
  m.maxStories = 1;
  for (let y = 5; y <= 8; y++) {
    m.setVEdge(5, y, EDGE.WALL);
    m.vEdgeTops[y * (m.w + 1) + 5] = FLOOR_H;
    m.setVEdge(9, y, EDGE.WALL);
    m.vEdgeTops[y * (m.w + 1) + 9] = FLOOR_H;
  }
  for (let x = 5; x <= 8; x++) {
    m.setHEdge(x, 5, EDGE.WALL);
    m.hEdgeTops[5 * m.w + x] = FLOOR_H;
    m.setHEdge(x, 9, EDGE.WALL);
    m.hEdgeTops[9 * m.w + x] = FLOOR_H;
  }
  m.setVEdge(5, 6, EDGE.WINDOW);
  m.vEdgeTops[6 * (m.w + 1) + 5] = 0;
  m.setVEdge(5, 7, EDGE.DOOR);
  m.vEdgeTops[7 * (m.w + 1) + 5] = 0;
  return m;
}

describe('D1 edgeClass', () => {
  it('derives every class from the edge byte, the top byte and buildingId', () => {
    const g = wallMap();
    expect(edgeClass(g, 10, 10, false)).toBe(ECLASS.WALL_LOW);
    expect(edgeClass(g, 10, 11, false)).toBe(ECLASS.WALL_HIGH);
    expect(edgeClass(g, 10, 12, false)).toBe(ECLASS.GATE);
    expect(edgeClass(g, 0, 0, false)).toBe(ECLASS.NONE);

    const b = buildingMap();
    expect(edgeClass(b, 5, 5, false)).toBe(ECLASS.MASONRY);
    expect(edgeClass(b, 5, 6, false)).toBe(ECLASS.WINDOW);
    expect(edgeClass(b, 5, 7, false)).toBe(ECLASS.DOOR); // a door WITH a building is not a gate
    expect(edgeClass(b, 5, 5, true)).toBe(ECLASS.MASONRY); // horizontal face
  });

  it('an already-breached edge is no longer a candidate', () => {
    const g = wallMap();
    g.setVEdge(10, 10, EDGE.BREACH);
    g.vEdgeTops[10 * (g.w + 1) + 10] = BREACH_LIP;
    expect(edgeClass(g, 10, 10, false)).toBe(ECLASS.NONE);
  });

  it('a full-height legacy wall (top 0) reads as masonry, not as a garden wall', () => {
    const m = new GameMap(20, 20);
    m.setVEdge(10, 10, EDGE.WALL); // top stays 0
    expect(edgeClass(m, 10, 10, false)).toBe(ECLASS.MASONRY);
  });
});

describe('D1 canStep across a breach', () => {
  it('foot passes a lip, a hull does not; a wide breach passes both', () => {
    const m = wallMap();
    expect(m.canStep(9, 10, 10, 10, 'foot')).toBe(false);
    expect(m.canStep(9, 10, 10, 10, 'vehicle')).toBe(false);

    m.setVEdge(10, 10, EDGE.BREACH);
    m.vEdgeTops[10 * (m.w + 1) + 10] = BREACH_LIP;
    expect(m.canStep(9, 10, 10, 10, 'foot')).toBe(true);
    expect(m.canStep(10, 10, 9, 10, 'foot')).toBe(true); // symmetric
    expect(m.canStep(9, 10, 10, 10, 'vehicle')).toBe(false);

    m.vEdgeTops[10 * (m.w + 1) + 10] = BREACH_WIDE;
    expect(m.canStep(9, 10, 10, 10, 'vehicle')).toBe(true);
  });

  it('horizontal breaches read their own top byte', () => {
    const m = new GameMap(20, 20);
    m.setHEdge(10, 10, EDGE.BREACH);
    m.hEdgeTops[10 * m.w + 10] = BREACH_LIP;
    expect(m.canStep(10, 9, 10, 10, 'foot')).toBe(true);
    expect(m.canStep(10, 9, 10, 10, 'vehicle')).toBe(false);
    m.hEdgeTops[10 * m.w + 10] = BREACH_WIDE;
    expect(m.canStep(10, 9, 10, 10, 'vehicle')).toBe(true);
    expect(m.canStep(10, 10, 10, 9, 'vehicle')).toBe(true); // symmetric
  });

  it('leaves every pre-existing edge rule alone', () => {
    const b = buildingMap();
    expect(b.canStep(4, 7, 5, 7, 'foot')).toBe(true); // door
    expect(b.canStep(4, 7, 5, 7, 'vehicle')).toBe(false);
    expect(b.canStep(4, 6, 5, 6, 'foot')).toBe(false); // window
    expect(b.canStep(4, 5, 5, 5, 'foot')).toBe(false); // wall
    expect(b.canStep(1, 1, 2, 1, 'vehicle')).toBe(true); // open ground
  });
});

describe('D1 rubble-lip cover', () => {
  it('grants BREACH_COVER when the ray crosses the lip within 2m of the target', () => {
    const m = wallMap();
    m.setVEdge(10, 10, EDGE.BREACH);
    expect(los(m, 5.5, 10.5, 10.5, 10.5).cover).toBeCloseTo(BREACH_COVER, 12);
  });

  it('grants nothing when the target is far past the lip', () => {
    const m = wallMap();
    m.setVEdge(10, 10, EDGE.BREACH);
    expect(los(m, 5.5, 10.5, 17.5, 10.5).cover).toBe(0);
  });

  it('does not block sight, and a window still beats it', () => {
    const m = wallMap();
    m.setVEdge(10, 10, EDGE.BREACH);
    expect(los(m, 5.5, 10.5, 10.5, 10.5).visible).toBe(true);
    const b = buildingMap();
    b.setVEdge(5, 6, EDGE.WINDOW);
    expect(los(b, 3.5, 6.5, 5.5, 6.5).cover).toBeCloseTo(0.5, 12); // window cover unchanged
  });
});
