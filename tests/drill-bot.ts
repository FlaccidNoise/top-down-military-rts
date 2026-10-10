// Two players for the drill, as headless order policies. They issue the same
// sim.orderSquad calls main.ts issues for a click, wait on the same conditions
// the tutorial steps wait on (src/drill.ts), and do nothing else.
//
//   follower  does what the steps say, and what the recovery step says when a
//             team refuses. The drill must be winnable this way.
//   idler     does steps 1 and 2 and then nothing. The drill must not be
//             losable this way.
//
// Shared by tests/drill.test.ts (the gate) and scripts/drillsweep.mjs (the
// wide sweep), so the numbers they report are the same policy.
import { enemiesInSight, hasRefused, houseIsQuiet, makeDrill, type Drill } from '../src/drill';
import { DT } from '../src/sim/sim';
import { effective } from '../src/ui/battle-goal';

const TICKS_PER_S = Math.round(1 / DT);

export interface DrillRun {
  seed: number;
  winner: 'blue' | 'red' | null;
  secs: number;
  blue: number;
  blueStart: number;
  /** Men of the first squad still fighting at the end. */
  lead: number;
  red: number;
  redStart: number;
  /** Battle seconds until the player first saw an enemy. -1 = never. */
  seenAt: number;
  /** Battle seconds from the Fire order until the house went quiet. -1 = never. */
  quietAfter: number;
  /** Times the assault was refused and the recovery step was followed. */
  recoveries: number;
}

function stepUntil(d: Drill, done: () => boolean, maxTicks: number): boolean {
  for (let n = 0; n < maxTicks && !d.sim.winner; n++) {
    if (done()) return true;
    d.sim.step();
  }
  return done();
}

/** Where the player holds for Fire: an enemy they can see, else the house. */
function fireTarget(d: Drill): { x: number; y: number } {
  const [seen] = enemiesInSight(d.sim);
  return seen ? { x: seen.x, y: seen.y } : { x: d.house.x, y: d.house.y };
}

function result(seed: number, d: Drill, seenAt: number, quietAfter: number, recoveries: number): DrillRun {
  const { sim } = d;
  return {
    seed,
    winner: sim.winner,
    secs: Math.round(sim.tick / TICKS_PER_S),
    blue: effective(sim, 'blue'),
    blueStart: sim.startStrength.blue,
    lead: sim.squads[d.lead].soldierIds.map((i) => sim.soldiers[i]).filter((m) => m.alive && !m.downed && !m.captured).length,
    red: effective(sim, 'red'),
    redStart: sim.startStrength.red,
    seenAt,
    quietAfter,
    recoveries,
  };
}

export function follower(seed: number, capMin = 10): DrillRun {
  const d = makeDrill(seed);
  const { sim } = d;
  const cap = capMin * 60 * TICKS_PER_S;
  // Steps 1-2: the first squad, to the hedge.
  sim.orderSquad(d.lead, { kind: 'move', x: d.hedge.x, y: d.hedge.y });
  // Step 3: the battle stops the moment an enemy is seen.
  const seen = stepUntil(d, () => enemiesInSight(sim).length > 0, 120 * TICKS_PER_S);
  const seenAt = seen ? sim.tick / TICKS_PER_S : -1;
  // Step 4: Fire, on the enemy.
  sim.orderSquad(d.lead, { kind: 'fire', ...fireTarget(d) });
  const firedAt = sim.tick;
  // Step 5: it stops again when the house goes quiet. Step 6: another squad, Assault, the house.
  const other = d.rifles.find((q) => q !== d.lead)!;
  const quiet = stepUntil(d, () => houseIsQuiet(d, other), cap);
  const quietAfter = quiet ? (sim.tick - firedAt) / TICKS_PER_S : -1;
  sim.orderSquad(other, { kind: 'assault', x: d.house.x, y: d.house.y });
  let recoveries = 0;
  while (!sim.winner && sim.tick < cap) {
    sim.step();
    // The recovery step: "They won't go. Fire on the enemy first."
    if (hasRefused(sim, other)) {
      recoveries++;
      sim.orderSquad(d.lead, { kind: 'fire', ...fireTarget(d) });
      stepUntil(d, () => houseIsQuiet(d, other), cap - sim.tick);
      sim.orderSquad(other, { kind: 'assault', x: d.house.x, y: d.house.y });
    }
  }
  return result(seed, d, seenAt, quietAfter, recoveries);
}

export function idler(seed: number, capMin = 10): DrillRun {
  const d = makeDrill(seed);
  const { sim } = d;
  const cap = capMin * 60 * TICKS_PER_S;
  sim.orderSquad(d.lead, { kind: 'move', x: d.hedge.x, y: d.hedge.y });
  let seenAt = -1;
  while (!sim.winner && sim.tick < cap) {
    sim.step();
    if (seenAt < 0 && enemiesInSight(sim).length > 0) seenAt = sim.tick / TICKS_PER_S;
  }
  return result(seed, d, seenAt, -1, 0);
}

/** Nobody is given an order at all: what the start line is like. */
export function sitter(seed: number, secs = 120): DrillRun {
  const d = makeDrill(seed);
  const { sim } = d;
  let seenAt = -1;
  for (let i = 0; i < secs * TICKS_PER_S && !sim.winner; i++) {
    sim.step();
    if (seenAt < 0 && (enemiesInSight(sim).length > 0 || sim.spotted.red.size > 0)) seenAt = sim.tick / TICKS_PER_S;
  }
  return result(seed, d, seenAt, -1, 0);
}
