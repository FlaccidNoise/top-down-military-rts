import { describe, expect, it } from 'vitest';
import { BREACH_COVER, BREACH_LIP, BREACH_WIDE, ECLASS, EDGE, FLOOR_H, GameMap, edgeClass, edgeMid, los, nearestBreachable } from '../src/sim/map';
import { astar, BREACH_STEP, CRUSH_STEP } from '../src/sim/path';
import { RedCommander } from '../src/sim/ai';
import { newCampaign } from '../src/campaign/campaign';
import { generateMap } from '../src/sim/mapgen';
import { applyEngagementOutcome, applyScars, breachScars, makeStrategicBattle, newFront } from '../src/strategic/bridge';
import { makeDefaultSector } from '../src/strategic/sector';
import { visibleEnemies } from '../src/sim/orders';
import { SPOT_INTERVAL, Sim, type BreachEvent } from '../src/sim/sim';

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

// ── D3: crossing a rubble lip costs time ───────────────────────────────────

describe('D3 A* rubble-lip cost', () => {
  // A solid north-south wall across the whole map with ONE hole in it, so the
  // hole is the only crossing and A* has to price it.
  function pierced(): GameMap {
    const m = new GameMap(24, 24);
    for (let y = 0; y < 24; y++) {
      m.setVEdge(10, y, EDGE.WALL);
      m.vEdgeTops[y * (m.w + 1) + 10] = 2;
    }
    return m;
  }

  it('a lip is passable but priced above open ground', () => {
    const m = pierced();
    expect(astar(m, 8, 12, 12, 12, 'foot')).toBeNull(); // sealed

    m.setVEdge(10, 12, EDGE.BREACH);
    m.vEdgeTops[12 * (m.w + 1) + 10] = BREACH_LIP;
    m.hasBreach = true;
    const p = astar(m, 8, 12, 12, 12, 'foot');
    expect(p).not.toBeNull();
    expect(p!.some((n) => n.x === 10 && n.y === 12)).toBe(true);
  });

  it('a door two tiles away beats the hole; a hole beats a long detour', () => {
    const near = pierced();
    near.setVEdge(10, 12, EDGE.BREACH);
    near.vEdgeTops[12 * (near.w + 1) + 10] = BREACH_LIP;
    near.setVEdge(10, 14, EDGE.DOOR); // free crossing, 2 rows south
    near.hasBreach = true;
    expect(astar(near, 8, 12, 12, 12, 'foot')!.some((n) => n.x === 10 && n.y === 14)).toBe(true);

    const far = pierced();
    far.setVEdge(10, 12, EDGE.BREACH);
    far.vEdgeTops[12 * (far.w + 1) + 10] = BREACH_LIP;
    far.setVEdge(10, 22, EDGE.DOOR); // free, but ten rows away
    far.hasBreach = true;
    expect(astar(far, 8, 12, 12, 12, 'foot')!.some((n) => n.x === 10 && n.y === 12)).toBe(true);
  });

  it('costs nothing on an unbreached map — hasBreach gates the whole check', () => {
    const m = new GameMap(24, 24);
    expect(m.hasBreach).toBe(false);
    expect(m.breachBetween(9, 12, 10, 12)).toBe(false);
    expect(BREACH_STEP).toBeGreaterThan(0);
  });
});

describe('D3 scramble timer', () => {
  it('a man crossing a lip stalls, then carries on — and it is not the climb timer', () => {
    const m = new GameMap(24, 24);
    for (let y = 0; y < 24; y++) {
      m.setVEdge(10, y, EDGE.WALL);
      m.vEdgeTops[y * (m.w + 1) + 10] = 2;
    }
    m.setVEdge(10, 12, EDGE.BREACH);
    m.vEdgeTops[12 * (m.w + 1) + 10] = BREACH_LIP;
    m.hasBreach = true;

    const sim = new Sim(m, 5);
    const squad = sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 6.5, y: 12.5 }]);
    sim.orderTeam(squad.teamIds[0], { kind: 'fast', x: 14.5, y: 12.5 });
    let stalledTick = -1;
    for (let i = 0; i < 900; i++) {
      sim.step();
      const s = sim.soldiers[0];
      if (s.scrambleLeft > 0 && stalledTick < 0) stalledTick = i;
      expect(s.climbLeft).toBe(0); // horizontal scramble never touches the level machinery
      expect(s.level).toBe(0);
    }
    expect(stalledTick).toBeGreaterThan(0); // he really did clamber through
    expect(sim.soldiers[0].x).toBeGreaterThan(12); // and he got to the far side
    expect(sim.soldiers[0].scrambleLeft).toBe(0);
  });
});

