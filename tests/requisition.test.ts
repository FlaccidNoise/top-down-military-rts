// Requisition (jtbug #793, tracker #133): one card at each reinforcement
// cycle in place of the even fill. Empty and blocked states first, then each
// card's real effect, then the save.
import { beforeEach, describe, expect, it } from 'vitest';
import { newCampaign, replacementRoom } from '../src/campaign/campaign';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeTheaterBattle } from '../src/strategic/bridge2';
import { REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY } from '../src/strategic/front';
import { makeHeadlessWorld, stepWorldMinute } from '../src/strategic/headless';
import { DETECT_FORCE_M, SCREEN_DETECT_MULT } from '../src/strategic/intel';
import {
  applyRequisition,
  draftSize,
  REQ_ARMOR,
  REQ_ARMOR_ATTACKS,
  REQ_BARRAGES,
  REQ_DAYS,
  requisitionNotes,
  requisitionOffer,
} from '../src/strategic/requisition';
import { loadGameV2, saveGameV2 } from '../src/strategic/save2';
import type { FrontV2 } from '../src/strategic/theater/force';
import { openBattle, stepWar } from '../src/strategic/theater/war';
import { lineFront, place } from './lib/line-theater';

const words = (s: string): number => s.trim().split(/\s+/).length;
const due = (fr: FrontV2): FrontV2 => {
  fr.requisition = { due: true, barrageUntilDay: 0 };
  return fr;
};

describe('nothing due, nobody eligible', () => {
  it('a card cannot be taken when nothing is due', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 1);
    expect(applyRequisition(fr, newCampaign(1, 1), 'barrage', f.id, true)).toEqual({ ok: false, reason: 'Nothing is due.' });
    expect(fr.requisition).toBeUndefined();
  });

  it('with no company left the three company cards say so, and the barrage still stands', () => {
    const fr = due(lineFront());
    const offer = requisitionOffer(fr, newCampaign(1, 1), -1, true);
    expect(offer.map((o) => o.blocked)).toEqual(['No company left.', 'No company left.', null, 'No company left.']);
    expect(applyRequisition(fr, newCampaign(1, 1), 'armour', -1, true)).toEqual({ ok: false, reason: 'No company left.' });
    expect(fr.requisition!.due).toBe(true); // a blocked card changes nothing
  });

  it('a company at full strength cannot take replacements, and recon is idle with the fog off', () => {
    const fr = due(lineFront());
    const c = newCampaign(1, 1);
    const f = place(fr, 'blue', 1);
    expect(replacementRoom(c, 0)).toBe(0);
    const offer = requisitionOffer(fr, c, f.id, false);
    expect(offer.find((o) => o.id === 'replacements')!.blocked).toBe('Full strength.');
    expect(offer.find((o) => o.id === 'recon')!.blocked).toBe('Fog is off.');
    expect(offer.find((o) => o.id === 'armour')!.blocked).toBeNull();
  });
});

