import { applyHit, capacities, consciousness, freshBody, rollPart, woundLabel, type Wound } from './body';
import { WEAPONS, type WeaponKey } from './data';
import { GameMap, los } from './map';
import { astar } from './path';
import { mulberry32, type Rng } from './rng';

export const DT = 1 / 30; // fixed timestep, seconds
const BASE_SPEED = 2; // m/s
const RETARGET_TICKS = 30;
const SUPPRESS_RADIUS = 5; // m around each shot impact
const PAIN_DECAY = 0.004; // per second
const SUPP_DECAY = 0.03; // per second
const AID_SECONDS = 8;
const BARRAGE_DELAY_TICKS = 20 * 30;
const BARRAGE_ROUNDS = 12;

export type Side = 'blue' | 'red';
export type Mental = 'steady' | 'shaken' | 'pinned' | 'broken';

export interface RescueTask {
  casualtyId: number;
  phase: 'goto' | 'drag' | 'aid';
  timer: number;
}

export interface Soldier {
  id: number;
  pid: number; // campaign roster id, -1 for one-off battles
  side: Side;
  squadId: number;
  name: string;
  weapon: WeaponKey;
  courage: number; // 0..1 trait
  xp: number; // battles survived; veterancy
  x: number;
  y: number;
  alive: boolean;
  // anatomy
  body: number[]; // hp per part, indexed by PARTS
  wounds: Wound[];
  pain: number; // 0..1+, shock at 0.8
  bloodLoss: number; // 0..1, death at 1
  bleedRate: number; // blood loss per second (sum of untreated wounds)
  stabilized: boolean;
  downed: boolean; // unconscious, in shock, or can't walk
  // psyche
  suppression: number; // 0..1, fast decay
  morale: number; // 0..1, battle state
  mental: Mental;
  bonds: Record<number, number>; // battle soldier id -> 0..1
  // action
  path: { x: number; y: number }[] | null;
  pathI: number;
  cooldown: number;
  targetId: number; // -1 = none
  fleeing: boolean;
  task: RescueTask | null;
  rescuerId: number; // who claimed this casualty, -1 none
  carriedBy: number; // -1 = not being dragged
}

export interface MemberInit {
  name: string;
  weapon: WeaponKey;
  x: number;
  y: number;
  courage?: number;
  xp?: number;
  bodyDamage?: number[]; // permanent damage per part (campaign scars)
  pid?: number;
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

interface Barrage {
  side: Side;
  x: number;
  y: number;
  roundsLeft: number;
  nextTick: number;
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
  barragesLeft: Record<Side, number> = { blue: 2, red: 1 };
  private barrages: Barrage[] = [];
  private pendingEvents: ShotEvent[] = [];
  private pendingBooms: { x: number; y: number }[] = [];

  constructor(readonly map: GameMap, seed: number) {
    this.rng = mulberry32(seed);
  }

  addSquad(side: Side, name: string, members: MemberInit[]): Squad {
    const squad: Squad = { id: this.squads.length, side, name, soldierIds: [] };
    for (const m of members) {
      const body = freshBody();
      if (m.bodyDamage) for (let i = 0; i < body.length; i++) body[i] = Math.max(0, body[i] - (m.bodyDamage[i] ?? 0));
      const s: Soldier = {
        id: this.soldiers.length,
        pid: m.pid ?? -1,
        side,
        squadId: squad.id,
        name: m.name,
        weapon: m.weapon,
        courage: m.courage ?? 0.3 + this.rng.next() * 0.6,
        xp: m.xp ?? 0,
        x: m.x,
        y: m.y,
        alive: true,
        body,
        wounds: [],
        pain: 0,
        bloodLoss: 0,
        bleedRate: 0,
        stabilized: false,
        downed: false,
        suppression: 0,
        morale: 0,
        mental: 'steady',
        bonds: {},
        path: null,
        pathI: 0,
        cooldown: 0,
        targetId: -1,
        fleeing: false,
        task: null,
        rescuerId: -1,
        carriedBy: -1,
      };
      s.morale = 0.7 + s.courage * 0.3;
      this.soldiers.push(s);
      squad.soldierIds.push(s.id);
    }
    // default squad cohesion for one-off battles; campaign wiring overwrites
    for (const a of squad.soldierIds) {
      for (const b of squad.soldierIds) {
        if (a !== b) this.soldiers[a].bonds[b] = 0.25 + this.rng.next() * 0.3;
      }
    }
    this.squads.push(squad);
    return squad;
  }

