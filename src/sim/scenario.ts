import type { Campaign, RosterEntry } from '../campaign/campaign';
import { fitRoster } from '../campaign/campaign';
import { RedCommander } from './ai';
import { DE_NAMES, US_NAMES, type WeaponKey } from './data';
import { generateMap, type Building, type MapPlan, type Vec } from './mapgen';
import { Sim, type MemberInit, type Side } from './sim';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const center = (b: Building): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// Nearest road tile center to (x,y) — vehicles spawn on the road, never in a
// woods stand or hedge the map happened to grow next to the entry point.
function roadSpot(sim: Sim, x: number, y: number): Vec {
  for (let r = 0; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = Math.floor(x) + dx;
        const ty = Math.floor(y) + dy;
        if (sim.map.inBounds(tx, ty) && sim.map.terrainKeyAt(tx, ty) === 'road') return { x: tx + 0.5, y: ty + 0.5 };
      }
    }
  }
  return { x, y };
}

function addVehicleOnRoad(sim: Sim, side: Side, kind: 'sherman' | 'panzer4', x: number, y: number, facing: number): void {
  const p = roadSpot(sim, x, y);
  sim.addVehicle(side, kind, p.x, p.y, facing);
}

function squadMembers(sim: Sim, side: Side, cx: number, cy: number, spread: number): { name: string; weapon: WeaponKey; x: number; y: number }[] {
  const names = side === 'blue' ? US_NAMES : DE_NAMES;
  const at: WeaponKey = side === 'blue' ? 'bazooka' : 'panzerfaust';
  const members: { name: string; weapon: WeaponKey; x: number; y: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const weapon: WeaponKey = i === 0 ? 'smg' : i === 1 ? 'mg' : i === 2 ? at : 'rifle';
    members.push({
      name: names[sim.rng.int(names.length)],
      weapon,
      x: cx + sim.rng.range(-spread, spread),
      y: cy + sim.rng.range(-spread, spread),
    });
  }
  return members;
}

// A 9-man squad placed exactly on the given positions.
function placedSquad(sim: Sim, side: Side, positions: { x: number; y: number }[]): { name: string; weapon: WeaponKey; x: number; y: number }[] {
  const g = squadMembers(sim, side, 0, 0, 0);
  g.forEach((m, i) => {
    m.x = positions[i].x;
    m.y = positions[i].y;
  });
  return g;
}

function placeInBuilding(sim: Sim, b: Building, count: number): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    spots.push({
      x: b.x + 1 + sim.rng.int(b.w - 2) + 0.5,
      y: b.y + 1 + sim.rng.int(b.h - 2) + 0.5,
    });
  }
  return spots;
}

function addRedDefenders(sim: Sim, plan: MapPlan): Record<number, Vec> {
  const [b0, b1, b2] = plan.buildings;
  const woods = plan.objectives[1];

  const spots1 = [...placeInBuilding(sim, b0, 5), ...placeInBuilding(sim, b1, 4)];
  const s1 = sim.addSquad('red', '1. Gruppe', placedSquad(sim, 'red', spots1));

  const spots2 = [
    ...placeInBuilding(sim, b2, 4),
    ...Array.from({ length: 5 }, () => ({
      x: woods.x + sim.rng.range(-6, 6),
      y: woods.y + sim.rng.range(-6, 6),
    })),
  ];
  const s2 = sim.addSquad('red', '2. Gruppe', placedSquad(sim, 'red', spots2));

  return { [s1.id]: center(b0), [s2.id]: center(b2) };
}

export function makeScenario(seed: number): Sim {
  const plan = generateMap(seed);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;
  const { west, east } = plan.spawns;
  sim.addSquad('blue', '1st Squad', squadMembers(sim, 'blue', west.x + 7, clamp(west.y - 14, 4, plan.map.h - 5), 3));
  sim.addSquad('blue', '2nd Squad', squadMembers(sim, 'blue', west.x + 7, clamp(west.y + 14, 4, plan.map.h - 5), 3));
  addRedDefenders(sim, plan);
  addVehicleOnRoad(sim, 'blue', 'sherman', west.x + 0.5, west.y + 0.5, 0);
  addVehicleOnRoad(sim, 'red', 'panzer4', east.x - 1.5, east.y + 0.5, Math.PI);
  return sim;
}

export const BATTLE_NAMES = ['Take the Village', 'Hold the Village', 'Clear the East Woods'];

export interface CampaignBattle {
  sim: Sim;
  commander: RedCommander;
  name: string;
  camStart: Vec;
}

function rosterMembers(roster: RosterEntry[], positions: { x: number; y: number }[]): MemberInit[] {
  return roster.map((r, i) => ({
    name: r.name,
    weapon: r.weapon,
    x: positions[i].x,
    y: positions[i].y,
    courage: r.courage,
    xp: r.xp,
    bodyDamage: r.bodyDamage,
    pid: r.pid,
  }));
}

