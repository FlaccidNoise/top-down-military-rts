# Top-Down Military RTS — Agent Guide

## Testing (read before running any tests)

Three tiers, measured 2026-07-31:

| Command | Wall time | Use |
|---|---|---|
| `npx vitest run tests/<file>.test.ts` | 1–5s | Iterating on one feature |
| `npx vitest related src/<path>.ts` | seconds | After editing one source file |
| `npm run test:quick` | ~23s | Pre-commit sanity (85 files, 1059 tests) |
| `npm test` | ~2 min | Full suite — ONLY on owner request or before merge/deploy |

NEVER run `npm test` during dev iteration. Use `test:quick` or single-file runs.
`tsc --noEmit` (`npm run check`) stays in every gate — it's fast.

The jtbug runner's merge gate always runs the full `npm test` before it merges
an agent's branch to main (set in `packages/runner/runner.config.json` in the
jtBugTracking repo). So an agent-dispatched change is full-suite verified even
though this guide tells you to iterate with `test:quick`.

Quick tier excludes 10 slow files (>5s each), listed with their timings in
`vitest.quick.config.ts`. `doctrine.test.ts` alone is 112s (commander soak
sims, 6k–80k ticks); `perf.test.ts` 64s; `bourg.test.ts` 36s (map regen).
When you add a test file that runs >5s, add it to the SLOW list in
`vitest.quick.config.ts` with its measured time.

Validators/verifiers: `npm run check && npm run test:quick` is the standard
gate. Escalate to `npm test` only when the change touches doctrine/perf/bourg/
mapgen territory or the owner asks for full.

## Repo layout

- `src/` — game code (sim, mapgen, strategic, ui)
- `tests/` — vitest suite, one file per concern
- `scripts/` — browser gates (playwright/CDP) and probes; `scripts/tutorial.mjs` is the strategic/UX gate
- `docs/` — plans, specs, decisions (INDEX.md is the running log)
