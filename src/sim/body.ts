// RimWorld-style anatomy: hits roll a body part, wounds degrade capacities,
// capacities degrade combat stats. Computed only on hit events.

export interface PartDef {
  key: string;
  name: string;
  hp: number;
  hitW: number; // hit-location roll weight
  pain: number; // pain multiplier
  bleed: number; // bleed multiplier
}

export const PARTS: PartDef[] = [
  { key: 'head', name: 'head', hp: 25, hitW: 7, pain: 1.5, bleed: 1.0 },
  { key: 'eyes', name: 'eyes', hp: 8, hitW: 1, pain: 2.0, bleed: 0.3 },
  { key: 'torso', name: 'torso', hp: 40, hitW: 34, pain: 1.0, bleed: 1.2 },
  { key: 'l-arm', name: 'left arm', hp: 30, hitW: 8, pain: 1.0, bleed: 0.7 },
  { key: 'r-arm', name: 'right arm', hp: 30, hitW: 8, pain: 1.0, bleed: 0.7 },
  { key: 'l-hand', name: 'left hand', hp: 14, hitW: 3, pain: 1.2, bleed: 0.4 },
  { key: 'r-hand', name: 'right hand', hp: 14, hitW: 3, pain: 1.2, bleed: 0.4 },
  { key: 'l-leg', name: 'left leg', hp: 30, hitW: 13, pain: 1.0, bleed: 0.8 },
  { key: 'r-leg', name: 'right leg', hp: 30, hitW: 13, pain: 1.0, bleed: 0.8 },
  { key: 'l-foot', name: 'left foot', hp: 14, hitW: 3, pain: 1.2, bleed: 0.4 },
  { key: 'r-foot', name: 'right foot', hp: 14, hitW: 3, pain: 1.2, bleed: 0.4 },
];

export const P = { HEAD: 0, EYES: 1, TORSO: 2, L_ARM: 3, R_ARM: 4, L_HAND: 5, R_HAND: 6, L_LEG: 7, R_LEG: 8, L_FOOT: 9, R_FOOT: 10 } as const;

const TOTAL_HIT_W = PARTS.reduce((a, p) => a + p.hitW, 0);

export function freshBody(): number[] {
  return PARTS.map((p) => p.hp);
}

export function rollPart(roll: number): number {
  let r = roll * TOTAL_HIT_W;
  for (let i = 0; i < PARTS.length; i++) {
    r -= PARTS[i].hitW;
    if (r <= 0) return i;
  }
  return P.TORSO;
}

export interface Wound {
  part: number;
  dmg: number; // damage actually applied to the part
}

export interface HitResult {
  wound: Wound;
  pain: number; // pain added
  bleedRate: number; // blood loss per second added
  fatal: boolean; // head or torso destroyed
}

export function applyHit(body: number[], part: number, dmg: number): HitResult {
  const def = PARTS[part];
  const applied = Math.min(body[part], dmg);
  body[part] -= applied;
  const frac = applied / def.hp;
  return {
    wound: { part, dmg: applied },
    pain: frac * def.pain * 0.45,
    bleedRate: frac * def.bleed * 0.0035,
    fatal: (part === P.HEAD || part === P.TORSO) && body[part] <= 0,
  };
}

export interface Capacities {
  manipulation: number;
  moving: number;
  sight: number;
}

export function capacities(body: number[]): Capacities {
  const f = (i: number) => body[i] / PARTS[i].hp;
  return {
    manipulation: 0.5 * f(P.L_ARM) * f(P.L_HAND) + 0.5 * f(P.R_ARM) * f(P.R_HAND),
    moving: 0.5 * f(P.L_LEG) * f(P.L_FOOT) + 0.5 * f(P.R_LEG) * f(P.R_FOOT),
    sight: 0.2 + 0.8 * f(P.EYES),
  };
}

export function consciousness(pain: number, bloodLoss: number): number {
  const c = (1 - bloodLoss * 1.2) * (1 - Math.max(0, pain - 0.15) * 0.5);
  return Math.min(1, Math.max(0, c));
}

export function woundLabel(w: Wound): string {
  const def = PARTS[w.part];
  const frac = w.dmg / def.hp;
  const sev = frac >= 1 ? 'mangled' : frac > 0.6 ? 'serious' : frac > 0.3 ? 'wounded' : 'grazed';
  return `${def.key}: ${sev}`;
}