  bond(a: Soldier, b: Soldier): number {
    return a.bonds[b.id] ?? 0;
  }

  // Effective aim multiplier from body + psyche + veterancy. Exposed for UI legibility.
  aimFactor(s: Soldier): number {
    const cap = capacities(s.body);
    let f = (0.4 + 0.6 * cap.manipulation) * (0.3 + 0.7 * cap.sight);
    f *= 1 - s.pain * 0.35;
    f *= 1 - s.suppression * 0.5;
    f *= 1 + Math.min(s.xp, 5) * 0.04;
    if (s.mental === 'shaken') f *= 0.8;
    if (s.mental === 'pinned') f *= 0.6;
    return f;
  }

  moveSpeed(s: Soldier): number {
    const cap = capacities(s.body);
    if (cap.moving < 0.15) return 0;
    return BASE_SPEED * (0.3 + 0.7 * cap.moving);
  }

  callBarrage(side: Side, x: number, y: number): boolean {
    if (this.barragesLeft[side] <= 0) return false;
    this.barragesLeft[side]--;
    this.barrages.push({ side, x, y, roundsLeft: BARRAGE_ROUNDS, nextTick: this.tick + BARRAGE_DELAY_TICKS });
    return true;
  }

  orderMove(squadId: number, wx: number, wy: number): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    const used = new Set<number>();
    let slot = 0;
    for (const sid of squad.soldierIds) {
      const s = this.soldiers[sid];
      if (!s.alive || s.downed || s.mental === 'broken') continue; // broken men ignore orders
      const [ox, oy] = OFFSETS[slot % OFFSETS.length];
      slot++;
      const spot = this.findSpot(Math.floor(wx + ox), Math.floor(wy + oy), used);
      if (!spot) continue;
      used.add(spot.y * this.map.w + spot.x);
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y);
      if (path && path.length > 1) {
        if (s.task) this.dropTask(s); // direct orders override a rescue
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
        s.fleeing = false;
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

  takeBooms(): { x: number; y: number }[] {
    const b = this.pendingBooms;
    this.pendingBooms = [];
    return b;
  }

  step(): void {
    this.tick++;
    this.stepBarrages();
    for (const s of this.soldiers) {
      if (s.alive) this.updateSoldier(s);
    }
    let blue = 0;
    let red = 0;
    for (const s of this.soldiers) {
      if (!s.alive || s.downed) continue;
      if (s.side === 'blue') blue++;
      else red++;
    }
    if (this.winner === null) {
      if (blue === 0 && red > 0) this.winner = 'red';
      else if (red === 0 && blue > 0) this.winner = 'blue';
    }
  }

  private stepBarrages(): void {
    for (const b of this.barrages) {
      while (b.roundsLeft > 0 && this.tick >= b.nextTick) {
        // ~normal scatter, sigma ≈ 6m
        const gauss = () => (this.rng.next() + this.rng.next() + this.rng.next() - 1.5) * 4.9;
        this.explode(b.x + gauss(), b.y + gauss());
        b.roundsLeft--;
        b.nextTick += 60 + this.rng.int(50);
      }
    }
    this.barrages = this.barrages.filter((b) => b.roundsLeft > 0);
  }

  private explode(x: number, y: number): void {
    this.pendingBooms.push({ x, y });
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > 15) continue;
      s.suppression = Math.min(1, s.suppression + 0.6 * (1 - d / 15) * (1.3 - s.courage * 0.6));
      if (d > 9) continue;
      if (!los(this.map, x, y, s.x, s.y).visible) continue; // walls stop fragments
      const frags = d < 2 ? 3 : d < 5 ? 2 : 1;
      for (let i = 0; i < frags; i++) {
        const pHit = (1 - d / 10) * (s.downed || s.mental === 'pinned' ? 0.45 : 0.8);
        if (this.rng.next() < pHit) {
          if (this.wound(s, this.rng.range(25, 75))) break;
        }
      }
    }
  }

