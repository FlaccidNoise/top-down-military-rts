import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { Sim, type Soldier } from '../src/sim/sim';
import { CRAWL_R, CRAWL_SUPP_THRESHOLD } from '../src/sim/spots';

// M6 (movement design §2.2, §4.4): a man under effective fire in the open,
// with nothing else asked of him, crawls to cover instead of dying where he
// stands. Failure states first — no cover in reach, and cover his mates are
// already using — then the gates that keep the behavior out of orders, then
// liveness under natural dynamics.

const tileOf = (s: Soldier): [number, number] => [Math.floor(s.x), Math.floor(s.y)];
const destOf = (s: Soldier): [number, number] | null => {
  const p = s.path;
  return p && p.length > 0 ? [Math.floor(p[p.length - 1].x), Math.floor(p[p.length - 1].y)] : null;
};

// One hedge tile at (20, 12) on open grass, and an enemy known to the EAST.
// That geometry has exactly two covered tiles in the crawler's reach: the
// hedge's west face (19, 12), where the lip sits between him and the threat,
// and the hedge tile itself (20, 12), which is passable cover but no lip.
// Everything else on the map is bare grass, so the fixture has no ties.
const HEDGE: [number, number] = [20, 12];
function hedgeSim(mates: [number, number][] = []): { sim: Sim; man: Soldier } {
  const sim = new Sim(new GameMap(48, 24), 7);
  sim.map.setTerrain(HEDGE[0], HEDGE[1], 'hedge');
  const squad = sim.addSquad('blue', 'B', [
    { name: 'S', weapon: 'garand', x: 16.5, y: 12.5 },
    ...mates.map(([x, y], i) => ({ name: `M${i}`, weapon: 'garand' as const, x: x + 0.5, y: y + 0.5 })),
  ]);
  for (const id of squad.soldierIds) {
    const s = sim.soldiers[id];
    s.ammo = {}; // dry: no firefight, and no rng burned on one
    s.magLeft = 0;
    s.morale = 1; // holds him at 'shaken' so the roll of the courage draw cannot pin him
  }
  sim.spotted.blue.set(999, { x: 30.5, y: 12.5 }); // known contact due east — the threat bearing
  return { sim, man: sim.soldiers[squad.soldierIds[0]] };
}

// Hold him under effective fire for `ticks`: suppression decays every tick,
// and the point of the fixture is a man who stays suppressed.
function underFire(sim: Sim, man: Soldier, ticks: number, supp = 0.5): void {
  for (let i = 0; i < ticks; i++) {
    man.suppression = supp;
    sim.step();
  }
}

describe('crawl-to-cover: failure states', () => {
  it('no cover in reach: he stays where he is and takes it', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const squad = sim.addSquad('blue', 'B', [{ name: 'S', weapon: 'garand', x: 20.5, y: 12.5 }]);
    const man = sim.soldiers[squad.soldierIds[0]];
    man.ammo = {};
    man.magLeft = 0;
    man.morale = 1;
    const start: [number, number] = [man.x, man.y];
    underFire(sim, man, 120); // > 2 full CRAWL_TICKS cadences

    expect(man.path).toBe(null);
    expect([man.x, man.y]).toEqual(start);
  });

  it('his mates already hold the best tile: he takes the next cover, not theirs', () => {
    const solo = hedgeSim();
    underFire(solo.sim, solo.man, 60);
    expect(destOf(solo.man)).toEqual([19, 12]); // the west face, unblocked

    // Same fixture, one squadmate standing on that west face.
    const { sim, man } = hedgeSim([[19, 12]]);
    underFire(sim, man, 60);
    const dest = destOf(man);
    expect(dest).not.toEqual([19, 12]);
    expect(dest).toEqual(HEDGE); // the hedge body: worse cover, but cover
    expect(sim.inCover(HEDGE[0] + 0.5, HEDGE[1] + 0.5)).toBe(true);
  });

  it('a mate walking to the tile reserves it too — the squad does not converge on one hedge', () => {
    const { sim, man } = hedgeSim([[10, 12]]);
    const mate = sim.soldiers[sim.squads[man.squadId].soldierIds[1]];
    mate.path = [{ x: 19.5, y: 12.5, l: 0 }]; // already on his way to the west face
    underFire(sim, man, 60);

    expect(destOf(man)).toEqual(HEDGE);
  });
});

