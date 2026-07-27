import { describe, expect, it } from 'vitest';
import { RedCommander } from '../src/sim/ai';
import { EYE_H, GameMap, los } from '../src/sim/map';
import type { OrderKind } from '../src/sim/orders';
import { makeScenario } from '../src/sim/scenario';
import { EYE_CROUCH, EYE_PRONE, EYE_STAND, eyeOf, stanceOf, type Sim, type Soldier } from '../src/sim/sim';

// V6: eye-height plumbing + the derived stance.
// V8: the doctrine stances — a team lying in ambush is prone, a team dug in on
// defend is crouched, and a man advancing under fire crawls. Stance therefore
// depends on the team's ORDER, which is why stanceOf takes the sim.

// A one-team sim stub: stanceOf reads nothing else off it.
function ctx(order?: OrderKind): Sim {
  return { teams: [{ orderState: { order: order ? { kind: order, x: 0, y: 0 } : null } }] } as unknown as Sim;
}

function man(over: Partial<Soldier> = {}): Soldier {
  return {
    alive: true,
    downed: false,
    captured: false,
    mental: 'steady',
    path: null,
    targetId: -1,
    suppression: 0,
    teamId: 0,
    ...over,
  } as Soldier;
}

describe('stanceOf', () => {
  it('is prone for anyone out of the fight', () => {
    expect(stanceOf(ctx(), man({ alive: false }))).toBe('prone');
    expect(stanceOf(ctx(), man({ downed: true }))).toBe('prone');
    expect(stanceOf(ctx(), man({ captured: true }))).toBe('prone');
  });

  it('reproduces the renderer pinned/broken prone predicate', () => {
    expect(stanceOf(ctx(), man({ mental: 'pinned' }))).toBe('prone');
    expect(stanceOf(ctx(), man({ mental: 'pinned', path: [{ x: 1, y: 1 }] }))).toBe('prone');
    expect(stanceOf(ctx(), man({ mental: 'broken' }))).toBe('prone');
    // a broken man who is running still runs
    expect(stanceOf(ctx(), man({ mental: 'broken', path: [{ x: 1, y: 1 }] }))).toBe('stand');
  });

  it('a moving man is upright unless he is crawling under fire', () => {
    expect(stanceOf(ctx(), man({ path: [{ x: 1, y: 1 }], targetId: 3, suppression: 0.4 }))).toBe('stand');
    // the WYSIWYG gap V6 left open: the renderer has always drawn this man
    // low-crawling, and now LOS sights him at 0.4 m to match
    expect(stanceOf(ctx(), man({ path: [{ x: 1, y: 1 }], suppression: 0.6 }))).toBe('prone');
    expect(stanceOf(ctx(), man({ path: [{ x: 1, y: 1 }], suppression: 0.5 }))).toBe('stand'); // strict >
  });

  it('crouches only when halted, engaged and suppressed past the kneel threshold', () => {
    expect(stanceOf(ctx(), man({ targetId: 3, suppression: 0.16 }))).toBe('crouch');
    expect(stanceOf(ctx(), man({ targetId: 3, suppression: 0.15 }))).toBe('stand'); // strict >
    expect(stanceOf(ctx(), man({ targetId: -1, suppression: 0.9 }))).toBe('stand'); // no target: standing watch
  });

  it('doctrine: ambush lies prone, defend digs in crouched, other orders do not', () => {
    expect(stanceOf(ctx('ambush'), man())).toBe('prone');
    expect(stanceOf(ctx('defend'), man())).toBe('crouch');
    for (const k of ['move', 'fast', 'sneak', 'fire', 'smoke', 'assault'] as OrderKind[]) {
      expect(stanceOf(ctx(k), man()), k).toBe('stand');
    }
  });

  it('doctrine: a team still walking to its post is not yet in its stance', () => {
    const marching = man({ path: [{ x: 1, y: 1 }] });
    expect(stanceOf(ctx('ambush'), marching)).toBe('stand');
    expect(stanceOf(ctx('defend'), marching)).toBe('stand');
  });

  it('covers every mental x (path, target, order) combination without falling through', () => {
    const mentals = ['steady', 'shaken', 'pinned', 'broken'] as const;
    for (const m of mentals)
      for (const p of [null, [{ x: 1, y: 1 }]])
        for (const t of [-1, 3])
          for (const sup of [0, 0.5])
            for (const o of [undefined, 'defend', 'ambush', 'move'] as (OrderKind | undefined)[]) {
              const st = stanceOf(ctx(o), man({ mental: m, path: p, targetId: t, suppression: sup }));
              expect(['stand', 'crouch', 'prone']).toContain(st);
            }
  });

  it('survives a soldier whose team is not in the sim (renderer mid-construction)', () => {
    expect(stanceOf({ teams: [] } as unknown as Sim, man({ teamId: 7 }))).toBe('stand');
  });
});

