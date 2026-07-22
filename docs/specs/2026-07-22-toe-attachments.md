# Company TO&E + Attachments — 2026-07-22

Design only. The integration spec: stitches the unit system (2026-07-22-unit-system.md) to the strategic campaign (2026-07-22-strategic-campaign.md). Fixes campaign-seam issues: chit schema, supply→ammo mapping, resolver weights, Outcome equipment.

**Confirmed fork:** company core is fixed historical TO&E (it IS the national asymmetry); battalion assets attach per operation via a requisition-point budget. AI commander spends the same catalog. Free point-buy rejected (destroys TO&E identity and the named-roster fantasy).

## Principle

Model the fighting echelon; abstract the admin tail. A "company" chit contains only combat teams — cooks, clerks, and supply troops live inside the supply/replacement abstractions.

## Company TO&E (game adaptation of 1944 tables)

### US Rifle Company '44 — 18 squads, ~138 men core

| Element | Units | Men |
|---|---|---|
| 3 rifle platoons | 9× Rifle Squad (12) | 108 |
| Weapons platoon | 3× 60mm mortar team (4), 2× M1919 HMG team (5) | 22 |
| Company pool | 3× bazooka team (2) | 6 |
| Attached | 1× sniper-scout team (2); 3 aidmen (1/platoon, folded into platoon rosters) | 2+3 |

Exactly the 18-squads/side design target. Platoons are **roster/deployment grouping only** — no command layer (HQ/command teams stay someday, per unit spec).

### German Grenadier Company '44 — 16 squads, ~109 men core

| Element | Units | Men |
|---|---|---|
| 3 platoons | 9× Grenadier Gruppe (9) | 81 |
| Company troops | 2× sMG42 team (6) | 12 |
| Attached down by default template | 2× 8cm mortar team (5), 2× Panzerschreck team (2) | 14 |
| Attached | 1× sniper team (2); 3 Sanitäter | 2+3 |

Deliberately smaller and MG-heavier than the US company — the correct '44 feel (understrength companies, more automatics per man). Historical purists' note: 8cm and Schreck were battalion assets; the default template pre-attaches them so a bare German company isn't helpless, and the requisition catalog can add more.

## Requisition (attachments)

- Operation template grants each side a **point budget** at operation start (and optionally at reinforcement phases). Budgets are asymmetric — a scenario/difficulty lever.
- Player spends points from a national **attachment catalog**; attachments bind to a company chit for the operation, fight in its battles, and their losses persist (crews are named soldiers in the universal roster; destroyed vehicles stay destroyed).
- AI front commander spends its budget through the identical catalog (no special AI units).

### Catalog v1 (costs are placeholders — calibrate via headless harness)

| US | pts | German | pts |
|---|---|---|---|
| Sherman section (2) | 40 | StuG III section (2) | 35 |
| M3 halftrack lift (3 — mounts a platoon) | 20 | SdKfz 251 lift (3) | 20 |
| 57mm AT section (2 guns + crews + tow) | 25 | PaK 40 section (2 + crews + tow) | 30 |
| Extra M1919 HMG section (2) | 15 | Extra sMG42 section (2) | 15 |
| Extra bazooka teams (2) | 10 | Extra Panzerfaust issue (+2/squad) | 10 |
| Extra 60mm section (2) | 15 | Extra 8cm team (1) | 15 |
| Off-map battery priority (+1 barrage) | 20 | Off-map battery priority | 20 |
| *Wave 2:* M8 section, M5A1 section | — | *Wave 2:* SdKfz 222/Puma section | — |

## Schema stitching (supersedes campaign spec's CompanyChit sketch)

```ts
interface CompanyDef {              // pure data, data.ts
  name: string; side: Side;
  platoons: { name: string; squads: SquadKey[] }[];  // grouping only
}
interface AttachmentDef {           // pure data
  name: string; side: Side; cost: number;
  squads?: SquadKey[]; vehicles?: VehicleKey[]; emplacements?: EmplacementKey[];
  modifiers?: { faustsPerSquad?: number; barrages?: number };  // non-unit attachments
}

interface SquadInstance { def: SquadKey; teams: { def: TeamKey; members: pid[] }[] }
interface CompanyChit {             // strategic layer — replaces prior sketch
  id: number; side: Side;
  cell: XY; destination?: XY; stance: 'attack' | 'defend' | 'move' | 'rest';
  toe: CompanyKey;
  squads: SquadInstance[];          // live roster incl. team structure
  attachments: { def: AttachmentKey; squads: SquadInstance[]; vehicles: VehicleInstanceId[] }[];
  supply: 'full' | 'low' | 'out'; fatigue: number;
}
```

- `carveBattle(chit, …)` flattens chit → the same battle-population shape `ForceDef` produces for standalone scenarios: one path into the Sim, two sources of content.
- Emplacements now exist on the strategic map (inside attachments/TO&E) — they move with the company, and can be captured (below).

## Supply → ammo mapping (per-soldier loadouts at battle start)

| Supply | Loadout |
|---|---|
| full | 100% of `SoldierSlot.ammo` def counts |
| low | 50%, rounded down, min 1 unit per slot — scaling is per-soldier, so distributed MG belts still exist and the ammo-runner mechanic survives scarcity |
| out | 25%; no mortar shells or rocket/faust replenishment between battles |

Vehicles gain ammo counts (amendment to unit spec §7 VehicleDef): `ammo: { ap: number; he: number }`, scaled by the same table. Fatigue mapping: battle-start stamina = f(chit fatigue) — companies at 'rest' stance recover both.

## Coarse resolver + Outcome (seam fixes)

- Resolver scores are **derived from weapon defs**, not hand-tuned per team: team firepower = Σ(rate × damage), suppression = Σ(suppression × rate), AT = best pen. New units automatically resolve correctly; calibration against the tactical harness stays the source of truth.
- `Outcome` gains equipment results: `{ vehiclesLost, gunsLost, gunsCaptured }`. Intact emplacements whose crews died/routed in a lost cell are **captured** — usable by the captor (crewSkill penalty, see casualty-chain spec), and the classic "turn the PaK around" moment. Destroyed vehicles/guns append to cell scars.
