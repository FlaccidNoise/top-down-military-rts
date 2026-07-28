import type { MapKind } from '../mapgen';
import type { Archetype } from './streets';

// Per-kind parameter sets for the one generator (docs/plans/2026-07-27-mapgen-v3-design.md §1).
//
// Every field here is a constant lifted out of a bourg stage AT ITS CURRENT
// VALUE, so `BOURG` reproduces the pipeline byte for byte — that is what makes
// the extraction provable rather than argued (the frozen fingerprints
// 97b5bca/eb9a14e6 and the PRE_RELIEF.bourg row are the control). A new map
// kind is then a new record, not a new branch.
//
// Ranges are [base, span]: the stage draws `base + rng.int(span)`, so [70, 41]
// is 70-110 inclusive. Spelled that way rather than [min, max] because the
// stages carry the draw and a min/max form would put arithmetic in front of it.
export interface KindProfile {
  // stage 1 — archetype and envelope
  archetypeW: [Archetype, number][]; // weights out of 100; [['bourgRue', 100]] forces one
  envW: [number, number];
  envH: [number, number];
  densFalloff: number; // densQ8 denominator slope — bigger falls off faster
  // stages 3/5 — the growth loop's floor and hard cap
  minStreets: number;
  maxStreets: number;
  // stage 4 — landmark sub-stage probabilities, out of 100.
  //
  // The market's roll is drawn UNCONDITIONALLY (it always was, landmarks.ts
  // reserveMarket), so tuning marketPct moves nothing else in the stage. The
  // church and the forecourt take a roll only when their pct is under 100: the
  // bourg draws neither today and the whole migration is pinned on its stream,
  // so for them 100 has to mean "no draw at all". Below 100 the draw happens at
  // every value including 0, so a kind that rolls keeps the same tuning
  // stability the market has.
  churchPct: number;
  marketPct: number;
  forecourtPct: number;
  placeLen: [number, number]; // columns of Grande Rue the widening spans
  // stage 9 — the cap that sheds block-interior sheds before frontage
  maxBuildings: number;
  // stage 11 — the rural fabric
  farms: [number, number];
  bocageCell: number;
  stands: [number, number]; // stands BEYOND the guaranteed east anchor
  standRadius: [number, number];
}

// The bourg, verbatim. Do not "tidy" a value here: each one is the number the
// bourg's art baseline and its geometry pins were frozen against.
export const BOURG: KindProfile = {
  archetypeW: [
    ['carrefour', 35],
    ['bourgRue', 35],
    ['enclos', 20],
    ['faubourg', 10],
  ],
  envW: [70, 41],
  envH: [55, 31],
  densFalloff: 12,
  minStreets: 9,
  maxStreets: 24,
  churchPct: 100,
  marketPct: 60,
  forecourtPct: 100,
  placeLen: [26, 17],
  maxBuildings: 80,
  farms: [2, 2],
  bocageCell: 22,
  stands: [2, 3],
  standRadius: [6, 5],
};

// §2.2 — the linear roadside village. Everything about it follows from one
// decision: the fight IS the street. 'bourgRue' is forced rather than weighted,
// because a carrefour on a 26-tile-tall envelope is a bourg that has been sat
// on, and the archetype is the only thing that suppresses the cross route
// (streets.ts stage 3b) and grows spurs off the rue instead (3d).
//
// The envelope is a ribbon: 90-119 wide against 26-37 tall, so the rue runs
// most of the map and everything else hangs off it. densFalloff 9 against the
// bourg's 12 is what keeps the frontage terraced along that whole length —
// density falls off from the place by Chebyshev distance, and at 12 a plot 50
// tiles down the rue is fringe-grade and comes out as a detached cottage.
//
// Landmarks turn probabilistic here. A village of this size has a church about
// half the time and a market rarely; the forecourt is the mairie, which is
// commoner than a market and rarer than a church. placeLen 16-23 against the
// bourg's 26-42 is the difference between a square and a bulge — and it is
// also the MG-lane control, since the widening is the one thing that can
// splice two straight runs of the rue into one lane (landmarks.ts widenPlace).
//
// The rural fabric is `open`'s, not the bourg's: a ribbon leaves most of the
// map as country, and the rear-garden band behind the frontage is the flanking
// route (enclosures.ts rearConnected), with the bocage beyond it.
export const ROAD: KindProfile = {
  archetypeW: [['bourgRue', 100]],
  envW: [90, 30],
  envH: [26, 12],
  densFalloff: 9,
  minStreets: 4,
  maxStreets: 12,
  churchPct: 50,
  marketPct: 15,
  forecourtPct: 40,
  placeLen: [16, 8],
  maxBuildings: 55,
  farms: [2, 2],
  bocageCell: 22,
  stands: [3, 3],
  standRadius: [6, 5],
};

// The routing table: a kind reaches the v3 pipeline exactly when it has a
// profile here (mapgen.ts tryGenerate). Partial while the legacy pipeline still
// owns the other kinds — a cutover is an entry added here, not a new branch.
export const PROFILES: Partial<Record<MapKind, KindProfile>> = {
  bourg: BOURG,
  road: ROAD,
};
