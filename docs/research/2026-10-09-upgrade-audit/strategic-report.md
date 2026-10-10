# Strategic (theater) layer audit — 2026-10-09

Tree: `main` at 8a90968, clean before and after. Read-only: no source edits, no commits, no bugs filed.
Screenshots: `scratchpad/audit/strategic/` (46 PNGs). Prefix `d-` = desktop 1280x800, `m-` = phone 390x844 @3x, `ml-` = phone landscape 844x390.
Seed 19440606, preset Normandy Bocage (24 km, 14 days, 3 US companies, enemy strength 2, supply on, intel omniscient, night tempo on).
Dev server: own Vite on 5302, verified by cwd of the listening pid and by grepping `objHelp` / `OBJ_TICKS` from the served sources. Killed at the end.

Evidence classes used below:
- **SHOT** = seen in a screenshot. **MEASURED** = a probe ran and printed the number. **READ** = code reading only, not run.
- Shots `d-11*`, `d-12*`, `d-13*`, `m-11*`, `m-12*`, `m-13*` are STAGED (camera, clock, or force fields written through `__game`). All others come from real input.
- Probes (kept in `scratchpad/audit/`): `capture-strategic.mjs`, `click-probe.mjs`, `fog-probe.mjs`, `liveness-probe.mjs`, `queue-probe.mjs`, `turn-probe.mjs`. Outputs: `liveness-omniscient.txt`, `liveness-contacts.txt`, `queue-probe.txt`.

---

