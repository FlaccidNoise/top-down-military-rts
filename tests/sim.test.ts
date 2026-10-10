import { describe, expect, it } from 'vitest';
import { TEAMS, WEAPONS } from '../src/sim/data';
import { ECLASS, EDGE, GameMap, edgeClass, los } from '../src/sim/map';
import { astar } from '../src/sim/path';
import { generateMap } from '../src/sim/mapgen';
import { makeScenario } from '../src/sim/scenario';
import { DT, RALLY_WINDOW_TICKS, Sim, sightBetween, smokePuff, type UnitEvent } from '../src/sim/sim';
import { CANON_CLOCK_MIN } from '../src/sim/solar';

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

describe('hedgerow cover and concealment', () => {
  // vertical hedge line at x=10
  const hedgeMap = () => {
    const m = new GameMap(20, 5);
    for (let y = 0; y < 5; y++) m.setTerrain(10, y, 'hedge');
    return m;
  };

  it('a shot crossing a hedge within 2m of the target grants lip cover (0.5)', () => {
    const r = los(hedgeMap(), 2.5, 2.5, 11.5, 2.5);
    expect(r.visible).toBe(true);
    expect(r.cover).toBeCloseTo(0.5, 10);
  });

  it('lip cover is directional — no cover from the hedgeless side', () => {
    const r = los(hedgeMap(), 18.5, 2.5, 11.5, 2.5);
    expect(r.visible).toBe(true);
    expect(r.cover).toBe(0);
    expect(r.conceal).toBe(0);
  });

  it('standing in the hedge itself keeps the tile cover (0.35)', () => {
    expect(los(hedgeMap(), 2.5, 2.5, 10.5, 2.5).cover).toBeCloseTo(0.35, 10);
  });

  it('a hedge crossed far from the target conceals but grants no cover', () => {
    const r = los(hedgeMap(), 2.5, 2.5, 15.5, 2.5);
    expect(r.visible).toBe(true);
    expect(r.cover).toBe(0);
    expect(r.conceal).toBeCloseTo(0.5, 10);
  });

  it('two hedges still block sight', () => {
    const m = hedgeMap();
    for (let y = 0; y < 5; y++) m.setTerrain(13, y, 'hedge');
    expect(los(m, 2.5, 2.5, 16.5, 2.5).visible).toBe(false);
  });

  it('coverAt/inCover treat hedge-adjacent tiles as cover to hug', () => {
    const sim = new Sim(hedgeMap(), 1);
    expect(sim.coverAt(11.5, 2.5)).toBeCloseTo(0.5, 10);
    expect(sim.inCover(11.5, 2.5)).toBe(true);
    expect(sim.coverAt(2.5, 2.5)).toBe(0);
    expect(sim.inCover(2.5, 2.5)).toBe(false);
  });
});

