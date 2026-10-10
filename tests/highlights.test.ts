import { describe, expect, it } from 'vitest';
import { makeDrill } from '../src/drill';
import { GameMap } from '../src/sim/map';
import { Sim, type UnitEvent } from '../src/sim/sim';
import { Highlights, HIGHLIGHTS_SHOWN } from '../src/ui/highlights';

function squadSim(): Sim {
  const sim = new Sim(new GameMap(40, 40), 3);
  sim.addSquadFromDef('blue', 'us_rifle', 10, 10);
  sim.addSquadFromDef('red', 'de_gruppe', 30, 30);
  return sim;
}
const blue = (sim: Sim) => sim.soldiers.filter((s) => s.side === 'blue');
const ev = (sim: Sim, kind: UnitEvent['kind'], id: number): UnitEvent => {
  const s = sim.soldiers[id];
  return { kind, x: s.x, y: s.y, side: s.side, name: s.name, id };
};
const words = (line: string): number => line.split(/\s+/).length;

describe('Highlights', () => {
  it('has nothing to say about a battle in which nothing happened', () => {
    expect(new Highlights().top()).toEqual([]);
  });

  it('names the man who dragged a casualty to cover, read off the rescue task', () => {
    const sim = squadSim();
    const [helper, casualty] = blue(sim);
    const h = new Highlights();
    helper.task = { kind: 'rescue', casualtyId: casualty.id, phase: 'goto', timer: 0 };
    h.observe(sim);
    helper.task.phase = 'drag';
    h.observe(sim);
    helper.task.phase = 'aid';
    h.observe(sim);
    helper.task = null;
    h.add([ev(sim, 'stabilized', casualty.id)], sim);
    expect(h.top()).toEqual([`${helper.name} dragged ${casualty.name} to cover.`]);
  });

  it('tells first aid given where the man fell from a drag', () => {
    const sim = squadSim();
    const [helper, casualty] = blue(sim);
    const h = new Highlights();
    helper.task = { kind: 'rescue', casualtyId: casualty.id, phase: 'aid', timer: 1 };
    h.observe(sim);
    h.add([ev(sim, 'stabilized', casualty.id)], sim);
    expect(h.top()).toEqual([`${helper.name} stopped ${casualty.name}'s bleeding.`]);
  });

  it('says nothing of a man stabilized by nobody it saw', () => {
    const sim = squadSim();
    const h = new Highlights();
    h.add([ev(sim, 'stabilized', blue(sim)[0].id)], sim);
    expect(h.top()).toEqual([]);
  });

  it('is about the player\'s men: an enemy who rallies or surrenders is not a highlight', () => {
    const sim = squadSim();
    const red = sim.soldiers.find((s) => s.side === 'red')!;
    const h = new Highlights();
    h.add([ev(sim, 'rallied', red.id), ev(sim, 'surrendered', red.id), ev(sim, 'grenade', red.id), ev(sim, 'took-over', red.id)], sim);
    expect(h.top()).toEqual([]);
  });

  it('tells an enemy tank brewing up as the player\'s, and his own as his loss', () => {
    const sim = squadSim();
    const h = new Highlights();
    h.add([{ kind: 'vehicle-destroyed', x: 5, y: 5, side: 'red', name: 'StuG III' }, { kind: 'vehicle-destroyed', x: 5, y: 5, side: 'blue', name: 'M4 Sherman' }], sim);
    expect(h.top()).toEqual(['An enemy StuG III brewed up.', 'Your M4 Sherman brewed up.']);
  });

  it('shows at most three, the most dramatic first, one of a kind before two', () => {
    const sim = squadSim();
    const men = blue(sim);
    const h = new Highlights();
    h.add([ev(sim, 'rallied', men[0].id), ev(sim, 'rallied', men[1].id), ev(sim, 'rallied', men[2].id), ev(sim, 'grenade', men[3].id), ev(sim, 'took-over', men[4].id), ev(sim, 'promoted', men[5].id)], sim);
    const top = h.top();
    expect(top).toHaveLength(HIGHLIGHTS_SHOWN);
    expect(top[0]).toBe(`${men[4].name} took over the gun.`);
    expect(top[1]).toBe(`${men[5].name} took command of ${sim.squads[men[5].squadId].name}.`);
    expect(top[2]).toMatch(/rallied under fire\.$/);
    expect(top.filter((l) => /rallied/.test(l))).toHaveLength(1);
  });

  it('fills up with a second of a kind when there is nothing else', () => {
    const sim = squadSim();
    const men = blue(sim);
    const h = new Highlights();
    h.add([ev(sim, 'rallied', men[0].id), ev(sim, 'rallied', men[1].id)], sim);
    expect(h.top()).toHaveLength(2);
  });

  it('counts a man\'s grenades in one line', () => {
    const sim = squadSim();
    const [man] = blue(sim);
    const h = new Highlights();
    h.add([ev(sim, 'grenade', man.id)], sim);
    expect(h.top()).toEqual([`${man.name} threw a grenade.`]);
    h.add([ev(sim, 'grenade', man.id), ev(sim, 'grenade', man.id)], sim);
    expect(h.top()).toEqual([`${man.name} threw 3 grenades.`]);
  });

  it('keeps every line to one short line', () => {
    const sim = squadSim();
    const men = blue(sim);
    const h = new Highlights();
    men[0].task = { kind: 'rescue', casualtyId: men[1].id, phase: 'drag', timer: 0 };
    h.observe(sim);
    h.add([ev(sim, 'stabilized', men[1].id), ev(sim, 'promoted', men[2].id), ev(sim, 'recovered', men[3].id), ev(sim, 'surrendered', men[4].id)], sim);
    for (const line of h.top(10)) expect(words(line), line).toBeLessThanOrEqual(8);
  });

  it('forgets the last battle', () => {
    const sim = squadSim();
    const h = new Highlights();
    h.add([ev(sim, 'rallied', blue(sim)[0].id)], sim);
    h.reset();
    expect(h.top()).toEqual([]);
  });
});

// The recorder is only worth its place if a real fight feeds it. Forced inputs
// above prove the wording, this proves the wiring: a live battle, the events the
// sim really raises, and the rescue tasks it really runs.
describe('Highlights, fed by a live battle', () => {
  function fight(seed: number): string[] {
    const d = makeDrill(seed);
    const { sim } = d;
    const h = new Highlights();
    // No fire first: three squads straight across the field, which is the costly way.
    for (const q of d.rifles) sim.orderSquad(q, { kind: 'assault', x: d.house.x, y: d.house.y });
    for (let i = 0; i < 30 * 240 && !sim.winner; i++) {
      sim.step();
      h.observe(sim);
      h.add(sim.takeUnitEvents(), sim);
    }
    return h.top(10);
  }

  it('finds something to tell in a costly assault, on most seeds', () => {
    const told = [1, 2, 3, 4, 5, 6].map(fight);
    expect(told.filter((t) => t.length > 0).length, told.map((t, i) => `seed ${i + 1}: ${t.join(' | ') || '(nothing)'}`).join('\n')).toBeGreaterThanOrEqual(4);
  });
});
