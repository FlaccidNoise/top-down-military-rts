import { WEAPONS, type Role, type WeaponKey } from '../sim/data';
import type { Side } from '../sim/sim';
import { AO_ALPHA, SUN } from './light';
import { SpriteCache } from './spritecache';
import { MOBILE } from './view';

// Parametric vector soldier, drawn facing +X in meter units, baked into a
// per-(pose, frame, weapon, side, zoom-band) sprite cache. The renderer draws
// one rotated drawImage per soldier; rotation is free because top-down art has
// a single valid view angle.

export type Pose =
  | 'idle'
  | 'walk'
  | 'crawl'
  | 'aim'
  | 'reload'
  | 'kneel'
  | 'prone'
  | 'downed'
  | 'dead'
  | 'dead1'
  | 'dead2'
  | 'drag'
  | 'aid'
  | 'dragged'
  | 'melee'
  | 'surrendered'
  | 'surrender2';
export const WALK_FRAMES = 6;
export const CRAWL_FRAMES = 4; // 0 left knee up, 1 mid, 2 right knee up, 3 mid
export const MELEE_FRAMES = 4; // 0 guard, 1 windup, 2 thrust, 3 recover
export const SPRITE_SPAN = 3.6; // meters covered by the (square) sprite canvas
export const DUDE_SCALE = 1.35; // genre-standard oversize so figures read at tactical zoom
export const SPRITE_MIN_SCALE = 5; // px/m; below this the renderer uses dot LOD

// Bake resolutions (px/m); never upscale on screen. Band 48 bakes ~90px
// canvases per (pose x frame x weapon x side) on demand and the phone's
// cam.maxScale is 32, so it could only ever be baked and never displayed.
const BANDS = MOBILE ? [6, 12, 24] : [6, 12, 24, 48];

export function bandFor(scale: number): number {
  return BANDS.find((b) => b >= scale) ?? BANDS[BANDS.length - 1];
}

// Detail tier per bake band — the one gate every piece of kit detail asks.
// 0: silhouette + team rim only (band 6: a strap is a third of a pixel there,
//    so drawing it is mush AND cost). 1: the historical look. 2: webbing,
//    per-weapon geometry, role marks. 3: netting, lacing, weathering.
export function tier(band: number): 0 | 1 | 2 | 3 {
  return band >= 48 ? 3 : band >= 24 ? 2 : band >= 12 ? 1 : 0;
}

// One device pixel in body units: the dude bake ctx is scaled by band*DUDE_SCALE,
// so a 0.02-unit tick is sub-pixel at band 24 unless it is clamped through here.
function hair(band: number): number {
  return 1 / (band * DUDE_SCALE);
}

type Ctx = CanvasRenderingContext2D;

interface Kit {
  side: Side;
  uniform: string; // torso — lightest value
  sleeve: string; // limbs — dark
  trousers: string; // limbs — dark
  helmet: string; // darkest value + rim highlight
  skin: string;
  outline: string; // team identity halo — the friend/foe read at a glance
}

// US olive-drab vs German feldgrau, each a light→dark→darkest ramp so torso,
// limbs and helmet separate by value (S1); the two kits also sit at
// distinctly different overall values (US warmer/lighter, GE cooler/darker).
const KITS: Record<Side, Kit> = {
  blue: { side: 'blue', uniform: '#7c8558', sleeve: '#4f5936', trousers: '#495030', helmet: '#333a24', skin: '#c9a481', outline: 'rgba(100,155,225,0.9)' },
  red: { side: 'red', uniform: '#686c60', sleeve: '#46483e', trousers: '#3f4137', helmet: '#34362f', skin: '#c9a481', outline: 'rgba(225,105,85,0.9)' },
};

function mix(hex: string, to: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const c = (i: number) => Math.round(p(hex, i) + (p(to, i) - p(hex, i)) * t);
  return `rgb(${c(1)},${c(3)},${c(5)})`;
}

function withAlpha(rgba: string, mult: number): string {
  return rgba.replace(/[\d.]+\)$/, (a) => `${(parseFloat(a) * mult).toFixed(3)})`);
}

// Zoom-attenuated team rim (architecture.md rule 5): full strength at the
// close bake bands, half at 24, a thin whisper by 48.
function haloMult(band: number): number {
  if (band <= 12) return 1;
  if (band === 24) return 0.5;
  return 0.22;
}

function deadKit(k: Kit): Kit {
  const earth = '#332c22'; // dark wet-earth tone — dead kits darken toward the ground, not pale grey (S6)
  return {
    side: k.side,
    uniform: mix(k.uniform, earth, 0.45),
    sleeve: mix(k.sleeve, earth, 0.45),
    trousers: mix(k.trousers, earth, 0.45),
    helmet: mix(k.helmet, earth, 0.45),
    skin: mix(k.skin, earth, 0.3),
    outline: k.outline,
  };
}

// Monochrome pass. The cast-shadow bake re-runs the *same* pose code with
// every colour collapsed to one ink and every non-silhouette flourish skipped,
// so a man's shadow can never drift from the man throwing it. Bakes are
// synchronous, so a module flag is enough — nothing re-enters mid-pose.
const SHADOW_INK = 'rgba(20,16,10,1)';
let mono = false;
function paint(c: string): string {
  return mono ? SHADOW_INK : c;
}

// --- Kit variant (U4) -------------------------------------------------------
// Role and veterancy marks ride a small bit field rather than new cache
// dimensions per attribute: bits 0-1 the role bucket, bit 2 veteran. Set once
// per bake by getSprite, read by torso()/helmet(); same single-threaded bake
// contract as `mono`.
const V_ROLE = 3;
const V_AIDMAN = 1;
const V_LEADER = 2;
const V_GUNNER = 3;
const V_VET = 4;
let kitBits = 0;

export function kitVariant(role: Role, xp: number, band: number): number {
  const t = tier(band);
  if (t < 2) return 0; // far bands must not mint extra cache entries
  const roleBits = role === 'aidman' ? V_AIDMAN : role === 'leader' ? V_LEADER : role === 'gunner' || role === 'assistant' ? V_GUNNER : 0;
  return roleBits | (t >= 3 && xp >= 3 ? V_VET : 0);
}

// Poses that actually show a torso and a helmet from above. A corpse or a man
// with his hands up carries no role marks — and, more to the point, must not
// multiply the keyspace with variants nobody can see.
const VARIANT_POSES = new Set<Pose>(['idle', 'walk', 'crawl', 'aim', 'reload', 'kneel', 'prone', 'melee']);

