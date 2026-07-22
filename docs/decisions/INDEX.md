# Decision Log

## Architecture
- 2026-07-21: Core game design — WW2 company tactical sim, TS/Canvas, headless deterministic core, per-soldier body-part + psychology sim, 18 squads/side → [architecture.md](architecture.md)
- 2026-07-21: Research amendments (stamina, ammo, legibility pillar, aggressive AI, replay, RimWorld thresholds) + edge-based walls for Door Kickers-style building interiors → [architecture.md](architecture.md)
- 2026-07-22: Art direction — procedural vector soldiers baked to zoom-band sprite cache + rotated drawImage; chunked procedural terrain; gable roofs with zoom/friendly-inside fade; dot LOD below 5 px/m → [architecture.md](architecture.md)
- 2026-07-22: UI — hybrid DOM/canvas: HTML overlay for screen-space chrome (sig-throttled rebuilds), canvas for world-anchored feedback; all "why" math via sim preview hooks (aimBreakdown/shotPreview/apShotPreview) shared with live fire → [ui.md](ui.md)
- 2026-07-22: Strategic campaign — front commander on 500 m cell-grid sector, continuous clock, universal both-sides soldier persistence + calibrated coarse resolver, deterministic battlefield carve with scars, supply line tracing → per-soldier ammo, data-driven objectives, tiers T1–T3 → [architecture.md](architecture.md), spec: [../specs/2026-07-22-strategic-campaign.md](../specs/2026-07-22-strategic-campaign.md)

## Units
- 2026-07-22: Unit system — team command atom; US/German asymmetry via composition + signature weapon mechanics; crewed weapons as load-carrying crew teams; halftracks + StuG wave 1; discrete mag/belt ammo; pure-data schema → [units.md](units.md)
- 2026-07-22: Company TO&E (fixed historical core, 18-squad US co) + requisition-point attachments; supply→ammo 100/50/25%; chit schema with team structure; casualty chain (stabilize + drag, aidmen, bond-gated rescue) + slot-owned weapons with automatic role succession → [units.md](units.md)

## Gameplay
- 2026-07-22: Order execution — interpret + refuse (comply/cautious/balk ladder, UI reason chips, auto-bounding); context actions outside the 7-order vocabulary; one shared danger model for refusal, positioning, and AI planning → [gameplay.md](gameplay.md)
- 2026-07-22: Tactical AI commander — honest vision + briefing, decaying threat map, plays through the player order API (its troops balk too), task-group plans, difficulty = skill not sight, doctrine-health harness metrics → [gameplay.md](gameplay.md)
