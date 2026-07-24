import { describe, expect, it } from 'vitest';
import { EDGE, FLOOR_H, GameMap } from '../src/sim/map';
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

// A 2-story building fixture built straight from GameMap APIs: floor tiles,
// buildingId/stories arrays, perimeter WALL edges with stamped tops, a stair,
// and (optionally) a full-height interior wall. Two soldiers spawn inside —
// blue at (5.5, 6.5) (tile 5,6), red at (7.5, 6.5) (tile 7,6) — same building.
function buildTwoStory(interiorWall: boolean): Sim {
  const W = 20;
  const m = new GameMap(W, 20);
  for (let y = 5; y <= 8; y++)
    for (let x = 5; x <= 8; x++) {
      m.setTerrain(x, y, 'floor');
      m.buildingId[y * W + x] = 0;
      m.stories[y * W + x] = 2;
    }
  m.maxStories = 2;
  m.stairs[6 * W + 6] = 1;
  // perimeter walls (one-story partial tops) — exterior; interior rays don't
  // cross them, but they make the building read as built.
  const perimTop = FLOOR_H;
  for (let y = 5; y <= 8; y++) {
    m.setVEdge(5, y, EDGE.WALL); m.vEdgeTops[y * (W + 1) + 5] = perimTop;
    m.setVEdge(9, y, EDGE.WALL); m.vEdgeTops[y * (W + 1) + 9] = perimTop;
  }
  for (let x = 5; x <= 8; x++) {
    m.setHEdge(x, 5, EDGE.WALL); m.hEdgeTops[5 * W + x] = perimTop;
    m.setHEdge(x, 9, EDGE.WALL); m.hEdgeTops[9 * W + x] = perimTop;
  }
  if (interiorWall) {
    // full 2-story wall between tile (5,6) and (6,6) — blocks level-1 eyes
    m.setVEdge(6, 6, EDGE.WALL); m.vEdgeTops[6 * (W + 1) + 6] = FLOOR_H * 2;
  }
  const sim = new Sim(m, 1);
  sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 6.5 }]);
  sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 7.5, y: 6.5 }]);
  return sim;
}

describe('computeShot floor-blocked cue', () => {
  it('reports floor-blocked for an upstairs target vs a downstairs observer in the same building', () => {
    const sim = buildTwoStory(false);
    sim.soldiers[1].level = 1; // red upstairs; blue stays ground
    const shot = computeShot(sim, 0, -1, soldierPick(sim, 1));
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('floor-blocked');
    expect(shot?.lines[0]).toContain('floor/ceiling');
  });

  it('does NOT fire the cue for a genuine wall block (observer moved upstairs)', () => {
    const sim = buildTwoStory(true);
    sim.soldiers[0].level = 1; // blue upstairs
    sim.soldiers[1].level = 1; // red upstairs, same floor
    const shot = computeShot(sim, 0, -1, soldierPick(sim, 1));
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('no-los');
  });
});
