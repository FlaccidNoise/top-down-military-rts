import { describe, expect, it } from 'vitest';
import { BALK_HINT, balkHint, canArm, ORDER_AFFORDANCE } from '../src/ui/order-data';
import type { OrderKind } from '../src/sim/orders';

const ALL_KINDS: OrderKind[] = ['move', 'fast', 'sneak', 'fire', 'smoke', 'defend', 'ambush', 'assault'];

describe('ORDER_AFFORDANCE', () => {
  it('has entries for all 8 OrderKind values', () => {
    for (const k of ALL_KINDS) {
      const a = ORDER_AFFORDANCE[k];
      expect(a, `missing ORDER_AFFORDANCE[${k}]`).toBeDefined();
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.when.length).toBeGreaterThan(0);
      expect(a.hotkey).toMatch(/^⇧\d$/);
      expect(a.complianceNote.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ORDER_AFFORDANCE)).toHaveLength(8);
  });
});

describe('balkHint', () => {
  it('names an order the player can give for every order that can be refused', () => {
    const names = Object.values(ORDER_AFFORDANCE).map((a) => a.name);
    for (const hint of Object.values(BALK_HINT)) {
      expect(names.some((n) => hint.includes(n)), hint).toBe(true);
    }
  });

  it('never tells the player to rally: there is no such order', () => {
    for (const k of ALL_KINDS) expect(balkHint(k, 'too far to throw smoke'), k).not.toMatch(/rally/i);
  });

  it('gives a smoke order that cannot be thrown the reason the sim gave', () => {
    expect(balkHint('smoke', 'too far to throw smoke — get within 30 m')).toBe('Too far to throw smoke — get within 30 m');
    expect(balkHint('smoke', 'no smoke grenades left')).toBe('No smoke grenades left');
  });
});

describe('canArm', () => {
  it('assault is squad-only', () => {
    expect(canArm('assault', 'squad')).toBe(true);
    expect(canArm('assault', 'vehicle')).toBe(false);
    expect(canArm('assault', 'crew')).toBe(false);
  });

  it('move/fast are universal', () => {
    for (const k of ['move', 'fast'] as OrderKind[]) {
      expect(canArm(k, 'squad')).toBe(true);
      expect(canArm(k, 'vehicle')).toBe(true);
      expect(canArm(k, 'crew')).toBe(true);
    }
  });

  it('fire/smoke/defend are squad+crew only', () => {
    for (const k of ['fire', 'smoke', 'defend'] as OrderKind[]) {
      expect(canArm(k, 'squad')).toBe(true);
      expect(canArm(k, 'crew')).toBe(true);
      expect(canArm(k, 'vehicle')).toBe(false);
    }
  });

  it('ambush is squad-only', () => {
    expect(canArm('ambush', 'squad')).toBe(true);
    expect(canArm('ambush', 'vehicle')).toBe(false);
    expect(canArm('ambush', 'crew')).toBe(false);
  });

  it('sneak is squad+crew, not vehicle', () => {
    expect(canArm('sneak', 'squad')).toBe(true);
    expect(canArm('sneak', 'crew')).toBe(true);
    expect(canArm('sneak', 'vehicle')).toBe(false);
  });

  it('returns boolean for all 8×3 combinations', () => {
    for (const k of ALL_KINDS) {
      for (const t of ['squad', 'vehicle', 'crew'] as const) {
        expect(typeof canArm(k, t)).toBe('boolean');
      }
    }
  });
});