// The planner's arms beyond the axis attack (jtbug #786): garrison sortie,
// the reserve called in, the supply cut and its relief, the counterattack on
// own ground. Hand-built theaters, so each arm is the only thing that can fire.
import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeWarGoals } from '../src/strategic/goals';
import { OmniscientIntel } from '../src/strategic/intel';
import { BLUE_V2, Commander2, RED_V2, SORTIE_COVER_MIN, type PlannerReport } from '../src/strategic/planner';
import type { Theater } from '../src/strategic/theater';
import { addForce, type Force, type ForceRole, type FrontV2 } from '../src/strategic/theater/force';
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

  it('stays in against an equal', () => {
    const { fr } = setup(100);
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

describe('the reserve is called in for an attack that fails alone', () => {
  it('one group does not go, two go together', () => {
    // Blue holds the objective C in strength. Red's line group and reserve stand at D.
    const fr = world(theater(2), ['blue', 'blue', 'blue', 'red', 'red']);
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 200);
    const line = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 90);
    const reserve = put(fr, 'red', 'reserve', { kind: 'node', nodeId: 3 }, 90);
    const red = commander(fr, 'red');
    const r = red.evaluate(fr, new OmniscientIntel(fr, 'red'))!;
    expect(whys(r)).toEqual([`${line.id}:attack>2`, `${reserve.id}:attack>2`]);
    expect(red.plan!.reserveIds).toEqual([]);
  });

  it('the reserve stays back when the line group clears the odds alone', () => {
    const fr = world(theater(2), ['blue', 'blue', 'blue', 'red', 'red']);
    put(fr, 'blue', 'line', { kind: 'node', nodeId: 2 }, 100);
    const line = put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 90);
    const reserve = put(fr, 'red', 'reserve', { kind: 'node', nodeId: 3 }, 90);
    const red = commander(fr, 'red');
    expect(whys(red.evaluate(fr, new OmniscientIntel(fr, 'red'))!)).toEqual([`${line.id}:attack>2`]);
    expect(red.plan!.reserveIds).toEqual([reserve.id]);
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
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    expect(whys(evalOnce(fr, 'red'))).toEqual([`${group.id}:hunt>1`]);
  });

  it('the same enemy across the line is left alone', () => {
    const fr = world(theater(3), ['blue', 'blue', 'red', 'red', 'red']);
    put(fr, 'blue', 'line', { kind: 'edge', edgeId: 0, s: 1000, dir: -1 }, 30);
    put(fr, 'red', 'line', { kind: 'node', nodeId: 3 }, 100);
    put(fr, 'red', 'reserve', { kind: 'node', nodeId: 4 }, 100);
    expect(evalOnce(fr, 'red').orders.map((o) => o.why)).not.toContain('hunt');
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
    expect(red.evaluate(fr, intel)!.orders).toEqual([]);
    expect(orders).toEqual(['probe']);
  });
});
