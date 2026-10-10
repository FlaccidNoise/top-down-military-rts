// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANUAL, manualText } from '../src/ui/manual-data';
import { MIN_WAR_DAYS } from '../src/campaign/spec';
import { PRESETS } from '../src/campaign/presets';
import { CONTACT_TTL, DT, hideFloorOf, SPOT_INTERVAL, SPOT_RANGE } from '../src/sim/sim';
import { GARRISON_RADIUS, TRIVIAL_RATIO } from '../src/strategic/bridge';
import { DEPLOY_ATK_DEPTH, DEPLOY_DEF_DEFAULT, DEPLOY_DEF_LINE } from '../src/strategic/deploy';
import { REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY } from '../src/strategic/front';
import { DETECT_FORCE_M, DETECT_NODE_M, STRAT_CONTACT_TTL } from '../src/strategic/intel';
import { NIGHT_MARCH_FATIGUE_MULT } from '../src/strategic/theater/step';
import { SUPPLY_AMMO_MULT, SUPPLY_LOW_MIN, SUPPLY_OUT_MIN } from '../src/strategic/theater/supply';
import { MOVE_MPM, REGION_PACE_MULT } from '../src/strategic/theater';
import { BRIDGE_DWELL_MIN, CONTACT_M, FORD_CROSS_MIN } from '../src/strategic/theater/force';
import { battleDuration, INFILTRATE_MIN, RETREAT_SETBACK_M } from '../src/strategic/theater/war';
import { BREAK_FRACTION } from '../src/ui/battle-goal';
import { ORDER_AFFORDANCE } from '../src/ui/order-data';
import { HOLD_MS, TAP_SLOP, TWO_TAP_MS } from '../src/ui/touch';

// This file imports the SAME modules manual-data imports. A retune therefore
// moves the constant, the prose and the expectation together and the suite
// stays green — which is the point. What it proves is that the prose is
// INTERPOLATED, not that it currently reads 300.

const SRC = new URL('../src/ui/manual-data.ts', import.meta.url);
const source = (): string => readFileSync(SRC, 'utf8') as string;

