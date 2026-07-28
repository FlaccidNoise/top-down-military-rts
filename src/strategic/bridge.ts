import { applyBattleResults, fitRoster, squadMembers, type BattleRecord, type Campaign, type RosterEntry } from '../campaign/campaign';
import { RedCommander } from '../sim/ai';
import { EMPLACEMENTS, SQUADS, TEAMS, WEAPONS, type EmplacementKey, type SquadKey } from '../sim/data';
import { BREACH_LIP, BREACH_WIDE, EDGE, type GameMap } from '../sim/map';
import { generateMap, type Building, type Vec } from '../sim/mapgen';
import { mulberry32, type Rng } from '../sim/rng';
import { wireBonds } from '../sim/scenario';
import { Sim, type BreachEvent, type MemberInit } from '../sim/sim';
import { lightAt } from '../sim/solar';
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
// Crew-served staging (balance 2026-07): these squads field as DEPLOYED
// emplacements bound to their own crew squad (addEmplacement roster
// passthrough keeps campaign names/pids/attrition), instead of bare foot
// squads whose "MG42"/"mortar81" degenerate to personal pseudo-rifles —
// sim.emplacements was EMPTY on every campaign battle, so the garrison's
// heavy weapons never fought as heavy weapons and the AI's mortar doctrine
// (readyMortar scans sim.emplacements) was structurally dead. Defenders
// emplace MGs and mortars; attackers only mortars — an attacking MG team
// must stay on its feet for the base-of-fire displacement game.
const ATTACKER_EMPLACED: Partial<Record<SquadKey, EmplacementKey>> = {
  us_mortar60: 'mortar60',
  de_mortar81: 'mortar81',
};
const DEFENDER_EMPLACED: Partial<Record<SquadKey, EmplacementKey>> = {
  ...ATTACKER_EMPLACED,
  us_m1919: 'm1919_tripod',
  de_smg42: 'mg42_lafette',
};
// A prepared position stockpiles ammunition for the gun it was dug for
// (balance 2026-07): the measured defense fired its tubes dry inside 90
// seconds against a company attack. Defender-emplaced crews only — an
// attacker's crews carry what marching order allows.
const STOCKPILE_MULT = 2;
function stockpileAmmo(sim: Sim, e: { kind: EmplacementKey; crewTeamId: number }): void {
  const type = WEAPONS[EMPLACEMENTS[e.kind].weapon].ammo.type;
  for (const id of sim.teams[e.crewTeamId].soldierIds) {
    const s = sim.soldiers[id];
    if (s.ammo[type]) s.ammo[type] = s.ammo[type]! * STOCKPILE_MULT;
  }
}

