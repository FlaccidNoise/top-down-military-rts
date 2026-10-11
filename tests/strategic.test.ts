import { describe, expect, it } from 'vitest';
import { advanceDays, newCampaign, squadMembers } from '../src/campaign/campaign';
import { Front, findPath, formatClock, chitEtaMinutes, operationStatus, OP_START_MIN, OP_DEADLINE_DAYS } from '../src/strategic/front';
import { cellIndex, makeDefaultSector, parseSector } from '../src/strategic/sector';
import { applyEngagementOutcome, LOSER_LOSS, makeStrategicBattle, newFront, resolveCoarse, syncStrengths, trivialMismatchWinner, WINNER_LOSS_CAP } from '../src/strategic/bridge';
import { loadGame, saveGame } from '../src/strategic/save';
import { StrategicView } from '../src/render/strategic';
import type { Sim } from '../src/sim/sim';

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

  it('river fords: transit at assault cost, never a destination, captured in passing', () => {
    const s = makeDefaultSector();
    const f = new Front(s);
    const chit = f.addChit({ side: 'blue', name: 'Able', cell: cellIndex(s, 19, 10), strength: 27, companyIndex: 0 });
    expect(f.orderMove(chit.id, cellIndex(s, 20, 10))).toBe(false); // can't stop in the water
    expect(f.orderMove(chit.id, cellIndex(s, 21, 10))).toBe(true);
    expect(chit.path).toEqual([cellIndex(s, 20, 10), cellIndex(s, 21, 10)]); // direct ford beats the 10-cell bridge detour
    expect(chitEtaMinutes(f, chit)).toBe(75); // 60 wading + 15 open
    for (let i = 0; i < 75; i++) expect(f.step()).toBeNull();
    expect(chit.cell).toBe(cellIndex(s, 21, 10));
    expect(s.cells[cellIndex(s, 20, 10)].owner).toBe('blue');
  });

  it('contact mid-ford: an enemy in the river cell yields a river-cell engagement', () => {
    const s = makeDefaultSector();
    const f = new Front(s);
    const blue = f.addChit({ side: 'blue', name: 'Able', cell: cellIndex(s, 19, 10), strength: 27, companyIndex: 0 });
    const red = f.addChit({ side: 'red', name: 'Gruppe', cell: cellIndex(s, 20, 10), strength: 18, companyIndex: -1 });
    f.orderMove(blue.id, cellIndex(s, 21, 10));
    let e = null;
    for (let i = 0; i < 200 && !e; i++) e = f.step();
    expect(e).toEqual({ attackerId: blue.id, defenderId: red.id, cell: cellIndex(s, 20, 10) });
    expect(s.cells[e!.cell].terrain).toBe('river');
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
    // Armour and gun crews are establishment men (pid -1) fielded on top of
    // the roster and the chit counter — a bridge cell is an armour kind.
    const blue = sim.soldiers.filter((s) => s.side === 'blue' && s.pid > 0);
    const red = sim.soldiers.filter((s) => s.side === 'red');
    expect(blue.length).toBe(138);
    expect(red.length).toBe(36 + 6); // prefix of de_grenadier_co TO&E by strength: 4x 9-man Gruppen, + PaK 40 crew
    const [a, b] = blue;
    expect(a.bonds[b.id]).toBeCloseTo(0.3); // trained-together, wired from campaign
  });

  // Vehicles reached a Sim only through the test-only scenario path until now:
  // sim.vehicles was empty in every campaign battle, so every AT weapon on the
  // field was structurally dead.
  it('an armour-kind engagement fields the attacker armour section and the defender AT gun', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const reserve = front.chits.find((ch) => ch.name === 'Reserve')!;
    const e = { attackerId: able.id, defenderId: reserve.id, cell: reserve.cell };
    expect(front.sector.cells[e.cell].terrain).toBe('road');
    const { sim } = makeStrategicBattle(c, front, e, 11);

    expect(sim.vehicles.map((v) => v.kind)).toEqual(['sherman', 'm3_halftrack']);
    expect(sim.vehicles.every((v) => v.side === 'blue' && v.alive)).toBe(true);
    // Staged on ground a hull may actually occupy — an illegal start tile
    // finds no route out and parks the vehicle for the whole battle.
    for (const v of sim.vehicles) {
      const t = sim.map.terrainAt(Math.floor(v.x), Math.floor(v.y));
      expect(t.passable && !t.noVehicle).toBe(true);
    }
    expect(new Set(sim.vehicles.map((v) => `${Math.floor(v.x)},${Math.floor(v.y)}`)).size).toBe(2); // no stacking

    const gun = sim.emplacements.find((em) => em.kind === 'pak40')!;
    expect(gun.side).toBe('red');
    expect(gun.state).toBe('deployed');
    expect(sim.teams[gun.crewTeamId].soldierIds.length).toBe(6);
    expect(Math.abs(gun.facing)).toBeGreaterThan(Math.PI / 2); // laid on the western approach
    expect(sim.emplacements.some((em) => em.kind === 'at57')).toBe(false); // blue attacks: no blue gun
  });

  it('woods and river engagements stay infantry fights', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const reserve = front.chits.find((ch) => ch.name === 'Reserve')!;
    reserve.cell = cellIndex(front.sector, 23, 3); // woods
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: reserve.id, cell: reserve.cell }, 11);
    expect(sim.vehicles.length).toBe(0);
    expect(sim.emplacements.some((em) => em.kind === 'pak40')).toBe(false);
  });

  it('staging an armour engagement twice is identical', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const reserve = front.chits.find((ch) => ch.name === 'Reserve')!;
    const e = { attackerId: able.id, defenderId: reserve.id, cell: reserve.cell };
    const print = (s: Sim) =>
      JSON.stringify([
        s.soldiers.map((x) => [x.side, x.name, x.pid, x.x, x.y, x.courage, x.inVehicle]),
        s.vehicles.map((v) => [v.side, v.kind, v.x, v.y, v.facing]),
        s.emplacements.map((m) => [m.side, m.kind, m.x, m.y, m.facing, m.state]),
      ]);
    expect(print(makeStrategicBattle(c, front, e, 11).sim)).toBe(print(makeStrategicBattle(c, front, e, 11).sim));
  });

  it('an engagement on a river cell fights on the river battle map', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const reserve = front.chits.find((ch) => ch.name === 'Reserve')!;
    reserve.cell = cellIndex(front.sector, 20, 10); // caught mid-ford
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: reserve.id, cell: reserve.cell }, 5);
    let water = 0;
    for (let y = 0; y < sim.map.h; y++)
      for (let x = 0; x < sim.map.w; x++) if (sim.map.terrainKeyAt(x, y) === 'water') water++;
    expect(water).toBeGreaterThan(800); // the 5-wide 'river' band, not bridge's 3
  });

  it('a ford assault fights on the river map with a suppressed, fatigued attacker', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const garrison = front.chits.find((ch) => ch.name === 'Garnison Vireux')!; // town cell, no water of its own
    able.cell = cellIndex(front.sector, 20, 10); // halted mid-ford, assaulting out of the water
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: garrison.id, cell: garrison.cell }, 5);
    let water = 0;
    for (let y = 0; y < sim.map.h; y++)
      for (let x = 0; x < sim.map.w; x++) if (sim.map.terrainKeyAt(x, y) === 'water') water++;
    expect(water).toBeGreaterThan(800); // river archetype, not the contested cell's town ground
    const blue = sim.soldiers.filter((s) => s.side === 'blue');
    expect(blue.length).toBe(138);
    expect(blue.every((s) => s.suppression >= 0.45)).toBe(true);
    expect(blue.every((s) => s.stamina <= 0.65)).toBe(true);
    const red = sim.soldiers.filter((s) => s.side === 'red');
    expect(red.every((s) => s.suppression === 0 && s.stamina === 1)).toBe(true); // defenders are settled
  });

  it('a land approach to the same garrison carries no ford penalty', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const garrison = front.chits.find((ch) => ch.name === 'Garnison Vireux')!;
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: garrison.id, cell: garrison.cell }, 5);
    const blue = sim.soldiers.filter((s) => s.side === 'blue');
    expect(blue.every((s) => s.suppression === 0)).toBe(true);
    expect(blue.every((s) => s.stamina === 1)).toBe(true);
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
    expect(out.redLosses).toBe(36 + 6); // garrison + the PaK 40 crew
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

  it('a lost ford assault retreats the attacker off the river cell', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const garrison = front.chits.find((ch) => ch.name === 'Garnison Vireux')!;
    able.cell = cellIndex(front.sector, 20, 10); // halted mid-ford
    const e = { attackerId: able.id, defenderId: garrison.id, cell: garrison.cell };
    const { sim } = makeStrategicBattle(c, front, e, 5);
    sim.winner = 'red'; // beaten back with survivors
    applyEngagementOutcome(c, front, e, sim);
    // never rests on open water: retreated to a friendly bank cell, or overrun
    expect(able.strength === 0 || front.sector.cells[able.cell].terrain !== 'river').toBe(true);
    if (able.strength > 0) expect(front.sector.cells[able.cell].owner).toBe('blue');
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

  it('trivialMismatchWinner guards zero strength and fires only past the 5x ratio', () => {
    const { front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!; // 138
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!; // 36, ~3.8x — below threshold
    expect(trivialMismatchWinner(able, wache)).toBeNull();
    wache.strength = 0;
    expect(trivialMismatchWinner(able, wache)).toBeNull(); // never divide by zero
    wache.strength = 20; // 138 / 20 = 6.9x
    expect(trivialMismatchWinner(able, wache)).toBe('attacker');
    expect(trivialMismatchWinner(wache, able)).toBe('defender');
  });

  it('forced and unforced resolution of the same foregone conclusion leave an identical world (S6)', () => {
    // Accepting the offered walkover must not fork the war: the forced path
    // draws the winner roll it ignores, so every later draw — loss bands,
    // roster picks, the NEXT battle — lands identically.
    const world = () => {
      const c = newCampaign(10);
      const front = newFront(c, makeDefaultSector());
      const able = front.chits.find((ch) => ch.side === 'blue')!;
      const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
      wache.strength = 20; // 6.9x — a genuine trivial mismatch
      return { c, front, able, wache };
    };
    const A = world(); // player accepts the auto-resolve offer
    const B = world(); // player fights out the same foregone conclusion
    const e = (w: ReturnType<typeof world>) => ({ attackerId: w.able.id, defenderId: w.wache.id, cell: w.wache.cell });
    const rA = resolveCoarse(A.c, A.front, e(A), 'attacker');
    const rB = resolveCoarse(B.c, B.front, e(B));
    expect(rA.attackerWon).toBe(true);
    expect(rB.attackerWon).toBe(true); // premise: the unforced roll agrees at this seed
    expect(A.able.strength).toBe(B.able.strength);
    expect(A.wache.strength).toBe(B.wache.strength);
    expect(rA.record).toEqual(rB.record);
    // The second engagement is the point: identical worlds resolve identically.
    const second = (w: ReturnType<typeof world>) => {
      const red = w.front.chits.find((ch) => ch.side === 'red' && ch.strength > 0 && ch.id !== w.wache.id)!;
      return resolveCoarse(w.c, w.front, { attackerId: w.able.id, defenderId: red.id, cell: red.cell });
    };
    const sA = second(A);
    const sB = second(B);
    expect(sA.record).toEqual(sB.record);
    expect(sA.attackerWon).toBe(sB.attackerWon);
  });

  it('nightMult is a parameter: it bites below civil dusk and is inert at noon', () => {
    // The mult moves the WIN THRESHOLD, so post-state only differs when the
    // seeded roll lands between the two scores — scan seeds until one splits.
    const world = (seed: number, clockMin: number) => {
      const c = newCampaign(seed);
      const front = newFront(c, makeDefaultSector());
      front.clockMin = clockMin;
      const able = front.chits.find((ch) => ch.side === 'blue')!;
      const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
      const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
      return { c, front, e, able, wache };
    };
    const night = 2 * 60; // 02:00 — well below the lightAt 0.25 band
    const noon = 13 * 60;
    let split = -1;
    for (let seed = 1; seed <= 50 && split < 0; seed++) {
      const a = world(seed, night);
      const b = world(seed, night);
      const ra = resolveCoarse(a.c, a.front, a.e, undefined, 1.0);
      const rb = resolveCoarse(b.c, b.front, b.e, undefined, 6.0);
      if (ra.attackerWon !== rb.attackerWon) split = seed;
      // Inert at noon for every seed scanned, split or not:
      const d1 = world(seed, noon);
      const d6 = world(seed, noon);
      resolveCoarse(d1.c, d1.front, d1.e, undefined, 1.0);
      resolveCoarse(d6.c, d6.front, d6.e, undefined, 6.0);
      expect([d1.able.strength, d1.wache.strength]).toEqual([d6.able.strength, d6.wache.strength]);
    }
    expect(split, 'no seed in 1..50 split the night threshold — the parameter is dead').toBeGreaterThan(0);
  });

  it('bridge.ts holds no module-level mutable state (the nightMult global died with S6)', () => {
    // @ts-expect-error no @types/node here; node:fs resolves under vitest
    // eslint-disable-next-line
    const { readFileSync } = require('node:fs');
    const src = readFileSync(new URL('../src/strategic/bridge.ts', import.meta.url), 'utf8');
    expect(src.match(/^let /m)).toBe(null);
  });

  it('resolveCoarse forcedWinner is deterministic, losses within the loss-model bands', () => {
    const run = () => {
      const c = newCampaign(10);
      const front = newFront(c, makeDefaultSector());
      const able = front.chits.find((ch) => ch.side === 'blue')!;
      const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
      wache.strength = 500; // would win the roll unforced; force the attacker anyway
      const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
      const result = resolveCoarse(c, front, e, 'attacker');
      return { attackerWon: result.attackerWon, ableStrength: able.strength, wacheStrength: wache.strength };
    };
    const a = run();
    expect(a).toEqual(run()); // same seed, same forced outcome, same losses
    expect(a.attackerWon).toBe(true);
    // The winner's losses follow the loser's strength, and 500 men cost more than the cap: it loses the cap.
    expect(a.ableStrength).toBe(138 - Math.floor(138 * WINNER_LOSS_CAP));
    expect(a.wacheStrength).toBeGreaterThanOrEqual(500 - Math.ceil(500 * LOSER_LOSS[1]));
    expect(a.wacheStrength).toBeLessThanOrEqual(500 - Math.floor(500 * LOSER_LOSS[0]));
  });
});

