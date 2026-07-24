import { describe, expect, it } from 'vitest';
import { EDGE, FLOOR_H, GameMap, los } from '../src/sim/map';

// Slab LOS (plan 2026-07-23-3d-height-sim §3): floor/ceiling slab planes are
// derived per tile (z_k = elev + k*FLOOR_H, k = 1..stories), stair tiles are
// the openings, and the old buildingId endpoint heuristic is retired.

// 4x4 two-story building at tiles (5..8, 5..8): floor tiles, buildingId 0,
// stories 2, perimeter walls stamped to one story (top = FLOOR_H) so upper
// rays clear the wall tops. Stair position is set per-test.
function buildingMap(): GameMap {
  const m = new GameMap(20, 20);
  for (let y = 5; y <= 8; y++)
    for (let x = 5; x <= 8; x++) {
      m.setTerrain(x, y, 'floor');
      m.buildingId[y * m.w + x] = 0;
      m.stories[y * m.w + x] = 2;
    }
  m.maxStories = 2;
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
  return m;
}

describe('slab LOS', () => {
  it('same-building cross-floor is blocked by the slab (heuristic retired)', () => {
    const m = buildingMap();
    m.stairs[5 * m.w + 6] = 1; // stair at (6,5) — off the y=6 ray
    // (5.5,6.5) ground -> (7.5,6.5) upstairs: enters (6,6) at z 2.35, exits
    // at z 3.85 — straddles the z=3 floor slab.
    expect(los(m, 5.5, 6.5, 7.5, 6.5, 0, 1).visible).toBe(false);
    // adjacent-tile case: the straddle happens inside the OBSERVER'S OWN
    // tile (ray exits it at z 3.1, having crossed the z=3 slab within it).
    expect(los(m, 5.5, 6.5, 6.5, 6.5, 0, 1).visible).toBe(false);
  });

  it('stairwell sightline is open between floors', () => {
    const m = buildingMap();
    m.stairs[6 * m.w + 6] = 1; // stair at (6,6) — directly on the ray
    // The slab plane is crossed while over the stair tile (the opening), so
    // no straddle is ever tested: down->up and up->down both pass.
    expect(los(m, 5.5, 6.5, 7.5, 6.5, 0, 1).visible).toBe(true);
    expect(los(m, 7.5, 6.5, 5.5, 6.5, 1, 0).visible).toBe(true);
  });

  it('elevated ray through a building\'s upper airspace is blocked by the slab', () => {
    const m = buildingMap();
    // Observer on a 9m hill at (2,6) (eye z 10.6) -> ground target at (12,6)
    // (eye z 1.6). The ray clears the west wall top at z 8.35 and would clear
    // the east one at z 4.75 (tops at 3), but straddles the z=6 roof slab
    // inside tile (7,6) (segment z 6.55 -> 5.65).
    m.elev[6 * m.w + 2] = 9;
    expect(los(m, 2.5, 6.5, 12.5, 6.5, 0, 0).visible).toBe(false);
    // Control: hill-to-hill at 8m both ends flies flat at z 9.6, OVER the 6m
    // roof slab — clears the wall tops and straddles nothing, so it passes.
    m.elev[6 * m.w + 12] = 8;
    m.elev[6 * m.w + 2] = 8;
    expect(los(m, 2.5, 6.5, 12.5, 6.5, 0, 0).visible).toBe(true);
  });

  it('upstairs window shot still works (regression)', () => {
    const m = buildingMap();
    m.setVEdge(5, 6, EDGE.WINDOW); // west wall of the observer's room
    // Upstairs eye (z 4.6) at (5.5,6.5) -> outside ground target (2.5,6.5):
    // crosses the window edge at z 4.1, enters no slab-bearing tile.
    const r = los(m, 5.5, 6.5, 2.5, 6.5, 1, 0);
    expect(r.visible).toBe(true);
  });

  it('flat maps are byte-identical — levels change nothing', () => {
    const m = new GameMap(20, 20);
    expect(m.maxStories).toBe(0);
    const rays: [number, number, number, number][] = [
      [2.5, 2.5, 17.5, 2.5],
      [2.5, 2.5, 17.5, 17.5],
      [18.5, 3.5, 1.5, 18.5],
      [5.5, 5.5, 5.5, 12.5],
    ];
    for (const [x0, y0, x1, y1] of rays) {
      const flat = los(m, x0, y0, x1, y1, 0, 0);
      for (const [l0, l1] of [[0, 1], [1, 0], [2, 1]] as const) {
        expect(los(m, x0, y0, x1, y1, l0, l1)).toEqual(flat);
      }
    }
  });
});