// ── D4: vehicle crush ──────────────────────────────────────────────────────

describe('D4 crush modes in canStep', () => {
  // One free-standing edge of each class on the west side of column 10.
  function classRow(): GameMap {
    const m = new GameMap(24, 24);
    m.setVEdge(10, 2, EDGE.WALL); //                       WALL_LOW
    m.vEdgeTops[2 * (m.w + 1) + 10] = 1;
    m.setVEdge(10, 3, EDGE.WALL); //                       WALL_HIGH
    m.vEdgeTops[3 * (m.w + 1) + 10] = 2;
    m.setVEdge(10, 4, EDGE.DOOR); //                       GATE
    m.setVEdge(10, 5, EDGE.BREACH); //                     lip
    m.vEdgeTops[5 * (m.w + 1) + 10] = BREACH_LIP;
    m.setVEdge(10, 6, EDGE.BREACH); //                     wide
    m.vEdgeTops[6 * (m.w + 1) + 10] = BREACH_WIDE;
    return m;
  }

  it('matches the §2.1 table exactly', () => {
    const m = classRow();
    const row = (y: number) => (['vehicle', 'crush_light', 'crush_heavy'] as const).map((mode) => m.canStep(9, y, 10, y, mode));
    expect(row(1)).toEqual([true, true, true]); //   NONE
    expect(row(2)).toEqual([false, true, true]); //  WALL_LOW  — crushed by both tiers
    expect(row(3)).toEqual([false, false, true]); // WALL_HIGH — tank only
    expect(row(4)).toEqual([false, true, true]); //  GATE
    expect(row(5)).toEqual([false, true, true]); //  BREACH lip — a hull widens it
    expect(row(6)).toEqual([true, true, true]); //   BREACH wide
  });

  it('never opens a building to a hull, at any tier', () => {
    const b = buildingMap();
    for (const mode of ['vehicle', 'crush_light', 'crush_heavy'] as const) {
      expect(b.canStep(4, 5, 5, 5, mode)).toBe(false); // masonry
      expect(b.canStep(4, 6, 5, 6, mode)).toBe(false); // window
      expect(b.canStep(4, 7, 5, 7, mode)).toBe(false); // house door
      expect(b.canStep(5, 5, 6, 5, mode)).toBe(false); // and the floor itself (noVehicle)
    }
  });

  it('hedges stay hard for every tier — the bocage is the map, not an obstacle', () => {
    const m = new GameMap(24, 24);
    m.setTerrain(10, 10, 'hedge');
    for (const mode of ['vehicle', 'crush_light', 'crush_heavy'] as const) {
      expect(m.canStep(9, 10, 10, 10, mode)).toBe(false);
    }
    expect(m.canStep(9, 10, 10, 10, 'foot')).toBe(true);
  });
});