describe('strategic view', () => {
  it('cellAtScreen inverts layout', () => {
    const view = new StrategicView(makeDefaultSector());
    const { size, ox, oy } = view.layout(800, 650);
    expect(view.cellAtScreen(ox + size * 4 + 1, oy + size * 15 + 1, 800, 650)).toBe(15 * 40 + 4);
    expect(view.cellAtScreen(0, 0, 800, 650)).toBe(-1);
  });

  it('default camera reproduces the fit-only layout exactly', () => {
    const view = new StrategicView(makeDefaultSector());
    expect(view.zoomMul).toBe(1);
    expect(view.panX).toBe(0);
    expect(view.panY).toBe(0);
    const size = Math.max(4, Math.floor(Math.min(1280 / 40, (800 - 34 - 24) / 30)));
    expect(view.layout(1280, 800)).toEqual({ size, ox: Math.floor((1280 - size * 40) / 2), oy: 34 });
  });

  it('clampPan is a no-op while the grid fits — desktop pans stay at zero', () => {
    const view = new StrategicView(makeDefaultSector());
    const before = view.layout(1280, 800);
    view.clampPan(1280, 800);
    expect(view.panX).toBe(0);
    expect(view.panY).toBe(0);
    expect(view.layout(1280, 800)).toEqual(before);
  });

  it('a tap at a cell centre round-trips under a non-default zoom and pan', () => {
    const view = new StrategicView(makeDefaultSector());
    view.zoomMul = 2.75;
    view.panX = -140;
    view.panY = -96;
    const { size, ox, oy } = view.layout(390, 844);
    for (const [cx, cy] of [
      [4, 15],
      [20, 7],
      [39, 29],
      [0, 0],
    ]) {
      const sx = ox + (cx + 0.5) * size;
      const sy = oy + (cy + 0.5) * size;
      expect(view.cellAtScreen(sx, sy, 390, 844)).toBe(cy * 40 + cx);
    }
  });

  it('frameFor zooms a phone viewport to a tappable cell and keeps the chits on screen', () => {
    const view = new StrategicView(makeDefaultSector());
    const cells = [cellIndex(view.sector, 4, 12), cellIndex(view.sector, 4, 15), cellIndex(view.sector, 4, 18)];
    view.frameFor(390, 844, cells);
    const { size, ox, oy } = view.layout(390, 844);
    expect(size).toBeGreaterThanOrEqual(26);
    for (const c of cells) {
      const x = c % 40;
      const y = (c / 40) | 0;
      const sx = ox + (x + 0.5) * size;
      const sy = oy + (y + 0.5) * size;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(390);
      expect(sy).toBeGreaterThanOrEqual(34);
      expect(sy).toBeLessThanOrEqual(844 - 24);
      expect(view.cellAtScreen(sx, sy, 390, 844)).toBe(c);
    }
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
