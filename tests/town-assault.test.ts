import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';

// jtbug #130: floor-aware town assault. A garrison auto-garrisons the TOP
// storey (orderLevel), and the level-blind assault plumbing walked chargers to
// the street tile under the window and hung the order "blocked" forever. The
// charge must climb: door, stairs, same-storey fight, order completes.

// 3×3 two-storey room, walls all round except an east door at y=5, stair in
// the far corner — the same shape orders.test.ts's auto-garrison suite uses.
function fortressMap(): GameMap {
  const m = new GameMap(24, 12);
  for (let y = 4; y <= 6; y++)
    for (let x = 8; x <= 10; x++) {
      m.setTerrain(x, y, 'floor');
      m.buildingId[y * m.w + x] = 0;
      m.stories[y * m.w + x] = 2;
    }
  m.maxStories = 2;
  for (let y = 4; y <= 6; y++) {
    m.setVEdge(8, y, EDGE.WALL);
    if (y !== 5) m.setVEdge(11, y, EDGE.WALL); // east door at y=5
  }
  for (let x = 8; x <= 10; x++) {
    m.setHEdge(x, 4, EDGE.WALL);
    m.setHEdge(x, 7, EDGE.WALL);
  }
  m.stairs[4 * m.w + 8] = 1;
  return m;
}

function stepUntil(sim: Sim, cond: () => boolean, maxTicks = 3600): boolean {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (cond()) return true;
  }
  return cond();
}

describe('floor-aware town assault (#130)', () => {
  it('a charge briefed at the top storey climbs the stairs, clears the garrison, and completes', () => {
    const sim = new Sim(fortressMap(), 11);
    const atk = sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'garand', x: 16.5, y: 4.5 },
      { name: 'A2', weapon: 'garand', x: 16.5, y: 5.5 },
      { name: 'A3', weapon: 'garand', x: 16.5, y: 6.5 },
      { name: 'A4', weapon: 'thompson', x: 17.5, y: 5.5 },
    ]);
    // Garrison holds the north row, OFF the door sight-lane at y=5: a defender
    // covering the approach drives dangerScore past the balk line (correctly —
    // the AI smokes the post first for exactly this reason). This test is the
    // movement/melee plumbing, not the compliance ladder.
    const def = sim.addSquad('red', 'D', [
      { name: 'D1', weapon: 'kar98k', x: 9.5, y: 4.5 },
      { name: 'D2', weapon: 'kar98k', x: 10.5, y: 4.5 },
    ]);
    for (const id of [...atk.soldierIds, ...def.soldierIds]) {
      sim.soldiers[id].ammo = {};
      sim.soldiers[id].magLeft = 0;
    }
    for (const id of atk.soldierIds) sim.soldiers[id].morale = 1; // willing — verdict must stay 'comply'
    for (const id of def.soldierIds) sim.soldiers[id].level = 1; // garrisoned upstairs
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 9.5, y: 5.5, l: 1 });

    // the charge enters the door and climbs to the garrison's storey...
    expect(stepUntil(sim, () => atk.soldierIds.some((id) => sim.soldiers[id].alive && sim.soldiers[id].level === 1))).toBe(true);
    // ...the garrison falls at bayonet point (zero ammo all round)...
    expect(
      stepUntil(sim, () =>
        def.soldierIds.every((id) => {
          const d = sim.soldiers[id];
          return !d.alive || d.downed || d.captured;
        }),
      ),
    ).toBe(true);
    // ...and the order COMPLETES instead of hanging "blocked" forever
    expect(stepUntil(sim, () => sim.teams[atk.teamIds[0]].orderState.phase === 'idle')).toBe(true);
  });

  it('a charger on the street does not melee-lock through the floor slab', () => {
    const sim = new Sim(fortressMap(), 12);
    const atk = sim.addSquad('blue', 'A', [{ name: 'A1', weapon: 'garand', x: 9.5, y: 5.5 }]);
    const def = sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'kar98k', x: 9.5, y: 5.5 }]);
    for (const id of [...atk.soldierIds, ...def.soldierIds]) {
      sim.soldiers[id].ammo = {};
      sim.soldiers[id].magLeft = 0;
    }
    sim.soldiers[def.soldierIds[0]].level = 1; // directly overhead, 2D distance 0
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.soldiers[atk.soldierIds[0]].meleeId).toBe(-1);
    expect(sim.soldiers[def.soldierIds[0]].meleeId).toBe(-1);
  });
});
