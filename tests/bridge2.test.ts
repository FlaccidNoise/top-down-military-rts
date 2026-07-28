import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeTheater } from '../src/strategic/theatergen';
import { makeDisposition } from '../src/strategic/theatergen/disposition';
import { addForce, type FrontV2 } from '../src/strategic/theater/force';
import { battleCatchUpMin, openBattle, stepWar } from '../src/strategic/theater/war';
import { orderMove } from '../src/strategic/theater/step';
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

  // OQ3 (B): fine and coarse battles cost the theater the SAME bounded time,
  // and the catch-up minutes are real war minutes — other forces march and
  // their events reach the log, never swallowed by the mode switch.
  it('OQ3: a fought battle + catch-up advances the clock exactly as the coarse timer would', () => {
    const stageContact = (w: ReturnType<typeof build>) => {
      const blue = w.front.forces.find((f) => f.side === 'blue')!;
      const g = w.front.forces.find((f) => f.role === 'garrison')!;
      blue.pos = g.pos;
      return openBattle(w.front, { attackerId: blue.id, defenderId: g.id, site: g.pos, gapM: 0 });
    };
    // World 1: the battle resolves on the war clock (coarse path).
    const w1 = build(4);
    const b1 = stageContact(w1);
    const t0 = w1.front.clockMin;
    while (w1.front.battles.length > 0) stepWar(w1.front, w1.campaign, { autoBattle: () => false });
    expect(w1.front.clockMin).toBe(b1.endMin);

    // World 2: the SAME battle is fought, then the debrief catch-up steps
    // battleCatchUpMin — with a second force marching a short final leg so
    // its arrival event provably lands INSIDE the catch-up window.
    const w2 = build(4);
    const b2 = stageContact(w2);
    expect(b2.endMin).toBe(b1.endMin);
    const other = w2.front.forces.find((f) => f.side === 'blue' && f.engagedIn === null && f.pos.kind === 'node')!;
    const nid = (other.pos as { nodeId: number }).nodeId;
    const e0 = w2.front.theater.edges.find((e) => e.moveClass !== 'rail' && (e.a === nid || e.b === nid))!;
    other.pos = e0.a === nid
      ? { kind: 'edge', edgeId: e0.id, s: 500, dir: -1 }
      : { kind: 'edge', edgeId: e0.id, s: e0.lengthM - 500, dir: 1 };
    expect(orderMove(w2.front, other.id, nid).ok).toBe(true);
    const tb = makeTheaterBattle(w2.campaign, w2.front, b2);
    tb.sim.winner = 'blue';
    applyTheaterOutcome(w2.campaign, w2.front, b2, tb.battleClass, tb.sim);
    const catchUp = battleCatchUpMin(b2);
    expect(catchUp).toBe(b2.endMin - b2.startMin);
    expect(catchUp).toBeLessThanOrEqual(240);
    for (let i = 0; i < catchUp; i++) stepWar(w2.front, w2.campaign, { autoBattle: () => false });
    expect(w2.front.clockMin).toBe(w1.front.clockMin);
    // The marching force's catch-up events reached the ring.
    expect(w2.front.events.some((e) => e.min > t0 && e.forceIds.includes(other.id))).toBe(true);
  });
});