describe('D4 crush pathing cost', () => {
  function sealed(): GameMap {
    const m = new GameMap(24, 24);
    for (let y = 0; y < 24; y++) {
      m.setVEdge(10, y, EDGE.WALL);
      m.vEdgeTops[y * (m.w + 1) + 10] = 1; // waist wall the whole way
    }
    return m;
  }

  it('a careful hull finds no route where a crushing one drives through', () => {
    const m = sealed();
    expect(astar(m, 8, 12, 12, 12, 'vehicle')).toBeNull();
    expect(astar(m, 8, 12, 12, 12, 'crush_light')).not.toBeNull();
    expect(astar(m, 8, 12, 12, 12, 'crush_heavy')).not.toBeNull();
  });

  it('takes the open gap when one is close, and drives through when it is not', () => {
    const near = sealed();
    for (let y = 13; y <= 14; y++) near.setVEdge(10, y, EDGE.NONE);
    expect(astar(near, 8, 12, 12, 12, 'crush_light')!.some((n) => n.x === 10 && n.y >= 13)).toBe(true);

    const far = sealed();
    far.setVEdge(10, 23, EDGE.NONE); // open, but eleven rows away
    expect(astar(far, 8, 12, 12, 12, 'crush_light')!.every((n) => n.y < 20)).toBe(true);
  });

  it('crush mode never leaks into the plain vehicle mode', () => {
    const m = sealed();
    expect(m.canStep(9, 12, 10, 12, 'vehicle')).toBe(false);
    expect(astar(m, 8, 12, 12, 12, 'vehicle')).toBeNull();
    expect(CRUSH_STEP).toBeGreaterThan(BREACH_STEP);
  });
});

describe('D4 the crush event', () => {
  // A single waist-high wall segment with a tank/halftrack west of it.
  function oneWall(top: 1 | 2): GameMap {
    const m = new GameMap(40, 20);
    for (let y = 0; y < 20; y++) {
      m.setVEdge(20, y, EDGE.WALL);
      m.vEdgeTops[y * (m.w + 1) + 20] = top;
    }
    return m;
  }

  function drive(kind: 'sherman' | 'm3_halftrack', top: 1 | 2, ticks = 900): Sim {
    const sim = new Sim(oneWall(top), 11);
    const v = sim.addVehicle('blue', kind, 10.5, 10.5, 0);
    sim.orderVehicleMove(v.id, 30.5, 10.5);
    for (let i = 0; i < ticks; i++) sim.step();
    return sim;
  }

  it('a halftrack flattens a waist wall flush — no rubble lip left behind', () => {
    const sim = drive('m3_halftrack', 1);
    expect(sim.vehicles[0].x).toBeGreaterThan(20);
    const ev = sim.breachLog.filter((b) => b.cause === 'crush');
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].cls).toBe(ECLASS.WALL_LOW);
    expect(sim.map.vEdge(20, ev[0].y)).toBe(EDGE.NONE); // flattened, not holed
    expect(sim.map.vEdgeTop(20, ev[0].y)).toBe(0);
  });

  it('a halftrack cannot take a head-high wall; a Sherman can, and leaves a hull-wide breach', () => {
    const light = drive('m3_halftrack', 2);
    expect(light.vehicles[0].x).toBeLessThan(20);
    expect(light.breachLog).toHaveLength(0);

    const heavy = drive('sherman', 2);
    expect(heavy.vehicles[0].x).toBeGreaterThan(20);
    const ev = heavy.breachLog.filter((b) => b.cause === 'crush');
    expect(ev).toHaveLength(1);
    expect(ev[0].cls).toBe(ECLASS.WALL_HIGH);
    expect(ev[0].wide).toBe(true);
    expect(heavy.map.vEdge(20, ev[0].y)).toBe(EDGE.BREACH);
    expect(heavy.map.vEdgeTop(20, ev[0].y)).toBe(BREACH_WIDE);
  });

  it('the tank stalls in the gap and rattles both sides while it does it', () => {
    const sim = new Sim(oneWall(2), 11);
    const v = sim.addVehicle('blue', 'sherman', 10.5, 10.5, 0);
    // one man each side of the wall, neither of them the tank's crew
    sim.addSquad('blue', 'a', [{ name: 'W', weapon: 'garand', x: 18.5, y: 10.5, courage: 0.5 }]);
    sim.addSquad('red', 'b', [{ name: 'E', weapon: 'kar98k', x: 22.5, y: 10.5, courage: 0.5 }]);
    const blue = sim.soldiers.find((s) => s.name === 'W')!;
    const red = sim.soldiers.find((s) => s.name === 'E')!;
    sim.orderVehicleMove(v.id, 30.5, 10.5);
    let stalled = 0;
    let suppAtCrush = { blue: 0, red: 0 };
    for (let i = 0; i < 900; i++) {
      sim.step();
      if (v.crushLeft > 0) {
        if (stalled === 0) suppAtCrush = { blue: blue.suppression, red: red.suppression };
        stalled++;
      }
    }
    expect(stalled).toBeGreaterThan(0);
    expect(suppAtCrush.blue).toBeGreaterThan(0); // both sides flinch, not just the enemy
    expect(suppAtCrush.red).toBeGreaterThan(0);
  });

  it('a crush is not a boom and draws no rng — two same-seed runs match byte for byte', () => {
    const snap = (): string => {
      const sim = new Sim(oneWall(2), 11);
      const v = sim.addVehicle('blue', 'sherman', 10.5, 10.5, 0);
      sim.orderVehicleMove(v.id, 30.5, 10.5);
      for (let i = 0; i < 600; i++) sim.step();
      return sim.snapshot() + JSON.stringify(sim.breachLog);
    };
    expect(snap()).toBe(snap());
  });
});

