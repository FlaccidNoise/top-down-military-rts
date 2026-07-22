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
} satisfies Record<string, TerrainDef>;

export type TerrainKey = keyof typeof TERRAIN;

export type AmmoKey = 'clip_3006' | 'mag_bar' | 'belt_3006' | 'belt_792' | 'clip_792'
  | 'mag_mp40' | 'mag_thompson' | 'rocket_bazooka' | 'rocket_schreck' | 'faust'
  | 'shell_60' | 'shell_81' | 'mag_carbine' | 'clip_springfield';

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
} satisfies Record<string, WeaponDef>;
export type WeaponKey = keyof typeof WEAPONS;

export interface VehicleDef {
  name: string;
  speed: number; // m/s
  armor: { front: number; side: number; rear: number };
  gunPen: number;
  gunAccuracy: number;
  gunRange: number;
  gunCooldown: number;
  mgRange: number;
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
  },
} satisfies Record<string, VehicleDef>;

export type VehicleKey = keyof typeof VEHICLES;

export const US_NAMES = ['Miller', 'Kowalski', 'Reyes', 'Sullivan', 'Baker', 'Carter', 'Nowak', 'Greco', 'Hayes', 'Dawson', 'Olsen', 'Freeman', 'Marsh', 'Quinn', 'Boone', 'Vance', 'Kirby', 'Slater', 'Doyle', 'Webb'];
export const DE_NAMES = ['Müller', 'Schneider', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Koch', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Braun', 'Krüger', 'Hofmann', 'Lange', 'Schmitt', 'Werner', 'Krause'];