describe('crawl-to-cover: the gates', () => {
  it('crawls onto the threat side of the hedge, and stops once he is in cover', () => {
    const { sim, man } = hedgeSim();
    underFire(sim, man, 60);
    expect(destOf(man)).toEqual([19, 12]);

    underFire(sim, man, 300); // long enough to arrive and re-trigger many times
    expect(tileOf(man)).toEqual([19, 12]);
    expect(sim.inCover(man.x, man.y)).toBe(true);
    expect(man.path).toBe(null); // arrived, and the trigger predicate is now false
  });

  it('a pinned man does not crawl — he cannot move at all', () => {
    const { sim, man } = hedgeSim();
    underFire(sim, man, 120, 0.95);

    expect(man.mental).toBe('pinned');
    expect(man.path).toBe(null);
    expect(tileOf(man)).toEqual([16, 12]);
  });

  it('a man already in cover stays put, hedge on the wrong side or not', () => {
    const { sim } = hedgeSim();
    const squad = sim.addSquad('blue', 'C', [{ name: 'W', weapon: 'garand', x: 21.5, y: 12.5 }]);
    const man = sim.soldiers[squad.soldierIds[0]];
    man.ammo = {};
    man.magLeft = 0;
    man.morale = 1;
    expect(sim.inCover(man.x, man.y)).toBe(true); // omnidirectional: the lip counts from either face
    underFire(sim, man, 120);

    expect(man.path).toBe(null);
    expect(tileOf(man)).toEqual([21, 12]);
  });

  it('below the under-fire line he does not move', () => {
    const { sim, man } = hedgeSim();
    underFire(sim, man, 120, CRAWL_SUPP_THRESHOLD);

    expect(man.path).toBe(null);
    expect(tileOf(man)).toEqual([16, 12]);
  });

  it('cover beyond CRAWL_R is out of reach', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    sim.map.setTerrain(16 + CRAWL_R + 2, 12, 'hedge');
    const squad = sim.addSquad('blue', 'B', [{ name: 'S', weapon: 'garand', x: 16.5, y: 12.5 }]);
    const man = sim.soldiers[squad.soldierIds[0]];
    man.ammo = {};
    man.magLeft = 0;
    man.morale = 1;
    underFire(sim, man, 60);

    expect(man.path).toBe(null);
  });

  it('a team order still running owns its members: no crawl mid-execution', () => {
    const { sim, man } = hedgeSim([[16, 14]]);
    const mate = sim.soldiers[sim.squads[man.squadId].soldierIds[1]];
    sim.orderTeam(man.teamId, { kind: 'move', x: 44.5, y: 12.5 });
    expect(sim.teams[man.teamId].orderState.phase).toBe('executing');

    // He arrives first; his mate is still walking, so the ORDER is still
    // executing — the state stepOrders' arrival test reads paths in.
    man.path = null;
    expect(mate.path).not.toBe(null);
    underFire(sim, man, 60);
    expect(sim.teams[man.teamId].orderState.phase).toBe('executing');
    expect(man.path).toBe(null); // no crawl: the order is not finished with him

    // Order done. Same man, same fire, same hedge — now he takes cover.
    sim.teams[man.teamId].orderState = { order: null, phase: 'idle', reason: '' };
    underFire(sim, man, 60);
    expect(destOf(man)).toEqual([19, 12]);
  });
});

// Design §4.4, and the recorded lesson that forced preconditions hide dead
// features: nothing here is staged except the terrain and the dry rifles. The
// suppression, the spotting, the mental states and the crawl all have to
// happen on their own.
describe('crawl-to-cover: liveness under natural dynamics', () => {
  function overwatch(seed: number): Sim {
    const sim = new Sim(new GameMap(140, 60), seed);
    for (let y = 18; y < 46; y++) sim.map.setTerrain(84, y, 'hedge'); // a hedge line 4 m west of the riflemen
    sim.addSquad('red', 'MG', [
      { name: 'G', weapon: 'mg42', x: 40.5, y: 30.5 },
      { name: 'A1', weapon: 'kar98k', x: 41.5, y: 29.5 },
      { name: 'A2', weapon: 'kar98k', x: 41.5, y: 31.5 },
    ]);
    const blue = sim.addSquad(
      'blue',
      'Rifles',
      Array.from({ length: 8 }, (_, i) => ({ name: `B${i}`, weapon: 'garand' as const, x: 88.5, y: 26.5 + i })),
    );
    // Dry: they are the ones being suppressed, not a second base of fire.
    for (const id of blue.soldierIds) {
      const s = sim.soldiers[id];
      s.ammo = {};
      s.magLeft = 0;
    }
    return sim;
  }

  it('an MG42 overwatch drives unordered riflemen into cover on their own', () => {
    const sim = overwatch(3);
    const blue = sim.squads.find((sq) => sq.name === 'Rifles')!;
    const start = new Map(blue.soldierIds.map((id) => [id, tileOf(sim.soldiers[id]).join(',')]));
    const disqualified = new Set<number>(); // moved by something that is not the crawl
    const crawled = new Set<number>();

    for (let i = 0; i < 6000; i++) {
      sim.step();
      for (const id of blue.soldierIds) {
        const s = sim.soldiers[id];
        if (!s.alive) continue;
        if (s.mental === 'broken' || s.fleeing || s.task || s.meleeId >= 0) disqualified.add(id);
        if (disqualified.has(id)) continue;
        if (tileOf(s).join(',') !== start.get(id) && sim.inCover(s.x, s.y)) crawled.add(id);
      }
    }

    // Measured over 200 s, seeds 3/11/42: 8/8, 8/8 and 7/8 riflemen reach
    // cover on their own, and 5/4/6 of the 8 are still alive at the end.
    // With the crawl call removed the same three runs give 0 relocations and
    // 0/1/1 survivors — the behavior is what moves them, and it is worth
    // roughly four men a squad against an untouchable MG (design §2.2's
    // "reduces attrition of suppressed troops on both sides").
    expect(crawled.size).toBeGreaterThan(0);
  }, 60000);

  it('the crawl is deterministic: twin sims stay byte-identical through 200 s of it', () => {
    const a = overwatch(3);
    const b = overwatch(3);
    for (let i = 0; i < 6000; i++) {
      a.step();
      b.step();
    }
    expect(a.snapshot()).toBe(b.snapshot());
  }, 60000);
});