export const GARRISON_RADIUS = 45; // meters from an objective a garrison post may sit
export const ATTACK_POST_MARGIN = 32; // attack posts start this far east of the west spawn (see attackObjectives)
const FORD_SUPPRESSION = 0.45; // crossing under fire: shaken at spawn (fast-decaying)
const FORD_STAMINA = 0.65; // an hour wading: no sprinting off the far bank

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
// Supports both blue-attacker and red-attacker (counterattack) engagements.
export function makeStrategicBattle(
  c: Campaign,
  front: Front,
  e: Engagement,
  seed: number,
): { sim: Sim; commander: RedCommander; blueCommander: RedCommander; name: string; companyIndex: number } {
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;
  const attackerSide = attacker.side;
  const viaFord = front.sector.cells[attacker.cell].terrain === 'river';
  // I9: the campaign's battles are the shipped configuration, so they are the
  // ones that get furnished interiors. The pinned generator tests all call the
  // <=4-argument form and are unaffected.
  const plan = generateMap(seed, 320, 240, viaFord ? 'river' : front.sector.cells[e.cell].terrain, { interiors: true });
  const sim = new Sim(plan.map, seed);
  // The campaign clock reaches the battlefield here and nowhere else: the sun,
  // the ambient grade and the night spotting rules all derive from startMin.
  sim.startMin = front.clockMin;
  sim.buildings = plan.buildings;

  const { west } = plan.spawns;
  const yLo = 4;
  const yHi = plan.map.h - 5;
  const commanderPosts: Record<number, Vec> = {};
  const bluePosts: Record<number, Vec> = {};

  // Attack posts must lie beyond the attacker's own deployment strip. Bourg
  // maps place outpost objectives as close as x=18-30 (seeds 1,2,3,7 of the
  // balance survey) while the attacker fields at west.x+3..+7 — "nearest
  // objective" then hands EVERY attacking squad the objective it practically
  // spawned on, the commander takes it in the opening minutes and declares
  // the attack complete without ever contacting the garrison (the doctrine
  // baseline's 0%-casualty bourg cells). Legitimate first objectives start at
  // x>=43 on every surveyed kind/seed; the 32-tile margin splits the gap.
  // Defender garrisons still cover every objective, outposts included.
  const beyondDeploy = plan.objectives.filter((o) => o.x >= west.x + ATTACK_POST_MARGIN);
  const attackObjectives = beyondDeploy.length > 0 ? beyondDeploy : plan.objectives;

  // --- Field attacker ---
  if (attackerSide === 'blue') {
    const company = c.companies[attacker.companyIndex];
    const rosters: RosterEntry[][] = [];
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
      const empKind = ATTACKER_EMPLACED[c.squads[si].def];
      if (empKind) {
        // Tube fielded in battery at the deployment line, crew bound to it. No
        // post: the commander's smoke/HE missions find tubes via sim.emplacements,
        // and a post would make runAttack march the crew off the gun.
        const e2 = sim.addEmplacement('blue', empKind, anchor.x, anchor.y, 0, 'deployed', roster);
        const squad = sim.squads[sim.teams[e2.crewTeamId].squadId];
        squad.name = c.squads[si].name;
        rosters.push(teamRosters.flat());
        return;
      }
      const squad = sim.addSquadFromDef('blue', c.squads[si].def, anchor.x, anchor.y, roster);
      squad.name = c.squads[si].name;
      const nearestObj = attackObjectives.reduce((best, o) => distSq(anchor, o) < distSq(anchor, best) ? o : best, attackObjectives[0]);
      bluePosts[squad.id] = nearestObj;
      rosters.push(teamRosters.flat());
    });
    wireBonds(sim, rosters);

    if (viaFord) {
      for (const s of sim.soldiers) {
        if (s.side !== 'blue') continue;
        s.suppression = Math.max(s.suppression, FORD_SUPPRESSION);
        s.stamina = Math.min(s.stamina, FORD_STAMINA);
      }
    }
  } else {
    // --- Red attacker: field from TO&E de_grenadier_co at west spawn ---
    const atkFielded: { key: SquadKey; take: number }[] = [];
    let atkRemaining = attacker.strength;
    for (const key of COMPANY_TOE.de_grenadier_co) {
      if (atkRemaining <= 0) break;
      const take = Math.min(squadHeadcount(key), atkRemaining);
      atkFielded.push({ key, take });
      atkRemaining -= take;
    }
    const yBandH = atkFielded.length > 0 ? (yHi - yLo) / atkFielded.length : yHi - yLo;
    atkFielded.forEach(({ key, take }, i) => {
      const anchor = nudgePassable(plan.map, west.x + 7, yLo + yBandH * (i + 0.5));
      const roster = take === squadHeadcount(key) ? undefined : partialRoster(key, take);
      const empKind = ATTACKER_EMPLACED[key];
      if (empKind) {
        // In battery at the deployment line; no post (see blue attacker branch).
        const e2 = sim.addEmplacement('red', empKind, anchor.x, anchor.y, 0, 'deployed', roster);
        const squad = sim.squads[sim.teams[e2.crewTeamId].squadId];
        squad.name = `${i + 1}. ${SQUADS[key].name}`;
        return;
      }
      const squad = sim.addSquadFromDef('red', key, anchor.x, anchor.y, roster);
      const nearestObj = attackObjectives.reduce((best, o) => distSq(anchor, o) < distSq(anchor, best) ? o : best, attackObjectives[0]);
      commanderPosts[squad.id] = nearestObj;
      squad.name = `${i + 1}. ${SQUADS[key].name}`;
    });

    if (viaFord) {
      for (const s of sim.soldiers) {
        if (s.side !== 'red') continue;
        s.suppression = Math.max(s.suppression, FORD_SUPPRESSION);
        s.stamina = Math.min(s.stamina, FORD_STAMINA);
      }
    }
  }

  // --- Compute garrison anchors (same for both sides) ---
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

  // --- Field defender ---
  if (attackerSide === 'blue') {
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

    fielded.forEach(({ key, take }, i) => {
      const anchor = anchorForSquad[i];
      const roster = take === squadHeadcount(key) ? undefined : partialRoster(key, take);
      const empKind = DEFENDER_EMPLACED[key];
      let squad;
      if (empKind) {
        // Prepared defense: the gun is dug in on the post, laid on the western
        // approach, crew bound. The post stays so runDefend's arc'd defend
        // order covers the crew (and re-mans the gun if pushed off).
        const facing = Math.atan2(west.y - anchor.y, west.x - anchor.x);
        const e2 = sim.addEmplacement('red', empKind, anchor.x, anchor.y, facing, 'deployed', roster);
        stockpileAmmo(sim, e2);
        squad = sim.squads[sim.teams[e2.crewTeamId].squadId];
      } else {
        squad = sim.addSquadFromDef('red', key, anchor.x, anchor.y, roster);
      }
      commanderPosts[squad.id] = anchor;
      squad.name = `${i + 1}. ${SQUADS[key].name}`;
    });
  } else {
    // --- Blue defender: field from campaign roster at objective anchors ---
    const defCompany = c.companies[defender.companyIndex];
    const defKeys: SquadKey[] = [];
    const defSquadIdxs: number[] = [];
    defCompany.squads.forEach((si) => {
      const teamRosters = fitRoster(c, si);
      if (teamRosters.every((t) => t.length === 0)) return;
      defKeys.push(c.squads[si].def);
      defSquadIdxs.push(si);
    });

    const assignedHeadcount = sectorAnchors.map(() => 0);
    const sectorOfSquad = defKeys.map((key) => {
      let best = 0;
      let bestScore = Infinity;
      const hc = squadHeadcount(key);
      weight.forEach((w, sIdx) => {
        const score = assignedHeadcount[sIdx] / w;
        if (score < bestScore) {
          bestScore = score;
          best = sIdx;
        }
      });
      assignedHeadcount[best] += hc;
      return best;
    });

    const anchorForSquad: Vec[] = new Array(defKeys.length);
    const defRosters: RosterEntry[][] = [];
    sectorAnchors.forEach((_, sIdx) => {
      const idxs = sectorOfSquad.map((s, idx) => (s === sIdx ? idx : -1)).filter((idx) => idx >= 0);
      const picks = assignSectorAnchors(
        sortedSectorAnchors[sIdx],
        idxs.map((idx) => defKeys[idx]),
      );
      idxs.forEach((idx, k) => (anchorForSquad[idx] = picks[k]));
    });

    defKeys.forEach((key, i) => {
      const si = defSquadIdxs[i];
      const teamRosters = fitRoster(c, si);
      const anchor = anchorForSquad[i];
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
      const empKind = DEFENDER_EMPLACED[key];
      let squad;
      if (empKind) {
        // Same prepared-defense staging as the red defender branch.
        const facing = Math.atan2(west.y - anchor.y, west.x - anchor.x);
        const e2 = sim.addEmplacement('blue', empKind, anchor.x, anchor.y, facing, 'deployed', roster);
        stockpileAmmo(sim, e2);
        squad = sim.squads[sim.teams[e2.crewTeamId].squadId];
      } else {
        squad = sim.addSquadFromDef('blue', c.squads[si].def, anchor.x, anchor.y, roster);
      }
      squad.name = c.squads[si].name;
      bluePosts[squad.id] = anchor;
      defRosters.push(teamRosters.flat());
    });
    wireBonds(sim, defRosters);
  }

  const { x, y } = cellXY(front.sector, e.cell);
  const stance = attackerSide === 'red' ? 'attack' : 'defend';
  // The debrief is the player's (BLUE) after-action report even when red
  // attacked: always hand back the blue participant's company.
  const blueChit = attackerSide === 'blue' ? attacker : defender;
  if (blueChit.companyIndex < 0) {
    throw new Error(`makeStrategicBattle: blue chit '${blueChit.name}' has no campaign company`);
  }
  // Briefed avenue of approach for whichever side defends: every attacker
  // (either side) deploys at the west spawn, and the defense is sited on it —
  // the same knowledge the garrison anchors already encode.
  // The attacker is briefed on the whole objective list, not just the one post
  // its squads deployed onto: every squad picks the objective nearest its own
  // anchor and every anchor sits in the same west strip, so posts alone name a
  // single objective and the attack has nowhere to go once it takes it.
  const blueCommander = new RedCommander({
    side: 'blue',
    stance: attackerSide === 'blue' ? 'attack' : 'defend',
    posts: bluePosts,
    ...(attackerSide === 'blue' ? { objectives: attackObjectives } : { approach: { x: west.x, y: west.y } }),
  });
  return {
    sim,
    commander: new RedCommander({
      side: 'red',
      stance,
      posts: commanderPosts,
      ...(stance === 'attack' ? { objectives: attackObjectives } : { approach: { x: west.x, y: west.y } }),
    }),
    blueCommander,
    name: `${defender.name} at (${x}, ${y})`,
    companyIndex: blueChit.companyIndex,
  };
}

