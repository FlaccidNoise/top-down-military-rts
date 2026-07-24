# Controls Pass — trackpad + configurable keys + multi-select formations

Goal: MacBook trackpad-first controls, fully rebindable keys (pause menu →
keybindings), box-select multi-squad command, honest move preview (slots =
actual eligible men), and right-drag formation control (orientation + width).

Branch: work on `main`. Run `npx tsc --noEmit` and `npm test` — must stay green
(68+ tests currently). Existing behavior defaults must not change unless noted.

## 1. `src/ui/keymap.ts` (NEW)

Rebindable keyboard map. No DOM deps — pure logic + optional Storage so it is
testable under vitest (node env, no localStorage).

```ts
export type ActionId =
  | 'pause' | 'mute' | 'menu' | 'cancel'            // global
  | 'barrage' | 'airstrike'                         // battle-global
  | 'squad1' | … | 'squad9'                         // battle
  | 'order1' | … | 'order8'                         // battle
  | 'speed1' | 'speed2' | 'speed3';                 // strategic
export interface Binding { code: string; shift?: boolean } // KeyboardEvent.code
export interface Keymap { bindings: Record<ActionId, Binding>; version: number }
```

- `DEFAULTS: Record<ActionId, Binding>` — pause `Space`, mute `KeyM`,
  menu `Escape`, cancel `Escape`, barrage `KeyB`, airstrike `KeyA`,
  squad1..9 `Digit1..9`, order1..8 `Digit1..8` + `shift:true`,
  speed1..3 `Digit1..3`.
- `CONTEXT: Record<ActionId, 'global'|'battle'|'strategic'>` — conflicts only
  matter within a context (Digit1 = squad1 in battle, speed1 in strategic).
- `LABEL: Record<ActionId, string>` — human names for the rebind UI
  ('Pause', 'Select squad 1', 'Order: Move', …, orderN labels use ORDER_KINDS).
- `loadKeymap(storage?: Storage): Keymap` — read `rts.keymap.v1` JSON, merge
  over DEFAULTS (unknown ids ignored, missing ids get defaults), try/catch →
  defaults. `saveKeymap(k, storage?)` persists + bumps `version`.
- `formatBinding(b): string` — display form: `Digit3`→`3`, `KeyB`→`B`,
  `Space`→`Space`, `Escape`→`Esc`, prepend `⇧` when `shift`.
- `actionForEvent(e: KeyboardEvent, k): ActionId | null` — first binding whose
  code matches `e.code` and shift-flag matches `e.shiftKey` (a binding without
  shift must NOT fire when shift is held, and vice versa). Global context wins
  ties deterministically by DEFAULTS declaration order — simplest: iterate
  Object.entries(k.bindings) in DEFAULTS order.
- `rebind(k, action, b)` — assigns; if another action **in the same context**
  holds `b`, that action reverts to its DEFAULT binding (never leaves two
  actions on one key in one context).

## 2. `src/ui/menu.ts` (NEW)

Pause menu DOM overlay (own `<div id="pausemenu">`, styled in ui.css —
reuse the `#debrief` `.db` panel look: dark panel, monospace, same buttons).

```ts
export class PauseMenu {
  constructor(cb: { onResume(): void; onKeymapChanged(k: Keymap): void })
  open(): void; close(): void; toggle(): void;
  get isOpen(): boolean;
}
```

- Main view: title `PAUSED`, buttons `Resume` and `Keybindings`.
- Keybindings view: rows grouped by context (GLOBAL / BATTLE / STRATEGIC):
  label + a button showing `formatBinding`. Click a binding button → it shows
  `press a key…`; the next keydown (window capture-phase listener,
  `preventDefault` + `stopPropagation`) becomes the binding via `rebind` +
  `saveKeymap` + `onKeymapChanged`. `Escape` while capturing cancels the
  capture instead of binding. `Reset to defaults` button restores DEFAULTS.
  `Back` returns to main view.
- While open, main.ts's keydown handler ignores everything except the menu's
  own capture listener (check `menu.isOpen` first).

## 3. Formation math — `src/sim/sim.ts`

- Export constants `TEAM_FAN = 8` (current hardcoded 8 in orderSquad) and
  `SQUAD_FAN = 12` (new, plain-click multi-squad fanout).
- `export function fanOffsets(n: number, spacing: number): number[]` —
  centered offsets `[ (i-(n-1)/2)*spacing ]`. Refactor orderSquad's existing
  `oy = (ti-(n-1)/2)*8` to use it (identical values).
