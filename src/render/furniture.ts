// Interior furnishing art (interiors design R2/R3, tasks I13/I15).
//
// STRICT PLAN PROJECTION. Nothing here is drawn in elevation: a table is its
// top, four leg dots peeking out at the SE, and a contact shadow; a bed is a
// headboard line and a blanket rectangle. The only verticality is the shared
// one-sun cast shadow (light.ts SUN) and the NW-lit / SE-dark edge pair on the
// piece's own silhouette.
//
// The sim→render interface is the terrain key alone (interiors design D3):
// `furn_heavy`, `furn_light`, `hearth`, `altar`. What KIND of heavy piece a
// tile is — pew, counter, table, dresser, bed, manger — is re-derived here from
// three things that are already on the map: the building's role, the tile's
// same-key orthogonal neighbours (which give the run axis and whether the piece
// is a run or a block), and which of the tile's four edges is a wall. No new
// sim data, no room semantics.
//
// Everything is baked per (piece, neighbour mask, orientation, variant, band)
// through stamps.ts, so a chunk pays one drawImage per furniture tile. The bake
// box is 1.5 m for a 1 m tile: the 0.25 m collar is where the cast shadow and
// the fused edges of a multi-tile piece live. 1.5 and 0.25 are both integral in
// pixels at every band (4/8/16/32/48), so the blit never resamples.

import { EDGE, type GameMap } from '../sim/map';
import type { Building, BuildingRole } from '../sim/mapgen';
import { MAP_N, SHADOW_ALPHA, SHADOW_SOFT_ALPHA } from './light';
import { hash } from './noise';
import { stamp } from './stamps';

type Ctx = CanvasRenderingContext2D;
type RGB = [number, number, number];

const tone = (c: RGB, f: number): string => `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`;

// ── Building roles as a tile-indexable code ────────────────────────────────
// Legacy maps carry no roles, so every id resolves to OTHER and every
// role-dependent branch below takes its house/plank default — the pre-interiors
// rendering, byte for byte.
export const ROLE = { OTHER: 0, TOWNHOUSE: 1, SHOP: 2, FARMHOUSE: 3, BARN: 4, CIVIC: 5, HALLE: 6, CHURCH: 7, HALT: 8 } as const;

const ROLE_CODE: Record<BuildingRole, number> = {
  house: ROLE.OTHER,
  townhouse: ROLE.TOWNHOUSE,
  shop: ROLE.SHOP,
  bakery: ROLE.SHOP, // a trade's floor is a shop floor; the oven is what differs
  forge: ROLE.SHOP,
  farmhouse: ROLE.FARMHOUSE,
  barn: ROLE.BARN,
  civic: ROLE.CIVIC,
  halle: ROLE.HALLE,
  church: ROLE.CHURCH,
  church_tower: ROLE.CHURCH,
  church_apse: ROLE.CHURCH,
  halt: ROLE.HALT,
};

export interface BuildingIndex {
  /** ROLE code per buildingId */
  role: Uint8Array;
  /**
   * The building's ACROSS axis per buildingId — 0 = world x, 1 = world y — the
   * same frame the generator partitions in (`across` is parallel to the
   * frontage wall, `deep` runs into the building). A pew block is a solid
   * rectangle of furniture, so nothing local to a tile can tell its rows from
   * its columns; the frontage can, and it is already on the Building.
   */
  across: Uint8Array;
}

// Both arrays are indexed by buildingId, so a lookup is one Int16Array read
// plus one Uint8Array read. Sized from the largest id actually stamped on the
// map rather than from buildings.length: a church group shares one id across
// three Building rows.
export function buildingIndex(map: GameMap, buildings: readonly Building[]): BuildingIndex {
  let maxId = -1;
  for (let i = 0; i < map.buildingId.length; i++) if (map.buildingId[i] > maxId) maxId = map.buildingId[i];
  const role = new Uint8Array(maxId + 2);
  const across = new Uint8Array(maxId + 2);
  // A church's nave, tower and apse are three Building rows sharing ONE
  // buildingId (mapgen groupId), and they do not agree about frontage. Last
  // writer wins would hand the whole group the apse's axis and turn every pew
  // 90 degrees; the biggest mass in the group is the one that owns the frame.
  const claim = new Int32Array(maxId + 2);
  for (const b of buildings) {
    const code = ROLE_CODE[b.role ?? 'house'] ?? ROLE.OTHER;
    // no frontage (legacy, or a mass that never faced a street) → the long side
    const ax = b.frontage === undefined ? (b.w >= b.h ? 0 : 1) : b.frontage === 'n' || b.frontage === 's' ? 0 : 1;
    const area = b.w * b.h;
    for (const p of b.parts ?? [b]) {
      for (let y = Math.max(0, p.y); y < Math.min(map.h, p.y + p.h); y++) {
        for (let x = Math.max(0, p.x); x < Math.min(map.w, p.x + p.w); x++) {
          const id = map.buildingId[y * map.w + x];
          if (id < 0 || area < claim[id]) continue;
          claim[id] = area;
          role[id] = code;
          across[id] = ax;
        }
      }
    }
  }
  return { role, across };
}

// ── Palette ────────────────────────────────────────────────────────────────
// All under the muted ceiling and all DARKER than the plank/flag floors they
// sit on, which is what makes a piece read as an object rather than a stain.
const WOOD: RGB = [106, 83, 58]; // TERRAIN.furn_heavy
const WOOD_PALE: RGB = [125, 102, 71]; // TERRAIN.furn_light — chairs, crates
const OAK: RGB = [84, 65, 46]; // dresser / wardrobe / pew back — the dark end
const STONE_HEARTH: RGB = [81, 71, 64];
const STONE_ALTAR: RGB = [150, 140, 122]; // warmer than the nave's cold flags on purpose
const BLANKET: RGB = [104, 96, 84];
const STRAW_C: RGB = [156, 138, 92];

