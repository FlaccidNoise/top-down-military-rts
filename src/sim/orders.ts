import { WEAPONS, type WeaponDef } from './data';
import { sightBetween, type Side, type Sim, type Soldier, type Team } from './sim';

// The order vocabulary (spec: docs/specs/2026-07-22-order-execution.md). One
// order per team; the executor in sim.ts decomposes it into per-soldier tasks.
export type OrderKind = 'move' | 'fast' | 'sneak' | 'fire' | 'smoke' | 'defend' | 'ambush';

export interface TeamOrder {
  kind: OrderKind;
  x: number;
  y: number;
  arc?: [number, number]; // facing arc, radians (defend/ambush)
  targetId?: number; // specific enemy soldier (fire)
}

// Per-team legibility state, lives on Team. UI reads this directly — never
// re-derive comply/cautious/balk from raw sim state elsewhere.
export interface OrderState {
  order: TeamOrder | null;
  phase: 'idle' | 'executing' | 'bounding_a' | 'bounding_b' | 'balked';
  reason: string;
}

export const BALK_REASON = 'open ground under fire — suppress or smoke first';

const RECENT_CASUALTY_TICKS = 900; // 30s at DT=1/30

// The honest-vision primitive: enemies any living member of `side` currently
// has LOS to, within that member's own weapon range. Shared by dangerScore,
// the team executor's fire order, and (Task 12) the AI commander — one
// definition of "what a side knows" everywhere it matters.
export function visibleEnemies(sim: Sim, side: Side): Soldier[] {
  const enemySide: Side = side === 'blue' ? 'red' : 'blue';
  const friendlies = sim.soldiers.filter((s) => s.alive && !s.downed && s.side === side && s.inVehicle < 0);
  const enemies = sim.soldiers.filter((e) => e.alive && !e.downed && e.side === enemySide);
  const seen: Soldier[] = [];
  for (const e of enemies) {
    for (const f of friendlies) {
      if (Math.hypot(f.x - e.x, f.y - e.y) <= WEAPONS[f.weapon].range && sightBetween(sim, f.x, f.y, e.x, e.y).visible) {
        seen.push(e);
        break;
      }
    }
  }
  return seen;
}

// Danger score for a team moving toward `dest`: samples 8 points along the
// straight line from the team's current centroid to dest. Deterministic, no
// RNG — the same evaluation backs soldier refusal, firing-position choice,
// and (Task 12) the AI's own risk assessment (spec's coherence rule).
export function dangerScore(sim: Sim, team: Team, dest: { x: number; y: number }): number {
  const eligible = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed && s.mental !== 'broken');
  if (eligible.length === 0) return 0;
  const cx = eligible.reduce((a, s) => a + s.x, 0) / eligible.length;
  const cy = eligible.reduce((a, s) => a + s.y, 0) / eligible.length;
  const side = sim.squads[team.squadId].side;
  const known = visibleEnemies(sim, side);

  let total = 0;
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const px = cx + (dest.x - cx) * t;
    const py = cy + (dest.y - cy) * t;
    let point = 0;
    if (sim.map.terrainAt(Math.floor(px), Math.floor(py)).cover < 0.1) point += 0.05;
    for (const e of known) {
      const w = WEAPONS[e.weapon];
      if (Math.hypot(e.x - px, e.y - py) <= w.range && sightBetween(sim, e.x, e.y, px, py).visible) point += 0.15;
    }
    total += point;
  }
  let score = total / 8;
  const lastCasualty = sim.teamLastCasualty[team.id] ?? -Infinity;
  if (sim.tick - lastCasualty < RECENT_CASUALTY_TICKS) score += 0.2;
  return score;
}

export function compliance(sim: Sim, team: Team, danger: number): 'comply' | 'cautious' | 'balk' {
  const eligible = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed && s.mental !== 'broken');
  if (eligible.length === 0) return 'balk';
  const leaderAlive = eligible.some((s) => s.role === 'leader');
  const avgMorale = eligible.reduce((a, s) => a + s.morale, 0) / eligible.length;
  const avgXp = eligible.reduce((a, s) => a + s.xp, 0) / eligible.length;
  const avgStamina = eligible.reduce((a, s) => a + s.stamina, 0) / eligible.length;
  const threshold = 0.45 + (leaderAlive ? 0.15 : 0) + avgMorale * 0.3 + avgXp * 0.02 - (avgStamina < 0.3 ? 0.1 : 0);
  if (danger < threshold) return 'comply';
  if (danger < threshold + 0.25) return 'cautious';
  return 'balk';
}

// Per-weapon-class ambush trigger distance (spec: faust ~30m -> 0.8x pen
// weapon range, MG opening burst 50-100m -> 60m, else 40m).
export function ambushThreshold(w: WeaponDef): number {
  if (w.pen !== undefined) return w.range * 0.8;
  if (w.heat) return 60;
  return 40;
}
