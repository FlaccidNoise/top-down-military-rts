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

  // jtbug #217: grenade room-clearing opener. The grenadier keys his throw off
  // the spotted map (this.spotted[side]), not LOS: a defender he can SEE through
  // the door makes him pre-clear the opening, wait out the fuse, then go in.
  // An unseen defender (upstairs, invisible from the street) is entered blind.
  // GRENADE_FUSE_TICKS lives in sim.ts (30); the door must be an explicit
  // EDGE.DOOR for maybeGrenadeEntry to treat the opening as a door.
  it('#217: a known spotted defender in the two-storey room makes the grenadier throw before the door and wait the fuse', () => {
    const m = fortressMap();
    m.setVEdge(11, 5, EDGE.DOOR);
    const sim = new Sim(m, 1);
    const atk = sim.addSquad('blue', 'A', [{ name: 'A1', weapon: 'garand', x: 16.5, y: 5.5 }]);
    const def = sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'kar98k', x: 8.5, y: 6.5 }]);
    const a = sim.soldiers[atk.soldierIds[0]];
    for (const id of [...atk.soldierIds, ...def.soldierIds]) {
      sim.soldiers[id].ammo = {};
      sim.soldiers[id].magLeft = 0;
    }
    a.grenadesLeft = 2;
    a.morale = 1;
    a.stamina = 0.2; // fatigued: slow approach so a repath lands on the door step
    sim.spotted['blue'].set(def.soldierIds[0], { x: 8.5, y: 6.5 }); // defender known
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 8.5, y: 6.5 });

    const FUSE = 30; // GRENADE_FUSE_TICKS in sim.ts
    let throwTick = -1;
    let enteredBeforeFuse = false;
    let enteredAfterFuse = false;
    for (let i = 0; i < 300; i++) {
      sim.step();
      if (throwTick < 0 && a.grenadesLeft < 2) throwTick = sim.tick;
      if (throwTick >= 0 && sim.tick < throwTick + FUSE && a.x < 11) enteredBeforeFuse = true;
      if (throwTick >= 0 && sim.tick >= throwTick + FUSE && a.x < 11) enteredAfterFuse = true;
    }
    expect(throwTick).toBeGreaterThanOrEqual(0); // the entry throw fired
    expect(a.entryHoldUntil).toBe(throwTick + FUSE);
    expect(enteredBeforeFuse).toBe(false); // waited the fuse outside
    expect(enteredAfterFuse).toBe(true);
  });

  it('#217: an unseen (unspotted) upstairs defender does not trigger the entry throw', () => {
    const sim = new Sim(fortressMap(), 1);
    const atk = sim.addSquad('blue', 'A', [{ name: 'A1', weapon: 'garand', x: 16.5, y: 5.5 }]);
    const def = sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'kar98k', x: 8.5, y: 6.5 }]);
    const a = sim.soldiers[atk.soldierIds[0]];
    for (const id of [...atk.soldierIds, ...def.soldierIds]) {
      sim.soldiers[id].ammo = {};
      sim.soldiers[id].magLeft = 0;
    }
    sim.soldiers[def.soldierIds[0]].level = 1; // upstairs: no LOS from the street
    a.grenadesLeft = 2;
    a.morale = 1;
    a.stamina = 0.2; // mirror the spotted test's cadence
    // NO spotted mark — the defender is unknown
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 8.5, y: 6.5, l: 1 });

    for (let i = 0; i < 300; i++) sim.step();
    expect(a.grenadesLeft).toBe(2); // no throw
    expect(a.entryHoldUntil).toBe(0); // never held outside the door
  });

  // #217 stair variant: the same pre-clear throw keys off the spotted map at the
  // STAIR opening, not just the door. A two-storey fortress with its defender
  // UPSTAIRS — known to blue via a shared friendly observer who walks into view
  // through an upper-storey window, far outside the frag radius — makes the
  // grenadier pre-clear the floor above, stay on level 0 until the 30-tick fuse
  // burns, and only then climb. The observer must spot the defender only after
  // the assault's initial compliance check (a defender covering the approach at
  // issuance would balk the charge instead).
  it('#217: a spotted upstairs defender is grenade pre-cleared at the stair; the grenadier stays level 0 until the fuse burns, then climbs', () => {
    // 7×5 two-storey block, stair in the NW corner — big enough that the far
    // corner defender sits >3 m (GRENADE_BLAST.fragRadius) from the stair, so
    // the throw is not refused as a point-blank frag.
    const m = new GameMap(28, 18);
    for (let y = 4; y <= 8; y++)
      for (let x = 9; x <= 15; x++) {
        m.setTerrain(x, y, 'floor');
        m.buildingId[y * m.w + x] = 0;
        m.stories[y * m.w + x] = 2;
      }
    m.maxStories = 2;
    for (let y = 4; y <= 8; y++) {
      m.setVEdge(9, y, EDGE.WALL);
      if (y !== 6) m.setVEdge(16, y, EDGE.WALL); // east entrance at y=6
    }
    for (let x = 9; x <= 15; x++) {
      m.setHEdge(x, 4, EDGE.WALL);
      m.setHEdge(x, 9, EDGE.WALL);
    }
    m.stairs[4 * m.w + 9] = 1; // NW-corner stair
    m.setHEdge(15, 9, EDGE.WINDOW); // upper-storey window overlooking the defender

    const sim = new Sim(m, 1);
    // the observer starts behind the block (no LOS up into the window) and
    // walks south to the window vantage, so the upstairs defender is spotted
    // only once the assault is already executing. He stays well outside the
    // frag radius of the defender, keeping the throw's friendly-frag check clear.
    const obs = sim.addSquad('blue', 'O', [{ name: 'O1', weapon: 'garand', x: 22.5, y: 12.5 }]);
    const atk = sim.addSquad('blue', 'A', [{ name: 'A1', weapon: 'garand', x: 17.5, y: 6.5 }]);
    const def = sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'kar98k', x: 15.5, y: 8.5 }]);
    const a = sim.soldiers[atk.soldierIds[0]];
    for (const id of [...obs.soldierIds, ...atk.soldierIds, ...def.soldierIds]) {
      sim.soldiers[id].ammo = {};
      sim.soldiers[id].magLeft = 0;
    }
    sim.soldiers[def.soldierIds[0]].level = 1; // garrisoned upstairs
    a.grenadesLeft = 2;
    a.morale = 1;
    a.stamina = 0.2; // fatigued approach so a repath lands at the stair base
    sim.soldiers[obs.soldierIds[0]].morale = 1; // so the observer's own move order does not balk before it reaches the window

    sim.orderTeam(obs.teamIds[0], { kind: 'move', x: 15.5, y: 9.5 }); // observer walks into the window vantage
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 15.5, y: 8.5, l: 1 });

    const FUSE = 30; // GRENADE_FUSE_TICKS in sim.ts
    let throwTick = -1;
    let climbedBeforeFuse = false;
    let climbedAfterFuse = false;
    for (let i = 0; i < 500; i++) {
      sim.step();
      if (throwTick < 0 && a.grenadesLeft < 2) throwTick = sim.tick;
      if (a.level === 1) {
        if (throwTick < 0 || sim.tick < throwTick + FUSE) climbedBeforeFuse = true;
        else climbedAfterFuse = true;
      }
    }

    expect(throwTick).toBeGreaterThanOrEqual(0); // stair pre-clear fired at the spotted upstairs defender
    expect(a.grenadesLeft).toBe(1);
    expect(a.entryHoldUntil).toBe(throwTick + FUSE);
    expect(climbedBeforeFuse).toBe(false); // waited the fuse out at the stair base, level 0
    expect(climbedAfterFuse).toBe(true); // ...then climbed
  });

});
