import { applyHit, capacities, consciousness, freshBody, rollPart, woundLabel, type Wound } from './body';
import {
  DE_NAMES,
  SQUADS,
  TEAMS,
  US_NAMES,
  VEHICLES,
  WEAPONS,
  type AmmoKey,
  type Role,
  type SquadKey,
  type VehicleKey,
  type WeaponDef,
  type WeaponKey,
} from './data';
import { GameMap, los, type LosResult } from './map';
import type { Building } from './mapgen';
import { ambushThreshold, BALK_REASON, compliance, dangerScore, type OrderState, type TeamOrder } from './orders';
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
const BOUND_LEG = 15; // meters per bounding rush (spec's "15m legs")

export type Side = 'blue' | 'red';
export type Mental = 'steady' | 'shaken' | 'pinned' | 'broken';

export interface RescueTask {
  kind: 'rescue';
  casualtyId: number;
  phase: 'goto' | 'drag' | 'aid';
  timer: number;
}

// Ammo runner: a bonded squadmate ferries reserve belts to a dry MG gunner
// (spec's casualty-chain-adjacent capability hook), reusing the RescueTask
// state-machine shape rather than a parallel scheduler.
export interface AmmoTask {
  kind: 'ammo';
  gunnerId: number;
  phase: 'goto' | 'transfer' | 'return';
  timer: number;
  returnX: number;
  returnY: number;
}

export interface Soldier {
  id: number;
  pid: number; // campaign roster id, -1 for one-off battles
  side: Side;
  squadId: number;
  teamId: number;
  role: Role;
  name: string;
  weapon: WeaponKey;
  secondary?: WeaponKey; // one-shot items (panzerfaust) revert to this once spent
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
  // ammo/weapon service
  ammo: Partial<Record<AmmoKey, number>>; // discrete reload-worths carried
  ammoStart: number; // total reserve units carried at spawn (ammo-discipline baseline)
  magLeft: number; // rounds left in the current mag/belt/clip
  reloading: number; // seconds left on a reload, barrel-swap, or weapon pickup, 0 = not busy
  heat: number; // 0..1.5, belt-fed barrel model
  stamina: number; // 1 = rested, drains on the move, recovers when settled
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
  task: RescueTask | AmmoTask | null;
  rescuerId: number; // who claimed this casualty, -1 none
  carriedBy: number; // -1 = not being dragged
  ammoRunnerId: number; // runner already en route to resupply this soldier, -1 none
  pickingUp: boolean; // mid weapon-pickup timer (rides `reloading`)
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
  ammo?: Partial<Record<AmmoKey, number>>;
  secondary?: WeaponKey;
}

export interface Squad {
  id: number;
  side: Side;
  name: string;
  soldierIds: number[];
  teamIds: number[];
}

