import type { RosterEntry } from '../campaign/campaign';
import { generateMap, type Building, type Vec } from './mapgen';
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

export function makeScenario(seed: number): Sim {
  const plan = generateMap(seed);
  const sim = new Sim(plan.map, seed);
  sim.buildings = plan.buildings;
  const { west, east } = plan.spawns;
  const by = (dy: number) => clamp(west.y + dy, 4, plan.map.h - 5);
  sim.addSquadFromDef('blue', 'us_rifle', west.x + 7, by(-16));
  sim.addSquadFromDef('blue', 'us_rifle', west.x + 7, by(16));
  sim.addSquadFromDef('blue', 'us_bazooka', west.x + 3, by(0));
  sim.addSquadFromDef('blue', 'us_m1919', west.x + 11, by(0));

  // German garrison: two Gruppen holding buildings, the sMG42 team in the east woods
  const [b0, , b2] = plan.buildings;
  const woods = plan.objectives[1];
  sim.addSquadFromDef('red', 'de_gruppe', center(b0).x, center(b0).y);
  sim.addSquadFromDef('red', 'de_gruppe', center(b2).x, center(b2).y);
  sim.addSquadFromDef('red', 'de_smg42', woods.x, woods.y);

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
