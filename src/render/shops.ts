import { EDGE, type GameMap } from '../sim/map';
import type { Building } from '../sim/mapgen';
import { AO_ALPHA, capsulePath, shadowOffsetLegible, sun, sweptRectPath, sweptStrokePath } from './light';
import { hash } from './noise';
import type { Detail } from './terrain';

// Storefront dressing (T21/N3). `role === 'shop'` is 20-25% of a bourg's
// frontage and nothing rendered it: a boulangerie and the house next door were
// the same roof over the same wall, so a high street read as a terrace of
// dwellings and the place had no commerce on it.
//
// All of it is plan-view and lives in the terrain chunk. An awning, a bracket
// sign and a pavement of crates read from directly above and read on all four
// frontages, which is the whole reason the dressing lives out here on the
// pavement rather than on a wall: `roofs.ts` draws no wall face at all now (the
// projected south/east elevations, and the up-sun roof parallax that uncovered
// them, are gone), so a shopfront painted on a wall would be a shopfront the
// player never sees.
//
// Salts 340-359.

type Face = 'n' | 's' | 'e' | 'w';

export interface Shopfront {
  // The frontage line, in world metres, already pushed out clear of the eave
  // the roof layer overhangs the footprint edge by.
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number; // outward unit normal
  ny: number;
  doorAt: number; // metres along a→b of the door centre, or -1
  seed: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Every frontage now clears the same distance, because there is nothing
// asymmetric left to clear. `roofs.ts` blits the roof AT the footprint with a
// 0.35 m OVERHANG on all four sides and projects no wall face on any of them,
// so the drawn eave is 0.35 m out whichever way the shop faces. An awning
// tucked inside that is invisible from directly above — which is exactly what
// the first cut of this looked like — so the frontage line sits a little past
// it. Mirrored rather than imported: terrain must not take a value dependency
// on the roof layer to place a canvas blind.
const EAVE = 0.42;
const AWNING = 1.2; // metres of projection
const SIGN_ARM = 1;
// How high off the pavement each piece hangs. These are the ONLY numbers that
// say "this thing is above the ground" in a strict plan projection, so they
// are real heights fed straight to shadowOffset — not a scaled-down fudge of
// one. A blind and a bracket sign both throw their shape clear into the
// street, which is exactly what an overhead photograph of a high street shows.
const AWNING_H = 2.3;
const SIGN_H = 2.5;
const TRESTLE_H = 0.8;

// Muted awning canvas — sun-bleached ticking, not a beach parasol. The pale
// stripe is the one that sets the value, so it stays well under the roof
// highlights or a row of shops becomes the brightest band in the frame.
const AWNING_PALE = 'rgb(178,170,148)';
const AWNING_TRIM = ['rgb(124,76,58)', 'rgb(86,96,78)', 'rgb(112,100,66)', 'rgb(76,84,96)'];
const SIGN_BOARD = ['rgb(58,52,40)', 'rgb(48,58,52)', 'rgb(66,50,38)'];

const normalOf = (f: Face): [number, number] => (f === 'n' ? [0, -1] : f === 's' ? [0, 1] : f === 'e' ? [1, 0] : [-1, 0]);

export function shopfrontsFor(map: GameMap, buildings: readonly Building[]): Shopfront[] {
  const out: Shopfront[] = [];
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.role !== 'shop' || !b.frontage) continue;
    const f = b.frontage;
    const [nx, ny] = normalOf(f);
    const along = f === 'n' || f === 's' ? b.w : b.h;
    if (along < 2.5) continue;
    const u0 = (f === 'n' || f === 's' ? b.x : b.y) + 0.25;
    const u1 = u0 + along - 0.5;
    // the footprint edge, pushed out past the eave
    const horizontal = f === 'n' || f === 's';
    const base = f === 'n' ? b.y : f === 's' ? b.y + b.h : f === 'e' ? b.x + b.w : b.x;
    const t = base + (horizontal ? ny : nx) * EAVE;
    const ax = horizontal ? u0 : t;
    const ay = horizontal ? t : u0;
    const bx = horizontal ? u1 : t;
    const by = horizontal ? t : u1;
    // where the door is, so the awning and the clutter arrange around it
    let doorAt = -1;
    for (const dr of b.doors ?? []) {
      if (dr.side !== f) continue;
      doorAt = (horizontal ? dr.x + dr.width / 2 : dr.y + dr.width / 2) - u0;
      break;
    }
    if (doorAt < 0) {
      // legacy/unlabelled: read the DOOR edge straight off the map
      for (let k = 0; k < Math.ceil(along); k++) {
        const cx = (horizontal ? b.x + k : b.x + (f === 'e' ? b.w - 1 : 0)) | 0;
        const cy = (horizontal ? b.y + (f === 's' ? b.h - 1 : 0) : b.y + k) | 0;
        const e = horizontal ? map.hEdge(cx, f === 's' ? cy + 1 : cy) : map.vEdge(f === 'e' ? cx + 1 : cx, cy);
        if (e === EDGE.DOOR) {
          doorAt = (horizontal ? cx + 0.5 : cy + 0.5) - u0;
          break;
        }
      }
    }
    const pad = AWNING + SIGN_ARM + 1.6;
    out.push({
      ax,
      ay,
      bx,
      by,
      nx,
      ny,
      doorAt,
      seed: (hash(b.x, b.y, 340) * 65536) | 0,
      minX: Math.min(ax, bx) - pad,
      minY: Math.min(ay, by) - pad,
      maxX: Math.max(ax, bx) + pad,
      maxY: Math.max(ay, by) + pad,
    });
  }
  return out;
}

