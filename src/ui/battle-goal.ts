// How a battle is won, as the HUD states it: one label, both sides' strength,
// and the line each side breaks at. Pure, no DOM.
import type { Side, Sim } from '../sim/sim';
import type { Rect } from './coach';

// The break-off rule is the sim's own: these are the constants Sim.step()
// runs on. tests/battle-goal.test.ts still walks a live Sim across the line,
// so the strip's count and the sim's verdict cannot part company.
export { BREAK_FLOOR_MIN, BREAK_FRACTION } from '../sim/sim';
export const breakFloor = (sim: Sim, side: Side): number => sim.breakFloor(side);

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

// What the player is told of the enemy's strength. A live body count is intel
// the fog withholds (the ticker and the top bar follow the same rule), so under
// fog the strip gives a coarse read: a few segments and one word, both from the
// true strength against the break line. With fog off the count is exact.
export const ENEMY_READS = ['Broken', 'Breaking', 'Wavering', 'Shaken', 'Holding'] as const;
export type EnemyRead =
  | { exact: true; strength: SideStrength }
  | { exact: false; lit: number; of: number; word: (typeof ENEMY_READS)[number] };

export interface BattleGoal {
  label: string;
  own: SideStrength;
  enemy: EnemyRead;
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

function enemyRead(sim: Sim): EnemyRead {
  const s = strength(sim, 'red');
  if (sim.fowDisabled) return { exact: true, strength: s };
  const of = ENEMY_READS.length - 1;
  // The share of the ground between full strength and the break line still held.
  const left = s.start > s.breakAt ? (s.now - s.breakAt) / (s.start - s.breakAt) : 0;
  const lit = Math.max(0, Math.min(of, Math.ceil(left * of)));
  return { exact: false, lit, of, word: ENEMY_READS[lit] };
}

/**
 * The player is the defender. Staging gives the attacker the west edge and
 * says so in sim.threatAxis: an attacker expects his enemy east, a defender
 * west (bridge.ts). The drill and every battle the player starts read false.
 */
export const defending = (sim: Sim): boolean => Math.cos(sim.threatAxis.blue) < 0;

// The rule is the same for both sides: the battle ends when one of them is
// under its break line, and in no other way. So the defender's goal is the
// attacker's, said from where he stands. "Hold" alone would be false: an
// attack that stalls above its break line does not end the battle.
export const GOAL_LABEL = { attack: 'Break them', defend: 'Break their attack' } as const;

/** null before either side is fielded: the strip has nothing true to say. */
export function battleGoal(sim: Sim): BattleGoal | null {
  if (sim.startStrength.blue <= 0 || sim.startStrength.red <= 0) return null;
  return { label: defending(sim) ? GOAL_LABEL.defend : GOAL_LABEL.attack, own: strength(sim, 'blue'), enemy: enemyRead(sim) };
}

/** The strip as plain text: what a screen reader hears, and what the tests read. */
export function goalText(g: BattleGoal): string {
  const enemy = g.enemy.exact ? `GE ${g.enemy.strength.now} \u2192 ${g.enemy.strength.breakAt}` : `GE ${g.enemy.word.toLowerCase()}`;
  return `${g.label} \u00b7 ${enemy} \u00b7 US ${g.own.now}`;
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
  const foe = nearestKnownEnemy(sim, cx, cy);
  const bearing = foe ? Math.atan2(foe.y - cy, foe.x - cx) : sim.threatAxis.blue;
  const i = ((Math.round(bearing / (Math.PI / 4)) % 8) + 8) % 8;
  return `${goal.label} · enemy to the ${COMPASS[i]} ${ARROWS[i]}`;
}

/** Every enemy position the player knows of: seen now, or a ghost of where one was. */
function knownEnemies(sim: Sim): { x: number; y: number }[] {
  return [...sim.spotted.blue.values(), ...sim.contacts.blue.values()];
}

/** The known enemy nearest a world point. null before any contact. */
export function nearestKnownEnemy(sim: Sim, x: number, y: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const k of knownEnemies(sim)) {
    const d = Math.hypot(k.x - x, k.y - y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export interface Pointer {
  x: number;
  y: number;
  /** Screen bearing the pointer aims along, radians. */
  angle: number;
}

const POINTER_INSET = 30; // px the pointer sits inside the stage edge

/**
 * Where a pointer to a screen point sits on the edge of `stage`, aimed from
 * the stage's centre. null = the point is on stage and needs no pointer.
 */
export function edgePointer(stage: Rect, tx: number, ty: number): Pointer | null {
  if (tx >= stage.left && tx <= stage.right && ty >= stage.top && ty <= stage.bottom) return null;
  const cx = (stage.left + stage.right) / 2;
  const cy = (stage.top + stage.bottom) / 2;
  const hw = Math.max(1, (stage.right - stage.left) / 2 - POINTER_INSET);
  const hh = Math.max(1, (stage.bottom - stage.top) / 2 - POINTER_INSET);
  const dx = tx - cx;
  const dy = ty - cy;
  // Scale the ray to where it leaves the inset box.
  const k = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) };
}

/**
 * The battle opens on the player's own men, so the screen has to say which way
 * the enemy is. This is the pointer at the edge of the map on screen: toward
 * the nearest enemy the player knows of, or, before any contact, toward the
 * side the enemy is expected from. null while a known enemy is on screen.
 * `project` is the camera: world to screen.
 */
export function enemyPointer(sim: Sim, stage: Rect, project: (x: number, y: number) => [number, number]): Pointer | null {
  const cx = (stage.left + stage.right) / 2;
  const cy = (stage.top + stage.bottom) / 2;
  let near: Pointer | null = null;
  let nearD = Infinity;
  for (const k of knownEnemies(sim)) {
    const [sx, sy] = project(k.x, k.y);
    const p = edgePointer(stage, sx, sy);
    if (!p) return null;
    const d = Math.hypot(sx - cx, sy - cy);
    if (d < nearD) {
      nearD = d;
      near = p;
    }
  }
  if (near) return near;
  const a = sim.threatAxis.blue;
  const far = Math.hypot(stage.right - stage.left, stage.bottom - stage.top);
  return edgePointer(stage, cx + Math.cos(a) * far, cy + Math.sin(a) * far);
}

const POINTER_RED = '#d05c50'; // the enemy's team colour (hud.ts TEAM.red)

export function drawEnemyPointer(ctx: CanvasRenderingContext2D, p: Pointer): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.font = '600 11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // The word sits behind the arrowhead, on the map side.
  const lx = -Math.cos(p.angle) * 30;
  const ly = -Math.sin(p.angle) * 22;
  const w = ctx.measureText('ENEMY').width + 10;
  ctx.fillStyle = 'rgba(18, 22, 15, 0.85)';
  ctx.fillRect(lx - w / 2, ly - 8, w, 16);
  ctx.fillStyle = POINTER_RED;
  ctx.fillText('ENEMY', lx, ly);
  ctx.rotate(p.angle);
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-4, -9);
  ctx.lineTo(-4, 9);
  ctx.closePath();
  ctx.fillStyle = POINTER_RED;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(18, 22, 15, 0.85)';
  ctx.stroke();
  ctx.restore();
}
