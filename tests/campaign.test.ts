import { describe, expect, it } from 'vitest';
import { advanceDays, applyBattleResults, fillReplacements, fitRoster, loadCampaign, newCampaign, saveCampaign } from '../src/campaign/campaign';
import { PARTS, P, applyHit } from '../src/sim/body';
import { RedCommander } from '../src/sim/ai';
import { GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';
import { makeCampaignBattle, makeScenario } from '../src/sim/scenario';

describe('bonds', () => {
  it('a bonded squadmate death hits morale harder than a stranger death', () => {
    const run = (bond: number) => {
      const map = new GameMap(20, 20);
      const sim = new Sim(map, 9);
      sim.addSquad('blue', 'A', [
        { name: 'victim', weapon: 'rifle', x: 5.5, y: 5.5 },
        { name: 'witness', weapon: 'rifle', x: 6.5, y: 5.5 },
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
      { name: 'casualty', weapon: 'rifle', x: 20.5, y: 20.5, courage: 0.5 },
      { name: 'buddy', weapon: 'rifle', x: 25.5, y: 20.5, courage: 0.5 },
      { name: 'stranger', weapon: 'rifle', x: 15.5, y: 20.5, courage: 0.5 },
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
    sim.addSquad('red', 'targets', [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ name: `t${i}`, weapon: 'rifle', x: 26.5 + (i % 3) * 3, y: 26.5 + Math.floor(i / 3) * 3 })));
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
    sim.addSquad('blue', 'A', [0, 1, 2].map((i) => ({ name: `b${i}`, weapon: 'rifle', x: 10.5 + i, y: 10.5 })));
    sim.addSquad('red', '1. Gruppe', [0, 1, 2, 3].map((i) => ({ name: `r${i}`, weapon: 'rifle', x: 30.5 + i, y: 30.5 })));
    const commander = new RedCommander({ stance: 'defend', posts: { 1: { x: 10, y: 10 } } });
    commander.update(sim);
    const ordered = sim.squads[1].soldierIds.map((i) => sim.soldiers[i]).filter((s) => s.path !== null);
    expect(ordered.length).toBeGreaterThan(0);
  });
});

describe('campaign', () => {
  it('battle results persist: KIA, recovery, xp, bonds growth', () => {
    const c = newCampaign(1);
    const { sim } = makeCampaignBattle(c, 5);
    const pids = c.squads[0].members;
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
    const pid = c.squads[0].members[0];
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
    c.soldiers[c.squads[0].members[0]].status = 'kia';
    c.soldiers[c.squads[0].members[1]].status = 'recovering';
    const added = fillReplacements(c, 42);
    expect(added).toBe(2); // one for the dead man, one for the recovering man
    const roster = fitRoster(c, 0);
    expect(roster.length).toBe(9);
    const newest = roster[roster.length - 1];
    expect(Object.keys(newest.bonds).length).toBe(0);
  });

  it('save/load roundtrip', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const c = newCampaign(4);
    saveCampaign(c, storage);
    expect(loadCampaign(storage)).toEqual(c);
  });

  it('a campaign battle wires persistent bonds onto battle soldiers', () => {
    const c = newCampaign(6);
    const { sim } = makeCampaignBattle(c, 8);
    const a = sim.soldiers[0];
    const b = sim.soldiers[1];
    expect(a.pid).toBeGreaterThan(0);
    expect(a.bonds[b.id]).toBeCloseTo(0.3); // trained-together baseline, from campaign
  });
});
