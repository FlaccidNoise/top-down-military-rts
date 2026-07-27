import { describe, expect, it } from 'vitest';
import { BREACH_COVER, BREACH_LIP, BREACH_WIDE, ECLASS, EDGE, FLOOR_H, GameMap, edgeClass, los } from '../src/sim/map';
import { Sim, type BreachEvent } from '../src/sim/sim';

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

// ── D2: blast breaching ────────────────────────────────────────────────────

type BlastP = { suppRadius: number; fragRadius: number; frags: number; dmg: [number, number]; breach?: number };
type ExplodeFn = (x: number, y: number, p?: BlastP, l?: number) => void;
const boom = (sim: Sim): ExplodeFn => (sim as unknown as { explode: ExplodeFn }).explode.bind(sim);

// A north-south run of free-standing wall on the west side of column 10,
// rows 8..14, with a gate at row 12. `top` picks waist (1) or head (2).
function wallRun(top: 1 | 2): GameMap {
  const m = new GameMap(24, 24);
  for (let y = 8; y <= 14; y++) {
    m.setVEdge(10, y, EDGE.WALL);
    m.vEdgeTops[y * (m.w + 1) + 10] = top;
  }
  m.setVEdge(10, 12, EDGE.DOOR); // gate
  m.vEdgeTops[12 * (m.w + 1) + 10] = 0;
  return m;
}

const GRENADE: BlastP = { suppRadius: 6, fragRadius: 3, frags: 2, dmg: [20, 55], breach: 2 };
const MORTAR_81: BlastP = { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 75], breach: 5 };
const TANK_HE: BlastP = { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 60], breach: 7 };
const STRAFE: BlastP = { suppRadius: 12, fragRadius: 5, frags: 2, dmg: [25, 70], breach: 0 };
const WALL_SHOT: BlastP = { suppRadius: 8, fragRadius: 3, frags: 1, dmg: [20, 50], breach: 12 };

describe('D2 threshold table', () => {
  it('a grenade at the gate opens the gate and nothing else', () => {
    const sim = new Sim(wallRun(2), 1);
    boom(sim)(10.3, 12.5, GRENADE);
    expect(sim.map.vEdge(10, 12)).toBe(EDGE.BREACH);
    for (const y of [11, 13]) expect(sim.map.vEdge(10, y)).toBe(EDGE.WALL);
    expect(sim.breachLog.map((b) => [b.x, b.y, b.cls])).toEqual([[10, 12, ECLASS.GATE]]);
  });

  it('a grenade cannot open a head-high enclosure wall; an 81 mm round can, on a direct hit', () => {
    const g = new Sim(wallRun(2), 1);
    boom(g)(10.3, 10.5, GRENADE);
    expect(g.map.vEdge(10, 10)).toBe(EDGE.WALL);

    // 81 mm energy (5) equals the WALL_HIGH threshold (5) exactly, so linear
    // falloff means the round has to land ON the wall. Balance knife-edge,
    // pinned deliberately: nudge either constant and this test says so.
    const hit = new Sim(wallRun(2), 1);
    boom(hit)(10.0, 10.5, MORTAR_81);
    expect(hit.map.vEdge(10, 10)).toBe(EDGE.BREACH);
    const near = new Sim(wallRun(2), 1);
    boom(near)(10.3, 10.5, MORTAR_81); // 4.7 at the face — not enough
    expect(near.map.vEdge(10, 10)).toBe(EDGE.WALL);
  });

  it('nothing short of a deliberate wall shot opens masonry', () => {
    for (const p of [GRENADE, MORTAR_81, TANK_HE]) {
      const sim = new Sim(buildingMap(), 1);
      boom(sim)(4.3, 5.5, p); // hard against the west face
      expect(sim.map.vEdge(5, 5)).toBe(EDGE.WALL);
    }
    const sim = new Sim(buildingMap(), 1);
    boom(sim)(4.3, 5.5, WALL_SHOT);
    expect(sim.map.vEdge(5, 5)).toBe(EDGE.BREACH);
  });

  it('a strafing run (breach 0) opens nothing at all', () => {
    const sim = new Sim(wallRun(1), 1);
    boom(sim)(10.3, 12.5, STRAFE); // right on the gate, the softest thing there is
    expect(sim.breachLog).toHaveLength(0);
  });

  it('energy falls off linearly, so the same round opens a wall up close and not at range', () => {
    const near = new Sim(wallRun(1), 1); // waist wall, THRESH 3, mortar 5
    boom(near)(10.5, 10.5, MORTAR_81); // d = 0.5 -> 4.5
    expect(near.map.vEdge(10, 10)).toBe(EDGE.BREACH);
    const far = new Sim(wallRun(1), 1);
    boom(far)(12.5, 10.5, MORTAR_81); // d = 2.5 -> 2.5, below 3
    expect(far.map.vEdge(10, 10)).toBe(EDGE.WALL);
  });
});

