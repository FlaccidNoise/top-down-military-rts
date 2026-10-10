import type { GameMap } from '../sim/map';
import { WIND_SPEED } from '../sim/wind';
import type { Camera } from './camera';
import type { Hedgerows } from './hedgerow';
import { WIND } from './light';
import { hash, soft } from './noise';
import type { PatchIndex } from './patches';
import { inShore, shorePolygons, type Shore } from './shore';
import { cropOf, treeAt } from './terrain';
import { MOBILE } from './view';

// Ambient motion: what moves on a battlefield when nobody is fighting on it.
// Gusts cross the map down the one wind, and where a gust front is passing,
// the crowns of the trees, the tops of the hedgerows and the standing wheat
// catch the light for a second. Water glints, and the glints drift down the
// channel.
//
// The art stays baked. Nothing here redraws a tree: every site is one small
// pale sprite laid over the chunk for as long as it is lit, and at any moment
// under a tenth of the sites are. It all rides the clock it is handed (the
// renderer's fxClock, in seconds), so it stops with the sim and ?flicker=0
// pins it to one frame.
//
// It is atmosphere and it sits UNDER everything that matters: over the ground,
// under decals, shadows, men and roofs. The alphas are low enough that a still
// frame barely shows it. It is the change from frame to frame that reads.

// Metres between gust fronts along the wind, how fast they travel, and how
// deep a front is as a fraction of that spacing. Twice the speed smoke drifts
// at: a gust is the air arriving, the smoke is what it then carries. A site
// is lit for about 2 s in every 14.
export const GUST_LEN = 46;
export const GUST_SPEED = WIND_SPEED * 2;
export const GUST_DEPTH = 0.14;
// A front as a line across the whole map is a scanner bar, however it bends.
// Each site is up to this many front-spacings early or late, by a slow field:
// more than one whole spacing, so the fronts break up into patches that
// arrive, cross a wood and die out, and no line can be followed over the map.
const GUST_RAG = 1.8;

// Where in the gust cycle a point sits when the clock reads zero, 0..1.
export function gustPhase(x: number, y: number): number {
  const p = (x * WIND.dx + y * WIND.dy) / GUST_LEN + soft(x, y, 41, 630) * GUST_RAG;
  return p - Math.floor(p);
}

// How far through a passing front a site is: 0 as it arrives, 1 as it leaves,
// -1 when no front is on it. The fronts move DOWN the wind: a site further
// along it is reached later.
export function gustThrough(phase: number, t: number): number {
  const a = phase - (t * GUST_SPEED) / GUST_LEN;
  const f = (a - Math.floor(a)) / GUST_DEPTH;
  return f < 1 ? 1 - f : -1;
}

// What stirs on a tile. Water is not wind: it has its own clock.
const NONE = 0;
const CROWN = 1;
const HEDGE = 2;
const WHEAT = 3;
const WATER = 4;

// Below this the whole effect is a pixel or two of low-alpha change.
const MIN_SCALE = MOBILE ? 12 : 9;
// Sprites laid in one frame, at about 1.6 microseconds each: this is the one
// effect that costs when nothing is happening. The lit sites in view are
// counted first, and past the cap they are thinned by a roll each one carries,
// never cut off at a row and never on a stride (a stride over overlapping
// sprites is hatching). A phone gets under half a desktop's.
export const MAX_LIT = MOBILE ? 50 : 120;

// A water glint: half its length (the sprite's radius), half its width, where
// in the tile it rests and how far down the channel it slides while lit.
const GLINT_HALF_L = 0.5;
const GLINT_HALF_W = 0.11;
const GLINT_REST = 0.1;
const GLINT_SLIDE = 0.8;

const TAU = Math.PI * 2;