// ── D5: player-directed breaching ──────────────────────────────────────────

describe('D5 wall-target resolution', () => {
  it('picks the nearest standing edge and ignores an already-open one', () => {
    const m = wallRun(2);
    expect(nearestBreachable(m, 10.2, 10.4, 2.5)).toEqual({ x: 10, y: 10, horiz: false });
    expect(nearestBreachable(m, 10.2, 13.4, 2.5)).toEqual({ x: 10, y: 13, horiz: false });
    expect(nearestBreachable(m, 3.5, 3.5, 2.5)).toBeNull(); // open ground

    m.setVEdge(10, 10, EDGE.BREACH); // the hole is not a target
    expect(nearestBreachable(m, 10.0, 10.5, 0.9)).toBeNull();
  });

  it('edgeMid straddles the tile boundary the edge actually sits on', () => {
    expect(edgeMid({ x: 10, y: 4, horiz: false })).toEqual({ x: 10, y: 4.5 });
    expect(edgeMid({ x: 10, y: 4, horiz: true })).toEqual({ x: 10.5, y: 4 });
  });
});

describe('D5 the tank gun', () => {
  it('one aimed round opens masonry, and the order clears itself', () => {
    const sim = new Sim(buildingMap(), 9);
    const v = sim.addVehicle('blue', 'sherman', 2.5, 5.5, 0);
    const he = v.ammo.he;
    expect(sim.orderVehicleBreach(v.id, 5.0, 5.5)).toEqual({ x: 5, y: 5, horiz: false });
    sim.step();
    expect(sim.map.vEdge(5, 5)).toBe(EDGE.BREACH);
    expect(sim.map.vEdgeTop(5, 5)).toBe(BREACH_WIDE); // 12 energy: a hull-wide hole
    expect(v.wallTarget).toBeNull();
    expect(v.ammo.he).toBe(he - 1);
    expect(sim.breachLog.some((b) => b.x === 5 && b.y === 5 && !b.horiz && b.cls === ECLASS.MASONRY)).toBe(true);
  });

  it('a halftrack has nothing to shoot with', () => {
    const sim = new Sim(buildingMap(), 9);
    const v = sim.addVehicle('blue', 'm3_halftrack', 2.5, 5.5, 0);
    expect(sim.orderVehicleBreach(v.id, 5.0, 5.5)).toBeNull();
    expect(v.wallTarget).toBeNull();
  });

  it('holds the order — and its ammunition — while the wall is out of sight', () => {
    const sim = new Sim(buildingMap(), 9);
    const v = sim.addVehicle('blue', 'sherman', 2.5, 5.5, 0);
    const he = v.ammo.he;
    // The far (east) face of the house: the west face is between it and the gun.
    expect(sim.orderVehicleBreach(v.id, 9.0, 5.5)).toEqual({ x: 9, y: 5, horiz: false });
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.map.vEdge(9, 5)).toBe(EDGE.WALL);
    expect(v.wallTarget).not.toBeNull(); // still standing by, not cancelled
    expect(v.ammo.he).toBe(he);
  });

  it('a target somebody else opened is spent — no round is wasted on a hole', () => {
    const sim = new Sim(buildingMap(), 9);
    const v = sim.addVehicle('blue', 'sherman', 2.5, 5.5, 0);
    const he = v.ammo.he;
    sim.orderVehicleBreach(v.id, 5.0, 5.5);
    boom(sim)(5.0, 5.5, WALL_SHOT); // a faust team gets there first
    sim.step();
    expect(v.wallTarget).toBeNull();
    expect(v.ammo.he).toBe(he);
  });
});