describe('MANUAL — shape', () => {
  it('carries the six chapters in the owner-mandated order, goal first', () => {
    expect(MANUAL.map((c) => c.id)).toEqual(['goal', 'operation', 'theater', 'deployment', 'battle', 'touch']);
  });

  it('has unique ids', () => {
    const ids = MANUAL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no empty chapter, and no entry without a heading and a body', () => {
    for (const c of MANUAL) {
      expect(c.title.length, `${c.id} title`).toBeGreaterThan(0);
      expect(c.entries.length, `${c.id} entries`).toBeGreaterThan(0);
      for (const e of c.entries) {
        expect(e.heading.length, `${c.id}/${e.heading}`).toBeGreaterThan(0);
        expect(e.body.length, `${c.id}/${e.heading}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every order in the shipped vocabulary its own entry, with both key paths', () => {
    const battle = MANUAL.find((c) => c.id === 'battle')!;
    for (const a of Object.values(ORDER_AFFORDANCE)) {
      const entry = battle.entries.find((e) => e.heading === a.name);
      expect(entry, `no entry for order ${a.name}`).toBeTruthy();
      expect(entry!.keys?.desktop.length).toBeGreaterThan(0);
      expect(entry!.keys?.touch.length).toBeGreaterThan(0);
    }
  });

  it('gives the touch chapter a touch key on every entry', () => {
    const touch = MANUAL.find((c) => c.id === 'touch')!;
    for (const e of touch.entries) expect(e.keys?.touch, e.heading).toBeTruthy();
  });
});

describe('MANUAL — the numbers are live', () => {
  const text = manualText();
  const has = (v: string | number, what: string): void => {
    expect(text.includes(String(v)), `${what} (${v}) missing from the manual`).toBe(true);
  };

  it('quotes the strategic constants', () => {
    has(CONTACT_M, 'CONTACT_M');
    has(RETREAT_SETBACK_M, 'RETREAT_SETBACK_M');
    has(INFILTRATE_MIN, 'INFILTRATE_MIN');
    has(FORD_CROSS_MIN, 'FORD_CROSS_MIN');
    has(BRIDGE_DWELL_MIN, 'BRIDGE_DWELL_MIN');
    has(MOVE_MPM.highway, 'MOVE_MPM.highway');
    has(MOVE_MPM.road, 'MOVE_MPM.road');
    has(MOVE_MPM.track, 'MOVE_MPM.track');
    has(REGION_PACE_MULT.forest, 'REGION_PACE_MULT.forest');
  });

  it('quotes the win-and-lose constants', () => {
    expect(text).toContain(`Every ${REINFORCE_CYCLE_DAYS} days`);
    has(REINFORCE_PER_COMPANY, 'REINFORCE_PER_COMPANY');
    expect(text).toContain(`${TRIVIAL_RATIO}:1`);
  });

  it('CALLS battleDuration rather than restating its formula', () => {
    has(battleDuration(100, 100, false), 'a two-company battle');
    has(battleDuration(100, 100, true), 'a forced battle');
    has(battleDuration(10000, 10000, false), 'the battle-length cap');
  });

  it('quotes the deployment zones, including every map kind in the table', () => {
    has(DEPLOY_ATK_DEPTH, 'DEPLOY_ATK_DEPTH');
    has(DEPLOY_DEF_DEFAULT, 'DEPLOY_DEF_DEFAULT');
    for (const [kind, x] of Object.entries(DEPLOY_DEF_LINE)) expect(text).toContain(`${kind} ${x}`);
    has(GARRISON_RADIUS, 'GARRISON_RADIUS');
  });

  it('states how a battle is won from the break-off rule', () => {
    const battle = MANUAL.find((c) => c.id === 'battle')!;
    const entry = battle.entries.find((e) => e.heading === 'How a battle is won');
    expect(entry, 'the battle chapter must say how a battle is won').toBeTruthy();
    expect(entry!.body).toContain(`under ${BREAK_FRACTION * 100}% of the men`);
  });

  it('quotes the battle-layer constants', () => {
    has(SPOT_RANGE, 'SPOT_RANGE');
    has(SPOT_INTERVAL * DT, 'the spotting cadence in seconds');
    has(CONTACT_TTL * DT, 'the ghost lifetime in seconds');
    has(hideFloorOf(1), 'the daylight hide range');
    has(hideFloorOf(0), 'the night hide range');
  });

  it('quotes the realism toggles from their live constants', () => {
    has(SUPPLY_LOW_MIN / 60, 'the low-supply delay in hours');
    has(SUPPLY_OUT_MIN / 60, 'the out-of-supply delay in hours');
    has(`${SUPPLY_AMMO_MULT.out * 100}%`, 'the out-of-supply ammunition share');
    has(DETECT_FORCE_M / 1000, 'the force detection range in km');
    has(DETECT_NODE_M / 1000, 'the node detection range in km');
    has(STRAT_CONTACT_TTL / 60, 'the contact lifetime in hours');
    has(`${NIGHT_MARCH_FATIGUE_MULT}×`, 'the night march fatigue multiplier');
  });

  it('quotes the touch grammar constants', () => {
    has(HOLD_MS, 'HOLD_MS');
    has(TAP_SLOP, 'TAP_SLOP');
    has(TWO_TAP_MS, 'TWO_TAP_MS');
  });

  it('names every preset and the largest theater feasibility floor', () => {
    for (const p of PRESETS) expect(text).toContain(p.name);
    const sizes = Object.keys(MIN_WAR_DAYS).map(Number).sort((a, b) => a - b);
    const biggest = sizes[sizes.length - 1] as keyof typeof MIN_WAR_DAYS;
    expect(text).toContain(`${biggest} km theater asks for at least ${MIN_WAR_DAYS[biggest]} days`);
  });
});

// Removes every ${...} span, balanced-brace aware, so what remains is the
// prose an author typed by hand plus the module's own plumbing.
// LIMITS, deliberate: a '}' inside a string inside an interpolation would end
// the span early, and this cannot tell a number in a comment from a number in
// shipped copy. Both are acceptable — it is a grep ratchet anyone can run by
// hand, not a parser. It fails loudly and is cheap to fix.
function stripInterpolations(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      i--;
      continue;
    }
    out += src[i];
  }
  return out;
}

describe('manual-data source — drift tripwire', () => {
  // The distinctive digit-strings of the tracked constants. A small, common
  // number (1, 2, 10) is deliberately absent: it would fire on the module's
  // own arithmetic and teach the next author to delete the test.
  const BANNED: [RegExp, string][] = [
    [/\b300\b/, 'CONTACT_M'],
    [/\b1500\b/, 'RETREAT_SETBACK_M'],
    [/\b120\b/, 'INFILTRATE_MIN'],
    [/\b45\b/, 'FORD_CROSS_MIN / GARRISON_RADIUS'],
    [/\b15\b/, 'BRIDGE_DWELL_MIN'],
    [/\b66\.7\b/, 'MOVE_MPM.highway'],
    [/\b33\.3\b/, 'MOVE_MPM.track'],
    [/\b50\b/, 'MOVE_MPM.road'],
    [/\b200\b/, 'SPOT_RANGE'],
    [/\b420\b/, 'HOLD_MS'],
    [/\b260\b/, 'TWO_TAP_MS'],
    [/\b32\b/, 'DEPLOY_ATK_DEPTH'],
    [/\b70\b/, 'DEPLOY_DEF_DEFAULT'],
    [/\b12\b/, 'REINFORCE_PER_COMPANY'],
    [/\b185\b/, 'battleDuration(100, 100, false)'],
    [/\b240\b/, 'the battleDuration cap'],
    [/\b5 ?: ?1\b/, 'TRIVIAL_RATIO odds'],
    [/\b25 ?%/, 'BREAK_FRACTION'],
  ];

  it('types no tracked game number by hand — every one arrives through ${...}', () => {
    const bare = stripInterpolations(source());
    for (const [re, name] of BANNED) {
      expect(re.test(bare), `${name}: ${re} appears as a raw literal — import the constant and interpolate it`).toBe(false);
    }
  });

  // The node-env import at the top of this file is the real proof: a module
  // that touched DOM at load would have thrown before any test ran. This
  // guards the next edit. Member access only — the prose says "window" about
  // a time window, and a manual is allowed to use the word.
  it('touches no DOM, so the copy stays testable outside a browser', () => {
    expect(/\b(document|window|localStorage|navigator)\s*\./.test(source())).toBe(false);
    expect(/\bHTML[A-Za-z]*Element\b/.test(source())).toBe(false);
  });
});
