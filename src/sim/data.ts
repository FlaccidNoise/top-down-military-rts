export interface TerrainDef {
  color: string;
  moveCost: number; // speed divisor
  cover: number; // 0..1 hit-chance reduction for a target standing in it
  opacity: number; // LOS accumulates this per tile crossed; >= 1 blocks
  coverBehind?: number; // directional: cover granted when a shot crosses this tile within 2m of the target (hedgerow lip)
  passable: boolean;
  featureHeight?: number; // physical height (m) of the terrain feature for LOS profile check
  // Foot-passable to infantry, closed to vehicles. THE authority for the
  // vehicle rule — map.ts canStep, mapgen.ts reachField (canStep inlined) and
  // sim.ts findVehicleSpot all read this flag instead of each keeping its own
  // key blacklist. Three hand-maintained copies had already drifted (V1 added
  // 'bank' to canStep only), and every new key had to be remembered in all
  // three. Set on impassable keys too where the intent is "no vehicle here"
  // even though `passable: false` already blocks — it documents the key and
  // costs nothing (interiors design D12).
  noVehicle?: boolean;
}

export const TERRAIN = {
  grass: { color: '#4e6b3f', moveCost: 1, cover: 0, opacity: 0, passable: true },
  road: { color: '#8a8172', moveCost: 0.85, cover: 0, opacity: 0, passable: true },
  woods: { color: '#31482b', moveCost: 1.6, cover: 0.3, opacity: 0.35, passable: true, featureHeight: 8, noVehicle: true },
  floor: { color: '#a0917a', moveCost: 1, cover: 0, opacity: 0, passable: true, noVehicle: true },
  hedge: { color: '#2f4a28', moveCost: 1.8, cover: 0.35, opacity: 0.5, coverBehind: 0.5, passable: true, featureHeight: 2, noVehicle: true },
  field: { color: '#6a7245', moveCost: 1.1, cover: 0.05, opacity: 0, passable: true },
  water: { color: '#465a63', moveCost: 1, cover: 0, opacity: 0, passable: false },
  // GameMap.tiles stores TERRAIN_KEYS.indexOf(key) and TERRAIN_KEYS is
  // Object.keys(TERRAIN), so tile indices are positional: new keys APPEND at the
  // END (grass=0 .. water=6, bank=7, rail=8 must never move) or every existing
  // map fingerprint shifts. bank = the batter of an embankment/sunken-lane
  // shoulder: infantry scramble it, vehicles cannot (noVehicle). rail =
  // ballasted crest of a railway embankment: drivable but slow.
  bank: { color: '#5f6b46', moveCost: 1.5, cover: 0.1, opacity: 0, passable: true, noVehicle: true },
  rail: { color: '#6b6459', moveCost: 1.15, cover: 0.15, opacity: 0, passable: true },
  // ── interior furniture (docs/plans/2026-07-26-interiors-design.md §2.1) ────
  // Written only by the interiors pass, only over 'floor' tiles, only when
  // GameMap.hasFurniture. Rationale for each number is in that document (D4-D6)
  // and the code table is frozen in src/sim/interiors/types.ts:
  //  - impassable heavy pieces are what make an aisle an aisle (astar routes
  //    round them), and coverBehind — never `cover` — is right because nobody
  //    stands on a table: it is "fire over the counter", directional, defeated
  //    by flanking past the end of the run.
  //  - furn_light is the soft version: passable at moveCost 2.2 (worse than
  //    hedge's 1.8) with on-tile `cover`, because a man among crates really is
  //    partly covered and can really push through.
  //  - no featureHeight on any of them: los() skips a feature once the eye-line
  //    clears elev + featureHeight, and at furniture height (0.8-1.1 m, under
  //    EYE_H 1.6) that branch would fire on every ground-level shot and delete
  //    the cover outright. Consequence (D6): the substrate cannot express "the
  //    tower shoots over the pews".
  furn_heavy: { color: '#6a533a', moveCost: 1, cover: 0, opacity: 0, coverBehind: 0.4, passable: false, noVehicle: true },
  furn_light: { color: '#7d6647', moveCost: 2.2, cover: 0.25, opacity: 0, passable: true, noVehicle: true },
  hearth: { color: '#514740', moveCost: 1, cover: 0, opacity: 0, coverBehind: 0.5, passable: false, noVehicle: true },
  altar: { color: '#8d8577', moveCost: 1, cover: 0, opacity: 0, coverBehind: 0.5, passable: false, noVehicle: true },
} satisfies Record<string, TerrainDef>;