describe('D5 infantry and crew-served AT', () => {
  it('a bazooka team opens the garden wall it was pointed at', () => {
    const sim = new Sim(wallRun(2), 9);
    const squad = sim.addSquad('blue', 'Z', [{ name: 'Z', weapon: 'bazooka', x: 7.5, y: 10.5 }]);
    const z = sim.soldiers[squad.soldierIds[0]];
    expect(sim.orderTeamBreach(squad.teamIds[0], 10.0, 10.5)).toEqual({ x: 10, y: 10, horiz: false });
    for (let i = 0; i < 30 && z.wallTarget; i++) sim.step();
    expect(sim.map.vEdge(10, 10)).toBe(EDGE.BREACH);
    expect(z.wallTarget).toBeNull();
    expect(z.magLeft).toBe(0); // the rocket went downrange
  });

  it('a rifle squad has nothing to breach with', () => {
    const sim = new Sim(wallRun(2), 9);
    const squad = sim.addSquad('blue', 'R', [{ name: 'R', weapon: 'garand', x: 7.5, y: 10.5 }]);
    expect(sim.orderSquadBreach(squad.id, 10.0, 10.5)).toBeNull();
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.map.vEdge(10, 10)).toBe(EDGE.WALL);
  });

  it('a deployed AT gun opens masonry; a mortar is never offered the order', () => {
    const gun = new Sim(buildingMap(), 9);
    const e = gun.addEmplacement('blue', 'at57', 2.5, 5.5, 0, 'deployed');
    expect(gun.orderEmplacementBreach(e.id, 5.0, 5.5)).toEqual({ x: 5, y: 5, horiz: false });
    for (let i = 0; i < 90 && e.wallTarget; i++) gun.step();
    expect(gun.map.vEdge(5, 5)).toBe(EDGE.BREACH);

    const tube = new Sim(buildingMap(), 9);
    const m = tube.addEmplacement('blue', 'mortar60', 2.5, 5.5, 0, 'deployed');
    expect(tube.orderEmplacementBreach(m.id, 5.0, 5.5)).toBeNull();
    expect(m.wallTarget).toBeNull();
  });
});

describe('D5 determinism', () => {
  it('a wall order replays byte for byte, snapshot and breach log alike', () => {
    const snap = (): string => {
      const sim = new Sim(buildingMap(), 21);
      const v = sim.addVehicle('blue', 'sherman', 2.5, 5.5, 0);
      sim.addSquad('red', 'D', [{ name: 'D', weapon: 'kar98k', x: 6.5, y: 5.5 }]);
      sim.orderVehicleBreach(v.id, 5.0, 5.5);
      for (let i = 0; i < 300; i++) sim.step();
      return sim.snapshot() + JSON.stringify(sim.breachLog);
    };
    expect(snap()).toBe(snap());
  });

  it('the wall target rides in the snapshot — an unshot order is visible state', () => {
    const sim = new Sim(buildingMap(), 9);
    const v = sim.addVehicle('blue', 'sherman', 2.5, 5.5, 0);
    const before = sim.snapshot();
    sim.orderVehicleBreach(v.id, 9.0, 5.5); // out of sight: the order persists
    expect(sim.snapshot()).not.toBe(before);
  });
});

// ── D6: the snapshot field ─────────────────────────────────────────────────