describe('stance liveness under natural dynamics', () => {
  // A test that FORCES a gate's inputs proves the mechanism, not that the
  // feature ever fires. stanceOf's non-standing branches depend on `mental`,
  // `suppression` and team orders reaching states nothing in the unit tests
  // above produces organically, so probe a real battle: if a refactor ever
  // makes crouch or prone unreachable, every eye-height assertion in the suite
  // would still pass while the feature was silently dead.
  const tallyOver = (sim: Sim, ticks: number, tick?: () => void) => {
    const tally = { stand: 0, crouch: 0, prone: 0 };
    for (let i = 0; i < ticks; i++) {
      tick?.();
      sim.step();
      if (i % 30 === 0) for (const s of sim.soldiers) if (s.alive && !s.downed) tally[stanceOf(sim, s)]++;
    }
    return { ...tally, total: tally.stand + tally.crouch + tally.prone };
  };

  it('an unordered battle still produces all three stances from state alone', () => {
    // measured 2026-07-26 on this scenario: 0.8% crouch, 5.3% prone. (V6, before
    // the crawl rule, ran 1.4% / 2.8%: men advancing under >0.5 suppression
    // moved from `stand` to `prone`, which is what the renderer always drew.)
    const t = tallyOver(makeScenario(7), 4500);
    expect(t.stand).toBeGreaterThan(0);
    expect(t.crouch, 'crouch never fired — the engaged/suppressed branch is dead').toBeGreaterThan(0);
    expect(t.prone, 'prone never fired — the pinned/broken/crawl branch is dead').toBeGreaterThan(0);
    expect((t.crouch + t.prone) / t.total).toBeLessThan(0.5);
  }, 60000);

  it('a commanded defence lies down: the doctrine prone branch fires under a real AI', () => {
    // The defending commander settles each squad onto its post and issues
    // `ambush` (ai.ts runDefend), so most of the garrison spends the battle
    // prone. Measured 2026-07-26: 42.7% prone, versus 5.3% with no commander.
    // THIS is V8's balance change — a dug-in defender's eye drops to 0.4 m, so
    // every 1 m bank and road verge on the map now hides him.
    const sim = makeScenario(7);
    const posts: Record<number, { x: number; y: number }> = {};
    for (const sq of sim.squads)
      if (sq.side === 'red') {
        const s = sim.soldiers[sq.soldierIds[0]];
        posts[sq.id] = { x: s.x, y: s.y };
      }
    const commander = new RedCommander({ side: 'red', stance: 'defend', posts });
    const t = tallyOver(sim, 4500, () => commander.update(sim));
    expect(t.prone / t.total, 'the doctrine prone branch never fired live').toBeGreaterThan(0.15);
  }, 60000);

  it('a defend order digs a team in, through the public order API', () => {
    // No AI issues `defend` today (runDefend picks `ambush`), so the crouch
    // branch's live producer is the player's own order vocabulary. Probe it
    // through the same call the HUD makes, then step: nothing here forces
    // stanceOf's inputs.
    const sim = makeScenario(7);
    const team = sim.teams.find((t) => sim.squads[t.squadId].side === 'blue')!;
    sim.orderTeam(team.id, { kind: 'defend', x: sim.soldiers[team.soldierIds[0]].x, y: sim.soldiers[team.soldierIds[0]].y });
    for (let i = 0; i < 300; i++) sim.step();
    const settled = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed && !s.path);
    expect(settled.length).toBeGreaterThan(0);
    for (const s of settled) expect(eyeOf(sim, s)).toBe(EYE_CROUCH);
  }, 60000);
});

