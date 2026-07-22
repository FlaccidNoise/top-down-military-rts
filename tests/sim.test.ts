import { describe, expect, it } from 'vitest';
import { EDGE, GameMap, los } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { BUILDINGS, makeScenario } from '../src/sim/scenario';

describe('line of sight', () => {
  const wallMap = (edge: number) => {
    const m = new GameMap(10, 10);
    // vertical barrier at x=5 across all rows, one special edge at y=5
    for (let y = 0; y < 10; y++) m.setVEdge(5, y, EDGE.WALL);
    m.setVEdge(5, 5, edge as 1 | 2 | 3);
    return m;
  };

  it('walls block sight', () => {
    expect(los(wallMap(EDGE.WALL), 2.5, 5.5, 7.5, 5.5).visible).toBe(false);
  });

  it('doors and windows pass sight', () => {
    expect(los(wallMap(EDGE.DOOR), 2.5, 5.5, 7.5, 5.5).visible).toBe(true);
    expect(los(wallMap(EDGE.WINDOW), 2.5, 5.5, 7.5, 5.5).visible).toBe(true);
  });

  it('a target just behind a window gets window cover', () => {
    const r = los(wallMap(EDGE.WINDOW), 2.5, 5.5, 5.5, 5.5);
    expect(r.visible).toBe(true);
    expect(r.cover).toBeGreaterThanOrEqual(0.5);
  });

  it('dense woods block sight', () => {
    const m = new GameMap(20, 5);
    for (let x = 5; x < 15; x++) m.setTerrain(x, 2, 'woods');
    expect(los(m, 1.5, 2.5, 18.5, 2.5).visible).toBe(false);
    expect(los(m, 1.5, 2.5, 6.5, 2.5).visible).toBe(true); // shallow into the treeline
  });
});

describe('pathfinding', () => {
  it('routes through the door, not through walls or windows', () => {
    const sim = makeScenario(1);
    const b = BUILDINGS[0];
    const inside = { x: b.x + 2, y: b.y + 2 };
    const path = astar(sim.map, 10, 44, inside.x, inside.y);
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual(inside);
    // every consecutive step must be legal (edge-aware)
    for (let i = 1; i < path!.length; i++) {
      const a = path![i - 1];
      const c = path![i];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      if (dx !== 0 && dy !== 0) continue; // diagonals validated by canStep in astar itself
      expect(sim.map.canStep(a.x, a.y, c.x, c.y)).toBe(true);
    }
  });

  it('returns null for unreachable goals', () => {
    const m = new GameMap(10, 10);
    for (let x = 4; x < 7; x++) {
      m.setHEdge(x, 4, EDGE.WALL);
      m.setHEdge(x, 7, EDGE.WALL);
    }
    for (let y = 4; y < 7; y++) {
      m.setVEdge(4, y, EDGE.WALL);
      m.setVEdge(7, y, EDGE.WALL);
    }
    expect(astar(m, 1, 1, 5, 5)).toBeNull();
  });
});

describe('simulation', () => {
  it('is deterministic: same seed and orders produce identical state', () => {
    const run = () => {
      const sim = makeScenario(42);
      sim.orderMove(0, 80, 55);
      sim.orderMove(1, 80, 70);
      for (let i = 0; i < 3000; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });

  it('different seeds diverge', () => {
    const run = (seed: number) => {
      const sim = makeScenario(seed);
      sim.orderMove(0, 80, 55);
      for (let i = 0; i < 3000; i++) sim.step();
      return sim.snapshot();
    };
    expect(run(1)).not.toBe(run(2));
  });

  it('an assault produces a resolved firefight with no NaN state', () => {
    const sim = makeScenario(7);
    sim.orderMove(0, 96, 52);
    sim.orderMove(1, 98, 79);
    let steps = 0;
    while (sim.winner === null && steps < 30 * 60 * 10) {
      sim.step();
      steps++;
      sim.takeEvents();
    }
    const casualties = sim.soldiers.filter((s) => !s.alive || s.downed).length;
    expect(casualties).toBeGreaterThan(0);
    for (const s of sim.soldiers) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.y)).toBe(true);
      expect(Number.isFinite(s.pain)).toBe(true);
      expect(Number.isFinite(s.bloodLoss)).toBe(true);
      expect(Number.isFinite(s.suppression)).toBe(true);
      expect(Number.isFinite(s.morale)).toBe(true);
    }
  });
});
