import { VEHICLES, type VehicleKey } from '../sim/data';
import type { Side } from '../sim/sim';
import { bolts, type Ctx, detailFor, type Detail, hair, plate, roundRectPath, TAU, teamRim, weld } from './bakekit';
import { DUDE_SCALE, kitTones, tier } from './dudes';
import { AO_ALPHA } from './light';
import { hash } from './noise';
import { SpriteCache } from './spritecache';

// Parametric vector tank, drawn facing +X in meter units, baked per
// (kind, side, state, zoom band) — same scheme as dudes.ts.

export const VEHICLE_SPAN = 8; // meters covered by the sprite canvas
const BANDS = [6, 12, 24, 48];
export function vehicleBandFor(scale: number): number {
  return BANDS.find((b) => b >= scale) ?? 48;
}

type State = 'ok' | 'dead';

interface Palette {
  hullTop: string; // upper deck plate — lighter, catches the light
  hullSide: string; // hull base / vertical armor — darker
  deck: string; // glacis, turret roof, casemate plate
  track: string;
  trackLink: string;
  rim: string; // team-color rim
  metalDark: string; // barrel, hatch, mantlet
  canvas: string; // bedroll / tarp — the stowage that isn't steel
  wood: string; // ammo crates
}

const LIVE: Record<Side, Palette> = {
  blue: {
    hullTop: '#6d7a4e',
    hullSide: '#4f5936',
    deck: '#647048',
    track: '#3a3a34',
    trackLink: '#242420',
    rim: 'rgba(100,155,225,0.9)',
    metalDark: '#2b2b28',
    canvas: '#6a6450',
    wood: '#6b5c42',
  },
  red: {
    hullTop: '#6a6d63',
    hullSide: '#4c4e46',
    deck: '#60625a',
    track: '#35352f',
    trackLink: '#201f1c',
    rim: 'rgba(225,105,85,0.9)',
    metalDark: '#2b2b28',
    canvas: '#645f4c',
    wood: '#63563e',
  },
};

const DEAD: Palette = {
  hullTop: '#453f36',
  hullSide: '#332f28',
  deck: '#3c372f',
  track: '#28241f',
  trackLink: '#18160f',
  rim: 'rgba(60,60,55,0.5)',
  metalDark: '#201d18',
  canvas: '#3b362c',
  wood: '#3a3128',
};

function paletteFor(side: Side, state: State): Palette {
  return state === 'dead' ? DEAD : LIVE[side];
}

function dims(kind: VehicleKey): { long: number; wide: number } {
  switch (kind) {
    case 'sherman':
      return { long: 5.8, wide: 2.7 };
    case 'panzer4':
      return { long: 5.9, wide: 2.9 };
    case 'stug3':
      return { long: 5.7, wide: 2.95 };
    case 'm3_halftrack':
      return { long: 6.4, wide: 2.2 };
    default:
      return VEHICLES[kind].openTop ? { long: 6.4, wide: 2.2 } : { long: 5.9, wide: 2.9 };
  }
}

// --- Surface fidelity kit (U5) ----------------------------------------------
// Everything below is bake-only and hairline-clamped. The rule that makes a
// bevel legal in a rotating sprite: the light offset goes along +X of BAKE
// space, never along the world sun vector — a baked directional highlight
// would swing with the hull and break the one-sun contract the cast-shadow
// pass (renderer.drawUnitShadows) upholds. A rotation-invariant edge pair
// reads as "this is a plate with thickness" without claiming a light angle.

// Crew hatch: a disc a shade off the deck, a rim ring, an inner arc that gives
// it a lip, a hinge tab on the -X side and a handle tick.
function hatch(g: Ctx, band: number, cx: number, cy: number, r: number, c: Palette, d: Detail, split = false): void {
  if (!d.d1) return;
  const hw = Math.max(0.028, hair(band));
  g.fillStyle = c.deck;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(0,0,0,0.11)'; // a hatch is deck-toned; only the shadow in its seam separates it
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.38)';
  g.lineWidth = hw;
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.beginPath();
  g.arc(cx, cy, r * 0.6, Math.PI * 0.9, Math.PI * 1.8);
  g.stroke();
  if (split) {
    g.strokeStyle = 'rgba(0,0,0,0.32)';
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx, cy + r);
    g.stroke();
  }
  g.fillStyle = 'rgba(0,0,0,0.34)';
  g.fillRect(cx - r - 0.11, cy - 0.03, 0.11, 0.06); // hinge tab
  if (d.d2) g.fillRect(cx + r * 0.3, cy - 0.02, 0.16, 0.04); // handle
}

function grilleLines(g: Ctx, x0: number, x1: number, y0: number, y1: number, n: number, color: string): void {
  g.strokeStyle = color;
  g.lineWidth = 0.035;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const y = y0 + ((y1 - y0) * (i + 0.5)) / n;
    g.moveTo(x0, y);
    g.lineTo(x1, y);
  }
  g.stroke();
}

// Engine-deck louvre: an inset dark well, the grille slats inside it, and a
// bevel on the top edge so it reads as recessed rather than painted on.
function louvre(g: Ctx, band: number, x: number, y: number, w: number, h: number, n: number, c: Palette, d: Detail): void {
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(x, y, w, h);
  grilleLines(g, x + 0.05, x + w - 0.05, y, y + h, n, c.hullSide);
  if (!d.d1) return;
  const hw = Math.max(0.028, hair(band));
  g.lineWidth = hw;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeRect(x, y, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w, y);
  g.stroke();
}

// --- Stowage ----------------------------------------------------------------
// Placement is fixed per kind: deterministic, shared by every instance of that
// kind. A per-instance weathering dimension would multiply a 590 KB band-48
// canvas by the vehicle count for zero legibility gain.

function bedroll(g: Ctx, band: number, x: number, y: number, len: number, c: Palette, d: Detail): void {
  g.fillStyle = c.canvas;
  roundRectPath(g, x - len / 2, y - 0.11, len, 0.22, 0.11);
  g.fill();
  if (!d.d2) return;
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = Math.max(0.025, hair(band));
  g.beginPath();
  for (let i = 0; i < 3; i++) {
    const lx = x - len / 2 + (len * (i + 1)) / 4;
    g.moveTo(lx, y - 0.1);
    g.lineTo(lx, y + 0.1);
  }
  g.stroke();
}

