// Rebindable keyboard map. Pure logic + optional Storage so it is testable
// under vitest (node env, no localStorage).

export type ActionId =
  | 'pause' | 'mute' | 'menu' | 'cancel'            // global
  | 'barrage' | 'airstrike'                         // battle-global
  | 'panUp' | 'panDown' | 'panLeft' | 'panRight'    // battle camera
  | 'squad1' | 'squad2' | 'squad3' | 'squad4' | 'squad5' | 'squad6' | 'squad7' | 'squad8' | 'squad9'  // battle
  | 'order1' | 'order2' | 'order3' | 'order4' | 'order5' | 'order6' | 'order7' | 'order8'              // battle
  | 'aiControl' | 'floorFocus'                      // battle
  | 'speed1' | 'speed2' | 'speed3';                 // strategic

export interface Binding { code: string; shift?: boolean }

export interface Keymap {
  bindings: Record<ActionId, Binding>;
  version: number;
}

export const DEFAULTS: Record<ActionId, Binding> = {
  pause:     { code: 'Space' },
  mute:      { code: 'KeyM' },
  menu:      { code: 'Escape' },
  cancel:    { code: 'Escape' },
  barrage:   { code: 'KeyB' },
  airstrike: { code: 'KeyV' },
  panUp:     { code: 'KeyW' },
  panDown:   { code: 'KeyS' },
  panLeft:   { code: 'KeyA' },
  panRight:  { code: 'KeyD' },
  squad1:    { code: 'Digit1' }, squad2: { code: 'Digit2' }, squad3: { code: 'Digit3' },
  squad4:    { code: 'Digit4' }, squad5: { code: 'Digit5' }, squad6: { code: 'Digit6' },
  squad7:    { code: 'Digit7' }, squad8: { code: 'Digit8' }, squad9: { code: 'Digit9' },
  order1:    { code: 'Digit1', shift: true }, order2: { code: 'Digit2', shift: true },
  order3:    { code: 'Digit3', shift: true }, order4: { code: 'Digit4', shift: true },
  order5:    { code: 'Digit5', shift: true }, order6: { code: 'Digit6', shift: true },
  order7:    { code: 'Digit7', shift: true }, order8: { code: 'Digit8', shift: true },
  speed1:    { code: 'Digit1' }, speed2: { code: 'Digit2' }, speed3: { code: 'Digit3' },
  aiControl: { code: 'KeyP' },
  floorFocus: { code: 'KeyF' },
};

export const CONTEXT: Record<ActionId, 'global' | 'battle' | 'strategic'> = {
  pause: 'global', mute: 'global', menu: 'global', cancel: 'global',
  barrage: 'battle', airstrike: 'battle',
  panUp: 'battle', panDown: 'battle', panLeft: 'battle', panRight: 'battle',
  squad1: 'battle', squad2: 'battle', squad3: 'battle', squad4: 'battle', squad5: 'battle',
  squad6: 'battle', squad7: 'battle', squad8: 'battle', squad9: 'battle',
  order1: 'battle', order2: 'battle', order3: 'battle', order4: 'battle',
  order5: 'battle', order6: 'battle', order7: 'battle', order8: 'battle',
  speed1: 'strategic', speed2: 'strategic', speed3: 'strategic',
  aiControl: 'battle', floorFocus: 'battle',
};

const ORDER_KINDS_LABEL = ['Move', 'Fast', 'Sneak', 'Fire', 'Smoke', 'Defend', 'Ambush', 'Assault'];

