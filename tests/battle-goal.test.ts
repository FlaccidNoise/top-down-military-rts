import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';
import { battleGoal, BREAK_FLOOR_MIN, BREAK_FRACTION, breakFloor, effective, quietPrompt } from '../src/ui/battle-goal';

// Two forces far apart on bare ground: nobody is in range, so the only thing
// that changes a count is this test.
function standoff(blueSquads: number, redSquads: number, redKind: 'de_gruppe' | 'de_smg42' = 'de_gruppe'): Sim {
  const sim = new Sim(new GameMap(400, 60), 5);
  for (let i = 0; i < blueSquads; i++) sim.addSquadFromDef('blue', 'us_rifle', 10, 10 + i * 8);
  for (let i = 0; i < redSquads; i++) sim.addSquadFromDef('red', redKind, 390, 10 + i * 8);
  return sim;
}

const takeOut = (sim: Sim, side: 'blue' | 'red'): void => {
  const m = sim.soldiers.find((s) => s.side === side && s.alive && !s.downed && !s.captured)!;
  m.alive = false;
};

describe('the break-off rule the HUD states is the one the sim runs', () => {
  // The constants in battle-goal.ts are a UI-side copy of a literal inside
  // Sim.step(). This walks a live Sim across the line one man at a time: the
  // battle must end on exactly the count the goal strip names, not one before
  // and not one after. A retune of either side fails here.
  // The last case is one weapon team: a quarter of it is under the minimum
  // floor, so it pins BREAK_FLOOR_MIN where the others pin BREAK_FRACTION.
  for (const [blue, red, kind] of [[3, 2, 'de_gruppe'], [2, 3, 'de_gruppe'], [4, 1, 'de_gruppe'], [1, 1, 'de_smg42']] as const) {
    it(`red breaks on the count the strip shows (${blue} v ${red} ${kind})`, () => {
      const sim = standoff(blue, red, kind);
      const breakAt = battleGoal(sim)!.enemy.breakAt;
      if (kind === 'de_smg42') expect(sim.startStrength.red * BREAK_FRACTION).toBeLessThan(BREAK_FLOOR_MIN);
      let lastStanding = -1;
      for (let i = 0; i < 200 && sim.winner === null; i++) {
        takeOut(sim, 'red');
        sim.step();
        const r = effective(sim, 'red');
        expect(effective(sim, 'blue')).toBe(sim.startStrength.blue);
        if (r < breakFloor(sim, 'red')) {
          expect(sim.winner, `red at ${r} of ${sim.startStrength.red}`).toBe('blue');
        } else {
          expect(sim.winner, `red at ${r} of ${sim.startStrength.red}`).toBeNull();
          lastStanding = r;
        }
      }
      expect(sim.winner).toBe('blue');
      expect(effective(sim, 'red')).toBe(breakAt);
      expect(lastStanding).toBe(breakAt + 1);
    });
  }

  it('blue breaks by the same rule', () => {
    const sim = standoff(2, 2);
    const breakAt = battleGoal(sim)!.own.breakAt;
    while (sim.winner === null) {
      takeOut(sim, 'blue');
      sim.step();
    }
    expect(sim.winner).toBe('red');
    expect(effective(sim, 'blue')).toBe(breakAt);
  });

  it('the floor never falls under its minimum for a tiny force', () => {
    const sim = standoff(1, 1);
    sim.startStrength.red = 3;
    expect(breakFloor(sim, 'red')).toBe(BREAK_FLOOR_MIN);
    expect(BREAK_FRACTION * 3).toBeLessThan(BREAK_FLOOR_MIN);
  });
});

describe('battleGoal', () => {
  it('has nothing to say before both sides are fielded', () => {
    expect(battleGoal(new Sim(new GameMap(40, 40), 1))).toBeNull();
    const oneSide = new Sim(new GameMap(40, 40), 1);
    oneSide.addSquadFromDef('blue', 'us_rifle', 10, 10);
    expect(battleGoal(oneSide)).toBeNull();
  });

  it('counts the men still fighting, not the wounded on the ground or the prisoners', () => {
    const sim = standoff(1, 1);
    const reds = sim.soldiers.filter((s) => s.side === 'red');
    reds[0].downed = true;
    reds[1].captured = true;
    reds[2].alive = false;
    expect(battleGoal(sim)!.enemy.now).toBe(reds.length - 3);
    expect(battleGoal(sim)!.enemy.start).toBe(reds.length);
  });

  it('colours a side by how near its break line it stands', () => {
    const sim = standoff(1, 3);
    const g0 = battleGoal(sim)!;
    expect(g0.enemy.state).toBe('steady');
    const reds = sim.soldiers.filter((s) => s.side === 'red');
    for (let i = 0; i < reds.length - g0.enemy.breakAt - 1; i++) reds[i].alive = false;
    expect(battleGoal(sim)!.enemy.now).toBe(g0.enemy.breakAt + 1);
    expect(battleGoal(sim)!.enemy.state).toBe('pinned');
    reds[reds.length - 1].alive = false;
    expect(battleGoal(sim)!.enemy.state).toBe('broken');
  });
});

describe('quietPrompt', () => {
  it('names the goal and the side the enemy is expected from before any contact', () => {
    const sim = standoff(1, 1);
    expect(quietPrompt(sim)).toBe('Break them · enemy to the east →');
    sim.threatAxis.blue = Math.PI;
    expect(quietPrompt(sim)).toBe('Break them · enemy to the west ←');
  });

  it('points at the nearest enemy the player knows of once there is one', () => {
    const sim = standoff(1, 1);
    const me = sim.soldiers.find((s) => s.side === 'blue')!;
    sim.contacts.blue.set('far', { kind: 'infantry', x: me.x + 200, y: me.y, tick: 0 });
    sim.contacts.blue.set('near', { kind: 'infantry', x: me.x, y: me.y - 60, tick: 0 });
    expect(quietPrompt(sim)).toBe('Break them · enemy to the north ↑');
    sim.spotted.blue.set(99, { x: me.x - 20, y: me.y + 20 });
    expect(quietPrompt(sim)).toBe('Break them · enemy to the south-west ↙');
  });

  it('names no control', () => {
    expect(quietPrompt(standoff(1, 1))).not.toMatch(/click|tap|press|drag|key|\[/i);
  });

  it('is silent with nobody left to command', () => {
    const sim = standoff(1, 1);
    for (const s of sim.soldiers) if (s.side === 'blue') s.alive = false;
    expect(quietPrompt(sim)).toBeNull();
  });
});
