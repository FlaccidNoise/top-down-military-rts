// T_RIVER (stage 40, S7): the main river and its tributaries — the first
// geometry on the theater and the anchor for towns, crossings and the
// initial front partition. Pure: all draws come from the RIVER stage stream,
// every emitted coordinate is an integer metre.
//
// Names are EMPTY here — T_NAMES (stage 46) names every river in one place,
// keyed on geometry, so naming retunes never move the water.
import type { River, Vec } from '../theater';
import { stageStream, T_TAG } from './streams';

// The main river crosses the theater north to south through the middle band —
// it is the river-anchored front partition's spine (§2 T_OBJECTIVES), so it
// must span the full height and stay off the map edges.
const MAIN_X_BAND: [number, number] = [0.35, 0.65]; // entry anchor, fraction of w
const MAIN_X_CLAMP: [number, number] = [0.2, 0.8]; // wander limit, fraction of w
const MAIN_STEP_M: [number, number] = [900, 1200];
const MAIN_DRIFT_M = 350; // max lateral drift per step
const TRIB_STEP_M: [number, number] = [700, 1000];
const TRIB_DRIFT_M = 280; // downstream-axis wobble per step
const TRIB_LEN_M: [number, number] = [4000, 9000];
const TRIB_JOIN_BAND: [number, number] = [0.15, 0.85]; // fraction of main's vertices

export function planRivers(base: number, riverDensity: 1 | 2 | 3, boundsM: { w: number; h: number }): River[] {
  const rng = stageStream(base, T_TAG.RIVER);
  const { w, h } = boundsM;

  // Main river: enter at y=0, exit at y=h, wandering x.
  const main: Vec[] = [];
  let x = rng.range(MAIN_X_BAND[0] * w, MAIN_X_BAND[1] * w);
  let y = 0;
  main.push({ x: Math.round(x), y: 0 });
  while (y < h) {
    y = Math.min(h, y + rng.range(MAIN_STEP_M[0], MAIN_STEP_M[1]));
    x = Math.max(MAIN_X_CLAMP[0] * w, Math.min(MAIN_X_CLAMP[1] * w, x + rng.range(-MAIN_DRIFT_M, MAIN_DRIFT_M)));
    main.push({ x: Math.round(x), y: Math.round(y) });
  }
  const rivers: River[] = [{ id: 0, name: '', polyline: main, widthClass: 'river' }];

  // Tributaries: each rises inland and JOINS the main at one of its vertices
  // (first point = the join, so the confluence is exact, not approximate).
  // Count bands by density knob: 1 -> 1-2, 2 -> 2-3 (the §2 default), 3 -> 3-4.
  const tribCount = riverDensity + rng.int(2);
  for (let t = 0; t < tribCount; t++) {
    const joinIdx =
      Math.round(rng.range(TRIB_JOIN_BAND[0] * (main.length - 1), TRIB_JOIN_BAND[1] * (main.length - 1)));
    const join = main[joinIdx];
    const side = rng.next() < 0.5 ? -1 : 1; // rises west or east of the main
    const lenTarget = rng.range(TRIB_LEN_M[0], TRIB_LEN_M[1]);
    const poly: Vec[] = [{ x: join.x, y: join.y }];
    let tx = join.x;
    let ty = join.y;
    let len = 0;
    while (len < lenTarget) {
      const step = rng.range(TRIB_STEP_M[0], TRIB_STEP_M[1]);
      tx += side * step; // away from the main, toward the side edge
      ty += rng.range(-TRIB_DRIFT_M, TRIB_DRIFT_M);
      // Stop AT the frame rather than clamping along it — a tributary that
      // hits the edge rises off-map, like the main entering at y=0.
      if (tx <= 0 || tx >= w || ty <= 0 || ty >= h) {
        poly.push({ x: Math.round(Math.max(0, Math.min(w, tx))), y: Math.round(Math.max(0, Math.min(h, ty))) });
        break;
      }
      poly.push({ x: Math.round(tx), y: Math.round(ty) });
      len += step;
    }
    rivers.push({ id: t + 1, name: '', polyline: poly, widthClass: 'stream' });
  }
  return rivers;
}
