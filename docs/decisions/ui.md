# UI Architecture (2026-07-22)

## Hybrid DOM/canvas UI

- **Screen-space chrome is an HTML overlay** (`src/ui/`): top bar, squad panel, tooltip card, mode banner, victory banner, debrief. Styled in `ui.css` (olive glass panels, cream text, amber accents). DOM rebuilds are throttled by a signature (`tick/5` bucket + selection + pause + mode), so a paused game costs zero DOM work and the panel is at most 166 ms stale during play.
- **World-anchored feedback stays on canvas** (`src/ui/overlays.ts`, drawn after `renderer.draw`): hit-chance/LOS line with % chip, move-order formation cover dots (the real `OFFSETS` spots), off-screen event pings (edge arrows). Pings expire on sim ticks, never wall clock.
- **The WHY comes from the sim, never re-derived in UI.** `sim.aimBreakdown` (product = `aimFactor`), `sim.shotPreview`, `sim.apShotPreview` are the exact formulas live fire consumes (`fireSmallArms`/`fireApAt` call them), so tooltips can never drift from the sim. Any new hidden mechanic must ship with a preview hook on `Sim`.
- Tooltip: single card div, one `pickAt` (living soldier > vehicle > body > terrain, radius `max(0.9m, 12px)`), innerHTML rebuilt only when picked entity / tick bucket / shot solution changes.
- Rejected: all-canvas HUD (text layout pain, every panel is imperative drawing), full HTML overlay (per-frame world→DOM sync for lines/markers), immediate-mode canvas UI lib (hand-rolling a layout engine the browser already ships).
- Perf verified: 255 agents, sim running, full UI live — 120 fps (vsync-capped M-series).
