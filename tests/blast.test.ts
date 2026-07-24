import { describe, expect, it } from 'vitest';
import { EDGE, FLOOR_H, GameMap } from '../src/sim/map';
import { Sim, SLAB_SUPP_FACTOR } from '../src/sim/sim';

// Floor-aware blast (plan 2026-07-23-3d-height-sim §5): explode(x, y, p, l)
// threads detonation level into the frag los() check (slabs block fragments)
// and attenuates suppression by SLAB_SUPP_FACTOR per slab crossed.

// Same 4x4 two-story building as tests/los.test.ts: tiles (5..8, 5..8),
// stories 2, perimeter walls stamped to one story. Stair set per-test.
function buildingMap(): GameMap {
  const m = new GameMap(20, 20);
  for (let y = 5; y <= 8; y++)
    for (let x = 5; x <= 8; x++) {
      m.setTerrain(x, y, 'floor');
      m.buildingId[y * m.w + x] = 0;
      m.stories[y * m.w + x] = 2;
    }
  m.maxStories = 2;
  for (let y = 5; y <= 8; y++) {
    m.setVEdge(5, y, EDGE.WALL);
    m.vEdgeTops[y * (m.w + 1) + 5] = FLOOR_H;
    m.setVEdge(9, y, EDGE.WALL);
    m.vEdgeTops[y * (m.w + 1) + 9] = FLOOR_H;
  }
  for (let x = 5; x <= 8; x++) {
    m.setHEdge(x, 5, EDGE.WALL);
    m.hEdgeTops[5 * m.w + x] = FLOOR_H;
    m.setHEdge(x, 9, EDGE.WALL);
    m.hEdgeTops[9 * m.w + x] = FLOOR_H;
  }
  return m;
}

type ExplodeFn = (
  x: number,
  y: number,
  p?: { suppRadius: number; fragRadius: number; frags: number; dmg: [number, number] },
  l?: number,
) => void;

function simWithVictim(level: number, seed = 1): { sim: Sim; explode: ExplodeFn } {
  const sim = new Sim(buildingMap(), seed);
  sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 5.5, y: 6.5, courage: 0.5 }]);
  sim.soldiers[0].level = level;
  return { sim, explode: (sim as unknown as { explode: ExplodeFn }).explode.bind(sim) };
}

// courage 0.5, d = 2, default suppRadius 15: 0.6 * (13/15) * (1.3 - 0.3)
const BASE_SUPP = 0.6 * (1 - 2 / 15) * (1.3 - 0.5 * 0.6);

describe('floor-aware blast', () => {
  it('upstairs blast does not frag the soldier directly downstairs, but rattles him (suppression ×0.25)', () => {
    const { sim, explode } = simWithVictim(0);
    explode(7.5, 6.5, undefined, 1); // grenade one floor up
    const s = sim.soldiers[0];
    expect(s.wounds).toHaveLength(0); // slab blocks every fragment — no rng rolls
    expect(s.bleedRate).toBe(0);
    expect(s.suppression).toBeCloseTo(BASE_SUPP * SLAB_SUPP_FACTOR, 12);
  });

  it('same-floor blast behaves exactly as before (regression)', () => {
    const { sim, explode } = simWithVictim(1);
    explode(7.5, 6.5, undefined, 1); // same floor as the victim
    const s = sim.soldiers[0];
    // Frag LOS is open on the same floor: seeded rng produces a wound.
    expect(s.wounds.length).toBeGreaterThan(0);
    // Unattenuated suppression, byte-identical to the pre-3D formula
    // (wound() adds +0.3 per wound — sim.ts:3072 — subtract it back).
    expect(s.suppression - 0.3 * s.wounds.length).toBeCloseTo(BASE_SUPP, 12);
  });

  it('blast through the stair opening frags the victim on the other floor', () => {
    const m = buildingMap();
    m.stairs[6 * m.w + 6] = 1; // stair at (6,6) — on the ray
    const sim = new Sim(m, 1);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 7.5, y: 6.5, courage: 0.5 }]);
    sim.soldiers[0].level = 1; // upstairs, next to the stairwell
    const explode = (sim as unknown as { explode: ExplodeFn }).explode.bind(sim);
    explode(6.5, 6.5, undefined, 0); // ground burst on the stair tile
    const s = sim.soldiers[0];
    // The slab has a hole at the stair: ray crosses z=3 over the stair tile,
    // so fragments reach upstairs (los.test.ts stairwell geometry at work).
    expect(s.wounds.length).toBeGreaterThan(0);
    // Suppression is still attenuated — one slab separates blast and victim.
    expect(s.suppression - 0.3 * s.wounds.length).toBeCloseTo(0.6 * (1 - 1 / 15) * (1.3 - 0.5 * 0.6) * SLAB_SUPP_FACTOR, 12);
  });

  it('cross-floor victims draw zero rng: enumeration order and rng stream for same-level victims are unchanged', () => {
    // Two victims: one downstairs (slab-blocked), one upstairs (same floor
    // as the blast). The downstairs victim must not consume rng draws, so
    // the upstairs victim's outcome equals a solo-upstairs control run.
    const m = buildingMap();
    const sim = new Sim(m, 1);
    sim.addSquad('blue', 'a', [{ name: 'DOWN', weapon: 'garand', x: 5.5, y: 6.5, courage: 0.5 }]);
    sim.addSquad('blue', 'b', [{ name: 'UP', weapon: 'garand', x: 6.5, y: 6.5, courage: 0.5 }]);
    sim.soldiers[0].level = 0;
    sim.soldiers[1].level = 1;
    (sim as unknown as { explode: ExplodeFn }).explode.call(sim, 7.5, 6.5, undefined, 1);

    const ctrl = new Sim(buildingMap(), 1);
    ctrl.addSquad('blue', 'b', [{ name: 'UP', weapon: 'garand', x: 6.5, y: 6.5, courage: 0.5 }]);
    ctrl.soldiers[0].level = 1;
    (ctrl as unknown as { explode: ExplodeFn }).explode.call(ctrl, 7.5, 6.5, undefined, 1);

    expect(sim.soldiers[0].wounds).toHaveLength(0); // slab-blocked
    expect(sim.soldiers[1].wounds).toEqual(ctrl.soldiers[0].wounds);
    expect(sim.soldiers[1].suppression).toBe(ctrl.soldiers[0].suppression);
  });
});