// The atomic command unit (spec §1): 3-6 men, one order at a time. A squad is
// 1-3 teams sharing a leader and bonds; crewed weapons/vehicles are
// single-team squads — same data shape, no special cases.
export interface Team {
  id: number;
  squadId: number;
  name: string;
  soldierIds: number[];
  orderState: OrderState;
  smokeLeft: number; // rifle-team smoke budget, 2/battle
  ambushBonusTick: number; // tick the ambush trigger fired on, -1 = none/consumed
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
  kind: 'downed' | 'kia' | 'broken' | 'vehicle-destroyed' | 'ping';
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

export interface Smoke {
  x: number;
  y: number;
  ttl: number; // seconds left
}

export interface DroppedKit {
  side: Side;
  x: number;
  y: number;
  weapon: WeaponKey;
  ammo: Partial<Record<AmmoKey, number>>;
  magLeft: number;
}

// Small-arms upgrade rank for casual battlefield pickup (spec: mg42/bar/m1919
// > smg > rifle > carbine). Weapons outside this table (AT, mortars) rank 0 —
// never picked up this way, only ever their own team's kit.
const WEAPON_RANK: Partial<Record<WeaponKey, number>> = {
  mg42: 4, bar: 4, m1919: 4,
  thompson: 3, mp40: 3,
  garand: 2, kar98k: 2, kar98k_scoped: 2, springfield: 2,
  carbine: 1,
};
function weaponRank(w: WeaponKey): number {
  return WEAPON_RANK[w] ?? 0;
}

// Formation offsets around a squad destination, meters. Exported for the
// move-order cover preview, which must show the real spots men will take.
export const OFFSETS = [
  [0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
  [2.2, 1.5], [-2.2, 1.5], [2.2, -1.5], [-2.2, -1.5], [0, 3],
];

// Squared distance from a point to a segment — used to test whether a smoke
// puff sits close enough to a sightline to obscure it.
function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// The one LOS wrapper every soldier-vision (and vehicle-sight) call site must
// route through: same as map.ts's los(), plus smoke. map.ts's signature stays
// untouched — this only adds smoke's contribution on top of its result. Each
// puff within 1.5m of the ray adds 0.5 opacity; >=1 blocks same as terrain.
export function sightBetween(sim: Sim, x0: number, y0: number, x1: number, y1: number): LosResult {
  const base = los(sim.map, x0, y0, x1, y1);
  if (!base.visible || sim.smoke.length === 0) return base;
  let opacity = 0;
  for (const p of sim.smoke) {
    if (distToSegment(p.x, p.y, x0, y0, x1, y1) <= 1.5) opacity += 0.5;
  }
  if (opacity >= 1) return { visible: false, cover: 0 };
  if (opacity > 0) return { visible: true, cover: Math.min(0.95, base.cover + opacity * 0.4) };
  return base;
}

export class Sim {
  tick = 0;
  rng: Rng;
  buildings: Building[] = []; // set by the scenario from the map plan; render + placement data
  soldiers: Soldier[] = [];
  squads: Squad[] = [];
  teams: Team[] = [];
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
  smoke: Smoke[] = [];
  droppedKit: DroppedKit[] = [];
  // Recent-casualty flags for dangerScore/ambush triggers, indexed by squad/team id.
  squadLastCasualty: number[] = [];
  teamLastCasualty: number[] = [];
  private sneakBaseline: number[] = []; // per-team wound count when a sneak order started

  constructor(readonly map: GameMap, seed: number) {
    this.rng = mulberry32(seed);
  }

  private spawnSoldier(side: Side, squadId: number, teamId: number, role: Role, m: MemberInit): Soldier {
    const body = freshBody();
    if (m.bodyDamage) for (let i = 0; i < body.length; i++) body[i] = Math.max(0, body[i] - (m.bodyDamage[i] ?? 0));
    const w = WEAPONS[m.weapon];
    const s: Soldier = {
      id: this.soldiers.length,
      pid: m.pid ?? -1,
      side,
      squadId,
      teamId,
      role,
      name: m.name,
      weapon: m.weapon,
      secondary: m.secondary,
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
      ammo: m.ammo ?? { [w.ammo.type]: 6 }, // fallback for legacy callers
      ammoStart: Object.values(m.ammo ?? { [w.ammo.type]: 6 }).reduce((a: number, n) => a + (n ?? 0), 0),
      magLeft: w.ammo.perUnit,
      reloading: 0,
      heat: 0,
      stamina: 1,
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
      ammoRunnerId: -1,
      pickingUp: false,
      inVehicle: -1,
    };
    s.morale = 0.7 + s.courage * 0.3;
    this.soldiers.push(s);
    return s;
  }

  // Spawns one team's soldiers onto a squad already pushed into this.squads.
  private spawnTeam(squad: Squad, name: string, entries: { role: Role; member: MemberInit }[]): Team {
    const team: Team = {
      id: this.teams.length,
      squadId: squad.id,
      name,
      soldierIds: [],
      orderState: { order: null, phase: 'idle', reason: '' },
      smokeLeft: 2,
      ambushBonusTick: -1,
    };
    this.teams.push(team);
    squad.teamIds.push(team.id);
    for (const { role, member } of entries) {
      const s = this.spawnSoldier(squad.side, squad.id, team.id, role, member);
      team.soldierIds.push(s.id);
      squad.soldierIds.push(s.id);
      this.startStrength[squad.side]++;
    }
    return team;
  }

  // Default squad cohesion for one-off battles; campaign wiring overwrites bonds.
  private bondSquad(squad: Squad): void {
    for (const a of squad.soldierIds) {
      for (const b of squad.soldierIds) {
        if (a !== b) this.soldiers[a].bonds[b] = 0.25 + this.rng.next() * 0.3;
      }
    }
  }

  // Legacy call shape: one implicit team holds the whole roster. Used by
  // campaign wiring (strategic/bridge.ts) and any hand-built test squad.
  addSquad(side: Side, name: string, members: MemberInit[]): Squad {
    const squad: Squad = { id: this.squads.length, side, name, soldierIds: [], teamIds: [] };
    this.squads.push(squad);
    this.spawnTeam(
      squad,
      name,
      members.map((m) => ({ role: 'rifleman' as const, member: m })),
    );
    this.bondSquad(squad);
    return squad;
  }

  // Data-driven force building: spawns every team a SquadDef calls for, named
  // and armed from data.ts. `roster` supplies per-team, per-slot overrides
  // (campaign soldiers) — any field left out falls back to the slot default.
  addSquadFromDef(side: Side, key: SquadKey, x: number, y: number, roster?: MemberInit[][]): Squad {
    const def = SQUADS[key];
    const names = side === 'blue' ? US_NAMES : DE_NAMES;
    const squad: Squad = { id: this.squads.length, side, name: def.name, soldierIds: [], teamIds: [] };
    this.squads.push(squad);
    const n = def.teams.length;
    def.teams.forEach((teamKey, ti) => {
      const teamDef = TEAMS[teamKey];
      const cy = y + (ti - (n - 1) / 2) * 8; // fan teams out so a multi-team squad doesn't stack
      const entries = teamDef.slots.map((slot, si) => {
        const ov = roster?.[ti]?.[si];
        const member: MemberInit = {
          name: ov?.name ?? names[this.rng.int(names.length)],
          weapon: ov?.weapon ?? slot.weapon,
          x: ov?.x ?? x + this.rng.range(-3, 3),
          y: ov?.y ?? cy + this.rng.range(-3, 3),
          courage: ov?.courage,
          xp: ov?.xp,
          bodyDamage: ov?.bodyDamage,
          pid: ov?.pid,
          ammo: ov?.ammo ?? { ...slot.ammo },
          secondary: ov?.secondary,
        };
        return { role: slot.role, member };
      });
      this.spawnTeam(squad, teamDef.name, entries);
    });
    this.bondSquad(squad);
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
      { label: 'Stamina', mult: s.stamina < 0.3 ? 0.8 : s.stamina < 0.6 ? 0.92 : 1 },
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
    let speed = BASE_SPEED * (0.3 + 0.7 * cap.moving);
    if (s.stamina < 0.3) speed *= 0.6; // fatigued
    else if (s.stamina < 0.6) speed *= 0.85; // winded
    if (s.path) {
      const order = this.teams[s.teamId].orderState.order;
      if (order?.kind === 'fast') speed *= 1.6;
      else if (order?.kind === 'sneak') speed *= 0.35;
    }
    return speed;
  }

  // Served-weapon rule: a living assistant nearby speeds reloads and barrel
  // swaps. Exposed for UI legibility and tests.
  assistFactor(s: Soldier): number {
    for (const sid of this.teams[s.teamId].soldierIds) {
      if (sid === s.id) continue;
      const m = this.soldiers[sid];
      if (m.alive && !m.downed && m.role === 'assistant' && Math.hypot(m.x - s.x, m.y - s.y) <= 3) return 1;
    }
    return 1.75;
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
    const squad: Squad = { id: this.squads.length, side, name: `${def.name} crew`, soldierIds: [], teamIds: [] };
    this.squads.push(squad);
    const entries = def.crew.map((slot) => ({
      role: slot.role,
      member: { name: slot.role[0].toUpperCase() + slot.role.slice(1), weapon: slot.weapon, x, y, ammo: { ...slot.ammo } },
    }));
    this.spawnTeam(squad, `${def.name} crew`, entries);
    this.bondSquad(squad);
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
          if (this.map.terrainAt(nx, ny).passable && k !== 'floor' && k !== 'woods' && k !== 'hedge') return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  // Direct order to one team: the opt-in fire-and-maneuver granularity (spec
  // §1). Paths every eligible member to a formation spot around (wx, wy).
  // Low-level primitive — no compliance, no order-kind behavior. Used by the
  // waypoint queue (dispatchSquadTo) and as the executor's "just walk there"
  // building block for move/fast/sneak/bounding legs.
  orderMove(teamId: number, wx: number, wy: number): void {
    const team = this.teams[teamId];
    if (!team) return;
    this.moveSoldiersTo(team.soldierIds, wx, wy);
  }

  private moveSoldiersTo(soldierIds: number[], wx: number, wy: number): void {
    const used = new Set<number>();
    let slot = 0;
    for (const sid of soldierIds) {
      const s = this.soldiers[sid];
      if (!this.eligible(s)) continue;
      const [ox, oy] = OFFSETS[slot % OFFSETS.length];
      slot++;
      const spot = this.findSpot(Math.floor(wx + ox), Math.floor(wy + oy), used);
      if (!spot) continue;
      used.add(spot.y * this.map.w + spot.x);
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y);
      if (path && path.length > 1) {
        if (s.task) this.dropTask(s); // direct orders override a rescue/ammo run
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
        s.fleeing = false;
      }
    }
  }

  private eligible(s: Soldier): boolean {
    return s.alive && !s.downed && s.mental !== 'broken';
  }

  // The order vocabulary's entry point (spec's "interpret + refuse"): runs
  // compliance, stores the legibility state, and kicks off execution.
  orderTeam(teamId: number, order: TeamOrder): void {
    const team = this.teams[teamId];
    if (!team) return;
    const eligibleIds = team.soldierIds.filter((id) => this.eligible(this.soldiers[id]));
    if (eligibleIds.length === 0) return;

    const danger = dangerScore(this, team, { x: order.x, y: order.y });
    const verdict = compliance(this, team, danger);
    if (verdict === 'balk') {
      team.orderState = { order, phase: 'balked', reason: BALK_REASON };
      return;
    }
    const cautious = verdict === 'cautious';
    const effective: TeamOrder = cautious && order.kind === 'fast' ? { ...order, kind: 'move' } : order;
    const reason = cautious ? 'moving cautiously' : '';

    if (effective.kind === 'move' && (cautious || this.teamUnderFire(team))) {
      team.orderState = { order: effective, phase: 'bounding_a', reason };
      const [a, b] = this.teamHalves(team);
      for (const id of b) this.soldiers[id].path = null;
      this.dispatchLeg(a, effective);
    } else if (effective.kind === 'move' || effective.kind === 'fast' || effective.kind === 'sneak') {
      team.orderState = { order: effective, phase: 'executing', reason };
      if (effective.kind === 'sneak') this.sneakBaseline[team.id] = this.woundCount(team);
      this.moveSoldiersTo(team.soldierIds, effective.x, effective.y);
    } else if (effective.kind === 'smoke') {
      team.orderState = { order: effective, phase: 'executing', reason };
      this.deploySmoke(team, effective);
    } else if (effective.kind === 'defend' || effective.kind === 'ambush') {
      team.orderState = { order: effective, phase: 'executing', reason };
      this.moveSoldiersTo(team.soldierIds, effective.x, effective.y);
    } else {
      // fire: no movement, members engage per updateSoldier's combat section
      team.orderState = { order: effective, phase: 'executing', reason };
    }
  }

  // Squad click broadcasts to teams (spec §1), offsetting each team's
  // destination by team index x 8m so a multi-team squad doesn't stack.
  // A direct order overrides any queued waypoint route.
  orderSquad(squadId: number, order: TeamOrder): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    this.squadWaypoints[squadId] = [];
    const isMoveKind = order.kind === 'move' || order.kind === 'fast' || order.kind === 'sneak';
    this.squadDest[squadId] = isMoveKind ? { x: order.x, y: order.y } : null;
    const n = squad.teamIds.length;
    squad.teamIds.forEach((teamId, ti) => {
      const oy = (ti - (n - 1) / 2) * 8;
      this.orderTeam(teamId, { ...order, y: order.y + oy });
    });
  }

  private teamUnderFire(team: Team): boolean {
    return team.soldierIds.some((id) => {
      const s = this.soldiers[id];
      return s.alive && !s.downed && s.suppression > 0.35;
    });
  }

  // Stable index split — first half is element A, second is B. Deterministic
  // across ticks since soldierIds never reorders.
  private teamHalves(team: Team): [number[], number[]] {
    const mid = Math.ceil(team.soldierIds.length / 2);
    return [team.soldierIds.slice(0, mid), team.soldierIds.slice(mid)];
  }

  private centroidOf(soldierIds: number[]): { x: number; y: number } | null {
    const alive = soldierIds.map((id) => this.soldiers[id]).filter((s) => this.eligible(s));
    if (alive.length === 0) return null;
    return {
      x: alive.reduce((a, s) => a + s.x, 0) / alive.length,
      y: alive.reduce((a, s) => a + s.y, 0) / alive.length,
    };
  }

  // Bounding rush: dispatches `ids` toward `order` at most BOUND_LEG meters
  // this leg, from their own centroid.
  private dispatchLeg(ids: number[], order: TeamOrder): void {
    const centroid = this.centroidOf(ids);
    if (!centroid) return;
    const dx = order.x - centroid.x;
    const dy = order.y - centroid.y;
    const d = Math.hypot(dx, dy);
    const leg = Math.min(BOUND_LEG, d);
    const target = d < 0.01 ? { x: order.x, y: order.y } : { x: centroid.x + (dx / d) * leg, y: centroid.y + (dy / d) * leg };
    this.moveSoldiersTo(ids, target.x, target.y);
  }

  // Alternates the active (rushing) half once its leg completes; the other
  // half holds and fires. Clears the order once arrived.
  private continueBounding(team: Team, order: TeamOrder, st: OrderState): void {
    const [a, b] = this.teamHalves(team);
    const activeIds = st.phase === 'bounding_a' ? a : b;
    const otherIds = st.phase === 'bounding_a' ? b : a;
    const activeAlive = activeIds.filter((id) => this.eligible(this.soldiers[id]));
    if (activeAlive.some((id) => this.soldiers[id].path)) return; // mid-leg
    const centroid = this.centroidOf(team.soldierIds);
    if (!centroid || Math.hypot(centroid.x - order.x, centroid.y - order.y) < 3) {
      st.order = null;
      st.phase = 'idle';
      st.reason = '';
      return;
    }
    st.phase = st.phase === 'bounding_a' ? 'bounding_b' : 'bounding_a';
    this.dispatchLeg(otherIds, order);
  }

  private woundCount(team: Team): number {
    return team.soldierIds.reduce((a, id) => a + this.soldiers[id].wounds.length, 0);
  }

  // Sneak breaks to move the instant any teammate takes a wound (spec: "holds
  // fire until fired on").
  private checkSneakBreak(team: Team): void {
    const order = team.orderState.order;
    if (!order || order.kind !== 'sneak') return;
    if (this.woundCount(team) > (this.sneakBaseline[team.id] ?? 0)) order.kind = 'move';
  }

  // Rifle-team smoke: 2 puffs at the point (<=30m from the team), 60s ttl,
  // 2/battle budget. Mortar smoke arrives with emplacements (Task 9).
  private deploySmoke(team: Team, order: TeamOrder): void {
    if (team.smokeLeft <= 0) return;
    const centroid = this.centroidOf(team.soldierIds);
    if (!centroid || Math.hypot(order.x - centroid.x, order.y - centroid.y) > 30) return;
    team.smokeLeft--;
    this.smoke.push({ x: order.x - 1, y: order.y, ttl: 60 });
    this.smoke.push({ x: order.x + 1, y: order.y, ttl: 60 });
  }

  private inArc(fx: number, fy: number, tx: number, ty: number, arc: [number, number]): boolean {
    const twoPi = 2 * Math.PI;
    const norm = (a: number) => ((a % twoPi) + twoPi) % twoPi;
    const angle = norm(Math.atan2(ty - fy, tx - fx));
    const a0 = norm(arc[0]);
    const a1 = norm(arc[1]);
    return a0 <= a1 ? angle >= a0 && angle <= a1 : angle >= a0 || angle <= a1;
  }

  // Enemy within per-weapon-class range (or a team casualty) converts an
  // ambush order to defend and marks this tick for the first-volley bonus.
  private checkAmbushTrigger(team: Team, order: TeamOrder): void {
    const side = this.squads[team.squadId].side;
    const enemySide: Side = side === 'blue' ? 'red' : 'blue';
    let triggered = this.tick - (this.teamLastCasualty[team.id] ?? -Infinity) <= 30;
    outer: for (const sid of team.soldierIds) {
      const s = this.soldiers[sid];
      if (!this.eligible(s)) continue;
      const thresh = ambushThreshold(WEAPONS[s.weapon]);
      for (const e of this.soldiers) {
        if (!e.alive || e.downed || e.side !== enemySide) continue;
        if (order.arc && !this.inArc(s.x, s.y, e.x, e.y, order.arc)) continue;
        const d = Math.hypot(e.x - s.x, e.y - s.y);
        if (d <= thresh && sightBetween(this, s.x, s.y, e.x, e.y).visible) {
          triggered = true;
          break outer;
        }
      }
    }
    if (triggered) {
      order.kind = 'defend';
      team.ambushBonusTick = this.tick;
    }
  }

  // Shift-click: append a waypoint; dispatches immediately if the squad is idle.
  queueMove(squadId: number, wx: number, wy: number): void {
    if (!this.squads[squadId]) return;
    if (!this.squadDest[squadId] && (this.squadWaypoints[squadId] ?? []).length === 0) {
      this.dispatchSquadTo(squadId, wx, wy);
      return;
    }
    (this.squadWaypoints[squadId] ??= []).push({ x: wx, y: wy });
  }

  // Squad-level broadcast: fans out to each member team, offsetting
  // destinations by team index x 8m so a multi-team squad doesn't stack.
  private dispatchSquadTo(squadId: number, wx: number, wy: number): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    this.squadDest[squadId] = { x: wx, y: wy };
    const n = squad.teamIds.length;
    squad.teamIds.forEach((teamId, ti) => {
      const oy = (ti - (n - 1) / 2) * 8;
      this.orderMove(teamId, wx, wy + oy);
    });
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
    this.stepSmoke();
    this.stepOrders();
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
      if (next) this.dispatchSquadTo(sq.id, next.x, next.y);
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

  private stepSmoke(): void {
    if (this.smoke.length === 0) return;
    for (const p of this.smoke) p.ttl -= DT;
    this.smoke = this.smoke.filter((p) => p.ttl > 0);
  }

  // Continues in-flight team orders: bounding leg alternation, sneak-break,
  // and ambush trigger detection. Runs before soldiers act this tick so a
  // trigger/break this tick is reflected in this same tick's combat.
  private stepOrders(): void {
    for (const team of this.teams) {
      const order = team.orderState.order;
      if (!order) continue;
      const st = team.orderState;
      if (st.phase === 'balked') continue;
      if (order.kind === 'move' && (st.phase === 'bounding_a' || st.phase === 'bounding_b')) {
        this.continueBounding(team, order, st);
      } else if ((order.kind === 'move' || order.kind === 'fast' || order.kind === 'sneak') && st.phase === 'executing') {
        const eligibleIds = team.soldierIds.filter((id) => this.eligible(this.soldiers[id]));
        if (eligibleIds.length > 0 && eligibleIds.every((id) => !this.soldiers[id].path)) {
          st.order = null;
          st.phase = 'idle';
          st.reason = '';
        }
      }
      if (order.kind === 'sneak') this.checkSneakBreak(team);
      else if (order.kind === 'ambush') this.checkAmbushTrigger(team, order);
    }
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
        if (d < 30 && sightBetween(this, v.x, v.y, s.x, s.y).visible) {
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
        if (d <= def.gunRange && d < bestD && sightBetween(this, v.x, v.y, e.x, e.y).visible) {
          bestD = d;
          v.targetVehicleId = e.id;
        }
      }
    }
    if (v.targetVehicleId >= 0 && v.gunCooldown <= 0) {
      const e = this.vehicles[v.targetVehicleId];
      if (e.alive && sightBetween(this, v.x, v.y, e.x, e.y).visible) {
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
      if (!sightBetween(this, v.x, v.y, t.x, t.y).visible) {
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
        this.fireVehicleMg(v.x, v.y, hullMg, t, false);
        v.mgCooldown = WEAPONS[hullMg].cooldown * (0.85 + this.rng.next() * 0.3);
      }
    }
  }

  // `arc` restricts candidates to a facing sector (defend/ambush: spec's
  // "members only acquire targets inside arc").
  private acquireSoldierTarget(x: number, y: number, side: Side, range: number, arc?: [number, number]): number {
    const candidates: { id: number; d: number }[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.side === side || e.inVehicle >= 0) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= range) candidates.push({ id: e.id, d });
    }
    candidates.sort((a, b) => a.d - b.d || a.id - b.id);
    for (const c of candidates) {
      const e = this.soldiers[c.id];
      if (arc && !this.inArc(x, y, e.x, e.y, arc)) continue;
      if (sightBetween(this, x, y, e.x, e.y).visible) return c.id;
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
    const sight = sightBetween(this, fx, fy, t.x, t.y);
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
  private resolveSmallArmsShot(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean, aim: number): { fired: boolean; kill: boolean } {
    const p = this.shotPreview(fx, fy, weapon, t, shooterMoving, aim);
    if (!p.visible) return { fired: false, kill: false };
    const w = WEAPONS[weapon];
    const hit = this.rng.next() < p.acc;
    let kill = false;
    if (hit) kill = this.wound(t, this.rng.range(w.damage[0], w.damage[1]));
    this.suppressAround(t.x, t.y, t.side, w.suppression);
    this.pendingEvents.push({ fx, fy, tx: t.x, ty: t.y, hit, kill });
    return { fired: true, kill };
  }

  // Vehicle hull MGs: unlimited ammo — no vehicle ammo model until Task 10.
  private fireVehicleMg(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean): boolean {
    return this.resolveSmallArmsShot(fx, fy, weapon, t, shooterMoving, 1).kill;
  }

  // Infantry small-arms fire: consumes the shooter's mag and builds barrel heat.
  private fireSmallArms(shooter: Soldier, t: Soldier, shooterMoving: boolean, aim = 1): boolean {
    const r = this.resolveSmallArmsShot(shooter.x, shooter.y, shooter.weapon, t, shooterMoving, aim);
    if (!r.fired) return false;
    shooter.magLeft--;
    const w: WeaponDef = WEAPONS[shooter.weapon];
    if (w.heat) shooter.heat = Math.min(1.5, shooter.heat + w.heat.perShot);
    return r.kill;
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
    const order = this.teams[s.teamId].orderState.order;
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
        this.dropKit(s);
        s.path = null;
        s.targetId = -1;
        if (s.task) this.dropTask(s);
      }
      return; // downed men don't act (still bleed; may be dragged)
    }
    if (wasDowned && s.rescuerId >= 0) {
      const r = this.soldiers[s.rescuerId];
      if (r.task?.kind === 'rescue' && r.task.casualtyId === s.id) this.dropTask(r); // he's back up
    }

