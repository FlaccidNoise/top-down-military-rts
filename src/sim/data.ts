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

export interface WeaponDef {
  name: string;
  range: number; // meters
  accuracy: number; // base hit chance at point blank
  damage: [number, number];
  cooldown: number; // seconds between attacks
  suppression: number; // suppression applied near each shot's impact
}

export const WEAPONS = {
  rifle: { name: 'Rifle', range: 100, accuracy: 0.35, damage: [35, 80], cooldown: 2.2, suppression: 0.06 },
  smg: { name: 'SMG', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05 },
  mg: { name: 'MG', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 2.8, suppression: 0.16 },
} satisfies Record<string, WeaponDef>;

export type WeaponKey = keyof typeof WEAPONS;

export const US_NAMES = ['Miller', 'Kowalski', 'Reyes', 'Sullivan', 'Baker', 'Carter', 'Nowak', 'Greco', 'Hayes', 'Dawson', 'Olsen', 'Freeman', 'Marsh', 'Quinn', 'Boone', 'Vance', 'Kirby', 'Slater', 'Doyle', 'Webb'];
export const DE_NAMES = ['Müller', 'Schneider', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Koch', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Braun', 'Krüger', 'Hofmann', 'Lange', 'Schmitt', 'Werner', 'Krause'];
