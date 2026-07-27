# MAPGEN V3 — one generator, per-kind profiles

Owner intent, after the bourg shipped live: "apply similar, but tuned, values and
simulation to generate ALL of our maps and map types." This design makes the bourg
pipeline (`src/sim/bourg/*`) the single generator. Per-kind parameter profiles replace
the legacy 2026-07-22 blob-village pipeline (`mapgen.ts tryGenerate`) for `open`,
`woods`, `river`, `bridge` and `road`. The legacy `town` kind is retired.

Every claim below cites file:line against the tree at commit b372eee.

---

## 0. What is already kind-agnostic, and what is not

Audit of the bourg pipeline, stage by stage:

| Stage | Module | Kind-agnostic today? |
|---|---|---|
| 1-3, 5 streets | streets.ts (buildSkeleton :217, growMinorStreets :523) | **Mostly.** The Parish & Müller loop, the jog/cap machinery, the seg/street plumbing and the arterial re-expression (:203-213) are generic. Bourg-specific: archetype weights (:112-117), envelope dims (:228-230), fixed street counts (:487-496). All become profile fields. |
| 4 landmarks | landmarks.ts (reserveLandmarks :43) | **Bourg-shaped but probability-gated already** (market p0.6 :202, forecourt fallback :239-252). Church/market/forecourt/place-widening each get a per-profile probability; p=0 for a kind skips the sub-stage without moving any other stage (D2 sub-streams). |
| 6-8 parcels | parcels.ts (buildParcels :88) | **Yes.** CCL blocks, depth BFS, back lanes, frontage runs, burgage strips read only the road bitmap + resv + the zone. Bourg-specific constants (BACK_LANE_DEPTH :79, depth caps :219) become profile fields with current defaults. |
| 9 footprints | footprints.ts (buildFootprints :192) | **Yes**, driven entirely by density + landmarks. MAX_BUILDINGS :72 and the terrace rules :249 become profile fields. |
| 10 enclosures | enclosures.ts (stampEnclosures :66) | **Yes.** Operates on fp/land data; the connectivity label+repair loop (:288-292) is generic. |
| 11 rural | rural.ts (addRuralFabric :58, paintRural :363) | **Yes** — this IS the open-country generator: farms (:78), space-colonisation lanes (:149), jittered-grid bocage (:271), stands/orchards/fields (:393-440). Counts/radii/CELL become profile fields. |
| 12 stamp | stamp.ts (stampStructure :68) | **Fully.** Mask stamper, role-driven storeys. |
| objectives | objectives.ts (buildObjectives :55) | **Yes** — tagged prefix + greedy coverage fill to 12; needs only per-kind prefix rules. |
| 13 elev + relief + halt + interiors | mapgen.ts (tryGenerateBourg :537, bourgFlatMask :644, elevateBourg :623) | **Yes.** The flat mask (zone + compounds + occ dilation + free walls) generalizes verbatim; relief profiles are already per-kind (RELIEF_BY_KIND :150-165); furnishHere :520 is shared. |
| validation | mapgen.ts (reachField :768, validate :862) | **Fully kind-agnostic already** and shared by both pipelines today. |

RNG regime carried forward unchanged: ONE `rng.int(0x7fffffff)` on the shared stream
inside the kind branch (mapgen.ts:538), every stage on
`subStream(base, TAG)` (streets.ts:39-41), tags frozen and only ever APPENDED
(streets.ts:18-20). V3 appends `TAG.WATER = 15` and `TAG.CLEARING = 16`.

Legacy pipeline features that must survive the port:
- Water band + "roads carve last and win over water; the crossing IS the bridge",
  with `map.bridges[i] = 1` recorded at the overwrite (mapgen.ts:258-276, 434-437).
- Bridge/river objective appended LAST (mapgen.ts:101 contract; tests
  mapgen.test.ts:169, 224-226; the crossing gets its own garrison sector for free,
  INDEX.md 2026-07-23 archetypes entry).
