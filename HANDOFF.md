# Handoff — Execute Mapgen v2 (Bocage Believability + Scale)

**Date:** 2026-07-22
**Project:** top-down-military-rts

## Current Task
Execute the mapgen v2 plan: hedge/field terrain types, farm compounds with lanes, orchards, and a second hamlet at 320×240 — building on the roads-first generator that shipped today.

## Completed
- Roads-first Normandy generator shipped and merged to main: `src/sim/mapgen.ts`, `MapPlan {map, buildings, spawns, objectives}` contract, deterministic + A*-validated, 59+ tests green (session commits de634ee…af326c2)
- Verified in-browser at 6 seeds × 3 zooms plus a debrief → battle-1 transition (`.screenshots/`)
- Decision logged in `docs/decisions/INDEX.md` (roads-first chosen over BSP/Voronoi; hedges = woods-line tiles, not a new edge type)
- Mapgen v2 plan written with exact code per task: `docs/plans/2026-07-22-mapgen-v2-bocage.md`

## Key Decisions
- Hedgerows get a dedicated `hedge` terrain key in v2 (Task 1) — visual distinction from woods; vehicle-blocking moves from "woods" membership to an explicit `canStep` rule
- Tasks 1–4 all edit `src/sim/mapgen.ts` → builders run SEQUENTIALLY (one builder + one validator per task), never in parallel
- Task 4's refactor must NOT change 160×120 geometry — the seed-1/seed-2 fingerprint snapshots are the gate (run vitest WITHOUT `-u` first)

## Relevant Files
| File | Notes |
|------|-------|
| `docs/plans/2026-07-22-mapgen-v2-bocage.md` | THE PLAN — execute this; exact code, tests, commands per task |
| `src/sim/mapgen.ts` | The generator all tasks modify |
| `src/sim/data.ts`, `src/sim/map.ts`, `src/render/terrain.ts` | Task 1/3 touchpoints (terrain defs, canStep, art) |
| `tests/mapgen.test.ts` | Determinism/snapshot/connectivity tests; grows per task |
| `docs/decisions/INDEX.md` | Generator architecture decision + rejected alternatives |

## Context & Warnings
- Working tree clean; no git remote (push is a no-op); a hook blocks the `Co-Authored-By` trailer — omit it
- Parallel session is executing the M-A strategic plan on main (main moved 4× today). MERGE MAIN INTO YOUR BRANCH FIRST, test, then start; merge back via `git -C <root> merge --ff-only <branch>` (memory: design-sequencing-2026-07)
- Do not touch `src/main.ts`, `src/campaign/**`, `src/strategic/**`, `src/ui/**`, `src/sim/scenario.ts` — M-A owns them
- Custom agent types (coder/auditor/etc.) pin unreachable models — always pass an explicit `model:` when spawning (memory: agent-model-pins)
- Browser verification: `?seed=N` URL param pins the map; dev server port 5199/5197 may be taken by parallel sessions — pick a free one

## Suggested Next Steps
1. Architect the subagent-driven execution: read the plan, then run Tasks 1→2→3→4 sequentially, each as one builder subagent (explicit model, task text as brief, its tests + `npm run check` as success criteria) followed by a separate validator subagent in fresh context
2. Task 5 (browser screenshots + art acceptance checklist) inline, then merge to main

## Copy-paste prompt for the fresh session

```
You are a procedural-generation engineer for tactical wargames orchestrating
subagent-driven execution of a fully-written implementation plan (WW2 top-down
RTS, TypeScript + Canvas, deterministic headless sim in src/sim/).

## Context
Yesterday's session shipped a roads-first Normandy map generator
(src/sim/mapgen.ts — arterial+cross roads, crossroads village, hedgerow
parcels, woods stands; MapPlan {map, buildings, spawns, objectives};
deterministic, A*-validated). Mapgen v2 upgrades believability (hedge/field
terrain, farm compounds with lanes, orchards) and proves 320×240 scale with a
second hamlet.

## What's Been Done
- Plan with exact code per task: docs/plans/2026-07-22-mapgen-v2-bocage.md —
  execute this, it is the spec
- Generator + tests merged to main; ~59 tests green at handoff

## Key Discoveries / Warnings
- A parallel session executes the M-A strategic plan on main (it moved 4×
  in one day). Merge main into your worktree branch FIRST, run
  npx vitest run + npm run check, then start. Merge back with
  git -C <repo-root> merge --ff-only <branch>. Never touch src/main.ts,
  src/campaign/**, src/strategic/**, src/ui/**, src/sim/scenario.ts.
- TERRAIN keys are append-only (tile bytes index Object.keys order).
- mapgen.ts must stay seeded-rng-only: no Math.random/Date/Math.hypot.
- Tasks 1-4 all edit src/sim/mapgen.ts — run builders SEQUENTIALLY, one per
  task, each followed by a separate validator agent in fresh context. Custom
  agent types pin broken models — always pass model: "sonnet" (or valid tier).
- Task 4 must not change 160×120 geometry: run vitest WITHOUT -u first; the
  seed-1/seed-2 inline fingerprints must pass untouched.
- No git remote; omit the Co-Authored-By trailer (a hook rejects it).

## What I Need You to Do
1. Read HANDOFF.md, then docs/plans/2026-07-22-mapgen-v2-bocage.md end-to-end.
2. Merge main into the worktree branch; verify tests green before any task.
3. Execute Tasks 1→2→3→4 sequentially, builder+validator per task, commit per
   task with the plan's commit messages.
4. Run Task 5 (browser screenshots at seeds 1/2/7, acceptance checklist,
   .screenshots/) inline, fix art in terrain.ts only, then merge to main.
```