function cap(g: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, color: string): void {
  g.strokeStyle = paint(color);
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

function dot(g: Ctx, x: number, y: number, r: number, color: string): void {
  g.fillStyle = paint(color);
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

// Silhouette bucket per weapon: short SMG-length guns, bipod'd MGs, else rifle-length.
function gunClass(w: WeaponKey): 'rifle' | 'smg' | 'mg' {
  return WEAPONS[w].class;
}

// --- Weapon silhouettes (U3) ------------------------------------------------
// Three lengths cannot tell a Kar98k from a bazooka. Every WeaponKey gets a
// shape instead, differentiated by geometry rather than by scale: the overall
// lengths stay close to the three they replace so no figure's proportions
// shift, and the read comes from stock, magazine, jacket and muzzle.
const WOOD = '#5d4126';
const METAL = '#2b2b28';
const METAL_DARK = '#232320';

interface GunShape {
  len: number; // overall length in body units (1 unit ~ 1.35 m)
  back: number; // butt distance behind the grip
  barrelW: number;
  stock: 'wood' | 'folding' | 'none';
  fore: number; // where the support hand rides along the bore — half the read
  mag?: [number, number]; // [x along bore, depth below] box magazine
  vmag?: number; // magazine hanging straight down (MP40)
  bipod?: number; // half-span at the muzzle
  scope?: number; // scope block length above the receiver
  drum?: number; // drum/pan radius
  jacket?: number; // cooling-jacket perforation ticks
  tube?: boolean; // constant-diameter launcher: no stock taper, no receiver step
  shield?: boolean; // blast shield (Panzerschreck)
  bulb?: number; // warhead bulb radius (Panzerfaust)
  bolt?: boolean; // straight bolt handle
  oprod?: boolean; // op-rod tick along the underside (Garand)
  brake?: boolean; // muzzle booster/brake
  foregrip?: boolean;
  can?: boolean; // ammo can + belt at the loader's side (M1919)
  slung?: number; // carried across the back, not fired: tube of this length
  plate?: boolean; // mortar baseplate disc
}

const GUNS: Record<WeaponKey, GunShape> = {
  garand: { len: 1.05, back: 0.32, barrelW: 0.06, stock: 'wood', fore: 0.38, oprod: true },
  carbine: { len: 0.82, back: 0.26, barrelW: 0.05, stock: 'wood', fore: 0.32, mag: [0.06, 0.12] },
  springfield: { len: 1.15, back: 0.34, barrelW: 0.055, stock: 'wood', fore: 0.4, scope: 0.22 },
  kar98k_scoped: { len: 1.15, back: 0.34, barrelW: 0.055, stock: 'wood', fore: 0.4, scope: 0.22 },
  kar98k: { len: 1.02, back: 0.32, barrelW: 0.062, stock: 'wood', fore: 0.38, bolt: true },
  bar: { len: 1.12, back: 0.32, barrelW: 0.075, stock: 'wood', fore: 0.42, bipod: 0.16, mag: [0.1, 0.16] },
  thompson: { len: 0.66, back: 0.22, barrelW: 0.055, stock: 'wood', fore: 0.24, drum: 0.1, foregrip: true },
  mp40: { len: 0.62, back: 0.2, barrelW: 0.05, stock: 'folding', fore: 0.22, vmag: 0.22 },
  m1919: { len: 1.2, back: 0.3, barrelW: 0.05, stock: 'none', fore: 0.4, jacket: 5, can: true },
  mg42: { len: 1.32, back: 0.32, barrelW: 0.085, stock: 'wood', fore: 0.44, jacket: 7, bipod: 0.2, drum: 0.11, brake: true },
  bazooka: { len: 1.4, back: 0.55, barrelW: 0.09, stock: 'none', fore: 0.5, tube: true },
  schreck: { len: 1.5, back: 0.6, barrelW: 0.095, stock: 'none', fore: 0.5, tube: true, shield: true },
  panzerfaust: { len: 0.75, back: 0.3, barrelW: 0.06, stock: 'none', fore: 0.3, tube: true, bulb: 0.09 },
  mortar60: { len: 0.9, back: 0, barrelW: 0.08, stock: 'none', fore: 0.3, slung: 0.9 },
  mortar81: { len: 1.1, back: 0, barrelW: 0.09, stock: 'none', fore: 0.3, slung: 1.1, plate: true },
  at57_gun: { len: 0.8, back: 0.26, barrelW: 0.05, stock: 'wood', fore: 0.3 },
  pak40_gun: { len: 0.8, back: 0.26, barrelW: 0.05, stock: 'wood', fore: 0.3 },
};

// Support-hand distance along the bore: a bazooka's hand sits at 0.5, an
// MP40's at 0.22. Hand placement is half of what makes a weapon read.
function gunFore(w: WeaponKey): number {
  return GUNS[w].fore;
}

// Weapon drawn with grip at (x, y), muzzle toward +X (before `angle`).
// Draw order is fixed: stock → receiver → barrel → jacket → magazine → bipod
// → scope → muzzle device, so nothing ever paints over the part that reads.
function gun(g: Ctx, weapon: WeaponKey, x: number, y: number, angle: number, band: number): void {
  const s = GUNS[weapon];
  const t = tier(band);
  const hw = hair(band);
  g.save();

  // A mortar on a man is cargo, not a weapon: tube slung across the back on
  // the same angle as the slung rifles in drag()/aid(). Firing tubes are
  // emplacements, not soldier sprites.
  if (s.slung) {
    g.translate(-0.04, 0);
    g.rotate(2.45);
    cap(g, -s.slung / 2, 0, s.slung / 2, 0, s.barrelW * 1.6, METAL);
    if (t >= 2) {
      cap(g, -s.slung / 2, 0, -s.slung / 2 + 0.1, 0, s.barrelW * 2.2, METAL_DARK); // muzzle collar
      if (s.plate) dot(g, s.slung / 2 + 0.06, 0, 0.11, METAL_DARK); // baseplate riding the butt end
    }
    g.restore();
    return;
  }

  g.translate(x, y);
  g.rotate(angle);
  if (s.tube) g.translate(0, -0.06); // launchers ride the shoulder line, not both fists
  const muzzle = s.len - s.back;

  if (s.stock === 'wood') cap(g, -s.back, 0, -s.back * 0.25, 0, 0.1, WOOD);
  else if (s.stock === 'folding') {
    if (t >= 2) {
      g.strokeStyle = METAL;
      g.lineWidth = Math.max(0.028, hw);
      g.strokeRect(-s.back, -0.05, s.back * 0.8, 0.1); // wire stock, folded under
    } else cap(g, -s.back, 0, -s.back * 0.3, 0, 0.06, METAL);
  }

  if (s.tube) {
    cap(g, -s.back, 0, muzzle, 0, s.barrelW * 2, METAL); // constant diameter, no taper
    if (t >= 2) {
      cap(g, -s.back * 0.35, 0.02, -s.back * 0.35, 0.12, 0.045, METAL_DARK); // shoulder rest
      if (s.shield) {
        g.fillStyle = METAL_DARK;
        g.fillRect(muzzle * 0.3, -0.16, 0.06, 0.32); // blast shield, seen edge-on from above
      }
    }
    if (s.bulb) dot(g, muzzle + s.bulb * 0.5, 0, s.bulb, METAL_DARK);
  } else {
    if (s.jacket && t >= 2) cap(g, 0.02, 0, muzzle * 0.62, 0, s.barrelW * 1.5, METAL); // cooling jacket sleeve
    cap(g, -s.back * 0.25, 0, muzzle, 0, s.barrelW, METAL);
  }

  if (s.jacket && t >= 3) {
    g.strokeStyle = METAL_DARK;
    g.lineWidth = Math.max(0.02, hw);
    g.beginPath();
    for (let i = 0; i < s.jacket; i++) {
      const jx = 0.06 + (muzzle * 0.55 * (i + 0.5)) / s.jacket;
      g.moveTo(jx, -s.barrelW * 0.75);
      g.lineTo(jx, s.barrelW * 0.75);
    }
    g.stroke();
  }
  if (s.oprod && t >= 3) cap(g, -0.05, s.barrelW * 0.7, muzzle * 0.6, s.barrelW * 0.7, Math.max(0.022, hw), METAL_DARK);
  if (s.bolt && t >= 2) cap(g, -0.15, 0.01, -0.15, 0.13, Math.max(0.035, hw), METAL_DARK);
  if (s.mag && t >= 2) {
    g.fillStyle = METAL_DARK;
    g.fillRect(s.mag[0] - 0.03, 0.02, 0.06, s.mag[1]);
  }
  if (s.vmag) cap(g, 0.08, 0.04, 0.08, 0.04 + s.vmag, 0.06, METAL); // straight-down stick mag: the MP40 read
  if (s.drum && t >= 2) {
    dot(g, 0.06, 0.09, s.drum, METAL_DARK);
    dot(g, 0.06, 0.09, s.drum * 0.45, METAL);
  }
  if (s.foregrip && t >= 2) cap(g, muzzle * 0.55, 0.02, muzzle * 0.55, 0.14, 0.05, METAL_DARK);
  if (s.bipod) cap(g, muzzle - 0.12, -s.bipod, muzzle - 0.12, s.bipod, Math.max(0.045, hw), METAL_DARK);
  if (s.scope && t >= 2) {
    g.fillStyle = METAL_DARK;
    g.fillRect(-0.02, -0.075, s.scope, 0.07);
    if (t >= 3) {
      g.strokeStyle = METAL;
      g.lineWidth = Math.max(0.022, hw);
      g.beginPath();
      for (const rx of [0.02, s.scope - 0.05]) {
        g.moveTo(rx, -0.085);
        g.lineTo(rx, 0.005);
      }
      g.stroke();
    }
  }
  if (s.can && t >= 2) {
    g.fillStyle = mix('#3c3f36', '#000000', 0.25); // olive can, not a black brick — it must not out-value the helmet
    g.fillRect(-0.1, 0.11, 0.24, 0.15); // ammo can at the loader's side
    g.strokeStyle = METAL;
    g.lineWidth = Math.max(0.03, hw);
    g.beginPath();
    g.moveTo(0.04, 0.03);
    g.quadraticCurveTo(0.02, 0.08, 0.06, 0.1); // belt out of the feed block
    g.stroke();
  }
  if (s.brake && t >= 2) cap(g, muzzle - 0.08, 0, muzzle + 0.02, 0, s.barrelW * 1.7, METAL_DARK);
  g.restore();
}

// Faction helmet silhouette (S5): US M1 "pot" helmet reads as a clean dome +
// thin brim ring; German stahlhelm reads elliptical with a flared rear
// (-X) skirt hint.
function helmet(g: Ctx, k: Kit, x: number, y: number, band: number): void {
  const t = tier(band);
  if (k.side === 'blue') {
    dot(g, x, y, 0.175, k.helmet);
    if (mono) return;
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 0.03;
    g.beginPath();
    g.arc(x, y, 0.2, 0, Math.PI * 2); // brim peeking past the dome
    g.stroke();
  } else {
    g.fillStyle = paint(k.helmet);
    g.beginPath();
    g.ellipse(x, y, 0.19, 0.165, 0, 0, Math.PI * 2);
    g.fill();
    if (mono) return;
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 0.04;
    g.beginPath();
    g.arc(x - 0.05, y, 0.19, Math.PI * 0.6, Math.PI * 1.4); // flared rear skirt
    g.stroke();
  }
  if (t === 0) return; // band 6: the dome IS the helmet; every ring below is sub-pixel
  const hw = hair(band);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = Math.max(0.035, hw);
  g.beginPath();
  g.arc(x, y, 0.165, 0, Math.PI * 2);
  g.stroke();
  // A highlight baked into the sprite points wherever the man happens to face.
  // From tier 2 the renderer lays a world-aligned glint quad on the head
  // instead; only the far bands, where that quad is sub-pixel, keep the blob.
  if (t < 2) {
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.beginPath();
    g.arc(x - 0.045, y - 0.045, 0.1, 0, Math.PI * 2);
    g.fill();
    return;
  }

  // Shell thickness: a dark rim just inside the outline. Cheap, and it stops
  // the helmet reading as a flat disc.
  g.strokeStyle = mix(k.helmet, '#000000', 0.4);
  g.lineWidth = Math.max(0.02, hw);
  g.beginPath();
  g.arc(x, y, 0.15, 0, Math.PI * 2);
  g.stroke();
  // Chinstrap under the jaw — the front (+X) quarter is all you see from above.
  g.strokeStyle = 'rgba(0,0,0,0.3)';
  g.lineWidth = Math.max(0.03, hw);
  g.beginPath();
  g.arc(x, y, 0.155, -0.55, 0.55);
  g.stroke();

  const role = kitBits & V_ROLE;
  if (t >= 3 && role !== V_LEADER) {
    // Netting on a 23 px helmet is exactly the texture the bake budget exists
    // for. US scrim net; German cloth cover with two splinter dabs.
    g.save();
    g.beginPath();
    g.arc(x, y, 0.16, 0, Math.PI * 2);
    g.clip();
    if (k.side === 'blue') {
      g.strokeStyle = 'rgba(0,0,0,0.16)';
      g.lineWidth = Math.max(0.018, hw);
      g.beginPath();
      for (let i = -1; i <= 1; i++) {
        g.moveTo(x - 0.18, y + i * 0.07);
        g.lineTo(x + 0.18, y + i * 0.07);
        g.moveTo(x + i * 0.07, y - 0.18);
        g.lineTo(x + i * 0.07, y + 0.18);
      }
      g.stroke();
    } else {
      g.fillStyle = 'rgba(70,74,52,0.5)';
      g.fillRect(x - 0.18, y - 0.05, 0.36, 0.1); // cover band
      dot(g, x + 0.06, y - 0.09, 0.045, 'rgba(70,74,52,0.5)');
      dot(g, x - 0.07, y + 0.07, 0.038, 'rgba(70,74,52,0.5)');
    }
    if (kitBits & V_VET) {
      // Foliage tucked under the net — the veteran tell, three dabs, no badge.
      dot(g, x - 0.06, y - 0.06, 0.03, 'rgba(58,70,44,0.6)');
      dot(g, x + 0.05, y - 0.02, 0.024, 'rgba(58,70,44,0.6)');
      dot(g, x - 0.01, y + 0.07, 0.028, 'rgba(58,70,44,0.6)');
    }
    g.restore();
  }
  if (role === V_AIDMAN) {
    // Top-down we see the crown, so that is where the red cross goes.
    dot(g, x, y, 0.09, '#e8e4d8');
    g.strokeStyle = '#8c2018';
    g.lineWidth = Math.max(0.035, hw);
    g.beginPath();
    g.moveTo(x - 0.06, y);
    g.lineTo(x + 0.06, y);
    g.moveTo(x, y - 0.06);
    g.lineTo(x, y + 0.06);
    g.stroke();
  } else if (role === V_LEADER) {
    cap(g, x - 0.16, y - 0.03, x - 0.16, y + 0.03, Math.max(0.055, hw), 'rgba(224,218,196,0.55)'); // rank tick, rear edge
  }
}

function torsoStraps(g: Ctx): void {
  cap(g, -0.1, -0.17, 0.14, -0.09, 0.05, 'rgba(42,36,24,0.5)');
  cap(g, -0.1, 0.17, 0.14, 0.09, 0.05, 'rgba(42,36,24,0.5)');
}

// Faction gear silhouette on the torso (S5): US haversack pack riding the
// back; German Y-straps + breadbag. MG crews of either side carry a belt
// fleck across the chest.
function torsoGear(g: Ctx, k: Kit, weapon: WeaponKey): void {
  if (k.side === 'blue') {
    g.fillStyle = 'rgba(40,34,22,0.4)';
    g.fillRect(-0.2, -0.1, 0.1, 0.2);
  } else {
    cap(g, -0.02, -0.16, -0.16, -0.05, 0.035, 'rgba(30,26,18,0.45)');
    cap(g, -0.02, 0.16, -0.16, 0.05, 0.035, 'rgba(30,26,18,0.45)');
    g.fillStyle = 'rgba(50,42,28,0.45)';
    g.beginPath();
    g.ellipse(-0.15, 0.02, 0.07, 0.05, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (gunClass(weapon) === 'mg') {
    g.strokeStyle = 'rgba(60,55,30,0.55)';
    g.lineWidth = 0.045;
    g.beginPath();
    g.moveTo(-0.05, -0.2);
    g.lineTo(0.12, 0.18);
    g.stroke();
  }
}

// --- Webbing (U4, tier >= 2) ------------------------------------------------
// Everything below is inside the torso outline except the medic's brassard, so
// the silhouette pillar survives: a kitted man, not a noisy one. Body axes seen
// from above: +X is his front, +Y his right, -X the pack edge.
function rrect(g: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + r, r);
  g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.arcTo(x, y + h, x, y + h - r, r);
  g.arcTo(x, y, x + r, y, r);
  g.closePath();
  g.fill();
}

function webbingUS(g: Ctx, k: Kit, band: number): void {
  const t = tier(band);
  const hw = hair(band);
  // Haversack riding the back, bedroll horseshoe over its top
  rrect(g, -0.26, -0.11, 0.13, 0.22, 0.035, mix(k.uniform, '#000000', 0.42));
  g.strokeStyle = mix(k.uniform, '#3a3020', 0.55);
  g.lineWidth = Math.max(0.05, hw);
  g.beginPath();
  g.arc(-0.13, 0, 0.16, 2.0, 4.28); // bedroll wrapped over the pack
  g.stroke();
  if (t >= 3) {
    g.strokeStyle = 'rgba(28,24,16,0.5)';
    g.lineWidth = Math.max(0.018, hw);
    g.beginPath();
    for (const ly of [-0.08, 0, 0.08]) {
      g.moveTo(-0.27, ly);
      g.lineTo(-0.12, ly); // lashing straps
    }
    g.stroke();
  }
  // M1923 cartridge belt across the waist, five pouches
  cap(g, 0.05, -0.2, 0.05, 0.2, Math.max(0.055, hw), 'rgba(52,45,30,0.55)');
  g.strokeStyle = 'rgba(24,20,14,0.5)';
  g.lineWidth = Math.max(0.022, hw);
  g.beginPath();
  for (let i = -2; i <= 2; i++) {
    g.moveTo(0.02, i * 0.08);
    g.lineTo(0.08, i * 0.08);
  }
  g.stroke();
  g.fillStyle = 'rgba(46,40,26,0.6)';
  g.beginPath();
  g.ellipse(-0.02, 0.21, 0.06, 0.05, 0, 0, Math.PI * 2); // canteen on the right hip
  g.fill();
  cap(g, -0.14, -0.15, -0.26, -0.19, Math.max(0.03, hw), 'rgba(36,30,20,0.6)'); // entrenching tool
}

function webbingGE(g: Ctx, k: Kit, band: number): void {
  const t = tier(band);
  const hw = hair(band);
  // Y-straps converging on the belt buckle
  const yw = Math.max(0.035, hw);
  cap(g, -0.06, -0.2, 0.11, -0.02, yw, 'rgba(30,26,18,0.5)');
  cap(g, -0.06, 0.2, 0.11, 0.02, yw, 'rgba(30,26,18,0.5)');
  dot(g, 0.13, 0, 0.05, 'rgba(38,33,22,0.75)'); // buckle
  g.fillStyle = 'rgba(34,29,20,0.6)';
  g.fillRect(0.06, -0.13, 0.07, 0.05); // ammo pouches flanking it
  g.fillRect(0.06, 0.08, 0.07, 0.05);
  g.fillStyle = 'rgba(50,42,28,0.5)';
  g.beginPath();
  g.ellipse(-0.13, -0.15, 0.07, 0.05, 0, 0, Math.PI * 2); // breadbag, left rear
  g.fill();
  if (t >= 3) cap(g, -0.16, -0.19, -0.1, -0.19, Math.max(0.02, hw), 'rgba(26,22,15,0.5)'); // bag flap
  rrect(g, -0.17, 0.08, 0.06, 0.11, 0.025, 'rgba(28,26,20,0.65)'); // gas-mask canister, right rear
  if (t >= 3) {
    g.strokeStyle = 'rgba(60,58,48,0.45)';
    g.lineWidth = Math.max(0.016, hw);
    g.beginPath();
    for (const ry of [0.11, 0.135, 0.16]) {
      g.moveTo(-0.17, ry);
      g.lineTo(-0.11, ry); // ribbing
    }
    g.stroke();
  }
  g.fillStyle = 'rgba(40,36,26,0.55)';
  g.fillRect(-0.22, -0.05, 0.07, 0.09); // mess tin on the pack
}

// Webbing + role marks, replacing the two flat strap strokes at tier 2+.
function kitDetail(g: Ctx, k: Kit, weapon: WeaponKey, band: number): void {
  const t = tier(band);
  const hw = hair(band);
  // shoulder seam across the upper third, and a collar tick at the front edge
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = Math.max(0.025, hw);
  g.beginPath();
  g.arc(-0.02, 0, 0.19, -1.15, 1.15);
  g.stroke();
  cap(g, 0.17, -0.03, 0.17, 0.03, Math.max(0.06, hw), mix(k.uniform, '#000000', 0.35)); // collar
  if (k.side === 'blue') webbingUS(g, k, band);
  else webbingGE(g, k, band);

  const role = kitBits & V_ROLE;
  const mg = gunClass(weapon) === 'mg';
  if (mg || role === V_GUNNER) {
    // a real belt, not a fleck: six perpendicular ticks along the diagonal
    cap(g, -0.05, -0.2, 0.12, 0.18, Math.max(0.05, hw), 'rgba(60,55,30,0.55)');
    g.strokeStyle = 'rgba(20,18,12,0.5)';
    g.lineWidth = Math.max(0.018, hw);
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const f = (i + 0.5) / 6;
      const bx = -0.05 + 0.17 * f;
      const by = -0.2 + 0.38 * f;
      g.moveTo(bx - 0.035, by + 0.016);
      g.lineTo(bx + 0.035, by - 0.016);
    }
    g.stroke();
  }
  if (role === V_GUNNER) {
    g.fillStyle = mix('#3c3f36', '#000000', 0.3);
    g.fillRect(-0.24, -0.05, 0.1, 0.07); // spare ammo can riding the pack
  } else if (role === V_LEADER) {
    rrect(g, -0.04, -0.24, 0.09, 0.13, 0.02, 'rgba(46,38,24,0.7)'); // map case on the left hip
    g.fillStyle = 'rgba(30,26,18,0.7)';
    g.fillRect(0.09, -0.03, 0.06, 0.05); // binocular case on the chest
  } else if (role === V_AIDMAN) {
    cap(g, 0.0, -0.27, 0.06, -0.27, Math.max(0.05, hw), 'rgba(232,228,214,0.8)'); // brassard, left upper arm
  }
}

// Boot, and at the closest band the legging + heel that stop a leg reading as
// a pipe with a dot on the end.
function boot(g: Ctx, k: Kit, x: number, y: number, r: number, band: number): void {
  dot(g, x, y, r, '#3a3128');
  if (tier(band) < 3 || mono) return;
  cap(g, x - 0.1, y, x - 0.05, y, 0.05, mix(k.trousers, '#000000', 0.2)); // canvas legging
  cap(g, x - 0.13, y, x - 0.1, y, Math.max(0.03, hair(band)), '#2a231c'); // heel
}

// Contact AO only — the dark pinch where a body meets the ground. It is not a
// cast shadow and carries no direction or elongation: the world-aligned cast
// pass (renderer.drawUnitShadows) owns both, off the one sun in light.ts.
function contactShadow(g: Ctx): void {
  if (mono) return; // a shadow must not bake its own shadow
  g.fillStyle = `rgba(20,16,10,${AO_ALPHA * 0.5})`;
  g.beginPath();
  g.ellipse(0, 0.04, 0.18, 0.13, 0, 0, Math.PI * 2);
  g.fill();
}

// Shared standing body: legSwing in [-1,1] (0 = feet hidden under torso).
// `shouldered` brings the stock to the cheek — the difference between holding
// a stick and firing a rifle.
function standing(g: Ctx, k: Kit, w: WeaponKey, gunAngle: number, legSwing: number, lean: number, band: number, shouldered = false): void {
  if (legSwing !== 0) {
    for (const side of [-1, 1] as const) {
      const lx = side * legSwing * 0.34;
      cap(g, lx * 0.35, side * 0.13, lx, side * 0.13, 0.13, k.trousers);
      boot(g, k, lx, side * 0.13, 0.07, band);
    }
  }
  g.save();
  // shoulder counter-sway against the leg swing (S4), plus a right-shoulder
  // bias when the stock is actually in the cheek
  g.rotate(-legSwing * 0.12 + (shouldered ? -0.1 : 0));
  torso(g, k, 0.22, 0.31, band, w);
  g.restore();
  const bob = Math.abs(legSwing) * 0.035; // head bob, two beats per stride (S4)
  const gx = shouldered ? 0.1 : 0.14;
  const gy = shouldered ? 0.06 : 0.13;
  const fore = gunFore(w);
  const fx = gx + Math.cos(gunAngle) * fore;
  const fy = gy + Math.sin(gunAngle) * fore;
  cap(g, 0.02, shouldered ? 0.2 : 0.24, gx, gy, 0.12, k.sleeve); // rear elbow tucks in behind the butt
  cap(g, 0.02, -0.24, fx, fy, 0.12, k.sleeve);
  gun(g, w, gx, gy, gunAngle, band);
  dot(g, gx, gy, 0.055, k.skin);
  dot(g, fx, fy, 0.055, k.skin);
  helmet(g, k, 0.04 + lean, -bob + (shouldered ? 0.06 : 0), band); // cheek down to the stock
}

// Reload: the weapon is out of the fight and it must LOOK out of the fight —
// canted down, pulled back to the body, support hand up at the receiver, head
// tipped to the breech. `Soldier.reloading` was already in the sim and nobody
// drew it; a squad where you can see who is empty is a tactical read.
function reload(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  torso(g, k, 0.22, 0.31, band, w);
  const gx = 0.02;
  const gy = 0.16;
  cap(g, 0.02, 0.24, gx, gy, 0.12, k.sleeve);
  cap(g, 0.02, -0.22, 0.2, -0.14, 0.12, k.sleeve); // support hand up at the breech
  gun(g, w, gx, gy, 0.5, band);
  dot(g, gx, gy, 0.055, k.skin);
  dot(g, 0.2, -0.14, 0.055, k.skin);
  if (tier(band) >= 3) cap(g, 0.22, -0.16, 0.28, -0.1, 0.05, '#6b6250'); // fresh clip in the working hand
  helmet(g, k, 0.02, 0.03, band);
}

// Crawling under fire: the shaken (not pinned) man still advances, on his
// belly, dragging the weapon alongside.
function crawl(g: Ctx, k: Kit, w: WeaponKey, frame: number, band: number): void {
  const legs: [number, number, number, number][][] = [
    [
      [-0.45, 0.08, -0.7, 0.28],
      [-0.45, -0.06, -0.95, -0.14],
    ],
    [
      [-0.45, 0.08, -0.88, 0.2],
      [-0.45, -0.08, -0.88, -0.2],
    ],
    [
      [-0.45, -0.08, -0.7, -0.28],
      [-0.45, 0.06, -0.95, 0.14],
    ],
    [
      [-0.45, 0.08, -0.88, 0.2],
      [-0.45, -0.08, -0.88, -0.2],
    ],
  ];
  proneBody(g, k, legs[frame], band);
  const reach = frame === 0 || frame === 3 ? 0.62 : 0.5; // forward arm alternates
  cap(g, 0.14, -0.22, reach, -0.1, 0.12, k.sleeve);
  cap(g, 0.1, 0.22, 0.34, 0.2, 0.12, k.sleeve); // opposite elbow tucked under the chest
  dot(g, reach, -0.1, 0.055, k.skin);
  dot(g, 0.34, 0.2, 0.055, k.skin);
  gun(g, w, 0.42, 0.14, 0.12, band); // dragged alongside, not aimed
  helmet(g, k, 0.42, frame === 1 ? 0.02 : frame === 3 ? -0.02 : 0, band);
}

// Kneeling, between idle and prone: one leg tucked, torso compressed, weapon
// aimed level (S8).
function kneel(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  boot(g, k, -0.1, 0.16, 0.075, band); // planted boot
  if (tier(band) >= 2) cap(g, -0.16, 0.18, -0.1, 0.16, 0.045, '#2c261f'); // rear heel up off the ground
  dot(g, -0.14, -0.12, 0.075, '#3a3128'); // tucked knee
  cap(g, -0.14, -0.12, 0.05, -0.05, 0.13, k.trousers); // bent leg up to the hip
  if (tier(band) >= 2) dot(g, 0.12, -0.13, 0.075, k.trousers); // front knee forward of the boot
  g.save();
  g.rotate(-0.1); // same right-shoulder bias as the standing firing pose
  torso(g, k, 0.2, 0.27, band, w);
  g.restore();
  const gx = 0.1;
  const gy = 0.04;
  const fore = gunFore(w);
  const fx = gx + fore;
  cap(g, 0.02, 0.18, gx, gy, 0.12, k.sleeve);
  cap(g, 0.02, -0.2, fx, gy, 0.12, k.sleeve);
  gun(g, w, gx, gy, 0, band);
  dot(g, gx, gy, 0.055, k.skin);
  dot(g, fx, gy, 0.055, k.skin);
  helmet(g, k, 0.06, 0.05, band);
}

function proneBody(g: Ctx, k: Kit, legs: [number, number, number, number][], band: number): void {
  for (const [x0, y0, x1, y1] of legs) {
    cap(g, x0, y0, x1, y1, 0.14, k.trousers);
    dot(g, x1, y1, 0.075, '#3a3128');
  }
  const m = haloMult(band);
  if (!mono) cap(g, -0.5, 0, 0.28, 0, 0.42 + 0.1 * m, withAlpha(k.outline, m));
  cap(g, -0.5, 0, 0.28, 0, 0.42, k.uniform);
  if (mono || tier(band) === 0) return;
  cap(g, -0.28, -0.14, -0.05, -0.1, 0.05, 'rgba(42,36,24,0.5)');
  cap(g, -0.28, 0.14, -0.05, 0.1, 0.05, 'rgba(42,36,24,0.5)');
}

function prone(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  proneBody(g, k, [
    [-0.45, -0.08, -0.92, -0.19],
    [-0.45, 0.08, -0.92, 0.19],
  ], band);
  cap(g, 0.12, 0.24, 0.5, 0.12, 0.12, k.sleeve);
  cap(g, 0.15, -0.24, 0.58, -0.04, 0.12, k.sleeve);
  gun(g, w, 0.5, 0.05, 0, band);
  dot(g, 0.5, 0.1, 0.055, k.skin);
  dot(g, 0.58, -0.04, 0.055, k.skin);
  helmet(g, k, 0.42, 0, band);
}

function downed(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  gun(g, w, 0.25, 0.45, 0.5, band); // weapon dropped
  proneBody(g, k, [
    [-0.45, 0.02, -0.88, 0.06],
    [-0.45, 0.12, -0.9, 0.24],
  ], band);
  cap(g, 0.12, -0.2, 0.52, -0.28, 0.12, k.uniform); // one arm reaching out
  dot(g, 0.52, -0.28, 0.055, k.skin);
  helmet(g, k, 0.42, 0.05, band);
}

function dead(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  gun(g, w, -0.05, -0.5, -2.7, band); // weapon flung
  for (const [x0, y0, x1, y1] of [
    [-0.42, 0.08, -0.92, 0.32],
    [-0.4, -0.05, -0.82, -0.28],
  ] as const) {
    cap(g, x0, y0, x1, y1, 0.14, k.trousers);
    dot(g, x1, y1, 0.075, '#3a3128');
  }
  cap(g, -0.48, 0, 0.24, 0.12, 0.42, k.uniform); // no team rim — corpses carry no halo (S2)
  cap(g, 0.15, -0.05, 0.5, -0.42, 0.12, k.sleeve); // arms flung
  cap(g, 0.08, 0.25, 0.28, 0.52, 0.12, k.sleeve);
  dot(g, 0.5, -0.42, 0.055, k.skin);
  dot(g, 0.28, 0.52, 0.055, k.skin);
  dot(g, 0.42, 0.12, 0.14, k.skin); // bare head, helmet rolled away
  dot(g, 0.46, 0.09, 0.1, '#5a4632');
  dot(g, 0.7, -0.18, 0.16, k.helmet);
}

// A battlefield where every corpse is the same drawing rotated by a per-id
// jitter reads as procedural at a glance. Three sprawls, picked render-side by
// hash (never the sim RNG), kill that tell.
// dead1: curled on his side, knees up, arms in — the commonest real posture.
function deadCurled(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  gun(g, w, -0.28, 0.44, -1.9, band); // weapon dropped beside him
  for (const side of [-1, 1] as const) {
    cap(g, -0.3, side * 0.1, -0.56, side * 0.26, 0.14, k.trousers);
    cap(g, -0.56, side * 0.26, -0.26, side * 0.36, 0.13, k.trousers); // shin folded back under the thigh
    dot(g, -0.26, side * 0.36, 0.075, '#3a3128');
  }
  cap(g, -0.4, 0.04, 0.16, 0.02, 0.44, k.uniform);
  cap(g, 0.06, 0.16, -0.14, 0.3, 0.12, k.sleeve); // both arms drawn in to the chest
  cap(g, 0.06, -0.14, -0.1, -0.26, 0.12, k.sleeve);
  dot(g, -0.14, 0.3, 0.055, k.skin);
  dot(g, -0.1, -0.26, 0.055, k.skin);
  helmet(g, k, 0.38, -0.06, band); // head turned, helmet still on
}

// dead2: face-down, arms forward past the head, legs straight.
function deadFaceDown(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  gun(g, w, 0.55, 0.4, 1.1, band);
  for (const side of [-1, 1] as const) {
    cap(g, -0.42, side * 0.09, -0.98, side * 0.13, 0.14, k.trousers);
    dot(g, -0.98, side * 0.13, 0.075, '#3a3128');
  }
  cap(g, -0.5, 0, 0.2, 0, 0.42, k.uniform);
  cap(g, 0.1, 0.2, 0.64, 0.14, 0.12, k.sleeve); // arms thrown out past the head
  cap(g, 0.1, -0.2, 0.6, -0.2, 0.12, k.sleeve);
  dot(g, 0.64, 0.14, 0.055, k.skin);
  dot(g, 0.6, -0.2, 0.055, k.skin);
  helmet(g, k, 0.44, 0, band);
}

// Hands high, head bowed: the surrender read at a glance.
function surrenderHigh(g: Ctx, k: Kit, band: number): void {
  torso(g, k, 0.22, 0.31, band, 'garand');
  cap(g, 0.02, 0.24, 0.36, 0.42, 0.12, k.sleeve);
  cap(g, 0.02, -0.24, 0.36, -0.42, 0.12, k.sleeve);
  dot(g, 0.36, 0.42, 0.055, k.skin);
  dot(g, 0.36, -0.42, 0.055, k.skin);
  g.save();
  g.translate(0.04, 0);
  g.scale(0.94, 0.94); // head bowed reads as a slightly smaller helmet from above
  helmet(g, k, 0, 0, band);
  g.restore();
}

// Helmet off, held low in one hand — the other half of the surrender read.
function surrenderDoffed(g: Ctx, k: Kit, band: number): void {
  torso(g, k, 0.22, 0.31, band, 'garand');
  cap(g, 0.02, -0.24, 0.34, -0.4, 0.12, k.sleeve);
  dot(g, 0.34, -0.4, 0.055, k.skin);
  if (tier(band) >= 3) cap(g, 0.34, -0.42, 0.44, -0.5, 0.06, 'rgba(226,222,208,0.85)'); // white cloth
  cap(g, 0.02, 0.22, 0.26, 0.2, 0.12, k.sleeve);
  dot(g, 0.26, 0.2, 0.055, k.skin);
  dot(g, 0.28, 0.24, 0.12, k.helmet); // helmet carried at the hip
  dot(g, 0.04, 0, 0.14, k.skin); // bare head
  dot(g, 0.0, -0.02, 0.1, '#5a4632');
}

function torso(g: Ctx, k: Kit, rx: number, ry: number, band: number, weapon: WeaponKey): void {
  const m = haloMult(band);
  if (!mono) {
    g.fillStyle = withAlpha(k.outline, m);
    g.beginPath();
    g.ellipse(0, 0, rx + 0.05 * m, ry + 0.06 * m, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = paint(k.uniform);
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  if (mono) return;
  const t = tier(band);
  if (t >= 2) {
    // Edge-darkening gradient: a rounded back from any facing, and
    // rotation-invariant by construction — the directional signal lives in the
    // world-aligned glint and cast shadow, never in a baked highlight.
    g.save();
    g.clip();
    g.scale(1, ry / rx);
    const vol = g.createRadialGradient(0, 0, 0, 0, 0, rx * 1.05);
    vol.addColorStop(0.55, k.uniform);
    vol.addColorStop(1, mix(k.uniform, '#000000', 0.28));
    g.fillStyle = vol;
    g.fillRect(-rx * 1.2, -rx * 1.2, rx * 2.4, rx * 2.4);
    g.restore();
  }
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = Math.max(0.035, hair(band));
  g.stroke();
  if (t === 0) return; // silhouette + rim only at band 6
  if (t >= 2) {
    kitDetail(g, k, weapon, band);
    return;
  }
  torsoStraps(g);
  torsoGear(g, k, weapon);
}

// Rescuer hauling a casualty: leaning into it, both arms trailing back to the
// grip, weapon slung across the back.
function drag(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  torso(g, k, 0.22, 0.31, band, w);
  gun(g, w, -0.08, 0, 2.45, band); // slung
  cap(g, 0.02, 0.24, -0.36, 0.15, 0.12, k.sleeve);
  cap(g, 0.02, -0.24, -0.36, -0.15, 0.12, k.sleeve);
  dot(g, -0.36, 0.15, 0.055, k.skin);
  dot(g, -0.36, -0.15, 0.055, k.skin);
  helmet(g, k, 0.1, 0, band);
}

// Kneeling over the casualty, hands working, weapon slung.
function aid(g: Ctx, k: Kit, w: WeaponKey, band: number): void {
  dot(g, -0.26, 0.17, 0.075, '#3a3128'); // tucked boots
  dot(g, -0.26, -0.17, 0.075, '#3a3128');
  torso(g, k, 0.24, 0.29, band, w);
  gun(g, w, -0.08, 0, 2.45, band);
  cap(g, 0.04, 0.22, 0.4, 0.12, 0.12, k.sleeve);
  cap(g, 0.04, -0.22, 0.4, -0.12, 0.12, k.sleeve);
  dot(g, 0.4, 0.12, 0.055, k.skin);
  dot(g, 0.4, -0.12, 0.055, k.skin);
  helmet(g, k, 0.13, 0, band);
}

// Casualty on his back, arms overhead toward the dragger, weapon left behind.
function dragged(g: Ctx, k: Kit, band: number): void {
  for (const side of [-1, 1] as const) {
    cap(g, -0.35, side * 0.06, -0.95, side * 0.13, 0.14, k.trousers);
    dot(g, -0.95, side * 0.13, 0.075, '#3a3128');
  }
  const m = haloMult(band);
  if (!mono) cap(g, -0.4, 0, 0.15, 0, 0.42 + 0.1 * m, withAlpha(k.outline, m));
  cap(g, -0.4, 0, 0.15, 0, 0.42, k.uniform);
  cap(g, 0.08, 0.15, 0.52, 0.17, 0.12, k.sleeve);
  cap(g, 0.08, -0.15, 0.52, -0.17, 0.12, k.sleeve);
  dot(g, 0.52, 0.17, 0.055, k.skin);
  dot(g, 0.52, -0.17, 0.055, k.skin);
  helmet(g, k, 0.32, 0, band);
}

// Close combat: braced lunge stance, both hands working the weapon as a
// bayonet/club (SMGs read as hip-fire — the muzzle flash sells the shot).
// The enemy is at +X. Frames: 0 guard, 1 windup (coiled back), 2 thrust, 3 recover.
function melee(g: Ctx, k: Kit, w: WeaponKey, frame: number, band: number): void {
  const p = [
    { gx: 0.08, ga: -0.5, lean: 0.02, lunge: 0.3 },
    { gx: -0.1, ga: -0.75, lean: -0.05, lunge: 0.18 },
    { gx: 0.32, ga: 0.05, lean: 0.16, lunge: 0.58 },
    { gx: 0.16, ga: -0.3, lean: 0.07, lunge: 0.42 },
  ][frame];
  // front foot toward the enemy, rear foot planted
  cap(g, 0.05, 0.13, p.lunge, 0.17, 0.13, k.trousers);
  boot(g, k, p.lunge, 0.17, 0.07, band);
  cap(g, -0.05, -0.13, -0.28 - p.lunge * 0.4, -0.18, 0.13, k.trousers);
  dot(g, -0.28 - p.lunge * 0.4, -0.18, 0.07, '#3a3128');
  torso(g, k, 0.22, 0.31, band, w);
  const gy = 0.12;
  const fore = gunFore(w);
  const fx = p.gx + Math.cos(p.ga) * fore;
  const fy = gy + Math.sin(p.ga) * fore;
  cap(g, 0.02, 0.24, p.gx, gy, 0.12, k.sleeve);
  cap(g, 0.02, -0.24, fx, fy, 0.12, k.sleeve);
  gun(g, w, p.gx, gy, p.ga, band);
  if (GUNS[w].stock === 'wood' && !GUNS[w].slung) {
    // fixed bayonet — the melee read at a glance. Only on a rifle that has a
    // muzzle to fix it to: data.ts files bazookas under `rifle` too.
    const len = GUNS[w].len - GUNS[w].back;
    const mx = p.gx + Math.cos(p.ga) * len;
    const my = gy + Math.sin(p.ga) * len;
    cap(g, mx, my, mx + Math.cos(p.ga) * 0.22, my + Math.sin(p.ga) * 0.22, 0.045, '#cfd2d6');
  }
  dot(g, p.gx, gy, 0.055, k.skin);
  dot(g, fx, fy, 0.055, k.skin);
  helmet(g, k, 0.05 + p.lean, 0, band);
}

function drawDude(g: Ctx, side: Side, weapon: WeaponKey, pose: Pose, frame: number, band: number): void {
  const k = KITS[side];
  contactShadow(g);
  switch (pose) {
    case 'idle':
      standing(g, k, weapon, -0.55, 0, 0, band);
      break;
    case 'aim':
      standing(g, k, weapon, 0, 0, 0.05, band, true);
      break;
    case 'reload':
      reload(g, k, weapon, band);
      break;
    case 'walk': {
      const swing = Math.sin((frame / WALK_FRAMES) * Math.PI * 2);
      standing(g, k, weapon, -0.3 + swing * 0.12, swing, 0.02, band);
      break;
    }
    case 'crawl':
      crawl(g, k, weapon, frame, band);
      break;
    case 'kneel':
      kneel(g, k, weapon, band);
      break;
    case 'prone':
      prone(g, k, weapon, band);
      break;
    case 'downed':
      downed(g, k, weapon, band);
      break;
    case 'dead':
      dead(g, deadKit(k), weapon, band);
      break;
    case 'dead1':
      deadCurled(g, deadKit(k), weapon, band);
      break;
    case 'dead2':
      deadFaceDown(g, deadKit(k), weapon, band);
      break;
    case 'drag':
      drag(g, k, weapon, band);
      break;
    case 'aid':
      aid(g, k, weapon, band);
      break;
    case 'dragged':
      dragged(g, k, band);
      break;
    case 'melee':
      melee(g, k, weapon, frame, band);
      break;
    case 'surrendered':
      surrenderHigh(g, k, band);
      break;
    case 'surrender2':
      surrenderDoffed(g, k, band);
      break;
  }
}

const DUDE_BUDGET = 48 << 20; // bytes of baked canvas; a band-48 dude is ~117 KB
const cache = new SpriteCache(DUDE_BUDGET);

export function spriteCacheStats(): { entries: number; bytes: number } {
  return cache.stats();
}

export function getSprite(side: Side, weapon: WeaponKey, pose: Pose, frame: number, band: number, variant = 0): HTMLCanvasElement {
  // Key hygiene: a pose that never draws the weapon must not mint one canvas
  // per weapon, and a pose that shows no kit must not mint one per variant.
  // Collapse both dimensions here, in the key builder — never at the draw
  // site, or far bands quietly multiply the keyspace.
  const wk: WeaponKey = pose === 'surrendered' || pose === 'surrender2' || pose === 'dragged' ? 'garand' : weapon;
  const v = VARIANT_POSES.has(pose) ? variant : 0;
  const key = `${side}|${wk}|${pose}|${frame}|${band}|${v}`;
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
  kitBits = v;
  drawDude(g, side, wk, pose, frame, band);
  kitBits = 0;
  cache.set(key, c);
  return c;
}

// --- One sun on units (U2) -------------------------------------------------

// Cast-shadow silhouettes carry no side, weapon or kit dimension — three gun
// classes and a pose-frame is the whole keyspace, so the entire army shares a
// handful of textures.
const SHADOW_BUDGET = 6 << 20;
const shadowCache = new SpriteCache(SHADOW_BUDGET);
const SHADOW_WEAPON: Record<'rifle' | 'smg' | 'mg', WeaponKey> = { rifle: 'garand', smg: 'mp40', mg: 'mg42' };
const SHADOW_BAKE_BAND = 24; // never bake finer: the upscale at band 48 IS the feathering

export function weaponClass(w: WeaponKey): 'rifle' | 'smg' | 'mg' {
  return gunClass(w);
}

export function getShadowSprite(pose: Pose, frame: number, cls: 'rifle' | 'smg' | 'mg', band: number): HTMLCanvasElement {
  const sb = Math.min(SHADOW_BAKE_BAND, band);
  const key = `${pose}|${frame}|${cls}|${sb}`;
  let c = shadowCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  const px = Math.ceil(SPRITE_SPAN * sb);
  c.width = px;
  c.height = px;
  const g = c.getContext('2d')!;
  g.translate(px / 2, px / 2);
  g.scale(sb * DUDE_SCALE, sb * DUDE_SCALE);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  mono = true;
  kitBits = 0; // a shadow carries no kit, so it carries no role marks either
  drawDude(g, 'blue', SHADOW_WEAPON[cls], pose, frame, sb);
  mono = false;
  shadowCache.set(key, c);
  return c;
}

// Where the head sits in body units for each pose — read straight off the
// helmet() call sites. The renderer needs it to put the world-aligned glint on
// the head without unbaking the sprite.
const HEAD_OFFSET: Record<Pose, [number, number]> = {
  idle: [0.04, 0],
  aim: [0.04, 0.06],
  reload: [0.02, 0.03],
  walk: [0.04, 0],
  crawl: [0.42, 0],
  kneel: [0.06, 0.05],
  prone: [0.42, 0],
  downed: [0.42, 0.05],
  dead: [0.42, 0.12],
  dead1: [0.38, -0.06],
  dead2: [0.44, 0],
  drag: [0.1, 0],
  aid: [0.13, 0],
  dragged: [0.32, 0],
  melee: [0.05, 0],
  surrendered: [0.04, 0],
  surrender2: [0.04, 0],
};

export function headOffset(pose: Pose): [number, number] {
  return HEAD_OFFSET[pose];
}

// One shared helmet glint: a NW-lit highlight with a matching SE shade limb,
// drawn UNROTATED on the head so 247 men are lit by the same sun. Baked once —
// the frame loop only ever pays for one small textured quad.
let glint: HTMLCanvasElement | null = null;
export function glintSprite(): HTMLCanvasElement {
  if (glint) return glint;
  const px = 32;
  const r = px / 2;
  glint = document.createElement('canvas');
  glint.width = px;
  glint.height = px;
  const g = glint.getContext('2d')!;
  g.beginPath();
  g.arc(r, r, r * 0.94, 0, Math.PI * 2);
  g.clip(); // the light lives on the dome, never past its edge
  const lx = r - SUN.dx * r * 0.35;
  const ly = r - SUN.dy * r * 0.35;
  const lit = g.createRadialGradient(lx, ly, 0, lx, ly, r * 0.62);
  lit.addColorStop(0, 'rgba(255,255,255,0.18)');
  lit.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = lit;
  g.fillRect(0, 0, px, px);
  const dx = r + SUN.dx * r * 0.55;
  const dy = r + SUN.dy * r * 0.55;
  const shade = g.createRadialGradient(dx, dy, 0, dx, dy, r * 0.6);
  shade.addColorStop(0, 'rgba(0,0,0,0.10)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, px, px);
  return glint;
}