    // psyche: bonded mates nearby steady the nerves
    let steadying = 0;
    for (const sid of this.squads[s.squadId].soldierIds) {
      const m = this.soldiers[sid];
      if (m.id === s.id || !m.alive || m.downed) continue;
      if (Math.hypot(m.x - s.x, m.y - s.y) < 8) steadying += this.bond(s, m);
    }
    // defend/ambush: suppression bleeds off faster once settled in (not moving)
    const settledDefending = (order?.kind === 'defend' || order?.kind === 'ambush') && !s.path;
    s.suppression = Math.max(0, s.suppression - SUPP_DECAY * (settledDefending ? 1.2 : 1) * (1 + Math.min(steadying, 1.5) * 0.6) * DT);
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

    // rescue / ammo run: a bonded squadmate may pull a casualty out of the
    // fight or ferry belts to a dry gunner
    if (s.task) {
      if (s.task.kind === 'rescue') this.updateRescue(s);
      else this.updateAmmoTask(s);
      return;
    }
    if (s.mental !== 'broken' && (this.tick + s.id) % 60 === 0) {
      this.considerRescue(s);
      this.considerAmmoRunner(s);
      this.considerPickup(s);
    }

    // stamina: recovers when settled and not under heavy fire (drain lives in advance())
    if (!s.path && s.suppression < 0.3) s.stamina = Math.min(1, s.stamina + 0.008 * DT);

