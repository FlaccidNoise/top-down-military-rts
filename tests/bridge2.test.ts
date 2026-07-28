import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeTheater } from '../src/strategic/theatergen';
import { makeDisposition } from '../src/strategic/theatergen/disposition';
import { addForce, type FrontV2 } from '../src/strategic/theater/force';
import { openBattle } from '../src/strategic/theater/war';
import { applyTheaterOutcome, makeTheaterBattle } from '../src/strategic/bridge2';

const CFG = DEFAULT_PRESET.theater;
const CAMP = DEFAULT_PRESET.campaign;

const build = (seed: number) => {
  const { theater, initialControlByNode } = makeTheater(seed, CFG);
  const campaign = newCampaign(seed, CAMP.blueCompanies);
  const spec = presetSpec(DEFAULT_PRESET, seed);
  const d = makeDisposition(theater, CAMP, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
  const front: FrontV2 = {
    theater, clockMin: 840, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
    controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
  };
  for (const f of d.forces) addForce(front, f);
  return { theater, campaign, front };
};

describe('makeTheaterBattle', () => {
  it('stages a real Sim from a theater contact: both sides fielded, clock threaded, toponym named', () => {
    const { front, campaign } = build(1);
    const blue = front.forces.find((f) => f.side === 'blue')!;
    const garrison = front.forces.find((f) => f.role === 'garrison')!;
    const site = garrison.pos;
    blue.pos = site; // walked into the garrison
    const battle = openBattle(front, { attackerId: blue.id, defenderId: garrison.id, site, gapM: 0 });
    const tb = makeTheaterBattle(campaign, front, battle);
    expect(tb.sim.soldiers.filter((s) => s.side === 'blue').length).toBeGreaterThan(50);
    expect(tb.sim.soldiers.filter((s) => s.side === 'red').length).toBeGreaterThan(10);
    expect(tb.sim.startMin).toBe(front.clockMin);
    expect(tb.companyIndex).toBe(blue.companyIndex);
    if (site.kind === 'node') expect(tb.name).toContain(front.theater.nodes[site.nodeId].name);
    expect(tb.sim.winner).toBeNull();
  });

  it('same battle stages byte-identically (seed = startMin x 7919 + siteKey)', () => {
    const a = build(2);
    const b = build(2);
    const stage = (w: ReturnType<typeof build>) => {
      const blue = w.front.forces.find((f) => f.side === 'blue')!;
      const g = w.front.forces.find((f) => f.role === 'garrison')!;
      blue.pos = g.pos;
      const battle = openBattle(w.front, { attackerId: blue.id, defenderId: g.id, site: g.pos, gapM: 0 });
      return makeTheaterBattle(w.campaign, w.front, battle);
    };
    const s1 = stage(a);
    const s2 = stage(b);
    expect(s1.sim.soldiers.map((s) => [s.x, s.y, s.weapon])).toEqual(s2.sim.soldiers.map((s) => [s.x, s.y, s.weapon]));
  });

  it('applyTheaterOutcome: winner paints and occupies, loser routes, roster reconciles', () => {
    const { front, campaign } = build(3);
    const blue = front.forces.find((f) => f.side === 'blue')!;
    const garrison = front.forces.find((f) => f.role === 'garrison')!;
    blue.pos = garrison.pos;
    const battle = openBattle(front, { attackerId: blue.id, defenderId: garrison.id, site: garrison.pos, gapM: 0 });
    const tb = makeTheaterBattle(campaign, front, battle);
    tb.sim.winner = 'blue'; // decide the fight without running 20k ticks
    const out = applyTheaterOutcome(campaign, front, battle, tb.battleClass, tb.sim);
    const nodeId = battle.site.kind === 'node' ? battle.site.nodeId : -1;
    expect(out.nodeTaken).toBe(nodeId);
    expect(front.controlByNode[nodeId]).toBe('blue');
    expect(blue.pos).toEqual({ kind: 'node', nodeId });
    expect(blue.engagedIn).toBeNull();
    expect(front.battles).toHaveLength(0);
    expect(campaign.log.length).toBeGreaterThan(0);
    expect(front.events.some((e) => e.kind === 'battle-resolved')).toBe(true);
  });
});
