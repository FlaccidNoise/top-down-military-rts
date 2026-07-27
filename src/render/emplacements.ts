import { EMPLACEMENTS, type EmplacementKey } from '../sim/data';
import type { Side } from '../sim/sim';
import { bolts, type Ctx, type Detail, detailFor, hair, plate, roundRectPath, TAU, teamRing, weld } from './bakekit';
import { AO_ALPHA } from './light';
import { SpriteCache } from './spritecache';

// Parametric crewed weapons, drawn facing +X in metre units and baked per
// (kind, side, state, zoom band) — the same scheme as vehicles.ts.
//
// Scoping rule that separates this from the open-top vehicle bake: an
// emplacement's crew have `inEmplacement >= 0` but `inVehicle < 0`, so they
// are ALREADY drawn as individual soldier sprites by the main soldier passes.
// Nothing here bakes a man. This module draws the weapon and its mount.

export type EmplacementState = 'packed' | 'deployed';

const BANDS = [6, 12, 24, 48];

export function emplacementBandFor(scale: number): number {
  return BANDS.find((b) => b >= scale) ?? 48;
}

// Sprite canvas size in metres, per kind. An MG on a tripod fits in three and
// a half; a PaK 40 is 3.1 m of barrel in front of the axle and 1.5 m of trail
// behind it, and shortening the gun to fit a shared span would be the wrong
// trade — spend the pixels instead, and only on the kinds that need them.
export function emplacementSpan(kind: EmplacementKey): number {
  return isGun(kind) ? 7 : 3.5;
}

function isGun(kind: EmplacementKey): boolean {
  return kind === 'at57' || kind === 'pak40';
}

// Genre-standard oversize, the same trade dudes.ts makes with DUDE_SCALE: an
// M2 tripod is 0.9 m across and a 60 mm baseplate 0.5 m, which at tactical
// zoom is a smudge next to the (already oversized) men serving it. AT guns are
// big enough to draw true — and their 3.1 m barrel has no room to grow inside
// the span anyway.
function artScale(kind: EmplacementKey): number {
  return isGun(kind) ? 1 : 1.3;
}

interface Palette {
  steel: string; // receivers, tubes, barrels
  steelLit: string; // the +X edge of a round tube
  mount: string; // tripod legs, trails, baseplates
  wood: string; // ammo crates, wheel hubs
  brass: string; // belts, loose casings
  rim: string; // team colour, already dimmed: a ring around a small mount carries far more weight than the same rim hugging a tank hull
}

// The mount has to sit a clear value step ABOVE the steel and above the field:
// a gun drawn entirely in dark greys on Normandy grass is a smudge, and the
// internal contrast between painted mount and blued steel is what makes the
// weapon read as machinery rather than a stain.
const LIVE: Record<Side, Palette> = {
  blue: { steel: '#33362f', steelLit: '#5b5f4f', mount: '#5d6446', wood: '#5f5541', brass: '#907a44', rim: 'rgba(100,155,225,0.55)' },
  red: { steel: '#2f312b', steelLit: '#585b50', mount: '#585b50', wood: '#5b5140', brass: '#8a7546', rim: 'rgba(225,105,85,0.55)' },
};

// Rough footprint of the deployed weapon, for the contact AO and the team rim.
// x0/y0/w/h in hull space, +X forward.
function footprint(kind: EmplacementKey): [number, number, number, number] {
  switch (kind) {
    case 'm1919_tripod':
    case 'mg42_lafette':
      return [-0.85, -0.75, 2.0, 1.5];
    case 'mortar60':
      return [-0.5, -0.55, 1.3, 1.1];
    case 'mortar81':
      return [-0.6, -0.65, 1.6, 1.3];
    default:
      return [-1.7, -1.0, 3.6, 2.0]; // AT guns: trails behind, wheels abreast
  }
}

// Radius in metres the frame loop draws the selection ring and the "not in
// action" dashed box at — derived from the same footprint the bake uses, not
// the old `cam.scale * 0.34 * 0.4 * 10` constant nobody could explain.
export function emplacementFootprintRadius(kind: EmplacementKey): number {
  const [x, y, w, h] = footprint(kind);
  return (Math.max(Math.abs(x), x + w, Math.abs(y), y + h) + 0.15) * artScale(kind);
}

// How far out the mount itself extends — where the team ring and the contact
// AO belong. NOT the footprint: a rounded box drawn around a PaK 40's barrel
// is a UI widget floating in a field, not an outline of anything.
function mountRadius(kind: EmplacementKey): number {
  switch (kind) {
    case 'm1919_tripod':
    case 'mg42_lafette':
      return 0.72;
    case 'mortar60':
      return 0.52;
    case 'mortar81':
      return 0.6;
    default:
      return 1.0;
  }
}