describe('the cards', () => {
  it('each states its effect in six words at most, numbers from the constants', () => {
    const fr = due(lineFront());
    const c = newCampaign(1, 3);
    const f = place(fr, 'blue', 1);
    const offer = requisitionOffer(fr, c, f.id, true);
    expect(offer.map((o) => o.id)).toEqual(['replacements', 'armour', 'barrage', 'recon']);
    for (const o of offer) {
      expect(words(o.effect), `${o.name}: ${o.effect}`).toBeLessThanOrEqual(6);
      expect(words(o.name)).toBe(1);
      expect(o.glyph.length).toBeGreaterThan(0);
    }
    expect(offer[0].effect).toBe(`Up to ${REINFORCE_PER_COMPANY * 3} men.`);
    expect(offer[1].effect).toContain(String(REQ_ARMOR_ATTACKS));
    expect(offer[2].effect).toBe(`+${REQ_BARRAGES} per battle, ${REQ_DAYS} days.`);
    expect(offer[3].effect).toContain(`${(DETECT_FORCE_M * SCREEN_DETECT_MULT) / 1000} km`);
  });

  it('replacements: the whole draft goes to the one company picked', () => {
    const fr = due(lineFront());
    const c = newCampaign(1, 3);
    const able = place(fr, 'blue', 1);
    // Kill off twenty men in each of two companies.
    const maul = (ci: number): void => {
      let n = 0;
      for (const si of c.companies[ci].squads) for (const t of c.squads[si].teams) for (const pid of t.members) if (n++ < 20) c.soldiers[pid].status = 'kia';
    };
    maul(0);
    maul(1);
    const room1 = replacementRoom(c, 1);
    expect(replacementRoom(c, 0)).toBe(20);
    const r = applyRequisition(fr, c, 'replacements', able.id, true);
    expect(r).toEqual({ ok: true, text: `20 replacements join ${able.name}` });
    expect(replacementRoom(c, 0)).toBe(0);
    expect(replacementRoom(c, 1)).toBe(room1); // the other company got nobody
    expect(draftSize(c)).toBe(REINFORCE_PER_COMPANY * 3);
    expect(fr.requisition!.due).toBe(false);
  });

  const attack = (prep: (fr: FrontV2, atkId: number) => void): { blueHulls: number; barrages: number; left: number } => {
    const fr = due(lineFront());
    fr.clockMin = 720;
    const atk = place(fr, 'blue', 1);
    const def = place(fr, 'red', 2);
    atk.pos = { kind: 'edge', edgeId: 1, s: 1800, dir: 1 };
    atk.path = [1];
    prep(fr, atk.id);
    const b = openBattle(fr, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 200 });
    const { sim } = makeTheaterBattle(newCampaign(1, 1), fr, b);
    return { blueHulls: sim.vehicles.filter((v) => v.side === 'blue').length, barrages: sim.barragesLeft.blue, left: atk.armorAttacks };
  };

  it('armour: one more hull in the attack column, for the attacks the card names', () => {
    const plain = attack(() => {});
    const c = newCampaign(1, 1);
    const armoured = attack((fr, id) => expect(applyRequisition(fr, c, 'armour', id, true).ok).toBe(true));
    expect(armoured.blueHulls).toBe(plain.blueHulls + REQ_ARMOR.length);
    expect(armoured.left).toBe(REQ_ARMOR_ATTACKS - 1);
    expect(plain.left).toBe(0);
  });

  it('barrage: one more in every fought battle while it runs, none after', () => {
    const plain = attack(() => {});
    const c = newCampaign(1, 1);
    const allotted = attack((fr, id) => expect(applyRequisition(fr, c, 'barrage', id, true).ok).toBe(true));
    expect(allotted.barrages).toBe(plain.barrages + REQ_BARRAGES);
    const lapsed = attack((fr, id) => {
      applyRequisition(fr, c, 'barrage', id, true);
      fr.day += REQ_DAYS;
    });
    expect(lapsed.barrages).toBe(plain.barrages);
  });

  it('recon: the company sees twice as far under fog, at a full march', () => {
    const sees = (card: boolean): boolean => {
      const fr = due(lineFront());
      fr.clockMin = 14;
      fr.controlByNode = [null, null, null, null];
      const f = place(fr, 'blue', 0);
      if (card) expect(applyRequisition(fr, newCampaign(1, 1), 'recon', f.id, true).ok).toBe(true);
      const far = place(fr, 'red', 2); // 4000 m away
      stepWar(fr, newCampaign(1, 1), { recon: 'contacts' });
      expect(f.posture).toBe('march');
      return (fr.intel?.blue ?? []).some((k) => k.forceId === far.id);
    };
    expect(sees(false)).toBe(false);
    expect(sees(true)).toBe(true);
  });

  it('the force card names what is running in a few words', () => {
    const fr = due(lineFront());
    const c = newCampaign(1, 1);
    const f = place(fr, 'blue', 1);
    expect(requisitionNotes(fr, f)).toEqual([]);
    applyRequisition(fr, c, 'armour', f.id, true);
    fr.requisition!.due = true;
    applyRequisition(fr, c, 'barrage', f.id, true);
    expect(requisitionNotes(fr, f)).toEqual([`Tank: ${REQ_ARMOR_ATTACKS} attacks`, `+${REQ_BARRAGES} barrage to Day ${fr.day + REQ_DAYS}`]);
  });
});

describe('the cycle and the save', () => {
  const CFG = DEFAULT_PRESET.theater;
  const CAMP = DEFAULT_PRESET.campaign;
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it("the AI's cycle is the even fill: a headless war raises no requisition", () => {
    const w = makeHeadlessWorld(1, CFG, CAMP);
    for (let m = 0; m < REINFORCE_CYCLE_DAYS * 1440 + 10; m++) stepWorldMinute(w);
    expect(w.front.day).toBeGreaterThan(REINFORCE_CYCLE_DAYS);
    expect(w.front.requisition).toBeUndefined();
  });

  it('a waiting choice and the running cards survive a save and a load', () => {
    const w = makeHeadlessWorld(1, CFG, CAMP);
    const able = w.front.forces.find((f) => f.side === 'blue')!;
    w.front.requisition = { due: true, barrageUntilDay: 7 };
    able.armorAttacks = 2;
    able.reconUntilDay = 5;
    expect(saveGameV2(1, CFG, CAMP, w.campaign, w.front)).toBe(true);
    const g = loadGameV2();
    if (g.status !== 'ok') throw new Error(`reload: ${g.status}`);
    expect(g.front.requisition).toEqual({ due: true, barrageUntilDay: 7 });
    const loaded = g.front.forces.find((f) => f.id === able.id)!;
    expect([loaded.armorAttacks, loaded.reconUntilDay]).toEqual([2, 5]);
  });

  it('a save from before the cards loads with nothing due and nothing running', () => {
    const w = makeHeadlessWorld(1, CFG, CAMP);
    expect(saveGameV2(1, CFG, CAMP, w.campaign, w.front)).toBe(true);
    const old = JSON.parse(store.get('ccg-save-v4')!);
    delete old.front.requisition;
    for (const f of old.front.forces) {
      delete f.armorAttacks;
      delete f.reconUntilDay;
    }
    store.set('ccg-save-v4', JSON.stringify(old));
    const g = loadGameV2();
    if (g.status !== 'ok') throw new Error(`reload: ${g.status}`);
    expect(g.front.requisition).toBeUndefined();
    expect(g.front.forces.every((f) => f.armorAttacks === 0 && f.reconUntilDay === 0)).toBe(true);
  });
});
