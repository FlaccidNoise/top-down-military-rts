import type { Parcels, Plot } from './parcels';
import type { Skeleton } from './streets';

// Block/neighbourhood coordination — adjusts plot positions for clean
// streetscapes. Pure data pass: reads Plot[], writes back adjusted positions.
// Called between buildParcels and buildFootprints in planBourg.
//
// Rules (docs/plans/2026-07-29-block-coordination.md):
//   C1 · frontages in a row share ONE setback line: the mode setback per run.
//   C3 · opposing runs rear onto ONE line. Per opposing run pair (same axis,
//        opposite sides of the same block), both runs' plots are snapped to
//        depths dA + dB = G, where G is the distance between the two
//        frontage lines. Shrinking only — a plot's d is never grown, because
//        `claimed` was built from the original rects and growing would claim
//        tiles later stages treat as free. R-O2 then writes exactly one rear
//        wall per boundary, and no leftover strip sits between the yards.
//
// Draw discipline: zero draws. Every decision is a pure function of plot data.

export function coordinateBlocks(_sk: Skeleton, pc: Parcels): Parcels {
  const runs = new Map<number, Plot[]>();
  for (const p of pc.plots) {
    let list = runs.get(p.runIndex);
    if (!list) {
      list = [];
      runs.set(p.runIndex, list);
    }
    list.push(p);
  }

  // ── C3 · one rear line per opposing run pair ───────────────────────────
  const byBlock = new Map<number, number[]>();
  for (const ri of runs.keys()) {
    const br = pc.runs[ri];
    let l = byBlock.get(br.blockId);
    if (!l) {
      l = [];
      byBlock.set(br.blockId, l);
    }
    l.push(ri);
  }
  // A run participates in at most one snap (blocks with three runs on one
  // axis leave the extra run alone rather than double-snap a partner).
  const snapped = new Set<number>();
  for (const [, runList] of byBlock) {
    runList.sort((a, b) => a - b); // deterministic: run order
    for (const ai of runList) {
      if (snapped.has(ai)) continue;
      const ra = pc.runs[ai];
      for (const bi of runList) {
        if (bi <= ai || snapped.has(bi)) continue;
        const rb = pc.runs[bi];
        if (ra.axis !== rb.axis || ra.side === rb.side) continue;
        // `plus` extends + from its frontage (side 1), `minus` extends -.
        const [plus, minus] = ra.side === 1 ? [ai, bi] : [bi, ai];
        const rp = pc.runs[plus];
        const rm = pc.runs[minus];
        const frontOf = (r: { axis: 'h' | 'v'; x0: number; y0: number }): number => (r.axis === 'h' ? r.y0 : r.x0);
        const fp = frontOf(rp);
        const fm = frontOf(rm);
        const G = fm - fp + 1; // dA + dB must equal this for the rears to meet
        if (G < 8) continue; // no room to split into two >=4 plots
        let mA = Infinity;
        let mB = Infinity;
        for (const p of runs.get(plus)!) mA = Math.min(mA, p.d);
        for (const p of runs.get(minus)!) mB = Math.min(mB, p.d);
        const lo = Math.max(4, G - mB);
        const hi = Math.min(mA, G - 4);
        if (hi < lo) continue; // the pair cannot meet without growing a plot
        // closest feasible depth to the block's middle; the shallow side wins
        // when one run cannot reach halfway
        const dA = Math.min(hi, Math.max(lo, G >> 1));
        const dB = G - dA;
        for (const p of runs.get(plus)!) p.d = dA;
        for (const p of runs.get(minus)!) p.d = dB;
        snapped.add(plus);
        snapped.add(minus);
        break;
      }
    }
  }

  // ── C1 · per run, normalize setbacks to the mode value ─────────────────
  // Runs AFTER C3 so the clamp sees the snapped depths: a plot shrunk to 4
  // keeps a house (setback clamped to 0 rather than leaving avail < MIN_AVAIL).
  for (const [, runPlots] of runs) {
    const counts = new Map<number, number>();
    for (const p of runPlots) counts.set(p.setback, (counts.get(p.setback) ?? 0) + 1);
    let modeSetback = runPlots[0].setback;
    let bestCount = 0;
    for (const [s, c] of counts) {
      if (c > bestCount || (c === bestCount && s > modeSetback)) {
        modeSetback = s;
        bestCount = c;
      }
    }
    // Clamp each plot's setback to its own max (d-4), so a shallow plot's
    // front wall still meets its row's setback line where possible.
    for (const p of runPlots) p.setback = Math.min(modeSetback, p.d - 4);
  }

  return pc;
}
