# Handoff — Execute M-A Strategic Skeleton (subagent-driven)

**Date:** 2026-07-22
**Project:** top-down-military-rts

## Current Task
Execute the approved M-A milestone plan: replace the linear 3-battle campaign with a playable strategic layer (cell-grid sector, company chits, continuous clock, contact → tactical battle → ownership feedback). The plan is fully written with complete code; this session architects and runs its subagent-driven execution.

## Completed
- Strategic campaign design approved: `docs/specs/2026-07-22-strategic-campaign.md` (tiers T1–T3, decision log entry in `docs/decisions/architecture.md`)
- M-A implementation plan written: `docs/plans/2026-07-22-strategic-skeleton.md` — 6 tasks, full code, tests, dependency batches
- All design docs committed (`dd455ac`)

## Key Decisions
- Front commander on a 40×30 × 500 m cell grid; universal both-sides soldier persistence; continuous clock + pause; battles carved from cells (M-B — M-A still uses today's `makeMap`)
- M-A plan is written against TODAY's code (9-man squads). The parallel unit-system + TOE designs (`docs/specs/2026-07-22-unit-system.md`, `docs/specs/2026-07-22-toe-attachments.md` — the latter supersedes the spec's `CompanyChit` sketch for later tiers) land AFTER M-A, never interleaved. M-A's minimal `Chit` is a deliberate subset and stays valid

## Relevant Files
| File | Notes |
|------|-------|
| `docs/plans/2026-07-22-strategic-skeleton.md` | THE PLAN — execute this |
| `docs/specs/2026-07-22-strategic-campaign.md` | Design the plan implements (M-A section) |
| `src/campaign/campaign.ts` | Modified by Tasks 3 & 5 |
| `src/sim/scenario.ts` | Modified by Tasks 4 & 5 |
| `src/main.ts` | Rewritten by Task 5 |

## Context & Warnings
- **Worktree conflict:** `git branch -vv` shows live worktrees; `worktree-structured-drifting-lollipop` contains a full UI pass that also rewrites `src/main.ts`. Reconcile (merge or discard) BEFORE Task 5, or execute Tasks 1–4 first and re-plan Task 5 against the merged main.
- No git remote — commits are local; `git push` is a no-op.
- A repo hook blocks commits containing the `Co-Authored-By` trailer — omit it.
- `npm run check` and `npm run test` must pass after every task; commit per task.

## Suggested Next Steps
1. Architect the subagent execution: reconcile the UI-pass worktree, then batch the plan's tasks by its dependency graph (Batch 1: Tasks 1+3 parallel; then 2; then 4; then 5 alone; then 6) and spawn a builder agent per task with a validator pass per batch.
2. After Task 6, run the plan's Task 5 manual smoke checklist in the browser.

## Copy-paste prompt for the fresh session

```
You are a senior TypeScript game developer orchestrating subagent-driven execution
of a fully-written implementation plan for a Close Combat-style WW2 tactical sim
(TS + Canvas, deterministic headless sim in src/sim/, renderer in src/render/).

## Context
The linear 3-battle campaign is being replaced by milestone M-A: a strategic layer
(40×30 cell sector, company chits, continuous clock, contact → tactical battle →
cell ownership feedback). The plan is complete — exact code, tests, and commands
for 6 tasks. Your job is orchestration and verification, not design.

## What's Been Done
- Plan: docs/plans/2026-07-22-strategic-skeleton.md (execute this, it is the spec)
- Design it implements: docs/specs/2026-07-22-strategic-campaign.md
- All docs committed at dd455ac; working tree was clean at handoff

## Key Discoveries / Warnings
- Live worktree `worktree-structured-drifting-lollipop` also rewrites src/main.ts
  (UI pass). Reconcile it BEFORE the plan's Task 5, or do Tasks 1-4 first and
  adapt Task 5's main.ts rewrite to the merged file.
- The unit-system spec (docs/specs/2026-07-22-unit-system.md) is approved but
  lands AFTER M-A — do not interleave it.
- No git remote (push is a no-op). A hook blocks the Co-Authored-By trailer in
  commit messages — omit it.
- npm run check + npm run test must be green after every task; commit per task.

## What I Need You to Do
1. Read HANDOFF.md, then the plan end-to-end.
2. Reconcile the UI-pass worktree with main (inspect its diff; merge or park it —
   ask the user only if the diff shows real feature work that M-A would clobber).
3. Map the plan's dependency graph into batches (it's in the plan: 1+3 parallel,
   then 2, then 4, then 5 alone, then 6). Spawn one builder subagent per task with
   the plan's task text as its brief and explicit success criteria (its tests +
   npm run check green); validate each batch with a separate reviewer agent in
   fresh context before starting the next.
4. After Task 6, run the plan's manual smoke checklist (plan, Task 5) in the
   browser and report results.
```