function jerrycan(g: Ctx, band: number, x: number, y: number, c: Palette, d: Detail): void {
  g.fillStyle = c.hullSide;
  roundRectPath(g, x - 0.2, y - 0.14, 0.4, 0.28, 0.05);
  g.fill();
  if (!d.d1) return;
  const hw = Math.max(0.025, hair(band));
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = hw;
  g.stroke();
  if (!d.d2) return;
  g.beginPath();
  for (let i = 0; i < 3; i++) {
    const rx = x - 0.12 + i * 0.12;
    g.moveTo(rx, y - 0.12);
    g.lineTo(rx, y + 0.12);
  }
  g.moveTo(x - 0.16, y - 0.11);
  g.lineTo(x + 0.16, y + 0.11);
  g.moveTo(x - 0.16, y + 0.11);
  g.lineTo(x + 0.16, y - 0.11);
  g.stroke();
  g.fillStyle = c.metalDark;
  g.fillRect(x - 0.19, y - 0.05, 0.05, 0.1); // filler cap
}

function crate(g: Ctx, band: number, x: number, y: number, c: Palette, d: Detail): void {
  g.fillStyle = c.wood;
  g.fillRect(x - 0.25, y - 0.2, 0.5, 0.4);
  if (!d.d1) return;
  const hw = Math.max(0.025, hair(band));
  g.lineWidth = hw;
  g.strokeStyle = 'rgba(0,0,0,0.32)';
  g.strokeRect(x - 0.25, y - 0.2, 0.5, 0.4);
  if (!d.d2) return;
  g.beginPath();
  for (let i = 0; i < 3; i++) {
    const px = x - 0.25 + (0.5 * (i + 1)) / 4;
    g.moveTo(px, y - 0.2);
    g.lineTo(px, y + 0.2);
  }
  g.stroke();
}

function tarp(g: Ctx, band: number, x: number, y: number, s: number, c: Palette, d: Detail): void {
  const pts: [number, number][] = [
    [-0.5, -0.34],
    [0.46, -0.42],
    [0.54, 0.3],
    [-0.42, 0.42],
  ];
  const path = (): void => {
    pts.forEach(([px, py], i) => {
      const ax = x + px * s;
      const ay = y + py * s;
      if (i === 0) g.moveTo(ax, ay);
      else g.lineTo(ax, ay);
    });
    g.closePath();
  };
  g.fillStyle = c.canvas;
  g.beginPath();
  path();
  g.fill();
  if (!d.d1) return;
  weld(g, band, path);
  if (!d.d2) return;
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = Math.max(0.025, hair(band));
  g.beginPath();
  g.moveTo(x - 0.3 * s, y - 0.2 * s);
  g.lineTo(x + 0.2 * s, y + 0.3 * s);
  g.stroke();
}

// A rack of spare track links, drawn along the segment (x0,y0)→(x1,y1).
function spareTrack(g: Ctx, band: number, x0: number, y0: number, x1: number, y1: number, n: number, c: Palette, d: Detail): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  g.save();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2);
  g.rotate(Math.atan2(y1 - y0, x1 - x0));
  // Links bolted to armour are steel on steel: one value step down from the
  // hull, not the near-black of a running track — a black bar across the
  // glacis reads as a hole in the tank.
  g.fillStyle = c.hullSide;
  g.fillRect(-len / 2, -0.07, len, 0.14);
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = Math.max(0.028, hair(band));
  g.strokeRect(-len / 2, -0.07, len, 0.14);
  if (d.d2) {
    g.strokeStyle = 'rgba(0,0,0,0.34)';
    g.beginPath();
    for (let i = 1; i < n; i++) {
      const x = -len / 2 + (len * i) / n;
      g.moveTo(x, -0.07);
      g.lineTo(x, 0.07);
    }
    g.stroke();
  }
  g.restore();
}

function towCable(g: Ctx, band: number, x: number, y: number, r: number, d: Detail): void {
  if (!d.d1) return;
  g.strokeStyle = 'rgba(30,27,22,0.75)';
  g.lineWidth = Math.max(0.04, hair(band));
  g.beginPath();
  g.arc(x, y, r, -Math.PI * 0.75, Math.PI * 0.75);
  g.stroke();
}

// --- Weathering -------------------------------------------------------------

// Mud thrown up by the tracks: a jittered band along each track edge, heavier
// over the rear third, plus speckle climbing the hull side. Hash-driven, keyed
// on the kind index so every Sherman is muddy the same way (see the stowage
// note — no per-instance dimension).
function mudSkirt(g: Ctx, kindIx: number, long: number, wide: number, d: Detail): void {
  if (!d.d2) return;
  const half = long / 2;
  // Caked earth over a near-black running track: the tone has to sit ABOVE
  // the track value or 0.35 alpha of dark brown on dark grey is nothing.
  g.fillStyle = 'rgba(96,80,55,0.42)';
  for (const s of [-1, 1] as const) {
    const salt = 31 + (s > 0 ? 7 : 0);
    g.beginPath();
    g.moveTo(-half, (s * wide) / 2);
    g.lineTo(half, (s * wide) / 2);
    const N = 11;
    for (let i = N; i >= 0; i--) {
      const u = i / N;
      const rear = u < 0.34 ? 1.55 : 1;
      const th = 0.16 * rear * (0.5 + hash(kindIx, i, salt) * 1.0);
      g.lineTo(-half + long * u, s * (wide / 2 - th));
    }
    g.closePath();
    g.fill();
    for (let i = 0; i < 7; i++) {
      const hx = hash(kindIx, i, salt + 10);
      const hy = hash(kindIx, i, salt + 20);
      g.beginPath();
      g.ellipse(-half + long * (0.06 + hx * 0.72), s * (wide / 2 - 0.22 - hy * 0.46), 0.06 + hy * 0.06, 0.05 + hx * 0.05, 0, 0, TAU);
      g.fill();
    }
  }
}

// Paint that has been in a hedgerow: chipping down to the hull tone, and a
// dust wash over the insignia's bounding box.
function weatherMark(g: Ctx, x: number, y: number, r: number, c: Palette, d: Detail): void {
  if (bakePart === 'turret') return; // hull paint
  if (!d.d2) return;
  g.save();
  g.globalAlpha = 0.35;
  g.fillStyle = c.hullTop;
  for (let i = 0; i < 4; i++) {
    const a = hash(Math.round(x * 10), i, 57) * TAU;
    const dr = r * (0.35 + hash(i, Math.round(y * 10), 58) * 0.7);
    g.beginPath();
    g.ellipse(x + Math.cos(a) * dr, y + Math.sin(a) * dr, r * 0.16, r * 0.12, a, 0, TAU);
    g.fill();
  }
  g.restore();
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(x - r * 1.15, y - r * 1.15, r * 2.3, r * 2.3);
}