export type TerrainKey = keyof typeof TERRAIN;

export type AmmoKey = 'clip_3006' | 'mag_bar' | 'belt_3006' | 'belt_792' | 'clip_792'
  | 'mag_mp40' | 'mag_thompson' | 'rocket_bazooka' | 'rocket_schreck' | 'faust'
  | 'shell_60' | 'shell_81' | 'mag_carbine' | 'clip_springfield' | 'shell_57' | 'shell_75';

export interface WeaponDef {
  name: string;
  class: 'rifle' | 'smg' | 'mg'; // silhouette + melee-handling bucket (render, melee); SMGs spray/club, MGs are clumsy, else rifle-length
  range: number; // meters
  accuracy: number; // base hit chance at point blank
  damage: [number, number];
  cooldown: number; // seconds between attacks
  suppression: number; // suppression applied near each shot's impact
  suppRadius?: number; // suppression footprint radius (m); default sim.ts SUPPRESS_RADIUS (5). Belt MGs beat a wider zone: massed targets eat more of each burst (density tax, balance 2026-07)
  pen?: number; // armor penetration (mm-ish); presence marks an AT weapon
  ammo: { type: AmmoKey; perUnit: number; reload: number }; // reload seconds
  heat?: { perShot: number; swapTime: number }; // belt-fed barrel model
  arc?: { minRange: number; scatter: number; scatterNoLos: number }; // mortars
  oneShot?: boolean; // consume item, revert to secondary
}

