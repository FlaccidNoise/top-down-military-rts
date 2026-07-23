import type { Side } from '../sim/sim';
import { cellIndex, cellXY, type SectorMap } from './sector';
import { Front, dijkstra, pathFromTree, type Chit, type Dijkstra } from './front';

// Per-side strategic doctrine. All values are tuning knobs — the commander
// itself is a pure function of front state with no rng.
export interface Doctrine {
  evalMinutes: number; // eval cadence
  attackRatio: number; // commit attack when my strength >= ratio * defender
  outmatchedRatio: number; // withdraw when adjacent enemy > ratio * mine
  counterRatio: number; // counterattack adjacent enemy < ratio * mine
  screenRadiusMin: number; // ford-screen reaction range in path-minutes
  shatterStrength: number; // withdraw below this strength
}

export const RED_DEFENDER: Doctrine = {
  evalMinutes: 60,
  attackRatio: 0, // unused
  outmatchedRatio: 2.0,
  counterRatio: 0.6,
  screenRadiusMin: 240,
  shatterStrength: 0,
};

export const BLUE_ATTACKER: Doctrine = {
  evalMinutes: 60,
  attackRatio: 1.0,
  outmatchedRatio: 0, // unused
  counterRatio: 0, // unused
  screenRadiusMin: 0, // unused
  shatterStrength: 30,
};

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function manhattan(sector: SectorMap, a: number, b: number): number {
  const pa = cellXY(sector, a);
  const pb = cellXY(sector, b);
  return Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
}

// A bank cell is a non-river cell adjacent to at least one river cell.
function isBankCell(sector: SectorMap, cell: number): boolean {
  if (sector.cells[cell].terrain === 'river') return false;
  const { x, y } = cellXY(sector, cell);
  for (const [dx, dy] of DIRS) {
    const nx = x + dx,
      ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= sector.w || ny >= sector.h) continue;
    if (sector.cells[cellIndex(sector, nx, ny)].terrain === 'river') return true;
  }
  return false;
}

// pressure(cell) = Σ enemy strength / (1 + eta_minutes / 60). Eta comes from
// one all-cells Dijkstra per enemy chit per tick (see StrategicCommander).
function computePressure(front: Front, cell: number, enemySide: Side, treeCache: Map<number, Dijkstra>): number {
  let p = 0;
  for (const enemy of front.chits) {
    if (enemy.side !== enemySide || enemy.strength <= 0) continue;
    let tree = treeCache.get(enemy.id);
    if (!tree) {
      tree = dijkstra(front.sector, enemy.cell);
      treeCache.set(enemy.id, tree);
    }
    const eta = tree.dist[cell];
    if (!isFinite(eta)) continue;
    p += enemy.strength / (1 + eta / 60);
  }
  return p;
}

export class StrategicCommander {
  private lastEvalMin = -Infinity;
  // Per-tick Dijkstra cache: one all-cells search per chit instead of one
  // per (cell, chit) pair. Cleared on every evaluate tick.
  private treeCache = new Map<number, Dijkstra>();

  private tree(front: Front, from: number): Dijkstra {
    let t = this.treeCache.get(from);
    if (!t) {
      t = dijkstra(front.sector, from);
      this.treeCache.set(from, t);
    }
    return t;
  }

  constructor(
    readonly side: Side,
    readonly doctrine: Doctrine,
  ) {}

  // Called every strategic minute by the caller; evaluates only when
  // front.clockMin crosses the next evalMinutes boundary.
  evaluate(front: Front): void {
    if (front.clockMin - this.lastEvalMin < this.doctrine.evalMinutes) return;
    this.lastEvalMin = front.clockMin;
    this.treeCache.clear();
    if (this.side === 'red') this.evaluateRed(front);
    else this.evaluateBlue(front);
  }

  // ---------------------------------------------------------------- red --

