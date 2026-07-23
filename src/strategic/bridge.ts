import { applyBattleResults, fitRoster, squadMembers, type BattleRecord, type Campaign, type RosterEntry } from '../campaign/campaign';
import { RedCommander } from '../sim/ai';
import { SQUADS, TEAMS, type SquadKey } from '../sim/data';
import type { GameMap } from '../sim/map';
import { generateMap, type Building, type Vec } from '../sim/mapgen';
import { wireBonds } from '../sim/scenario';
import { Sim, type MemberInit } from '../sim/sim';
import { COMPANY_TOE, squadHeadcount } from '../sim/toe';
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
    ['Brückenwache Süd', 20, 15, 36],
    ['Garnison St-Aubin', 25, 15, 109],
    ['Brückenwache Nord', 20, 7, 36],
    ['Garnison Vireux', 30, 7, 109],
    ['Reserve', 33, 15, 109],
  ];
  for (const [name, x, y, strength] of garrisons) {
    front.addChit({ side: 'red', name, cell: cellIndex(sector, x, y), strength, companyIndex: -1 });
  }
  syncStrengths(c, front);
  return front;
}

// Blue chit strength mirrors the roster; red carries attrition. Blue chits
// vanish only when the whole company is dead — an all-wounded company stays
// on the map at strength 0 and recovers as men heal and replacements arrive.
export function syncStrengths(c: Campaign, front: Front): void {
  for (const chit of front.chits) {
    if (chit.side !== 'blue') continue;
    chit.strength = c.companies[chit.companyIndex].squads.reduce(
      (n, si) => n + squadMembers(c.squads[si]).filter((pid) => c.soldiers[pid].status === 'fit').length,
      0,
    );
  }
  front.chits = front.chits.filter((ch) =>
    ch.side === 'red'
      ? ch.strength > 0
      : c.companies[ch.companyIndex].squads.some((si) => squadMembers(c.squads[si]).some((pid) => c.soldiers[pid].status !== 'kia')),
  );
}

const buildingCenter = (b: Building): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const distSq = (a: Vec, b: Vec): number => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

// TO&E order boundaries for us_rifle_co's 6 deployment bands: 3 rifle bands
// (0-2 / 3-5 / 6-8), one weapons band (9-13: mortars + MGs), bazookas
// (14-16), the sniper alone (17).
const BAND_START = [0, 3, 6, 9, 14, 17, 18];

// Nudge a spawn anchor off impassable ground: walk y outward up to 8 tiles,
// alternating below/above, keeping x fixed; keep the original point if
// nothing within range is passable.
function nudgePassable(map: GameMap, x: number, y: number): Vec {
  if (map.terrainAt(Math.round(x), Math.round(y)).passable) return { x, y };
  for (let d = 1; d <= 8; d++) {
    for (const sign of [1, -1] as const) {
      const ny = y + d * sign;
      if (map.terrainAt(Math.round(x), Math.round(ny)).passable) return { x, y: ny };
    }
  }
  return { x, y };
}

const DIRECT_FIRE = new Set<SquadKey>(['de_gruppe', 'de_smg42']);
const GARRISON_RADIUS = 45; // meters from an objective a garrison post may sit

// Front-packed partial roster of slot-default members: fields exactly `count`
// men of a squad def (teams fill in order), so a garrison's headcount always
// matches its chit strength — no over- or under-fielding on attrited chits.
function partialRoster(key: SquadKey, count: number): Partial<MemberInit>[][] {
  return SQUADS[key].teams.map((teamKey) => {
    const take = Math.min(count, TEAMS[teamKey].slots.length);
    count -= take;
    return Array.from({ length: take }, () => ({}));
  });
}

// Anchor assignment within one sector: direct-fire squads (Gruppen, sMG42)
// take the anchors closest to the blue spawn in turn; mortars, Panzerschreck,
// and the sniper take the farthest. An anchor repeats only once every anchor
// in the sector has hosted a squad.
function assignSectorAnchors(sorted: Vec[], keys: SquadKey[]): Vec[] {
  const n = sorted.length;
  const used = new Set<number>();
  let closeI = 0;
  let farI = n - 1;
  return keys.map((key) => {
    if (used.size >= n) used.clear();
    const direct = DIRECT_FIRE.has(key);
    let i = direct ? closeI : farI;
    while (used.has(i)) i = direct ? (i + 1) % n : (i - 1 + n) % n;
    used.add(i);
    if (direct) closeI = (i + 1) % n;
    else farI = (i - 1 + n) % n;
    return sorted[i];
  });
}