export function retreat(front: Front, chit: Chit): void {
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
  // Blue rosters are persistent named men (an all-wounded company already
  // stays on the map at strength 0 to recover): with no adjacent escape the
  // company infiltrates back to the nearest owned cell within 8 cells rather
  // than being overrun. Red chits are attrition counters and still die here.
  if (chit.side === 'blue') {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < front.sector.cells.length; i++) {
      const cell = front.sector.cells[i];
      if (cell.owner !== 'blue' || cell.terrain === 'river' || front.chitAt(i)) continue;
      const a = cellXY(front.sector, chit.cell);
      const b = cellXY(front.sector, i);
      const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (d <= 8 && (d < bestD || (d === bestD && i < best))) {
        best = i;
        bestD = d;
      }
    }
    if (best >= 0) {
      chit.cell = best;
      return;
    }
  }
  chit.strength = 0; // nowhere to go: overrun
}

// ── Battle scars (design section 4.3) ─────────────────────────────────────
// Campaign doctrine already commits to persistent battle damage: decision
// 2026-07-22 "deterministic battlefield carve WITH scars", and the strategic
// spec defines `scars: Scar[]` on the cell as "wrecks, craters, ruined
// buildings — appended after battles", applied at carve step 5, with the
// stated payoff "with scars, the Panzer killed in June is still rusting there
// in July". Scars are a T2 item and nothing wires them yet. Tactical breaching
// is the PRODUCER that system was specified to consume, so this design's job is
// to emit and to fix the re-stamp shape, and to stop there.
//
// T2 adds 'wreck' and 'crater' arms to the union; applyScars switches on kind.
export interface BreachScar {
  kind: 'breach';
  horiz: boolean;
  x: number;
  y: number;
  wide: boolean;
}
export type Scar = BreachScar;