describe('eyeOf', () => {
  it('maps the three stances onto the three eye heights', () => {
    expect(eyeOf(ctx(), man({ mental: 'pinned' }))).toBe(EYE_PRONE);
    expect(eyeOf(ctx(), man({ targetId: 3, suppression: 0.5 }))).toBe(EYE_CROUCH);
    expect(eyeOf(ctx(), man())).toBe(EYE_STAND);
    expect(eyeOf(ctx('ambush'), man())).toBe(EYE_PRONE);
    expect(eyeOf(ctx('defend'), man())).toBe(EYE_CROUCH);
  });

  it('EYE_STAND is the engine eye, unchanged (H5)', () => {
    expect(EYE_STAND).toBe(EYE_H);
    expect(EYE_STAND).toBe(1.6);
    expect(EYE_CROUCH).toBe(1.1);
    expect(EYE_PRONE).toBe(0.4);
  });
});

describe('los eye parameters', () => {
  it('explicit EYE_H is identical to the defaults', () => {
    const m = new GameMap(40, 40);
    for (let i = 0; i < m.elev.length; i++) m.elev[i] = (i * 7919) % 3;
    for (let y = 2; y < 38; y += 5) {
      const a = los(m, 1.5, y + 0.5, 38.5, y + 0.5);
      const b = los(m, 1.5, y + 0.5, 38.5, y + 0.5, 0, 0, EYE_H, EYE_H);
      expect(b).toEqual(a);
    }
  });

  it('a 1 m rise blocks prone-to-prone and passes stand-to-stand (H4)', () => {
    const m = new GameMap(20, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 10] = 1; // one-tile, 1 m bank
    const p = { x0: 4.5, y0: 4.5, x1: 16.5, y1: 4.5 };
    expect(los(m, p.x0, p.y0, p.x1, p.y1, 0, 0, EYE_STAND, EYE_STAND).visible).toBe(true);
    expect(los(m, p.x0, p.y0, p.x1, p.y1, 0, 0, EYE_CROUCH, EYE_CROUCH).visible).toBe(true);
    expect(los(m, p.x0, p.y0, p.x1, p.y1, 0, 0, EYE_PRONE, EYE_PRONE).visible).toBe(false);
  });

  it('a 2 m rise blocks every stance (H4)', () => {
    const m = new GameMap(20, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 10] = 2;
    for (const e of [EYE_STAND, EYE_CROUCH, EYE_PRONE]) {
      expect(los(m, 4.5, 4.5, 16.5, 4.5, 0, 0, e, e).visible).toBe(false);
    }
  });

  it('equal eyes give a direction-independent result', () => {
    const m = new GameMap(20, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 10] = 1;
    for (const e of [EYE_STAND, EYE_CROUCH, EYE_PRONE]) {
      const ab = los(m, 4.5, 4.5, 16.5, 4.5, 0, 0, e, e);
      const ba = los(m, 16.5, 4.5, 4.5, 4.5, 0, 0, e, e);
      expect(ab.visible).toBe(ba.visible);
    }
  });

  it('unequal eyes are direction-dependent — a PRE-EXISTING property of the traversal', () => {
    const m = new GameMap(20, 8);
    for (let y = 0; y < 8; y++) m.elev[y * m.w + 10] = 1;
    // los() samples the ground-occlusion height at each tile's ENTRY edge
    // (map.ts, `const lineZ = z0 + dz * tEntry`), i.e. at the near face as seen
    // from the observer. A sloping z-line therefore reads a different height
    // depending on which end you start from. This already applied to l0 != l1
    // cross-floor rays before stance existed; stance only makes it common.
    // Both sides are affected identically (stanceOf has no side term), so it is
    // an accuracy wart, not a fairness gap. Pinned so V9's mirror test and any
    // future "sight is reciprocal" assumption trip here first.
    const standToProne = los(m, 4.5, 4.5, 16.5, 4.5, 0, 0, EYE_STAND, EYE_PRONE);
    const proneToStand = los(m, 16.5, 4.5, 4.5, 4.5, 0, 0, EYE_PRONE, EYE_STAND);
    expect(standToProne.visible).toBe(true);
    expect(proneToStand.visible).toBe(false);
  });
});