  private updateSoldier(s: Soldier): void {
    // physiology
    if (s.wounds.length > 0) {
      s.bloodLoss = Math.min(1, s.bloodLoss + s.bleedRate * DT);
      s.pain = Math.max(0, s.pain - PAIN_DECAY * DT);
      if (s.bloodLoss >= 1) {
        this.kill(s);
        return;
      }
    }
    const cons = consciousness(s.pain, s.bloodLoss);
    const wasDowned = s.downed;
    s.downed = cons < 0.3 || s.pain >= 0.8 || capacities(s.body).moving < 0.15;
    if (s.downed) {
      if (!wasDowned) {
        s.path = null;
        s.targetId = -1;
        if (s.task) this.dropTask(s);
      }
      return; // downed men don't act (still bleed; may be dragged)
    }
    if (wasDowned && s.rescuerId >= 0) {
      const r = this.soldiers[s.rescuerId];
      if (r.task?.casualtyId === s.id) this.dropTask(r); // he's back up
    }

    // psyche: bonded mates nearby steady the nerves
    let steadying = 0;
    for (const sid of this.squads[s.squadId].soldierIds) {
      const m = this.soldiers[sid];
      if (m.id === s.id || !m.alive || m.downed) continue;
      if (Math.hypot(m.x - s.x, m.y - s.y) < 8) steadying += this.bond(s, m);
    }
    s.suppression = Math.max(0, s.suppression - SUPP_DECAY * (1 + Math.min(steadying, 1.5) * 0.6) * DT);
    if (s.suppression > 0.6) s.morale = Math.max(0, s.morale - 0.005 * DT);
    else if (s.suppression < 0.2) s.morale = Math.min(1, s.morale + 0.004 * DT);
    const pinThreshold = 0.7 - (0.5 - s.courage) * 0.2;
    s.mental =
      s.morale < 0.25 ? 'broken'
      : s.suppression > pinThreshold || (s.suppression > 0.5 && s.morale < 0.5) ? 'pinned'
      : s.suppression > 0.35 || s.morale < 0.55 ? 'shaken'
      : 'steady';

    // broken men flee away from the nearest enemy
    if (s.mental === 'broken') {
      s.targetId = -1;
      if (s.task) this.dropTask(s);
      if (!s.fleeing || (this.tick + s.id) % 90 === 0) this.flee(s);
    } else if (s.fleeing) {
      s.fleeing = false;
      s.path = null;
    }

    // rescue: a downed squadmate may pull a bonded buddy out of the fight
    if (s.task) {
      this.updateRescue(s);
      return;
    }
    if (s.mental !== 'broken' && (this.tick + s.id) % 60 === 0) this.considerRescue(s);

    // movement (pinned men hug the ground)
    if (s.path && s.mental !== 'pinned') this.advance(s, this.moveSpeed(s));

    // combat
    if (s.cooldown > 0) s.cooldown -= DT;
    if (s.mental === 'broken') return;
    const w = WEAPONS[s.weapon];
    const t = s.targetId >= 0 ? this.soldiers[s.targetId] : null;
    const targetInvalid = !t || !t.alive || t.downed || Math.hypot(t.x - s.x, t.y - s.y) > w.range;
    if (targetInvalid || (this.tick + s.id) % RETARGET_TICKS === 0) {
      s.targetId = this.acquire(s);
    }
    if (s.targetId >= 0 && s.cooldown <= 0) {
      this.fire(s, this.soldiers[s.targetId]);
    }
  }

