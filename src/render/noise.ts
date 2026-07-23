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
