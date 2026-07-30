import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { hedgeBanks } from '../src/sim/relief';
import {
  EYE_VEHICLE,
  eyeOf,
  HULL_VEHICLE,
  Sim,
  sightBetween,
  sightToSoldier,
  SPOT_INTERVAL,
  stanceOf,
  type Side,
  type Soldier,
} from '../src/sim/sim';

// V9: stance × relief, at the SIM level rather than the los() level — the
// stance comes from a real order through the public API, the relief from
// relief.ts's own geometry, and the sense from the same funnel the AI uses.
// Staged maps, not generated ones, so every assertion is exact (V3 has not
// wired relief into mapgen yet, and these tests must not depend on it).

const W = 40;
const H = 12;

// A N→S hedgerow on a bank at x = HEDGE_X, built by the real R-A pass: hedge
// tiles rise to 1 m and the west flank rises with them. Placed close to the
// eastern man on purpose — a 1 m rise MID-field does not hide a prone target
// from a standing observer, because the sagging chord is still above the crest
// where it enters that tile. The tactical case is a man hugging the far side.
const HEDGE_X = 24;

function bankMap(mirror = false): GameMap {
  const m = new GameMap(W, H);
  const mx = (x: number) => (mirror ? W - 1 - x : x);
  for (let y = 0; y < H; y++) m.setTerrain(mx(HEDGE_X), y, 'hedge');
  hedgeBanks(m, new Uint8Array(W * H));
  return m;
}

const swap = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');

function place(sim: Sim, side: Side, name: string, x: number, y: number): Soldier {
  const sq = sim.addSquad(side, name, [{ name, weapon: 'kar98k', x, y }]);
  return sim.soldiers[sq.soldierIds[0]];
}

describe('a hedge bank hides the stance that lies behind it', () => {
  const stage = () => {
    const sim = new Sim(bankMap(), 7);
    const watcher = place(sim, 'blue', 'W', 4.5, 6.5);
    const hider = place(sim, 'red', 'H', HEDGE_X + 2.5, 6.5); // far side, hugging the bank
    return { sim, watcher, hider };
  };

  it('standing, he is seen; on an ambush order, he is not', () => {
    const { sim, watcher, hider } = stage();
    expect(stanceOf(sim, hider)).toBe('stand');
    expect(sightToSoldier(sim, watcher.x, watcher.y, hider, 0, eyeOf(sim, watcher)).visible).toBe(true);

    sim.orderTeam(hider.teamId, { kind: 'ambush', x: hider.x, y: hider.y });
    expect(stanceOf(sim, hider)).toBe('prone'); // the doctrine stance, from the order
    expect(sightToSoldier(sim, watcher.x, watcher.y, hider, 0, eyeOf(sim, watcher)).visible).toBe(false);
  });

  it('a defend order is not enough — a crouching man still clears a 1 m bank', () => {
    const { sim, watcher, hider } = stage();
    sim.orderTeam(hider.teamId, { kind: 'defend', x: hider.x, y: hider.y });
    expect(stanceOf(sim, hider)).toBe('crouch');
    expect(sightToSoldier(sim, watcher.x, watcher.y, hider, 0, eyeOf(sim, watcher)).visible).toBe(true);
  });

  it('the watcher lying down too does not restore the sightline', () => {
    const { sim, watcher, hider } = stage();
    sim.orderTeam(hider.teamId, { kind: 'ambush', x: hider.x, y: hider.y });
    sim.orderTeam(watcher.teamId, { kind: 'ambush', x: watcher.x, y: watcher.y });
    expect(sightToSoldier(sim, watcher.x, watcher.y, hider, 0, eyeOf(sim, watcher)).visible).toBe(false);
  });

  it('hugging the far side beats optics too — and the ambusher is blind in the same instant', () => {
    // A cupola at 2.2 m clears a bank in the MIDDLE of the field that stops a
    // rifleman (tests/eye-heights.test.ts pins that at the los() level). It does
    // NOT clear a bank the target is lying against: the chord has already sagged
    // to the target's 0.4 m by the time it reaches the crest. The trade is
    // symmetric and it is the whole point of the position — the ambusher cannot
    // see his target either until he comes up to fire.
    const { sim, hider } = stage();
    const v = sim.addVehicle('blue', 'sherman', 4.5, 6.5, 0);
    expect(sightBetween(sim, v.x, v.y, hider.x, hider.y, 0, hider.level, EYE_VEHICLE, eyeOf(sim, hider)).visible).toBe(true);

    sim.orderTeam(hider.teamId, { kind: 'ambush', x: hider.x, y: hider.y });
    expect(sightBetween(sim, v.x, v.y, hider.x, hider.y, 0, hider.level, EYE_VEHICLE, eyeOf(sim, hider)).visible).toBe(false);
    expect(sightBetween(sim, hider.x, hider.y, v.x, v.y, hider.level, 0, eyeOf(sim, hider), HULL_VEHICLE).visible).toBe(false);
  });

  it('the fog-of-war sweep agrees with the raycast: an ambusher behind the bank goes unspotted', () => {
    const { sim, hider } = stage();
    sim.orderTeam(hider.teamId, { kind: 'ambush', x: hider.x, y: hider.y });
    for (let i = 0; i < SPOT_INTERVAL + 1; i++) sim.step();
    expect(sim.soldierVisibleTo('blue', hider)).toBe(false);

    const seen = stage();
    for (let i = 0; i < SPOT_INTERVAL + 1; i++) seen.sim.step();
    expect(seen.sim.soldierVisibleTo('blue', seen.hider)).toBe(true);
  });
});