type Ctx = CanvasRenderingContext2D;

export function drawShopfronts(g: Ctx, fronts: Shopfront[], tx0: number, ty0: number, tx1: number, ty1: number, d: Detail): void {
  for (const s of fronts) {
    if (s.maxX < tx0 || s.minX > tx1 || s.maxY < ty0 || s.minY > ty1) continue;
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
    if (len <= 0) continue;
    const ux = (s.bx - s.ax) / len;
    const uy = (s.by - s.ay) / len;
    // Not every shop is canopied. Six frontages in a row all under stripes
    // reads as a fairground, and the ones without still say "shop" through the
    // bracket sign and the goods stacked outside.
    const up = hash(s.seed, 5, 341) < 0.74;
    const span = Math.min(3.6 + hash(s.seed, 6, 341) * 1.4, len);
    const mid = s.doorAt >= 0 ? Math.max(span / 2, Math.min(len - span / 2, s.doorAt)) : len / 2;
    const aw0 = up ? mid - span / 2 : 0;
    const aw1 = up ? mid + span / 2 : -1;
    if (up) awning(g, s, ux, uy, aw0, aw1, d);
    if (d >= 1) sign(g, s, ux, uy, len);
    // last, so nothing is stacked under a canvas that would hide it from
    // directly above — see the placement rule in `apron`
    apron(g, s, ux, uy, len, aw0, aw1, d);
  }
}

// A world-space quad from frontage coordinates: `u` along the wall from a,
// `v` outward along the normal.
const qx = (s: Shopfront, ux: number, u: number, v: number): number => s.ax + ux * u + s.nx * v;
const qy = (s: Shopfront, uy: number, u: number, v: number): number => s.ay + uy * u + s.ny * v;

