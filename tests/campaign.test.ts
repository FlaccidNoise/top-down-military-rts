import { describe, expect, it } from 'vitest';
import { advanceDays, applyBattleResults, fillReplacements, fitRoster, newCampaign, squadMembers } from '../src/campaign/campaign';
import { SQUADS } from '../src/sim/data';
import { PARTS, P, applyHit } from '../src/sim/body';
import { RedCommander } from '../src/sim/ai';
import { GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';
import { makeScenario } from '../src/sim/scenario';
import { makeStrategicBattle, newFront } from '../src/strategic/bridge';
import { makeDefaultSector } from '../src/strategic/sector';
import { loadGame, saveGame } from '../src/strategic/save';

describe('bonds', () => {
  it('a bonded squadmate death hits morale harder than a stranger death', () => {
    const run = (bond: number) => {
      const map = new GameMap(20, 20);
      const sim = new Sim(map, 9);
      sim.addSquad('blue', 'A', [
        { name: 'victim', weapon: 'garand', x: 5.5, y: 5.5 },
        { name: 'witness', weapon: 'garand', x: 6.5, y: 5.5 },
      ]);
      const [victim, witness] = sim.soldiers;
      witness.bonds[victim.id] = bond;
      const before = witness.morale;
      applyHit(victim.body, P.HEAD, 100);
      // kill via the sim path: shoot with overwhelming damage isn't exposed;
      // simulate the shock by marking dead through bloodLoss
      victim.bloodLoss = 1;
      victim.wounds.push({ part: P.TORSO, dmg: 40 });
      sim.step();
      return before - witness.morale;
    };
    expect(run(1)).toBeGreaterThan(run(0) * 2);
  });

  it('rescue goes to the bonded buddy, not the stranger', () => {
    const map = new GameMap(40, 40);
    const sim = new Sim(map, 11);
    sim.addSquad('blue', 'A', [
      { name: 'casualty', weapon: 'garand', x: 20.5, y: 20.5, courage: 0.5 },
      { name: 'buddy', weapon: 'garand', x: 25.5, y: 20.5, courage: 0.5 },
      { name: 'stranger', weapon: 'garand', x: 15.5, y: 20.5, courage: 0.5 },
    ]);
    const [casualty, buddy, stranger] = sim.soldiers;
    buddy.bonds[casualty.id] = 0.9;
    stranger.bonds[casualty.id] = 0.05;
    casualty.pain = 0.9; // shock: downed
    for (let i = 0; i < 30 * 30 && !casualty.stabilized; i++) sim.step();
    expect(casualty.stabilized).toBe(true);
    expect(casualty.rescuerId).toBe(-1); // task complete and released
    expect(buddy.task).toBeNull();
    // the stranger never volunteered: willingness 0.05*1.2 + 0.25 < 0.75
    expect(stranger.task).toBeNull();
    expect(Math.hypot(buddy.x - casualty.x, buddy.y - casualty.y)).toBeLessThan(4);
  });
});

describe('barrage', () => {
  it('lands after a call-in delay and wounds or suppresses men in the open', () => {
    const map = new GameMap(60, 60);
    const sim = new Sim(map, 21);
    sim.addSquad('red', 'targets', [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ name: `t${i}`, weapon: 'garand', x: 26.5 + (i % 3) * 3, y: 26.5 + Math.floor(i / 3) * 3 })));
    expect(sim.callBarrage('blue', 30, 30)).toBe(true);
    expect(sim.barragesLeft.blue).toBe(1);
    for (let i = 0; i < 30 * 61; i++) sim.step(); // 20s delay + full barrage
    const touched = sim.soldiers.filter((s) => s.wounds.length > 0 || s.suppression > 0 || !s.alive || s.downed);
    expect(touched.length).toBeGreaterThan(0);
  });

  it('is a limited resource', () => {
    const sim = makeScenario(22);
    expect(sim.callBarrage('blue', 100, 60)).toBe(true);
    expect(sim.callBarrage('blue', 100, 60)).toBe(true);
    expect(sim.callBarrage('blue', 100, 60)).toBe(false);
  });
});