const PAD = 0.25; // collar around the 1 m tile inside the bake box
const BOX = 1 + PAD * 2;
// Contact shade, not a full-height cast — and deliberately NOT the moving sun:
// furniture stands under a roof, so its 0.18 m drop is ambient-interior
// styling fixed at the house direction, the same rule as AO_ALPHA. That is
// what keeps the furn:* stamps sun-independent (no step in their key) and an
// interior identical at noon and at midnight until the grade dims it.
const SDX = MAP_N.dx * 0.18;
const SDY = MAP_N.dy * 0.18;

// neighbour / wall bitmask
const N = 1;
const S = 2;
const W = 4;
const E = 8;

const PIECE = {
  TABLE: 0,
  BENCH: 1,
  COUNTER: 2,
  CHEST: 3,
  BED: 4,
  MANGER: 5,
  ALTAR: 6,
  HEARTH: 7,
  CRATE: 8,
  BARREL: 9,
  CHAIR: 10,
  STRAW: 11,
} as const;

// ── Shared plan-view primitives ────────────────────────────────────────────

// The SE contact shadow. Drawn before the body, so only the sliver that clears
// the silhouette survives — which is exactly what says "this sits above the
// floor" without drawing a single side face.
function dropShadow(g: Ctx, x0: number, y0: number, x1: number, y1: number): void {
  g.fillStyle = `rgba(14,11,8,${SHADOW_SOFT_ALPHA})`;
  g.fillRect(x0 + SDX * 1.7 - 0.03, y0 + SDY * 1.7 - 0.03, x1 - x0 + 0.06, y1 - y0 + 0.06);
  g.fillStyle = `rgba(14,11,8,${SHADOW_ALPHA})`;
  g.fillRect(x0 + SDX, y0 + SDY, x1 - x0, y1 - y0);
}

// One sun on the silhouette: a lit lip on the N and W faces, a dark one on S
// and E. Suppressed on any face where the same piece continues into the next
// tile, so a pew run or a counter reads as one object and not as a row of
// bricks.
function sunEdges(g: Ctx, x0: number, y0: number, x1: number, y1: number, free: number, lit = 0.20, dk = 0.26): void {
  const t = 0.05;
  g.fillStyle = `rgba(240,232,208,${lit})`;
  if (free & N) g.fillRect(x0, y0, x1 - x0, t);
  if (free & W) g.fillRect(x0, y0, t, y1 - y0);
  g.fillStyle = `rgba(18,14,10,${dk})`;
  if (free & S) g.fillRect(x0, y1 - t, x1 - x0, t);
  if (free & E) g.fillRect(x1 - t, y0, t, y1 - y0);
}

// The (u, t) frame a run-shaped piece is authored in: u runs ALONG the piece,
// t across it. `axis` picks which world axis u is; `flip` mirrors t (a counter
// whose front faces north instead of south); `rev` mirrors u (a bed whose head
// is at the far end). Every transform is axis-aligned, so nothing resamples and
// the world bbox is still a rectangle.
interface Frame {
  pt(u: number, t: number): [number, number];
  rect(u0: number, t0: number, u1: number, t1: number): [number, number, number, number];
  fill(u0: number, t0: number, u1: number, t1: number): void;
}

function frameOf(g: Ctx, axis: number, flip: boolean, rev: boolean): Frame {
  const pt = (u: number, t: number): [number, number] => {
    const uu = rev ? 1 - u : u;
    const tt = flip ? 1 - t : t;
    return axis === 0 ? [uu, tt] : [tt, uu];
  };
  const rect = (u0: number, t0: number, u1: number, t1: number): [number, number, number, number] => {
    const [ax, ay] = pt(u0, t0);
    const [bx, by] = pt(u1, t1);
    return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
  };
  return {
    pt,
    rect,
    fill(u0, t0, u1, t1) {
      const [x, y, w, h] = rect(u0, t0, u1, t1);
      g.fillRect(x, y, w, h);
    },
  };
}

// Wood grain along the run: a couple of hairline joints plus a value wobble, so
// a 3-tile counter is three planks and not one flat swatch.
function grain(g: Ctx, f: Frame, u0: number, t0: number, u1: number, t1: number, v: number, n: number): void {
  for (let i = 1; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / n + (hash(v, i, 402) - 0.5) * 0.02;
    g.fillStyle = `rgba(30,22,14,${(0.14 + hash(v, i, 403) * 0.1).toFixed(3)})`;
    f.fill(u0, t, u1, t + 0.022);
  }
}

// ── The pieces ─────────────────────────────────────────────────────────────

interface Shape {
  /** run extent, in the u direction, after fusing with same-key neighbours */
  u0: number;
  u1: number;
  /** this tile carries the low-u / high-u END of the run */
  endLo: boolean;
  endHi: boolean;
  /** which world faces are free (no same-key neighbour) */
  free: number;
}

