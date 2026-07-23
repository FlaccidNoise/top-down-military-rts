import { applyHit, capacities, consciousness, freshBody, rollPart, woundLabel, type Wound } from './body';
import {
  DE_NAMES,
  EMPLACEMENT_CREW,
  EMPLACEMENTS,
  LOADS,
  SQUADS,
  TEAMS,
  US_NAMES,
  VEHICLES,
  WEAPONS,
  type AmmoKey,
  type EmplacementDef,
  type EmplacementKey,
  type LoadKey,
  type Role,
  type SoldierSlot,
  type SquadKey,
  type VehicleDef,
  type VehicleKey,
  type WeaponDef,
  type WeaponKey,
} from './data';
import { crewDegrade, crewHasLos, crewNear, friendlyHasLos, loadsReady, pickFirer, type Emplacement } from './emplacement';
import { GameMap, los, type LosResult } from './map';
import type { Building } from './mapgen';
import { ambushThreshold, ASSAULT_DANGER_MULT, BALK_REASON, CHARGE_BALK_REASON, compliance, dangerScore, type OrderState, type TeamOrder } from './orders';
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
// Melee (decision log 2026-07-23): proximity-triggered close combat.
const MELEE_ENGAGE = 2.0; // m — an enemy this close (and reachable on foot) locks both into melee
const MELEE_CONTACT = 0.9; // m — combatants close to here, then hold
export const MELEE_STRIKE_RANGE = 1.3; // m — strikes only land inside this (renderer keys the pose off it)
const MELEE_BREAK = 2.5; // m — an opponent past this has gotten away
const MELEE_INTERVAL = 1.4; // s between strikes, jittered per swing
// Assault order: enemies within this of the order point are the objective's
// defenders — the charge redirects onto them and completes when none remain visible.
const ASSAULT_RADIUS = 20; // m
const ASSAULT_REPATH_TICKS = 15; // per-soldier redirect cadence (0.5 s)
// SMGs with rounds left fight melee by shooting from the hip — their CQC
// edge over the bayonet, paid for in ammo. (Sim-side twin of dudes.ts's
// SMG_CLASS silhouette bucket; data.ts has no weapon-class field.)
const MELEE_SMG: ReadonlySet<WeaponKey> = new Set(['thompson', 'mp40']);

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

// Role succession (spec: casualty-chain.md "In-battle role succession"): a
// crew weapon belongs to its slot, not the man. Trigger fills the gap
// automatically — goto the weapon's position, a timed 3s swap, inherit
// weapon + remaining ammo + role 'gunner'. Covers both a personally-held
// squad MG (empId -1, weapon picked up from the dropped kit it left behind)
// and an Emplacement crew slot (empId >= 0, the gun never moves — pickFirer
// already keeps it firing meanwhile; this task is the formal hand-off).
export interface TakeOverTask {
  kind: 'takeOver';
  empId: number;
  weapon: WeaponKey;
  ammo: Partial<Record<AmmoKey, number>>;
  magLeft: number;
  x: number;
  y: number;
  phase: 'goto' | 'swap';
  timer: number;
}

export type CrewClass = 'mg' | 'mortar' | 'gun' | 'vehicle';

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
  crewSkill: Partial<Record<CrewClass, number>>; // 0..1, grows +0.0005/shot serving that weapon class
  // action
  path: { x: number; y: number }[] | null;
  pathI: number;
  cooldown: number;
  targetId: number; // -1 = none
  fleeing: boolean;
  task: RescueTask | AmmoTask | TakeOverTask | null;
  rescuerId: number; // who claimed this casualty, -1 none
  carriedBy: number; // -1 = not being dragged
  helperId: number; // second bearer on a two-man carry, -1 = solo/none
  ammoRunnerId: number; // runner already en route to resupply this soldier, -1 none
  pickingUp: boolean; // mid weapon-pickup timer (rides `reloading`)
  inVehicle: number; // vehicle id crewing, -1 = on foot
  inEmplacement: number; // emplacement id crewing, -1 = none
  carries: LoadKey[]; // emplacement loads on his back (Task 4's speedCap/staminaMult factor)
  mountTarget: number; // vehicle id he's walking to board, -1 = none
  // melee: who he's fighting hand-to-hand (-1 = none; several attackers may
  // point at one victim — the victim strikes back at whoever engaged him first)
  meleeId: number;
  meleePhase: number; // 0..1 strike cycle, advances only in strike range; strike lands at wrap
  meleeTempo: number; // cycles/s, re-jittered each swing
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
  ammo: { ap: number; he: number };
  passengerTeamIds: number[];
  turning: boolean; // rotating a restricted-arc turret (StuG) toward a target instead of firing
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
  carries?: LoadKey[];
  crewSkill?: Partial<Record<CrewClass, number>>;
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
  weapon?: WeaponKey; // render-only: lets the audio layer pick a per-weapon report. Undefined = vehicle cannon/AP (paired with a boom anyway).
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

// One melee swing landing (or whiffing) at the victim — drives the
// renderer's impact feedback, same consume-queue shape as ShotEvent.
// Fighter ids let the renderer gate FX/decals through the *VisibleTo helpers.
export interface MeleeEvent {
  attackerId: number;
  victimId: number;
  x: number;
  y: number;
  hit: boolean;
  kill: boolean;
}

export interface ShotPreview {
  visible: boolean;
  dist: number;
  cover: number; // effective cover incl. pinned/downed hug-the-ground bonus
  acc: number;
  concealed?: boolean; // invisible because sneaking behind concealment, not because LOS is blocked
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
  load?: LoadKey; // present for an emplacement load dropped by a downed/killed bearer
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

// Which crewSkill class a weapon trains (spec: mg/mortar/gun/vehicle — the
// 'vehicle' class is reserved for a future vehicle-crew succession pass and
// never accrued/applied by this milestone).
function crewClassOf(w: WeaponDef): CrewClass | null {
  if (w.heat) return 'mg';
  if (w.arc) return 'mortar';
  if (w.pen !== undefined) return 'gun';
  return null;
}

// Formation offsets around a squad destination, meters. Exported for the
// move-order cover preview, which must show the real spots men will take.
export const OFFSETS = [
  [0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
  [2.2, 1.5], [-2.2, 1.5], [2.2, -1.5], [-2.2, -1.5], [0, 3],
];

function isOpenTop(kind: VehicleKey): boolean {
  const def: VehicleDef = VEHICLES[kind];
  return def.openTop === true;
}

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
  if (opacity >= 1) return { visible: false, cover: 0, conceal: 1 };
  if (opacity > 0) {
    return { visible: true, cover: Math.min(0.95, base.cover + opacity * 0.4), conceal: Math.min(1, base.conceal + opacity) };
  }
  return base;
}

// Sight to a soldier: sightBetween plus the spotting rule that completes the
// sneak and ambush orders — a hiding target (sneaking, or lying in untriggered
// ambush) with >= 0.5 accumulated concealment (one hedge, two woods tiles, or
// a smoke puff on the ray) is unseen beyond 20m. An ambush trigger converts
// the order to defend, so the first volley reveals the position. Deterministic,
// no RNG. Every soldier-target sense (acquire, live fire, ambush trigger,
// honest vision, fog-of-war spotting) routes through this; sight to a map
// point stays on sightBetween.
export function sightToSoldier(sim: Sim, x0: number, y0: number, t: Soldier): LosResult {
  const sight = sightBetween(sim, x0, y0, t.x, t.y);
  const order = sim.teams[t.teamId].orderState.order;
  if (
    sight.visible &&
    sight.conceal >= 0.5 &&
    (order?.kind === 'sneak' || order?.kind === 'ambush') &&
    Math.hypot(t.x - x0, t.y - y0) > 20
  ) {
    return { visible: false, cover: 0, conceal: sight.conceal, concealed: true };
  }
  return sight;
}

// --- Fog of war: per-side spotting (the intel layer) ---
// visibleEnemies (orders.ts) answers "who can we engage right now"
// (weapon-range-bound, drives the danger model); this layer answers "who do
// we know about" (SPOT_RANGE-bound, drives what the player and future AI
// intel see). Both look through sightToSoldier, so concealment hides from
// intel too. Recomputed on a cadence in step(); deterministic (no RNG) and
// never read back by sim behavior.
export const SPOT_INTERVAL = 15; // ticks: 0.5 s between spotting sweeps
const SPOT_RANGE = 200; // m — beyond every small-arms range
export const CONTACT_TTL = 45 * 30; // ticks a last-known ghost lingers

export interface Contact {
  kind: 'infantry' | 'vehicle';
  x: number;
  y: number;
  tick: number;
}

export class Sim {
  tick = 0;
  rng: Rng;
  buildings: Building[] = []; // set by the scenario from the map plan; render + placement data
  soldiers: Soldier[] = [];
  squads: Squad[] = [];
  teams: Team[] = [];
  vehicles: Vehicle[] = [];
  emplacements: Emplacement[] = [];
  winner: Side | null = null;
  // fog of war (see the module comment above Contact). fowDisabled is a
  // dev/staging escape hatch read ONLY by the *VisibleTo helpers, never by
  // step() — flipping it can never change sim outcomes.
  fowDisabled = false;
  // spotted maps carry the last position a spotter actually saw, so a lost
  // contact ghosts where he was last SEEN, not where he secretly is now
  spotted: Record<Side, Map<number, { x: number; y: number }>> = { blue: new Map(), red: new Map() };
  spottedVehicles: Record<Side, Map<number, { x: number; y: number }>> = { blue: new Map(), red: new Map() };
  seenStatic: Record<Side, Set<string>> = { blue: new Set(), red: new Set() }; // corpses s{id}, wrecks v{id}, emplacements e{id} — permanent once seen
  contacts: Record<Side, Map<string, Contact>> = { blue: new Map(), red: new Map() };
  barragesLeft: Record<Side, number> = { blue: 2, red: 1 };
  airstrikesLeft: Record<Side, number> = { blue: 1, red: 0 };
  startStrength: Record<Side, number> = { blue: 0, red: 0 };
  private barrages: Barrage[] = [];
  private strafeImpacts: { tick: number; x: number; y: number }[] = [];
  private pendingEvents: ShotEvent[] = [];
  private pendingBooms: { x: number; y: number }[] = [];
  private pendingPlanes: { x0: number; y: number; x1: number }[] = [];
  private pendingUnitEvents: UnitEvent[] = [];
  private pendingMeleeEvents: MeleeEvent[] = [];
  // Per-squad move state, indexed by squad id. Read-only for the UI (route preview).
  squadDest: ({ x: number; y: number } | null)[] = [];
  squadWaypoints: { x: number; y: number }[][] = [];
  smoke: Smoke[] = [];
  droppedKit: DroppedKit[] = [];
  // Recent-casualty flags for dangerScore/ambush triggers, indexed by squad/team id.
  squadLastCasualty: number[] = [];
  teamLastCasualty: number[] = [];
  private sneakBaseline: number[] = []; // per-team wound count when a sneak order started
  private leaderVacantSince = new Map<number, number>(); // teamId -> tick its leader died, pending the 10s promotion
  // Mortar rounds in flight: 3s from trigger to impact (spec: indirect fire).
  private mortarShells: { tick: number; x: number; y: number; smoke: boolean }[] = [];
  // Staggered dismount: one passenger every 0.5s (spec: "1 per 0.5s").
  private dismountQueue: { vehicleId: number; soldierId: number; tick: number }[] = [];

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
      crewSkill: m.crewSkill ?? {},
      path: null,
      pathI: 0,
      cooldown: 0,
      targetId: -1,
      fleeing: false,
      task: null,
      rescuerId: -1,
      carriedBy: -1,
      helperId: -1,
      ammoRunnerId: -1,
      pickingUp: false,
      inVehicle: -1,
      inEmplacement: -1,
      carries: m.carries ? [...m.carries] : [],
      mountTarget: -1,
      meleeId: -1,
      meleePhase: 0,
      meleeTempo: 0,
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
  addSquadFromDef(side: Side, key: SquadKey, x: number, y: number, roster?: Partial<MemberInit>[][]): Squad {
    const def = SQUADS[key];
    const names = side === 'blue' ? US_NAMES : DE_NAMES;
    const squad: Squad = { id: this.squads.length, side, name: def.name, soldierIds: [], teamIds: [] };
    this.squads.push(squad);
    const n = def.teams.length;
    def.teams.forEach((teamKey, ti) => {
      const teamDef = TEAMS[teamKey];
      const cy = y + (ti - (n - 1) / 2) * 8; // fan teams out so a multi-team squad doesn't stack
      // A passed roster is authoritative: this team spawns exactly its roster
      // entries (campaign attrition), not the full establishment. No roster
      // (or no entry for this team) means full establishment, unchanged.
      const teamRoster = roster?.[ti];
      const slots = teamRoster ? teamDef.slots.slice(0, teamRoster.length) : teamDef.slots;
      const entries = slots.map((slot: SoldierSlot, si) => {
        const ov = teamRoster?.[si];
        // rng draws keep their original order (name, x, y) and stay conditional
        // on each override (?? short-circuit) — determinism depends on both
        const name = ov?.name ?? names[this.rng.int(names.length)];
        const sx = ov?.x ?? x + this.rng.range(-3, 3);
        const sy = ov?.y ?? cy + this.rng.range(-3, 3);
        const pos = this.nudgeSpawn(sx, sy);
        const member: MemberInit = {
          name,
          weapon: ov?.weapon ?? slot.weapon,
          x: pos.x,
          y: pos.y,
          courage: ov?.courage,
          xp: ov?.xp,
          bodyDamage: ov?.bodyDamage,
          pid: ov?.pid,
          ammo: ov?.ammo ?? { ...slot.ammo },
          secondary: ov?.secondary,
          carries: ov?.carries ?? (slot.carries ? [...slot.carries] : []),
          crewSkill: ov?.crewSkill,
        };
        return { role: slot.role, member };
      });
      this.spawnTeam(squad, teamDef.name, entries);
    });
    this.bondSquad(squad);
    return squad;
  }