- `open` at 160x120 must emit ≥3 buildings near objectives[0] and a passable woods
  anchor at objectives[1] — scenario.ts:49-56 destructures `[b0, , b2]`, garrisons
  the woods, and emplaces the MG42 on objectives[0].
- Second-settlement slot objectives[2] on w ≥ 240 (mapgen.ts:443-444; the bourg
  already preserves it, objectives.ts:76-82).
- 60x40 floor generation for every kind (mapgen.test.ts:199-209; bourg.test.ts:268).

---

## 1. The profile

New file `src/sim/bourg/profile.ts`:

```ts
export interface KindProfile {
  // stage 1: nucleus scale. 'town' = full envelope + landmarks eligible;
  // 'hamlet' = small envelope, landmarks mostly suppressed; the pipeline shape
  // is identical — only the numbers differ.
  nucleus: 'town' | 'hamlet';
  archetypeW: [Archetype, number][];        // weights /100; [['bourgRue',100]] forces one
  envW: [number, number]; envH: [number, number]; // base + rng span (tiles)
  densFalloff: number;                      // densQ8 denominator slope (streets.ts:262, currently 12)
  // stages 3/5
  minStreets: number; maxStreets: number;
  // stage 4 (probabilities /100; 0 skips the sub-stage, stream position preserved
  // by drawing the roll regardless — same discipline as footprints.ts:463)
  churchPct: number; marketPct: number; forecourtPct: number; placeWiden: boolean;
  // stages 8/9
  maxBuildings: number; minBuildings: number; // minBuildings < n → attempt reroll (mapgen.ts:209 loop)
  // stage 11
  farms: [number, number]; bocageCell: number;
  stands: [number, number]; standRadius: [number, number];
  clearings: [number, number];              // woods only; 0 elsewhere (TAG.CLEARING)
  // water (null = none)
  water: { width: number } | null;          // TAG.WATER; band placement rules in §3.4
  relief: ReliefProfile;                    // absorbed from RELIEF_BY_KIND
}
export const PROFILES: Record<MapKind, KindProfile>;
```

Threading rule: profile fields replace module constants **at the same value for
`bourg`**, so P1 is a pure refactor provable by the frozen bourg fingerprints
(`97b5bca`/`eb9a14e6`, bourg.test.ts:384-387). Changing a value for another kind
changes only that kind — per-kind determinism is the D2 property, not per-kind
byte-stability across tuning.

---

## 2. Per-kind profiles

Values are starting points for the tuning loop; the structural choices are the design.

### 2.1 `bourg` — unchanged
Current values verbatim: archetypes 35/35/20/10, env 70+41 x 55+31, streets 9-24,
church always attempted, market 60, forecourt always, widen on, buildings ≤80,
farms 2-3, bocage CELL 22, stands 2-4(+area), relief {2, banks, rail, 0}.
Tactical intent (already proven): jog-capped MG lanes ≤45 (streets.ts:89-98),
rear-garden flanking network (enclosures.ts:44-51), cour strongpoints, 12-slot
garrison coverage.

### 2.2 `road` — linear roadside village (Normandy village-rue)
- nucleus 'town', archetype forced `[['bourgRue',100]]` — one street and its spurs
  (streets.ts:342 already skips the cross route for bourgRue; :414-423 grows spurs).
- env 90+30 x 26+12: a ribbon. densFalloff ~9 (density hugs the street).
- streets 4-12. church 50, market 15, forecourt 40, widen on but short (the place
  is a bulge, not a square — widen len 16+8 via profile).
- buildings ≤55; rank-0 terracing rule (footprints.ts:249) already produces the
  continuous street frontage; DENS_TERRACE stays.
