// Supply (S50, design §5a) — degrade-only. The trace is a pure function of
// front state; the two effects live at the verified seams: staging ammo in
// bridge2 and supplyMult through combatMult into the coarse win score.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/sim/rng';
import { newCampaign } from '../src/campaign/campaign';
import { presetSpec, DEFAULT_PRESET } from '../src/campaign/presets';
import { SPEC_TAG, specStream } from '../src/campaign/spec';
import { makeTheater } from '../src/strategic/theatergen';
import { makeDisposition } from '../src/strategic/theatergen/disposition';
import { validateTheater } from '../src/strategic/theatergen/validate';
import { coarseOdds } from '../src/strategic/bridge';
import { battleSiteOf, type Theater } from '../src/strategic/theater';
import { addForce, type FrontV2 } from '../src/strategic/theater/force';
import { openBattle, resolveBattleV2, stepWar, battleSides } from '../src/strategic/theater/war';
import {
  forceSupplied,
  SUPPLY_AMMO_MULT,
  SUPPLY_COMBAT_MULT,
  supplyTierOf,
  traceSupply,
  updateSupplyMinute,
} from '../src/strategic/theater/supply';
import { combatMult, effStrength } from '../src/strategic/theater/combat';
import { makeTheaterBattle } from '../src/strategic/bridge2';
import { lineFront, lineTheater, place as soldier } from './lib/line-theater';

describe('supply tiers', () => {
  it('full below 240, low from 240, out from 720 untraced minutes', () => {
    expect(supplyTierOf(0)).toBe('full');
    expect(supplyTierOf(239)).toBe('full');
    expect(supplyTierOf(240)).toBe('low');
    expect(supplyTierOf(719)).toBe('low');
    expect(supplyTierOf(720)).toBe('out');
  });

  it('combatMult composes the supply debuff with the 0.4 floor', () => {
    const fr = lineFront();
    const f = soldier(fr, 'blue', 1);
    expect(combatMult(f)).toBe(1);
    f.untracedMin = 240;
    expect(combatMult(f)).toBe(SUPPLY_COMBAT_MULT.low);
    f.untracedMin = 720;
    expect(combatMult(f)).toBe(SUPPLY_COMBAT_MULT.out);
    expect(effStrength(f)).toBe(f.strength * SUPPLY_COMBAT_MULT.out);
  });
});

describe('supply trace', () => {
  it('traces to the front line and stops at enemy-controlled nodes', () => {
    const fr = lineFront();
    const { traced } = traceSupply(fr, 'blue');
    expect([...traced].sort()).toEqual([0, 1]);
    const red = traceSupply(fr, 'red');
    expect([...red.traced].sort()).toEqual([2, 3]);
  });

  it('a live enemy force ON an edge interdicts it — the 5-line ZOC subset', () => {
    const fr = lineFront();
    const b = soldier(fr, 'blue', 1);
    const raider = soldier(fr, 'red', 3);
    raider.pos = { kind: 'edge', edgeId: 0, s: 1000, dir: -1 };
    const { traced, interdicted } = traceSupply(fr, 'blue');
    expect(interdicted.has(0)).toBe(true);
    expect(traced.has(1)).toBe(false);
    expect(forceSupplied(fr, b, traced)).toBe(false);
    // A dead force interdicts nothing.
    raider.strength = 0;
    expect(traceSupply(fr, 'blue').traced.has(1)).toBe(true);
  });

  it('a force mid-edge is supplied through either traced end', () => {
    const fr = lineFront();
    const b = soldier(fr, 'blue', 1);
    b.pos = { kind: 'edge', edgeId: 1, s: 500, dir: 1 }; // B->C, C is enemy
    const { traced } = traceSupply(fr, 'blue');
    expect(forceSupplied(fr, b, traced)).toBe(true); // through B
  });

  it('updateSupplyMinute accrues in whole hours on the boundary and resets on re-trace', () => {
    const fr = lineFront();
    const b = soldier(fr, 'blue', 1);
    const raider = soldier(fr, 'red', 3);
    raider.pos = { kind: 'edge', edgeId: 0, s: 1000, dir: -1 };
    fr.clockMin = 59;
    updateSupplyMinute(fr);
    expect(b.untracedMin).toBe(0); // not a boundary
    fr.clockMin = 60;
    updateSupplyMinute(fr);
    expect(b.untracedMin).toBe(60);
    fr.clockMin = 120;
    updateSupplyMinute(fr);
    expect(b.untracedMin).toBe(120);
    raider.strength = 0; // interdiction lifted
    fr.clockMin = 180;
    updateSupplyMinute(fr);
    expect(b.untracedMin).toBe(0);
  });

  it('stepWar runs the trace only when the campaign runs supply', () => {
    const run = (supply: boolean): number => {
      const fr = lineFront();
      const b = soldier(fr, 'blue', 1);
      const raider = soldier(fr, 'red', 3);
      raider.pos = { kind: 'edge', edgeId: 0, s: 1700, dir: -1 }; // cuts the road, out of contact range of B
      fr.clockMin = 59;
      stepWar(fr, newCampaign(1, 2), { supply });
      return b.untracedMin;
    };
    expect(run(true)).toBe(60);
    expect(run(false)).toBe(0);
  });
});

