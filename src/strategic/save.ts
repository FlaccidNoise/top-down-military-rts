import type { Campaign } from '../campaign/campaign';
import type { WeaponKey } from '../sim/data';
import { Front, type FrontSave } from './front';
import { makeDefaultSector } from './sector';

const KEY = 'ccg-save-v2';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Old saves carry pre-M5 generic weapon keys; map them onto their national
// replacements at the boundary where old saves enter the sim.
const LEGACY_WEAPONS: Record<string, WeaponKey> = { rifle: 'garand', smg: 'thompson', mg: 'bar' };

export function saveGame(campaign: Campaign, front: Front, storage: Store = localStorage): void {
  storage.setItem(KEY, JSON.stringify({ campaign, front: front.save() }));
}

export function loadGame(storage: Store = localStorage): { campaign: Campaign; front: Front } | null {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { campaign: Campaign; front: FrontSave };
    for (const s of Object.values(parsed.campaign.soldiers)) {
      const legacy = LEGACY_WEAPONS[s.weapon];
      if (legacy) s.weapon = legacy;
    }
    return { campaign: parsed.campaign, front: Front.restore(makeDefaultSector(), parsed.front) };
  } catch {
    return null;
  }
}