// Wire campaign bonds (keyed by pid) onto battle soldiers (keyed by battle id).
export function wireBonds(sim: Sim, roster: RosterEntry[][]): void {
  const byPid = new Map<number, number>();
  for (const s of sim.soldiers) if (s.pid >= 0) byPid.set(s.pid, s.id);
  for (const squad of roster) {
    for (const r of squad) {
      const sid = byPid.get(r.pid);
      if (sid === undefined) continue;
      for (const [otherPid, v] of Object.entries(r.bonds)) {
        const oid = byPid.get(Number(otherPid));
        if (oid !== undefined) sim.soldiers[sid].bonds[oid] = v;
      }
    }
  }
}

export function makeCampaignBattle(campaign: Campaign, seed: number): CampaignBattle {
  const battle = campaign.battleIndex;
  const plan = generateMap(seed);
  const { map, buildings } = plan;
  const sim = new Sim(map, seed);
  sim.buildings = buildings;
  const rosters = [fitRoster(campaign, 0), fitRoster(campaign, 1)];
  const { west, east } = plan.spawns;
  const village = plan.objectives[0];
  const woods = plan.objectives[1];
  const cyc = (v: number) => clamp(v, 4, map.h - 5);

  const spread = (cx: number, cy: number, n: number) =>
    Array.from({ length: n }, () => ({ x: cx + sim.rng.range(-3, 3), y: cy + sim.rng.range(-3, 3) }));

  let posts: Record<number, Vec>;
  let stance: 'defend' | 'attack';
  let camStart: Vec;

  if (battle === 1) {
    // player holds the village; red assaults from the east
    sim.addSquad('blue', '1st Squad', rosterMembers(rosters[0], placeInBuilding(sim, buildings[0], rosters[0].length)));
    sim.addSquad('blue', '2nd Squad', rosterMembers(rosters[1], placeInBuilding(sim, buildings[2], rosters[1].length)));
    stance = 'attack';
    posts = {};
    const anchors = [center(buildings[0]), center(buildings[2]), village];
    for (let i = 0; i < 3; i++) {
      const g = placedSquad(sim, 'red', spread(east.x - 8, cyc(east.y + (i - 1) * 18), 9));
      posts[sim.addSquad('red', `${i + 1}. Gruppe`, g).id] = anchors[i];
    }
    camStart = village;
  } else if (battle === 2) {
    // push east: clear the woods beyond the village
    const c0 = center(buildings[0]);
    const c2 = center(buildings[2]);
    sim.addSquad('blue', '1st Squad', rosterMembers(rosters[0], spread(c0.x, c0.y, rosters[0].length)));
    sim.addSquad('blue', '2nd Squad', rosterMembers(rosters[1], spread(c2.x, c2.y, rosters[1].length)));
    stance = 'defend';
    posts = {};
    const anchors = [woods, { x: clamp(woods.x + 7, 4, map.w - 5), y: cyc(woods.y + 16) }];
    for (let i = 0; i < 2; i++) {
      const g = placedSquad(sim, 'red', spread(anchors[i].x, anchors[i].y, 9));
      posts[sim.addSquad('red', `${i + 1}. Gruppe`, g).id] = anchors[i];
    }
    camStart = village;
  } else {
    // battle 0: the original assault
    sim.addSquad('blue', '1st Squad', rosterMembers(rosters[0], spread(west.x + 7, cyc(west.y - 14), rosters[0].length)));
    sim.addSquad('blue', '2nd Squad', rosterMembers(rosters[1], spread(west.x + 7, cyc(west.y + 14), rosters[1].length)));
    stance = 'defend';
    posts = addRedDefenders(sim, plan);
    camStart = { x: west.x + 12, y: west.y };
  }

  // armor: the player always brings a Sherman; the Germans field armor
  // from battle 2 onward (their counterattack and their last stand)
  if (battle === 1) {
    addVehicleOnRoad(sim, 'blue', 'sherman', village.x - 2.5, village.y + 0.5, 0);
    addVehicleOnRoad(sim, 'red', 'panzer4', east.x - 1.5, east.y + 0.5, Math.PI);
    addVehicleOnRoad(sim, 'red', 'panzer4', east.x - 5.5, east.y + 0.5, Math.PI);
  } else if (battle === 2) {
    addVehicleOnRoad(sim, 'blue', 'sherman', village.x - 2.5, village.y + 0.5, 0);
    addVehicleOnRoad(sim, 'red', 'panzer4', east.x - 8.5, east.y + 0.5, Math.PI);
  } else {
    addVehicleOnRoad(sim, 'blue', 'sherman', west.x + 0.5, west.y + 0.5, 0);
  }

  wireBonds(sim, rosters);
  return { sim, commander: new RedCommander({ stance, posts }), name: BATTLE_NAMES[battle], camStart };
}