// A finished battle's breach log as re-stampable scars. Tile-indexed, and exact
// on a future generation of the same seed BECAUSE the map is regenerated rather
// than persisted (makeStrategicBattle calls generateMap fresh for every
// engagement, and the bourg decision rejected a map version flag for exactly
// this reason): a breach recorded at (h, 114, 87) on seed S refers to the same
// wall on every future generation of seed S.
export function breachScars(breaches: readonly BreachEvent[]): Scar[] {
  return breaches.map((b) => ({ kind: 'breach', horiz: b.horiz, x: b.x, y: b.y, wide: b.wide }));
}

// Carve step 5, for the one scar kind that exists. Writes the edge byte and the
// width code straight onto a freshly generated map — the same two writes
// Sim.breachEdge makes, which is why a re-stamped map is indistinguishable from
// the one the battle left behind.
//
// DELIBERATELY UNREFERENCED in production until T2 wires the scar list onto
// Cell. Written now so the shape is fixed and the breach log is not silently
// thrown away for a milestone; NOT called from makeStrategicBattle, because
// doing so would need a `scars` field the strategic save does not carry, and
// half-persisted damage that vanishes on reload is worse than none.
export function applyScars(map: GameMap, scars: readonly Scar[]): void {
  for (const s of scars) {
    switch (s.kind) {
      case 'breach': {
        const top = s.wide ? BREACH_WIDE : BREACH_LIP;
        if (s.horiz) {
          map.setHEdge(s.x, s.y, EDGE.BREACH);
          map.hEdgeTops[s.y * map.w + s.x] = top;
        } else {
          map.setVEdge(s.x, s.y, EDGE.BREACH);
          map.vEdgeTops[s.y * (map.w + 1) + s.x] = top;
        }
        map.hasBreach = true;
        break;
      }
    }
  }
}

