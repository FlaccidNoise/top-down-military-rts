import { WEAPONS, type WeaponDef } from './data';
import { sightBetween, sightToSoldier, type Side, type Sim, type Soldier, type Team } from './sim';

// The order vocabulary (spec: docs/specs/2026-07-22-order-execution.md). One
// order per team; the executor in sim.ts decomposes it into per-soldier tasks.
export type OrderKind = 'move' | 'fast' | 'sneak' | 'fire' | 'smoke' | 'defend' | 'ambush' | 'assault';

export interface TeamOrder {
  kind: OrderKind;
  x: number;
  y: number;
  arc?: [number, number]; // facing arc, radians (defend/ambush)
  targetId?: number; // specific enemy soldier (fire)
  l?: number; // target floor level, 0-based; undefined = auto (defend/ambush) or ground (else)
  facing?: number; // radians, formation long-axis direction (right-drag)
  width?: number; // meters, full front-line width (right-drag)
}

// Per-team legibility state, lives on Team. UI reads this directly — never
// re-derive comply/cautious/balk from raw sim state elsewhere.
export interface OrderState {
  order: TeamOrder | null;
  phase: 'idle' | 'executing' | 'bounding_a' | 'bounding_b' | 'balked';
  reason: string;
}

export const BALK_REASON = 'open ground under fire — suppress or smoke first';
export const CHARGE_BALK_REASON = 'refusing to charge — suppress or smoke the position first';
// Assault is the scariest ask in the vocabulary: the same danger evaluation,
// weighted up before the compliance ladder runs (orderTeam applies it).
export const ASSAULT_DANGER_MULT = 1.3;

const RECENT_CASUALTY_TICKS = 900; // 30s at DT=1/30

// Per-(sim, tick, side) memo. This is O(enemies x friendlies) raycasts, and
// dangerSamples calls it once per team — a select-all move order evaluated it
// ~54 times for one unchanged answer (~87 ms of the order burst). Soldier
// positions, levels and liveness only change inside step(), so within a tick
// the result is invariant and the memo is exact, not an approximation.
// Callers must treat the array as read-only (none mutate it today).
const seenCache = new WeakMap<Sim, { tick: number; blue?: Soldier[]; red?: Soldier[] }>();

// The honest-vision primitive: enemies any living member of `side` currently
// has LOS to, within that member's own weapon range. Shared by dangerScore,
// the team executor's fire order, and (Task 12) the AI commander — one
// definition of "what a side knows" everywhere it matters.
export function visibleEnemies(sim: Sim, side: Side): Soldier[] {
  let entry = seenCache.get(sim);
  if (!entry || entry.tick !== sim.tick) {
    entry = { tick: sim.tick };
    seenCache.set(sim, entry);
  }
  const hit = entry[side];
  if (hit) return hit;
  const computed = computeVisibleEnemies(sim, side);
  entry[side] = computed;
  return computed;
}

function computeVisibleEnemies(sim: Sim, side: Side): Soldier[] {
  const enemySide: Side = side === 'blue' ? 'red' : 'blue';
  const friendlies = sim.soldiers.filter((s) => s.alive && !s.downed && !s.captured && s.side === side && s.inVehicle < 0);
  const enemies = sim.soldiers.filter((e) => e.alive && !e.downed && !e.captured && e.side === enemySide);
  const seen: Soldier[] = [];
  for (const e of enemies) {
    for (const f of friendlies) {
      if (Math.hypot(f.x - e.x, f.y - e.y) <= WEAPONS[f.weapon].range && sightToSoldier(sim, f.x, f.y, e, f.level).visible) {
        seen.push(e);
        break;
      }
    }
  }
  return seen;
}

export interface DangerSample {
  x: number;
  y: number;
  score: number; // 0..0.2 per point (open ground +0.05, covering enemy +0.15)
}

// The 8 sample points dangerScore sums over, exposed so the UI can preview
// the same evaluation the team's refusal model will run (legibility
// contract: what you see before ordering is what decides compliance).
// Deterministic, no RNG.
export function dangerSamples(sim: Sim, team: Team, dest: { x: number; y: number }): DangerSample[] {
  const eligible = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed && s.mental !== 'broken');
  if (eligible.length === 0) return [];
  const cx = eligible.reduce((a, s) => a + s.x, 0) / eligible.length;
  const cy = eligible.reduce((a, s) => a + s.y, 0) / eligible.length;
  const side = sim.squads[team.squadId].side;
  const known = visibleEnemies(sim, side);

  const samples: DangerSample[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const px = cx + (dest.x - cx) * t;
    const py = cy + (dest.y - cy) * t;
    let point = 0;
    if (sim.coverAt(px, py) < 0.1) point += 0.05;
    for (const e of known) {
      const w = WEAPONS[e.weapon];
      if (Math.hypot(e.x - px, e.y - py) <= w.range && sightBetween(sim, e.x, e.y, px, py, e.level, 0).visible) {
        point += 0.15;
        break; // one covering enemy is enough to flag the point; not per-enemy
      }
    }
    samples.push({ x: px, y: py, score: point });
  }
  return samples;
}

// Danger score for a team moving toward `dest`: sums dangerSamples' 8
// per-point contributions (no averaging — the plan's formula is a sum), plus
// a flat recent-casualty term. Deterministic, no RNG — the same evaluation
// backs soldier refusal, firing-position choice, and the AI commander's own
// risk assessment (spec's coherence rule).
export function dangerScore(sim: Sim, team: Team, dest: { x: number; y: number }): number {
  const samples = dangerSamples(sim, team, dest);
  if (samples.length === 0) return 0;
  let total = samples.reduce((a, p) => a + p.score, 0);
  // Recent casualty is squad-scoped (a sister team's loss raises this team's
  // danger too); the ambush trigger's own casualty check stays team-scoped.
  const lastCasualty = sim.squadLastCasualty[team.squadId] ?? -Infinity;
  if (sim.tick - lastCasualty < RECENT_CASUALTY_TICKS) total += 0.2;
  return total;
}

export function compliance(sim: Sim, team: Team, danger: number): 'comply' | 'cautious' | 'balk' {
  const eligible = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed && !s.captured && s.mental !== 'broken');
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