describe('red commander', () => {
  it('counterattacks a captured post', () => {
    const map = new GameMap(40, 40);
    const sim = new Sim(map, 23);
    // blue squad sits on red's post; red squad is far off it
    sim.addSquad('blue', 'A', [0, 1, 2].map((i) => ({ name: `b${i}`, weapon: 'garand', x: 10.5 + i, y: 10.5 })));
    // Counterattacking across ground the enemy already holds is exactly what
    // the order-vocabulary's refusal model (orderSquad -> orderTeam ->
    // compliance) is supposed to flag as dangerous — veteran/led/high-morale
    // troops so the counterattack is actually issued instead of balking.
    sim.addSquad('red', '1. Gruppe', [0, 1, 2, 3].map((i) => ({ name: `r${i}`, weapon: 'garand', x: 30.5 + i, y: 30.5, xp: 30 })));
    sim.soldiers[3].role = 'leader';
    for (const s of sim.squads[1].soldierIds) sim.soldiers[s].morale = 1;
    for (const s of sim.soldiers) {
      s.magLeft = 0;
      s.ammo = {}; // dry: no firefight while red's spotting sweep runs
    }
    // the commander reads sim intel (spotted/contacts), not live LOS — a
    // sweep must run before it can know the post is taken
    for (let i = 0; i < 15; i++) sim.step();
    const commander = new RedCommander({ stance: 'defend', posts: { 1: { x: 10, y: 10 } } });
    commander.update(sim);
    const ordered = sim.squads[1].soldierIds.map((i) => sim.soldiers[i]).filter((s) => s.path !== null);
    expect(ordered.length).toBeGreaterThan(0);
  });
});