function drawTable(g: Ctx, f: Frame, s: Shape, mask: number, v: number, d: number): void {
  // Legs first and OUTSIDE the top, then the top offset NW over them: the four
  // dark dots peek out at the SE corners and the slab appears to float. That
  // one offset is the whole table.
  const t0 = mask & N ? -0.04 : 0.14;
  const t1 = mask & S ? 1.04 : 0.86;
  const [bx, by, bw, bh] = f.rect(s.u0, t0, s.u1, t1);
  dropShadow(g, bx, by, bx + bw, by + bh);
  if (d >= 1) {
    g.fillStyle = 'rgba(26,20,14,0.55)';
    const lg = 0.075;
    for (let c = 0; c < 4; c++) {
      const cx = c & 1 ? bx + bw - lg : bx;
      const cy = c & 2 ? by + bh - lg : by;
      // only the corners of the whole mass carry legs
      if ((c & 1 ? !(s.free & E) : !(s.free & W)) || (c & 2 ? !(s.free & S) : !(s.free & N))) continue;
      g.fillRect(cx + 0.02, cy + 0.02, lg, lg);
    }
  }
  g.fillStyle = tone(WOOD, 1.1 + hash(v, 0, 400) * 0.12);
  g.fillRect(bx - 0.025, by - 0.03, bw, bh);
  if (d >= 1) grain(g, f, s.u0, t0, s.u1, t1, v, 3);
  sunEdges(g, bx - 0.025, by - 0.03, bx + bw - 0.025, by + bh - 0.03, s.free);
}

// A pew: seat plank, a darker back rail along one long side, and an end
// standard wherever the row stops. The back is always on the low-t side of the
// frame (north for an E–W row, west for a N–S one), so every pew in a nave
// faces the same way without the renderer having to find the chancel.
function drawBench(g: Ctx, f: Frame, s: Shape, v: number, d: number): void {
  const [bx, by, bw, bh] = f.rect(s.u0, 0.17, s.u1, 0.79);
  dropShadow(g, bx, by, bx + bw, by + bh);
  g.fillStyle = tone(OAK, 0.80); // back rail — the darkest bar, and the tell
  f.fill(s.u0, 0.17, s.u1, 0.31);
  g.fillStyle = 'rgba(24,18,12,0.42)'; // the shaded well between back and seat
  f.fill(s.u0, 0.31, s.u1, 0.365);
  g.fillStyle = tone(WOOD, 1.22 + hash(v, 1, 404) * 0.1); // seat, the lit plank
  f.fill(s.u0, 0.365, s.u1, 0.74);
  g.fillStyle = 'rgba(240,232,208,0.22)';
  f.fill(s.u0, 0.365, s.u1, 0.40);
  if (d >= 1) {
    g.fillStyle = tone(OAK, 0.72);
    if (s.endLo) f.fill(s.u0, 0.17, s.u0 + 0.10, 0.79); // end standard
    if (s.endHi) f.fill(s.u1 - 0.10, 0.17, s.u1, 0.79);
    g.fillStyle = 'rgba(28,20,12,0.22)'; // seat boards
    f.fill(s.u0, 0.55, s.u1, 0.575);
  }
  sunEdges(g, bx, by, bx + bw, by + bh, s.free, 0.16, 0.34);
}

// Shop counter: a deep slab with a bullnose on the customer side. The gap the
// generator leaves in the run (interiors §4.3) is a plain floor tile, so the
// run simply stops there and the two ends get their own lit lip.
function drawCounter(g: Ctx, f: Frame, s: Shape, v: number, d: number): void {
  const [bx, by, bw, bh] = f.rect(s.u0, 0.11, s.u1, 0.89);
  dropShadow(g, bx, by, bx + bw, by + bh);
  // Kept dark: a shop's quarry-tile floor is the same warm family as bare wood,
  // and a mid-tone counter simply vanished into it.
  g.fillStyle = tone(WOOD, 0.92 + hash(v, 0, 405) * 0.1);
  f.fill(s.u0, 0.11, s.u1, 0.89);
  g.fillStyle = tone(OAK, 0.74);
  f.fill(s.u0, 0.78, s.u1, 0.89); // bullnose front rail
  g.fillStyle = 'rgba(240,232,208,0.16)';
  f.fill(s.u0, 0.78, s.u1, 0.805);
  if (d >= 1) grain(g, f, s.u0, 0.13, s.u1, 0.76, v, 3);
  sunEdges(g, bx, by, bx + bw, by + bh, s.free);
}

// Dresser, wardrobe, shelving, vestment press: one wall-hugging dark slab.
// D1's consequence made visible — the same tile is the dresser downstairs and
// the wardrobe upstairs, so it is authored as the piece that is true on both.
function drawChest(g: Ctx, f: Frame, s: Shape, v: number, d: number): void {
  const [bx, by, bw, bh] = f.rect(s.u0, 0.06, s.u1, 0.60);
  dropShadow(g, bx, by, bx + bw, by + bh);
  g.fillStyle = tone(OAK, 1.04 + hash(v, 0, 406) * 0.12);
  f.fill(s.u0, 0.06, s.u1, 0.60);
  if (d >= 1) {
    if (hash(v, 1, 406) < 0.5) {
      g.fillStyle = 'rgba(24,18,12,0.34)'; // drawer courses
      f.fill(s.u0 + 0.05, 0.26, s.u1 - 0.05, 0.285);
      f.fill(s.u0 + 0.05, 0.43, s.u1 - 0.05, 0.455);
      g.fillStyle = 'rgba(206,192,160,0.30)';
      const [kx, ky] = f.pt((s.u0 + s.u1) / 2, 0.35);
      g.fillRect(kx - 0.035, ky - 0.03, 0.07, 0.06);
    } else {
      g.fillStyle = 'rgba(24,18,12,0.34)'; // two press doors
      f.fill((s.u0 + s.u1) / 2 - 0.012, 0.09, (s.u0 + s.u1) / 2 + 0.012, 0.57);
      g.fillStyle = 'rgba(240,232,208,0.09)';
      f.fill(s.u0 + 0.07, 0.12, (s.u0 + s.u1) / 2 - 0.05, 0.54);
    }
  }
  sunEdges(g, bx, by, bx + bw, by + bh, s.free, 0.22, 0.3);
}