// Contact AO under the mount — the same directionless pinch of dark the hull
// bakes use, because the DIRECTIONAL shadow is a world-aligned draw pass.
function baseAO(g: Ctx, kind: EmplacementKey): void {
  const r = mountRadius(kind);
  const grad = g.createRadialGradient(0, 0, r * 0.35, 0, 0, r * 1.25);
  grad.addColorStop(0, `rgba(14,13,10,${AO_ALPHA * 0.5})`);
  grad.addColorStop(1, 'rgba(14,13,10,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, r * 1.25, 0, TAU);
  g.fill();
}

// A round tube seen from above: a dark bar with a lit edge along +X of bake
// space. Rotation-invariant by construction (see bakekit's weld note).
function tube(g: Ctx, band: number, x0: number, y0: number, x1: number, y1: number, w: number, c: Palette, d: Detail): void {
  g.lineCap = 'butt';
  g.strokeStyle = c.steel;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
  if (!d.d1) return;
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = Math.max(0.025, hair(band));
  const nx = -(y1 - y0);
  const ny = x1 - x0;
  const len = Math.hypot(nx, ny) || 1;
  const ox = (nx / len) * w * 0.3;
  const oy = (ny / len) * w * 0.3;
  g.beginPath();
  g.moveTo(x0 + ox, y0 + oy);
  g.lineTo(x1 + ox, y1 + oy);
  g.stroke();
}

// Cooling-jacket perforations / muzzle-brake baffles: n ticks across a barrel.
function jacket(g: Ctx, band: number, x0: number, x1: number, y: number, w: number, n: number, d: Detail): void {
  if (!d.d2) return;
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = Math.max(0.025, hair(band));
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    g.moveTo(x, y - w / 2);
    g.lineTo(x, y + w / 2);
  }
  g.stroke();
}

function ammoCan(g: Ctx, band: number, x: number, y: number, c: Palette, d: Detail): void {
  g.fillStyle = c.mount;
  roundRectPath(g, x - 0.2, y - 0.125, 0.4, 0.25, 0.04);
  g.fill();
  if (!d.d1) return;
  g.strokeStyle = 'rgba(0,0,0,0.34)';
  g.lineWidth = Math.max(0.025, hair(band));
  g.stroke();
  if (!d.d2) return;
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.beginPath();
  g.moveTo(x - 0.1, y - 0.125);
  g.lineTo(x + 0.1, y - 0.125); // lid handle
  g.stroke();
}

// The belt hanging from the feed tray to the can — the detail that says
// "loaded" more than any amount of receiver plumbing.
function belt(g: Ctx, band: number, x0: number, y0: number, x1: number, y1: number, c: Palette, d: Detail): void {
  if (!d.d1) return;
  g.strokeStyle = c.brass;
  g.lineWidth = Math.max(0.04, hair(band));
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo((x0 + x1) / 2, y0 + (y1 - y0) * 0.9, x1, y1);
  g.stroke();
}

function crate(g: Ctx, band: number, x: number, y: number, w: number, h: number, c: Palette, d: Detail): void {
  plate(g, band, c.wood, d, () => g.rect(x - w / 2, y - h / 2, w, h));
  if (!d.d2) return;
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = Math.max(0.025, hair(band));
  g.beginPath();
  g.moveTo(x - w / 2, y);
  g.lineTo(x + w / 2, y);
  g.stroke();
}

// --- MG on a mount ----------------------------------------------------------