- `export function formationSlots(count: number, facing?: number, width?: number): [number, number][]`
  offsets relative to destination:
  - `facing === undefined`: `OFFSETS[i % OFFSETS.length]` for i<count
    (exactly current behavior).
  - facing set: rank-and-file grid whose long axis runs ALONG `facing`:
    `cols = max(2, round((width ?? count*1.5) / 1.5))`,
    `rows = ceil(count/cols)`; slot i: `col = i%cols`, `row = floor(i/cols)`;
    local `lx = (col-(cols-1)/2)*1.5`, `ly = (row-(rows-1)/2)*1.5`;
    rotate: `ox = lx*cos(f) - ly*sin(f)`, `oy = lx*sin(f) + ly*cos(f)`.
- `TeamOrder` (src/sim/orders.ts) gains `facing?: number; width?: number`
  (meters, full front-line width).
- `moveSoldiersTo(soldierIds, wx, wy, facing?, width?)`: replace the
  `OFFSETS[slot % OFFSETS.length]` line with
  `formationSlots(<eligible count>, facing, width)` indexed per eligible
  soldier (same findSpot/used/path flow otherwise — slots count must equal
  eligible count, computed once up front).
- `orderTeam`: pass `effective.facing/width` through to both
  `moveSoldiersTo` call sites (executing branch + defend/ambush branch).
- `orderSquad(squadId, order)`:
  - `order.facing === undefined` → legacy: `fanOffsets(n, TEAM_FAN)` applied
    to y only (byte-identical to today).
  - facing set → teams fan ALONG the facing axis within `order.width`:
    `share = (order.width ?? n*TEAM_FAN) / n`,
    `off = fanOffsets(n, share)[ti]`; team dest =
    `x + cos(f)*off`, `y + sin(f)*off`; per-team order gets
    `{ ...order, x, y, width: share }`.
- `squadDest` route-preview bookkeeping unchanged.

## 4. Input rework — `src/main.ts`

State: add `let selectedSquads: number[] = []` (primary = LAST element).
Keep `selectedSquad` as the primary for all existing call sites
(HUD detail card, team narrowing, computeShot) — sync it whenever
selectedSquads changes. `selectSquad(id)` → `selectedSquads = id<0 ? [] : [id]`.
Add `toggleSquadSelection(id)` for shift-add. Team narrowing
(`selectedTeam`) only when `selectedSquads.length === 1`.

- **Trackpad**: `wheel` — `e.ctrlKey` (macOS pinch) or `e.shiftKey` → existing
  zoom; otherwise pan: `cam.x -= e.deltaX / cam.scale; cam.y -= e.deltaY / cam.scale`
  (battle mode only, as today).
- **Left-drag = box select** (battle only; remove drag-pan — pan is the
  two-finger scroll now): mousedown records `dragStart`; mousemove past 5px →
  `boxRect` (screen coords, normalized); mouseup with boxRect → world rect via
  `cam.screenToWorld` on both corners; select every blue squad with ≥1 alive,
  on-foot (`inVehicle < 0`), non-downed soldier inside. `shiftKey` → union with
  current selection; else replace. Empty box → clear (unless shift). No drag →
  existing click-pick logic, extended: shift+click on a soldier/emplacement
  squad toggles that squad in the multi-selection; plain click = replace.
- **Right-drag = formation order**: on `mousedown` button 2 record screen +
  world anchor (`rmb`). `contextmenu` now ONLY `preventDefault()` (plus the
  strategic chit-move logic moves to `mouseup`). On `mouseup` button 2:
  - strategic mode → the chit-move logic currently in contextmenu.
  - battle, `targetMode` set → nothing (target modes use left click).
  - drag length < 2m world → legacy behavior exactly (armed order /
    shift-queueMove / team / squad order, now fanned per squad when
    multi-selected: squad i dest `y += fanOffsets(K, SQUAD_FAN)[i]` — match
    overlays preview).
  - drag ≥ 2m → `facing = atan2(wdy, wdx)`, `width = clamp(len, 3, 60)`;
    squads split the line: `seg = width / K`, squad i center offset along
    facing = `fanOffsets(K, seg)[i]`; issue per squad
    `orderSquad(id, { kind: armedOrder ?? 'move', x: ax+cos(f)*off, y: ay+sin(f)*off, facing, width: seg })`
    (armed order only for move-family kinds move/fast/sneak/assault/defend/
    ambush; fire/smoke fall back to plain click behavior at the anchor).
  - Live preview while rmb held: pass `{ ax, ay, facing, width }` to overlays.
