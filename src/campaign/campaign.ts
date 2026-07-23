import { PARTS } from '../sim/body';
import { SQUADS, TEAMS, US_NAMES, type SquadKey, type TeamKey, type WeaponKey } from '../sim/data';
import { mulberry32 } from '../sim/rng';
import type { CrewClass, Sim } from '../sim/sim';
import { COMPANY_TOE } from '../sim/toe';

// The campaign roster: named soldiers persisting across battles, carrying
// wounds, experience, and bonds. Destroyed body parts never heal.

export interface CSoldier {
  pid: number;
  name: string;
  weapon: WeaponKey;
  courage: number;
  xp: number;
  bodyDamage: number[]; // permanent + healing damage per part
  status: 'fit' | 'recovering' | 'kia';
  recoveryDays: number;
  bonds: Record<number, number>; // pid -> 0..1
  battles: number;
  crewSkill: Partial<Record<CrewClass, number>>;
}

export interface BattleRecord {
  day: number;
  won: boolean;
  kia: string[];
  wounded: string[];
}

export interface CampaignTeam {
  def: TeamKey;
  members: number[]; // pids, slot order, front-packed (index i = slot i)
}

export interface CampaignSquad {
  name: string;
  def: SquadKey;
  teams: CampaignTeam[]; // 1:1 with SQUADS[def].teams, same order
}

export function squadMembers(sq: CampaignSquad): number[] {
  return sq.teams.flatMap((t) => t.members);
}

export interface Campaign {
  day: number;
  nextPid: number;
  companies: { name: string; squads: number[] }[]; // indices into squads
  squads: CampaignSquad[];
  soldiers: Record<number, CSoldier>;
  log: BattleRecord[];
}

function uniqueName(c: Campaign, rng: { int(n: number): number }): string {
  const used = new Set(Object.values(c.soldiers).map((s) => s.name));
  for (let i = 0; i < 40; i++) {
    const n = US_NAMES[rng.int(US_NAMES.length)];
    if (!used.has(n)) return n;
  }
  // pool exhausted: disambiguate with an initial
  const base = US_NAMES[rng.int(US_NAMES.length)];
  const initial = String.fromCharCode(65 + rng.int(26));
  return `${base} ${initial}.`;
}

function newSoldier(c: Campaign, rng: { next(): number; int(n: number): number }, green: boolean): CSoldier {
  const s: CSoldier = {
    pid: c.nextPid++,
    name: uniqueName(c, rng),
    weapon: 'garand',
    courage: green ? 0.25 + rng.next() * 0.35 : 0.3 + rng.next() * 0.6,
    xp: 0,
    bodyDamage: PARTS.map(() => 0),
    status: 'fit',
    recoveryDays: 0,
    bonds: {},
    battles: 0,
    crewSkill: {},
  };
  c.soldiers[s.pid] = s;
  return s;
}

export const COMPANY_NAMES = ['Able', 'Baker', 'Charlie'];

// us_rifle_co TO&E is 9 rifle, 3 mortar60, 2 m1919, 3 bazooka, 1 sniper (18
// squads, in that order); names are derived positionally from that shape.
function companySquadNames(coName: string): string[] {
  const counts: Partial<Record<SquadKey, number>> = {};
  for (const k of COMPANY_TOE.us_rifle_co) counts[k] = (counts[k] ?? 0) + 1;
  if (counts.us_rifle !== 9 || counts.us_mortar60 !== 3 || counts.us_m1919 !== 2 || counts.us_bazooka !== 3 || counts.us_sniper !== 1) {
    throw new Error('companySquadNames: us_rifle_co TO&E shape changed; naming assumes 9/3/2/3/1');
  }
  const ordinal = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
  return [
    ...ordinal.map((o) => `${coName} ${o}`),
    ...[1, 2, 3].map((n) => `${coName} Mortar ${n}`),
    ...[1, 2].map((n) => `${coName} MG ${n}`),
    ...[1, 2, 3].map((n) => `${coName} Zooka ${n}`),
    `${coName} Scouts`,
  ];
}

export function newCampaign(seed: number): Campaign {
  const rng = mulberry32(seed);
  const c: Campaign = { day: 1, nextPid: 1, companies: [], squads: [], soldiers: {}, log: [] };
  for (const coName of COMPANY_NAMES) {
    const squadIndexes: number[] = [];
    const names = companySquadNames(coName);
    COMPANY_TOE.us_rifle_co.forEach((squadKey, i) => {
      const teams: CampaignTeam[] = SQUADS[squadKey].teams.map((teamKey) => ({
        def: teamKey,
        members: TEAMS[teamKey].slots.map((slot) => {
          const s = newSoldier(c, rng, false);
          s.weapon = slot.weapon; // display/informational — battle spawns take weapons from slots
          return s.pid;
        }),
      }));
      const sq: CampaignSquad = { name: names[i], def: squadKey, teams };
      // trained together: everyone starts somewhat bonded
      const members = squadMembers(sq);
      for (const a of members) for (const b of members) if (a !== b) c.soldiers[a].bonds[b] = 0.3;
      squadIndexes.push(c.squads.length);
      c.squads.push(sq);
    });
    c.companies.push({ name: coName, squads: squadIndexes });
  }
  return c;
}

