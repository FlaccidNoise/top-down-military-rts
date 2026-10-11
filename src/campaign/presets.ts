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
      redStrength: 4,
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
      redStrength: 4,
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
      redStrength: 4,
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
// battle commanders. On main at the jtbug #797 commit (2026-10-11: the
// calibrated battle math and red's five battlegroups), 12 seeds each:
//   Skirmish, weakest garrison   odds 4.2 to 5.5 : 1, blue won 11, lost 1,
//                                median 26 killed of 143, 2 to 5 minutes.
//   Skirmish, nearest objective  odds from 1.6 : 1, blue won 12.
//   Normandy Bocage, weakest     odds 1.2 to 5 : 1, blue won 12, median 34
//                                killed. Nearest objective: blue won 12.
// "Weakest garrison" is the town the tutorial's march step rings (theaterMark
// in src/main.ts). Skirmish stays first for what it leaves out: fog, supply
// and night tempo are off, and red fields two battlegroups where the standard
// presets field five. Once a campaign has been finished, New campaign starts
// DEFAULT_PRESET (src/main.ts). Re-run the sweep after a balance pass.
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
