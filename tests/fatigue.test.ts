// Fatigue (S51, §5d): one float per force. March accrues (x1.5 in the
// dark), rest recovers (x2 billeted), combat lands lumps, and the debuffs
// flow through exactly three seams: march pace, staging stamina, and
// combatMult into the coarse score — with the joint 0.4 floor tested on its
// own (two uncapped debuffs on one score is a death spiral).
import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeTheater } from '../src/strategic/theatergen';
import { makeDisposition } from '../src/strategic/theatergen/disposition';
import { addForce, type FrontV2 } from '../src/strategic/theater/force';
import {
  BILLET_RECOVER_MULT,
  FATIGUE_SPEED_SLOPE,
  FATIGUE_STAMINA_SLOPE,
  fatigueMinute,
  MARCH_FATIGUE_MIN,
  NIGHT_MARCH_FATIGUE_MULT,
  orderMove,
  paceMult,
  REST_RECOVER_MIN,
} from '../src/strategic/theater/step';
import { COARSE_BATTLE_FATIGUE, FOUGHT_BATTLE_FATIGUE, openBattle, resolveBattleV2 } from '../src/strategic/theater/war';
import { combatMult, COMBAT_MULT_FLOOR, FATIGUE_COMBAT_SLOPE } from '../src/strategic/theater/combat';
import { SUPPLY_COMBAT_MULT } from '../src/strategic/theater/supply';
import { applyTheaterOutcome, makeTheaterBattle } from '../src/strategic/bridge2';
import { lineFront, place } from './lib/line-theater';

const NOON = 840; // CANON_CLOCK_MIN — full daylight
const MIDNIGHT = 0;

describe('accrual and recovery', () => {
  it('a marching minute costs 1/1080; the same minute in the dark costs 1.5x', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    orderMove(fr, f.id, 1);
    fatigueMinute(fr, f, NOON);
    expect(f.fatigue).toBeCloseTo(1 / MARCH_FATIGUE_MIN, 9);
    fatigueMinute(fr, f, MIDNIGHT);
    expect(f.fatigue).toBeCloseTo((1 + NIGHT_MARCH_FATIGUE_MULT) / MARCH_FATIGUE_MIN, 9);
  });

  it('resting recovers 1/600; a friendly in-supply settlement billets at 2x; enemy or cut ground does not', () => {
    const fr = lineFront();
    fr.theater.nodes[1].kind = 'village';
    const f = place(fr, 'blue', 1);
    f.fatigue = 0.5;
    fatigueMinute(fr, f, NOON);
    expect(f.fatigue).toBeCloseTo(0.5 - BILLET_RECOVER_MULT / REST_RECOVER_MIN, 9);
    // Cut off: the billet is gone, plain rest remains.
    f.fatigue = 0.5;
    f.untracedMin = 720;
    fatigueMinute(fr, f, NOON);
    expect(f.fatigue).toBeCloseTo(0.5 - 1 / REST_RECOVER_MIN, 9);
    // A crossroads is a field, not a billet.
    const g = place(fr, 'blue', 0);
    g.fatigue = 0.5;
    fatigueMinute(fr, g, NOON);
    expect(g.fatigue).toBeCloseTo(0.5 - 1 / REST_RECOVER_MIN, 9);
  });

  it('an engaged force neither accrues nor recovers — combat fatigue is a lump at resolution', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 1);
    f.fatigue = 0.5;
    f.engagedIn = 0;
    fatigueMinute(fr, f, NOON);
    expect(f.fatigue).toBe(0.5);
  });
});

describe('combat lumps', () => {
  it('a coarse battle charges every participant +0.15', () => {
    const fr = lineFront();
    const campaign = newCampaign(1, 2);
    const atk = place(fr, 'blue', 2);
    const def = place(fr, 'red', 2);
    const battle = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 0 });
    resolveBattleV2(fr, campaign, battle);
    expect(atk.fatigue).toBeCloseTo(COARSE_BATTLE_FATIGUE, 9);
    expect(def.fatigue).toBeCloseTo(COARSE_BATTLE_FATIGUE, 9);
  });
});

describe('the three effect seams', () => {
  it('pace: a spent force marches at 65%; the ramp multiplies only under nightTempo', () => {
    expect(paceMult(0, NOON, {})).toBe(1);
    expect(paceMult(1, NOON, {})).toBeCloseTo(1 - FATIGUE_SPEED_SLOPE, 9);
    expect(paceMult(0, MIDNIGHT, {})).toBe(1); // toggle off: darkness costs nothing
    expect(paceMult(0, MIDNIGHT, { nightTempo: true })).toBeCloseTo(0.7, 9);
    expect(paceMult(0, NOON, { nightTempo: true })).toBe(1); // full daylight: ramp is 1
  });

  it('combatMult: fatigue slope, and the JOINT 0.4 floor under supply x fatigue', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    f.fatigue = 1;
    expect(combatMult(f)).toBeCloseTo(1 - FATIGUE_COMBAT_SLOPE, 9);
    f.untracedMin = 720; // out: 0.5 x 0.7 = 0.35 -> floored
    expect(SUPPLY_COMBAT_MULT.out * (1 - FATIGUE_COMBAT_SLOPE)).toBeLessThan(COMBAT_MULT_FLOOR);
    expect(combatMult(f)).toBe(COMBAT_MULT_FLOOR);
  });

  it('staging: a worn force fields men at stamina <= 1 - 0.5 x fatigue; a fought battle adds +0.25', () => {
    const seed = 9;
    const { theater, initialControlByNode } = makeTheater(seed, DEFAULT_PRESET.theater);
    const campaign = newCampaign(seed, DEFAULT_PRESET.campaign.blueCompanies);
    const spec = presetSpec(DEFAULT_PRESET, seed);
    const d = makeDisposition(theater, DEFAULT_PRESET.campaign, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
    const front: FrontV2 = {
      theater, clockMin: 840, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
      controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
    };
    for (const f of d.forces) addForce(front, f);
    const blue = front.forces.find((f) => f.side === 'blue')!;
    const g = front.forces.find((f) => f.role === 'garrison')!;
    blue.fatigue = 0.8;
    blue.pos = g.pos;
    const battle = openBattle(front, { attackerId: blue.id, defenderId: g.id, site: g.pos, gapM: 0 });
    const tb = makeTheaterBattle(campaign, front, battle);
    const cap = 1 - FATIGUE_STAMINA_SLOPE * 0.8;
    for (const s of tb.sim.soldiers) {
      if (s.side === 'blue') expect(s.stamina).toBeLessThanOrEqual(cap + 1e-9);
    }
    // Red garrison fresh: at least one red soldier above the blue cap.
    expect(tb.sim.soldiers.some((s) => s.side === 'red' && s.stamina > cap)).toBe(true);

    tb.sim.winner = 'blue';
    applyTheaterOutcome(campaign, front, battle, tb.battleClass, tb.sim);
    expect(blue.fatigue).toBe(Math.min(1, 0.8 + FOUGHT_BATTLE_FATIGUE)); // capped at 1
    expect(g.fatigue).toBeCloseTo(FOUGHT_BATTLE_FATIGUE, 9);
  });
});
