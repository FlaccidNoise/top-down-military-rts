// Theater generator sub-stream harness (S7, design doc §2 — the bourg D2
// pattern): exactly ONE draw on the shared attempt stream yields a base, then
// every stage derives its own independent stream from that base. Retuning one
// stage can never reshuffle another stage's draws.
import { mulberry32, type Rng } from '../../sim/rng';

// Frozen tags 40-59, append-only, never renumbered (bourg owns 1-16, relief
// 20-29). A new stage takes the next free tag; a deleted stage retires its
// tag forever.
export const T_TAG = {
  RIVER: 40,
  TOWNS: 41,
  ROADS: 42,
  CROSSINGS: 43,
  RAIL: 44,
  REGIONS: 45,
  NAMES: 46,
  OBJECTIVES: 47,
} as const;
export type StageTag = (typeof T_TAG)[keyof typeof T_TAG];

// The ONE shared draw. Everything after it is derived, so the shared stream's
// cursor advances exactly one position per generation attempt.
export function stageBase(shared: Rng): number {
  return shared.int(0x7fffffff);
}

// Golden-ratio spacing, never base + tag: adjacent mulberry32 seeds are
// correlated for their first outputs (src/sim/bourg precedent).
export function stageStream(base: number, tag: StageTag): Rng {
  return mulberry32((base ^ Math.imul(tag, 0x9e3779b1)) >>> 0);
}