// Bed: headboard line + blanket rectangle + pillow. Plan view, no bedstead.
function drawBed(g: Ctx, f: Frame, s: Shape, v: number, d: number): void {
  const [bx, by, bw, bh] = f.rect(s.u0, 0.14, s.u1, 0.86);
  dropShadow(g, bx, by, bx + bw, by + bh);
  g.fillStyle = tone(BLANKET, 1.0 + hash(v, 0, 407) * 0.12);
  f.fill(s.u0, 0.14, s.u1, 0.86);
  const head = s.endLo; // the frame put the walled end of the run at low u
  if (head) {
    g.fillStyle = tone(OAK, 0.95);
    f.fill(s.u0, 0.10, s.u0 + 0.10, 0.90); // headboard
    if (d >= 1) {
      g.fillStyle = 'rgba(226,220,204,0.55)';
      f.fill(s.u0 + 0.14, 0.22, s.u0 + 0.40, 0.78); // pillow
    }
  }
  if (d >= 1) {
    g.fillStyle = 'rgba(226,220,204,0.22)'; // turned-down sheet
    const uf = head ? s.u0 + 0.48 : s.u0 + 0.1;
    f.fill(uf, 0.14, uf + 0.05, 0.86);
    g.fillStyle = 'rgba(24,20,16,0.14)';
    f.fill(uf + 0.05, 0.14, uf + 0.075, 0.86);
  }
  sunEdges(g, bx, by, bx + bw, by + bh, s.free, 0.16, 0.22);
}

// Barn manger: a trough, straw in it. Wall-hugging like the chest but open.
function drawManger(g: Ctx, f: Frame, s: Shape, v: number, d: number): void {
  const [bx, by, bw, bh] = f.rect(s.u0, 0.08, s.u1, 0.62);
  dropShadow(g, bx, by, bx + bw, by + bh);
  g.fillStyle = tone(OAK, 1.0);
  f.fill(s.u0, 0.08, s.u1, 0.62);
  g.fillStyle = 'rgba(20,16,11,0.55)';
  f.fill(s.u0 + 0.04, 0.16, s.u1 - 0.04, 0.54);
  if (d >= 1) {
    for (let i = 0; i < 5; i++) {
      const u = s.u0 + 0.08 + hash(v * 7 + i, 0, 408) * Math.max(0.05, s.u1 - s.u0 - 0.16);
      const t = 0.2 + hash(v * 7 + i, 1, 408) * 0.3;
      g.fillStyle = tone(STRAW_C, 0.8 + hash(v * 7 + i, 2, 408) * 0.4);
      f.fill(u, t, u + 0.16, t + 0.03);
    }
  }
  sunEdges(g, bx, by, bx + bw, by + bh, s.free, 0.2, 0.28);
}

