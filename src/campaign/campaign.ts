import { PARTS } from '../sim/body';
import { US_NAMES, type WeaponKey } from '../sim/data';
import { mulberry32 } from '../sim/rng';
import type { CrewClass, Sim } from '../sim/sim';

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

export interface Campaign {
  day: number;
  nextPid: number;
  companies: { name: string; squads: number[] }[]; // indices into squads
  squads: { name: string; members: number[] }[];
  soldiers: Record<number, CSoldier>;
  log: BattleRecord[];
}

const SQUAD_SIZE = 9;

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
export const SQUADS_PER_COMPANY = 3;

export function newCampaign(seed: number): Campaign {
  const rng = mulberry32(seed);
  const c: Campaign = { day: 1, nextPid: 1, companies: [], squads: [], soldiers: {}, log: [] };
  const ordinal = ['1st', '2nd', '3rd'];
  for (const coName of COMPANY_NAMES) {
    const squadIndexes: number[] = [];
    for (let q = 0; q < SQUADS_PER_COMPANY; q++) {
      const members: number[] = [];
      for (let i = 0; i < SQUAD_SIZE; i++) {
        const s = newSoldier(c, rng, false);
        if (i === 0) s.weapon = 'thompson';
        if (i === 1) s.weapon = 'bar';
        members.push(s.pid);
      }
      // trained together: everyone starts somewhat bonded
      for (const a of members) for (const b of members) if (a !== b) c.soldiers[a].bonds[b] = 0.3;
      squadIndexes.push(c.squads.length);
      c.squads.push({ name: `${coName} ${ordinal[q]}`, members });
    }
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
    const sq = c.squads.findIndex((q) => q.members.includes(s.pid));
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

export function fillReplacements(c: Campaign, seed: number): number {
  const rng = mulberry32(seed);
  let added = 0;
  for (const squad of c.squads) {
    squad.members = squad.members.filter((pid) => c.soldiers[pid].status !== 'kia');
    while (squad.members.filter((pid) => c.soldiers[pid].status === 'fit').length < SQUAD_SIZE) {
      const green = newSoldier(c, rng, true); // no bonds: the new guy is a stranger
      squad.members.push(green.pid);
      added++;
    }
  }
  return added;
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

export function fitRoster(c: Campaign, squadIndex: number): RosterEntry[] {
  return c.squads[squadIndex].members
    .map((pid) => c.soldiers[pid])
    .filter((cs) => cs.status === 'fit')
    .slice(0, SQUAD_SIZE)
    .map((cs) => ({
      pid: cs.pid,
      name: cs.name,
      weapon: cs.weapon,
      courage: cs.courage,
      xp: cs.xp,
      bodyDamage: cs.bodyDamage,
      bonds: cs.bonds,
      crewSkill: cs.crewSkill,
    }));
}
