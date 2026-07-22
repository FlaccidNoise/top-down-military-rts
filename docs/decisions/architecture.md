# Architecture Decisions

### [APPROVED] Core game design — WW2 company-level tactical sim
**Date:** 2026-07-21
**Context:** Brainstorm for a Close Combat / Firefight-style top-down real-time tactical game.
**Decision:**
- TypeScript + Canvas, browser-based. Headless deterministic sim core (pure TS, fixed timestep, seeded RNG); renderer is a thin layer over it. Data-driven definitions (weapons, body parts, terrain, traits). Saves are JSON.
- Per-soldier body-part simulation (RimWorld-style): hits roll body parts; wounds → capacities (moving, manipulation, sight, consciousness) → combat stats. Bleeding, medics, permanent aftermath. Body-part detail computed only on hit events.
- Psychology: courage (trait) / morale (battle state) / suppression (fast-decay state); ladder steady → shaken → pinned → broken → routing. Squad bonds grown across battles; bonds gate rescue behavior and morale shocks. Replacements start unbonded.
- Scale: WW2, company-level, 18 squads per side (~250 soldiers on map), real-time with pause. Player commands one side; enemy AI commander layer issues squad orders over the same soldier AI. Headless mode = two AI commanders, used for 1000-battle balance runs.
- Urban locomotion is a core system: cover-seeking micro-AI, bounds between cover, room-to-room building movement. Gets dedicated test scenarios (genre's worst failure point is pathfinding).
- Campaign: linear operation, persistent named roster, wounds heal over campaign days, replacements trickle in.
- Build order: (1) walking skeleton with scalar HP combat → (2) anatomy + psychology → (3) bonds, artillery, campaign → (4) vehicles, air support, polish.
**Alternatives considered:** Squad-aggregate sim (rejected: abandons deep-sim goal); per-soldier scalar HP only (kept as milestone 1 stepping stone); Godot/Bevy/Pygame (rejected for iteration speed vs. web); battalion scale (rejected: per-soldier detail becomes invisible).
---

### [APPROVED] Research-driven amendments + Door Kickers-style building interiors
**Date:** 2026-07-21
**Context:** Genre research report (docs/research/2026-07-21-genre-research.md) and user request for room-by-room building clearing.
**Decision:**
1. Soldier model gains stamina and individually tracked ammo (Close Combat's five-layer model; enables Firefight's ammo-runner behavior as a bond moment).
2. Legibility is a fourth design pillar: surface the hidden math (suppression, cover value, hit chance) in the UI — the genre's #1 modern complaint is opacity.
3. Enemy AI must maneuver and counterattack; headless harness gets an explicit AI-aggression metric (whole genre ships passive AI).
4. Instant replay of recent combat (cheap: sim is a pure function of state+orders+seed).
5. RimWorld thresholds adopted: moving <15% → incapacitated; consciousness <30% → unconscious; pain shock ~80% → downed-but-alive. Order vocabulary stays tiny (move/fast/sneak/fire/smoke/defend/hide). Maps ~500m.
6. Buildings are enterable with room-by-room clearing (Door Kickers reference). Enabling choice made in milestone 1: **walls live on tile edges** (wall/door/window edge types), never solid wall tiles. Interiors are ordinary walkable sim space; roofs fade on zoom; multi-story = floor layers + stair tiles (milestone 4).
---

### [APPROVED] Art direction: procedural vector sprites baked per zoom band
**Date:** 2026-07-22
**Context:** Replace placeholder visuals (team-colored dots, flat terrain colors). Must survive 2–48 px/m zoom, 250 agents at 60fps, and the legibility pillar.
**Decision:**
- Soldiers are parametric vector art drawn in code (src/render/dudes.ts), baked lazily into a sprite cache keyed (pose, walk-frame, weapon, side, zoom band ∈ {6,12,24,48}), rendered as one rotated drawImage per soldier. Top-down means one art angle serves all facings via ctx.rotate — no direction quantization. Poses: idle, walk×6, aim, prone, downed, dead. Dudes drawn 1.35× human scale (genre-standard oversize for readability). Team read = colored silhouette halo (Running With Rifles-style), blue vs red, plus distinct US olive / German feldgrau kits.
- Facing and gait are render-side state derived from sim position deltas and targetId (src/sim/ untouched); pose maps from sim state: pinned/broken→prone, downed→dropped-weapon + blood pool, dead→sprawl with per-id rotation jitter.
- Below 5 px/m the renderer falls back to the milestone-2 dot language (dots, prone ellipses, X marks) — correct minimap read at far zoom.
- Terrain renders lazily into 16×16-tile chunk canvases at zoom band ∈ {4,8,16,32,48} with 1-tile gutter (prevents downscale seam bleed), LRU pixel budget ~24 Mpx. Procedural detail from deterministic tile hashes: bilinear 8m value noise + speckles (grass), tree canopies with shadow/rim/highlight (woods), shoulders + pebbles (road), planks (floor). Walls/doors/windows styled on edges; gable roofs (src/render/roofs.ts) with per-building alpha, faded when zoom > 14 px/m or a friendly is inside.
- Verified in-browser at 3.5/8/10/12/16/24/30/48 px/m; 252 soldiers at 121 fps (vsync-capped).
**Alternatives considered:** Pure per-frame procedural vector (rejected: pays path cost every frame, ~10k ops at 250 agents); offline PNG sprite atlases (rejected: wastes top-down's free rotation, combinatorial atlas across zoom tiers, pipeline friction per tweak).
---

### [APPROVED] Strategic campaign layer — front commander, universal persistence, cell-grid sector
**Date:** 2026-07-22
**Context:** Design brainstorm replacing the linear 3-battle placeholder campaign. Full design: docs/specs/2026-07-22-strategic-campaign.md.
**Decision:**
- Player is the front commander (Total War / CC5 Grand Campaign): moves company chits across an operational sector, fights any battle tactically. Strategic layer is a real game vs. an enemy strategic AI; no friendly-side strategic AI needed.
- Universal persistence: every soldier on the front, both sides, is a named CSoldier record (~3k soldiers ≈ MBs of JSON). Two-tier resolution: player-commanded battles use the full tactical sim; the rest go through a deterministic coarse resolver operating on the same soldier records via the same body-part tables, calibrated against the 1000-battle headless harness (calibration non-negotiable — uncalibrated resolvers get farmed).
- Continuous strategic clock + pause (1 tick = 1 min); during a tactical battle the front runs 1:1, other contacts auto-resolve — choosing which battle to command is a real decision. V1 ships coarse speed steps, not smooth flow.
- Sector = cell grid (~40×30 × 500 m cells; terrain composition per cell; road/river polylines with exact cell-edge crossings). Chit = company (~100–120 men), so one contested cell = one company-scale battle by construction. Front line = emergent cell-ownership boundary.
- Tactical maps carved deterministically from cell + neighbor edges (map = f(sectorSeed, cellXY)); existing addBuilding/woods-blob machinery reused; flood-fill validation with deterministic reroll; per-cell scar lists persist wrecks/craters across battles. Ship one hand-authored sector; procgen sectors later share the same cell format (hand-built sector = generator's gold standard).
- Supply: Unity of Command-style line tracing from railhead through friendly cells → company supply state (full/low/out) → per-soldier ammo loadouts at battle start (source of truth for the approved ammo mechanic), replacement/healing throttles. Encirclement emerges from tracing.
- Objectives are data over cells ({type, targetCells, deadline}): operation mode, sandbox mode, and a procgen campaign generator all evaluate the same predicates.
- New pure deterministic module src/strategic/ (no render imports); interface: carveBattle(sector, engagement, seed) → Sim; applyOutcome consumes one Outcome shape from both tactical and coarse results.
- Tiers, each a complete game: T1 Operation (skeleton→carve→resolver→binary supply), T2 Front Alive (3-state supply, scars, enemy AI reserves/counterattack, campaign generator, sandbox), T3 Living War (procgen sectors, physical logistics + convoy-ambush battles, multi-cell engagements). Bond growth retunes from +0.15 to ~+0.05/battle with diminishing returns for dozens-of-battles scale.
**Alternatives considered:** One flagship company w/ aggregate front (rejected: requires friendly strategic AI, abandons "everyone on the front is a person"); named persistence player-side only (rejected: loses returning-enemy texture for little savings); turn-based front (rejected by user for continuous clock); free vector map (rejected: approximate strategic→tactical correspondence); CC5 sector graph (rejected: abandons carved-from-real-terrain vision); procgen-only sectors (rejected: two generators to debug before one game exists).
---
