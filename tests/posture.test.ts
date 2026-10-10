// Postures (jtbug #786): march, forced march, rest, dig in, screen. Each is a
// trade, so each test holds both halves of it.
import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { DETECT_FORCE_M, SCREEN_DETECT_MULT } from '../src/strategic/intel';
import { DIG_BARRAGES, makeTheaterBattle } from '../src/strategic/bridge2';
import { combatMult, defStrength, DIG_DEF_MULT, effStrength, REST_COMBAT_MULT } from '../src/strategic/theater/combat';
import {
  DIG_IN_MIN,
  dugIn,
  FORCED_FATIGUE_MULT,
  FORCED_PACE_MULT,
  forceEtaMinutes,
  orderMove,
  REST_RECOVER_MULT,
  SCREEN_PACE_MULT,
  setPosture,
} from '../src/strategic/theater/step';
import { battleSides, openBattle, stepWar } from '../src/strategic/theater/war';
import { postureEffect } from '../src/ui/theater-hud';
import { lineFront, place } from './lib/line-theater';

const NOON = 12 * 60;
const words = (s: string): number => s.trim().split(/\s+/).length;

describe('forced march', () => {
  it('arrives sooner and arrives more tired', () => {
    const run = (forced: boolean): { min: number; fatigue: number } => {
      const fr = lineFront();
      fr.clockMin = NOON;
      const f = place(fr, 'blue', 0);
      if (forced) setPosture(fr, f.id, 'forced');
      expect(orderMove(fr, f.id, 1).ok).toBe(true);
      const campaign = newCampaign(1, 1);
      let min = 0;
      while (f.path.length > 0) {
        stepWar(fr, campaign);
        min++;
      }
      return { min, fatigue: f.fatigue };
    };
    const plain = run(false);
    const forced = run(true);
    // 2000 m at 50 m/min is 40 minutes, plus what fatigue costs on the way.
    expect(plain.min).toBeGreaterThanOrEqual(40);
    expect(plain.min).toBeLessThanOrEqual(42);
    expect(forced.min).toBeLessThan(plain.min / FORCED_PACE_MULT + 2);
    // Fatigue per minute is x2.5, over fewer minutes.
    expect(forced.fatigue / forced.min).toBeCloseTo((plain.fatigue / plain.min) * FORCED_FATIGUE_MULT, 6);
  });

  it('the ETA shown before the order is the minutes the march takes', () => {
    const fr = lineFront();
    fr.clockMin = NOON;
    const f = place(fr, 'blue', 0);
    setPosture(fr, f.id, 'forced');
    const r = orderMove(fr, f.id, 1);
    const campaign = newCampaign(1, 1);
    let min = 0;
    while (f.path.length > 0) {
      stepWar(fr, campaign);
      min++;
    }
    expect(r.ok && r.etaMin).toBe(min);
    expect(forceEtaMinutes(fr, f, 1)).toBe(0);
  });
});

describe('rest', () => {
  it('recovers twice as fast and fights below strength', () => {
    const fr = lineFront();
    const a = place(fr, 'blue', 0);
    const b = place(fr, 'blue', 1);
    a.fatigue = b.fatigue = 0.8;
    setPosture(fr, b.id, 'rest');
    const campaign = newCampaign(1, 1);
    for (let m = 0; m < 60; m++) stepWar(fr, campaign);
    expect(0.8 - b.fatigue).toBeCloseTo((0.8 - a.fatigue) * REST_RECOVER_MULT, 9);
    a.fatigue = b.fatigue = 0;
    expect(combatMult(a)).toBe(1);
    expect(combatMult(b)).toBe(REST_COMBAT_MULT);
  });

  it('a move order ends it', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    setPosture(fr, f.id, 'rest');
    orderMove(fr, f.id, 1);
    expect(f.posture).toBe('march');
  });

  it('halts a march', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    orderMove(fr, f.id, 1);
    setPosture(fr, f.id, 'rest');
    expect(f.path).toEqual([]);
  });
});