function drawTripodMG(g: Ctx, band: number, c: Palette, d: Detail, lafette: boolean): void {
  const legW = Math.max(0.06, hair(band) * 2);
  g.lineCap = 'round';
  g.strokeStyle = c.steel; // legs are the dark value; the mount tone is for plates
  g.lineWidth = legW;
  g.beginPath();
  if (lafette) {
    // sled mount: a T-frame with two outriggers and a trailing rail
    g.moveTo(-0.1, -0.55);
    g.lineTo(-0.1, 0.55);
    g.moveTo(-0.1, -0.55);
    g.lineTo(0.45, -0.42);
    g.moveTo(-0.1, 0.55);
    g.lineTo(0.45, 0.42);
    g.moveTo(-0.1, 0);
    g.lineTo(-0.85, 0);
  } else {
    // tripod: two legs forward at +-40 degrees, one trailing
    for (const s of [-1, 1] as const) {
      g.moveTo(0, 0);
      g.lineTo(Math.cos((s * 40 * Math.PI) / 180) * 0.9, Math.sin((s * 40 * Math.PI) / 180) * 0.9);
    }
    g.moveTo(0, 0);
    g.lineTo(-0.9, 0);
  }
  g.stroke();
  g.lineCap = 'butt';
  // pintle / traverse ring
  if (d.d1) {
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = Math.max(0.03, hair(band));
    g.beginPath();
    g.arc(0, 0, 0.22, 0, TAU);
    g.stroke();
  }
  g.fillStyle = c.steel;
  g.beginPath();
  g.arc(0, 0, 0.12, 0, TAU);
  g.fill();
  if (lafette && d.d1) {
    // recoil slide rail under the receiver
    g.strokeStyle = c.steel;
    g.lineWidth = 0.1;
    g.beginPath();
    g.moveTo(-0.32, 0);
    g.lineTo(0.3, 0);
    g.stroke();
  }
  // receiver + barrel jacket. The MG42's is fat and short-ticked with a
  // booster on the muzzle; the M1919's is a slim perforated water jacket.
  const barrelW = lafette ? 0.17 : 0.14;
  tube(g, band, -0.35, 0, 0.12, 0, 0.24, c, d); // receiver
  tube(g, band, 0.12, 0, 0.9, 0, barrelW, c, d);
  jacket(g, band, 0.18, 0.84, 0, barrelW, lafette ? 7 : 5, d);
  if (lafette) {
    g.fillStyle = c.steel;
    g.fillRect(0.9, -0.11, 0.14, 0.22); // muzzle booster
    if (d.d1) {
      g.fillStyle = c.mount;
      g.fillRect(-0.2, -0.32, 0.28, 0.2); // optic block on the left
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(-0.2, -0.32, 0.28, 0.05);
    }
  } else if (d.d1) {
    // spare-barrel tube stowed alongside
    tube(g, band, -0.2, -0.42, 0.55, -0.42, 0.1, c, d);
  }
  // feed: belt out of the tray to the can on the loader's side
  const cy = lafette ? 0.42 : 0.38;
  ammoCan(g, band, -0.05, cy + 0.1, c, d);
  belt(g, band, -0.12, 0.1, -0.05, cy - 0.02, c, d);
  if (lafette) ammoCan(g, band, -0.55, cy + 0.14, c, d);
}

// --- Mortars ----------------------------------------------------------------

function drawMortar(g: Ctx, band: number, c: Palette, d: Detail, big: boolean): void {
  const plateR = big ? 0.3 : 0.25;
  const tubeLen = big ? 0.7 : 0.55;
  // pit ring: the crew dug the baseplate in
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.beginPath();
  g.arc(0, 0, plateR * 1.75, 0, TAU);
  g.fill();
  // baseplate: a disc for the 60 mm, a square plate for the 8 cm
  plate(g, band, c.mount, d, () => {
    if (big) g.rect(-plateR, -plateR, plateR * 2, plateR * 2);
    else g.arc(0, 0, plateR, 0, TAU);
  });
  g.fillStyle = c.steel;
  g.beginPath();
  g.arc(0, 0, 0.09, 0, TAU); // socket
  g.fill();
  // bipod opening toward the front
  g.lineCap = 'round';
  g.strokeStyle = c.steel;
  g.lineWidth = Math.max(0.055, hair(band) * 2);
  g.beginPath();
  for (const s of [-1, 1] as const) {
    g.moveTo(0.06, 0);
    g.lineTo(0.78, s * 0.56); // wide enough to clear the baseplate — the V is the read
  }
  g.stroke();
  g.lineCap = 'butt';
  // The tube is near vertical, so from above it is SHORT. That foreshortening
  // is the whole read: a mortar drawn at an AT gun's barrel length is a
  // different weapon.
  tube(g, band, 0, 0, tubeLen, 0, big ? 0.2 : 0.16, c, d);
  g.fillStyle = c.steel;
  g.beginPath();
  g.arc(tubeLen, 0, big ? 0.14 : 0.11, 0, TAU); // muzzle ring bulb
  g.fill();
  if (d.d1) {
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.lineWidth = Math.max(0.025, hair(band));
    g.beginPath();
    g.arc(tubeLen, 0, big ? 0.09 : 0.07, Math.PI * 0.8, Math.PI * 1.8);
    g.stroke();
    g.fillStyle = c.steel;
    g.fillRect(0.3, -0.19, 0.06, 0.1); // elevation screw
  }
  // three-round ready rack beside the pit
  if (!d.d1) return;
  for (let i = 0; i < 3; i++) {
    const rx = -0.32 + i * 0.2;
    const ry = 0.52;
    g.fillStyle = c.steel;
    g.beginPath();
    g.arc(rx, ry, 0.09, 0, TAU);
    g.fill();
    if (!d.d2) continue;
    g.strokeStyle = c.mount;
    g.lineWidth = Math.max(0.025, hair(band));
    g.beginPath();
    g.moveTo(rx, ry + 0.09);
    g.lineTo(rx, ry + 0.14);
    g.stroke();
  }
}

