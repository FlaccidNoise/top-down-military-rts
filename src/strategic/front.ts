import type { Side } from '../sim/sim';
import { CELL_MINUTES, cellIndex, cellXY, type SectorMap } from './sector';

export interface Chit {
  id: number;
  side: Side;
  name: string;
  cell: number; // sector cell index
  path: number[]; // remaining cells to enter, front-to-back
  progress: number; // minutes walked toward path[0]
  strength: number; // effectives. blue: synced from roster; red: attrition counter
  companyIndex: number; // blue: index into campaign.companies; red: -1
}

export interface Engagement {
  attackerId: number;
  defenderId: number;
  cell: number; // the contested (defender's) cell
}

export interface FrontSave {
  clockMin: number;
  nextChitId: number;
  owners: (Side | null)[];
  chits: Chit[];
}

export const OP_START_MIN = 6 * 60; // day 1, 06:00
export const OP_DEADLINE_DAYS = 14;

// Replacements arrive in batches rather than a silent daily top-up: every
// REINFORCE_CYCLE_DAYS, each company receives up to REINFORCE_PER_COMPANY men.
export const REINFORCE_CYCLE_DAYS = 2;
export const REINFORCE_PER_COMPANY = 12;

export function formatClock(min: number): { day: number; hhmm: string } {
  const day = Math.floor(min / 1440) + 1;
  const m = min % 1440;
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
  return { day, hhmm };
}

// Minutes remaining until the chit finishes its ordered path: the unwalked
// portion of the current leg plus the full cost of every leg after it. 0 if
// idle. Pure display arithmetic — mirrors the terrain costs step() consumes.
export function chitEtaMinutes(front: Front, chit: Chit): number {
  if (chit.path.length === 0) return 0;
  let total = CELL_MINUTES[front.sector.cells[chit.path[0]].terrain] - chit.progress;
  for (let i = 1; i < chit.path.length; i++) {
    total += CELL_MINUTES[front.sector.cells[chit.path[i]].terrain];
  }
  return Math.max(0, total);
}

// Minutes until the next reinforcement cycle boundary (midnight starting the
// next day divisible by REINFORCE_CYCLE_DAYS). Reinforcements for the current
// day, if it's a cycle day, have already arrived at the moment it began.
export function minutesToReinforcement(front: Front): number {
  const day = front.day;
  const nextDay = day + (REINFORCE_CYCLE_DAYS - (day % REINFORCE_CYCLE_DAYS));
  return (nextDay - 1) * 1440 - front.clockMin;
}

export class Front {
  clockMin = OP_START_MIN;
  chits: Chit[] = [];
  nextChitId = 1;

  constructor(readonly sector: SectorMap) {}

  get day(): number {
    return formatClock(this.clockMin).day;
  }

  get hhmm(): string {
    return formatClock(this.clockMin).hhmm;
  }

  addChit(init: Omit<Chit, 'id' | 'path' | 'progress'>): Chit {
    const chit: Chit = { ...init, id: this.nextChitId++, path: [], progress: 0 };
    this.chits.push(chit);
    return chit;
  }

  chitAt(cell: number, side?: Side): Chit | undefined {
    return this.chits.find((c) => c.cell === cell && c.strength > 0 && (side === undefined || c.side === side));
  }

  orderMove(chitId: number, dest: number): boolean {
    const chit = this.chits.find((c) => c.id === chitId);
    if (!chit) return false;
    // Rivers are assault crossings: valid transit, never a destination — a
    // company doesn't hold 500 m of open water.
    if (this.sector.cells[dest].terrain === 'river') return false;
    const path = findPath(this.sector, chit.cell, dest);
    if (path === null) return false;
    chit.path = path;
    chit.progress = 0;
    return true;
  }

