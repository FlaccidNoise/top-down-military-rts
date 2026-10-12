// The planner's arms beyond the axis attack (jtbug #786): garrison sortie,
// the reserve called in, the supply cut and its relief, the counterattack on
// own ground, the march into a threatened objective. Hand-built theaters, so each arm is the only thing that can fire.
import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeWarGoals } from '../src/strategic/goals';
import { OmniscientIntel } from '../src/strategic/intel';
import { BLUE_V2, Commander2, GIVE_UP_MIN, RED_V2, redDoctrine, SORTIE_COVER_MIN, SPOIL_FROM_DAY, spoilDelayMin, type PlannerReport } from '../src/strategic/planner';
import type { Theater } from '../src/strategic/theater';
import { addForce, type Force, type ForceRole, type FrontV2 } from '../src/strategic/theater/force';
import { DIG_IN_MIN, orderMove } from '../src/strategic/theater/step';
import { stepWar } from '../src/strategic/theater/war';
import { lineTheater } from './lib/line-theater';

const CAMP = DEFAULT_PRESET.campaign;

// A(0)–B(1)–C(2)–D(3)–E(4) in a line, 2000 m apart, plus any extra roads.
// Blue's depot is A, red's is E.
function theater(objective: number, extra: [number, number, number][] = []): Theater {
  const t = lineTheater();
  const road = (id: number, a: number, b: number, lengthM: number): Theater['edges'][number] => ({ ...t.edges[0], id, a, b, lengthM, polyline: [t.nodes[a]?.pos ?? { x: a * 2000, y: 1000 }, { x: b * 2000, y: 1000 }] });
  t.nodes.push({ ...t.nodes[0], id: 4, pos: { x: 8000, y: 1000 }, name: 'N4' });
  t.edges.push(road(3, 3, 4, 2000));
  extra.forEach(([a, b, len], i) => t.edges.push(road(4 + i, a, b, len)));
  t.boundsM = { w: 10000, h: 2000 };
  t.objectiveNodes = [objective];
  t.sources = { blue: [0], red: [4] };
  return t;
}

function world(t: Theater, control: ('blue' | 'red')[]): FrontV2 {
  return { theater: t, clockMin: 600, day: 1, nextForceId: 0, nextBattleId: 0, forces: [], controlByNode: control, battles: [], events: [], defileQueues: {} };
}

const put = (fr: FrontV2, side: 'blue' | 'red', role: ForceRole, pos: Force['pos'], strength: number): Force =>
  addForce(fr, { side, name: `${side} ${role} ${fr.forces.length}`, pos, path: [], dwellMin: 0, strength, companyIndex: side === 'blue' ? fr.forces.filter((f) => f.side === 'blue').length : -1, role, engagedIn: null, queuedAt: null });

const commander = (fr: FrontV2, side: 'blue' | 'red'): Commander2 => new Commander2(side, side === 'red' ? RED_V2 : BLUE_V2, makeWarGoals(fr.theater, CAMP), CAMP.warDays);
const evalOnce = (fr: FrontV2, side: 'blue' | 'red'): PlannerReport => commander(fr, side).evaluate(fr, new OmniscientIntel(fr, side))!;
const whys = (r: PlannerReport): string[] => r.orders.map((o) => `${o.forceId}:${o.why}>${o.dest}`);

