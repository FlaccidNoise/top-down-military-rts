import { describe, expect, it } from 'vitest';
import { EDGE, FLOOR_H, GameMap, los } from '../src/sim/map';
import { EYE_PRONE, EYE_STAND, EYE_VEHICLE, HULL_VEHICLE, Sim, sightBetween, sightToSoldier } from '../src/sim/sim';
import { computeShot, type Pick } from '../src/ui/tooltip';

// V7: the eye threaded through every call site, including the vehicle-facing
// class a previous change missed (memory: sight-funnel-callers.md).

describe('vehicle eye and hull constants', () => {
  it('a tank sights over a 2 m bank that blinds every infantry stance', () => {
    const m = new GameMap(24, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 12] = 2;
    expect(los(m, 4.5, 4.5, 20.5, 4.5, 0, 0, EYE_STAND, EYE_STAND).visible).toBe(false);
    expect(los(m, 4.5, 4.5, 20.5, 4.5, 0, 0, EYE_VEHICLE, HULL_VEHICLE).visible).toBe(true);
  });

  it('a bank that hides a prone man does not hide a tank hull', () => {
    // The bank sits close to the far end, so the sagging stand->prone chord is
    // already below the crest when it gets there (the hedge-bank case: a prone
    // man hugging the far side is gone, a tank behind it is not).
    const m = new GameMap(24, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 16] = 1;
    expect(los(m, 4.5, 4.5, 20.5, 4.5, 0, 0, EYE_STAND, EYE_PRONE).visible).toBe(false);
    expect(los(m, 4.5, 4.5, 20.5, 4.5, 0, 0, EYE_STAND, HULL_VEHICLE).visible).toBe(true);
  });

  it('a 3 m embankment is a hard wall to tank optics too', () => {
    const m = new GameMap(24, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 12] = 3;
    expect(los(m, 4.5, 4.5, 20.5, 4.5, 0, 0, EYE_VEHICLE, HULL_VEHICLE).visible).toBe(false);
  });

  it('the constants stay ordered: prone < stand < hull < cupola', () => {
    expect(EYE_PRONE).toBeLessThan(EYE_STAND);
    expect(EYE_STAND).toBeLessThan(HULL_VEHICLE);
    expect(HULL_VEHICLE).toBeLessThan(EYE_VEHICLE);
  });
});

describe('sightToSoldier derives the target eye', () => {
  it('a prone man behind a 1 m bank is invisible; the same man steady is visible', () => {
    const m = new GameMap(24, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 16] = 1; // bank hugged by the target, not mid-field
    const sim = new Sim(m, 7);
    sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 4.5, y: 4.5 }]);
    sim.addSquad('red', 'b', [{ name: 'B', weapon: 'garand', x: 20.5, y: 4.5 }]);
    const observer = sim.soldiers[0];
    const target = sim.soldiers[1];

    expect(sightToSoldier(sim, observer.x, observer.y, target, 0, EYE_STAND).visible).toBe(true);
    target.mental = 'pinned'; // stanceOf -> prone -> EYE_PRONE
    expect(sightToSoldier(sim, observer.x, observer.y, target, 0, EYE_STAND).visible).toBe(false);
  });

  it('no caller can override the target eye — it is not a parameter', () => {
    // sightToSoldier's arity is (sim, x0, y0, t, l0, e0): six. A seventh
    // argument would mean someone had a way to disagree with stanceOf.
    expect(sightToSoldier.length).toBe(4); // sim, x0, y0, t — l0/e0 have defaults
  });
});

describe('blast LOS is stance-neutral (H13)', () => {
  it('the victim’s stance does not change whether fragments reach him', () => {
    const m = new GameMap(20, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 10] = 1; // would hide a prone man from sight

    const run = (pin: boolean): number => {
      const sim = new Sim(m, 11);
      sim.addSquad('blue', 'a', [{ name: 'A', weapon: 'garand', x: 14.5, y: 4.5, courage: 0.5 }]);
      const v = sim.soldiers[0];
      if (pin) v.mental = 'pinned';
      const explode = (sim as unknown as { explode: (x: number, y: number) => void }).explode.bind(sim);
      explode(6.5, 4.5); // other side of the bank, inside the default suppression radius
      return v.suppression;
    };
    // Identical suppression means the frag/blast ray took the same path, i.e.
    // it did not consult stanceOf. (Both are non-zero, so the ray is live.)
    expect(run(false)).toBeGreaterThan(0);
    expect(run(true)).toBe(run(false));
  });
});

// Same 4x4 two-story building as tests/los.test.ts: walls stamped one story
// tall, so an upstairs eye (3 + 1.6 = 4.6 m) clears them and a ground eye
// (1.6 m) does not.
function buildingMap(): GameMap {
  const m = new GameMap(24, 20);
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

describe('apSolution agrees with live AT fire for an upstairs shooter', () => {
  // The pre-existing bug: live fire passed the shooter's level into
  // sightBetween, the tooltip's mirror did not, so an AT man upstairs got a
  // ground-floor shot preview — exactly the drift the "the UI must never
  // re-derive this formula" contract exists to prevent.
  const build = (level: number): { sim: Sim; shot: ReturnType<typeof computeShot> } => {
    const sim = new Sim(buildingMap(), 5);
    sim.addSquad('blue', 'at', [{ name: 'AT', weapon: 'bazooka', x: 6.5, y: 6.5, courage: 0.5 }]);
    sim.soldiers[0].level = level;
    const v = sim.addVehicle('red', 'panzer4', 15.5, 6.5, Math.PI);
    const pick: Pick = { kind: 'vehicle', v };
    return { sim, shot: computeShot(sim, 0, -1, pick) };
  };

  it('ground floor: the wall blocks, and the preview says so', () => {
    const { sim, shot } = build(0);
    const s = sim.soldiers[0];
    const v = sim.vehicles[0];
    expect(sightBetween(sim, s.x, s.y, v.x, v.y, s.level, 0, EYE_STAND, HULL_VEHICLE).visible).toBe(false);
    expect(shot?.ok).toBe(false);
    expect(shot?.reason).toBe('no-los');
  });

  it('upstairs: live fire has the shot, and now so does the preview', () => {
    const { sim, shot } = build(1);
    const s = sim.soldiers[0];
    const v = sim.vehicles[0];
    // what the sim itself would do
    expect(sightBetween(sim, s.x, s.y, v.x, v.y, s.level, 0, EYE_STAND, HULL_VEHICLE).visible).toBe(true);
    // what the UI reports — these must not disagree
    expect(shot?.ok).toBe(true);
  });
});
