import type { Campaign } from '../campaign/campaign';
import { Front, type FrontSave } from './front';
import { makeDefaultSector } from './sector';

const KEY = 'ccg-save-v2';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function saveGame(campaign: Campaign, front: Front, storage: Store = localStorage): void {
  storage.setItem(KEY, JSON.stringify({ campaign, front: front.save() }));
}

export function loadGame(storage: Store = localStorage): { campaign: Campaign; front: Front } | null {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { campaign: Campaign; front: FrontSave };
    return { campaign: parsed.campaign, front: Front.restore(makeDefaultSector(), parsed.front) };
  } catch {
    return null;
  }
}
