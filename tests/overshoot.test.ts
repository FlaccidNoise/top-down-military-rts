import { describe, expect, it } from 'vitest';
import { EDGE, GameMap } from '../src/sim/map';
import { traceOvershoot } from '../src/render/fx';

// The overshoot raycast has to use map.ts's edge-crossing convention exactly
// (vEdge between columns a and a+1 is vEdge(a+1, row)); off by one and every
// pockmark lands on the wrong side of the wall.
describe('traceOvershoot', () => {
  it('finds the wall edge east of the target and names the crossed column', () => {
    const map = new GameMap(32, 32);
    map.setVEdge(20, 10, EDGE.WALL); // west face of tile (20,10)
    const o = traceOvershoot(map, 5.5, 10.5, 15.5, 10.5, 0.5);
    expect(o.kind).toBe('wall');
    expect(o.x).toBe(20);
    expect(o.y).toBeCloseTo(10.5, 1);
    expect(o.nx).toBe(-1); // normal points back at the shooter
    expect(o.ny).toBe(0);
  });

  it('finds a horizontal wall edge when firing south', () => {
    const map = new GameMap(32, 32);
    map.setHEdge(10, 18, EDGE.WALL); // north face of tile (10,18)
    const o = traceOvershoot(map, 10.5, 5.5, 10.5, 14.5, 0.5);
    expect(o.kind).toBe('wall');
    expect(o.y).toBe(18);
    expect(o.ny).toBe(-1);
  });

  it('treats windows as strikeable masonry', () => {
    const map = new GameMap(32, 32);
    map.setVEdge(20, 10, EDGE.WINDOW);
    expect(traceOvershoot(map, 5.5, 10.5, 15.5, 10.5, 0.5).kind).toBe('wall');
  });

  it('reports foliage when a hedge comes first', () => {
    const map = new GameMap(32, 32);
    map.setVEdge(24, 10, EDGE.WALL);
    map.setTerrain(19, 10, 'hedge');
    const o = traceOvershoot(map, 5.5, 10.5, 15.5, 10.5, 0.5);
    expect(o.kind).toBe('foliage');
    expect(Math.floor(o.x)).toBe(19);
  });

  it('falls back to open ground a few meters past the target', () => {
    const map = new GameMap(32, 32);
    const o = traceOvershoot(map, 5.5, 10.5, 15.5, 10.5, 0.5);
    expect(o.kind).toBe('ground');
    expect(o.x).toBeCloseTo(15.5 + 2.75, 1);
  });
});