- rural: farms 2-3, bocage 22, stands as open.
- Tactical intent: the fight is the street. The jog cap keeps any single MG from
  owning the whole rue; the rear-garden band (gates every 2-3 plots,
  enclosures.ts:156-163) is the flanking route and `rearConnected` (enclosures.ts:51)
  is the load-bearing gate for this kind; venelle mouths are the infantry cut-throughs;
  vehicles are road-bound between hedged parcels. Garrison anchors string along the
  frontage so the defense is sequential house clearing.

### 2.3 `open` — scattered farmsteads, hedged parcels, tiny nucleus
- nucleus 'hamlet': env 34+12 x 26+8, archetypes carrefour 70 / bourgRue 30.
  densFalloff ~20 (dense only right at the junction). streets 3-8.
- church 10 (wayside chapel), market 0, forecourt 0, widen OFF — the junction stays
  a plain crossroads, which keeps objectives[0] a bare road tile for the MG42
  (scenario.ts:55-56, landmarks anchor logic :56-71 still runs).
- buildings ≤24, minBuildings 4 (preserves the legacy floor, mapgen.ts:319, and
  scenario.ts's `[b0,,b2]`).
- rural is the map: farms 4-6, bocage CELL 20, lanes at current density, stands 3-5
  radius 6-10. relief {2, banks, rail, 0} (RELIEF_BY_KIND.open today; sunken lanes
  are a TUNE item gated on trimming lane runs within 6 tiles of compound rects —
  the same caveat recorded at mapgen.ts:157-163).
- Tactical intent: bocage warfare. Hedge gates (rural.ts:343-353) are the chokes,
  farm cours the strongpoints and garrison anchors, hedge banks the covered
  approaches. MG lanes are field-length (~one bocage cell), never street-length.
  The optional railway halt (mapgen.ts:571-587) becomes reachable for `open` since
  its relief profile carries `rail: true` — accept it; it is a good fight.

### 2.4 `woods` — stands, clearings, a forester pocket
- nucleus 'hamlet' as open but smaller (env 28+8 x 22+6), streets 3-6, no landmarks
  (church 0/market 0/forecourt 0), widen off. buildings ≤14, minBuildings 3.
- rural: stands 8-12, radius 8-14 — the stand pass runs FIRST so woods dominate;
  then **clearings** (new sub-stage, TAG.CLEARING): 2-4 ellipses of grass/field
  carved back out of painted woods, each ≥12 tiles across, one guaranteed astride
  the arterial. farms 1-2 (the forester/charcoal pocket), bocage CELL 32 (sparse).
- relief {2, banks, no rail, 2} (RELIEF_BY_KIND.woods today).
- Tactical intent: short sightlines everywhere except the clearings, which are the
  kill zones and pick up coverage-fill objectives naturally (objectives.ts:95-125
  puts posts near uncovered buildings; clearing centres join `woodsStands` anchors
  for garrison sectors, bridge.ts:223). The arterial and the farm lanes are the only
  vehicle routes; validate's vehicle gate (mapgen.ts:875-876) is the constraint that
  keeps the clearing-astride-arterial rule honest.

### 2.5 `river` / `bridge` — the water band composed with organic ground
- New water stage (TAG.WATER), drawn AFTER the regional arterial (stage 2), BEFORE
  the envelope commits: band base column derived from place/env exactly as legacy
  derives it from crossX (mapgen.ts:262), width 3 (`bridge`) / 5 (`river`),
  random-walk ±3 per row. The envelope is then placed CLEAR of the band:
  - `bridge`: env west edge 6-12 tiles east of the band — a **bridge-head hamlet**
    (nucleus 'hamlet'+, env 44+16 x 34+10, church 25, market 10). The defended far
    bank is the town.
  - `river`: open-profile countryside both banks, nucleus east of the band. This is
    the ford-assault archetype (bridge.ts:135-139 forces `'river'` when the attacker
    halts on a river cell; doctrine: rivers are transit, INDEX.md 2026-07-23 ford
    entries).
- Carve rules: water is painted first in stampBourg's terrain phase; roads still
  paint after rural (plan.ts:55) and win over water — each such tile records
  `map.bridges[i] = 1`, byte-for-byte the legacy rule (mapgen.ts:434-437). The
  growth loop's localConstraints (streets.ts:649-666) and the farm lanes' `free()`
  (rural.ts:168-169) and bocage owner mask (rural.ts:292-293) all gain a water test,
  so ONLY the arterial crosses — the crossing is the choke by construction.
- Objectives: the crossing appended LAST, new `ObjectiveKind` arm `'bridge'`
  (mapgen.ts:95). Preserves the "last objective = crossing" contract and its free
  garrison sector.
- No new terrain key (D8): banks are hedge-bank relief + existing keys.
- Tactical intent: `bridge` = fortified far bank, crossing under MG fire from
  bridge-head houses, flanking limited to the banks; `river` = suppression-and-cross
  in open bocage, spawn penalties handled upstream (bridge.ts:186-191).

### 2.6 `town` — retired
`CHAR_TERRAIN` already maps no character to it (sector.ts:21-29; t/T → bourg since
T16). Saves store owners + chits only (front.ts:127-141) and the sector rebuilds
from ASCII at load (save.ts:33 `makeDefaultSector()`), so **no terrain string is
ever persisted — zero migration surface, no load-normalization needed** (verified).
Removals: the `MapKind` arm (mapgen.ts:112), `CELL_MINUTES.town` (sector.ts:36),
the `'town'` half of the coarse ×7 (bridge.ts:540), `TERRAIN_ORDER`/paint case
(render/strategic.ts:44, 247), RELIEF_BY_KIND.town (mapgen.ts:154), the density
test (mapgen.test.ts:211-219), the town fingerprint pin (bourg.test.ts:413), and
the perf comparison re-points at `open` (perf.test.ts:303-325).

---

## 3. Migration strategy — recommendation: big-bang, staged as one sequential chain

**Recommended: no v3 flag, no dual pipeline.** Cut over kind-by-kind in ONE
sequential chain, delete `tryGenerate`/`placeCluster`/`addBuilding` in the final
task. Argument:

1. **There is no persisted map.** Battles regenerate from `(seed, w, h, kind)` at
   bridge.ts:139; the map-version flag was already REJECTED for exactly this reason
   (INDEX.md 2026-07-26, Rejected list). Scars are seed-anchored and deliberately
   unwired (bridge.ts:449-455). Campaign saves carry owners/chits/clock only
   (front.ts:21-24) — a mid-campaign save simply fights its next battle on a v3 map,
   which is already true of any generator change.
2. **Fingerprints are per-kind inline snapshots** (bourg.test.ts:404-437,
   mapgen.test.ts:55-75), so "one re-baseline" decomposes into per-task re-freezes.
   Each kind task re-records its own pins; nothing else moves (D2 guarantees the
   other kinds' streams are untouched until their own task).
3. **A guarded flag doubles the reachable-generator surface** — two pipelines per
   kind to test, sweep, and balance — and contradicts the standing
   no-backwards-compat rule. The bourg's D1 guard existed solely to protect art
   baselines pending sign-off; the owner has signed off.
4. **Sweep cost is bounded and precedented.** Each kind task reshoots its affected
   crops (`sweep.mjs --seeds`, FORCE_KIND slots, scripts/sweep.mjs:26-30); the final
   task reshoots the full 112-shot baseline once for human review — the N8 art-key
   reroll and the 2026-07-27 fresh-sweep commit (41869c7) are the precedent that a
   net-win reshoot is acceptable.

Exact re-recording plan per kind task: (a) re-freeze that kind's geometry pins in
bourg.test.ts:404-437 (and the two default-map pins mapgen.test.ts:56-57 plus the
two furnished open pins :71-72 when `open` lands — they are the same generator);
(b) update/replace the kind's structural tests (§4); (c) reshoot the kind's sweep
seeds and eyeball the contact sheet; (d) run the full suite. Final task: full sweep
reshoot + `scripts/.balance-baseline.json` re-record, coordinated with the movement
chain (§5).

---

## 4. Validation and perf, generalized

- **The gate stays shared.** `validate()` (mapgen.ts:862-877) is already
  kind-agnostic: both spawns reach every objective and building on foot, stairs
  reachable, west→east by vehicle, via `reachField` flood fills. Unchanged.
- **Per-kind structural battery** (tests, generalizing bourg.test.ts §5.2/§5.3 into
  a table over kinds): buildings count range; objective prefix tags per kind
  (open `[place, woods, …]`, bridge/river `…, bridge` last, bourg unchanged);
  every enclosure gate infantry-permeable + vehicle-proof; orphans === 0;
  MG-lane cap on the carved bitmap (critical for `road`); rearConnected for
  `road`/`bourg`; water band present + crossing on road + `map.bridges` recorded
  for `river`/`bridge`; ≥2 clearings ≥12 tiles for `woods`; farms count for `open`;
  60x40 floor generation for all kinds.
- **Garrison/objective coverage**: the greedy fill (objectives.ts:95-125) runs for
  every kind — every building centre within GARRISON_RADIUS 45 of an objective,
  asserted per kind (bourg.test.ts:232 generalized). `objectiveKinds` becomes
  always-present on MapPlan (additive; consumers already optional-chain,
  mapgen.ts:102).
- **Perf budgets** (perf.test.ts pattern, 320x240, warmup + min-of-reps): bourg
  keeps 40 mean / 90 max (measured 18.0/31.3). New: `open`/`woods` ≤ 25/60 —
  they skip most of parcels/footprints so the CCL+BFS pair (~3 ms each) plus bocage
  dominates, estimate 10-14 ms mean; `road` ≤ 30/70; `river`/`bridge` ≤ 35/80.
  First-attempt reject rate asserted ≤ existing thresholds per kind
  (perf.test.ts:268 pattern).

---

## 5. In-flight work — design around, do not block

- **Balance retuning of defender staging (bridge.ts)**: consumes only
  `plan.buildings`/`objectives`/`woodsStands` (bridge.ts:223-241). The MapPlan
  contract is frozen by this design, so the two chains merge trivially; the coarse
  resolver multipliers (bridge.ts:539-546) are untouched except the `'town'` key
  removal in P6. V3 changes anchor DISTRIBUTIONS per kind (more cours, bridge-head
  clusters) — that is the point; the balance chain owns re-tuning against it.
- **Movement M2-M6 (spots.ts resolver)**: reads cover/edges off the finished map;
  no mapgen API coupling. V3 raises free-standing-wall and gate density on all
  kinds, which shifts cover statistics — sequence ONE final
  `.balance-baseline.json` re-record after whichever chain lands last (P7 notes it;
  do not race two re-records).
- Both touch spawns/garrisons only through the frozen MapPlan surface. Nothing in
  P1-P7 edits sim.ts, spots.ts or the staging half of bridge.ts.

---

## 6. Task breakdown (sequential sim lane)

**P1 — Profile extraction, bourg byte-identical (M).**
Files: new `src/sim/bourg/profile.ts`; thread `KindProfile` through streets.ts,
landmarks.ts, parcels.ts, footprints.ts, rural.ts, plan.ts, mapgen.ts
(`tryGenerateBourg` → `tryGenerateV3(kind, profile)`, still reached only by
`kind === 'bourg'`). Every constant listed in §1 becomes a field at its current
value. Spec: `97b5bca`/`eb9a14e6`, `cd8c2d19`/`98495a59`, `f3c5a70`/`2f746b24`
all unchanged; full suite green with zero pin edits. Deps: none.

**P2 — `road` cutover (M).**
Files: profile.ts, mapgen.ts (route `'road'` to v3), bourg.test.ts (re-freeze road
pins :431), new road battery cases, sweep reshoot of road-forced crops.
Spec: §2.2 profile; ribbon envelope; rearConnected asserted; MG-lane cap asserted on
the bitmap; objectives prefix `[place, woods, (faubourg/street on w≥240)]`.
Deps: P1.

**P3 — `open` cutover (M).**
Files: profile.ts, mapgen.ts, mapgen.test.ts (re-freeze :56-57, :71-72; port the
seeds-1-30 reachability test to the v3 open), scenario compatibility test
(≥3 buildings near objectives[0]; objectives[0] plain road; objectives[1] passable),
sweep reshoot. Spec: §2.3; farms 4-6 asserted; halt permitted. Deps: P1 (P2
independent in content but the chain is sequential by decree).

**P4 — `woods` cutover + clearing sub-stage (M).**
Files: rural.ts (clearing carve, TAG.CLEARING=16 appended in streets.ts TAG),
profile.ts, mapgen.ts, bourg.test.ts re-freeze (:407), battery cases (≥2 clearings,
one astride the arterial, vehicle route intact), sweep reshoot. Spec: §2.4.
Deps: P1.

**P5 — water composition: `river` + `bridge` (L).**
Files: streets.ts (TAG.WATER=15; water mask in localConstraints), new water carve in
the skeleton phase, plan.ts/stampBourg (water painted first; bridges recorded on
road-over-water), rural.ts (lane/bocage water exclusion), objectives.ts (`'bridge'`
tag arm, appended last), mapgen.ts (ObjectiveKind union), profile.ts, bourg.test.ts
re-freeze (:419, :425), battery (band width per kind, crossing-on-road, flanked-by-
water within 2, spawns connected across, `map.bridges` non-empty), sweep reshoot of
FORCE_KIND slots 3/8. Spec: §2.5; the legacy water tests (mapgen.test.ts:162-252)
port over as the acceptance battery. Deps: P1 (uses hamlet profile shape from P3 —
run after P3).

**P6 — retire `town`, delete the legacy pipeline, generalize gates (M).**
Files: mapgen.ts (delete tryGenerate/placeCluster/addBuilding/hedgeLine and the
`MapKind` `'town'` arm; RELIEF_BY_KIND folds into profiles), sector.ts:32-40,
bridge.ts:540, render/strategic.ts:44+247, tests (delete town pins/density test,
generalize the per-kind battery table of §4, per-kind perf budgets, re-point
perf.test.ts:303 comparison at `open`), reachField/validate stay. Spec: `grep -r
"'town'" src tests scripts` returns nothing; suite green. Deps: P2-P5.

**P7 — final re-baseline + coordination (S).**
Full sweep reshoot (all seeds, contact-sheet review), FORCE_KIND audit,
`.balance-baseline.json` re-record sequenced with the movement/balance chains,
HANDOFF + decision-log entry (this doc → INDEX.md). Deps: P6.

**Render/dressing addendum** (small, may run parallel after P2):

**R1 — sweep crop derivation per kind (S).**
Files: scripts/lib/stage.mjs `deriveTargets`, scripts/sweep.mjs ORDER tables.
Kinds now all emit `objectiveKinds`: derive crops from tags (road gets the bourg
`terrace`/`street` crops; bridge gets a `bridgehead` crop on the last objective;
woods gets a `clearing` crop). Deps: P2.

**R2 — strip-village frontage dressing audit (S, only if review flags).**
Terrace roofs, shop awnings and enclosure materials are already keyed on
`Building.role`/`terraceRun`/wall-top codes (mapgen.ts:114-139), so **no new art is
expected**; this task exists to eyeball the road-kind contact sheet and fix material
seams (render/enclos.ts, render/roofs.ts) if any. Deps: R1 + P2 sweep.

Explicit TUNE backlog (not tasks): sunken lanes for open/woods once lane runs are
trimmed clear of compound approaches (mapgen.ts:157-163); halt frequency per kind;
densFalloff values; woods bocage cell.
