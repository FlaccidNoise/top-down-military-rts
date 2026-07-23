# UI Design + Implementation Plan — Both Maps (2026-07-23)

Direction: docs/decisions/ui.md (hybrid DOM/canvas, sim owns the WHY), architecture.md §"Muted Normandy, one sun", legibility pillar. Audit basis: code-level survey of `src/ui/*`, `src/render/strategic.ts`, `src/strategic/*`, `src/campaign/campaign.ts`, `src/sim/sim.ts` preview hooks (pixel screenshots not viewable this session — plan is IA/interaction, not pixel-tuning; visual fidelity already landed 2026-07-23).

**Design goal (user):** maximum legibility, clarity, information density; understandable from the UI alone — every game state has a visible surface, every interactive element teaches itself, the campaign map is brought to parity with the battle map.

## Genre precedents adopted (cited per pattern)
- **Soldier/unit info card w/ morale+suppression bars** → *Close Combat* (the genre's reference for per-man psychology readout). Our `STATE_COLOR` + suppression bar already follow this; we extend, not replace.
- **Stat-bar data tooltips + vet stars + phase pressure** → *Steel Division / Warno* (data-dense pick cards, deployment/phase framing).
- **Tactical HUD: ability bar, reinforce/promote, suppressive-fire pin** → *Company of Heroes* (order hotbar + off-map support counts; we keep, add affordance).
- **LOF/danger preview on cursor + plan-then-execute** → *Door Kickers* (cover dots, danger samples, waypoint preview — we already have these; extend to a floating context card).
- **Campaign ownership tint + settlement detail-on-select + recruitment queue** → *Total War* campaign maps (chit→detail panel, reinforce ETA badge, ownership history).
- **Info density without clutter via value-separation, not hue** → *Muted Normandy* art direction (already the palette constraint; UI tokens must harmonize — desaturated panels, amber as the single accent).

## Information architecture — what the player needs, per moment

### Battle mode
| Moment | Need | Current surface | Gap |
|---|---|---|---|
| Idle (nothing selected) | "what can I do, what am I here for" | modeline (order-mode text only) | no objective/stakes strip; no contextual key hints |
| Squad selected | identity, strength, morale, ammo, current order + compliance | squad panel (have most) | squad-aggregate ammo; emplacement state (packed/deployed/transit timer); order "what will happen" affordance |
| Order armed | what this order does here, danger, ETA, will they comply | canvas danger dots + balk chip | no aggregate danger read; no floating context card; no order-button affordance tooltip |
| Hovering entity | picked detail + shot solution | tooltip card (have) | vehicle damage plates; emplacement state; terrain "why this cover %" breakdown |
| Combat event | who/what/where | right-edge pings (have) | feed overrun (6 vs planned 5); world KIA label stacking |
| Always-on | force ratio, clock, off-map support, pause | top bar (have) | **battle objective + win/loss conditions + time/loss budget** (biggest battle gap) |

### Strategic mode (currently thin — the focus of this plan)
| Need | Current surface | Gap |
|---|---|---|
| Operation progress (objectives held/total) | end-game only | no progress bar / live status |
| Day + clock + day/night | header text | no visual day/night; no "night reduces spotting" indicator if/when shipped |
| Per-chit detail | chit box (name initial + strength bar) | **no detail panel**: composition, supply status, path/waypoints, ETA, strength trend |
| Reinforcement ETA | header "Reinforcements in Xh" | no persistent badge/queue; no arrival push beyond flash toast |
| Engagement staging | modal (terrain+objective) | **no force comparison, no retreat path preview, no stakes** |
| Ownership/loss history | cell.owner current only | no "this cell changed hands" read |
| Supply line | path tracing exists in sim | no strategic supply viz |
| Company roster health | per-soldier CSoldier.status | no strategic casualty/roster summary |

## Task 1 — design tokens + ui.css refactor [foundation, do first]
`src/ui/ui.css` (319 ln → ~expands). Keep olive-glass/cream/amber identity; harden the system:
- Token groups: `--paper/--ink/--border` (surfaces), `--amber/--blue/--red` (accents — amber is the ONE accent, blue/red team only), `--state-*` (steady/shaken/pinned/broken = existing STATE_COLOR), `--cover`/`--danger` (semantic, for overlay dot legend), `--track-bg/--chip-bg`.
- Type scale (rem): the monospace military-readout feel is a genre fit — **keep mono**, add weight hierarchy (400 body / 600 labels / 700 headers) + a 3-step size scale. No serif/sans swap (frontend-design skill's Lora/Nunito is a *web-app* default; this is a diegetic HUD — override, documented).
- Spacing scale (4/8/12/16/24px), applied to all panel padding/gaps (current is ad-hoc).
- `:focus-visible` amber ring on **all** interactive elements (order buttons, menu, modal buttons) — audit + add where missing (frontend-design a11y requirement).
- `prefers-reduced-motion: reduce` disables pulse/transition (have partial — extend to modeline pulse, balk chip pulse, ping fade).
- No layout shift on interaction: armed-order emphasis via `box-shadow`/`outline` transforms, never width/position.
- Frosted-glass `backdrop-filter: blur()` on top bar + squad panel (already glass; formalize token), skip on tooltip (must be opaque for legibility over world).

## Task 2 — tooltip system: multi-tier + expanded cards [after T1; touches tooltip.ts]
Precedent: *Close Combat* soldier panel + *Steel Division* data card. Current = single card rebuilt on pick change. Extend to a tiered system, all DOM, sig-throttled:
- **T1 Hover pick card** (existing, expand): add to soldier card — squad-aggregate ammo (`m.ammo` sum / max), emplacement state (packed/deployed/transit + timer), vehicle **damage plates** (per F/S/R armor + current body, via Vehicle fields), terrain **cover/concealment breakdown** (why this % — the `TerrainDef.cover`/`coverBehind`/`conceal` values, not just the aggregate). All from existing sim read methods — no new hooks.
- **T2 Affordance tooltip** (new): hovering an order button (`orderBar()` buttons, hud.ts:189) shows — order name, one-line "when to use", compliance modifier (dangerScore × multiplier from the order kind), hotkey chip, "right-click to issue / shift+right-click to queue". Driven by a static `ORDER_AFFORDANCE` table (data, keyed by OrderKind) — no sim calls. Precedent: CoH ability tooltips.
- **T3 Context card** (new, canvas-anchored via overlays.ts + DOM): when an order is **armed**, the cursor location gets a floating chip — aggregate danger score (sum of `dangerSamples`), cover at cursor (`inCover`), ETA (distance / move speed), compliance verdict (`comply/cautious/balk` from `sim.compliance`). Replaces "just dots" with "dots + a read". Precedent: *Door Kickers* cursor danger read.
- Stale-tooltip clear on canvas mouseleave (known gap from visual-fidelity-plan U3).

## Task 3 — battle top bar: objective + stakes strip [after T1; hud.ts + sim hook]
Biggest battle gap: the player fights with no visible *why*. Add a slim strip under the top bar:
- **Objective line**: the engagement's objective (from `Engagement`/mapgen objectives — needs a sim accessor; if none, ship a `sim.objectiveSummary()` read hook returning `{name, type, holds}` — UI consumes, never re-derives, per ui.md invariant).
- **Win/loss conditions**: hold objective for X / reduce enemy to Y / time budget / loss budget. From `operationStatus()` + Engagement fields.
- **Progress**: objective-hold timer bar, loss-counter (friendly KIA / budget).
- This is the *Total War* "why am I here" campaign framing, compressed into the tactical layer.

## Task 4 — squad panel polish + order affordances [after T1, T2; hud.ts]
- Order buttons: hotkey chip (e.g. `⇧1`), armed-state emphasis (amber outline + the order's affordance tooltip from T2), disabled state when order illegal for selected unit (e.g. assault for a vehicle — gate on `canArm` if exists, else a per-kind predicate).
- **Squad-aggregate ammo** chip on each squad card header (sum `m.ammo` / `maxAmmo` for members) — glanceable resupply need. Precedent: CoH squad reinforce/ammo.
- **Emplacement state** row on crew squads: packed/deployed/transit + timer bar (from `Emplacement.state`/`timer`). Replaces implicit context buttons.
- **Compliance reason mapping**: balk chip currently shows raw reason; map to player-readable + a hint ("smoke the objective first" for naked-assault balk). The reason text is a sim-provided structured field (ui.md: UI branches on structured fields) — add a `REASON_HINT` table.
- Vehicle cards: damage plates summary (ties to T2 vehicle card expansion).

## Task 5 — strategic mode UI: the parity build [after T1; strategic.ts + new strategic HUD]
The strategic map is the underbuilt half. Bring it to battle-map information density. **Two surfaces: canvas render (strategic.ts) + DOM HUD (new, parallel to battle hud).**
- **Canvas (strategic.ts)**: already has ownership tint, front line, objective pulse, chits, path preview, legend. Add — day/night clock ring around the header (visual), supply-line overlay toggle (trace from `front` supply path — render only, sim owns truth), ownership-change scar (last cell to flip = highlighted boundary for one tick cycle), engagement-staging highlight (cell you're about to attack).
- **DOM strategic HUD** (new file `src/ui/strat-hud.ts`):
  - **Operation progress bar**: objectives held / total, day, operation status (`operationStatus()`).
  - **Reinforcement persistent badge**: queue + ETA (from `minutesToReinforcement`), not just header text; arrival flash already exists — keep.
  - **Chit detail panel** (on chit select, replaces transient tooltip): strength + **strength trend sparkline** (track last N `Chit.strength` samples — UI-side history of a sim-provided value is allowed; it's display history, not intel), composition (teams/weapons from chit/team structure), **supply status**, **path + waypoints** (editable: click waypoint to cancel, drag to reorder — `Chit.path` is mutable per survey), ETA to dest.
  - **Engagement staging modal expansion**: force comparison (attacker vs defender strength/composition — fog-filtered for enemy), terrain + objective, **retreat path preview** (the cells a retreat would traverse — sim `retreat()` aware), **stakes** (what winning/losing this cell means for the operation). Precedent: *Total War* pre-battle panel.
  - **Company roster health summary**: per-company fit/recovering/kia counts (from `CSoldier.status`), drill-down to squad → soldier. The campaign-level casualty read the battle debrief hints at but the campaign map never shows.
  - Sig-throttle like battle hud (tick/5 bucket + selection + clock bucket + op status).

## Task 6 — onboarding: teaching without a tutorial [after T2, T4; new `src/ui/coach.ts` + keymap/menu]
**No forced tutorial** (rejected — see below). Instead, self-teaching surfaces:
- **First-time coachmarks**: one-time, localStorage-flagged (`rts.coach.v1`). Fire on: first squad select, first order arm, first engagement staging, first strategic chit select. Single dismissable hint pointing at the relevant element. Precedent: *Door Kickers* contextual hints, CoH first-ability tips.
- **Keyboard hint chips** on all actions (order buttons, top-bar buttons, menu items) — the `⇧1`/`B`/`Space` labels, always visible, not just in the keybindings page.
- **Idle "what now" hint**: when idle for >N ticks with nothing selected, a faint modeline prompt ("select a squad [1-9] · drag to pan · scroll to zoom"). Disappears on any input.
- **Affordance tooltips** (T2) are the primary teacher — every button explains itself on hover.
- Reuse `menu.ts` keybindings page (already grouped GLOBAL/BATTLE/STRATEGIC) — ensure new actions (strategic chit path edit, coachmark reset) appear there.

## Task 7 — event feed + ping polish [after T1; overlays.ts]
- Feed → single right-edge column, **max 5** (visual-fidelity-plan noted 6 vs planned 5 — fix), newest on top, fade-out, no overlap.
- World KIA labels: stack-offset per position collision (have partial — ensure deterministic stacking, no per-frame jitter).
- Ping expiry on sim ticks (already correct — reaffirm, never wall clock).

## Task 8 — (stretch) multi-select + formation drag wiring [after T4; main.ts + overlays.ts]
`selectedSquads[]`, `selectRect`, `formationDrag` are declared in `OverlayState` but **unwired** (survey finding). If in scope:
- Drag-select rect → populates `selectedSquads[]` (shift to add).
- Group squad panel card (collapsed multi-select summary).
- Formation drag: anchor→cursor line + segment dots (have draw code, need input wiring in main.ts mouse handlers).
**Mark optional** — it's an interaction-model change, not strictly IA. Defer if the core 1-7 fill the session.

## Rejections (reaffirmed + new)
- **Minimap** (reaffirmed): zoom-out is the minimap at this scale.
- **Kill-feed panel** (reaffirmed): duplicate of event pings.
- **Forced tutorial / mission walkthrough** (new): coachmarks + affordance tooltips teach without gating. Genre precedent: players skip tutorials; self-teaching surfaces stick.
- **UI-side enemy intel guessing** (reaffirmed, ui.md): all enemy reads via `*VisibleTo` helpers; the chit detail panel enemy composition is fog-filtered.
- **Serif/sans font swap** (new, vs frontend-design skill default): diegetic HUD stays monospace — documented override; the skill's Lora/Nunito default is for web apps, not a Normandy field manual readout.

## Tests [extend tests/tooltip.test.ts + new]
- `tests/tooltip.test.ts`: add — vehicle card damage-plate data, terrain cover-breakdown fields, emplacement state rendering, context-card compliance verdict branches.
- `tests/order-affordance.test.ts` (new): `ORDER_AFFORDANCE` table completeness (all 8 OrderKind), `REASON_HINT` mapping coverage for all balk reasons.
- `tests/strat-hud.test.ts` (new): chit detail panel data formatting (strength trend from sampled values, ETA calc, force-comparison fog filtering).
- Pixels are not tested (per convention) — verified via staging screenshots.

## Verification staging
`npm run dev -- --port 5199 --strictPort`, `?seed=7`, `localStorage.clear()` (clears coachmarks + keymap rebinds).
- **Battle**: `__game.startEngagementBattle({attackerId:1, defenderId:4, cell:<red chit cell>})`. Scenes: idle `cam(95,57)@12` (objective strip visible), squad select `cam(10.5,39.3)@48` (panel + affordance tooltip on order hover), order armed `cam(95,57)@16` (context card at cursor), combat (unpause, let red engage — pings feed), debrief (let objective resolve).
- **Strategic**: boot (operation progress + reinforce badge), chit select (detail panel + trend), path edit (drag/cancel waypoint), engagement staging (force comparison modal), reinforce arrival (advance clock to ETA).
- **Onboarding**: fresh localStorage — first-select/first-order/first-engagement coachmarks fire once; dismiss; reload → do not refire.
- **Check**: `npm run check` + `npm test` green after each task. Perf: ≥100 fps at 247 soldiers (battle), strategic frame cheap.

## Execution / dependencies
T1 (tokens) → {T2, T3, T4, T5, T7} (parallel where disjoint files) → T6 (needs T2/T4 affordances) → T8 (stretch). Builder + fresh-context verifier per task; verifier runs staging recipe, screenshots the scenes, checks tsc + vitest, spot-checks fps. Commit per task; land on main fast-forward.

## Outcome (2026-07-23)
Tasks landed: T1 (tokens), T2+T4 (tooltip/panel/order affordances), T3 (objective+stakes strip), T5a (strategic DOM HUD), T5b (strategic canvas + engagement modal), T6 (onboarding), T7 (feed fix + context chip). T8 (multi-select/formation drag) deferred as stretch.

**New files:** `src/ui/order-data.ts` (ORDER_AFFORDANCE/BALK_HINT/canArm), `src/ui/tooltip-format.ts` (formatCoverBreakdown), `src/ui/objective-strip.ts` (objectiveStripText), `src/ui/strat-hud.ts` (StratHud), `src/ui/coach.ts` (Coach).
**New tests:** order-affordance (8), objective-strip (7), strat-hud (12), context-chip (7), coach (11) + tooltip extended (+4) = **51 new tests, all green.** `npm run check` green throughout.

**Genre precedents realized:** Close Combat per-man psychology readout (kept/expanded); Steel Division data-card tooltips (affordance + cover breakdown); CoH ability-bar affordances + reinforce (hotkey chips, aggregate ammo, emplacement state); Door Kickers cursor danger read (context chip) + contextual coachmarks; Total War campaign framing (operation progress, chit detail panel, force comparison at staging, roster health).

**Known leftovers / gaps (not blocking):**
- **Supply is not modeled** at the strategic layer (no field on Chit, no supply fn) — chit detail panel shows "supply: not modeled" rather than inventing data. Needs a strategic-layer change, out of UI scope.
- **Day/night is a clock ring only** — no darkness/spotting model exists in sim; the ring shows time-of-day position, not a night effect. If night mechanics ship, the ring gains a shaded arc.
- **T8 multi-select + formation drag** unwired (declared in OverlayState, no input wiring) — deferred as stretch; it's an interaction-model change, not IA.
- **Engagement retreat-path preview** not added (retreat() path not cheaply exposed for preview) — the staging modal shows force comparison + stakes instead.
- **jsdom DOM tests** for coach.maybeShow skipped (vitest runs node env); pure-logic coverage instead.

**Shared-tree hazard:** an external editor/session was actively modifying the working tree during this session (one silent revert of main.ts caught + re-applied; sim.ts/orders.ts/bridge.ts carry pre-existing in-flight changes not from these tasks). All UI deliverables verified intact via sentinel greps; tsc green confirms no cross-breakage. Commit scope must exclude the external session's sim/ changes.
