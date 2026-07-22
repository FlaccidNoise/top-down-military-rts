import { WEAPONS, type WeaponKey } from './data';
import { GameMap, los } from './map';
import { astar } from './path';
import { mulberry32, type Rng } from './rng';

export const DT = 1 / 30; // fixed timestep, seconds
const BASE_SPEED = 2; // m/s
const RETARGET_TICKS = 30;

export type Side = 'blue' | 'red';

export interface Soldier {
  id: number;
  side: Side;
  squadId: number;
  name: string;
  weapon: WeaponKey;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  path: { x: number; y: number }[] | null;
  pathI: number;
  cooldown: number;
  targetId: number; // -1 = none
}

export interface Squad {
  id: number;
  side: Side;
  name: string;
  soldierIds: number[];
}

export interface ShotEvent {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  hit: boolean;
  kill: boolean;
}

// Formation offsets around a squad destination, meters.
const OFFSETS = [
  [0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
  [2.2, 1.5], [-2.2, 1.5], [2.2, -1.5], [-2.2, -1.5], [0, 3],
];

export class Sim {
  tick = 0;
  rng: Rng;
  soldiers: Soldier[] = [];
  squads: Squad[] = [];
  winner: Side | null = null;
  private pendingEvents: ShotEvent[] = [];

  constructor(readonly map: GameMap, seed: number) {
    this.rng = mulberry32(seed);
  }

  addSquad(side: Side, name: string, members: { name: string; weapon: WeaponKey; x: number; y: number }[]): Squad {
    const squad: Squad = { id: this.squads.length, side, name, soldierIds: [] };
    for (const m of members) {
      const s: Soldier = {
        id: this.soldiers.length,
        side,
        squadId: squad.id,
        name: m.name,
        weapon: m.weapon,
        x: m.x,
        y: m.y,
        hp: 100,
        alive: true,
        path: null,
        pathI: 0,
        cooldown: 0,
        targetId: -1,
      };
      this.soldiers.push(s);
      squad.soldierIds.push(s.id);
    }
    this.squads.push(squad);
    return squad;
  }

  orderMove(squadId: number, wx: number, wy: number): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    const used = new Set<number>();
    let slot = 0;
    for (const sid of squad.soldierIds) {
      const s = this.soldiers[sid];
      if (!s.alive) continue;
      const [ox, oy] = OFFSETS[slot % OFFSETS.length];
      slot++;
      const spot = this.findSpot(Math.floor(wx + ox), Math.floor(wy + oy), used);
      if (!spot) continue;
      used.add(spot.y * this.map.w + spot.x);
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y);
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
      }
    }
  }

  private findSpot(x: number, y: number, used: Set<number>): { x: number; y: number } | null {
    for (let r = 0; r <= 5; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.map.inBounds(nx, ny) || !this.map.terrainAt(nx, ny).passable) continue;
          if (used.has(ny * this.map.w + nx)) continue;
          return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  takeEvents(): ShotEvent[] {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  step(): void {
    this.tick++;
    for (const s of this.soldiers) {
      if (s.alive) this.updateSoldier(s);
    }
    let blue = 0;
    let red = 0;
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      if (s.side === 'blue') blue++;
      else red++;
    }
    if (this.winner === null) {
      if (blue === 0 && red > 0) this.winner = 'red';
      else if (red === 0 && blue > 0) this.winner = 'blue';
    }
  }

  private updateSoldier(s: Soldier): void {
    if (s.path) {
      const cost = this.map.terrainAt(Math.floor(s.x), Math.floor(s.y)).moveCost;
      let remaining = (BASE_SPEED / cost) * DT;
      while (remaining > 0 && s.path) {
        const wp = s.path[s.pathI];
        const dx = wp.x - s.x;
        const dy = wp.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d <= remaining) {
          s.x = wp.x;
          s.y = wp.y;
          remaining -= d;
          s.pathI++;
          if (s.pathI >= s.path.length) {
            s.path = null;
            s.pathI = 0;
          }
        } else {
          s.x += (dx / d) * remaining;
          s.y += (dy / d) * remaining;
          remaining = 0;
        }
      }
    }

    if (s.cooldown > 0) s.cooldown -= DT;

    const w = WEAPONS[s.weapon];
    const t = s.targetId >= 0 ? this.soldiers[s.targetId] : null;
    const targetInvalid = !t || !t.alive || Math.hypot(t.x - s.x, t.y - s.y) > w.range;
    if (targetInvalid || (this.tick + s.id) % RETARGET_TICKS === 0) {
      s.targetId = this.acquire(s);
    }
    if (s.targetId >= 0 && s.cooldown <= 0) {
      this.fire(s, this.soldiers[s.targetId]);
    }
  }

  private acquire(s: Soldier): number {
    const w = WEAPONS[s.weapon];
    let best = -1;
    let bestD = Infinity;
    const candidates: { id: number; d: number }[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.side === s.side) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d <= w.range) candidates.push({ id: e.id, d });
    }
    candidates.sort((a, b) => a.d - b.d || a.id - b.id);
    for (const c of candidates) {
      const e = this.soldiers[c.id];
      if (los(this.map, s.x, s.y, e.x, e.y).visible) {
        if (c.d < bestD) {
          best = c.id;
          bestD = c.d;
        }
        break;
      }
    }
    return best;
  }

  private fire(s: Soldier, t: Soldier): void {
    const sight = los(this.map, s.x, s.y, t.x, t.y);
    if (!sight.visible) {
      s.targetId = -1;
      return;
    }
    const w = WEAPONS[s.weapon];
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    let acc = w.accuracy * (1 - 0.75 * (d / w.range)) * (1 - sight.cover);
    if (s.path) acc *= 0.5; // shooter moving
    if (t.path) acc *= 0.75; // target moving
    acc = Math.min(0.95, Math.max(0.02, acc));
    const hit = this.rng.next() < acc;
    let kill = false;
    if (hit) {
      t.hp -= this.rng.range(w.damage[0], w.damage[1]);
      if (t.hp <= 0) {
        t.hp = 0;
        t.alive = false;
        t.path = null;
        kill = true;
      }
    }
    s.cooldown = w.cooldown * (0.85 + this.rng.next() * 0.3);
    this.pendingEvents.push({ fx: s.x, fy: s.y, tx: t.x, ty: t.y, hit, kill });
    if (kill) s.targetId = -1;
  }

  // For determinism tests: full mutable state, rounded to dodge float noise.
  snapshot(): string {
    return JSON.stringify(
      this.soldiers.map((s) => [s.id, Math.round(s.x * 1e6), Math.round(s.y * 1e6), Math.round(s.hp * 1e6), s.alive, s.targetId]),
    );
  }
}
