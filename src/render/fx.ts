import type { WeaponKey } from '../sim/data';
import { EDGE, type GameMap } from '../sim/map';
import { SUN, WIND as LIGHT_WIND } from './light';
import { hash } from './noise';

// Baked particle atlas — the effects layer's answer to dudes.ts/getSprite.
// Every transient used to build a live `createRadialGradient` per particle per
// frame; gradients are not cached by any browser, so a busy explosion paid for
// dozens of them. Here the expensive art is baked once at two fixed pixel
// sizes and the frame loop is nothing but `drawImage` + transforms.
//
// Bake-time randomness comes from `hash`, not `Math.random`: the static art
// gate re-shoots the same scene across page loads, and a chunk that changes
// silhouette per reload would show up as an art regression.

export type FxKind =
  | 'smoke'
  | 'dustTan'
  | 'masonry'
  | 'soot'
  | 'flash'
  | 'fire'
  | 'ringTan'
  | 'ringDark'
  | 'spark'
  | 'leaf'
  | 'chunk0'
  | 'chunk1'
  | 'chunk2'
  | 'chunk3'
  | 'pock0'
  | 'pock1'
  | 'pock2'
  | 'pock3';

// The sun model (light.ts) owns the direction of *light*; this owns the
// direction of *air*. They are deliberately different axes — SUN falls SE,
// WIND blows ENE — so smoke lean and cast shadows never collapse the scene
// into one big diagonal.
export const WIND = { dx: LIGHT_WIND.dx, dy: LIGHT_WIND.dy, speed: 1.6 };

// Detail tier by zoom: 2 = full (pockmarks, per-lick flame), 1 = mid (chunks,
// sparks, plumes), 0 = silhouette only (fireball + smoke mass). Every effect
// multiplies its particle count by the tier, so a zoomed-out battle never pays
// for sub-pixel detail.
export function fxDetail(scale: number): 0 | 1 | 2 {
  return scale >= 24 ? 2 : scale >= 10 ? 1 : 0;
}

// Every additive draw batches into one call per frame, so the composite mode
// flips twice rather than once per particle.
export function hotPass(ctx: CanvasRenderingContext2D, f: () => void): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  f();
  ctx.restore();
}

// Top-down 3D cheat: ground distance travelled and height above ground at t
// seconds. Ground position = origin + dir*dist, sprite at (sx, sy - z*scale),
// shadow ellipse stays at (sx, sy). Serves debris chunks and wall spall.
export function ballistic(t: number, v: number, vz: number): [number, number] {
  return [v * t, Math.max(0, vz * t - 4.9 * t * t)];
}

// Muzzle-signature classes. Deliberately NOT WEAPONS[w].class — data.ts files
// bazooka, panzerfaust, mortar60 and pak40_gun all under `rifle`, which would
// give a Panzerfaust a rifle's flash. This table is about what the weapon
// looks like when it goes off, not what the sim treats it as.
export type FlashClass = 'rifle' | 'smg' | 'mg' | 'rocket' | 'cannon';

const FLASH_CLASS: Record<WeaponKey, FlashClass> = {
  garand: 'rifle',
  carbine: 'rifle',
  bar: 'rifle',
  springfield: 'rifle',
  kar98k: 'rifle',
  kar98k_scoped: 'rifle',
  thompson: 'smg',
  mp40: 'smg',
  m1919: 'mg',
  mg42: 'mg',
  bazooka: 'rocket',
  schreck: 'rocket',
  panzerfaust: 'rocket',
  mortar60: 'cannon',
  mortar81: 'cannon',
  at57_gun: 'cannon',
  pak40_gun: 'cannon',
};

export interface FlashSpec {
  r: number; // flash radius, meters
  spikes: number;
  len: number; // spike length as a multiple of r
  spread: number; // rad off the bearing at full deflection
  life: number; // ms
  tracerW: number; // px, the always-drawn faint thread
  tracerCol: string;
  extra?: 'double' | 'backblast' | 'wash';
  tracerOdds: number; // fraction of rounds that carry a visible tracer
}

