import { VEHICLES, type VehicleKey } from '../sim/data';
import type { Side } from '../sim/sim';
import { SHADOW_ALPHA, shadowOffset } from './light';
import { SpriteCache } from './spritecache';

// Parametric vector tank, drawn facing +X in meter units, baked per
// (kind, side, state, zoom band) — same scheme as dudes.ts.

export const VEHICLE_SPAN = 8; // meters covered by the sprite canvas
const BANDS = [6, 12, 24, 48];

export function vehicleBandFor(scale: number): number {
  return BANDS.find((b) => b >= scale) ?? 48;
}

// One device pixel in metres: the vehicle bake ctx is scaled by band alone
// (no DUDE_SCALE oversize), so panel lines clamp against this.
function hair(band: number): number {
  return 1 / band;
}

type State = 'ok' | 'dead';
type Ctx = CanvasRenderingContext2D;

interface Palette {
  hullTop: string; // upper deck plate — lighter, catches the light
  hullSide: string; // hull base / vertical armor — darker
  deck: string; // glacis, turret roof, casemate plate
  track: string;
  trackLink: string;
  rim: string; // team-color rim
  metalDark: string; // barrel, hatch, mantlet
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
  },
  red: {
    hullTop: '#6a6d63',
    hullSide: '#4c4e46',
    deck: '#60625a',
    track: '#35352f',
    trackLink: '#201f1c',
    rim: 'rgba(225,105,85,0.9)',
    metalDark: '#2b2b28',
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

function roundRectPath(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

// Soft ambient blob offset toward the sun, baked as the bottom layer so it
// rotates with the hull — an approximation, but the ground under a vehicle
// never shows a true world-aligned shadow at this render scale.
function hullShadow(g: Ctx, long: number, wide: number): void {
  const [dx, dy] = shadowOffset(long * 0.22);
  g.fillStyle = `rgba(14,13,10,${SHADOW_ALPHA})`;
  g.beginPath();
  g.ellipse(dx, dy, long / 2 + 0.15, wide / 2 + 0.12, 0, 0, Math.PI * 2);
  g.fill();
}

// Team-color rim: strong at close bake bands (6/12), a whisper at the far
// ones (24/48) — same "everyone doesn't look selected" fix as the soldiers.
function teamRim(g: Ctx, long: number, wide: number, band: number, color: string): void {
  const strong = band <= 12;
  g.save();
  g.globalAlpha = strong ? 1 : 0.35;
  g.strokeStyle = color;
  g.lineWidth = strong ? 0.16 : 0.07;
  const pad = 0.14;
  roundRectPath(g, -long / 2 - pad, -wide / 2 - pad, long + pad * 2, wide + pad * 2, 0.4);
  g.stroke();
  g.restore();
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
  for (let x = x0 + step / 2; x < x1; x += step) {
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
    g.arc(x, y, 0.09, 0, Math.PI * 2);
    g.fill();
  }
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

function star(g: Ctx, x: number, y: number, r: number, color: string): void {
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

function turret(g: Ctx, cx: number, cy: number, r: number, deck: string, dark: string, barrelLen: number, cupola: boolean): void {
  g.fillStyle = deck;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 0.035;
  g.stroke();
  // mantlet stub at the barrel root
  g.fillStyle = dark;
  g.beginPath();
  g.ellipse(cx + r * 0.65, cy, r * 0.34, r * 0.26, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = dark;
  g.lineWidth = r * 0.28;
  g.beginPath();
  g.moveTo(cx + r * 0.75, cy);
  g.lineTo(cx + r + barrelLen, cy);
  g.stroke();
  if (cupola) {
    g.fillStyle = dark;
    g.beginPath();
    g.arc(cx - r * 0.35, cy, r * 0.24, 0, Math.PI * 2);
    g.fill();
  }
}

// Burnt two-tone finish: char-dark base palette (DEAD) plus a couple of
// fixed ash-grey patches on top — deterministic, no per-instance variety needed.
function ashPatches(g: Ctx, long: number, wide: number): void {
  g.fillStyle = 'rgba(150,146,134,0.28)';
  g.beginPath();
  g.ellipse(-long * 0.18, -wide * 0.12, long * 0.16, wide * 0.22, 0.3, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(long * 0.22, wide * 0.16, long * 0.13, wide * 0.18, -0.4, 0, Math.PI * 2);
  g.fill();
}

function drawSherman(g: Ctx, c: Palette, wreck: boolean, long: number, wide: number): void {
  const half = long / 2;
  const trackH = 0.5;
  const topY = -wide / 2;
  const botY = wide / 2 - trackH;
  const gap: [number, number] | undefined = wreck ? [-0.6, 0.6] : undefined;
  const botOffset = wreck ? 0.14 : 0;
  g.fillStyle = c.hullSide;
  roundRectPath(g, -half, -wide / 2, long, wide, 0.5);
  g.fill();
  trackStrip(g, -half + 0.15, half - 0.15, topY, trackH, c.track, c.trackLink);
  trackStrip(g, -half + 0.15, half - 0.15, botY + botOffset, trackH, c.track, c.trackLink, gap);
  bogieDots(g, -half + 0.5, half - 0.5, topY + trackH / 2, 5, c.trackLink);
  bogieDots(g, -half + 0.5, half - 0.5, botY + trackH / 2 + botOffset, 5, c.trackLink);
  g.fillStyle = c.hullTop;
  roundRectPath(g, -half + 0.15, -wide / 2 + trackH, long - 0.3, wide - trackH * 2, 0.35);
  g.fill();
  grilleLines(g, -half + 0.35, -half + 1.3, -wide / 2 + trackH + 0.15, wide / 2 - trackH - 0.15, 4, c.hullSide);
  g.fillStyle = c.deck;
  roundRectPath(g, half - 1.1, -wide / 2 + trackH + 0.05, 0.85, wide - trackH * 2 - 0.1, 0.15);
  g.fill();
  const [jx, jy] = turretJolt(wreck);
  turret(g, -0.15 + jx, jy, 1.0, c.deck, c.metalDark, 2.3, false);
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.arc(half - 0.55, 0, 0.16, 0, Math.PI * 2);
  g.fill();
}

function drawPanzer4(g: Ctx, c: Palette, wreck: boolean, long: number, wide: number): void {
  const half = long / 2;
  const trackH = 0.5;
  const topY = -wide / 2;
  const botY = wide / 2 - trackH;
  const gap: [number, number] | undefined = wreck ? [-0.5, 0.5] : undefined;
  const botOffset = wreck ? -0.13 : 0;
  g.fillStyle = c.hullSide;
  g.fillRect(-half, -wide / 2, long, wide); // boxier — square corners, no round
  trackStrip(g, -half + 0.1, half - 0.1, topY, trackH, c.track, c.trackLink, gap);
  trackStrip(g, -half + 0.1, half - 0.1, botY + botOffset, trackH, c.track, c.trackLink);
  bogieDots(g, -half + 0.45, half - 0.45, topY + trackH / 2, 5, c.trackLink);
  bogieDots(g, -half + 0.45, half - 0.45, botY + trackH / 2 + botOffset, 5, c.trackLink);
  g.fillStyle = c.hullTop;
  g.fillRect(-half + 0.12, -wide / 2 + trackH, long - 0.24, wide - trackH * 2);
  // side-skirt (Schürzen) hint — short seam ticks along the track edges
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 0.04;
  g.beginPath();
  for (let x = -half + 0.5; x < half - 0.3; x += 0.55) {
    g.moveTo(x, topY + trackH + 0.02);
    g.lineTo(x, topY + trackH + 0.22);
    g.moveTo(x, botY - 0.02);
    g.lineTo(x, botY - 0.22);
  }
  g.stroke();
  g.fillStyle = c.deck;
  g.fillRect(half - 1.0, -wide / 2 + trackH + 0.05, 0.8, wide - trackH * 2 - 0.1);
  const [jx, jy] = turretJolt(wreck);
  turret(g, -0.1 + jx, jy, 0.95, c.deck, c.metalDark, 2.8, true);
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.arc(half - 0.5, 0, 0.15, 0, Math.PI * 2);
  g.fill();
}

function drawStug(g: Ctx, c: Palette, wreck: boolean, long: number, wide: number): void {
  const half = long / 2;
  const trackH = 0.5;
  const topY = -wide / 2;
  const botY = wide / 2 - trackH;
  const gap: [number, number] | undefined = wreck ? [-0.5, 0.4] : undefined;
  const botOffset = wreck ? 0.12 : 0;
  g.fillStyle = c.hullSide;
  g.fillRect(-half, -wide / 2, long, wide);
  trackStrip(g, -half + 0.1, half - 0.1, topY, trackH, c.track, c.trackLink);
  trackStrip(g, -half + 0.1, half - 0.1, botY + botOffset, trackH, c.track, c.trackLink, gap);
  bogieDots(g, -half + 0.45, half - 0.45, topY + trackH / 2, 5, c.trackLink);
  bogieDots(g, -half + 0.45, half - 0.45, botY + trackH / 2 + botOffset, 5, c.trackLink);
  g.fillStyle = c.hullTop;
  g.fillRect(-half + 0.12, -wide / 2 + trackH, long - 0.24, wide - trackH * 2);
  // low angular casemate — NO turret circle; sloped front plate
  g.fillStyle = c.deck;
  g.beginPath();
  g.moveTo(-half + 0.3, topY + trackH + 0.1);
  g.lineTo(half - 0.5, topY + trackH + 0.28);
  g.lineTo(half - 0.15, 0);
  g.lineTo(half - 0.5, botY - 0.28);
  g.lineTo(-half + 0.3, botY - 0.1);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 0.03;
  g.stroke();
  // gun mounted right of centerline, offset further on the wreck's jolt
  const gy = wreck ? 0.28 : 0.22;
  g.strokeStyle = c.metalDark;
  g.lineWidth = 0.16;
  g.beginPath();
  g.moveTo(half - 0.3, gy);
  g.lineTo(half + 2.5, gy);
  g.stroke();
  g.fillStyle = c.metalDark;
  g.beginPath();
  g.ellipse(half - 0.25, gy, 0.26, 0.2, 0, 0, Math.PI * 2);
  g.fill();
}

function drawHalftrack(g: Ctx, c: Palette, wreck: boolean, long: number, wide: number): void {
  const half = long / 2;
  const trackH = 0.42;
  const trackX0 = -half;
  const trackX1 = -half + long * 0.55;
  const gap: [number, number] | undefined = wreck ? [trackX0 + long * 0.16, trackX0 + long * 0.3] : undefined;
  const topOffset = wreck ? 0.1 : 0;
  trackStrip(g, trackX0 + 0.1, trackX1, -wide / 2 + topOffset, trackH, c.track, c.trackLink, gap);
  trackStrip(g, trackX0 + 0.1, trackX1, wide / 2 - trackH, trackH, c.track, c.trackLink);
  bogieDots(g, trackX0 + 0.4, trackX1 - 0.2, -wide / 2 + trackH / 2 + topOffset, 3, c.trackLink);
  bogieDots(g, trackX0 + 0.4, trackX1 - 0.2, wide / 2 - trackH / 2, 3, c.trackLink);
  // front road wheels
  g.fillStyle = c.trackLink;
  for (const s of [-1, 1] as const) {
    g.beginPath();
    g.arc(half - 0.5, s * (wide / 2 - 0.15), 0.32, 0, Math.PI * 2);
    g.fill();
  }
  // thin armor hull walls
  g.fillStyle = c.hullSide;
  g.fillRect(trackX0, -wide / 2, long, wide);
  // engine hood
  g.fillStyle = c.deck;
  g.fillRect(half - 1.3, -wide / 2 + 0.2, 1.15, wide - 0.4);
  // open bed: floor tone, bench line, crew helmet dots
  const bedX0 = trackX0 + 0.15;
  const bedX1 = half - 1.3;
  g.fillStyle = c.hullTop;
  g.fillRect(bedX0, -wide / 2 + 0.2, bedX1 - bedX0, wide - 0.4);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 0.03;
  g.strokeRect(bedX0, -wide / 2 + 0.2, bedX1 - bedX0, wide - 0.4);
  g.strokeStyle = c.hullSide;
  g.lineWidth = 0.06;
  g.beginPath();
  g.moveTo(bedX0 + 0.15, 0);
  g.lineTo(bedX1 - 0.1, 0);
  g.stroke();
  if (!wreck) {
    g.fillStyle = c.metalDark;
    for (const [hx, hy] of [
      [-0.6, -0.25],
      [0.3, 0.2],
      [-1.1, 0.15],
    ] as const) {
      g.beginPath();
      g.arc(hx, hy, 0.16, 0, Math.PI * 2);
      g.fill();
    }
  }
}

const VEHICLE_BUDGET = 24 << 20; // bytes; a band-48 hull canvas is ~590 KB, so this is a real ceiling
const cache = new SpriteCache(VEHICLE_BUDGET);

export function vehicleCacheStats(): { entries: number; bytes: number } {
  return cache.stats();
}

export function getVehicleSprite(kind: VehicleKey, side: Side, state: State, band: number): HTMLCanvasElement {
  const key = `${kind}|${side}|${state}|${band}`;
  const hit = cache.get(key);
  if (hit) return hit;

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

  hullShadow(g, long, wide);
  teamRim(g, long, wide, band, pal.rim);

  switch (kind) {
    case 'sherman':
      drawSherman(g, pal, wreck, long, wide);
      if (!wreck) star(g, -long / 2 + 1.05, 0, 0.3, '#e7e2d4');
      break;
    case 'panzer4':
      drawPanzer4(g, pal, wreck, long, wide);
      if (!wreck) balkenkreuz(g, -long / 2 + 1.05, 0, 0.34);
      break;
    case 'stug3':
      drawStug(g, pal, wreck, long, wide);
      if (!wreck) balkenkreuz(g, -long / 2 + 1.05, 0, 0.32);
      break;
    case 'm3_halftrack':
      drawHalftrack(g, pal, wreck, long, wide);
      break;
    default: {
      // Any future VehicleKey: bucket by its data rather than failing —
      // open-top transports read as a halftrack, restricted-arc guns as a
      // casemate, everything else as a generic turreted tank.
      const def = VEHICLES[kind];
      if (def.openTop) {
        drawHalftrack(g, pal, wreck, long, wide);
      } else if (typeof def.turret === 'number') {
        drawStug(g, pal, wreck, long, wide);
        if (!wreck) balkenkreuz(g, -long / 2 + 1.05, 0, 0.32);
      } else {
        drawPanzer4(g, pal, wreck, long, wide);
        if (!wreck && side === 'blue') star(g, -long / 2 + 1.05, 0, 0.3, '#e7e2d4');
        else if (!wreck) balkenkreuz(g, -long / 2 + 1.05, 0, 0.34);
      }
    }
  }

  if (wreck) ashPatches(g, long, wide);

  cache.set(key, c);
  return c;
}