describe('garrison sortie', () => {
  const setup = (blueStrength: number): { fr: FrontV2; garrison: Force; prey: Force } => {
    const fr = world(theater(2), ['blue', 'blue', 'red', 'red', 'red']);
    const garrison = put(fr, 'red', 'garrison', { kind: 'node', nodeId: 2 }, 100);
    // Thrown back down the B-C road: 1500 m short of the garrison's post.
    const prey = put(fr, 'blue', 'line', { kind: 'edge', edgeId: 1, s: 500, dir: -1 }, blueStrength);
    return { fr, garrison, prey };
  };

  it('a garrison remembers its post', () => {
    const { garrison, prey } = setup(30);
    expect(garrison.homeNode).toBe(2);
    expect(prey.homeNode).toBeNull();
  });

  it('sorties on a clearly weaker enemy next door, fights it, and comes home', () => {
    const { fr, garrison, prey } = setup(30);
    const red = commander(fr, 'red');
    const intel = new OmniscientIntel(fr, 'red');
    const campaign = newCampaign(1, 1);
    const seen: string[] = [];
    let attackedBy = -1;
    for (let m = 0; m < 600; m++) {
      for (const o of red.evaluate(fr, intel)?.orders ?? []) seen.push(o.why);
      stepWar(fr, campaign, { autoBattle: () => true });
      if (fr.battles.length > 0) attackedBy = fr.battles[0].attackerId;
    }
    expect(seen[0]).toBe('sortie');
    expect(attackedBy).toBe(garrison.id);
    expect(seen).toContain('return');
    expect(garrison.pos).toEqual({ kind: 'node', nodeId: 2 });
    expect(garrison.path).toEqual([]);
    // The beaten company was parked facing its rear. It falls back that way,
    // onto the A-B road, not out through the post it was attacked from.
    expect(prey.strength).toBeGreaterThan(0);
    expect(prey.pos).toMatchObject({ kind: 'edge', edgeId: 0 });
  });

  it('stays in against a stronger enemy', () => {
    // On a road an equal is a fight the attacker wins three times in four
    // (jtbug #797): the garrison stays in for one it would lose.
    const { fr } = setup(140);
    expect(evalOnce(fr, 'red').orders).toEqual([]);
  });

  it('stays in when a second enemy could walk into the post meanwhile', () => {
    const { fr } = setup(30);
    // A is 4000 m from the post: 80 minutes by road, inside the cover time.
    expect(4000 / 50).toBeLessThan(SORTIE_COVER_MIN);
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 0 }, 100);
    expect(evalOnce(fr, 'red').orders).toEqual([]);
  });
});

// #808. A garrison stood and died at any odds. C and E are objectives, a
// road joins them that does not pass D, and a blue company stands at D:
// 40 minutes from C, and 40 from E.
describe('a garrison gives up a post it cannot hold', () => {
  const setup = (cfg: { small?: number; need?: number; doctrine?: typeof RED_V2 } = {}) => {
    const t = theater(2, [[2, 4, 3000]]);
    t.objectiveNodes = [2, 3, 4];
    const fr = world(t, ['blue', 'blue', 'red', 'blue', 'red']);
    const small = put(fr, 'red', 'garrison', { kind: 'node', nodeId: 2 }, cfg.small ?? 30);
    const big = put(fr, 'red', 'garrison', { kind: 'node', nodeId: 4 }, 160); // holds E against the company, and is not strong enough to sortie on it
    const blue = put(fr, 'blue', 'line', { kind: 'node', nodeId: 3 }, 150);
    const goals = { ...makeWarGoals(t, CAMP), blue: [{ kind: 'control' as const, nodeIds: [2, 3, 4], need: cfg.need ?? 3 }] };
    const red = new Commander2('red', cfg.doctrine ?? RED_V2, goals, CAMP.warDays);
    const intel = new OmniscientIntel(fr, 'red');
    return { fr, small, big, blue, red, intel, first: () => whys(red.evaluate(fr, intel)!) };
  };

  it('30 men against a company 40 minutes off fall back on the next objective, by a forced march, and dig in there', () => {
    expect(2000 / 50).toBeLessThan(GIVE_UP_MIN);
    const { fr, small, red, intel, first } = setup();
    expect(first()).toEqual([`${small.id}:give-up>4`]);
    expect(small.posture).toBe('forced');
    // The log says so. Under fog the HUD shows the line only while the garrison is a contact.
    expect(fr.events.at(-1)).toMatchObject({ kind: 'retreat', forceIds: [small.id], text: `${small.name} gives up ${fr.theater.nodes[2].name} and falls back on ${fr.theater.nodes[4].name}` });
    const campaign = newCampaign(1, 1);
    const seen: string[] = [];
    for (let m = 0; m < 400; m++) {
      for (const o of red.evaluate(fr, intel)?.orders ?? []) seen.push(o.why);
      stepWar(fr, campaign, { autoBattle: () => true });
    }
    expect(small.pos).toEqual({ kind: 'node', nodeId: 4 });
    expect(small.strength).toBe(30); // it met nobody
    expect(small.posture).toBe('dig');
    expect(seen).not.toContain('return'); // the company still stands 40 minutes from its post
  });

  it('the company that walks into the empty town is told the garrison pulled out', () => {
    const { fr, blue, red, intel } = setup();
    const campaign = newCampaign(1, 1);
    for (let m = 0; m < 300; m++) {
      if (m === 120) orderMove(fr, blue.id, 2);
      red.evaluate(fr, intel);
      stepWar(fr, campaign, { autoBattle: () => true });
    }
    expect(fr.controlByNode[2]).toBe('blue');
    expect(fr.events.filter((e) => e.kind === 'capture').map((e) => e.text)).toEqual([`${blue.name} takes ${fr.theater.nodes[2].name}: the garrison has pulled out`]);
  });

  it('it goes home when no enemy is closing on the post any more', () => {
    const { fr, small, blue, red, intel } = setup();
    const campaign = newCampaign(1, 1);
    const seen: string[] = [];
    for (let m = 0; m < 900; m++) {
      if (m === 400) blue.strength = 0;
      for (const o of red.evaluate(fr, intel)?.orders ?? []) seen.push(o.why);
      stepWar(fr, campaign, { autoBattle: () => true });
    }
    expect(seen).toContain('return');
    expect(small.pos).toEqual({ kind: 'node', nodeId: 2 });
  });

  it('a garrison that can make a fight of it stands', () => {
    expect(setup({ small: 120 }).first()).toEqual([]);
  });

  it('it stands on the last objective the enemy needs', () => {
    // Blue holds D and needs two of the three: C would give him the war.
    expect(setup({ need: 2 }).first()).toEqual([]);
  });

  it('with nowhere to go it stands', () => {
    const { fr, big, first } = setup();
    fr.controlByNode[4] = 'blue'; // the other objective is lost
    big.strength = 0;
    expect(first()).toEqual([]);
  });

  it('at enemy strength 0 and 1 a garrison never leaves: a first campaign has a first battle', () => {
    expect(redDoctrine(4)).toBe(RED_V2);
    expect(redDoctrine(2).giveUpOdds).toBeGreaterThan(0);
    for (const strength of [0, 1]) expect(setup({ doctrine: redDoctrine(strength) }).first()).toEqual([]);
  });
});

