// "One wind" the same way there is one sun: anything that drifts — smoke
// columns, chimney plumes, and later grass or flags — leans along this vector,
// so the weather reads as a single system.
//
// It lives sim-side because the sim needs it (a leaning smoke column blocks
// sight along its axis, not straight up) and src/sim/* must never import
// src/render/*. The dependency arrow is render -> sim: src/render/light.ts
// re-exports WIND from here, so fx.ts, roofs.ts, yards.ts and renderer.ts are
// unchanged and there is still exactly one definition.
//
// Normalized with Math.sqrt, not Math.hypot. Math.sqrt is required by IEEE-754
// to be correctly rounded; Math.hypot is not specified that tightly and is
// implemented differently across JS engines. Anything a sim decision depends on
// must replay bit-identically on every machine (same rule as mapgen.ts).
const RX = 0.82;
const RY = -0.57;
const L = Math.sqrt(RX * RX + RY * RY);
export const WIND = { dx: RX / L, dy: RY / L };

export const WIND_SPEED = 1.6; // m/s

// Horizontal metres a plume drifts per vertical metre of column. The renderer
// and sightBetween both lean by this, so the drawn column and the blocking
// column are the same object.
export const LEAN_K = 0.35;