describe('campaign', () => {
  const battleFor = (c: ReturnType<typeof newCampaign>, seed: number) => {
    const front = newFront(c, makeDefaultSector());
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    return makeStrategicBattle(c, front, { attackerId: able.id, defenderId: wache.id, cell: wache.cell }, seed);
  };

  it('battle results persist: KIA, recovery, xp, bonds growth', () => {
    const c = newCampaign(1);
    const { sim } = battleFor(c, 5);
    const pids = squadMembers(c.squads[0]);
    // fabricate outcomes: first man dies, second is wounded, rest survive clean
    const first = sim.soldiers.find((s) => s.pid === pids[0])!;
    const second = sim.soldiers.find((s) => s.pid === pids[1])!;
    first.alive = false;
    applyHit(second.body, P.L_LEG, 20);
    applyBattleResults(c, sim, true);
    expect(c.soldiers[pids[0]].status).toBe('kia');
    expect(c.soldiers[pids[1]].status).toBe('recovering');
    expect(c.soldiers[pids[2]].xp).toBe(1);
    expect(c.soldiers[pids[2]].bonds[pids[3]]).toBeCloseTo(0.45); // 0.3 + 0.15
    // dead men forge no new bonds
    expect(c.soldiers[pids[2]].bonds[pids[0]]).toBeCloseTo(0.3);
  });

  it('healing: wounds clear, destroyed parts are permanent', () => {
    const c = newCampaign(2);
    const pid = squadMembers(c.squads[0])[0];
    const cs = c.soldiers[pid];
    cs.status = 'recovering';
    cs.recoveryDays = 2;
    cs.bodyDamage[P.L_LEG] = 10; // healing wound
    cs.bodyDamage[P.L_HAND] = PARTS[P.L_HAND].hp; // destroyed: permanent
    advanceDays(c, 3);
    expect(cs.status).toBe('fit');
    expect(cs.bodyDamage[P.L_LEG]).toBe(0);
    expect(cs.bodyDamage[P.L_HAND]).toBe(PARTS[P.L_HAND].hp); // the scar stays
  });

  it('replacements arrive green and unbonded', () => {
    const c = newCampaign(3);
    const sq0 = squadMembers(c.squads[0]);
    c.soldiers[sq0[0]].status = 'kia';
    c.soldiers[sq0[1]].status = 'kia';
    const beforeIds = new Set(Object.keys(c.soldiers));
    const added = fillReplacements(c, 42);
    expect(added).toBe(2); // us_rifle establishment is 12 (us_able 6 + us_baker 6)
    const roster = fitRoster(c, 0);
    expect(roster.reduce((n, team) => n + team.length, 0)).toBe(12);
    const newIds = Object.keys(c.soldiers)
      .filter((id) => !beforeIds.has(id))
      .map(Number);
    expect(newIds.length).toBe(2);
    for (const pid of newIds) {
      expect(c.soldiers[pid].courage).toBeLessThan(0.6); // green range: 0.25 + rng*0.35
      expect(Object.keys(c.soldiers[pid].bonds).length).toBe(0);
    }
  });

  it('fillReplacements caps replacements per company, going to the neediest squad first', () => {
    const c = newCampaign(15);
    const fitCount = (si: number) => squadMembers(c.squads[si]).filter((pid) => c.soldiers[pid].status === 'fit').length;
    const sq0 = squadMembers(c.squads[0]);
    const sq1 = squadMembers(c.squads[1]);
    for (const pid of sq0.slice(0, 3)) c.soldiers[pid].status = 'kia'; // squad 0: down 3
    c.soldiers[sq1[0]].status = 'kia'; // squad 1: down 1, less needy
    const before0 = fitCount(0);
    const before1 = fitCount(1);
    const added = fillReplacements(c, 99, 1);
    expect(added).toBe(1);
    expect(fitCount(0)).toBe(before0 + 1); // the one capped slot goes to the neediest squad
    expect(fitCount(1)).toBe(before1); // squad 1 gets nothing this round
  });

  it('save/load roundtrip', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const c = newCampaign(4);
    const front = newFront(c, makeDefaultSector());
    saveGame(c, front, storage);
    expect(loadGame(storage)!.campaign).toEqual(c);
  });

  it(
    'strategic battles place both sides on the generated map',
    { timeout: 30_000 },
    () => {
      for (const seed of [13, 14]) {
        const c = newCampaign(9);
        const { sim } = battleFor(c, seed);
        // fresh campaign fields a full 138-man company against Süd's 36-man
        // garrison (150 leaves margin without depending on the exact split)
        expect(sim.soldiers.length).toBeGreaterThan(150);
        for (const s of sim.soldiers) {
          expect(s.x).toBeGreaterThan(0);
          expect(s.x).toBeLessThan(sim.map.w);
          expect(s.y).toBeGreaterThan(0);
          expect(s.y).toBeLessThan(sim.map.h);
        }
        for (let i = 0; i < 60; i++) sim.step();
        for (const s of sim.soldiers) expect(Number.isFinite(s.x)).toBe(true);
      }
    },
  );

  it('makeScenario spawns every vehicle on the road', () => {
    for (const seed of [13, 42, 77]) {
      const sim = makeScenario(seed);
      for (const v of sim.vehicles) {
        expect(sim.map.terrainKeyAt(Math.floor(v.x), Math.floor(v.y))).toBe('road');
      }
    }
  });

  it('a campaign battle wires persistent bonds onto battle soldiers', () => {
    const c = newCampaign(6);
    const { sim } = battleFor(c, 8);
    const a = sim.soldiers[0];
    const b = sim.soldiers[1];
    expect(a.pid).toBeGreaterThan(0);
    expect(a.bonds[b.id]).toBeCloseTo(0.3); // trained-together baseline, from campaign
  });

  it('a fresh campaign fields 3 companies of 18 squads at design-scale strength', () => {
    const c = newCampaign(7);
    expect(c.companies.map((co) => co.name)).toEqual(['Able', 'Baker', 'Charlie']);
    expect(c.companies.every((co) => co.squads.length === 18)).toBe(true);
    expect(c.squads.length).toBe(54);
    expect(Object.keys(c.soldiers).length).toBe(414);
    expect(c.squads[0].name).toBe('Able 1st');
    expect(c.squads[0].def).toBe('us_rifle');
    expect(c.squads[0].teams.length).toBe(SQUADS.us_rifle.teams.length);
    // bonds stay within a squad at creation
    const sq0 = squadMembers(c.squads[0]);
    const sq18 = squadMembers(c.squads[18]); // Baker 1st: a different company
    expect(c.soldiers[sq0[0]].bonds[sq0[1]]).toBeCloseTo(0.3);
    expect(c.soldiers[sq0[0]].bonds[sq18[0]]).toBeUndefined();
  });
});