// Hand-painted tactical number, ~0.34 m of cap height — a stencil on the
// turret side, not a billboard. Text is drawn at 34 px in a 0.01-scaled frame
// rather than as a 0.34 px font: sub-pixel font sizes are a rasterizer coin
// flip, a scaled-down big glyph is not.
function turretNumber(g: Ctx, x: number, y: number, text: string, d: Detail): void {
  if (bakePart === 'turret') return; // hull paint
  if (!d.d2) return;
  g.save();
  g.translate(x, y);
  g.scale(0.01, 0.01);
  g.font = '34px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.strokeText(text, 0, 0);
  g.fillStyle = 'rgba(226,222,208,0.6)';
  g.fillText(text, 0, 0);
  g.restore();
}

// Contact AO: a tight dark ring hugging the hull outline, the pinch of dark
// where armour meets dirt. Directionless by design — the cast shadow is a
// world-aligned draw pass now (renderer.drawUnitShadows), because a blob baked
// into a rotating sprite pointed a different way for every heading.
function hullAO(g: Ctx, long: number, wide: number, band: number): void {
  g.strokeStyle = `rgba(14,13,10,${AO_ALPHA * 0.6})`;
  g.lineWidth = Math.max(0.22, hair(band) * 2);
  roundRectPath(g, -long / 2 - 0.04, -wide / 2 - 0.04, long + 0.08, wide + 0.08, 0.4);
  g.stroke();
}

// --- Motion state carried into the bake (U7) --------------------------------
// Two bake-time dimensions that would be absurd as parameters threaded through
// eight drawing functions: which third of a link pitch the track is on, and
// how full an open top is. Set once per bake by getVehicleSprite, read by
// trackStrip and drawHalftrack — the same single-threaded bake contract
// dudes.ts's `mono` and `kitBits` use.
let bakePhase = 0;
let bakeOcc = 0;
let bakeSide: Side = 'blue';

// Which part of a turreted tank this bake is of. 'all' is the one sprite a
// vehicle has always been: hull with the gun baked pointing forward. The
// renderer asks for 'hull' and 'turret' as two sprites only while the turret
// is off the centreline or the gun is recoiling, and turns the second about
// turretCenter(). A tank at rest still draws 'all', so nothing that does not
// move changes by a pixel.
export type VehiclePart = 'all' | 'hull' | 'turret';
let bakePart: VehiclePart = 'all';

// Discard everything drawn until the matching unmute(): an empty clip. The
// hull and turret passes share one drawing function per kind, and its
// statements interleave the two. Muting a span leaves the function's order
// untouched, and in an 'all' bake neither call does anything at all.
function mute(g: Ctx, off: boolean): void {
  if (!off) return;
  g.save();
  g.beginPath();
  g.rect(0, 0, 0, 0);
  g.clip();
}
function unmute(g: Ctx, off: boolean): void {
  if (off) g.restore();
}

// Bucketed occupancy for the sprite key. Deliberately not the raw head count:
// four buckets is what the cache can afford (an open top's canvas is ~590 KB
// at band 48), and nobody reads the difference between six men and seven.
// Bucket 1 is "crewed but empty" — a transport with a driver and a gunner and
// nothing in the bed, which floor(n/3) would have drawn as abandoned.
export function occBucket(kind: VehicleKey, aboard: number): number {
  if (!isOpenTop(kind) || aboard <= 0) return 0;
  return aboard <= 2 ? 1 : aboard <= 6 ? 2 : 3;
}

// `openTop` is optional in the vehicle table, so it only narrows inside a
// switch that has already excluded the closed kinds. One accessor instead of
// a cast at every call site.
function isOpenTop(kind: VehicleKey): boolean {
  return (VEHICLES[kind] as { openTop?: boolean }).openTop === true;
}

// Half the distance between the two track centres — where a track mark or a
// dust puff belongs, in hull space.
export function trackGauge(kind: VehicleKey): number {
  const { wide } = dims(kind);
  return wide / 2 - (isOpenTop(kind) ? 0.42 : 0.5) / 2;
}

function trackStrip(g: Ctx, x0: number, x1: number, y: number, h: number, color: string, linkColor: string, gap?: [number, number]): void {
  g.fillStyle = color;
  if (gap) {
    g.fillRect(x0, y, gap[0] - x0, h);
    g.fillRect(gap[1], y, x1 - gap[1], h);
  } else {
    g.fillRect(x0, y, x1 - x0, h);
  }
  g.strokeStyle = linkColor;
  g.lineWidth = 0.045;
  g.beginPath();
  const step = 0.32;
  // The whole of the track-churn animation: the link row starts a third of a
  // pitch further along per phase. At 4.5 m/s the phase steps about every
  // other frame — churn, not strobe.
  for (let x = x0 + step / 2 + (bakePhase * step) / 3; x < x1; x += step) {
    if (gap && x > gap[0] && x < gap[1]) continue;
    g.moveTo(x, y);
    g.lineTo(x, y + h);
  }
  g.stroke();
}

function bogieDots(g: Ctx, x0: number, x1: number, y: number, n: number, color: string): void {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    g.beginPath();
    g.arc(x, y, 0.09, 0, TAU);
    g.fill();
  }
}

function star(g: Ctx, x: number, y: number, r: number, color: string): void {
  if (bakePart === 'turret') return; // hull paint
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.42;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
}

function balkenkreuz(g: Ctx, x: number, y: number, r: number): void {
  if (bakePart === 'turret') return; // hull paint
  const armW = r * 0.62;
  g.save();
  g.translate(x, y);
  g.fillStyle = '#161512';
  g.fillRect(-r, -armW / 2, r * 2, armW);
  g.fillRect(-armW / 2, -r, armW, r * 2);
  g.strokeStyle = '#e8e4d8';
  g.lineWidth = armW * 0.22;
  g.strokeRect(-r, -armW / 2, r * 2, armW);
  g.strokeRect(-armW / 2, -r, armW, r * 2);
  g.restore();
}

// ~0.3m turret jolt off-center, baked for wrecks of turreted kinds.
function turretJolt(wreck: boolean): [number, number] {
  return wreck ? [-0.14, 0.27] : [0, 0];
}