export const FLASH: Record<FlashClass, FlashSpec> = {
  rifle: { r: 0.3, spikes: 2, len: 1.35, spread: 0.42, life: 50, tracerW: 1, tracerCol: '255,240,210', tracerOdds: 0.2 },
  smg: { r: 0.22, spikes: 3, len: 1, spread: 0.8, life: 38, tracerW: 1, tracerCol: '255,236,200', tracerOdds: 0.2 },
  mg: { r: 0.42, spikes: 3, len: 1.8, spread: 0.3, life: 70, tracerW: 2, tracerCol: '255,214,140', extra: 'double', tracerOdds: 0.34 },
  rocket: { r: 0.7, spikes: 0, len: 0, spread: 0, life: 90, tracerW: 2, tracerCol: '255,222,170', extra: 'backblast', tracerOdds: 1 },
  cannon: { r: 0.85, spikes: 2, len: 1.5, spread: 0.5, life: 110, tracerW: 2, tracerCol: '255,226,180', extra: 'wash', tracerOdds: 1 },
};

// Undefined weapon is a vehicle cannon / AP round (sim.ts pairs those with a
// boom), so it inherits the cannon signature.
export function flashClass(w: WeaponKey | undefined): FlashClass {
  return w ? FLASH_CLASS[w] : 'cannon';
}

// Spike deflections by count — never a symmetric fan, which is what made the
// old three-equal-spikes flash read as a UI arrowhead.
export const SPIKE_SIDES: number[][] = [[], [0], [0.65, -1], [0, 1, -0.75]];

export interface Overshoot {
  kind: 'wall' | 'foliage' | 'ground';
  x: number;
  y: number;
  nx: number; // surface normal, pointing back toward the shooter (wall only)
  ny: number;
}

const OVER_STEP = 0.25;
const OVER_MAX = 12;

// Where a missed round actually ends up. The sim clears LOS before firing, so
// there is never a full wall between shooter and target — a miss has to be
// resolved PAST the target, not at its feet. Marching outward from the target
// finds the masonry, hedge or open dirt the round really strikes.
//
// Edge crossings use map.ts `canStep`'s convention exactly: the vEdge between
// columns a and a+1 is vEdge(a+1, row); the hEdge between rows b and b+1 is
// hEdge(col, b+1). Getting this wrong lands every pockmark one tile off.
export function traceOvershoot(map: GameMap, fx: number, fy: number, tx: number, ty: number, h: number): Overshoot {
  const a = Math.atan2(ty - fy, tx - fx) + (h - 0.5) * 0.08;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let px = Math.floor(tx);
  let py = Math.floor(ty);
  for (let i = 1; i <= OVER_MAX / OVER_STEP; i++) {
    const d = i * OVER_STEP;
    const wx = tx + dx * d;
    const wy = ty + dy * d;
    const cx = Math.floor(wx);
    const cy = Math.floor(wy);
    if (cx !== px) {
      const e = map.vEdge(Math.max(px, cx), py);
      if (e === EDGE.WALL || e === EDGE.WINDOW) return { kind: 'wall', x: Math.max(px, cx), y: wy, nx: -Math.sign(dx), ny: 0 };
    }
    if (cy !== py) {
      const e = map.hEdge(cx, Math.max(py, cy));
      if (e === EDGE.WALL || e === EDGE.WINDOW) return { kind: 'wall', x: wx, y: Math.max(py, cy), nx: 0, ny: -Math.sign(dy) };
    }
    px = cx;
    py = cy;
    if (!map.inBounds(cx, cy)) break;
    const k = map.terrainKeyAt(cx, cy);
    if (k === 'hedge' || k === 'woods') return { kind: 'foliage', x: wx, y: wy, nx: -dx, ny: -dy };
  }
  const d = 1.5 + h * 2.5;
  return { kind: 'ground', x: tx + dx * d, y: ty + dy * d, nx: -dx, ny: -dy };
}

type Ctx = CanvasRenderingContext2D;

const BAKE_SMALL = 32;
const BAKE_LARGE = 96;
const cache = new Map<string, HTMLCanvasElement>();

function getFx(kind: FxKind, px: number): HTMLCanvasElement {
  const band = px <= 48 ? BAKE_SMALL : BAKE_LARGE;
  const key = `${kind}|${band}`;
  let c = cache.get(key);
  if (!c) {
    c = bake(kind, band);
    cache.set(key, c);
  }
  return c;
}

// One centered drawImage at 2*rPx square. save/rotate/restore only when the
// caller actually needs a rotation (chunks, pockmarks, leaves).
export function blit(ctx: Ctx, kind: FxKind, sx: number, sy: number, rPx: number, alpha: number, rot = 0): void {
  if (alpha <= 0.004 || rPx <= 0.2) return;
  const d = rPx * 2;
  const spr = getFx(kind, d);
  ctx.globalAlpha = alpha < 1 ? alpha : 1;
  if (rot !== 0) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(rot);
    ctx.drawImage(spr, -rPx, -rPx, d, d);
    ctx.restore();
  } else {
    ctx.drawImage(spr, sx - rPx, sy - rPx, d, d);
  }
  ctx.globalAlpha = 1;
}