  // Spawn safety: expanding-ring walk (no rng) to the nearest passable tile,
  // so squads anchored beside water (bridge posts) never start in the river.
  // Keeps the fractional part of the position; no-op on fully passable ground.
  private nudgeSpawn(x: number, y: number): { x: number; y: number } {
    const tx = Math.round(x);
    const ty = Math.round(y);
    if (this.map.terrainAt(tx, ty).passable) return { x, y };
    for (let r = 1; r <= 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          // inBounds first: terrainAt returns passable grass for OOB coords
          if (this.map.inBounds(tx + dx, ty + dy) && this.map.terrainAt(tx + dx, ty + dy).passable)
            return { x: x + dx, y: y + dy };
        }
    return { x, y };
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
      else if (order?.kind === 'assault') speed *= 1.4; // weapons up, moving hard
      else if (order?.kind === 'sneak') speed *= 0.35;
    }
    if (s.carries.length > 0) speed = Math.min(speed, Math.min(...s.carries.map((l) => LOADS[l].speedCap)));
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

  // Crew-served competency penalty (spec: "a rifleman on the MG42 suffers
  // accuracy... penalties; an assistant who's served three battles is
  // qualified"): whoever is NOT the weapon's designated 'gunner' aims worse,
  // scaled back toward 1 as his crewSkill for that class grows from use.
  // `w` is the weapon actually being served (soldier-held or emplaced), not
  // necessarily `s.weapon` — callers pass the right one.
  crewAimMult(s: Soldier, w: WeaponDef): number {
    if (!w.heat || s.role === 'gunner') return 1;
    return 0.7 + 0.3 * (s.crewSkill.mg ?? 0);
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
      ammo: { ...def.ammo },
      passengerTeamIds: [],
      turning: false,
    };
    for (const sid of squad.soldierIds) this.soldiers[sid].inVehicle = v.id;
    this.vehicles.push(v);
    return v;
  }

  private passengerCount(v: Vehicle): number {
    let n = 0;
    for (const tid of v.passengerTeamIds) {
      for (const sid of this.teams[tid].soldierIds) if (this.soldiers[sid].inVehicle === v.id) n++;
    }
    return n;
  }

  // Team paths to the vehicle and boards within 2m (Soldier.mountTarget,
  // resolved in updateSoldier). Whole-team boarding only — refuses if the
  // team wouldn't all fit in the remaining seats.
  orderMount(teamId: number, vehicleId: number): void {
    const team = this.teams[teamId];
    const v = this.vehicles[vehicleId];
    if (!team || !v || !v.alive) return;
    const def: VehicleDef = VEHICLES[v.kind];
    if (def.seats === undefined) return;
    const eligibleIds = team.soldierIds.filter((id) => this.eligible(this.soldiers[id]) && this.soldiers[id].inVehicle < 0);
    if (eligibleIds.length === 0) return;
    if (this.passengerCount(v) + eligibleIds.length > def.seats) return;
    if (!v.passengerTeamIds.includes(teamId)) v.passengerTeamIds.push(teamId);
    // Straight to the vehicle itself, not moveSoldiersTo's OFFSETS-fanned
    // formation spots (up to 3m out — well past the 2m boarding radius,
    // which would strand a soldier assigned the widest offset).
    for (const id of eligibleIds) {
      const s = this.soldiers[id];
      if (s.task) this.dropTask(s);
      s.path = null; // (re)path fresh toward the vehicle in updateSoldier
      s.mountTarget = v.id;
    }
  }

  // Dismount-under-fire runs the Task 6 compliance check per passenger team
  // (dest = the vehicle's own position, i.e. "the exposure of getting out
  // here"): a balk keeps that team mounted. Complying teams disembark via
  // findSpot in a ring, staggered 1 soldier per 0.5s (dismountQueue).
  orderDismount(vehicleId: number): void {
    const v = this.vehicles[vehicleId];
    if (!v) return;
    for (const teamId of v.passengerTeamIds) {
      const team = this.teams[teamId];
      const aboard = team.soldierIds.filter((id) => this.soldiers[id].inVehicle === v.id && this.soldiers[id].alive);
      if (aboard.length === 0) continue;
      const danger = dangerScore(this, team, { x: v.x, y: v.y });
      if (compliance(this, team, danger) === 'balk') {
        team.orderState = { order: null, phase: 'balked', reason: BALK_REASON };
        continue;
      }
      team.orderState = { order: null, phase: 'idle', reason: '' };
      aboard.forEach((sid, i) => this.dismountQueue.push({ vehicleId: v.id, soldierId: sid, tick: this.tick + i * 15 }));
    }
    v.passengerTeamIds = v.passengerTeamIds.filter((tid) => this.teams[tid].soldierIds.some((id) => this.soldiers[id].inVehicle === v.id));
  }

  private stepDismounts(): void {
    if (this.dismountQueue.length === 0) return;
    const used = new Set<number>();
    this.dismountQueue = this.dismountQueue.filter((d) => {
      if (this.tick < d.tick) return true;
      const s = this.soldiers[d.soldierId];
      const v = this.vehicles[d.vehicleId];
      if (s.inVehicle === d.vehicleId && v) {
        const spot = this.findSpot(Math.floor(v.x), Math.floor(v.y), used);
        if (spot) used.add(spot.y * this.map.w + spot.x);
        s.inVehicle = -1;
        s.x = (spot?.x ?? v.x) + 0.5;
        s.y = (spot?.y ?? v.y) + 0.5;
      }
      return false;
    });
  }

  // Wheeled/towable emplacement + towHook vehicle, adjacent, gun limbered
  // (packed): hitches on. Towed emplacements can't deploy (Sim.orderDeploy).
  orderHitch(vehicleId: number, empId: number): void {
    const v = this.vehicles[vehicleId];
    const e = this.emplacements[empId];
    if (!v || !v.alive || !e || e.state !== 'packed' || e.towedBy >= 0) return;
    const def: VehicleDef = VEHICLES[v.kind];
    const edef: EmplacementDef = EMPLACEMENTS[e.kind];
    if (!def.towHook || !edef.towable) return;
    if (Math.hypot(v.x - e.x, v.y - e.y) > 4) return;
    e.towedBy = v.id;
    e.moveTarget = null;
  }