// Battle-end bookkeeping: casualties, healing clocks, xp, bond growth.
export function applyBattleResults(c: Campaign, sim: Sim, won: boolean): BattleRecord {
  const record: BattleRecord = { day: c.day, won, kia: [], wounded: [] };
  const survivorsBySquad: number[][] = c.squads.map(() => []);

  for (const s of sim.soldiers) {
    if (s.pid < 0 || s.side !== 'blue') continue;
    const cs = c.soldiers[s.pid];
    if (!cs) continue;
    cs.crewSkill = { ...s.crewSkill }; // grown by use across battles (spec: casualty-chain.md)
    if (!s.alive) {
      cs.status = 'kia';
      record.kia.push(cs.name);
      continue;
    }
    // battle damage becomes healing damage; destroyed parts are forever
    for (let i = 0; i < PARTS.length; i++) {
      cs.bodyDamage[i] = PARTS[i].hp - s.body[i];
    }
    const totalDmg = cs.bodyDamage.reduce((a, d, i) => a + (s.body[i] > 0 ? d : 0), 0);
    if (totalDmg > 0 || s.downed) {
      cs.status = 'recovering';
      cs.recoveryDays = Math.max(1, Math.ceil(totalDmg / 15) + (s.downed ? 3 : 0));
      record.wounded.push(cs.name);
    }
    cs.battles++;
    cs.xp = Math.min(10, cs.xp + 1);
    const sq = c.squads.findIndex((q) => squadMembers(q).includes(s.pid));
    if (sq >= 0) survivorsBySquad[sq].push(s.pid);
  }

  // shared survival forges bonds
  for (const pids of survivorsBySquad) {
    for (const a of pids) {
      for (const b of pids) {
        if (a !== b) c.soldiers[a].bonds[b] = Math.min(1, (c.soldiers[a].bonds[b] ?? 0) + 0.15);
      }
    }
  }

  c.log.push(record);
  return record;
}

export function advanceDays(c: Campaign, days: number): void {
  c.day += days;
  for (const cs of Object.values(c.soldiers)) {
    if (cs.status !== 'recovering') continue;
    cs.recoveryDays -= days;
    if (cs.recoveryDays <= 0) {
      cs.status = 'fit';
      cs.recoveryDays = 0;
      // wounds heal — except destroyed parts, which stay destroyed
      for (let i = 0; i < PARTS.length; i++) {
        if (cs.bodyDamage[i] < PARTS[i].hp) cs.bodyDamage[i] = 0;
      }
    }
  }
}

export function fillReplacements(c: Campaign, seed: number, capPerCompany = Infinity): number {
  const rng = mulberry32(seed);
  // kia pids drop first: survivors shift toward slot 0 (array order IS slot
  // order), so filtering alone reproduces crew succession.
  for (const squad of c.squads) {
    for (const team of squad.teams) team.members = team.members.filter((pid) => c.soldiers[pid].status !== 'kia');
  }
  const deficit = (si: number) =>
    c.squads[si].teams.reduce((n, t) => n + Math.max(0, TEAMS[t.def].slots.length - t.members.length), 0);

  let total = 0;
  for (const company of c.companies) {
    const order = [...company.squads].sort((a, b) => deficit(b) - deficit(a));
    let added = 0;
    for (const si of order) {
      for (const team of c.squads[si].teams) {
        const capacity = TEAMS[team.def].slots.length;
        while (team.members.length < capacity && added < capPerCompany) {
          const green = newSoldier(c, rng, true); // no bonds: the new guy is a stranger
          team.members.push(green.pid); // replacement takes the junior slot
          added++;
        }
      }
    }
    total += added;
  }
  return total;
}

export interface RosterEntry {
  pid: number;
  name: string;
  weapon: WeaponKey;
  courage: number;
  xp: number;
  bodyDamage: number[];
  bonds: Record<number, number>;
  crewSkill: Partial<Record<CrewClass, number>>;
}

export function fitRoster(c: Campaign, squadIndex: number): RosterEntry[][] {
  return c.squads[squadIndex].teams.map((team) =>
    team.members
      .map((pid) => c.soldiers[pid])
      .filter((cs) => cs.status === 'fit')
      .map((cs) => ({
        pid: cs.pid,
        name: cs.name,
        weapon: cs.weapon,
        courage: cs.courage,
        xp: cs.xp,
        bodyDamage: cs.bodyDamage,
        bonds: cs.bonds,
        crewSkill: cs.crewSkill,
      })),
  );
}
