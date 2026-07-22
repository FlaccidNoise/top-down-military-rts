import type { WeaponKey } from '../sim/data';
import type { Side } from '../sim/sim';

// Parametric vector soldier, drawn facing +X in meter units, baked into a
// per-(pose, frame, weapon, side, zoom-band) sprite cache. The renderer draws
// one rotated drawImage per soldier; rotation is free because top-down art has
// a single valid view angle.

export type Pose = 'idle' | 'walk' | 'aim' | 'prone' | 'downed' | 'dead';
export const WALK_FRAMES = 6;
export const SPRITE_SPAN = 3.6; // meters covered by the (square) sprite canvas
const DUDE_SCALE = 1.35; // genre-standard oversize so figures read at tactical zoom
export const SPRITE_MIN_SCALE = 5; // px/m; below this the renderer uses dot LOD

const BANDS = [6, 12, 24, 48]; // bake resolutions (px/m); never upscale on screen

export function bandFor(scale: number): number {
  return BANDS.find((b) => b >= scale) ?? 48;
}

type Ctx = CanvasRenderingContext2D;

interface Kit {
  uniform: string;
  sleeve: string; // slightly darker so limbs separate from the torso
  trousers: string;
  helmet: string;
  skin: string;
  outline: string; // team identity halo — the friend/foe read at a glance
}

const KITS: Record<Side, Kit> = {
  blue: { uniform: '#6d7a4e', sleeve: '#5c6841', trousers: '#5f6a44', helmet: '#5a6644', skin: '#c9a481', outline: 'rgba(100,155,225,0.9)' },
  red: { uniform: '#70746c', sleeve: '#5e625a', trousers: '#616459', helmet: '#53574d', skin: '#c9a481', outline: 'rgba(225,105,85,0.9)' },
};

function mix(hex: string, to: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const c = (i: number) => Math.round(p(hex, i) + (p(to, i) - p(hex, i)) * t);
  return `rgb(${c(1)},${c(3)},${c(5)})`;
}

function deadKit(k: Kit): Kit {
  const g = '#77746c';
  return {
    uniform: mix(k.uniform, g, 0.45),
    sleeve: mix(k.sleeve, g, 0.45),
    trousers: mix(k.trousers, g, 0.45),
    helmet: mix(k.helmet, g, 0.45),
    skin: mix(k.skin, g, 0.3),
    outline: k.outline.replace('0.9', '0.35'),
  };
}