function awning(g: Ctx, s: Shopfront, ux: number, uy: number, u0: number, u1: number, d: Detail): void {
  const span = u1 - u0;
  const [sdx, sdy] = shadowOffsetLegible(AWNING_H);
  const quad = (a: number, b: number, v0: number, v1: number, odx = 0, ody = 0): void => {
    g.beginPath();
    g.moveTo(qx(s, ux, a, v0) + odx, qy(s, uy, a, v0) + ody);
    g.lineTo(qx(s, ux, b, v0) + odx, qy(s, uy, b, v0) + ody);
    g.lineTo(qx(s, ux, b, v1) + odx, qy(s, uy, b, v1) + ody);
    g.lineTo(qx(s, ux, a, v1) + odx, qy(s, uy, a, v1) + ody);
    g.closePath();
    g.fill();
  };
  // Swept from the frontage line, not a translated copy: the canvas hangs on
  // this wall, so its shade leaves the wall base — a copy of the quad 7 m out
  // in the street is what dawn used to draw. Alpha rides the sun's ramp.
  g.fillStyle = `rgba(10,12,8,${(AO_ALPHA * 0.75 * sun().alphaMul).toFixed(3)})`;
  {
    const cs = [
      [qx(s, ux, u0, 0), qy(s, uy, u0, 0)],
      [qx(s, ux, u1, 0), qy(s, uy, u1, 0)],
      [qx(s, ux, u1, AWNING), qy(s, uy, u1, AWNING)],
      [qx(s, ux, u0, AWNING), qy(s, uy, u0, AWNING)],
    ];
    const x0 = Math.min(cs[0][0], cs[1][0], cs[2][0], cs[3][0]);
    const y0 = Math.min(cs[0][1], cs[1][1], cs[2][1], cs[3][1]);
    const x1 = Math.max(cs[0][0], cs[1][0], cs[2][0], cs[3][0]);
    const y1 = Math.max(cs[0][1], cs[1][1], cs[2][1], cs[3][1]);
    g.beginPath();
    sweptRectPath(g, x0, y0, x1 - x0, y1 - y0, sdx, sdy);
    g.fill();
  }
  // Striped canvas: the stripes run OUT from the wall, which is what an awning
  // does and also what tells the eye which way the shop faces.
  const trim = AWNING_TRIM[(hash(s.seed, 0, 341) * AWNING_TRIM.length) | 0];
  const stripe = 0.4;
  const n = Math.max(2, Math.round(span / stripe));
  for (let i = 0; i < n; i++) {
    g.fillStyle = i & 1 ? trim : AWNING_PALE;
    quad(u0 + (span * i) / n, u0 + (span * (i + 1)) / n, 0.04, AWNING);
  }
  // lit crown where the canvas leaves the wall, shade in the fall
  g.fillStyle = 'rgba(255,250,236,0.14)';
  quad(u0, u1, 0.04, 0.3);
  g.fillStyle = 'rgba(20,22,16,0.20)';
  quad(u0, u1, AWNING - 0.26, AWNING);
  // scalloped valance at the outer lip
  g.fillStyle = 'rgba(38,32,24,0.55)';
  quad(u0, u1, AWNING - 0.07, AWNING);
  if (d < 2) return;
  g.fillStyle = trim;
  const m = Math.max(2, Math.round(span / 0.34));
  for (let i = 0; i < m; i++) {
    const cu = u0 + (span * (i + 0.5)) / m;
    g.beginPath();
    g.arc(qx(s, ux, cu, AWNING - 0.02), qy(s, uy, cu, AWNING - 0.02), 0.085, 0, Math.PI * 2);
    g.fill();
  }
}