function newCanvas(px: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  return [c, c.getContext('2d')!];
}

// Ambient haze band (FX7). Not part of the square particle atlas: a band is a
// long horizontal smear, so it bakes once at 256x64 and stretches to whatever
// world length the band wants. A full-viewport wash would be both more fill
// and flatter — the whole point is that the air is lumpy and only in places.
const HAZE_W = 256;
const HAZE_H = 64;
const HAZE_RGB = '201,196,180';
let hazeCache: HTMLCanvasElement | null = null;

export function hazeBand(): HTMLCanvasElement {
  if (hazeCache) return hazeCache;
  const c = document.createElement('canvas');
  c.width = HAZE_W;
  c.height = HAZE_H;
  const g = c.getContext('2d')!;
  const body = g.createLinearGradient(0, 0, 0, HAZE_H);
  body.addColorStop(0, `rgba(${HAZE_RGB},0)`);
  body.addColorStop(0.5, `rgba(${HAZE_RGB},1)`);
  body.addColorStop(1, `rgba(${HAZE_RGB},0)`);
  g.fillStyle = body;
  g.fillRect(0, 0, HAZE_W, HAZE_H);
  // Lumps and thin patches, both composited against the band's own alpha so
  // neither can put a hard edge outside the feathered envelope.
  for (let i = 0; i < 12; i++) {
    const bx = hash(i, 0, 250) * HAZE_W;
    const by = (0.2 + hash(i, 1, 251) * 0.6) * HAZE_H;
    const br = (0.12 + hash(i, 2, 252) * 0.22) * HAZE_W;
    const thin = i % 2 === 1;
    g.globalCompositeOperation = thin ? 'destination-out' : 'source-atop';
    radial(g, bx, by, br, [
      [0, `rgba(${HAZE_RGB},${thin ? 0.45 : 0.4})`],
      [1, `rgba(${HAZE_RGB},0)`],
    ]);
  }
  // Feather both ends so a drifting band never slides a vertical cut across
  // the field.
  g.globalCompositeOperation = 'destination-in';
  const ends = g.createLinearGradient(0, 0, HAZE_W, 0);
  ends.addColorStop(0, 'rgba(0,0,0,0)');
  ends.addColorStop(0.22, 'rgba(0,0,0,1)');
  ends.addColorStop(0.78, 'rgba(0,0,0,1)');
  ends.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = ends;
  g.fillRect(0, 0, HAZE_W, HAZE_H);
  g.globalCompositeOperation = 'source-over';
  hazeCache = c;
  return c;
}

function radial(g: Ctx, cx: number, cy: number, r: number, stops: [number, string][]): void {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
}

// Cauliflower silhouette: one broad core plus three offset lobes. A single
// clean radial disc is the tell that a puff is a gradient; the lumps are what
// make a mass of smoke read as volume at any size.
function puff(g: Ctx, px: number, rgb: string, salt: number): void {
  const h = px / 2;
  radial(g, h, h, h, [
    [0, `rgba(${rgb},1)`],
    [0.6, `rgba(${rgb},0.55)`],
    [1, `rgba(${rgb},0)`],
  ]);
  for (let i = 0; i < 3; i++) {
    const a = hash(i, salt, 3) * Math.PI * 2;
    const d = (0.18 + hash(i, salt, 4) * 0.22) * h;
    const r = (0.42 + hash(i, salt, 5) * 0.26) * h;
    radial(g, h + Math.cos(a) * d, h + Math.sin(a) * d, r, [
      [0, `rgba(${rgb},0.5)`],
      [0.65, `rgba(${rgb},0.26)`],
      [1, `rgba(${rgb},0)`],
    ]);
  }
}

// Annulus: transparent hole, opaque wall at 0.80, feathered out to the rim.
// Blitting a scaled sprite is what keeps a shockwave soft — a `stroke()`d
// circle of constant lineWidth is the arcade read this replaces.
function ring(g: Ctx, px: number, rgb: string): void {
  const h = px / 2;
  radial(g, h, h, h, [
    [0, `rgba(${rgb},0)`],
    [0.62, `rgba(${rgb},0)`],
    [0.8, `rgba(${rgb},1)`],
    [1, `rgba(${rgb},0)`],
  ]);
}

