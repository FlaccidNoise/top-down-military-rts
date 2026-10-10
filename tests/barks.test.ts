import { describe, expect, it, vi } from 'vitest';
import { BARK, BARK_MS, Barks, BARKS_STORAGE_KEY, barkAlpha, barkPx, barksOn, MAX_BARKS, setBarksOn } from '../src/render/barks';
import { Camera } from '../src/render/camera';
import type { Sim, Soldier, UnitEvent } from '../src/sim/sim';

// Barks (src/render/barks.ts) read sim state and never write it, so a sim
// here is the handful of fields they read. Two teams of four in one blue
// squad, one red team.

type Man = Pick<Soldier, 'id' | 'side' | 'squadId' | 'teamId' | 'x' | 'y' | 'alive' | 'downed' | 'captured' | 'mental' | 'inVehicle' | 'reloading' | 'pickingUp' | 'grenadesLeft' | 'task'>;
const man = (id: number, side: 'blue' | 'red', squadId: number, teamId: number): Man => ({
  id, side, squadId, teamId, x: 50 + id, y: 50, alive: true, downed: false, captured: false, mental: 'ok' as Soldier['mental'],
  inVehicle: -1, reloading: 0, pickingUp: false, grenadesLeft: 2, task: null,
});
function world(): { sim: Sim; men: Man[]; teams: { id: number; squadId: number; soldierIds: number[]; orderState: { phase: string } }[] } {
  const men = [0, 1, 2, 3].map((i) => man(i, 'blue', 0, 0)).concat([4, 5, 6, 7].map((i) => man(i, 'blue', 0, 1)), [8, 9].map((i) => man(i, 'red', 1, 2)));
  const teams = [
    { id: 0, squadId: 0, soldierIds: [0, 1, 2, 3], orderState: { phase: 'idle' } },
    { id: 1, squadId: 0, soldierIds: [4, 5, 6, 7], orderState: { phase: 'idle' } },
    { id: 2, squadId: 1, soldierIds: [8, 9], orderState: { phase: 'idle' } },
  ];
  return { sim: { soldiers: men, teams } as unknown as Sim, men, teams };
}
const said = (b: Barks): Record<number, string> => Object.fromEntries([...b.speaking].map(([id, v]) => [id, v.kind]));
const rescue = { kind: 'rescue', casualtyId: 3, phase: 'goto', timer: 0 } as Soldier['task'];
const ev = (kind: UnitEvent['kind'], m: Man): UnitEvent => ({ kind, x: m.x, y: m.y, side: m.side, name: 'x', id: m.id });

describe('Barks.observe', () => {
  it('says nothing on the first look, whatever the men are doing', () => {
    const { sim, men, teams } = world();
    men[0].reloading = 2;
    men[1].task = rescue;
    teams[0].orderState.phase = 'balked';
    const b = new Barks();
    b.observe(sim, 0);
    expect(b.speaking.size).toBe(0);
  });

  it('calls MEDIC! when a rescue starts, GRENADE! on a throw, RELOADING on a reload', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.observe(sim, 0);
    men[1].task = rescue;
    men[2].grenadesLeft = 1;
    men[4].reloading = 2.5;
    b.observe(sim, 100);
    expect(said(b)).toEqual({ 1: 'medic', 2: 'grenade', 4: 'reloading' });
    // a state that merely continues is not said again
    b.observe(sim, 100 + BARK_MS);
    expect(b.speaking.size).toBe(0);
  });

  it('does not take a weapon pickup for a reload', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.observe(sim, 0);
    men[0].reloading = 3;
    men[0].pickingUp = true;
    b.observe(sim, 100);
    expect(b.speaking.size).toBe(0);
  });

  it('keeps a kind quiet per team: two men reloading together is one RELOADING, the other team still speaks', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.observe(sim, 0);
    men[0].reloading = 2;
    men[1].reloading = 2;
    men[5].reloading = 2;
    b.observe(sim, 100);
    expect(said(b)).toEqual({ 0: 'reloading', 5: 'reloading' });
    men[0].reloading = 0;
    b.observe(sim, 3000);
    men[0].reloading = 2;
    b.observe(sim, 3100);
    expect(b.speaking.size).toBe(0); // inside the 12 s quiet
    men[0].reloading = 0;
    b.observe(sim, 3200);
    men[0].reloading = 2;
    b.observe(sim, 100 + BARK.reloading.quiet * 1000);
    expect(said(b)).toEqual({ 0: 'reloading' });
  });

  it('gives a man one word at a time: an alarm takes it from RELOADING, never the other way', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.observe(sim, 0);
    men[0].reloading = 2;
    b.observe(sim, 100);
    expect(said(b)).toEqual({ 0: 'reloading' });
    men[0].task = rescue;
    men[4].task = rescue;
    b.observe(sim, 200);
    expect(said(b)).toEqual({ 0: 'medic', 4: 'medic' });
    men[4].reloading = 2;
    b.observe(sim, 300);
    expect(said(b)).toEqual({ 0: 'medic', 4: 'medic' });
  });

  it('names the two halves of a bounding team, and swaps them when the bound swaps', () => {
    const { sim, teams } = world();
    const b = new Barks();
    b.observe(sim, 0);
    teams[0].orderState.phase = 'bounding_a';
    b.observe(sim, 100);
    expect(said(b)).toEqual({ 0: 'moving', 2: 'covering' });
    teams[0].orderState.phase = 'bounding_b';
    b.observe(sim, 100 + BARK.moving.quiet * 1000);
    expect(said(b)).toEqual({ 2: 'moving', 0: 'covering' });
  });

  it("says WON'T GO over the first man standing when a team balks", () => {
    const { sim, men, teams } = world();
    men[4].downed = true;
    const b = new Barks();
    b.observe(sim, 0);
    teams[1].orderState.phase = 'balked';
    b.observe(sim, 100);
    expect(said(b)).toEqual({ 5: 'balk' });
  });

  it('never speaks for the enemy, a man in a hull, or a man who is down', () => {
    const { sim, men, teams } = world();
    men[1].inVehicle = 0;
    men[2].downed = true;
    const b = new Barks();
    b.observe(sim, 0);
    for (const i of [1, 2, 8, 9]) men[i].reloading = 2;
    men[8].grenadesLeft = 0;
    teams[2].orderState.phase = 'balked';
    b.observe(sim, 100);
    expect(b.speaking.size).toBe(0);
  });

  it('drops a bark when its life is over, when its man falls, and on a clock that is not a number', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.observe(sim, 0);
    men[0].reloading = 2;
    men[5].reloading = 2;
    b.observe(sim, 100);
    men[5].alive = false;
    b.observe(sim, 200);
    expect(said(b)).toEqual({ 0: 'reloading' });
    b.observe(sim, 100 + BARK_MS);
    expect(b.speaking.size).toBe(0);
    men[6].task = rescue;
    b.observe(sim, NaN);
    expect(b.speaking.size).toBe(0);
  });
});

