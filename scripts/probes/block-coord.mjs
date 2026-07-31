// Block-coordination probe — measures the residual gaps the coordination layer
// owns, per seed × kind, on the plan geometry (no relief).
//
//   npx vite-node scripts/probes/block-coord.mjs            # all kinds, seeds 1-12
//   npx vite-node scripts/probes/block-coord.mjs -- --kind bourg --seeds 1,2,3
//
// Metrics:
//   sliver1      building pairs (non-terrace side-neighbours) exactly 1 tile apart
//   abut0        building pairs 0 tiles apart NOT sharing a terraceRun (glued sheds)
//   rearStrip    columns of opposing-run pairs whose rear boundaries leave a strip
//                (rearB - rearA >= 1) — the leftover-sliver backyards
//   setbackSpread  per-run max setback minus min setback (unclamped plots only)
//   doubleWall   parallel enclosure-wall pairs 1 tile apart with overlapping spans
//   orphans      gardens whose plot carries no building
import { mulberry32 } from '../../src/sim/rng';
import { subStream, TAG } from '../../src/sim/bourg/streets';
import { generateHeightField } from '../../src/sim/bourg/height';
import { planBourg } from '../../src/sim/bourg/plan';
import { PROFILES } from '../../src/sim/bourg/profile';
import { EDGE } from '../../src/sim/map';

const KINDS = ['open', 'road', 'woods', 'river', 'bridge', 'bourg'];
const W = 320;
const H = 240;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

function planFor(seed, kind) {
  const profile = PROFILES[kind];
  const rng = mulberry32((seed ^ 0x51ab3fc7) + 0); // attempt 0 only
  const bourgBase = rng.int(0x7fffffff);
  const heightRng = subStream(bourgBase, TAG.HEIGHT);
  const height = generateHeightField(heightRng.int(0x7fffffff), W, H, profile.height.amp);
  return planBourg(bourgBase, W, H, profile, height);
}

// ── A: inter-building gaps (same-run street rows only) ───────────────────
// The coordination layer's contract is about houses in a row: adjacent plots
// on the same frontage run. Rural/civic masses (farms, church group, market,
// interior sheds) are placed by their own systems and excluded.
import { plotRect } from '../../src/sim/bourg/parcels';

const PLOT_ROLES = new Set(['townhouse', 'farmhouse', 'shop', 'bakery', 'forge']);

function buildingGaps(pc, fp) {
  // map each plot's primary rect to its runIndex
  const runOf = new Map();
  for (const p of pc.plots) runOf.set(`${p.fx},${p.fy},${p.w},${p.d}`, p.runIndex);
  const rects = [];
  for (const b of fp.buildings) {
    if (!PLOT_ROLES.has(b.role)) continue;
    const r = b.parts?.[0] ?? b;
    // find the plot this house sits in: body rect is inside the plot rect
    let runIndex = -1;
    for (const p of pc.plots) {
      const pr = plotRect(p);
      if (r.x >= pr.x && r.y >= pr.y && r.x + r.w <= pr.x + pr.w && r.y + r.h <= pr.y + pr.h) {
        runIndex = p.runIndex;
        break;
      }
    }
    if (runIndex < 0) continue;
    for (const p of b.parts ?? [b]) rects.push({ ...p, runIndex, terraceRun: b.terraceRun });
  }
  const sliver1 = [];
  const abut0 = [];
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.runIndex !== b.runIndex) continue;
      // horizontal neighbours (a west of b)
      if (a.x + a.w <= b.x && a.y < b.y + b.h && b.y < a.y + a.h) {
        const gap = b.x - (a.x + a.w);
        if (gap === 1) sliver1.push([a, b]);
        else if (gap === 0 && a.terraceRun !== b.terraceRun) abut0.push([a, b]);
      }
      // vertical neighbours (a north of b)
      if (a.y + a.h <= b.y && a.x < b.x + b.w && b.x < a.x + a.w) {
        const gap = b.y - (a.y + a.h);
        if (gap === 1) sliver1.push([a, b]);
        else if (gap === 0 && a.terraceRun !== b.terraceRun) abut0.push([a, b]);
      }
    }
  return { sliver1, abut0 };
}

