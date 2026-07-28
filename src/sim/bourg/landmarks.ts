import type { Rect, Vec } from '../mapgen';
import type { Rng } from '../rng';
import { grandeRueRunAt, TAG, type Skeleton } from './streets';

// Stage 4 — landmark reservation (docs/plans/2026-07-26-town-gen-design.md, T5).
//
// Runs BETWEEN the skeleton and the minor-street growth loop, so the streets
// route around the landmarks rather than through them. That routing-around is
// what produces the characteristic tangent-street ring — the reservation is not
// just a keep-out mask, it is the shape generator for the enclos archetype.
//
// Writes: `resv` (its own array) and `sk.road` (the place widening only).
// Reads and clips against nothing else; nothing is stamped.

export const RESV = {
  NONE: 0,
  CHURCHYARD: 1, // walled enclosure, church group goes inside (T7)
  MARKET: 2, // island of terraced units inside the widened place (T7)
  CIVIC: 3, // set-back forecourt parcel for the mairie/école (T7)
} as const;

export interface Landmarks {
  resv: Uint8Array;
  churchyard: Rect | null;
  chamfer: number; // corner staircase depth of the churchyard, 0 when absent
  place: Rect; // the actual widened road area (never empty: falls back to the 3-wide band)
  market: Rect | null;
  forecourt: Rect | null;
  // A road tile ON the place, guaranteed unreserved — T10's objectives[0].
  // sk.place is the density origin and the geometric carrefour, but the market
  // island can legitimately sit on top of it, and scenario.ts:49 emplaces the
  // MG42 on objectives[0], which therefore has to be standable road.
  anchor: Vec;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// Columns of plain 3-wide Grande Rue the place widening must leave at each end
// of its run. See widenPlace — this is what keeps §1.4's MG-lane cap true on
// the carved bitmap and not just in the Seg list.
const JOG_CLEAR = 3;

export function reserveLandmarks(sk: Skeleton): Landmarks {
  const { w, h, road, place } = sk;
  const r4 = sk.S(TAG.LANDMARK);
  const resv = new Uint8Array(w * h);

  const churchyard = reserveChurchyard(sk, r4, resv);
  const chamfer = churchyard ? churchyard.chamfer : 0;
  const placeRect = widenPlace(sk, r4, resv);
  const market = reserveMarket(sk, r4, resv, placeRect);
  const forecourt = reserveForecourt(sk, r4, resv, placeRect, churchyard ? churchyard.rect : null);

  // nearest free road tile to the carrefour, by Chebyshev rings — the widening
  // leaves >= 3 tiles of lane on both flanks of the island, so one always exists
  let anchor: Vec = { x: place.x, y: place.y };
  for (let r = 0; r < Math.max(placeRect.w, placeRect.h); r++) {
    let found: Vec | null = null;
    for (let dy = -r; dy <= r && !found; dy++)
      for (let dx = -r; dx <= r && !found; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = place.x + dx;
        const y = place.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (road[y * w + x] && !resv[y * w + x]) found = { x, y };
      }
    if (found) {
      anchor = found;
      break;
    }
  }

  return { resv, churchyard: churchyard ? churchyard.rect : null, chamfer, place: placeRect, market, forecourt, anchor };
}

// ── 1. churchyard ────────────────────────────────────────────────────────────
//
// The doc's literal origin (`place + (int(9)-4, int(9)-4)`, side 24-34) puts the
// square's CORNER on the carrefour, i.e. it fills one quadrant of the crossing —
// which is right, and is what is implemented, but the corner is pushed 2-6 tiles
// clear of both centrelines instead of jittered through them. At offset 0 the
// square would swallow the cross route's 3-wide band and the Grande Rue's, and
// a reservation with a road through it is not an enclosure.
function reserveChurchyard(
  sk: Skeleton,
  r4: Rng,
  resv: Uint8Array,
): { rect: Rect; chamfer: number } | null {
  const { w, h, place } = sk;
  // The bourg always attempts a church and takes no roll for it, so 100 means
  // "no draw" — see KindProfile.churchPct. Same rule in reserveForecourt.
  if (sk.profile.churchPct < 100 && r4.int(100) >= sk.profile.churchPct) return null;
  const side = 24 + r4.int(11);
  const qx = r4.next() < 0.5 ? -1 : 1;
  const qy = r4.next() < 0.5 ? -1 : 1;
  const gapX = 2 + r4.int(5);
  const gapY = 2 + r4.int(5);
  const chamfer = 3 + r4.int(3);

  // Near corner sits `gap` clear of the centreline, the square extends away.
  // A candidate containing ANY road tile is rejected outright and the next
  // quadrant tried: an enclosure with a street through it is not an enclosure,
  // and for 'enclos' the cross route is placed 12-20 tiles off the place
  // precisely so one of the four quadrants is always clear of it.
  const fit = (sx: number, sy: number, len: number): Rect | null => {
    const x = sx < 0 ? place.x - gapX - len : place.x + gapX;
    const y = sy < 0 ? place.y - gapY - len : place.y + gapY;
    if (x < 3 || y < 3 || x + len > w - 3 || y + len > h - 3) return null;
    for (let yy = y; yy < y + len; yy++)
      for (let xx = x; xx < x + len; xx++) if (sk.road[yy * w + xx]) return null;
    return { x, y, w: len, h: len };
  };
  let rect: Rect | null = null;
  for (const [sx, sy] of [
    [qx, qy],
    [-qx, qy],
    [qx, -qy],
    [-qx, -qy],
  ]) {
    rect = fit(sx, sy, side);
    if (rect) break;
  }
  for (let len = side - 4; !rect && len >= 16; len -= 4) rect = fit(qx, qy, len) ?? fit(-qx, -qy, len);
  if (!rect) return null;

  // chamfer each corner with a staircase, then reserve every non-road tile
  const cut = (i: number, j: number): boolean => i + j < chamfer;
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      if (cut(x, y) || cut(rect.w - 1 - x, y) || cut(x, rect.h - 1 - y) || cut(rect.w - 1 - x, rect.h - 1 - y)) continue;
      resv[(rect.y + y) * w + rect.x + x] = RESV.CHURCHYARD;
    }
  return { rect, chamfer };
}

