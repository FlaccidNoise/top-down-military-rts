import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';
import { computeShot, type Pick } from '../src/ui/tooltip';

const soldierPick = (sim: Sim, id: number): Pick => ({ kind: 'soldier', s: sim.soldiers[id] });

describe('computeShot blocked-shot reason', () => {
  it('reports out-of-range when LOS is clear but every weapon is short', () => {
    const sim = new Sim(new GameMap(200, 10), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'rifle', x: 2.5, y: 5.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'rifle', x: 150.5, y: 5.5 }]);
    const shot = computeShot(sim, 0, -1, soldierPick(sim, 1));
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('out-of-range');
  });

  it('reports no-los when in range but a wall blocks every shooter', () => {
    const m = new GameMap(60, 10);
    for (let y = 0; y < 10; y++) m.setVEdge(30, y, EDGE.WALL);
    const sim = new Sim(m, 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'rifle', x: 2.5, y: 5.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'rifle', x: 40.5, y: 5.5 }]);
    const shot = computeShot(sim, 0, -1, soldierPick(sim, 1));
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('no-los');
  });
});
