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
import {
  BREACH_LIP,
  BREACH_THRESH,
  BREACH_WIDE,
  ECLASS,
  EDGE,
  EYE_H,
  FLOOR_H,
  GameMap,
  edgeClass,
  edgeMid,
  los,
  nearestBreachable,
  type EdgeRef,
  type EdgeType,
  type LosResult,
  type StepMode,
} from './map';
import type { Building } from './mapgen';
import {
  ambushThreshold,
  BALK_REASON,
  CHARGE_BALK_REASON,
  compliance,
  dangerScore,
  orderVerdict,
  type OrderKind,
  type OrderState,
  type TeamOrder,
} from './orders';
import { astar } from './path';
import { mulberry32, type Rng } from './rng';
import { CANON_CLOCK_MIN, lightAt } from './solar';
import { CRAWL_SUPP_THRESHOLD, CRAWL_TICKS, crawlCoverSpot, orderLevel, resolveMoveSpots } from './spots';
import { LEAN_K, WIND } from './wind';

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
// Mid-execution refusal re-audit cadence (balance 2026-07): a move/fast order
// used to be compliance-checked only at issuance — the one instant a
// map-length order is guaranteed to read safe (pre-contact danger caps at
// ~0.4 vs a ~0.85 threshold) — then owned the team to the far map edge. Under
// fire, the same ladder re-runs every 2s, staggered by team id.
const REAUDIT_TICKS = 60;
// A man who steadies within this long of being pinned or broken has rallied
// (#766). The crossing never happens in one tick: suppression decays at most
// 0.0023 a tick and morale climbs 0.00013, so he always passes through
// 'shaken' first — the old one-tick test fired 0 times in 38 probed battles.
// Measured time from the last pinned/broken tick to steady: pinned, two
// thirds inside 30 s and all inside 120 s; broken, all between 60 and 120 s
// (morale has to climb from 0.25 to 0.55).
export const RALLY_WINDOW_TICKS = 120 * 30;
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
// Full-map A* searches serviced per tick. A select-all move order wants ~140
// at once; at ~3 ms each that is a quarter-second freeze. 6/tick keeps the
// pathing cost under ~20 ms and drains a full-company order in ~0.6 s, which
// reads as squads stepping off in sequence rather than as a stall.
const PATH_BUDGET_PER_TICK = 6;
// Grenades: the assault's room-clearing opener (decision log 2026-07-23).
const GRENADE_RANGE = 12; // m
const GRENADE_FUSE_TICKS = 30; // ~1 s
const GRENADE_COOLDOWN_TICKS = 60;
const GRENADE_BLAST: Blast = { suppRadius: 6, fragRadius: 3, frags: 2, dmg: [20, 55], breach: 2, kind: 'grenade' };
const GRENADE_SCATTER = 2; // m max
const ENTRY_LOOKAHEAD = 4; // path waypoints: imminent opening, not any later opening
const AP_DESTROY_CHANCE = 0.45; // conditional on a penetrating hit

// Destructible terrain (docs/plans/2026-07-27-destructible-terrain-design.md
// §1.2-§1.3). Breach energy falls off linearly from the burst point over the
// frag radius and is compared against map.ts's BREACH_THRESH — no rng, ever.
// The shared sequential rng stream is why: one draw per candidate edge would
// reshuffle every downstream draw in the tick and invalidate every pinned
// determinism snapshot. Jitter, if it is ever wanted, belongs in a derived
// sub-stream (mulberry32(base ^ imul(edgeIndex, 0x9e3779b1))), which takes
// zero draws from this.rng.
const BREACH_CAP = 4; // edges opened per explosion, in a fixed scan order
// Source energy at or above which the hole is wide enough for a hull: tank HE
// (7), a missed AT rocket (8) and a deliberate wall shot (12). A mortar,
// a strafing run or a grenade leaves a foot-only rubble lip.
const BREACH_WIDE_ENERGY = 7;
// How far onto the burst's own side of an edge the occlusion guard aims. Any
// value in (0, 0.5) picks the same tile; small keeps the ray honest.
const BREACH_FACE_EPS = 0.01;
// Ticks a man spends getting himself over a rubble lip (0.3 s), the climbLeft
// shape applied to a horizontal obstacle.
const SCRAMBLE_TICKS = 18;
// Ticks of stalled movement after a hull drives through something: half a
// second for a fence or a garden wall, a second and a quarter for a tank
// grinding a head-high enclosure wall down under its tracks.
const CRUSH_STALL_LIGHT = 30;
const CRUSH_STALL_HEAVY = 75;
const CRUSH_SUPPRESSION = 0.25;
// D5, the deliberate wall shot: the same warhead as a MISSED AT round (which
// is where most accidental masonry breaching already comes from) with the
// aiming put back in. 12 is the only energy on the field that clears every row
// of BREACH_THRESH, so an aimed round always opens the edge it lands on —
// which is what makes "assault routes you make" a rule rather than a lottery.
const WALL_SHOT: Blast = {
  kind: 'at',
  suppRadius: 8,
  fragRadius: 3,
  frags: 1,
  dmg: [20, 50],
  breach: 12,
};
// D7: how close a walking man has to be to a fresh hole to be worth making him
// re-ask the pathfinder. 25 m is the "he could plausibly use it" band — wide
// enough that the squad you blew the wall for pours through, tight enough that
// one barrage does not re-solve half the company's journeys.
const BREACH_REPATH_RADIUS = 25;
// How far from the click a wall target may be picked up. Two and a half metres
// is a tile and a half: close enough that the player is unambiguously pointing
// at a wall, loose enough that he need not hit the edge line to the pixel.
export const WALL_TARGET_RADIUS = 2.5;

// A wall (or gate, or window) that opened mid-battle. Insertion-ordered:
// `pendingBreaches` is the render channel (drained every frame like booms),
// `breachLog` is append-only and survives to the debrief for the campaign
// scar re-stamp.
export interface BreachEvent {
  horiz: boolean;
  x: number;
  y: number;
  cls: number; // ECLASS of what stood there before it opened
  wide: boolean;
  cause: 'blast' | 'crush';
}

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
  path: { x: number; y: number; l?: number }[] | null;
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
  // height: floor level and stair transition
  level: number; // floor level, 0-based. vehicles/emplacements always 0
  climbLeft: number; // ticks remaining of a stair climb; >0 = on stairs transitioning
  scrambleLeft: number; // ticks remaining of a rubble-lip crossing; >0 = clambering through a breach
  wallTarget: EdgeRef | null; // player-assigned wall to open with an AT weapon (D5), null = none
  grenadesLeft: number; // 2 for grenadiers, 0 for everyone else
  grenadeCooldownUntil: number; // tick when next grenade throw is allowed
  entryHoldUntil: number; // waits outside an opening until his own grenade bursts (#217)
  captured: boolean; // alive, out of the fight, untargetable (surrendered at melee contact)
  lastCowedTick: number; // tick he was last pinned or broken. Output only: it times the 'rallied' event and nothing in the sim reads it, so it is not in snapshot()
  // The last wound that came from somewhere: unit vector away from its source,
  // and the tick. Output only (the kia/downed events' dx, dy), not in snapshot().
  hitDx: number;
  hitDy: number;
  hitTick: number;
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
  crushLeft: number; // ticks of stalled MOVEMENT after driving through something; the gun still works
  wallTarget: EdgeRef | null; // player-assigned wall to open with the main gun (D5), null = none
}

// Can this man be pointed at a wall (D5)? A rocket launcher in his hands, or a
// panzerfaust stashed in his pockets — the same two branches his anti-armour
// fire already runs on, so the HUD's Breach button and the sim agree on who
// can take the shot without either re-deriving it.
export function canBreachByHand(s: Soldier): boolean {
  const w: WeaponDef = WEAPONS[s.weapon];
  return w.pen !== undefined || (s.ammo.faust ?? 0) > 0;
}

// A wall target as one snapshot cell. It is mutable state that gates which
// weapon fires at what, so §4.2's rule applies: it goes in the determinism
// snapshot or two same-seed runs can silently diverge on it.
function refKey(t: EdgeRef | null): string {
  return t ? `${t.horiz ? 'h' : 'v'}${t.x},${t.y}` : '';
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
  grenades?: number;
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
  // Render-only: the soldier who fired and the soldier fired at, where the sim
  // has one. A shot from a gun or a hull has no shooterId (it leaves from the
  // weapon, not from a man); a shot at a point, a wall or a vehicle has no
  // targetId.
  shooterId?: number;
  targetId?: number;
}

// What went off, so the renderer can tell a grenade from a shell. `r` is the
// fragment radius in metres, the same number the blast wounded with; a brew-up
// has none. Render-only, like every drain queue here.
export type BoomKind = 'grenade' | 'shell' | 'mortar' | 'at' | 'brewup' | 'bomb';
export interface BoomEvent {
  x: number;
  y: number;
  r?: number;
  kind: BoomKind;
}

interface Blast {
  suppRadius: number;
  fragRadius: number;
  frags: number;
  dmg: [number, number];
  breach?: number;
  kind: BoomKind;
}

// Discrete casualty/morale transitions, emitted the tick they happen so the
// UI never has to diff sim state (a DOWN followed by KIA in one frame batch
// would otherwise drop the DOWN).
export interface UnitEvent {
  kind:
    | 'downed'
    | 'kia'
    | 'broken'
    | 'surrendered'
    | 'vehicle-destroyed'
    | 'ping'
    | 'pinned'
    | 'rallied'
    | 'ambush'
    // The quiet recoveries (#766): each was a state change nothing announced.
    | 'took-over' // a crewman finished taking over the gunner's weapon
    | 'promoted' // a teammate became leader after the leader fell
    | 'stabilized' // a casualty's bleeding was stopped by a squadmate
    | 'recovered' // a downed man is back on his feet
    | 'resupplied'; // a runner handed ammunition to a dry gunner
  x: number;
  y: number;
  side: Side;
  name: string;
  team?: string; // the quiet recoveries: the team of the man it happened to, for the ticker's team-named line
  // 'kia' and 'downed': unit vector along the shot that did it, or away from
  // the blast centre. Absent when the cause had no direction (bled out, hit
  // inside a hull, a burst on top of him).
  dx?: number;
  dy?: number;
  // The man it happened to, where there is one. Output only — the UI fog
  // filter needs soldierVisibleTo, and a point test would leak a concealed
  // man that sightToSoldier's concealment rule hides. Absent on the two
  // kinds that anchor to no single soldier: vehicle-destroyed and ambush.
  id?: number;
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
  destroyChance: number; // immediate vehicle destruction, conditional on a hit
}

interface Barrage {
  side: Side;
  x: number;
  y: number;
  roundsLeft: number;
  nextTick: number;
}

// Shell smoke's height three seconds after deploy (m) — the calibration anchor
// for PLUME[0], not a constant the sim reads any more. It used to be THE column
// height: fixed at 3.5 so a ground eye (1.6m) was blind and a floor-2 eye
// (elev + FLOOR_H + EYE_H = 4.6m) saw over. The column now ages (see PLUME),
// and grow(3, …) lands within 1% of this number, so the first seconds of a
// screen behave as they always did. A test pins that agreement, which is what
// stops a future retune of PLUME[0] from silently rewriting smoke doctrine.
export const SMOKE_H = 3.5;
// Suppression addend multiplier per floor slab between blast and soldier
// (plan 2026-07-23-3d-height-sim §5): felt through the floor, not lethal.
export const SLAB_SUPP_FACTOR = 0.25;

export interface Smoke {
  x: number;
  y: number;
  z0: number; // column base z: ground elevation + deployer level * FLOOR_H at deploy
  h: number; // CURRENT column height, m — recomputed from age once per tick
  ttl: number; // seconds left
  age: number; // seconds since deploy
  kind: 0 | 1; // 0 = shell/grenade smoke, 1 = fire (burning wreck or building)
  r: number; // CURRENT column radius, m
  r2max: number; // cached (r + LEAN_K*h)^2 — the per-ray early-reject radius, squared
}

// Growth curves per smoke kind. Rational and saturating, never exponential:
// Math.exp/pow/hypot are not guaranteed correctly-rounded across JS engines,
// while + − × ÷ are IEEE-exact, so a/(a+T) replays identically everywhere.
const PLUME = [
  { h0: 1.5, hMax: 10, T: 10, r0: 1.5, rMax: 3.0 }, // 0 shell/grenade smoke
  { h0: 2.0, hMax: 20, T: 8, r0: 2.0, rMax: 4.5 }, // 1 fire
] as const;

export function grow(a: number, v0: number, vMax: number, T: number): number {
  return v0 + (vMax - v0) * (a / (a + T));
}

// The single construction path for a puff, so the age-derived fields can never
// disagree with the curve the LOS test reads. `age` is a parameter because a
// screen is only a screen once it has grown: a puff deployed this tick is
// 1.5 m tall and a standing man (1.6 m) can still see over it for the ~4 ticks
// it takes to climb past his eye. Tests that want a developed screen pass 3 s,
// the height the old constant-height model always had.
export function smokePuff(x: number, y: number, z0: number, ttl: number, kind: 0 | 1 = 0, age = 0): Smoke {
  const p: Smoke = { x, y, z0, h: 0, ttl, age, kind, r: 0, r2max: 0 };
  agePuff(p);
  return p;
}

// Evaluate the age-dependent geometry ONCE per puff per tick (never per ray):
// sightBetween's smoke loop is O(puffs) on the hottest path in the game, so it
// must see nothing but comparisons.
function agePuff(p: Smoke): void {
  const k = PLUME[p.kind];
  p.h = grow(p.age, k.h0, k.hMax, k.T);
  p.r = grow(p.age, k.r0, k.rMax, k.T);
  const R = p.r + LEAN_K * p.h;
  p.r2max = R * R;
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

// Who a leaderless team can best spare for the job, lowest first. Roles not
// listed are riflemen for this purpose.
const LEADER_SPARE: Partial<Record<Role, number>> = { bearer: 1, assistant: 2, aidman: 3, gunner: 4 };

// Which crewSkill class a weapon trains (spec: mg/mortar/gun/vehicle — the
// 'vehicle' class is reserved for a future vehicle-crew succession pass and
// never accrued/applied by this milestone).
function crewClassOf(w: WeaponDef): CrewClass | null {
  if (w.heat) return 'mg';
  if (w.arc) return 'mortar';
  if (w.pen !== undefined) return 'gun';
  return null;
}

// Formation offsets around a squad destination, meters. formationSlots below
// is the only production reader — the order preview goes through
// resolveMoveSpots, which asks formationSlots for the slots execution uses.
export const OFFSETS: [number, number][] = [
  [0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
  [2.2, 1.5], [-2.2, 1.5], [2.2, -1.5], [-2.2, -1.5], [0, 3],
];

// Fan-out spacing for team destinations (orderSquad legacy, 8m between teams)
// and multi-squad fan (plain-click, 12m between squads).
export const TEAM_FAN = 8;
export const SQUAD_FAN = 12;
// Rifle-team smoke grenade reach, meters (deploySmoke; the balk reason quotes it).
export const SMOKE_THROW_M = 30;

// Centered offsets: n items spread across `spacing` meters, centered on zero.
export function fanOffsets(n: number, spacing: number): number[] {
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * spacing);
}

// Compact 2-D anchors for a multi-squad point order: squads cluster round the
// click (golden-angle spiral, ~SQUAD_FAN neighbour spacing) instead of forming
// one long line — the line is the right-drag's job, where the player draws it.
// Deterministic, rng-free; entry 0 is the click itself, so a single squad is
// byte-identical to the old fanOffsets(1) path.
export function squadClumpOffsets(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return [0, 0] as [number, number];
    const r = SQUAD_FAN * 0.85 * Math.sqrt(i);
    const a = i * 2.399963229728653; // golden angle, radians
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
  });
}

