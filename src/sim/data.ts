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
  pen?: number; // armor penetration (mm-ish); presence marks an AT weapon
}

export const WEAPONS: Record<'rifle' | 'smg' | 'mg' | 'bazooka' | 'panzerfaust', WeaponDef> = {
  rifle: { name: 'Rifle', range: 100, accuracy: 0.35, damage: [35, 80], cooldown: 2.2, suppression: 0.06 },
  smg: { name: 'SMG', range: 50, accuracy: 0.5, damage: [25, 60], cooldown: 1.8, suppression: 0.05 },
  mg: { name: 'MG', range: 150, accuracy: 0.4, damage: [30, 70], cooldown: 2.8, suppression: 0.16 },
  bazooka: { name: 'Bazooka', range: 70, accuracy: 0.35, damage: [30, 70], cooldown: 7, suppression: 0.1, pen: 100 },
  panzerfaust: { name: 'Panzerfaust', range: 35, accuracy: 0.5, damage: [30, 70], cooldown: 9, suppression: 0.1, pen: 150 },
};

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
