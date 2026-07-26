import { describe, expect, it } from 'vitest';
import { EDGE } from '../src/sim/map';
import { generateMap } from '../src/sim/mapgen';
import { PatchIndex } from '../src/render/patches';
import { propsFor } from '../src/render/props';

// Props have no sim collision — src/sim is off limits — so legality is the
// whole contract: a haystack the pathfinder walks through is fine, a haystack
// in the middle of the arterial is not.
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23];

function build(seed: number) {
  const plan = generateMap(seed, 320, 240, 'town');
  return { map: plan.map, props: propsFor(plan.map, new PatchIndex(plan.map)) };
}

describe('propsFor', () => {
  it('never places a prop on road, floor, water, hedge, bridge or inside a footprint', () => {
    for (const seed of SEEDS) {
      const { map, props } = build(seed);
      for (const p of props) {
        const tx = Math.floor(p.x);
        const ty = Math.floor(p.y);
        expect(map.inBounds(tx, ty)).toBe(true);
        expect(['grass', 'field']).toContain(map.terrainKeyAt(tx, ty));
        expect(map.isBridge(tx, ty)).toBe(false);
        expect(map.buildingIdAt(tx, ty)).toBe(-1);
      }
    }
  });

  it('keeps clear of every door by at least 1 m', () => {
    for (const seed of SEEDS) {
      const { map, props } = build(seed);
      const doors: [number, number][] = [];
      for (let y = 0; y <= map.h; y++) {
        for (let x = 0; x < map.w; x++) if (map.hEdge(x, y) === EDGE.DOOR) doors.push([x + 0.5, y]);
      }
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x <= map.w; x++) if (map.vEdge(x, y) === EDGE.DOOR) doors.push([x, y + 0.5]);
      }
      for (const p of props) {
        for (const [dx, dy] of doors) {
          if (Math.abs(dx - p.x) > 2 || Math.abs(dy - p.y) > 2) continue;
          expect(Math.hypot(dx - p.x, dy - p.y)).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('keeps at least 0.8 m between any two props', () => {
    for (const seed of SEEDS) {
      const { props } = build(seed);
      const cells = new Map<number, typeof props>();
      for (const p of props) {
        const k = Math.floor(p.y) * 4096 + Math.floor(p.x);
        cells.set(k, [...(cells.get(k) ?? []), p]);
      }
      for (const p of props) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const q of cells.get((Math.floor(p.y) + dy) * 4096 + Math.floor(p.x) + dx) ?? []) {
              if (q === p) continue;
              expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThanOrEqual(0.8);
            }
          }
        }
      }
    }
  });

  it('populates the map without carpeting it', () => {
    for (const seed of SEEDS) {
      const { props } = build(seed);
      expect(props.length).toBeGreaterThanOrEqual(40);
      expect(props.length).toBeLessThanOrEqual(900);
    }
  });

  it('is byte-identical across two builds of the same map', () => {
    for (const seed of SEEDS) {
      const plan = generateMap(seed, 320, 240, 'town');
      const a = propsFor(plan.map, new PatchIndex(plan.map));
      const b = propsFor(plan.map, new PatchIndex(plan.map));
      expect(a).toEqual(b);
    }
  });
});