describe('a 3 m embankment is a wall to everybody', () => {
  const crestMap = () => {
    const m = new GameMap(W, H);
    for (let y = 0; y < H; y++)
      for (const [x, e] of [
        [18, 1],
        [19, 2],
        [20, 3],
        [21, 3],
        [22, 3],
        [23, 2],
        [24, 1],
      ] as [number, number][]) {
        m.elev[y * W + x] = e;
        m.setTerrain(x, y, e === 3 ? 'rail' : 'bank');
      }
    return m;
  };

  it('blocks stand→stand in both directions', () => {
    const sim = new Sim(crestMap(), 7);
    const a = place(sim, 'blue', 'A', 6.5, 6.5);
    const b = place(sim, 'red', 'B', 34.5, 6.5);
    expect(sightToSoldier(sim, a.x, a.y, b, 0, eyeOf(sim, a)).visible).toBe(false);
    expect(sightToSoldier(sim, b.x, b.y, a, 0, eyeOf(sim, b)).visible).toBe(false);
  });

  it('a man on the crest sees both approaches that cannot see each other', () => {
    const sim = new Sim(crestMap(), 7);
    const a = place(sim, 'blue', 'A', 6.5, 6.5);
    const b = place(sim, 'red', 'B', 34.5, 6.5);
    const onCrest = place(sim, 'blue', 'C', 21.5, 6.5);
    expect(sightToSoldier(sim, onCrest.x, onCrest.y, a, 0, eyeOf(sim, onCrest)).visible).toBe(true);
    expect(sightToSoldier(sim, onCrest.x, onCrest.y, b, 0, eyeOf(sim, onCrest)).visible).toBe(true);
  });

  it('the batter stops vehicles and passes infantry', () => {
    const m = crestMap();
    expect(m.canStep(17, 6, 18, 6, 'vehicle')).toBe(false);
    expect(m.canStep(17, 6, 18, 6, 'foot')).toBe(true);
  });
});

