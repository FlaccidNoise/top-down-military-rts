import type { Side } from '../sim/sim';

export type CellTerrain = 'open' | 'woods' | 'town' | 'river' | 'bridge' | 'road';

export interface Cell {
  terrain: CellTerrain;
  owner: Side | null; // null = neutral (river)
  objective: boolean;
}

export interface SectorMap {
  w: number;
  h: number;
  name: string;
  cells: Cell[];
}

const CHAR_TERRAIN: Record<string, CellTerrain> = {
  '.': 'open',
  w: 'woods',
  t: 'town',
  T: 'town', // objective town
  '~': 'river',
  '=': 'bridge',
  r: 'road',
};

// Minutes for a company column to cross one 500 m cell.
export const CELL_MINUTES: Record<CellTerrain, number> = {
  road: 10,
  bridge: 12,
  open: 15,
  town: 15,
  woods: 30,
  river: Infinity,
};

export function parseSector(rows: string[], frontX: number, name: string): SectorMap {
  const h = rows.length;
  const w = rows[0].length;
  const cells: Cell[] = [];
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`sector row ${y} has length ${rows[y].length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const terrain = CHAR_TERRAIN[ch];
      if (!terrain) throw new Error(`unknown sector char '${ch}' at ${x},${y}`);
      cells.push({
        terrain,
        owner: terrain === 'river' ? null : x < frontX ? 'blue' : 'red',
        objective: ch === 'T',
      });
    }
  }
  return { w, h, name, cells };
}

export const cellIndex = (s: SectorMap, x: number, y: number): number => y * s.w + x;
export const cellXY = (s: SectorMap, i: number): { x: number; y: number } => ({ x: i % s.w, y: Math.floor(i / s.w) });

// The Vireux sector: a river line with two garrisoned bridges, the objective
// town of St-Aubin beyond the southern crossing. 40×30 cells = 20×15 km.
// Placeholder-quality art — replace rows freely, the parser is the contract.
const DEFAULT_ROWS = [
  '....................~...................',
  '....................~...................',
  '...wwwwww...........~..wwwww............',
  '...wwwwww...........~..wwwww............',
  '...wwwwww...........~..wwwww............',
  '...wwwwww...........~..wwwww............',
  '....................~........ttt........',
  'rrrrrrrrrrrrrrrrrrrr=rrrrrrrrtttrrrrrrrr',
  '....................~........ttt........',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...TTT.............',
  'rrrrrrrrrrrrrrrrrrrr=rrrTTTrrrrrrrrrrrrr',
  '....................~...TTT.............',
  '....................~...................',
  '....................~...................',
  '....................~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
];

export function makeDefaultSector(): SectorMap {
  return parseSector(DEFAULT_ROWS, 20, 'Vireux sector');
}
