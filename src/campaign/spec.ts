import { mulberry32, type Rng } from '../sim/rng';

// CampaignSpec is the persisted, shareable unit AND the object the generator
// consumes: a raw seed without its config cannot regenerate the theater.
// It reaches src/ui only as data — nothing here may import src/ui, which owns
// the one entropy source in the app (src/ui/seed.ts).

// Bumped whenever a generation stage changes shape. Saves carrying a different
// genVersion reject as 'stale-generator' rather than regenerating a different
// map. This is the number src/strategic/theater.ts THEATER_VERSION takes (S5) —
// one version, two readers, never two constants.
export const GEN_VERSION = 1;

export type TheaterSizeKm = 18 | 24 | 32;
export type TerrainMix = 'bocage' | 'open' | 'wooded' | 'marshland';

// Reaches makeTheater. Every field is a generation knob; none may carry war
// state, or a war-length change would move the map (§9.2).
export interface TheaterConfig {
  sizeKm: TheaterSizeKm; // long axis, 4:3
  riverDensity: 1 | 2 | 3; // 0 would mint no crossing node and reject every seed
  crossingScarcity: 0 | 1 | 2;
  roadDensity: 0 | 1 | 2 | 3;
  railDensity: 0 | 1 | 2;
  townDensity: 1 | 2 | 3 | 4 | 5 | 6; // towns per 100 km², capped by townSpacingMinKm
  townSpacingMinKm: 2 | 3 | 4 | 5;
  terrainMix: TerrainMix;
  woodsShare: 1 | 2 | 3 | 4; // 0 cannot satisfy the forest area band
}

export type VictoryPreset = 'objectives' | 'majority';
export type RedDoctrine = 'defensive' | 'offensive';
export type ReconMode = 'omniscient' | 'contacts';

// Structurally unable to reach the generator: makeTheater takes TheaterConfig only.
export interface CampaignConfig {
  warDays: 7 | 14 | 21 | 30; // what OP_DEADLINE_DAYS becomes
  victory: VictoryPreset;
  blueCompanies: 2 | 3 | 4;
  redStrength: 0 | 1 | 2 | 3 | 4;
  redDoctrine: RedDoctrine;
  supply: boolean;
  recon: ReconMode;
  nightTempo: boolean;
}

export interface CampaignSpec {
  genVersion: number;
  seed: number; // uint32; the single seed of record
  seedText: string; // what the player typed; parseSeed(seedText) === seed
  theater: TheaterConfig;
  campaign: CampaignConfig;
}

// A war shorter than this on a theater this large cannot be won by marching;
// feasible(cfg) rejects the combination by name instead of shipping it.
export const MIN_WAR_DAYS: Record<TheaterSizeKm, number> = { 18: 7, 24: 14, 32: 21 };

// Frozen and append-only: retuning red strength must never rename the men or
// move the map, so every consumer draws on its own tag.
export const SPEC_TAG = { THEATER: 1, ROSTER: 2, DISPOSITION: 3, AI_SALT: 4 } as const;
export type SpecTag = (typeof SPEC_TAG)[keyof typeof SPEC_TAG];

// mulberry32 is a 32-bit counter: two streams seeded 1 apart are correlated for
// their first few outputs, so the tag is spaced by the golden-ratio odd
// constant rather than added (src/sim/bourg/streets.ts subStream). Never seed + tag.
export function specSeed(spec: CampaignSpec, tag: SpecTag): number {
  return (spec.seed ^ Math.imul(tag, 0x9e3779b1)) >>> 0;
}

export function specStream(spec: CampaignSpec, tag: SpecTag): Rng {
  return mulberry32(specSeed(spec, tag));
}
