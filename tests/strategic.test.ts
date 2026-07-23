import { describe, expect, it } from 'vitest';
import { advanceDays, newCampaign, squadMembers } from '../src/campaign/campaign';
import { Front, findPath, formatClock, chitEtaMinutes, operationStatus, OP_START_MIN, OP_DEADLINE_DAYS } from '../src/strategic/front';
import { cellIndex, makeDefaultSector, parseSector } from '../src/strategic/sector';
import { applyEngagementOutcome, makeStrategicBattle, newFront, syncStrengths } from '../src/strategic/bridge';
import { loadGame, saveGame } from '../src/strategic/save';
import { StrategicView } from '../src/render/strategic';

describe('sector', () => {
  it('parses the default sector: 40×30, river neutral, bridges, objective town', () => {
    const s = makeDefaultSector();
    expect(s.w).toBe(40);
    expect(s.h).toBe(30);
    expect(s.cells[cellIndex(s, 20, 9)].terrain).toBe('river');
    expect(s.cells[cellIndex(s, 20, 9)].owner).toBeNull();
    expect(s.cells[cellIndex(s, 20, 15)].terrain).toBe('bridge');
    expect(s.cells[cellIndex(s, 20, 7)].terrain).toBe('bridge');
    expect(s.cells[cellIndex(s, 4, 15)].terrain).toBe('road');
    expect(s.cells[cellIndex(s, 4, 15)].owner).toBe('blue');
    const objectives = s.cells.filter((c) => c.objective);
    expect(objectives.length).toBe(9); // St-Aubin, 3×3
    expect(objectives.every((c) => c.owner === 'red')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => parseSector(['..', '.'], 1, 'bad')).toThrow(/length/);
    expect(() => parseSector(['.x'], 1, 'bad')).toThrow(/unknown sector char/);
  });
});

