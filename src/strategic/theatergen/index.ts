// makeTheater (S11, design doc §2): the assembly line. Pure — same (seed,
// cfg) is byte-identical forever. Eight attempts, each on its own derived
// base (the generateMap precedent), then a THROWN TheaterGenError carrying
// the reject tally and the knob most likely responsible. NEVER a fallback
// theater.
import { mulberry32 } from '../../sim/rng';
import type { TheaterConfig } from '../../campaign/spec';
import type { Side } from '../../sim/sim';
import { MOVE_MPM, REGION_PACE_MULT, THEATER_VERSION, type Theater, type TheaterEdge, type TheaterNode, type Vec } from '../theater';
import { planRivers } from './rivers';
import { planSettlements } from './settlements';
import { planNetwork } from './roads';
import { LAT_M, planRegions } from './regions';
import { nameAll } from './names';
import { stageBase, stageStream, T_TAG } from './streams';
import { REJECT_KNOB, validateTheater, type RejectReason } from './validate';

export const THEATER_SALT = 0x7e47e12b;
const ATTEMPTS = 8;

export class TheaterGenError extends Error {
  constructor(
    public readonly seed: number,
    public readonly attempts: number,
    public readonly lastReason: RejectReason,
    public readonly rejectCounts: Partial<Record<RejectReason, number>>,
    public readonly knob: string | null,
  ) {
    super(
      `makeTheater: ${attempts} attempts rejected for seed ${seed} — last '${lastReason}'` +
        (knob ? ` (try the '${knob}' knob)` : '') +
        ` [${Object.entries(rejectCounts).map(([r, n]) => `${r}:${n}`).join(' ')}]`,
    );
    this.name = 'TheaterGenError';
  }
}

export interface TheaterResult {
  theater: Theater;
  initialControlByNode: Side[];
}

// Pure feasibility precheck (§9.2): the customize screen calls this on every
// knob change; an infeasible point greys out Generate & Play with the
// offending knob NAMED. This is a visible state, never a silent clamp.
export function feasible(
  cfg: TheaterConfig,
  campaign?: { warDays: number },
): { ok: true } | { ok: false; knob: string; reason: string } {
  const w = cfg.sizeKm * 1000;
  const h = w * 0.75;
  const areaKm2 = (w / 1000) * (h / 1000);
  const towns = (cfg.townDensity * areaKm2) / 100;
  const needed = towns * 0.866 * cfg.townSpacingMinKm ** 2;
  if (needed >= areaKm2) {
    return { ok: false, knob: 'townDensity', reason: `${Math.round(towns)} towns cannot pack at ${cfg.townSpacingMinKm} km spacing` };
  }
  if (campaign) {
    const minWarDays: Record<number, number> = { 18: 7, 24: 14, 32: 21 };
    const floor = minWarDays[cfg.sizeKm] ?? 14;
    if (campaign.warDays < floor) {
      return { ok: false, knob: 'warDays', reason: `deadline-infeasible: a ${cfg.sizeKm} km theater needs >= ${floor} days` };
    }
  }
  return { ok: true };
}

// Interpolated x of the main river at a given y — the front partition line.
function mainRiverXAt(polyline: Vec[], y: number): number {
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    if (y >= a.y && y <= b.y && b.y > a.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
  }
  return polyline[polyline.length - 1].x;
}

const OBJ_BRIDGES = 1;
const OBJ_OPEN = 1;
const OBJ_TOTAL = 3;
const OBJ_SPACING_M = 3000;