    // movement (pinned men hug the ground)
    if (s.path && s.mental !== 'pinned') this.advance(s, this.moveSpeed(s));

    // combat
    if (s.cooldown > 0) s.cooldown -= DT;
    if (s.mental === 'broken') return;

    // reload / barrel-swap / weapon pickup: soldier services the weapon (or
    // finishes swapping to a dropped one) before firing again
    if (s.reloading > 0) {
      s.reloading = Math.max(0, s.reloading - DT);
      if (s.reloading === 0) {
        if (s.pickingUp) {
          s.pickingUp = false;
          const myRank = weaponRank(s.weapon);
          const i = this.droppedKit.findIndex(
            (k) => k.side === s.side && weaponRank(k.weapon) > myRank && Math.hypot(k.x - s.x, k.y - s.y) <= 2,
          );
          if (i >= 0) {
            const kit = this.droppedKit[i];
            s.weapon = kit.weapon;
            s.secondary = undefined;
            s.ammo = { ...kit.ammo };
            s.ammoStart = Object.values(kit.ammo).reduce((a: number, n) => a + (n ?? 0), 0);
            s.magLeft = kit.magLeft;
            s.heat = 0;
            this.droppedKit.splice(i, 1);
          }
        } else {
          if (s.heat >= 1) s.heat = 0;
          if (s.magLeft <= 0) s.magLeft = WEAPONS[s.weapon].ammo.perUnit;
        }
      }
      return;
    }
    const w: WeaponDef = WEAPONS[s.weapon];
    if (w.heat && s.heat >= 1) {
      s.reloading = w.heat.swapTime * this.assistFactor(s);
      return;
    }
    if (s.magLeft <= 0) {
      const type = w.ammo.type;
      if ((s.ammo[type] ?? 0) > 0) {
        s.ammo[type] = (s.ammo[type] ?? 0) - 1;
        s.reloading = w.ammo.reload * this.assistFactor(s);
        if (s.reloading <= 0) s.magLeft = w.ammo.perUnit; // zero-duration reload (panzerfaust) completes at once
        // Garand en-bloc ping: audible tell that the rifle just went dry.
        if (type === 'clip_3006') this.pendingUnitEvents.push({ kind: 'ping', x: s.x, y: s.y, side: s.side, name: s.name });
      } else if (w.oneShot && s.secondary) {
        s.weapon = s.secondary;
        s.secondary = undefined;
        s.magLeft = WEAPONS[s.weapon].ammo.perUnit;
      }
      return; // dry (no ammo, no secondary): holds fire — runner arrives Task 8
    }

