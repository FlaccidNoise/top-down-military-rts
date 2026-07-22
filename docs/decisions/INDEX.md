# Decision Log

## Architecture
- 2026-07-21: Core game design — WW2 company tactical sim, TS/Canvas, headless deterministic core, per-soldier body-part + psychology sim, 18 squads/side → [architecture.md](architecture.md)
- 2026-07-21: Research amendments (stamina, ammo, legibility pillar, aggressive AI, replay, RimWorld thresholds) + edge-based walls for Door Kickers-style building interiors → [architecture.md](architecture.md)
- 2026-07-22: Art direction — procedural vector soldiers baked to zoom-band sprite cache + rotated drawImage; chunked procedural terrain; gable roofs with zoom/friendly-inside fade; dot LOD below 5 px/m → [architecture.md](architecture.md)
- 2026-07-22: UI — hybrid DOM/canvas: HTML overlay for screen-space chrome (sig-throttled rebuilds), canvas for world-anchored feedback; all "why" math via sim preview hooks (aimBreakdown/shotPreview/apShotPreview) shared with live fire → [ui.md](ui.md)
