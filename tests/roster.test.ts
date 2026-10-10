import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { Sim, type Soldier } from '../src/sim/sim';
import { LOW_AMMO_SHARE, manAmmo, manStatus, reserveAmmo, shortNames, squadAmmoLow } from '../src/ui/roster';

function squad(): Soldier[] {
  const sim = new Sim(new GameMap(40, 40), 3);
  sim.addSquadFromDef('blue', 'us_rifle', 10, 10);
  return sim.soldiers;
}

describe('shortNames', () => {
  it('drops the company every squad shares, so nine rows stop reading "Abl…"', () => {
    expect(shortNames(['Able 1st', 'Able 2nd', 'Able Mortar 1', 'Able Scouts'])).toEqual(['1st', '2nd', 'Mortar 1', 'Scouts']);
  });

  it('keeps full names when the squads are from different companies', () => {
    const mixed = ['Able 1st', 'Baker 1st'];
    expect(shortNames(mixed)).toEqual(mixed);
  });

  it('keeps a name that would be left empty', () => {
    const names = ['Able', 'Able 1st'];
    expect(shortNames(names)).toEqual(names);
  });

  it('has nothing to drop from one squad or none', () => {
    expect(shortNames([])).toEqual([]);
    expect(shortNames(['Able 1st'])).toEqual(['Able 1st']);
  });
});

describe('ammunition is shown only when it is a problem', () => {
  it('a squad with what it carried in is not low', () => {
    expect(squadAmmoLow(squad())).toBe(false);
  });

  it('a squad is low under a quarter of what it carried in, counting the living', () => {
    const men = squad();
    const start = men.reduce((a, m) => a + m.ammoStart, 0);
    for (const m of men) for (const k of Object.keys(m.ammo) as (keyof Soldier['ammo'])[]) m.ammo[k] = 0;
    const key = Object.keys(men[0].ammo)[0] as keyof Soldier['ammo'];
    men[0].ammo[key] = Math.ceil(start * LOW_AMMO_SHARE);
    expect(squadAmmoLow(men)).toBe(false);
    men[0].ammo[key] = Math.ceil(start * LOW_AMMO_SHARE) - 1;
    expect(squadAmmoLow(men)).toBe(true);
  });

  it('says nothing for a squad with no men left to count', () => {
    const men = squad();
    for (const m of men) m.alive = false;
    expect(squadAmmoLow(men)).toBe(false);
  });

  it('a man gets a word only when he has no reload left', () => {
    const [m] = squad();
    expect(reserveAmmo(m)).toBeGreaterThan(0);
    expect(manAmmo(m)).toBe('');
    for (const k of Object.keys(m.ammo) as (keyof Soldier['ammo'])[]) m.ammo[k] = 0;
    expect(manAmmo(m)).toBe('LAST MAG');
    m.magLeft = 0;
    expect(manAmmo(m)).toBe('NO AMMO');
  });
});

describe('manStatus', () => {
  it('a steady man needs no word; every other state gets its own', () => {
    const [m] = squad();
    expect(manStatus(m)).toBe('');
    m.mental = 'shaken';
    expect(manStatus(m)).toBe('SHAKEN');
    m.mental = 'pinned';
    expect(manStatus(m)).toBe('PINNED');
    m.mental = 'broken';
    expect(manStatus(m)).toBe('BROKEN');
    m.downed = true;
    expect(manStatus(m)).toBe('DOWN');
    m.alive = false;
    expect(manStatus(m)).toBe('KIA');
  });
});
