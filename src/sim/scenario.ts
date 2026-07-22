import type { RosterEntry } from '../campaign/campaign';
import { DE_NAMES, US_NAMES, type WeaponKey } from './data';
import { generateMap, type Building, type MapPlan, type Vec } from './mapgen';
import { Sim, type Side } from './sim';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const center = (b: Building): Vec => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// Nearest road tile center to (x,y) — vehicles spawn on the road, never in a
// woods stand or hedge the map happened to grow next to the entry point.
function roadSpot(sim: Sim, x: number, y: number): Vec {
  for (let r = 0; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = Math.floor(x) + dx;
        const ty = Math.floor(y) + dy;
        if (sim.map.inBounds(tx, ty) && sim.map.terrainKeyAt(tx, ty) === 'road') return { x: tx + 0.5, y: ty + 0.5 };
      }
    }
  }
  return { x, y };
}

function addVehicleOnRoad(sim: Sim, side: Side, kind: 'sherman' | 'panzer4', x: number, y: number, facing: number): void {
  const p = roadSpot(sim, x, y);
  sim.addVehicle(side, kind, p.x, p.y, facing);
}

function squadMembers(sim: Sim, side: Side, cx: number, cy: number, spread: number): { name: string; weapon: WeaponKey; x: number; y: number }[] {
  const names = side === 'blue' ? US_NAMES : DE_NAMES;
  const at: WeaponKey = side === 'blue' ? 'bazooka' : 'panzerfaust';
  const members: { name: string; weapon: WeaponKey; x: number; y: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const weapon: WeaponKey =
      i === 0 ? (side === 'blue' ? 'thompson' : 'mp40')
      : i === 1 ? (side === 'blue' ? 'bar' : 'mg42')
      : i === 2 ? at
      : side === 'blue' ? 'garand' : 'kar98k';
    members.push({
      name: names[sim.rng.int(names.length)],
      weapon,
      x: cx + sim.rng.range(-spread, spread),
      y: cy + sim.rng.range(-spread, spread),
    });
  }
  return members;
}

// A 9-man squad placed exactly on the given positions.
function placedSquad(sim: Sim, side: Side, positions: { x: number; y: number }[]): { name: string; weapon: WeaponKey; x: number; y: number }[] {
  const g = squadMembers(sim, side, 0, 0, 0);
  g.forEach((m, i) => {
    m.x = positions[i].x;
    m.y = positions[i].y;
  });
  return g;
}

function placeInBuilding(sim: Sim, b: Building, count: number): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    spots.push({
      x: b.x + 1 + sim.rng.int(b.w - 2) + 0.5,
      y: b.y + 1 + sim.rng.int(b.h - 2) + 0.5,
    });
  }
  return spots;
}

function addRedDefenders(sim: Sim, plan: MapPlan): Record<number, Vec> {
  const [b0, b1, b2] = plan.buildings;
  const woods = plan.objectives[1];

  const spots1 = [...placeInBuilding(sim, b0, 5), ...placeInBuilding(sim, b1, 4)];
  const s1 = sim.addSquad('red', '1. Gruppe', placedSquad(sim, 'red', spots1));

  const spots2 = [
    ...placeInBuilding(sim, b2, 4),
    ...Array.from({ length: 5 }, () => ({
      x: woods.x + sim.rng.range(-6, 6),
      y: woods.y + sim.rng.range(-6, 6),
    })),
  ];
  const s2 = sim.addSquad('red', '2. Gruppe', placedSquad(sim, 'red', spots2));

  return { [s1.id]: center(b0), [s2.id]: center(b2) };
}

export function makeScenario(seed: number): Sim {
  const plan = generateMap(seed);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;
  const { west, east } = plan.spawns;
  sim.addSquad('blue', '1st Squad', squadMembers(sim, 'blue', west.x + 7, clamp(west.y - 14, 4, plan.map.h - 5), 3));
  sim.addSquad('blue', '2nd Squad', squadMembers(sim, 'blue', west.x + 7, clamp(west.y + 14, 4, plan.map.h - 5), 3));
  addRedDefenders(sim, plan);
  addVehicleOnRoad(sim, 'blue', 'sherman', west.x + 0.5, west.y + 0.5, 0);
  addVehicleOnRoad(sim, 'red', 'panzer4', east.x - 1.5, east.y + 0.5, Math.PI);
  return sim;
}

// Wire campaign bonds (keyed by pid) onto battle soldiers (keyed by battle id).
export function wireBonds(sim: Sim, roster: RosterEntry[][]): void {
  const byPid = new Map<number, number>();
  for (const s of sim.soldiers) if (s.pid >= 0) byPid.set(s.pid, s.id);
  for (const squad of roster) {
    for (const r of squad) {
      const sid = byPid.get(r.pid);
      if (sid === undefined) continue;
      for (const [otherPid, v] of Object.entries(r.bonds)) {
        const oid = byPid.get(Number(otherPid));
        if (oid !== undefined) sim.soldiers[sid].bonds[oid] = v;
      }
    }
  }
}