describe('fog of war', () => {
  // dry everyone so the scene stays static (shared-RNG rule: zero ammo, never toggle alive in A/B tests)
  const dry = (sim: Sim) => {
    for (const s of sim.soldiers) {
      s.magLeft = 0;
      s.ammo = {};
    }
  };
  // vertical double-hedge wall: accumulated opacity 1.0 blocks LOS entirely
  const walledMap = () => {
    const m = new GameMap(80, 20);
    for (let y = 0; y < 20; y++) {
      m.setTerrain(30, y, 'hedge');
      m.setTerrain(33, y, 'hedge');
    }
    return m;
  };

  it('knows nothing at battle start; spots an enemy in the open after one sweep', () => {
    const sim = new Sim(new GameMap(80, 20), 11);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 55.5, y: 10.5 }]);
    dry(sim);
    const [blue, red] = sim.soldiers;
    expect(sim.soldierVisibleTo('blue', red)).toBe(false); // tick 0: no intel yet
    expect(sim.soldierVisibleTo('blue', blue)).toBe(true); // friendlies always
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(true);
    expect(sim.spotted.red.has(blue.id)).toBe(true); // intel is symmetric
  });

  it('a spotted enemy who breaks LOS ghosts at his last-SEEN spot; the ghost expires', () => {
    const sim = new Sim(walledMap(), 12);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 20.5, y: 10.5 }]);
    dry(sim);
    const red = sim.soldiers[1];
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(true);
    red.x = 45.5; // staged: slips behind the wall between sweeps
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(false);
    const ghost = sim.contacts.blue.get(`s${red.id}`);
    expect(ghost?.kind).toBe('infantry');
    expect(ghost!.x).toBeCloseTo(20.5, 5); // where we last SAW him, not where he hides
    for (let i = 0; i <= 45 * 30 + 15; i++) sim.step();
    expect(sim.contacts.blue.has(`s${red.id}`)).toBe(false); // expired
  });

  it('an untriggered ambush behind a hedge is off the intel picture; defend reveals it', () => {
    const m = new GameMap(80, 20);
    for (let y = 0; y < 20; y++) m.setTerrain(30, y, 'hedge');
    const sim = new Sim(m, 13);
    sim.addSquad('blue', 'obs', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    sim.addSquad('red', 'amb', [{ name: 'R', weapon: 'kar98k', x: 60.5, y: 10.5 }]); // 55m: beyond the 40m kar98k ambush trigger
    dry(sim);
    const amb = sim.soldiers[1];
    sim.orderTeam(amb.teamId, { kind: 'ambush', x: 60.5, y: 10.5 });
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.teams[amb.teamId].orderState.order?.kind).toBe('ambush'); // guard: untriggered
    expect(sim.soldierVisibleTo('blue', amb)).toBe(false); // conceal 0.5, holding fire
    sim.orderTeam(amb.teamId, { kind: 'defend', x: 60.5, y: 10.5 });
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', amb)).toBe(true);
  });

  it('a tracked enemy who dies out of sight leaves a ghost until the corpse is found', () => {
    const sim = new Sim(walledMap(), 15);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 20.5, y: 10.5 }]);
    dry(sim);
    const [blue, red] = sim.soldiers;
    for (let i = 0; i < 15; i++) sim.step(); // tracked in the open
    red.x = 45.5; // staged: behind the wall...
    red.alive = false; // ...and dead before the next sweep
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(false);
    expect(sim.contacts.blue.get(`s${red.id}`)?.x).toBeCloseTo(20.5, 5); // ghost at last-seen, not silently dropped
    blue.x = 40.5; // walks past the wall and finds the corpse
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.contacts.blue.has(`s${red.id}`)).toBe(false); // resolved
    expect(sim.soldierVisibleTo('blue', red)).toBe(true); // permanent corpse marker
  });

  it('night caps spotting absolutely: at 02:00 a clear-LOS enemy at 60 m goes unseen, at 20 m he is seen', () => {
    // Open ground, nothing on either ray — by day both would be spotted on
    // the first sweep (SPOT_RANGE 200). At 02:00 light is 0 and the cap is
    // 25 m: the far man vanishes, the near man does not. An absolute cap, not
    // a multiplier — SPOT_RANGE x0.5 would change nothing (design §7.1).
    const sim = new Sim(new GameMap(120, 20), 16);
    sim.startMin = 2 * 60;
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [
      { name: 'Far', weapon: 'kar98k', x: 65.5, y: 10.5 },
      { name: 'Near', weapon: 'kar98k', x: 25.5, y: 10.5 },
    ]);
    dry(sim);
    const [, far, near] = sim.soldiers;
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', far)).toBe(false); // 60 m: beyond the 25 m night cap
    expect(sim.soldierVisibleTo('blue', near)).toBe(true); // 20 m: inside it
  });

  it('startMin stays out of snapshot(), and the canonical default runs byte-identical to an explicit CANON', () => {
    // Two sims differing ONLY in startMin snapshot identically at tick 0 —
    // the clock is derivable from (startMin, tick) and adds no bytes. And a
    // default-constructed sim IS the canonical-hour sim after a real run.
    const a = makeScenario(7);
    const b = makeScenario(7);
    b.startMin = 2 * 60;
    expect(b.snapshot()).toBe(a.snapshot());
    const run = (explicit: boolean) => {
      const sim = makeScenario(42);
      if (explicit) sim.startMin = CANON_CLOCK_MIN;
      sim.orderSquad(0, { kind: 'move', x: 80, y: 55 });
      for (let i = 0; i < 900; i++) sim.step();
      const spots = [...sim.spotted.blue.keys()].join(',') + '|' + [...sim.spotted.red.keys()].join(',');
      return sim.snapshot() + '#' + spots;
    };
    expect(run(true)).toBe(run(false));
  });

  it('an unseen corpse stays hidden until a friendly gains LOS, then is known for good', () => {
    const sim = new Sim(walledMap(), 14);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    sim.addSquad('red', 'r', [{ name: 'R', weapon: 'kar98k', x: 45.5, y: 10.5 }]);
    dry(sim);
    const [blue, red] = sim.soldiers;
    red.alive = false; // staged death behind the wall (single scenario, not an RNG A/B)
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(false);
    blue.x = 40.5; // walks past the wall: corpse in plain sight
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(true);
    blue.x = 5.5; // leaves again — the find is permanent
    for (let i = 0; i < 15; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', red)).toBe(true);
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
  // The map stopped being immutable the day breaching landed, and snapshot()
  // captured no map state at all because it had never had to (destructible
  // terrain design, section 4.2). The primary determinism gate therefore has
  // to contain something breachable, or the new `breaches` field is pinned by
  // nothing. A waist-high garden wall (WALL_LOW, threshold 3) across the
  // ordered axis is inside a barrage round's 4 energy out to 2.25 m, so the
  // run really does open — asserted below rather than assumed.
  //
  // The run must stand in the CLEAR: edgeClass calls any edge touching a
  // building MASONRY (threshold 9), which no 4-energy round can ever open.
  // The wall used to be laid across a house, leaving two openable segments at
  // one end, so the gate below was pinned by which way the scatter happened to
  // fall — and any change that reshuffles the shared rng stream (the movement
  // resolver was one) silently dropped the breach coverage. Each segment is
  // class-checked as it is built so that cannot recur.
  const gardenWall = (sim: Sim, x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) {
      sim.map.setVEdge(x, y, EDGE.WALL);
      sim.map.vEdgeTops[y * (sim.map.w + 1) + x] = 1;
      expect(edgeClass(sim.map, x, y, false)).toBe(ECLASS.WALL_LOW);
    }
  };

  it('is deterministic: same seed and orders produce identical state', () => {
    const run = () => {
      const sim = makeScenario(42);
      gardenWall(sim, 80, 46, 52);
      sim.callBarrage('blue', 80, 49);
      sim.orderSquad(0, { kind: 'move', x: 80, y: 55 });
      sim.orderSquad(1, { kind: 'move', x: 80, y: 70 });
      for (let i = 0; i < 3000; i++) sim.step();
      return sim;
    };
    const a = run();
    expect(a.snapshot()).toBe(run().snapshot());
    expect(a.breachLog.length).toBeGreaterThan(0); // the fixture really breaches
    expect(JSON.parse(a.snapshot()).breaches).toHaveLength(a.breachLog.length);
  });

  it('different seeds diverge', () => {
    const run = (seed: number) => {
      const sim = makeScenario(seed);
      sim.orderSquad(0, { kind: 'move', x: 80, y: 55 });
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
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 15.5, y: 2.5 }]);
    const [shooter, target] = sim.soldiers;
    expect(sim.shotPreview(shooter.x, shooter.y, 'garand', target, false, 1).visible).toBe(false);
    target.x = 8.5; // same side of the wall
    const p = sim.shotPreview(shooter.x, shooter.y, 'garand', target, false, 1);
    const w = WEAPONS.garand;
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
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
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

  it('waypoint queue dispatches legs in order; a direct order cancels it', () => {
    const sim = new Sim(new GameMap(60, 20), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    sim.queueMove(0, 20, 10); // idle → dispatches immediately
    sim.queueMove(0, 40, 10);
    expect(sim.squadWaypoints[0].length).toBe(1);
    let reachedFirst = false;
    for (let i = 0; i < 30 * 120 && (sim.squadDest[0] || sim.squadWaypoints[0].length); i++) {
      if (Math.hypot(s.x - 20, s.y - 10) < 6) reachedFirst = true;
      sim.step();
    }
    expect(reachedFirst).toBe(true);
    expect(Math.hypot(s.x - 40, s.y - 10)).toBeLessThan(6);
    expect(sim.squadDest[0]).toBeNull();

    sim.queueMove(0, 20, 10);
    sim.queueMove(0, 2, 10);
    sim.orderSquad(0, { kind: 'move', x: 50, y: 10 }); // direct order wipes the queue
    expect(sim.squadWaypoints[0]).toEqual([]);
  });

  it('a queued waypoint does not cancel a squadmate rescue in progress', () => {
    const sim = new Sim(new GameMap(80, 20), 1);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 5.5, y: 10.5 },
      { name: 'B', weapon: 'garand', x: 6.5, y: 10.5 },
    ]);
    const [a, b] = sim.soldiers;
    a.bonds[b.id] = 1;
    b.bonds[a.id] = 1;
    sim.queueMove(0, 30, 10);
    sim.queueMove(0, 60, 10); // queue holds one pending leg
    b.pain = 1; // B goes down next tick
    let taskAt = -1;
    for (let i = 0; i < 30 * 10 && taskAt < 0; i++) {
      sim.step();
      if (a.task) taskAt = sim.tick;
    }
    expect(taskAt).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) sim.step();
    expect(a.task).not.toBeNull(); // previously dropped one tick after pickup
    expect(sim.squadWaypoints[0].length).toBe(1); // queue held, no auto-dispatch mid-rescue
  });

  // 15s: passes in ~2.5s alone but the design-scale perf/strategic suites now contend for CPU
  it('an assault produces a resolved firefight with no NaN state', { timeout: 15_000 }, () => {
    const sim = makeScenario(7);
    const [b0, b2] = [sim.buildings[0], sim.buildings[2]];
    sim.orderSquad(0, { kind: 'move', x: b0.x + b0.w / 2, y: b0.y + b0.h / 2 });
    sim.orderSquad(1, { kind: 'move', x: b2.x + b2.w / 2, y: b2.y + b2.h / 2 });
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

describe('morale drama events', () => {
  // One man, no enemies, no rounds: the psych ladder is the only thing moving,
  // so forcing morale/suppression each tick drives an exact state trajectory.
  const loner = () => {
    const sim = new Sim(new GameMap(20, 20), 3);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 10.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    s.magLeft = 0;
    s.ammo = {};
    return { sim, s };
  };

  const run = (sim: Sim, ticks: number, hold: () => void) => {
    const kinds: string[] = [];
    for (let i = 0; i < ticks; i++) {
      hold();
      sim.step();
      kinds.push(...sim.takeUnitEvents().map((e) => e.kind));
    }
    return kinds;
  };

  it('steady → pinned fires once, and not again while the pin holds', () => {
    const { sim, s } = loner();
    const kinds = run(sim, 40, () => {
      s.suppression = 1;
      s.morale = 0.8;
    });
    expect(s.mental).toBe('pinned');
    expect(kinds.filter((k) => k === 'pinned')).toHaveLength(1);
  });

  // The recovery below is NOT staged. The test this replaces wrote
  // suppression = 0 by hand, which is the only way a man ever went from
  // pinned to steady in one tick — so it passed for an event that fired 0
  // times in 38 real battles (#766). Only the pin is forced; from there
  // nothing is written and the psych model does the rest.
  const recover = (sim: Sim, s: { mental: string }, maxTicks: number) => {
    const kinds: string[] = [];
    const states = new Set<string>();
    for (let i = 0; i < maxTicks && s.mental !== 'steady'; i++) {
      sim.step();
      states.add(s.mental);
      kinds.push(...sim.takeUnitEvents().map((e) => e.kind));
    }
    kinds.push(...run(sim, 60, () => {})); // and nothing more once he is steady
    return { kinds, states };
  };

  it('a pinned man whose suppression decays rallies once, by way of shaken', () => {
    const { sim, s } = loner();
    run(sim, 20, () => {
      s.suppression = 1;
      s.morale = 0.8;
    });
    expect(s.mental).toBe('pinned');
    const { kinds, states } = recover(sim, s, 30 * 60);
    expect(s.mental).toBe('steady');
    expect(states.has('shaken')).toBe(true); // never straight from pinned
    expect(kinds.filter((k) => k === 'rallied')).toHaveLength(1);
    expect(kinds).not.toContain('pinned');
  });

  it('a broken man whose morale climbs back rallies once', () => {
    const { sim, s } = loner();
    run(sim, 20, () => {
      s.suppression = 1;
      s.morale = 0.1;
    });
    expect(s.mental).toBe('broken');
    const { kinds, states } = recover(sim, s, 30 * 240);
    expect(s.mental).toBe('steady');
    expect(states.has('shaken')).toBe(true);
    expect(kinds.filter((k) => k === 'rallied')).toHaveLength(1);
  });

  it('steadying long after the pin is not a rally', () => {
    const { sim, s } = loner();
    run(sim, 20, () => {
      s.suppression = 1;
      s.morale = 0.8;
    });
    // Kept rattled but not pinned until the window has run out.
    run(sim, RALLY_WINDOW_TICKS + 1, () => {
      s.suppression = 0.45;
    });
    expect(s.mental).toBe('shaken');
    const { kinds } = recover(sim, s, 30 * 60);
    expect(s.mental).toBe('steady');
    expect(kinds).not.toContain('rallied');
  });

  it('broken → pinned is a recovery, not a pin', () => {
    const { sim, s } = loner();
    run(sim, 20, () => {
      s.morale = 0;
      s.suppression = 1;
    });
    expect(s.mental).toBe('broken');
    const kinds = run(sim, 40, () => {
      s.morale = 0.4;
      s.suppression = 1;
    });
    expect(s.mental).toBe('pinned');
    expect(kinds).not.toContain('pinned');
  });

  it('a springing ambush emits one event, at the team, named for it', () => {
    const sim = new Sim(new GameMap(100, 20), 11);
    sim.addSquad('blue', 'obs', [{ name: 'A', weapon: 'garand', x: 5.5, y: 10.5 }]);
    const red = sim.addSquad('red', 'amb', [{ name: 'R', weapon: 'kar98k', x: 80.5, y: 10.5, xp: 30 }]);
    for (const s of sim.soldiers) {
      s.magLeft = 0;
      s.ammo = {};
    }
    const r = sim.soldiers[red.soldierIds[0]];
    r.morale = 1;
    sim.orderTeam(r.teamId, { kind: 'ambush', x: 80.5, y: 10.5 });
    const events: UnitEvent[] = [];
    for (let i = 0; i < 30; i++) sim.step(); // 75m out: nothing to spring on
    expect(sim.teams[r.teamId].orderState.order?.kind).toBe('ambush');
    expect(sim.takeUnitEvents().filter((e) => e.kind === 'ambush')).toHaveLength(0);
    sim.soldiers[0].x = 50.5; // walks to 30m — inside the 40m rifleman threshold
    for (let i = 0; i < 60; i++) {
      sim.step();
      events.push(...sim.takeUnitEvents());
    }
    expect(sim.teams[r.teamId].orderState.order?.kind).toBe('defend');
    const sprung = events.filter((e) => e.kind === 'ambush');
    expect(sprung).toHaveLength(1); // the order flips to defend, so the site is reached once
    expect(sprung[0].side).toBe('red');
    expect(sprung[0].name).toBe(sim.teams[r.teamId].name);
    expect(sprung[0].x).toBeCloseTo(80.5, 0);
  });

  // Liveness: the forced trajectories above prove the mechanism, not that
  // anything ever crosses the threshold under natural fire. Two squads at 30 m
  // with live ammo and no orders — nothing staged but the placement.
  it('a natural firefight pins someone', () => {
    const sim = new Sim(new GameMap(60, 20), 7);
    sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'garand', x: 10.5, y: 9.5 },
      { name: 'A2', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'A3', weapon: 'bar', x: 10.5, y: 11.5 },
    ]);
    sim.addSquad('red', 'B', [
      { name: 'B1', weapon: 'kar98k', x: 40.5, y: 9.5 },
      { name: 'B2', weapon: 'kar98k', x: 40.5, y: 10.5 },
      { name: 'B3', weapon: 'mg42', x: 40.5, y: 11.5 },
    ]);
    const kinds: string[] = [];
    for (let i = 0; i < 900; i++) {
      sim.step();
      kinds.push(...sim.takeUnitEvents().map((e) => e.kind));
    }
    expect(kinds).toContain('pinned');
  });

  // Same staging, run to its end: the fire slackens as men go down, and the
  // survivors come back up on their own.
  it('a natural firefight ends with someone rallying', () => {
    const sim = new Sim(new GameMap(60, 20), 7);
    sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'garand', x: 10.5, y: 9.5 },
      { name: 'A2', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'A3', weapon: 'bar', x: 10.5, y: 11.5 },
    ]);
    sim.addSquad('red', 'B', [
      { name: 'B1', weapon: 'kar98k', x: 40.5, y: 9.5 },
      { name: 'B2', weapon: 'kar98k', x: 40.5, y: 10.5 },
      { name: 'B3', weapon: 'mg42', x: 40.5, y: 11.5 },
    ]);
    const kinds: string[] = [];
    for (let i = 0; i < 30 * 240 && !kinds.includes('rallied'); i++) {
      sim.step();
      kinds.push(...sim.takeUnitEvents().map((e) => e.kind));
    }
    expect(kinds).toContain('pinned');
    expect(kinds).toContain('rallied');
  });
});