// Bracket and hanging board — the strongest "this is a trade premises" cue
// available from directly overhead, because nothing else in the town projects
// a rigid arm out over the pavement.
function sign(g: Ctx, s: Shopfront, ux: number, uy: number, len: number): void {
  const end = hash(s.seed, 1, 342) > 0.5;
  const u = end ? Math.min(len - 0.5, len - 0.7) : 0.7;
  const [sdx, sdy] = shadowOffsetLegible(SIGN_H);
  const bx = qx(s, ux, u, SIGN_ARM);
  const by = qy(s, uy, u, SIGN_ARM);
  g.strokeStyle = `rgba(12,14,9,${(0.26 * sun().alphaMul).toFixed(3)})`;
  g.lineWidth = 0.09;
  g.beginPath();
  g.moveTo(qx(s, ux, u, 0.05) + sdx, qy(s, uy, u, 0.05) + sdy);
  g.lineTo(bx + sdx, by + sdy);
  g.stroke();
  g.strokeStyle = 'rgb(52,46,38)';
  g.lineWidth = 0.075;
  g.beginPath();
  g.moveTo(qx(s, ux, u, 0.05), qy(s, uy, u, 0.05));
  g.lineTo(bx, by);
  g.stroke();
  const bw = 0.62;
  const bh = 0.42;
  const board = (cx: number, cy: number, fill: string): void => {
    g.save();
    g.translate(cx, cy);
    g.rotate(Math.atan2(uy, ux));
    g.fillStyle = fill;
    g.fillRect(-bw / 2, -bh / 2, bw, bh);
    g.restore();
  };
  board(bx + sdx, by + sdy, `rgba(10,12,8,${(0.32 * sun().alphaMul).toFixed(3)})`);
  board(bx, by, SIGN_BOARD[(hash(s.seed, 2, 342) * SIGN_BOARD.length) | 0]);
  g.save();
  g.translate(bx, by);
  g.rotate(Math.atan2(uy, ux));
  g.strokeStyle = 'rgba(206,190,150,0.55)';
  g.lineWidth = 0.035;
  g.strokeRect(-bw / 2 + 0.05, -bh / 2 + 0.05, bw - 0.1, bh - 0.1);
  g.restore();
}