// ── 2. place widening ────────────────────────────────────────────────────────
//
// Not a square — a widening of the Grande Rue, asymmetric, over a run centred
// on the carrefour. Historically correct and mechanically simpler than a plaza:
// it is carved as `road`, which is exactly what drawPaving's `pavable` test
// already requires (terrain.ts:673-681), so G7 cobbles fire for free.
function widenPlace(sk: Skeleton, r4: Rng, resv: Uint8Array): Rect {
  const { w, h, road, place } = sk;
  const len = sk.profile.placeLen[0] + r4.int(sk.profile.placeLen[1]);
  const width = 11 + r4.int(7);
  const northShare = 3 + r4.int(width - 5);

  // Clipped to the straight run containing the place, so the widening never
  // straddles a jog and comes out as two offset rectangles — and held JOG_CLEAR
  // columns short of each end of that run.
  //
  // Clipping to the run alone is not enough, and this is §1.4's cap failing in
  // the one place §5.2's bitmap proxy does not look. A jog moves the Grande Rue
  // 2-3 rows, so consecutive runs' 3-row bands overlap in at most one row and
  // the band breaks at every jog — until the widening reaches the jog column.
  // There the widening's extra rows ARE the next run's rows, the band is
  // continuous across the joint, and two 45-tile arms plus the place merge into
  // one lane: measured 101 tiles on seed 7, 74/78/72 on three more, i.e. an MG
  // on the place covering both approaches end to end. That is exactly the "one
  // bad corridor" §1.4 caps the runs to prevent.
  //
  // The vertical jog seg is 3 wide, so it owns columns runHi-1..runHi+1; the
  // widening has to stop clear of that with at least one plain 3-wide column
  // between, hence 3. The place shrinks by up to 6 tiles on a short run, which
  // is the right trade: §1.3's 26-42 length is a look, §1.4's cap is the fight.
  const run = grandeRueRunAt(sk.grandeRue, place.x);
  const runLo = (run ? Math.min(run.ax, run.bx) : place.x - (len >> 1)) + JOG_CLEAR;
  const runHi = (run ? Math.max(run.ax, run.bx) : place.x + (len >> 1)) - JOG_CLEAR;
  // …but never so far that the carrefour itself falls outside its own place:
  // land.anchor (objectives[0], the MG42 emplacement) is searched outward from
  // sk.place, and the market island is centred in the returned rect.
  const lo = Math.min(runLo, place.x);
  const hi = Math.max(runHi, place.x);
  const x0 = clamp(place.x - (len >> 1), Math.max(2, lo), w - 3);
  const x1 = clamp(x0 + len - 1, x0, Math.min(w - 3, Math.max(hi, x0)));
  const y0 = clamp(place.y - northShare, 2, h - 3);
  const y1 = clamp(place.y + (width - 1 - northShare), 2, h - 3);

  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (resv[i]) continue; // the churchyard wall bounds the place — correct, and historically so
      road[i] = 1;
    }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ── 3. market infill island ──────────────────────────────────────────────────
