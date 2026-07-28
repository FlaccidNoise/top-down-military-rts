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
  maxBuildings: 80,
  farms: [2, 2],
  bocageCell: 22,
  stands: [2, 3],
  standRadius: [6, 5],
};

// The routing table: a kind reaches the v3 pipeline exactly when it has a
// profile here (mapgen.ts tryGenerate). Partial while the legacy pipeline still
// owns the other kinds — a cutover is an entry added here, not a new branch.
export const PROFILES: Partial<Record<MapKind, KindProfile>> = {
  bourg: BOURG,
};
