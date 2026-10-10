# Top-Down Military RTS — Agent Guide

## Testing (read before running any tests)

Three tiers, measured 2026-07-31:

| Command | Wall time | Use |
|---|---|---|
| `npx vitest run tests/<file>.test.ts` | 1–5s | Iterating on one feature |
| `npx vitest related src/<path>.ts` | seconds | After editing one source file |
| `npm run test:quick` | ~27s | Pre-commit sanity (every file not on the SLOW list) |
| `npm test` | ~2 min | Full suite. Only on owner request or before merge/deploy |

Don't run `npm test` during dev iteration. Use `test:quick` or single-file runs.
`tsc --noEmit` (`npm run check`) stays in every gate — it's fast.

Quick tier excludes 10 slow files (>5s each), listed with their timings in
`vitest.quick.config.ts`. `doctrine.test.ts` alone is 112s (commander soak
sims, 6k–80k ticks); `perf.test.ts` 64s; `bourg.test.ts` 36s (map regen).
When you add a test file that runs >5s, add it to the SLOW list in
`vitest.quick.config.ts` with its measured time.

Validators/verifiers: `npm run check && npm run test:quick` is the standard
gate. Escalate to `npm test` only when the change touches doctrine/perf/bourg/
mapgen territory or the owner asks for full.

## Where things are

- `scripts/` — browser gates (playwright/CDP) and probes; `scripts/tutorial.mjs` is the onboarding gate (a fresh profile from the landing screen through the drill to the first campaign debrief, desktop and phone); `scripts/drill.mjs` plays the drill on any seeds and devices; `scripts/stratsweep.mjs` is the theater map's art gate (fixed seed, staged states, three devices, `--diff <baseline dir>`)
- `scripts/lib/play.mjs` — real mouse and CDP touch input for those gates. Targets come from live state (`window.__game.tutorialView`, `.stage`), never fixed pixels
- Headless sweeps (`npx vite-node scripts/<name>.mjs -- <flags>`): `drillsweep.mjs` (is the drill winnable by its steps and safe to idle in), `firstcontact.mjs` (which preset gives a winnable first battle: the measurement behind `FIRST_PRESET`)
- `src/drill.ts` — the training battle. `src/ui/tutorial.ts` — the step driver for the drill and the campaign
- `docs/` — plans, specs, and decision records (`docs/decisions/INDEX.md` indexes the decisions)
