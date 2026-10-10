// Deterministic hash, 0..1 — the render layer's one source of visual
// randomness (never the sim RNG, never Math.random in bake paths). Salt picks
// independent streams; callers key on tile coords, building index, or shot
// coords as suits them.
export function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) ^ 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth direction field on a `cell`-meter lattice — the mowing/wind combing
// grass and crops are oriented by. Per-lattice angle is 0..PI (a direction,
// not a heading) and cos/sin are interpolated separately: interpolating the
// ANGLE would spin through a wrap discontinuity and leave a visible seam.
export function vec(x: number, y: number, salt: number, cell: number): [number, number] {
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  let dx = 0;
  let dy = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const a = hash(ix + i, iy + j, salt) * Math.PI;
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      dx += Math.cos(a) * w;
      dy += Math.sin(a) * w;
    }
  }
  return [dx, dy];
}

// Value noise on a `cell`-metre lattice with smoothstep weights, 0..1.
// Bilinear weights are fine for a tone drift under texture. Where the field is
// seen bare (the out-of-focus surround) or moves geometry (a hedgerow's
// wander) the bilinear lattice shows as creases.
export function soft(x: number, y: number, cell: number, salt: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, salt) * (1 - ux) + hash(ix + 1, iy, salt) * ux;
  const b = hash(ix, iy + 1, salt) * (1 - ux) + hash(ix + 1, iy + 1, salt) * ux;
  return a * (1 - uy) + b * uy;
}