// Altar: pale stone mensa under a cloth, two candlesticks. The one warm-pale
// object in a church whose floor is cold grey flags, which is what makes the
// chancel the thing the eye lands on.
function drawAltar(g: Ctx, f: Frame, s: Shape, v: number, d: number): void {
  const [bx, by, bw, bh] = f.rect(s.u0, 0.10, s.u1, 0.90);
  dropShadow(g, bx, by, bx + bw, by + bh);
  g.fillStyle = tone(STONE_ALTAR, 0.68); // predella — one step up to the mensa
  f.fill(s.u0, 0.10, s.u1, 0.90);
  g.fillStyle = tone(STONE_ALTAR, 1.0 + hash(v, 0, 409) * 0.08);
  f.fill(s.u0, 0.16, s.u1, 0.84);
  g.fillStyle = 'rgba(232,226,208,0.50)';
  f.fill(s.u0 + 0.06, 0.30, s.u1 - 0.06, 0.78); // frontal cloth
  if (d >= 1) {
    g.fillStyle = 'rgba(120,104,80,0.22)';
    f.fill(s.u0 + 0.06, 0.62, s.u1 - 0.06, 0.65); // cloth fold
    g.fillStyle = 'rgba(64,54,40,0.55)';
    const [cx, cy] = f.pt((s.u0 + s.u1) / 2, 0.22);
    g.fillRect(cx - 0.022, cy - 0.05, 0.044, 0.13); // cross, plan view = a tick
    g.fillRect(cx - 0.06, cy - 0.015, 0.12, 0.035);
  }
  if (d >= 2) {
    for (const u of [s.u0 + 0.18, s.u1 - 0.18]) {
      const [px, py] = f.pt(u, 0.24);
      g.fillStyle = 'rgba(48,40,30,0.7)';
      g.beginPath();
      g.arc(px, py, 0.045, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(236,226,196,0.85)';
      g.beginPath();
      g.arc(px - 0.012, py - 0.014, 0.024, 0, Math.PI * 2);
      g.fill();
    }
  }
  sunEdges(g, bx, by, bx + bw, by + bh, s.free, 0.24, 0.22);
}

// Hearth: the chimney breast in plan — coursed masonry filling the tile, with a
// firebox opening on the room side. The ember dots here are cold; the living
// flicker is a frame-loop pass (drawHearthGlow), because a baked one cannot
// flicker and a per-frame bake would cost a chunk rebake every frame.
function drawHearth(g: Ctx, f: Frame, v: number, d: number): void {
  g.fillStyle = tone(STONE_HEARTH, 1.06);
  g.fillRect(0, 0, 1, 1);
  if (d >= 1) {
    for (let c = 0; c < 3; c++) {
      const t = 0.06 + c * 0.3;
      g.fillStyle = 'rgba(22,18,15,0.35)';
      f.fill(0, t, 1, t + 0.028);
      for (let i = 0; i < 2; i++) {
        const u = 0.2 + i * 0.4 + (c % 2) * 0.2;
        g.fillStyle = 'rgba(22,18,15,0.28)';
        f.fill(u, t, u + 0.026, t + 0.3);
      }
    }
    g.fillStyle = `rgba(200,192,178,${(0.08 + hash(v, 0, 410) * 0.06).toFixed(3)})`;
    f.fill(0, 0.02, 1, 0.07);
  }
  // firebox, on the far side from the wall (which the frame put at low t)
  g.fillStyle = 'rgba(20,16,13,0.92)';
  f.fill(0.16, 0.44, 0.84, 0.95);
  g.fillStyle = 'rgba(38,32,26,0.9)';
  f.fill(0.16, 0.40, 0.84, 0.46); // lintel
  if (d >= 1) {
    g.fillStyle = 'rgba(150,142,130,0.30)';
    f.fill(0.24, 0.80, 0.76, 0.92); // ash bed
    for (let i = 0; i < 3; i++) {
      const u = 0.26 + hash(v * 5 + i, 0, 411) * 0.44;
      const t = 0.60 + hash(v * 5 + i, 1, 411) * 0.18;
      g.fillStyle = `rgba(196,118,58,${(0.28 + hash(v * 5 + i, 2, 411) * 0.22).toFixed(3)})`;
      f.fill(u, t, u + 0.06, t + 0.05);
    }
  }
}

// ── furn_light: things you can push past ───────────────────────────────────
// Scattered, small, never filling a tile — the art has to say "passable" as
// plainly as the 2.2 move cost does.

function drawCrate(g: Ctx, v: number, d: number): void {
  const n = 1 + (hash(v, 0, 412) < 0.55 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const w = 0.34 + hash(v * 3 + i, 0, 413) * 0.14;
    const h = 0.30 + hash(v * 3 + i, 1, 413) * 0.14;
    const x = 0.1 + hash(v * 3 + i, 2, 413) * (0.8 - w);
    const y = 0.1 + hash(v * 3 + i, 3, 413) * (0.8 - h);
    dropShadow(g, x, y, x + w, y + h);
    g.fillStyle = tone(WOOD_PALE, 0.95 + hash(v * 3 + i, 4, 413) * 0.2);
    g.fillRect(x, y, w, h);
    if (d >= 1) {
      g.strokeStyle = 'rgba(34,26,17,0.45)';
      g.lineWidth = 0.035;
      g.strokeRect(x + 0.02, y + 0.02, w - 0.04, h - 0.04);
      g.beginPath();
      g.moveTo(x + 0.04, y + 0.04);
      g.lineTo(x + w - 0.04, y + h - 0.04);
      g.stroke();
    }
    sunEdges(g, x, y, x + w, y + h, 15);
  }
}

function drawBarrel(g: Ctx, v: number, d: number): void {
  const r = 0.19 + hash(v, 0, 414) * 0.05;
  const cx = 0.22 + hash(v, 1, 414) * 0.56;
  const cy = 0.22 + hash(v, 2, 414) * 0.56;
  g.fillStyle = `rgba(14,11,8,${SHADOW_ALPHA})`;
  g.beginPath();
  g.ellipse(cx + SDX, cy + SDY, r, r, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = tone(WOOD, 1.12);
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  if (d >= 1) {
    g.strokeStyle = 'rgba(38,30,20,0.5)';
    g.lineWidth = 0.04;
    g.beginPath();
    g.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(240,232,208,0.22)';
    g.lineWidth = 0.05;
    g.beginPath();
    g.arc(cx, cy, r - 0.03, Math.PI * 1.05, Math.PI * 1.85);
    g.stroke();
  }
  g.fillStyle = 'rgba(20,16,11,0.35)';
  g.beginPath();
  g.arc(cx, cy, r * 0.16, 0, Math.PI * 2);
  g.fill();
}

function drawChair(g: Ctx, v: number, d: number): void {
  const s = 0.30;
  const cx = 0.2 + hash(v, 0, 415) * 0.5;
  const cy = 0.2 + hash(v, 1, 415) * 0.5;
  const back = (hash(v, 2, 415) * 4) | 0;
  dropShadow(g, cx, cy, cx + s, cy + s);
  if (d >= 1) {
    g.fillStyle = 'rgba(26,20,14,0.5)';
    for (let c = 0; c < 4; c++) g.fillRect(cx + (c & 1 ? s - 0.055 : 0.01), cy + (c & 2 ? s - 0.055 : 0.01), 0.05, 0.05);
  }
  g.fillStyle = tone(WOOD, 1.16);
  g.fillRect(cx - 0.02, cy - 0.025, s, s);
  g.fillStyle = tone(OAK, 1.0);
  if (back === 0) g.fillRect(cx - 0.02, cy - 0.09, s, 0.07);
  else if (back === 1) g.fillRect(cx - 0.02, cy + s - 0.05, s, 0.07);
  else if (back === 2) g.fillRect(cx - 0.09, cy - 0.025, 0.07, s);
  else g.fillRect(cx + s - 0.05, cy - 0.025, 0.07, s);
  sunEdges(g, cx - 0.02, cy - 0.025, cx + s - 0.02, cy + s - 0.025, 15, 0.18, 0.2);
}

function drawStraw(g: Ctx, v: number, d: number): void {
  g.fillStyle = 'rgba(24,20,12,0.16)';
  g.beginPath();
  g.ellipse(0.5 + SDX, 0.5 + SDY, 0.38, 0.32, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = tone(STRAW_C, 0.86);
  g.beginPath();
  g.ellipse(0.5, 0.5, 0.36, 0.3, 0, 0, Math.PI * 2);
  g.fill();
  if (d < 1) return;
  // wisps inside the mound's silhouette and close to its own value — a bale
  // that throws long pale strokes across the tile reads as a scratch, not straw
  g.lineWidth = 0.035;
  for (let i = 0; i < 8; i++) {
    const a = hash(v * 11 + i, 0, 416) * Math.PI;
    const x = 0.26 + hash(v * 11 + i, 1, 416) * 0.48;
    const y = 0.28 + hash(v * 11 + i, 2, 416) * 0.44;
    const l = 0.07 + hash(v * 11 + i, 3, 416) * 0.1;
    g.strokeStyle = hash(v * 11 + i, 4, 416) > 0.5 ? tone(STRAW_C, 1.05) : tone(STRAW_C, 0.78);
    g.beginPath();
    g.moveTo(x - Math.cos(a) * l, y - Math.sin(a) * l);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
}

// ── The stamp ──────────────────────────────────────────────────────────────

function furnStamp(piece: number, mask: number, orient: number, v: number, band: number): HTMLCanvasElement {
  return stamp(`furn:${piece}:${mask}:${orient}:${v}`, band, BOX, (g) => {
    g.translate(PAD, PAD);
    const d = band >= 32 ? 2 : band >= 16 ? 1 : 0;
    const axis = orient >> 2;
    const flip = (orient & 2) !== 0;
    const rev = (orient & 1) !== 0;
    const f = frameOf(g, axis, flip, rev);
    if (piece === PIECE.CRATE) return drawCrate(g, v, d);
    if (piece === PIECE.BARREL) return drawBarrel(g, v, d);
    if (piece === PIECE.CHAIR) return drawChair(g, v, d);
    if (piece === PIECE.STRAW) return drawStraw(g, v, d);
    if (piece === PIECE.HEARTH) return drawHearth(g, f, v, d);
    // run-shaped pieces: fuse into the neighbours that share the key, inset
    // from the ones that do not
    const loBit = axis === 0 ? (rev ? E : W) : rev ? S : N;
    const hiBit = axis === 0 ? (rev ? W : E) : rev ? N : S;
    const inset = piece === PIECE.BENCH ? 0.10 : piece === PIECE.BED ? 0.04 : 0.08;
    // A run piece is narrower than its tile ACROSS the run, so those two faces
    // are always part of its silhouette and always take the sun pair — only the
    // faces it fuses through are suppressed. A table fuses in both axes, so it
    // suppresses on both.
    const along = axis === 0 ? W | E : N | S;
    const s: Shape = {
      u0: mask & loBit ? -0.04 : inset,
      u1: mask & hiBit ? 1.04 : 1 - inset,
      endLo: (mask & loBit) === 0,
      endHi: (mask & hiBit) === 0,
      free: piece === PIECE.TABLE ? ~mask & 15 : 15 & ~(mask & along),
    };
    if (piece === PIECE.BENCH) drawBench(g, f, s, v, d);
    else if (piece === PIECE.COUNTER) drawCounter(g, f, s, v, d);
    else if (piece === PIECE.CHEST) drawChest(g, f, s, v, d);
    else if (piece === PIECE.BED) drawBed(g, f, s, v, d);
    else if (piece === PIECE.MANGER) drawManger(g, f, s, v, d);
    else if (piece === PIECE.ALTAR) drawAltar(g, f, s, v, d);
    else drawTable(g, f, s, mask, v, d);
  });
}

// ── Per-tile derivation ────────────────────────────────────────────────────

// A face is "walled" when the tile across it is not interior to the same
// building, or when the edge between them is a WALL. That is the only thing the
// piece chooser needs to know about the room it is in.
function wallMaskAt(map: GameMap, x: number, y: number): number {
  const id = map.buildingIdAt(x, y);
  let m = 0;
  if (map.hEdge(x, y) === EDGE.WALL || map.buildingIdAt(x, y - 1) !== id) m |= N;
  if (map.hEdge(x, y + 1) === EDGE.WALL || map.buildingIdAt(x, y + 1) !== id) m |= S;
  if (map.vEdge(x, y) === EDGE.WALL || map.buildingIdAt(x - 1, y) !== id) m |= W;
  if (map.vEdge(x + 1, y) === EDGE.WALL || map.buildingIdAt(x + 1, y) !== id) m |= E;
  return m;
}

// What a heavy tile IS, from role + shape + wall contact alone.
//  block   — the mass turns a corner, so it is a table, never a run piece
//  run     — a same-key neighbour along the axis
//  backed  — a wall on a long side (a counter's back, a dresser's wall)
//  headed  — a wall at exactly ONE end of the run: the only shape a bed fits
const HEAVY_ROLE_PIECE = (role: number, run: boolean, block: boolean, backed: boolean, headed: boolean, v: number): number => {
  // A nave's pew block is a SOLID rectangle of furn_heavy (interiors §4.3):
  // rows separated by 1-tile cross-lanes, columns by the central aisle. So a
  // church heavy tile is a pew whatever its neighbour mask — the one exception
  // is a lone piece shoved against a wall, which is the sacristy's vestment
  // press. Rendering a 3x2 pew block as one table was the visible bug this
  // rule exists to prevent.
  if (role === ROLE.CHURCH) return !run && backed ? PIECE.CHEST : PIECE.BENCH;
  if (role === ROLE.SHOP || role === ROLE.HALLE) return run && !backed ? PIECE.COUNTER : PIECE.CHEST;
  if (role === ROLE.BARN) return run && backed ? PIECE.MANGER : block ? PIECE.TABLE : PIECE.CHEST;
  if (block) return PIECE.TABLE;
  if (run && headed && v < 0.42) return PIECE.BED;
  if (run) return backed ? PIECE.CHEST : PIECE.TABLE;
  return backed ? PIECE.CHEST : PIECE.TABLE;
};

const LIGHT_ROLE_PIECE = (role: number, v: number): number => {
  if (role === ROLE.CHURCH) return PIECE.CHAIR;
  if (role === ROLE.SHOP || role === ROLE.HALLE) return v < 0.7 ? PIECE.CRATE : PIECE.BARREL;
  if (role === ROLE.BARN) return v < 0.4 ? PIECE.STRAW : v < 0.72 ? PIECE.CRATE : PIECE.BARREL;
  if (role === ROLE.FARMHOUSE) return v < 0.45 ? PIECE.CHAIR : v < 0.75 ? PIECE.BARREL : PIECE.CRATE;
  return v < 0.62 ? PIECE.CHAIR : PIECE.BARREL;
};

/**
 * Furniture for a tile range, as a post-pass over the finished tile bases —
 * NOT inside drawTileBase. A piece's contact shadow spills into the tile SE of
 * it, and the base pass would paint the next tile's floor straight over it.
 */
export function drawFurniture(
  g: Ctx,
  map: GameMap,
  roleAt: (x: number, y: number) => number,
  acrossAt: (x: number, y: number) => number,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  band: number,
): void {
  if (!map.hasFurniture) return;
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      const k = map.terrainKeyAt(x, y);
      if (k !== 'furn_heavy' && k !== 'furn_light' && k !== 'hearth' && k !== 'altar') continue;
      const same = (dx: number, dy: number) => map.inBounds(x + dx, y + dy) && map.terrainKeyAt(x + dx, y + dy) === k;
      const mask = (same(0, -1) ? N : 0) | (same(0, 1) ? S : 0) | (same(-1, 0) ? W : 0) | (same(1, 0) ? E : 0);
      const wall = wallMaskAt(map, x, y);
      const role = roleAt(x, y);
      const v = (hash(x, y, 401) * 3) | 0;

      let piece: number;
      let axis: number;
      let flip = false;
      let rev = false;
      if (k === 'furn_light') {
        piece = LIGHT_ROLE_PIECE(role, hash(x, y, 417));
        axis = 0;
      } else if (k === 'hearth') {
        piece = PIECE.HEARTH;
        // the frame puts the chimney's wall at low t, so the firebox opens into
        // the room whichever face the masonry actually sits on
        axis = wall & (N | S) ? 0 : 1;
        flip = axis === 0 ? (wall & N) === 0 : (wall & W) === 0;
      } else {
        const runH = (mask & (W | E)) !== 0;
        const runV = (mask & (N | S)) !== 0;
        // Run axis with a 2-tile lookahead. Adjacency alone cannot tell a 3x2
        // pew block's rows from its columns, and it cannot see that the lone
        // pew across a 1-tile side alley belongs to the row beyond it. The
        // half-weighted second ring can, and it costs four terrain reads.
        const sx = (mask & W ? 2 : 0) + (mask & E ? 2 : 0) + (same(-2, 0) ? 1 : 0) + (same(2, 0) ? 1 : 0);
        const sy = (mask & N ? 2 : 0) + (mask & S ? 2 : 0) + (same(0, -2) ? 1 : 0) + (same(0, 2) ? 1 : 0);
        // A nave overrides the local heuristic outright: pew rows run ACROSS,
        // and a 2-deep block of pews looks exactly like a 2-long N–S run from
        // inside a single tile. Letting adjacency decide gave one church rows in
        // both directions at once.
        axis =
          role === ROLE.CHURCH && k === 'furn_heavy'
            ? acrossAt(x, y)
            : sx > sy
              ? 0
              : sy > sx
                ? 1
                : wall & (N | S)
                  ? 0
                  : wall & (W | E)
                    ? 1
                    : 0;
        const run = runH || runV;
        const block = runH && runV;
        const loW = axis === 0 ? N : W;
        const hiW = axis === 0 ? S : E;
        const loRun = axis === 0 ? W : N;
        const hiRun = axis === 0 ? E : S;
        const backed = (wall & (loW | hiW)) !== 0;
        const headed = ((wall & loRun) !== 0) !== ((wall & hiRun) !== 0);
        flip = (wall & loW) === 0 && (wall & hiW) !== 0;
        piece = k === 'altar' ? PIECE.ALTAR : HEAVY_ROLE_PIECE(role, run, block, backed, headed, hash(x, y, 418));
        // a bed's head goes against the wall the run runs INTO, so mirror u
        // when that wall is at the far end
        if (piece === PIECE.BED) rev = (wall & loRun) === 0;
      }
      const orient = (axis << 2) | (flip ? 2 : 0) | (rev ? 1 : 0);
      g.drawImage(furnStamp(piece, k === 'furn_light' ? 0 : mask, orient, v, band), x - PAD, y - PAD, BOX, BOX);
    }
  }
}

// ── I15 · rugs ─────────────────────────────────────────────────────────────

// A rug is render-only: no terrain key, no sim effect. Anchored on a plain
// floor tile beside a heavy piece in a dwelling, hash-gated, and grown to 2x1
// or 2x2 where the neighbouring tiles are also plain floor — so it crosses tile
// seams as one object, which is why it is drawn straight into the chunk instead
// of being a per-tile stamp.
const RUG_A: RGB = [124, 64, 52]; // faded madder
const RUG_B: RGB = [70, 74, 92]; // indigo
const RUG_C: RGB = [116, 98, 58]; // old gold

export function drawRugs(
  g: Ctx,
  map: GameMap,
  roleAt: (x: number, y: number) => number,
  tx0: number,
  ty0: number,
  tx1: number,
  ty1: number,
  d: number,
): void {
  if (!map.hasFurniture) return;
  const plain = (x: number, y: number) => map.inBounds(x, y) && map.terrainKeyAt(x, y) === 'floor' && map.buildingIdAt(x, y) >= 0;
  for (let y = ty0 - 1; y < ty1; y++) {
    for (let x = tx0 - 1; x < tx1; x++) {
      if (!plain(x, y) || hash(x, y, 420) >= 0.16) continue;
      const role = roleAt(x, y);
      if (role !== ROLE.OTHER && role !== ROLE.TOWNHOUSE && role !== ROLE.CIVIC) continue;
      const heavy = (dx: number, dy: number) => map.inBounds(x + dx, y + dy) && map.terrainKeyAt(x + dx, y + dy) === 'furn_heavy';
      if (!heavy(-1, 0) && !heavy(1, 0) && !heavy(0, -1) && !heavy(0, 1) && !heavy(1, 1) && !heavy(-1, -1)) continue;
      const w = plain(x + 1, y) ? 2 : 1;
      const h = plain(x, y + 1) && (w === 1 || plain(x + 1, y + 1)) && hash(x, y, 421) < 0.6 ? 2 : 1;
      const t = hash(x, y, 422);
      const col = t < 0.4 ? RUG_A : t < 0.72 ? RUG_B : RUG_C;
      const x0 = x + 0.14;
      const y0 = y + 0.16;
      const x1 = x + w - 0.14;
      const y1 = y + h - 0.16;
      g.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0.60)`;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (d < 1) continue;
      g.strokeStyle = 'rgba(28,22,18,0.28)';
      g.lineWidth = 0.05;
      g.strokeRect(x0 + 0.09, y0 + 0.09, x1 - x0 - 0.18, y1 - y0 - 0.18);
      g.strokeStyle = 'rgba(226,214,190,0.24)';
      g.lineWidth = 0.035;
      g.strokeRect(x0 + 0.16, y0 + 0.16, x1 - x0 - 0.32, y1 - y0 - 0.32);
      if (d < 2) continue;
      g.fillStyle = 'rgba(40,32,26,0.22)'; // fringe on the two short ends
      for (let i = 0; i < 8; i++) {
        const fx = x0 + ((x1 - x0) * (i + 0.5)) / 8;
        g.fillRect(fx - 0.015, y0 - 0.05, 0.03, 0.05);
        g.fillRect(fx - 0.015, y1, 0.03, 0.05);
      }
    }
  }
}

// ── I15 · hearth glow ──────────────────────────────────────────────────────

/**
 * Firelight, in the FRAME LOOP. It cannot live in a chunk bake: a baked flicker
 * is a still, and rebaking a chunk per frame is 2-5 ms of chunk work per frame.
 * Gated on the roof fade exactly like drawStairs — no roof up, no firelight.
 * World transform is applied by the caller.
 */
export function drawHearthGlow(
  g: Ctx,
  map: GameMap,
  hearths: readonly number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  now: number,
  visible: (x: number, y: number) => boolean,
): void {
  const t = now / 1000;
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const i of hearths) {
    const x = i % map.w;
    const y = (i / map.w) | 0;
    if (x < x0 || x > x1 || y < y0 || y > y1 || !visible(x, y)) continue;
    const ph = hash(x, y, 423) * 100;
    // two incommensurate rates so the flicker never reads as a loop, clamped
    // well under the one-sun key light — this is a warm bloom on the floor, not
    // a light source
    const amp = 0.72 + 0.19 * Math.sin(t * 5.1 + ph) + 0.11 * Math.sin(t * 11.3 + ph * 1.7);
    const wall = wallMaskAt(map, x, y);
    const dx = wall & N ? 0 : wall & S ? 0 : wall & W ? 0.18 : -0.18;
    const dy = wall & N ? 0.18 : wall & S ? -0.18 : 0;
    const cx = x + 0.5 + dx;
    const cy = y + 0.5 + dy;
    const r = 1.15 + amp * 0.22;
    const grad = g.createRadialGradient(cx, cy, 0.05, cx, cy, r);
    grad.addColorStop(0, `rgba(196,116,52,${(0.30 * amp).toFixed(3)})`);
    grad.addColorStop(0.45, `rgba(150,84,36,${(0.13 * amp).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(120,64,28,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `rgba(228,150,70,${(0.34 * amp).toFixed(3)})`;
    g.beginPath();
    g.ellipse(cx, cy, 0.2 + amp * 0.05, 0.14 + amp * 0.04, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** Tile indices of every hearth on the map — scanned once, iterated per frame. */
export function hearthTiles(map: GameMap): number[] {
  if (!map.hasFurniture) return [];
  const out: number[] = [];
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) if (map.terrainKeyAt(x, y) === 'hearth') out.push(y * map.w + x);
  }
  return out;
}