describe('D2 width code', () => {
  it('tank HE and above leave a hull-wide hole; smaller rounds leave a lip', () => {
    const lip = new Sim(wallRun(1), 1);
    boom(lip)(10.3, 10.5, MORTAR_81);
    expect(lip.map.vEdgeTop(10, 10)).toBe(BREACH_LIP);
    expect(lip.map.canStep(9, 10, 10, 10, 'vehicle')).toBe(false);

    const wide = new Sim(wallRun(1), 1);
    boom(wide)(10.3, 10.5, TANK_HE);
    expect(wide.map.vEdgeTop(10, 10)).toBe(BREACH_WIDE);
    expect(wide.breachLog.every((b) => b.wide)).toBe(true);
    expect(wide.map.canStep(9, 10, 10, 10, 'vehicle')).toBe(true);
  });
});

describe('D2 occlusion guard', () => {
  it('a burst inside a walled yard does not open the far wall of the house next door', () => {
    const m = buildingMap(); // house at (5..8, 5..8), masonry
    // head-high yard wall two tiles west of the house's west face
    for (let y = 4; y <= 9; y++) {
      m.setVEdge(3, y, EDGE.WALL);
      m.vEdgeTops[y * (m.w + 1) + 3] = 2;
    }
    const sim = new Sim(m, 1);
    // Burst west of the yard wall, in range of both it and the house face.
    boom(sim)(2.5, 6.5, WALL_SHOT);
    expect(sim.map.vEdge(3, 6)).toBe(EDGE.BREACH); // the near wall goes
    expect(sim.map.vEdge(5, 6)).not.toBe(EDGE.BREACH); // the house behind it does not
  });

  it('a head-high wall is breachable from EITHER side — the guard must not see the wall itself', () => {
    for (const bx of [9.7, 10.3]) {
      const sim = new Sim(wallRun(2), 1);
      boom(sim)(bx, 10.5, WALL_SHOT);
      expect(sim.map.vEdge(10, 10)).toBe(EDGE.BREACH);
    }
  });
});

describe('D2 cap and ordering', () => {
  it('opens at most 4 edges per explosion, in a fixed row-major scan order', () => {
    const sim = new Sim(wallRun(1), 1);
    boom(sim)(10.5, 11.5, WALL_SHOT); // radius 3 covers the whole run
    expect(sim.breachLog).toHaveLength(4);
    const ys = sim.breachLog.map((b) => b.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b)); // row-major
  });

  it('replays identically: same seed, same orders, same insertion-ordered breach log', () => {
    const run = (): BreachEvent[] => {
      const sim = new Sim(wallRun(1), 7);
      for (let i = 0; i < 6; i++) boom(sim)(10.5 + (i % 3), 9.5 + i * 0.5, MORTAR_81);
      return sim.breachLog;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('D2 draws no rng', () => {
  it('a breachable wall in the blast does not perturb a single frag roll', () => {
    const withWall = new Sim(wallRun(1), 3);
    withWall.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 11.5, y: 10.5, courage: 0.5 }]);
    boom(withWall)(10.5, 10.5, MORTAR_81);

    const bare = new Sim(new GameMap(24, 24), 3);
    bare.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 11.5, y: 10.5, courage: 0.5 }]);
    boom(bare)(10.5, 10.5, MORTAR_81);

    expect(withWall.breachLog.length).toBeGreaterThan(0); // the scan really ran
    expect(withWall.soldiers[0].wounds).toEqual(bare.soldiers[0].wounds);
    expect(withWall.soldiers[0].suppression).toBe(bare.soldiers[0].suppression);
  });
});

describe('D2 event channels', () => {
  it('takeBreaches drains; breachLog is append-only', () => {
    const sim = new Sim(wallRun(1), 1);
    boom(sim)(10.5, 10.5, MORTAR_81);
    const first = sim.takeBreaches();
    expect(first.length).toBeGreaterThan(0);
    expect(sim.takeBreaches()).toHaveLength(0);
    expect(sim.breachLog).toHaveLength(first.length);

    boom(sim)(10.5, 13.5, MORTAR_81);
    expect(sim.takeBreaches().length).toBeGreaterThan(0);
    expect(sim.breachLog.length).toBeGreaterThan(first.length);
  });

  it('a breach is not a boom: nothing extra lands on the crater channel', () => {
    const sim = new Sim(wallRun(1), 1);
    boom(sim)(10.5, 10.5, MORTAR_81);
    expect(sim.takeBooms()).toHaveLength(1); // the detonation itself, not one per breach
  });

  it('an already-open edge is never re-breached', () => {
    const sim = new Sim(wallRun(1), 1);
    boom(sim)(10.5, 10.5, MORTAR_81);
    const n = sim.breachLog.length;
    boom(sim)(10.5, 10.5, MORTAR_81);
    expect(sim.breachLog).toHaveLength(n);
  });
});