describe('the reserve is called in for an attack that fails alone', () => {
  it('one group does not go, two go together', () => {
    // Blue holds the objective C in strength. Red's line group and reserve stand at D.
    const fr = world(theater(2), ['blue', 'blue', 'blue', 'red', 'red']);
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 100);
    const line = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 90);
    const reserve = put(fr, 'red', 'reserve', { kind: 'node', nodeId: 3 }, 90);
    const red = commander(fr, 'red');
    const r = red.evaluate(fr, new OmniscientIntel(fr, 'red'))!;
    expect(whys(r)).toEqual([`${line.id}:attack>2`, `${reserve.id}:attack>2`]);
    expect(red.plan!.reserveIds).toEqual([]);
  });

  it('the reserve stays back when the line group clears the odds alone', () => {
    const fr = world(theater(2), ['blue', 'blue', 'blue', 'red', 'red']);
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 60);
    const line = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 90);
    const reserve = put(fr, 'red', 'reserve', { kind: 'node', nodeId: 3 }, 90);
    const red = commander(fr, 'red');
    expect(whys(red.evaluate(fr, new OmniscientIntel(fr, 'red'))!)).toEqual([`${line.id}:attack>2`]);
    expect(red.plan!.reserveIds).toEqual([reserve.id]);
  });
});

describe('postures', () => {
  it('a garrison digs in at its post, and its sortie is a forced march', () => {
    const fr = world(theater(2), ['blue', 'blue', 'red', 'red', 'red']);
    const garrison = put(fr, 'red', 'garrison', { kind: 'node', nodeId: 2 }, 100);
    evalOnce(fr, 'red');
    expect(garrison.posture).toBe('dig');
    put(fr, 'blue', 'line', { kind: 'edge', edgeId: 1, s: 500, dir: -1 }, 30);
    expect(whys(evalOnce(fr, 'red'))).toEqual([`${garrison.id}:sortie>1`]);
    expect(garrison.posture).toBe('forced');
    expect(garrison.dugMin).toBe(0);
  });

  it('a tired force with no enemy near rests; an enemy near keeps it up', () => {
    const fr = world(theater(3), ['blue', 'red', 'red', 'red', 'red']);
    const tired = put(fr, 'red', 'line', { kind: 'node', nodeId: 1 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    tired.fatigue = 0.8;
    evalOnce(fr, 'red');
    expect(tired.posture).toBe('rest');
    put(fr, 'blue', 'line', { kind: 'edge', edgeId: 0, s: 1000, dir: 1 }, 100);
    evalOnce(fr, 'red');
    expect(tired.posture).toBe('march');
  });

  it('a dug-in defender is weighed as dug in: the same attack then needs the reserve', () => {
    const attack = (dug: boolean): string[] => {
      const fr = world(theater(2), ['blue', 'blue', 'blue', 'red', 'red']);
      const def = put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 77);
      if (dug) {
        def.posture = 'dig';
        def.dugMin = DIG_IN_MIN;
      }
      put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 90);
      put(fr, 'red', 'reserve', { kind: 'node', nodeId: 3 }, 90);
      return whys(evalOnce(fr, 'red'));
    };
    expect(attack(false)).toEqual(['1:attack>2']);
    expect(attack(true)).toEqual(['1:attack>2', '2:attack>2']);
  });
});