export const WEAPONS = {
  garand:     { name: 'M1 Garand', class: 'rifle', range: 100, accuracy: 0.35, damage: [35, 80], cooldown: 1.6, suppression: 0.05, ammo: { type: 'clip_3006', perUnit: 8, reload: 2.5 } },
  carbine:    { name: 'M1 Carbine', class: 'rifle', range: 70, accuracy: 0.35, damage: [28, 65], cooldown: 1.4, suppression: 0.04, ammo: { type: 'mag_carbine', perUnit: 15, reload: 3 } },
  thompson:   { name: 'Thompson', class: 'smg', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05, ammo: { type: 'mag_thompson', perUnit: 30, reload: 3.5 } },
  bar:        { name: 'BAR', class: 'rifle', range: 110, accuracy: 0.38, damage: [30, 70], cooldown: 1.2, suppression: 0.1, ammo: { type: 'mag_bar', perUnit: 20, reload: 4 } },
  m1919:      { name: 'M1919A4', class: 'mg', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 2.4, suppression: 0.16, suppRadius: 8, ammo: { type: 'belt_3006', perUnit: 250, reload: 8 }, heat: { perShot: 0.02, swapTime: 10 } },
  springfield:{ name: 'M1903A4', class: 'rifle', range: 200, accuracy: 0.55, damage: [40, 85], cooldown: 4, suppression: 0.04, ammo: { type: 'clip_springfield', perUnit: 5, reload: 4 } },
  kar98k:     { name: 'Kar98k', class: 'rifle', range: 110, accuracy: 0.38, damage: [40, 85], cooldown: 2.6, suppression: 0.05, ammo: { type: 'clip_792', perUnit: 5, reload: 3 } },
  kar98k_scoped:{ name: 'Kar98k (scoped)', class: 'rifle', range: 200, accuracy: 0.55, damage: [40, 85], cooldown: 4, suppression: 0.04, ammo: { type: 'clip_792', perUnit: 5, reload: 4 } },
  mp40:       { name: 'MP40', class: 'smg', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05, ammo: { type: 'mag_mp40', perUnit: 32, reload: 3.5 } },
  mg42:       { name: 'MG42', class: 'mg', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 1.8, suppression: 0.22, suppRadius: 10, ammo: { type: 'belt_792', perUnit: 250, reload: 7 }, heat: { perShot: 0.04, swapTime: 8 } },
  bazooka:    { name: 'Bazooka', class: 'rifle', range: 70, accuracy: 0.35, damage: [30, 70], cooldown: 7, suppression: 0.1, pen: 100, ammo: { type: 'rocket_bazooka', perUnit: 1, reload: 7 } },
  schreck:    { name: 'Panzerschreck', class: 'rifle', range: 90, accuracy: 0.4, damage: [30, 70], cooldown: 8, suppression: 0.1, pen: 160, ammo: { type: 'rocket_schreck', perUnit: 1, reload: 8 } },
  panzerfaust:{ name: 'Panzerfaust', class: 'rifle', range: 35, accuracy: 0.5, damage: [30, 70], cooldown: 9, suppression: 0.1, pen: 150, ammo: { type: 'faust', perUnit: 1, reload: 0 }, oneShot: true },
  mortar60:   { name: 'M2 60mm', class: 'rifle', range: 180, accuracy: 0.5, damage: [25, 75], cooldown: 4, suppression: 0.12, ammo: { type: 'shell_60', perUnit: 1, reload: 4 }, arc: { minRange: 20, scatter: 4, scatterNoLos: 9 } },
  mortar81:   { name: 'GrW 34 8cm', class: 'rifle', range: 240, accuracy: 0.5, damage: [30, 85], cooldown: 6, suppression: 0.16, ammo: { type: 'shell_81', perUnit: 1, reload: 6 }, arc: { minRange: 30, scatter: 5, scatterNoLos: 10 } },
  at57_gun:   { name: 'M1 57mm', class: 'rifle', range: 140, accuracy: 0.55, damage: [40, 90], cooldown: 6, suppression: 0.12, pen: 110, ammo: { type: 'shell_57', perUnit: 1, reload: 5 } },
  pak40_gun:  { name: 'PaK 40 7.5cm', class: 'rifle', range: 160, accuracy: 0.6, damage: [45, 95], cooldown: 6, suppression: 0.14, pen: 150, ammo: { type: 'shell_75', perUnit: 1, reload: 5 } },
} satisfies Record<string, WeaponDef>;
export type WeaponKey = keyof typeof WEAPONS;

export interface LoadDef {
  name: string;
  speedCap: number; // m/s cap while carrying
  staminaMult: number; // stamina drain multiplier while carrying
}

export const LOADS = {
  tripod_m1919: { name: 'M1919 tripod', speedCap: 1.4, staminaMult: 2 },
  lafette: { name: 'MG42 Lafette', speedCap: 1.2, staminaMult: 2.5 },
  mg_gun: { name: 'MG receiver', speedCap: 1.6, staminaMult: 1.5 },
  mortar_tube: { name: 'Mortar tube', speedCap: 1.4, staminaMult: 2 },
  mortar_baseplate: { name: 'Mortar baseplate', speedCap: 1.4, staminaMult: 2 },
  ammo_cans: { name: 'Ammo cans', speedCap: 1.6, staminaMult: 1.5 },
  shell_load: { name: 'Shell load', speedCap: 1.6, staminaMult: 1.5 },
} satisfies Record<string, LoadDef>;
export type LoadKey = keyof typeof LOADS;

export type Role = 'leader' | 'gunner' | 'assistant' | 'rifleman' | 'bearer' | 'driver' | 'sniper' | 'scout' | 'aidman';

export interface SoldierSlot {
  role: Role;
  weapon: WeaponKey;
  ammo: Partial<Record<AmmoKey, number>>; // discrete units carried
  carries?: LoadKey[];
  grenades?: number; // 2 for grenadiers, 0 default
}