- **Keydown**: dispatch via `actionForEvent` on the loaded keymap.
  If `menu.isOpen` → return (menu's own capture listener handles keys).
  Cancel/menu chain (battle): targetMode→clear, armedOrder→clear,
  selectedTeam→widen, selectedSquads→clear, else `menu.toggle()`.
  Strategic: selectedChit→clear, else `menu.toggle()`. squadN selects from
  `infantrySquads(sim)` as today; orderN arms `ORDER_KINDS[n]`; speedN
  strategic only; barrage/airstrike keep their `>0` guards; pause toggles
  the mode-appropriate pause; mute → audio.toggleMute().
- **Pause menu open** → force the mode-appropriate pause on; close → restore
  the pause state from before open (store a flag).
- Overlays state additions: `selectedSquads: number[]`, `selectRect`,
  `formationDrag: { x, y, facing, width } | null`. `focusTeams` = all teams of
  all selected squads (or the single narrowed team). Route preview: loop all
  selectedSquads (each squad's dest/queue as today).
- Renderer: `draw(ctx, cam, selectedSquads: number[], now)` — update
  drawDot/drawSoldier/drawEmplacement to test membership
  (`arr.includes(s.squadId)`; K is tiny). Update renderer call site.

## 5. Honest previews — `src/ui/overlays.ts`

- Move preview (terrain hover, selection active, no targetMode): replace the
  fixed `OFFSETS` loop with per-team reality: for each selected squad, team
  dests computed with the SAME formulas as the order path (`fanOffsets` +
  `TEAM_FAN`, and `SQUAD_FAN` per squad when multi-selected, y-axis legacy
  layout); per team `count = team.soldierIds.filter(s => s.alive && !s.downed
  && s.mental !== 'broken' && s.inVehicle < 0).length`; draw
  `formationSlots(count)` at the team dest (cover coloring as today). A 4-man
  team shows 4 dots.
- Formation drag preview: when `formationDrag` set, for each selected squad
  compute its segment center/share exactly as main.ts will issue, then per
  team `formationSlots(count, facing, share)` at the fanned team dest
  (teams fanned along facing per orderSquad's new branch). Draw all slots +
  the drag line itself.
- Draw `selectRect` (screen-space, thin dashed amber, translucent fill).
- Danger preview (armed order): unchanged, but use the fanned dests from the
  same shared math so it still lines up (it already mirrors orderSquad's
  formula — switch its `(ti-(n-1)/2)*8` to `fanOffsets`).

## 6. HUD + tooltips show the configured keys

- `hud.ts`: import keymap; include `keymap.version` in the render sig.
  - topbar button titles: `title="${fmt(barrage)}"`, airstrike, pause.
  - order bar titles: `formatBinding(orderN)` instead of hardcoded `⇧${i+1}`.
  - modeline `esc cancels` → `${fmt(cancel)} cancels`.
  - hint bar rewrite (from keymap):
    `scroll pan · pinch/⇧scroll zoom · drag box-select · ⇧click add · right-click move · right-drag formation`
    and `{squad1}–{squad9} squad · {order1}… order kind · {barrage} barrage · {airstrike} airstrike · {pause} pause · {cancel} cancel/menu`
    (use the actual formatted bindings; squad range = bindings of squad1/squad9).
- `tooltip.ts` terrainCard moveHint → `RIGHT-CLICK MOVE · RIGHT-DRAG FORMATION`.
- `hud.ts` HudState gains `selectedSquads: number[]`; every selected card gets
  `.sel`; only the primary expands rows/order bar. Order issuance buttons keep
  working against the primary (armOrder fans out at issue time).

## 7. Tests — `tests/controls.test.ts` (NEW)

- keymap: defaults round-trip through save/load with a fake Storage;
  unknown ids in storage ignored; `rebind` conflict in same context reverts
  the other action to default; cross-context duplicate allowed;
  `actionForEvent` shift-exactness; `formatBinding` cases.
- formationSlots: returns exactly `count` slots (count 1, 4, 12);
  facing=0 layout spreads along x more than y; facing=π/2 along y;
  undefined matches OFFSETS prefix.
- orderSquad with facing: two-team squad, team destinations lie on the
  facing line through the anchor (perpendicular deviation < 0.01);
  without facing matches legacy `y ± 4`.
- moveSoldiersTo via a Sim fixture (mirror tests/orders.test.ts setup): a
  4-man team ordered with facing=0 gets paths to 4 distinct spots spread
  wider along x than y.

## 8. Docs (short)

One decision-log entry in `docs/decisions/INDEX.md` (+2-3 lines in `ui.md`):
trackpad-first controls (scroll pan/pinch zoom, left-drag box select),
rebindable keymap persisted in localStorage with pause-menu UI, honest
formation preview (slots = eligible men), right-drag formation facing/width
threaded through TeamOrder→formationSlots.

## Out of scope

Strategic-view rebind hints beyond the menu, vehicle multi-select, gamepad,
per-squad formation memory, rotation of the danger-preview samples.