    // Order-level fire discipline: sneak and (untriggered) ambush hold fire
    // entirely; fast holds fire only while actually sprinting.
    if (order?.kind === 'sneak' || order?.kind === 'ambush' || (order?.kind === 'fast' && s.path)) return;

    // AT men engage armor first
    if (w.pen !== undefined && s.cooldown <= 0) {
      let bestV: Vehicle | null = null;
      let bestD = Infinity;
      for (const v of this.vehicles) {
        if (!v.alive || v.side === s.side) continue;
        const d = Math.hypot(v.x - s.x, v.y - s.y);
        if (d <= w.range && d < bestD && sightBetween(this, s.x, s.y, v.x, v.y).visible) {
          bestD = d;
          bestV = v;
        }
      }
      if (bestV) {
        this.fireApAt(s.x, s.y, w.pen, w.accuracy * this.aimFactor(s), w.range, bestV, s.path !== null);
        s.magLeft--;
        s.cooldown = w.cooldown * (0.85 + this.rng.next() * 0.3);
        return;
      }
    }

    // Faust carriers: a rifleman with a stashed panzerfaust engages armor too —
    // a one-off item, not a weapon slot, decremented straight from inventory.
    if (w.pen === undefined && (s.ammo.faust ?? 0) > 0 && s.cooldown <= 0) {
      const faust = WEAPONS.panzerfaust;
      let bestV: Vehicle | null = null;
      let bestD = Infinity;
      for (const v of this.vehicles) {
        if (!v.alive || v.side === s.side) continue;
        const d = Math.hypot(v.x - s.x, v.y - s.y);
        if (d <= faust.range && d < bestD && sightBetween(this, s.x, s.y, v.x, v.y).visible) {
          bestD = d;
          bestV = v;
        }
      }
      if (bestV) {
        this.fireApAt(s.x, s.y, faust.pen!, faust.accuracy * this.aimFactor(s), faust.range, bestV, s.path !== null);
        s.ammo.faust!--;
        s.cooldown = faust.cooldown * (0.85 + this.rng.next() * 0.3);
        return;
      }
    }