function turret(g: Ctx, band: number, cx: number, cy: number, r: number, c: Palette, barrelLen: number, cupola: boolean, d: Detail, droop = 0): void {
  g.fillStyle = c.deck;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 0.035;
  g.stroke();
  // cast-armour texture: two shallow concentric arcs, the read that separates
  // a cast turret from a stamped disc
  if (d.d2) {
    g.lineWidth = Math.max(0.03, hair(band));
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    g.arc(cx, cy, r * 0.72, Math.PI * 0.75, Math.PI * 1.7);
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.13)';
    g.beginPath();
    g.arc(cx, cy, r * 0.46, Math.PI * 1.75, Math.PI * 0.7);
    g.stroke();
  }
  // mantlet stub at the barrel root
  g.save();
  g.translate(cx, cy);
  g.rotate(droop);
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.ellipse(r * 0.65, 0, r * 0.34, r * 0.26, 0, 0, TAU);
  g.fill();
  g.strokeStyle = c.metalDark;
  g.lineWidth = r * 0.28;
  g.beginPath();
  g.moveTo(r * 0.75, 0);
  g.lineTo(r + barrelLen, 0);
  g.stroke();
  if (d.d2) {
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = Math.max(0.03, hair(band));
    g.beginPath();
    g.moveTo(r * 0.9, -r * 0.09);
    g.lineTo(r + barrelLen - 0.1, -r * 0.09);
    g.stroke();
  }
  g.restore();
  if (cupola) {
    g.fillStyle = c.metalDark;
    g.beginPath();
    g.arc(cx - r * 0.35, cy, r * 0.24, 0, TAU);
    g.fill();
  }
}

// Burnt two-tone finish: char-dark base palette (DEAD) plus a couple of
// fixed ash-grey patches on top — deterministic, no per-instance variety needed.
function ashPatches(g: Ctx, long: number, wide: number, d: Detail): void {
  g.fillStyle = 'rgba(150,146,134,0.28)';
  g.beginPath();
  g.ellipse(-long * 0.18, -wide * 0.12, long * 0.16, wide * 0.22, 0.3, 0, TAU);
  g.fill();
  g.beginPath();
  g.ellipse(long * 0.22, wide * 0.16, long * 0.13, wide * 0.18, -0.4, 0, TAU);
  g.fill();
  if (!d.d2) return;
  // soot radiating out of the turret ring — the fire came from inside
  const soot = g.createRadialGradient(-0.1, 0, 0.15, -0.1, 0, long * 0.55);
  soot.addColorStop(0, 'rgba(12,10,8,0.5)');
  soot.addColorStop(0.5, 'rgba(12,10,8,0.22)');
  soot.addColorStop(1, 'rgba(12,10,8,0)');
  g.fillStyle = soot;
  g.beginPath();
  g.ellipse(-0.1, 0, long * 0.55, wide * 0.62, 0, 0, TAU);
  g.fill();
}

function drawSherman(g: Ctx, band: number, c: Palette, wreck: boolean, long: number, wide: number, d: Detail): void {
  const half = long / 2;
  const trackH = 0.5;
  const topY = -wide / 2;
  const botY = wide / 2 - trackH;
  const gap: [number, number] | undefined = wreck ? [-0.6, 0.6] : undefined;
  const botOffset = wreck ? 0.14 : 0;
  const deckY = -wide / 2 + trackH; // -0.85
  const noHull = bakePart === 'turret';
  const noTurret = bakePart === 'hull';
  mute(g, noHull);
  g.fillStyle = c.hullSide;
  roundRectPath(g, -half, -wide / 2, long, wide, 0.5);
  g.fill();
  trackStrip(g, -half + 0.15, half - 0.15, topY, trackH, c.track, c.trackLink);
  trackStrip(g, -half + 0.15, half - 0.15, botY + botOffset, trackH, c.track, c.trackLink, gap);
  bogieDots(g, -half + 0.5, half - 0.5, topY + trackH / 2, 5, c.trackLink);
  bogieDots(g, -half + 0.5, half - 0.5, botY + trackH / 2 + botOffset, 5, c.trackLink);
  plate(g, band, c.hullTop, d, () => roundRectPath(g, -half + 0.15, deckY, long - 0.3, wide - trackH * 2, 0.35));
  // rear engine deck: two louvres with the bedroll lashed between them
  louvre(g, band, -half + 0.3, deckY + 0.06, 0.62, 0.5, 3, c, d);
  louvre(g, band, -half + 0.3, -deckY - 0.56, 0.62, 0.5, 3, c, d);
  if (d.d1) {
    bedroll(g, band, -half + 0.72, 0, 0.95, c, d);
    crate(g, band, -half + 1.32, -0.42, c, d);
    jerrycan(g, band, -half + 1.38, 0.28, c, d);
    jerrycan(g, band, -half + 1.38, 0.64, c, d);
    towCable(g, band, -half + 0.2, 0, 0.17, d);
  }
  // front glacis: transmission cover arcs + a spare-track rack across it
  plate(g, band, c.deck, d, () => roundRectPath(g, half - 1.1, deckY + 0.05, 0.85, wide - trackH * 2 - 0.1, 0.15));
  if (d.d1) {
    g.strokeStyle = 'rgba(0,0,0,0.24)';
    g.lineWidth = Math.max(0.03, hair(band));
    for (const rr of [0.35, 0.58, 0.8]) {
      g.beginPath();
      g.arc(half - 0.05, 0, rr, Math.PI * 0.62, Math.PI * 1.38);
      g.stroke();
    }
    spareTrack(g, band, half - 0.72, -0.52, half - 0.72, 0.52, 5, c, d);
  }
  bolts(g, band, -half + 0.6, deckY + 0.02, half - 1.3, deckY + 0.02, 8, d);
  bolts(g, band, -half + 0.6, -deckY - 0.02, half - 1.3, -deckY - 0.02, 8, d);
  unmute(g, noHull);
  mute(g, noTurret);
  const [jx, jy] = turretJolt(wreck);
  turret(g, band, -0.15 + jx, jy, 1.0, c, 2.3, false, d, wreck ? 0.12 : 0);
  // commander's split hatch + loader's hatch + the roof .50 on its pintle
  if (!wreck) {
    hatch(g, band, -0.55, -0.38, 0.3, c, d, true);
    hatch(g, band, -0.5, 0.42, 0.24, c, d);
    if (d.d1) {
      g.strokeStyle = c.metalDark;
      g.lineWidth = 0.07;
      g.beginPath();
      g.moveTo(-0.88, -0.62);
      g.lineTo(-0.53, -0.62);
      g.stroke();
      g.fillStyle = c.metalDark;
      g.fillRect(-0.98, -0.68, 0.12, 0.12);
    }
  } else if (d.d2) {
    hatch(g, band, -0.55 + jx + 0.4, -0.38 + jy - 0.18, 0.3, c, d, true); // blown clear of its ring
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = Math.max(0.03, hair(band));
    g.beginPath();
    g.arc(-0.55 + jx, -0.38 + jy, 0.3, 0, TAU);
    g.stroke();
  }
  unmute(g, noTurret);
  mute(g, noHull);
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.arc(half - 0.55, 0, 0.16, 0, TAU);
  g.fill();
  mudSkirt(g, 1, long, wide, d);
  unmute(g, noHull);
}