describe('front', () => {
  const miniSector = () => parseSector(['rrrr'], 2, 'mini'); // 4×1 road; x<2 blue

  it('paths cross the river only at bridges', () => {
    const s = makeDefaultSector();
    const path = findPath(s, cellIndex(s, 4, 15), cellIndex(s, 25, 15))!;
    expect(path).toContain(cellIndex(s, 20, 15));
    expect(path.some((i) => s.cells[i].terrain === 'river')).toBe(false);
  });

  it('moves at terrain speed and captures entered cells', () => {
    const s = miniSector();
    const f = new Front(s);
    const chit = f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    expect(f.orderMove(chit.id, 3)).toBe(true);
    for (let i = 0; i < 10; i++) expect(f.step()).toBeNull(); // road = 10 min/cell
    expect(chit.cell).toBe(1);
    for (let i = 0; i < 20; i++) f.step();
    expect(chit.cell).toBe(3);
    expect(chit.path.length).toBe(0);
    expect(s.cells[2].owner).toBe('blue'); // was red, captured in passing
    expect(s.cells[3].owner).toBe('blue');
  });

  it('contact: reaching an enemy-held cell halts the mover and returns an engagement', () => {
    const s = miniSector();
    const f = new Front(s);
    const blue = f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    const red = f.addChit({ side: 'red', name: 'Gruppe', cell: 2, strength: 18, companyIndex: -1 });
    f.orderMove(blue.id, 3);
    let e = null;
    for (let i = 0; i < 200 && !e; i++) e = f.step();
    expect(e).toEqual({ attackerId: blue.id, defenderId: red.id, cell: 2 });
    expect(blue.cell).toBe(1); // halted short of the contested cell
    expect(blue.path.length).toBe(0);
    expect(s.cells[2].owner).toBe('red'); // not captured
  });

  it('clock: day rolls at midnight, hhmm formats', () => {
    const f = new Front(miniSector());
    expect(f.clockMin).toBe(OP_START_MIN);
    expect(f.day).toBe(1);
    expect(f.hhmm).toBe('0600');
    for (let i = 0; i < 18 * 60; i++) f.step(); // 06:00 + 18 h = midnight
    expect(f.day).toBe(2);
    expect(f.hhmm).toBe('0000');
  });

  it('operationStatus: objectives won, deadline and annihilation lost', () => {
    const s = parseSector(['.T'], 1, 'tiny');
    const f = new Front(s);
    f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    expect(operationStatus(f)).toBe('ongoing');
    s.cells[1].owner = 'blue';
    expect(operationStatus(f)).toBe('won');
    s.cells[1].owner = 'red';
    f.clockMin = OP_DEADLINE_DAYS * 1440 + 1;
    expect(operationStatus(f)).toBe('lost');
    f.clockMin = OP_START_MIN;
    f.chits[0].strength = 0;
    expect(operationStatus(f)).toBe('lost');
  });

  it('formatClock: converts absolute minutes to day/hhmm, rolling at midnight', () => {
    expect(formatClock(0)).toEqual({ day: 1, hhmm: '0000' });
    expect(formatClock(1440)).toEqual({ day: 2, hhmm: '0000' });
    expect(formatClock(OP_START_MIN)).toEqual({ day: 1, hhmm: '0600' });
  });

  it('chitEtaMinutes: sums remaining path cost minus progress on the current leg', () => {
    const s = miniSector();
    const f = new Front(s);
    const chit = f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    expect(chitEtaMinutes(f, chit)).toBe(0); // idle, no path
    f.orderMove(chit.id, 3);
    expect(chitEtaMinutes(f, chit)).toBe(30); // 3 road cells * 10 min
    for (let i = 0; i < 4; i++) f.step();
    expect(chitEtaMinutes(f, chit)).toBe(26);
    for (let i = 0; i < 6; i++) f.step(); // completes the first leg into cell 1
    expect(chit.cell).toBe(1);
    expect(chitEtaMinutes(f, chit)).toBe(20);
  });

  it('save/restore roundtrips through JSON', () => {
    const s = makeDefaultSector();
    const f = new Front(s);
    const chit = f.addChit({ side: 'blue', name: 'Able', cell: cellIndex(s, 4, 15), strength: 27, companyIndex: 0 });
    f.orderMove(chit.id, cellIndex(s, 10, 15));
    for (let i = 0; i < 25; i++) f.step();
    const raw = JSON.parse(JSON.stringify(f.save()));
    const g = Front.restore(makeDefaultSector(), raw);
    expect(g.clockMin).toBe(f.clockMin);
    expect(g.chits).toEqual(f.chits);
    expect(g.sector.cells.map((c) => c.owner)).toEqual(f.sector.cells.map((c) => c.owner));
  });
});

