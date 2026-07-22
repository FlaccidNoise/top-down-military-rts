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
