# HANDOFF — 2026-07-27 evening (mid balance takeover, designs in flight)

## STRATEGIC LAYER V2 — PLAYABLE CORE DEPLOYED (2026-07-27 night, strategic-v2 session)
Design doc approved (all 22 gates, INDEX.md entry). LANDED ON MAIN and LIVE at joshtaylor.world/demos/close-combat-like (index-B4i2IFhf.js): S1-S20 chain complete — generator (makeTheater 3.3ms/200 seeds, 11 named rejects, fingerprints), disposition + war goals, Front V2 (continuous march, ford dwell 45/bridge defile 15, ETA mirror, graphGap contacts, timed coarse battles, graph retreat), goal-driven two-tier planner (red retakes objectives 7/8 seeds vs V1 baseline zero; coarseOdds shared with the resolver), TheaterView renderer, bridge2 adapter (REAL tactical battles from theater contacts through unmodified makeStrategicBattle), main menu -> V2 campaign wiring, save v4 (theater regenerated from seed; v3 roster adoption per OQ1). ?camp=N still boots the V1 grid war — every art/battle harness byte-identical (sweep verified at S2). Full suite 1054/1055 incl. perf. Browser-gated end to end.
NOT YET BUILT (next session queue, in order): customize-campaign screen (seed+knobs+preview, S38+), battle deployment phase (owner scope, doc §10), realism systems (supply/FOW/fatigue/ops-tempo, S50+), commander-plan persistence (§4.8 — replans on load today), warsweep-v2 calibration sweep (S58/S59), theater-view polish (region edge smoothing, DOM event log, force ETA HUD, mobile pass), S57 harness/test migration off the grid. Playtest feedback from the owner drives the polish order.
## SUPERSEDED 2026-07-27 later: balance pass COMPLETE and DEPLOYED
Everything in "In flight: balance" below is DONE and live (index-B-GLaMvN.js verified at joshtaylor.world/demos/close-combat-like/). Main (2eb12a6) has: the range/mass tune (91c0dd9), honest AI attacker + objective progression (06580e5), culmination rule (16f0d7f), trivial-mismatch auto-resolve (7f580a6+50e5b2e), balance.mjs fail-fast (721fe43), tuned 54-run record (scripts/.balance-tuned.json). Results: blob ≤35% wins everywhere (0/12 open+woods, 2/6 bourg at 41.7% KIA-on-win — owner accepted the sub-45 miss); doctrine 0-for-18 → 3W bourg / 0 losses woods / 2 losses open. Balance shard traps recorded in project memory (balance-harness-traps). mapgen-v3 design committed (15593fb+899651f), review pending. lane-b/lane-fix-attacker/lane-trivial/wf_6ff3010c worktrees removed (branches kept). NEXT: movement chain M2-M6 + M4b (gate 3 below), then mapgen-v3. TUNE follow-ups: pre-battle appraisal so open-ground frontals get declined instead of culminated; hearth-glow flicker + pock sun-keying still open.

Fresh session: read this, then docs/decisions/INDEX.md, then the project memory index. Act as the orchestrator of multi-agent workflows on this repo (Workflow tool, worktree lanes, sequential chains with structured handoffs).

## OWNER DECISIONS (recorded this session — do not re-ask)

- Blob-rush feel: REFUSE + BLEED (mix of mid-move balk and ranged attrition). Target: blob ≤35% wins on defended bourg+woods, ≥45% blue casualties on wins. Doctrine profile within 15 pts of baseline; doctrine-health suite green.
- AI-doctrine attacker (0/18 baseline, WORSE vs tuned defense: 0W/1L/17H, ~34% KIA): fix in this balance pass.
- NEW: trivial-mismatch engagements (owner blob-rushed a ~8-man bridge picket with 136 men — correct outcome, wrong ceremony) should offer coarse-resolve/fast-forward above a force-ratio threshold instead of staging a formality battle.
- NEW: floors UX — buildings need an at-a-glance storey-count indicator + discoverable floor cycling (F-key floor-focus, Alt+right-click floor menu, and auto-top-floor garrison on defend/ambush ALL EXIST — the gap is visibility/discoverability, incl. touch). Fold into the movement chain near M4 (same overlay surface).
- Mapgen-v3: owner saw the bourg live, loved it, wants the organic pipeline (tuned per kind) generating ALL map kinds.