describe('D6 snapshot breach list', () => {
  // A lattice of waist-high garden walls: enough breachable edge in one place
  // to drive the log past thirty entries in a handful of rounds.
  function lattice(): GameMap {
    const m = new GameMap(40, 40);
    for (let x = 6; x <= 30; x += 3) {
      for (let y = 6; y <= 30; y++) {
        m.setVEdge(x, y, EDGE.WALL);
        m.vEdgeTops[y * (m.w + 1) + x] = 1;
      }
    }
    return m;
  }

  function shelled(seed: number): Sim {
    const sim = new Sim(lattice(), seed);
    for (let i = 0; i < 10; i++) boom(sim)(6.5 + (i % 4) * 3, 8.5 + i * 2, MORTAR_81);
    return sim;
  }

  it('carries every breach, in insertion order, in the [horiz,x,y,cls,wide] shape', () => {
    const sim = new Sim(wallRun(1), 4);
    boom(sim)(10.5, 10.5, TANK_HE);
    const rows = JSON.parse(sim.snapshot()).breaches as number[][];
    expect(rows).toEqual(sim.breachLog.map((b) => [b.horiz ? 1 : 0, b.x, b.y, b.cls, b.wide ? 1 : 0]));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('is a LIST, not a set or a checksum — the same edges in a different order differ', () => {
    const sim = shelled(5);
    expect(sim.breachLog.length).toBeGreaterThan(1);
    const before = sim.snapshot();
    sim.breachLog.reverse(); // same set of edges, different insertion order
    expect(sim.snapshot()).not.toBe(before);
  });

  it('replays identically across a battle that opens more than thirty edges', () => {
    const a = shelled(13);
    const b = shelled(13);
    expect(a.breachLog.length).toBeGreaterThanOrEqual(30);
    expect(a.snapshot()).toBe(b.snapshot());
  });

  it('an unbreached battle leaves the field empty rather than absent', () => {
    const sim = new Sim(new GameMap(24, 24), 1);
    expect(JSON.parse(sim.snapshot()).breaches).toEqual([]);
  });
});

// ── D7: AI awareness ───────────────────────────────────────────────────────

describe('D7 forced repath near a fresh breach', () => {
  // One head-high wall across the map with a single gate ten rows south, so
  // the only route is a long detour until something opens a hole.
  function detour(): GameMap {
    const m = new GameMap(30, 30);
    for (let y = 0; y < 30; y++) {
      m.setVEdge(10, y, EDGE.WALL);
      m.vEdgeTops[y * (m.w + 1) + 10] = 2;
    }
    m.setVEdge(10, 25, EDGE.DOOR); // the gate he would otherwise walk to
    return m;
  }

  function walker(kind: 'move' | 'assault' | 'defend') {
    const sim = new Sim(detour(), 6);
    const squad = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 2.5, y: 12.5 }]);
    sim.orderTeam(squad.teamIds[0], { kind, x: 14.5, y: 12.5 });
    const s = sim.soldiers[squad.soldierIds[0]];
    for (let i = 0; i < 20; i++) sim.step();
    return { sim, s };
  }

  it('a walking squad re-solves its journey through the hole instead of finishing the detour', () => {
    const { sim, s } = walker('move');
    expect(s.path).not.toBeNull();
    const before = s.path;
    boom(sim)(10.0, 12.5, WALL_SHOT); // blow the wall on his own axis
    expect(sim.map.vEdge(10, 12)).toBe(EDGE.BREACH);

    sim.step(); // drainPendingPaths runs at the top of the tick
    expect(s.path).not.toBe(before); // he asked the pathfinder again

    let maxY = s.y;
    for (let i = 0; i < 600; i++) {
      sim.step();
      maxY = Math.max(maxY, s.y);
    }
    expect(s.x).toBeGreaterThan(11); // through, and out the far side
    expect(maxY).toBeLessThan(20); // never went anywhere near the gate at row 25
  });

  it('leaves an order kind that was not move or assault alone', () => {
    const { sim, s } = walker('defend');
    const before = s.path;
    boom(sim)(10.0, 12.5, WALL_SHOT);
    sim.step();
    expect(s.path).toBe(before); // same array: nothing re-solved his route
  });

  it('is what discriminates: a plain walker is re-solved, a stretcher party is not', () => {
    const sim = new Sim(detour(), 6);
    const squad = sim.addSquad('blue', 'A', [
      { name: 'R', weapon: 'garand', x: 2.5, y: 12.5 },
      { name: 'P', weapon: 'garand', x: 2.5, y: 13.5 },
      { name: 'C', weapon: 'garand', x: 2.5, y: 20.5 },
    ]);
    sim.orderTeam(squad.teamIds[0], { kind: 'move', x: 14.5, y: 12.5 });
    for (let i = 0; i < 20; i++) sim.step();
    const [r, plain, c] = squad.soldierIds.map((id) => sim.soldiers[id]);
    // R is carrying the squad's casualty out. pathTo drops a task and clears
    // `fleeing`, so the nudge has to leave him alone or a wall coming down
    // 8 m away cancels the rescue.
    c.downed = true;
    c.rescuerId = r.id;
    r.task = { kind: 'rescue', casualtyId: c.id, phase: 'goto', timer: 0 };
    const rBefore = r.path;
    const pBefore = plain.path;

    boom(sim)(10.0, 12.5, WALL_SHOT);
    sim.step();

    expect(plain.path).not.toBe(pBefore); // the plain walker asked again
    expect(r.path).toBe(rBefore); // the stretcher party was not touched
  });
});