  // Advance one strategic minute. Returns an engagement if a moving chit
  // finished its approach into a cell held by an enemy chit; the mover halts
  // in its current cell (assault positions) and the engagement is the caller's
  // to resolve. Entering an empty cell captures it.
  step(): Engagement | null {
    this.clockMin++;
    for (const chit of this.chits) {
      if (chit.path.length === 0 || chit.strength <= 0) continue;
      const nextCell = chit.path[0];
      chit.progress++;
      if (chit.progress < CELL_MINUTES[this.sector.cells[nextCell].terrain]) continue;
      const enemy = this.chitAt(nextCell, chit.side === 'blue' ? 'red' : 'blue');
      if (enemy) {
        chit.path = [];
        chit.progress = 0;
        return { attackerId: chit.id, defenderId: enemy.id, cell: nextCell };
      }
      chit.cell = nextCell;
      chit.path.shift();
      chit.progress = 0;
      this.sector.cells[nextCell].owner = chit.side;
    }
    return null;
  }

  save(): FrontSave {
    return {
      clockMin: this.clockMin,
      nextChitId: this.nextChitId,
      owners: this.sector.cells.map((c) => c.owner),
      chits: structuredClone(this.chits),
    };
  }

  static restore(sector: SectorMap, s: FrontSave): Front {
    const f = new Front(sector);
    f.clockMin = s.clockMin;
    f.nextChitId = s.nextChitId;
    s.owners.forEach((o, i) => (sector.cells[i].owner = o));
    f.chits = structuredClone(s.chits);
    return f;
  }
}

export interface Dijkstra {
  dist: Float64Array;
  prev: Int32Array;
}

// Dijkstra over 4-neighbors weighted by CELL_MINUTES from `from` to EVERY
// cell. Batch counterpart of findPath for callers that need times/paths to
// many cells (e.g. pressure maps, destination scans).
export function dijkstra(sector: SectorMap, from: number): Dijkstra {
  const n = sector.cells.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) break;
    visited[u] = 1;
    const { x, y } = cellXY(sector, u);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= sector.w || ny >= sector.h) continue;
      const v = cellIndex(sector, nx, ny);
      const cost = CELL_MINUTES[sector.cells[v].terrain];
      if (!isFinite(cost)) continue;
      if (dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        prev[v] = u;
      }
    }
  }
  return { dist, prev };
}

export function allPathTimes(sector: SectorMap, from: number): Float64Array {
  return dijkstra(sector, from).dist;
}

// Path reconstruction on a precomputed Dijkstra tree: same output contract
// as findPath (sequence excluding `from`, [] if equal, null if unreachable).
export function pathFromTree(tree: Dijkstra, from: number, to: number): number[] | null {
  if (from === to) return [];
  if (!isFinite(tree.dist[to])) return null;
  const path: number[] = [];
  for (let v = to; v !== from; v = tree.prev[v]) path.unshift(v);
  return path;
}

// Dijkstra over 4-neighbors weighted by CELL_MINUTES. Ignores chits: paths may
// run through enemy-held cells — contact triggers there during step(). Returns
// the cell sequence excluding `from`, [] if from === to, null if unreachable.
export function findPath(sector: SectorMap, from: number, to: number): number[] | null {
  if (from === to) return [];
  const n = sector.cells.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) return null;
    if (u === to) break;
    visited[u] = 1;
    const { x, y } = cellXY(sector, u);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= sector.w || ny >= sector.h) continue;
      const v = cellIndex(sector, nx, ny);
      const cost = CELL_MINUTES[sector.cells[v].terrain];
      if (!isFinite(cost)) continue;
      if (dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        prev[v] = u;
      }
    }
  }
  const path: number[] = [];
  for (let v = to; v !== from; v = prev[v]) path.unshift(v);
  return path;
}

export function operationStatus(front: Front): 'ongoing' | 'won' | 'lost' {
  const objectives = front.sector.cells.filter((c) => c.objective);
  if (objectives.length > 0 && objectives.every((c) => c.owner === 'blue')) return 'won';
  const anyBlue = front.chits.some((c) => c.side === 'blue' && c.strength > 0);
  if (!anyBlue || front.day > OP_DEADLINE_DAYS) return 'lost';
  return 'ongoing';
}
