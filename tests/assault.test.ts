import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { CHARGE_BALK_REASON } from '../src/sim/orders';
import { Sim } from '../src/sim/sim';

// Assault order (decision log 2026-07-23): the charge that feeds the melee
// lock. Soldiers are dried by default so melee/pathing is what's under test.

const flat = (w = 60, h = 20) => new GameMap(w, h);

function dry(sim: Sim, ids: number[]): void {
  for (const id of ids) {
    sim.soldiers[id].ammo = {};
    sim.soldiers[id].magLeft = 0;
  }
}

function stepUntil(sim: Sim, cond: () => boolean, maxTicks = 1200): boolean {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (cond()) return true;
  }
  return cond();
}

// Two hedge rows fully block LOS (0.5 conceal each), so the approach reads
// safe and the charge complies — the assault only meets its defenders late.
function hedgeScreenedAssault() {
  const m = flat(40, 12);
  for (let y = 0; y < 12; y++) {
    m.setTerrain(20, y, 'hedge');
    m.setTerrain(23, y, 'hedge');
  }
  const sim = new Sim(m, 11);
  const atk = sim.addSquad('blue', 'A', [
    { name: 'A1', weapon: 'garand', x: 10.5, y: 5.5 },
    { name: 'A2', weapon: 'garand', x: 10.5, y: 7.5 },
    { name: 'A3', weapon: 'thompson', x: 9.5, y: 6.5 },
  ]);
  const def = sim.addSquad('red', 'D', [
    { name: 'D1', weapon: 'kar98k', x: 28.5, y: 5.5 },
    { name: 'D2', weapon: 'kar98k', x: 28.5, y: 7.5 },
  ]);
  dry(sim, [...atk.soldierIds, ...def.soldierIds]);
  return { sim, atk, def };
}

describe('assault order', () => {
  it('a screened charge complies, closes through the hedges, and ends in melee', () => {
    const { sim, atk, def } = hedgeScreenedAssault();
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 28.5, y: 6.5 });
    const st = sim.teams[atk.teamIds[0]].orderState;
    expect(st.phase).toBe('executing');
    expect(st.order?.kind).toBe('assault');
    const attackers = atk.soldierIds.map((id) => sim.soldiers[id]);
    const defenders = def.soldierIds.map((id) => sim.soldiers[id]);
    expect(stepUntil(sim, () => attackers.some((a) => a.meleeId >= 0))).toBe(true);
    // the charge finishes the position: defenders dead/downed, order completes
    expect(stepUntil(sim, () => defenders.every((d) => !d.alive || d.downed), 3600)).toBe(true);
    expect(stepUntil(sim, () => st.order === null && st.phase === 'idle', 900)).toBe(true);
  });

  it('a naked charge across open ground balks with the charge reason', () => {
    const sim = new Sim(flat(), 11);
    const atk = sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'garand', x: 10.5, y: 9.5 },
      { name: 'A2', weapon: 'garand', x: 10.5, y: 11.5 },
    ]);
    sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'kar98k', x: 35.5, y: 10.5 }]);
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 35.5, y: 10.5 });
    const st = sim.teams[atk.teamIds[0]].orderState;
    expect(st.phase).toBe('balked');
    expect(st.reason).toBe(CHARGE_BALK_REASON);
  });

  it('smoke on the approach turns that same balked charge into a live one', () => {
    const sim = new Sim(flat(), 11);
    const atk = sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'garand', x: 10.5, y: 9.5 },
      { name: 'A2', weapon: 'garand', x: 10.5, y: 11.5 },
    ]);
    sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'kar98k', x: 35.5, y: 10.5 }]);
    // two puffs on the sightline = opacity 1, LOS blocked — the doctrine loop
    sim.smoke.push({ x: 23, y: 10.4, ttl: 60 }, { x: 23, y: 10.6, ttl: 60 });
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 35.5, y: 10.5 });
    expect(sim.teams[atk.teamIds[0]].orderState.phase).toBe('executing');
  });

  it('marching fire: assaulting men shoot while still moving', () => {
    const { sim, atk } = hedgeScreenedAssault();
    // attackers keep their ammo this time; defenders stay dry
    for (const id of atk.soldierIds) {
      const s = sim.soldiers[id];
      s.ammo = { clip_3006: 6, mag_thompson: 3 };
      s.magLeft = 8;
    }
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 28.5, y: 6.5 });
    const attackers = atk.soldierIds.map((id) => sim.soldiers[id]);
    let firedOnTheMove = false;
    for (let i = 0; i < 1200 && !firedOnTheMove; i++) {
      const moving = new Set(attackers.filter((a) => a.path).map((a) => a.id));
      sim.step();
      for (const e of sim.takeEvents()) {
        if (attackers.some((a) => moving.has(a.id) && Math.hypot(a.x - e.fx, a.y - e.fy) < 0.01)) firedOnTheMove = true;
      }
    }
    expect(firedOnTheMove).toBe(true);
  });

  it('partial exposure downgrades the charge to a cautious advance', () => {
    // 3 of 8 danger samples inside the defender's Thompson range: a plain
    // move complies, the same ask as a charge comes back "advancing instead".
    const sim = new Sim(flat(140, 20), 11);
    const atk = sim.addSquad('blue', 'A', [
      { name: 'A1', weapon: 'springfield', x: 10.5, y: 10.5 },
      { name: 'A2', weapon: 'garand', x: 10.5, y: 12.5 },
    ]);
    sim.addSquad('red', 'D', [{ name: 'D1', weapon: 'thompson', x: 130.5, y: 10.5 }]);
    for (const id of atk.soldierIds) {
      const s = sim.soldiers[id];
      s.morale = 1;
    }
    sim.soldiers[atk.soldierIds[0]].role = 'leader';
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 130.5, y: 10.5 });
    const st = sim.teams[atk.teamIds[0]].orderState;
    expect(st.phase).not.toBe('balked');
    expect(st.order?.kind).toBe('move'); // downgraded — no charge home
    expect(st.reason).toBe('unwilling to charge — advancing instead');
  });

  it('an uncontested assault just takes the ground and completes', () => {
    const sim = new Sim(flat(), 11);
    const atk = sim.addSquad('blue', 'A', [{ name: 'A1', weapon: 'garand', x: 10.5, y: 10.5 }]);
    dry(sim, atk.soldierIds);
    sim.orderTeam(atk.teamIds[0], { kind: 'assault', x: 30.5, y: 10.5 });
    const st = sim.teams[atk.teamIds[0]].orderState;
    expect(st.phase).toBe('executing');
    expect(stepUntil(sim, () => st.order === null && st.phase === 'idle')).toBe(true);
    const a = sim.soldiers[atk.soldierIds[0]];
    expect(Math.hypot(a.x - 30.5, a.y - 10.5)).toBeLessThan(5);
  });
});