describe('supply in the coarse resolver (§4.4 parity)', () => {
  it('the win score reads EFFECTIVE strength — resolver truth equals coarseOdds on eff inputs', () => {
    // Find a seed whose winner roll separates the raw odds (0.5) from the
    // starved odds (1/3): if resolveBattleV2 regresses to raw strength the
    // expected outcome flips and this test goes red.
    let seed = -1;
    for (let s = 1; s < 400; s++) {
      const fr = lineFront();
      const atk = soldier(fr, 'blue', 2);
      const def = soldier(fr, 'red', 2);
      const battle = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 0 });
      const { siteKey } = battleSiteOf(fr.theater, battle.site);
      const roll = mulberry32((s ^ (battle.startMin * 7919 + siteKey)) >>> 0).next();
      if (roll > 1 / 3 + 0.02 && roll < 0.5 - 0.02) {
        seed = s;
        break;
      }
    }
    expect(seed).toBeGreaterThan(0);

    const fr = lineFront();
    const campaign = newCampaign(seed, 2);
    campaign.seed = seed;
    const atk = soldier(fr, 'blue', 2);
    const def = soldier(fr, 'red', 2);
    atk.untracedMin = 720; // out: eff 50 vs 100 -> odds 1/3; raw odds 0.5
    const battle = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 0 });
    const sides = battleSides(fr, battle);
    expect(sides.atkEff).toBe(50);
    expect(coarseOdds(sides.atkEff, sides.defEff, 1)).toBeCloseTo(1 / 3, 5);
    const out = resolveBattleV2(fr, campaign, battle);
    expect(out.attackerWon).toBe(false); // roll > eff odds; raw would have won
  });
});

