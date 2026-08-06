import { describe, expect, it } from 'vitest';
import { advanceDays, fillReplacements, newCampaign } from '../src/campaign/campaign';
import { Front, REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY, operationStatus } from '../src/strategic/front';
import { cellIndex, parseSector, makeDefaultSector, cellXY } from '../src/strategic/sector';
import { newFront, makeStrategicBattle, applyEngagementOutcome, resolveCoarse, syncStrengths, retreat } from '../src/strategic/bridge';
import { StrategicCommander, RED_DEFENDER, BLUE_ATTACKER } from '../src/strategic/command';

function fordSector() {
  return parseSector([
    '....~.....',
    '....~.....',
    '....~.....',
    '....~.....',
    '....~.....',
  ], 4, 'ford-test');
}

describe('StrategicCommander', () => {
  describe('red defender', () => {
    it('ford screening: red garrison moves to bank cell when blue approaches unguarded ford', () => {
      const c = newCampaign(1);
      const sector = fordSector();
      const front = new Front(sector);
      const red = front.addChit({ side: 'red', name: 'Garrison', cell: cellIndex(sector, 6, 2), strength: 50, companyIndex: -1 });
      front.addChit({ side: 'blue', name: 'Able', cell: cellIndex(sector, 1, 2), strength: 100, companyIndex: 0 });

      const cmd = new StrategicCommander('red', RED_DEFENDER);
      cmd.evaluate(front);

      expect(red.path.length).toBeGreaterThan(0);
      const dest = red.path[red.path.length - 1];
      expect(sector.cells[dest].terrain).not.toBe('river');
      const { x, y } = cellXY(sector, dest);
      const nearRiver = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
        const nx = x+dx, ny = y+dy;
        return nx >= 0 && ny >= 0 && nx < sector.w && ny < sector.h && sector.cells[cellIndex(sector,nx,ny)].terrain === 'river';
      });
      expect(nearRiver).toBe(true);
      expect(x).toBeGreaterThan(4);
    });

    it('screening never leaves a red path ending on a river cell (500-minute run)', () => {
      const c = newCampaign(1);
      const sector = fordSector();
      const front = new Front(sector);
      front.addChit({ side: 'red', name: 'G1', cell: cellIndex(sector, 6, 1), strength: 50, companyIndex: -1 });
      front.addChit({ side: 'red', name: 'G2', cell: cellIndex(sector, 6, 3), strength: 50, companyIndex: -1 });
      const blue = front.addChit({ side: 'blue', name: 'Able', cell: cellIndex(sector, 1, 2), strength: 100, companyIndex: 0 });
      front.orderMove(blue.id, cellIndex(sector, 8, 2));

      const cmd = new StrategicCommander('red', RED_DEFENDER);
      for (let i = 0; i < 500; i++) {
        cmd.evaluate(front);
        front.step();
        for (const chit of front.chits) {
          if (chit.side !== 'red' || chit.path.length === 0) continue;
          const dest = chit.path[chit.path.length - 1];
          expect(sector.cells[dest].terrain).not.toBe('river');
        }
      }
    });

    it('reserve commits when objective pressure exceeds garrison strength', () => {
      // Riverless sector so SCREEN FORDS can't trigger — isolates COMMIT RESERVE.
      const sector = parseSector([
        '........',
        '..T.....',
        '........',
      ], 2, 'reserve-test');
      const front = new Front(sector);
      const objective = cellIndex(sector, 2, 1);
      const garrison = front.addChit({ side: 'red', name: 'Garnison', cell: objective, strength: 10, companyIndex: -1 });
      const reserve = front.addChit({ side: 'red', name: 'Reserve', cell: cellIndex(sector, 6, 1), strength: 100, companyIndex: -1 });
      front.addChit({ side: 'blue', name: 'Able', cell: cellIndex(sector, 1, 1), strength: 120, companyIndex: 0 });

      const cmd = new StrategicCommander('red', RED_DEFENDER);
      cmd.evaluate(front);

      // Garrison withdraws (adjacent 120 > 2*10), leaving the objective
      // pressured. COMMIT RESERVE sends the Reserve toward it.
      expect(reserve.path.length).toBeGreaterThan(0);
      const dest = reserve.path[reserve.path.length - 1];
      const destXY = cellXY(sector, dest);
      const objXY = cellXY(sector, objective);
      const dist = Math.abs(destXY.x - objXY.x) + Math.abs(destXY.y - objXY.y);
      expect(dist).toBeLessThanOrEqual(2);
    });

    it('withdrawal: outmatched red chit retreats instead of being overrun', () => {
      const c = newCampaign(1);
      const sector = parseSector([
        '........',
        '........',
        '........',
      ], 4, 'withdraw-test');
      const front = new Front(sector);
      const startCell = cellIndex(sector, 5, 1);
      const red = front.addChit({ side: 'red', name: 'Weak', cell: startCell, strength: 30, companyIndex: -1 });
      front.addChit({ side: 'blue', name: 'Strong', cell: cellIndex(sector, 4, 1), strength: 120, companyIndex: 0 });

      const cmd = new StrategicCommander('red', RED_DEFENDER);
      cmd.evaluate(front);

      expect(red.path.length).toBeGreaterThan(0);
      const dest = red.path[red.path.length - 1];
      const destXY = cellXY(sector, dest);
      expect(destXY.x).toBeGreaterThan(5);
      // WITHDRAW moves to the safest rear cell (multi-cell), not just an
      // adjacent cell like REPOSITION would — this distinguishes the two.
      const startXY = cellXY(sector, startCell);
      const moveDist = Math.abs(destXY.x - startXY.x) + Math.abs(destXY.y - startXY.y);
      expect(moveDist).toBeGreaterThan(1);

      let engagement = null;
      for (let i = 0; i < 200; i++) {
        const e = front.step();
        if (e) {
          expect(e.attackerId).not.toBe(red.id);
          expect(e.defenderId).not.toBe(red.id);
        }
      }
      expect(red.strength).toBeGreaterThan(0);
    });

    it('counterattack: strong red chit attacks weak adjacent blue on red-owned cell', () => {
      const c = newCampaign(1);
      const sector = parseSector([
        '........',
        '........',
        '........',
      ], 4, 'counter-test');
      const front = new Front(sector);
      const red = front.addChit({ side: 'red', name: 'Strong', cell: cellIndex(sector, 5, 1), strength: 100, companyIndex: -1 });
      const blue = front.addChit({ side: 'blue', name: 'Weak', cell: cellIndex(sector, 4, 1), strength: 40, companyIndex: 0 });

      const cmd = new StrategicCommander('red', RED_DEFENDER);
      cmd.evaluate(front);

      expect(red.path.length).toBeGreaterThan(0);
      expect(red.path[red.path.length - 1]).toBe(cellIndex(sector, 4, 1));

      let engagement = null;
      for (let i = 0; i < 200 && !engagement; i++) engagement = front.step();
      expect(engagement).not.toBeNull();
      expect(engagement!.attackerId).toBe(red.id);
    });

    it('pressure is measured from the enemy chit, not a cache entry keyed by its id', () => {
      // Regression: computePressure shared the commander's Dijkstra cache
      // (keyed by cell) but keyed its own entries by chit ID — chit id 1 and
      // cell 1 collide. Here the withdrawing red garrison at cell 1 seeds the
      // cache under key 1, and the blue chit is id 1. Blue sits on the
      // doorstep of objective (0,1); measured from its own cell that's the
      // most-threatened objective, but measured from cell 1 the far objective
      // (2,0) looks hotter — the reserve commits to the wrong cell.
      const sector = parseSector(['..T.', 'T...'], 0, 'cache-key-test');
      const front = new Front(sector);
      front.addChit({ side: 'blue', name: 'B', cell: cellIndex(sector, 0, 0), strength: 200, companyIndex: -1 }); // id 1
      front.addChit({ side: 'red', name: 'G', cell: cellIndex(sector, 1, 0), strength: 30, companyIndex: -1 }); // id 2, withdraws, seeding cache key 1
      const reserve = front.addChit({ side: 'red', name: 'Reserve', cell: cellIndex(sector, 1, 1), strength: 100, companyIndex: -1 });

      new StrategicCommander('red', RED_DEFENDER).evaluate(front);

      expect(reserve.path.length).toBeGreaterThan(0);
      expect(reserve.path[reserve.path.length - 1]).toBe(cellIndex(sector, 0, 1));
    });
  });

  describe('blue attacker', () => {
    it('objective with weak garrison gets attacked', () => {
      const sector = parseSector([
        '....T.',
        '......',
        '......',
      ], 3, 'blue-test');
      const front = new Front(sector);
      const blue = front.addChit({ side: 'blue', name: 'Able', cell: cellIndex(sector, 1, 1), strength: 100, companyIndex: 0 });

      const cmd = new StrategicCommander('blue', BLUE_ATTACKER);
      cmd.evaluate(front);

      expect(blue.path.length).toBeGreaterThan(0);
      const dest = blue.path[blue.path.length - 1];
      const destXY = cellXY(sector, dest);
      expect(destXY.x).toBeGreaterThanOrEqual(3);
    });

    it('shattered company withdraws rearward', () => {
      const sector = parseSector([
        '........',
        '........',
      ], 4, 'shatter-test');
      const front = new Front(sector);
      const blue = front.addChit({ side: 'blue', name: 'Battered', cell: cellIndex(sector, 3, 1), strength: 20, companyIndex: 0 });
      front.addChit({ side: 'red', name: 'Garrison', cell: cellIndex(sector, 6, 1), strength: 100, companyIndex: -1 });

      const cmd = new StrategicCommander('blue', BLUE_ATTACKER);
      cmd.evaluate(front);

      expect(blue.path.length).toBeGreaterThan(0);
      const dest = blue.path[blue.path.length - 1];
      const destXY = cellXY(sector, dest);
      expect(destXY.x).toBeLessThan(3);
    });
  });

  describe('AI-vs-AI', () => {
    // Headless war, mirroring the main.ts strategic tick: both commanders,
    // coarse resolution, heal clocks and reinforcement cycles on day change.
    const runWar = (seed: number) => {
      const c = newCampaign(seed);
      const sector = makeDefaultSector();
      const front = newFront(c, sector);
      const redCmd = new StrategicCommander('red', RED_DEFENDER);
      const blueCmd = new StrategicCommander('blue', BLUE_ATTACKER);
      let prevDay = front.day;
      let steps = 0;
      while (operationStatus(front) === 'ongoing' && steps < 100000) {
        redCmd.evaluate(front);
        blueCmd.evaluate(front);
        const e = front.step();
        if (front.day > prevDay) {
          advanceDays(c, front.day - prevDay);
          if (front.day % REINFORCE_CYCLE_DAYS === 0) fillReplacements(c, front.day * 31 + 7, REINFORCE_PER_COMPANY);
          syncStrengths(c, front);
          prevDay = front.day;
        }
        if (e) resolveCoarse(c, front, e);
        steps++;
      }
      return { status: operationStatus(front), day: front.day, logLen: c.log.length };
    };

    it('same campaign seed reproduces the same war', () => {
      expect(runWar(42)).toEqual(runWar(42));
    }, 60000);

    // DELETED (S57): the bit-for-bit {status, day, logLen} tuple pin. It froze
    // the V1 grid war, which is no longer the war representation — the theater
    // graph is. THE war pin now lives in tests/war-pin.test.ts, frozen from
    // scripts/warsweep2.mjs over the V2 headless loop. What stays here are
    // property gates over the grid, which ?camp=N still boots (src/main.ts:985).

    it('war terminates, varies with the campaign seed, and can go either way', () => {
      const outcomes = [0, 1, 7, 42, 99, 500, 1000, 9999].map(runWar);
      for (const o of outcomes) {
        expect(o.status).not.toBe('ongoing');
        expect(o.day).toBeLessThanOrEqual(15);
      }
      // The campaign seed salts every coarse battle: distinct seeds must not
      // all produce the same scripted war.
      const distinct = new Set(outcomes.map((o) => `${o.status}:${o.day}:${o.logLen}`));
      expect(distinct.size).toBeGreaterThan(1);
      // Balance: a spectate war is a war, not a script — both outcomes occur.
      expect(outcomes.some((o) => o.status === 'won')).toBe(true);
      expect(outcomes.some((o) => o.status === 'lost')).toBe(true);
    }, 120000);
  });

  describe('retreat', () => {
    it('blue with no adjacent escape infiltrates to the nearest owned cell instead of being overrun', () => {
      const sector = parseSector(['.....'], 2, 'overrun-test'); // cells 0-1 blue, 2-4 red
      const front = new Front(sector);
      const chit = front.addChit({ side: 'blue', name: 'A', cell: 2, strength: 50, companyIndex: 0 }); // just lost cell 2
      front.addChit({ side: 'blue', name: 'B', cell: 1, strength: 50, companyIndex: 1 }); // blocks the adjacent escape

      retreat(front, chit);

      expect(chit.cell).toBe(0);
      expect(chit.strength).toBe(50);
    });

    it('red with no escape is still overrun', () => {
      const sector = parseSector(['.....'], 2, 'overrun-test');
      const front = new Front(sector);
      front.addChit({ side: 'blue', name: 'B', cell: 1, strength: 50, companyIndex: 0 });
      const red = front.addChit({ side: 'red', name: 'R', cell: 0, strength: 40, companyIndex: -1 }); // on blue-owned ground, no red neighbor

      retreat(front, red);

      expect(red.strength).toBe(0);
    });
  });

  describe('battle staging', () => {
    it('red-attacker battle: red soldiers on west side, blue defenders near objectives', () => {
      const c = newCampaign(10);
      const sector = makeDefaultSector();
      const front = newFront(c, sector);

      const reserve = front.chits.find(ch => ch.name === 'Reserve')!;
      const able = front.chits.find(ch => ch.side === 'blue')!;
      const ableXY = cellXY(sector, able.cell);
      reserve.cell = cellIndex(sector, ableXY.x + 1, ableXY.y);

      const e = { attackerId: reserve.id, defenderId: able.id, cell: able.cell };
      const { sim } = makeStrategicBattle(c, front, e, 5);

      const red = sim.soldiers.filter(s => s.side === 'red');
      const blueSoldiers = sim.soldiers.filter(s => s.side === 'blue');

      expect(red.length).toBeGreaterThan(0);
      // The chit's strength is its infantry; the StuG and SdKfz crews ride on
      // top of it (establishment men, not chit manpower).
      expect(red.filter((s) => s.inVehicle < 0).length).toBe(reserve.strength);

      const redAvgX = red.reduce((a, s) => a + s.x, 0) / red.length;
      expect(redAvgX).toBeLessThan(sim.map.w / 2);

      expect(blueSoldiers.length).toBeGreaterThan(0);
    });

    it('blue-attacker battle staging unchanged: same soldier counts for fixed seed', () => {
      const c = newCampaign(10);
      const sector = makeDefaultSector();
      const front = newFront(c, sector);

      const able = front.chits.find(ch => ch.side === 'blue')!;
      const wache = front.chits.find(ch => ch.name === 'Brückenwache Süd')!;
      const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: wache.id, cell: wache.cell }, 5);

      const blue = sim.soldiers.filter(s => s.side === 'blue');
      const red = sim.soldiers.filter(s => s.side === 'red');
      expect(blue.length).toBe(138 + 5); // roster + Sherman/M3 crews
      expect(red.length).toBe(36 + 6); // garrison + PaK 40 crew
    });

    // Regression: a red-AI counterattack vs the player crashed the debrief
    // (companyIndex -1) and reported VICTORY/DEFEAT from the attacker's side.
    // The debrief is the player's after-action report — always BLUE-perspective.
    const stageRedAttack = () => {
      const c = newCampaign(10);
      const front = newFront(c, makeDefaultSector());
      const reserve = front.chits.find(ch => ch.name === 'Reserve')!;
      const able = front.chits.find(ch => ch.side === 'blue')!;
      const ableXY = cellXY(front.sector, able.cell);
      reserve.cell = cellIndex(front.sector, ableXY.x + 1, ableXY.y);
      const e = { attackerId: reserve.id, defenderId: able.id, cell: able.cell };
      return { c, front, able, e };
    };

    it('red-attacker engagement: debrief company is the BLUE defender, not -1', () => {
      const { c, front, able, e } = stageRedAttack();
      const battle = makeStrategicBattle(c, front, e, 5);
      expect(battle.companyIndex).toBe(able.companyIndex);
      expect(c.companies[battle.companyIndex].squads.length).toBeGreaterThan(0);
    });

    it('red-attacker engagement repelled: record.won is true (BLUE held), cell unchanged', () => {
      const { c, front, e } = stageRedAttack();
      const battle = makeStrategicBattle(c, front, e, 5);
      for (const s of battle.sim.soldiers) if (s.side === 'red') s.alive = false;
      battle.sim.step();
      expect(battle.sim.winner).toBe('blue');
      const out = applyEngagementOutcome(c, front, e, battle.sim);
      expect(out.record.won).toBe(true);
      expect(out.cellTaken).toBe(false);
      expect(front.sector.cells[e.cell].owner).toBe('blue');
    });

    it('red-attacker engagement: the RED attacker chit attrits by its own losses', () => {
      // Regression: redLosses were subtracted from the DEFENDER regardless of
      // side — a red attacker never attrited (immortal counterattackers) and
      // the blue defender was docked red's dead (masked by syncStrengths).
      const { c, front, e } = stageRedAttack();
      const battle = makeStrategicBattle(c, front, e, 5);
      const redAttacker = front.chits.find(ch => ch.id === e.attackerId)!;
      const before = redAttacker.strength;
      // Kill half the red force, wipe none of blue: red wins on attrition floor? No —
      // just apply the outcome directly; won/lost is irrelevant to the attrition path.
      const redSoldiers = battle.sim.soldiers.filter(s => s.side === 'red');
      const killed = Math.floor(redSoldiers.length / 2);
      for (const s of redSoldiers.slice(0, killed)) s.alive = false;
      applyEngagementOutcome(c, front, e, battle.sim);
      expect(redAttacker.strength).toBe(before - killed);
    });

    it('red-attacker engagement lost: record.won is false (BLUE lost), cell falls', () => {
      const { c, front, e } = stageRedAttack();
      const battle = makeStrategicBattle(c, front, e, 5);
      for (const s of battle.sim.soldiers) if (s.side === 'blue') s.alive = false;
      battle.sim.step();
      expect(battle.sim.winner).toBe('red');
      const out = applyEngagementOutcome(c, front, e, battle.sim);
      expect(out.record.won).toBe(false);
      expect(out.cellTaken).toBe(true);
      expect(front.sector.cells[e.cell].owner).toBe('red');
    });
  });
});