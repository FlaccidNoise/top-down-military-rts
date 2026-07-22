import type { Campaign, RosterEntry } from '../campaign/campaign';
import { fitRoster } from '../campaign/campaign';
import { RedCommander } from './ai';
import { DE_NAMES, US_NAMES, type WeaponKey } from './data';
import { EDGE, GameMap } from './map';
import { Sim, type MemberInit, type Side } from './sim';
import { mulberry32 } from './rng';

export const MAP_W = 160;
export const MAP_H = 120;

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Perimeter walls with a south door, windows every 3 tiles, floor interior,
// and an interior partition with a door when wide enough.
function addBuilding(map: GameMap, b: Building): void {
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      map.setTerrain(x, y, 'floor');
    }
  }
  const doorX = b.x + Math.floor(b.w / 2);
  for (let x = b.x; x < b.x + b.w; x++) {
    map.setHEdge(x, b.y, (x - b.x) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
    map.setHEdge(x, b.y + b.h, x === doorX ? EDGE.DOOR : (x - b.x) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
  }
  for (let y = b.y; y < b.y + b.h; y++) {
    map.setVEdge(b.x, y, (y - b.y) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
    map.setVEdge(b.x + b.w, y, (y - b.y) % 3 === 1 ? EDGE.WINDOW : EDGE.WALL);
  }
  if (b.w >= 8) {
    const px = b.x + Math.floor(b.w / 2);
    const pDoorY = b.y + Math.floor(b.h / 2);
    for (let y = b.y; y < b.y + b.h; y++) {
      map.setVEdge(px, y, y === pDoorY ? EDGE.DOOR : EDGE.WALL);
    }
  }
}

export const BUILDINGS: Building[] = [
  { x: 92, y: 48, w: 10, h: 8 },
  { x: 106, y: 64, w: 12, h: 9 },
  { x: 94, y: 76, w: 9, h: 7 },
];

export function makeMap(seed: number): GameMap {
  const map = new GameMap(MAP_W, MAP_H);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  // road
  for (let x = 0; x < MAP_W; x++) {
    for (let y = 60; y < 64; y++) map.setTerrain(x, y, 'road');
  }
  // woods blobs
  const blobs = [
    { x: 118, y: 36, w: 22, h: 18 },
    { x: 124, y: 82, w: 26, h: 22 },
    { x: 40, y: 20, w: 20, h: 14 },
    { x: 30, y: 90, w: 24, h: 16 },
  ];
  for (const b of blobs) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (map.inBounds(x, y) && rng.next() < 0.85 && map.terrainKeyAt(x, y) === 'grass') {
          map.setTerrain(x, y, 'woods');
        }
      }
    }
  }
  for (const b of BUILDINGS) addBuilding(map, b);
  return map;
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

function addRedDefenders(sim: Sim): Record<number, { x: number; y: number }> {
  const g1 = squadMembers(sim, 'red', 0, 0, 0);
  const spots1 = [...placeInBuilding(sim, BUILDINGS[0], 5), ...placeInBuilding(sim, BUILDINGS[1], 4)];
  g1.forEach((m, i) => {
    m.x = spots1[i].x;
    m.y = spots1[i].y;
  });
  const s1 = sim.addSquad('red', '1. Gruppe', g1);

  const g2 = squadMembers(sim, 'red', 0, 0, 0);
  const spots2 = [
    ...placeInBuilding(sim, BUILDINGS[2], 4),
    ...Array.from({ length: 5 }, () => ({
      x: 122 + sim.rng.range(0, 12),
      y: 40 + sim.rng.range(0, 12),
    })),
  ];
  g2.forEach((m, i) => {
    m.x = spots2[i].x;
    m.y = spots2[i].y;
  });
  const s2 = sim.addSquad('red', '2. Gruppe', g2);

  return {
    [s1.id]: { x: 97, y: 52 },
    [s2.id]: { x: 98, y: 79 },
  };
}

