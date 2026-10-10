// How a battle is won, as the HUD states it: one label, both sides' strength,
// and the line each side breaks at. Pure, no DOM.
import type { Side, Sim } from '../sim/sim';

// The break-off rule lives in Sim.step(): a side breaks off the battle below a
// quarter of its starting strength, and never with two men or more above an
// empty floor. Until the sim exports these, this is the one UI-side copy, and
// tests/battle-goal.test.ts pins it against a live Sim so it cannot drift.
// When the sim's own BREAK_FRACTION, BREAK_FLOOR_MIN and Sim.breakFloor land,
// this block becomes a re-export.
export const BREAK_FRACTION = 0.25;
export const BREAK_FLOOR_MIN = 2;
export function breakFloor(sim: Sim, side: Side): number {
  return Math.max(BREAK_FLOOR_MIN, sim.startStrength[side] * BREAK_FRACTION);
}

/** Men still fighting: the count Sim.step() tests against the floor. */
export function effective(sim: Sim, side: Side): number {
  let n = 0;
  for (const s of sim.soldiers) if (s.side === side && s.alive && !s.downed && !s.captured) n++;
  return n;
}

export interface SideStrength {
  now: number;
  start: number;
  /** The largest count at which this side has broken: the sim tests `now < floor`. */
  breakAt: number;
  /** How near the break line it stands, for the bar's colour. */
  state: 'steady' | 'shaken' | 'pinned' | 'broken';
}

export interface BattleGoal {
  label: string;
  own: SideStrength;
  enemy: SideStrength;
}

function strength(sim: Sim, side: Side): SideStrength {
  const now = effective(sim, side);
  const start = sim.startStrength[side];
  const breakAt = Math.ceil(breakFloor(sim, side)) - 1;
  // Thirds of the ground between full strength and the break line.
  const left = start > breakAt ? (now - breakAt) / (start - breakAt) : 0;
  const state = now <= breakAt ? 'broken' : left > 2 / 3 ? 'steady' : left > 1 / 3 ? 'shaken' : 'pinned';
  return { now, start, breakAt, state };
}

/** null before either side is fielded: the strip has nothing true to say. */
export function battleGoal(sim: Sim): BattleGoal | null {
  if (sim.startStrength.blue <= 0 || sim.startStrength.red <= 0) return null;
  return { label: 'Break them', own: strength(sim, 'blue'), enemy: strength(sim, 'red') };
}

// Screen bearings: +x is east, +y is south.
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'] as const;
const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'] as const;

/** Sim seconds without an order before the HUD says what to do next. */
export const QUIET_PROMPT_S = 60;

/**
 * The line a player who has stopped giving orders reads: the goal, and where
 * the enemy is. It names no control. The bearing runs from the centre of the
 * player's men to the nearest enemy they know of (seen now, or a ghost), and
 * before any contact to the side the enemy is expected from.
 */
export function quietPrompt(sim: Sim): string | null {
  const goal = battleGoal(sim);
  if (!goal) return null;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const s of sim.soldiers) {
    if (s.side !== 'blue' || !s.alive || s.downed || s.captured) continue;
    cx += s.x;
    cy += s.y;
    n++;
  }
  if (n === 0) return null;
  cx /= n;
  cy /= n;
  let bearing = sim.threatAxis.blue;
  let best = Infinity;
  const known = [...sim.spotted.blue.values(), ...sim.contacts.blue.values()];
  for (const k of known) {
    const d = Math.hypot(k.x - cx, k.y - cy);
    if (d < best) {
      best = d;
      bearing = Math.atan2(k.y - cy, k.x - cx);
    }
  }
  const i = ((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8;
  return `${goal.label} · enemy to the ${COMPASS[i]} ${ARROWS[i]}`;
}
