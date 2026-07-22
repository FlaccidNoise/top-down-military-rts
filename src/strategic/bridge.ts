import { applyBattleResults, fitRoster, type BattleRecord, type Campaign } from '../campaign/campaign';
import { RedCommander } from '../sim/ai';
import { DE_NAMES, type WeaponKey } from '../sim/data';
import { generateMap, type Building, type Vec } from '../sim/mapgen';
import { wireBonds } from '../sim/scenario';
import { Sim, type MemberInit } from '../sim/sim';
import { cellIndex, cellXY, type SectorMap } from './sector';
import { Front, type Chit, type Engagement } from './front';

// Initial dispositions on the default sector: three companies on the west
// bank, static German garrisons on the crossings, towns, and reserve line.
export function newFront(c: Campaign, sector: SectorMap): Front {
  const front = new Front(sector);
  const blueCells: [number, number][] = [
    [4, 13],
    [4, 15],
    [4, 17],
  ];
  c.companies.forEach((co, i) =>
    front.addChit({
      side: 'blue',
      name: `${co.name} Company`,
      cell: cellIndex(sector, blueCells[i][0], blueCells[i][1]),
      strength: 0, // synced below
      companyIndex: i,
    }),
  );
  const garrisons: [string, number, number, number][] = [
    ['Brückenwache Süd', 20, 15, 18],
    ['Garnison St-Aubin', 25, 15, 27],
    ['Brückenwache Nord', 20, 7, 18],
    ['Garnison Vireux', 30, 7, 27],
    ['Reserve', 33, 15, 27],
  ];
  for (const [name, x, y, strength] of garrisons) {
    front.addChit({ side: 'red', name, cell: cellIndex(sector, x, y), strength, companyIndex: -1 });
  }
  syncStrengths(c, front);
  return front;
}

// Blue chit strength mirrors the roster; red carries attrition. Wiped chits vanish.
export function syncStrengths(c: Campaign, front: Front): void {
  for (const chit of front.chits) {
    if (chit.side !== 'blue') continue;
    chit.strength = c.companies[chit.companyIndex].squads.reduce(
      (n, si) => n + c.squads[si].members.filter((pid) => c.soldiers[pid].status === 'fit').length,
      0,
    );
  }
  front.chits = front.chits.filter((ch) => ch.strength > 0);
}

function redMembers(sim: Sim, count: number, cx: number, cy: number): MemberInit[] {
  const members: MemberInit[] = [];
  for (let i = 0; i < count; i++) {
    const weapon: WeaponKey = i === 0 ? 'smg' : i === 1 ? 'mg' : i === 2 ? 'panzerfaust' : 'rifle';
    members.push({
      name: DE_NAMES[sim.rng.int(DE_NAMES.length)],
      weapon,
      x: cx + sim.rng.range(-4, 4),
      y: cy + sim.rng.range(-4, 4),
    });
  }
  return members;
}

const buildingCenter = (b: Building): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// M-A: every engagement fights on a fresh procgen battle map. The carve
// (M-B) replaces generateMap here; nothing outside this function changes.
export function makeStrategicBattle(
  c: Campaign,
  front: Front,
  e: Engagement,
  seed: number,
): { sim: Sim; commander: RedCommander; name: string; companyIndex: number } {
  const plan = generateMap(seed);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;

  const { west } = plan.spawns;
  const clampY = (v: number) => Math.max(4, Math.min(plan.map.h - 5, v));
  const company = c.companies[attacker.companyIndex];
  const rosters = company.squads.map((si) => fitRoster(c, si));
  company.squads.forEach((si, i) => {
    const roster = rosters[i];
    if (roster.length === 0) return;
    const members: MemberInit[] = roster.map((r) => ({
      name: r.name,
      weapon: r.weapon,
      x: west.x + 7 + sim.rng.range(-2, 2),
      y: clampY(west.y + (i - 1) * 14 + sim.rng.range(-3, 3)),
      courage: r.courage,
      xp: r.xp,
      bodyDamage: r.bodyDamage,
      pid: r.pid,
    }));
    sim.addSquad('blue', c.squads[si].name, members);
  });
  wireBonds(sim, rosters);

  // German garrison: buildings first, then the east woods
  const anchors: Vec[] = [...plan.buildings.slice(0, 3).map(buildingCenter), plan.objectives[1]];
  const posts: Record<number, Vec> = {};
  let remaining = defender.strength;
  for (let i = 0; remaining > 0; i++) {
    const size = Math.min(9, remaining);
    remaining -= size;
    const anchor = anchors[Math.min(i, anchors.length - 1)];
    const squad = sim.addSquad('red', `${i + 1}. Gruppe`, redMembers(sim, size, anchor.x, anchor.y));
    posts[squad.id] = anchor;
  }

  const { x, y } = cellXY(front.sector, e.cell);
  return {
    sim,
    commander: new RedCommander({ stance: 'defend', posts }),
    name: `${defender.name} at (${x}, ${y})`,
    companyIndex: attacker.companyIndex,
  };
}

function retreat(front: Front, chit: Chit): void {
  const { x, y } = cellXY(front.sector, chit.cell);
  for (const [dx, dy] of [
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, 0],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
    const v = cellIndex(front.sector, nx, ny);
    const cell = front.sector.cells[v];
    if (cell.owner === chit.side && cell.terrain !== 'river' && !front.chitAt(v)) {
      chit.cell = v;
      return;
    }
  }
  chit.strength = 0; // nowhere to go: overrun
}

export function applyEngagementOutcome(
  c: Campaign,
  front: Front,
  e: Engagement,
  sim: Sim,
): { record: BattleRecord; redLosses: number; cellTaken: boolean } {
  const won = sim.winner === 'blue';
  const record = applyBattleResults(c, sim, won);
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;
  const redLosses = sim.soldiers.filter((s) => s.side === 'red' && (!s.alive || s.downed)).length;
  defender.strength = Math.max(0, defender.strength - redLosses);
  let cellTaken = false;
  if (won) {
    if (defender.strength > 0) retreat(front, defender);
    front.sector.cells[e.cell].owner = 'blue';
    attacker.cell = e.cell;
    cellTaken = true;
  }
  syncStrengths(c, front);
  return { record, redLosses, cellTaken };
}
