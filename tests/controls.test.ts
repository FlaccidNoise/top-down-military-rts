import { describe, expect, it } from 'vitest';
import { DEFAULTS, CONTEXT, loadKeymap, saveKeymap, formatBinding, actionForEvent, rebind, type ActionId, type Keymap } from '../src/ui/keymap';
import { GameMap } from '../src/sim/map';
import { Sim, fanOffsets, formationSlots, OFFSETS } from '../src/sim/sim';

function fakeStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  } as Storage;
}

function mkEvent(code: string, shiftKey = false): KeyboardEvent {
  return { code, shiftKey } as KeyboardEvent;
}

// ── keymap ──────────────────────────────────────────────────────────

describe('keymap', () => {
  describe('defaults round-trip through save/load', () => {
    it('loadKeymap returns defaults when no storage', () => {
      const km = loadKeymap();
      expect(km.bindings.pause).toEqual(DEFAULTS.pause);
      expect(km.bindings.squad1).toEqual(DEFAULTS.squad1);
      expect(km.version).toBe(0);
    });

    it('WASD pan defaults own A; airstrike moved to E (no battle-context clash)', () => {
      expect(DEFAULTS.panLeft).toEqual({ code: 'KeyA' });
      expect(DEFAULTS.airstrike).toEqual({ code: 'KeyE' });
      const battleIds = (Object.keys(CONTEXT) as ActionId[]).filter((id) => CONTEXT[id] === 'battle');
      const keys = battleIds.map((id) => `${DEFAULTS[id].code}|${DEFAULTS[id].shift ?? false}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('saveKeymap + loadKeymap round-trips custom bindings', () => {
      const storage = fakeStorage();
      const km = loadKeymap(storage);
      km.bindings.pause = { code: 'KeyP' };
      km.version = 1;
      saveKeymap(km, storage);

      const loaded = loadKeymap(storage);
      expect(loaded.bindings.pause).toEqual({ code: 'KeyP', shift: false });
      expect(loaded.version).toBe(2); // save bumps version (HUD sig keys off it)
    });

    it('version bumps on save', () => {
      const storage = fakeStorage();
      saveKeymap({ bindings: { ...DEFAULTS }, version: 5 }, storage);
      expect(loadKeymap(storage).version).toBe(6);
    });

    it('unknown action ids in stored JSON are ignored', () => {
      const storage = fakeStorage();
      storage.setItem('rts.keymap.v1', JSON.stringify({
        bindings: { pause: { code: 'KeyP' }, unknown_action: { code: 'KeyX' } },
        version: 2,
      }));
      const km = loadKeymap(storage);
      expect(km.bindings.pause).toEqual({ code: 'KeyP', shift: false });
      expect((km.bindings as Record<string, unknown>).unknown_action).toBeUndefined();
    });

    it('corrupt JSON falls back to defaults', () => {
      const storage = fakeStorage();
      storage.setItem('rts.keymap.v1', 'not json');
      const km = loadKeymap(storage);
      expect(km.bindings.pause).toEqual(DEFAULTS.pause);
      expect(km.version).toBe(0);
    });
  });

  describe('rebind', () => {
    it('conflict in same context swaps bindings', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 1 };
      rebind(km, 'pause', { code: 'KeyP' });
      expect(km.bindings.pause.code).toBe('KeyP');

      rebind(km, 'mute', { code: 'KeyP' });
      // mute takes KeyP; pause gets mute's previous binding (KeyM)
      expect(km.bindings.mute).toEqual({ code: 'KeyP', shift: false });
      expect(km.bindings.pause).toEqual({ code: 'KeyM' });
    });

    it('swap handles default-equals-incoming: squad1→Digit5 swaps, no duplicate', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 1 };
      rebind(km, 'squad1', { code: 'Digit5' });
      expect(km.bindings.squad1).toEqual({ code: 'Digit5', shift: false });
      expect(km.bindings.squad5).toEqual({ code: 'Digit1' });
      // No two battle-context actions share a binding
      const battleSeen = new Set<string>();
      for (const [id, b] of Object.entries(km.bindings)) {
        if (CONTEXT[id as keyof typeof CONTEXT] !== 'battle') continue;
        const key = `${b.code}:${b.shift}`;
        expect(battleSeen.has(key)).toBe(false);
        battleSeen.add(key);
      }
    });

    it('cascade: if swapped binding collides, third action reverts to default', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 1 };
      // Manually create a conflict so prev cascades: squad3 also on Digit1
      km.bindings.squad3 = { code: 'Digit1', shift: false };
      rebind(km, 'squad1', { code: 'Digit5' });
      expect(km.bindings.squad1).toEqual({ code: 'Digit5', shift: false });
      expect(km.bindings.squad5).toEqual({ code: 'Digit1' });
      expect(km.bindings.squad3).toEqual(DEFAULTS.squad3);
    });

    it('invariant: no two actions in the same context share a binding after rebinds', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 1 };
      const actions = Object.keys(CONTEXT) as (keyof typeof CONTEXT)[];
      const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'KeyQ', 'KeyW', 'KeyE'];
      const battleActions = actions.filter((a) => CONTEXT[a] === 'battle');
      for (let i = 0; i < 20; i++) {
        const a = battleActions[Math.floor(Math.random() * battleActions.length)];
        const c = codes[Math.floor(Math.random() * codes.length)];
        rebind(km, a, { code: c, shift: false });
      }
      // Verify invariant per context (menu/cancel share Escape by design)
      for (const ctx of ['global', 'battle', 'strategic'] as const) {
        const seen = new Set<string>();
        for (const [id, b] of Object.entries(km.bindings)) {
          if (CONTEXT[id as keyof typeof CONTEXT] !== ctx) continue;
          if (ctx === 'global' && (id === 'menu' || id === 'cancel')) continue;
          const key = `${b.code}:${b.shift}`;
          if (seen.has(key)) {
            expect.fail(`${ctx}: '${id}' and another action both bound to ${key}`);
          }
          seen.add(key);
        }
      }
    });

    it('cross-context duplicate is allowed', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 1 };
      expect(km.bindings.squad1.code).toBe('Digit1');
      expect(km.bindings.speed1.code).toBe('Digit1');

      rebind(km, 'squad1', { code: 'KeyQ' });
      expect(km.bindings.squad1).toEqual({ code: 'KeyQ', shift: false });
      expect(km.bindings.speed1).toEqual(DEFAULTS.speed1);
    });
  });

  describe('actionForEvent', () => {
    it('Digit1 without shift → squad1', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 0 };
      expect(actionForEvent(mkEvent('Digit1'), km)).toBe('squad1');
    });

    it('Digit1 with shift → order1', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 0 };
      expect(actionForEvent(mkEvent('Digit1', true), km)).toBe('order1');
    });

    it('binding without shift does NOT fire when shift is held', () => {
      const km: Keymap = { bindings: { ...DEFAULTS }, version: 0 };
      expect(actionForEvent(mkEvent('Digit1', true), km)).not.toBe('squad1');
    });
  });

  describe('formatBinding', () => {
    it('Digit3 → 3', () => expect(formatBinding({ code: 'Digit3' })).toBe('3'));
    it('KeyB → B', () => expect(formatBinding({ code: 'KeyB' })).toBe('B'));
    it('Space → Space', () => expect(formatBinding({ code: 'Space' })).toBe('Space'));
    it('Escape → Esc', () => expect(formatBinding({ code: 'Escape' })).toBe('Esc'));
    it('⇧A → ⇧A', () => expect(formatBinding({ code: 'KeyA', shift: true })).toBe('⇧A'));
  });
});

// ── formationSlots ──────────────────────────────────────────────────

describe('formationSlots', () => {
  it('count', () => {
    expect(formationSlots(1).length).toBe(1);
    expect(formationSlots(4).length).toBe(4);
    expect(formationSlots(12).length).toBe(12);
  });

  it('facing=0 spreads more along x than y', () => {
    const s = formationSlots(4, 0);
    const xs = s.map(([x]) => x);
    const ys = s.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys));
  });

  it('facing=π/2 spreads more along y', () => {
    const s = formationSlots(4, Math.PI / 2);
    const xs = s.map(([x]) => x);
    const ys = s.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs));
  });

  it('undefined matches OFFSETS prefix', () => {
    expect(formationSlots(3)).toEqual([OFFSETS[0], OFFSETS[1], OFFSETS[2]]);
  });

  it('facing=π/2 equals facing=0 rotated +90° CCW ((x,y)→(-y,x))', () => {
    const s0 = formationSlots(4, 0, 6);
    const s90 = formationSlots(4, Math.PI / 2, 6);
    expect(s0.length).toBe(4);
    expect(s90.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(s90[i][0]).toBeCloseTo(-s0[i][1], 10);
      expect(s90[i][1]).toBeCloseTo(s0[i][0], 10);
    }
    // Exact hand-computed values for facing=0, width=6: cols=4, rows=1
    expect(s0[0][0]).toBeCloseTo(-2.25); expect(s0[0][1]).toBeCloseTo(0);
    expect(s0[1][0]).toBeCloseTo(-0.75); expect(s0[1][1]).toBeCloseTo(0);
    expect(s0[2][0]).toBeCloseTo(0.75);  expect(s0[2][1]).toBeCloseTo(0);
    expect(s0[3][0]).toBeCloseTo(2.25);  expect(s0[3][1]).toBeCloseTo(0);
    // facing=π/2: same grid rotated, each (x,y) → (-y,x)
    expect(s90[0][0]).toBeCloseTo(0);     expect(s90[0][1]).toBeCloseTo(-2.25);
    expect(s90[1][0]).toBeCloseTo(0);     expect(s90[1][1]).toBeCloseTo(-0.75);
    expect(s90[2][0]).toBeCloseTo(0);     expect(s90[2][1]).toBeCloseTo(0.75);
    expect(s90[3][0]).toBeCloseTo(0);     expect(s90[3][1]).toBeCloseTo(2.25);
  });
});

// ── fanOffsets ──────────────────────────────────────────────────────

describe('fanOffsets', () => {
  it('centered spacing', () => {
    expect(fanOffsets(3, 8)).toEqual([-8, 0, 8]);
    expect(fanOffsets(2, 12)).toEqual([-6, 6]);
  });
});

// ── orderSquad with facing ──────────────────────────────────────────

describe('orderSquad with facing', () => {
  it('two-team squad destinations lie on the facing line', () => {
    const sim = new Sim(new GameMap(80, 80), 100);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 40, 40);
    sim.orderSquad(squad.id, { kind: 'move', x: 50, y: 50, facing: 0.5, width: 20 });

    const dests = squad.teamIds.map((tid) => sim.teams[tid].orderState.order!);
    expect(dests.length).toBeGreaterThanOrEqual(2);
    expect(dests[0]).toBeTruthy();
    expect(dests[1]).toBeTruthy();

    const cos = Math.cos(0.5);
    const sin = Math.sin(0.5);
    for (const d of dests) {
      const dx = d.x - 50;
      const dy = d.y - 50;
      expect(Math.abs(dx * sin - dy * cos)).toBeLessThan(0.01);
    }
  });

  it('without facing: legacy y ± 4 (TEAM_FAN/2)', () => {
    const sim = new Sim(new GameMap(80, 80), 101);
    const squad = sim.addSquadFromDef('blue', 'us_rifle', 40, 40);
    sim.orderSquad(squad.id, { kind: 'move', x: 50, y: 50 });

    const ys = squad.teamIds.map((tid) => sim.teams[tid].orderState.order!.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(46, 5);
    expect(ys[1]).toBeCloseTo(54, 5);
  });
});

// ── moveSoldiersTo with facing (via orderTeam) ──────────────────────

describe('moveSoldiersTo with facing', () => {
  it('4-man team gets paths to 4 distinct spots, wider along x', () => {
    const sim = new Sim(new GameMap(80, 80), 102);
    sim.addSquad('blue', 'a', [
      { name: 'A', weapon: 'garand', x: 30, y: 40 },
      { name: 'B', weapon: 'garand', x: 31, y: 41 },
      { name: 'C', weapon: 'garand', x: 32, y: 40 },
      { name: 'D', weapon: 'garand', x: 33, y: 41 },
    ]);
    sim.orderTeam(0, { kind: 'move', x: 50, y: 50, facing: 0, width: 6 });

    const dests = sim.soldiers
      .filter((s) => s.path && s.path.length > 0)
      .map((s) => s.path![s.path!.length - 1]);
    expect(dests.length).toBe(4);

    const keys = new Set(dests.map((d) => `${d.x.toFixed(3)},${d.y.toFixed(3)}`));
    expect(keys.size).toBe(4);

    const xs = dests.map((d) => d.x);
    const ys = dests.map((d) => d.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys));
  });
});