// The contact card's copy (jtbug #782): short, and every number in it owned
// by a constant or a live function.
// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { fmtEta } from '../src/render/theater-view';
import { TRIVIAL_RATIO } from '../src/strategic/bridge';
import { makeHeadlessWorld } from '../src/strategic/headless';
import type { Contact } from '../src/strategic/theater/contact';
import { SUPPLY_OUT_MIN } from '../src/strategic/theater/supply';
import { DIG_IN_MIN } from '../src/strategic/theater/step';
import { battleDuration, openBattle, RETREAT_SETBACK_M } from '../src/strategic/theater/war';
import { briefWords, contactBrief } from '../src/ui/contact-brief';

const OPTS = { supply: true, fog: false };

// Able has walked up to the first garrisoned objective.
function atContact(): { front: ReturnType<typeof makeHeadlessWorld>['front']; c: Contact } {
  const { front } = makeHeadlessWorld(19440606, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
  const atk = front.forces.find((f) => f.side === 'blue')!;
  const def = front.forces.find((f) => f.side === 'red' && f.role === 'garrison' && f.pos.kind === 'node')!;
  atk.pos = { ...def.pos };
  return { front, c: { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: 0 } };
}

describe('contact brief', () => {
  it('says what the player needs in under 45 words, attacking or defending', () => {
    const { front, c } = atContact();
    const attack = contactBrief(front, c, OPTS);
    expect(briefWords(attack).length).toBeLessThan(45);
    const defend = contactBrief(front, { ...c, attackerId: c.defenderId, defenderId: c.attackerId }, OPTS);
    expect(briefWords(defend).length).toBeLessThan(45);
  });

  it('names the fight, the map to expect, both sides and their condition', () => {
    const { front, c } = atContact();
    const def = front.forces.find((f) => f.id === c.defenderId)!;
    const atk = front.forces.find((f) => f.id === c.attackerId)!;
    atk.fatigue = 0.7;
    atk.untracedMin = SUPPLY_OUT_MIN;
    const b = contactBrief(front, c, OPTS);
    expect(b.title).toBe(front.theater.nodes[(def.pos as { nodeId: number }).nodeId].name);
    expect(b.kind).toMatch(/ · map: /);
    expect(b.sides.map((s) => [s.name, s.men])).toEqual([[atk.name, `${atk.strength} men`], [def.name, `${def.strength} men`]]);
    expect(b.sides[0].state).toBe('out of supply · exhausted');
    expect(b.sides[1].state).toBe('supplied · fresh');
    // Under fog the enemy's condition is not ours to print; with supply rules off it is not printed at all.
    expect(contactBrief(front, c, { supply: true, fog: true }).sides[1].state).toBe('condition unknown');
    expect(contactBrief(front, c, { supply: false, fog: false }).sides[0].state).toBe('exhausted');
  });

  it('prints the time the fight costs and the stand-down distance from their owners', () => {
    const { front, c } = atContact();
    const atk = front.forces.find((f) => f.id === c.attackerId)!;
    const def = front.forces.find((f) => f.id === c.defenderId)!;
    const b = contactBrief(front, c, OPTS);
    expect(b.facts).toContain(`Costs ${fmtEta(battleDuration(atk.strength, def.strength, false))}.`);
    expect(b.facts).toContain(`Stand down: fall back ${RETREAT_SETBACK_M / 1000} km, no losses.`);
    expect(b.forced).toBeNull();
    // A defender is told why there is no Stand down, in the words the tutorial gate reads.
    const defend = contactBrief(front, { ...c, attackerId: c.defenderId, defenderId: c.attackerId }, OPTS);
    expect(defend.forced).toBe('They chose this fight. A defender cannot stand down.');
    expect(defend.facts.some((f) => f.startsWith('Stand down'))).toBe(false);
  });

  it('offers auto-resolve on a walkover and says who is in range, honestly', () => {
    const { front, c } = atContact();
    const def = front.forces.find((f) => f.id === c.defenderId)!;
    def.strength = 10;
    const b = contactBrief(front, c, OPTS);
    expect(b.trivial).toBe(true);
    expect(b.odds.endsWith(' A walkover: auto-resolve offered.')).toBe(true);
    expect(b.facts[0]).toBe('None in range to join.');
    const other = front.forces.filter((f) => f.side === 'blue')[1];
    other.pos = { ...def.pos };
    expect(contactBrief(front, c, OPTS).facts[0]).toBe(`In range: ${other.name}. They join only an auto-resolved fight.`);
  });

  // Isolation as a weapon (jtbug #786): the same garrison, the same company.
  // Supplied it is a fight. Cut off and starved it is a walkover, and the card
  // says why. Dug in, numbers alone are not enough, and the card says that.
  it('a starved garrison is a walkover, a supplied one is not, and the card says why', () => {
    const { front, c } = atContact();
    const atk = front.forces.find((f) => f.id === c.attackerId)!;
    const def = front.forces.find((f) => f.id === c.defenderId)!;
    def.strength = Math.floor((atk.strength / TRIVIAL_RATIO) * 1.5); // 3.3:1 in men
    expect(contactBrief(front, c, OPTS).trivial).toBe(false);
    def.untracedMin = SUPPLY_OUT_MIN;
    const starved = contactBrief(front, c, OPTS);
    expect(starved.trivial).toBe(true);
    expect(starved.odds).toContain('They are out of supply. A walkover: auto-resolve offered.');
    // The offer is the forced winner the battle is opened with.
    expect(openBattle(front, c).forced).toBe('attacker');
  });

  it('a dug-in garrison denies the walkover its numbers would give', () => {
    const { front, c } = atContact();
    const def = front.forces.find((f) => f.id === c.defenderId)!;
    def.strength = 25;
    def.posture = 'march';
    expect(contactBrief(front, c, OPTS).trivial).toBe(true);
    def.posture = 'dig';
    def.dugMin = DIG_IN_MIN;
    const dug = contactBrief(front, c, OPTS);
    expect(dug.trivial).toBe(false);
    expect(dug.odds).toContain('No walkover: they are dug in.');
  });

  it('types no tracked number into its copy', () => {
    const source = readFileSync(new URL('../src/ui/contact-brief.ts', import.meta.url), 'utf8') as string;
    const copy = source.replace(/\/\/.*$/gm, '');
    // The setback, the trivial ratio, contact range and the battle cap live elsewhere.
    for (const literal of ['1.5 km', '1500', '5:1', '300 m', '240']) expect(copy, literal).not.toContain(literal);
  });
});
