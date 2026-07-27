# HANDOFF — 2026-07-27 (post fidelity campaign, mid balance + movement)

Fresh session: read this, then docs/decisions/INDEX.md, then the project memory index. Act as the orchestrator of multi-agent workflows on this repo (Workflow tool, worktree lanes, sequential chains with structured handoffs).

## State of main (634d111)

Everything below is MERGED, gated, and deployed to joshtaylor.world/demos/close-combat-like/ (Netlify, push-to-deploy from ~/CodingProjects/personal-website — the game lives at public/demos/close-combat-like/, a copy of this repo's dist/):

- Fidelity campaign complete: baked roofs/walls/terrain/units/vehicles/emplacements/effects, yards+clutter, burning, atmosphere. Strict plan-view art rule (owner-set, in project memory): NO elevation views; shadows sweep from the caster's base (light.ts sweptRectPath/sweptStrokePath/capsulePath, cap SHADOW_LEN_LEGIBLE=2.4).
- Bourg town generator LIVE in campaign (CHAR_TERRAIN t/T → 'bourg', src/strategic/sector.ts). Furnished role-based interiors LIVE (opts.interiors on at bridge.ts + scenario.ts). Micro-relief/rail/halt generate. Stance-aware LOS. Aged leaning smoke plumes (renderer draws what blocks sight). Destructible walls D1–D13 end-to-end (EDGE.BREACH, vehicle crush, AT breaching, render invalidation via src/render/versions.ts). Day/night N1–N14 (src/sim/solar.ts, sun-step rebakes, night spotting caps, CANON_CLOCK_MIN=840).
- Mobile: touch in both modes, bottom-sheet HUD, DPR, PWA. scripts/mobile.mjs green (needs --port of a live dev server).
- M1 of the movement chain merged: src/sim/spots.ts pure resolver + tests/spots.test.ts (16 tests). INERT until M2 wires it.

Gates at last full run: 921+ tests green, tsc clean, bake.mjs ≤8ms, vfx.mjs 18/18, sweep 112 shots (canonical hour 1400 pinned — never sweep unpinned), smoke-dist PASS.

## In flight: balance workflow (THE blocking item)

- Run wf_bd98002a-64c. Script: ~/.claude/projects/-Users-joshtaylor-CodingProjects-top-down-military-rts/cc0a7d57-f5e5-43a0-a61f-367d9a8a68ec/workflows/scripts/balance-blob-rush-wf_bd98002a-64c.js. Resume after a crash: Workflow({scriptPath, resumeFromRunId:'wf_bd98002a-64c'}). Per-agent reports: same session dir, subagents/workflows/wf_bd98002a-64c/journal.jsonl.
- Worktree .claude/worktrees/lane-b, branch lane-b-balance (baseline commit 199f9e8). Harness: scripts/balance.mjs (blob/blob-fast/doctrine × open/woods/bourg × 6 seeds, cap 54000 ticks). Baseline: scripts/.balance-baseline.json.
- Instrumented diagnosis (journal results 2–3): (1) runDefend puts garrisons on ambush; the 40m/60m trigger leash gives the blob a free approach march then a point-blank fight; (2) the defense generates so little fire that pinning/morale never engage (blue suppression 0.00–0.02 crossing open ground); (3) the blob never balks — dangerScore peaks 0.800 vs ~0.85 threshold. Also: AI-doctrine attacker won 0/18 — its own bug, in scope.
- Tune phase: ≤3 iterations, each re-measures. TARGETS: blob/blob-fast ≤35% wins on bourg+woods with ≥45% blue casualties on wins; doctrine profile within 15 pts of its baseline; doctrine-health + determinism suites green.
- When it lands: merge lane-b → main; re-run tests/perf.test.ts on a QUIET machine before believing failures (mapgen budgets sit at 39–45ms vs 40 under harness load); full gates; redeploy (recipe below); report the tuning table to the owner.

## Next after balance: movement chain M2–M6

Spec: docs/plans/2026-07-27-movement-cover-design.md. M1 merged; the frozen interface + full M2 wiring contract live in the M1 workflow manifest (journal of wf_50ad21e1-a3e) — load-bearing points: pre-filter soldierIds with exported eligible() in team order; q.x/y = post-fan anchor; thread kind+arc from TeamOrder; ONE fresh used-Set per moveSoldiersTo call and the resolver adds tile keys itself; omitted soldiers = no footing (caller skips, M4 surfaces); findSpot keeps dismount/bail/flee; call once at order time (PATH_BUDGET amortization, INDEX.md order-burst entry). Known deviation: threat half-plane is strict <90°.
- Run as ONE sequential chain on a worktree branched from post-balance main: M2 (wire moveSoldiersTo, re-record determinism baselines) → M3 (defend/ambush garrison audit; re-run balance.mjs, hand the delta to balance) → M4 (overlays preview: ghost dots, snap tails, refusal-early, "n/m covered" chip) → M5 (preview===execution parity test + resolver perf budget) → M6 (under-fire crawl-to-cover, LAST — attrition shifts, re-run the balance grid after).
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