// ── B: rear-strip columns between opposing runs ────────────────────────────
// For a pair of opposing runs (same block, same axis, opposite side) all plots
// on a run share the frontage line; per column the two rear boundaries must
// meet (no strip). rear edge for side=1 is fy+d (axis h), for side=-1 fy-d+1.
function rearStrips(pc) {
  const runs = new Map(); // runIndex -> plots
  for (const p of pc.plots) {
    let l = runs.get(p.runIndex);
    if (!l) { l = []; runs.set(p.runIndex, l); }
    l.push(p);
  }
  const byBlock = new Map();
  for (const p of pc.plots) {
    let l = byBlock.get(p.blockId);
    if (!l) { l = []; byBlock.set(p.blockId, l); }
    l.push(p);
  }
  const strips = []; // { a, b, strip, G, feasible }
  const runMin = new Map();
  for (const p of pc.plots) runMin.set(p.runIndex, Math.min(runMin.get(p.runIndex) ?? 999, p.d));
  const rearOf = (p) =>
    p.axis === 'h' ? (p.side < 0 ? p.fy - p.d + 1 : p.fy + p.d) : p.side < 0 ? p.fx - p.d + 1 : p.fx + p.d;
  const frontOf = (p) => (p.axis === 'h' ? p.fy : p.fx);
  const spanOf = (p) => (p.axis === 'h' ? p.fx : p.fy);
  const widOf = (p) => p.w;

  for (const [, plots] of byBlock) {
    for (let i = 0; i < plots.length; i++)
      for (let j = i + 1; j < plots.length; j++) {
        const a = plots[i];
        const b = plots[j];
        if (a.axis !== b.axis || a.side === b.side) continue;
        const lo = Math.max(spanOf(a), spanOf(b));
        const hi = Math.min(spanOf(a) + widOf(a), spanOf(b) + widOf(b));
        if (hi - lo <= 0) continue;
        // a is the side=1 run (extends +), b the side=-1 (extends -); the
        // frontages must be ordered so the pair faces across the block
        const [plus, minus] = a.side === 1 ? [a, b] : [b, a];
        if (frontOf(plus) >= frontOf(minus)) continue;
        const G = frontOf(minus) - frontOf(plus) + 1;
        const dPlus = plus.d;
        const dMinus = minus.d;
        const rearPlus = frontOf(plus) + dPlus;
        const rearMinus = frontOf(minus) - dMinus + 1;
        const strip = rearMinus - rearPlus; // >=1 means leftover ground
        if (strip >= 1)
          strips.push({
            a,
            b,
            strip,
            G,
            // C3 could merge the pair only when both runs' shallowest plots
            // reach the meeting line; otherwise the strip is geometrically
            // forced (growing a plot is forbidden — claimed/interiors/rural).
            feasible: runMin.get(a.runIndex) + runMin.get(b.runIndex) >= G,
          });
      }
  }
  return strips;
}

// ── C: per-run setback spread ───────────────────────────────────────────────
function setbackSpread(pc) {
  const runs = new Map();
  for (const p of pc.plots) {
    let l = runs.get(p.runIndex);
    if (!l) { l = []; runs.set(p.runIndex, l); }
    l.push(p);
  }
  const spreads = [];
  for (const [, plots] of runs) {
    if (plots.length < 2) continue;
    // unclamped: plots whose setback was not cut by d-4
    const free = plots.filter((p) => p.setback <= p.d - 5);
    if (free.length < 2) continue;
    let mn = Infinity;
    let mx = -1;
    for (const p of free) {
      if (p.setback < mn) mn = p.setback;
      if (p.setback > mx) mx = p.setback;
    }
    if (mx - mn > 0) spreads.push({ run: plots[0].runIndex, mn, mx, n: free.length });
  }
  return spreads;
}

// ── D: parallel enclosure walls 1 tile apart ───────────────────────────────
// Walls live on the GameMap, which planBourg does not produce — stamp it.
import { GameMap } from '../../src/sim/map';
import { stampBourg } from '../../src/sim/bourg/plan';