// Irregular 5-7 vertex fragment, dark earth body with a NW-lit top facet so
// tumbling debris still obeys the one sun.
function chunk(g: Ctx, px: number, variant: number): void {
  const h = px / 2;
  const n = 5 + Math.floor(hash(variant, 0, 11) * 3);
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = h * (0.55 + hash(variant, i, 12) * 0.42);
    const x = h + Math.cos(a) * r;
    const y = h + Math.sin(a) * r * 0.82;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = '#3b3226';
  g.fill();
  g.strokeStyle = '#241f18';
  g.lineWidth = Math.max(1, px / 24);
  g.stroke();
  g.save();
  g.clip();
  g.fillStyle = 'rgba(122,110,86,0.5)';
  g.beginPath();
  g.ellipse(h - SUN.dx * h * 0.35, h - SUN.dy * h * 0.35, h * 0.5, h * 0.32, -0.5, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// Bullet strike in masonry: dark irregular core, a pale spall crescent thrown
// OPPOSITE the sun so every chip catches the same light, plus two chips.
function pock(g: Ctx, px: number, variant: number): void {
  const h = px / 2;
  const core = h * 0.62;
  g.fillStyle = 'rgba(210,204,188,0.5)';
  g.beginPath();
  g.ellipse(h - SUN.dx * core * 0.5, h - SUN.dy * core * 0.5, core * 1.05, core * 0.9, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + hash(variant, i, 21) * 0.5;
    const r = core * (0.6 + hash(variant, i, 22) * 0.5);
    const x = h + Math.cos(a) * r;
    const y = h + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = 'rgba(28,22,16,0.72)';
  g.fill();
  g.fillStyle = 'rgba(38,31,23,0.45)';
  for (let i = 0; i < 2; i++) {
    const a = hash(variant, i, 23) * Math.PI * 2;
    const d = core * (1.1 + hash(variant, i, 24) * 0.5);
    g.beginPath();
    g.arc(h + Math.cos(a) * d, h + Math.sin(a) * d, px * 0.045, 0, Math.PI * 2);
    g.fill();
  }
}

function bake(kind: FxKind, px: number): HTMLCanvasElement {
  const [c, g] = newCanvas(px);
  const h = px / 2;
  switch (kind) {
    case 'smoke':
      puff(g, px, '152,154,152', 1);
      break;
    case 'dustTan':
      puff(g, px, '150,130,100', 2);
      break;
    case 'masonry':
      puff(g, px, '196,190,176', 3);
      break;
    case 'soot':
      puff(g, px, '34,31,27', 4);
      break;
    case 'flash':
      radial(g, h, h, h, [
        [0, 'rgba(255,252,238,1)'],
        [0.45, 'rgba(255,196,96,0.5)'],
        [1, 'rgba(255,150,40,0)'],
      ]);
      break;
    case 'fire':
      radial(g, h, h, h, [
        [0, 'rgba(255,186,84,1)'],
        [0.5, 'rgba(214,96,32,0.6)'],
        [1, 'rgba(178,66,18,0)'],
      ]);
      for (let i = 0; i < 3; i++) {
        const a = hash(i, 7, 8) * Math.PI * 2;
        const d = (0.16 + hash(i, 7, 9) * 0.2) * h;
        const r = (0.36 + hash(i, 7, 10) * 0.24) * h;
        radial(g, h + Math.cos(a) * d, h + Math.sin(a) * d, r, [
          [0, 'rgba(255,214,132,0.55)'],
          [0.7, 'rgba(226,118,44,0.25)'],
          [1, 'rgba(200,90,30,0)'],
        ]);
      }
      break;
    case 'ringTan':
      ring(g, px, '150,112,72');
      break;
    case 'ringDark':
      ring(g, px, '30,24,16');
      break;
    case 'spark':
      radial(g, h, h, h, [
        [0, 'rgba(255,248,222,1)'],
        [0.3, 'rgba(255,204,110,0.8)'],
        [0.7, 'rgba(238,132,44,0.24)'],
        [1, 'rgba(220,100,30,0)'],
      ]);
      break;
    case 'leaf': {
      g.save();
      g.translate(h, h);
      g.fillStyle = '#5b6b3c';
      g.beginPath();
      g.ellipse(0, 0, h * 0.82, h * 0.34, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(40,50,28,0.8)';
      g.lineWidth = Math.max(1, px / 32);
      g.beginPath();
      g.moveTo(-h * 0.8, 0);
      g.lineTo(h * 0.8, 0);
      g.stroke();
      g.restore();
      break;
    }
    default:
      if (kind.startsWith('chunk')) chunk(g, px, Number(kind.slice(5)));
      else pock(g, px, Number(kind.slice(4)));
  }
  return c;
}