export function makeScenario(seed: number): Sim {
  const map = makeMap(seed);
  const sim = new Sim(map, seed);
  sim.addSquad('blue', '1st Squad', squadMembers(sim, 'blue', 10, 44, 3));
  sim.addSquad('blue', '2nd Squad', squadMembers(sim, 'blue', 10, 76, 3));
  addRedDefenders(sim);
  sim.addVehicle('blue', 'sherman', 8.5, 61.5, 0);
  sim.addVehicle('red', 'panzer4', 119.5, 61.5, Math.PI);
  return sim;
}

export const BATTLE_NAMES = ['Take the Village', 'Hold the Village', 'Clear the East Woods'];

export interface CampaignBattle {
  sim: Sim;
  commander: RedCommander;
  name: string;
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
function wireBonds(sim: Sim, roster: RosterEntry[][]): void {
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
  const map = makeMap(seed);
  const sim = new Sim(map, seed);
  const rosters = [fitRoster(campaign, 0), fitRoster(campaign, 1)];

  const spread = (cx: number, cy: number, n: number) =>
    Array.from({ length: n }, () => ({ x: cx + sim.rng.range(-3, 3), y: cy + sim.rng.range(-3, 3) }));

  let posts: Record<number, { x: number; y: number }>;
  let stance: 'defend' | 'attack';

  if (battle === 1) {
    // player holds the village; red assaults from the east
    sim.addSquad('blue', '1st Squad', rosterMembers(rosters[0], placeInBuilding(sim, BUILDINGS[0], rosters[0].length)));
    sim.addSquad('blue', '2nd Squad', rosterMembers(rosters[1], placeInBuilding(sim, BUILDINGS[2], rosters[1].length)));
    stance = 'attack';
    posts = {};
    const anchors = [
      { x: 97, y: 52 },
      { x: 98, y: 79 },
      { x: 111, y: 68 },
    ];
    for (let i = 0; i < 3; i++) {
      const g = squadMembers(sim, 'red', 0, 0, 0);
      const sp = spread(150, 45 + i * 18, g.length);
      g.forEach((m, j) => {
        m.x = sp[j].x;
        m.y = sp[j].y;
      });
      const sq = sim.addSquad('red', `${i + 1}. Gruppe`, g);
      posts[sq.id] = anchors[i];
    }
  } else if (battle === 2) {
    // push east: clear the woods beyond the village
    sim.addSquad('blue', '1st Squad', rosterMembers(rosters[0], spread(96, 52, rosters[0].length)));
    sim.addSquad('blue', '2nd Squad', rosterMembers(rosters[1], spread(98, 79, rosters[1].length)));
    stance = 'defend';
    posts = {};
    const anchors = [
      { x: 128, y: 45 },
      { x: 135, y: 92 },
    ];
    for (let i = 0; i < 2; i++) {
      const g = squadMembers(sim, 'red', 0, 0, 0);
      const sp = spread(anchors[i].x, anchors[i].y, g.length);
      g.forEach((m, j) => {
        m.x = sp[j].x;
        m.y = sp[j].y;
      });
      const sq = sim.addSquad('red', `${i + 1}. Gruppe`, g);
      posts[sq.id] = anchors[i];
    }
  } else {
    // battle 0: the original assault
    sim.addSquad('blue', '1st Squad', rosterMembers(rosters[0], spread(10, 44, rosters[0].length)));
    sim.addSquad('blue', '2nd Squad', rosterMembers(rosters[1], spread(10, 76, rosters[1].length)));
    stance = 'defend';
    posts = addRedDefenders(sim);
  }

  // armor: the player always brings a Sherman; the Germans field armor
  // from battle 2 onward (their counterattack and their last stand)
  if (battle === 1) {
    sim.addVehicle('blue', 'sherman', 100.5, 61.5, 0);
    sim.addVehicle('red', 'panzer4', 152.5, 61.5, Math.PI);
    sim.addVehicle('red', 'panzer4', 152.5, 75.5, Math.PI);
  } else if (battle === 2) {
    sim.addVehicle('blue', 'sherman', 96.5, 61.5, 0);
    sim.addVehicle('red', 'panzer4', 140.5, 61.5, Math.PI);
  } else {
    sim.addVehicle('blue', 'sherman', 8.5, 61.5, 0);
  }

  wireBonds(sim, rosters);
  return { sim, commander: new RedCommander({ stance, posts }), name: BATTLE_NAMES[battle] };
}