## State of main (634d111)

Everything below is MERGED, gated, and deployed to joshtaylor.world/demos/close-combat-like/ (Netlify, push-to-deploy from ~/CodingProjects/personal-website — the game lives at public/demos/close-combat-like/, a copy of this repo's dist/):

- Fidelity campaign complete: baked roofs/walls/terrain/units/vehicles/emplacements/effects, yards+clutter, burning, atmosphere. Strict plan-view art rule (owner-set, in project memory): NO elevation views; shadows sweep from the caster's base (light.ts sweptRectPath/sweptStrokePath/capsulePath, cap SHADOW_LEN_LEGIBLE=2.4).
- Bourg town generator LIVE in campaign (CHAR_TERRAIN t/T → 'bourg', src/strategic/sector.ts). Furnished role-based interiors LIVE (opts.interiors on at bridge.ts + scenario.ts). Micro-relief/rail/halt generate. Stance-aware LOS. Aged leaning smoke plumes (renderer draws what blocks sight). Destructible walls D1–D13 end-to-end (EDGE.BREACH, vehicle crush, AT breaching, render invalidation via src/render/versions.ts). Day/night N1–N14 (src/sim/solar.ts, sun-step rebakes, night spotting caps, CANON_CLOCK_MIN=840).
- Mobile: touch in both modes, bottom-sheet HUD, DPR, PWA. scripts/mobile.mjs green (needs --port of a live dev server).
- M1 of the movement chain merged: src/sim/spots.ts pure resolver + tests/spots.test.ts (16 tests). INERT until M2 wires it.

Gates at last full run: 921+ tests green, tsc clean, bake.mjs ≤8ms, vfx.mjs 18/18, sweep 112 shots (canonical hour 1400 pinned — never sweep unpinned), smoke-dist PASS.

## In flight at handoff time: balance — INTERACTIVE TAKEOVER state

The auto-loop workflow (wf_bd98002a-64c) was deliberately STOPPED mid-iteration-1-measurement; the orchestrator now drives tuning interactively with the owner. Exact state:

- Worktree .claude/worktrees/lane-b, branch lane-b-balance. Iteration-1 tune is COMMITTED (91c0dd9 "the defense fights at range and mass pays for it": crew-served field deployed, long-range fire release, MASS_RELEASE early ambush trigger, suppression feeds dangerScore, mid-move balk phase; b28a70e adds --seed-start sharding to scripts/balance.mjs). Suites were green at commit.
- Post-tune DOCTRINE measurement DONE: scripts/.bal-i1-[d-i].json — 0W/1L/17H, blueKIA ~32-35% (attacker got worse; see decisions).
- Post-tune BLOB/BLOB-FAST measurement was RUNNING as 8 detached vite-node shard processes (survive session end) writing scripts/.bal-i1-blob*.json in lane-b/scripts. First action of a fresh session: ls those files; if 8 exist, merge (aggregate blueWins/redWins/holds/blueKiaPct per profile×kind across seed shards) and compare vs scripts/.balance-baseline.json (199f9e8: blob won 1-3/6 per kind, rest holds). If shards died early, relaunch: cd lane-b && npx vite-node scripts/balance.mjs -- --profiles blob --kinds open,woods --seed-start 1 --seeds 3 --out scripts/.bal-i1-blob-openwoods-1.json (etc; profiles×kinds×seed-halves; cap default 54000).
- THEN, per owner decisions: (1) present the before/after table; (2) fix the AI-doctrine attacker (diagnosis inputs: journal results 2-3 of wf_bd98002a-64c in the PRIOR session dir ~/.claude/projects/.../cc0a7d57-f5e5-43a0-a61f-367d9a8a68ec/subagents/workflows/wf_bd98002a-64c/journal.jsonl — ambush-leash/fire-volume/balk-threshold findings; the attacker's assault preconditions never satisfy vs a ranged defense); (3) trivial-mismatch auto-resolve (force-ratio threshold at makeStrategicBattle/contact-modal level — offer, not force); (4) if blob still >35% on any defended kind, iterate knobs interactively with the owner; (5) merge lane-b → main, re-run tests/perf.test.ts QUIET (mapgen budgets flake under harness load: 39-45ms vs 40), full gates, redeploy, report.

## Also in flight: mapgen-v3 design (relaunch if it died with the session)

Design workflow wf_e8107e0c was writing docs/plans/2026-07-27-mapgen-v3-design.md (one organic pipeline, per-kind profiles: open=farmsteads+sunken lanes, woods=stands+forester pocket, road=linear street-village, river/bridge=bridge-head hamlet + existing water doctrine, bourg=current; migration recommendation big-bang re-baseline vs guarded cutover). If the doc doesn't exist or has no P-task list, relaunch: Workflow({scriptPath: '~/.claude/projects/-Users-joshtaylor-CodingProjects-top-down-military-rts/a4119349-6e50-40a4-8024-bd2b4c73ebd4/workflows/scripts/mapgen-v3-organic-everywhere-design-wf_e8107e0c-e6e.js'}). Implementation sequences AFTER movement M2–M6 (both touch mapgen/spawns peripherally). Commit the doc when it lands.

## Next after balance: movement chain M2–M6 (+ floors UX)

Spec: docs/plans/2026-07-27-movement-cover-design.md. M1 merged; the frozen interface + full M2 wiring contract live in the M1 workflow manifest (journal of wf_50ad21e1-a3e) — load-bearing points: pre-filter soldierIds with exported eligible() in team order; q.x/y = post-fan anchor; thread kind+arc from TeamOrder; ONE fresh used-Set per moveSoldiersTo call and the resolver adds tile keys itself; omitted soldiers = no footing (caller skips, M4 surfaces); findSpot keeps dismount/bail/flee; call once at order time (PATH_BUDGET amortization, INDEX.md order-burst entry). Known deviation: threat half-plane is strict <90°.
- Run as ONE sequential chain on a worktree branched from post-balance main: M2 (wire moveSoldiersTo, re-record determinism baselines) → M3 (defend/ambush garrison audit; re-run balance.mjs, hand the delta to balance) → M4 (overlays preview: ghost dots, snap tails, refusal-early, "n/m covered" chip) → M4b NEW, owner-requested (floors UX: per-building storey-count indicator at tactical zooms on the overlay/roof surface, discoverable floor cycling — surface the existing F floor-focus + Alt+right-click floor menu incl. a touch path; keep auto-top-floor garrison as the defend/ambush default; preview dots must show the TARGET FLOOR when ordering into a building) → M5 (preview===execution parity test + resolver perf budget) → M6 (under-fire crawl-to-cover, LAST — attrition shifts, re-run the balance grid after).
- lane-m worktree/branch still exist; M1 is in main — reuse or delete.

## Open debts (small, tracked)

- drawHearthGlow flicker: art-baseline instability; fix = staging pin in furniture.ts/main.ts (diagnosed in the wave-4 manifests).
- fx pock/debris stamps not sun-step-keyed (cosmetic stale sprite if the sun moves mid-battle).
- Towns-v2: owner wants towns "improved" — waiting for specifics after they play a live bourg cell (t/T on the sector map, e.g. St-Aubin).
- Worktree wf_6ff3010c-f4c-1 (shadow fix, merged) is removable now; lane-b/lane-m after their merges.

## Deploy recipe (verified twice)

npm run build → replace ~/CodingProjects/personal-website/public/demos/close-combat-like with dist/ → smoke: serve a scratch dir containing a demos/close-combat-like symlink via python3 -m http.server PORT, then node scripts/smoke-dist.mjs --url http://127.0.0.1:PORT/demos/close-combat-like/ → commit+push the website repo (origin main; Netlify auto-deploys) → ~60s later curl https://joshtaylor.world/demos/close-combat-like/ and confirm the new index-*.js hash.

## Process rules that bit us (full versions in project memory)

- Repo hook blocks Co-Authored-By trailers; commit without.
- Workflow agents: the FINAL action must be the StructuredOutput manifest — a text-only ending kills the chain. On persistent 529s spawning opus agents, edit the script so remaining slices drop model:'opus' (inherit session model) while completed slices keep byte-identical opts (cache hits).
- Shell cwd persists across Bash calls — a merge after cd-ing into a worktree runs in the WRONG repo and "Already up to date" lies. cd back or use -C.
- Sequential chains + handoff fields on one worktree beat parallel worktrees when tasks share files (zero conflicts across 5 chains; the parallel waves needed hand-merges).
- Vite binds IPv6 ([::1]); harness default port 5198; before trusting screenshots, curl-grep a new symbol to prove the served code is yours.
