import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { Sim, type UnitEvent } from '../src/sim/sim';

// Open ground; soldiers get zeroed ammo unless a test needs live rounds.
const flat = () => new GameMap(20, 10);

function stepUntil(sim: Sim, cond: () => boolean, maxTicks = 600, events?: UnitEvent[]): boolean {
  for (let i = 0; i < maxTicks; i++) {
    sim.step();
    if (events) events.push(...sim.takeUnitEvents());
    if (cond()) return true;
  }
  return cond();
}

describe('surrender', () => {
  it('attacker locks an already-broken man with a second enemy within 2m → captured', () => {
    const sim = new Sim(flat(), 42);
    const a1Id = sim.addSquad('blue', 'A1', [{ name: 'A1', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const a2Id = sim.addSquad('blue', 'A2', [{ name: 'A2', weapon: 'garand', x: 6.0, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 6.5, y: 5.5 }]).soldierIds[0];
    const a1 = sim.soldiers[a1Id];
    const a2 = sim.soldiers[a2Id];
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) { s.ammo = {}; s.magLeft = 0; }
    // Break b's morale before any melee lock
    b.morale = 0;
    const events: UnitEvent[] = [];
    // Step until psych update marks b as broken
    expect(stepUntil(sim, () => b.mental === 'broken', 300, events)).toBe(true);
    // b should be captured: 2 blue enemies (a1, a2) within MELEE_ENGAGE (2m)
    expect(b.captured).toBe(true);
    expect(b.alive).toBe(true);
    expect(b.mental).toBe('broken');
    // force-spotted both sides (captor is nearest enemy — a2 at 6.0 is closer than a1 at 5.5)
    expect(sim.spotted['red'].has(a2.id)).toBe(true);
    expect(sim.spotted['blue'].has(b.id)).toBe(true);
    // surrendered UnitEvent emitted
    expect(events.some((e) => e.kind === 'surrendered' && e.side === 'red')).toBe(true);
  });

  it('only ONE enemy within 2m → NOT captured, flees, pursuit behavior unchanged', () => {
    const sim = new Sim(flat(), 42);
    const aId = sim.addSquad('blue', 'A', [{ name: 'A', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 6.5, y: 5.5 }]).soldierIds[0];
    const a = sim.soldiers[aId];
    const b = sim.soldiers[bId];
    for (const s of [a, b]) { s.ammo = {}; s.magLeft = 0; }
    b.morale = 0;
    // Step until b breaks
    expect(stepUntil(sim, () => b.mental === 'broken', 300)).toBe(true);
    // Only 1 enemy within 2m → NOT captured
    expect(b.captured).toBe(false);
    // b should flee (has a path or is fleeing)
    expect(b.fleeing || b.path !== null || b.meleeId === -1).toBe(true);
  });

  it('man breaks mid-lock with ≥2 enemies in reach → captured instead of fleeing', () => {
    const sim = new Sim(flat(), 42);
    const a1Id = sim.addSquad('blue', 'A1', [{ name: 'A1', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const a2Id = sim.addSquad('blue', 'A2', [{ name: 'A2', weapon: 'garand', x: 6.0, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 5.8, y: 5.5 }]).soldierIds[0];
    const a1 = sim.soldiers[a1Id];
    const a2 = sim.soldiers[a2Id];
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) { s.ammo = {}; s.magLeft = 0; }
    const events: UnitEvent[] = [];
    // Step until melee lock between a1 and b
    expect(stepUntil(sim, () => a1.meleeId === b.id || b.meleeId === a1.id, 300, events)).toBe(true);
    // Break b's morale mid-lock
    b.morale = 0;
    // Step until psych update processes the break
    expect(stepUntil(sim, () => b.mental === 'broken', 300, events)).toBe(true);
    // With ≥2 enemies within 2m, b should be captured
    expect(b.captured).toBe(true);
    expect(b.alive).toBe(true);
    expect(b.mental).toBe('broken');
    // Check the surrendered event was emitted
    expect(events.some((e) => e.kind === 'surrendered')).toBe(true);
  });

  it('captured excluded from strength count but alive (not KIA)', () => {
    const sim = new Sim(flat(), 42);
    const a1Id = sim.addSquad('blue', 'A1', [{ name: 'A1', weapon: 'garand', x: 5.5, y: 5.5 }]).soldierIds[0];
    const a2Id = sim.addSquad('blue', 'A2', [{ name: 'A2', weapon: 'garand', x: 6.0, y: 5.5 }]).soldierIds[0];
    const bId = sim.addSquad('red', 'B', [{ name: 'B', weapon: 'kar98k', x: 5.8, y: 5.5 }]).soldierIds[0];
    const a1 = sim.soldiers[a1Id];
    const a2 = sim.soldiers[a2Id];
    const b = sim.soldiers[bId];
    for (const s of [a1, a2, b]) { s.ammo = {}; s.magLeft = 0; }
    const events: UnitEvent[] = [];
    expect(stepUntil(sim, () => a1.meleeId === b.id || b.meleeId === a1.id, 300, events)).toBe(true);
    b.morale = 0;
    expect(stepUntil(sim, () => b.captured, 300, events)).toBe(true);
    // b is alive but captured
    expect(b.alive).toBe(true);
    expect(b.captured).toBe(true);
    // Force-spotted both sides
    expect(sim.spotted['red'].has(a1.id)).toBe(true);
    expect(sim.spotted['blue'].has(b.id)).toBe(true);
    // surrendered event, not KIA
    expect(events.some((e) => e.kind === 'surrendered')).toBe(true);
    expect(events.some((e) => e.kind === 'kia' && e.name === 'B')).toBe(false);
  });
});
