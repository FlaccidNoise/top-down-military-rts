# Handoff — Execute Milestone 5: Unit System Foundation (AFTER M-A)

**Date:** 2026-07-22
**Project:** top-down-military-rts

> **Sequencing:** `HANDOFF.md` (from the parallel strategic session) executes the
> M-A strategic skeleton and declares the unit system lands AFTER M-A, never
> interleaved. Run that first. This handoff is the M5 session that follows.

## Current Task
The unit-system design (6 specs across this session + the strategic session) is complete and committed. This session executes the M5 implementation plan with subagents.

## Completed
- Specs: unit system (teams/archetypes/schema), TO&E + attachments, order execution (interpret + refuse), casualty chain + succession, AI commander (honest vision) — `docs/specs/2026-07-22-*.md`.
- Decisions logged: `docs/decisions/units.md`, `gameplay.md`, INDEX updated.
- Implementation plan committed (da466c8): `docs/plans/2026-07-22-unit-system-foundation.md` — 14 tasks, 6 dependency batches, verified against the code as of da466c8.

## Key Decisions
- Team (3–6 men) is the command atom; vehicle/gun crews are single-team squads — one data shape.
- Orders are intent: comply / comply-cautious / balk ladder with UI reason chips.
- One shared danger model serves soldier refusal, team positioning, and AI planning.
- AI plays through the player order API only; honest vision; its troops balk too.
- TO&E/requisition/supply→ammo NOT in M5 (waits on strategic tiers past M-A).

## Relevant Files
| File | Notes |
|------|-------|
| `docs/plans/2026-07-22-unit-system-foundation.md` | THE payload — read fully first |
| `docs/decisions/INDEX.md` | decision log (standing instruction: read at session start) |
| `docs/specs/2026-07-22-unit-system.md` | schema §7, signature mechanics §3 |
| `docs/specs/2026-07-22-order-execution.md` | order behaviors, refusal model |
| `docs/specs/2026-07-22-casualty-chain.md` | succession, aid, crewSkill |
| `docs/specs/2026-07-22-ai-commander.md` | commander v2 architecture |
| `src/sim/sim.ts` | the hub — most tasks modify it; batches serialize through it |

## Context & Warnings
- The plan was written while M-A work was landing. **Before executing, re-verify the plan's touchpoints against post-M-A main** (`scenario.ts`, `campaign.ts`, `main.ts` are the hot files) and amend task file references where M-A moved things. Grep symbols, not line numbers.
- Work on branch `m5-unit-system`; rebase between batches.
- Determinism is sacred: seeded RNG only; extend `snapshot()` in tests/sim.test.ts, never weaken it.
- Pre-commit hook blocks `Co-Authored-By` — omit trailers. No git remote; push is a no-op.

## Suggested Next Steps
1. Architect the subagent-driven execution: read the plan, diff its assumptions against post-M-A main, then batch per the plan's dependency table and spawn one builder agent per batch paired with a fresh-context validator agent (a builder never self-validates).
2. Batches 1–5 are sequential chains through sim.ts; only Batch 6 (UI ∥ doctrine tests) runs parallel agents.
3. After Task 14, record doctrine-test numbers in the commit message — they are the tuning dashboard.

## Copy-paste prompt for the fresh session

```
You are a senior TypeScript game-systems engineer orchestrating subagent-driven
execution of a written implementation plan for a WW2 tactical sim (Close
Combat-style; headless deterministic sim in src/sim/; every soldier
individually simulated).

## Context
Milestone 5 builds the unit system designed in docs/specs/2026-07-22-*.md.
Design is done and committed — your job is orchestration and execution, not
design. Do not relitigate decisions in docs/decisions/. Precondition: the M-A
strategic skeleton (HANDOFF.md) is already executed; if git log shows no M-A
task commits, stop and run that handoff first.

## What's Been Done
- Plan: docs/plans/2026-07-22-unit-system-foundation.md (commit da466c8) —
  14 tasks in 6 dependency batches with exact schemas, signatures, and tests.
- Specs + decision log committed (docs/specs/, docs/decisions/INDEX.md).

## Key Discoveries
- The plan predates M-A execution: re-verify its touchpoints (scenario.ts,
  campaign.ts, main.ts) against current main before batching; amend stale
  references. Grep symbols, never trust line numbers.
- Determinism is sacred: seeded RNG only (mulberry32); the snapshot() test in
  tests/sim.test.ts must be extended, never weakened.
- src/sim/sim.ts is the hub: batches 1-5 are sequential chains; only Batch 6
  (UI wiring ∥ doctrine tests) parallelizes.
- Pre-commit hook blocks 'Co-Authored-By' in commit messages — omit it.
  No git remote; push is a no-op.

## What I Need You to Do
1. Read HANDOFF-M5.md, then docs/plans/2026-07-22-unit-system-foundation.md in
   full, then docs/decisions/INDEX.md and the four spec files the plan cites.
2. Run git log --oneline -10; confirm M-A landed; git checkout -b m5-unit-system.
3. Re-verify the plan's file-touchpoint assumptions against current code and
   amend the plan file where M-A moved things (commit the amendment).
4. Map the plan's 6 batches into an execution schedule and run them
   subagent-driven: one builder agent per batch (tasks sequential within it),
   each paired with a separate fresh-context validator agent that runs
   `npm run check && npm run test:quick` (full `npm test` only pre-merge — see
   AGENTS.md#testing) and reviews the diff against the task text
   before the next batch launches. Never let a builder self-validate.
5. Commit after every task; verify each agent completes before the next batch.
```
