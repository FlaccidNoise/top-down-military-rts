// "One sun" model (architecture.md — Muted Normandy): every shadow in the
// scene falls the same direction, NW light at ~40° elevation, so shadows
// fall SE. Shared by terrain (hedges) and roofs (building shadow + AO) so
// the world reads as lit by a single source.

const SUN_LEN = Math.hypot(0.45, 0.55);
export const SUN = { dx: 0.45 / SUN_LEN, dy: 0.55 / SUN_LEN }; // unit vector, SE

// The wind now lives sim-side (src/sim/wind.ts) because the smoke-column LOS
// test leans by it, and src/sim/* may not import src/render/*. Re-exported here
// so every render consumer keeps importing it from the light model.
export { WIND } from '../sim/wind';

export const SHADOW_ALPHA = 0.3; // core cast-shadow alpha
export const SHADOW_SOFT_ALPHA = 0.14; // outer feathered layer, stacked under the core
export const AO_ALPHA = 0.32; // contact/base ambient occlusion, not sun-directional

// World-space [dx, dy] offset for a shadow cast by something `len` meters tall/long.
export function shadowOffset(len: number): [number, number] {
  return [SUN.dx * len, SUN.dy * len];
}
