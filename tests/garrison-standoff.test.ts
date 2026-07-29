import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { makeStrategicBattle, newFront } from '../src/strategic/bridge';
import { DEPLOY_ATK_DEPTH } from '../src/strategic/deploy';
import { makeDefaultSector } from '../src/strategic/sector';
import type { MapKind } from '../src/sim/mapgen';

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