// Per-soldier formation slots relative to a destination point.
// - facing === undefined: OFFSETS[i % OFFSETS.length] (legacy blob).
// - facing set: rank-and-file grid whose long axis runs ALONG facing
// (right-drag formation orders; overlays preview uses the same helper).
export function formationSlots(count: number, facing?: number, width?: number): [number, number][] {
  if (facing === undefined) {
    return Array.from({ length: count }, (_, i) => OFFSETS[i % OFFSETS.length]);
  }
  const cols = Math.max(2, Math.round((width ?? count * 1.5) / 1.5));
  const rows = Math.ceil(count / cols);
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  const slots: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const lx = (col - (cols - 1) / 2) * 1.5;
    const ly = (row - (rows - 1) / 2) * 1.5;
    slots.push([lx * cos - ly * sin, lx * sin + ly * cos]);
  }
  return slots;
}

function isOpenTop(kind: VehicleKey): boolean {
  const def: VehicleDef = VEHICLES[kind];
  return def.openTop === true;
}

function crushMode(kind: VehicleKey): StepMode {
  const def: VehicleDef = VEHICLES[kind];
  return def.crush === 'heavy' ? 'crush_heavy' : 'crush_light';
}

// Closest-approach parameter t (in [0,1]) of a point to a segment — used to
// test whether a smoke puff sits close enough to a sightline to obscure it,
// and where along the ray the column is crossed. Returns only the scalar t so
// the smoke loop stays allocation-free; the caller derives the squared
// distance from t (+−× only — no Math.hypot in the decision path, plan §7).
function closestT(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  return len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
}

// --- Stance and eye heights (verticality design §3) ---
// Between two men on level ground the eye-line is horizontal, so a rise only
// discriminates by stance at exactly 1 m: it blocks prone (0.4) and passes
// crouch (1.1) and stand (1.6). 2 m and up blocks everybody. That is why the
// relief work puts its tactical payload in 1 m features (hedge banks, road
// verges, sunken-lane shoulders) and treats a 3 m embankment as a hard wall.
export type Stance = 'stand' | 'crouch' | 'prone';
export const EYE_STAND = EYE_H; // 1.6 — the engine's existing eye; moving it would rewrite every legacy LOS result
export const EYE_CROUCH = 1.1;
export const EYE_PRONE = 0.4;
// A vehicle sights from the commander's cupola and is itself a hull-sized
// target: a bank that hides a man does not hide a tank.
export const EYE_VEHICLE = 2.2;
export const HULL_VEHICLE = 2.0;

// Stance is DERIVED, never stored: no field on Soldier, no bytes in snapshot().
// This is the renderer's own pose predicate hoisted sim-side so the two cannot
// drift — renderer.ts calls this function rather than re-testing `mental`.
//
// It takes the sim because a man's posture is mostly a matter of ORDERS, not of
// his own state (V8): a team lying in ambush is prone, a team dug in on defend
// is crouched, and both are the whole point of a 1 m hedge bank. Passing the
// sim rather than defaulting an order argument is deliberate — a default would
// let a new call site silently sight a prone ambusher at standing height, which
// is exactly the class of miss the sight-caller gate exists to prevent.
export function stanceOf(sim: Sim, s: Soldier): Stance {
  if (!s.alive || s.downed || s.captured) return 'prone';
  if (s.mental === 'pinned' || (s.mental === 'broken' && !s.path)) return 'prone';
  // Advancing under fire = low crawl. The renderer has drawn this since before
  // stance existed; sighting him at 1.6 m while drawing him flat was the one
  // WYSIWYG gap V6 left open.
  if (s.path) return s.suppression > 0.5 ? 'prone' : 'stand';
  const kind = sim.teams[s.teamId]?.orderState.order?.kind;
  if (kind === 'ambush') return 'prone'; // lying up: the reverse-slope ambush
  if (kind === 'defend') return 'crouch'; // dug in on the post
  return s.targetId >= 0 && s.suppression > 0.15 ? 'crouch' : 'stand';
}

export function eyeOf(sim: Sim, s: Soldier): number {
  const st = stanceOf(sim, s);
  return st === 'prone' ? EYE_PRONE : st === 'crouch' ? EYE_CROUCH : EYE_STAND;
}

// The one LOS wrapper every soldier-vision (and vehicle-sight) call site must
// route through: same as map.ts's los(), plus smoke. map.ts's signature stays
// untouched — this only adds smoke's contribution on top of its result. Each
// puff within 1.5m of the ray adds 0.5 opacity, but only if the eye-line at
// the crossing point falls inside the puff's z-interval [z0, z0+h] — so an
// upstairs observer sees over a ground smoke column. >=1 blocks same as
// terrain.
// e0/e1 are the observer's and target's heights above their feet; they feed
// both los()'s profile check and the smoke z-line below, so the two agree.
export function sightBetween(sim: Sim, x0: number, y0: number, x1: number, y1: number, l0 = 0, l1 = 0, e0 = EYE_H, e1 = EYE_H): LosResult {
  const base = los(sim.map, x0, y0, x1, y1, l0, l1, e0, e1);
  if (!base.visible || sim.smoke.length === 0) return base;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const zEye0 = sim.map.elevAt(Math.floor(x0), Math.floor(y0)) + l0 * FLOOR_H + e0;
  const zEye1 = sim.map.elevAt(Math.floor(x1), Math.floor(y1)) + l1 * FLOOR_H + e1;
  let opacity = 0;
  for (const p of sim.smoke) {
    // 1. Cheap reject against the ENLARGED radius (column + full lean), one
    // projection and no z arithmetic. Prunes nearly every puff.
    const t = closestT(p.x, p.y, x0, y0, x1, y1);
    const cx = p.x - (x0 + t * dx);
    const cy = p.y - (y0 + t * dy);
    if (cx * cx + cy * cy > p.r2max) continue;
    // 2. Height of the eye-line where the column's BASE sits.
    const lineZ = zEye0 + (zEye1 - zEye0) * t;
    if (lineZ < p.z0) continue; // the ray passes under the column
    const top = p.z0 + p.h;
    const zc = lineZ < top ? lineZ : top; // clamp to the column top
    // 3. Re-project against the axis AT that height: the column leans downwind
    // by LEAN_K metres per metre of rise, so a tall plume blocks a line its
    // base does not. One fixed-point refinement, no iteration.
    const off = LEAN_K * (zc - p.z0);
    const ax = p.x + WIND.dx * off;
    const ay = p.y + WIND.dy * off;
    const t2 = closestT(ax, ay, x0, y0, x1, y1);
    const bx = ax - (x0 + t2 * dx);
    const by = ay - (y0 + t2 * dy);
    if (bx * bx + by * by > p.r * p.r) continue;
    // 4. Confirm the z-interval at the refined parameter.
    const lineZ2 = zEye0 + (zEye1 - zEye0) * t2;
    if (lineZ2 < p.z0 || lineZ2 > top) continue;
    opacity += 0.5;
  }
  if (opacity >= 1) return { visible: false, cover: 0, conceal: 1 };
  if (opacity > 0) {
    return { visible: true, cover: Math.min(0.95, base.cover + opacity * 0.4), conceal: Math.min(1, base.conceal + opacity) };
  }
  return base;
}

// --- Night rules (design 2026-07-27 §7): three ramps on sim.light ---
// All three are read INSIDE the sense funnel off sim.light, never passed as
// arguments (the sight-funnel-callers scar: a threaded arg must cover the
// vehicle/AT callers, a field read has no call sites to miss). Zero RNG.
// At light === 1 each returns its exact shipped constant, so the whole
// existing suite and every canonical-hour battle is a no-op-by-default.

// Spotting is an ABSOLUTE cap, not a multiplier: SPOT_RANGE=200 is
// measured-inert above ~60 m (decision 2026-07-23 — LOS p95 is 48-56 m), so a
// multiplier does nothing until it cliffs. The knots live in the band the map
// operates in: 90 m sits just above the measured p95 (golden hour clips only
// the rare long sightline), 45 m and 25 m genuinely bite.
export function spotCapOf(light: number): number {
  if (light >= 1) return Infinity; // full day: SPOT_RANGE unchanged
  if (light >= 0.5) return 90 + ((light - 0.5) / 0.5) * (SPOT_RANGE - 90); // golden hour
  if (light >= 0.25) return 45 + ((light - 0.25) / 0.25) * 45; // civil twilight
  return 25 + (light / 0.25) * 20; // night, floored at 25 m
}

/** Concealment a hiding team needs on the ray: 0.5 by day, 0.18 at night — one woods tile or half a hedge hides a sneaking team in the dark. */
export function concealNeedOf(light: number): number {
  return light >= 1 ? 0.5 : 0.18 + 0.32 * light;
}

/** Range beyond which a concealed hider is unseen: 20 m by day, 8 m at night. */
export function hideFloorOf(light: number): number {
  return light >= 1 ? 20 : 8 + 12 * light;
}