export function applyEngagementOutcome(
  c: Campaign,
  front: Front,
  e: Engagement,
  sim: Sim,
  // `breaches` rides the RETURNED result, not BattleRecord: BattleRecord lives
  // in Campaign.log, which save.ts serializes, and the design forbids a save
  // schema bump for a list nothing reads until T2.
): { record: BattleRecord; redLosses: number; cellTaken: boolean; breaches: BreachEvent[] } {
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;
  // record.won is BLUE-perspective (the debrief is the player's after-action
  // report); attackerWon drives the map changes.
  const attackerWon = sim.winner === attacker.side;
  const record = applyBattleResults(c, sim, sim.winner === 'blue');
  const redLosses = sim.soldiers.filter((s) => s.side === 'red' && (!s.alive || s.downed)).length;
  // Attrite whichever chit is RED — attacker or defender. (Blue chit
  // strength is recomputed from the roster by syncStrengths below.)
  const redChit = attacker.side === 'red' ? attacker : defender;
  redChit.strength = Math.max(0, redChit.strength - redLosses);
  let cellTaken = false;
  if (attackerWon) {
    if (defender.strength > 0) retreat(front, defender);
    front.sector.cells[e.cell].owner = attacker.side;
    attacker.cell = e.cell;
    cellTaken = true;
  } else if (front.sector.cells[attacker.cell].terrain === 'river') {
    retreat(front, attacker);
  }
  syncStrengths(c, front);
  return { record, redLosses, cellTaken, breaches: sim.breachLog };
}

// Trivial-mismatch auto-resolve (owner-decided): once one side outnumbers the
// other by this much, staging a full battle is ceremony for a foregone
// conclusion — offer the player resolveCoarse's forced outcome instead.
export const TRIVIAL_RATIO = 5;

export function trivialMismatchWinner(attacker: Chit, defender: Chit): 'attacker' | 'defender' | null {
  if (attacker.strength <= 0 || defender.strength <= 0) return null; // never offer, never divide by zero
  if (attacker.strength >= defender.strength * TRIVIAL_RATIO) return 'attacker';
  if (defender.strength >= attacker.strength * TRIVIAL_RATIO) return 'defender';
  return null;
}

// The planner's belief and the resolver's truth are ONE formula (§4.4):
// coarseOdds is what the AI weighs an attack with and exactly what the
// resolver rolls against — they cannot drift.
export function coarseOdds(atkEff: number, defEff: number, terrainMult: number): number {
  return Math.max(0.05, Math.min(0.95, atkEff / (atkEff + defEff * terrainMult)));
}

// The tuned Lanchester core — THE asset (2026-07 calibration, 16 seeds,
// wars 1-15 days, both outcomes). One implementation, two callers: the grid
// resolveCoarse below and the V2 theater battle layer. Draw order is frozen:
// winner roll, winner losses, loser losses.
// atkEff/defEff (S50/S51): the WIN SCORE reads effective strength — supply
// and fatigue enter resolveCoarse through the strength terms and nowhere
// else (§4.4) — while the LOSS BANDS keep reading raw strength: a starving
// force loses fights more often, it does not evaporate. Defaults preserve
// the V1 grid path bit-for-bit.
export function coarseOutcome(
  atkStrength: number,
  defStrength: number,
  terrainMult: number,
  rng: Rng,
  forcedWinner?: 'attacker' | 'defender' | null,
  atkEff = atkStrength,
  defEff = defStrength,
): { attackerWins: boolean; atkLosses: number; defLosses: number } {
  const clampedScore = coarseOdds(atkEff, defEff, terrainMult);
  // clampedScore still allows a 5% upset either way — a forced outcome (the
  // player accepted an offered "foregone conclusion") must never roll for it.
  // The roll is DRAWN either way: a skipped draw would shift every later draw
  // one place, and accepting the walkover vs fighting out the same result
  // would fork the war from the first loss number onward.
  const winnerRoll = rng.next();
  const attackerWins = forcedWinner ? forcedWinner === 'attacker' : winnerRoll < clampedScore;
  const winnerStrength = attackerWins ? atkStrength : defStrength;
  const loserStrength = attackerWins ? defStrength : atkStrength;
  // Each side bleeds in proportion to its OWN strength: a small garrison
  // that repels a big assault isn't mauled by the effort of winning (2-6%),
  // but losing a battle is a rout (50-80%).
  const winnerLosses = Math.max(0, Math.floor(winnerStrength * (0.02 + rng.next() * 0.04)));
  const loserLosses = Math.max(1, Math.floor(loserStrength * (0.5 + rng.next() * 0.3)));
  return {
    attackerWins,
    atkLosses: attackerWins ? winnerLosses : loserLosses,
    defLosses: attackerWins ? loserLosses : winnerLosses,
  };
}