function drawPanzer4(g: Ctx, band: number, c: Palette, wreck: boolean, long: number, wide: number, d: Detail): void {
  const half = long / 2;
  const trackH = 0.5;
  const topY = -wide / 2;
  const botY = wide / 2 - trackH;
  const gap: [number, number] | undefined = wreck ? [-0.5, 0.5] : undefined;
  const botOffset = wreck ? -0.13 : 0;
  const noHull = bakePart === 'turret';
  const noTurret = bakePart === 'hull';
  mute(g, noHull);
  const deckY = -wide / 2 + trackH; // -0.95
  g.fillStyle = c.hullSide;
  g.fillRect(-half, -wide / 2, long, wide); // boxier — square corners, no round
  trackStrip(g, -half + 0.1, half - 0.1, topY, trackH, c.track, c.trackLink, gap);
  trackStrip(g, -half + 0.1, half - 0.1, botY + botOffset, trackH, c.track, c.trackLink);
  bogieDots(g, -half + 0.45, half - 0.45, topY + trackH / 2, 5, c.trackLink);
  bogieDots(g, -half + 0.45, half - 0.45, botY + trackH / 2 + botOffset, 5, c.trackLink);
  plate(g, band, c.hullTop, d, () => g.rect(-half + 0.12, deckY, long - 0.24, wide - trackH * 2));
  // real Schürzen: standoff plates outboard of each track, one shot away and
  // one bent back — battle-worn is the whole point of modelling them
  if (d.d1) {
    const segN = 5;
    const x0 = -half + 0.3;
    const span = long - 0.6;
    const segW = (span - (segN - 1) * 0.08) / segN;
    for (const s of [-1, 1] as const) {
      for (let i = 0; i < segN; i++) {
        if (s < 0 && i === 3) continue; // shot away
        const sx = x0 + i * (segW + 0.08);
        const yOut = s * (wide / 2 + 0.14);
        const yIn = s * (wide / 2);
        const bent = s > 0 && i === 1;
        g.fillStyle = c.hullSide;
        g.beginPath();
        g.moveTo(sx, yIn);
        g.lineTo(sx + segW, yIn);
        g.lineTo(sx + segW, bent ? yIn + s * 0.05 : yOut);
        g.lineTo(sx, bent ? yOut + s * 0.16 : yOut);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.34)';
        g.lineWidth = Math.max(0.028, hair(band));
        g.stroke();
      }
    }
  }
  g.fillStyle = c.deck;
  g.fillRect(half - 1.0, deckY + 0.05, 0.8, wide - trackH * 2 - 0.1);
  // rear deck: louvre pair, transverse muffler on the tail plate
  louvre(g, band, -half + 0.28, deckY + 0.08, 0.66, 0.62, 3, c, d);
  louvre(g, band, -half + 0.28, -deckY - 0.7, 0.66, 0.62, 3, c, d);
  if (d.d1) {
    g.fillStyle = c.metalDark;
    roundRectPath(g, -half + 0.02, -0.55, 0.2, 1.1, 0.08);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = Math.max(0.028, hair(band));
    g.beginPath();
    g.moveTo(-half + 0.22, -0.3);
    g.lineTo(-half + 0.42, -0.3);
    g.moveTo(-half + 0.22, 0.3);
    g.lineTo(-half + 0.42, 0.3);
    g.stroke();
    // spare road wheel + a tarp bundle on the glacis
    g.fillStyle = c.track;
    g.beginPath();
    g.arc(half - 1.5, -0.6, 0.26, 0, TAU);
    g.fill();
    g.fillStyle = c.trackLink;
    g.beginPath();
    g.arc(half - 1.5, -0.6, 0.09, 0, TAU);
    g.fill();
    tarp(g, band, half - 1.55, 0.52, 0.72, c, d);
  }
  bolts(g, band, -half + 0.5, deckY + 0.03, half - 0.5, deckY + 0.03, 9, d);
  bolts(g, band, -half + 0.5, -deckY - 0.03, half - 0.5, -deckY - 0.03, 9, d);
  unmute(g, noHull);
  mute(g, noTurret);
  const [jx, jy] = turretJolt(wreck);
  const tcx = -0.1 + jx;
  // turret Schürzen: a hex standoff ring hung off the turret roof
  if (d.d1 && !wreck) {
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = Math.max(0.05, hair(band) * 2);
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (TAU * i) / 6 + Math.PI / 6;
      const px = tcx + Math.cos(a) * 1.28;
      const py = jy + Math.sin(a) * 1.28;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.stroke();
  }
  // stowage bin across the turret rear
  if (d.d1) {
    g.fillStyle = c.hullSide;
    roundRectPath(g, tcx - 1.42, jy - 0.42, 0.36, 0.84, 0.06);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.32)';
    g.lineWidth = Math.max(0.028, hair(band));
    g.stroke();
  }
  turret(g, band, tcx, jy, 0.95, c, 2.8, true, d, wreck ? -0.12 : 0);
  if (!wreck) hatch(g, band, tcx - 0.33, jy, 0.24, c, d);
  unmute(g, noTurret);
  mute(g, noHull);
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.arc(half - 0.5, 0, 0.15, 0, TAU);
  g.fill();
  mudSkirt(g, 2, long, wide, d);
  unmute(g, noHull);
}