describe('ammo, reload, heat, one-shot', () => {
  it('reload starts when the mag runs dry, and the clip count drops', () => {
    const sim = new Sim(new GameMap(10, 10), 40);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5, ammo: { clip_3006: 3 } }]);
    const s = sim.soldiers[0];
    s.magLeft = 0;
    sim.step();
    expect(s.reloading).toBeGreaterThan(0);
    expect(s.ammo.clip_3006).toBe(2);
  });

  it('a Garand reload from empty pings', () => {
    const sim = new Sim(new GameMap(10, 10), 45);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5, ammo: { clip_3006: 3 } }]);
    sim.soldiers[0].magLeft = 0;
    sim.step();
    expect(sim.takeUnitEvents().map((e) => e.kind)).toEqual(['ping']);
  });

  it('MG42 barrel heat forces a long swap with no shots fired during it', () => {
    const sim = new Sim(new GameMap(180, 10), 41);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'mg42', x: 2.5, y: 5.5 }]);
    // out of the gunner's garand-armed target's own range, so there's no return fire muddying the window
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 130.5, y: 5.5 }]);
    const gunner = sim.soldiers[0];
    gunner.heat = 1;
    const swapTicks = Math.ceil((WEAPONS.mg42.heat!.swapTime * sim.assistFactor(gunner)) / DT);
    for (let i = 0; i < swapTicks - 5; i++) sim.step();
    expect(gunner.heat).toBe(1); // still mid-swap, not yet reset
    expect(gunner.reloading).toBeGreaterThan(0);
    expect(sim.takeEvents().length).toBe(0); // no shots landed during the swap window
  });

  it('a panzerfaust soldier fires once at a vehicle, then reverts to his secondary weapon', () => {
    const sim = new Sim(new GameMap(20, 10), 42);
    sim.addSquad('red', 'a', [{ name: 'A', weapon: 'panzerfaust', x: 5.5, y: 5.5, ammo: {}, secondary: 'kar98k' }]);
    const v = sim.addVehicle('blue', 'sherman', 15.5, 5.5, Math.PI);
    v.gunCooldown = 999; // isolate: only the faust shot should register this test
    v.mgCooldown = 999;
    const soldier = sim.soldiers[0];
    sim.step(); // fires the faust
    expect(soldier.weapon).toBe('panzerfaust');
    sim.step(); // dry, no faust reserve left: reverts to the secondary
    expect(soldier.weapon).toBe('kar98k');
  });

  it('assistFactor: a lone gunner gets the unassisted (slower) multiplier', () => {
    const sim = new Sim(new GameMap(10, 10), 44);
    sim.addSquad('blue', 'gun', [{ name: 'G', weapon: 'm1919', x: 2.5, y: 2.5 }]);
    expect(sim.assistFactor(sim.soldiers[0])).toBe(1.75);
  });
});