describe('supply at the staging seam (bridge2)', () => {
  const build = (seed: number) => {
    const { theater, initialControlByNode } = makeTheater(seed, DEFAULT_PRESET.theater);
    const campaign = newCampaign(seed, DEFAULT_PRESET.campaign.blueCompanies);
    const spec = presetSpec(DEFAULT_PRESET, seed);
    const d = makeDisposition(theater, DEFAULT_PRESET.campaign, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
    const front: FrontV2 = {
      theater, clockMin: 840, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
      controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
    };
    for (const f of d.forces) addForce(front, f);
    return { campaign, front };
  };
  const stage = (w: ReturnType<typeof build>, defUntraced: number) => {
    const blue = w.front.forces.find((f) => f.side === 'blue')!;
    const g = w.front.forces.find((f) => f.role === 'garrison')!;
    g.untracedMin = defUntraced;
    blue.pos = g.pos;
    const battle = openBattle(w.front, { attackerId: blue.id, defenderId: g.id, site: g.pos, gapM: 0 });
    return makeTheaterBattle(w.campaign, w.front, battle);
  };

  it('an OUT defender stages at 25% ammo, ammoStart mirrored, attacker untouched', () => {
    const full = stage(build(5), 0);
    const cut = stage(build(5), 720);
    const reds = full.sim.soldiers.filter((s) => s.side === 'red');
    const cutReds = cut.sim.soldiers.filter((s) => s.side === 'red');
    expect(cutReds.length).toBe(reds.length);
    let shrank = 0;
    for (let i = 0; i < reds.length; i++) {
      const orig = reds[i];
      const scaled = cutReds[i];
      for (const k of Object.keys(orig.ammo) as (keyof typeof orig.ammo)[]) {
        const o = orig.ammo[k];
        const c = scaled.ammo[k];
        if (!o) continue;
        expect(c).toBe(Math.max(1, Math.floor(o * SUPPLY_AMMO_MULT.out)));
        if (c! < o) shrank++;
      }
      const sum = Object.values(scaled.ammo).reduce((a: number, n) => a + (n ?? 0), 0);
      expect(scaled.ammoStart).toBe(sum);
    }
    expect(shrank).toBeGreaterThan(0);
    // The attacker's side is untouched — supply is per-side.
    expect(cut.sim.soldiers.filter((s) => s.side === 'blue').map((s) => s.ammo))
      .toEqual(full.sim.soldiers.filter((s) => s.side === 'blue').map((s) => s.ammo));
  });

  it('full tier stages byte-identically (positions AND ammo)', () => {
    const a = stage(build(6), 0);
    const b = stage(build(6), 0);
    expect(a.sim.soldiers.map((s) => [s.x, s.y, s.ammo, s.ammoStart]))
      .toEqual(b.sim.soldiers.map((s) => [s.x, s.y, s.ammo, s.ammoStart]));
  });
});

describe('no-supply-source (the 12th reject)', () => {
  it('a side with no source node rejects by name', () => {
    const t = lineTheater();
    // Satisfy the earlier checks (crossing band) so the sources check is the
    // first to fire — the line theater has no river of its own.
    t.nodes[1].crossing = { riverId: 0, kind: 'bridge' };
    t.nodes[2].crossing = { riverId: 0, kind: 'bridge' };
    t.sources.red = [];
    expect(validateTheater(t, ['blue', 'blue', 'red', 'red'])).toBe('no-supply-source');
    t.sources.red = [3];
    t.sources.blue = [];
    expect(validateTheater(t, ['blue', 'blue', 'red', 'red'])).toBe('no-supply-source');
  });

  it('generated theaters never trip it (subsumed by front-degenerate)', () => {
    for (let s = 1; s <= 8; s++) {
      const { theater } = makeTheater(s, DEFAULT_PRESET.theater);
      expect(theater.sources.blue.length).toBeGreaterThan(0);
      expect(theater.sources.red.length).toBeGreaterThan(0);
    }
  });
});

// The spur-source regression (GEN_VERSION 2): the literal westmost blue node
// can hang off a red-held crossing, and a source nobody can trace from makes
// supply a lie for the whole campaign — every blue force read OUT from
// minute one at seed 7. Sources now come from each side's largest component.
describe('sources reach the army', () => {
  it('every disposition force starts SUPPLIED across 16 seeds', () => {
    for (let s = 1; s <= 16; s++) {
      const { theater, initialControlByNode } = makeTheater(s, DEFAULT_PRESET.theater);
      const campaign = newCampaign(s, DEFAULT_PRESET.campaign.blueCompanies);
      const spec = presetSpec(DEFAULT_PRESET, s);
      const d = makeDisposition(theater, DEFAULT_PRESET.campaign, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
      const front: FrontV2 = {
        theater, clockMin: 360, day: 1, nextForceId: 0, nextBattleId: 0, forces: [],
        controlByNode: [...initialControlByNode], battles: [], events: [], defileQueues: {},
      };
      for (const f of d.forces) addForce(front, f);
      for (const side of ['blue', 'red'] as const) {
        const { traced } = traceSupply(front, side);
        for (const f of front.forces) {
          if (f.side !== side) continue;
          expect(forceSupplied(front, f, traced), `seed ${s}: ${f.name} starts cut off`).toBe(true);
        }
      }
    }
  });
});