function drawStug(g: Ctx, band: number, c: Palette, wreck: boolean, long: number, wide: number, d: Detail): void {
  const half = long / 2;
  const trackH = 0.5;
  const topY = -wide / 2;
  const botY = wide / 2 - trackH;
  const gap: [number, number] | undefined = wreck ? [-0.5, 0.4] : undefined;
  const botOffset = wreck ? 0.12 : 0;
  const deckY = -wide / 2 + trackH;
  g.fillStyle = c.hullSide;
  g.fillRect(-half, -wide / 2, long, wide);
  trackStrip(g, -half + 0.1, half - 0.1, topY, trackH, c.track, c.trackLink);
  trackStrip(g, -half + 0.1, half - 0.1, botY + botOffset, trackH, c.track, c.trackLink, gap);
  bogieDots(g, -half + 0.45, half - 0.45, topY + trackH / 2, 5, c.trackLink);
  bogieDots(g, -half + 0.45, half - 0.45, botY + trackH / 2 + botOffset, 5, c.trackLink);
  plate(g, band, c.hullTop, d, () => g.rect(-half + 0.12, deckY, long - 0.24, wide - trackH * 2));
  // low angular casemate — NO turret circle; sloped front plate
  const casemate = (): void => {
    g.moveTo(-half + 0.3, topY + trackH + 0.1);
    g.lineTo(half - 0.5, topY + trackH + 0.28);
    g.lineTo(half - 0.15, 0);
    g.lineTo(half - 0.5, botY - 0.28);
    g.lineTo(-half + 0.3, botY - 0.1);
    g.closePath();
  };
  plate(g, band, c.deck, d, casemate);
  // the one place a rotation-invariant inset AO genuinely reads as height:
  // the step down from the casemate roof to the deck on its -X edge
  if (d.d1) {
    g.strokeStyle = 'rgba(0,0,0,0.15)';
    g.lineWidth = 0.14;
    g.beginPath();
    g.moveTo(-half + 0.32, topY + trackH + 0.16);
    g.lineTo(-half + 0.32, botY - 0.16);
    g.stroke();
    // spare track links racked along the superstructure sides — the StuG
    // crew's improvised extra armour, and the kind's most recognisable clutter
    spareTrack(g, band, -half + 1.0, -0.72, -half + 3.1, -0.70, 6, c, d);
    spareTrack(g, band, -half + 1.0, 0.72, -half + 3.1, 0.7, 6, c, d);
  }
  if (!wreck) {
    hatch(g, band, -0.45, -0.42, 0.26, c, d);
    hatch(g, band, -0.45, 0.44, 0.24, c, d);
    if (d.d1) {
      // driver's periscope box, offset to the left of the gun
      g.fillStyle = c.metalDark;
      g.fillRect(half - 1.35, -0.62, 0.3, 0.18);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(half - 1.35, -0.62, 0.3, 0.05);
    }
  } else if (d.d2) {
    hatch(g, band, -0.05, -0.6, 0.26, c, d);
  }
  bolts(g, band, -half + 0.6, topY + trackH + 0.06, half - 1.0, topY + trackH + 0.2, 7, d);
  bolts(g, band, -half + 0.6, botY - 0.06, half - 1.0, botY - 0.2, 7, d);
  // gun mounted right of centerline, offset further on the wreck's jolt
  const gy = wreck ? 0.28 : 0.22;
  g.save();
  g.translate(half - 0.3, gy);
  if (wreck) g.rotate(0.12);
  g.strokeStyle = c.metalDark;
  g.lineWidth = 0.16;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(2.8, 0);
  g.stroke();
  if (d.d2) {
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = Math.max(0.03, hair(band));
    g.beginPath();
    g.moveTo(0.2, -0.05);
    g.lineTo(2.7, -0.05);
    g.stroke();
  }
  g.restore();
  // Saukopf mantlet: a cast blob over the gun root, not a flat ellipse stub
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.ellipse(half - 0.28, gy, 0.34, 0.28, 0, 0, TAU);
  g.fill();
  if (d.d2) {
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = Math.max(0.03, hair(band));
    g.beginPath();
    g.arc(half - 0.28, gy, 0.22, Math.PI * 0.8, Math.PI * 1.7);
    g.stroke();
  }
  mudSkirt(g, 3, long, wide, d);
}

// One man seen from above at ~0.62 of a soldier sprite's scale: shoulders,
// helmet, and (close in) the rifle across his knees. Soldiers with
// `inVehicle >= 0` are filtered out of every soldier pass in the renderer, so
// this bake is the only place a passenger can exist.
const OCC = 0.62 * DUDE_SCALE; // body units → metres, at passenger scale

function occupant(g: Ctx, band: number, x: number, y: number, facing: number, d: Detail): void {
  const k = kitTones(bakeSide);
  g.save();
  g.translate(x, y);
  g.rotate(facing);
  g.fillStyle = 'rgba(0,0,0,0.2)';
  g.beginPath();
  g.ellipse(-0.04 * OCC, 0, 0.24 * OCC, 0.34 * OCC, 0, 0, TAU); // he sits ON the bench, not in the floor
  g.fill();
  g.fillStyle = k.uniform; // torso value, not sleeve — the helmet has to be the darkest thing on him
  g.beginPath();
  g.ellipse(-0.04 * OCC, 0, 0.2 * OCC, 0.3 * OCC, 0, 0, TAU); // shoulders
  g.fill();
  g.fillStyle = k.helmet;
  g.beginPath();
  g.arc(0.06 * OCC, 0, 0.175 * OCC, 0, TAU);
  g.fill();
  if (!d.d2) {
    g.restore();
    return;
  }
  g.strokeStyle = 'rgba(0,0,0,0.32)';
  g.lineWidth = Math.max(0.025, hair(band));
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.beginPath();
  g.arc(0.06 * OCC, 0, 0.1 * OCC, Math.PI * 0.85, Math.PI * 1.75);
  g.stroke();
  g.restore();
}

// Who is riding, by occupancy bucket: 1 = driver + pintle gunner only,
// 2 = plus four in the bed, 3 = packed. Alternating outboard facings are what
// make the bed read as men rather than a grid of dots.
function crewAboard(g: Ctx, band: number, bedX0: number, bedX1: number, bedY: number, d: Detail): void {
  const rows = bakeOcc >= 3 ? 4 : bakeOcc >= 2 ? 2 : 0;
  const x0 = bedX0 + 0.42;
  const x1 = bedX1 - 1.25;
  for (let i = 0; i < rows; i++) {
    const px = x0 + ((x1 - x0) * i) / (rows - 1);
    for (const s of [-1, 1] as const) {
      occupant(g, band, px, s * (bedY - 0.3), (s * Math.PI) / 2, d);
    }
  }
  if (bakeOcc >= 3) occupant(g, band, (x0 + x1) / 2, 0, Math.PI, d); // the odd man out, facing the tailgate
  occupant(g, band, bedX1 - 0.52, -0.3, 0, d); // driver, behind his visor plate
  occupant(g, band, bedX1 - 1.08, 0.38, 0, d); // gunner, standing to the pintle
}