export interface TeamDef {
  name: string;
  slots: SoldierSlot[];
}

export const TEAMS = {
  us_able: {
    name: 'Able',
    slots: [
      { role: 'leader', weapon: 'thompson', ammo: { mag_thompson: 5 } },
      { role: 'gunner', weapon: 'bar', ammo: { mag_bar: 8 } },
      { role: 'assistant', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
    ],
  },
  us_baker: {
    name: 'Baker',
    slots: [
      { role: 'leader', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'aidman', weapon: 'carbine', ammo: { mag_carbine: 6 } }, // spec: carries a carbine/pistol, no combat role
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 }, grenades: 2 },
    ],
  },
  us_m1919_team: {
    name: 'M1919 HMG Team',
    slots: [
      { role: 'gunner', weapon: 'm1919', ammo: { belt_3006: 2 }, carries: ['mg_gun'] },
      { role: 'assistant', weapon: 'carbine', ammo: { mag_carbine: 6 }, carries: ['tripod_m1919'] },
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6 }, carries: ['ammo_cans'] },
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6 } },
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6 } },
    ],
  },
  us_mortar60_team: {
    name: '60mm Mortar Team',
    slots: [
      { role: 'gunner', weapon: 'mortar60', ammo: { shell_60: 6 }, carries: ['mortar_tube'] },
      { role: 'assistant', weapon: 'carbine', ammo: { mag_carbine: 6 }, carries: ['mortar_baseplate'] },
      { role: 'bearer', weapon: 'carbine', ammo: { shell_60: 6 }, carries: ['shell_load'] },
      { role: 'bearer', weapon: 'carbine', ammo: { shell_60: 6 } },
    ],
  },
  us_bazooka_team: {
    name: 'Bazooka Team',
    slots: [
      { role: 'gunner', weapon: 'bazooka', ammo: { rocket_bazooka: 3 } }, // +1 loaded = 4 total
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6 } },
    ],
  },
  us_sniper_team: {
    name: 'Sniper-Scout Team',
    slots: [
      { role: 'sniper', weapon: 'springfield', ammo: { clip_springfield: 8 } },
      { role: 'scout', weapon: 'garand', ammo: { clip_3006: 8 } },
    ],
  },
  de_mg_trupp: {
    name: 'MG-Trupp',
    slots: [
      { role: 'gunner', weapon: 'mg42', ammo: { belt_792: 2 } },
      { role: 'assistant', weapon: 'kar98k', ammo: { belt_792: 2 }, carries: ['mg_gun'] }, // spare-barrel abstraction rides heat.swapTime
      { role: 'bearer', weapon: 'kar98k', ammo: { belt_792: 3 }, carries: ['ammo_cans'] },
    ],
  },
  de_schuetzen: {
    name: 'Schützen',
    slots: [
      { role: 'leader', weapon: 'mp40', ammo: { mag_mp40: 5 } },
      { role: 'rifleman', weapon: 'kar98k', ammo: { clip_792: 8, faust: 1 } },
      { role: 'rifleman', weapon: 'kar98k', ammo: { clip_792: 8, faust: 1 } },
      { role: 'rifleman', weapon: 'kar98k', ammo: { clip_792: 8 } },
      { role: 'rifleman', weapon: 'kar98k', ammo: { clip_792: 8 } },
      { role: 'aidman', weapon: 'kar98k', ammo: { clip_792: 4 } }, // Sanitäter: carbine-equivalent, no combat role
    ],
  },
  de_smg42_team: {
    name: 'sMG42 Team',
    slots: [
      { role: 'gunner', weapon: 'mg42', ammo: { belt_792: 2 }, carries: ['mg_gun'] },
      { role: 'assistant', weapon: 'kar98k', ammo: { belt_792: 2 }, carries: ['lafette'] },
      { role: 'bearer', weapon: 'kar98k', ammo: { belt_792: 2 }, carries: ['ammo_cans'] },
      { role: 'bearer', weapon: 'kar98k', ammo: { belt_792: 2 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { belt_792: 2 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { belt_792: 2 } },
    ],
  },
  de_mortar81_team: {
    name: '8cm Mortar Team',
    slots: [
      { role: 'gunner', weapon: 'mortar81', ammo: { shell_81: 6 }, carries: ['mortar_tube'] },
      { role: 'assistant', weapon: 'kar98k', ammo: { clip_792: 8 }, carries: ['mortar_baseplate'] },
      { role: 'bearer', weapon: 'kar98k', ammo: { shell_81: 6 }, carries: ['shell_load'] },
      { role: 'bearer', weapon: 'kar98k', ammo: { shell_81: 6 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { shell_81: 6 } },
    ],
  },
  de_schreck_team: {
    name: 'Panzerschreck Team',
    slots: [
      { role: 'gunner', weapon: 'schreck', ammo: { rocket_schreck: 3 } }, // +1 loaded = 4 total
      { role: 'bearer', weapon: 'kar98k', ammo: { clip_792: 8 } },
    ],
  },
  de_sniper_team: {
    name: 'Sniper Team',
    slots: [
      { role: 'sniper', weapon: 'kar98k_scoped', ammo: { clip_792: 8 } },
      { role: 'scout', weapon: 'mp40', ammo: { mag_mp40: 5 } },
    ],
  },
  // AT gun crews: not man-packable (EMPLACEMENTS.at57/pak40 declare loads: []),
  // so slot weapons are personal sidearms only — the gun itself is fired by
  // the emplacement, funded from the gunner's own ammo (shell_57/shell_75),
  // not from a Soldier.weapon field. Batch 1 deliberately left these out;
  // Task 9 (EMPLACEMENT_CREW) owns them.
  us_at57_team: {
    name: '57mm AT Gun Crew',
    slots: [
      { role: 'gunner', weapon: 'carbine', ammo: { mag_carbine: 6, shell_57: 6 } },
      { role: 'assistant', weapon: 'carbine', ammo: { mag_carbine: 6, shell_57: 4 } },
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6, shell_57: 4 } },
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6 } },
      { role: 'bearer', weapon: 'carbine', ammo: { mag_carbine: 6 } },
    ],
  },
  de_pak40_team: {
    name: 'PaK 40 Crew',
    slots: [
      { role: 'gunner', weapon: 'kar98k', ammo: { clip_792: 8, shell_75: 6 } },
      { role: 'assistant', weapon: 'kar98k', ammo: { clip_792: 8, shell_75: 4 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { clip_792: 8, shell_75: 4 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { clip_792: 8 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { clip_792: 8 } },
      { role: 'bearer', weapon: 'kar98k', ammo: { clip_792: 8 } },
    ],
  },
} satisfies Record<string, TeamDef>;
export type TeamKey = keyof typeof TEAMS;

export interface SquadDef {
  name: string;
  side: 'us' | 'de';
  teams: TeamKey[]; // 1-3; crew squads have exactly 1
}

export const SQUADS = {
  us_rifle: { name: 'Rifle Squad', side: 'us', teams: ['us_able', 'us_baker'] },
  us_m1919: { name: 'M1919 HMG Team', side: 'us', teams: ['us_m1919_team'] },
  us_mortar60: { name: '60mm Mortar Team', side: 'us', teams: ['us_mortar60_team'] },
  us_bazooka: { name: 'Bazooka Team', side: 'us', teams: ['us_bazooka_team'] },
  us_sniper: { name: 'Sniper-Scout Team', side: 'us', teams: ['us_sniper_team'] },
  de_gruppe: { name: 'Grenadier Gruppe', side: 'de', teams: ['de_mg_trupp', 'de_schuetzen'] },
  de_smg42: { name: 'sMG42 Team', side: 'de', teams: ['de_smg42_team'] },
  de_mortar81: { name: '8cm Mortar Team', side: 'de', teams: ['de_mortar81_team'] },
  de_schreck: { name: 'Panzerschreck Team', side: 'de', teams: ['de_schreck_team'] },
  de_sniper: { name: 'Sniper Team', side: 'de', teams: ['de_sniper_team'] },
  us_at57: { name: '57mm AT Gun Crew', side: 'us', teams: ['us_at57_team'] },
  de_pak40: { name: 'PaK 40 Crew', side: 'de', teams: ['de_pak40_team'] },
} satisfies Record<string, SquadDef>;
export type SquadKey = keyof typeof SQUADS;

export interface EmplacementDef {
  name: string;
  weapon: WeaponKey;
  setupTime: number;
  packTime: number;
  loads: LoadKey[]; // empty = not man-packable
  wheeled?: { speed: number };
  towable?: boolean;
  minCrew: number;
}

export const EMPLACEMENTS = {
  m1919_tripod: { name: 'M1919A4 tripod', weapon: 'm1919', setupTime: 30, packTime: 20, loads: ['tripod_m1919', 'mg_gun', 'ammo_cans'], minCrew: 2 },
  mg42_lafette: { name: 'MG42 on Lafette', weapon: 'mg42', setupTime: 30, packTime: 20, loads: ['lafette', 'mg_gun', 'ammo_cans'], minCrew: 2 },
  mortar60: { name: 'M2 60mm mortar', weapon: 'mortar60', setupTime: 45, packTime: 30, loads: ['mortar_tube', 'mortar_baseplate', 'shell_load'], minCrew: 2 },
  mortar81: { name: 'GrW 34 8cm mortar', weapon: 'mortar81', setupTime: 60, packTime: 40, loads: ['mortar_tube', 'mortar_baseplate', 'shell_load'], minCrew: 3 },
  at57: { name: 'M1 57mm AT gun', weapon: 'at57_gun', setupTime: 60, packTime: 45, loads: [], wheeled: { speed: 1 }, towable: true, minCrew: 3 },
  pak40: { name: 'PaK 40 7.5cm', weapon: 'pak40_gun', setupTime: 60, packTime: 45, loads: [], wheeled: { speed: 0.8 }, towable: true, minCrew: 3 },
} satisfies Record<string, EmplacementDef>;
export type EmplacementKey = keyof typeof EMPLACEMENTS;

// Which crew squad serves each emplacement (spec §4's vehicle-crew pattern:
// emplacement entity + crew team bound by crewOf). Sim.addEmplacement spawns
// this squad and binds its one team to the new Emplacement.
export const EMPLACEMENT_CREW: Record<EmplacementKey, SquadKey> = {
  m1919_tripod: 'us_m1919',
  mg42_lafette: 'de_smg42',
  mortar60: 'us_mortar60',
  mortar81: 'de_mortar81',
  at57: 'us_at57',
  pak40: 'de_pak40',
};

export interface VehicleDef {
  name: string;
  speed: number; // m/s
  armor: { front: number; side: number; rear: number };
  gunPen: number;
  gunAccuracy: number;
  gunRange: number;
  gunCooldown: number;
  mgRange: number;
  ammo: { ap: number; he: number };
  turret: 'full' | number; // number = traverse degrees (StuG: 12)
  // What this hull can drive through (destructible-terrain design §2.1). Stated
  // per vehicle rather than inferred from armour or openTop: those are proxies
  // that go wrong the first time an open-topped tank destroyer joins the
  // roster, and this codebase has already been bitten by hand-kept blacklists
  // drifting from the rule they stand in for (see canStep/reachField).
  // 'light' flattens fences, gates and waist walls; 'heavy' also takes a
  // head-high enclosure wall. Neither ever drives through a house.
  crush: 'light' | 'heavy';
  crew: SoldierSlot[]; // replaces hardcoded crew
  seats?: number; // transport capacity
  towHook?: boolean;
  openTop?: boolean;
}

export const VEHICLES = {
  sherman: {
    name: 'M4 Sherman',
    speed: 4.5,
    armor: { front: 90, side: 50, rear: 40 },
    gunPen: 110,
    gunAccuracy: 0.5,
    gunRange: 120,
    gunCooldown: 4.5,
    mgRange: 100,
    ammo: { ap: 30, he: 40 },
    turret: 'full',
    crush: 'heavy',
    crew: [
      { role: 'leader', weapon: 'carbine', ammo: { mag_carbine: 6 } },
      { role: 'gunner', weapon: 'carbine', ammo: { mag_carbine: 6 } },
      { role: 'driver', weapon: 'carbine', ammo: { mag_carbine: 6 } },
    ],
  },
  panzer4: {
    name: 'Panzer IV',
    speed: 4.2,
    armor: { front: 85, side: 35, rear: 25 },
    gunPen: 120,
    gunAccuracy: 0.5,
    gunRange: 120,
    gunCooldown: 4.5,
    mgRange: 100,
    ammo: { ap: 30, he: 40 },
    turret: 'full',
    crush: 'heavy',
    crew: [
      { role: 'leader', weapon: 'mp40', ammo: { mag_mp40: 5 } },
      { role: 'gunner', weapon: 'mp40', ammo: { mag_mp40: 5 } },
      { role: 'driver', weapon: 'mp40', ammo: { mag_mp40: 5 } },
    ],
  },
  stug3: {
    name: 'StuG III G',
    speed: 4,
    armor: { front: 80, side: 30, rear: 30 },
    gunPen: 135,
    gunAccuracy: 0.5,
    gunRange: 120,
    gunCooldown: 4.5,
    mgRange: 100,
    ammo: { ap: 30, he: 40 },
    turret: 12, // casemate: hull traverse only, ±12°
    crush: 'heavy',
    crew: [
      { role: 'leader', weapon: 'mp40', ammo: { mag_mp40: 5 } },
      { role: 'gunner', weapon: 'mp40', ammo: { mag_mp40: 5 } },
      { role: 'driver', weapon: 'mp40', ammo: { mag_mp40: 5 } },
    ],
  },
  m3_halftrack: {
    name: 'M3 Halftrack',
    speed: 7,
    armor: { front: 15, side: 10, rear: 10 },
    gunPen: 0,
    gunAccuracy: 0.4,
    gunRange: 0, // no main gun — pintle MG only, modeled via mg fields
    gunCooldown: 5,
    mgRange: 100,
    ammo: { ap: 0, he: 0 },
    turret: 'full',
    crush: 'light',
    crew: [
      { role: 'driver', weapon: 'carbine', ammo: { mag_carbine: 6 } },
      { role: 'gunner', weapon: 'carbine', ammo: { mag_carbine: 6 } },
    ],
    seats: 12,
    towHook: true,
    openTop: true,
  },
  sdkfz251: {
    name: 'SdKfz 251',
    speed: 7,
    armor: { front: 15, side: 10, rear: 10 },
    gunPen: 0,
    gunAccuracy: 0.4,
    gunRange: 0,
    gunCooldown: 5,
    mgRange: 100,
    ammo: { ap: 0, he: 0 },
    turret: 'full',
    crush: 'light',
    crew: [
      { role: 'driver', weapon: 'mp40', ammo: { mag_mp40: 5 } },
      { role: 'gunner', weapon: 'mp40', ammo: { mag_mp40: 5 } },
    ],
    seats: 10,
    towHook: true,
    openTop: true,
  },
} satisfies Record<string, VehicleDef>;

export type VehicleKey = keyof typeof VEHICLES;

export const US_NAMES = ['Miller', 'Kowalski', 'Reyes', 'Sullivan', 'Baker', 'Carter', 'Nowak', 'Greco', 'Hayes', 'Dawson', 'Olsen', 'Freeman', 'Marsh', 'Quinn', 'Boone', 'Vance', 'Kirby', 'Slater', 'Doyle', 'Webb'];
export const DE_NAMES = ['Müller', 'Schneider', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Koch', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Braun', 'Krüger', 'Hofmann', 'Lange', 'Schmitt', 'Werner', 'Krause'];
