// T_TOWNS (stage 41, S8): settlement sites — towns prefer the river line
// (crossing candidates, confluences), villages spaced-sample the countryside.
// Pure geometry: no nodes are minted here; roads.ts turns sites into the
// node/edge graph. All draws come from the TOWNS stage stream, all
// coordinates are integer metres.
import type { River, Vec } from '../theater';
import { stageStream, T_TAG } from './streams';

export interface SettlementPlan {
  towns: Vec[];
  villages: Vec[];
}

// §2 default bands (24x18 km, townDensity 1): towns 3-5 spaced >= 5000 m with
// >= 2 river-adjacent, villages 8-12 spaced >= 1800 m. Counts are functions
// of cfg (§9.2): town target = townDensity x areaKm2 / 100, villages ~2.8x, capped at the band ceiling 12.
export const TOWN_SPACING_M = 5000;
export const VILLAGE_SPACING_M = 1800;
const TOWN_RIVER_OFFSET_M: [number, number] = [300, 800]; // beside the water, not in it
const EDGE_MARGIN_M = 1500; // no settlement hard against the frame
const PLACE_ATTEMPTS = 40; // bounded rejection sampling per site

const far = (p: Vec, others: Vec[], minM: number): boolean =>
  others.every((o) => Math.hypot(o.x - p.x, o.y - p.y) >= minM);

export function planSettlements(
  base: number,
  cfg: { townDensity: number; townSpacingMinKm: number },
  boundsM: { w: number; h: number },
  rivers: River[],
): SettlementPlan {
  const rng = stageStream(base, T_TAG.TOWNS);
  const { w, h } = boundsM;
  const areaKm2 = (w / 1000) * (h / 1000);
  const townTarget = Math.max(3, Math.round((cfg.townDensity * areaKm2) / 100));
  const villageTarget = Math.min(12, Math.round(townTarget * 2.8));
  const townSpacing = Math.max(TOWN_SPACING_M, cfg.townSpacingMinKm * 1000);

  const main = rivers[0];
  const towns: Vec[] = [];

  // River towns first (>= 2): pick spaced main-river vertices away from the
  // frame, offset to one bank. Confluence vertices (tributary joins) are in
  // the candidate set by construction — tributaries rise at main vertices.
  const riverVerts = main.polyline.filter(
    (p) => p.y > EDGE_MARGIN_M && p.y < h - EDGE_MARGIN_M,
  );
  const riverTowns = 2 + (townTarget >= 5 ? rng.int(2) : 0);
  for (let i = 0; i < riverTowns; i++) {
    for (let a = 0; a < PLACE_ATTEMPTS; a++) {
      const v = riverVerts[rng.int(riverVerts.length)];
      const side = rng.next() < 0.5 ? -1 : 1;
      const p = {
        x: Math.round(v.x + side * rng.range(TOWN_RIVER_OFFSET_M[0], TOWN_RIVER_OFFSET_M[1])),
        y: v.y,
      };
      if (p.x < EDGE_MARGIN_M || p.x > w - EDGE_MARGIN_M) continue;
      if (!far(p, towns, townSpacing)) continue;
      towns.push(p);
      break;
    }
  }

  // Inland towns fill the target, spaced against every existing town.
  while (towns.length < townTarget) {
    let placed = false;
    for (let a = 0; a < PLACE_ATTEMPTS; a++) {
      const p = {
        x: Math.round(rng.range(EDGE_MARGIN_M, w - EDGE_MARGIN_M)),
        y: Math.round(rng.range(EDGE_MARGIN_M, h - EDGE_MARGIN_M)),
      };
      if (!far(p, towns, townSpacing)) continue;
      towns.push(p);
      placed = true;
      break;
    }
    if (!placed) break; // validation (S11 'spacing') owns the reject
  }

  // Villages: spaced against towns AND each other.
  const villages: Vec[] = [];
  while (villages.length < villageTarget) {
    let placed = false;
    for (let a = 0; a < PLACE_ATTEMPTS; a++) {
      const p = {
        x: Math.round(rng.range(EDGE_MARGIN_M, w - EDGE_MARGIN_M)),
        y: Math.round(rng.range(EDGE_MARGIN_M, h - EDGE_MARGIN_M)),
      };
      if (!far(p, towns, VILLAGE_SPACING_M) || !far(p, villages, VILLAGE_SPACING_M)) continue;
      villages.push(p);
      placed = true;
      break;
    }
    if (!placed) break;
  }

  return { towns, villages };
}