describe('D7 the LOS memo is breach-aware', () => {
  it('visibleEnemies answers the question again in the SAME tick a wall comes down', () => {
    const m = new GameMap(24, 24);
    for (let y = 0; y < 24; y++) m.setVEdge(10, y, EDGE.WALL); // top 0: full-height masonry
    const sim = new Sim(m, 2);
    sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 6.5, y: 10.5 }]);
    sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 14.5, y: 10.5 }]);

    expect(visibleEnemies(sim, 'blue')).toHaveLength(0); // walled off — and memoized
    boom(sim)(10.0, 10.5, WALL_SHOT); // same tick, no step()
    expect(sim.map.vEdge(10, 10)).toBe(EDGE.BREACH);
    expect(visibleEnemies(sim, 'blue')).toHaveLength(1); // stale memo would still say 0
  });
});

describe('D7 the commander re-scores a firing spot a breach changed', () => {
  type Priv = {
    baseSpot: Map<number, { x: number; y: number }>;
    baseFiring: Set<number>;
    invalidateBreachedSpots(sim: Sim): void;
  };

  function staged(spot: { x: number; y: number }) {
    const sim = new Sim(wallRun(1), 3);
    const c = new RedCommander({ side: 'red', stance: 'attack', posts: {} });
    const priv = c as unknown as Priv;
    priv.baseSpot.set(0, spot);
    priv.baseFiring.add(0);
    return { sim, priv };
  }

  it('drops the cached spot AND the settled flag when the hole is inside the radius', () => {
    const { sim, priv } = staged({ x: 20, y: 10 }); // 10 m east of the wall run
    boom(sim)(10.0, 10.5, WALL_SHOT);
    priv.invalidateBreachedSpots(sim);
    expect(priv.baseSpot.has(0)).toBe(false);
    expect(priv.baseFiring.has(0)).toBe(false);
  });

  it('is wired into the eval, not just callable — update() advances the cursor', () => {
    const sim = new Sim(wallRun(1), 3);
    const sq = sim.addSquad('red', 'MG', [{ name: 'G', weapon: 'mg42', x: 14.5, y: 10.5 }]);
    const c = new RedCommander({ side: 'red', stance: 'attack', posts: { [sq.id]: { x: 4, y: 10 } } });
    const priv = c as unknown as Priv & { breachSeen: number };
    for (let i = 0; i <= SPOT_INTERVAL; i++) sim.step();
    boom(sim)(10.0, 10.5, WALL_SHOT);
    expect(sim.breachLog.length).toBeGreaterThan(0);
    c.update(sim);
    expect(priv.breachSeen).toBe(sim.breachLog.length);
  });

  it('leaves a spot alone when the hole is out of the radius, and reacts only once per breach', () => {
    const { sim, priv } = staged({ x: 200, y: 10 }); // far off
    boom(sim)(10.0, 10.5, WALL_SHOT);
    priv.invalidateBreachedSpots(sim);
    expect(priv.baseSpot.has(0)).toBe(true);

    priv.baseSpot.set(1, { x: 20, y: 10 });
    priv.invalidateBreachedSpots(sim); // the same breaches, already consumed
    expect(priv.baseSpot.has(1)).toBe(true);
  });
});

