// The drill: one fixed, small training battle, played before the campaign and
// again from the menu. A US platoon takes one farmhouse from eight riflemen.
//
// It is not a campaign and nothing in it is scripted: the map and the forces
// are authored here, the fight is the live sim, and the defender's whole plan
// is to hold the house it stands in. That is why it needs no commander, and
// why it cannot drift the way a staged campaign against a goal-driven enemy
// does (docs/decisions/INDEX.md, 2026-07-28 UI: the tutorial entry). The men
// are not campaign soldiers, so nothing that happens here follows the player
// into the war.
//
// The ground teaches three things in the order a fight needs them: a hedge to
// move to (cover), a house to shoot at across an open field (fire), and the
// field itself (an assault crosses it once nobody in the house is shooting).
import { stampStructure } from './sim/bourg/stamp';
import { GameMap } from './sim/map';
import type { Building } from './sim/mapgen';
import { orderVerdict, visibleEnemies } from './sim/orders';
import { Sim, type MemberInit, type Soldier } from './sim/sim';

export const DRILL_MAP = { w: 96, h: 64 } as const;

/**
 * The hedgerow the first squad is sent to: a double line down the map, west of
 * the field. One hedge is something a man sees through. Two are not, so the
 * start line is out of sight of the house and the fight starts when the
 * player's first order arrives, not before it.
 */
const HEDGE_X = 36;
const HEDGE_BACK_X = 33;
const HEDGE_Y0 = 4;
const HEDGE_Y1 = 59;
/** The row the farm track and the middle squad share. */
const TRACK_Y = 32;

const FARMHOUSE: Building = { x: 64, y: 27, w: 9, h: 6, role: 'farmhouse', frontage: 'w' };

/**
 * The platoon's start line: three rifle squads abreast, far enough apart that
 * each reads as one group to tap, and the gun behind the middle one. The
 * middle squad is the first: it is the one the lesson starts with.
 */
const SQUAD_X = 14;
const SQUADS = [
  { name: '1st Squad', y: 32 },
  { name: '2nd Squad', y: 15 },
  { name: '3rd Squad', y: 49 },
] as const;
const GUN = { x: 6, y: 32 } as const;

/** The garrison: riflemen only. A machine gun in the windows is a lesson for a later day. */
export const DRILL_DEFENDERS = 8;
const GARRISON_ARC_HALF = Math.PI / 3; // they watch the field, west of the house

export interface Drill {
  sim: Sim;
  /** The squad the first steps ring: 1st Squad, in the middle, opposite the house. */
  lead: number;
  /** The rifle squads, lead included. */
  rifles: number[];
  /** Where the first order is meant to land: between the hedges, opposite the house. */
  hedge: { x: number; y: number; r: number };
  /** The farmhouse: its centre, and a radius that takes it in. */
  house: { x: number; y: number; r: number };
}

function drillMap(): GameMap {
  const map = new GameMap(DRILL_MAP.w, DRILL_MAP.h);
  // The field between the hedge and the farm: open, and seen from every window.
  for (let y = 16; y < 48; y++) for (let x = HEDGE_X + 2; x < FARMHOUSE.x - 3; x++) map.setTerrain(x, y, 'field');
  // The farm track comes in from the east. Nothing breaks the hedges.
  for (let x = FARMHOUSE.x + FARMHOUSE.w; x < DRILL_MAP.w; x++) map.setTerrain(x, TRACK_Y, 'road');
  for (let y = HEDGE_Y0; y <= HEDGE_Y1; y++) {
    map.setTerrain(HEDGE_BACK_X, y, 'hedge');
    map.setTerrain(HEDGE_X, y, 'hedge');
  }
  // Woods on the flanks close the picture off and give the eye an edge.
  const stand = (cx: number, cy: number, r: number): void => {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (map.inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r + 0.3 && map.terrainKeyAt(x, y) === 'grass') map.setTerrain(x, y, 'woods');
  };
  stand(22, 4, 5);
  stand(50, 58, 6);
  stand(86, 10, 7);
  stand(88, 50, 6);
  stampStructure(map, FARMHOUSE, 0);
  map.maxStories = 1;
  return map;
}

/**
 * Stage the drill. `seed` is the battle's own dice: the ground and the forces
 * are the same every time, the fight is not.
 */
export function makeDrill(seed: number): Drill {
  const sim = new Sim(drillMap(), seed);
  sim.buildings = [FARMHOUSE];
  // Nothing to call in: the lesson is the three orders, not the support net.
  sim.barragesLeft.blue = 0;
  sim.airstrikesLeft.blue = 0;
  sim.barragesLeft.red = 0;

  const rifles = SQUADS.map((q) => {
    const squad = sim.addSquadFromDef('blue', 'us_rifle', SQUAD_X, q.y);
    squad.name = q.name;
    return squad.id;
  });
  sim.addSquadFromDef('blue', 'us_m1919', GUN.x, GUN.y).name = 'MG Team';

  const men: MemberInit[] = Array.from({ length: DRILL_DEFENDERS }, (_, i) => ({
    name: `Schütze ${i + 1}`,
    weapon: 'kar98k' as const,
    x: FARMHOUSE.x + 1.5 + (i % 2) * 2,
    y: FARMHOUSE.y + 0.5 + Math.floor(i / 2) * 1.5,
  }));
  const garrison = sim.addSquad('red', 'Garnison', men);
  // They hold the house, facing the field. An order given where a team already
  // stands is never refused, so this is the whole of the defender's plan.
  sim.orderSquad(garrison.id, { kind: 'defend', x: FARMHOUSE.x + FARMHOUSE.w / 2, y: FARMHOUSE.y + FARMHOUSE.h / 2, arc: [Math.PI - GARRISON_ARC_HALF, Math.PI + GARRISON_ARC_HALF] });

  return {
    sim,
    lead: rifles[0],
    rifles,
    hedge: { x: HEDGE_X - 1, y: TRACK_Y - 2, r: 5 },
    house: { x: FARMHOUSE.x + FARMHOUSE.w / 2, y: FARMHOUSE.y + FARMHOUSE.h / 2, r: Math.hypot(FARMHOUSE.w, FARMHOUSE.h) / 2 + 1 },
  };
}

const fighting = (s: Soldier): boolean => s.alive && !s.downed && !s.captured;

/** The defenders the player can see on the map right now. */
export function enemiesInSight(sim: Sim): Soldier[] {
  return sim.soldiers.filter((s) => s.side === 'red' && fighting(s) && sim.soldierVisibleTo('blue', s));
}

/** The squad would cross the field to the house if it were told to. */
export function wouldAssault(d: Drill, squad: number): boolean {
  const { sim } = d;
  return sim.squads[squad].teamIds.every((t) => orderVerdict(sim, sim.teams[t], { kind: 'assault', x: d.house.x, y: d.house.y }).verdict !== 'balk');
}

/**
 * Nobody in the house is shooting at the field: no defender has a line to any
 * of the platoon. This is what fire on a position buys, and it is the state an
 * assault needs. The squad is asked too (wouldAssault), by the same function
 * that will answer the order, so the step this gates never sends a squad that
 * refuses.
 */
export function houseIsQuiet(d: Drill, squad: number): boolean {
  return visibleEnemies(d.sim, 'blue').length === 0 && wouldAssault(d, squad);
}

/** A team of the squad has refused its order. */
export function hasRefused(sim: Sim, squad: number): boolean {
  return sim.squads[squad].teamIds.some((t) => sim.teams[t].orderState.phase === 'balked');
}