// Stall clutter on the pavement: crates, a barrel, sacks, and on half the
// shops a trestle with produce on it.
//
// Placement rule, and it is the whole reason this reads at all: from directly
// overhead an awning HIDES what is under it, so an item whose position falls
// inside the canvas's span has to stand out past its lip instead of against
// the wall. Goods beside the door, stall in front of it — which is also where
// a real shopkeeper put them.
function apron(g: Ctx, s: Shopfront, ux: number, uy: number, len: number, aw0: number, aw1: number, d: Detail): void {
  const [sdx, sdy] = shadowOffsetLegible(0.55);
  const am = sun().alphaMul;
  const n = 2 + ((hash(s.seed, 3, 343) * 3) | 0);
  for (let i = 0; i < n; i++) {
    const k = s.seed * 11 + i;
    const u = 0.45 + hash(k, 0, 344) * Math.max(0.1, len - 0.9);
    // never in the doorway itself — a crate across the threshold reads as a
    // blocked shop, and the door-wear trail is drawn right there
    if (s.doorAt >= 0 && Math.abs(u - s.doorAt) < 0.85) continue;
    const v = u > aw0 && u < aw1 ? AWNING + 0.2 + hash(k, 1, 344) * 0.45 : 0.28 + hash(k, 1, 344) * 0.62;
    const cx = qx(s, ux, u, v);
    const cy = qy(s, uy, u, v);
    const kind = hash(k, 2, 344);
    if (kind < 0.42) {
      const w = 0.44 + hash(k, 3, 345) * 0.2;
      const rot = Math.atan2(uy, ux) + (hash(k, 4, 345) - 0.5) * 0.5;
      // the one sun, rotated into crate space (the old code rotated the
      // OFFSET with the crate, then translated the whole silhouette)
      const ldx = sdx * Math.cos(rot) + sdy * Math.sin(rot);
      const ldy = -sdx * Math.sin(rot) + sdy * Math.cos(rot);
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      g.fillStyle = `rgba(12,14,9,${(0.3 * am).toFixed(3)})`;
      g.beginPath();
      sweptRectPath(g, -w / 2, -w / 2, w, w, ldx, ldy);
      g.fill();
      g.fillStyle = 'rgb(126,102,68)';
      g.fillRect(-w / 2, -w / 2, w, w);
      g.fillStyle = 'rgba(206,182,132,0.30)';
      g.fillRect(-w / 2, -w / 2, w, w * 0.22);
      if (d >= 2) {
        g.strokeStyle = 'rgba(58,44,26,0.55)';
        g.lineWidth = 0.035;
        g.strokeRect(-w / 2, -w / 2, w, w);
        g.beginPath();
        g.moveTo(-w / 2, 0);
        g.lineTo(w / 2, 0);
        g.stroke();
      }
      g.restore();
    } else if (kind < 0.72) {
      const r = 0.24 + hash(k, 3, 345) * 0.07;
      g.fillStyle = `rgba(12,14,9,${(0.3 * am).toFixed(3)})`;
      g.beginPath();
      capsulePath(g, cx, cy, cx + sdx, cy + sdy, r);
      g.fill();
      g.fillStyle = 'rgb(104,78,50)';
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(168,150,110,0.45)';
      g.lineWidth = 0.045;
      g.beginPath();
      g.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(226,214,186,0.20)';
      g.beginPath();
      g.arc(cx - r * 0.28, cy - r * 0.3, r * 0.4, 0, Math.PI * 2);
      g.fill();
    } else {
      // sacks, leaning against the wall
      for (let j = 0; j < 2; j++) {
        const ox = cx + ux * j * 0.34;
        const oy = cy + uy * j * 0.34;
        g.fillStyle = `rgba(12,14,9,${(0.26 * am).toFixed(3)})`;
        g.beginPath();
        capsulePath(g, ox, oy, ox + sdx, oy + sdy, 0.24);
        g.fill();
        g.fillStyle = j ? 'rgb(158,146,116)' : 'rgb(142,131,104)';
        g.beginPath();
        g.ellipse(ox, oy, 0.2, 0.26, hash(k, j, 346) * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  if (d < 2 || hash(s.seed, 4, 347) > 0.55) return;
  // trestle stall: a board on two Xs, with produce heaped on it
  const [tdx, tdy] = shadowOffsetLegible(TRESTLE_H);
  const su = Math.max(0.9, Math.min(len - 0.9, s.doorAt >= 0 ? s.doorAt + 1.7 : len * 0.65));
  const half = 0.85;
  const v = AWNING + 0.42;
  const a0 = su - half;
  const a1 = su + half;
  g.fillStyle = `rgba(12,14,9,${(0.28 * sun().alphaMul).toFixed(3)})`;
  g.beginPath();
  sweptStrokePath(g, qx(s, ux, a0, v), qy(s, uy, a0, v), qx(s, ux, a1, v), qy(s, uy, a1, v), 0.5, tdx, tdy);
  g.fill();
  g.strokeStyle = 'rgb(134,112,78)';
  g.lineWidth = 0.46;
  g.beginPath();
  g.moveTo(qx(s, ux, a0, v), qy(s, uy, a0, v));
  g.lineTo(qx(s, ux, a1, v), qy(s, uy, a1, v));
  g.stroke();
  g.strokeStyle = 'rgba(216,196,152,0.28)';
  g.lineWidth = 0.06;
  g.beginPath();
  g.moveTo(qx(s, ux, a0, v - 0.19), qy(s, uy, a0, v - 0.19));
  g.lineTo(qx(s, ux, a1, v - 0.19), qy(s, uy, a1, v - 0.19));
  g.stroke();
  for (let i = 0; i < 7; i++) {
    const k = s.seed * 19 + i;
    const pu = a0 + hash(k, 0, 348) * (a1 - a0);
    const pv = v + (hash(k, 1, 348) - 0.5) * 0.26;
    g.fillStyle = hash(k, 2, 348) > 0.5 ? '#7d6a30' : '#8a4a34';
    g.beginPath();
    g.arc(qx(s, ux, pu, pv), qy(s, uy, pu, pv), 0.075 + hash(k, 3, 348) * 0.04, 0, Math.PI * 2);
    g.fill();
  }
}