function doubleWalls(plan) {
  const map = new GameMap(W, H);
  stampBourg(map, plan);
  const w = map.w;
  const h = map.h;
  const ourT = (t) => t === 1 || t === 2;
  // horizontal walls at rows y and y+1 (same x range)
  const hw = new Map(); // y -> [x0,x1] runs
  for (let ey = 0; ey <= h; ey++) {
    const runs = [];
    let s = -1;
    for (let ex = 0; ex < w; ex++) {
      const e = map.hEdge(ex, ey);
      if (e === EDGE.WALL && ourT(map.hEdgeTops[ey * w + ex])) {
        if (s < 0) s = ex;
      } else if (s >= 0) {
        runs.push([s, ex - 1]);
        s = -1;
      }
    }
    if (s >= 0) runs.push([s, w - 1]);
    hw.set(ey, runs);
  }
  let count = 0;
  const pairs = [];
  for (let ey = 0; ey < h; ey++)
    for (const rA of hw.get(ey))
      for (const rB of hw.get(ey + 1))
        if (rA[0] <= rB[1] && rB[0] <= rA[1]) {
          count++;
          pairs.push(['h', ey, rA, rB]);
        }
  // vertical walls at columns x and x+1
  const vw = new Map();
  for (let ex = 0; ex <= w; ex++) {
    const runs = [];
    let s = -1;
    for (let ey = 0; ey < h; ey++) {
      const e = map.vEdge(ex, ey);
      if (e === EDGE.WALL && ourT(map.vEdgeTops[ey * (w + 1) + ex])) {
        if (s < 0) s = ey;
      } else if (s >= 0) {
        runs.push([s, ey - 1]);
        s = -1;
      }
    }
    if (s >= 0) runs.push([s, h - 1]);
    vw.set(ex, runs);
  }
  for (let ex = 0; ex < w; ex++)
    for (const rA of vw.get(ex))
      for (const rB of vw.get(ex + 1))
        if (rA[0] <= rB[1] && rB[0] <= rA[1]) {
          count++;
          pairs.push(['v', ex, rA, rB]);
        }
  return { count, pairs: pairs.slice(0, 8) };
}

// ── E: gardens with no house ────────────────────────────────────────────────
function orphanGardens(fp) {
  const withHouse = new Set();
  for (const b of fp.buildings) withHouse.add(b.plotIndex);
  const orphans = [];
  for (const g of fp.gardens) if (!withHouse.has(g.plotIndex)) orphans.push(g);
  return orphans;
}

const kinds = (arg('kind', null) || KINDS.join(',')).split(',');
const seeds = (arg('seeds', null) || '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);
const verbose = process.argv.includes('--verbose');

let totals = { sliver1: 0, abut0: 0, rearStrip: 0, rearInfeas: 0, doubleWall: 0, setbackSpread: 0, orphans: 0, plots: 0, houses: 0 };
const perKind = {};
for (const kind of kinds)
  perKind[kind] = { sliver1: 0, abut0: 0, rearStrip: 0, rearInfeas: 0, doubleWall: 0, setbackSpread: 0, orphans: 0 };

for (const kind of kinds) {
  for (const seed of seeds) {
    const plan = planFor(seed, kind);
    const { pc, fp } = plan;
    const gaps = buildingGaps(pc, fp);
    const strips = rearStrips(pc);
    const spreads = setbackSpread(pc);
    const dw = doubleWalls(plan);
    const orph = orphanGardens(fp);
    const feas = strips.filter((s) => s.feasible).length;
    totals.sliver1 += gaps.sliver1.length;
    totals.abut0 += gaps.abut0.length;
    totals.rearStrip += strips.length;
    totals.rearInfeas += strips.length - feas;
    totals.doubleWall += dw.count;
    totals.setbackSpread += spreads.length;
    totals.orphans += orph.length;
    totals.plots += pc.plots.length;
    totals.houses += fp.buildings.length;
    const k = perKind[kind];
    k.sliver1 += gaps.sliver1.length;
    k.abut0 += gaps.abut0.length;
    k.rearStrip += strips.length;
    k.rearInfeas += strips.length - feas;
    k.doubleWall += dw.count;
    k.setbackSpread += spreads.length;
    k.orphans += orph.length;
    if (gaps.sliver1.length || gaps.abut0.length || feas || strips.length || dw.count || spreads.length)
      console.log(
        `${kind} s${seed}: sliver1=${gaps.sliver1.length} abut0=${gaps.abut0.length} rearStrip=${strips.length}(feas-unmerged=${feas}) doubleWall=${dw.count} setbackSpread=${spreads.length} (plots=${pc.plots.length} houses=${fp.buildings.length})`,
      );
  }
}

console.log('── totals (over ' + kinds.length * seeds.length + ' maps) ──');
for (const kind of kinds)
  console.log(
    `${kind}: sliver1=${perKind[kind].sliver1} abut0=${perKind[kind].abut0} rearStrip=${perKind[kind].rearStrip} (infeasible=${perKind[kind].rearInfeas}) doubleWall=${perKind[kind].doubleWall} setbackSpread=${perKind[kind].setbackSpread} orphans=${perKind[kind].orphans}`,
  );
console.log(
  `ALL: sliver1=${totals.sliver1} abut0=${totals.abut0} rearStrip=${totals.rearStrip} (infeasible=${totals.rearInfeas}) doubleWall=${totals.doubleWall} setbackSpread=${totals.setbackSpread} orphans=${totals.orphans} plots=${totals.plots} houses=${totals.houses}`,
);