describe('stamina', () => {
  it('marching drains stamina; standing still recovers it', () => {
    const sim = new Sim(new GameMap(60, 20), 50);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 10.5 }]);
    const s = sim.soldiers[0];
    sim.orderMove(0, 50, 10);
    for (let i = 0; i < 30 * 60 && s.path; i++) sim.step();
    expect(s.stamina).toBeLessThan(1);
    const winded = s.stamina;
    for (let i = 0; i < 30 * 60; i++) sim.step(); // standing still, no fire: recovers
    expect(s.stamina).toBeGreaterThan(winded);
  });

  it('fatigued soldiers aim worse than rested ones', () => {
    const sim = new Sim(new GameMap(10, 10), 51);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 2.5 }]);
    const s = sim.soldiers[0];
    const rested = sim.aimFactor(s);
    s.stamina = 0.1;
    expect(sim.aimFactor(s)).toBeLessThan(rested);
  });
});

describe('teams and data-driven squads', () => {
  it('addSquadFromDef spawns a US rifle squad as 12 men in 2 teams with the roster weapons', () => {
    const sim = new Sim(new GameMap(40, 40), 60);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 20, 20);
    expect(squad.soldierIds.length).toBe(12);
    expect(squad.teamIds.length).toBe(2);
    const [able, baker] = squad.teamIds.map((id) => sim.teams[id]);
    expect(able.soldierIds.map((id) => sim.soldiers[id].weapon)).toEqual(TEAMS.us_able.slots.map((sl) => sl.weapon));
    expect(able.soldierIds.map((id) => sim.soldiers[id].role)).toEqual(TEAMS.us_able.slots.map((sl) => sl.role));
    expect(baker.soldierIds.map((id) => sim.soldiers[id].weapon)).toEqual(TEAMS.us_baker.slots.map((sl) => sl.weapon));
  });

  it('addSquadFromDef spawns a German Gruppe as 9 men, MG-Trupp holding 3', () => {
    const sim = new Sim(new GameMap(40, 40), 61);
    const squad = sim.addSquadFromDef('red', 'de_gruppe', 20, 20);
    expect(squad.soldierIds.length).toBe(9);
    const mgTrupp = sim.teams[squad.teamIds[0]];
    expect(mgTrupp.soldierIds.length).toBe(3);
  });

  it('orderSquad moves both teams of a multi-team squad', () => {
    const sim = new Sim(new GameMap(60, 40), 62);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 5, 20);
    sim.orderSquad(squad.id, { kind: 'move', x: 50, y: 20 });
    // A squad's worth of A* exceeds the per-tick path budget, so the tail of
    // the order is serviced over the next few ticks (see PATH_BUDGET_PER_TICK).
    // The contract is that EVERY team ends up moving, not that every path
    // exists in the same microsecond as the click.
    for (let i = 0; i < 5; i++) sim.step();
    const moving = (teamId: number) => sim.teams[teamId].soldierIds.some((id) => sim.soldiers[id].path !== null);
    expect(squad.teamIds.every(moving)).toBe(true);
  });

  it('addSquadFromDef with a roster shorter than the team spawns only the roster, not the full establishment', () => {
    const sim = new Sim(new GameMap(40, 40), 63);
    const roster = [[{ pid: 901 }, { pid: 902, crewSkill: { mg: 0.4 } }, { pid: 903 }]];
    const squad = sim.addSquadFromDef('blue', 'us_m1919', 20, 20, roster);
    expect(squad.soldierIds.length).toBe(3); // 5-slot team, 3-entry roster: no phantom fill
    const team = sim.teams[squad.teamIds[0]];
    expect(team.soldierIds.map((id) => sim.soldiers[id].pid)).toEqual([901, 902, 903]); // no -1 padding
    expect(sim.soldiers[team.soldierIds[1]].crewSkill).toEqual({ mg: 0.4 });
    expect(team.soldierIds.map((id) => sim.soldiers[id].weapon)).toEqual(
      TEAMS.us_m1919_team.slots.slice(0, 3).map((sl) => sl.weapon),
    );
  });
});