//
// p = KindProfile.marketPct/100, 0.6 for the bourg. The highest ratio of
// recognisability to code in the whole document: a terraced island dropped
// off-centre in the widened area splits the place into two lanes, which is what
// every surviving Norman market square looks like.
function reserveMarket(
  sk: Skeleton,
  r4: Rng,
  resv: Uint8Array,
  placeRect: Rect,
): Rect | null {
  const { w, road } = sk;
  const roll = r4.next();
  const iw = 6 + r4.int(6);
  const ih = 5 + r4.int(4);
  const off = 2 + r4.int(5);
  const sign = r4.next() < 0.5 ? -1 : 1;
  if (roll >= sk.profile.marketPct / 100) return null;
  // >= 3 tiles of lane on both flanks, in both axes
  if (ih + 6 > placeRect.h || iw + 6 > placeRect.w) return null;
  const cx = placeRect.x + ((placeRect.w - iw) >> 1) + sign * off;
  const x = clamp(cx, placeRect.x + 3, placeRect.x + placeRect.w - 3 - iw);
  const y = placeRect.y + ((placeRect.h - ih) >> 1);
  // checked in full BEFORE anything is written: a half-reserved island would
  // leave unpaved holes in the place with no structure on them
  for (let yy = y; yy < y + ih; yy++)
    for (let xx = x; xx < x + iw; xx++) if (resv[yy * w + xx] !== RESV.NONE) return null;
  for (let yy = y; yy < y + ih; yy++)
    for (let xx = x; xx < x + iw; xx++) {
      const i = yy * w + xx;
      road[i] = 0; // the island is BUILT on: it must not stay paved
      resv[i] = RESV.MARKET;
    }
  return { x, y, w: iw, h: ih };
}

// ── 4. civic forecourt ───────────────────────────────────────────────────────
//
// A 10x8 set-back parcel on the place for the mairie/école (T7 puts the
// building at the back of it and a walled forecourt in front). Preferred on the
// flank the churchyard does not already occupy.
function reserveForecourt(
  sk: Skeleton,
  r4: Rng,
  resv: Uint8Array,
  placeRect: Rect,
  churchyard: Rect | null,
): Rect | null {
  const { w, h, road } = sk;
  if (sk.profile.forecourtPct < 100 && r4.int(100) >= sk.profile.forecourtPct) return null;
  const fw = 10;
  const fh = 8;
  const jitter = r4.int(9) - 4;
  const prefer = churchyard && churchyard.y < sk.place.y ? 1 : -1;
  const x = clamp(placeRect.x + ((placeRect.w - fw) >> 1) + jitter, 2, w - 2 - fw);
  for (const s of [prefer, -prefer]) {
    const y = s < 0 ? placeRect.y - fh : placeRect.y + placeRect.h;
    if (y < 2 || y + fh > h - 2) continue;
    let free = true;
    for (let yy = y; yy < y + fh && free; yy++)
      for (let xx = x; xx < x + fw && free; xx++) {
        const i = yy * w + xx;
        if (road[i] || resv[i]) free = false;
      }
    if (!free) continue;
    for (let yy = y; yy < y + fh; yy++) for (let xx = x; xx < x + fw; xx++) resv[yy * w + xx] = RESV.CIVIC;
    return { x, y, w: fw, h: fh };
  }
  return null;
}
