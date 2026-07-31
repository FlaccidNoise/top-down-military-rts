# Micro-plausibility catalog — zoomed-in defects (owner review 2026-07-28)

Owner: "Zoomed out, towns and buildings look great. Zoomed in, streets, paths,
yards, fences, roadside decorations don't make physical sense — positioning,
placement." Constraint: do NOT regress the macro layout (town/building
generation signed off).

Evidence: .screenshots/audit-{place,street,terrace,cour,bocage}-s1.png (seed 1
bourg, 24 px/m, canonical hour). All V4-P1..P5 landed.

## Defect classes (each cites the audit shots)

**M1 · Wall fragments that enclose nothing / connect to nothing.**
Dashed low-wall stubs floating mid-garden (street: top-centre band; terrace:
rows of dashes below the terrace with random gaps and stray singletons);
wall corners floating free (place: top-left yard corner); an empty walled
yard with no building (street: bottom-left L); wall line sticking out past a
roofline (street: semi-detached pair, shared boundary extends 1 tile past
the front). Rule: every wall segment must belong to a closed perimeter OR
terminate at a building corner/another wall/a gate. No singletons, no
spurs past corners, no yard without its building.

**M2 · Props scattered without context.**
Barrels/crates/carts mid-garden and mid-field at random angles (terrace:
garden band; street: crate row in the field, bottom-left; place: lined-up
crates inside a yard). Rule: props hug context — against building walls, in
yard corners, at gates, on roadside verges facing the road. Never mid-field,
never free-floating mid-lawn, rows aligned to their host wall.

**M3 · Buildings with no path to the road network.**
Isolated houses sitting in pasture, zero track (street: pink house
bottom-centre; terrace: red-roof bottom). Rule: every building reaches a
road/lane via at least a dirt path; farm lanes already exist — extend the
rule to every footprint (fringe houses, étables).

**M4 · Hedge stubs.**
Isolated single-tile/short hedge blobs floating in fields with rounded caps,
not connected to any boundary (bocage: several). Likely single-wide rule
leftovers (site-jitter boundary ends / gate remnants). Rule: hedge runs
shorter than K tiles that connect to nothing are deleted (or extended to
close their cell).

**M5 · Market stalls / awnings off the place.**
Striped stall on GRASS south of the place cobbles (place: bottom-centre);
awning on a grass verge (street: mid-map). Rule: stalls sit ON place/street
frontage tiles; awnings attach to shop frontages on the street side.

**M6 · Woods stands overlapping plowed fields.**
Trees on field tiles (street: top-right stand on the field edge; bocage:
stand on the plowed corner). Rule: stands avoid crop parcels, or the parcel
under a stand reverts to grass — one owner per tile.

**M7 · Paved path fragments leading nowhere.**
Checkerboard pad fragments (place: single tile at place edge; cour: fragment
behind the barn not reaching any road). Rule: every paved/dirt path tile is
8-connected to the road network or deleted.

**M8 · Compound walls not meeting building corners.**
Farm cour wall L floating free of the barn corner, gate opening onto no lane
(cour: bottom-right wall; gate east with no path). Rule: compound walls
attach to building corners where they meet a mass; gates face the lane.

## Fix waves (sequential sim lane; determinism law per mapgen-v4 §4)

- **W1 · rural coherence (M3, M4, M6, M7)** — rural.ts: path-to-road for every
  building, hedge-stub cleanup, stand/field exclusion, path connectivity.
- **W2 · enclosure coherence (M1, M8)** — enclosures.ts: closed-perimeter
  rule, no singletons/spurs, compound walls meet corners, gates face lanes.
- **W3 · dressing coherence (M2, M5)** — prop/stall placement context. Check
  first whether placement is sim-side or render-side (render/props.ts,
  render/shops.ts, render/yards.ts); render-side = zero pin risk.