describe('ammo runner + weapon pickup', () => {
  it('a dry MG42 gunner gets resupplied by a bonded bearer', () => {
    const sim = new Sim(new GameMap(20, 20), 70);
    sim.addSquad('blue', 'g', [
      { name: 'Gunner', weapon: 'mg42', x: 5.5, y: 5.5, ammo: { belt_792: 1 } },
      { name: 'Bearer', weapon: 'kar98k', x: 6.5, y: 5.5, ammo: { belt_792: 4 } },
    ]);
    const [gunner, bearer] = sim.soldiers;
    bearer.bonds[gunner.id] = 1;
    bearer.courage = 0.8;
    for (let i = 0; i < 300 && bearer.task === null; i++) sim.step();
    expect(bearer.task?.kind).toBe('ammo');
    for (let i = 0; i < 300 && bearer.task !== null; i++) sim.step();
    expect(bearer.task).toBeNull();
    expect(gunner.ammo.belt_792).toBeGreaterThan(1);
    expect(bearer.ammo.belt_792).toBeLessThan(4);
  });

  it('a rifleman adjacent to a dead BAR man upgrades weapons', () => {
    const sim = new Sim(new GameMap(20, 20), 71);
    sim.addSquad('blue', 's', [
      { name: 'Dead', weapon: 'bar', x: 5.5, y: 5.5, ammo: { mag_bar: 5 } },
      { name: 'Rifle', weapon: 'garand', x: 6.0, y: 5.5, ammo: { clip_3006: 8 } },
    ]);
    const [dead, rifle] = sim.soldiers;
    dead.wounds.push({ part: 0, dmg: 100 });
    dead.bloodLoss = 1; // kills on the next physiology tick
    for (let i = 0; i < 250 && rifle.weapon !== 'bar'; i++) sim.step();
    expect(rifle.weapon).toBe('bar');
    expect(rifle.ammo.mag_bar).toBe(5);
    expect(sim.droppedKit.length).toBe(0); // kit consumed
  });
});

