import type { Campaign } from '../campaign/campaign';
import type { WeaponKey } from '../sim/data';
import { Front, type FrontSave } from './front';
import { makeDefaultSector } from './sector';

const KEY = 'ccg-save-v2';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Old saves carry pre-M5 generic weapon keys; map them onto their national
// replacements at the boundary where old saves enter the sim.
const LEGACY_WEAPONS: Record<string, WeaponKey> = { rifle: 'garand', smg: 'thompson', mg: 'bar' };

// Storage throws synchronously in private browsing / over quota; a save runs
// inside the rAF loop, so an uncaught throw would freeze the whole game.
export function saveGame(campaign: Campaign, front: Front, storage: Store = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify({ campaign, front: front.save() }));
  } catch (err) {
    console.warn('saveGame failed; progress will not persist:', err);
  }
}

export function loadGame(storage: Store = localStorage): { campaign: Campaign; front: Front } | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
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
