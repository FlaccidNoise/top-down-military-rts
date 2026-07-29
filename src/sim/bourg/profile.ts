import type { MapKind } from '../mapgen';
import type { Archetype } from './streets';

// Per-kind parameter sets for the one generator (docs/plans/2026-07-27-mapgen-v3-design.md §1).
//
// Every field here is a constant lifted out of a bourg stage AT ITS CURRENT
// VALUE, so `BOURG` reproduces the pipeline byte for byte — that is what makes
// the extraction provable rather than argued (the frozen fingerprints
// 8607a31f/6e8a0239 and the PRE_RELIEF.bourg row are the control). A new map
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
  // Columns of Grande Rue the widening spans, or null for "there is no place".
  // §1 spells this as a separate `placeWiden: boolean` beside a length; one
  // nullable field instead, because two fields can disagree and this one
  // cannot. null leaves the carrefour as the plain 3-wide crossing it was.
  placeLen: [number, number] | null;
  // stage 9 — the cap that sheds block-interior sheds before frontage, and the
  // floor under which the whole attempt is rerolled. 0 disables the floor;
  // `bourg` and `road` keep it disabled because their geometry pins were frozen
  // before the reroll existed (mapgen.ts tryGenerateV3).
  maxBuildings: number;
  minBuildings: number;
  // stage 11 — the rural fabric
  farms: [number, number];
  bocageCell: number;
  stands: [number, number]; // stands BEYOND the guaranteed east anchor
  standRadius: [number, number];
  // Ellipses of grass carved back OUT of the painted stands (rural.ts
  // carveClearings, TAG.CLEARING). [0, 0] skips the sub-stage entirely rather
  // than drawing a zero count — the stage owns its own sub-stream, so skipping
  // it moves nothing, and that is what keeps every kind but `woods` frozen.
  //
  // It stays [0, 0] on every small-stand kind, and that is a MEASURED decision,
  // not an oversight: a clearing is 12-19 tiles across and a stand at
  // standRadius [6, 5] is 12-24, so a carve is stand-sized. The pick maximises
  // canopy, so it lands on the biggest stand on the map and deletes it —
  // `open` at clearings [1, 1] loses 5 % of its canopy (1.16 % → 1.10 % of
  // tiles, seeds 1-40) and gives back grass that is indistinguishable from the
  // grass round it. Only `woods`, whose radii are 40-57, has anything to carve.
  clearings: [number, number];
  // stage 2c — the N→S water band (streets.ts carveWater, TAG.WATER). null is
  // no river at all and takes no draw, which is what keeps every dry kind
  // byte-identical. `width` is the band's span in tiles before its ±3 walk.
  water: { width: number } | null;
  /** S4 per-site land-use assignment: [cropPct, orchPct] out of 100; remainder is pasture. */
  fieldMix: [number, number];
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
  minBuildings: 0,
  farms: [2, 2],
  bocageCell: 26,
  stands: [2, 3],
  standRadius: [6, 5],
  clearings: [0, 0],
  water: null,
  fieldMix: [35, 10],
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
  minBuildings: 0,
  farms: [2, 2],
  bocageCell: 24,
  stands: [3, 3],
  standRadius: [6, 5],
  clearings: [0, 0],
  water: null,
  fieldMix: [40, 10],
};

