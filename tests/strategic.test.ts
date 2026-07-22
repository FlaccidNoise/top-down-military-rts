import { describe, expect, it } from 'vitest';
import { Front, findPath, operationStatus, OP_START_MIN, OP_DEADLINE_DAYS } from '../src/strategic/front';
import { cellIndex, makeDefaultSector, parseSector } from '../src/strategic/sector';

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
