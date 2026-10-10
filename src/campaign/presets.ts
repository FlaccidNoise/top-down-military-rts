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
// The three standard presets play under fog (recon 'contacts', jtbug #786):
// the Screen posture is the player's way to see. Skirmish keeps every realism
// rule off, fog with them.
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
      recon: 'contacts',
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
      recon: 'contacts',
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
      recon: 'contacts',
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

function presetNamed(name: string): Preset {
  const p = PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`presets: no preset named "${name}"`);
  return p;
}

// The campaign a new player is put into with no setup screen: the main menu's
// New campaign, and "Start the campaign" after the drill. Chosen by
// measurement, not taste: scripts/firstcontact.mjs marches the strongest
// company at an objective on each preset and fights what it meets with both
// battle commanders. On the sim of 2026-10-10 (main at 227cce7), 12 seeds each:
//   Skirmish         odds 2.4 to 4.8 : 1, blue won 10, lost 1, 1 undecided,
//                    median 30 killed of 143. At the weakest garrison instead
//                    of the nearest (what the tutorial's ring points at):
//                    won 12 of 12, median 35 killed.
//   Normandy Bocage  odds 1.5 to 3.5 : 1, blue won 8, lost 2, 2 undecided,
//                    median 68 killed of 143.
// River Line and Open Country open at 1.3 : 1 median odds and were not fought.
// Re-run the sweep after a balance pass. DEFAULT_PRESET stays the setup
// screen's starting point.
export const FIRST_PRESET = presetNamed('Skirmish');

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