function drawHalftrack(g: Ctx, band: number, c: Palette, wreck: boolean, long: number, wide: number, d: Detail, faceted: boolean): void {
  const half = long / 2;
  const trackH = 0.42;
  const trackX0 = -half;
  const trackX1 = -half + long * 0.55;
  const gap: [number, number] | undefined = wreck ? [trackX0 + long * 0.16, trackX0 + long * 0.3] : undefined;
  const topOffset = wreck ? 0.1 : 0;
  // Hull first, running gear over it: the body used to be filled AFTER the
  // tracks and painted them out entirely, which is why a halftrack read as a
  // plain box with three dots on it.
  g.fillStyle = c.hullSide;
  g.fillRect(trackX0, -wide / 2, long, wide);
  trackStrip(g, trackX0 + 0.1, trackX1, -wide / 2 + topOffset, trackH, c.track, c.trackLink, gap);
  trackStrip(g, trackX0 + 0.1, trackX1, wide / 2 - trackH, trackH, c.track, c.trackLink);
  bogieDots(g, trackX0 + 0.4, trackX1 - 0.2, -wide / 2 + trackH / 2 + topOffset, 3, c.trackLink);
  bogieDots(g, trackX0 + 0.4, trackX1 - 0.2, wide / 2 - trackH / 2, 3, c.trackLink);
  // front road wheels
  g.fillStyle = c.trackLink;
  for (const s of [-1, 1] as const) {
    g.beginPath();
    g.arc(half - 0.5, s * (wide / 2 - 0.15), 0.32, 0, TAU);
    g.fill();
  }
  // engine hood
  plate(g, band, c.deck, d, () => g.rect(half - 1.3, -wide / 2 + 0.2, 1.15, wide - 0.4));
  if (d.d1) {
    // louvred hood sides + the unditching roller on a US nose
    grilleLines(g, half - 1.15, half - 0.35, -0.55, -0.2, 3, c.hullSide);
    grilleLines(g, half - 1.15, half - 0.35, 0.2, 0.55, 3, c.hullSide);
    if (!faceted) {
      g.fillStyle = c.metalDark;
      roundRectPath(g, half - 0.12, -0.62, 0.2, 1.24, 0.1);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = Math.max(0.028, hair(band));
      g.stroke();
    }
  }
  // open bed: floor tone, bench line, bed walls. The floor stops at the inner
  // edge of the tracks so the running gear stays visible.
  const bedX0 = trackX0 + 0.15;
  const bedX1 = half - 1.3;
  const bedY = wide / 2 - trackH - 0.03;
  g.fillStyle = c.hullTop;
  g.fillRect(bedX0, -bedY, bedX1 - bedX0, bedY * 2);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 0.03;
  g.strokeRect(bedX0, -bedY, bedX1 - bedX0, bedY * 2);
  // the 251's characteristic angled side plates — otherwise it is just a US
  // halftrack painted feldgrau
  if (faceted && d.d1) {
    for (const s of [-1, 1] as const) {
      plate(g, band, c.hullSide, d, () => {
        g.moveTo(bedX1, s * bedY);
        g.lineTo(bedX0 + 0.1, s * bedY);
        g.lineTo(bedX0 + 0.5, s * (bedY - 0.3));
        g.lineTo(bedX1 - 0.25, s * (bedY - 0.24));
        g.closePath();
      });
    }
  }
  g.strokeStyle = c.hullSide;
  g.lineWidth = 0.06;
  g.beginPath();
  g.moveTo(bedX0 + 0.15, 0);
  g.lineTo(bedX1 - 0.1, 0);
  g.stroke();
  if (d.d1) {
    // windscreen visor plates with their vision slots
    for (const s of [-1, 1] as const) {
      const y0 = s < 0 ? -0.52 : 0.14;
      g.fillStyle = c.metalDark;
      g.fillRect(bedX1 - 0.28, y0, 0.22, 0.38);
      g.fillStyle = 'rgba(190,196,186,0.22)';
      g.fillRect(bedX1 - 0.24, y0 + 0.11, 0.14, 0.045);
      g.fillRect(bedX1 - 0.24, y0 + 0.22, 0.14, 0.045);
    }
    // bench ticks along both bed walls
    g.strokeStyle = 'rgba(0,0,0,0.26)';
    g.lineWidth = Math.max(0.03, hair(band));
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const bx = bedX0 + 0.4 + i * ((bedX1 - bedX0 - 0.8) / 3);
      g.moveTo(bx, -bedY + 0.04);
      g.lineTo(bx, -bedY + 0.24);
      g.moveTo(bx, bedY - 0.04);
      g.lineTo(bx, bedY - 0.24);
    }
    g.stroke();
    // stowed rifles racked along the port wall
    g.strokeStyle = c.metalDark;
    g.lineWidth = Math.max(0.035, hair(band));
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const bx = bedX0 + 0.75 + i * 0.5;
      g.moveTo(bx, -bedY + 0.06);
      g.lineTo(bx + 0.34, -bedY + 0.3);
    }
    g.stroke();
    // pintle MG with its shield, front-right of the bed (inboard of the
    // windscreen plate, which owns the last 0.3 m of the bed)
    g.fillStyle = c.metalDark;
    g.beginPath();
    g.arc(bedX1 - 0.85, 0.38, 0.11, 0, TAU);
    g.fill();
    g.lineWidth = 0.06;
    g.strokeStyle = c.metalDark;
    g.beginPath();
    g.moveTo(bedX1 - 0.85, 0.38);
    g.lineTo(bedX1 - 0.4, 0.38);
    g.stroke();
    g.fillStyle = c.hullSide;
    g.fillRect(bedX1 - 0.52, 0.16, 0.09, 0.44);
    g.strokeStyle = 'rgba(0,0,0,0.32)';
    g.lineWidth = Math.max(0.028, hair(band));
    g.strokeRect(bedX1 - 0.52, 0.16, 0.09, 0.44);
    // jerrycans on the rear step
    jerrycan(g, band, bedX0 + 0.28, -0.38, c, d);
    jerrycan(g, band, bedX0 + 0.28, 0.38, c, d);
  }
  if (!wreck && bakeOcc > 0) crewAboard(g, band, bedX0, bedX1, bedY, d);
  mudSkirt(g, faceted ? 4 : 5, long, wide, d);
}

const VEHICLE_BUDGET = 24 << 20; // bytes; a band-48 hull canvas is ~590 KB, so this is a real ceiling
const cache = new SpriteCache(VEHICLE_BUDGET);

export function vehicleCacheStats(): { entries: number; bytes: number } {
  return cache.stats();
}

