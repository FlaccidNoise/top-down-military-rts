import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';
import { computeShot, pickAt, type Pick } from '../src/ui/tooltip';
import { formatCoverBreakdown, formatCoverBreakdownForFloor } from '../src/ui/tooltip-format';
import { TERRAIN } from '../src/sim/data';
import { Camera } from '../src/render/camera';

const soldierPick = (sim: Sim, id: number): Pick => ({ kind: 'soldier', s: sim.soldiers[id] });

describe('computeShot blocked-shot reason', () => {
  it('reports out-of-range when LOS is clear but every weapon is short', () => {
    const sim = new Sim(new GameMap(200, 10), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 5.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 150.5, y: 5.5 }]);
    const shot = computeShot(sim, 0, -1, soldierPick(sim, 1));
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('out-of-range');
  });

  it('reports no-los when in range but a wall blocks every shooter', () => {
    const m = new GameMap(60, 10);
    for (let y = 0; y < 10; y++) m.setVEdge(30, y, EDGE.WALL);
    const sim = new Sim(m, 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 2.5, y: 5.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 40.5, y: 5.5 }]);
    const shot = computeShot(sim, 0, -1, soldierPick(sim, 1));
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('no-los');
  });
});

describe('formatCoverBreakdown', () => {
  it('shows direct cover, lip, and concealment for hedge', () => {
    const lines = formatCoverBreakdown(TERRAIN.hedge);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Direct cover');
    expect(lines[0]).toContain('35%');
    expect(lines[1]).toContain('Directional lip');
    expect(lines[1]).toContain('50%');
    expect(lines[1]).toContain('within 2m');
    expect(lines[2]).toContain('Concealment');
  });

  it('omits lip line when coverBehind is undefined', () => {
    const lines = formatCoverBreakdown(TERRAIN.woods);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Direct cover');
    expect(lines[0]).toContain('30%');
    expect(lines.some((l) => l.includes('Directional lip'))).toBe(false);
    expect(lines[1]).toContain('Concealment');
  });

  it('shows none for concealment when opacity is 0', () => {
    const lines = formatCoverBreakdown(TERRAIN.grass);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Concealment: none');
  });

  it('formatCoverBreakdownForFloor has building-specific notes', () => {
    const lines = formatCoverBreakdownForFloor();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('0% in the open');
    expect(lines[1]).toContain('50% at windows');
    expect(lines[2]).toContain('Concealment: none');
  });
});

describe('pickAt tie-breaking by level', () => {
  it('prefers higher-level soldier at same distance', () => {
    const sim = new Sim(new GameMap(40, 10), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 10.5, y: 5.5 }]);
    sim.addSquad('blue', 'b', [{ name: 'B', weapon: 'garand', x: 10.5, y: 5.5 }]);
    sim.soldiers[1].level = 1;
    const cam = new Camera(10.5, 5.5);
    const pick = pickAt(sim, cam, 200, 150, 400, 300);
    expect(pick?.kind).toBe('soldier');
    if (pick?.kind === 'soldier') expect(pick.s.id).toBe(1);
  });

  it('returns first soldier when both same level (scan-order tie)', () => {
    const sim = new Sim(new GameMap(40, 10), 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 10.5, y: 5.5 }]);
    sim.addSquad('blue', 'b', [{ name: 'B', weapon: 'garand', x: 10.5, y: 5.5 }]);
    const cam = new Camera(10.5, 5.5);
    const pick = pickAt(sim, cam, 200, 150, 400, 300);
    expect(pick?.kind).toBe('soldier');
    if (pick?.kind === 'soldier') expect(pick.s.id).toBe(0);
  });
});