// --- AT guns ----------------------------------------------------------------

function wheel(g: Ctx, band: number, x: number, y: number, r: number, c: Palette, d: Detail): void {
  g.fillStyle = c.steel;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
  if (!d.d1) return;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = Math.max(0.028, hair(band));
  g.stroke();
  if (!d.d3) {
    g.fillStyle = c.mount;
    g.beginPath();
    g.arc(x, y, r * 0.36, 0, TAU);
    g.fill();
    return;
  }
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (TAU * i) / 6;
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85);
  }
  g.stroke();
  g.fillStyle = c.mount;
  g.beginPath();
  g.arc(x, y, r * 0.3, 0, TAU);
  g.fill();
}

function drawATGun(g: Ctx, band: number, c: Palette, d: Detail, heavy: boolean, packed: boolean): void {
  const barrel = (heavy ? 3.1 : 2.6) * (packed ? 0.7 : 1);
  const trail = 1.6;
  const spread = packed ? 6 : 25; // degrees off the axis; limbered trails fold together
  const axle = packed ? -0.35 : 0;
  // split trail, spades at the ends
  g.lineCap = 'butt';
  g.strokeStyle = c.steel;
  g.lineWidth = Math.max(0.11, hair(band) * 3);
  g.beginPath();
  for (const s of [-1, 1] as const) {
    const a = Math.PI - (s * spread * Math.PI) / 180;
    g.moveTo(axle - 0.15, 0);
    g.lineTo(axle - 0.15 + Math.cos(a) * trail, Math.sin(a) * trail);
  }
  g.stroke();
  if (d.d1) {
    g.fillStyle = c.steel;
    for (const s of [-1, 1] as const) {
      const a = Math.PI - (s * spread * Math.PI) / 180;
      const ex = axle - 0.15 + Math.cos(a) * trail;
      const ey = Math.sin(a) * trail;
      g.beginPath();
      g.arc(ex, ey, 0.1, 0, TAU);
      g.fill();
    }
  }
  // wheels, forward of the axle when limbered
  const wy = heavy ? 0.82 : 0.74;
  wheel(g, band, axle + (packed ? 0.5 : 0), -wy, 0.42, c, d);
  wheel(g, band, axle + (packed ? 0.5 : 0), wy, 0.42, c, d);
  // shield: a plate across the front with a bevel and a sight notch
  if (!packed) {
    // Forward of the axle, spanning the full width: a shield tucked between
    // the wheels is invisible from above, which is where this game looks from.
    const sx = 0.52;
    plate(g, band, c.mount, d, () => g.rect(sx, -0.88, 0.18, 1.76));
    if (d.d1) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(sx, -0.36, 0.18, 0.13); // gunner's sight notch
      bolts(g, band, sx + 0.09, -0.74, sx + 0.09, 0.74, 5, d);
    }
  }
  // breech at the trail junction, recuperator riding above the barrel
  g.fillStyle = c.steel;
  roundRectPath(g, axle - 0.22, -0.22, 0.5, 0.44, 0.06);
  g.fill();
  if (d.d1) weld(g, band, () => roundRectPath(g, axle - 0.22, -0.22, 0.5, 0.44, 0.06));
  tube(g, band, axle + 0.1, 0, axle + barrel, 0, heavy ? 0.17 : 0.14, c, d);
  if (d.d1) tube(g, band, axle + 0.15, -0.2, axle + barrel * 0.45, -0.2, 0.13, c, d); // recuperator
  if (heavy && !packed) {
    // two-baffle muzzle brake; the 57 mm keeps a plain bore
    g.fillStyle = c.steel;
    g.fillRect(axle + barrel - 0.42, -0.16, 0.16, 0.32);
    g.fillRect(axle + barrel - 0.16, -0.16, 0.16, 0.32);
  }
  if (packed || !d.d1) return;
  crate(g, band, -0.75, 0.95, 0.5, 0.35, c, d);
  crate(g, band, -1.25, 0.98, 0.5, 0.35, c, d);
  if (!d.d2) return;
  g.fillStyle = c.brass;
  for (let i = 0; i < 3; i++) {
    g.save();
    g.translate(-0.35 + i * 0.26, 1.05 + (i % 2) * 0.14);
    g.rotate(0.5 + i * 0.7);
    g.fillRect(-0.11, -0.035, 0.22, 0.07);
    g.restore();
  }
}

