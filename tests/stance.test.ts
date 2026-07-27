import { describe, expect, it } from 'vitest';
import { EYE_H, GameMap, los } from '../src/sim/map';
import { makeScenario } from '../src/sim/scenario';
import { EYE_CROUCH, EYE_PRONE, EYE_STAND, eyeOf, stanceOf, type Soldier } from '../src/sim/sim';

// V6: eye-height plumbing + the derived stance. The whole point of this commit
// is that it is INERT — los()'s new params default to EYE_H and no call site
// passes anything else yet.

function man(over: Partial<Soldier> = {}): Soldier {
  return {
    alive: true,
    downed: false,
    captured: false,
    mental: 'steady',
    path: null,
    targetId: -1,
    suppression: 0,
    ...over,
  } as Soldier;
}

describe('stanceOf', () => {
  it('is prone for anyone out of the fight', () => {
    expect(stanceOf(man({ alive: false }))).toBe('prone');
    expect(stanceOf(man({ downed: true }))).toBe('prone');
    expect(stanceOf(man({ captured: true }))).toBe('prone');
  });

  it('reproduces the renderer pinned/broken prone predicate', () => {
    expect(stanceOf(man({ mental: 'pinned' }))).toBe('prone');
    expect(stanceOf(man({ mental: 'pinned', path: [{ x: 1, y: 1 }] }))).toBe('prone');
    expect(stanceOf(man({ mental: 'broken' }))).toBe('prone');
    // a broken man who is running still runs
    expect(stanceOf(man({ mental: 'broken', path: [{ x: 1, y: 1 }] }))).toBe('stand');
  });

  it('a moving man is upright regardless of target or suppression', () => {
    expect(stanceOf(man({ path: [{ x: 1, y: 1 }], targetId: 3, suppression: 0.9 }))).toBe('stand');
  });

  it('crouches only when halted, engaged and suppressed past the kneel threshold', () => {
    expect(stanceOf(man({ targetId: 3, suppression: 0.16 }))).toBe('crouch');
    expect(stanceOf(man({ targetId: 3, suppression: 0.15 }))).toBe('stand'); // strict >
    expect(stanceOf(man({ targetId: -1, suppression: 0.9 }))).toBe('stand'); // no target: standing watch
  });

  it('covers every mental x (path, target) combination without falling through', () => {
    const mentals = ['steady', 'shaken', 'pinned', 'broken'] as const;
    for (const m of mentals)
      for (const p of [null, [{ x: 1, y: 1 }]])
        for (const t of [-1, 3])
          for (const sup of [0, 0.5]) {
            const st = stanceOf(man({ mental: m, path: p, targetId: t, suppression: sup }));
            expect(['stand', 'crouch', 'prone']).toContain(st);
          }
  });
});

describe('stance liveness under natural dynamics', () => {
  // A test that FORCES a gate's inputs proves the mechanism, not that the
  // feature ever fires. stanceOf's non-standing branches depend on `mental` and
  // `suppression` reaching thresholds nothing in the unit tests above produces
  // organically, so probe a real battle: if a refactor ever makes crouch or
  // prone unreachable, every eye-height assertion in the suite would still pass
  // while the feature was silently dead.
  it('a real battle produces all three stances', () => {
    const sim = makeScenario(7);
    const tally = { stand: 0, crouch: 0, prone: 0 };
    for (let i = 0; i < 4500; i++) {
      sim.step();
      if (i % 30 === 0) for (const s of sim.soldiers) if (s.alive && !s.downed) tally[stanceOf(s)]++;
    }
    expect(tally.stand).toBeGreaterThan(0);
    expect(tally.crouch, 'crouch never fired — the kneel branch is dead').toBeGreaterThan(0);
    expect(tally.prone, 'prone never fired — the pinned/broken branch is dead').toBeGreaterThan(0);
    // Recorded for V8, which adds the doctrine stances (ambush -> prone,
    // defend -> crouch) and should move these sharply: at 2026-07-26 a
    // 150-second battle on a flat 160x120 map ran ~1.4% crouch, ~2.8% prone.
    const total = tally.stand + tally.crouch + tally.prone;
    expect((tally.crouch + tally.prone) / total).toBeLessThan(0.5);
  }, 60000);
});

describe('eyeOf', () => {
  it('maps the three stances onto the three eye heights', () => {
    expect(eyeOf(man({ mental: 'pinned' }))).toBe(EYE_PRONE);
    expect(eyeOf(man({ targetId: 3, suppression: 0.5 }))).toBe(EYE_CROUCH);
    expect(eyeOf(man())).toBe(EYE_STAND);
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
