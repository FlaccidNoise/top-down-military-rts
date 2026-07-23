import { SQUADS, TEAMS, type SquadKey } from './data';

// Table of organization: a company as a flat list of squad/crew-team keys
// (spec: docs/specs/2026-07-22-unit-system.md "Balance harness" / Task 14
// perf work needs design-scale forces, not hand-built test squads).
export const COMPANY_TOE = {
  us_rifle_co: [
    ...Array<SquadKey>(9).fill('us_rifle'),
    ...Array<SquadKey>(3).fill('us_mortar60'),
    ...Array<SquadKey>(2).fill('us_m1919'),
    ...Array<SquadKey>(3).fill('us_bazooka'),
    'us_sniper',
  ],
  de_grenadier_co: [
    ...Array<SquadKey>(9).fill('de_gruppe'),
    ...Array<SquadKey>(2).fill('de_smg42'),
    ...Array<SquadKey>(2).fill('de_mortar81'),
    ...Array<SquadKey>(2).fill('de_schreck'),
    'de_sniper',
  ],
} satisfies Record<string, SquadKey[]>;

export function squadHeadcount(k: SquadKey): number {
  return SQUADS[k].teams.reduce((n, t) => n + TEAMS[t].slots.length, 0);
}

export function companyHeadcount(list: SquadKey[]): number {
  return list.reduce((n, k) => n + squadHeadcount(k), 0);
}

// Greedy prefix by headcount: always keeps at least one squad, and stops
// before a squad would push the running total past targetHeadcount.
export function prefixSlice(list: SquadKey[], targetHeadcount: number): SquadKey[] {
  const out: SquadKey[] = [];
  let total = 0;
  for (const k of list) {
    const hc = squadHeadcount(k);
    if (out.length > 0 && total + hc > targetHeadcount) break;
    out.push(k);
    total += hc;
  }
  return out;
}