  // Drops the gun at the tow vehicle's rear.
  orderUnhitch(empId: number): void {
    const e = this.emplacements[empId];
    if (!e || e.towedBy < 0) return;
    const v = this.vehicles[e.towedBy];
    e.towedBy = -1;
    if (v) {
      e.x = v.x - Math.cos(v.facing) * 3;
      e.y = v.y - Math.sin(v.facing) * 3;
    }
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

  // Crewed weapon (spec §4): spawns the matching crew squad (EMPLACEMENT_CREW)
  // and binds its one team to a new Emplacement, same shape as addVehicle's
  // crew binding. Crew are snapped onto tight (<=3m) formation offsets so
  // they start well inside CREW_RADIUS instead of addSquadFromDef's wider scatter.
  addEmplacement(side: Side, kind: EmplacementKey, x: number, y: number, facing = 0, initialState: 'packed' | 'deployed' = 'packed'): Emplacement {
    const def: EmplacementDef = EMPLACEMENTS[kind];
    const squad = this.addSquadFromDef(side, EMPLACEMENT_CREW[kind], x, y);
    const crewTeamId = squad.teamIds[0];
    const e: Emplacement = {
      id: this.emplacements.length,
      side,
      kind,
      x,
      y,
      facing,
      state: initialState,
      timer: 0,
      crewTeamId,
      loadsPresent: [...def.loads],
      cooldown: 0,
      heat: 0,
      towedBy: -1,
      targetX: x,
      targetY: y,
      hasTarget: false,
      smokeRoundsLeft: 0,
      moveTarget: null,
    };
    this.teams[crewTeamId].soldierIds.forEach((sid, i) => {
      const [ox, oy] = OFFSETS[i % OFFSETS.length];
      const s = this.soldiers[sid];
      s.x = x + ox;
      s.y = y + oy;
      s.inEmplacement = e.id;
    });
    this.emplacements.push(e);
    return e;
  }

  // Deploy requires all def.loads within CREW_RADIUS (carried or dropped
  // there) and crew >= minCrew; runs setupTime. Towed guns can't deploy.
  orderDeploy(empId: number): void {
    const e = this.emplacements[empId];
    if (!e || e.state !== 'packed' || e.towedBy >= 0) return;
    const def: EmplacementDef = EMPLACEMENTS[e.kind];
    if (crewNear(this, e).length < def.minCrew) return;
    if (!loadsReady(this, e)) return;
    e.state = 'deploying';
    e.timer = def.setupTime;
  }

  orderPack(empId: number): void {
    const e = this.emplacements[empId];
    if (!e || e.state !== 'deployed' || crewNear(this, e).length === 0) return;
    e.state = 'packing';
    e.timer = EMPLACEMENTS[e.kind].packTime;
  }

  // Wheeled AT guns only: crew pushes the gun at wheeled.speed while packed
  // (not hitched, not deployed).
  orderWheel(empId: number, wx: number, wy: number): void {
    const e = this.emplacements[empId];
    if (!e || e.state !== 'packed' || e.towedBy >= 0) return;
    const def: EmplacementDef = EMPLACEMENTS[e.kind];
    if (!def.wheeled) return;
    e.moveTarget = { x: wx, y: wy };
  }

  // Mortar-only (arc weapons): sets the indirect-fire HE point. Any point a
  // friendly currently sees is a valid call (spec §4/§6's shared-vision rule) —
  // range/spotter eligibility is re-checked every tick in updateEmplacement.
  orderFire(empId: number, x: number, y: number): void {
    const e = this.emplacements[empId];
    if (!e) return;
    const w: WeaponDef = WEAPONS[EMPLACEMENTS[e.kind].weapon];
    if (!w.arc) return;
    e.targetX = x;
    e.targetY = y;
    e.hasTarget = true;
  }

  // Mortar-only: a 4-round smoke screen at the point, consuming shells —
  // sustained coverage the rifle-squad smoke grenades can't match.
  orderSmoke(empId: number, x: number, y: number): void {
    const e = this.emplacements[empId];
    if (!e) return;
    const w: WeaponDef = WEAPONS[EMPLACEMENTS[e.kind].weapon];
    if (!w.arc) return;
    e.targetX = x;
    e.targetY = y;
    e.hasTarget = true;
    e.smokeRoundsLeft = 4;
  }

  private stepEmplacements(): void {
    for (const e of this.emplacements) this.updateEmplacement(e);
    if (this.mortarShells.length === 0) return;
    this.mortarShells = this.mortarShells.filter((sh) => {
      if (this.tick < sh.tick) return true;
      if (sh.smoke) this.smoke.push({ x: sh.x, y: sh.y, ttl: 60 });
      else this.explode(sh.x, sh.y, { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 75] });
      return false;
    });
  }

  private updateEmplacement(e: Emplacement): void {
    const def: EmplacementDef = EMPLACEMENTS[e.kind];
    if (e.towedBy >= 0) {
      const v = this.vehicles[e.towedBy];
      if (!v || !v.alive) {
        e.towedBy = -1;
      } else {
        e.x = v.x - Math.cos(v.facing) * 3;
        e.y = v.y - Math.sin(v.facing) * 3;
        e.facing = v.facing;
        for (const sid of this.teams[e.crewTeamId].soldierIds) {
          const s = this.soldiers[sid];
          if (s.alive) {
            s.x = e.x;
            s.y = e.y;
            s.path = null;
          }
        }
        return; // can't deploy or fire while hitched
      }
    }
    if (e.moveTarget) {
      // Crew pushes the gun by hand — nobody left near it, it stops rolling,
      // same pause convention as the deploy/pack timer below.
      if (crewNear(this, e).length > 0) {
        const dx = e.moveTarget.x - e.x;
        const dy = e.moveTarget.y - e.y;
        const d = Math.hypot(dx, dy);
        const step = (def.wheeled?.speed ?? 0) * DT;
        if (d <= step || d < 0.05) {
          e.x = e.moveTarget.x;
          e.y = e.moveTarget.y;
          e.moveTarget = null;
        } else {
          e.x += (dx / d) * step;
          e.y += (dy / d) * step;
          e.facing = Math.atan2(dy, dx);
        }
      }
      for (const sid of this.teams[e.crewTeamId].soldierIds) {
        const s = this.soldiers[sid];
        if (s.alive) {
          s.x = e.x;
          s.y = e.y;
          s.path = null;
        }
      }
    }

    if (e.state === 'deploying' || e.state === 'packing') {
      if (crewNear(this, e).length > 0) e.timer -= DT; // paused with nobody on the gun
      if (e.timer <= 0) {
        e.state = e.state === 'deploying' ? 'deployed' : 'packed';
        e.timer = 0;
      }
    }
    e.loadsPresent = def.loads.filter((l) => crewNear(this, e).some((s) => s.carries.includes(l)));

    if (e.state !== 'deployed') return;
    if (e.cooldown > 0) e.cooldown -= DT;
    const firer = pickFirer(this, e);
    if (!firer || e.cooldown > 0) return;
    const w: WeaponDef = WEAPONS[def.weapon];
    // Same "cowering: slower fire" penalty personal fire() applies (rate =
    // pinned ? 2 : 1), folded into the served-weapon degrade multiplier so
    // every emplacement fire path (heat swap, indirect, AT, small arms)
    // picks it up for free.
    const degrade = crewDegrade(this, e) * (firer.mental === 'pinned' ? 2 : 1);

    // Barrel heat (belt-fed only): forced swap, slower below minCrew — same
    // served-weapon rule that gates every other emplacement fire rate.
    if (w.heat && e.heat >= 1) {
      e.cooldown = w.heat.swapTime * degrade;
      e.heat = 0;
      return;
    }
    if (w.arc) {
      this.fireEmplacementIndirect(e, w, firer, degrade);
      return;
    }
    if (w.pen !== undefined) {
      this.fireEmplacementAt(e, w, firer, degrade);
      return;
    }
    this.fireEmplacementSmallArms(e, def, w, firer, degrade);
  }

  // A crew-served gun draws on the whole crew's carried reserve, not just
  // whichever soldier happens to be pickFirer's pick this tick — that's what
  // ammo bearers are for. Tries the firer's own stock first, then the
  // nearest other crewman's.
  private consumeEmplacementAmmo(e: Emplacement, firer: Soldier, type: AmmoKey): boolean {
    if ((firer.ammo[type] ?? 0) > 0) {
      firer.ammo[type] = firer.ammo[type]! - 1;
      return true;
    }
    for (const s of crewNear(this, e)) {
      if (s.id === firer.id) continue;
      if ((s.ammo[type] ?? 0) > 0) {
        s.ammo[type] = s.ammo[type]! - 1;
        return true;
      }
    }
    return false;
  }

  private fireEmplacementIndirect(e: Emplacement, w: WeaponDef, firer: Soldier, degrade: number): void {
    if (!e.hasTarget) return;
    const arc = w.arc!;
    const d = Math.hypot(e.targetX - e.x, e.targetY - e.y);
    if (d < arc.minRange || d > w.range) return;
    if (!friendlyHasLos(this, e.side, e.targetX, e.targetY)) return;
    const smoke = e.smokeRoundsLeft > 0;
    if (!this.consumeEmplacementAmmo(e, firer, w.ammo.type)) return;
    firer.crewSkill.mortar = Math.min(1, (firer.crewSkill.mortar ?? 0) + 0.0005);
    const scatter = crewHasLos(this, e, e.targetX, e.targetY) ? arc.scatter : arc.scatterNoLos;
    const angle = this.rng.next() * Math.PI * 2;
    const dist = this.rng.next() * scatter;
    this.mortarShells.push({ tick: this.tick + 90, x: e.targetX + Math.cos(angle) * dist, y: e.targetY + Math.sin(angle) * dist, smoke });
    e.cooldown = w.cooldown * degrade;
    if (smoke) {
      e.smokeRoundsLeft--;
      if (e.smokeRoundsLeft <= 0) e.hasTarget = false;
    }
  }

