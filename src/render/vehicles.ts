import type { VehicleKey } from '../sim/data';
import type { Side } from '../sim/sim';

// Parametric vector tank, drawn facing +X in meter units, baked per
// (kind, side, state, zoom band) — same scheme as dudes.ts.

export const VEHICLE_SPAN = 8; // meters covered by the sprite canvas
const BANDS = [6, 12, 24, 48];

export function vehicleBandFor(scale: number): number {
  return BANDS.find((b) => b >= scale) ?? 48;
}

type State = 'ok' | 'dead';

const HULLS: Record<Side, { hull: string; deck: string; track: string; outline: string }> = {
  blue: { hull: '#5f6b3f', deck: '#6d7a4e', track: '#3a3a34', outline: 'rgba(100,155,225,0.9)' },
  red: { hull: '#5d6157', deck: '#70746c', track: '#35352f', outline: 'rgba(225,105,85,0.9)' },
};

const cache = new Map<string, HTMLCanvasElement>();

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

  const long = kind === 'sherman' ? 5.8 : 5.9; // hull length
  const wide = kind === 'sherman' ? 2.6 : 2.9;
  let { hull, deck, track, outline } = HULLS[side];
  if (state === 'dead') {
    hull = '#3c3a34';
    deck = '#46443c';
    track = '#2b2b27';
    outline = 'rgba(60,60,55,0.5)';
  }

  // team halo
  g.strokeStyle = outline;
  g.lineWidth = 0.22;
  g.strokeRect(-long / 2, -wide / 2, long, wide);
  // tracks
  g.fillStyle = track;
  g.fillRect(-long / 2, -wide / 2, long, 0.55);
  g.fillRect(-long / 2, wide / 2 - 0.55, long, 0.55);
  // hull
  g.fillStyle = hull;
  g.fillRect(-long / 2 + 0.2, -wide / 2 + 0.5, long - 0.4, wide - 1);
  // glacis hint
  g.fillStyle = deck;
  g.fillRect(long / 2 - 1.1, -wide / 2 + 0.55, 0.85, wide - 1.1);
  // turret + barrel
  g.fillStyle = deck;
  g.beginPath();
  g.arc(-0.2, 0, kind === 'sherman' ? 1.05 : 1.15, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = state === 'dead' ? '#2f2e29' : '#2b2b28';
  g.lineWidth = 0.16;
  g.beginPath();
  g.moveTo(0.6, 0);
  g.lineTo(0.6 + (kind === 'sherman' ? 2.4 : 2.9), 0);
  g.stroke();
  // hatch
  g.fillStyle = state === 'dead' ? '#2f2e29' : track;
  g.beginPath();
  g.arc(-0.5, 0, 0.28, 0, Math.PI * 2);
  g.fill();
  if (state === 'dead') {
    // scorch
    g.fillStyle = 'rgba(20,18,15,0.55)';
    g.beginPath();
    g.arc(-0.2, 0, 1.6, 0, Math.PI * 2);
    g.fill();
  }

  cache.set(key, c);
  return c;
}
