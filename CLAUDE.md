# top-down-military-rts

Agent guidance: `AGENTS.md`. Milestone state: `HANDOFF.md`, `HANDOFF-M5.md`.

## Bug tracking (jtbug)

Work is tracked in jtbug, group `rts`. The MCP server `jtbug` is registered via `.mcp.json` (actor `claude-rts`). Check `briefing` at session start. File discovered problems with `bug_create` into group `rts` instead of fixing out-of-scope things inline. Reference bugs as `#N` in commits.

CLI fallback: `BUG_URL=${BUG_URL} BUG_ACTOR=claude-rts node <repos>/jtBugTracking/packages/cli/bin/bug.js <cmd>`
