import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { makeStrategicBattle, newFront } from '../src/strategic/bridge';
import { DEPLOY_ATK_DEPTH } from '../src/strategic/deploy';
import { makeDefaultSector } from '../src/strategic/sector';
import type { MapKind } from '../src/sim/mapgen';
import { eyeOf, sightToSoldier } from '../src/sim/sim';

// The garrison stages behind the attacker's deployment zone — the zone the HUD
// draws and deployPlace enforces (main.ts deployZone). An outpost objective can
// sit at x=14-30, and every building and woods stand within GARRISON_RADIUS of
// it used to be legal garrison ground: these four cells staged a Grenadier
// Gruppe at x=8-26 while the attacking company fields at x=6-12, so the player
// unpaused with Germans standing inside their own start line.
//
// Each cell is one live staging (makeStrategicBattle, the path both the
// campaign and the theater battles use), so the assertion is on the men, not
// on the anchor arithmetic that places them.
const CELLS: [MapKind, number][] = [
  ['open', 7], // worst measured: red at x=8.0 against blue's x=11.9
  ['open', 1],
  ['woods', 7], // the one that also dug an emplacement in the strip
  ['bourg', 1],
];

describe('garrison standoff', () => {
  it.each(CELLS)('%s seed %i: no defender stages inside the attacker deployment zone', (kind, seed) => {
    const c = newCampaign(seed);
    const front = newFront(c, makeDefaultSector());
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const garrison = front.chits.find((ch) => ch.name === 'Garnison St-Aubin')!;
    front.sector.cells[garrison.cell].terrain = kind;
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: garrison.id, cell: garrison.cell }, seed);

    const red = sim.soldiers.filter((s) => s.side === 'red');
    expect(red.length).toBeGreaterThan(0);
    expect(red.filter((s) => s.x <= DEPLOY_ATK_DEPTH)).toEqual([]);
    expect(sim.emplacements.filter((e) => e.side === 'red' && e.x <= DEPLOY_ATK_DEPTH)).toEqual([]);
  });
});

// #789. Out of the strip is not out of sight of it. 32 of 60 staged battles
// used to open with a defender in plain view inside 60 m of the start line,
// and the player's first second was a firefight he had not started.
describe('start line clear of the garrison (#789)', () => {
  const stage = (kind: MapKind, seed: number, startLineClear?: number) => {
    const c = newCampaign(seed);
    const front = newFront(c, makeDefaultSector());
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const garrison = front.chits.find((ch) => ch.name === 'Garnison St-Aubin')!;
    front.sector.cells[garrison.cell].terrain = kind;
    front.clockMin = 840;
    return makeStrategicBattle(c, front, { attackerId: able.id, defenderId: garrison.id, cell: garrison.cell }, seed, startLineClear === undefined ? {} : { startLineClear }).sim;
  };
  // Nearest defender who can see one of the attacker's men as staged.
  const nearestInSight = (sim: ReturnType<typeof stage>): number => {
    let near = Infinity;
    for (const r of sim.soldiers) {
      if (r.side !== 'red') continue;
      for (const b of sim.soldiers) {
        if (b.side !== 'blue' || b.inVehicle >= 0) continue;
        const d = Math.hypot(r.x - b.x, r.y - b.y);
        if (d < near && sightToSoldier(sim, r.x, r.y, b, r.level, eyeOf(sim, r)).visible) near = d;
      }
    }
    return near;
  };

  // The worst measured: a Gruppe and the PaK crew 25 to 39 m from the line.
  const HOT: [MapKind, number][] = [
    ['road', 10],
    ['bridge', 10],
    ['bourg', 10],
    ['bourg', 1],
    ['road', 6],
    ['bridge', 4],
  ];

  it.each(HOT)('%s seed %i: nobody in the garrison sees the start line inside 60 m', (kind, seed) => {
    expect(nearestInSight(stage(kind, seed, 0))).toBeLessThan(45); // as it was: the case is real
    const sim = stage(kind, seed);
    expect(sim.soldiers.filter((s) => s.side === 'red').length).toBeGreaterThan(0);
    expect(nearestInSight(sim)).toBeGreaterThan(60);
  });

  it.each(HOT)('%s seed %i: the rule moves men and draws nothing', (kind, seed) => {
    const on = stage(kind, seed);
    const off = stage(kind, seed, 0);
    const drawn = (sim: ReturnType<typeof stage>) => sim.soldiers.map((s) => [s.side, s.name, s.weapon, s.role, s.courage, s.xp, JSON.stringify(s.bonds)]);
    expect(drawn(on)).toEqual(drawn(off)); // every draw staging made, in the same order
    expect(on.rng.next()).toBe(off.rng.next()); // and the stream the battle inherits is at the same place
    const moved = on.soldiers.filter((s, i) => s.side === 'red' && (s.x !== off.soldiers[i].x || s.y !== off.soldiers[i].y)).length;
    expect(moved).toBeGreaterThan(0);
    // the attacker is where he was
    expect(on.soldiers.filter((s) => s.side === 'blue').map((s) => [s.x, s.y])).toEqual(off.soldiers.filter((s) => s.side === 'blue').map((s) => [s.x, s.y]));
  });
});
