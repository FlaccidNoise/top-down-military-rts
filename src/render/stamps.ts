// Pre-baked ground-detail patches. A tuft cluster or a gravel scatter is a
// dozen path ops; baked once per (key, band) it costs one drawImage (~1.3 µs)
// instead of ~10 µs, which is the whole reason per-tile micro-detail is
// affordable inside a chunk bake at all. Content is always deterministic —
// every variant's randomness comes from `hash`, never Math.random.

const cache = new Map<string, HTMLCanvasElement>();
const PIXEL_CAP = 8_000_000;
let cached = 0;
let warned = false;

// `size` is the patch's side in meters; the returned canvas is size*band px,
// and the draw callback works in meters over 0..size. Chunk canvases are
// scaled by `band` and translated by whole tiles, so blitting with
// `drawImage(c, x, y, size, size)` at an integer x/y maps 1:1 to source
// pixels — crisp, no resample.
export function stamp(key: string, band: number, size: number, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const k = `${key}:${band}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, Math.round(size * band));
  const g = c.getContext('2d')!;
  g.scale(c.width / size, c.height / size);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw(g);
  cache.set(k, c);
  cached += c.width * c.height;
  if (cached > PIXEL_CAP && !warned) {
    warned = true;
    console.warn(`stamps: ${(cached / 1e6).toFixed(1)} Mpx cached, over the ${PIXEL_CAP / 1e6} Mpx budget — trim variants or bands`);
  }
  return c;
}

// Non-square patches (logs, verge strips) — same cache, explicit w/h in meters.
export function stampRect(key: string, band: number, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const k = `${key}:${band}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * band));
  c.height = Math.max(1, Math.round(h * band));
  const g = c.getContext('2d')!;
  g.scale(c.width / w, c.height / h);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw(g);
  cache.set(k, c);
  cached += c.width * c.height;
  if (cached > PIXEL_CAP && !warned) {
    warned = true;
    console.warn(`stamps: ${(cached / 1e6).toFixed(1)} Mpx cached, over the ${PIXEL_CAP / 1e6} Mpx budget — trim variants or bands`);
  }
  return c;
}

export function stampPixels(): number {
  return cached;
}
