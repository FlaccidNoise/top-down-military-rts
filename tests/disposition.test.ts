import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/sim/rng';
import { COMPANY_NAMES, fitStrength, newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeTheater } from '../src/strategic/theatergen';
import { DispositionError, makeDisposition } from '../src/strategic/theatergen/disposition';
import { makeWarGoals, TheaterGoalsError, warStatus } from '../src/strategic/goals';
import { addForce, MAX_FORCES, type FrontV2 } from '../src/strategic/theater/force';

const CFG = DEFAULT_PRESET.theater;
const CAMP = DEFAULT_PRESET.campaign;

const build = (seed: number, redStrength = CAMP.redStrength, blueCompanies = CAMP.blueCompanies) => {
  const { theater, initialControlByNode } = makeTheater(seed, CFG);
  const campaign = newCampaign(seed, blueCompanies);
  const spec = presetSpec(DEFAULT_PRESET, seed);
  const rng = specStream(spec, SPEC_TAG.DISPOSITION);
  const d = makeDisposition(theater, { ...CAMP, redStrength: redStrength as never, blueCompanies: blueCompanies as never }, campaign, initialControlByNode, rng);
  return { theater, campaign, control: initialControlByNode, d };
};

describe('makeDisposition', () => {
  it('blue: one line force per company on blue entry nodes, roster-backed strengths', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { d, campaign, control, theater } = build(seed);
      const blue = d.forces.filter((f) => f.side === 'blue');
      expect(blue).toHaveLength(CAMP.blueCompanies);
      blue.forEach((f, i) => {
        expect(f.name).toBe(COMPANY_NAMES[i]);
        expect(f.companyIndex).toBe(i);
        expect(f.strength).toBe(fitStrength(campaign, i));
        expect(f.role).toBe('line');
        if (f.pos.kind === 'node') {
          expect(control[f.pos.nodeId]).toBe('blue');
          expect(theater.nodes[f.pos.nodeId].rank).toBeLessThanOrEqual(1);
        }
      });
    }
  });

  it('four companies muster when the knob says four', () => {
    const { d } = build(5, 2, 4);
    expect(d.forces.filter((f) => f.side === 'blue')).toHaveLength(4);
    expect(newCampaign(5, 4).companies.map((c) => c.name)).toEqual(['Able', 'Baker', 'Charlie', 'Dog']);
  });

  it('red: garrisons on red objectives/crossings inside the band, plus mobile groups', () => {
    const { d, control, theater } = build(1);
    const garrisons = d.forces.filter((f) => f.role === 'garrison');
    expect(garrisons.length).toBeGreaterThanOrEqual(2);
    for (const g of garrisons) {
      expect(g.side).toBe('red');
      expect(g.strength).toBeGreaterThanOrEqual(36);
      expect(g.strength).toBeLessThanOrEqual(109);
      if (g.pos.kind === 'node') {
        expect(control[g.pos.nodeId]).toBe('red');
        const n = theater.nodes[g.pos.nodeId];
        expect(theater.objectiveNodes.includes(n.id) || n.crossing !== null).toBe(true);
      }
    }
    const mobile = d.forces.filter((f) => f.side === 'red' && f.role !== 'garrison');
    expect(mobile.length).toBeGreaterThanOrEqual(1); // red can ATTACK
  });

  it('redStrength 0 fields no red at all; establishment records every starting strength', () => {
    const { d } = build(2, 0);
    expect(d.forces.every((f) => f.side === 'blue')).toBe(true);
    d.forces.forEach((f, i) => expect(d.establishment[i]).toBe(f.strength));
  });

  it('the DISPOSITION sub-stream is isolated: red strengths never move the theater', () => {
    const a = build(3, 1);
    const b = build(3, 4);
    expect(a.theater).toEqual(b.theater); // different redStrength, same map
    expect(a.d.forces.filter((f) => f.side === 'red')).not.toEqual(b.d.forces.filter((f) => f.side === 'red'));
  });

  it('caps at MAX_FORCES and every force loads through addForce', () => {
    const { d, theater, control } = build(1);
    expect(d.forces.length).toBeLessThanOrEqual(MAX_FORCES);
    const fr: FrontV2 = {
      theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
      controlByNode: [...control], battles: [], events: [], defileQueues: {},
    };
    for (const f of d.forces) addForce(fr, f);
    expect(fr.forces).toHaveLength(d.forces.length);
  });

  it('named rejects throw: establishment-zero when the roster is empty', () => {
    const { theater, control } = build(1);
    const dead = newCampaign(1);
    for (const s of Object.values(dead.soldiers)) s.status = 'kia';
    const rng = mulberry32(1);
    expect(() => makeDisposition(theater, CAMP, dead, control, rng)).toThrow(DispositionError);
    expect(() => makeDisposition(theater, CAMP, dead, control, rng)).toThrow('establishment-zero');
  });

  it('named rejects throw: no-entry-node when blue holds nothing', () => {
    const { theater, campaign } = build(1);
    const allRed = theater.nodes.map(() => 'red' as const);
    expect(() => makeDisposition(theater, CAMP, campaign, allRed, mulberry32(1))).toThrow('no-entry-node');
  });
});

describe('war goals', () => {
  it('binds the deadline and preset; campaign knobs never reach the theater', () => {
    const { theater } = build(1);
    const goals = makeWarGoals(theater, CAMP);
    expect(goals.deadlineDay).toBe(CAMP.warDays);
    expect(goals.objectiveNodes).toEqual(theater.objectiveNodes);
    expect(() => makeWarGoals({ ...theater, objectiveNodes: [] }, CAMP)).toThrow(TheaterGoalsError);
  });

  it('warStatus: blue-first tie on the deadline day, red by deadline or annihilation', () => {
    const { theater, control, d } = build(1);
    const fr: FrontV2 = {
      theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
      controlByNode: [...control], battles: [], events: [], defileQueues: {},
    };
    for (const f of d.forces) addForce(fr, f);
    const goals = makeWarGoals(theater, CAMP);
    expect(warStatus(fr, goals)).toBe('ongoing');
    // Blue takes every objective on the deadline day itself: blue wins.
    fr.day = goals.deadlineDay;
    for (const n of goals.objectiveNodes) fr.controlByNode[n] = 'blue';
    expect(warStatus(fr, goals)).toBe('blue');
    // Past the deadline without the objectives: red wins.
    for (const n of goals.objectiveNodes) fr.controlByNode[n] = 'red';
    fr.day = goals.deadlineDay + 1;
    expect(warStatus(fr, goals)).toBe('red');
    // Annihilation before the deadline: red wins.
    fr.day = 2;
    for (const f of fr.forces) if (f.side === 'blue') f.strength = 0;
    expect(warStatus(fr, goals)).toBe('red');
  });
});
