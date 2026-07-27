import { hash } from './noise';
import { shadowOffset, sun, sunStepFor } from './light';
import { stamp } from './stamps';
import type { Detail } from './terrain';

// Trees are the most-repeated art in the frame, and one circle plus one
// highlight circle plus a dark stroke is what made a stand read as bubble
// wrap. A canopy is a ragged cluster of lobes instead: cast shadow, a
// silhouette pass for the rim, the mass itself, deep SE shade and NW
// highlight from the shared sun, and gap flecks. That is ~30 path ops, which
// is only affordable baked — and baked it is ~1.3 µs a tree, so a dense woods
// chunk gets FASTER than the six-op version it replaces.

const SPRITE = 3; // meters; fits the lobes plus the SE cast shadow at k=1
const TAU = Math.PI * 2;

// Kept local rather than imported from terrain.ts: terrain imports this
// module, and a value import back would be a runtime cycle.
const FAMILY: { base: [number, number, number]; scale: number; light: number; orchard: boolean }[] = [
  { base: [52, 78, 42], scale: 1, light: 1, orchard: false },
  { base: [44, 68, 46], scale: 1, light: 1, orchard: false },
  { base: [66, 90, 52], scale: 0.8, light: 1.06, orchard: true },
];

function shade(base: [number, number, number], f: number): string {
  return `rgb(${Math.round(base[0] * f)},${Math.round(base[1] * f)},${Math.round(base[2] * f)})`;
}

export function canopySprite(family: 0 | 1 | 2, variant: number, band: number, d: Detail): HTMLCanvasElement {
  const fine = d >= 2;
  // The sprite reads the sun (cast direction, lit/shaded lobes), so its cache
  // key carries the step — pinned to 0 at far LOD bands with the terrain
  // chunks that blit it, which keeps the far-LOD sprite set from churning.
  return stamp(`canopy:${family}:${variant}:${fine ? 2 : 1}:${sunStepFor(band)}`, band, SPRITE, (g) => {
    const f = FAMILY[family];
    const R = 0.75 * f.scale;
    const C = SPRITE / 2;
    const [sx, sy] = shadowOffset(0.45);
    // Down-sun, the direction shade falls. At night the cast offset collapses
    // to zero length; the lobe shading then keys off the direction vector so
    // the canopy keeps a coherent (if moot, under the grade) light side.
    const sunA = sx === 0 && sy === 0 ? Math.atan2(sun().dir[1], sun().dir[0]) : Math.atan2(sy, sx);
    if (f.orchard) {
      // planted tree standing in worked earth, not lawn
      g.fillStyle = 'rgba(120,102,70,0.20)';
      g.beginPath();
      g.arc(C, C, 0.55, 0, TAU);
      g.fill();
    }
    const n = 6 + ((hash(variant, family, 250) * 3) | 0);
    const lobes: [number, number, number, number][] = []; // x, y, r, angle
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (hash(variant, family * 16 + i, 251) - 0.5) * 0.9;
      const dist = (0.3 + hash(variant, family * 16 + i, 252) * 0.2) * R * (f.orchard ? 0.72 : 1);
      const r = (0.34 + hash(variant, family * 16 + i, 253) * 0.24) * R * (f.orchard ? 1.12 : 1);
      lobes.push([C + Math.cos(a) * dist, C + Math.sin(a) * dist, r, a]);
    }
    const blob = (lx: number, ly: number, lr: number) => {
      g.beginPath();
      g.arc(lx, ly, lr, 0, TAU);
      g.fill();
    };
    g.fillStyle = `rgba(10,16,8,${0.28 * sun().alphaMul})`;
    for (const [lx, ly, lr] of lobes) blob(lx + sx, ly + sy, lr);
    // one silhouette pass at 1.06x gives the whole cluster a clean dark rim
    // for the price of a single extra fill — cheaper and far less busy than
    // stroking every lobe
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (const [lx, ly, lr] of lobes) blob(C + (lx - C) * 1.06, C + (ly - C) * 1.06, lr * 1.06);
    for (let i = 0; i < lobes.length; i++) {
      const [lx, ly, lr] = lobes[i];
      g.fillStyle = shade(f.base, (0.86 + hash(variant, i, 254) * 0.19) * f.light);
      blob(lx, ly, lr);
    }
    const facing = (a: number, target: number) => Math.cos(a - target) > 0.2;
    g.fillStyle = 'rgba(14,22,12,0.22)';
    for (const [lx, ly, lr, a] of lobes) if (facing(a, sunA)) blob(lx + lr * 0.16, ly + lr * 0.2, lr * 0.82);
    g.fillStyle = 'rgba(190,214,148,0.16)';
    for (const [lx, ly, lr, a] of lobes) if (facing(a, sunA + Math.PI)) blob(lx - lr * 0.14, ly - lr * 0.18, lr * 0.7);
    g.fillStyle = 'rgba(206,224,158,0.22)';
    for (const [lx, ly, lr, a] of lobes) if (facing(a, sunA + Math.PI)) blob(lx - lr * 0.3, ly - lr * 0.34, lr * 0.3);
    g.fillStyle = 'rgba(12,20,10,0.30)';
    for (let i = 0; i < 8; i++) {
      const a = hash(variant, i, 255) * TAU;
      const rr = Math.sqrt(hash(variant, i, 256)) * R * 0.85;
      blob(C + Math.cos(a) * rr, C + Math.sin(a) * rr, 0.025 + hash(variant, i, 257) * 0.02);
    }
    if (f.orchard && fine) {
      g.fillStyle = 'rgba(150,74,54,0.50)';
      for (let i = 0; i < 4; i++) {
        const a = hash(variant, i, 258) * TAU;
        const rr = Math.sqrt(hash(variant, i, 259)) * R * 0.8;
        blob(C + Math.cos(a) * rr, C + Math.sin(a) * rr, 0.022);
      }
    }
    if (!fine) return;
    const tx = C + Math.cos(sunA) * R * 0.72;
    const ty = C + Math.sin(sunA) * R * 0.72;
    g.fillStyle = 'rgba(30,24,16,0.55)';
    blob(tx, ty, 0.045);
    g.strokeStyle = 'rgba(30,24,16,0.4)';
    g.lineWidth = 0.035;
    for (let i = 0; i < 2; i++) {
      const a = sunA + Math.PI + (hash(variant, i, 260) - 0.5) * 1.6;
      g.beginPath();
      g.moveTo(tx, ty);
      g.lineTo(tx + Math.cos(a) * R * 0.4, ty + Math.sin(a) * R * 0.4);
      g.stroke();
    }
  });
}