describe('casualty chain v2: succession, two-man carry, aidman', () => {
  it('regression: a gunner killed on a packed (not deployed) emplacement does not disarm the surviving crew', () => {
    const sim = new Sim(new GameMap(60, 20), 53);
    const e = sim.addEmplacement('blue', 'mg42_lafette', 10.5, 10.5); // packed by default
    expect(e.state).toBe('packed');
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const gunner = crew.find((s) => s.role === 'gunner')!;
    sim.addSquad('red', 'target', [{ name: 'T', weapon: 'kar98k', x: 30.5, y: 10.5, ammo: {} }]);
    sim.soldiers[sim.soldiers.length - 1].magLeft = 0; // dry: no return fire complicating the read

    gunner.wounds.push({ part: 0, dmg: 100 });
    gunner.bloodLoss = 1;
    sim.step(); // kills him this tick
    expect(gunner.alive).toBe(false);
    // no formal succession for a packed gun — nothing to serve
    const survivors = crew.filter((s) => s.id !== gunner.id);
    expect(survivors.every((s) => s.task === null)).toBe(true);

    let fired = false;
    for (let i = 0; i < 300 && !fired; i++) {
      sim.step();
      if (sim.takeEvents().length > 0) fired = true;
    }
    expect(fired).toBe(true); // a surviving crewman still fights with his personal weapon
  });

  it('leader succession: the highest-xp teammate becomes leader about 10s after the leader dies, not before', () => {
    const sim = new Sim(new GameMap(20, 20), 52);
    sim.addSquad('blue', 'a', [
      { name: 'L', weapon: 'garand', x: 10.5, y: 10.5 },
      { name: 'Low', weapon: 'garand', x: 10.5, y: 10.5, xp: 2 },
      { name: 'High', weapon: 'garand', x: 10.5, y: 10.5, xp: 9 },
    ]);
    const [leader, low, high] = sim.soldiers;
    leader.role = 'leader';
    leader.wounds.push({ part: 0, dmg: 100 });
    leader.bloodLoss = 1; // kills him on the next physiology tick
    sim.step();
    expect(leader.alive).toBe(false);

    for (let i = 0; i < 250; i++) sim.step(); // well short of 10s: no promotion yet
    expect(high.role).not.toBe('leader');
    expect(low.role).not.toBe('leader');

    for (let i = 0; i < 100; i++) sim.step(); // past the 10s mark
    expect(high.role).toBe('leader'); // highest xp, not the lower-xp teammate
    expect(low.role).not.toBe('leader');
  });

  // #766. A role is one field: the man promoted stops being what he was.
  const leaderless = (seed: number, rest: { name: string; weapon: 'garand' | 'm1919'; xp: number; role?: 'gunner' | 'aidman' | 'assistant' | 'bearer' }[]) => {
    const sim = new Sim(new GameMap(20, 20), seed);
    sim.addSquad('blue', 'a', [{ name: 'L', weapon: 'garand', x: 10.5, y: 10.5 }, ...rest.map((m) => ({ name: m.name, weapon: m.weapon, x: 10.5, y: 10.5, xp: m.xp }))]);
    const [leader, ...men] = sim.soldiers;
    leader.role = 'leader';
    rest.forEach((m, i) => {
      if (m.role) men[i].role = m.role;
    });
    leader.wounds.push({ part: 0, dmg: 100 });
    leader.bloodLoss = 1;
    for (let i = 0; i < 360; i++) sim.step(); // past the 10 s vacancy
    expect(leader.alive).toBe(false);
    return Object.fromEntries(men.map((m) => [m.name, m.role]));
  };

  it('leader succession passes over the gunner and the aidman for a rifleman, whatever their xp', () => {
    const roles = leaderless(54, [
      { name: 'Gun', weapon: 'm1919', xp: 9, role: 'gunner' },
      { name: 'Aid', weapon: 'garand', xp: 8, role: 'aidman' },
      { name: 'Green', weapon: 'garand', xp: 1 },
      { name: 'Old', weapon: 'garand', xp: 4 },
    ]);
    expect(roles).toEqual({ Gun: 'gunner', Aid: 'aidman', Green: 'rifleman', Old: 'leader' }); // highest xp among the riflemen
  });

  it('a specialist leads only when nobody else is left: bearer, assistant, aidman, then the gunner', () => {
    expect(
      leaderless(55, [
        { name: 'Gun', weapon: 'm1919', xp: 9, role: 'gunner' },
        { name: 'Asst', weapon: 'garand', xp: 8, role: 'assistant' },
        { name: 'Bear', weapon: 'garand', xp: 1, role: 'bearer' },
      ]),
    ).toEqual({ Gun: 'gunner', Asst: 'assistant', Bear: 'leader' });
    expect(
      leaderless(56, [
        { name: 'Gun', weapon: 'm1919', xp: 9, role: 'gunner' },
        { name: 'Aid', weapon: 'garand', xp: 1, role: 'aidman' },
      ]),
    ).toEqual({ Gun: 'gunner', Aid: 'leader' });
    expect(leaderless(57, [{ name: 'Gun', weapon: 'm1919', xp: 9, role: 'gunner' }])).toEqual({ Gun: 'leader' });
  });

  it('a bazooka man and a mortar man leave a dropped rifle where it lies', () => {
    for (const weapon of ['bazooka', 'mortar60'] as const) {
      const sim = new Sim(new GameMap(20, 20), 58);
      sim.addSquad('blue', 's', [
        { name: 'Dead', weapon: 'garand', x: 5.5, y: 5.5, ammo: { clip_3006: 8 } },
        { name: 'Keeper', weapon, x: 6.0, y: 5.5, ammo: weapon === 'bazooka' ? { rocket_bazooka: 3 } : { shell_60: 12 } },
      ]);
      const [dead, keeper] = sim.soldiers;
      dead.wounds.push({ part: 0, dmg: 100 });
      dead.bloodLoss = 1;
      for (let i = 0; i < 250; i++) sim.step();
      expect(dead.alive).toBe(false);
      expect(keeper.weapon, weapon).toBe(weapon); // was 'garand' inside 5 s
      expect(keeper.ammo.clip_3006, weapon).toBeUndefined(); // and his rockets or shells were gone with it
      expect(sim.droppedKit.length, weapon).toBe(1);
    }
  });

  it("an AT gun's gunner does not trade his carbine for a rifle", () => {
    const sim = new Sim(new GameMap(40, 20), 59);
    const e = sim.addEmplacement('blue', 'at57', 10.5, 10.5, 0, 'deployed');
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const gunner = crew.find((m) => m.role === 'gunner')!;
    for (const m of crew) if (m !== gunner) m.x += 12; // staged: only the gunner stands by the rifle
    const dead = sim.soldiers[sim.addSquad('blue', 'r', [{ name: 'Dead', weapon: 'garand', x: gunner.x, y: gunner.y, ammo: { clip_3006: 8 } }]).soldierIds[0]];
    dead.wounds.push({ part: 0, dmg: 100 });
    dead.bloodLoss = 1;
    for (let i = 0; i < 250; i++) sim.step();
    expect(gunner.weapon).toBe('carbine');
    expect(sim.droppedKit.length).toBe(1);
  });

  it('a man who takes up a weapon keeps what he carries for other weapons', () => {
    // A bearer with the gun's shells picks up a rifle: the carbine magazines
    // go, the shells stay.
    const sim = new Sim(new GameMap(40, 20), 60);
    sim.addSquad('blue', 's', [
      { name: 'Dead', weapon: 'garand', x: 5.5, y: 5.5, ammo: { clip_3006: 8 } },
      { name: 'Bearer', weapon: 'carbine', x: 6.0, y: 5.5, ammo: { mag_carbine: 6, shell_57: 4 } },
    ]);
    const [dead, bearer] = sim.soldiers;
    dead.wounds.push({ part: 0, dmg: 100 });
    dead.bloodLoss = 1;
    for (let i = 0; i < 250 && bearer.weapon !== 'garand'; i++) sim.step();
    expect(bearer.weapon).toBe('garand');
    expect(bearer.ammo).toEqual({ shell_57: 4, clip_3006: 8 });

    // The assistant who takes over the MG42 adds the dead gunner's belts to
    // the ones on his own back instead of swapping one stock for the other.
    const sim2 = new Sim(new GameMap(60, 20), 61);
    const e = sim2.addEmplacement('blue', 'mg42_lafette', 10.5, 10.5, 0, 'deployed');
    const crew = sim2.teams[e.crewTeamId].soldierIds.map((id) => sim2.soldiers[id]);
    const gunner = crew.find((m) => m.role === 'gunner')!;
    const assistant = crew.find((m) => m.role === 'assistant')!;
    const belts = (gunner.ammo.belt_792 ?? 0) + (assistant.ammo.belt_792 ?? 0);
    expect(assistant.ammo.belt_792).toBeGreaterThan(0);
    gunner.wounds.push({ part: 0, dmg: 100 });
    gunner.bloodLoss = 1;
    for (let i = 0; i < 400 && assistant.role !== 'gunner'; i++) sim2.step();
    expect(assistant.role).toBe('gunner');
    expect(assistant.ammo.belt_792).toBe(belts);
  });

  it('an MG42 gunner killed on an emplacement is served by the assistant within ~10s, with a worse-aim penalty during the interim', () => {
    const sim = new Sim(new GameMap(60, 20), 46);
    const e = sim.addEmplacement('blue', 'mg42_lafette', 10.5, 10.5, 0, 'deployed');
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const gunner = crew.find((s) => s.role === 'gunner')!;
    const assistant = crew.find((s) => s.role === 'assistant')!;

    gunner.wounds.push({ part: 0, dmg: 100 });
    gunner.bloodLoss = 1; // kills him on the next physiology tick
    sim.step();
    expect(gunner.alive).toBe(false);
    // interim: pickFirer's instant fallback already has him serving the gun,
    // but he isn't the formal gunner yet — worse aim
    expect(assistant.task?.kind).toBe('takeOver');
    expect(sim.crewAimMult(assistant, WEAPONS.mg42)).toBeLessThan(1);

    for (let i = 0; i < 300 && assistant.role !== 'gunner'; i++) sim.step(); // ~10s budget
    expect(assistant.role).toBe('gunner');
    expect(assistant.weapon).toBe('mg42');
    expect(sim.crewAimMult(assistant, WEAPONS.mg42)).toBe(1); // formally took over: penalty gone
  });

  it('regression: the substitute firer never fires his personal weapon while serving the emplacement gun', () => {
    const sim = new Sim(new GameMap(60, 20), 50);
    const e = sim.addEmplacement('blue', 'mg42_lafette', 10.5, 10.5, 0, 'deployed');
    const crew = sim.teams[e.crewTeamId].soldierIds.map((id) => sim.soldiers[id]);
    const gunner = crew.find((s) => s.role === 'gunner')!;
    const assistant = crew.find((s) => s.role === 'assistant')!;
    // a target within both the assistant's personal kar98k range and the mg42's
    sim.addSquad('red', 'target', [{ name: 'T', weapon: 'kar98k', x: 40.5, y: 10.5, ammo: {} }]);
    sim.soldiers[sim.soldiers.length - 1].magLeft = 0; // dry: no return fire

    gunner.wounds.push({ part: 0, dmg: 100 });
    gunner.bloodLoss = 1;
    sim.step(); // kills the gunner this tick

    let firedPersonally = false;
    let prevMag = assistant.magLeft;
    for (let i = 0; i < 300; i++) {
      sim.step();
      if (assistant.weapon === 'kar98k' && assistant.magLeft < prevMag) firedPersonally = true;
      prevMag = assistant.magLeft;
    }
    expect(firedPersonally).toBe(false);
    expect(assistant.role).toBe('gunner'); // succession completed within the window
  });

  it('a two-man carry drags a casualty faster than a solo drag over the same distance', () => {
    const dragTicks = (helperPresent: boolean) => {
      const sim = new Sim(new GameMap(60, 20), 48);
      const members = [
        { name: 'C', weapon: 'garand' as const, x: 10.5, y: 10.5 },
        { name: 'R', weapon: 'garand' as const, x: 10.5, y: 10.5 },
      ];
      if (helperPresent) members.push({ name: 'H', weapon: 'garand' as const, x: 10.5, y: 10.5 });
      const squad = sim.addSquad('blue', 'a', members);
      const [c, r, h] = squad.soldierIds.map((id) => sim.soldiers[id]);
      c.pain = 0.9; // shock: downed, drives the physiology 'downed' flag
      r.task = { kind: 'rescue', casualtyId: c.id, phase: 'drag', timer: 0 };
      c.carriedBy = r.id;
      r.path = [{ x: 30.5, y: 10.5 }]; // fixed 20m leg
      r.pathI = 0;
      if (helperPresent) {
        c.helperId = h.id;
        h.task = { kind: 'rescue', casualtyId: c.id, phase: 'drag', timer: 0 };
      }
      let ticks = 0;
      for (; r.path && ticks < 3000; ticks++) sim.step();
      return ticks;
    };
    const solo = dragTicks(false);
    const paired = dragTicks(true);
    expect(paired).toBeLessThan(solo); // 0.8x speed cap vs 0.45x
    expect(paired).toBeLessThan(solo * 0.75); // meaningfully faster, not a rounding artifact
  });

  it('a dedicated aidman stabilizes a casualty about 3x faster than an ordinary rescuer', () => {
    const runAid = (aidman: boolean) => {
      const sim = new Sim(new GameMap(20, 20), aidman ? 50 : 49);
      sim.addSquad('blue', 'a', [
        { name: 'C', weapon: 'garand', x: 10.5, y: 10.5 },
        { name: 'R', weapon: 'garand', x: 10.5, y: 10.5 },
      ]);
      const [c, r] = sim.soldiers;
      if (aidman) r.role = 'aidman';
      r.bonds[c.id] = 1;
      r.courage = 1;
      c.pain = 0.9; // shock: downed
      let ticks = 0;
      for (; ticks < 30 * 60 && !c.stabilized; ticks++) sim.step();
      return ticks;
    };
    const normal = runAid(false);
    const aidman = runAid(true);
    expect(aidman).toBeLessThan(normal);
    expect(aidman / normal).toBeLessThan(0.5); // roughly 3x, generous bound against goto-phase overhead
  });
});