describe('supply cut and relief', () => {
  // D-B is a back road round the blue company at C, and the quicker way to
  // B. B is the one node the company's supply runs through.
  const backRoad = (): FrontV2 => world(theater(3, [[3, 1, 3000]]), ['blue', 'blue', 'blue', 'red', 'red']);

  it('a free group marches on the node that cuts an enemy off', () => {
    const fr = backRoad();
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 138);
    const raider = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    expect(whys(evalOnce(fr, 'red'))).toEqual([`${raider.id}:cut>1`]);
  });

  it('with nobody to cut off it takes the nearest open node', () => {
    const fr = backRoad();
    const raider = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    expect(whys(evalOnce(fr, 'red'))).toEqual([`${raider.id}:probe>2`]);
  });

  it('under fog a probe goes as a screen; with full knowledge at a march', () => {
    for (const fog of [false, true]) {
      const fr = backRoad();
      const raider = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
      put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
      const red = new Commander2('red', RED_V2, makeWarGoals(fr.theater, CAMP), CAMP.warDays, { fog });
      expect(whys(red.evaluate(fr, new OmniscientIntel(fr, 'red'))!)).toEqual([`${raider.id}:probe>2`]);
      expect(raider.posture).toBe(fog ? 'screen' : 'march');
    }
  });

  it('never marches on the enemy depot', () => {
    const fr = world(theater(3), ['blue', 'red', 'red', 'red', 'red']);
    put(fr, 'red', 'line', { kind: 'node', nodeId: 1 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    expect(evalOnce(fr, 'red').orders).toEqual([]);
  });

  it('a cut-off company is relieved before anything else', () => {
    const fr = backRoad();
    fr.controlByNode[1] = 'red'; // the raider took B and moved on
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 138);
    const rescuer = put(fr, 'blue', 'line', { kind: 'node', nodeId: 0 }, 138);
    expect(whys(evalOnce(fr, 'blue'))).toContain(`${rescuer.id}:relieve>1`);
  });
});

describe('counterattack', () => {
  it('a weak enemy on a road out of our node is attacked', () => {
    const fr = world(theater(3), ['blue', 'blue', 'red', 'red', 'red']);
    put(fr, 'blue', 'line', { kind: 'edge', edgeId: 1, s: 500, dir: -1 }, 30);
    const group = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
    const reserve = put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    // The reserve covers the objective the hunter leaves open.
    expect(whys(evalOnce(fr, 'red'))).toEqual([`${group.id}:hunt>1`, `${reserve.id}:reinforce>3`]);
  });

  // A weak blue company on the A-B road, across the line from red's group at D.
  const acrossTheLine = (day: number): { fr: FrontV2; group: Force } => {
    const fr = world(theater(3), ['blue', 'blue', 'red', 'red', 'red']);
    fr.day = day;
    fr.clockMin = (day - 1) * 1440 + 30; // half past midnight on that day
    put(fr, 'blue', 'line', { kind: 'edge', edgeId: 0, s: 1000, dir: -1 }, 30);
    const group = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    return { fr, group };
  };

  it('the same enemy across the line is left alone on the first day', () => {
    expect(evalOnce(acrossTheLine(1).fr, 'red').orders.map((o) => o.why)).not.toContain('hunt');
  });

  it('from the second day red crosses the line for it: a spoiling attack (jtbug #799)', () => {
    const { fr, group } = acrossTheLine(SPOIL_FROM_DAY);
    // On A: the march there is the one that meets it.
    expect(whys(evalOnce(fr, 'red'))).toContain(`${group.id}:hunt>0`);
  });

  it('the hour it may start is the war\'s own: not before its delay has run, and from then on (jtbug #808)', () => {
    const { fr, group } = acrossTheLine(SPOIL_FROM_DAY);
    const late = new Commander2('red', RED_V2, makeWarGoals(fr.theater, CAMP), CAMP.warDays, { spoilDelayMin: 360 });
    const intel = new OmniscientIntel(fr, 'red');
    expect(late.evaluate(fr, intel)!.orders.map((o) => o.why)).not.toContain('hunt');
    fr.clockMin += 360;
    expect(whys(late.evaluate(fr, intel)!)).toContain(`${group.id}:hunt>0`);
    // Five start hours over the seeds, a quarter of a day apart, and a seed keeps its own.
    const delays = Array.from({ length: 200 }, (_, seed) => spoilDelayMin(seed + 1));
    expect([...new Set(delays)].sort((a, b) => a - b)).toEqual([0, 360, 720, 1080, 1440]);
    expect(spoilDelayMin(7)).toBe(spoilDelayMin(7));
  });

  it('not for one beyond its reach, and blue has no spoiling attack', () => {
    const { fr } = acrossTheLine(SPOIL_FROM_DAY);
    // B is 80 march minutes from D.
    const short = new Commander2('red', { ...RED_V2, spoilMinutes: 60 }, makeWarGoals(fr.theater, CAMP), CAMP.warDays);
    expect(short.evaluate(fr, new OmniscientIntel(fr, 'red'))!.orders.map((o) => o.why)).not.toContain('hunt');
    expect(BLUE_V2.spoilMinutes).toBe(0);
  });
});