// §3.6: every sense on both sides routes through the same two functions and
// stanceOf has no side term, so verticality can only make both sides blinder in
// the same places. The mirror is in x with the sides swapped.
//
// NOTE for anyone extending this: sight is NOT reciprocal for unequal eye
// heights (los() samples ground occlusion at each tile's entry edge — see
// tests/stance.test.ts). So the mirror must swap sides and flip the map; it
// must never assert that A-sees-B equals B-sees-A.
describe('AI symmetry: the mirrored battle is the same battle', () => {
  const PLACEMENTS: { side: Side; x: number; y: number; order?: 'ambush' | 'defend' }[] = [
    { side: 'blue', x: 4.5, y: 6.5 },
    { side: 'blue', x: 5.5, y: 3.5 },
    { side: 'red', x: HEDGE_X + 2.5, y: 6.5, order: 'ambush' },
    { side: 'red', x: HEDGE_X + 3.5, y: 8.5, order: 'defend' },
    { side: 'red', x: 34.5, y: 4.5 },
  ];

  const build = (mirror: boolean) => {
    const sim = new Sim(bankMap(mirror), 7);
    // identical call ORDER in both builds, so the shared sequential rng and the
    // soldier ids line up one-for-one
    const men = PLACEMENTS.map((p, i) => {
      const s = place(sim, mirror ? swap(p.side) : p.side, `S${i}`, mirror ? W - p.x : p.x, p.y);
      if (p.order) sim.orderTeam(s.teamId, { kind: p.order, x: s.x, y: s.y });
      return s;
    });
    return { sim, men };
  };

  it('every cross-side sightline has the same answer in the mirror', () => {
    const a = build(false);
    const b = build(true);
    let checked = 0;
    let blocked = 0;
    for (let i = 0; i < PLACEMENTS.length; i++)
      for (let j = 0; j < PLACEMENTS.length; j++) {
        if (PLACEMENTS[i].side === PLACEMENTS[j].side) continue;
        const av = sightToSoldier(a.sim, a.men[i].x, a.men[i].y, a.men[j], 0, eyeOf(a.sim, a.men[i])).visible;
        const bv = sightToSoldier(b.sim, b.men[i].x, b.men[i].y, b.men[j], 0, eyeOf(b.sim, b.men[i])).visible;
        expect(bv, `pair ${i}->${j}`).toBe(av);
        checked++;
        if (!av) blocked++;
      }
    expect(checked).toBeGreaterThan(8);
    expect(blocked, 'nothing was blocked — the map is not exercising relief at all').toBeGreaterThan(0);
  });

  it('stances mirror man for man', () => {
    const a = build(false);
    const b = build(true);
    for (let i = 0; i < PLACEMENTS.length; i++) expect(stanceOf(b.sim, b.men[i]), `man ${i}`).toBe(stanceOf(a.sim, a.men[i]));
  });

  it('the spotting sweep reports the same counts for the mirrored side', () => {
    const a = build(false);
    const b = build(true);
    // dry weapons on both: nobody shoots, nobody dies, so the two runs cannot
    // diverge through the shared rng — this measures the sweep, not the fight
    for (const sim of [a.sim, b.sim])
      for (const s of sim.soldiers) {
        s.ammo = {};
        s.magLeft = 0;
      }
    for (let i = 0; i < SPOT_INTERVAL * 4; i++) {
      a.sim.step();
      b.sim.step();
    }
    expect(a.sim.spotted.blue.size + a.sim.spotted.red.size).toBeGreaterThan(0);
    expect(b.sim.spotted.red.size).toBe(a.sim.spotted.blue.size);
    expect(b.sim.spotted.blue.size).toBe(a.sim.spotted.red.size);
    for (let i = 0; i < PLACEMENTS.length; i++) {
      const seenA = a.sim.soldierVisibleTo(swap(PLACEMENTS[i].side), a.men[i]);
      const seenB = b.sim.soldierVisibleTo(PLACEMENTS[i].side, b.men[i]);
      expect(seenB, `man ${i} spotted-ness`).toBe(seenA);
    }
  });
});