describe('bridge', () => {
  const setup = () => {
    const c = newCampaign(10);
    const sector = makeDefaultSector();
    const front = newFront(c, sector);
    return { c, sector, front };
  };

  it('newFront fields 3 blue companies at strength 138 and 5 sized garrisons', () => {
    const { front } = setup();
    const blue = front.chits.filter((ch) => ch.side === 'blue');
    expect(blue.length).toBe(3);
    expect(blue.every((ch) => ch.strength === 138)).toBe(true);
    const red = front.chits.filter((ch) => ch.side === 'red');
    expect(red.length).toBe(5);
    const strengthByName = Object.fromEntries(red.map((ch) => [ch.name, ch.strength]));
    expect(strengthByName).toEqual({
      'Brückenwache Süd': 36,
      'Garnison St-Aubin': 109,
      'Brückenwache Nord': 36,
      'Garnison Vireux': 109,
      Reserve: 109,
    });
  });

  it('a strategic battle fields the company roster with pids and bonds against a sized garrison', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: wache.id, cell: wache.cell }, 5);
    const blue = sim.soldiers.filter((s) => s.side === 'blue');
    const red = sim.soldiers.filter((s) => s.side === 'red');
    expect(blue.length).toBe(138);
    expect(blue.every((s) => s.pid > 0)).toBe(true);
    expect(red.length).toBe(36); // prefix of de_grenadier_co TO&E by strength: 4x 9-man Gruppen
    const [a, b] = blue;
    expect(a.bonds[b.id]).toBeCloseTo(0.3); // trained-together, wired from campaign
  });

  it('a won battle takes the cell, moves the attacker in, and attrits the garrison away', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
    const { sim } = makeStrategicBattle(c, front, e, 6);
    for (const s of sim.soldiers) if (s.side === 'red') s.alive = false;
    sim.step();
    expect(sim.winner).toBe('blue');
    const out = applyEngagementOutcome(c, front, e, sim);
    expect(out.cellTaken).toBe(true);
    expect(out.redLosses).toBe(36);
    expect(front.sector.cells[e.cell].owner).toBe('blue');
    expect(able.cell).toBe(e.cell);
    expect(front.chits.find((ch) => ch.name === 'Brückenwache Süd')).toBeUndefined();
    expect(c.log.length).toBe(1);
  });

  it('a lost battle leaves the map unchanged and prunes a wiped company', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
    const { sim } = makeStrategicBattle(c, front, e, 7);
    for (const s of sim.soldiers) if (s.side === 'blue') s.alive = false;
    sim.step();
    expect(sim.winner).toBe('red');
    const out = applyEngagementOutcome(c, front, e, sim);
    expect(out.cellTaken).toBe(false);
    expect(front.sector.cells[e.cell].owner).toBe('red');
    expect(front.chits.filter((ch) => ch.side === 'blue').length).toBe(2); // Able wiped, pruned
  });

  it('saveGame/loadGame roundtrips campaign and front', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const { c, front } = setup();
    saveGame(c, front, storage);
    const loaded = loadGame(storage)!;
    expect(loaded.campaign).toEqual(c);
    expect(loaded.front.chits).toEqual(front.chits);
    expect(loaded.front.clockMin).toBe(front.clockMin);
  });

  it('an all-wounded company stays on the map and recovers strength', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    for (const si of c.companies[able.companyIndex].squads)
      for (const pid of squadMembers(c.squads[si])) {
        c.soldiers[pid].status = 'recovering';
        c.soldiers[pid].recoveryDays = 1;
      }
    syncStrengths(c, front);
    expect(front.chits.find((ch) => ch.id === able.id)).toBeDefined();
    expect(able.strength).toBe(0);
    advanceDays(c, 1);
    syncStrengths(c, front);
    expect(able.strength).toBe(138);
  });
});

describe('strategic view', () => {
  it('cellAtScreen inverts layout', () => {
    const view = new StrategicView(makeDefaultSector());
    const { size, ox, oy } = view.layout(800, 650);
    expect(view.cellAtScreen(ox + size * 4 + 1, oy + size * 15 + 1, 800, 650)).toBe(15 * 40 + 4);
    expect(view.cellAtScreen(0, 0, 800, 650)).toBe(-1);
  });
});

describe('m-a loop', () => {
  it('order → march → contact → battle → outcome → objective → won', () => {
    const c = newCampaign(10);
    const sector = makeDefaultSector();
    const front = newFront(c, sector);
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    front.orderMove(able.id, cellIndex(sector, 20, 15));
    let e = null;
    for (let i = 0; i < 100000 && !e; i++) e = front.step();
    expect(e).not.toBeNull();
    expect(e!.cell).toBe(cellIndex(sector, 20, 15));
    const seed = front.clockMin * 7919 + e!.cell;
    const { sim } = makeStrategicBattle(c, front, e!, seed);
    for (const s of sim.soldiers) if (s.side === 'red') s.alive = false;
    sim.step();
    const out = applyEngagementOutcome(c, front, e!, sim);
    expect(out.cellTaken).toBe(true);
    expect(able.cell).toBe(cellIndex(sector, 20, 15));
    expect(operationStatus(front)).toBe('ongoing');
    for (const cell of sector.cells) if (cell.objective) cell.owner = 'blue';
    expect(operationStatus(front)).toBe('won');
  });
});
