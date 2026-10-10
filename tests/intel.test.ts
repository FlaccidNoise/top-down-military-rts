// Strategic FOW (S53, §4.3): last-seen contacts, linear decay over
// STRAT_CONTACT_TTL, graph-metre detection on a 15-min cadence, and the
// grep gate that keeps the planner honest — no cross-side front.forces read
// outside intel.ts.
// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeTheater } from '../src/strategic/theatergen';
import { makeDisposition } from '../src/strategic/theatergen/disposition';
import { addForce, type FrontV2 } from '../src/strategic/theater/force';
import { stepWar } from '../src/strategic/theater/war';
import {
  ContactIntel,
  contactConf,
  DETECT_FORCE_M,
  DETECT_NODE_M,
  INTEL_EVAL_MIN,
  STRAT_CONTACT_TTL,
  updateIntelMinute,
} from '../src/strategic/intel';
import { Commander2, RED_V2 } from '../src/strategic/planner';
import { makeWarGoals } from '../src/strategic/goals';
import { loadGameV2, saveGameV2 } from '../src/strategic/save2';
import { lineFront, place } from './lib/line-theater';

describe('detection sweep', () => {
  it('sees a force within 3000 graph metres of an own force, not beyond', () => {
    const fr = lineFront();
    place(fr, 'blue', 1);
    const near = place(fr, 'red', 2); // 2000 m
    const far = place(fr, 'red', 3); // 4000 m
    fr.clockMin = INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    const ids = fr.intel!.blue.map((c) => c.forceId);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
    // Symmetric: red saw blue too (OQ6 — same fog, same sweep).
    expect(fr.intel!.red.map((c) => c.forceId)).toContain(fr.forces[0].id);
  });

  it('an owned node sees only DETECT_NODE_M — a force outranges it 2:1', () => {
    const fr = lineFront();
    const red = place(fr, 'red', 2);
    // No blue forces at all: only the owned nodes 0/1 watch. Node 1 is
    // 2000 m from the enemy, past the 1500 m node radius.
    fr.clockMin = INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    expect(fr.intel!.blue).toHaveLength(0);
    // Mid-edge at 1300 m from the owned node: inside the node radius.
    red.pos = { kind: 'edge', edgeId: 1, s: 1300, dir: -1 };
    fr.clockMin = 2 * INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    expect(fr.intel!.blue.map((c) => c.forceId)).toContain(red.id);
    expect(DETECT_FORCE_M - DETECT_NODE_M).toBe(1500);
  });

  it('sweeps only on the 15-minute boundary', () => {
    const fr = lineFront();
    place(fr, 'blue', 1);
    place(fr, 'red', 2);
    fr.clockMin = INTEL_EVAL_MIN + 1;
    updateIntelMinute(fr);
    expect(fr.intel?.blue ?? []).toHaveLength(0);
  });

  it('keeps the LAST-SEEN snapshot when the enemy moves out of range, then expires it at the TTL', () => {
    const fr = lineFront();
    place(fr, 'blue', 1);
    const red = place(fr, 'red', 2);
    fr.clockMin = INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    const snap = fr.intel!.blue.find((c) => c.forceId === red.id)!;
    expect(snap.pos).toEqual({ kind: 'node', nodeId: 2 });

    red.pos = { kind: 'node', nodeId: 3 }; // slipped away
    fr.clockMin = 2 * INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    const ghost = fr.intel!.blue.find((c) => c.forceId === red.id)!;
    expect(ghost.pos).toEqual({ kind: 'node', nodeId: 2 }); // stale, honest
    expect(ghost.seenMin).toBe(INTEL_EVAL_MIN);
    expect(contactConf(ghost, fr.clockMin)).toBeCloseTo(1 - INTEL_EVAL_MIN / STRAT_CONTACT_TTL, 5);

    fr.clockMin = INTEL_EVAL_MIN + STRAT_CONTACT_TTL;
    updateIntelMinute(fr);
    expect(fr.intel!.blue.find((c) => c.forceId === red.id)).toBeUndefined();
  });

  it('a dead force stops being detected; its old ghost decays out on its own', () => {
    const fr = lineFront();
    place(fr, 'blue', 1);
    const red = place(fr, 'red', 2);
    fr.clockMin = INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    red.strength = 0;
    fr.clockMin = 2 * INTEL_EVAL_MIN;
    updateIntelMinute(fr);
    const ghost = fr.intel!.blue.find((c) => c.forceId === red.id)!;
    expect(ghost.seenMin).toBe(INTEL_EVAL_MIN); // not refreshed
  });

  it('ContactIntel serves aged ghosts; stepWar runs the sweep only under recon: contacts', () => {
    const fr = lineFront();
    place(fr, 'blue', 1);
    place(fr, 'red', 2);
    fr.clockMin = INTEL_EVAL_MIN - 1;
    stepWar(fr, newCampaign(1, 2), { recon: 'contacts', autoBattle: () => false });
    const intel = new ContactIntel(fr, 'blue');
    expect(intel.contacts()).toHaveLength(1);
    expect(intel.contacts()[0].ageMin).toBe(0);

    const fr2 = lineFront();
    place(fr2, 'blue', 1);
    place(fr2, 'red', 2);
    fr2.clockMin = INTEL_EVAL_MIN - 1;
    stepWar(fr2, newCampaign(1, 2), { recon: 'omniscient', autoBattle: () => false });
    expect(fr2.intel).toBeUndefined();
  });
});

describe('the AI under fog (OQ6)', () => {
  it('a fogged red with zero contacts still plans — it advances instead of stalling', () => {
    const fr = lineFront();
    place(fr, 'red', 3, 120);
    place(fr, 'blue', 0); // far out of detection range
    fr.controlByNode = ['blue', 'blue', 'blue', 'red']; // objective 2 lost — red wants it back
    const goals = makeWarGoals(fr.theater, DEFAULT_PRESET.campaign);
    const red = new Commander2('red', RED_V2, goals, 14);
    fr.clockMin = 60;
    const report = red.evaluate(fr, new ContactIntel(fr, 'red'))!;
    expect(report.stall).toBeNull();
    expect(report.orders.some((o) => o.dest === 2 && o.why === 'advance')).toBe(true);
  });

  it('grep gate: the planner reads NO force truth — front.forces does not appear in planner.ts', () => {
    const src = readFileSync('src/strategic/planner.ts', 'utf8');
    expect(src.includes('front.forces')).toBe(false);
  });
});

describe('intel persistence (save v4)', () => {
  it('contact maps ride the save and conf rebuilds from seenMin + clock', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const seed = 3;
    const { theater, initialControlByNode } = makeTheater(seed, DEFAULT_PRESET.theater);
    const campaign = newCampaign(seed, DEFAULT_PRESET.campaign.blueCompanies);
    const spec = presetSpec(DEFAULT_PRESET, seed);
    const d = makeDisposition(theater, DEFAULT_PRESET.campaign, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
    const front: FrontV2 = {
      theater, clockMin: 900, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
      controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
    };
    for (const f of d.forces) addForce(front, f);
    front.intel = {
      blue: [{ forceId: 7, pos: { kind: 'node', nodeId: 1 }, strength: 80, seenMin: 840, moving: false }],
      red: [],
    };
    expect(saveGameV2(seed, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign, campaign, front)).toBe(true);
    const loaded = loadGameV2();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.front.intel).toEqual(front.intel);
    expect(contactConf(loaded.front.intel!.blue[0], loaded.front.clockMin)).toBeCloseTo(1 - 60 / STRAT_CONTACT_TTL, 5);
  });
});
