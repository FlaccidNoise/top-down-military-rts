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

### [APPROVED] Fidelity direction: "Muted Normandy, one sun" (builds on the art-direction framework above)
**Date:** 2026-07-23
**Context:** Full visual fidelity pass. Game reads "hobby project": kelly-green toy palette, four visual defect classes catalogued in docs/plans/2026-07-23-visual-fidelity-audit.md (flat blob soldiers, tile-quantized terrain, primitive vehicles, thin effects + an unrendered smoke mechanic). Framework (bakes, halos, dot LOD, chunked terrain) stays; this decision fixes what the bakes *contain*.
**Decision — the five rules every render surface follows:**
1. **Palette: desaturated Normandy.** Mossy greens, wet-earth browns, slate/terracotta roofs, US olive-drab vs German feldgrau. Saturation ceiling ~35% for ground, units read by VALUE separation (light torso / dark limbs / distinct helmet), not hue. Hot colors reserved for fire, tracers, blood, and UI accents — they pop only because the world is muted.
2. **One sun: NW, ~40° elevation.** Every shadow falls SE with shared offset direction (shared `src/render/light.ts` constants). Buildings, trees, hedges, vehicles, soldiers (contact ellipse) all comply; AO darkening at bases of anything vertical (walls, hedges, tree trunks). Overcast-soft edges — no hard black shadows.
3. **Texture language: 2-octave value noise + macro patches, never grid-visible.** Detail noise stays sub-tile; a second 24–32m octave drives patch/hue drift so no two fields/lawns match. All texture lives in the chunk/sprite bakes — frame loop stays drawImage + transforms.
4. **Effects language: hot-brief-flash, cool-lingering-smoke, earth-toned scars.** Muzzle = oriented 60ms star; explosions = fireball flash + dirt ejecta + rising grey smoke column + lingering dust; screen smoke (sim.smoke) = drifting layered puffs; impacts kick dust. Craters = earth-rim + dark center (replace charcoal starbursts). Particles capped and short-lived; wrecks burn persistently (cheap flicker + puffs).
5. **Silhouette discipline (legibility pillar unchanged).** Crisp unit outlines, faction identity via helmet/gear shapes baked per side, team halo becomes zoom-attenuated rim (strong at 6/12 bands, whisper at 48), max ONE ring per soldier on top of it (selection > suppression). Dot LOD below 5 px/m untouched.
**Alternatives considered:** (A) Painterly Close Combat ground — rejected: multi-octave painterly washes in Canvas 2D trend muddy, fights the legibility pillar, hardest to keep consistent across procedural surfaces. (B) Crisp flat Door Kickers vector — rejected: cheapest and cleanest but reads "tactics toy", wastes the sim's grit (persistent scars, casualty drama); its silhouette discipline is adopted into rule 5.
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

### [APPROVED] Design-scale battles: TO&E companies in the campaign, 320×240 engagements, reinforcement cycle
**Date:** 2026-07-23
**Context:** Battles ran at most 27v27 (54 men, 160×120) against a decided design target of ~250 soldiers on map. The full team/squad catalog (SQUADS/TEAMS, addSquadFromDef) already existed; only campaign.ts/bridge.ts still used the legacy flat 9-man addSquad path.
**Decision:**
1. Campaign roster is team-structured one milestone early (`CampaignSquad { name, def, teams: CampaignTeam[] }` ≈ the TO&E spec's SquadInstance): 3 companies × `COMPANY_TOE.us_rifle_co` (18 squads, ~138 men; 414 campaign soldiers). Slots own weapons — `CSoldier.weapon` is display-only; whoever holds slot 0 next battle gets the MG (succession by roster order). Save key bumped to ccg-save-v3, no migration (pre-release).
2. `addSquadFromDef` roster is now authoritative: short teams spawn short (phantom-padding silently un-did attrition every battle) and `crewSkill` survives the round-trip. Rosters are `Partial<MemberInit>[][]`.
3. All engagements generate 320×240 maps (~4× area, second hamlet = objectives[2]). Blue spawns in 6 platoon-column bands over the map height; weapons/bazooka bands sit 4m to the rear.
4. Garrisons (newFront): Brückenwachen 36 (4 Gruppen), Garnisonen St-Aubin/Vireux + Reserve 109 (full de_grenadier_co, 16 squads) — escalation arc from 138v36 skirmishes to 138v109 (~247-man) set pieces. Red fields exactly chit strength: TO&E prefix, last squad partial via empty-object roster.
5. Garrison posts = buildings/objectives/woods stands **within 45m of an objective**, split into per-objective sectors (weighted round-robin by headcount; direct-fire squads take approach-side anchors, mortars/schreck/sniper the far side). Radius filter is load-bearing: dispersing remnants map-wide left battles unresolvable (blue never finds the last defenders; the 25% attrition floor never trips).
6. Replacements arrive on a visible cycle (user decision — no silent daily full top-ups): every 2 days, ≤12 green replacements/company, neediest squads first (`fillReplacements` cap; per-team establishment sizing). Strategic header shows a countdown; arrivals flash top-center for 6s. Healing (advanceDays) unchanged and daily.
7. Perf at 247 soldiers (M-series, vsync 120): headless tick mean 2.1–2.3ms / p95 ~11.5ms (budget 5ms mean at DT=1/30); in-browser 119.5 fps avg panning the full map mid-battle, 117–120 across 3.5/16/32 px/m bands, p95 frame <10ms. astar scratch buffers pooled (company-wide order = ~140 calls × ~1MB alloc was pure GC churn; burst 247→232ms isolated, 110ms warm in-browser). No other perf fix earned its keep by measurement.
**Deferred/observations:** RedCommander maneuver cap `pool.slice(0,2)` unscaled (red only defends this milestone); squad hotkeys stop at 9 of 18 (Shift+digit taken; click/scroll works); no camera fit-to-map affordance; supply-gated replacements await the supply milestone; German 8cm mortars can wipe a spawn-area team before the player moves (watched as a tuning item — historically plausible, possibly brutal).
**Alternatives considered:** uniform 109 garrisons (rejected: pacing fatigue); tiered map sizes by battle size (rejected: two scales to tune); full daily top-ups (rejected by user: erodes attachment to soldiers); trickle-per-day replacements (rejected: death-spiral risk without the cycle's legible rhythm).
---