// Sight to a soldier: sightBetween plus the spotting rule that completes the
// sneak and ambush orders — a hiding target (sneaking, or lying in untriggered
// ambush) with >= concealNeedOf(light) accumulated concealment (by day: one
// hedge, two woods tiles, or a smoke puff on the ray) is unseen beyond
// hideFloorOf(light) (20 m by day, 8 m at night). Darkness rewards the chosen
// posture only — a squad standing in the open at midnight is still visible;
// the spotCap is what shortens that. An ambush trigger converts the order to
// defend, so the first volley reveals the position — and at night the muzzle
// flash is the brightest thing on a graded-dark field. Deterministic,
// no RNG. Every soldier-target sense (acquire, live fire, ambush trigger,
// honest vision, fog-of-war spotting) routes through this; sight to a map
// point stays on sightBetween and keeps day behaviour (a map point is not
// hiding; friendlyHasLos is a deliberately unlimited-range rule).
// The target's eye is DERIVED here, never passed: no caller may disagree with
// stanceOf about how tall the man it is looking at is. Observers still pass
// their own eye — a vehicle looking at a soldier is EYE_VEHICLE.
export function sightToSoldier(sim: Sim, x0: number, y0: number, t: Soldier, l0 = 0, e0 = EYE_H): LosResult {
  const sight = sightBetween(sim, x0, y0, t.x, t.y, l0, t.level, e0, eyeOf(sim, t));
  const order = sim.teams[t.teamId].orderState.order;
  if (
    sight.visible &&
    sight.conceal >= concealNeedOf(sim.light) &&
    (order?.kind === 'sneak' || order?.kind === 'ambush') &&
    Math.hypot(t.x - x0, t.y - y0) > hideFloorOf(sim.light)
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
export const SPOT_RANGE = 200; // m — beyond every small-arms range
export const CONTACT_TTL = 45 * 30; // ticks a last-known ghost lingers
// A side breaks off the battle when its effectives fall below this share of
// its starting strength, and never while it still has BREAK_FLOOR_MIN men.
export const BREAK_FRACTION = 0.25;
export const BREAK_FLOOR_MIN = 2;

export interface Contact {
  kind: 'infantry' | 'vehicle';
  x: number;
  y: number;
  tick: number;
}

// The ONE shared "can this man execute an order" predicate (movement design
// §1.1): execution (Sim.eligible delegates here), spots.ts's resolver callers
// and the preview overlay all filter through this same function, so the
// preview's dot count can never drift from the mover count.
export function eligible(s: Soldier): boolean {
  return s.alive && !s.downed && !s.captured && s.mental !== 'broken';
}

export class Sim {
  tick = 0;
  rng: Rng;
  // The battle's wall clock (design §7.3): makeStrategicBattle sets startMin
  // from front.clockMin; every direct constructor (tests, scenario.ts) keeps
  // the canonical default, under which light === 1 and every night rule is
  // exactly the shipped day behaviour. NOT in snapshot(): clockMin and light
  // are derivable from (startMin, tick), which snapshot already pins.
  startMin = CANON_CLOCK_MIN;
  private lightTick = -1;
  private lightMemo = 1;
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
  private pendingBooms: BoomEvent[] = [];
  private pendingBreaches: BreachEvent[] = [];
  // Append-only, never drained. The map itself is the single source of truth
  // for where the holes are; this is the ordered record of how it got that way.
  breachLog: BreachEvent[] = [];
  private pendingPlanes: { x0: number; y: number; x1: number }[] = [];
  private pendingUnitEvents: UnitEvent[] = [];
  private pendingMeleeEvents: MeleeEvent[] = [];
  // Per-squad move state, indexed by squad id. Read-only for the UI (route preview).
  squadDest: ({ x: number; y: number } | null)[] = [];
  squadWaypoints: { x: number; y: number }[][] = [];
  // The direction each side expects its enemy from before intel exists — the
  // attacker always enters at the west spawn (bridge.ts), so staging sets
  // attacker 0 / defender π. threatBearing's last rung reads this instead of
  // guessing due east when men dig in where they stand. Static per battle,
  // never serialized: staging re-derives it.
  threatAxis: Record<Side, number> = { blue: 0, red: Math.PI };
  smoke: Smoke[] = [];
  droppedKit: DroppedKit[] = [];
  // Recent-casualty flags for dangerScore/ambush triggers, indexed by squad/team id.
  squadLastCasualty: number[] = [];
  teamLastCasualty: number[] = [];
  private sneakBaseline: number[] = []; // per-team wound count when a sneak order started
  private leaderVacantSince = new Map<number, number>(); // teamId -> tick its leader died, pending the 10s promotion
  // Mortar rounds in flight: 3s from trigger to impact (spec: indirect fire).
  private mortarShells: { tick: number; x: number; y: number; smoke: boolean }[] = [];
  private pendingGrenades: { x: number; y: number; fuse: number; l: number }[] = [];
  // Staggered dismount: one passenger every 0.5s (spec: "1 per 0.5s").
  private dismountQueue: { vehicleId: number; soldierId: number; tick: number }[] = [];
  private pathBudget = PATH_BUDGET_PER_TICK;
  private pendingPaths = new Map<number, { spot: { x: number; y: number; l: number } }>();

  constructor(readonly map: GameMap, seed: number) {
    this.rng = mulberry32(seed);
  }

  /** Wall-clock minute of the battle: startMin + elapsed sim time (30 ticks/s = 1800 ticks a minute). Pure in (startMin, tick). */
  get clockMin(): number {
    return this.startMin + this.tick / 1800;
  }

  // Light level 0..1 (solar.ts lightAt): 1 through the core of the day, 0 in
  // astronomical dark. A pure function of (startMin, tick) — no RNG, no
  // accumulation; the memo is keyed on the tick and only skips recomputing
  // the same value. Read INSIDE the sense funnel (sightToSoldier,
  // updateSpotting, sideSeesPoint), never passed as an argument — a new
  // per-observer argument is the trap the sight-funnel-callers note records.
  get light(): number {
    if (this.lightTick !== this.tick) {
      this.lightTick = this.tick;
      this.lightMemo = lightAt(this.clockMin);
    }
    return this.lightMemo;
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
      level: 0,
      climbLeft: 0,
      scrambleLeft: 0,
      wallTarget: null,
      grenadesLeft: m.grenades ?? 0,
      grenadeCooldownUntil: 0,
      entryHoldUntil: 0,
      captured: false,
      lastCowedTick: -Infinity,
      hitDx: 0,
      hitDy: 0,
      hitTick: -Infinity,
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
          grenades: ov?.grenades ?? slot.grenades,
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
  // Public since the deployment phase (V2): pre-tick placement shares the
  // spawn nudge — deterministic expanding ring, zero rng draws.
  nudgeSpawn(x: number, y: number): { x: number; y: number } {
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
      if (m.alive && !m.downed && !m.captured && m.role === 'assistant' && Math.hypot(m.x - s.x, m.y - s.y) <= 3) return 1;
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
      crushLeft: 0,
      wallTarget: null,
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
    // Crush mode, not plain 'vehicle': the pathfinder is where a hull decides
    // it would rather go through the garden wall than the long way round, and
    // CRUSH_STEP is what stops it doing so casually.
    const path = astar(this.map, Math.floor(v.x), Math.floor(v.y), spot.x, spot.y, crushMode(v.kind));
    if (path && path.length > 1) {
      v.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
      v.pathI = 0;
    }
  }

  // Nearest tile a vehicle may actually occupy. The test MUST be canStep's
  // (TerrainDef.noVehicle), not a local key list: returning a tile astar can
  // never enter makes orderVehicleMove find no route and drop the order in
  // silence. That is the bug the old 'floor'/'woods'/'hedge' list already had
  // for 'bank' — an embankment batter was a legal destination and an illegal
  // step — and it is why furniture must be excluded here as well as in canStep.
  private findVehicleSpot(x: number, y: number): { x: number; y: number } | null {
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.map.inBounds(nx, ny)) continue;
          const t = this.map.terrainAt(nx, ny);
          if (t.passable && !t.noVehicle) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  // Crewed weapon (spec §4): spawns the matching crew squad (EMPLACEMENT_CREW)
  // and binds its one team to a new Emplacement, same shape as addVehicle's
  // crew binding. Crew are snapped onto tight (<=3m) formation offsets so
  // they start well inside CREW_RADIUS instead of addSquadFromDef's wider scatter.
  // `roster` passes through to addSquadFromDef: campaign staging fields crew
  // squads as emplacements without losing named men, pids, or attrition.
  addEmplacement(side: Side, kind: EmplacementKey, x: number, y: number, facing = 0, initialState: 'packed' | 'deployed' = 'packed', roster?: Partial<MemberInit>[][]): Emplacement {
    const def: EmplacementDef = EMPLACEMENTS[kind];
    const squad = this.addSquadFromDef(side, EMPLACEMENT_CREW[kind], x, y, roster);
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
      wallTarget: null,
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

  // ── Player-directed breaching (design D5) ─────────────────────────────────
  // The point-target affordance orderFire established for the mortar HE point,
  // pointed at a wall instead of at ground. Each order resolves the click to
  // ONE edge up front (nearestBreachable) and stores that edge, so the wall the
  // player picked is the wall the gun shoots — the alternative, re-deriving the
  // nearest edge from the click point every tick, silently retargets the moment
  // the first hole changes what "nearest" means.
  //
  // All three return the edge that was taken, or null when nothing standing is
  // near the click / the selection has no gun for the job. The UI shows the
  // button off that same predicate, so a button that is there always fires.

  // Tanks and assault guns. A halftrack (gunPen 0) has nothing to shoot with.
  orderVehicleBreach(vehicleId: number, x: number, y: number): EdgeRef | null {
    const v = this.vehicles[vehicleId];
    if (!v || !v.alive || VEHICLES[v.kind].gunPen <= 0) return null;
    const t = nearestBreachable(this.map, x, y, WALL_TARGET_RADIUS);
    if (t) v.wallTarget = t;
    return t;
  }

  // Deployed AT guns (at57 / pak40). Mortars are excluded by the pen test:
  // 5 energy of 81 mm never opens masonry, so a wall order would be a lie.
  orderEmplacementBreach(empId: number, x: number, y: number): EdgeRef | null {
    const e = this.emplacements[empId];
    if (!e) return null;
    const w: WeaponDef = WEAPONS[EMPLACEMENTS[e.kind].weapon];
    if (w.pen === undefined) return null;
    const t = nearestBreachable(this.map, x, y, WALL_TARGET_RADIUS);
    if (t) e.wallTarget = t;
    return t;
  }

  // Every AT man in the team takes the same edge. Usually that is one bazooka
  // gunner; a Gruppe with two stashed fausts double-taps the wall, which is
  // fine — the second man's target self-clears the tick the hole appears.
  orderTeamBreach(teamId: number, x: number, y: number): EdgeRef | null {
    const team = this.teams[teamId];
    if (!team) return null;
    const t = nearestBreachable(this.map, x, y, WALL_TARGET_RADIUS);
    if (!t) return null;
    let any = false;
    for (const id of team.soldierIds) {
      const s = this.soldiers[id];
      if (!this.eligible(s) || s.inVehicle >= 0 || !canBreachByHand(s)) continue;
      s.wallTarget = t;
      any = true;
    }
    return any ? t : null;
  }

  orderSquadBreach(squadId: number, x: number, y: number): EdgeRef | null {
    const squad = this.squads[squadId];
    if (!squad) return null;
    let taken: EdgeRef | null = null;
    for (const tid of squad.teamIds) taken = this.orderTeamBreach(tid, x, y) ?? taken;
    return taken;
  }

  // Is this wall target still worth shooting at, and can the firer reach it?
  // The sight ray aims at the firer's OWN FACE of the edge (the BREACH_FACE_EPS
  // nudge breachScan uses, and for the same reason): the midpoint sits exactly
  // on the edge line and floors into the far tile from one side, so asking for
  // LOS to it would run the ray through the very wall under test and no gun
  // could ever engage a head-high wall from that side.
  private wallShotReady(t: EdgeRef, fx: number, fy: number, l: number, e0: number, range: number): boolean {
    const m = edgeMid(t);
    if (Math.hypot(m.x - fx, m.y - fy) > range) return false;
    const gx = t.horiz ? m.x : fx < t.x ? t.x - BREACH_FACE_EPS : t.x + BREACH_FACE_EPS;
    const gy = t.horiz ? (fy < t.y ? t.y - BREACH_FACE_EPS : t.y + BREACH_FACE_EPS) : m.y;
    return sightBetween(this, fx, fy, gx, gy, l, 0, e0, EYE_H).visible;
  }

  // One aimed round into the edge, detonating ON the midpoint — which is what
  // guarantees the aimed edge opens: breachScan reaches it at distance 0, where
  // 12 energy clears even MASONRY's 9. Ground burst (l = 0) like every other
  // explode caller; a wall is a wall whatever floor the gunner is standing on.
  private fireWallShot(fx: number, fy: number, t: EdgeRef): void {
    const m = edgeMid(t);
    this.pendingEvents.push({ fx, fy, tx: m.x, ty: m.y, hit: true, kill: false });
    this.explode(m.x, m.y, WALL_SHOT, 0);
  }

  // A wall target that somebody else already opened is spent. Called at the top
  // of each firer's wall-shot branch so the order clears itself whoever got
  // there first — the tank's own round, a sister team's faust, or a hull.
  private wallTargetSpent(t: EdgeRef): boolean {
    return edgeClass(this.map, t.x, t.y, t.horiz) === ECLASS.NONE;
  }

  private stepEmplacements(): void {
    for (const e of this.emplacements) this.updateEmplacement(e);
    if (this.mortarShells.length === 0) return;
    this.mortarShells = this.mortarShells.filter((sh) => {
      if (this.tick < sh.tick) return true;
          // Mortar/barrage smoke lands at ground level 0, wherever it falls.
      if (sh.smoke) this.smoke.push(smokePuff(sh.x, sh.y, this.map.elevAt(Math.floor(sh.x), Math.floor(sh.y)), 60));
      else this.explode(sh.x, sh.y, { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 75], breach: 5, kind: 'mortar' }); // 81 mm: opens a head-high enclosure wall, never masonry
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
    // A player-assigned wall outranks whatever the gun would have picked for
    // itself — a deliberate order beats autonomous acquisition, and it is one
    // round. If the shot is not on (out of range, no LOS, crew dry) the gun
    // falls through and fights normally rather than sitting inert.
    if (e.wallTarget && w.pen !== undefined) {
      if (this.wallTargetSpent(e.wallTarget)) {
        e.wallTarget = null;
      } else if (this.wallShotReady(e.wallTarget, e.x, e.y, 0, EYE_H, w.range) && this.consumeEmplacementAmmo(e, firer, w.ammo.type)) {
        firer.crewSkill.gun = Math.min(1, (firer.crewSkill.gun ?? 0) + 0.0005);
        this.fireWallShot(e.x, e.y, e.wallTarget);
        e.wallTarget = null;
        e.cooldown = w.cooldown * degrade;
        return;
      }
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
      if (d <= w.range && d < bestD && sightBetween(this, e.x, e.y, v.x, v.y, 0, 0, EYE_H, HULL_VEHICLE).visible) {
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
    // A served gun sights at about chest height, so emplacements keep EYE_H
    // (passed explicitly, not defaulted, so the grep gate sees an answer here).
    const targetId = this.acquireSoldierTarget(e.x, e.y, e.side, w.range, arc, 0, EYE_H);
    if (targetId < 0) return;
    const t = this.soldiers[targetId];
    let aim = this.aimFactor(firer) * this.crewAimMult(firer, w);
    if (arc && this.inArc(e.x, e.y, t.x, t.y, arc)) aim *= 1.25;
    if (order?.kind === 'defend' && crewTeam.ambushBonusTick === this.tick) aim *= 1.3;
    const p = this.shotPreview(e.x, e.y, def.weapon, t, false, aim, 0, EYE_H);
    if (!p.visible) return;
    if (!this.consumeEmplacementAmmo(e, firer, w.ammo.type)) return;
    firer.crewSkill.mg = Math.min(1, (firer.crewSkill.mg ?? 0) + 0.0005);
    const hit = this.rng.next() < p.acc;
    const kill = hit ? this.wound(t, this.rng.range(w.damage[0], w.damage[1]), e.x, e.y) : false;
    this.suppressAround(t.x, t.y, t.side, w.suppression, w.suppRadius);
    this.pendingEvents.push({ fx: e.x, fy: e.y, tx: t.x, ty: t.y, hit, kill, weapon: def.weapon, targetId: t.id });
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

  // Ordered movement resolves its per-soldier tiles through the shared
  // resolver (movement design §1.4): it walks findSpot's ring with a cover
  // scorer inside SNAP_R, fills `used` itself, and omits men with no footing
  // in reach (findSpot's null, same silent skip as before). ORDERED movement
  // only — findSpot still owns dismount, vehicle bail and flee, which have no
  // formation anchor and no player preview. The resolver runs once here, at
  // order time, which is what keeps it inside the pathBudget amortization
  // below; it must never be called per tick.
  private moveSoldiersTo(
    soldierIds: number[],
    wx: number,
    wy: number,
    gl = 0,
    facing?: number,
    width?: number,
    kind: OrderKind = 'move',
    arc?: [number, number],
    used: Set<number> = new Set<number>(),
  ): void {
    const eligibleIds = soldierIds.filter((id) => this.eligible(this.soldiers[id]));
    const spots = resolveMoveSpots(this, { soldierIds: eligibleIds, x: wx, y: wy, facing, width, kind, arc, l: gl }, used);
    for (const spot of spots) {
      const sid = spot.sid;
      const s = this.soldiers[sid];
      // Select-all + one order is ~140 full-map A* searches in a single tick
      // (~250 ms, a visible freeze). Over budget, the search is deferred to a
      // later tick — the assigned formation spot is reserved now, so the
      // resulting path is the same one it would have got, just later. A
      // pending entry keyed by soldier means a re-order overwrites rather
      // than queues twice. No rng is involved in pathing, so deferral cannot
      // perturb the shared rng stream.
      if (this.pathBudget > 0) {
        this.pathBudget--;
        this.pathTo(s, spot);
      } else {
        this.pendingPaths.set(sid, { spot });
      }
    }
  }

  // The spot carries its own floor: the resolver only hands out tiles that have
  // the storey, so the goal level is a property of the destination and never a
  // second argument that can disagree with it.
  private pathTo(s: Soldier, spot: { x: number; y: number; l: number }): void {
    const gl = spot.l;
    let path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y, 'foot', s.level, gl);
    if (!path && gl > 0) {
      path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y, 'foot', s.level, 0);
    }
    if (path && path.length > 1) {
      if (s.task) this.dropTask(s); // direct orders override a rescue/ammo run
      s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
      s.pathI = 0;
      s.fleeing = false;
    }
  }

  private drainPendingPaths(): void {
    if (this.pendingPaths.size === 0) return;
    for (const [sid, req] of this.pendingPaths) {
      if (this.pathBudget <= 0) return;
      this.pendingPaths.delete(sid);
      const s = this.soldiers[sid];
      if (!this.eligible(s)) continue; // died/broke while queued: drop it
      this.pathBudget--;
      this.pathTo(s, req.spot);
    }
  }

  private eligible(s: Soldier): boolean {
    return eligible(s); // the module-scope export above — one predicate, no drift
  }

  // Still on his way: walking a path, or waiting on one. PATH_BUDGET_PER_TICK
  // defers most of a big commit's searches to later ticks, and every "has
  // this leg finished" test that read `path` alone took a man still waiting
  // for his search as a man who had arrived — an order issued to the tenth
  // team in a tick was declared complete on the next (#763).
  private marching(id: number): boolean {
    return this.soldiers[id].path !== null || this.pendingPaths.has(id);
  }

  // Men who stop where they are — the half that holds while the other rushes,
  // a team that balks mid-move: halted, and not about to be started again by
  // a search still queued from before.
  private halt(ids: number[]): void {
    for (const id of ids) {
      this.soldiers[id].path = null;
      this.pendingPaths.delete(id);
    }
  }

  // A leg dispatched inside a running order is a continuation of it, not a
  // new order: a man who left the bound to reach a casualty, carry belts or
  // take over a gun is not pulled off it by the next leg. pathTo's task drop
  // is for real orders.
  private offTask(ids: number[]): number[] {
    return ids.filter((id) => !this.soldiers[id].task);
  }

  // The order vocabulary's entry point (spec's "interpret + refuse"): runs
  // compliance, stores the legibility state, and kicks off execution.
  // `used` is the ONE tile-reservation set of the whole player commit —
  // orderSquad shares it across its teams and a multi-squad click shares it
  // across squads, so clumped anchors cannot resolve two men onto one tile.
  orderTeam(teamId: number, order: TeamOrder, used?: Set<number>): void {
    const team = this.teams[teamId];
    if (!team) return;
    const eligibleIds = team.soldierIds.filter((id) => this.eligible(this.soldiers[id]));
    if (eligibleIds.length === 0) return;

    // Assault is the scariest ask: same danger evaluation, weighted up before
    // the ladder runs. Checked ONCE — a charge that steps off is committed
    // (no bounding, no per-leg re-check); pinned/broken men drop out via the
    // psych model instead. An order that moves nobody is never refused
    // (orderVerdict).
    const verdict = orderVerdict(this, team, order).verdict;
    if (verdict === 'balk') {
      team.orderState = { order, phase: 'balked', reason: order.kind === 'assault' ? CHARGE_BALK_REASON : BALK_REASON };
      if (order.kind === 'sneak') this.sneakBaseline[team.id] = this.woundCount(team); // a refused sneak still holds fire until someone is hit
      return;
    }
    const cautious = verdict === 'cautious';
    const effective: TeamOrder =
      cautious && (order.kind === 'fast' || order.kind === 'assault') ? { ...order, kind: 'move' } : order;
    const reason = cautious ? (order.kind === 'assault' ? 'unwilling to charge — advancing instead' : 'moving cautiously') : '';

    if (effective.kind === 'move' && (cautious || this.teamUnderFire(team))) {
      team.orderState = { order: effective, phase: 'bounding_a', reason };
      const [a, b] = this.teamHalves(team);
      this.halt(b);
      this.dispatchLeg(a, effective, used);
    } else if (effective.kind === 'move' || effective.kind === 'fast' || effective.kind === 'sneak' || effective.kind === 'assault') {
      team.orderState = { order: effective, phase: 'executing', reason };
      if (effective.kind === 'sneak') this.sneakBaseline[team.id] = this.woundCount(team);
      const gl = orderLevel(this, effective.kind, effective.x, effective.y, effective.l);
      this.moveSoldiersTo(team.soldierIds, effective.x, effective.y, gl, effective.facing, effective.width, effective.kind, undefined, used);
    } else if (effective.kind === 'smoke') {
      // A throw that cannot happen must say so — a silently swallowed smoke
      // order reads as "smoke is broken".
      if (this.deploySmoke(team, effective)) {
        team.orderState = { order: effective, phase: 'executing', reason };
      } else {
        const why = team.smokeLeft <= 0 ? 'no smoke grenades left' : `too far to throw smoke — get within ${SMOKE_THROW_M} m`;
        team.orderState = { order: effective, phase: 'balked', reason: why };
      }
    } else if (effective.kind === 'defend' || effective.kind === 'ambush') {
      team.orderState = { order: effective, phase: 'executing', reason };
      // Auto-top-floor garrison: the defend/ambush default, owned by orderLevel
      // so the preview can show the same storey the men will hold.
      const gl = orderLevel(this, effective.kind, effective.x, effective.y, effective.l);
      this.moveSoldiersTo(team.soldierIds, effective.x, effective.y, gl, effective.facing, effective.width, effective.kind, effective.arc, used);
    } else {
      // fire: no movement, members engage per updateSoldier's combat section
      team.orderState = { order: effective, phase: 'executing', reason };
    }
  }

  // Squad click broadcasts to teams (spec §1), offsetting each team's
  // destination by team index x 8m so a multi-team squad doesn't stack.
  // A direct order overrides any queued waypoint route. One `used` set spans
  // every team of the squad (and, when the caller passes one, every squad of
  // the commit), so neighbouring teams never resolve onto the same tile.
  orderSquad(squadId: number, order: TeamOrder, used: Set<number> = new Set<number>()): void {
    const squad = this.squads[squadId];
    if (!squad) return;
    this.squadWaypoints[squadId] = [];
    const isMoveKind = order.kind === 'move' || order.kind === 'fast' || order.kind === 'sneak' || order.kind === 'assault';
    this.squadDest[squadId] = isMoveKind ? { x: order.x, y: order.y } : null;
    const n = squad.teamIds.length;
    // A point tool (smoke, fire) carries a TARGET, not a destination: fanning
    // it would throw one squad's smoke in as many places as it has teams —
    // measured 4.1 m of scatter on a two-team squad, and it can push the far
    // team outside its own throw range. Only destination orders fan.
    if (!isMoveKind && order.kind !== 'defend' && order.kind !== 'ambush') {
      squad.teamIds.forEach((teamId) => this.orderTeam(teamId, order, used));
    } else if (order.facing === undefined) {
      // Legacy: fan teams along y axis only
      const offs = fanOffsets(n, TEAM_FAN);
      squad.teamIds.forEach((teamId, ti) => {
        this.orderTeam(teamId, { ...order, y: order.y + offs[ti] }, used);
      });
    } else {
      // Formation: fan teams along the facing axis within order.width
      const share = (order.width ?? n * TEAM_FAN) / n;
      const offs = fanOffsets(n, share);
      const cos = Math.cos(order.facing);
      const sin = Math.sin(order.facing);
      squad.teamIds.forEach((teamId, ti) => {
        const dx = cos * offs[ti];
        const dy = sin * offs[ti];
        this.orderTeam(teamId, { ...order, x: order.x + dx, y: order.y + dy, width: share }, used);
      });
    }
  }

  private teamUnderFire(team: Team): boolean {
    return team.soldierIds.some((id) => {
      const s = this.soldiers[id];
      return s.alive && !s.downed && !s.captured && s.suppression > 0.35;
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
  // `used` is the commit-wide tile reservation (see orderTeam). A bounding
  // team that skipped it reserved nothing and respected nothing, which is the
  // very stacking the shared set exists to stop — and it made preview disagree
  // with execution for exactly the teams that are cautious or under fire.
  private dispatchLeg(ids: number[], order: TeamOrder, used?: Set<number>): void {
    const centroid = this.centroidOf(ids);
    if (!centroid) return;
    const dx = order.x - centroid.x;
    const dy = order.y - centroid.y;
    const d = Math.hypot(dx, dy);
    const leg = Math.min(BOUND_LEG, d);
    const target = d < 0.01 ? { x: order.x, y: order.y } : { x: centroid.x + (dx / d) * leg, y: centroid.y + (dy / d) * leg };
    this.moveSoldiersTo(ids, target.x, target.y, 0, undefined, undefined, 'move', undefined, used);
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
    if (activeIds.some((id) => this.eligible(this.soldiers[id]) && this.marching(id))) return; // mid-leg
    const centroid = this.centroidOf(team.soldierIds);
    const done = (): void => {
      st.order = null;
      st.phase = 'idle';
      st.reason = '';
    };
    if (!centroid || Math.hypot(centroid.x - order.x, centroid.y - order.y) < 3) {
      done();
      return;
    }
    const danger = dangerScore(this, team, { x: order.x, y: order.y });
    if (compliance(this, team, danger) === 'balk') {
      st.phase = 'balked';
      st.reason = BALK_REASON;
      return;
    }
    const moving = (ids: number[]): boolean => ids.some((id) => this.marching(id));
    this.dispatchLeg(this.offTask(otherIds), order);
    if (moving(otherIds)) {
      st.phase = st.phase === 'bounding_a' ? 'bounding_b' : 'bounding_a';
      return;
    }
    // The other half has nowhere to go — on its spots already, or nobody left
    // in it — so the half that just rushed goes again. When that half cannot
    // move either, the team is as far forward as this order takes it. The
    // centroid test above cannot say so for a team whose cover spots sit off
    // the order point, and such a team alternated every tick for the rest of
    // the battle (measured: 23,174 flips in one), re-resolving its spots each
    // time.
    this.dispatchLeg(this.offTask(activeIds), order);
    if (!moving(activeIds)) done();
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

  // Rifle-team smoke: 2 puffs at the point (<= SMOKE_THROW_M from the team),
  // 60s ttl, 2/battle budget. Mortar smoke arrives with emplacements (Task 9).
  // Returns whether the throw happened — orderTeam surfaces a refusal.
  private deploySmoke(team: Team, order: TeamOrder): boolean {
    if (team.smokeLeft <= 0) return false;
    const centroid = this.centroidOf(team.soldierIds);
    if (!centroid || Math.hypot(order.x - centroid.x, order.y - centroid.y) > SMOKE_THROW_M) return false;
    team.smokeLeft--;
    // Column base = ground elevation + deployer's floor level: smoke thrown
    // from an upstairs window screens that floor, not the street.
    const deployer = team.soldierIds.map((id) => this.soldiers[id]).find((s) => s.alive);
    const z0 = this.map.elevAt(Math.floor(order.x), Math.floor(order.y)) + (deployer?.level ?? 0) * FLOOR_H;
    this.smoke.push(smokePuff(order.x - 1, order.y, z0, 60));
    this.smoke.push(smokePuff(order.x + 1, order.y, z0, 60));
    return true;
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
        if (!e.alive || e.downed || e.captured || e.side !== enemySide) continue;
        if (order.arc && !this.inArc(s.x, s.y, e.x, e.y, order.arc)) continue;
        const d = Math.hypot(e.x - s.x, e.y - s.y);
        if (d <= thresh && sightToSoldier(this, s.x, s.y, e, s.level, eyeOf(this, s)).visible) {
          triggered = true;
          break outer;
        }
      }
    }
    if (triggered) {
      order.kind = 'defend';
      team.ambushBonusTick = this.tick;
      // Fires once: the order is 'defend' from here, so this site is never
      // reached again for it. Anchor on the first live member, else the first
      // listed man — position only, no state read that could vary.
      let anchor: Soldier | undefined;
      for (const sid of team.soldierIds) {
        const m = this.soldiers[sid];
        if (this.eligible(m)) {
          anchor = m;
          break;
        }
      }
      anchor ??= this.soldiers[team.soldierIds[0]];
      if (anchor) this.pendingUnitEvents.push({ kind: 'ambush', x: anchor.x, y: anchor.y, side, name: team.name });
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

  // I10 · interiors §5.2. The ring scan that actually places a garrisoning
  // squad. It used to return the FIRST passable unused tile in ring order,
  // which on a furnished map lands a man in the middle of the floor with the
  // window nook one tile away. Now it takes the highest-scoring tile, ties to
  // the first in the same iteration order.
  //
  // The guard is airtight two ways over. `garrisonScore` is identically 0
  // unless the map is furnished, so max-with-first-wins would return exactly
  // the old tile anyway; and because that is true, the unfurnished path keeps
  // the old EARLY RETURN as well, so it is not merely behaviourally identical
  // but the same instructions in the same order at the same cost. The scoring
  // path is the only one that pays for the full 121-tile sweep.
  private findSpot(x: number, y: number, used: Set<number>): { x: number; y: number } | null {
    const scored = this.map.hasFurniture;
    let best: { x: number; y: number } | null = null;
    let bestScore = -1;
    for (let r = 0; r <= 5; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!this.map.inBounds(nx, ny) || !this.map.terrainAt(nx, ny).passable) continue;
          if (used.has(ny * this.map.w + nx)) continue;
          if (!scored) return { x: nx, y: ny };
          const s = this.garrisonScore(nx, ny);
          if (s > bestScore) {
            bestScore = s;
            best = { x: nx, y: ny };
            if (s === 3) return best; // nothing can beat a covered nook
          }
        }
      }
    }
    return best;
  }

  // A garrison tile is worth more if it is a firing position. Deliberately NOT
  // scored on generic terrain cover: doing that would move formation spots on
  // open ground on every map, which is a large unrelated behaviour change
  // hiding inside an interiors task.
  private garrisonScore(x: number, y: number): number {
    if (this.map.buildingIdAt(x, y) < 0) return 0;
    const nook =
      this.map.hEdge(x, y) === EDGE.WINDOW ||
      this.map.hEdge(x, y + 1) === EDGE.WINDOW ||
      this.map.vEdge(x, y) === EDGE.WINDOW ||
      this.map.vEdge(x + 1, y) === EDGE.WINDOW
        ? 2
        : 0;
    // 0.40 is furn_heavy's coverBehind — a counter, a pew block or a dresser
    // in one of the four orthogonal neighbours (sim.coverAt maxes them).
    const cov = this.coverAt(x + 0.5, y + 0.5) >= 0.4 ? 1 : 0;
    return nook + cov;
  }

  takeEvents(): ShotEvent[] {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  takeBooms(): BoomEvent[] {
    const b = this.pendingBooms;
    this.pendingBooms = [];
    return b;
  }

  // Deliberately NOT routed through takeBooms: that path stamps a scorch decal
  // and punches a roof hole, and a flattened garden wall is not a crater.
  takeBreaches(): BreachEvent[] {
    const b = this.pendingBreaches;
    this.pendingBreaches = [];
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
    this.pathBudget = PATH_BUDGET_PER_TICK;
    this.drainPendingPaths();
    this.stepWaypoints();
    this.stepBarrages();
    this.stepStrafes();
    this.stepSmoke();
    this.stepGrenades();
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
      if (!s.alive || s.downed || s.captured) continue;
      if (s.side === 'blue') blue++;
      else red++;
    }
    if (this.winner === null) {
      if (blue < this.breakFloor('blue') && red >= this.breakFloor('red')) this.winner = 'red';
      else if (red < this.breakFloor('red') && blue >= this.breakFloor('blue')) this.winner = 'blue';
      else if (blue === 0 && red > 0) this.winner = 'red';
      else if (red === 0 && blue > 0) this.winner = 'blue';
    }
  }

  // Effectives below which `side` breaks off the battle. Public: the HUD
  // quotes it.
  breakFloor(side: Side): number {
    return Math.max(BREAK_FLOOR_MIN, this.startStrength[side] * BREAK_FRACTION);
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
        if (!s.alive || s.downed || s.captured || s.mental === 'broken') continue;
        eligible++;
        // a rescue task counts as busy: it holds path=null for a tick on pickup,
        // and auto-dispatching the next leg would silently cancel the rescue.
        // A melee lock is busy too — pathless for seconds, but hardly "arrived".
        if (this.marching(s.id) || s.task || s.meleeId >= 0) moving++;
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
      // breach 0, and that is a decision, not an omission: a 20 mm cannon
      // strafing run chews masonry cosmetically and opens nothing.
      this.explode(s.x, s.y, { suppRadius: 12, fragRadius: 5, frags: 2, dmg: [25, 70], breach: 0, kind: 'bomb' });
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
    for (const p of this.smoke) {
      p.ttl -= DT;
      p.age += DT;
      agePuff(p); // once per puff per tick; sightBetween only ever reads the cache
    }
    this.smoke = this.smoke.filter((p) => p.ttl > 0);
  }

  private stepGrenades(): void {
    for (let i = this.pendingGrenades.length - 1; i >= 0; i--) {
      const g = this.pendingGrenades[i];
      if (--g.fuse <= 0) {
        this.explode(g.x, g.y, GRENADE_BLAST, g.l);
        this.pendingGrenades.splice(i, 1);
      }
    }
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
      if (st.phase === 'balked') {
        // Refusing to walk somewhere does not suspend the fire discipline the
        // order carries. A team that balked on the way to an ambush is lying
        // up where it stopped, and skipping its trigger left it holding fire
        // until it was dead (#764: one team mute for 53,985 of 54,000 ticks).
        this.checkFireDiscipline(team, order);
        continue;
      }
      if (order.kind === 'move' && (st.phase === 'bounding_a' || st.phase === 'bounding_b')) {
        this.continueBounding(team, order, st);
      } else if ((order.kind === 'move' || order.kind === 'fast' || order.kind === 'sneak') && st.phase === 'executing') {
        const eligibleIds = team.soldierIds.filter((id) => this.eligible(this.soldiers[id]));
        if (eligibleIds.length > 0 && eligibleIds.every((id) => !this.marching(id))) {
          st.order = null;
          st.phase = 'idle';
          st.reason = '';
        } else if (order.kind !== 'sneak' && (this.tick + team.id) % REAUDIT_TICKS === 0 && this.teamUnderFire(team)) {
          // Refusal re-audit mid-execution (see REAUDIT_TICKS). Sneak keeps
          // its own break rule; assault stays committed by design (1702-1705).
          // Balk latches — the existing no-oscillation semantics; cautious
          // drops into the same bounding machinery issuance would have used.
          const danger = dangerScore(this, team, { x: order.x, y: order.y });
          const verdict = compliance(this, team, danger);
          if (verdict === 'balk') {
            st.phase = 'balked';
            st.reason = BALK_REASON;
            this.halt(eligibleIds);
          } else if (verdict === 'cautious') {
            if (order.kind === 'fast') st.order = { ...order, kind: 'move' };
            const eff = st.order!;
            st.phase = 'bounding_a';
            st.reason = 'moving cautiously';
            const [a, b] = this.teamHalves(team);
            this.halt(b);
            this.dispatchLeg(this.offTask(a), eff);
          }
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
              // Level-aware (#130): path to the defender's own storey. The
              // level-blind form pathed to the ground tile UNDER an upstairs
              // holdout — always reachable inside a building — so the order
              // hung "blocked" forever while nobody could climb to him.
              const p = astar(this.map, Math.floor(m.x), Math.floor(m.y), Math.floor(e.x), Math.floor(e.y), 'foot', m.level, e.level);
              return p !== null && p.length > 1;
            });
          });
        if (settled && !blocked) {
          st.order = null;
          st.phase = 'idle';
          st.reason = '';
        }
      }
      this.checkFireDiscipline(team, order);
    }
  }

  // The two orders that hold fire, and what releases each.
  private checkFireDiscipline(team: Team, order: TeamOrder): void {
    if (order.kind === 'sneak') this.checkSneakBreak(team);
    else if (order.kind === 'ambush') this.checkAmbushTrigger(team, order);
  }

  private explode(
    x: number,
    y: number,
    p: Blast = {
      suppRadius: 15,
      fragRadius: 9,
      frags: 3,
      dmg: [25, 75],
      breach: 4, // 60 mm mortar / unqualified blast
      kind: 'shell', // the one caller that takes the default is the off-map barrage
    },
    l = 0, // detonation level (floor); all current callers are ground-bursts
  ): void {
    this.pendingBooms.push({ x, y, r: p.fragRadius, kind: p.kind });
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
      // Slab attenuation: integer level compare + repeated multiply (no pow)
      // — same-level victims get atten 1, byte-identical to pre-3D behavior.
      let atten = 1;
      for (let i = Math.abs(s.level - l); i > 0; i--) atten *= SLAB_SUPP_FACTOR;
      s.suppression = Math.min(1, s.suppression + 0.6 * (1 - d / p.suppRadius) * (1.3 - s.courage * 0.6) * mult * atten);
      if (d > p.fragRadius) continue;
      // Blast LOS is deliberately stance-NEUTRAL (both eyes default to EYE_H):
      // threading a prone body height in here would silently change explosion
      // lethality on every map that already exists. Pinned by a test.
      if (!los(this.map, x, y, s.x, s.y, l, s.level).visible) continue; // walls/floors stop fragments
      const frags = d < 2 ? p.frags : d < p.fragRadius * 0.55 ? Math.max(1, p.frags - 1) : 1;
      for (let i = 0; i < frags; i++) {
        const pHit = (1 - d / (p.fragRadius + 1)) * (s.downed || s.mental === 'pinned' ? 0.45 : 0.8) * mult;
        if (this.rng.next() < pHit) {
          if (this.wound(s, this.rng.range(p.dmg[0], p.dmg[1]), x, y)) break;
        }
      }
    }
    // Appended AFTER the soldier loop and drawing nothing from this.rng, so
    // the frag/suppression order above is untouched (tests/blast.test.ts).
    if (p.breach) this.breachScan(x, y, p.fragRadius, p.breach, l);
  }

  // Deterministic candidate scan (§1.2). One integer pass over the tiles the
  // frag radius covers; at each cell the north (h) edge then the west (v)
  // edge, row-major — a fixed order, so the 4-edge cap always takes the same
  // four edges on a replay. The cap bounds the render invalidation set and
  // stops one 81 mm round deleting a whole courtyard.
  //
  // The cheap test runs first, deliberately: the raw edge byte, then the
  // distance, then the threshold, and only then the los() occlusion guard —
  // a full grid traversal that must not run on a burst inside a courtyard
  // for every wall of the house next door. Do not reorder these.
  private breachScan(bx: number, by: number, radius: number, energy: number, l: number): void {
    if (radius <= 0) return;
    const map = this.map;
    const wide = energy >= BREACH_WIDE_ENERGY;
    const x0 = Math.floor(bx - radius);
    const x1 = Math.floor(bx + radius) + 1;
    const y0 = Math.floor(by - radius);
    const y1 = Math.floor(by + radius) + 1;
    let opened = 0;
    for (let ty = y0; ty <= y1 && opened < BREACH_CAP; ty++) {
      for (let tx = x0; tx <= x1 && opened < BREACH_CAP; tx++) {
        for (let k = 0; k < 2; k++) {
          const horiz = k === 0;
          const e = horiz ? map.hEdge(tx, ty) : map.vEdge(tx, ty);
          if (e === EDGE.NONE || e === EDGE.BREACH) continue;
          // midpoint of the edge span, for the falloff
          const mx = horiz ? tx + 0.5 : tx;
          const my = horiz ? ty : ty + 0.5;
          const d = Math.hypot(mx - bx, my - by);
          if (d > radius) continue;
          const cls = edgeClass(map, tx, ty, horiz);
          if (energy * (1 - d / radius) < BREACH_THRESH[cls]) continue;
          // The los() guard aims at the NEAR FACE, not at the midpoint: the
          // midpoint lies exactly on the edge line and floors into the far
          // tile from one side, so a ray to it crosses the very wall under
          // test and a head-high wall could never be opened from that side.
          // Nudging onto the burst's own side asks the question we actually
          // mean — "does the blast reach this face" — and keeps the courtyard
          // guard (§1.4) intact, because an intervening wall still blocks.
          const gx = horiz ? mx : bx < tx ? tx - BREACH_FACE_EPS : tx + BREACH_FACE_EPS;
          const gy = horiz ? (by < ty ? ty - BREACH_FACE_EPS : ty + BREACH_FACE_EPS) : my;
          // Stance-neutral EYE_H both ends, exactly like the frag ray above: a
          // waist-high wall does not shadow what is behind it, a head-high one
          // does. Stated rather than defaulted (tests/sight-callers.test.ts).
          if (!los(map, bx, by, gx, gy, l, l, EYE_H, EYE_H).visible) continue;
          this.breachEdge(horiz, tx, ty, cls, wide, 'blast');
          if (++opened >= BREACH_CAP) break;
        }
      }
    }
  }

  // The one place an edge byte is allowed to change mid-battle. State lives on
  // the map and nowhere else; the two event lists are derived records.
  // `code` is BREACH — a hole with a rubble lip in it — except when a hull
  // flattens a fence or snaps a gate off its hinges, which leaves nothing to
  // climb and so leaves NONE (§2.2).
  private breachEdge(horiz: boolean, x: number, y: number, cls: number, wide: boolean, cause: 'blast' | 'crush', code: EdgeType = EDGE.BREACH): void {
    const map = this.map;
    const top = code === EDGE.BREACH ? (wide ? BREACH_WIDE : BREACH_LIP) : 0;
    if (code === EDGE.BREACH) map.hasBreach = true;
    if (horiz) {
      map.setHEdge(x, y, code);
      map.hEdgeTops[y * map.w + x] = top;
    } else {
      map.setVEdge(x, y, code);
      map.vEdgeTops[y * (map.w + 1) + x] = top;
    }
    const ev: BreachEvent = { horiz, x, y, cls, wide, cause };
    this.pendingBreaches.push(ev);
    this.breachLog.push(ev);
    this.repathNearBreach(horiz ? x + 0.5 : x, horiz ? y : y + 0.5);
  }

  // The single highest-value AI change in the feature (design section 5 item
  // 1). Pathing already reads the edge bytes live, so a NEW route is free —
  // but a man already walking does not gain it until something makes him ask
  // again, and an ordinary move order never repaths at all. Without this the
  // squad finishes its walk to the door while the hole you just blew for it
  // stands empty.
  //
  // It QUEUES a repath rather than clearing s.path. Clearing would strand
  // anyone whose new search fails (pathTo only overwrites on success), and
  // routing through pendingPaths means an 80-breach barrage cannot blow the
  // tick: PATH_BUDGET_PER_TICK still meters the A* and a second breach near
  // the same man overwrites his entry instead of queueing twice. The
  // destination comes off his own path's last waypoint, so he is re-solving
  // the journey he was already on, not being re-ordered.
  private repathNearBreach(mx: number, my: number): void {
    for (const s of this.soldiers) {
      // Every exclusion here is a path this must not stomp: pathTo drops a
      // rescue/ammo/take-over task and clears `fleeing`, so a medic mid-carry
      // or a broken man running must not be swept up because a wall fell.
      if (!s.path || s.task || s.fleeing || s.inVehicle >= 0 || s.mountTarget >= 0) continue;
      if (!this.eligible(s)) continue;
      const kind = this.teams[s.teamId].orderState.order?.kind;
      if (kind !== 'move' && kind !== 'assault') continue;
      if (Math.hypot(s.x - mx, s.y - my) > BREACH_REPATH_RADIUS) continue;
      const dest = s.path[s.path.length - 1];
      this.pendingPaths.set(s.id, { spot: { x: Math.floor(dest.x), y: Math.floor(dest.y), l: dest.l ?? 0 } });
    }
  }

  // A hull that has just consumed a waypoint drives through whatever stood on
  // the edge it crossed. Nothing is re-checked here: canStep in the crush mode
  // this vehicle paths with is what decided the step was legal at all, so this
  // only has to say what the wreckage looks like.
  private resolveCrush(v: Vehicle, x0: number, y0: number, x1: number, y1: number): void {
    const map = this.map;
    if (!map.crushesBetween(x0, y0, x1, y1)) return;
    const a = map.edgeAddr(x0, y0, x1, y1);
    if (!a) return;
    const cls = edgeClass(map, a.x, a.y, a.horiz);
    if (cls === ECLASS.NONE) {
      // Already a rubble lip: the tracks shove it aside into a hull-wide gap.
      this.breachEdge(a.horiz, a.x, a.y, cls, true, 'crush');
      v.crushLeft = CRUSH_STALL_LIGHT;
      return;
    }
    if (cls === ECLASS.WALL_HIGH) {
      this.breachEdge(a.horiz, a.x, a.y, cls, true, 'crush');
      v.crushLeft = CRUSH_STALL_HEAVY;
      // Both sides flinch. suppressAround is side-filtered, so it takes two
      // calls: a Sherman coming through a garden wall eight metres away should
      // rattle the men behind it whoever they are. Neither call draws rng.
      const mx = a.horiz ? a.x + 0.5 : a.x;
      const my = a.horiz ? a.y : a.y + 0.5;
      this.suppressAround(mx, my, 'blue', CRUSH_SUPPRESSION);
      this.suppressAround(mx, my, 'red', CRUSH_SUPPRESSION);
      return;
    }
    // Fence, gate, waist wall: flattened flush, nothing left to climb.
    this.breachEdge(a.horiz, a.x, a.y, cls, true, 'crush', EDGE.NONE);
    v.crushLeft = CRUSH_STALL_LIGHT;
  }

  private updateVehicle(v: Vehicle): void {
    const def = VEHICLES[v.kind];
    // movement — a hull grinding through a wall stalls; its gun does not, so
    // this gates the movement block only and everything below runs as usual.
    if (v.crushLeft > 0) {
      v.crushLeft--;
    } else if (v.path) {
      const wp = v.path[v.pathI];
      const dx = wp.x - v.x;
      const dy = wp.y - v.y;
      const d = Math.hypot(dx, dy);
      const onRoad = this.map.terrainKeyAt(Math.floor(v.x), Math.floor(v.y)) === 'road';
      let remaining = def.speed * (onRoad ? 1.3 : 1) * DT;
      if (d > 0.01) v.facing = Math.atan2(dy, dx);
      if (d <= remaining) {
        // Which tile he came from, taken off the path: waypoints are tile
        // centres, so v.x has already crossed the boundary by the time the
        // waypoint is consumed (same trap as advance()'s scramble).
        const prev = v.pathI > 0 ? v.path[v.pathI - 1] : null;
        const px = prev ? Math.floor(prev.x) : Math.floor(v.x);
        const py = prev ? Math.floor(prev.y) : Math.floor(v.y);
        v.x = wp.x;
        v.y = wp.y;
        v.pathI++;
        if (v.pathI >= v.path.length) {
          v.path = null;
          v.pathI = 0;
        }
        this.resolveCrush(v, px, py, Math.floor(wp.x), Math.floor(wp.y));
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
        if (!s.alive || s.downed || s.captured || s.side === v.side || s.inVehicle >= 0) continue;
        const d = Math.hypot(s.x - v.x, s.y - v.y);
        if (d < 30 && sightBetween(this, v.x, v.y, s.x, s.y, 0, s.level, EYE_VEHICLE, eyeOf(this, s)).visible) {
          s.suppression = Math.min(1, s.suppression + 0.05 * (1.3 - s.courage * 0.6));
        }
      }
    }

    if (v.gunCooldown > 0) v.gunCooldown -= DT;
    if (v.mgCooldown > 0) v.mgCooldown -= DT;

    // A player-assigned wall owns the main gun (D5): a deliberate order beats
    // autonomous acquisition, and it is one round — the wall opens and the
    // order clears itself. HE for preference, AP if that is all that is left.
    // A shot that is not on (turret still traversing, no LOS, out of range)
    // falls through to normal engagement rather than freezing the tank.
    if (v.wallTarget) {
      if (this.wallTargetSpent(v.wallTarget)) {
        v.wallTarget = null;
      } else if (v.gunCooldown <= 0 && v.ammo.he + v.ammo.ap > 0) {
        const m = edgeMid(v.wallTarget);
        if (this.wallShotReady(v.wallTarget, v.x, v.y, 0, EYE_VEHICLE, def.gunRange) && this.turretBearingReady(v, def, m.x, m.y)) {
          this.fireWallShot(v.x, v.y, v.wallTarget);
          if (v.ammo.he > 0) v.ammo.he--;
          else v.ammo.ap--;
          // Flat, unjittered: an aimed round at a stationary wall is not a
          // snap shot, and it keeps the whole player-breach path free of
          // shared-stream draws beyond explode()'s own frag rolls.
          v.gunCooldown = def.gunCooldown;
          v.wallTarget = null;
          return;
        }
      }
    }

    // prefer enemy armor with the main gun
    if ((this.tick + v.id) % RETARGET_TICKS === 0 || v.targetVehicleId < 0) {
      v.targetVehicleId = -1;
      let bestD = Infinity;
      for (const e of this.vehicles) {
        if (!e.alive || e.side === v.side) continue;
        const d = Math.hypot(e.x - v.x, e.y - v.y);
        if (d <= def.gunRange && d < bestD && sightBetween(this, v.x, v.y, e.x, e.y, 0, 0, EYE_VEHICLE, HULL_VEHICLE).visible) {
          bestD = d;
          v.targetVehicleId = e.id;
        }
      }
    }
    if (v.targetVehicleId >= 0 && v.gunCooldown <= 0 && v.ammo.ap > 0) {
      const e = this.vehicles[v.targetVehicleId];
      if (e.alive && sightBetween(this, v.x, v.y, e.x, e.y, 0, 0, EYE_VEHICLE, HULL_VEHICLE).visible) {
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
      v.targetSoldierId = this.acquireSoldierTarget(v.x, v.y, v.side, def.mgRange, undefined, 0, EYE_VEHICLE);
    }
    const t = v.targetSoldierId >= 0 ? this.soldiers[v.targetSoldierId] : null;
    if (t && (!t.alive || t.downed || t.captured)) {
      v.targetSoldierId = -1;
      return;
    }
    if (t) {
      if (!sightToSoldier(this, v.x, v.y, t, 0, EYE_VEHICLE).visible) {
        v.targetSoldierId = -1;
        return;
      }
      // guard HE fire on remaining he ammo — the M3/SdKfz (ammo.he: 0, no
      // real main gun) fall straight through to the pintle MG.
      if (v.gunCooldown <= 0 && v.ammo.he > 0 && this.turretBearingReady(v, def, t.x, t.y)) {
        // Tank HE is the first thing on the field that leaves a hull-wide hole.
        this.explode(t.x + this.rng.range(-2, 2), t.y + this.rng.range(-2, 2), { suppRadius: 10, fragRadius: 5, frags: 2, dmg: [25, 60], breach: 7, kind: 'shell' });
        this.pendingEvents.push({ fx: v.x, fy: v.y, tx: t.x, ty: t.y, hit: true, kill: false, targetId: t.id });
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
  private acquireSoldierTarget(x: number, y: number, side: Side, range: number, arc?: [number, number], l0 = 0, e0 = EYE_H): number {
    const candidates: { id: number; d: number }[] = [];
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.captured || e.side === side) continue;
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
      if (sightToSoldier(this, x, y, e, l0, e0).visible) return c.id;
    }
    return -1;
  }

  private fireApAt(fx: number, fy: number, pen: number, accuracy: number, range: number, target: Vehicle, moving: boolean): void {
    const p = this.apShotPreview(fx, fy, pen, accuracy, range, target, moving);
    const hit = this.rng.next() < p.acc;
    this.pendingEvents.push({ fx, fy, tx: target.x, ty: target.y, hit, kill: false });
    if (!hit) {
      // A missed AT rocket / tank round hits whatever is behind the tank, and
      // that is usually a wall. Same warhead as a deliberate wall shot, minus
      // the aiming, so it is nearly as good at opening one.
      this.explode(target.x + this.rng.range(-4, 4), target.y + this.rng.range(-4, 4), { suppRadius: 8, fragRadius: 3, frags: 1, dmg: [20, 50], breach: 8, kind: 'at' });
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
    if (this.rng.next() < AP_DESTROY_CHANCE) this.destroyVehicle(target);
  }

  private destroyVehicle(v: Vehicle): void {
    this.pendingUnitEvents.push({ kind: 'vehicle-destroyed', x: v.x, y: v.y, side: v.side, name: VEHICLES[v.kind].name });
    v.alive = false;
    v.burning = true;
    v.path = null;
    this.pendingBooms.push({ x: v.x, y: v.y, kind: 'brewup' });
    // A brewed-up tank burns for three minutes and throws a 20 m column
    // (PLUME[1]) that screens the street it died in and is visible from
    // anywhere on the map. It is ordinary smoke: stepSmoke ages it, the LOS
    // capsule blocks through it and the renderer draws it, all off one record.
    this.smoke.push(smokePuff(v.x, v.y, this.map.elevAt(Math.floor(v.x), Math.floor(v.y)), 180, 1));
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
  shotPreview(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean, aim: number, l0 = 0, e0 = EYE_H): ShotPreview {
    const sight = sightToSoldier(this, fx, fy, t, l0, e0);
    const d = Math.hypot(t.x - fx, t.y - fy);
    if (!sight.visible) return { visible: false, dist: d, cover: 0, acc: 0, concealed: sight.concealed };
    const w = WEAPONS[weapon];
    let cover = sight.cover;
    if (t.mental === 'pinned' || t.downed || t.captured) cover = Math.max(cover, Math.min(0.9, cover + 0.3));
    let acc = w.accuracy * (1 - 0.75 * (d / w.range)) * (1 - cover) * aim;
    if (shooterMoving) acc *= 0.5;
    // Movers are harder to hit — except a sneaking target: once spotted, a
    // slow crouched mover is as easy to hit as if he'd stood still. That's
    // sneak's trade-off for its stealth (spec: the mover discount doesn't
    // apply to sneak). Live fire and this preview share this one formula.
    if (t.path && this.teams[t.teamId].orderState.order?.kind !== 'sneak') acc *= 0.75;
    acc = Math.min(0.95, Math.max(0.02, acc));
    // Marching fire past close range is walking noise, not aimed fire
    // (balance 2026-07): applied AFTER the floor clamp, because 130 walking
    // rifles riding the 2% floor was measured killing a garrison's posts
    // east-to-west from 80-150m before the wave ever arrived. Close-in
    // (<=40m) marching fire keeps its full clamped value.
    if (shooterMoving && d > 40) acc *= 0.35;
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
    return { dist: d, acc, arc, armor, penChance, destroyChance: penChance * AP_DESTROY_CHANCE };
  }

  // Shared small-arms resolution used by soldiers and vehicle MGs.
  private resolveSmallArmsShot(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean, aim: number, l0 = 0, e0 = EYE_H, shooterId?: number): { fired: boolean; kill: boolean } {
    const p = this.shotPreview(fx, fy, weapon, t, shooterMoving, aim, l0, e0);
    if (!p.visible) return { fired: false, kill: false };
    const w: WeaponDef = WEAPONS[weapon];
    const hit = this.rng.next() < p.acc;
    let kill = false;
    if (hit) kill = this.wound(t, this.rng.range(w.damage[0], w.damage[1]), fx, fy);
    // Marching fire suppresses at half weight: accuracy already pays the
    // ×0.5 shooter-moving tax (2644), but suppression used to be delivered
    // at 100% while walking — a company advancing at a steady walk got its
    // full stationary suppression output for free (balance 2026-07).
    this.suppressAround(t.x, t.y, t.side, w.suppression * (shooterMoving ? 0.5 : 1), w.suppRadius);
    this.pendingEvents.push({ fx, fy, tx: t.x, ty: t.y, hit, kill, weapon, shooterId, targetId: t.id });
    return { fired: true, kill };
  }

  // Vehicle hull MGs: unlimited ammo — no vehicle ammo model until Task 10.
  // EYE_VEHICLE, not EYE_H: the acquire path already sights from the cupola, so
  // resolving the shot at rifleman height would let a hull-down tank acquire a
  // target across an embankment and then never be able to fire at it.
  private fireVehicleMg(fx: number, fy: number, weapon: WeaponKey, t: Soldier, shooterMoving: boolean): boolean {
    return this.resolveSmallArmsShot(fx, fy, weapon, t, shooterMoving, 1, 0, EYE_VEHICLE).kill;
  }

  // Infantry small-arms fire: consumes the shooter's mag and builds barrel heat.
  private fireSmallArms(shooter: Soldier, t: Soldier, shooterMoving: boolean, aim = 1): boolean {
    const r = this.resolveSmallArmsShot(shooter.x, shooter.y, shooter.weapon, t, shooterMoving, aim, shooter.level, eyeOf(this, shooter), shooter.id);
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
        this.pendingUnitEvents.push({ kind: 'downed', x: s.x, y: s.y, side: s.side, name: s.name, id: s.id, ...this.hitDir(s, 1) });
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
    if (wasDowned && !s.captured) this.note('recovered', s);
    if (s.captured) return; // captured men are inert: no movement, no flee, no psych re-trigger, no fire

    // psyche: bonded mates nearby steady the nerves
    let steadying = 0;
    for (const sid of this.squads[s.squadId].soldierIds) {
      const m = this.soldiers[sid];
      if (m.id === s.id || !m.alive || m.downed || m.captured) continue;
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
    // Morale drama, one event per crossing. Deterioration into pinned only —
    // a broken man recovering to pinned is good news, not a pin. Rallying
    // counts from pinned/broken, however long he spent shaken on the way back
    // up inside RALLY_WINDOW_TICKS; a man who was only ever shaken steadies
    // too often to be drama.
    if (s.mental === 'pinned' || s.mental === 'broken') s.lastCowedTick = this.tick;
    if (s.mental === 'pinned' && (wasMental === 'steady' || wasMental === 'shaken')) {
      this.pendingUnitEvents.push({ kind: 'pinned', x: s.x, y: s.y, side: s.side, name: s.name, id: s.id });
    } else if (s.mental === 'steady' && wasMental !== 'steady' && this.tick - s.lastCowedTick <= RALLY_WINDOW_TICKS) {
      s.lastCowedTick = -Infinity; // one rally per pin
      this.pendingUnitEvents.push({ kind: 'rallied', x: s.x, y: s.y, side: s.side, name: s.name, id: s.id });
    }
    if (s.mental === 'broken' && wasMental !== 'broken') {
      this.pendingUnitEvents.push({ kind: 'broken', x: s.x, y: s.y, side: s.side, name: s.name, id: s.id });
      // Overwhelmed at contact: ≥2 enemies within MELEE_ENGAGE → capture
      // instead of flee. Count BEFORE flee clears state (a broken man clears
      // his own meleeId first — key everything off counts around the victim).
      let captors = 0;
      for (const e of this.soldiers) {
        if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0) continue;
        if (Math.hypot(e.x - s.x, e.y - s.y) <= MELEE_ENGAGE) captors++;
      }
      if (captors >= 2) {
        // find a captor (nearest enemy) for the force-spot and event
        let captor: Soldier | null = null;
        let captorD = Infinity;
        for (const e of this.soldiers) {
          if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0) continue;
          const d = Math.hypot(e.x - s.x, e.y - s.y);
          if (d <= MELEE_ENGAGE && d < captorD) { captorD = d; captor = e; }
        }
        if (captor) this.capture(s, captor);
      }
    }

    // broken men flee away from the nearest enemy — breaking is the one way
    // out of a melee lock: he drops his guard and runs (and can be run down)
    if (s.mental === 'broken' && !s.captured) {
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
      this.maybeGrenadeEntry(s);
      this.maybeThrowGrenade(s);
    }

    // Under effective fire, stationary, in the open, with nothing else asked
    // of him: crawl to the nearest real cover instead of dying where he
    // stands (movement design §2.2). Cadence-staggered by id like flee and
    // the rescue considerations above. Excluded: pinned men (they cannot
    // move — the advance below refuses them), broken men (flee owns their
    // path), melee, a served gun, and a man walking to a vehicle. `legInProgress`
    // keeps him out from under his own team's order.
    if (
      (this.tick + s.id) % CRAWL_TICKS === 0 &&
      !s.path &&
      s.suppression > CRAWL_SUPP_THRESHOLD &&
      s.mental !== 'pinned' &&
      s.mental !== 'broken' &&
      s.meleeId < 0 &&
      s.inEmplacement < 0 &&
      s.mountTarget < 0 &&
      !this.legInProgress(this.teams[s.teamId].orderState) &&
      !this.inCover(s.x, s.y)
    ) {
      this.crawlToCover(s);
    }

    // pinned men stay down; a grenadier waits outside the opening for his fuse
    if (s.path && s.mental !== 'pinned' && (this.tick >= s.entryHoldUntil || s.mental === 'broken')) this.advance(s, this.moveSpeed(s));

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
          s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
            this.takeWeapon(s, kit.weapon, kit.ammo, kit.magLeft);
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
        if (type === 'clip_3006') this.pendingUnitEvents.push({ kind: 'ping', x: s.x, y: s.y, side: s.side, name: s.name, id: s.id });
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

    // A player-assigned wall outranks armour for this man (D5): he was pointed
    // at that wall on purpose. One round, then the order clears — and it clears
    // early if anyone else opens the edge first. Deliberately below the
    // hold-fire gate above: a team told to sneak is told to sneak.
    if (s.wallTarget) {
      if (this.wallTargetSpent(s.wallTarget)) {
        s.wallTarget = null;
      } else if (s.cooldown <= 0) {
        const at: WeaponDef | null = w.pen !== undefined ? w : (s.ammo.faust ?? 0) > 0 ? WEAPONS.panzerfaust : null;
        if (at && this.wallShotReady(s.wallTarget, s.x, s.y, s.level, eyeOf(this, s), at.range)) {
          this.fireWallShot(s.x, s.y, s.wallTarget);
          if (w.pen !== undefined) s.magLeft--;
          else s.ammo.faust!--;
          s.crewSkill.gun = Math.min(1, (s.crewSkill.gun ?? 0) + 0.0005);
          s.cooldown = at.cooldown; // aimed, not snapped: no jitter draw
          s.wallTarget = null;
          return;
        }
      }
    }

    // AT men engage armor first
    if (w.pen !== undefined && s.cooldown <= 0) {
      let bestV: Vehicle | null = null;
      let bestD = Infinity;
      for (const v of this.vehicles) {
        if (!v.alive || v.side === s.side) continue;
        const d = Math.hypot(v.x - s.x, v.y - s.y);
        if (d <= w.range && d < bestD && sightBetween(this, s.x, s.y, v.x, v.y, s.level, 0, eyeOf(this, s), HULL_VEHICLE).visible) {
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
        if (d <= faust.range && d < bestD && sightBetween(this, s.x, s.y, v.x, v.y, s.level, 0, eyeOf(this, s), HULL_VEHICLE).visible) {
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
    const targetInvalid = !t || !t.alive || t.downed || t.captured || Math.hypot(t.x - s.x, t.y - s.y) > w.range;
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
    this.pendingEvents.push({ fx: s.x, fy: s.y, tx: order.x, ty: order.y, hit: false, kill: false, weapon: s.weapon, shooterId: s.id });
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

    // stair climb: decrement timer, flip level on completion
    if (s.climbLeft > 0) {
      s.climbLeft--;
      if (s.climbLeft <= 0) {
        if (s.path && s.pathI < s.path.length) {
          s.level = s.path[s.pathI].l ?? 0;
        }
        s.pathI++;
        if (s.pathI >= (s.path?.length ?? 0)) {
          s.path = null;
          s.pathI = 0;
          s.fleeing = false;
        }
      }
      return;
    }

    // Rubble scramble: he is over the lip and on the far tile already, so this
    // is a plain countdown with no path bookkeeping. Deliberately NOT climbLeft
    // — that timer's completion branch writes s.level from the path waypoint,
    // and wiring a horizontal clamber into the level machinery is a bug waiting
    // for the first breach on an upper floor.
    if (s.scrambleLeft > 0) {
      s.scrambleLeft--;
      return;
    }

    const cost = this.map.terrainAt(Math.floor(s.x), Math.floor(s.y)).moveCost;
    let remaining = (speed / cost) * DT;
    // Which tile he is leaving, tracked off the PATH rather than off s.x/s.y:
    // waypoints are tile centres, so by the time he consumes one he has already
    // crossed the boundary and Math.floor(s.x) reads the tile he just entered.
    // Only the previous waypoint answers "which edge did he come through". On
    // the first leg there is no previous waypoint (astar's origin node is
    // sliced off at assignment); his current tile is the honest fallback and
    // can only ever under-report, never invent a crossing.
    const track = this.map.hasBreach;
    let prevX = 0;
    let prevY = 0;
    if (track && s.path) {
      const p = s.pathI > 0 ? s.path[s.pathI - 1] : null;
      prevX = p ? Math.floor(p.x) : Math.floor(s.x);
      prevY = p ? Math.floor(p.y) : Math.floor(s.y);
    }
    while (remaining > 0 && s.path) {
      const wp = s.path[s.pathI];
      const dx = wp.x - s.x;
      const dy = wp.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d <= remaining) {
        s.x = wp.x;
        s.y = wp.y;
        remaining -= d;
        // check for stair climb: reached a stair tile, next waypoint has different level
        if (this.map.isStair(Math.floor(s.x), Math.floor(s.y)) && s.pathI + 1 < s.path.length) {
          const nextL = s.path[s.pathI + 1].l ?? 0;
          if (nextL !== s.level) {
            s.climbLeft = 30;
            s.pathI++;
            remaining = 0;
            break;
          }
        }
        s.pathI++;
        if (s.pathI >= s.path.length) {
          s.path = null;
          s.pathI = 0;
          s.fleeing = false;
        }
        // He just came through a hole in a wall: hands and knees over the
        // rubble, then on. Charged on arrival, so the pause reads as him
        // picking himself up on the far side.
        if (track) {
          const wx = Math.floor(wp.x);
          const wy = Math.floor(wp.y);
          const lip = this.map.breachBetween(prevX, prevY, wx, wy);
          prevX = wx;
          prevY = wy;
          if (lip) {
            s.scrambleLeft = SCRAMBLE_TICKS;
            remaining = 0;
            break;
          }
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
          s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
      this.note('stabilized', c);
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
          s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
        this.note('resupplied', gunner);
      }
      gunner.ammoRunnerId = -1;
      task.phase = 'return';
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(task.returnX), Math.floor(task.returnY));
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
    // A launcher or a mortar ranks 0 because it is not in the small-arms
    // table, not because it is worse than a carbine — and the man carrying it
    // traded it for the first dropped rifle he stood next to (#766, measured
    // in 38 battles: bazooka 13 times, Schreck 8, mortar 22). The swap also
    // replaces his whole ammo record, so a gun's own gunner keeps his hands
    // off too: the shells the gun fires are in his pockets.
    const w: WeaponDef = WEAPONS[s.weapon];
    if (w.pen !== undefined || w.arc || (s.role === 'gunner' && s.inEmplacement >= 0)) return;
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
          s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
    this.takeWeapon(s, task.weapon, task.ammo, task.magLeft);
    s.role = 'gunner';
    this.note('took-over', s);
    // the predecessor's own dropped copy of this weapon (from dropKit) is
    // now spoken for — clear it so nobody double-claims it via considerPickup
    const i = this.droppedKit.findIndex((k) => !k.load && k.side === s.side && k.weapon === task.weapon && Math.hypot(k.x - task.x, k.y - task.y) <= 2);
    if (i >= 0) this.droppedKit.splice(i, 1);
    s.task = null;
  }

  // A man takes up a weapon and the ammunition that came with it, on a
  // battlefield pickup or a crew hand-over. He lets go of what his old weapon
  // fed on (unless the new one takes the same) and keeps the rest of what he
  // carries. Both callers used to replace his whole ammo record (#766): the
  // assistant who took over the gun lost the belts on his own back, and a
  // bearer who picked up a better rifle left the gun's shells in the grass.
  private takeWeapon(s: Soldier, weapon: WeaponKey, ammo: Partial<Record<AmmoKey, number>>, magLeft: number): void {
    const carried = { ...s.ammo };
    const own = WEAPONS[s.weapon].ammo.type;
    if (own !== WEAPONS[weapon].ammo.type) delete carried[own];
    for (const k of Object.keys(ammo) as AmmoKey[]) carried[k] = (carried[k] ?? 0) + (ammo[k] ?? 0);
    s.weapon = weapon;
    s.secondary = undefined;
    s.ammo = carried;
    s.ammoStart = Object.values(carried).reduce((a: number, n) => a + (n ?? 0), 0);
    s.magLeft = magLeft;
    s.heat = 0;
  }

  // Leader succession (spec: "highest xp teammate becomes leader after
  // 10s" — death only, no travel needed, so no takeOver task).
  //
  // Highest xp among the men whose job the team can spare (#766). A role is a
  // single field, so the man promoted stops being whatever he was: a gunner
  // loses crewAimMult and his death no longer triggers succession, an aidman
  // stops treating at aidman speed, an assistant stops speeding the reload.
  // Promotion took any role on xp alone (measured: gunner 1.7 and aidman 0.8
  // times a battle). Specialists are now promoted only when nobody else is
  // left, in the order LEADER_SPARE gives.
  private promoteLeader(team: Team): void {
    let best: Soldier | null = null;
    for (const sid of team.soldierIds) {
      const c = this.soldiers[sid];
      if (!c.alive || c.downed || c.captured || c.role === 'leader') continue;
      const d = best ? (LEADER_SPARE[c.role] ?? 0) - (LEADER_SPARE[best.role] ?? 0) : -1;
      if (d < 0 || (d === 0 && c.xp > best!.xp)) best = c;
    }
    if (best) {
      best.role = 'leader';
      this.note('promoted', best);
    }
  }

  // Any living un-downed soldier or alive vehicle of `side` with LOS to the
  // point within SPOT_RANGE. (friendlyHasLos in emplacement.ts is the
  // unlimited-range mortar-spotting rule — different semantics, not this.)
  // Public: main.ts gates enemy unit-event pings on it.
  sideSeesPoint(side: Side, x: number, y: number): boolean {
    const range = Math.min(SPOT_RANGE, spotCapOf(this.light)); // night cap (§7.1) — Infinity by day
    for (const s of this.soldiers) {
      if (!s.alive || s.downed || s.captured || s.side !== side || s.inVehicle >= 0) continue;
      if (Math.hypot(s.x - x, s.y - y) <= range && sightBetween(this, s.x, s.y, x, y, s.level, 0, eyeOf(this, s), EYE_H).visible) return true;
    }
    for (const v of this.vehicles) {
      if (!v.alive || v.side !== side) continue;
      if (Math.hypot(v.x - x, v.y - y) <= range && sightBetween(this, v.x, v.y, x, y, 0, 0, EYE_VEHICLE, EYE_H).visible) return true;
    }
    return false;
  }

  private updateSpotting(side: Side): void {
    const enemySide: Side = side === 'blue' ? 'red' : 'blue';
    const spotRange = Math.min(SPOT_RANGE, spotCapOf(this.light)); // night cap (§7.1) — Infinity by day
    // `e` is the spotter's eye height: a prone man's fog-of-war sweep is as
    // blind as his rifle is, and a tank sweeps from the cupola.
    const spotters: { x: number; y: number; l: number; e: number }[] = [];
    for (const s of this.soldiers) {
      if (s.alive && !s.downed && !s.captured && s.side === side && s.inVehicle < 0) spotters.push({ x: s.x, y: s.y, l: s.level, e: eyeOf(this, s) });
    }
    for (const v of this.vehicles) if (v.alive && v.side === side) spotters.push({ x: v.x, y: v.y, l: 0, e: EYE_VEHICLE });
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
          spotters.some((p) => Math.hypot(t.x - p.x, t.y - p.y) <= spotRange && sightToSoldier(this, p.x, p.y, t, p.l, p.e).visible);
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

  // A team reads its members' paths as "this leg is still running" while it
  // bounds (continueBounding's mid-leg test), marches (stepOrders' arrival
  // test) or closes an assault (its settled test). Any path handed to a
  // member during one of those — a crawl included — hangs the ORDER, not just
  // the man. Defend/ambush and fire have no such test, so a man who has
  // arrived on his post may still take better cover.
  private legInProgress(st: OrderState): boolean {
    if (st.phase === 'bounding_a' || st.phase === 'bounding_b') return true;
    const k = st.order?.kind;
    return st.phase === 'executing' && (k === 'move' || k === 'fast' || k === 'sneak' || k === 'assault');
  }

  // Tiles the crawl must leave alone: where his squadmates are standing, and
  // where the moving ones are headed. Soldiers have no collision here, so
  // without this an area-suppressed team crawls into a single hedge tile.
  private crawlBlocked(s: Soldier): Set<number> {
    const blocked = new Set<number>();
    for (const sid of this.squads[s.squadId].soldierIds) {
      const m = this.soldiers[sid];
      if (m.id === s.id || !m.alive || m.captured) continue;
      blocked.add(Math.floor(m.y) * this.map.w + Math.floor(m.x));
      const dest = m.path?.[m.path.length - 1];
      if (dest) blocked.add(Math.floor(dest.y) * this.map.w + Math.floor(dest.x));
    }
    return blocked;
  }

  // One relocation per trigger, and no relocation at all when nothing scores:
  // the man stays and takes it, exactly as he did before this behavior
  // existed. Not on the pathBudget — this is reactive, staggered movement,
  // like flee and the rescue crawl, not the select-all order burst the budget
  // was built to amortize.
  private crawlToCover(s: Soldier): void {
    const spot = crawlCoverSpot(this, s, this.crawlBlocked(s));
    if (!spot) return;
    const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), spot.x, spot.y, 'foot', s.level, s.level);
    if (!path || path.length < 2) return;
    s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
    s.pathI = 0;
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
      s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
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
      if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0) continue;
      if (Math.hypot(e.x - order.x, e.y - order.y) > ASSAULT_RADIUS) continue;
      if (sightToSoldier(this, s.x, s.y, e, s.level, eyeOf(this, s)).visible) out.push(e);
    }
    return out;
  }

  // One assault redirect: path onto the nearest visible defender (the melee
  // lock takes over inside 2m); with none in sight, close on the point itself.
  // Floor-aware (#130): each goal carries its defender's storey, so a charge
  // onto an upstairs garrison paths through the door and up the stairs instead
  // of settling on the street tile under the window — which is what left the
  // AI unable to crack a fortress town whose garrison holds the top floor.
  private assaultRepath(s: Soldier, order: TeamOrder): void {
    const defenders = this.assaultDefenders(s, order);
    const candidates: { x: number; y: number; l: number }[] = defenders
      .map((e) => ({ e, d: Math.hypot(e.x - s.x, e.y - s.y) }))
      .sort((a, b) => a.d - b.d || a.e.id - b.e.id)
      .map((c) => ({ x: c.e.x, y: c.e.y, l: c.e.level }));
    if (
      candidates.length > 0 &&
      candidates[0].l === s.level &&
      Math.hypot(candidates[0].x - s.x, candidates[0].y - s.y) <= MELEE_ENGAGE &&
      this.meleeReachable(s.x, s.y, candidates[0].x, candidates[0].y)
    ) {
      return; // true contact — the melee lock owns him now (a man 1.5m away
      // through a window, or one storey up, is NOT contact; keep closing)
    }
    // Nearest REACHABLE defender wins; a visible-but-unreachable one (window,
    // water) must not stall the charge — fall through to the next man, then
    // to the ground itself, rather than reselecting the same dead end forever.
    if (candidates.length === 0) {
      if (s.path || Math.hypot(order.x - s.x, order.y - s.y) <= 4) return;
      candidates.push({ x: order.x, y: order.y, l: order.l ?? 0 }); // nobody left in sight: take the ground
    }
    for (const goal of candidates) {
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(goal.x), Math.floor(goal.y), 'foot', s.level, goal.l);
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
        s.pathI = 0;
        return;
      }
    }
    // every defender unreachable: at least stand on the objective
    if (!s.path && Math.hypot(order.x - s.x, order.y - s.y) > 4) {
      const path = astar(this.map, Math.floor(s.x), Math.floor(s.y), Math.floor(order.x), Math.floor(order.y), 'foot', s.level, order.l ?? 0);
      if (path && path.length > 1) {
        s.path = path.slice(1).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5, l: p.l }));
        s.pathI = 0;
      }
    }
  }

  // Cheap interior check: is a point inside any building footprint? Used by
  // grenade targeting (enclosed ground softens the cluster requirement) and
  // the roof renderer. O(buildings) — 3-5 rects, no allocation.
  isInside(x: number, y: number): boolean {
    for (const b of this.buildings) {
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return true;
    }
    return false;
  }

  // Grenade throw: fires alongside the assault repath on the same cadence.
  // Only throws at a clustered target point or into a building — a lone man
  // in the open is a fire problem, not a grenade problem.
  private maybeThrowGrenade(s: Soldier): void {
    if (s.grenadesLeft <= 0 || this.tick < s.grenadeCooldownUntil) return;
    let best: Soldier | null = null;
    let bestD = Infinity;
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d > GRENADE_RANGE || d >= bestD) continue;
      if (!sightToSoldier(this, s.x, s.y, e, s.level, eyeOf(this, s)).visible) continue;
      bestD = d;
      best = e;
    }
    if (!best) return;
    // Clustered: ≥2 enemies within frag radius of the target point
    let clustered = 0;
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0) continue;
      if (Math.hypot(e.x - best.x, e.y - best.y) <= GRENADE_BLAST.fragRadius) clustered++;
    }
    const enclosed = this.isInside(best.x, best.y);
    if (clustered < 2 && !enclosed) return;
    // Throw: scatter exactly like the mortar (angle then dist, one draw each)
    s.grenadesLeft--;
    s.grenadeCooldownUntil = this.tick + GRENADE_COOLDOWN_TICKS;
    const angle = this.rng.next() * Math.PI * 2;
    const dist = this.rng.next() * GRENADE_SCATTER;
    this.pendingGrenades.push({ x: best.x + Math.cos(angle) * dist, y: best.y + Math.sin(angle) * dist, fuse: GRENADE_FUSE_TICKS, l: best.level });
  }

  // Before crossing a door or stair into a room with a currently spotted enemy,
  // throw through the opening and wait outside until the fuse expires.
  private maybeGrenadeEntry(s: Soldier): void {
    if (s.grenadesLeft <= 0 || this.tick < s.grenadeCooldownUntil || !s.path) return;
    let ax = Math.floor(s.x);
    let ay = Math.floor(s.y);
    let al = s.level;
    const end = Math.min(s.path.length, s.pathI + ENTRY_LOOKAHEAD);
    for (let i = s.pathI; i < end; i++) {
      const wp = s.path[i];
      const bx = Math.floor(wp.x);
      const by = Math.floor(wp.y);
      const bl = wp.l ?? 0;
      let opening = bl !== al && this.map.isStair(ax, ay);
      if (!opening && bl === al) {
        const edge = this.map.edgeAddr(ax, ay, bx, by);
        opening = !!edge && (edge.horiz ? this.map.hEdge(edge.x, edge.y) : this.map.vEdge(edge.x, edge.y)) === EDGE.DOOR;
      }
      if (opening) {
        const buildingId = this.map.buildingIdAt(bx, by);
        if (buildingId >= 0) this.grenadeEntryThrow(s, buildingId, bl);
        return;
      }
      ax = bx;
      ay = by;
      al = bl;
    }
  }

  private grenadeEntryThrow(s: Soldier, buildingId: number, level: number): void {
    let target: Soldier | null = null;
    let targetDistance = Infinity;
    for (const e of this.soldiers) {
      if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0 || e.level !== level) continue;
      if (!this.spotted[s.side].has(e.id) || this.map.buildingIdAt(Math.floor(e.x), Math.floor(e.y)) !== buildingId) continue;
      const distance = Math.hypot(e.x - s.x, e.y - s.y);
      if (distance > GRENADE_RANGE || distance >= targetDistance) continue;
      target = e;
      targetDistance = distance;
    }
    if (!target || targetDistance <= GRENADE_BLAST.fragRadius) return;
    for (const friendly of this.soldiers) {
      if (!friendly.alive || friendly.id === s.id || friendly.side !== s.side || friendly.inVehicle >= 0 || friendly.level !== level) continue;
      if (Math.hypot(friendly.x - target.x, friendly.y - target.y) <= GRENADE_BLAST.fragRadius) return;
    }
    s.grenadesLeft--;
    s.grenadeCooldownUntil = this.tick + GRENADE_COOLDOWN_TICKS;
    s.entryHoldUntil = this.tick + GRENADE_FUSE_TICKS;
    const angle = this.rng.next() * Math.PI * 2;
    const distance = this.rng.next() * GRENADE_SCATTER;
    this.pendingGrenades.push({
      x: target.x + Math.cos(angle) * distance,
      y: target.y + Math.sin(angle) * distance,
      fuse: GRENADE_FUSE_TICKS,
      l: level,
    });
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
      // Same storey only (#130): 2D distance locked a charger into a phantom
      // fight through the floor slab with the garrison one level up.
      if (!e.alive || e.downed || e.captured || e.side === s.side || e.inVehicle >= 0 || e.level !== s.level) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d > MELEE_ENGAGE || d >= bestD) continue;
      if (!this.meleeReachable(s.x, s.y, e.x, e.y)) continue;
      bestD = d;
      best = e;
    }
    if (!best) return;
    // A broken man at melee contact surrenders if ≥2 enemies are within
    // MELEE_ENGAGE of him — a lone pursuer still gets the run-down drama.
    if (best.mental === 'broken') {
      let captors = 0;
      for (const e of this.soldiers) {
        if (!e.alive || e.downed || e.captured || e.side === best.side || e.inVehicle >= 0) continue;
        if (Math.hypot(e.x - best.x, e.y - best.y) <= MELEE_ENGAGE) captors++;
      }
      if (captors >= 2) {
        this.capture(best, s);
        return;
      }
      // fall through: lone pursuer still locks and chases
    }
    this.enterMelee(s, best.id);
    if (best.meleeId < 0) this.enterMelee(best, s.id); // already fighting someone: he keeps his man
  }

  // Capture a broken man overwhelmed at melee contact: alive, out of the
  // fight, untargetable. Force-spots both sides (contact is a sense).
  private capture(victim: Soldier, captor: Soldier): void {
    victim.captured = true;
    victim.meleeId = -1;
    // clear any locker's meleeId pointing at the victim
    for (const s of this.soldiers) {
      if (s.meleeId === victim.id) s.meleeId = -1;
    }
    victim.path = null;
    victim.targetId = -1;
    if (victim.task) this.dropTask(victim);
    // contact is a sense: both sides see the surrender
    this.spotted[victim.side].set(captor.id, { x: captor.x, y: captor.y });
    this.spotted[captor.side].set(victim.id, { x: victim.x, y: victim.y });
    this.contacts[victim.side].delete(`s${captor.id}`);
    this.contacts[captor.side].delete(`s${victim.id}`);
    this.pendingUnitEvents.push({ kind: 'surrendered', x: victim.x, y: victim.y, side: victim.side, name: victim.name, id: victim.id });
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
    if (!t.alive || t.downed || t.captured || t.inVehicle >= 0 || t.level !== s.level || d > MELEE_BREAK || (t.mental === 'broken' && d > MELEE_STRIKE_RANGE)) {
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
    const isSmg = w.class === 'smg'; // SMGs with rounds left fight melee from the hip — CQC edge over the bayonet, paid in ammo
    const smgFire = isSmg && s.magLeft > 0;
    const clumsy = !!w.heat || w.pen !== undefined || !!w.arc; // an MG42 makes a poor club
    const base = smgFire ? 0.7 : clumsy ? 0.35 : isSmg ? 0.45 : 0.55;
    const dmg: [number, number] = smgFire ? w.damage : clumsy || isSmg ? [20, 50] : [30, 70];
    const hit = this.rng.next() < Math.min(0.9, Math.max(0.05, base * this.aimFactor(s)));
    let kill = false;
    if (hit) kill = this.wound(t, this.rng.range(dmg[0], dmg[1]), s.x, s.y);
    else t.suppression = Math.min(1, t.suppression + 0.1); // a blade past your face
    if (smgFire) {
      s.magLeft--;
      this.pendingEvents.push({ fx: s.x, fy: s.y, tx: t.x, ty: t.y, hit, kill, weapon: s.weapon, shooterId: s.id, targetId: t.id }); // hip-fire muzzle flash
    }
    this.pendingMeleeEvents.push({ attackerId: s.id, victimId: t.id, x: t.x, y: t.y, hit, kill });
    if (kill) this.seenStatic[s.side].add(`s${t.id}`); // killed at arm's length: the corpse is found, not a ghost
    if (kill || t.downed || t.captured) s.meleeId = -1;
  }

  private acquire(s: Soldier): number {
    const order = this.teams[s.teamId].orderState.order;
    const arc = (order?.kind === 'defend' || order?.kind === 'ambush') ? order.arc : undefined;
    return this.acquireSoldierTarget(s.x, s.y, s.side, WEAPONS[s.weapon].range, arc, s.level, eyeOf(this, s));
  }

  private fire(s: Soldier, t: Soldier): void {
    if (!sightToSoldier(this, s.x, s.y, t, s.level, eyeOf(this, s)).visible) {
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
    if (kill || t.downed || t.captured) s.targetId = -1;
  }

  // `fromX, fromY`: where the hit came from — the muzzle, the blast centre,
  // the man swinging — when it came from anywhere. It is recorded for the
  // kia/downed events and read by nothing else.
  private wound(t: Soldier, dmg: number, fromX?: number, fromY?: number): boolean {
    t.hitTick = -Infinity;
    if (fromX !== undefined && fromY !== undefined) {
      const d = Math.hypot(t.x - fromX, t.y - fromY);
      if (d > 1e-6) {
        t.hitDx = (t.x - fromX) / d;
        t.hitDy = (t.y - fromY) / d;
        t.hitTick = this.tick;
      }
    }
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

  // The direction of the wound that did this, when it landed within `age`
  // ticks. A kill is resolved inside wound(); a man is found downed in his own
  // update, which can be the tick after the hit.
  private hitDir(t: Soldier, age: number): { dx?: number; dy?: number } {
    return this.tick - t.hitTick <= age ? { dx: t.hitDx, dy: t.hitDy } : {};
  }

  // The quiet recoveries: an output event for the man it happened to, carrying
  // his team's name for the ticker.
  private note(kind: UnitEvent['kind'], s: Soldier): void {
    this.pendingUnitEvents.push({ kind, x: s.x, y: s.y, side: s.side, name: s.name, id: s.id, team: this.teams[s.teamId].name });
  }

  private kill(t: Soldier): void {
    if (t.inVehicle < 0) {
      this.pendingUnitEvents.push({ kind: 'kia', x: t.x, y: t.y, side: t.side, name: t.name, id: t.id, ...this.hitDir(t, 0) });
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

  // Seeing a man hit hurts in proportion to how much he meant to you.
  // Side-wide within the radius, not own-squad-only (balance 2026-07): a
  // packed crowd in the open carries its shock as a crowd — each casualty
  // rattles every exposed friendly close enough to see it (strangers at the
  // bond-0 floor, 0.4×), while teams spaced at doctrine intervals keep their
  // morale pools apart. Cover insulates STRANGERS only: a garrison fighting
  // from buildings keeps its squad-local pools (else the density tax routs a
  // packed defense as fast as the crowd it was aimed at — measured, bourg s1),
  // but a squadmate down is a squadmate down, wall or no wall.
  private moraleShock(t: Soldier, amount: number): void {
    for (const m of this.soldiers) {
      if (m.id === t.id || m.side !== t.side || !m.alive) continue;
      if (Math.hypot(m.x - t.x, m.y - t.y) >= 15) continue;
      if (m.squadId !== t.squadId && this.inCover(m.x, m.y)) continue;
      m.morale = Math.max(0, m.morale - amount * (0.4 + this.bond(m, t) * 1.6));
    }
  }

  // `radius` is the weapon's suppression footprint (WeaponDef.suppRadius) —
  // a belt MG's burst beats a wider zone than one rifle round, which is what
  // makes shoulder-to-shoulder massing eat more of each burst than spread
  // teams do (balance 2026-07: the density tax).
  private suppressAround(x: number, y: number, side: Side, amount: number, radius: number = SUPPRESS_RADIUS): void {
    for (const m of this.soldiers) {
      if (!m.alive || m.side !== side) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < radius) {
        const gain = amount * (1 - d / radius) * (1.3 - m.courage * 0.6) * (1 - Math.min(m.xp, 5) * 0.05);
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
        s.grenadesLeft,
        s.grenadeCooldownUntil,
        s.entryHoldUntil,
        s.captured,
        Math.round((s.crewSkill.mg ?? 0) * 1e6),
        Math.round((s.crewSkill.mortar ?? 0) * 1e6),
        Math.round((s.crewSkill.gun ?? 0) * 1e6),
        s.level,
        s.climbLeft,
        s.scrambleLeft,
        refKey(s.wallTarget),
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
        v.crushLeft,
        refKey(v.wallTarget),
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
        refKey(e.wallTarget),
      ]),
      smoke: this.smoke.map((p) => [
        Math.round(p.x * 1e6),
        Math.round(p.y * 1e6),
        Math.round(p.z0 * 1e6),
        Math.round(p.h * 1e6),
        Math.round(p.ttl * 1e6),
        Math.round(p.age * 1e6),
        p.kind,
        Math.round(p.r * 1e6),
      ]),
      pendingGrenades: this.pendingGrenades.map((g) => [Math.round(g.x * 1e6), Math.round(g.y * 1e6), g.fuse, g.l]),
      droppedKit: this.droppedKit.map((k) => [
        k.side,
        Math.round(k.x * 1e6),
        Math.round(k.y * 1e6),
        k.weapon,
        Object.values(k.ammo).reduce((a: number, n) => a + (n ?? 0), 0),
        k.magLeft,
      ]),
      // The map stopped being immutable the day breaching landed, and
      // snapshot() captured no map state at all because it never had to
      // (design section 4.2 — the single biggest correctness hazard in the
      // feature). INSERTION-ORDERED list, not a set and not a checksum: a
      // checksum proves the same edges broke, the list additionally proves
      // they broke in the same ORDER, which is what catches an iteration-order
      // bug in the candidate scan — precisely the class of bug that makes a
      // replay drift 400 ticks later and is undebuggable from a mismatch.
      breaches: this.breachLog.map((b) => [b.horiz ? 1 : 0, b.x, b.y, b.cls, b.wide ? 1 : 0]),
      squadLastCasualty: this.squadLastCasualty,
      teamLastCasualty: this.teamLastCasualty,
      leaderVacantSince: [...this.leaderVacantSince.entries()].sort((a, b) => a[0] - b[0]),
    });
  }
}
