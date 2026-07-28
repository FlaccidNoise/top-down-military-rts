import type { GameMap } from '../map';
import type { Vec } from '../mapgen';
import { stampEnclosures, type Enclosures } from './enclosures';
import { buildFootprints, type Footprints } from './footprints';
import { reserveLandmarks, type Landmarks } from './landmarks';
import { buildParcels, type Parcels } from './parcels';
import type { KindProfile } from './profile';
import { bourgSpawns } from './objectives';
import { addRuralFabric, paintRural, type Rural } from './rural';
import { stampStructure } from './stamp';
import { buildSkeleton, growMinorStreets, type Skeleton } from './streets';

// The bourg pipeline, assembled. Two phases, because the stage order is not
// negotiable and getting it wrong is silent:
//
//   planBourg(base, w, h, profile)  stages 1-11, PURE. No GameMap exists yet;
//                           the output is geometry plus a carved `road` bitmap.
//                           `profile` rides on the Skeleton from here on, so
//                           every later stage reads its own constants off it.
//   stampBourg(map, plan)   stage 12's write half, in mapgen's own order —
//                           terrain first, roads over it, buildings over that,
//                           enclosures last so every wall lands on a free edge.
//
// T11 owns the one `rng.int(0x7fffffff)` draw on the shared stream that seeds
// `base`, the objective list (buildObjectives, which needs stampBourg's woods
// stands), the elevation pass and validation. Everything else is here.

export interface BourgPlan {
  sk: Skeleton;
  land: Landmarks;
  pc: Parcels;
  fp: Footprints;
  rural: Rural;
  spawns: { west: Vec; east: Vec };
}

export interface BourgStamp {
  woodsStands: Vec[];
  maxStories: number;
  enclosures: Enclosures;
  // The middle tile of the bridge deck — the road that overwrote the water —
  // or null on a dry kind. Derived HERE rather than re-found afterwards
  // because this is the loop that records `map.bridges`: the crossing
  // objective is by construction the deck the sim already knows about.
  crossing: Vec | null;
}

export function planBourg(base: number, w: number, h: number, profile: KindProfile): BourgPlan {
  const sk = buildSkeleton(base, w, h, profile); // stages 1, 2, 3
  const land = reserveLandmarks(sk); // stage 4 — mutates sk.road (the place widening)
  // Stage 4's reservations and the river are the same fact to every stage
  // after this line — ground the town may not take — and each of those stages
  // takes ONE mask, so the two merge once here instead of being threaded as a
  // pair. A dry kind passes `land.resv` itself: no allocation, no extra read,
  // and nothing about P1-P4's four kinds left to prove.
  //
  // The growth loop still gets `resv` as well, because a reservation does one
  // thing water must not: a proposal stopped by one spawns a TANGENT street
  // along its boundary (streets.ts tangentAlong), which is the churchyard ring
  // and would be a road down the river bank.
  const blocked = profile.water ? union(land.resv, sk.water) : land.resv;
  growMinorStreets(sk, { resv: land.resv, blocked }); // stage 5 — mutates sk.road and sk.segs
  const pc = buildParcels(sk, blocked); // stages 6, 7, 8
  const fp = buildFootprints(sk, land, pc); // stage 9
  const rural = addRuralFabric(sk, land, pc, fp); // stage 11a — mutates sk.road and fp
  return { sk, land, pc, fp, rural, spawns: bourgSpawns(sk) };
}

function union(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] || b[i];
  return out;
}

export function stampBourg(map: GameMap, plan: BourgPlan): BourgStamp {
  const { sk, land, pc, fp, rural } = plan;
  // Water FIRST (§2.5). Every rural pass writes only over 'grass' (paintRural
  // plantable), so this one setTerrain is the whole exclusion: no hedge, wood,
  // orchard or field lands in the river, and no pass needs to know it exists.
  if (sk.profile.water)
    for (let i = 0; i < sk.water.length; i++) if (sk.water[i]) map.setTerrain(i % sk.w, (i / sk.w) | 0, 'water');
  // 11b: hedges, woods, orchards, fields — every pass writes only over 'grass'
  const woodsStands = paintRural(map, sk, land, pc, fp, rural);
  // roads next, so they win over the rural passes — and over the water, which
  // is the retired legacy pipeline's deck rule byte for byte: a road tile that
  // overwrites water IS the bridge, and it is recorded before the water is lost.
  const deck: number[] = [];
  for (let i = 0; i < sk.road.length; i++)
    if (sk.road[i]) {
      map.setTerrain(i % sk.w, (i / sk.w) | 0, 'road');
      if (sk.water[i]) {
        map.bridges[i] = 1;
        deck.push(i);
      }
    }
  const crossing = deckCentre(deck, sk);
  let maxStories = 0;
  fp.buildings.forEach((b, i) => {
    maxStories = Math.max(maxStories, stampStructure(map, b, i));
  });
  // stage 10 last: a free-standing wall only ever lands on an edge nothing else
  // owns, so the enclosures have to close around the finished buildings
  const enclosures = stampEnclosures(map, sk, land, fp);
  return { woodsStands, maxStories, enclosures, crossing };
}

// Which tile of the deck the crossing objective goes on: the one with open
// river closest on BOTH sides, ties to the middle of the deck's bounding box
// and then to scan order.
//
// Scored rather than picked geometrically, because the two obvious picks are
// both measurably wrong. The median tile in scan order lands on the west arm
// when the arterial's staircase steps AT the river — a column the band has
// since walked away from, so the objective is a road tile with no river north
// of it at all (7 seeds in 200 on 'river'). The centre of the bounding box is
// worse (34 in 200): a stepped crossing spans four road rows, and its middle
// two rows are the ones with three rows of deck above or below them.
//
// The score is the property itself: an objective on a bridge has to have the
// water it bridges within reach on either side, because that is what makes the
// crossing a choke and not just a road tile. Same Chebyshev measure the
// acceptance battery uses, so the test cannot pass by accident of a metric.
//
// `water && !road` is the river as it survives the stamp: the deck is water
// underneath, and scoring against the mask alone would let one deck tile count
// as the neighbour of the next.
function deckCentre(deck: number[], sk: Skeleton): Vec | null {
  if (deck.length === 0) return null;
  const { w, h } = sk;
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  for (const i of deck) {
    x0 = Math.min(x0, i % w);
    x1 = Math.max(x1, i % w);
    y0 = Math.min(y0, (i / w) | 0);
    y1 = Math.max(y1, (i / w) | 0);
  }
  const open = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && sk.water[y * w + x] === 1 && sk.road[y * w + x] === 0;
  // nearest open river to the north and to the south, Chebyshev, capped at 5
  // (past which the tile is not on a crossing by any reading)
  const reach = (cx: number, cy: number, sign: number): number => {
    for (let r = 1; r <= 5; r++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.sign(dy) !== sign) continue;
        for (let dx = -r; dx <= r; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && open(cx + dx, cy + dy)) return r;
      }
    return 99;
  };
  let best = deck[0];
  let bestScore = Infinity;
  let bestD2 = Infinity;
  for (const i of deck) {
    const x = i % w;
    const y = (i / w) | 0;
    const score = Math.max(reach(x, y, -1), reach(x, y, 1));
    // doubled, so an even span's centre is exact and the tiebreak stays integer
    const dx = 2 * x - (x0 + x1);
    const dy = 2 * y - (y0 + y1);
    const d2 = dx * dx + dy * dy;
    if (score < bestScore || (score === bestScore && d2 < bestD2)) {
      bestScore = score;
      bestD2 = d2;
      best = i;
    }
  }
  return { x: best % w, y: (best / w) | 0 };
}
