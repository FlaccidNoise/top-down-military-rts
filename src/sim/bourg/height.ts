import { mulberry32 } from '../rng';

// ── S0 Height-first elevation field ───────────────────────────────────────────
// §3.1 of docs/plans/2026-07-28-mapgen-v4-design.md. Produces an integer-metre
// elevation raster from 3-octave value noise. The caller stamps this into the
// GameMap before any feature placement so that streets, parcels, and relief
// all query a single authoritative ground truth.
//
// DARK module: zero consumers wired yet. No file imports this module.

// ── lerp2 ─────────────────────────────────────────────────────────────────────
// Deterministic bilinear sample of a value lattice. + − × only.
export function lerp2(
  L: Float64Array,
  nx: number,
  u: number,
  v: number,
): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const i = y0 * nx + x0;
  const top = L[i] + (L[i + 1] - L[i]) * fx;
  const bot = L[i + nx] + (L[i + nx + 1] - L[i + nx]) * fx;
  return top + (bot - top) * fy;
}

// ── generateHeightField ───────────────────────────────────────────────────────
// 3-octave integer value noise on lattices of 96, 48, and 19 tiles.
// Draw count = pure function of map size (3 × ceil(w/L) × ceil(h/L) draws).
// Returns Uint8Array of length w*h with integer metre values in [0, 255].
export function generateHeightField(
  seed: number,
  w: number,
  h: number,
  amp: number,
): Uint8Array {
  const latticeSizes = [96, 48, 19];
  const weights = [0.55, 0.3, 0.15];

  // Precompute one lattice per octave.
  const lattices: { data: Float64Array; nx: number; ny: number }[] = [];
  for (let o = 0; o < 3; o++) {
    const L = latticeSizes[o];
    const nx = Math.ceil(w / L) + 2;
    const ny = Math.ceil(h / L) + 2;
    const n = nx * ny;
    const data = new Float64Array(n);
    const rng = mulberry32(seed + o);
    for (let i = 0; i < n; i++) data[i] = rng.next();
    lattices.push({ data, nx, ny });
  }

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v =
        weights[0] *
          lerp2(lattices[0].data, lattices[0].nx, x / 96, y / 96) +
        weights[1] *
          lerp2(lattices[1].data, lattices[1].nx, x / 48, y / 48) +
        weights[2] *
          lerp2(lattices[2].data, lattices[2].nx, x / 19, y / 19);
      const e = Math.round(amp * v);
      out[y * w + x] = e > 255 ? 255 : e;
    }
  }
  return out;
}

// ── townWeightField ───────────────────────────────────────────────────────────
// Feathered town-weight helper: replaces a binary mask with a smooth Q8 weight
// field via two separable integer box-blur passes of radius 4.
// Returns Uint8Array of length w*h, values in [0, 255] (Q8 range [0, 256]).
export function townWeightField(
  binaryMask: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;
  const tmp = new Uint16Array(n);
  for (let i = 0; i < n; i++) tmp[i] = binaryMask[i] * 256;

  const radius = 4;
  const kernelW = 2 * radius + 1; // 9

  // Horizontal pass.
  const hpass = new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      const sx = x < 0 ? 0 : x >= w ? w - 1 : x;
      sum += tmp[y * w + sx];
    }
    hpass[y * w] = sum / kernelW;
    for (let x = 1; x < w; x++) {
      const leave = x - radius - 1;
      const enter = x + radius;
      const sl = leave < 0 ? 0 : leave >= w ? w - 1 : leave;
      const se = enter < 0 ? 0 : enter >= w ? w - 1 : enter;
      sum = sum - tmp[y * w + sl] + tmp[y * w + se];
      hpass[y * w + x] = Math.min(255, sum / kernelW);
    }
  }

  // Vertical pass.
  const out = new Uint8Array(n);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      const sy = y < 0 ? 0 : y >= h ? h - 1 : y;
      sum += hpass[sy * w + x];
    }
    out[x] = Math.min(255, sum / kernelW);
    for (let y = 1; y < h; y++) {
      const leave = y - radius - 1;
      const enter = y + radius;
      const sl = leave < 0 ? 0 : leave >= h ? h - 1 : leave;
      const se = enter < 0 ? 0 : enter >= h ? h - 1 : enter;
      sum = sum - hpass[sl * w + x] + hpass[se * w + x];
      out[y * w + x] = Math.min(255, sum / kernelW);
    }
  }

  return out;
}