    if (order?.kind === 'fire' && order.targetId !== undefined) {
      const forced = this.soldiers[order.targetId];
      if (forced.alive && !forced.downed && Math.hypot(forced.x - s.x, forced.y - s.y) <= w.range) s.targetId = order.targetId;
    }
    const t = s.targetId >= 0 ? this.soldiers[s.targetId] : null;
    const targetInvalid = !t || !t.alive || t.downed || Math.hypot(t.x - s.x, t.y - s.y) > w.range;
    if (targetInvalid || (this.tick + s.id) % RETARGET_TICKS === 0) {
      s.targetId = this.acquire(s);
    }
    if (s.targetId >= 0 && s.cooldown <= 0) {
      this.fire(s, this.soldiers[s.targetId]);
    } else if (order?.kind === 'fire' && w.heat && s.cooldown <= 0) {
      // MGs take area suppression at the order's point when no visible target
      this.areaFire(s, order);
    }
  }

  // MG area suppression at a point (no visible individual target): costs
  // ammo/heat like an aimed shot but rolls no hit. Ammo discipline: holds the
  // last belt below 30% of starting reserve.
  private areaFire(s: Soldier, order: TeamOrder): void {
    const w: WeaponDef = WEAPONS[s.weapon];
    const currentUnits = Object.values(s.ammo).reduce((a: number, n) => a + (n ?? 0), 0);
    if (s.ammoStart > 0 && currentUnits / s.ammoStart < 0.3) return;
    const enemySide: Side = s.side === 'blue' ? 'red' : 'blue';
    this.suppressAround(order.x, order.y, enemySide, w.suppression);
    this.pendingEvents.push({ fx: s.x, fy: s.y, tx: order.x, ty: order.y, hit: false, kill: false });
    s.magLeft--;
    if (w.heat) s.heat = Math.min(1.5, s.heat + w.heat.perShot);
    s.cooldown = w.cooldown * (0.85 + this.rng.next() * 0.3);
  }

  private advance(s: Soldier, speed: number): void {
    // walking (0.004/s) unless sprinting under a fast order (0.02/s); load
    // multiplier arrives with Task 9
    const order = this.teams[s.teamId].orderState.order;
    const drainRate = order?.kind === 'fast' ? 0.02 : 0.004;
    s.stamina = Math.max(0, s.stamina - drainRate * DT);
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
      s.task = { kind: 'rescue', casualtyId: c.id, phase: 'goto', timer: 0 };
      s.path = null;
      s.targetId = -1;
      c.rescuerId = s.id;
      return;
    }
  }

  private updateRescue(s: Soldier): void {
    const task = s.task as RescueTask;
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

  // A dry MG gunner (<=1 belt left) flags need; the nearest willing
  // same-squad bearer carrying that ammo type runs it over. Reuses
  // rescueWillingness's bond/courage/suppression formula (same trade-off,
  // different threshold).
  private considerAmmoRunner(s: Soldier): void {
    const w: WeaponDef = WEAPONS[s.weapon];
    if (!w.heat) return; // MG-class only
    if (s.ammoRunnerId >= 0) return; // already coming
    const total = Object.values(s.ammo).reduce((a: number, n) => a + (n ?? 0), 0);
    if (total > 1) return;
    const type = w.ammo.type;
    let best: Soldier | null = null;
    let bestD = Infinity;
    for (const sid of this.squads[s.squadId].soldierIds) {
      const c = this.soldiers[sid];
      if (c.id === s.id || !c.alive || c.downed || c.task) continue;
      if ((c.ammo[type] ?? 0) < 2) continue;
      if (this.rescueWillingness(c, s) < 0.6) continue;
      const d = Math.hypot(c.x - s.x, c.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return;
    best.task = { kind: 'ammo', gunnerId: s.id, phase: 'goto', timer: 0, returnX: best.x, returnY: best.y };
    best.path = null;
    s.ammoRunnerId = best.id;
  }

  private updateAmmoTask(s: Soldier): void {
    const task = s.task as AmmoTask;
    const gunner = this.soldiers[task.gunnerId];
    if (!gunner.alive || gunner.downed) {
      this.dropTask(s);
      return;
    }
    if (task.phase === 'goto') {
      const d = Math.hypot(gunner.x - s.x, gunner.y - s.y);
      if (d > 1.5) {
        if (!s.path) {
          const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(gunner.x), Math.floor(gunner.y));
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
      task.phase = 'transfer';
      task.timer = 3;
      return;
    }
    if (task.phase === 'transfer') {
      task.timer -= DT;
      if (task.timer > 0) return;
      const type = WEAPONS[gunner.weapon].ammo.type;
      const have = s.ammo[type] ?? 0;
      const give = Math.floor(have / 2);
      if (give > 0) {
        s.ammo[type] = have - give;
        gunner.ammo[type] = (gunner.ammo[type] ?? 0) + give;
      }
      gunner.ammoRunnerId = -1;
      task.phase = 'return';
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(task.returnX), Math.floor(task.returnY));
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
      }
      return;
    }
    // return
    if (s.path) {
      this.advance(s, this.moveSpeed(s));
      return;
    }
    s.task = null;
  }

  // Idle soldier within 2m of a same-side dropped kit that outranks his
  // current weapon (mg42/bar/m1919 > smg > rifle > carbine) swaps to it —
  // timed 3s riding the reloading busy-timer, inherits remaining ammo.
  private considerPickup(s: Soldier): void {
    if (s.reloading > 0 || s.pickingUp || s.path) return;
    const myRank = weaponRank(s.weapon);
    for (const kit of this.droppedKit) {
      if (kit.side !== s.side || weaponRank(kit.weapon) <= myRank) continue;
      if (Math.hypot(kit.x - s.x, kit.y - s.y) > 2) continue;
      s.pickingUp = true;
      s.reloading = 3;
      return;
    }
  }

  // On kill/downed: the weapon+ammo a soldier was carrying hits the ground,
  // and both squad- and team-scoped "recent casualty" clocks reset (dangerScore,
  // ambush trigger).
  private dropKit(s: Soldier): void {
    this.droppedKit.push({ side: s.side, x: s.x, y: s.y, weapon: s.weapon, ammo: { ...s.ammo }, magLeft: s.magLeft });
    this.squadLastCasualty[s.squadId] = this.tick;
    this.teamLastCasualty[s.teamId] = this.tick;
  }

  private dropTask(s: Soldier): void {
    if (s.task?.kind === 'rescue') {
      const c = this.soldiers[s.task.casualtyId];
      if (c.rescuerId === s.id) c.rescuerId = -1;
      if (c.carriedBy === s.id) c.carriedBy = -1;
    } else if (s.task?.kind === 'ammo') {
      const g = this.soldiers[s.task.gunnerId];
      if (g.ammoRunnerId === s.id) g.ammoRunnerId = -1;
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
    const order = this.teams[s.teamId].orderState.order;
    const arc = (order?.kind === 'defend' || order?.kind === 'ambush') ? order.arc : undefined;
    return this.acquireSoldierTarget(s.x, s.y, s.side, WEAPONS[s.weapon].range, arc);
  }

  private fire(s: Soldier, t: Soldier): void {
    if (!sightBetween(this, s.x, s.y, t.x, t.y).visible) {
      s.targetId = -1;
      return;
    }
    const w = WEAPONS[s.weapon];
    const team = this.teams[s.teamId];
    const order = team.orderState.order;
    let aim = this.aimFactor(s);
    // pre-registered arc: +0.1 accuracy, approximated as a proportional aim
    // bump (shotPreview's public formula has no additive-accuracy hook)
    if (order && (order.kind === 'defend' || order.kind === 'ambush') && order.arc && this.inArc(s.x, s.y, t.x, t.y, order.arc)) {
      aim *= 1.25;
    }
    if (order?.kind === 'defend' && team.ambushBonusTick === this.tick) aim *= 1.3; // ambush's first-volley bonus
    const kill = this.fireSmallArms(s, t, s.path !== null, aim);
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
    if (t.inVehicle < 0) {
      this.pendingUnitEvents.push({ kind: 'kia', x: t.x, y: t.y, side: t.side, name: t.name });
      this.dropKit(t);
    }
    t.alive = false;
    t.path = null;
    t.downed = false;
    if (t.task) this.dropTask(t);
    if (t.rescuerId >= 0) {
      const r = this.soldiers[t.rescuerId];
      if (r.task?.kind === 'rescue' && r.task.casualtyId === t.id) this.dropTask(r);
    }
    if (t.ammoRunnerId >= 0) {
      const r = this.soldiers[t.ammoRunnerId];
      if (r.task?.kind === 'ammo' && r.task.gunnerId === t.id) this.dropTask(r);
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
        s.task ? (s.task.kind === 'rescue' ? `rescue:${s.task.phase}:${s.task.casualtyId}` : `ammo:${s.task.phase}:${s.task.gunnerId}`) : '',
        s.stabilized,
        s.magLeft,
        s.reloading > 0,
        Math.round(s.heat * 1e6),
        Object.values(s.ammo).reduce((a: number, n) => a + (n ?? 0), 0),
        Math.round(s.stamina * 1e6),
        s.ammoRunnerId,
        s.pickingUp,
        s.weapon,
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
      teams: this.teams.map((t) => [t.id, t.orderState.phase, t.orderState.order?.kind ?? '', t.smokeLeft, t.ambushBonusTick]),
      smoke: this.smoke.map((p) => [Math.round(p.x * 1e6), Math.round(p.y * 1e6), Math.round(p.ttl * 1e6)]),
      droppedKit: this.droppedKit.map((k) => [
        k.side,
        Math.round(k.x * 1e6),
        Math.round(k.y * 1e6),
        k.weapon,
        Object.values(k.ammo).reduce((a: number, n) => a + (n ?? 0), 0),
        k.magLeft,
      ]),
    });
  }
}