// `tphase` (track churn, 0-2) and `occ` (open-top occupancy bucket, 0-3) are
// extra cache dimensions, so both must be 0 wherever they cannot be seen —
// the renderer pins them at far bands and on wrecks. See occBucket().
export function getVehicleSprite(kind: VehicleKey, side: Side, state: State, band: number, tphase = 0, occ = 0, part: VehiclePart = 'all'): HTMLCanvasElement {
  const key = part === 'all' ? `${kind}|${side}|${state}|${band}|${tphase}|${occ}` : `${kind}|${side}|${state}|${band}|${tphase}|${occ}|${part}`;
  const hit = cache.get(key);
  if (hit) return hit;
  bakePhase = tphase;
  bakeOcc = occ;
  bakeSide = side;
  bakePart = part;

  const px = VEHICLE_SPAN * band;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.translate(px / 2, px / 2);
  g.scale(band, band);

  const { long, wide } = dims(kind);
  const wreck = state === 'dead';
  const pal = paletteFor(side, state);

  if (part !== 'turret') {
    hullAO(g, long, wide, band);
    teamRim(g, -long / 2, -wide / 2, long, wide, band, pal.rim);
  }
  drawBody(g, kind, side, pal, wreck, long, wide, true, band);
  if (wreck) ashPatches(g, long, wide, detailFor(band, true));
  bakePart = 'all';

  cache.set(key, c);
  return c;
}

// Hull geometry per kind, shared by the colour bake and the shadow bake so a
// silhouette can never drift from the vehicle throwing it. `marks` is off for
// the shadow pass: national insignia is paint, and paint casts nothing — and
// the same flag zeroes the detail tier, because a weld seam or a mud spray is
// surface treatment, not something that stands up into the light.
function drawBody(g: Ctx, kind: VehicleKey, side: Side, pal: Palette, wreck: boolean, long: number, wide: number, marks: boolean, band: number): void {
  const d = detailFor(band, marks);
  switch (kind) {
    case 'sherman':
      drawSherman(g, band, pal, wreck, long, wide, d);
      if (marks && !wreck) {
        star(g, -long / 2 + 1.05, 0, 0.3, '#e7e2d4');
        weatherMark(g, -long / 2 + 1.05, 0, 0.3, pal, d);
        turretNumber(g, 1.35, -0.6, '212', d);
      }
      break;
    case 'panzer4':
      drawPanzer4(g, band, pal, wreck, long, wide, d);
      if (marks && !wreck) {
        balkenkreuz(g, -long / 2 + 1.05, 0, 0.34);
        weatherMark(g, -long / 2 + 1.05, 0, 0.34, pal, d);
        turretNumber(g, -0.1, -0.6, '431', d);
      }
      break;
    case 'stug3':
      drawStug(g, band, pal, wreck, long, wide, d);
      if (marks && !wreck) {
        balkenkreuz(g, -long / 2 + 1.05, 0, 0.32);
        weatherMark(g, -long / 2 + 1.05, 0, 0.32, pal, d);
        turretNumber(g, -1.85, -0.55, 'S31', d);
      }
      break;
    case 'm3_halftrack':
      drawHalftrack(g, band, pal, wreck, long, wide, d, false);
      if (marks && !wreck) star(g, -long / 2 + 1.5, 0, 0.24, '#e7e2d4');
      break;
    default: {
      // Any future VehicleKey: bucket by its data rather than failing —
      // open-top transports read as a halftrack, restricted-arc guns as a
      // casemate, everything else as a generic turreted tank.
      const def = VEHICLES[kind];
      if (def.openTop) {
        drawHalftrack(g, band, pal, wreck, long, wide, d, true);
        if (marks && !wreck) balkenkreuz(g, -long / 2 + 1.5, 0, 0.26);
      } else if (typeof def.turret === 'number') {
        drawStug(g, band, pal, wreck, long, wide, d);
        if (marks && !wreck) balkenkreuz(g, -long / 2 + 1.05, 0, 0.32);
      } else {
        drawPanzer4(g, band, pal, wreck, long, wide, d);
        if (marks && !wreck && side === 'blue') star(g, -long / 2 + 1.05, 0, 0.3, '#e7e2d4');
        else if (marks && !wreck) balkenkreuz(g, -long / 2 + 1.05, 0, 0.34);
      }
    }
  }
}

// --- One sun on vehicles (U2) ----------------------------------------------

const SHADOW_INK = 'rgba(20,16,10,1)';
const MONO: Palette = {
  hullTop: SHADOW_INK,
  hullSide: SHADOW_INK,
  deck: SHADOW_INK,
  track: SHADOW_INK,
  trackLink: SHADOW_INK,
  rim: SHADOW_INK,
  metalDark: SHADOW_INK,
  canvas: SHADOW_INK,
  wood: SHADOW_INK,
};
const SHADOW_BAKE_BAND = 24; // the 2x upscale at band 48 is the feathering
const shadowCache = new SpriteCache(8 << 20);

// Flat-ink hull silhouette, drawn by the world-aligned cast pass. Carries no
// side dimension — a Sherman's shadow and a Panzer's differ by hull, not paint.
export function getVehicleShadow(kind: VehicleKey, state: State, band: number): HTMLCanvasElement {
  const sb = Math.min(SHADOW_BAKE_BAND, band);
  const key = `${kind}|${state}|${sb}`;
  const hit = shadowCache.get(key);
  if (hit) return hit;
  bakePhase = 0;
  bakeOcc = 0; // the silhouette is the hull; it never gains or loses a passenger
  const px = VEHICLE_SPAN * sb;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.translate(px / 2, px / 2);
  g.scale(sb, sb);
  const { long, wide } = dims(kind);
  drawBody(g, kind, 'blue', MONO, state === 'dead', long, wide, false, sb);
  shadowCache.set(key, c);
  return c;
}

// Turret centre + radius in hull space, or null for a casemate/open top. The
// turret sits ~1 m above the deck, so it needs its own drop shadow to read as
// sitting ON the hull rather than painted onto it.
export function turretCenter(kind: VehicleKey): [number, number, number] | null {
  switch (kind) {
    case 'sherman':
      return [-0.15, 0, 1.0];
    case 'panzer4':
      return [-0.1, 0, 0.95];
    case 'stug3':
    case 'm3_halftrack':
      return null;
    default: {
      const def = VEHICLES[kind];
      if (def.openTop || typeof def.turret === 'number') return null;
      return [-0.1, 0, 0.95];
    }
  }
}

// One shared soft ellipse for every turret drop shadow.
let blob: HTMLCanvasElement | null = null;
export function turretBlob(): HTMLCanvasElement {
  if (blob) return blob;
  const px = 32;
  const r = px / 2;
  blob = document.createElement('canvas');
  blob.width = px;
  blob.height = px;
  const g = blob.getContext('2d')!;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(10,9,7,1)');
  grad.addColorStop(0.62, 'rgba(10,9,7,0.85)');
  grad.addColorStop(1, 'rgba(10,9,7,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return blob;
}