describe('3D smoke columns (plan 2026-07-23-3d-height-sim §4)', () => {
  // Flat map; two ground-smoke puffs on the east-west ray, close to the
  // observer end so the upstairs eye-line clears the column tops with margin
  // (lineZ 4.24 / 4.00 at the puffs). Deployed 3 seconds ago: that is the age
  // at which the aged column matches the old fixed SMOKE_H = 3.5 (see the
  // calibration test in tests/smoke.test.ts), so these results are the
  // pre-V11 ones unchanged.
  const groundSmokeSim = () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    sim.smoke.push(smokePuff(8.5, 10.5, 0, 60, 0, 3));
    sim.smoke.push(smokePuff(10.5, 10.5, 0, 60, 0, 3));
    return sim;
  };

  it('ground-to-ground through two puffs is still fully blind', () => {
    const sim = groundSmokeSim();
    const r = sightBetween(sim, 5.5, 10.5, 30.5, 10.5, 0, 0);
    expect(r.visible).toBe(false);
    expect(r.conceal).toBe(1);
  });

  it('upstairs observer sees OVER ground smoke that blinds a ground observer', () => {
    const sim = groundSmokeSim();
    // eye 4.6m (level 1) -> 1.6m: both puffs crossed above their 3.5m tops
    const r = sightBetween(sim, 5.5, 10.5, 30.5, 10.5, 1, 0);
    expect(r.visible).toBe(true);
    expect(r.conceal).toBe(0);
  });

  it('upstairs observer is blind through smoke deployed on their own floor', () => {
    const sim = new Sim(new GameMap(40, 20), 1);
    // level-1 deploy: z-interval [3, 6.46] contains the 4.6m eye-line
    sim.smoke.push(smokePuff(8.5, 10.5, 3, 60, 0, 3));
    sim.smoke.push(smokePuff(10.5, 10.5, 3, 60, 0, 3));
    expect(sightBetween(sim, 5.5, 10.5, 30.5, 10.5, 1, 1).visible).toBe(false);
  });

  it('flat-map snapshot stays byte-identical across same-seed double runs with smoke live', () => {
    const run = () => {
      const sim = makeScenario(42);
      sim.smoke.push(smokePuff(30.5, 40.5, 0, 60)); // still live at snapshot, and ageing through it
      for (let i = 0; i < 300; i++) sim.step();
      return sim.snapshot();
    };
    expect(run()).toBe(run());
  });
});
