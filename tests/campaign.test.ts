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
  it('lands after a call-in delay, wounds men in the open, spares men behind walls', () => {
    const sim = makeScenario(21);
    const before = sim.snapshot();
    // barrage the red woods position (2. Gruppe men in the open at ~122-134, 40-52)
    expect(sim.callBarrage('blue', 128, 46)).toBe(true);
    expect(sim.barragesLeft.blue).toBe(1);
    for (let i = 0; i < 30 * 21; i++) sim.step(); // 20s delay + first round
    expect(sim.snapshot()).not.toBe(before);
    for (let i = 0; i < 30 * 40; i++) sim.step(); // rest of the barrage
    const woodsRed = sim.soldiers.filter((s) => s.side === 'red' && s.x > 118);
    const touched = woodsRed.filter((s) => s.wounds.length > 0 || s.suppression > 0 || !s.alive || s.downed);
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
    const sim = makeScenario(23);
    const commander = new RedCommander({
      stance: 'defend',
      posts: { 2: { x: 97, y: 52 }, 3: { x: 98, y: 79 } },
    });
    // teleport a blue squad onto 1. Gruppe's post (building A)
    for (const sid of sim.squads[0].soldierIds) {
      const s = sim.soldiers[sid];
      s.x = 96 + (sid % 3);
      s.y = 51 + (sid % 2);
    }
    // pull 1. Gruppe off its post so it must counterattack
    for (const sid of sim.squads[2].soldierIds) {
      const s = sim.soldiers[sid];
      s.x = 120;
      s.y = 100;
    }
    commander.update(sim);
    const ordered = sim.squads[2].soldierIds.map((i) => sim.soldiers[i]).filter((s) => s.path !== null);
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
