# top-down-military-rts

A top-down military real-time strategy game in TypeScript. Deterministic
simulation, a separate render layer, and a strategic layer above the tactical
battles.

![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6) ![Vite](https://img.shields.io/badge/Vite-6-646cff)

## Run it

```bash
git clone https://github.com/FlaccidNoise/top-down-military-rts.git
cd top-down-military-rts
npm install
npm run dev
```

Vite prints a local URL — open it. That's the whole setup; no API keys, no
services, no config file.

## Commands

| Command | Wall time | Does |
|---|---|---|
| `npm run dev` | — | Dev server with hot reload |
| `npm run build` | — | Production build to `dist/` |
| `npm run check` | — | Typecheck (`tsc --noEmit`) |
| `npm run test:quick` | ~23s | 1059 tests across 85 files — the pre-commit gate |
| `npm test` | ~2 min | Full suite |

For a single file while iterating: `npx vitest run tests/<file>.test.ts`.

## Layout

```
src/main.ts     entry point
src/sim/        deterministic simulation core
src/render/     drawing, terrain, roofs
src/strategic/  campaign-map layer above tactical combat
src/campaign/   scenario and progression logic
src/ui/         interface
tests/          vitest suites
docs/           design notes and plans
```

The simulation is kept deterministic and free of render imports — same inputs
produce the same outputs, which is what makes the test suite meaningful.

## Optional environment variables

Neither is required.

| Variable | Purpose |
|---|---|
| `DEV` | Enables dev-only diagnostics |
| `SEEDS` | Fixed RNG seeds for reproducible sim runs in tests |

## License

No license file yet — all rights reserved by default. Add one before reusing.