function cap(g: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, color: string): void {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

function dot(g: Ctx, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

// Weapon drawn with grip at (x, y), muzzle toward +X (before `angle`).
function gun(g: Ctx, w: WeaponKey, x: number, y: number, angle: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  const len = w === 'rifle' ? 1.05 : w === 'smg' ? 0.62 : 1.25;
  const back = w === 'smg' ? 0.2 : 0.32;
  cap(g, -back, 0, -back * 0.25, 0, 0.1, '#5d4126'); // stock
  cap(g, -back * 0.25, 0, len - back, 0, w === 'mg' ? 0.08 : 0.06, '#2b2b28');
  if (w === 'smg') cap(g, 0.1, 0.04, 0.1, 0.2, 0.06, '#2b2b28'); // magazine
  if (w === 'mg') cap(g, len - back - 0.12, -0.14, len - back - 0.12, 0.14, 0.045, '#232320'); // bipod
  g.restore();
}

function helmet(g: Ctx, k: Kit, x: number, y: number): void {
  dot(g, x, y, 0.175, k.helmet);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 0.035;
  g.beginPath();
  g.arc(x, y, 0.165, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.beginPath();
  g.arc(x - 0.045, y - 0.045, 0.1, 0, Math.PI * 2);
  g.fill();
}

function torsoStraps(g: Ctx): void {
  cap(g, -0.1, -0.17, 0.14, -0.09, 0.05, 'rgba(42,36,24,0.5)');
  cap(g, -0.1, 0.17, 0.14, 0.09, 0.05, 'rgba(42,36,24,0.5)');
}

// Shared standing body: legSwing in [-1,1] (0 = feet hidden under torso).
function standing(g: Ctx, k: Kit, w: WeaponKey, gunAngle: number, legSwing: number, lean: number): void {
  if (legSwing !== 0) {
    for (const side of [-1, 1] as const) {
      const lx = side * legSwing * 0.34;
      cap(g, lx * 0.35, side * 0.13, lx, side * 0.13, 0.13, k.trousers);
      dot(g, lx, side * 0.13, 0.07, '#3a3128');
    }
  }
  // team silhouette halo under the body
  g.fillStyle = k.outline;
  g.beginPath();
  g.ellipse(0, 0, 0.27, 0.37, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = k.uniform;
  g.beginPath();
  g.ellipse(0, 0, 0.22, 0.31, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 0.035;
  g.stroke();
  torsoStraps(g);
  // arms to the weapon
  const gx = 0.14;
  const gy = 0.13;
  const fore = w === 'smg' ? 0.24 : 0.38;
  const fx = gx + Math.cos(gunAngle) * fore;
  const fy = gy + Math.sin(gunAngle) * fore;
  cap(g, 0.02, 0.24, gx, gy, 0.12, k.sleeve);
  cap(g, 0.02, -0.24, fx, fy, 0.12, k.sleeve);
  gun(g, w, gx, gy, gunAngle);
  dot(g, gx, gy, 0.055, k.skin);
  dot(g, fx, fy, 0.055, k.skin);
  helmet(g, k, 0.04 + lean, 0);
}

function proneBody(g: Ctx, k: Kit, legs: [number, number, number, number][]): void {
  for (const [x0, y0, x1, y1] of legs) {
    cap(g, x0, y0, x1, y1, 0.14, k.trousers);
    dot(g, x1, y1, 0.075, '#3a3128');
  }
  cap(g, -0.5, 0, 0.28, 0, 0.52, k.outline);
  cap(g, -0.5, 0, 0.28, 0, 0.42, k.uniform);
  cap(g, -0.28, -0.14, -0.05, -0.1, 0.05, 'rgba(42,36,24,0.5)');
  cap(g, -0.28, 0.14, -0.05, 0.1, 0.05, 'rgba(42,36,24,0.5)');
}

function prone(g: Ctx, k: Kit, w: WeaponKey): void {
  proneBody(g, k, [
    [-0.45, -0.08, -0.92, -0.19],
    [-0.45, 0.08, -0.92, 0.19],
  ]);
  cap(g, 0.12, 0.24, 0.5, 0.12, 0.12, k.sleeve);
  cap(g, 0.15, -0.24, 0.58, -0.04, 0.12, k.sleeve);
  gun(g, w, 0.5, 0.05, 0);
  dot(g, 0.5, 0.1, 0.055, k.skin);
  dot(g, 0.58, -0.04, 0.055, k.skin);
  helmet(g, k, 0.42, 0);
}

function downed(g: Ctx, k: Kit, w: WeaponKey): void {
  gun(g, w, 0.25, 0.45, 0.5); // weapon dropped
  proneBody(g, k, [
    [-0.45, 0.02, -0.88, 0.06],
    [-0.45, 0.12, -0.9, 0.24],
  ]);
  cap(g, 0.12, -0.2, 0.52, -0.28, 0.12, k.uniform); // one arm reaching out
  dot(g, 0.52, -0.28, 0.055, k.skin);
  helmet(g, k, 0.42, 0.05);
}

function dead(g: Ctx, k: Kit, w: WeaponKey): void {
  gun(g, w, -0.05, -0.5, -2.7); // weapon flung
  for (const [x0, y0, x1, y1] of [
    [-0.42, 0.08, -0.92, 0.32],
    [-0.4, -0.05, -0.82, -0.28],
  ] as const) {
    cap(g, x0, y0, x1, y1, 0.14, k.trousers);
    dot(g, x1, y1, 0.075, '#3a3128');
  }
  cap(g, -0.48, 0, 0.24, 0.12, 0.52, k.outline);
  cap(g, -0.48, 0, 0.24, 0.12, 0.42, k.uniform);
  cap(g, 0.15, -0.05, 0.5, -0.42, 0.12, k.sleeve); // arms flung
  cap(g, 0.08, 0.25, 0.28, 0.52, 0.12, k.sleeve);
  dot(g, 0.5, -0.42, 0.055, k.skin);
  dot(g, 0.28, 0.52, 0.055, k.skin);
  dot(g, 0.42, 0.12, 0.14, k.skin); // bare head, helmet rolled away
  dot(g, 0.46, 0.09, 0.1, '#5a4632');
  dot(g, 0.7, -0.18, 0.16, k.helmet);
}

function drawDude(g: Ctx, side: Side, weapon: WeaponKey, pose: Pose, frame: number): void {
  const k = KITS[side];
  switch (pose) {
    case 'idle':
      standing(g, k, weapon, -0.55, 0, 0);
      break;
    case 'aim':
      standing(g, k, weapon, 0, 0, 0.05);
      break;
    case 'walk': {
      const swing = Math.sin((frame / WALK_FRAMES) * Math.PI * 2);
      standing(g, k, weapon, -0.3 + swing * 0.06, swing, 0.02);
      break;
    }
    case 'prone':
      prone(g, k, weapon);
      break;
    case 'downed':
      downed(g, k, weapon);
      break;
    case 'dead':
      dead(g, deadKit(k), weapon);
      break;
  }
}

const cache = new Map<string, HTMLCanvasElement>();

export function getSprite(side: Side, weapon: WeaponKey, pose: Pose, frame: number, band: number): HTMLCanvasElement {
  const key = `${side}|${weapon}|${pose}|${frame}|${band}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  const px = Math.ceil(SPRITE_SPAN * band);
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.translate(px / 2, px / 2);
  g.scale(band * DUDE_SCALE, band * DUDE_SCALE);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  drawDude(g, side, weapon, pose, frame);
  cache.set(key, c);
  return c;
}
