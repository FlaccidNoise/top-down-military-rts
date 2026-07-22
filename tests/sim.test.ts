import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../src/sim/data';
import { EDGE, GameMap, los } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { generateMap } from '../src/sim/mapgen';
import { makeScenario } from '../src/sim/scenario';
import { Sim } from '../src/sim/sim';

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
    const plan = generateMap(1);
    const b = plan.buildings[0];
    const inside = { x: b.x + 2, y: b.y + 2 };
    const path = astar(plan.map, plan.spawns.west.x, plan.spawns.west.y, inside.x, inside.y);
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual(inside);
    // every consecutive step must be legal (edge-aware)
    for (let i = 1; i < path!.length; i++) {
      const a = path![i - 1];
      const c = path![i];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      if (dx !== 0 && dy !== 0) continue; // diagonals validated by canStep in astar itself
      expect(plan.map.canStep(a.x, a.y, c.x, c.y)).toBe(true);
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

  it('aimFactor is exactly the product of its exposed breakdown', () => {
    const sim = makeScenario(3);
    const s = sim.soldiers[0];
    s.pain = 0.3;
    s.suppression = 0.5;
    s.xp = 3;
    s.mental = 'shaken';
    const product = sim.aimBreakdown(s).reduce((a, t) => a * t.mult, 1);
    expect(sim.aimFactor(s)).toBe(product);
  });

  it('shotPreview reports blocked LOS and matches the live-fire formula in the open', () => {
    const m = new GameMap(20, 10);
    for (let y = 0; y < 10; y++) m.setVEdge(10, y, EDGE.WALL);
    const sim = new Sim(m, 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'rifle', x: 2.5, y: 2.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'rifle', x: 15.5, y: 2.5 }]);
    const [shooter, target] = sim.soldiers;
    expect(sim.shotPreview(shooter.x, shooter.y, 'rifle', target, false, 1).visible).toBe(false);
    target.x = 8.5; // same side of the wall
    const p = sim.shotPreview(shooter.x, shooter.y, 'rifle', target, false, 1);
    const w = WEAPONS.rifle;
    const d = Math.hypot(target.x - shooter.x, target.y - shooter.y);
    expect(p.visible).toBe(true);
    expect(p.acc).toBeCloseTo(w.accuracy * (1 - 0.75 * (d / w.range)), 12);
  });

  it('apShotPreview reports the struck arc and certain/impossible penetration odds', () => {
    const sim = makeScenario(5);
    const panzer = sim.vehicles.find((v) => v.kind === 'panzer4')!;
    // shot from dead ahead: front arc
    const front = sim.apShotPreview(panzer.x + Math.cos(panzer.facing) * 50, panzer.y + Math.sin(panzer.facing) * 50, 120, 0.5, 120, panzer, false);
    expect(front.arc).toBe('front');
    expect(front.armor).toBe(85);
    const rear = sim.apShotPreview(panzer.x - Math.cos(panzer.facing) * 50, panzer.y - Math.sin(panzer.facing) * 50, 120, 0.5, 120, panzer, false);
    expect(rear.arc).toBe('rear');
    expect(rear.penChance).toBe(1); // 25mm plate vs 90+ effective pen
  });

  it('queues unit events so DOWN then KIA across one frame batch keeps both', () => {
    const sim = new Sim(new GameMap(10, 10), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'rifle', x: 2.5, y: 2.5 }]);
    const s = sim.soldiers[0];
    s.pain = 1; // >= 0.8 → downed
    sim.step();
    s.wounds.push({ part: 0, dmg: 10 });
    s.bloodLoss = 1; // → kill on next physiology tick
    sim.step();
    const kinds = sim.takeUnitEvents().map((e) => e.kind);
    expect(kinds).toEqual(['downed', 'kia']);
    expect(sim.takeUnitEvents()).toEqual([]); // queue drains
  });

  it('an assault produces a resolved firefight with no NaN state', () => {
    const sim = makeScenario(7);
    const [b0, b2] = [sim.buildings[0], sim.buildings[2]];
    sim.orderMove(0, b0.x + b0.w / 2, b0.y + b0.h / 2);
    sim.orderMove(1, b2.x + b2.w / 2, b2.y + b2.h / 2);
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