function sprite(w: number, h: number, rgb: string, rot: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d')!;
  g.translate(24, 24);
  g.rotate(rot);
  g.scale(w, h);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 23);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.5, `rgba(${rgb},0.45)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 23, 0, TAU);
  g.fill();
  return c;
}

export class Ambient {
  private kind: Uint8Array;
  private phase: Float32Array; // gustPhase of the site, or a water tile's own roll
  private sx: Float32Array; // where the stirring thing actually stands, world metres
  private sy: Float32Array;
  private r: Float32Array; // its size, metres; for water, how far its glint slides
  private rank: Float32Array; // 0..1, the order sites are dropped in when a view holds too many
  private sites = 0;
  // The lit sites of the frame being drawn: room for a third of the sites of a
  // 4K view at the widest zoom this draws at. A frame that lit more would lose
  // the motion in its last rows, for that frame.
  private litAt = new Int32Array(1 << 15);
  private litHow = new Float32Array(1 << 15);
  private leaf: HTMLCanvasElement | null = null;
  private swathe: HTMLCanvasElement | null = null;
  private glint: HTMLCanvasElement | null = null;

  constructor(
    private map: GameMap,
    hedges: Hedgerows,
    patches: PatchIndex,
    shore: Shore,
  ) {
    // The water as it is DRAWN (shore.ts), not as it is tiled: a glint is laid
    // only where all of it lies on drawn water, and slides down the channel
    // only where the drawn water goes on.
    // A bridge deck is inside that outline (the river runs on beneath it) and
    // is not water to a glint: the deck is baked into the chunk this is laid on.
    const banks = shorePolygons(shore);
    const wet = (x: number, y: number): boolean => map.inBounds(x, y) && map.terrainKeyAt(x, y) === 'water';
    const afloat = (x: number, y0: number, y1: number): boolean =>
      inShore(banks, x - GLINT_HALF_W, y0) && inShore(banks, x + GLINT_HALF_W, y0) && inShore(banks, x - GLINT_HALF_W, y1) && inShore(banks, x + GLINT_HALF_W, y1);
    const n = map.w * map.h;
    this.kind = new Uint8Array(n);
    this.phase = new Float32Array(n);
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.r = new Float32Array(n);
    this.rank = new Float32Array(n);
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const i = y * map.w + x;
        const key = map.terrainKeyAt(x, y);
        let k = NONE;
        let px = x + 0.5;
        let py = y + 0.5;
        let r = 0.5;
        if (key === 'woods') {
          const tree = treeAt(map, x, y);
          if (tree) [k, px, py, r] = [CROWN, tree[0], tree[1], tree[2] * 0.7];
        } else if (key === 'hedge') {
          [k, px, py, r] = [HEDGE, hedges.px[i], hedges.py[i], 0.4];
        } else if (key === 'field') {
          const p = patches.patchAt(x, y);
          if (p && cropOf(p.seed) === 1) k = WHEAT; // cereal: plough and roots have nothing to bend
        } else if (key === 'water') {
          px = x + hash(x, y, 631);
          // Open water is water whichever way the glint goes. A tile on the
          // bank is tested against the drawn bank: for where the glint rests,
          // and again for the stretch it would slide through.
          let open = true;
          for (let dy = -1; dy <= 2 && open; dy++) for (let dx = -1; dx <= 1 && open; dx++) open = wet(x + dx, y + dy);
          if (open || (wet(x, y - 1) && afloat(px, y + GLINT_REST - GLINT_HALF_L, y + GLINT_REST + GLINT_HALF_L))) {
            k = WATER;
            r = open || (wet(x, y + 1) && afloat(px, y + GLINT_REST + GLINT_HALF_L, y + GLINT_REST + GLINT_SLIDE + GLINT_HALF_L)) ? GLINT_SLIDE : 0;
          }
        }
        if (k === NONE) continue;
        this.sites++;
        this.kind[i] = k;
        this.phase[i] = k === WATER ? hash(x, y, 632) : gustPhase(px, py);
        this.sx[i] = px;
        this.sy[i] = py;
        this.r[i] = r;
        this.rank[i] = hash(x, y, 633);
      }
    }
  }

  // How far through being lit a site is, 0..1, or -1 when it is dark. A gust
  // front for the three that stir; a water tile's glint is on for a third of
  // its own cycle.
  private through(i: number, t: number): number {
    if (this.kind[i] !== WATER) return gustThrough(this.phase[i], t);
    const a = this.phase[i] + t * 0.3;
    const f = (a - Math.floor(a)) * 3;
    return f < 1 ? f : -1;
  }

  /** `t` is the cosmetic clock in seconds. Returns the sprites laid. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number, t: number): number {
    if (this.sites === 0 || cam.scale < MIN_SCALE || !(t >= 0)) return 0;
    const map = this.map;
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    const x0 = Math.max(0, Math.floor(wx0) - 1);
    const y0 = Math.max(0, Math.floor(wy0) - 1);
    const x1 = Math.min(map.w, Math.ceil(wx1) + 1);
    const y1 = Math.min(map.h, Math.ceil(wy1) + 1);
    // one scan of the view: the lit sites, and how far through each is
    const at = this.litAt;
    const how = this.litHow;
    let lit = 0;
    for (let y = y0; y < y1; y++) {
      for (let i = y * map.w + x0, end = y * map.w + x1; i < end && lit < at.length; i++) {
        if (this.kind[i] === NONE) continue;
        const f = this.through(i, t);
        if (f < 0) continue;
        at[lit] = i;
        how[lit++] = f;
      }
    }
    if (lit === 0) return 0;
    const keep = MAX_LIT / lit;
    this.leaf ??= sprite(1, 1, '216,228,172', 0);
    // a swathe lies ACROSS the wind: the line the front draws through a crop
    this.swathe ??= sprite(0.36, 1, '236,224,176', Math.atan2(WIND.dy, WIND.dx));
    this.glint ??= sprite(0.22, 1, '236,244,246', 0);
    const s = cam.scale;
    const ox = cw / 2 - cam.x * s;
    const oy = ch / 2 - cam.y * s;
    let laid = 0;
    const put = (c: HTMLCanvasElement, wx: number, wy: number, r: number, a: number): void => {
      laid++;
      ctx.globalAlpha = a;
      ctx.drawImage(c, wx * s + ox - r * s, wy * s + oy - r * s, r * 2 * s, r * 2 * s);
    };
    for (let n = 0; n < lit; n++) {
      const i = at[n];
      if (this.rank[i] >= keep) continue;
      const f = how[n];
      const k = this.kind[i];
      // The count moves from frame to frame and `keep` with it: a site right
      // at the line is faded, not switched, so the thinning never pops.
      const e = Math.sin(f * Math.PI) * Math.min(1, (keep - this.rank[i]) * 8);
      if (k === WATER) {
        // the glint slides down the channel while it is on (the rivers run north to south)
        put(this.glint, this.sx[i], ((i / map.w) | 0) + GLINT_REST + f * this.r[i], GLINT_HALF_L, 0.26 * e);
        continue;
      }
      // the lit patch runs a little down the wind as the front goes over
      const slide = (f - 0.5) * 0.3;
      const px = this.sx[i] + WIND.dx * slide;
      const py = this.sy[i] + WIND.dy * slide;
      if (k === WHEAT) put(this.swathe, px, py, 1.3, 0.11 * e);
      else put(this.leaf, px, py, this.r[i], (k === CROWN ? 0.15 : 0.13) * e);
    }
    ctx.globalAlpha = 1;
    return laid;
  }
}
