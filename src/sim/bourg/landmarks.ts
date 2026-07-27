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
  const len = 26 + r4.int(17);
  const width = 11 + r4.int(7);
  const northShare = 3 + r4.int(width - 5);

  // clipped to the straight run containing the place, so the widening never
  // straddles a jog and come out as two offset rectangles
  const run = grandeRueRunAt(sk.grandeRue, place.x);
  const runLo = run ? Math.min(run.ax, run.bx) : place.x - (len >> 1);
  const runHi = run ? Math.max(run.ax, run.bx) : place.x + (len >> 1);
  const x0 = clamp(place.x - (len >> 1), Math.max(2, runLo), w - 3);
  const x1 = clamp(x0 + len - 1, 2, Math.min(w - 3, runHi));
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
// p 0.6. The highest ratio of recognisability to code in the whole document: a
// terraced island dropped off-centre in the widened area splits the place into
// two lanes, which is what every surviving Norman market square looks like.
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
  if (roll >= 0.6) return null;
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