describe('reinforce (jtbug #799)', () => {
  // Red holds the objective C with a handful. Blue stands at A, 80 minutes out.
  const setup = (blueStrength: number, redAt: number): { fr: FrontV2; group: Force } => {
    const fr = world(theater(2), ['blue', 'blue', 'red', 'red', 'red']);
    put(fr, 'red', 'garrison', { kind: 'node', nodeId: 2 }, 10);
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 0 }, blueStrength);
    return { fr, group: put(fr, 'red', 'line', { kind: 'node', nodeId: redAt }, 90) };
  };

  it('a free group marches into the objective the enemy is closing on, forced', () => {
    const { fr, group } = setup(150, 3);
    expect(whys(evalOnce(fr, 'red'))).toEqual([`${group.id}:reinforce>2`]);
    expect(group.posture).toBe('forced');
  });

  it('a group already there stays and digs in', () => {
    const { fr, group } = setup(150, 2);
    expect(evalOnce(fr, 'red').orders).toEqual([]);
    expect(group.posture).toBe('dig');
  });

  it('it does not go when the enemy would be there first', () => {
    const { fr } = setup(150, 4);
    fr.forces.find((f) => f.side === 'blue')!.pos = { kind: 'node', nodeId: 1 };
    expect(evalOnce(fr, 'red').orders.map((o) => o.why)).not.toContain('reinforce');
  });

  it('it does not feed a defence that is lost with it there', () => {
    const { fr } = setup(5000, 3);
    expect(evalOnce(fr, 'red').orders.map((o) => o.why)).not.toContain('reinforce');
  });

  it('no enemy near, no reinforcement', () => {
    const fr = world(theater(2), ['blue', 'blue', 'red', 'red', 'red']);
    put(fr, 'red', 'garrison', { kind: 'node', nodeId: 2 }, 10);
    put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 90);
    expect(evalOnce(fr, 'red').orders.map((o) => o.why)).not.toContain('reinforce');
  });
});

describe('a march is finished', () => {
  it('a marching force gets no new order while nothing overwhelms it', () => {
    const fr = world(theater(3, [[3, 1, 5000]]), ['blue', 'blue', 'blue', 'red', 'red']);
    const raider = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    const red = commander(fr, 'red');
    const intel = new OmniscientIntel(fr, 'red');
    const campaign = newCampaign(1, 1);
    const orders: string[] = [];
    for (let m = 0; m < 30; m++) {
      for (const o of red.evaluate(fr, intel)?.orders ?? []) orders.push(o.why);
      stepWar(fr, campaign, { autoBattle: () => true });
    }
    expect(raider.path.length).toBeGreaterThan(0);
    // A better target appears mid-march: a blue company whose line runs through B.
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 0 }, 20);
    fr.clockMin += 60;
    expect(red.evaluate(fr, intel)!.orders.filter((o) => o.forceId === raider.id)).toEqual([]);
    expect(orders).toEqual(['probe']);
  });
});