  private evaluateRed(front: Front): void {
    const enemySide: Side = 'blue';
    const myChits = front.chits.filter((c) => c.side === 'red' && c.strength > 0);
    const enemyChits = front.chits.filter((c) => c.side === 'blue' && c.strength > 0);
    const idle = myChits.filter((c) => c.path.length === 0);
    // Garrisons on objective cells hold their post: never withdrawn, never
    // pulled into ford screens or repositioning, never drawn off by a
    // counterattack. Mobile chits (Reserve, town/bridge garrisons off
    // objectives) do all maneuver.
    const holds = (chit: Chit) => front.sector.cells[chit.cell].objective;
    const mobile = idle.filter((c) => !holds(c));
    const reserve = myChits.find((c) => c.name === 'Reserve');
    const ordered = new Set<number>();

    // Chits already screening a ford (path destination is a bank cell)
    const screening = new Set<number>();
    const screenedBanks = new Set<number>();
    for (const chit of myChits) {
      if (chit.path.length === 0) continue;
      const dest = chit.path[chit.path.length - 1];
      if (isBankCell(front.sector, dest)) {
        screening.add(chit.id);
        screenedBanks.add(dest);
      }
    }

    // ── 1. WITHDRAW ────────────────────────────────────────────────────
    for (const chit of mobile) {
      if (ordered.has(chit.id) || screening.has(chit.id)) continue;
      const adjStr = this.adjacentEnemyStrength(front, chit, enemySide);
      if (adjStr > this.doctrine.outmatchedRatio * chit.strength) {
        const dest = this.findWithdrawDest(front, chit, enemyChits);
        if (dest >= 0) {
          front.orderMove(chit.id, dest);
          ordered.add(chit.id);
        }
      }
    }

    // ── 2. SCREEN FORDS ───────────────────────────────────────────────
    const claimedThisEval = new Set<number>();
    for (const enemy of enemyChits) {
      const fords = this.findScreenableFords(front, enemy);
      for (const { bankCell, time } of fords) {
        if (time > this.doctrine.screenRadiusMin) continue;
        if (screenedBanks.has(bankCell) || claimedThisEval.has(bankCell)) continue;

        let best: Chit | null = null;
        let bestDist = Infinity;
        for (const chit of mobile) {
          if (ordered.has(chit.id) || screening.has(chit.id)) continue;
          const isRes = reserve !== undefined && chit.id === reserve.id;
          const dist = manhattan(front.sector, chit.cell, bankCell) + (isRes ? 10000 : 0);
          if (dist < bestDist) {
            bestDist = dist;
            best = chit;
          }
        }
        if (!best && reserve && reserve.path.length === 0 && !screening.has(reserve.id) && !ordered.has(reserve.id)) {
          best = reserve;
        }
        if (best) {
          if (front.orderMove(best.id, bankCell)) {
            ordered.add(best.id);
            screening.add(best.id);
            claimedThisEval.add(bankCell);
          }
        }
      }
    }

    // ── 3. REPOSITION ─────────────────────────────────────────────────
    let maxP = 0;
    let maxCell = -1;
    for (let i = 0; i < front.sector.cells.length; i++) {
      const cell = front.sector.cells[i];
      if (cell.owner !== 'red' || cell.terrain === 'river') continue;
      const hasChit = front.chitAt(i, 'red');
      if (!hasChit && !cell.objective) continue;
      const p = computePressure(front, i, enemySide, this.treeCache);
      const defStr = hasChit ? hasChit.strength : 0;
      if (defStr < p && p > maxP) {
        maxP = p;
        maxCell = i;
      }
    }
    if (maxCell >= 0) {
      let best: Chit | null = null;
      let bestDist = Infinity;
      for (const chit of mobile) {
        if (ordered.has(chit.id) || screening.has(chit.id)) continue;
        if (reserve && chit.id === reserve.id) continue;
        const dist = manhattan(front.sector, chit.cell, maxCell);
        if (dist < bestDist) {
          bestDist = dist;
          best = chit;
        }
      }
      if (best) {
        const garrison = front.chitAt(maxCell, 'red');
        if (!garrison) {
          if (front.orderMove(best.id, maxCell)) ordered.add(best.id);
        } else {
          const adj = this.findAdjacentFreeRedCell(front, maxCell);
          if (adj >= 0 && front.orderMove(best.id, adj)) ordered.add(best.id);
        }
      }
    }

    // ── 4. COMMIT RESERVE ─────────────────────────────────────────────
    if (reserve && reserve.path.length === 0 && !screening.has(reserve.id) && !ordered.has(reserve.id)) {
      let bestP = 0;
      let bestCell = -1;
      for (let i = 0; i < front.sector.cells.length; i++) {
        const cell = front.sector.cells[i];
        if (cell.owner !== 'red') continue;
        if (!cell.objective && cell.terrain !== 'bridge') continue;
        const gar = front.chitAt(i, 'red');
        const garStr = gar ? gar.strength : 0;
        const p = computePressure(front, i, enemySide, this.treeCache);
        if (p > 1.2 * Math.max(garStr, 0) && p > bestP) {
          bestP = p;
          bestCell = i;
        }
      }
      if (bestCell >= 0) {
        const gar = front.chitAt(bestCell, 'red');
        if (!gar) {
          front.orderMove(reserve.id, bestCell);
        } else {
          const adj = this.findAdjacentFreeRedCell(front, bestCell);
          if (adj >= 0) front.orderMove(reserve.id, adj);
        }
      }
    }

    // ── 5. COUNTERATTACK ──────────────────────────────────────────────
    for (const chit of mobile) {
      if (ordered.has(chit.id) || screening.has(chit.id)) continue;
      const { x, y } = cellXY(front.sector, chit.cell);
      for (const [dx, dy] of DIRS) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
        const ci = cellIndex(front.sector, nx, ny);
        // Counterattack into ANY adjacent cell — including blue-owned ground
        // (retaking lost objectives is the point of a counterattack).
        const enemy = front.chitAt(ci, enemySide);
        if (!enemy) continue;
        if (enemy.strength < this.doctrine.counterRatio * chit.strength) {
          front.orderMove(chit.id, ci);
          ordered.add(chit.id);
          break;
        }
      }
    }
  }

  // --------------------------------------------------------------- blue --

  private evaluateBlue(front: Front): void {
    const enemySide: Side = 'red';
    const myChits = front.chits.filter((c) => c.side === 'blue' && c.strength > 0);
    const idle = myChits.filter((c) => c.path.length === 0);
    const ordered = new Set<number>();

    // ── 1. WITHDRAW SHATTERED ─────────────────────────────────────────
    for (const chit of idle) {
      if (ordered.has(chit.id)) continue;
      if (chit.strength < this.doctrine.shatterStrength) {
        const dest = this.findRearCell(front, chit);
        if (dest >= 0) {
          front.orderMove(chit.id, dest);
          ordered.add(chit.id);
        }
      }
    }

    // ── 2. ATTACK / CONCENTRATE ───────────────────────────────────────
    let target = -1;
    let targetDefStr = Infinity;
    for (let i = 0; i < front.sector.cells.length; i++) {
      const cell = front.sector.cells[i];
      if (!cell.objective || cell.owner === 'blue') continue;
      const def = front.chitAt(i, enemySide);
      const ds = def ? def.strength : 0;
      if (ds < targetDefStr || (ds === targetDefStr && (target < 0 || i < target))) {
        target = i;
        targetDefStr = ds;
      }
    }
    if (target < 0) return;

    const targetDefender = front.chitAt(target, enemySide);
    const defStr = targetDefender ? targetDefender.strength : 0;
    const sorted = [...idle].sort((a, b) => b.strength - a.strength || a.id - b.id);

    for (const chit of sorted) {
      if (ordered.has(chit.id)) continue;
      if (chit.strength >= this.doctrine.attackRatio * Math.max(1, defStr)) {
        front.orderMove(chit.id, target);
        ordered.add(chit.id);
      } else {
        // Stage adjacent, then check ford exploit
        const staging = this.findStagingCell(front, chit, target);
        let didFord = false;
        if (defStr > chit.strength * this.doctrine.attackRatio) {
          const ford = this.findFordExploit(front, chit);
          if (ford >= 0) {
            front.orderMove(chit.id, ford);
            ordered.add(chit.id);
            didFord = true;
          }
        }
        if (!didFord && staging >= 0) {
          front.orderMove(chit.id, staging);
          ordered.add(chit.id);
        }
      }
    }
  }

  // ------------------------------------------------------------ helpers --

  private adjacentEnemyStrength(front: Front, chit: Chit, enemySide: Side): number {
    const { x, y } = cellXY(front.sector, chit.cell);
    let total = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
      const enemy = front.chitAt(cellIndex(front.sector, nx, ny), enemySide);
      if (enemy) total += enemy.strength;
    }
    return total;
  }

  private findWithdrawDest(front: Front, chit: Chit, enemyChits: Chit[]): number {
    let best = -1;
    let bestMinDist = -1;
    let bestX = -1;
    const tree = this.tree(front, chit.cell);
    for (let i = 0; i < front.sector.cells.length; i++) {
      const cell = front.sector.cells[i];
      if (cell.owner !== 'red' || cell.terrain === 'river') continue;
      if (front.chitAt(i)) continue;
      if (!isFinite(tree.dist[i])) continue;
      let minDist = Infinity;
      for (const enemy of enemyChits) {
        const d = manhattan(front.sector, i, enemy.cell);
        if (d < minDist) minDist = d;
      }
      const { x } = cellXY(front.sector, i);
      if (minDist > bestMinDist || (minDist === bestMinDist && x > bestX)) {
        bestMinDist = minDist;
        bestX = x;
        best = i;
      }
    }
    return best;
  }

  private findScreenableFords(front: Front, enemy: Chit): { riverCell: number; bankCell: number; time: number }[] {
    const results: { riverCell: number; bankCell: number; time: number }[] = [];
    const tree = this.tree(front, enemy.cell);
    for (let i = 0; i < front.sector.cells.length; i++) {
      if (front.sector.cells[i].terrain !== 'river') continue;
      const { x, y } = cellXY(front.sector, i);
      for (const [dx, dy] of DIRS) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
        const bi = cellIndex(front.sector, nx, ny);
        const bc = front.sector.cells[bi];
        if (bc.terrain === 'river' || bc.owner !== 'red') continue;
        if (front.chitAt(bi, 'red')) continue;
        const time = tree.dist[i];
        if (isFinite(time)) results.push({ riverCell: i, bankCell: bi, time });
      }
    }
    return results;
  }

  private findAdjacentFreeRedCell(front: Front, cellIdx: number): number {
    const { x, y } = cellXY(front.sector, cellIdx);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
      const idx = cellIndex(front.sector, nx, ny);
      const cell = front.sector.cells[idx];
      if (cell.owner !== 'red' || cell.terrain === 'river') continue;
      if (front.chitAt(idx)) continue;
      return idx;
    }
    return -1;
  }

  private findRearCell(front: Front, chit: Chit): number {
    let best = -1;
    let bestMinDist = -1;
    const tree = this.tree(front, chit.cell);
    for (let i = 0; i < front.sector.cells.length; i++) {
      const cell = front.sector.cells[i];
      if (cell.owner !== 'blue' || cell.terrain === 'river') continue;
      if (front.chitAt(i)) continue;
      if (!isFinite(tree.dist[i])) continue;
      let minDist = Infinity;
      for (const red of front.chits) {
        if (red.side !== 'red' || red.strength <= 0) continue;
        const d = manhattan(front.sector, i, red.cell);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = i;
      }
    }
    return best;
  }

  private findStagingCell(front: Front, chit: Chit, target: number): number {
    const { x, y } = cellXY(front.sector, target);
    let best = -1;
    let bestDist = Infinity;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
      const idx = cellIndex(front.sector, nx, ny);
      const cell = front.sector.cells[idx];
      if (cell.terrain === 'river') continue;
      if (front.chitAt(idx)) continue;
      const dist = manhattan(front.sector, chit.cell, idx);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    }
    return best;
  }

  // Find a red-free non-river cell on the far bank, reachable only via a
  // river cell on the path. Generic: inspects findPath output, no hardcoded
  // coordinates.
  private findFordExploit(front: Front, chit: Chit): number {
    const tree = this.tree(front, chit.cell);
    for (let i = 0; i < front.sector.cells.length; i++) {
      const cell = front.sector.cells[i];
      if (cell.terrain === 'river') continue;
      if (front.chitAt(i, 'red')) continue;
      const path = pathFromTree(tree, chit.cell, i);
      if (path === null || path.length === 0) continue;
      if (!path.some((c) => front.sector.cells[c].terrain === 'river')) continue;
      return i;
    }
    return -1;
  }
}