  private advance(s: Soldier, speed: number): void {
    const cost = this.map.terrainAt(Math.floor(s.x), Math.floor(s.y)).moveCost;
    let remaining = (speed / cost) * DT;
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
          s.fleeing = false;
        }
      } else {
        s.x += (dx / d) * remaining;
        s.y += (dy / d) * remaining;
        remaining = 0;
      }
    }
  }

  // Whether a soldier will risk it is bond vs. fear — you rescue your buddy,
  // not a stranger. This is the design's showcase behavior.
  rescueWillingness(s: Soldier, casualty: Soldier): number {
    return this.bond(s, casualty) * 1.2 + s.courage * 0.5 - s.suppression * 0.8;
  }

  private considerRescue(s: Soldier): void {
    for (const sid of this.squads[s.squadId].soldierIds) {
      const c = this.soldiers[sid];
      if (!c.alive || !c.downed || c.stabilized || c.rescuerId >= 0) continue;
      if (Math.hypot(c.x - s.x, c.y - s.y) > 30) continue;
      if (this.rescueWillingness(s, c) < 0.75) continue;
      s.task = { casualtyId: c.id, phase: 'goto', timer: 0 };
      s.path = null;
      s.targetId = -1;
      c.rescuerId = s.id;
      return;
    }
  }

  private updateRescue(s: Soldier): void {
    const task = s.task!;
    const c = this.soldiers[task.casualtyId];
    if (!c.alive || !c.downed) {
      this.dropTask(s);
      return;
    }
    if (task.phase === 'goto') {
      const d = Math.hypot(c.x - s.x, c.y - s.y);
      if (d > 1.5) {
        if (!s.path) {
          const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(c.x), Math.floor(c.y));
          if (!path || path.length < 2) {
            this.dropTask(s);
            return;
          }
          s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
          s.pathI = 0;
        }
        this.advance(s, this.moveSpeed(s));
        return;
      }
      s.path = null;
      if (s.suppression < 0.35 || this.inCover(c.x, c.y)) {
        task.phase = 'aid';
        task.timer = AID_SECONDS;
      } else {
        const spot = this.findCoverSpot(s);
        if (!spot) {
          task.phase = 'aid';
          task.timer = AID_SECONDS;
          return;
        }
        const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y);
        if (!path || path.length < 2) {
          task.phase = 'aid';
          task.timer = AID_SECONDS;
          return;
        }
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
        task.phase = 'drag';
        c.carriedBy = s.id;
      }
      return;
    }
    if (task.phase === 'drag') {
      this.advance(s, this.moveSpeed(s) * 0.45);
      c.x = s.x;
      c.y = s.y;
      if (!s.path) {
        task.phase = 'aid';
        task.timer = AID_SECONDS;
        c.carriedBy = -1;
      }
      return;
    }
    // aid
    task.timer -= DT;
    if (task.timer <= 0) {
      c.stabilized = true;
      c.bleedRate *= 0.15;
      this.dropTask(s);
    }
  }

  private dropTask(s: Soldier): void {
    if (s.task) {
      const c = this.soldiers[s.task.casualtyId];
      if (c.rescuerId === s.id) c.rescuerId = -1;
      if (c.carriedBy === s.id) c.carriedBy = -1;
    }
    s.task = null;
  }

  private inCover(x: number, y: number): boolean {
    const t = this.map.terrainAt(Math.floor(x), Math.floor(y));
    return t.cover > 0.2 || this.map.terrainKeyAt(Math.floor(x), Math.floor(y)) === 'floor';
  }

  private findCoverSpot(s: Soldier): { x: number; y: number } | null {
    const sx = Math.floor(s.x);
    const sy = Math.floor(s.y);
    for (let r = 1; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = sx + dx;
          const ny = sy + dy;
          if (!this.map.inBounds(nx, ny) || !this.map.terrainAt(nx, ny).passable) continue;
          if (this.inCover(nx + 0.5, ny + 0.5)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  private flee(s: Soldier): void {
    let nearest: Soldier | null = null;
    let nd = Infinity;
    for (const e of this.soldiers) {
      if (!e.alive || e.side === s.side) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d < nd) {
        nd = d;
        nearest = e;
      }
    }
    if (!nearest) return;
    const dx = s.x - nearest.x;
    const dy = s.y - nearest.y;
    const len = Math.hypot(dx, dy) || 1;
    const gx = Math.floor(s.x + (dx / len) * 30);
    const gy = Math.floor(s.y + (dy / len) * 30);
    const spot = this.findSpot(
      Math.max(1, Math.min(this.map.w - 2, gx)),
      Math.max(1, Math.min(this.map.h - 2, gy)),
      new Set(),
    );
    if (!spot) return;
    const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y);
    if (path && path.length > 1) {
      s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
      s.pathI = 0;
      s.fleeing = true;
    }
  }

  private acquire(s: Soldier): number {
    const w = WEAPONS[s.weapon];
    const candidates: { id: number; d: number }[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.side === s.side) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d <= w.range) candidates.push({ id: e.id, d });
    }
    candidates.sort((a, b) => a.d - b.d || a.id - b.id);
    for (const c of candidates) {
      const e = this.soldiers[c.id];
      if (los(this.map, s.x, s.y, e.x, e.y).visible) return c.id;
    }
    return -1;
  }

  private fire(s: Soldier, t: Soldier): void {
    const sight = los(this.map, s.x, s.y, t.x, t.y);
    if (!sight.visible) {
      s.targetId = -1;
      return;
    }
    const w = WEAPONS[s.weapon];
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    let cover = sight.cover;
    if (t.mental === 'pinned' || t.downed) cover = Math.min(0.9, cover + 0.3); // hugging the ground
    let acc = w.accuracy * (1 - 0.75 * (d / w.range)) * (1 - cover) * this.aimFactor(s);
    if (s.path) acc *= 0.5; // shooter moving
    if (t.path) acc *= 0.75; // target moving
    acc = Math.min(0.95, Math.max(0.02, acc));
    const hit = this.rng.next() < acc;
    let kill = false;
    if (hit) {
      kill = this.wound(t, this.rng.range(w.damage[0], w.damage[1]));
    }
    // near misses and hits suppress everyone around the impact point
    this.suppressAround(t.x, t.y, t.side, w.suppression);
    const rate = s.mental === 'pinned' ? 2 : 1; // cowering: slower fire
    s.cooldown = w.cooldown * rate * (0.85 + this.rng.next() * 0.3);
    this.pendingEvents.push({ fx: s.x, fy: s.y, tx: t.x, ty: t.y, hit, kill });
    if (kill || t.downed) s.targetId = -1;
  }

  private wound(t: Soldier, dmg: number): boolean {
    const part = rollPart(this.rng.next());
    const r = applyHit(t.body, part, dmg);
    t.wounds.push(r.wound);
    t.bleedRate += t.stabilized ? r.bleedRate * 0.15 : r.bleedRate;
    t.pain = Math.min(1.2, t.pain + r.pain);
    t.suppression = Math.min(1, t.suppression + 0.3);
    t.morale = Math.max(0, t.morale - 0.1 - (r.wound.dmg / 100) * 0.2);
    if (r.fatal) {
      this.kill(t);
      return true;
    }
    this.moraleShock(t, 0.03);
    return false;
  }

  private kill(t: Soldier): void {
    t.alive = false;
    t.path = null;
    t.downed = false;
    if (t.task) this.dropTask(t);
    if (t.rescuerId >= 0) {
      const r = this.soldiers[t.rescuerId];
      if (r.task?.casualtyId === t.id) this.dropTask(r);
    }
    this.moraleShock(t, 0.08);
  }

  // Seeing a squadmate hit hurts in proportion to how much he meant to you.
  private moraleShock(t: Soldier, amount: number): void {
    for (const sid of this.squads[t.squadId].soldierIds) {
      const m = this.soldiers[sid];
      if (m.id === t.id || !m.alive) continue;
      if (Math.hypot(m.x - t.x, m.y - t.y) < 15) {
        m.morale = Math.max(0, m.morale - amount * (0.4 + this.bond(m, t) * 1.6));
      }
    }
  }

  private suppressAround(x: number, y: number, side: Side, amount: number): void {
    for (const m of this.soldiers) {
      if (!m.alive || m.side !== side) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < SUPPRESS_RADIUS) {
        const gain = amount * (1 - d / SUPPRESS_RADIUS) * (1.3 - m.courage * 0.6) * (1 - Math.min(m.xp, 5) * 0.05);
        m.suppression = Math.min(1, m.suppression + gain);
      }
    }
  }

  woundSummary(s: Soldier): string {
    return s.wounds.map(woundLabel).slice(-2).join(', ');
  }

  // For determinism tests: full mutable state, rounded to dodge float noise.
  snapshot(): string {
    return JSON.stringify(
      this.soldiers.map((s) => [
        s.id,
        Math.round(s.x * 1e6),
        Math.round(s.y * 1e6),
        s.alive,
        s.downed,
        s.mental,
        Math.round(s.pain * 1e6),
        Math.round(s.bloodLoss * 1e6),
        Math.round(s.suppression * 1e6),
        Math.round(s.morale * 1e6),
        s.body.join(','),
        s.targetId,
        s.task ? `${s.task.phase}:${s.task.casualtyId}` : '',
        s.stabilized,
      ]),
    );
  }
}
