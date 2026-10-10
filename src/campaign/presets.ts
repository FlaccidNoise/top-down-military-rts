import { GEN_VERSION, type CampaignConfig, type CampaignSpec, type TheaterConfig } from './spec';

// The four frozen setup presets. Editing a knob in the customize screen relabels
// the selection 'Custom (from X)' — the preset objects themselves never change,
// so a shared spec generated from a preset stays reproducible.

export interface Preset {
  name: string;
  theater: TheaterConfig;
  campaign: CampaignConfig;
}

// townDensity is towns per 100 km²: the default 24×18 km theater (432 km²) at
// density 1 asks for 4.3 towns, which is the plausibility band §2 pins at 3-5.
// recon stays 'omniscient' until ContactIntel and its doctrine re-tune ship (S53).
export const PRESETS: readonly Preset[] = [
  {
    name: 'Normandy Bocage',
    theater: {
      sizeKm: 24,
      riverDensity: 2,
      crossingScarcity: 1,
      roadDensity: 2,
      railDensity: 1,
      townDensity: 1,
      townSpacingMinKm: 5,
      terrainMix: 'bocage',
      woodsShare: 2,
    },
    campaign: {
      warDays: 14,
      victory: 'objectives',
      blueCompanies: 3,
      redStrength: 2,
      supply: true,
      recon: 'omniscient',
      nightTempo: true,
    },
  },
  {
    name: 'River Line',
    theater: {
      sizeKm: 24,
      riverDensity: 3,
      crossingScarcity: 2,
      roadDensity: 2,
      railDensity: 1,
      townDensity: 1,
      townSpacingMinKm: 5,
      terrainMix: 'marshland',
      woodsShare: 2,
    },
    campaign: {
      warDays: 21,
      victory: 'objectives',
      blueCompanies: 3,
      redStrength: 3,
      supply: true,
      recon: 'omniscient',
      nightTempo: true,
    },
  },
  {
    name: 'Open Country',
    theater: {
      sizeKm: 32,
      riverDensity: 1,
      crossingScarcity: 0,
      roadDensity: 3,
      railDensity: 2,
      townDensity: 1,
      townSpacingMinKm: 5,
      terrainMix: 'open',
      woodsShare: 1,
    },
    campaign: {
      warDays: 21,
      victory: 'majority',
      blueCompanies: 4,
      redStrength: 3,
      supply: true,
      recon: 'omniscient',
      nightTempo: true,
    },
  },
  {
    name: 'Skirmish',
    theater: {
      sizeKm: 18,
      riverDensity: 1,
      crossingScarcity: 1,
      roadDensity: 2,
      railDensity: 0,
      townDensity: 2,
      townSpacingMinKm: 3,
      terrainMix: 'wooded',
      woodsShare: 3,
    },
    campaign: {
      warDays: 7,
      victory: 'majority',
      blueCompanies: 2,
      redStrength: 1,
      supply: false,
      recon: 'omniscient',
      nightTempo: false,
    },
  },
];

export const DEFAULT_PRESET = PRESETS[0];

// Copies both configs: the customize screen edits the returned spec in place.
export function presetSpec(p: Preset, seed: number, seedText = String(seed >>> 0)): CampaignSpec {
  return {
    genVersion: GEN_VERSION,
    seed: seed >>> 0,
    seedText,
    theater: { ...p.theater },
    campaign: { ...p.campaign },
  };
}