describe('dig in', () => {
  it('takes DIG_IN_MIN standing still, with no recovery meanwhile', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 1);
    f.fatigue = 0.5;
    setPosture(fr, f.id, 'dig');
    const campaign = newCampaign(1, 1);
    for (let m = 0; m < DIG_IN_MIN - 1; m++) stepWar(fr, campaign);
    expect(dugIn(f)).toBe(false);
    expect(f.fatigue).toBe(0.5);
    stepWar(fr, campaign);
    expect(dugIn(f)).toBe(true);
    stepWar(fr, campaign);
    expect(f.fatigue).toBeLessThan(0.5); // the position is done: now it rests
  });

  it('multiplies the defence and not the attack', () => {
    const fr = lineFront();
    const def = place(fr, 'blue', 1);
    def.posture = 'dig';
    def.dugMin = DIG_IN_MIN;
    expect(defStrength(def)).toBe(effStrength(def) * DIG_DEF_MULT);
    const atk = place(fr, 'red', 2);
    atk.pos = { kind: 'edge', edgeId: 1, s: 200, dir: -1 };
    atk.path = [1];
    const b = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 200 });
    const sides = battleSides(fr, b);
    expect(sides.defEff).toBe(100 * DIG_DEF_MULT);
    expect(sides.atkEff).toBe(100);
  });

  it('a move order gives the position up', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    f.posture = 'dig';
    f.dugMin = DIG_IN_MIN;
    orderMove(fr, f.id, 1);
    expect(f.dugMin).toBe(0);
    expect(f.posture).toBe('march');
  });

  it('in a fought battle the dug-in defender has one more barrage', () => {
    const stage = (dug: boolean): number => {
      const fr = lineFront();
      fr.clockMin = NOON;
      const def = place(fr, 'blue', 1);
      if (dug) {
        def.posture = 'dig';
        def.dugMin = DIG_IN_MIN;
      }
      const atk = place(fr, 'red', 2);
      atk.pos = { kind: 'edge', edgeId: 1, s: 200, dir: -1 };
      atk.path = [1];
      const b = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 200 });
      return makeTheaterBattle(newCampaign(1, 1), fr, b).sim.barragesLeft.blue;
    };
    expect(stage(true)).toBe(stage(false) + DIG_BARRAGES);
  });
});

describe('screen', () => {
  it('moves slowly', () => {
    const fr = lineFront();
    fr.clockMin = NOON;
    const f = place(fr, 'blue', 0);
    setPosture(fr, f.id, 'screen');
    const r = orderMove(fr, f.id, 1);
    const eta = r.ok ? r.etaMin : 0;
    expect(eta).toBeGreaterThanOrEqual(Math.ceil(40 / SCREEN_PACE_MULT));
    expect(eta).toBeLessThanOrEqual(Math.ceil(42 / SCREEN_PACE_MULT));
  });

  it('falls back in front of a stronger enemy with no fight and no losses', () => {
    const fr = lineFront();
    const screen = place(fr, 'blue', 1, 60);
    setPosture(fr, screen.id, 'screen');
    const enemy = place(fr, 'red', 2, 100);
    orderMove(fr, enemy.id, 1);
    const campaign = newCampaign(1, 1);
    for (let m = 0; m < 60 && screen.pos.kind === 'node'; m++) stepWar(fr, campaign);
    expect(fr.battles).toEqual([]);
    expect(screen.strength).toBe(60);
    expect(screen.pos).toMatchObject({ kind: 'edge', edgeId: 0 });
    expect(enemy.path.length).toBeGreaterThan(0); // the enemy's march goes on
  });

  it('stands and fights a weaker enemy', () => {
    const fr = lineFront();
    const screen = place(fr, 'blue', 1, 100);
    setPosture(fr, screen.id, 'screen');
    const enemy = place(fr, 'red', 2, 60);
    orderMove(fr, enemy.id, 1);
    const campaign = newCampaign(1, 1);
    for (let m = 0; m < 60 && fr.battles.length === 0; m++) stepWar(fr, campaign);
    expect(fr.battles.length).toBe(1);
  });

  it('sees twice as far under fog', () => {
    const sees = (posture: 'march' | 'screen'): boolean => {
      const fr = lineFront();
      fr.clockMin = 14; // the sweep runs on the quarter hour
      fr.controlByNode = [null, null, null, null];
      const f = place(fr, 'blue', 0);
      f.posture = posture;
      const far = place(fr, 'red', 2); // 4000 m away
      stepWar(fr, newCampaign(1, 1), { recon: 'contacts' });
      return (fr.intel?.blue ?? []).some((c) => c.forceId === far.id);
    };
    expect(4000).toBeGreaterThan(DETECT_FORCE_M);
    expect(4000).toBeLessThanOrEqual(DETECT_FORCE_M * SCREEN_DETECT_MULT);
    expect(sees('march')).toBe(false);
    expect(sees('screen')).toBe(true);
  });
});

describe('the force card line', () => {
  it('states each effect in five words or fewer, numbers from the constants', () => {
    for (const fog of [false, true]) {
      for (const p of ['march', 'forced', 'rest', 'dig', 'screen'] as const) {
        expect(words(postureEffect(p, fog)), `${p}: ${postureEffect(p, fog)}`).toBeLessThanOrEqual(5);
      }
    }
    expect(postureEffect('forced', false)).toBe(`+${Math.round((FORCED_PACE_MULT - 1) * 100)}% pace, ${FORCED_FATIGUE_MULT}× fatigue.`);
    expect(postureEffect('rest', false)).toContain(`${REST_RECOVER_MULT}×`);
    expect(postureEffect('dig', false)).toContain(`×${DIG_DEF_MULT}`);
    expect(postureEffect('screen', true)).toContain(`${(DETECT_FORCE_M * SCREEN_DETECT_MULT) / 1000} km`);
    expect(postureEffect('dig', false, { posture: 'dig', dugMin: DIG_IN_MIN })).toBe(`Dug in: defence ×${DIG_DEF_MULT}.`);
    expect(words(postureEffect('dig', false, { posture: 'dig', dugMin: 30 }))).toBeLessThanOrEqual(5);
  });
});