## 0. Defects found on the way (fix before any upgrade work)

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| CRITICAL | src/strategic/theater/step.ts:136-155, src/strategic/theater/contact.ts:100, src/strategic/theater/war.ts:98 | **Bridge defile queue deadlocks forces for the rest of the war.** MEASURED over the 16 war-pin seeds: seeds 12, 13, 16 hold forces queued for 15,078-18,000 consecutive minutes (10-12 days). Seed 13: all three blue companies stuck at Pont-Dampierre from day 4. Samples show a stale queue head (a force standing at another node, still listed as `queue[0]`) and a force with `queuedAt` set and an empty path. A queued force rejects every order (`'queued-at-defile'`, step.ts:247), so a player company in this state cannot be moved again. `defileQueues` is saved (save2.ts:82), so reload does not clear it. READ: `haltAtContact` removes a force from the queue only when `queuedAt !== null`, which skips the force currently crossing. `joinBattle`, `retreatForce`, `f2Park` and the winner reposition (war.ts:280) clear `path` or move the force and never touch the queue or `queuedAt`. A dead force is never removed. | One `leaveDefile(front, f)` helper that clears `queuedAt` and removes the id from every queue. Call it from every site that clears `path` or sets `pos`, and when strength reaches 0. Add an invariant test: no force has `queuedAt !== null` with an empty path, and every queue id is a live force at that node. **Moves the war pin** (seeds 12, 13, 16 at least). Refreeze with `warsweep2.mjs --gate`. |
| HIGH | src/ui/theater-hud.ts:34-41, :113-125 | **Mouse clicks on Pause, speed and the menu button do not land while the clock runs.** The HUD replaces `innerHTML` whenever the game minute changes, so the button under the cursor is a new element between mousedown and mouseup and no `click` fires on it. MEASURED (`click-probe.mjs`, 12 presses each): at 60x 0/36 land at any press length. At 10x 12/12 at 20 ms, 3/12 at 90 ms, 0/12 at 150 ms. At 1x 9/12 at 150 ms. Phone touch lands 108/108. Space still works. The tutorial tells the player "March at 60x. Pause any time" (tutorial.ts:108). Not tested in Safari or Firefox. | Handle `pointerdown` on the root, or build the control row once and patch only the clock and objective text nodes. |
| HIGH | src/strategic/theater/step.ts:257-261, src/strategic/theater/force.ts:188-192 | **A march cannot be stopped or reversed.** There is no halt verb, and a mid-road order routes from the node AHEAD. MEASURED (`turn-probe.mjs`): Able walks 10 minutes (666 m of a 5,352 m road), is ordered back to its start, and gets ETA 155 minutes with path `[16,16]` — it finishes the road, then returns. If the far node is garrisoned, the only way out is the contact modal's Stand down. | Let a mid-edge force flip `dir` when the first route edge is its own edge. Add a Halt button on the force card. Planner calls `orderMove` too (withdraw arm, planner.ts:231), so this **moves the war pin**. |
| HIGH | src/ui/ui.css:1449-1459 (no override in the 720 px block at :1487-1517) | **Phone, fog of war on: the NO CONTACT banner covers the lower half of every clock button.** MEASURED (`fog-probe.mjs`): banner rect x -27..417 on a 390 px viewport (clipped both sides), y 52..80. Each of Resume, 1x, 10x, 60x, menu is 50% tappable. SHOT m-14-fog-start.png. The capture script's own tap on 60x was intercepted by the banner. | Put the banner in the flex column under the top bar on narrow screens, allow wrap, `pointer-events: none`. |
| MEDIUM | src/ui/tutorial.ts:97-98 | **Coach copy promises a preview that does not exist.** "The path and the ETA preview before you commit." SHOT: d-05a-hover-before-order.png is byte-identical (`cmp`) to d-04-force-selected.png. The path draws only after the order (theater-view.ts:375-404). Design doc 8.8 specified the hover and hold preview. It was not built. | Build the preview (upgrade C3) or change the copy. |
| MEDIUM | src/main.ts:1060, src/ui/customize.ts:41, src/campaign/spec.ts:49 | **"Enemy doctrine" knob is dead.** `redDoctrine` is read by nothing outside the customize screen and the presets. Red always gets `RED_V2`. SHOT d-02b-customize-advanced.png shows the control. | Map `offensive` to a second `DoctrineV2`, or delete the knob. |
| MEDIUM | src/strategic/bridge2.ts:38-71, :122-135 | **Massing two companies does nothing in a battle the player fights.** READ: `makeTheaterBattle` stages `attackerId` and `defenderId` only. `battle.joined` is not read. `applyTheaterOutcome` updates only those two forces. Reinforcement joins (war.ts:372-380) count only in coarse battles, where MEASURED 39-47% of battles have a join. | See depth upgrade D3. |
| MEDIUM | src/main.ts:1623-1626, :1653 | **Desktop has no theater camera.** MEASURED: wheel, left-drag, middle-drag, WASD, arrows and + leave `zoomMul/panX/panY` at `[1,0,0]`. The wheel handler returns unless `mode === 'battle'`. Pinch and one-finger pan exist on touch only (main.ts:1591-1614). Design doc 8.2 specified wheel zoom, drag pan and `frameForces`. None exist (grep: zero hits for `frameForces`). | Upgrade C5. |
| LOW | src/render/theater-view.ts:75-78, :409-417, src/main.ts:1420 | Order flash lives 6 s of wall time. At 60x that is 6 game hours. SHOT d-08-after-stand-down.png still says "Able moving — ETA 2h0m" after Able fell back. The flash prints `2h0m`, the card prints `2h00m`. | Clear the flash on the next theater event. Share one ETA formatter. |
| LOW | src/ui/theater-hud.ts:66-68, :118 | Paused state and selected speed use the same gold highlight. SHOT d-03b: "Resume" and "10x" both lit. | Give the paused state its own treatment (dim the speed row, banner "PAUSED"). |
| LOW | src/ui/theater-hud.ts:124 | Banner says "push a screen toward the enemy". No screen verb exists (#141). | Reword until the stance ships. |
| LOW | src/strategic/theatergen/disposition.ts:131-135 | `establishment` is computed and returned and never read. The designed strength bar against establishment (doc 8.7) does not exist. | Use it in C1 or delete it. |

---

## 1. Clarity findings

### 1.1 The five-second test (SHOT d-03b-theater-start-coach.png, m-03b-theater-start-coach.png)

| Question | Desktop | Phone portrait | Why (file:line) |
|---|---|---|---|
| Where are my forces? | Weak. Three 16x10 px blue rectangles with a 9 px number. Smaller than a village node with its tint ring. No name on the map. | Weak. Same 16x10 CSS px marks. | theater-view.ts:351-364 |
| Where is the enemy? | Partial. Nine 14x10 px red rectangles. On objectives the rectangle sits inside the gold ring, on the red tint disc, over the node glyph. The strength number is under the ring. | Same, and "43" and "79" touch. | theater-view.ts:249-274, :351-364 |
| What are the objectives? | Good. Gold ring, ticks, star, larger label. This is the one thing that reads at once. | Good. | theater-view.ts:262-282 |
| Where is the front line? | Not shown. Ownership is a 5 px tint ring around each node. No territory shading, no line. The player must infer the front from ~24 dots. | Not shown. | theater-view.ts:249-254. Doc 8.6 front line not built (grep `FRONT_LINE` hits V1 only). |
| What is my supply state? | Not shown unless a company is selected, then one word, "supplied". No depot, no supply route. | Same. | theater-hud.ts:69-75. `Theater.sources` is never drawn. |
| What do I do next? | With the tutorial on: yes, the coach bubble. With it off: one grey line in the log corner. | Same. | theater-hud.ts:14-16 |

### 1.2 What competes for attention
- **Terrain wins.** The largest, highest-contrast shapes are the dark forest masses on the west edge and the tan settlement regions. Neither is something to act on. Forces are the smallest marks on the map. SHOT d-10-clean-fit.png.
- **No legend anywhere.** Five terrain fills, two textures, three road weights, a dotted rail line, three node glyphs, two ring colours, two tint colours. The V1 grid has a legend (SHOT d-20-v1-legacy-grid-camp42.png, strategic.ts:527). V2 dropped it. The blue-stippled marsh reads as a lake. The dotted rail line reads as a border or a march route, and rail carries nothing (theater.ts:82-86).
- **Tan "settlement" regions are not where the towns are.** The town glyph is a node. The tan polygon is a region class. Two encodings for one idea.
- **Ragged map edge.** Region polygons stop short of the bounds and leave black notches. SHOT d-10. Black wedges between regions show at zoom (SHOT d-11-zoom-4x.png).
- **All red forces look the same.** Garrisons (never move: MEASURED 0 move-minutes in 16 wars), mobile Kampfgruppen and the reserve share one rectangle. The briefing says "the enemy is not waiting". The map does not show which two of the nine marks that means. theater-view.ts:351-356, role lives at force.ts:20.
- **Marks stack.** At contact the blue rectangle, red rectangle, node diamond, tint disc, gold ring and both numbers share ~30 px. SHOT d-07b-map-at-contact.png.

### 1.3 Phone (SHOT m-03b, m-06b, m-13, ml-04)
- **The map uses about a third of the screen.** A 4:3 theater fitted to 390 px wide is 374x280 px of 844. Fit scale MEASURED 15.6 px/km against 40 on desktop. More than half the screen is empty background. No boot framing on own forces (doc 8.2 `frameForces` was written to prevent this).
- **Labels collide.** "St-Martin / 138 / St-Pierre" overprint to "1St-Pierre". "Quettreville-le-Sec" clips at the right edge. "Percy-sur-Aure" runs under the Pont-Dangy ring. Force numbers and supply tags are not in the declutter pass (theater-view.ts:284-304 covers node labels only).
- **Supply tags are 8 px text** (theater-view.ts:369). STAGED m-13: "OUT" overprints "St-Pierre".
- **Clock buttons are 44x32 CSS px** (ui.css:1444). Below the 44 px touch floor the tutorial entry itself cites.
- **Landscape:** the force card covers the selected company and its town, and the log covers the Jurques-Bocage objective. SHOT ml-04-theater-landscape-selected.png.
- **A battle rotate banner greets the player before the main menu** ("The battlefield is 320 m wide"). SHOT m-00-rotate-banner.png. It is about the tactical map and appears before the player has seen any map.
- **Zoom adds nothing.** STAGED m-11-zoom-5x.png, d-11-zoom-4x.png: markers and labels stay the same size and no new detail appears. There are no level-of-detail tiers (doc 8.4). Zoomed regions are flat fills.

### 1.4 Against a readable operational wargame map

| Convention | Here | Evidence |
|---|---|---|
| Unit counters: large, named, with a strength step and unit type | 16x10 px rectangle and a number | theater-view.ts:351-364 |
| Front-line shading or a drawn front | None | theater-view.ts:249-254 |
| Movement arrows | A 1.5 px, 50% alpha dashed line on the selected force only, after commit, no arrowhead. Nearly invisible on a cream highway (SHOT d-05b-order-issued.png). Other companies show nothing. | theater-view.ts:375-404 |
| Clear terrain classes with a key | Five classes, no key, and terrain effects are never stated | theater-view.ts:21-30 |
| Stacking shown | Marks overprint | SHOT d-07b |
| Zones of control or threat range | None. Contact fires at 300 m with no warning ring. | force.ts:70 |
| Turn or phase summary | An 8-line text log in a corner | theater-hud.ts:100-108 |

The legacy V1 grid, still served by `?camp=N`, has several of these and V2 lost them: owner-coloured territory (the whole map is split blue-green and brown), lettered counters, a legend, a reinforcement countdown ("Reinforcements 18h · up to 12/co every 2d"), an objective progress bar, a key hint bar and a company roster drawer. SHOT d-20-v1-legacy-grid-camp42.png. `minutesToReinforcement` has no V2 reader (grep).

### 1.5 Animation and feedback inventory

| Event | Feedback today | Evidence |
|---|---|---|
| March | The rectangle slides. No interpolation between minutes, no trail, no arrow. | theater-view.ts:345-349 |
| Order accepted | Canvas text for 6 s, hidden under the coach bubble on the first order (SHOT d-05b) | main.ts:1420 |
| Contact | A full-screen opaque modal replaces the map. The player cannot see where the fight is. No terrain, no battle type, no supply or fatigue of either side, no time cost. | main.ts:822-834. SHOT d-07-contact-modal.png |
| Battle in progress (coarse) | A 2 px orange ring, radius 5-11 px. On an objective it is inside the 10-14 px gold ring and over the tint disc. STAGED d-13: not visible. It pulses on `clockMin % 8`, so it is frozen when paused and flickers at 7.5 Hz at 60x. A 4x3 px tick marks an engaged force. | theater-view.ts:306-322, :357-360 |
| Capture | The 5 px tint ring changes colour and a log line appears. No flash, no sound cue on the map. | step.ts:85-96, theater-view.ts:249-254 |
| Retreat or stand down | The rectangle teleports 1.5 km. Log line. SHOT d-08. | war.ts:175-183 |
| Supply cut | Red dashes on a road, only when an enemy stands on that road. A cut caused by an enemy-held node draws nothing. Own tier is an 8 px tag. STAGED d-13. | theater-view.ts:219-236, :365-372 |
| Replacements | 6 s canvas text. Not in the event log. | main.ts:788 |
| Day and night | Nothing. MEASURED: the 02:00 and 14:00 frames differ only inside the clock digits (pixel diff bbox 587,25-601,36). `theater-view.ts` does not import the solar model. | STAGED d-12, d-12b |
| War won or lost | Modal with battles, days, men killed | main.ts:1101-1111 |

There is no art gate for the theater. `scripts/stratsweep.mjs` (doc 8.12) does not exist, and the decision log says so.

---

## 2. Decision inventory

### 2.1 Player

| Decision | Code path | UI path | Verdict |
|---|---|---|---|
| March a company to a node | `orderMove` step.ts:243 | Right-click / press-hold: main.ts:1411, :1490, :1603 | **Real.** Which objective and when. Route is always the fastest. No waypoints, no route choice. The costs (fatigue, night pace, forest pace, supply reach) are invisible, so the choice is made blind. |
| Halt | none | none | **Absent.** |
| Reverse or cancel a march | step.ts:257-261 | same as march | **Broken.** MEASURED: 10 minutes out costs 155 minutes back. |
| Leave a company to hold a captured objective | implicit: control persists after you leave (step.ts:85-96), red retakes by walking in | none | **Real, and the best decision in the layer.** Three companies, 3-6 objectives, default victory needs all of them. MEASURED: red retakes on most seeds, mostly by `advance` into empty nodes (530 advance orders against 34 attack orders in 16 wars). Nothing on the map shows which red forces can do this. |
| Stance (march, rest, screen, dig in) | none | none | **Absent** (#141). |
| Split or merge | none. Friendlies stack freely (doc 3.5). | none | **Absent.** |
| Concentrate two companies on one fight | war.ts:372-380 `joinBattle` | automatic within 300 m | **Dead for fought battles** (bridge2.ts:38-71 stages one company). Live for auto-resolved ones only. |
| Reinforce or allocate replacements | main.ts:786-789, campaign.ts:205 | none | **No choice.** +12 per company every 2 days, largest deficit first. No countdown in the V2 HUD. #133 never built. |
| Supply | supply.ts:39-88 | none | **No verb.** The only lever is where a company stands. |
| Recon | intel.ts:125 | none | **No verb.** Fog is off in all four presets (presets.ts:37, :61, :85, :109). |
| Contact: Attack | main.ts:835 | modal | **Near no-brainer.** The player ordered the march. The modal gives a raw headcount ratio and nothing else. |
| Contact: Defend | main.ts:830 | modal | **Forced.** One button. |
| Contact: Stand down | main.ts:856, war.ts:149 | modal, attacker only | **Real but mis-sold.** It is free (no loss, no fatigue lump) and it is the only way to cancel an approach. |
| Contact: Auto-resolve | main.ts:841, war.ts:53-58 | modal, only at 5:1 raw | **Never offered on a first battle, a no-brainer after.** MEASURED: first battle of 16 wars tops out at 3.45:1. Battles 2-3 reach 5:1 on 4 of 16 seeds, always against a garrison already cut to 17-26 men. Over whole wars 37.6% of coarse battles are forced (42.6% under fog). When offered to the stronger side it costs 15 minutes and 2-6% losses, so there is nothing to weigh. This refines #137: the threshold is not dead, it is late. |
| Deployment before a fought battle | main.ts:729 `deployPlace` | battle screen | **Real.** Tactical, outside this audit. |
| Clock speed and pause | main.ts:1660-1677, theater-hud.ts:34-41 | keys, HUD | Not a strategic decision. Mouse path fails at speed (section 0). |
| Campaign setup knobs | customize.ts:21-47 | customize screen | Real, except `redDoctrine` (dead). No knob says what it changes in play. |

Count: one real verb (march), one real implicit choice (where to leave a company), one broken verb (cancel), and a modal whose answers are mostly forced.

### 2.2 Red planner

| Behaviour | Code | Fires in natural wars? (MEASURED, 16 seeds, omniscient) | Verdict |
|---|---|---|---|
| Hold while it owns every objective | planner.ts:203-206 | `goals-met-holding` on 3,307 of 4,057 red stall evaluations | Red is idle until blue takes something. Reactive by construction. |
| Pick 1-2 axes on lost objectives | planner.ts:120-149 | yes | Real. |
| Advance onto an undefended lost objective | planner.ts:304-305 | 530 orders | **The main threat.** |
| Attack a defended node | planner.ts:267-303 | 34 orders in 16 wars, about 2 per war | Rare. `no-viable-attack` on 750 evaluations. Matches #443's `redAtk=0` seeds. |
| Withdraw at 3:1 local odds | planner.ts:220-238 | 157 orders | Live. |
| Reserve echelon, commit to a losing node battle | planner.ts:151-162, :240-260 | 55 orders | Live, thin. |
| Dawn doctrine | planner.ts:294-301 | not isolated. 21.5% of battles start at night, mostly blue's. | Could not confirm separately. |
| Never attack into 5:1 | planner.ts:280 | not isolated | — |
| Garrisons | planner.ts:128, :218 | 0 move-minutes | **7-10 of red's 9-12 forces never act.** Only two red forces play. |
| Cut the player's supply on purpose | none | — | **Absent.** The doc 5a "CUT plan class" was not built. Red cuts supply only by accident of where it stands. |
| Screen crossings, break contact for axis value | none | — | **Absent** (doc 4.1 arms not in code). |
| Doctrine variety | main.ts:1060 | — | **Dead knob.** |

Other liveness numbers from the same runs:
- Outcomes: blue won 4 of 16, same as the pin. Under fog blue won 8 of 16.
- **Battle classes: bridge-assault 365 of 550 (66%)**, roadside 80, settlement 40, marsh 21, forest 18, ford-assault 17, farmland 9. Garrisons sit on crossings and objectives are mostly "Pont-" nodes, so two of three fights are the same kind on the same map kind.
- Supply is live: blue force-minutes 1.8% LOW and 8.5% OUT, 15 of 48 blue forces OUT at some point. Red 12.6% OUT (24.9% under fog). 22.5% of battles open with a LOW or OUT principal.
- Fatigue is live: blue is at 0.33 or more for 21.5% of force-minutes and opens battles at mean 0.45. Under fog mean 0.65.
- These are AI-blue, all-coarse wars. They show what the step code does, not what a human does.

---

## 3. Simulated but invisible to the player

| System | What runs | What the player sees | Code |
|---|---|---|---|
| Supply sources and trace | Hourly BFS from depots. Enemy node blocks, enemy on a road interdicts. | Depots never drawn. Trace never drawn. A cut through an enemy-held node has no mark. | supply.ts:39-66, theater-view.ts:219-236 |
| Supply effect | Ammo 100/50/25%, combat x1/0.75/0.5 | "SUPPLY LOW · cut 5h" on the selected card. No statement of the effect. | supply.ts:29-32, theater-hud.ts:69-75 |
| **Enemy supply** | Red is OUT for 12.6-24.9% of its force-minutes | Nothing. The strongest lever the simulation offers (isolate a garrison, then fight it at quarter ammo) cannot be seen or planned. | combat.ts:13-17 |
| Fatigue | March +1 per 18 h (x1.5 in the dark), rest -1 per 10 h, x2 when billeted in a friendly supplied town. Effects: pace -35%, combat -30%, battle stamina cap -50%. Battle lumps +0.15 / +0.25. | An unlabelled bar on the selected card. No number, no effect, no map mark, no hint that a town heals twice as fast. | step.ts:28-76, war.ts:41-42 |
| Night tempo | Pace falls to 70% in full dark. Red waits for dawn to assault. | The map does not change at night. The ETA is longer and nothing says why. | step.ts:42-51, planner.ts:294-301 |
| Terrain | Forest halves pace. Settlement x7, hamlet x3, forest x1.5 for the defender in coarse fights. Crossing assault x2 against the attacker. | Nothing. The contact modal does not name the battle type or the map the player is about to fight on. | theater.ts:94-141 |
| Road class | Highway 66.7, road 50, track 33.3 m/min | Line width only | theater.ts:82-86 |
| Bridge defile and ford | Bridge: one force at a time, 15 min. Ford: 45 min. | A reject string, only if you issue an order while queued | step.ts:98-155, main.ts:685 |
| Reinforcement cycle | +12 per company every 2 days | 6 s of canvas text on arrival. No countdown. | main.ts:786-789 |
| Reinforcement joins | Any free force within 300 m joins a coarse battle | Nothing | war.ts:372-380 |
| Battle time cost | A fought battle advances the theater up to 240 min. Red marches meanwhile. | Nothing before the fight. The log shows the results after. | main.ts:921-929, war.ts:38-45 |
| Retreat rules | 1.5 km setback, infiltration within 120 graph-minutes, overrun when trapped | A log line after the fact | war.ts:149-218 |
| Fog model | Detection 3 km from forces, 1.5 km from owned nodes, ghosts fade over 6 h | Ghost opacity only. No detection range shown. | intel.ts:49-52, theater-view.ts:327-342 |
| Red roles and plan | Garrison, line, reserve. Axes replanned every 6 h. | All red marks identical | planner.ts:120-191 |
| Named roster | Every man persists | No roster door on the V2 theater HUD (V1 has one: strat-hud.ts:117-119) | theater-hud.ts |

---

## 4. Upgrades

"Pin" = effect on `tests/war-pin.test.ts`, which freezes 16 `{status, day, logLen}` tuples from `src/strategic/headless.ts`. Anything that changes `stepWar`, `orderMove`, the planner, coarse resolution or disposition moves it and needs a refreeze through `warsweep2.mjs --gate`. Render and HUD work does not. New `Force` fields need one default in `save2.ts:137` and no key bump.

### 4.1 Top 10 clarity and visual upgrades (highest impact per unit of work first)

| # | Upgrade — what the player sees | Files | Size | Save / pin | Mobile |
|---|---|---|---|---|---|
| C1 | **Real unit counters.** 30-34 px counters with the company letter or name, a strength bar against establishment, and a role mark for red (fortified box for a garrison, arrow for mobile, "R" for reserve). Selected = bright halo. Supply and fatigue pips on the counter. Stacks fan out. Counters join the label declutter pass. | theater-view.ts:344-373, disposition.ts:131 (carry establishment onto Force) | M | Force gains `establishment`: one save default. Pin safe. | 44 px pitch. Hit radius already 28 px (theater-view.ts:128). |
| C2 | **Clock controls that work.** Fix the dead mouse click, separate "paused" from "speed selected", 44 px targets. | theater-hud.ts:34-41, :113-125, ui.css:1444 | S | none | Fixes the 32 px buttons. |
| C3 | **Order preview and movement arrows.** Hover (desktop) or hold (touch) draws the real route in a bright colour with an arrowhead and an ETA chip before commit. Every moving company keeps a thin arrow to its destination, not just the selected one. Makes the coach copy true. | theater-view.ts:375-404, main.ts:1411-1429, touch `holdStart/holdMove` main.ts:1601-1603 | S-M | none (dry-run `route`, as `tutorial.mjs` does) | The 420 ms hold window already exists and draws only a ring (SHOT m-05a-hold-ring.png). |
| C4 | **Territory wash and a front line.** Blue and red tint over the ground each side controls, with a cream line between. Recompute only when control changes. | theater-view.ts (new pass after regions), doc 8.6 | M | none. Render-only. Keep it out of `src/strategic`. | Same. Reads better small than node rings do. |
| C5 | **Camera.** Desktop wheel zoom and drag pan. Both platforms boot framed on the player's companies and the nearest objective. | main.ts:1623-1626, :1453-1479, theater-view.ts:81-97 | S | none | Solves the one-third-of-screen problem in portrait. |
| C6 | **Legend, objective list and "next" strip.** A collapsible key. A list of objectives with holder and last-known garrison, tap to centre. Reinforcement countdown. Port from V1. | theater-hud.ts, strat-hud.ts:211-213 as the model | S | none | Collapsed by default. Replaces the idle log line. |
| C7 | **Contact as a map callout.** The map stays visible and centred on the fight. The card states battle type and the map to expect, both sides' supply and fatigue in words, who can join, the time the fight will cost, and what Stand down does. | main.ts:803-869, theater.ts `battleSiteOf` | S-M | none | Bottom sheet. |
| C8 | **Supply made visible.** Depots drawn. A toggle shows the supplied road net. A cut is marked where it happens, with the reason. Isolated enemy forces carry an "ISOLATED" tag when known. | theater-view.ts:215-236, supply.ts:39 (expose the trace to the view) | M | none if the view calls `traceSupply` read-only | Toggle in the legend. |
| C9 | **Events you can see.** Capture: the node flashes and the wash moves. Battle: a marker outside the objective ring, driven by the render clock so it animates while paused. Retreat: a short arrow. Replacements: a log line. Log lines tap to centre. Night: a dark wash and a dawn or dusk line in the log. | theater-view.ts:306-322, main.ts:788, `fxNow` at main.ts:1795 | M | none | Same. |
| C10 | **Phone pass.** Fix the fog banner. Stack the force card clear of the map. Keep labels on-screen. Move the rotate banner to battle entry. Then add a theater sweep script so none of this regresses. | ui.css:1449-1517, theater-view.ts:284-304, new `scripts/stratsweep.mjs` | S-M | none | This is the mobile item. |

Smaller, fold in where convenient: stale flash, ETA format, ragged map edge, inter-region wedges, tan-region ambiguity, `Region.holes` (#144, P4, could not find a live case).

### 4.2 Top 10 depth upgrades (most decision-interest per unit of work first)

D0 is a precondition, not an upgrade: fix the defile deadlock and the dead knob (section 0). Without it, adding verbs adds ways to get stuck.

| # | Upgrade — what the player decides | Files | Size | Save / pin | Mobile |
|---|---|---|---|---|---|
| D1 | **Halt, about-face, and a waypoint queue.** Whether to commit to an approach or pull back when a red column appears. Today the answer is fixed at the first click. | step.ts:243-265, force.ts:188, main.ts:1411, theater-hud.ts (Halt button) | S | Pin moves (planner withdraw uses `orderMove`). | Halt on the force card. Shift-click has no touch form, so queue by repeated hold. |
| D2 | **Postures: march, forced march, rest, dig in, screen.** Speed against fatigue. Time spent digging in against a stronger defence when red comes. Screen = wider detection, slow, falls back instead of fighting. Closes #141. | force.ts:11 (`stance`), step.ts:48-76, combat.ts:13, intel.ts:51, contact.ts:50 | M | One save default. Pin safe while the AI stays on `march`. Moves when the planner uses it. | Four buttons on the force card. |
| D3 | **Make concentration pay in fought battles.** A second company inside 300 m arrives as timed reinforcements, or lends its support weapons. The modal shows who is in range. Whether to wait an hour for Baker or go now. | bridge2.ts:38-110, war.ts:372-380, bridge.ts staging | M-L | No pin effect (fought path only). Tactical balance records are affected. | Modal line only. |
| D4 | **Isolation as a weapon.** Auto-resolve and the planner's trivial test read effective strength times the terrain multiplier, not raw headcount. An isolated, starved garrison becomes a walkover. A fresh one in a town does not. Whether to assault now or cut the road and wait two days against the deadline. Resolves #137 with a design reason. | war.ts:53-58, :108-113, planner.ts:280, main.ts:808-819 | S | Pin moves (`forced` changes). | none |
| D5 | **Requisition at the 2-day cycle** (#133, HANDOFF chunk C). Each cycle, choose one: replacements to a named company, an armour section, an extra barrage, engineers. | campaign.ts:205, main.ts:786-789, headless.ts:124, new card UI | M | Campaign gains fields. Pin safe if the AI default equals today's even fill. | Bottom-sheet cards. |
| D6 | **Turn fog on, with a recon verb.** Default presets to `contacts` once C1 and C10 land. Screen posture (D2) or a recon detachment gives sight. Whether to spend a company's speed on knowing what is in the next town. MEASURED: fog changes the war (blue wins 8 of 16 against 4). | presets.ts:37-109, intel.ts:51-52 | S after D2 | Pin unaffected (it runs omniscient). Needs its own fog sweep. | Fix the banner first. |
| D7 | **A red that plays.** Wire the doctrine knob. Let a garrison sortie against a weaker force next door. Add the supply-cut plan from the design. Show red's last-known axis as an intel line. The player must then guard a rear road, not only objectives. | planner.ts:120-313, main.ts:1060, spec.ts:49 | M | `defensive` = today's values keeps the pin. New arms move it. | none |
| D8 | **Tempo scoring.** Use the existing `byDay` field (goals.ts:18, unused) for an early-capture bonus or a tiered result (decisive, marginal, pyrrhic by losses and day). Whether to rest a tired company or spend it. | goals.ts:29-72, main.ts:1101-1111 | S | Pin moves only if the win test changes. A tiered label does not. | none |
| D9 | **Refit.** Replacements reach only a company that is supplied and out of contact, and arrive faster in a billet. Whether to pull a company off the line. The design kept replacement throttling out to avoid a death spiral, so cap it and run the sweep. | main.ts:786-789, headless.ts:124, step.ts:54-62 | S-M | Pin moves. | none |
| D10 | **Crossings as terrain you can change.** Blow or repair a bridge, or bring engineers (D5). MEASURED: 66% of fights are bridge assaults, so this is where variety is most missing. Smaller first step: more than one crossing class per river and garrisons placed on towns as well as bridges. | theater.ts, theatergen/roads.ts, disposition.ts:83-85, save (edge state) | L (S for the disposition step) | Save gains edge state. Pin moves. GEN_VERSION bump if generation changes. | none |

What a believable operational layer has that this lacks, in the same order of value: stop and turn (D1), posture (D2), combined attacks (D3), isolation (D4), task organisation (D5), reconnaissance (D6), an active enemy (D7), tempo pressure with degrees of victory (D8), rest and refit (D9), engineering (D10). Lower value for the size and left out of the ten: weather, command radius, air interdiction of roads, rail movement (rail is drawn and carries nothing), theater-level allocation of barrages and air strikes.

Recommended first slice: D0, then C2, C1, C3, C5, D1. These are small, they remove the three things that are broken today, and D1 turns the one real verb into a decision that can be revised.

---

## 5. Not confirmed, and where I looked

- **Which code arm leaves the stale defile entry.** The deadlock itself is measured. The four candidate arms are from reading (contact.ts:100, war.ts:98, :179-181, :280, plus death). I did not isolate each with a failing test, because this audit is read-only.
- **Whether a human campaign reaches the deadlock.** The probe runs AI blue with every battle coarse. The player path shares `stepWar` and `advanceForce`, and joins run during the post-battle catch-up, so I expect it. Not reproduced in the browser.
- **The mouse-click failure on a real mouse and in Safari or Firefox.** Measured with synthetic mousedown/up 20-150 ms apart in headless Chrome only.
- **Massing in fought battles.** From reading bridge2.ts. I did not fight a battle with a second company adjacent.
- **Dawn doctrine and the trivial veto firing.** `PlannerReport` does not expose them. Not isolated.
- **#443 (assault liveness).** Still unmeasured for fought battles. The coarse numbers above (34 red attack orders in 16 wars, AI blue stalled on `no-viable-attack` for 3,286 evaluations) are not a substitute.
- **#144 `Region.holes`.** No enclave in the sampled theater. Not searched across seeds.
- **Night, zoom and realism overlays** were staged by writing state. Supply tags, cut hatching and the battle ring were not seen arising in a browser session. Their natural frequency comes from the headless probe.
- **Fog in play beyond the first frame, and the theater menu.** The staged capture stopped at the banner overlap, which is itself finding 4 in section 0. Shots `d-14b`, `d-15` and their phone twins do not exist.
- **Other presets and theater sizes.** One seed, one preset in the browser. The 32 km theater will be smaller still on a phone. Not captured.
- **Frame cost.** The theater repaints every frame, paused or not (main.ts:1828). Doc 8.11 budgets were not measured. `scripts/theaterperf.mjs` exists and was not run.
- **Design doc items 9.6 (share codes) and 8.1 (static layer bake).** Absent by grep (`ShareCode`, `theater=`, `TheaterStaticLayer`: zero hits). Not checked against the owner's later decisions.