export function makeTheater(seed: number, cfg: TheaterConfig): TheaterResult {
  const boundsM = { w: cfg.sizeKm * 1000, h: Math.round(cfg.sizeKm * 750) };
  const rejectCounts: Partial<Record<RejectReason, number>> = {};
  let lastReason: RejectReason = 'disconnected';

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const shared = mulberry32((((seed ^ THEATER_SALT) + attempt * 0x9e3779b9) >>> 0));
    const base = stageBase(shared);

    const rivers = planRivers(base, cfg.riverDensity, boundsM);
    const settlements = planSettlements(base, cfg, boundsM, rivers);
    const { nodes, edges } = planNetwork(base, cfg, boundsM, rivers, settlements);
    const { regions, regionIdAt } = planRegions(base, cfg, boundsM, rivers, nodes);

    // Assign regionIds and bake paceMpm (moveClass base x length-weighted
    // region pace mult, sampled along the polyline at lattice resolution).
    for (const n of nodes) n.regionId = regionIdAt(n.pos.x, n.pos.y);
    for (const e of edges) {
      if (e.moveClass === 'rail') continue;
      e.paceMpm = bakePace(e, regions.length, regionIdAt, regions);
    }

    const name = nameAll(base, nodes, regions, rivers);

    // T_OBJECTIVES (stage 47): the initial front is the river-anchored
    // partition — west of the main river is blue, east is red; crossing
    // nodes sit on the line and start red (the defender holds the river).
    // Objectives: every red-side town plus every main-river BRIDGE — never
    // a ford: rivers are transit, orderMove refuses ford destinations, and a
    // war goal nobody may stand on is a stalled war (found live: the planner
    // vetoed nothing yet issued zero orders at seed 2).
    const objRng = stageStream(base, T_TAG.OBJECTIVES);
    const main = rivers[0].polyline;
    const control: Side[] = nodes.map((n) => {
      if (n.crossing) return 'red';
      return n.pos.x < mainRiverXAt(main, n.pos.y) ? 'blue' : 'red';
    });
    // v3 (jtbug #793): the objectives are spread over the kinds of ground a
    // war is fought on. Every red-side town that is not on a crossing still
    // counts. Of the main-river bridges, towns among them, only OBJ_BRIDGES
    // (a town first). Then places in open country, at least OBJ_OPEN of them
    // and as many as bring the theater to OBJ_TOTAL: a red-side village or
    // road junction, the shallowest behind the river first, on ground no
    // objective has yet, and at least OBJ_SPACING_M from every other
    // objective. With every bridge an objective, two fights in three were
    // the same bridge assault on the same map.
    const foot = (id: number): number => edges.filter((e) => e.moveClass !== 'rail' && (e.a === id || e.b === id)).length;
    const groundOf = (n: TheaterNode): string => (n.crossing ? 'crossing' : n.kind === 'town' || n.kind === 'village' ? n.kind : (regions[n.regionId]?.terrainClass ?? 'farmland'));
    const picked: TheaterNode[] = [
      ...nodes.filter((n) => n.kind === 'town' && control[n.id] === 'red' && !n.crossing),
      ...nodes
        .filter((n) => n.crossing?.riverId === 0 && n.crossing.kind === 'bridge')
        .sort((a, b) => a.rank - b.rank || a.id - b.id)
        .slice(0, OBJ_BRIDGES),
    ];
    const depth = (n: TheaterNode): number => n.pos.x - mainRiverXAt(main, n.pos.y);
    // A village or a junction with two roads or more first. On a red bank
    // that has none left, any dry red node: a rail halt, a road's end.
    const through = (n: TheaterNode): boolean => (n.kind === 'village' || n.kind === 'junction' || n.kind === 'crossroads') && foot(n.id) >= 2;
    const open = nodes
      .filter((n) => control[n.id] === 'red' && !n.crossing && n.kind !== 'town' && n.kind !== 'ford' && foot(n.id) >= 1)
      .sort((a, b) => Number(through(b)) - Number(through(a)) || depth(a) - depth(b) || a.id - b.id);
    for (let i = 0; i < OBJ_OPEN || picked.length < OBJ_TOTAL; i++) {
      const rest = open.filter((n) => !picked.includes(n));
      const gap = (n: TheaterNode): number => Math.min(...picked.map((p) => Math.hypot(p.pos.x - n.pos.x, p.pos.y - n.pos.y)));
      const apart = rest.filter((n) => gap(n) >= OBJ_SPACING_M);
      const have = new Set(picked.map(groundOf));
      // Nothing far enough apart: the one farthest from the rest, so a small
      // red bank still fills its count.
      const next = apart.find((n) => through(n) && !have.has(groundOf(n))) ?? apart[0] ?? [...rest].sort((a, b) => gap(b) - gap(a) || a.id - b.id)[0];
      if (!next) break;
      picked.push(next);
    }
    const objectiveNodes = picked.map((n) => n.id).sort((a, b) => a - b);
    // Supply sources: the map-edge lifelines — westmost blue, eastmost red,
    // picked from each side's LARGEST connected component of own-controlled
    // nodes. The literal westmost blue node can hang off a red-held crossing
    // on a spur (crossings start red by the partition rule), and a source
    // nobody can trace from makes supply a lie for the whole campaign —
    // found live at seed 7: source 14's only road ran through crossing 15
    // and every blue force read OUT from minute one. Drawn tiebreak keeps
    // the stage's stream live so appending draws later never reshuffles
    // another stage.
    void objRng.next();
    const sideSources = (side: Side, eastmost: boolean): number[] => {
      const mine = new Set(nodes.filter((n) => control[n.id] === side).map((n) => n.id));
      const seen = new Set<number>();
      const out: number[] = [];
      for (const start of [...mine].sort((a, b) => a - b)) {
        if (seen.has(start)) continue;
        const comp: number[] = [start];
        seen.add(start);
        const q = [start];
        while (q.length > 0) {
          const n = q.pop()!;
          for (const e of edges) {
            if (e.moveClass === 'rail') continue;
            const far = e.a === n ? e.b : e.b === n ? e.a : -1;
            if (far < 0 || seen.has(far) || !mine.has(far)) continue;
            seen.add(far);
            comp.push(far);
            q.push(far);
          }
        }
        const byX = comp
          .map((id) => nodes[id])
          .sort((a, b) => (eastmost ? b.pos.x - a.pos.x : a.pos.x - b.pos.x) || a.id - b.id);
        out.push(byX[0].id);
      }
      return out.sort((a, b) => a - b);
    };
    const sources: Record<Side, number[]> = {
      blue: sideSources('blue', false),
      red: sideSources('red', true),
    };

    const theater: Theater = {
      version: THEATER_VERSION,
      seed,
      name,
      boundsM,
      nodes,
      edges,
      regions,
      rivers,
      objectiveNodes,
      sources,
    };

    const reject = validateTheater(theater, control);
    if (reject === null) return { theater, initialControlByNode: control };
    rejectCounts[reject] = (rejectCounts[reject] ?? 0) + 1;
    lastReason = reject;
  }
  throw new TheaterGenError(seed, ATTEMPTS, lastReason, rejectCounts, REJECT_KNOB[lastReason]);
}

function bakePace(
  e: TheaterEdge,
  regionCount: number,
  regionIdAt: (x: number, y: number) => number,
  regions: Theater['regions'],
): number {
  if (e.moveClass === 'rail') return 0;
  const basePace = MOVE_MPM[e.moveClass];
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < e.polyline.length; i++) {
    const a = e.polyline[i - 1];
    const b = e.polyline[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const samples = Math.max(1, Math.round(segLen / LAT_M));
    for (let s = 0; s < samples; s++) {
      const t = (s + 0.5) / samples;
      const rid = regionIdAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      const mult = rid >= 0 && rid < regionCount ? REGION_PACE_MULT[regions[rid].terrainClass] : 1;
      weighted += (segLen / samples) * mult;
      total += segLen / samples;
    }
  }
  return Math.round(basePace * (total > 0 ? weighted / total : 1) * 10) / 10;
}