// Resolve an engagement without running a Sim — coarse Lanchester-style
// resolution for AI-vs-AI battles, and for the player's offered trivial-
// mismatch auto-resolve (forcedWinner).
// nightMult (day/night design §6): below civil-dusk light the defender
// multiplier scales by it — the fine resolver's night rules favour whoever is
// dug in. A PARAMETER, not module state (S6): production callers take the 1.0
// default (bit-identical to the tuned build) until scripts/warsweep.mjs picks
// a value from evidence (OQ7); the sweep threads candidates through here.
export function resolveCoarse(
  c: Campaign,
  front: Front,
  e: Engagement,
  forcedWinner?: 'attacker' | 'defender',
  nightMult = 1.0,
): { record: BattleRecord; attackerWon: boolean } {
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;
  const seed = (c.seed ^ (front.clockMin * 7919 + e.cell)) >>> 0; // per-campaign salt: wars differ across campaigns
  const rng = mulberry32(seed);

  const defCell = front.sector.cells[e.cell];
  const atkCell = front.sector.cells[attacker.cell];
  // Coarse balance knobs (tuned 2026-07 across 16 campaign seeds: wars run
  // 1-15 days with both 'won' and 'lost' outcomes): a bourg garrison is a
  // fortress (repeated full-strength assaults to crack), woods give cover,
  // and an assault across a defended river/bridge crossing is costlier.
  let terrainMult = 1.0;
  if (defCell.terrain === 'bourg') terrainMult *= 7.0;
  if (defCell.terrain === 'woods') terrainMult *= 1.5;
  if (atkCell.terrain === 'river' || atkCell.terrain === 'bridge') terrainMult *= 2.0; // assault across a defended crossing
  if (lightAt(front.clockMin) < 0.25) terrainMult *= nightMult;

  const { attackerWins, atkLosses, defLosses } = coarseOutcome(attacker.strength, defender.strength, terrainMult, rng, forcedWinner);
  attacker.strength = Math.max(0, attacker.strength - atkLosses);
  defender.strength = Math.max(0, defender.strength - defLosses);

  const record: BattleRecord = { day: front.day, won: attackerWins === (attacker.side === 'blue'), kia: [], wounded: [] };
  if (attacker.side === 'blue') {
    applyCoarseBlueLosses(c, attacker, atkLosses, rng, record);
  }
  if (defender.side === 'blue') {
    applyCoarseBlueLosses(c, defender, defLosses, rng, record);
  }
  c.log.push(record);

  if (attackerWins) {
    if (defender.strength > 0) retreat(front, defender);
    front.sector.cells[e.cell].owner = attacker.side;
    attacker.cell = e.cell;
  } else if (front.sector.cells[attacker.cell].terrain === 'river') {
    retreat(front, attacker);
  }
  syncStrengths(c, front);

  return { record, attackerWon: attackerWins };
}

export function applyCoarseBlueLosses(c: Campaign, chit: { companyIndex: number }, lossCount: number, rng: Rng, record: BattleRecord): void {
  // companyIndex < 0 = a red attrition counter — no roster to bleed.
  if (chit.companyIndex < 0 || lossCount <= 0) return;
  const company = c.companies[chit.companyIndex];
  const fitPids: number[] = [];
  for (const si of company.squads) {
    for (const pid of squadMembers(c.squads[si])) {
      if (c.soldiers[pid].status === 'fit') fitPids.push(pid);
    }
  }
  const toDraw = Math.min(lossCount, fitPids.length);
  for (let i = 0; i < toDraw; i++) {
    const j = i + rng.int(fitPids.length - i);
    [fitPids[i], fitPids[j]] = [fitPids[j], fitPids[i]];
    const pid = fitPids[i];
    const cs = c.soldiers[pid];
    // Coarse casualties land hard: half KIA (a rout, not a skirmish), the
    // rest out 1-3 days.
    if (rng.next() < 0.5) {
      cs.status = 'kia';
      record.kia.push(cs.name);
    } else {
      cs.status = 'recovering';
      cs.recoveryDays = 1 + rng.int(3);
      record.wounded.push(cs.name);
    }
  }
}