// §2.3 — scattered farmsteads, hedged parcels, a tiny nucleus. The inversion
// of the bourg: there, the rural fabric is the frame around the town; here the
// rural fabric IS the map and the nucleus is a detail in it. Nothing about the
// pipeline changes — only which stages get room to run.
//
// The envelope is 34-45 x 26-33, a hamlet: enough for a crossroads with a
// dozen plots round it and no more. densFalloff 20 against the bourg's 12
// collapses the density gradient onto the junction itself, so the four corners
// of the crossroads terrace and everything past them comes out as detached
// cottages with gardens — which is what a carrefour hamlet is. Streets 3-8:
// the two arms of the crossing plus a lane or two off it.
//
// Landmarks are suppressed rather than tuned down. A wayside chapel on one
// seed in ten is the only one a hamlet earns (churchPct 10); there is no
// market and no mairie at this scale, and placeLen null keeps the junction a
// plain 3-wide crossing. That last one is load-bearing beyond the look:
// scenario.ts emplaces the MG42 on objectives[0], which is land.anchor, and
// with no widening and no market island the anchor is the carrefour tile
// itself rather than a lane beside a paved square.
//
// maxBuildings 24 is the nucleus cap; the outlying farms are appended past it
// (rural.ts emitRural), so a 320x240 open map runs 20-40 buildings all in.
// minBuildings 4 is the legacy floor carried over verbatim — the retired blob
// pipeline rerolled an attempt that placed under four,
// and scenario.ts destructures `[b0, , b2]` out of the list, so it is a
// contract and not a preference.
//
// The rural numbers are where the kind actually lives: farms 4-6 against the
// bourg's 2-3, and bocage CELL 20 against 22 — a tighter grid of smaller
// parcels, which is the difference between hedges as scenery and hedges as the
// terrain. Every farm cour is a strongpoint, every hedge gate a choke, and the
// MG lanes are one field long instead of one street long.
export const OPEN: KindProfile = {
  archetypeW: [
    ['carrefour', 70],
    ['bourgRue', 30],
  ],
  envW: [34, 12],
  envH: [26, 8],
  densFalloff: 20,
  minStreets: 3,
  maxStreets: 8,
  churchPct: 10,
  marketPct: 0,
  forecourtPct: 0,
  placeLen: null,
  maxBuildings: 24,
  minBuildings: 4,
  farms: [4, 3],
  bocageCell: 24,
  stands: [3, 3],
  standRadius: [6, 5],
  clearings: [0, 0],
  water: null,
  fieldMix: [45, 10],
};

// §2.4 — stands, clearings, a forester pocket. `open` inverted the bourg by
// letting the rural fabric take the map; `woods` goes one further and lets ONE
// pass of it take the map. Stands 16-23 at radius 40-57 against open's 3-5 at
// 6-10 is not a tuning step, it is the difference between a wood on the map and
// a map that is wood, and every other number here follows from it.
//
// DEVIATION from §2.4, which asks for stands 8-12 at radius 8-14. Those numbers
// paint 3.5 % of a 320x240 map as trees — measured, and the same 3 % the legacy
// blob generator painted, i.e. §2.4's own tactical claim ("short sightlines
// everywhere except the clearings") is false of the map its numbers build. The
// stand pass paints roughly 1.94·r² tiles per stand before overlap, so canopy
// is quadratic in the radius and barely linear in anything else; the values
// here were swept against measured canopy and settled at 40-70 % (median 58 %,
// seeds 1-200). That is the number the kind actually is, and it is the reason
// the clearing sub-stage has anything to carve.
//
// The nucleus is a forester pocket, not a village: a 28-35 x 22-27 envelope
// (open's, shrunk), streets 3-6, no church, no market, no mairie, no place, and
// maxBuildings 14. minBuildings 3 rather than open's 4 — the floor exists to
// stop a kind coming out as two sheds, and three is what a pocket is. farms 1-2
// is the charcoal burner's holding; bocage CELL 32 against open's 20 is the
// same statement from the other side, since a hedged parcel is a thing you do
// to open country and there is not much of that here.
//
// clearings 2-4 is the counterweight, and the only genuinely new machinery in
// the kind. Under a solid canopy every sightline is 8 m and a battle is a
// series of ambushes at grenade range; the clearings are where a fight can
// actually be had, and one of them is guaranteed astride the arterial so the
// one vehicle route across the map opens into a kill zone rather than running
// blind end to end.
//
// densFalloff 20 is open's, not a measured value for this kind: with an
// envelope this small the density gradient is spent inside the nucleus either
// way. It is the first thing to reach for if the pocket comes out too even.
export const WOODS: KindProfile = {
  archetypeW: [
    ['carrefour', 70],
    ['bourgRue', 30],
  ],
  envW: [28, 8],
  envH: [22, 6],
  densFalloff: 20,
  minStreets: 3,
  maxStreets: 6,
  churchPct: 0,
  marketPct: 0,
  forecourtPct: 0,
  placeLen: null,
  maxBuildings: 14,
  minBuildings: 3,
  farms: [1, 2],
  bocageCell: 34,
  stands: [16, 8],
  standRadius: [40, 18],
  clearings: [2, 3],
  water: null,
  fieldMix: [15, 5],
};