// A fallen trunk: capsule, NW-lit top strip, AO under it, stub branches. Drawn
// in the tree pass so canopies overlap it.
export function drawLog(g: CanvasRenderingContext2D, x: number, y: number, seed: number): void {
  const len = 1.4 + hash(seed, 0, 261) * 0.8;
  const a = hash(seed, 1, 261) * Math.PI;
  const dx = Math.cos(a) * len * 0.5;
  const dy = Math.sin(a) * len * 0.5;
  const [ox, oy] = shadowOffset(0.3);
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(10,14,8,0.30)';
  g.lineWidth = 0.34;
  g.beginPath();
  g.moveTo(x - dx + ox, y - dy + oy);
  g.lineTo(x + dx + ox, y + dy + oy);
  g.stroke();
  g.strokeStyle = '#3a2f22';
  g.lineWidth = 0.28;
  g.beginPath();
  g.moveTo(x - dx, y - dy);
  g.lineTo(x + dx, y + dy);
  g.stroke();
  g.strokeStyle = 'rgba(176,158,116,0.30)';
  g.lineWidth = 0.07;
  g.beginPath();
  g.moveTo(x - dx - 0.05, y - dy - 0.06);
  g.lineTo(x + dx - 0.05, y + dy - 0.06);
  g.stroke();
  g.strokeStyle = 'rgba(42,34,24,0.8)';
  g.lineWidth = 0.05;
  for (let i = 0; i < 3; i++) {
    const t = -0.6 + hash(seed, i, 262) * 1.2;
    const b = a + (hash(seed, i, 263) > 0.5 ? 1.1 : -1.1);
    const bl = 0.18 + hash(seed, i, 264) * 0.18;
    g.beginPath();
    g.moveTo(x + dx * t, y + dy * t);
    g.lineTo(x + dx * t + Math.cos(b) * bl, y + dy * t + Math.sin(b) * bl);
    g.stroke();
  }
}