// ── D8: campaign emission and the scar re-stamp ────────────────────────────

describe('D8 scar re-stamp', () => {
  // The exactness claim the whole scar system rests on: a battle map is
  // REGENERATED from (seed, w, h, kind), never persisted, so an edge recorded
  // by tile index refers to the same wall on every future generation.
  it('re-stamping a freshly generated map reproduces the one the battle left behind', () => {
    const kind = 'bourg';
    const fought = generateMap(3, 120, 90, kind).map;
    const sim = new Sim(fought, 8);

    // Shell the first few walls the generator put down, wherever they are.
    let hit = 0;
    for (let y = 0; y < fought.h && hit < 5; y++) {
      for (let x = 0; x < fought.w && hit < 5; x++) {
        if (edgeClass(fought, x, y, false) === ECLASS.NONE) continue;
        boom(sim)(x, y + 0.5, WALL_SHOT);
        hit++;
      }
    }
    expect(sim.breachLog.length).toBeGreaterThanOrEqual(5);

    const fresh = generateMap(3, 120, 90, kind).map;
    applyScars(fresh, breachScars(sim.breachLog));
    expect(fresh.vEdges).toEqual(fought.vEdges);
    expect(fresh.hEdges).toEqual(fought.hEdges);
    expect(fresh.vEdgeTops).toEqual(fought.vEdgeTops);
    expect(fresh.hEdgeTops).toEqual(fought.hEdgeTops);
    expect(fresh.hasBreach).toBe(true);
  });

  it('carries the width code, so a hull route survives the re-stamp', () => {
    const m = new GameMap(24, 24);
    applyScars(m, [
      { kind: 'breach', horiz: false, x: 10, y: 10, wide: true },
      { kind: 'breach', horiz: true, x: 12, y: 12, wide: false },
    ]);
    expect(m.vEdge(10, 10)).toBe(EDGE.BREACH);
    expect(m.vEdgeTop(10, 10)).toBe(BREACH_WIDE);
    expect(m.canStep(9, 10, 10, 10, 'vehicle')).toBe(true);
    expect(m.hEdge(12, 12)).toBe(EDGE.BREACH);
    expect(m.hEdgeTop(12, 12)).toBe(BREACH_LIP);
    expect(m.canStep(12, 11, 12, 12, 'vehicle')).toBe(false);
  });

  it('an empty scar list leaves the map, and its fast-path hint, untouched', () => {
    const m = new GameMap(24, 24);
    applyScars(m, []);
    expect(m.hasBreach).toBe(false);
  });
});

describe('D8 battle-result emission', () => {
  it('the engagement outcome carries the breach log alongside the casualties', () => {
    const c = newCampaign(10);
    const front = newFront(c, makeDefaultSector());
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
    const { sim } = makeStrategicBattle(c, front, e, 6);

    // One deliberate wall shot somewhere on the generated map.
    let opened = false;
    for (let y = 0; y < sim.map.h && !opened; y++) {
      for (let x = 0; x < sim.map.w && !opened; x++) {
        if (edgeClass(sim.map, x, y, false) === ECLASS.NONE) continue;
        boom(sim)(x, y + 0.5, WALL_SHOT);
        opened = true;
      }
    }
    expect(opened).toBe(true);

    for (const s of sim.soldiers) if (s.side === 'red') s.alive = false;
    sim.step();
    const out = applyEngagementOutcome(c, front, e, sim);
    expect(out.breaches.length).toBeGreaterThan(0);
    expect(out.breaches).toEqual(sim.breachLog);
    // No save-schema bump: the persisted record still carries casualties only.
    expect(Object.keys(out.record).sort()).toEqual(['day', 'kia', 'won', 'wounded']);
  });
});
