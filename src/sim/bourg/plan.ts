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
}

export function planBourg(base: number, w: number, h: number, profile: KindProfile): BourgPlan {
  const sk = buildSkeleton(base, w, h, profile); // stages 1, 2, 3
  const land = reserveLandmarks(sk); // stage 4 — mutates sk.road (the place widening)
  growMinorStreets(sk, { resv: land.resv }); // stage 5 — mutates sk.road and sk.segs
  const pc = buildParcels(sk, land.resv); // stages 6, 7, 8
  const fp = buildFootprints(sk, land, pc); // stage 9
  const rural = addRuralFabric(sk, land, pc, fp); // stage 11a — mutates sk.road and fp
  return { sk, land, pc, fp, rural, spawns: bourgSpawns(sk) };
}

export function stampBourg(map: GameMap, plan: BourgPlan): BourgStamp {
  const { sk, land, pc, fp, rural } = plan;
  // 11b: hedges, woods, orchards, fields — every pass writes only over 'grass'
  const woodsStands = paintRural(map, sk, land, pc, fp, rural);
  // roads next, so they win over the rural passes exactly as mapgen's do
  for (let i = 0; i < sk.road.length; i++) if (sk.road[i]) map.setTerrain(i % sk.w, (i / sk.w) | 0, 'road');
  let maxStories = 0;
  fp.buildings.forEach((b, i) => {
    maxStories = Math.max(maxStories, stampStructure(map, b, i));
  });
  // stage 10 last: a free-standing wall only ever lands on an edge nothing else
  // owns, so the enclosures have to close around the finished buildings
  const enclosures = stampEnclosures(map, sk, land, fp);
  return { woodsStands, maxStories, enclosures };
}
