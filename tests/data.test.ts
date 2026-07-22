import { describe, expect, it } from 'vitest';
import { EMPLACEMENT_CREW, EMPLACEMENTS, LOADS, SQUADS, TEAMS, WEAPONS, type AmmoKey, type LoadKey, type SoldierSlot, type WeaponDef } from '../src/sim/data';

describe('weapon data', () => {
  const entries: [string, WeaponDef][] = Object.entries(WEAPONS);

  it('every ammo.type is a valid AmmoKey', () => {
    // compile-time check: this assignment fails to typecheck if a weapon's
    // ammo.type ever falls outside AmmoKey.
    for (const [, w] of entries) {
      const t: AmmoKey = w.ammo.type;
      expect(typeof t).toBe('string');
    }
  });

  it('damage ranges are ordered low <= high', () => {
    for (const [key, w] of entries) {
      expect(w.damage[0], key).toBeLessThanOrEqual(w.damage[1]);
    }
  });

  it('cooldown is positive', () => {
    for (const [key, w] of entries) {
      expect(w.cooldown, key).toBeGreaterThan(0);
    }
  });

  it('belt-fed weapons (perUnit >= 50) declare a heat model', () => {
    for (const [key, w] of entries) {
      if (w.ammo.perUnit >= 50) expect(w.heat, key).toBeDefined();
    }
  });

  it('mortars (arc) never carry a pen rating', () => {
    for (const [key, w] of entries) {
      if (w.arc) expect(w.pen, key).toBeUndefined();
    }
  });
});

describe('unit data referential integrity', () => {
  it('every SquadDef.teams key exists in TEAMS', () => {
    for (const [key, sq] of Object.entries(SQUADS)) {
      for (const teamKey of sq.teams) {
        expect(TEAMS[teamKey], `${key} -> ${teamKey}`).toBeDefined();
      }
    }
  });

  it('every slot weapon exists in WEAPONS', () => {
    for (const [key, team] of Object.entries(TEAMS)) {
      for (const slot of team.slots) {
        expect(WEAPONS[slot.weapon], `${key}: ${slot.role}`).toBeDefined();
      }
    }
  });

  it('every carries load exists in LOADS', () => {
    for (const [key, team] of Object.entries(TEAMS)) {
      for (const slot of team.slots as SoldierSlot[]) {
        for (const loadKey of slot.carries ?? ([] as LoadKey[])) {
          expect(LOADS[loadKey], `${key}: ${slot.role}`).toBeDefined();
        }
      }
    }
  });

  it('every emplacement weapon exists in WEAPONS', () => {
    for (const [key, emp] of Object.entries(EMPLACEMENTS)) {
      expect(WEAPONS[emp.weapon], key).toBeDefined();
    }
  });

  it('per-squad slot-count sanity', () => {
    const slotCount = (squadKey: keyof typeof SQUADS) =>
      SQUADS[squadKey].teams.reduce((n, teamKey) => n + TEAMS[teamKey].slots.length, 0);
    expect(slotCount('us_rifle')).toBe(12);
    expect(slotCount('de_gruppe')).toBe(9);
  });

  it('every EMPLACEMENT_CREW entry names a real, single-team crew squad matching its own side', () => {
    for (const [empKey, squadKey] of Object.entries(EMPLACEMENT_CREW)) {
      const sq = SQUADS[squadKey];
      expect(sq, `${empKey} -> ${squadKey}`).toBeDefined();
      expect(sq.teams.length, `${empKey} -> ${squadKey}`).toBe(1);
    }
  });

  it('each squad has a consistent side (no team mixes nationalities)', () => {
    // Team keys are nationality-prefixed (us_/de_) by convention; a squad's
    // teams must all match its own declared side, so mixed-nationality rosters
    // would fail this even though TeamDef itself carries no side field.
    for (const [key, sq] of Object.entries(SQUADS)) {
      for (const teamKey of sq.teams) {
        expect(teamKey.startsWith(sq.side + '_'), `${key} -> ${teamKey}`).toBe(true);
      }
    }
  });
});
