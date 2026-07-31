# Block Coordination Layer — 2026-07-29

Adds a per-block/per-run coordination step between parcels (stage 8) and
footprints (stage 9) in the bourg pipeline: `src/sim/bourg/coord.ts`,
called from `planBourg()` as `coordinateBlocks(sk, pc)`. Adjusts plot
positions and house placement ONLY — micro house/yard generation (footprint
shapes, parts, wings, doors, stamp, enclosure wall rules, yard rendering,
rural farms) is untouched.

## Audit Findings (2026-07-29, verified by probing 12 seeds × 6 kinds)

Already exists (verified, kept):
- Party-wall jitter across adjacent plots (`parcels.ts:247-254`)
- `indexInRun` for wing pairing (`parcels.ts:183`)
- Terrace-run chaining (`footprints.ts:289-299`)
- R-O2 one-rear-wall dedup between gardens (`enclosures.ts:140-146`)
- Lateral wall dedup with depth tiebreak (`enclosures.ts:148-170`)
- Wall fragment cleanup + connectivity repair (`enclosures.ts cleanWallFragments`/`repair`)
- House orientation within a row (all plots on a FrontageRun share axis+side)

Residual gaps this layer owns (measured before the fix, 72 maps):
- **(a) 1-tile sliver gaps** — 123 same-row house pairs exactly 1 tile apart.
  Root cause: `inset = p.w >= 7 ? 1 : 0` put a 1-tile inset beside a flush
  terrace neighbour; `gap = 1 + r9.int(2)` could also draw a 1-tile gap.
- **(b) glued sheds** — 45 same-row pairs 0 tiles apart with NO shared
  terraceRun (each draws its own party wall; reads as two sheds fused).
- **(c) parallel backyards / leftover strips** — 76 columns where opposing
  runs' rear lines left a 1-3 tile strip of unclaimed ground between the two
  garden rows (double rear walls around a sliver).
- **(d) staggered street face** — fringe plots drew `setback = 2 + r8.int(3)`
  independently, so a row's front walls zigzagged.
- **(e) house orientation** — NOT a gap; verified, all plots on a run agree.

## Rules (C1-C2)

### C1 · Frontage setback alignment
Within a run, all plots share the same setback. Take the **mode** setback
(most common; ties to the larger) so one outlier can't pull the whole row,
then clamp each plot's setback to `d - 4` (a shallow plot's wall sits at the
line its depth forces).
Measured result: **setback spread within every run = 0**.

### C2 · Detached minimum gap
A gap of exactly 1 tile between two detached houses reads as neither terraced
nor detached. Rules, in `footprints.ts`:
- The minimum gap a detached (mid-band) house may draw is 2 tiles
  (`gap = 2 + r9.int(1)`; same draw count and stream position as before).
- The side inset for a detached house is **2, never 1** (`p.w >= 9`): beside
  a flush terrace the combined gap is then ≥ 2.
- A plot too narrow for `gap + body + 2×inset` — or with no right-hand inset
  (`p.w < 9`) — **flushes instead**: it fills its plot and joins the terrace
  chain (`flush = gap === 0 && inset === 0`, party wall, shared terraceRun).
  Never a 1-tile sliver, never a 0-gap pair without a shared run.
Measured result: **0 same-row slivers, 0 unshared 0-gap pairs** over 72 maps.

### C3 · Rear-line snap — RARE but load-bearing (corrected 2026-07-29)
C3 snaps opposing runs' rear depths onto one line (`dA + dB = G`). An
adversarial verifier first reported it a provable no-op (parcel extraction
bounds opposing depth columns) and its dedicated metric test was indeed a
tautology — but deleting it MOVED the bourg fingerprints, so the snap does
fire on bourg cores with true opposing runs and the no-op proof had a hole.
The code stays (the pins encode its effect); the tautological test was
removed. What remains of the intent: **0 feasible-but-unmerged rear strips**
— every remaining
strip is geometrically forced.

## What This Deliberately Does NOT Do

- Does NOT change how houses are shaped (parts, wings, porte-cochère, doors)
- Does NOT change enclosure wall rules (R-O1, R-O2, tops, gates, cleanup)
- Does NOT change yard rendering or stamp logic
- Does NOT change rural farm compound placement
- Does NOT force all houses in a run to the same depth (`bd` still varies)
- Does NOT add random draws — all coordination decisions are pure functions
  of existing plot data (determinism law: mulberry32, subStream tags only)

## Documented Residuals (verified, measured)

- **Infeasible rear strips** (64 plot-pairs / 72 maps): an opposing pair whose
  shallowest plots cannot reach the meeting line (`minA + minB < G`, or
  `G < 8`). The plots physically don't reach the middle; merging would require
  growing a plot into claimed/interior/rural ground, which is forbidden. The
  strip stays at its natural minimum (1-3 tiles of block-interior ground).
  Of these, ~10 produce two parallel rear walls ≤ 1 tile apart (R-O2 dedups
  garden↔garden walls only when the outside tile IS the other garden).
- **Garden↔other-owner wall pairs** (~9 / 72 maps): a garden rear wall 1 tile
  from a farm compound wall or the churchyard wall. Each is a legitimately
  separate boundary system (R-O2's dedup is garden↔garden; compounds are
  rural.ts placement, churchyard is the reservation wall). Pre-exists this
  layer; not a coordination regression.

## Determinism

- No new random draws. `coordinateBlocks` is draw-free; the C2 rules keep the
  exact same two footprint draws under the same conditions.
- Draw counts are still pure functions: the narrow-plot flush removes an
  early return, so those plots now consume the body/wing draws they previously
  skipped — deterministic, and covered by the re-baseline.
- Pins re-baselined via `scripts/fp.mjs` (relief-wiring PRE_RELIEF, all 6
  kinds) and hand-pasted computed values (bourg.test.ts relief-on + relief-off
  bourg/road/river/bridge, mapgen.test.ts furnished bourg). Only expected pins
  moved; 160x120 flag-off open and the open/woods 320x240 fingerprints did not
  move (coordination has no effect on those maps — hamlets have no mid-band
  detached rows or feasible opposing pairs).

## Verification

- `scripts/probes/block-coord.mjs` — 12 seeds × 6 kinds: same-row sliver=0,
  unshared 0-gap=0, feasible-unmerged strips=0, setback spread=0, all residual
  strips infeasible.
- tests/bourg.test.ts "block coordination (2026-07-29)" — the four invariants
  above as a structural battery (12 seeds × 6 kinds, including the
  garden↔garden double-wall probe with the forced-strip carve-out).
- Full suite: 1305 passed (2 vitest worker RPC timeout flakes, infra-only).
