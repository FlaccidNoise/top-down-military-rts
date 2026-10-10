// Night ops tempo (S52, §5e): the march ramp 0.7 + 0.3·min(1, light/0.25)
// ships ONLY with the light-integrated ETA (the mirror must survive a
// time-varying speed), plus the AI dawn doctrine — assaults land at first
// light. resolveCoarse's nightMult stays 1.0 (OQ7): the VALUE lands later,
// from warsweep evidence, as its own change.
import { describe, expect, it } from 'vitest';
import { lightAt } from '../src/sim/solar';
import { forceEtaMinutes, nightRamp, orderMove, stepMovement } from '../src/strategic/theater/step';
import { Commander2, RED_V2 } from '../src/strategic/planner';
import { ContactIntel, updateIntelMinute, INTEL_EVAL_MIN } from '../src/strategic/intel';
import { makeWarGoals } from '../src/strategic/goals';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { lineFront, place } from './lib/line-theater';

// The first minute of the day where light crosses the 0.25 floor upward.
const civilDawn = (): number => {
  for (let m = 1; m < 1440; m++) {
    if (lightAt(m - 1) < 0.25 && lightAt(m) >= 0.25) return m;
  }
  throw new Error('no dawn crossing found');
};
const civilDusk = (): number => {
  for (let m = 721; m < 1440; m++) {
    if (lightAt(m - 1) >= 0.25 && lightAt(m) < 0.25) return m;
  }
  throw new Error('no dusk crossing found');
};

describe('the ramp and the integrated ETA', () => {
  it('nightRamp: 0.7 in full darkness, 1.0 from the 0.25 floor up', () => {
    expect(nightRamp(civilDawn() - 120)).toBeCloseTo(0.7 + 0.3 * (lightAt(civilDawn() - 120) / 0.25), 9);
    expect(lightAt(0)).toBeLessThan(0.05); // midnight is properly dark
    expect(nightRamp(0)).toBeLessThan(0.76);
    expect(nightRamp(840)).toBe(1); // canonical hour: full daylight
  });

  it('a march across dusk takes longer under nightTempo and the ETA predicts it to the minute', () => {
    const dusk = civilDusk();
    const mk = (nightTempo: boolean) => {
      const fr = lineFront();
      fr.clockMin = dusk - 30; // half the march in light, half in the dark
      const f = place(fr, 'blue', 0);
      const order = orderMove(fr, f.id, 2, { nightTempo });
      if (!order.ok) throw new Error('route must exist');
      return { fr, f, eta: order.etaMin };
    };
    const day = mk(false);
    const night = mk(true);
    expect(night.eta).toBeGreaterThan(day.eta); // darkness costs real minutes
    // Mirror under the ramp: step with the SAME kernel opts (stepWar order:
    // clock first, then movement) and arrive exactly on the predicted minute.
    let steps = 0;
    while (!(night.f.pos.kind === 'node' && night.f.pos.nodeId === 2 && night.f.path.length === 0) && steps < 2000) {
      night.fr.clockMin++;
      stepMovement(night.fr, { nightTempo: true });
      steps++;
    }
    expect(steps).toBe(night.eta);
  });
});

describe('dawn doctrine (the AI attacks at first light)', () => {
  const stage = (clockMin: number) => {
    const fr = lineFront();
    fr.clockMin = clockMin;
    fr.controlByNode = ['blue', 'blue', 'blue', 'red']; // objective 2 is blue-held — red wants it back
    const defender = place(fr, 'blue', 2);
    const red = place(fr, 'red', 3, 150);
    // Both sides know each other (contacts at detection range) so the
    // attack arm — not the advance arm — is what the eval exercises.
    const sweepAt = Math.ceil(clockMin / INTEL_EVAL_MIN) * INTEL_EVAL_MIN;
    const save = fr.clockMin;
    fr.clockMin = sweepAt;
    updateIntelMinute(fr);
    fr.clockMin = save;
    const goals = makeWarGoals(fr.theater, DEFAULT_PRESET.campaign);
    const cmd = new Commander2('red', RED_V2, goals, 14, { nightTempo: true });
    const report = cmd.evaluate(fr, new ContactIntel(fr, 'red'))!;
    return { report, defender, red };
  };

  it('holds an assault whose arrival would fall in darkness, releases one that lands after dawn', () => {
    const dawn = civilDawn();
    // Rough eta for the 2000 m hop under the night ramp: bounded by
    // 40 (full light) and 40/0.7 + drag (full dark) — use 45 as the probe.
    const held = stage(dawn - 240); // arrival deep in the dark
    expect(held.report.orders.filter((o) => o.why === 'attack')).toHaveLength(0);

    const released = stage(dawn - 15); // arrival minutes after first light
    const attack = released.report.orders.find((o) => o.why === 'attack');
    expect(attack).toBeDefined();
    expect(attack!.dest).toBe(2);
  });

  it('with nightTempo off the same night assault goes in immediately', () => {
    const dawn = civilDawn();
    const fr = lineFront();
    fr.clockMin = dawn - 240;
    fr.controlByNode = ['blue', 'blue', 'blue', 'red'];
    place(fr, 'blue', 2);
    place(fr, 'red', 3, 150);
    updateIntelMinute(fr); // may or may not be on cadence; force the map
    fr.intel = {
      blue: [],
      red: [{ forceId: fr.forces[0].id, pos: { kind: 'node', nodeId: 2 }, strength: 100, seenMin: fr.clockMin, moving: false, dug: false }],
    };
    const goals = makeWarGoals(fr.theater, DEFAULT_PRESET.campaign);
    const cmd = new Commander2('red', RED_V2, goals, 14, {});
    const report = cmd.evaluate(fr, new ContactIntel(fr, 'red'))!;
    expect(report.orders.some((o) => o.why === 'attack' && o.dest === 2)).toBe(true);
  });
});