export const LABEL: Record<ActionId, string> = {
  pause: 'Pause', mute: 'Mute', menu: 'Menu', cancel: 'Cancel',
  barrage: 'Barrage', airstrike: 'Airstrike',
  panUp: 'Pan camera up', panDown: 'Pan camera down', panLeft: 'Pan camera left', panRight: 'Pan camera right',
  squad1: 'Select squad 1', squad2: 'Select squad 2', squad3: 'Select squad 3',
  squad4: 'Select squad 4', squad5: 'Select squad 5', squad6: 'Select squad 6',
  squad7: 'Select squad 7', squad8: 'Select squad 8', squad9: 'Select squad 9',
  order1: `Order: ${ORDER_KINDS_LABEL[0]}`, order2: `Order: ${ORDER_KINDS_LABEL[1]}`,
  order3: `Order: ${ORDER_KINDS_LABEL[2]}`, order4: `Order: ${ORDER_KINDS_LABEL[3]}`,
  order5: `Order: ${ORDER_KINDS_LABEL[4]}`, order6: `Order: ${ORDER_KINDS_LABEL[5]}`,
  order7: `Order: ${ORDER_KINDS_LABEL[6]}`, order8: `Order: ${ORDER_KINDS_LABEL[7]}`,
  speed1: 'Speed 1×', speed2: 'Speed 10×', speed3: 'Speed 60×',
  aiControl: 'AI auto-command',
  floorFocus: 'Cycle floor focus',
};

const STORAGE_KEY = 'rts.keymap.v1';

export function loadKeymap(storage?: Storage): Keymap {
  let bindings = { ...DEFAULTS };
  let version = 0;
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed.bindings ?? {})) {
            if (!(k in DEFAULTS)) continue; // unknown ids ignored
            const b = v as Binding;
            if (b && typeof b.code === 'string') {
              bindings[k as ActionId] = { code: b.code, shift: b.shift ?? false };
            }
          }
          version = typeof parsed.version === 'number' ? parsed.version : 0;
        }
      }
    } catch { /* storage corrupt/unavailable → defaults */ }
  }
  return { bindings, version };
}

export function saveKeymap(km: Keymap, storage?: Storage): void {
  km.version++; // consumers (HUD sig) key re-renders off this
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(km));
  } catch { /* quota exceeded / unavailable */ }
}

export function formatBinding(b: Binding): string {
  const code = b.code;
  let s: string;
  if (code.startsWith('Digit')) s = code.slice(5);
  else if (code.startsWith('Key')) s = code.slice(3);
  else if (code === 'Space') s = 'Space';
  else if (code === 'Escape') s = 'Esc';
  else s = code;
  return b.shift ? `⇧${s}` : s;
}

// Returns first binding whose code matches e.code and shift-flag matches
// e.shiftKey. A binding without shift must NOT fire when shift is held, and
// vice versa. Iterates in DEFAULTS declaration order for deterministic ties.
export function actionForEvent(e: KeyboardEvent, km: Keymap): ActionId | null {
  for (const id of Object.keys(DEFAULTS) as ActionId[]) {
    const b = km.bindings[id];
    if (b.code === e.code && (b.shift ?? false) === e.shiftKey) return id;
  }
  return null;
}

// Assigns binding with swap semantics: if another action in the same context
// holds b, it receives this action's PREVIOUS binding. If that previous binding
// itself collides with a third action, that third action reverts to default
// (one level deep). Guarantees no two actions in a context share a binding.
export function rebind(km: Keymap, action: ActionId, b: Binding): void {
  const ctx = CONTEXT[action];
  const prev = { ...km.bindings[action] };

  for (const [id, existing] of Object.entries(km.bindings)) {
    if (id === action) continue;
    if (CONTEXT[id as ActionId] !== ctx) continue;
    if ((existing.shift ?? false) === (b.shift ?? false) && existing.code === b.code) {
      km.bindings[id as ActionId] = prev;
      for (const [id2, existing2] of Object.entries(km.bindings)) {
        if (id2 === id || id2 === action) continue;
        if (CONTEXT[id2 as ActionId] !== ctx) continue;
        if ((existing2.shift ?? false) === (prev.shift ?? false) && existing2.code === prev.code) {
          km.bindings[id2 as ActionId] = { ...DEFAULTS[id2 as ActionId] };
        }
      }
    }
  }
  km.bindings[action] = { code: b.code, shift: b.shift ?? false };
}