  private fireEmplacementAt(e: Emplacement, w: WeaponDef, firer: Soldier, degrade: number): void {
    let best: Vehicle | null = null;
    let bestD = Infinity;
    for (const v of this.vehicles) {
      if (!v.alive || v.side === e.side) continue;
      const d = Math.hypot(v.x - e.x, v.y - e.y);
      if (d <= w.range && d < bestD && sightBetween(this, e.x, e.y, v.x, v.y).visible) {
        bestD = d;
        best = v;
      }
    }
    if (!best) return;
    if (!this.consumeEmplacementAmmo(e, firer, w.ammo.type)) return;
    firer.crewSkill.gun = Math.min(1, (firer.crewSkill.gun ?? 0) + 0.0005);
    this.fireApAt(e.x, e.y, w.pen!, w.accuracy * this.aimFactor(firer), w.range, best, false);
    e.cooldown = w.cooldown * degrade;
  }

  private fireEmplacementSmallArms(e: Emplacement, def: EmplacementDef, w: WeaponDef, firer: Soldier, degrade: number): void {
    const crewTeam = this.teams[e.crewTeamId];
    const order = crewTeam.orderState.order;
    const arc = order?.kind === 'defend' || order?.kind === 'ambush' ? order.arc : undefined;
    const targetId = this.acquireSoldierTarget(e.x, e.y, e.side, w.range, arc);
    if (targetId < 0) return;
    const t = this.soldiers[targetId];
    let aim = this.aimFactor(firer) * this.crewAimMult(firer, w);
    if (arc && this.inArc(e.x, e.y, t.x, t.y, arc)) aim *= 1.25;
    if (order?.kind === 'defend' && crewTeam.ambushBonusTick === this.tick) aim *= 1.3;
    const p = this.shotPreview(e.x, e.y, def.weapon, t, false, aim);
    if (!p.visible) return;
    if (!this.consumeEmplacementAmmo(e, firer, w.ammo.type)) return;
    firer.crewSkill.mg = Math.min(1, (firer.crewSkill.mg ?? 0) + 0.0005);
    const hit = this.rng.next() < p.acc;
    const kill = hit ? this.wound(t, this.rng.range(w.damage[0], w.damage[1])) : false;
    this.suppressAround(t.x, t.y, t.side, w.suppression);
    this.pendingEvents.push({ fx: e.x, fy: e.y, tx: t.x, ty: t.y, hit, kill, weapon: def.weapon });
    if (w.heat) {
      const heatMult = firer.role !== 'gunner' ? 1.5 : 1;
      e.heat = Math.min(1.5, e.heat + w.heat.perShot * heatMult);
    }
    e.cooldown = w.cooldown * degrade * (0.85 + this.rng.next() * 0.3);
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

    // Assault is the scariest ask: same danger evaluation, weighted up before
    // the ladder runs. Checked ONCE — a charge that steps off is committed
    // (no bounding, no per-leg re-check); pinned/broken men drop out via the
    // psych model instead.
    const danger = dangerScore(this, team, { x: order.x, y: order.y }) * (order.kind === 'assault' ? ASSAULT_DANGER_MULT : 1);
    const verdict = compliance(this, team, danger);
    if (verdict === 'balk') {
      team.orderState = { order, phase: 'balked', reason: order.kind === 'assault' ? CHARGE_BALK_REASON : BALK_REASON };
      return;
    }
    const cautious = verdict === 'cautious';
    const effective: TeamOrder =
      cautious && (order.kind === 'fast' || order.kind === 'assault') ? { ...order, kind: 'move' } : order;
    const reason = cautious ? (order.kind === 'assault' ? 'unwilling to charge — advancing instead' : 'moving cautiously') : '';

    if (effective.kind === 'move' && (cautious || this.teamUnderFire(team))) {
      team.orderState = { order: effective, phase: 'bounding_a', reason };
      const [a, b] = this.teamHalves(team);
      for (const id of b) this.soldiers[id].path = null;
      this.dispatchLeg(a, effective);
    } else if (effective.kind === 'move' || effective.kind === 'fast' || effective.kind === 'sneak' || effective.kind === 'assault') {
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
    const isMoveKind = order.kind === 'move' || order.kind === 'fast' || order.kind === 'sneak' || order.kind === 'assault';
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
  // half holds and fires. Clears the order once arrived. Re-runs the refusal
  // model at each leg alternation (spec: "at each bound/leg") — a fresh balk
  // latches the team in place; it does not oscillate back to comply next
  // tick, matching the top-level order-issuance balk behavior.
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
    const danger = dangerScore(this, team, { x: order.x, y: order.y });
    if (compliance(this, team, danger) === 'balk') {
      st.phase = 'balked';
      st.reason = BALK_REASON;
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
        if (d <= thresh && sightToSoldier(this, s.x, s.y, e).visible) {
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
  // Routes each leg through orderTeam (not the raw orderMove) so the refusal
  // model re-runs at every waypoint leg dispatch (spec: "at each bound/leg")
  // — but, unlike orderSquad, never touches squadWaypoints/squadDest, so a
  // queued route's remaining legs survive a leg that balks or advances.
  private dispatchSquadTo(squadId: number, wx: number, wy: number): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    this.squadDest[squadId] = { x: wx, y: wy };
    const n = squad.teamIds.length;
    squad.teamIds.forEach((teamId, ti) => {
      const oy = (ti - (n - 1) / 2) * 8;
      this.orderTeam(teamId, { kind: 'move', x: wx, y: wy + oy });
    });
  }

  private squadHasBalkedTeam(squad: Squad): boolean {
    return squad.teamIds.some((tid) => this.teams[tid].orderState.phase === 'balked');
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

  takeMeleeEvents(): MeleeEvent[] {
    const e = this.pendingMeleeEvents;
    this.pendingMeleeEvents = [];
    return e;
  }

  step(): void {
    this.tick++;
    this.stepWaypoints();
    this.stepBarrages();
    this.stepStrafes();
    this.stepSmoke();
    this.stepOrders();
    this.stepEmplacements();
    this.stepDismounts();
    for (const v of this.vehicles) {
      if (v.alive) this.updateVehicle(v);
    }
    for (const s of this.soldiers) {
      if (s.alive) this.updateSoldier(s);
    }
    if (this.tick % SPOT_INTERVAL === 0) {
      this.updateSpotting('blue');
      this.updateSpotting('red');
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
        // a rescue task counts as busy: it holds path=null for a tick on pickup,
        // and auto-dispatching the next leg would silently cancel the rescue.
        // A melee lock is busy too — pathless for seconds, but hardly "arrived".
        if (s.path || s.task || s.meleeId >= 0) moving++;
      }
      if (eligible === 0) {
        this.squadWaypoints[sq.id] = [];
        this.squadDest[sq.id] = null;
        continue;
      }
      if (moving > 0) continue;
      // A balked leg holds in place (spec: no oscillation) until a fresh
      // order — don't pop the next waypoint out from under it.
      if (this.squadHasBalkedTeam(sq)) continue;
      // An executing assault owns its team until the position is clear —
      // popping the next waypoint here would orderTeam(move) right over it
      // (assault is the one order that idles pathless mid-execution while its
      // throttled completion check still sees defenders).
      if (sq.teamIds.some((tid) => this.teams[tid].orderState.order?.kind === 'assault' && this.teams[tid].orderState.phase === 'executing')) continue;
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
      const vacantSince = this.leaderVacantSince.get(team.id);
      if (vacantSince !== undefined && this.tick - vacantSince >= 300) {
        this.promoteLeader(team);
        this.leaderVacantSince.delete(team.id);
      }
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
      } else if (order.kind === 'assault' && st.phase === 'executing' && (this.tick + team.id) % ASSAULT_REPATH_TICKS === 0) {
        // position taken: everyone arrived, out of melee, and no member sees
        // a defender he could still get at. A visible-but-unreachable holdout
        // (sealed room behind a window, far bank of a river) is a fire
        // problem, not an assault problem — he must not hang the order.
        // astar here is cheap: only runs settled, on the cadence, and the
        // defender list at that point is empty or tiny.
        const eligibleIds = team.soldierIds.filter((id) => this.eligible(this.soldiers[id]));
        const settled = eligibleIds.length > 0 && eligibleIds.every((id) => !this.soldiers[id].path && this.soldiers[id].meleeId < 0);
        const blocked =
          settled &&
          eligibleIds.some((id) => {
            const m = this.soldiers[id];
            return this.assaultDefenders(m, order).some((e) => {
              const p = astar(this.map, Math.floor(m.x), Math.floor(m.y), Math.floor(e.x), Math.floor(e.y));
              return p !== null && p.length > 1;
            });
          });
        if (settled && !blocked) {
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
      if (!s.alive) continue;
      let mult = 1;
      if (s.inVehicle >= 0) {
        const v = this.vehicles[s.inVehicle];
        if (!v || !v.alive || !isOpenTop(v.kind)) continue; // armor shrugs off fragments
        mult = 0.5; // open-topped: exposed to arcing fragments/plunging fire
      }
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > p.suppRadius) continue;
      s.suppression = Math.min(1, s.suppression + 0.6 * (1 - d / p.suppRadius) * (1.3 - s.courage * 0.6) * mult);
      if (d > p.fragRadius) continue;
      if (!los(this.map, x, y, s.x, s.y).visible) continue; // walls stop fragments
      const frags = d < 2 ? p.frags : d < p.fragRadius * 0.55 ? Math.max(1, p.frags - 1) : 1;
      for (let i = 0; i < frags; i++) {
        const pHit = (1 - d / (p.fragRadius + 1)) * (s.downed || s.mental === 'pinned' ? 0.45 : 0.8) * mult;
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
    // crew and passengers ride the hull — sync their position so range/LOS
    // math (and an exposed pintle gunner's targetability) reads correctly.
    for (const cid of v.crewIds) {
      const c = this.soldiers[cid];
      if (c.alive) {
        c.x = v.x;
        c.y = v.y;
      }
    }
    for (const tid of v.passengerTeamIds) {
      for (const sid of this.teams[tid].soldierIds) {
        const s = this.soldiers[sid];
        if (s.alive && s.inVehicle === v.id) {
          s.x = v.x;
          s.y = v.y;
        }
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
    if (v.targetVehicleId >= 0 && v.gunCooldown <= 0 && v.ammo.ap > 0) {
      const e = this.vehicles[v.targetVehicleId];
      if (e.alive && sightBetween(this, v.x, v.y, e.x, e.y).visible) {
        if (this.turretBearingReady(v, def, e.x, e.y)) {
          this.fireApAt(v.x, v.y, def.gunPen, def.gunAccuracy, def.gunRange, e, v.path !== null);
          v.ammo.ap--;
          v.gunCooldown = def.gunCooldown * (0.85 + this.rng.next() * 0.3);
        }
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
      if (!sightToSoldier(this, v.x, v.y, t).visible) {
        v.targetSoldierId = -1;
        return;
      }
      // guard HE fire on remaining he ammo — the M3/SdKfz (ammo.he: 0, no
      // real main gun) fall straight through to the pintle MG.
      if (v.gunCooldown <= 0 && v.ammo.he > 0 && this.turretBearingReady(v, def, t.x, t.y)) {
        this.explode(t.x + this.rng.range(-2, 2), t.y + this.rng.range(-2, 2), { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 60] });
        this.pendingEvents.push({ fx: v.x, fy: v.y, tx: t.x, ty: t.y, hit: true, kill: false });
        v.ammo.he--;
        v.gunCooldown = def.gunCooldown * (0.85 + this.rng.next() * 0.3);
      } else if (v.mgCooldown <= 0) {
        const hullMg: WeaponKey = v.side === 'blue' ? 'm1919' : 'mg42';
        this.fireVehicleMg(v.x, v.y, hullMg, t, false);
        v.mgCooldown = WEAPONS[hullMg].cooldown * (0.85 + this.rng.next() * 0.3);
      }
    }
  }

  // Restricted-arc turret (StuG: turret is a traverse-degree number, not
  // 'full'): fires only within |bearing - hull facing| <= arc; otherwise
  // rotates the hull toward the target at 30 deg/s and holds fire this tick.
  // "Facing IS the weapon" — a vehicle mid-path keeps its movement heading
  // rather than also chasing a firing solution.
  private turretBearingReady(v: Vehicle, def: VehicleDef, tx: number, ty: number): boolean {
    if (def.turret === 'full') return true;
    const bearing = Math.atan2(ty - v.y, tx - v.x);
    let diff = bearing - v.facing;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const arcRad = (def.turret * Math.PI) / 180;
    if (Math.abs(diff) <= arcRad) {
      v.turning = false;
      return true;
    }
    if (v.path) return false;
    const rotSpeed = ((30 * Math.PI) / 180) * DT;
    v.facing += Math.sign(diff) * Math.min(Math.abs(diff), rotSpeed);
    v.turning = true;
    return false;
  }

  // `arc` restricts candidates to a facing sector (defend/ambush: spec's
  // "members only acquire targets inside arc"). Vehicle crew are normally
  // hull-protected and untargetable — except an open-top vehicle's pintle
  // gunner, who's standing up in the back exposed to small arms.
  private acquireSoldierTarget(x: number, y: number, side: Side, range: number, arc?: [number, number]): number {
    const candidates: { id: number; d: number }[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.side === side) continue;
      if (e.inVehicle >= 0) {
        const ev = this.vehicles[e.inVehicle];
        if (!ev || !ev.alive || !isOpenTop(ev.kind) || e.role !== 'gunner') continue;
      }
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= range) candidates.push({ id: e.id, d });
    }
    candidates.sort((a, b) => a.d - b.d || a.id - b.id);
    for (const c of candidates) {
      const e = this.soldiers[c.id];
      if (arc && !this.inArc(x, y, e.x, e.y, arc)) continue;
      if (sightToSoldier(this, x, y, e).visible) return c.id;
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
    // penetration: spall wounds crew (and, if open-topped, everyone riding
    // in back too — no armor to shrug it off), chance of brew-up
    const aboard = [...target.crewIds];
    if (isOpenTop(target.kind)) {
      for (const tid of target.passengerTeamIds) {
        for (const sid of this.teams[tid].soldierIds) if (this.soldiers[sid].inVehicle === target.id) aboard.push(sid);
      }
    }
    for (const cid of aboard) {
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
    // survivors (crew and any passengers still aboard) bail out shaken
    const aboard = [...v.crewIds];
    for (const tid of v.passengerTeamIds) {
      for (const sid of this.teams[tid].soldierIds) if (this.soldiers[sid].inVehicle === v.id) aboard.push(sid);
    }
    v.passengerTeamIds = [];
    let slot = 0;
    for (const cid of aboard) {
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
    const sight = sightToSoldier(this, fx, fy, t);
    const d = Math.hypot(t.x - fx, t.y - fy);
    if (!sight.visible) return { visible: false, dist: d, cover: 0, acc: 0, concealed: sight.concealed };
    const w = WEAPONS[weapon];
    let cover = sight.cover;
    if (t.mental === 'pinned' || t.downed) cover = Math.max(cover, Math.min(0.9, cover + 0.3));
    let acc = w.accuracy * (1 - 0.75 * (d / w.range)) * (1 - cover) * aim;
    if (shooterMoving) acc *= 0.5;
    // Movers are harder to hit — except a sneaking target: once spotted, a
    // slow crouched mover is as easy to hit as if he'd stood still. That's
    // sneak's trade-off for its stealth (spec: the mover discount doesn't
    // apply to sneak). Live fire and this preview share this one formula.
    if (t.path && this.teams[t.teamId].orderState.order?.kind !== 'sneak') acc *= 0.75;
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
    this.pendingEvents.push({ fx, fy, tx: t.x, ty: t.y, hit, kill, weapon });
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
    const cls = crewClassOf(w);
    if (cls) shooter.crewSkill[cls] = Math.min(1, (shooter.crewSkill[cls] ?? 0) + 0.0005);
    if (w.heat) {
      const heatMult = shooter.role !== 'gunner' ? 1.5 : 1;
      shooter.heat = Math.min(1.5, shooter.heat + w.heat.perShot * heatMult);
    }
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
        s.meleeId = -1;
        if (s.task) this.dropTask(s);
        this.triggerSuccession(s);
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

    // broken men flee away from the nearest enemy — breaking is the one way
    // out of a melee lock: he drops his guard and runs (and can be run down)
    if (s.mental === 'broken') {
      s.targetId = -1;
      s.meleeId = -1;
      if (s.task) this.dropTask(s);
      if (!s.fleeing || (this.tick + s.id) % 90 === 0) this.flee(s);
    } else if (s.fleeing) {
      s.fleeing = false;
      s.path = null;
    }

    // close combat: an enemy in reach locks both into melee, which overrides
    // tasks, orders, and ranged fire until it resolves (kill, down, or rout)
    if (s.meleeId < 0 && s.mental !== 'pinned' && s.mental !== 'broken' && (this.tick + s.id) % 10 === 0) this.considerMelee(s);
    if (s.meleeId >= 0 && this.updateMelee(s)) return;

    // rescue / ammo run / weapon succession: a bonded squadmate may pull a
    // casualty out of the fight, ferry belts to a dry gunner, or take over a
    // fallen crew slot
    if (s.task) {
      if (s.task.kind === 'rescue') this.updateRescue(s);
      else if (s.task.kind === 'ammo') this.updateAmmoTask(s);
      else this.updateTakeOver(s);
      return;
    }
    if (s.mental !== 'broken' && (this.tick + s.id) % 60 === 0) {
      this.considerRescue(s);
      this.considerAmmoRunner(s);
      this.considerPickup(s);
      this.considerLoadPickup(s);
    }

    // stamina: recovers when settled and not under heavy fire (drain lives in advance())
    if (!s.path && s.suppression < 0.3) s.stamina = Math.min(1, s.stamina + 0.008 * DT);

    // assault: on a cadence, redirect onto the nearest visible defender of the
    // objective — the closing loop that feeds the 2m melee lock. Marching
    // fire stays on (assault is deliberately absent from the hold-fire gate).
    // Same mental gate as considerMelee: a broken man's flee path must never
    // be overwritten with a charge (the 15-tick cadence divides flee's 90).
    if (
      order?.kind === 'assault' &&
      s.mental !== 'broken' &&
      s.mental !== 'pinned' &&
      this.teams[s.teamId].orderState.phase === 'executing' &&
      (this.tick + s.id) % ASSAULT_REPATH_TICKS === 0
    ) {
      this.assaultRepath(s, order);
    }

    // movement (pinned men hug the ground)
    if (s.path && s.mental !== 'pinned') this.advance(s, this.moveSpeed(s));

    // Sim.orderMount: walking to board, or arrived and boarding within 2m.
    // Re-paths if he arrives short (a formation spot, a vehicle that moved)
    // rather than stranding him just outside the boarding radius.
    if (s.mountTarget >= 0) {
      const v = this.vehicles[s.mountTarget];
      if (!v || !v.alive) {
        s.mountTarget = -1;
      } else if (Math.hypot(v.x - s.x, v.y - s.y) <= 2) {
        s.inVehicle = v.id;
        s.mountTarget = -1;
        s.path = null;
        s.x = v.x;
        s.y = v.y;
      } else if (!s.path) {
        const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(v.x), Math.floor(v.y));
        if (path && path.length > 1) {
          s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
          s.pathI = 0;
        } else {
          s.mountTarget = -1; // unreachable: give up rather than loop forever
        }
      }
      return;
    }

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
            (k) => !k.load && k.side === s.side && weaponRank(k.weapon) > myRank && Math.hypot(k.x - s.x, k.y - s.y) <= 2,
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

    // Crew-served weapon: this soldier's personal `weapon` IS the emplaced
    // gun (m1919/mg42/mortar60/mortar81 gunner slots) — firing is driven by
    // Sim.updateEmplacement's fire loop against the same ammo/heat state, not
    // by his own acquire+fire. AT-gun crews (at57/pak40) never hit this gate:
    // their slot weapons are personal sidearms, never the served gun.
    // Also excludes whoever pickFirer is substituting onto the gun this tick
    // after the gunner goes down — his own personal weapon differs from the
    // served gun (that gate above wouldn't catch him), so without this he'd
    // serve the emplacement AND fire his sidearm in the same tick. Formal
    // succession (Sim.updateTakeOver) later folds him into the gate above by
    // handing him the served weapon outright.
    // Gated on state === 'deployed': a packed gun has nothing to serve —
    // updateEmplacement's fire loop bails on state before ever reaching
    // pickFirer, so excluding personal fire here too would just strand the
    // crew unarmed. Packed, everyone fights with whatever's in their hands.
    if (s.inEmplacement >= 0) {
      const emp = this.emplacements[s.inEmplacement];
      if (emp && emp.state === 'deployed' && (s.weapon === EMPLACEMENTS[emp.kind].weapon || pickFirer(this, emp)?.id === s.id)) return;
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
        s.crewSkill.gun = Math.min(1, (s.crewSkill.gun ?? 0) + 0.0005);
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
        s.crewSkill.gun = Math.min(1, (s.crewSkill.gun ?? 0) + 0.0005);
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
    this.pendingEvents.push({ fx: s.x, fy: s.y, tx: order.x, ty: order.y, hit: false, kill: false, weapon: s.weapon });
    s.magLeft--;
    if (w.heat) s.heat = Math.min(1.5, s.heat + w.heat.perShot);
    s.cooldown = w.cooldown * (0.85 + this.rng.next() * 0.3);
  }

  private advance(s: Soldier, speed: number): void {
    // walking (0.004/s) unless sprinting under a fast order (0.02/s),
    // multiplied by the heaviest load he's carrying (Task 9's speedCap
    // wiring counterpart).
    const order = this.teams[s.teamId].orderState.order;
    let drainRate = order?.kind === 'fast' ? 0.02 : order?.kind === 'assault' ? 0.015 : 0.004;
    if (s.carries.length > 0) drainRate *= Math.max(...s.carries.map((l) => LOADS[l].staminaMult));
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

  // Dedicated aidmen triage 3x faster (spec: "better triage outcome roll" —
  // this milestone models the speed half of that, not a separate roll).
  private aidTimer(s: Soldier): number {
    return s.role === 'aidman' ? AID_SECONDS / 3 : AID_SECONDS;
  }

  // Two-man carry (spec: "walking pace, weapons slung"): a second willing
  // squadmate within 5m of the casualty when the drag starts attaches too,
  // trading the solo drag's crouched crawl for a proper carry.
  private findCarryHelper(primary: Soldier, c: Soldier): Soldier | null {
    for (const sid of this.squads[c.squadId].soldierIds) {
      const h = this.soldiers[sid];
      if (h.id === primary.id || h.id === c.id || !h.alive || h.downed || h.task) continue;
      if (h.mental === 'pinned' || h.mental === 'broken') continue;
      if (Math.hypot(h.x - c.x, h.y - c.y) > 5) continue;
      if (this.rescueWillingness(h, c) < 0.75) continue;
      return h;
    }
    return null;
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
        task.timer = this.aidTimer(s);
      } else {
        const spot = this.findCoverSpot(s);
        if (!spot) {
          task.phase = 'aid';
          task.timer = this.aidTimer(s);
          return;
        }
        const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y);
        if (!path || path.length < 2) {
          task.phase = 'aid';
          task.timer = this.aidTimer(s);
          return;
        }
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
        task.phase = 'drag';
        c.carriedBy = s.id;
        const helper = this.findCarryHelper(s, c);
        if (helper) {
          c.helperId = helper.id;
          helper.task = { kind: 'rescue', casualtyId: c.id, phase: 'drag', timer: 0 };
          helper.path = null;
        }
      }
      return;
    }
    if (task.phase === 'drag') {
      if (c.carriedBy !== s.id) {
        // the second bearer on a two-man carry: slaved to the casualty's
        // position (the primary drives the path), released once he arrives
        s.x = c.x;
        s.y = c.y;
        s.path = null;
        if (c.carriedBy === -1) this.dropTask(s);
        return;
      }
      const dragMult = c.helperId >= 0 ? 0.8 : 0.45;
      this.advance(s, this.moveSpeed(s) * dragMult);
      c.x = s.x;
      c.y = s.y;
      if (!s.path) {
        task.phase = 'aid';
        task.timer = this.aidTimer(s);
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
      const d = Math.hypot(c.x - s.x, c.y - s.y);
      if (d > 30) continue; // same 30m cap as considerRescue
      if (this.rescueWillingness(c, s) < 0.6) continue;
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
      if (kit.load || kit.side !== s.side || weaponRank(kit.weapon) <= myRank) continue;
      if (Math.hypot(kit.x - s.x, kit.y - s.y) > 2) continue;
      s.pickingUp = true;
      s.reloading = 3;
      return;
    }
  }

  // On kill/downed: the weapon+ammo a soldier was carrying hits the ground
  // (plus one entry per emplacement load he was humping — spec: "casualties
  // drop loads at position; any soldier can pick one up"), and both squad-
  // and team-scoped "recent casualty" clocks reset (dangerScore, ambush trigger).
  private dropKit(s: Soldier): void {
    this.droppedKit.push({ side: s.side, x: s.x, y: s.y, weapon: s.weapon, ammo: { ...s.ammo }, magLeft: s.magLeft });
    for (const load of s.carries) {
      this.droppedKit.push({ side: s.side, x: s.x, y: s.y, weapon: s.weapon, ammo: {}, magLeft: 0, load });
    }
    s.carries = [];
    this.squadLastCasualty[s.squadId] = this.tick;
    this.teamLastCasualty[s.teamId] = this.tick;
  }

  // Idle soldier within 2m of a same-side dropped load picks it up — no
  // timer (unlike the 3s weapon swap; the plan doesn't call for one here).
  private considerLoadPickup(s: Soldier): void {
    if (s.reloading > 0 || s.pickingUp || s.path) return;
    for (let i = 0; i < this.droppedKit.length; i++) {
      const kit = this.droppedKit[i];
      if (!kit.load || kit.side !== s.side) continue;
      if (Math.hypot(kit.x - s.x, kit.y - s.y) > 2) continue;
      s.carries.push(kit.load);
      this.droppedKit.splice(i, 1);
      return;
    }
  }

  private dropTask(s: Soldier): void {
    if (s.task?.kind === 'rescue') {
      const c = this.soldiers[s.task.casualtyId];
      if (c.rescuerId === s.id) c.rescuerId = -1;
      if (c.carriedBy === s.id) c.carriedBy = -1;
      if (c.helperId === s.id) c.helperId = -1;
    } else if (s.task?.kind === 'ammo') {
      const g = this.soldiers[s.task.gunnerId];
      if (g.ammoRunnerId === s.id) g.ammoRunnerId = -1;
    }
    s.task = null;
  }

  // Role succession trigger (spec: "chains" — MG: gunner -> assistant ->
  // ammo bearer -> any teammate; same rule for bazooka/schreck gunner ->
  // loader). Fires once, the instant a gunner slot goes down or dies: picks
  // the best-ranked eligible teammate within reach and vacates the slot
  // immediately so a later recovery doesn't reclaim it out from under the
  // successor. Team-scoped ("teammate"), not squad-scoped.
  private triggerSuccession(g: Soldier): void {
    if (g.role !== 'gunner') return;
    // A packed gun has nothing to serve — no formal succession, the crew
    // just fights with their personal weapons (the updateSoldier gate above
    // already stopped excluding them once state !== 'deployed').
    const emp = g.inEmplacement >= 0 ? this.emplacements[g.inEmplacement] : null;
    if (emp && emp.state !== 'deployed') return;
    const team = this.teams[g.teamId];
    const rank = (r: Role) => (r === 'assistant' ? 0 : r === 'bearer' ? 1 : 2);
    let best: Soldier | null = null;
    for (const sid of team.soldierIds) {
      const c = this.soldiers[sid];
      if (c.id === g.id || !c.alive || c.downed || c.task) continue;
      if (c.mental === 'pinned' || c.mental === 'broken') continue;
      if (Math.hypot(c.x - g.x, c.y - g.y) > 8) continue;
      if (!best || rank(c.role) < rank(best.role)) best = c;
    }
    if (!best) return;
    g.role = 'rifleman'; // vacate the slot
    best.task = {
      kind: 'takeOver',
      empId: emp ? emp.id : -1,
      weapon: g.weapon,
      ammo: { ...g.ammo },
      magLeft: g.magLeft,
      x: emp ? emp.x : g.x,
      y: emp ? emp.y : g.y,
      phase: 'goto',
      timer: 0,
    };
    best.path = null;
  }

  private updateTakeOver(s: Soldier): void {
    const task = s.task as TakeOverTask;
    if (task.phase === 'goto') {
      const d = Math.hypot(task.x - s.x, task.y - s.y);
      if (d > 1.5) {
        if (!s.path) {
          const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(task.x), Math.floor(task.y));
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
      task.phase = 'swap';
      task.timer = 3;
      return;
    }
    // swap: crawl to the gun, shoulder it — a timed, exposed action
    task.timer -= DT;
    if (task.timer > 0) return;
    s.weapon = task.weapon;
    s.secondary = undefined;
    s.ammo = { ...task.ammo };
    s.magLeft = task.magLeft;
    s.heat = 0;
    s.role = 'gunner';
    // the predecessor's own dropped copy of this weapon (from dropKit) is
    // now spoken for — clear it so nobody double-claims it via considerPickup
    const i = this.droppedKit.findIndex((k) => !k.load && k.side === s.side && k.weapon === task.weapon && Math.hypot(k.x - task.x, k.y - task.y) <= 2);
    if (i >= 0) this.droppedKit.splice(i, 1);
    s.task = null;
  }

  // Leader succession (spec: "highest xp teammate becomes leader after
  // 10s" — death only, no travel needed, so no takeOver task).
  private promoteLeader(team: Team): void {
    let best: Soldier | null = null;
    for (const sid of team.soldierIds) {
      const c = this.soldiers[sid];
      if (!c.alive || c.downed || c.role === 'leader') continue;
      if (!best || c.xp > best.xp) best = c;
    }
    if (best) best.role = 'leader';
  }

  // Any living un-downed soldier or alive vehicle of `side` with LOS to the
  // point within SPOT_RANGE. (friendlyHasLos in emplacement.ts is the
  // unlimited-range mortar-spotting rule — different semantics, not this.)
  // Public: main.ts gates enemy unit-event pings on it.
  sideSeesPoint(side: Side, x: number, y: number): boolean {
    for (const s of this.soldiers) {
      if (!s.alive || s.downed || s.side !== side || s.inVehicle >= 0) continue;
      if (Math.hypot(s.x - x, s.y - y) <= SPOT_RANGE && sightBetween(this, s.x, s.y, x, y).visible) return true;
    }
    for (const v of this.vehicles) {
      if (!v.alive || v.side !== side) continue;
      if (Math.hypot(v.x - x, v.y - y) <= SPOT_RANGE && sightBetween(this, v.x, v.y, x, y).visible) return true;
    }
    return false;
  }

  private updateSpotting(side: Side): void {
    const enemySide: Side = side === 'blue' ? 'red' : 'blue';
    const spotters: { x: number; y: number }[] = [];
    for (const s of this.soldiers) {
      if (s.alive && !s.downed && s.side === side && s.inVehicle < 0) spotters.push(s);
    }
    for (const v of this.vehicles) if (v.alive && v.side === side) spotters.push(v);
    const spotted = this.spotted[side];
    const spottedV = this.spottedVehicles[side];
    const seen = this.seenStatic[side];
    const contacts = this.contacts[side];

    // melee is a physical-contact sense: a locked fighter stays spotted for
    // his opponent's side even when smoke or concealment blanks the raycast
    const meleeContact = new Set<number>();
    for (const m of this.soldiers) {
      if (!m.alive || m.meleeId < 0) continue;
      meleeContact.add(m.side === side ? m.meleeId : m.id);
    }

    for (const t of this.soldiers) {
      if (t.side !== enemySide) continue;
      const key = `s${t.id}`;
      if (t.alive && t.inVehicle >= 0) {
        spotted.delete(t.id); // aboard: covered by his vehicle's visibility
        contacts.delete(key); // and any foot-position ghost is moot
      } else if (t.alive) {
        const now = meleeContact.has(t.id) ||
          spotters.some((p) => Math.hypot(t.x - p.x, t.y - p.y) <= SPOT_RANGE && sightToSoldier(this, p.x, p.y, t).visible);
        if (now) {
          spotted.set(t.id, { x: t.x, y: t.y });
          contacts.delete(key);
        } else {
          const last = spotted.get(t.id);
          if (last) {
            spotted.delete(t.id);
            contacts.set(key, { kind: 'infantry', x: last.x, y: last.y, tick: this.tick });
          }
        }
      } else {
        // died while tracked but out of sight: ghost at last-seen like a
        // living contact would, until the corpse itself is found
        const last = spotted.get(t.id);
        if (last) {
          spotted.delete(t.id);
          contacts.set(key, { kind: 'infantry', x: last.x, y: last.y, tick: this.tick });
        }
        if (!seen.has(key) && this.sideSeesPoint(side, t.x, t.y)) seen.add(key);
        if (seen.has(key)) contacts.delete(key); // corpse found resolves the ghost
      }
    }

    for (const v of this.vehicles) {
      if (v.side !== enemySide) continue;
      const key = `v${v.id}`;
      if (v.alive) {
        if (this.sideSeesPoint(side, v.x, v.y)) {
          spottedV.set(v.id, { x: v.x, y: v.y });
          contacts.delete(key);
        } else {
          const last = spottedV.get(v.id);
          if (last) {
            spottedV.delete(v.id);
            contacts.set(key, { kind: 'vehicle', x: last.x, y: last.y, tick: this.tick });
          }
        }
      } else {
        spottedV.delete(v.id);
        if (!seen.has(key) && this.sideSeesPoint(side, v.x, v.y)) seen.add(key);
        if (seen.has(key)) contacts.delete(key);
      }
    }

    for (const e of this.emplacements) {
      if (e.side === enemySide && !seen.has(`e${e.id}`) && this.sideSeesPoint(side, e.x, e.y)) seen.add(`e${e.id}`);
    }

    for (const [k, c] of contacts) {
      if (this.tick - c.tick > CONTACT_TTL) contacts.delete(k);
    }
  }

  // The UI's only fog-of-war surface — renderer, pickAt, and HUD all ask
  // these; none of them re-derive vision.
  soldierVisibleTo(side: Side, s: Soldier): boolean {
    if (this.fowDisabled || s.side === side) return true;
    if (s.inVehicle >= 0) return false;
    return s.alive ? this.spotted[side].has(s.id) : this.seenStatic[side].has(`s${s.id}`);
  }

  vehicleVisibleTo(side: Side, v: Vehicle): boolean {
    if (this.fowDisabled || v.side === side) return true;
    return v.alive ? this.spottedVehicles[side].has(v.id) : this.seenStatic[side].has(`v${v.id}`);
  }

  emplacementVisibleTo(side: Side, e: Emplacement): boolean {
    return this.fowDisabled || e.side === side || this.seenStatic[side].has(`e${e.id}`);
  }

  // Public: omnidirectional summary of the cover available at a spot — the
  // tile's own cover or an adjacent hedgerow bank to hug. Shared by AI
  // cover-seeking, danger scoring, and the UI's move-preview dot colors.
  coverAt(x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    return Math.max(
      this.map.terrainAt(tx, ty).cover,
      this.map.terrainAt(tx + 1, ty).coverBehind ?? 0,
      this.map.terrainAt(tx - 1, ty).coverBehind ?? 0,
      this.map.terrainAt(tx, ty + 1).coverBehind ?? 0,
      this.map.terrainAt(tx, ty - 1).coverBehind ?? 0,
    );
  }

  // Public: the same cover predicate AI cover-seeking uses drives the UI's
  // move-preview dot colors — one definition of "in cover".
  inCover(x: number, y: number): boolean {
    return this.coverAt(x, y) > 0.2 || this.map.terrainKeyAt(Math.floor(x), Math.floor(y)) === 'floor';
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

  // The objective's defenders as this soldier sees them: alive, on foot,
  // within ASSAULT_RADIUS of the order point, and visible to him. Shared by
  // the per-soldier redirect and (via any-member sight) assault completion.
  private assaultDefenders(s: Soldier, order: TeamOrder): Soldier[] {
    const out: Soldier[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.side === s.side || e.inVehicle >= 0) continue;
      if (Math.hypot(e.x - order.x, e.y - order.y) > ASSAULT_RADIUS) continue;
      if (sightToSoldier(this, s.x, s.y, e).visible) out.push(e);
    }
    return out;
  }

  // One assault redirect: path onto the nearest visible defender (the melee
  // lock takes over inside 2m); with none in sight, close on the point itself.
  private assaultRepath(s: Soldier, order: TeamOrder): void {
    const defenders = this.assaultDefenders(s, order);
    const candidates: { x: number; y: number }[] = defenders
      .map((e) => ({ e, d: Math.hypot(e.x - s.x, e.y - s.y) }))
      .sort((a, b) => a.d - b.d || a.e.id - b.e.id)
      .map((c) => c.e);
    if (
      candidates.length > 0 &&
      Math.hypot(candidates[0].x - s.x, candidates[0].y - s.y) <= MELEE_ENGAGE &&
      this.meleeReachable(s.x, s.y, candidates[0].x, candidates[0].y)
    ) {
      return; // true contact — the melee lock owns him now (a man 1.5m away
      // through a window is NOT contact; keep working the reachable ones)
    }
    // Nearest REACHABLE defender wins; a visible-but-unreachable one (window,
    // water) must not stall the charge — fall through to the next man, then
    // to the ground itself, rather than reselecting the same dead end forever.
    if (candidates.length === 0) {
      if (s.path || Math.hypot(order.x - s.x, order.y - s.y) <= 4) return;
      candidates.push(order); // nobody left in sight: take the ground
    }
    for (const goal of candidates) {
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(goal.x), Math.floor(goal.y));
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
        return;
      }
    }
    // every defender unreachable: at least stand on the objective
    if (!s.path && Math.hypot(order.x - s.x, order.y - s.y) > 4) {
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(order.x), Math.floor(order.y));
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        s.pathI = 0;
      }
    }
  }

  // Can a man physically get at (bx, by) from (ax, ay) at melee distance?
  // Greedy tile walk over canStep — doors pass, walls and windows don't.
  // At MELEE_ENGAGE range the chain is <= 2 steps; deterministic, no RNG.
  private meleeReachable(ax: number, ay: number, bx: number, by: number): boolean {
    let tx = Math.floor(ax);
    let ty = Math.floor(ay);
    const tx1 = Math.floor(bx);
    const ty1 = Math.floor(by);
    let guard = 4;
    while ((tx !== tx1 || ty !== ty1) && guard-- > 0) {
      const sx = Math.sign(tx1 - tx);
      const sy = Math.sign(ty1 - ty);
      const order = Math.abs(tx1 - tx) >= Math.abs(ty1 - ty) ? [[sx, 0], [0, sy]] : [[0, sy], [sx, 0]];
      let stepped = false;
      for (const [dx, dy] of order) {
        if (dx === 0 && dy === 0) continue;
        if (this.map.canStep(tx, ty, tx + dx, ty + dy)) {
          tx += dx;
          ty += dy;
          stepped = true;
          break;
        }
      }
      if (!stepped) return false;
    }
    return tx === tx1 && ty === ty1;
  }

  // Melee acquisition is a physical-contact sense: no sight check, so smoke
  // and concealment never stop a lock — at 2m you bump into a man whether or
  // not you can see him, and a smoke-covered assault is supposed to end at
  // bayonet point. The tradeoff is honest intel: entering melee force-spots
  // both fighters to both sides (enterMelee + the meleeContact override in
  // updateSpotting), and a melee kill marks the corpse found for the killer's
  // side. A sneaking/ambushing man bumped into melee is thus revealed — his
  // team's order is untouched (one compromised man doesn't blow the ambush),
  // so when the fight ends he can melt back, leaving the usual ghost.
  private considerMelee(s: Soldier): void {
    let best: Soldier | null = null;
    let bestD = Infinity;
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.side === s.side || e.inVehicle >= 0) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d > MELEE_ENGAGE || d >= bestD) continue;
      if (!this.meleeReachable(s.x, s.y, e.x, e.y)) continue;
      bestD = d;
      best = e;
    }
    if (!best) return;
    this.enterMelee(s, best.id);
    if (best.meleeId < 0) this.enterMelee(best, s.id); // already fighting someone: he keeps his man
  }

  private enterMelee(m: Soldier, oppId: number): void {
    m.meleeId = oppId;
    m.meleePhase = 0.4; // start at guard; first strike after the windup below
    m.meleeTempo = 1 / this.rng.range(0.9, 1.5);
    m.path = null;
    m.targetId = -1;
    m.mountTarget = -1;
    if (m.task) this.dropTask(m);
    m.suppression = Math.min(1, m.suppression + 0.15); // steel at arm's length
    // physical contact is intel: both fighters spot each other instantly, not
    // on the next sweep — the lock pose must never point at an unseen man
    const opp = this.soldiers[oppId];
    this.spotted[m.side].set(oppId, { x: opp.x, y: opp.y });
    this.spotted[opp.side].set(m.id, { x: m.x, y: m.y });
    this.contacts[m.side].delete(`s${oppId}`);
    this.contacts[opp.side].delete(`s${m.id}`);
  }

  // One tick of an ongoing melee. Returns true while the fight holds this
  // soldier (skip tasks, movement, and ranged combat); false once it resolves.
  private updateMelee(s: Soldier): boolean {
    const t = this.soldiers[s.meleeId];
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    // A routing opponent already out of strike reach can't be caught (equal
    // speeds) — break off and let the rifle take over, no futile jogging.
    if (!t.alive || t.downed || t.inVehicle >= 0 || d > MELEE_BREAK || (t.mental === 'broken' && d > MELEE_STRIKE_RANGE)) {
      s.meleeId = -1;
      return false;
    }
    s.stamina = Math.max(0, s.stamina - 0.03 * DT); // grappling is exhausting
    if (d > MELEE_CONTACT) {
      // close to contact: straight steps, wall-aware (a routing opponent is
      // pursued this way too — same speed, so strikes keep landing in range)
      const step = Math.min(this.moveSpeed(s) * DT, d - MELEE_CONTACT);
      const nx = s.x + ((t.x - s.x) / d) * step;
      const ny = s.y + ((t.y - s.y) / d) * step;
      const cx = Math.floor(s.x);
      const cy = Math.floor(s.y);
      const tx = Math.floor(nx);
      const ty = Math.floor(ny);
      const legal =
        (tx === cx && ty === cy) ? true
        : (tx === cx || ty === cy) ? this.map.canStep(cx, cy, tx, ty)
        // diagonal crossing: both L-paths must be steppable — the pathfinder's
        // no-corner-cutting rule (path.ts); canStep alone half-checks diagonals
        : this.map.canStep(cx, cy, tx, cy) && this.map.canStep(tx, cy, tx, ty) &&
          this.map.canStep(cx, cy, cx, ty) && this.map.canStep(cx, ty, tx, ty);
      if (legal) {
        s.x = nx;
        s.y = ny;
      }
    }
    if (d > MELEE_STRIKE_RANGE) {
      s.meleePhase = 0.4; // can't wind up on the move — guard until back in reach
      return true;
    }
    s.meleePhase += s.meleeTempo * DT;
    if (s.meleePhase >= 1) {
      s.meleePhase = 0;
      s.meleeTempo = 1 / (MELEE_INTERVAL * this.rng.range(0.85, 1.15));
      this.meleeStrike(s, t);
    }
    return true;
  }

  // One swing, resolved through the standard wound/body model. Hit chance is
  // weapon-class base x aimFactor — the same aim formula as ranged fire, so
  // pain, suppression, nerves, and stamina all degrade melee too.
  private meleeStrike(s: Soldier, t: Soldier): void {
    const w: WeaponDef = WEAPONS[s.weapon];
    const isSmg = MELEE_SMG.has(s.weapon);
    const smgFire = isSmg && s.magLeft > 0;
    const clumsy = !!w.heat || w.pen !== undefined || !!w.arc; // an MG42 makes a poor club
    const base = smgFire ? 0.7 : clumsy ? 0.35 : isSmg ? 0.45 : 0.55;
    const dmg: [number, number] = smgFire ? w.damage : clumsy || isSmg ? [20, 50] : [30, 70];
    const hit = this.rng.next() < Math.min(0.9, Math.max(0.05, base * this.aimFactor(s)));
    let kill = false;
    if (hit) kill = this.wound(t, this.rng.range(dmg[0], dmg[1]));
    else t.suppression = Math.min(1, t.suppression + 0.1); // a blade past your face
    if (smgFire) {
      s.magLeft--;
      this.pendingEvents.push({ fx: s.x, fy: s.y, tx: t.x, ty: t.y, hit, kill, weapon: s.weapon }); // hip-fire muzzle flash
    }
    this.pendingMeleeEvents.push({ attackerId: s.id, victimId: t.id, x: t.x, y: t.y, hit, kill });
    if (kill) this.seenStatic[s.side].add(`s${t.id}`); // killed at arm's length: the corpse is found, not a ghost
    if (kill || t.downed) s.meleeId = -1;
  }

  private acquire(s: Soldier): number {
    const order = this.teams[s.teamId].orderState.order;
    const arc = (order?.kind === 'defend' || order?.kind === 'ambush') ? order.arc : undefined;
    return this.acquireSoldierTarget(s.x, s.y, s.side, WEAPONS[s.weapon].range, arc);
  }

  private fire(s: Soldier, t: Soldier): void {
    if (!sightToSoldier(this, s.x, s.y, t).visible) {
      s.targetId = -1;
      return;
    }
    const w = WEAPONS[s.weapon];
    const team = this.teams[s.teamId];
    const order = team.orderState.order;
    let aim = this.aimFactor(s) * this.crewAimMult(s, w);
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
    t.meleeId = -1;
    if (t.task) this.dropTask(t);
    if (t.rescuerId >= 0) {
      const r = this.soldiers[t.rescuerId];
      if (r.task?.kind === 'rescue' && r.task.casualtyId === t.id) this.dropTask(r);
    }
    if (t.helperId >= 0) {
      const h = this.soldiers[t.helperId];
      if (h.task?.kind === 'rescue' && h.task.casualtyId === t.id) this.dropTask(h);
    }
    if (t.ammoRunnerId >= 0) {
      const r = this.soldiers[t.ammoRunnerId];
      if (r.task?.kind === 'ammo' && r.task.gunnerId === t.id) this.dropTask(r);
    }
    this.triggerSuccession(t);
    if (t.role === 'leader') this.leaderVacantSince.set(t.teamId, this.tick);
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
        s.task
          ? s.task.kind === 'rescue'
            ? `rescue:${s.task.phase}:${s.task.casualtyId}`
            : s.task.kind === 'ammo'
              ? `ammo:${s.task.phase}:${s.task.gunnerId}`
              : `takeOver:${s.task.phase}:${s.task.empId}`
          : '',
        s.stabilized,
        s.magLeft,
        s.reloading > 0,
        Math.round(s.heat * 1e6),
        Object.values(s.ammo).reduce((a: number, n) => a + (n ?? 0), 0),
        Math.round(s.stamina * 1e6),
        s.ammoRunnerId,
        s.pickingUp,
        s.weapon,
        s.inVehicle,
        s.inEmplacement,
        s.carries.join(','),
        s.mountTarget,
        s.role,
        s.helperId,
        s.meleeId,
        Math.round(s.meleePhase * 1e6),
        Math.round((s.crewSkill.mg ?? 0) * 1e6),
        Math.round((s.crewSkill.mortar ?? 0) * 1e6),
        Math.round((s.crewSkill.gun ?? 0) * 1e6),
      ]),
      vehicles: this.vehicles.map((v) => [
        v.id,
        Math.round(v.x * 1e6),
        Math.round(v.y * 1e6),
        v.alive,
        Math.round(v.facing * 1e6),
        v.targetVehicleId,
        v.targetSoldierId,
        v.ammo.ap,
        v.ammo.he,
        v.turning,
        v.passengerTeamIds.join(','),
      ]),
      teams: this.teams.map((t) => [t.id, t.orderState.phase, t.orderState.order?.kind ?? '', t.smokeLeft, t.ambushBonusTick]),
      emplacements: this.emplacements.map((e) => [
        e.id,
        Math.round(e.x * 1e6),
        Math.round(e.y * 1e6),
        e.state,
        Math.round(e.timer * 1e6),
        Math.round(e.cooldown * 1e6),
        Math.round(e.heat * 1e6),
        e.towedBy,
        e.loadsPresent.length,
        e.hasTarget,
        e.smokeRoundsLeft,
      ]),
      smoke: this.smoke.map((p) => [Math.round(p.x * 1e6), Math.round(p.y * 1e6), Math.round(p.ttl * 1e6)]),
      droppedKit: this.droppedKit.map((k) => [
        k.side,
        Math.round(k.x * 1e6),
        Math.round(k.y * 1e6),
        k.weapon,
        Object.values(k.ammo).reduce((a: number, n) => a + (n ?? 0), 0),
        k.magLeft,
      ]),
      squadLastCasualty: this.squadLastCasualty,
      teamLastCasualty: this.teamLastCasualty,
      leaderVacantSince: [...this.leaderVacantSince.entries()].sort((a, b) => a[0] - b[0]),
    });
  }
}
