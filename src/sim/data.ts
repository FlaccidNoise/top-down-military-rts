export interface TerrainDef {
  color: string;
  moveCost: number; // speed divisor
  cover: number; // 0..1 hit-chance reduction for a target standing in it
  opacity: number; // LOS accumulates this per tile crossed; >= 1 blocks
  passable: boolean;
}

export const TERRAIN = {
  grass: { color: '#4e6b3f', moveCost: 1, cover: 0, opacity: 0, passable: true },
  road: { color: '#8a8172', moveCost: 0.85, cover: 0, opacity: 0, passable: true },
  woods: { color: '#31482b', moveCost: 1.6, cover: 0.3, opacity: 0.35, passable: true },
  floor: { color: '#a0917a', moveCost: 1, cover: 0, opacity: 0, passable: true },
  hedge: { color: '#2f4a28', moveCost: 1.8, cover: 0.35, opacity: 0.5, passable: true },
  field: { color: '#6a7245', moveCost: 1.1, cover: 0.05, opacity: 0, passable: true },
} satisfies Record<string, TerrainDef>;

export type TerrainKey = keyof typeof TERRAIN;

export type AmmoKey = 'clip_3006' | 'mag_bar' | 'belt_3006' | 'belt_792' | 'clip_792'
  | 'mag_mp40' | 'mag_thompson' | 'rocket_bazooka' | 'rocket_schreck' | 'faust'
  | 'shell_60' | 'shell_81' | 'mag_carbine' | 'clip_springfield' | 'shell_57' | 'shell_75';

export interface WeaponDef {
  name: string;
  range: number; // meters
  accuracy: number; // base hit chance at point blank
  damage: [number, number];
  cooldown: number; // seconds between attacks
  suppression: number; // suppression applied near each shot's impact
  pen?: number; // armor penetration (mm-ish); presence marks an AT weapon
  ammo: { type: AmmoKey; perUnit: number; reload: number }; // reload seconds
  heat?: { perShot: number; swapTime: number }; // belt-fed barrel model
  arc?: { minRange: number; scatter: number; scatterNoLos: number }; // mortars
  oneShot?: boolean; // consume item, revert to secondary
}

export const WEAPONS = {
  garand:     { name: 'M1 Garand', range: 100, accuracy: 0.35, damage: [35, 80], cooldown: 1.6, suppression: 0.05, ammo: { type: 'clip_3006', perUnit: 8, reload: 2.5 } },
  carbine:    { name: 'M1 Carbine', range: 70, accuracy: 0.35, damage: [28, 65], cooldown: 1.4, suppression: 0.04, ammo: { type: 'mag_carbine', perUnit: 15, reload: 3 } },
  thompson:   { name: 'Thompson', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05, ammo: { type: 'mag_thompson', perUnit: 30, reload: 3.5 } },
  bar:        { name: 'BAR', range: 110, accuracy: 0.38, damage: [30, 70], cooldown: 1.2, suppression: 0.1, ammo: { type: 'mag_bar', perUnit: 20, reload: 4 } },
  m1919:      { name: 'M1919A4', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 2.4, suppression: 0.16, ammo: { type: 'belt_3006', perUnit: 250, reload: 8 }, heat: { perShot: 0.02, swapTime: 10 } },
  springfield:{ name: 'M1903A4', range: 200, accuracy: 0.55, damage: [40, 85], cooldown: 4, suppression: 0.04, ammo: { type: 'clip_springfield', perUnit: 5, reload: 4 } },
  kar98k:     { name: 'Kar98k', range: 110, accuracy: 0.38, damage: [40, 85], cooldown: 2.6, suppression: 0.05, ammo: { type: 'clip_792', perUnit: 5, reload: 3 } },
  kar98k_scoped:{ name: 'Kar98k (scoped)', range: 200, accuracy: 0.55, damage: [40, 85], cooldown: 4, suppression: 0.04, ammo: { type: 'clip_792', perUnit: 5, reload: 4 } },
  mp40:       { name: 'MP40', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05, ammo: { type: 'mag_mp40', perUnit: 32, reload: 3.5 } },
  mg42:       { name: 'MG42', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 1.8, suppression: 0.22, ammo: { type: 'belt_792', perUnit: 250, reload: 7 }, heat: { perShot: 0.04, swapTime: 8 } },
  bazooka:    { name: 'Bazooka', range: 70, accuracy: 0.35, damage: [30, 70], cooldown: 7, suppression: 0.1, pen: 100, ammo: { type: 'rocket_bazooka', perUnit: 1, reload: 7 } },
  schreck:    { name: 'Panzerschreck', range: 90, accuracy: 0.4, damage: [30, 70], cooldown: 8, suppression: 0.1, pen: 160, ammo: { type: 'rocket_schreck', perUnit: 1, reload: 8 } },
  panzerfaust:{ name: 'Panzerfaust', range: 35, accuracy: 0.5, damage: [30, 70], cooldown: 9, suppression: 0.1, pen: 150, ammo: { type: 'faust', perUnit: 1, reload: 0 }, oneShot: true },
  mortar60:   { name: 'M2 60mm', range: 180, accuracy: 0.5, damage: [25, 75], cooldown: 4, suppression: 0.12, ammo: { type: 'shell_60', perUnit: 1, reload: 4 }, arc: { minRange: 20, scatter: 4, scatterNoLos: 9 } },
  mortar81:   { name: 'GrW 34 8cm', range: 240, accuracy: 0.5, damage: [30, 85], cooldown: 6, suppression: 0.16, ammo: { type: 'shell_81', perUnit: 1, reload: 6 }, arc: { minRange: 30, scatter: 5, scatterNoLos: 10 } },
  at57_gun:   { name: 'M1 57mm', range: 140, accuracy: 0.55, damage: [40, 90], cooldown: 6, suppression: 0.12, pen: 110, ammo: { type: 'shell_57', perUnit: 1, reload: 5 } },
  pak40_gun:  { name: 'PaK 40 7.5cm', range: 160, accuracy: 0.6, damage: [45, 95], cooldown: 6, suppression: 0.14, pen: 150, ammo: { type: 'shell_75', perUnit: 1, reload: 5 } },
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
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 8 } },
      { role: 'rifleman', weapon: 'garand', ammo: { clip_3006: 18 } }, // grenadier stand-in: 10 extra clips, no grenades this milestone
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
      { role: 'rifleman', weapon: 'kar98k', ammo: { clip_792: 8 } },
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
