import { applyHit, capacities, consciousness, freshBody, rollPart, woundLabel, type Wound } from './body';
import { VEHICLES, WEAPONS, type VehicleKey, type WeaponDef, type WeaponKey } from './data';
import { GameMap, los } from './map';
import type { Building } from './mapgen';
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
  inVehicle: number; // vehicle id crewing, -1 = on foot
}

export interface Vehicle {
  id: number;
  side: Side;
  kind: VehicleKey;
  x: number;
  y: number;
  facing: number; // radians, hull
  alive: boolean;
  burning: boolean;
  crewIds: number[];
  path: { x: number; y: number }[] | null;
  pathI: number;
  gunCooldown: number;
  mgCooldown: number;
  targetVehicleId: number;
  targetSoldierId: number;
}

// Which armor arc does a shot from (fx,fy) strike?
export function armorFacing(v: { x: number; y: number; facing: number }, fx: number, fy: number): 'front' | 'side' | 'rear' {
  const shotAngle = Math.atan2(fy - v.y, fx - v.x);
  let rel = shotAngle - v.facing;
  while (rel > Math.PI) rel -= 2 * Math.PI;
  while (rel < -Math.PI) rel += 2 * Math.PI;
  const a = Math.abs(rel);
  if (a < Math.PI / 3) return 'front';
  if (a > (2 * Math.PI) / 3) return 'rear';
  return 'side';
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

// Discrete casualty/morale transitions, emitted the tick they happen so the
// UI never has to diff sim state (a DOWN followed by KIA in one frame batch
// would otherwise drop the DOWN).
export interface UnitEvent {
  kind: 'downed' | 'kia' | 'broken' | 'vehicle-destroyed';
  x: number;
  y: number;
  side: Side;
  name: string;
}

export interface ShotPreview {
  visible: boolean;
  dist: number;
  cover: number; // effective cover incl. pinned/downed hug-the-ground bonus
  acc: number;
}

export interface ApShotPreview {
  dist: number;
  acc: number;
  arc: 'front' | 'side' | 'rear';
  armor: number;
  penChance: number;
}

interface Barrage {
  side: Side;
  x: number;
  y: number;
  roundsLeft: number;
  nextTick: number;
}

// Formation offsets around a squad destination, meters. Exported for the
// move-order cover preview, which must show the real spots men will take.
export const OFFSETS = [
  [0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
  [2.2, 1.5], [-2.2, 1.5], [2.2, -1.5], [-2.2, -1.5], [0, 3],
];

export class Sim {
  tick = 0;
  rng: Rng;
  buildings: Building[] = []; // set by the scenario from the map plan; render + placement data
  soldiers: Soldier[] = [];
  squads: Squad[] = [];
  vehicles: Vehicle[] = [];
  winner: Side | null = null;
  barragesLeft: Record<Side, number> = { blue: 2, red: 1 };
  airstrikesLeft: Record<Side, number> = { blue: 1, red: 0 };
  startStrength: Record<Side, number> = { blue: 0, red: 0 };
  private barrages: Barrage[] = [];
  private strafeImpacts: { tick: number; x: number; y: number }[] = [];
  private pendingEvents: ShotEvent[] = [];
  private pendingBooms: { x: number; y: number }[] = [];
  private pendingPlanes: { x0: number; y: number; x1: number }[] = [];
  private pendingUnitEvents: UnitEvent[] = [];
  // Per-squad move state, indexed by squad id. Read-only for the UI (route preview).
  squadDest: ({ x: number; y: number } | null)[] = [];
  squadWaypoints: { x: number; y: number }[][] = [];

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
        inVehicle: -1,
      };
      s.morale = 0.7 + s.courage * 0.3;
      this.soldiers.push(s);
      squad.soldierIds.push(s.id);
      this.startStrength[side]++;
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

  // The aim multiplier as named terms, product = aimFactor. Exposed so the UI
  // can show WHY a man shoots the way he does without re-deriving the math.
  aimBreakdown(s: Soldier): { label: string; mult: number }[] {
    const cap = capacities(s.body);
    return [
      { label: 'Hands', mult: 0.4 + 0.6 * cap.manipulation },
      { label: 'Sight', mult: 0.3 + 0.7 * cap.sight },
      { label: 'Pain', mult: 1 - s.pain * 0.35 },
      { label: 'Suppressed', mult: 1 - s.suppression * 0.5 },
      { label: 'Veterancy', mult: 1 + Math.min(s.xp, 5) * 0.04 },
      { label: 'Nerves', mult: s.mental === 'shaken' ? 0.8 : s.mental === 'pinned' ? 0.6 : 1 },
    ];
  }

  // Effective aim multiplier from body + psyche + veterancy. Exposed for UI legibility.
  aimFactor(s: Soldier): number {
    let f = 1;
    for (const t of this.aimBreakdown(s)) f *= t.mult;
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

  // The superpower: a strafing run west→east through the target point.
  callAirstrike(side: Side, x: number, y: number): boolean {
    if (this.airstrikesLeft[side] <= 0) return false;
    this.airstrikesLeft[side]--;
    const start = this.tick + 25 * 30;
    for (let i = 0; i < 10; i++) {
      this.strafeImpacts.push({
        tick: start + i * 5,
        x: x - 20 + i * 4 + this.rng.range(-1, 1),
        y: y + this.rng.range(-1.5, 1.5),
      });
    }
    this.strafeImpacts.sort((a, b) => a.tick - b.tick);
    return true;
  }

  addVehicle(side: Side, kind: VehicleKey, x: number, y: number, facing = 0): Vehicle {
    const def = VEHICLES[kind];
    const crewWeapon: WeaponKey = side === 'blue' ? 'carbine' : 'mp40';
    const squad = this.addSquad(side, `${def.name} crew`, [
      { name: 'Cmdr', weapon: crewWeapon, x, y },
      { name: 'Gunner', weapon: crewWeapon, x, y },
      { name: 'Driver', weapon: crewWeapon, x, y },
    ]);
    const v: Vehicle = {
      id: this.vehicles.length,
      side,
      kind,
      x,
      y,
      facing,
      alive: true,
      burning: false,
      crewIds: [...squad.soldierIds],
      path: null,
      pathI: 0,
      gunCooldown: 0,
      mgCooldown: 0,
      targetVehicleId: -1,
      targetSoldierId: -1,
    };
    for (const sid of squad.soldierIds) this.soldiers[sid].inVehicle = v.id;
    this.vehicles.push(v);
    return v;
  }

  orderVehicleMove(vehicleId: number, wx: number, wy: number): void {
    const v = this.vehicles[vehicleId];
    if (!v || !v.alive) return;
    const spot = this.findVehicleSpot(Math.floor(wx), Math.floor(wy));
    if (!spot) return;
    const path = astar(this.map, Math.floor(v.x), Math.floor(v.y), spot.x, spot.y, 'vehicle');
    if (path && path.length > 1) {
      v.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
      v.pathI = 0;
    }
  }

  private findVehicleSpot(x: number, y: number): { x: number; y: number } | null {
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.map.inBounds(nx, ny)) continue;
          const k = this.map.terrainKeyAt(nx, ny);
          if (this.map.terrainAt(nx, ny).passable && k !== 'floor' && k !== 'woods') return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  // A direct order overrides any queued route.
  orderMove(squadId: number, wx: number, wy: number): void {
    this.squadWaypoints[squadId] = [];
    this.moveSquadTo(squadId, wx, wy);
  }

  // Shift-click: append a waypoint; dispatches immediately if the squad is idle.
  queueMove(squadId: number, wx: number, wy: number): void {
    if (!this.squads[squadId]) return;
    if (!this.squadDest[squadId] && (this.squadWaypoints[squadId] ?? []).length === 0) {
      this.moveSquadTo(squadId, wx, wy);
      return;
    }
    (this.squadWaypoints[squadId] ??= []).push({ x: wx, y: wy });
  }

  private moveSquadTo(squadId: number, wx: number, wy: number): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    this.squadDest[squadId] = { x: wx, y: wy };
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

  takePlanes(): { x0: number; y: number; x1: number }[] {
    const p = this.pendingPlanes;
    this.pendingPlanes = [];
    return p;
  }

  takeUnitEvents(): UnitEvent[] {
    const e = this.pendingUnitEvents;
    this.pendingUnitEvents = [];
    return e;
  }

  step(): void {
    this.tick++;
    this.stepWaypoints();
    this.stepBarrages();
    this.stepStrafes();
    for (const v of this.vehicles) {
      if (v.alive) this.updateVehicle(v);
    }
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
      // a side breaks off the battle below a quarter of starting strength
      const floorOf = (side: Side) => Math.max(2, this.startStrength[side] * 0.25);
      if (blue < floorOf('blue') && red >= floorOf('red')) this.winner = 'red';
      else if (red < floorOf('red') && blue >= floorOf('blue')) this.winner = 'blue';
      else if (blue === 0 && red > 0) this.winner = 'red';
      else if (red === 0 && blue > 0) this.winner = 'blue';
    }
  }

  // When every eligible member of a squad has arrived, dispatch its next waypoint.
  private stepWaypoints(): void {
    for (const sq of this.squads) {
      const q = this.squadWaypoints[sq.id];
      if (!this.squadDest[sq.id] && (!q || q.length === 0)) continue;
      let eligible = 0;
      let moving = 0;
      for (const sid of sq.soldierIds) {
        const s = this.soldiers[sid];
        if (!s.alive || s.downed || s.mental === 'broken') continue;
        eligible++;
        if (s.path) moving++;
      }
      if (eligible === 0) {
        this.squadWaypoints[sq.id] = [];
        this.squadDest[sq.id] = null;
        continue;
      }
      if (moving > 0) continue;
      const next = q?.shift();
      if (next) this.moveSquadTo(sq.id, next.x, next.y);
      else this.squadDest[sq.id] = null; // arrived, route done
    }
  }

  private stepStrafes(): void {
    if (this.strafeImpacts.length === 0) return;
    if (this.strafeImpacts[0].tick - this.tick === 60) {
      // plane appears 2s ahead of the first burst
      const first = this.strafeImpacts[0];
      this.pendingPlanes.push({ x0: first.x - 60, y: first.y, x1: first.x + 100 });
    }
    while (this.strafeImpacts.length > 0 && this.tick >= this.strafeImpacts[0].tick) {
      const s = this.strafeImpacts.shift()!;
      this.explode(s.x, s.y, { suppRadius: 12, fragRadius: 5, frags: 2, dmg: [25, 70] });
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

  private explode(
    x: number,
    y: number,
    p: { suppRadius: number; fragRadius: number; frags: number; dmg: [number, number] } = {
      suppRadius: 15,
      fragRadius: 9,
      frags: 3,
      dmg: [25, 75],
    },
  ): void {
    this.pendingBooms.push({ x, y });
    for (const s of this.soldiers) {
      if (!s.alive || s.inVehicle >= 0) continue; // armor shrugs off fragments
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > p.suppRadius) continue;
      s.suppression = Math.min(1, s.suppression + 0.6 * (1 - d / p.suppRadius) * (1.3 - s.courage * 0.6));
      if (d > p.fragRadius) continue;
      if (!los(this.map, x, y, s.x, s.y).visible) continue; // walls stop fragments
      const frags = d < 2 ? p.frags : d < p.fragRadius * 0.55 ? Math.max(1, p.frags - 1) : 1;
      for (let i = 0; i < frags; i++) {
        const pHit = (1 - d / (p.fragRadius + 1)) * (s.downed || s.mental === 'pinned' ? 0.45 : 0.8);
        if (this.rng.next() < pHit) {
          if (this.wound(s, this.rng.range(p.dmg[0], p.dmg[1]))) break;
        }
      }
    }
  }

  private updateVehicle(v: Vehicle): void {
    const def = VEHICLES[v.kind];
    // movement
    if (v.path) {
      const wp = v.path[v.pathI];
      const dx = wp.x - v.x;
      const dy = wp.y - v.y;
      const d = Math.hypot(dx, dy);
      const onRoad = this.map.terrainKeyAt(Math.floor(v.x), Math.floor(v.y)) === 'road';
      let remaining = def.speed * (onRoad ? 1.3 : 1) * DT;
      if (d > 0.01) v.facing = Math.atan2(dy, dx);
      if (d <= remaining) {
        v.x = wp.x;
        v.y = wp.y;
        v.pathI++;
        if (v.pathI >= v.path.length) {
          v.path = null;
          v.pathI = 0;
        }
      } else {
        v.x += (dx / d) * remaining;
        v.y += (dy / d) * remaining;
      }
    }

    // tank terror: enemy infantry with sight of an approaching tank feel it
    if (this.tick % 30 === 0) {
      for (const s of this.soldiers) {
        if (!s.alive || s.downed || s.side === v.side || s.inVehicle >= 0) continue;
        const d = Math.hypot(s.x - v.x, s.y - v.y);
        if (d < 30 && los(this.map, v.x, v.y, s.x, s.y).visible) {
          s.suppression = Math.min(1, s.suppression + 0.05 * (1.3 - s.courage * 0.6));
        }
      }
    }

    if (v.gunCooldown > 0) v.gunCooldown -= DT;
    if (v.mgCooldown > 0) v.mgCooldown -= DT;

    // prefer enemy armor with the main gun
    if ((this.tick + v.id) % RETARGET_TICKS === 0 || v.targetVehicleId < 0) {
      v.targetVehicleId = -1;
      let bestD = Infinity;
      for (const e of this.vehicles) {
        if (!e.alive || e.side === v.side) continue;
        const d = Math.hypot(e.x - v.x, e.y - v.y);
        if (d <= def.gunRange && d < bestD && los(this.map, v.x, v.y, e.x, e.y).visible) {
          bestD = d;
          v.targetVehicleId = e.id;
        }
      }
    }
    if (v.targetVehicleId >= 0 && v.gunCooldown <= 0) {
      const e = this.vehicles[v.targetVehicleId];
      if (e.alive && los(this.map, v.x, v.y, e.x, e.y).visible) {
        this.fireApAt(v.x, v.y, def.gunPen, def.gunAccuracy, def.gunRange, e, v.path !== null);
        v.gunCooldown = def.gunCooldown * (0.85 + this.rng.next() * 0.3);
      } else {
        v.targetVehicleId = -1;
      }
      return;
    }

    // otherwise work the infantry: HE from the gun, bursts from the hull MG
    if ((this.tick + v.id) % RETARGET_TICKS === 0 || v.targetSoldierId < 0) {
      v.targetSoldierId = this.acquireSoldierTarget(v.x, v.y, v.side, def.mgRange);
    }
    const t = v.targetSoldierId >= 0 ? this.soldiers[v.targetSoldierId] : null;
    if (t && (!t.alive || t.downed)) {
      v.targetSoldierId = -1;
      return;
    }
    if (t) {
      if (!los(this.map, v.x, v.y, t.x, t.y).visible) {
        v.targetSoldierId = -1;
        return;
      }
      if (v.gunCooldown <= 0) {
        // HE round at the infantry position
        this.explode(t.x + this.rng.range(-2, 2), t.y + this.rng.range(-2, 2), { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 60] });
        this.pendingEvents.push({ fx: v.x, fy: v.y, tx: t.x, ty: t.y, hit: true, kill: false });
        v.gunCooldown = def.gunCooldown * (0.85 + this.rng.next() * 0.3);
      } else if (v.mgCooldown <= 0) {
        const hullMg: WeaponKey = v.side === 'blue' ? 'm1919' : 'mg42';
        this.fireSmallArms(v.x, v.y, hullMg, t, false);
        v.mgCooldown = WEAPONS[hullMg].cooldown * (0.85 + this.rng.next() * 0.3);
      }
    }
  }

  private acquireSoldierTarget(x: number, y: number, side: Side, range: number): number {
    const candidates: { id: number; d: number }[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.side === side || e.inVehicle >= 0) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= range) candidates.push({ id: e.id, d });
    }
    candidates.sort((a, b) => a.d - b.d || a.id - b.id);
    for (const c of candidates) {
      const e = this.soldiers[c.id];
      if (los(this.map, x, y, e.x, e.y).visible) return c.id;
    }
    return -1;
  }

  private fireApAt(fx: number, fy: number, pen: number, accuracy: number, range: number, target: Vehicle, moving: boolean): void {
    const p = this.apShotPreview(fx, fy, pen, accuracy, range, target, moving);
    const hit = this.rng.next() < p.acc;
    this.pendingEvents.push({ fx, fy, tx: target.x, ty: target.y, hit, kill: false });
    if (!hit) {
      this.explode(target.x + this.rng.range(-4, 4), target.y + this.rng.range(-4, 4), { suppRadius: 8, fragRadius: 3, frags: 1, dmg: [20, 50] });
      return;
    }
    const effPen = pen * this.rng.range(0.75, 1.25);
    if (effPen <= p.armor) return; // clang — ricochet
    // penetration: spall wounds crew, chance of brew-up
    for (const cid of target.crewIds) {
      const c = this.soldiers[cid];
      if (c.alive && this.rng.next() < 0.45) this.wound(c, this.rng.range(30, 80));
    }
    if (this.rng.next() < 0.45) this.destroyVehicle(target);
  }

  private destroyVehicle(v: Vehicle): void {
    this.pendingUnitEvents.push({ kind: 'vehicle-destroyed', x: v.x, y: v.y, side: v.side, name: VEHICLES[v.kind].name });
    v.alive = false;
    v.burning = true;
    v.path = null;
    this.pendingBooms.push({ x: v.x, y: v.y });
    // survivors bail out shaken
    let slot = 0;
    for (const cid of v.crewIds) {
      const c = this.soldiers[cid];
      c.inVehicle = -1;
      if (!c.alive) continue;
      const [ox, oy] = OFFSETS[slot++ % OFFSETS.length];
      const spot = this.findSpot(Math.floor(v.x + ox * 2), Math.floor(v.y + oy * 2), new Set());
      if (spot) {
        c.x = spot.x + 0.5;
        c.y = spot.y + 0.5;
      }
      c.suppression = Math.min(1, c.suppression + 0.8);
      c.morale = Math.max(0, c.morale - 0.3);
    }
  }

  // The exact accuracy math live fire uses, exposed for hit-chance previews —
  // the UI must never re-derive (and drift from) this formula.
  shotPreview(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean, aim: number): ShotPreview {
    const sight = los(this.map, fx, fy, t.x, t.y);
    const d = Math.hypot(t.x - fx, t.y - fy);
    if (!sight.visible) return { visible: false, dist: d, cover: 0, acc: 0 };
    const w = WEAPONS[weapon];
    let cover = sight.cover;
    if (t.mental === 'pinned' || t.downed) cover = Math.min(0.9, cover + 0.3);
    let acc = w.accuracy * (1 - 0.75 * (d / w.range)) * (1 - cover) * aim;
    if (shooterMoving) acc *= 0.5;
    if (t.path) acc *= 0.75;
    acc = Math.min(0.95, Math.max(0.02, acc));
    return { visible: true, dist: d, cover, acc };
  }

  // AP fire preview: hit chance plus which plate the shot meets and the odds
  // of beating it (effective pen rolls uniform in 0.75–1.25 × pen).
  apShotPreview(fx: number, fy: number, pen: number, accuracy: number, range: number, target: Vehicle, moving: boolean): ApShotPreview {
    const d = Math.hypot(target.x - fx, target.y - fy);
    let acc = accuracy * (1 - 0.6 * (d / range));
    if (moving) acc *= 0.6;
    acc = Math.min(0.95, Math.max(0.05, acc));
    const arc = armorFacing(target, fx, fy);
    const armor = VEHICLES[target.kind].armor[arc];
    const penChance = Math.min(1, Math.max(0, (1.25 - armor / pen) / 0.5));
    return { dist: d, acc, arc, armor, penChance };
  }

  // Shared small-arms resolution used by soldiers and vehicle MGs.
  private fireSmallArms(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean, aim = 1): boolean {
    const p = this.shotPreview(fx, fy, weapon, t, shooterMoving, aim);
    if (!p.visible) return false;
    const w = WEAPONS[weapon];
    const hit = this.rng.next() < p.acc;
    let kill = false;
    if (hit) kill = this.wound(t, this.rng.range(w.damage[0], w.damage[1]));
    this.suppressAround(t.x, t.y, t.side, w.suppression);
    this.pendingEvents.push({ fx, fy, tx: t.x, ty: t.y, hit, kill });
    return kill;
  }

  private updateSoldier(s: Soldier): void {
    // crew fight from inside the hull: physiology only
    if (s.inVehicle >= 0) {
      if (s.wounds.length > 0) {
        s.bloodLoss = Math.min(1, s.bloodLoss + s.bleedRate * DT);
        s.pain = Math.max(0, s.pain - PAIN_DECAY * DT);
        if (s.bloodLoss >= 1) this.kill(s);
        s.downed = consciousness(s.pain, s.bloodLoss) < 0.3 || s.pain >= 0.8;
      }
      return;
    }
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
        this.pendingUnitEvents.push({ kind: 'downed', x: s.x, y: s.y, side: s.side, name: s.name });
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
    const wasMental = s.mental;
    s.mental =
      s.morale < 0.25 ? 'broken'
      : s.suppression > pinThreshold || (s.suppression > 0.5 && s.morale < 0.5) ? 'pinned'
      : s.suppression > 0.35 || s.morale < 0.55 ? 'shaken'
      : 'steady';
    if (s.mental === 'broken' && wasMental !== 'broken') {
      this.pendingUnitEvents.push({ kind: 'broken', x: s.x, y: s.y, side: s.side, name: s.name });
    }

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
    const w: WeaponDef = WEAPONS[s.weapon];

    // AT men engage armor first
    if (w.pen !== undefined && s.cooldown <= 0) {
      let bestV: Vehicle | null = null;
      let bestD = Infinity;
      for (const v of this.vehicles) {
        if (!v.alive || v.side === s.side) continue;
        const d = Math.hypot(v.x - s.x, v.y - s.y);
        if (d <= w.range && d < bestD && los(this.map, s.x, s.y, v.x, v.y).visible) {
          bestD = d;
          bestV = v;
        }
      }
      if (bestV) {
        this.fireApAt(s.x, s.y, w.pen, w.accuracy * this.aimFactor(s), w.range, bestV, s.path !== null);
        s.cooldown = w.cooldown * (0.85 + this.rng.next() * 0.3);
        return;
      }
    }

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

  // Public: the same cover predicate AI cover-seeking uses drives the UI's
  // move-preview dot colors — one definition of "in cover".
  inCover(x: number, y: number): boolean {
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
    return this.acquireSoldierTarget(s.x, s.y, s.side, WEAPONS[s.weapon].range);
  }

  private fire(s: Soldier, t: Soldier): void {
    if (!los(this.map, s.x, s.y, t.x, t.y).visible) {
      s.targetId = -1;
      return;
    }
    const w = WEAPONS[s.weapon];
    const kill = this.fireSmallArms(s.x, s.y, s.weapon, t, s.path !== null, this.aimFactor(s));
    const rate = s.mental === 'pinned' ? 2 : 1; // cowering: slower fire
    s.cooldown = w.cooldown * rate * (0.85 + this.rng.next() * 0.3);
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
    if (t.inVehicle < 0) this.pendingUnitEvents.push({ kind: 'kia', x: t.x, y: t.y, side: t.side, name: t.name });
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
    return JSON.stringify({
      soldiers: this.soldiers.map((s) => [
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
      vehicles: this.vehicles.map((v) => [
        v.id,
        Math.round(v.x * 1e6),
        Math.round(v.y * 1e6),
        v.alive,
        Math.round(v.facing * 1e6),
        v.targetVehicleId,
        v.targetSoldierId,
      ]),
    });
  }
}
