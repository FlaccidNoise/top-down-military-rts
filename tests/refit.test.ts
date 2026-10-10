// Refit (jtbug #793): replacements reach a company that is supplied and out
// of contact, more of them when it is billeted, and a draft that cannot be
// delivered waits at the depot instead of being lost.
import { describe, expect, it } from 'vitest';
import { newCampaign, replacementRoom, type Campaign } from '../src/campaign/campaign';
import { REINFORCE_PER_COMPANY } from '../src/strategic/front';
import { cycleRefit, REFIT_BILLET_MULT, REFIT_OWED_CYCLES, refitBlock, refitNote } from '../src/strategic/refit';
import { applyRequisition, requisitionOffer } from '../src/strategic/requisition';
import { SUPPLY_EVAL_MIN } from '../src/strategic/theater/supply';
import { THREAT_M } from '../src/strategic/theater/war';
import { lineFront, place } from './lib/line-theater';

const words = (s: string): number => s.trim().split(/\s+/).length;
// Kill `n` men of company 0, so it has room for replacements.
const maul = (c: Campaign, n: number): void => {
  let k = 0;
  for (const si of c.companies[0].squads) for (const t of c.squads[si].teams) for (const pid of t.members) if (k++ < n) c.soldiers[pid].status = 'kia';
};

describe('who can refit', () => {
  it('a supplied company clear of the enemy can; contact and a cut supply line each stop it', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    expect(refitBlock(fr, f)).toBeNull();
    expect(refitNote(fr, f)).toBe('Refit ready.');

    const enemy = place(fr, 'red', 1);
    enemy.pos = { kind: 'edge', edgeId: 0, s: THREAT_M, dir: -1 };
    expect(refitBlock(fr, f)).toBe('contact');
    expect(refitNote(fr, f)).toBe('No refit: in contact.');
    enemy.pos = { kind: 'edge', edgeId: 0, s: THREAT_M + 1, dir: -1 };
    expect(refitBlock(fr, f)).toBeNull();

    f.untracedMin = SUPPLY_EVAL_MIN;
    expect(refitBlock(fr, f)).toBe('supply');
    expect(refitNote(fr, f)).toBe('No refit: out of supply.');
    f.untracedMin = 0;
    f.engagedIn = 3;
    expect(refitBlock(fr, f)).toBe('contact');
  });

  it('a company in a friendly, supplied town or village is billeted and says so', () => {
    const fr = lineFront();
    fr.theater.nodes[0].kind = 'village';
    const f = place(fr, 'blue', 0);
    expect(refitNote(fr, f)).toBe(`Refit ×${REFIT_BILLET_MULT}: billeted.`);
    for (const s of ['Refit ready.', 'No refit: in contact.', 'No refit: out of supply.', refitNote(fr, f)]) expect(words(s)).toBeLessThanOrEqual(5);
  });
});

describe('the cycle', () => {
  it('a company that can refit takes its draft; billeted it takes half as much again', () => {
    const run = (village: boolean): number => {
      const fr = lineFront();
      if (village) fr.theater.nodes[0].kind = 'village';
      const c = newCampaign(1, 1);
      maul(c, 40);
      place(fr, 'blue', 0);
      return cycleRefit(c, fr, 7);
    };
    expect(run(false)).toBe(REINFORCE_PER_COMPANY);
    expect(run(true)).toBe(Math.round(REINFORCE_PER_COMPANY * REFIT_BILLET_MULT));
  });

  it('a draft that cannot be delivered waits, up to the cap, and arrives when the company is free', () => {
    const fr = lineFront();
    const c = newCampaign(1, 1);
    maul(c, 60);
    const f = place(fr, 'blue', 0);
    const enemy = place(fr, 'red', 1);
    enemy.pos = { kind: 'edge', edgeId: 0, s: 1000, dir: -1 };
    const room = replacementRoom(c, 0);
    for (let cycle = 1; cycle <= 4; cycle++) {
      expect(cycleRefit(c, fr, cycle)).toBe(0);
      expect(f.owedMen).toBe(REINFORCE_PER_COMPANY * Math.min(cycle, REFIT_OWED_CYCLES));
    }
    expect(replacementRoom(c, 0)).toBe(room); // nobody arrived, nobody was lost
    enemy.strength = 0; // the company is clear
    expect(cycleRefit(c, fr, 5)).toBe(REINFORCE_PER_COMPANY * REFIT_OWED_CYCLES);
    expect(f.owedMen).toBe(0);
  });

  it('a force at strength zero is owed nothing', () => {
    const fr = lineFront();
    const f = place(fr, 'blue', 0);
    f.strength = 0;
    cycleRefit(newCampaign(1, 1), fr, 1);
    expect(f.owedMen).toBe(0);
  });
});

describe('the Replacements card obeys the same rule', () => {
  it('is blocked in contact and out of supply, with the reason, and a billet brings more', () => {
    const fr = lineFront();
    fr.requisition = { due: true, barrageUntilDay: 0 };
    const c = newCampaign(1, 3);
    maul(c, 60);
    const f = place(fr, 'blue', 0);
    const card = (): { effect: string; blocked: string | null } => requisitionOffer(fr, c, f.id, true)[0];
    expect(card()).toMatchObject({ effect: `Up to ${REINFORCE_PER_COMPANY * 3} men.`, blocked: null });

    f.untracedMin = SUPPLY_EVAL_MIN;
    expect(card().blocked).toBe('Out of supply.');
    expect(applyRequisition(fr, c, 'replacements', f.id, true)).toEqual({ ok: false, reason: 'Out of supply.' });
    f.untracedMin = 0;

    const enemy = place(fr, 'red', 1);
    enemy.pos = { kind: 'edge', edgeId: 0, s: 1000, dir: -1 };
    expect(card().blocked).toBe('In contact.');
    enemy.strength = 0;

    fr.theater.nodes[0].kind = 'village';
    expect(card()).toMatchObject({ effect: `Up to ${Math.round(REINFORCE_PER_COMPANY * 3 * REFIT_BILLET_MULT)} men.`, blocked: null });
    expect(applyRequisition(fr, c, 'replacements', f.id, true)).toEqual({ ok: true, text: `${Math.round(REINFORCE_PER_COMPANY * 3 * REFIT_BILLET_MULT)} replacements join ${f.name}` });
  });
});