describe('Barks.addUnitEvents', () => {
  it('has the nearest squadmate on his feet call MAN DOWN, not the man who fell', () => {
    const { sim, men } = world();
    men[3].downed = true;
    men[2].downed = true; // nearer, but in no state to call it
    const b = new Barks();
    b.addUnitEvents([ev('downed', men[3])], sim, 100);
    expect(said(b)).toEqual({ 4: 'mandown' });
  });

  it('says nothing when the nearest squadmate is out of earshot or the casualty is the enemy', () => {
    const { sim, men } = world();
    for (const m of men) if (m.id !== 3 && m.side === 'blue') m.x += 60;
    const b = new Barks();
    b.addUnitEvents([ev('kia', men[3]), ev('kia', men[8])], sim, 100);
    expect(b.speaking.size).toBe(0);
  });

  it('speaks the quiet recoveries over the man they happened to', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.addUnitEvents([ev('promoted', men[1]), ev('recovered', men[5]), ev('resupplied', men[8]), ev('pinned', men[2])], sim, 100);
    expect(said(b)).toEqual({ 1: 'promoted', 5: 'recovered' });
  });
});

describe('Barks.shown', () => {
  it('caps what is on screen, alarms first, and does not count men out of view', () => {
    const { sim, men } = world();
    const b = new Barks();
    b.observe(sim, 0);
    for (const i of [0, 4]) men[i].reloading = 2;
    men[5].task = rescue;
    b.observe(sim, 100);
    const cam = new Camera(53, 50);
    cam.scale = 14;
    expect(b.shown(cam, sim, 200, 400, 300).map((v) => v.kind)).toEqual(['medic', 'reloading', 'reloading']);
    expect(b.shown(cam, sim, 200, 400, 300, 1).map((v) => v.s.id)).toEqual([5]);
    cam.x = 500; // the men are off screen
    expect(b.shown(cam, sim, 200, 400, 300)).toEqual([]);
    expect(MAX_BARKS).toBeGreaterThanOrEqual(5);
  });
});

describe('bark type', () => {
  it('fades in fast, holds, fades out, and is zero outside its life or on a bad age', () => {
    expect(barkAlpha(0)).toBe(0);
    expect(barkAlpha(45)).toBeCloseTo(0.5);
    expect(barkAlpha(600)).toBe(1);
    expect(barkAlpha(BARK_MS - 150)).toBeCloseTo(0.5);
    expect(barkAlpha(BARK_MS)).toBe(0);
    expect(barkAlpha(-1)).toBe(0);
    expect(barkAlpha(NaN)).toBe(0);
  });

  it('follows the zoom between a legible floor, higher on a phone, and a caption ceiling', () => {
    expect(barkPx(6, false)).toBe(10);
    expect(barkPx(6, true)).toBe(11);
    expect(barkPx(24, false)).toBe(12);
    expect(barkPx(48, false)).toBe(13);
  });
});

describe('the barks setting', () => {
  it('is on until switched off, and the switch is stored', () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(barksOn(store)).toBe(true);
    setBarksOn(false, store);
    expect(barksOn(store)).toBe(false);
    expect(data.get(BARKS_STORAGE_KEY)).toBe('0');
    setBarksOn(true, store);
    expect(barksOn(store)).toBe(true);
    expect(data.get(BARKS_STORAGE_KEY)).toBe('1');
  });

  it('reads a stored off at start', async () => {
    vi.resetModules();
    const fresh = await import('../src/render/barks');
    expect(fresh.barksOn({ getItem: () => '0', setItem: () => {} })).toBe(false);
  });
});