// M-A: every engagement fights on a fresh procgen battle map, at the design
// scale of a full company (18 blue squads, TO&E garrison strength red).
export function makeStrategicBattle(
  c: Campaign,
  front: Front,
  e: Engagement,
  seed: number,
): { sim: Sim; commander: RedCommander; name: string; companyIndex: number } {
  const plan = generateMap(seed, 320, 240, front.sector.cells[e.cell].terrain);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;

  const { west } = plan.spawns;
  const company = c.companies[attacker.companyIndex];
  const rosters: RosterEntry[][] = [];
  const yLo = 4;
  const yHi = plan.map.h - 5;
  const bandH = (yHi - yLo) / 6;
  company.squads.forEach((si, i) => {
    const teamRosters = fitRoster(c, si);
    if (teamRosters.every((t) => t.length === 0)) return;
    let band = 0;
    while (i >= BAND_START[band + 1]) band++;
    const idx = i - BAND_START[band];
    const count = BAND_START[band + 1] - BAND_START[band];
    const support = band === 3 || band === 4; // mortars/MGs/bazookas set up rear
    const anchor = nudgePassable(plan.map, support ? west.x + 3 : west.x + 7, yLo + bandH * (band + (idx + 0.5) / count));
    const roster: Partial<MemberInit>[][] = teamRosters.map((team) =>
      team.map((r) => ({
        name: r.name,
        x: anchor.x + sim.rng.range(-2, 2),
        y: anchor.y + sim.rng.range(-3, 3),
        courage: r.courage,
        xp: r.xp,
        bodyDamage: r.bodyDamage,
        pid: r.pid,
        crewSkill: r.crewSkill,
      })),
    );
    const squad = sim.addSquadFromDef('blue', c.squads[si].def, anchor.x, anchor.y, roster);
    squad.name = c.squads[si].name;
    rosters.push(teamRosters.flat());
  });
  wireBonds(sim, rosters);

  // German garrison: buildings, objectives, and woods stands near an objective
  // are posts, split into 2-3 sectors by nearest objective; squads go to the
  // least-covered sector first, then onto that sector's anchors. Anchors
  // farther than GARRISON_RADIUS from every objective are excluded — a
  // garrison defends its objectives, not every copse on the map. Dispersing
  // remnants across the full 320x240 map left battles unresolvable (blue
  // never finds the last defenders, the attrition floor never trips).
  const anchors: Vec[] = [...plan.buildings.map(buildingCenter), ...plan.objectives, ...plan.woodsStands];
  const sectorAnchors: Vec[][] = plan.objectives.map(() => []);
  for (const a of anchors) {
    let best = 0;
    let bestD = Infinity;
    plan.objectives.forEach((o, oi) => {
      const d = distSq(a, o);
      if (d < bestD) {
        bestD = d;
        best = oi;
      }
    });
    if (bestD <= GARRISON_RADIUS * GARRISON_RADIUS) sectorAnchors[best].push(a);
  }
  // an objective is always its own anchor, so no sector is ever empty
  const totalAnchors = sectorAnchors.reduce((n, s) => n + s.length, 0);
  const weight = sectorAnchors.map((s) => s.length / totalAnchors);
  const sortedSectorAnchors = sectorAnchors.map((list) => [...list].sort((a, b) => distSq(a, west) - distSq(b, west)));

  // Field exactly defender.strength men: TO&E squads in order, the last one
  // partial if the strength doesn't land on a squad boundary.
  const fielded: { key: SquadKey; take: number }[] = [];
  let remaining = defender.strength;
  for (const key of COMPANY_TOE.de_grenadier_co) {
    if (remaining <= 0) break;
    const take = Math.min(squadHeadcount(key), remaining);
    fielded.push({ key, take });
    remaining -= take;
  }
  const assignedHeadcount = sectorAnchors.map(() => 0);
  const sectorOfSquad = fielded.map(({ take }) => {
    let best = 0;
    let bestScore = Infinity;
    weight.forEach((w, sIdx) => {
      const score = assignedHeadcount[sIdx] / w;
      if (score < bestScore) {
        bestScore = score;
        best = sIdx;
      }
    });
    assignedHeadcount[best] += take;
    return best;
  });

  const anchorForSquad: Vec[] = new Array(fielded.length);
  sectorAnchors.forEach((_, sIdx) => {
    const idxs = sectorOfSquad.map((s, idx) => (s === sIdx ? idx : -1)).filter((idx) => idx >= 0);
    const picks = assignSectorAnchors(
      sortedSectorAnchors[sIdx],
      idxs.map((idx) => fielded[idx].key),
    );
    idxs.forEach((idx, k) => (anchorForSquad[idx] = picks[k]));
  });

  const posts: Record<number, Vec> = {};
  fielded.forEach(({ key, take }, i) => {
    const anchor = anchorForSquad[i];
    const roster = take === squadHeadcount(key) ? undefined : partialRoster(key, take);
    const squad = sim.addSquadFromDef('red', key, anchor.x, anchor.y, roster);
    posts[squad.id] = anchor;
    squad.name = `${i + 1}. ${SQUADS[key].name}`;
  });

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