// --- Packed loads -----------------------------------------------------------

// A man-packable weapon that is not set up is a pile of bundles on the ground:
// one per load the def declares, so a tripod team's pile differs from a mortar
// team's without a second table.
function drawLoadPile(g: Ctx, band: number, c: Palette, d: Detail, kind: EmplacementKey): void {
  const loads = EMPLACEMENTS[kind].loads;
  loads.forEach((l, i) => {
    const x = -0.35 + i * 0.42;
    const y = i % 2 === 0 ? -0.12 : 0.16;
    if (l === 'mg_gun' || l === 'mortar_tube') {
      tube(g, band, x - 0.32, y, x + 0.32, y, 0.18, c, d);
    } else if (l === 'mortar_baseplate') {
      plate(g, band, c.mount, d, () => g.rect(x - 0.22, y - 0.22, 0.44, 0.44));
    } else if (l === 'ammo_cans' || l === 'shell_load') {
      ammoCan(g, band, x, y, c, d);
    } else {
      // tripod / Lafette: a folded bundle of legs
      g.strokeStyle = c.mount;
      g.lineCap = 'round';
      g.lineWidth = Math.max(0.07, hair(band) * 2);
      g.beginPath();
      for (let k = -1; k <= 1; k++) {
        g.moveTo(x - 0.3, y + k * 0.08);
        g.lineTo(x + 0.3, y + k * 0.08);
      }
      g.stroke();
      g.lineCap = 'butt';
    }
  });
}

function drawWeapon(g: Ctx, kind: EmplacementKey, band: number, c: Palette, state: EmplacementState, d: Detail): void {
  const packed = state === 'packed';
  switch (kind) {
    case 'm1919_tripod':
      if (packed) drawLoadPile(g, band, c, d, kind);
      else drawTripodMG(g, band, c, d, false);
      break;
    case 'mg42_lafette':
      if (packed) drawLoadPile(g, band, c, d, kind);
      else drawTripodMG(g, band, c, d, true);
      break;
    case 'mortar60':
      if (packed) drawLoadPile(g, band, c, d, kind);
      else drawMortar(g, band, c, d, false);
      break;
    case 'mortar81':
      if (packed) drawLoadPile(g, band, c, d, kind);
      else drawMortar(g, band, c, d, true);
      break;
    case 'at57':
      drawATGun(g, band, c, d, false, packed);
      break;
    default:
      drawATGun(g, band, c, d, true, packed);
  }
}

const cache = new SpriteCache(8 << 20);
const shadowCache = new SpriteCache(4 << 20);

export function emplacementCacheStats(): { entries: number; bytes: number } {
  return cache.stats();
}

export function getEmplacementSprite(kind: EmplacementKey, side: Side, state: EmplacementState, band: number): HTMLCanvasElement {
  const key = `${kind}|${side}|${state}|${band}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const span = emplacementSpan(kind);
  const px = Math.ceil(span * band);
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.translate(px / 2, px / 2);
  g.scale(band * artScale(kind), band * artScale(kind));
  const pal = LIVE[side];
  const d = detailFor(band, true);
  baseAO(g, kind);
  teamRing(g, 0, 0, mountRadius(kind), band, pal.rim);
  drawWeapon(g, kind, band, pal, state, d);
  cache.set(key, c);
  return c;
}

// Flat-ink silhouette for the world-aligned cast pass (U2). No side dimension:
// a PaK 40's shadow and a 57 mm's differ by geometry, not by paint.
const SHADOW_INK = 'rgba(20,16,10,1)';
const MONO: Palette = { steel: SHADOW_INK, steelLit: SHADOW_INK, mount: SHADOW_INK, wood: SHADOW_INK, brass: SHADOW_INK, rim: SHADOW_INK };
const SHADOW_BAKE_BAND = 24;

export function getEmplacementShadow(kind: EmplacementKey, state: EmplacementState, band: number): HTMLCanvasElement {
  const sb = Math.min(SHADOW_BAKE_BAND, band);
  const key = `${kind}|${state}|${sb}`;
  const hit = shadowCache.get(key);
  if (hit) return hit;
  const px = Math.ceil(emplacementSpan(kind) * sb);
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.translate(px / 2, px / 2);
  g.scale(sb * artScale(kind), sb * artScale(kind));
  // detail off: a weld seam and a brass belt are surface treatment, not
  // something that stands up into the light.
  drawWeapon(g, kind, sb, MONO, state, detailFor(sb, false));
  shadowCache.set(key, c);
  return c;
}