// §2.5 — the ford assault. `river` is OPEN's countryside with a 5-wide band
// through it, and the numbers below are open's VERBATIM rather than a spread
// of it: each kind's fingerprints are frozen against its own record, so a
// `river: { ...OPEN, water }` would let a future tuning pass on `open` move
// river's pins with nothing in the diff to say why.
//
// What the kind is, is the composition and not the numbers. The nucleus sits
// east of the band by construction (streets.ts carveWater), so both banks are
// bocage country and the fight is suppress-and-cross rather than a fight for a
// structure: the crossing is the only armour route on the map, and the west
// bank is where the attack forms up. 5 tiles wide against the bridge's 3 is
// the whole difference in the water itself — wide enough that the far bank is
// a separate problem, which is what makes it a river rather than a stream.
export const RIVER: KindProfile = {
  archetypeW: [
    ['carrefour', 70],
    ['bourgRue', 30],
  ],
  envW: [34, 12],
  envH: [26, 8],
  densFalloff: 20,
  minStreets: 3,
  maxStreets: 8,
  churchPct: 10,
  marketPct: 0,
  forecourtPct: 0,
  placeLen: null,
  maxBuildings: 24,
  minBuildings: 4,
  farms: [4, 3],
  bocageCell: 24,
  stands: [3, 3],
  standRadius: [6, 5],
  clearings: [0, 0],
  water: { width: 5 },
  fieldMix: [45, 10],
};

// §2.5 — the bridge-head hamlet. The one kind whose nucleus exists BECAUSE of
// the water: a village grows where a road crosses a river, and the crossing is
// then the thing it is defended from. carveWater puts R_env 6-12 tiles east of
// the band, so the houses overlook the deck and the defence is fire onto a
// 3-wide approach the attacker has no way round.
//
// The envelope is 44-59 x 34-43 — §2.5's numbers, between open's hamlet and
// road's ribbon, because a bridge-head is a real village and not a crossroads
// with four cottages on it. densFalloff 15 sits between the bourg's 12 and
// open's 20 for the same reason: at 20 an envelope this size is fringe-grade
// eight tiles from the junction and the whole bridge-head comes out detached,
// which is the one thing it must not be — the far bank is defended from party
// walls or it is not defended.
//
// Landmarks are rolled, not suppressed: church 25, market 10, per §2.5.
// placeLen is what makes the market roll mean anything at all — reserveMarket
// needs a widened rect 12 by 11 to fit its island and returns null on the
// plain 3-wide crossing (landmarks.ts), so `marketPct 10` against
// `placeLen: null` would be a dead draw. 16-23 columns is road's short bulge,
// which is the right size for a village that grew on a bridge approach.
//
// forecourtPct 0 is open's value and NOT a deviation from §2.5, which names
// only the church and the market: a hamlet of this size has no mairie.
export const BRIDGE: KindProfile = {
  archetypeW: [
    ['carrefour', 70],
    ['bourgRue', 30],
  ],
  envW: [44, 16],
  envH: [34, 10],
  densFalloff: 15,
  minStreets: 4,
  maxStreets: 10,
  churchPct: 25,
  marketPct: 10,
  forecourtPct: 0,
  placeLen: [16, 8],
  maxBuildings: 36,
  minBuildings: 4,
  farms: [4, 3],
  bocageCell: 24,
  stands: [3, 3],
  standRadius: [6, 5],
  clearings: [0, 0],
  water: { width: 3 },
  fieldMix: [45, 10],
};

// The routing table, and since P6 retired the legacy pipeline it is the WHOLE
// dispatch: generateMap looks the kind up here and runs the one pipeline
// against what it finds. A new map kind is a record in this table, never a
// branch. Exhaustive by type, so adding a MapKind arm fails to compile until
// its parameters exist.
export const PROFILES: Record<MapKind, KindProfile> = {
  bourg: BOURG,
  road: ROAD,
  open: OPEN,
  woods: WOODS,
  river: RIVER,
  bridge: BRIDGE,
};
