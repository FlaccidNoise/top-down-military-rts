import { EMPLACEMENTS, type EmplacementKey, type LoadKey } from './data';
import type { EdgeRef } from './map';
import { EYE_STAND, eyeOf, sightBetween, type Side, type Sim, type Soldier } from './sim';

// Crewed-weapon entity (spec §4): reuses the vehicle-crew pattern — an
// emplacement bound to a crew team by crewTeamId, same data shape as a
// vehicle's crew, no special cases. Packs into carried loads, deploys/packs
// on a timer, and shares the served-weapon rule with soldier-held MGs (crew
// below minCrew fire slower; a lone survivor can still serve the gun, badly).
// The fire loop/state machine that mutates this lives in Sim (sim.ts's
// updateEmplacement et al) — this module holds the pure decisions it reads,
// mirroring orders.ts's split (dangerScore/compliance are pure; orderTeam is
// the stateful executor) rather than exporting Sim's private fire primitives.
export interface Emplacement {
  id: number;
  side: Side;
  kind: EmplacementKey;
  x: number;
  y: number;
  facing: number;
  state: 'packed' | 'deploying' | 'deployed' | 'packing';
  timer: number;
  crewTeamId: number;
  loadsPresent: LoadKey[];
  cooldown: number;
  heat: number;
  towedBy: number; // vehicle id, -1 = not hitched
  targetX: number;
  targetY: number;
  hasTarget: boolean; // arc weapons (mortars): HE point set via Sim.orderFire
  smokeRoundsLeft: number; // arc weapons: rounds left in an active smoke mission
  moveTarget: { x: number; y: number } | null; // wheeled AT guns: Sim.orderWheel destination
  wallTarget: EdgeRef | null; // AT guns: player-assigned wall to open (D5), null = none
}

// How close a crew soldier must be to the gun to count as "serving" it —
// covers addEmplacement's spawn scatter (OFFSETS, max 3.0m) with margin, and
// is the same radius the loads-present and deploy checks use.
export const CREW_RADIUS = 4;

export function crewNear(sim: Sim, e: Emplacement): Soldier[] {
  return sim.teams[e.crewTeamId].soldierIds
    .map((id) => sim.soldiers[id])
    .filter((s) => s.alive && !s.downed && s.mental !== 'broken' && Math.hypot(s.x - e.x, s.y - e.y) <= CREW_RADIUS);
}

// Served-weapon rule: rate of fire degrades below minCrew; floor is "a lone
// survivor can still fire, badly" — never fully stalls once crewed >= 1.
// Infinity (never ready to fire) when nobody is left on the gun.
export function crewDegrade(sim: Sim, e: Emplacement): number {
  const present = crewNear(sim, e).length;
  if (present <= 0) return Infinity;
  return Math.max(1, EMPLACEMENTS[e.kind].minCrew / present);
}

// Every load the emplacement needs must either be on a living nearby
// crewman's back or lying dropped within reach of the gun (a casualty's,
// hauled to the site but not re-shouldered) — plan-literal: "requires all
// loads within 3m (carried or dropped there)". A load still stranded where
// its carrier died en route (anywhere outside CREW_RADIUS) does NOT count:
// kill the tripod carrier 20m out and the gun stays stranded until someone
// physically hauls it back to the site. AT guns declare loads: [] and are
// vacuously ready (not man-packable at all).
export function loadsReady(sim: Sim, e: Emplacement): boolean {
  const def = EMPLACEMENTS[e.kind];
  const carried = new Set<LoadKey>();
  for (const s of crewNear(sim, e)) for (const l of s.carries) carried.add(l);
  for (const k of sim.droppedKit) {
    if (k.load && k.side === e.side && Math.hypot(k.x - e.x, k.y - e.y) <= CREW_RADIUS) carried.add(k.load);
  }
  return def.loads.every((l) => carried.has(l));
}

// Who pulls the trigger this tick: the designated gunner if he's alive and on
// the gun; otherwise the nearest living crew role in line (assistant, then
// anyone present) — the "lone survivor" case, ahead of Task 11's animated 3s
// hand-off (role: 'takeOver').
export function pickFirer(sim: Sim, e: Emplacement): Soldier | null {
  const near = crewNear(sim, e);
  if (near.length === 0) return null;
  return near.find((s) => s.role === 'gunner') ?? near.find((s) => s.role === 'assistant') ?? near[0];
}

// Mortar shared-vision spotting (spec §4/§6): a valid indirect-fire point is
// any point a living, un-downed friendly currently sees — not limited to the
// crew's own eyes or any weapon's range (that's what makes it "any point a
// friendly sees" rather than a normal acquire()).
export function friendlyHasLos(sim: Sim, side: Side, x: number, y: number): boolean {
  for (const s of sim.soldiers) {
    if (!s.alive || s.downed || s.side !== side || s.inVehicle >= 0) continue;
    if (sightBetween(sim, s.x, s.y, x, y, s.level, 0, eyeOf(sim, s), EYE_STAND).visible) return true;
  }
  return false;
}

// The crew's OWN eyes on the target point (tighter scatter) vs shared vision
// from elsewhere on the map (wider scatter) — the gun sits at (e.x, e.y).
// DELIBERATE EYE DEFAULT: a served gun sights at about chest height, so the
// crew keeps EYE_H on both ends. Giving it a stance would move mortar-spotting
// balance for no verticality gain. On the grep gate's allow-list.
export function crewHasLos(sim: Sim, e: Emplacement, x: number, y: number): boolean {
  return sightBetween(sim, e.x, e.y, x, y).visible;
}
