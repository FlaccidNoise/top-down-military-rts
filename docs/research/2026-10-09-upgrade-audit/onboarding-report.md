# Onboarding, tutorial, text and playability audit

Tree: `main` at `8a90968`, clean. Dev server: my own Vite on `localhost:5303`, identity checked by fetching `/src/ui/tutorial.ts` (`TUTORIAL_STORAGE_KEY`) and `/src/ui/theater-hud.ts` (`objHelp`). Read-only: no source edits, no commits, no bugs filed.

Evidence directories (all under `…/scratchpad/audit/`):

- `onboarding/` — 103 ordered walkthrough screenshots, 8 probe shots and the metrics JSON. Prefix `d` = desktop 1280x800 mouse, `m` = phone 390x844 touch, `l` = phone landscape 844x390 touch, `probe-*` = targeted probes.
- `gate-desktop/`, `gate-desktop-rerun/`, `gate-mobile/` — shots and logs from `scripts/tutorial.mjs`.
- `fight-tests/` — the idle and naive first-battle runs.
- `walk.mjs`, `probe-viewport.mjs`, `probe-taps.mjs` — the drivers. They live outside the repo.

Every profile was fresh (new browser context, empty localStorage). Seeds were rolled per run, so each run is a different war.

## Verdict in six lines

1. The tutorial teaches the theater (select, march, clock) by doing. It stops teaching at the moment the battle starts. The only battle step says "the menu holds the Field Manual" and retires the instant it shows (`src/ui/tutorial.ts:133-145`, `:286`).
2. The first battle is a full-size live fight: 143 men against 70 to 102, on a 320 m map, at 1x with no speed control. The gate's own bot LOST it twice on the same seed. My bots won three, each with about half the company gone.
3. A V2 battle never states how it is won. The objective strip is wired to a V1-only variable and stays hidden (`src/main.ts:2031`, `src/ui/hud.ts:427`). The manual has no entry for it.
4. On a portrait phone with the tutorial on, the deployment screen opens with every control off screen. The tutorial bubble causes it (`src/ui/tutorial.ts:126`, `src/ui/coach.ts:65-80`).
5. On desktop, a normal mouse click on a roster order chip is dropped while the battle runs: 3 of 20 land at a 120 ms press (`src/ui/hud.ts:316`, `:527`).
6. Text on the path to the first order: 689 words and 11 inputs on desktop, 9 screens. The Field Manual behind it is 67 entries and 2,934 words.

---

## 1. First-session walkthrough

Word count = DOM words actually visible and not covered. Controls = enabled, visible, not covered. Canvas text (deploy banner, context chips, ticker) is not in the count. I name it in the friction column where it matters. "t" is seconds since landing for a script that reads nothing.

### 1a. Desktop 1280x800, mouse

| # | Step | Screenshot | Words | Controls | The player must | Obvious? | Friction found | Owner |
|---|---|---|---|---|---|---|---|---|
| 1 | Main menu | `d01-mainmenu.png` | 11 | 3 | Click New Operation | Yes | Title only says NORMANDY. No line says what the game is. | `src/ui/mainmenu.ts:128-137` |
| 2 | Field Manual (optional) | `d02-manual.png` | 263 on screen, 2,934 total | 8 | Close it | Yes | 67 entries, 58 of them over 20 words. | `src/ui/manual-data.ts:103` |
| 3 | Customize campaign | `d03-customize.png` | 61 | 34 | Click Generate & Play | Weak | 34 controls before the first minute of play. Seed, 4 presets, 6 knobs. Advanced adds 27 more (`d04`, 61 controls). The primary button sits mid-column, not at an edge. | `src/ui/customize.ts:174-193` |
| 4 | Briefing card | `d05-briefing.png` | 163 | 3 | Read, click Begin | Yes | Read-then-do. Three paragraphs of strategy before the player has seen the map. | `src/ui/tutorial.ts:295-307`, copy `src/ui/manual-data.ts:108-128` |
| 5 | Theater, "select a company" | `d06-theater-select-force.png` | 34 | 7 | Click a blue company | Weak | Bubble is Times 10 px and points at the top bar, not at a company. Companies are 18 px squares among 25 named places. | `src/ui/tutorial.ts:75-87`, `src/ui/ui.css:1060-1077` |
| 6 | Theater, "march" | `d07-theater-march.png`, `d08-theater-march-hover.png` | 48 | 7 | Right-click a gold-ringed town | Medium | Copy promises "the path and the ETA preview before you commit". `d08` hovers the town: nothing draws. The path only draws after the order. | `src/ui/tutorial.ts:97`, `src/render/theater-view.ts:375-377` |
| 7 | Theater, "speed" | `d09-theater-speed.png`, `d10-theater-after-speed-tap.png` | 47 | 7 | Click 60x AND Resume | No | Bubble says "March at 60x". Clicking 60x retires the bubble and the clock is still paused (`d10`, button still reads Resume). The bubble also covers the "Able moving — ETA" flash, the only confirmation of the order. | `src/ui/tutorial.ts:101-111`, `src/main.ts:405-406`, `src/render/theater-view.ts:409-416` |
| 8 | Contact modal | `d12-contact.png` | 35 | 4 | Click Attack | Yes | "Read the odds line first" with no rule for what odds are safe. 1.4:1 lost, 1.6:1 cost 52 dead. | `src/main.ts:803-834`, `src/ui/tutorial.ts:112-121` |
| 9 | Deployment | `d13-deploy.png` | 142 + 12 canvas | 25 | Click Resume | Medium | Nine squad cards all read "Abl…". Own men are 5 px dots on the left edge. Nothing marks the enemy or the goal. Two-line key legend (34 words) at the bottom. | `src/ui/hud.ts:487-585`, `src/ui/ui.css:163`, `src/ui/hud.ts:134-137` |
| 10 | Deployment, squad selected | `d14-deploy-squad-selected.png`, `d16-deploy-refused.png` | 129 | 32 | Right-click in the zone, or Resume | No | Selecting a squad REPLACES the deploy step with the legacy coachmark "Select a squad, then right-click to move. Shift+1-8 arms an order." Wrong for this phase. Refusal reads "Outside your deployment zone (x 0–32)" and the terrain tooltip covers it. | `src/main.ts:259-267`, `src/ui/coach.ts:58`, `src/main.ts:732` |
| 11 | Battle start | `d17-battle-start.png` | 148 | 35 | Select a squad, give an order | No | The whole battle lesson: "Your orders arm with ⇧1–⇧8. The menu holds the Field Manual". No goal, no enemy marker, no arrow. `#obj-strip` is `display:none`. | `src/ui/tutorial.ts:132-145`, `src/main.ts:2030-2048` |
| 12 | Squad selected, move preview | `d18`, `d19-battle-move-preview.png` | 139 | 34 | Right-click the ground | Medium | Battle step is gone, replaced by the legacy bubble that says "Select a squad" after the squad is selected. Tooltip: "Directional lip: 50% (within 2m of far side)". | `src/main.ts:259-267`, `src/ui/tooltip.ts:198-201` |
| 13 | First order issued | `d20-battle-first-order.png` | 139 | 34 | Watch | — | **11 inputs, t = 18.2 s** for a script. March wait at 60x was 4.6 s. | — |
| 14 | Order chips armed | `d21`…`d24-battle-armed-assault.png` | 124-129 | 30-33 | Right-click to issue | Medium | "Order armed" bubble covers the legend and the first soldier row and never leaves. | `src/main.ts:283-294` |
| 15 | Chip hover card | `d25-battle-affordance-hover.png` | 129 | 33 | Read | No | Card has no background and Times font. Its text prints through the chips and is unreadable. | `src/ui/hud.ts:146-149`, `src/ui/ui.css:69`, `:541` |
| 16 | Pause, barrage mode | `d26`, `d28-battle-barrage-mode.png` | 129-141 | 33 | Click a target | Yes | Fine. | `src/ui/hud.ts:330` |
| 17 | Soldier health panel | `d29-battle-health-panel.png` | 188 | 33 | Close | Yes | Third click on the same man opens a 188-word medical panel. Optional. | `src/ui/health-panel.ts:97` |
| 18 | Pause menu, keybindings | `d30-pause-menu.png`, `d31` | 12, 52 | 5, 16 | Resume | Yes | The coach bubble floats over both screens. | `src/ui/menu.ts:41-45` |
| 19 | Mid fight | `d32-battle-mid-fight.png` | 142 | 26 | Keep ordering | No | Ticker fills with five "WON'T ADVANCE" lines. A refusal chip is cut off under the roster. Balk hint says "rally", an order that does not exist. | `src/ui/overlays.ts:827`, `src/ui/order-data.ts:25-28` |
| 20 | Victory banner | `d33-battle-winner-banner.png` | 142 | 24 | Wait 4 s | Yes | US 76 of 143 left after 7 min 02 s of battle clock. | `src/ui/hud.ts:340-345` |
| 21 | Debrief | `d34-debrief.png` | 207 on screen | 3 | Click Return to the front | Yes | 52 names in red, then 156 table rows, 5,189 px of scroll. Bubble covers the table. It says "Read your roster before the next fight". The theater has no roster. | `src/main.ts:871-903`, `src/ui/tutorial.ts:152` |
| 22 | Back on the theater | `d35-theater-after-battle.png` | 36 | 5 | Order the next march | No | Tutorial is over. Able has 69 men. The next objective holds 97. No guidance. | — |

### 1b. Phone 390x844, touch

| # | Step | Screenshot | Words | Controls | The player must | Obvious? | Friction found | Owner |
|---|---|---|---|---|---|---|---|---|
| 1 | Rotate gate | `m01-rotate-gate.png` | 29 | 1 | Turn the phone, or tap the button | Yes | "frontage a company needs to manoeuvre across". | `src/main.ts:105-109` |
| 2 | Main menu | `m02-mainmenu.png` | 11 | 3 | Tap New Operation | Yes | — | `src/ui/mainmenu.ts:128-137` |
| 3 | Customize | `m04-customize.png` | 61 | 34 | Tap Generate & Play | Weak | All 34 controls are 30 px tall. | `src/ui/ui.css:1540` |
| 4 | Briefing | `m06-briefing.png` | 163 | 3 | Read, tap Begin | Yes | Fills the phone screen with prose. | `src/ui/tutorial.ts:295-307` |
| 5 | Theater, select | `m07-theater-select-force.png` | 34 | 7 | Tap a blue company | Weak | Map is letterboxed to about a third of the screen height. Companies are 14 px. Clock buttons 44x32. | `src/ui/ui.css:1444`, `:1485-1494` |
| 6 | Theater, march | `m08-theater-march.png` | 52 | 7 | Press and hold a gold-ringed town | Medium | Same false "preview before you commit" line. A phone has no hover at all. Town labels are cut by force markers ("Pont-Es▮y"). | `src/ui/tutorial.ts:98` |
| 7 | Theater, speed | `m09-theater-speed.png` | 49 | 7 | Tap 60x and Resume | No | Order flash is not visible at all. The bubble sits where the canvas draws it. | `src/render/theater-view.ts:416` |
| 8 | Contact | `m12-contact.png` | 35 | 4 | Tap Attack | Yes | Attack and Stand down are 38 px tall. | `src/ui/ui.css:422` |
| 9 | **Deployment** | `m13-deploy.png`, `probe-phone-deploy-tutorial-on.png` | **0** | **0** | Tap Play | **No** | **No touch bar, no strength panel, no bubble. `innerWidth` is 748x1619 on a 390x844 screen.** Banner says "Resume to begin". No Resume or Play is visible. | `src/ui/tutorial.ts:126`, `src/ui/coach.ts:65-80` |
| 10 | Deployment, squad tapped | `m14-deploy-squad-selected.png`, `m17-deploy-refused.png` | 26 | 9 | Hold in the zone, then find Play | No | Tapping a man swaps the bubble and the layout recovers. The new bubble covers the order chips it tells the player to tap. Play is off screen to the right of a scrolling row. Refusal text is overprinted by a "DEFEND" label. | `src/main.ts:259-267`, `src/ui/hud.ts:199-212` |
| 11 | Battle start | `m18-battle-start.png` | 34 | 15 | Tap a squad | No | Own men are dark specks a few px across. Bubble: "the ⚙ menu holds the Field Manual". | `src/ui/tutorial.ts:143` |
| 12 | Squad selected, first order | `m19`, `m20-battle-first-order.png` | 25 | 9 | Hold on the ground | Medium | **12 inputs, t = 19.0 s.** March wait 1.4 s. | — |
| 13 | Order armed, holding | `m21-battle-armed-move.png` | 22 + chip | 14 | Lift | Medium | Bubble covers the battle title and clock for the rest of the session. Context chip "RISK ME… / 5/12 COVERED / COMPLY" is overprinted by the MOVE label. | `src/main.ts:283-294`, `src/ui/overlays.ts:657-660` |
| 14 | Chip long-press card | `m25-battle-affordance-longpress.png` | 21 | 13 | Read | No | Card is placed at y = -94. Nothing shows. | `src/ui/hud.ts:243-254`, `:281-291` |
| 15 | Barrage, health, roster | `m27`, `m28`, `m29-battle-roster-open.png` | 33, 49, 84 | 13-22 | — | Medium | Roster says "Team: Able (esc widens)" on a phone. Soldier rows are 27 px tall. | `src/ui/hud.ts:577` |
| 16 | Pause menu, keybindings | `m30`, `m31-pause-keybindings.png` | 15, 61 | 4, 17 | Resume | Yes | A keyboard rebinding screen on a phone, with the bubble on top of it. | `src/ui/menu.ts:77` |
| 17 | Mid fight | `m32-battle-mid-fight.png` | 22 | 14 | Keep ordering | No | Screen is a web of route lines. No enemy in view. | `src/ui/overlays.ts:371-423` |
| 18 | Debrief | `m34-debrief.png` | 173 on screen | 3 | Tap Return to the front | Yes | 51 names, then 6,866 px of table. | `src/main.ts:871-903` |

### 1c. Phone landscape 844x390, battle screen

| Step | Screenshot | Words | Controls | Friction found | Owner |
|---|---|---|---|---|---|
| Theater | `l07-theater-march.png` | 52 | 7 | Bubble covers the centre of the map, a company and an objective label. | `src/ui/coach.ts:65-69` |
| Deployment | `l12-deploy.png` | 31 | 12 | Works. All ten chips fit, Play is visible, the bubble points at it. Banner still says "Resume" where the chip says "Play". | `src/main.ts:1983` |
| Squad selected | `l13`, `l16-deploy-refused.png` | 32 | 16 | Bubble covers DEFEND, AMBUSH, ASSAULT. With both chip rows up, the map is 844x285. | `src/main.ts:259-267` |
| Holding an order | `l20-battle-armed-move.png` | 27 | 19 | The docked terrain card covers 65% of the screen for the length of every hold. The player sees a 130 px strip of map while aiming. | `src/ui/ui.css:1306`, `src/ui/tooltip.ts:198` |
| Roster open | `l28-battle-roster-open.png` | 73 | 24 | Sheet covers 82% of the screen. | `src/ui/ui.css:1224-1252` |
| Mid fight | `l31-battle-mid-fight.png` | 27 | 19 | Readable. This is the best of the three layouts. | — |

### 1d. Landing to first battle order

| Platform | Inputs | Script time, no reading | DOM words on the path | Screens |
|---|---|---|---|---|
| Desktop | 11 | 18.2 s | 689 | 9 |
| Phone portrait | 12 | 19.0 s | 468 (deploy shows 0, controls are off screen) | 10 |
| Phone landscape | 11 | 19.5 s | 378 | 9 |

The 11 inputs: New Operation, Generate & Play, Begin, select company, order march, 60x, Resume, Attack, Resume, select squad, order. I did not time a human. At 200 words a minute the desktop text alone is about three and a half minutes of reading.

### 1e. Who wins the first battle

All on rolled seeds, Normandy Bocage preset, fought at 1x because the battle has no speed control.

| Run | Odds | Play style | Result | Real time | Blue left |
|---|---|---|---|---|---|
| Gate desktop leg, seed 1636534801 | 143 v 102 (1.4:1) | Gate bot: smoke, fire, assault, barrage on stall | **RED wins** | 276 s | 32 of 143 |
| Same seed, gate run alone | 143 v 102 | Same | **RED wins** | 277 s | 34 of 143 |
| My desktop walk | 143 v 95 (1.5:1) | Same cycle | Blue wins | 411 s | 71 of 143, 52 KIA |
| My phone walk | 143 v 70 (2:1) | Same cycle | Blue wins | 306 s | 77 of 143, 51 KIA |
| My landscape walk | 143 v 75 (1.9:1) | Naive: select all, plain Move at the enemy | Undecided at budget | 334 s | 41 of 143 (loses below 36) |
| Naive, desktop | 143 v 78 (1.8:1) | Naive: select all, plain Move at the enemy | Blue wins | 406 s | 71 of 143 |
| Idle, desktop | 143 v 85 (1.7:1) | One squad given a few orders, then no input | **No result.** Red does not attack. | 300 s, stopped by me | 130 of 143 |

Three things follow. A script that issues an order every four seconds loses half the company when it wins, whatever it does. The doctrine the manual teaches did not clearly beat plain Move in these runs: the two naive runs gave one win and one near-loss, and the doctrine runs gave two wins and one seed lost twice. Six runs is too few to rank them. And a player who waits gets nothing: the defender sits, the battle has no clock and no prompt, and it never ends.

---

## 2. Defect list

Severity is about the first session. Screenshots are in `onboarding/` unless a path says otherwise.

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| CRITICAL | `src/ui/tutorial.ts:126`, `src/ui/coach.ts:65-80` | Phone portrait, tutorial on: the deploy step anchors to `[data-tb="pause"]`, which sits at x = 569 in a scrolling row on a 390 px screen. The bubble is placed at left 595 px. The document grows to 748x1619, Chrome grows `innerWidth` to match, and the clamp at `coach.ts:76-80` then reads the inflated width and leaves the bubble there. Fixed HUD lays out against the larger viewport: touch bar at y = 1562. Shots `m13-deploy.png`, `probe-phone-deploy-tutorial-on.png`. With the tutorial skipped the same screen is normal (`probe-phone-deploy-tutorial-skipped.png`). Reproduced in 3 runs. | Anchor touch steps to `#touchbar`, never to a chip inside a scroll row. In `coach.ts` clamp against `document.documentElement.clientWidth` and make `.coach` `position: fixed`. Add a phone leg to the gate that reaches deployment. |
| CRITICAL | `scripts/tutorial.mjs:610-617`, `src/main.ts:803-838`, `src/campaign/presets.ts:17-34` | The first guided battle is losable by the gate's own bot. Seed 1636534801: 1.4:1 odds, red wins, twice. The gate is red on `main`. | Stop sending a first-time player into a live 143-man fight. See section 4a. Until then, make the tutorial march target a garrison at 3:1 or better and fail the gate on anything less. |
| HIGH | `src/ui/hud.ts:316`, `:527` | Desktop: `#squads` is rebuilt with `innerHTML` every 5 sim ticks. A mouse press that spans a rebuild lands its up on a new element and the click is dropped. Measured on the FIRE chip, running battle: 18/20 at 40 ms press, 3/20 at 120 ms, 0/20 at 220 ms. Paused: 20/20 at every duration. Touch is not affected (20/20). The same path serves squad cards, soldier rows and context buttons. | Handle `pointerdown` instead of `click` on `#squads`, or patch the cards in place instead of replacing them. Move order chips out of the rebuilt card (section 4c). |
| HIGH | `src/main.ts:2030-2048`, `src/ui/hud.ts:425-430`, `src/sim/sim.ts:2166-2172` | A V2 battle shows no goal. `objective` is built only when `pendingEngagement` is set, and V2 battles never set it (`src/main.ts:670-680`). `#obj-strip` computed `display: none` in every battle I staged. The win rule (enemy under 25% of start strength) appears nowhere, not in the HUD and not in the manual. | Feed the strip from `v2.battle`. Show one line: "Break them: GE 53 → 13". Rewrite the V1 condition text, which uses floor brackets (`src/ui/objective-strip.ts:44`). |
| HIGH | `src/ui/tutorial.ts:132-145`, `:286` | The one battle step has `doneOn: null`, so it is marked done the frame it shows. It is then removed by the first squad selection. It teaches no action and points at the manual. | Replace with the event-gated battle steps in section 4a. |
| HIGH | `src/main.ts:259-267`, `:283-294`, `:2067-2070`, `src/ui/coach.ts:57-58` | Two teaching systems share one bubble slot. The legacy coachmarks (`touch-basics`, `touch-order` / `first-squad-select`, `first-order-arm`) evict tutorial steps. In deployment the deploy step is replaced by "right-click to move" (`d14`, `m14`). `Tutorial.shown` still names the evicted step. | Delete the four legacy `coach.maybeShow` calls and fold their content into tutorial steps. One owner for the bubble. |
| HIGH | `src/main.ts:259-267`, `src/ui/coach.ts:65-71` | Phone: the "Squad selected" bubble covers the chips it refers to. Portrait blocks FAST, SNEAK, FIRE, SMOKE, DEFEND. Landscape blocks DEFEND, AMBUSH, ASSAULT. Measured with `elementFromPoint`. Portrait: 0 of 20 taps on FIRE armed while the bubble was up, 20 of 20 after it was dismissed. Legacy bubbles never dismiss on their own. The ✕ is 17x16 px. | Place bubbles over the map, never over controls. Dismiss on the action the bubble names. |
| HIGH | `src/ui/hud.ts:199-212`, `src/ui/ui.css:1196-1205` | Phone portrait: Play/Pause, Cancel, barrage, airstrike and ⚙ are off screen in a horizontally scrolling row. My driver had to swipe the row to reach Play (`[data-tb="pause"] @602,816`). The only cue is a 28 px fade. | Pin Play/Pause and ⚙ outside the scroll row. Move Select, Add, Floors into an overflow menu. |
| HIGH | `scripts/tutorial.mjs:769-770`, `docs/decisions/INDEX.md:75` | The gate's phone leg ends at the march step. It runs in 0.1 min and never opens a contact, a deployment or a battle. The decision record says the gate plays "boot → tutorial → REAL first victory … both platforms". `scripts/mobile.mjs` uses `?camp=`, where the tutorial does not exist. Nothing gates the tutorial in a phone battle, which is how the CRITICAL above shipped. | Extend the phone leg through deployment, first order and debrief. |
| MEDIUM | `src/ui/coach.ts:71`, `src/ui/ui.css:1060-1077`, `src/ui/hud.ts:146-149`, `src/ui/ui.css:69`, `:541-549` | `.coach` and `.affordance-tip` are appended to `document.body`, outside `#hud`. Computed style: `font-family: Times`, 10 px. The tip's `.panel` background rule is scoped to `#hud .panel`, so the tip is transparent (`rgba(0,0,0,0)`). Shots `d06`, `d25`. | Give both a font family and background of their own, or mount them inside `#hud`. |
| MEDIUM | `src/ui/hud.ts:243-254`, `:281-291` | Phone: long-press on an order chip shows nothing while the battle runs. The timer holds the button captured at `pointerdown`. The HUD has replaced it 480 ms later, so its rect is 0,0 and the card lands at y = -80. Paused: card at y = 666, on screen. Running: off screen. `probe-phone-affordance-running.png`. | Re-query the chip by `data-order` when the timer fires. |
| MEDIUM | `src/ui/tutorial.ts:97-98`, `src/ui/manual-data.ts:255-256`, `src/render/theater-view.ts:375-377` | Copy states a feature that does not exist. "The path and the ETA preview before you commit." The path draws only for a force that already has one. The ETA is a flash after the order. `d08`. | Cut the sentence, or build the preview. |
| MEDIUM | `src/ui/tutorial.ts:106`, `src/main.ts:405-406`, `src/render/theater-view.ts:409-416` | The speed bubble covers the order flash. It retires when the player taps 60x, and the war is still paused. Two inputs are needed and the tutorial counts one. | Make a speed button also start the clock, and gate the step on the clock advancing. |
| MEDIUM | `src/main.ts:1983`, `src/ui/tutorial.ts:129`, `src/ui/hud.ts:411` | Touch copy says "Resume". The touch control is labelled "Play". | One name. |
| MEDIUM | `src/main.ts:732`, `:736` | Deploy refusals: "Outside your deployment zone (x 0–32)" shows raw map coordinates. "Select a squad first — tap it, then right-click the ground" mixes touch and mouse on every platform. | "Stay inside the green zone." Use the platform's verb. |
| MEDIUM | `src/ui/ui.css:163`, `src/ui/hud.ts:583` | Desktop 1280: nine rifle squad cards all read "Abl…". The ammo chip and 12 dots take the row. `d13`. | Drop the company prefix ("1st", "2nd"). Hide the ammo chip until ammo is low. |
| MEDIUM | `src/ui/ui.css:1306`, `src/ui/tooltip.ts:198-201` | Phone landscape: the docked terrain card covers 65% of the screen during every order hold. `l20`. | One line while holding: name and a cover word. |
| MEDIUM | `src/main.ts:871-889` | Debrief renders the whole company: 156 rows, 5,189 px (desktop) and 6,866 px (phone) of scroll, under up to 52 names in red. | Summary first. Roster behind "Show roster". |
| MEDIUM | `src/ui/order-data.ts:25-28` | Balk hints say "rally first". There is no rally control (`src/ui/hud.ts:17`, `:80-91`). | "Pull them back or suppress the threat." |
| MEDIUM | `src/ui/tutorial.ts:152`, `src/ui/theater-hud.ts:92-99` | Debrief step says "Read your roster before the next fight". The V2 theater has no roster view, only a one-line force card. | Cut, or add the view. |
| MEDIUM | `src/ui/ui.css:1540`, `:1444`, `:422`, `:1100`, `:1119` | Phone touch targets under 44 px: all 34 customize controls (30 px tall), theater clock and ⚙ (32 px tall), Attack / Stand down / Return to the front (38 px tall), roster soldier rows (27 px tall), coach ✕ (17x16), Skip tutorial (50x22). | `min-height: 44px` under `html.mobile` for each. |
| MEDIUM | `src/ui/menu.ts:41-45` | Coach bubbles (z 20) float over the pause menu and the keybinding screen. `d30`, `m31`. The manual hides them (`src/ui/manual.ts:69`), the pause menu does not. | Call `coach.hide()` in `PauseMenu.open`. |
| MEDIUM | `src/ui/theater-hud.ts:110-115`, `src/ui/manual-data.ts:134` | The full win condition is a `title` attribute. A phone cannot hover. The manual tells the phone player to hover. | Tap to expand. |
| MEDIUM | `src/ui/keymap.ts:51`, `src/ui/hud.ts:126-128` | No battle speed control on either platform. First battles ran 5 to 7 minutes of real time at 1x. | 1x / 2x / 4x beside Pause. |
| MEDIUM | `src/sim/sim.ts:2166-2172`, `src/main.ts:2076-2077` | A battle ends only on attrition. With no input for 300 s the defender held, nobody won and nothing prompted the player. The idle hint (`src/ui/hud.ts:349-370`) names controls, not the goal. | State the goal on screen (first HIGH above). Prompt after a quiet minute: "The enemy is holding the village. Advance." |
| LOW | `src/ui/menu.ts:77` | Keybindings is offered on a phone. | Hide under `MOBILE`. |
| LOW | `src/ui/hud.ts:577` | "(esc widens)" on a phone. | Platform copy. |
| LOW | `src/main.ts:1665` | Mute is key M only. No touch path. | A toggle in the ⚙ menu. |
| LOW | `src/ui/overlays.ts:555-568`, `:657-660` | Team order labels (AMBUSH, DEFEND, MOVE) overprint the deploy banner and the docked context chip. `m17`, `m21`. | Hide the labels in deployment. Move the chip dock. |
| LOW | `src/ui/overlays.ts:683-697` | Refusal chips are cut off at the screen edge and under the roster. `d32`, `m25`. | Clamp to the clear viewport. |
| LOW | `src/ui/hud.ts:340-345` | Victory banner overlaps the roster by 258x105 px. `d33`. | Centre on the clear viewport, as the deploy banner already does. |
| LOW | `docs/decisions/INDEX.md:75` | Record says 58 manual entries. `MANUAL` holds 67. 58 is the count over 20 words. | Correct the record. |
| LOW | `src/render/theater-view.ts` (labels), `m08` | Phone portrait theater: town labels are cut by force markers and the map uses a third of the screen. | Fit to height in portrait, declutter labels against forces. |

### Controls with no touch path

| Desktop control | Touch path | Owner |
|---|---|---|
| Hover a chip for its order card | Long-press. Broken while running, transparent when paused. | `src/ui/hud.ts:243-254` |
| Hover the theater top bar for the win condition | None | `src/ui/theater-hud.ts:115` |
| Hover an enemy or ground for a card, with no order pending | None. The card shows only inside an order hold, and lifting issues the order when a squad is selected. | `src/main.ts:1546-1566` |
| Hover a target for the hit percentage line | Same hold only | `src/main.ts:1935-1936` |
| M mute | None | `src/main.ts:1665` |
| P AI auto-command | None | `src/main.ts:1680` |
| 1-9 select squad | Roster sheet (2 taps) | `src/main.ts:1685-1689` |
| Hover path "preview" in the theater | Does not exist on either platform | `src/render/theater-view.ts:375` |

### A hypothesis I tested and dropped

I expected touch taps on order chips to be lost to the same HUD rebuild. They are not: 20 of 20 at 40, 120 and 220 ms, paused and running, portrait and landscape. The loss is desktop mouse only.

---

## 3. Text inventory

Every block of player-facing prose over 20 words. Word counts are rendered text.

### 3a. On the critical path

| Block | Where | Words | Verdict |
|---|---|---|---|
| Briefing "How you win" | `src/ui/manual-data.ts:109` via `src/ui/tutorial.ts:301` | 64 | Shorten to 8: "Take the gold-ringed towns before Day 14." Show the rings pulsing behind it. |
| Briefing "How you lose" | `src/ui/manual-data.ts:117` | 44 | Cut from the card. The top bar already shows "Day 1 of 14". |
| Briefing "The enemy is not waiting" | `src/ui/manual-data.ts:124` | 37 | Cut from the card. Show it the first time red retakes a town. |
| Rotate gate | `src/main.ts:108` | 22 | Shorten to 6: "Turn your phone for a wider view." Keep the glyph. |
| Desktop key legend, 2 lines | `src/ui/hud.ts:135-136`, `:390-391` | 34 | Cut. Replace with a "?" button that opens a controls card. |
| Win condition tooltip | `src/ui/theater-hud.ts:110-112` | 21 | Keep the text, show it on tap, not on hover. |
| Tutorial "deploy" (touch) | `src/ui/tutorial.ts:129` | 20 | Shorten to 5: "Tap Play to start." Repositioning is optional and can wait. |
| Tutorial "battle-orders" (touch) | `src/ui/tutorial.ts:143` | 20 | Replace with the gated steps in 4a. |
| Terrain tooltip | `src/ui/tooltip.ts:198-201` | about 20 | Replace with an icon and one word ("good cover"). Numbers behind Alt or long-press. |

Under 20 words but wrong or redundant: tutorial "march" (16 to 18, one false sentence), tutorial "debrief" (19, points at a roster that does not exist), deploy banner (12 to 15, restates the deploy bubble on the same screen), legacy "Squad selected" (18, tells a player who has selected a squad to select a squad).

### 3b. Field Manual, 58 entries over 20 words

Lines are in `src/ui/manual-data.ts`. "gen" = built by `orderEntries()` at `:88-99` from `src/ui/order-data.ts:10-19`.

| Chapter | Entry | Line | Words | Verdict |
|---|---|---|---|---|
| Objective | How you win | 109 | 64 | Shorten to 20 |
| Objective | How you lose | 117 | 44 | Shorten to 15 |
| Objective | The enemy is not waiting | 124 | 37 | Shorten to 15 |
| Objective | Read the top bar | 130 | 35 | Cut. It describes what the bar shows and tells a phone to hover. |
| Objective | Losses are not forever | 137 | 44 | Shorten to 20 |
| Operation | The main menu | 150 | 48 | Cut. Restates three buttons. |
| Operation | The seed | 157 | 44 | Shorten to 15 |
| Operation | Presets | 164 | 41 | Shorten to 15 |
| Operation | Knobs | 170 | 53 | Cut. Restates the labels on the screen. |
| Operation | Supply lines | 177 | 72 | Keep, shorten to 30 |
| Operation | Enemy intel | 186 | 72 | Keep, shorten to 30 |
| Operation | Night tempo | 194 | 54 | Shorten to 25 |
| Operation | The preview is the real map | 201 | 35 | Cut |
| Operation | When a combination is refused | 207 | 46 | Cut. The reject card says it. |
| Theater | The map is the war | 220 | 41 | Cut. No instruction in it. |
| Theater | Reading the ground | 227 | 37 | Replace with a map legend |
| Theater | Roads and pace | 234 | 43 | Replace with a legend row per road weight |
| Theater | Rivers, bridges and fords | 241 | 49 | Shorten to 20 |
| Theater | Giving a march order | 253 | 35 | Shorten to 12. Remove the false preview claim. |
| Theater | When an order is refused | 260 | 41 | Cut. The flash states each reason. |
| Theater | The clock | 267 | 37 | Shorten to 12 |
| Theater | Contact | 278 | 44 | Shorten to 15 |
| Theater | The contact choice | 285 | 50 | Shorten to 25 |
| Theater | How long a battle takes | 292 | 34 | Keep |
| Theater | Losing a battle on the map | 299 | 44 | Keep, shorten to 25 |
| Theater | Saving | 306 | 29 | Shorten to 10 |
| Deployment | The battle opens paused | 318 | 33 | Shorten to 12 |
| Deployment | Your zone when attacking | 324 | 28 | Replace with the green zone already drawn |
| Deployment | Your zone when defending | 330 | 41 | Same |
| Deployment | Repositioning | 336 | 43 | Shorten to 15 |
| Deployment | Guns do not move | 343 | 28 | Shorten to 10 |
| Deployment | Where the defenders are | 349 | 29 | Keep |
| Battle | Selecting men | 368 | 36 | Shorten to 15 |
| Battle | Giving an order | 379 | 51 | Shorten to 15. Move the cancel ladder to its own entry. |
| Battle | Move | gen | 24 | Shorten to 10 and attach to the chip card |
| Battle | Fast | gen | 28 | Same |
| Battle | Sneak | gen | 31 | Same |
| Battle | Fire | gen | 22 | Same |
| Battle | Smoke | gen | 26 | Same |
| Battle | Defend | gen | 25 | Same |
| Battle | Ambush | gen | 23 | Same |
| Battle | Assault | gen | 28 | Same |
| Battle | Formation, width and facing | 388 | 41 | Replace with a 3-frame diagram |
| Battle | Cover | 396 | 34 | Shorten to 12. Taught in the drill. |
| Battle | Concealment | 402 | 39 | Shorten to 20 |
| Battle | Line of sight | 409 | 40 | Shorten to 20 |
| Battle | Buildings and floors | 416 | 62 | Keep, shorten to 30 |
| Battle | Ammunition | 425 | 36 | Shorten to 15 |
| Battle | Suppression, morale and rout | 432 | 49 | Shorten to 25 with the four state colours |
| Battle | Weapon teams | 439 | 46 | Shorten to 25 |
| Battle | Emplacements | 446 | 43 | Shorten to 20 |
| Battle | Barrage and airstrike | 453 | 41 | Shorten to 20 |
| Battle | Fog of war | 461 | 52 | Shorten to 25 |
| Battle | Assault, melee and surrender | 468 | 49 | Shorten to 25 |
| Battle | The debrief, and what carries | 475 | 44 | Shorten to 15 |
| Touch | Cancel | 512 | 22 | Keep |
| Touch | Floors | 527 | 22 | Keep |
| Touch | The roster | 532 | 21 | Keep |

Missing from the manual: how a battle is won. Add it.

The manual is a reference and can stay long. The fault is that the tutorial sends the player to it in place of teaching.

---

## 4. Proposed redesign

### 4a. A guided first battle that teaches by doing

**The real choice is where the first battle happens.**

| Option | What it is | For | Against |
|---|---|---|---|
| A. Drill battle | A fixed, small training battle before the campaign. One platoon (3 rifle squads and one MG) against about 8 defenders in one farmhouse. Steps gated on sim events. Losses do not persist. Replayable from the main menu. | The lesson fits a phone screen. It cannot be lost by accident. It teaches the loop the live battle needs. It never touches the campaign roster. | New content: one authored map and force. It needs its own gate over a range of seeds so a balance pass cannot break it. |
| B. Coach the live first battle | Keep the campaign as the entry. Add battle steps to the existing driver. Make the first contact safe by steering the tutorial march to a 3:1 or better garrison. | No new content. Reuses every screen. | The classroom is 143 men, 18 squads and a 320 m map. Events arrive in any order. A portrait phone sees a third of it. 3:1 is not proven safe: 2:1 cost 51 dead with a bot. |
| C. Copy and bug pass only | Fix section 2, cut section 3, add no teaching. | Small. | Does not answer the owner. The battle still teaches nothing. |

**Recommend A, plus the section 2 fixes and the section 3 cuts.** Build A on the driver from B: the step data, state machine and storage are already right.

**On the earlier decision.** `docs/decisions/INDEX.md:75` rejected "a scripted staged first-campaign" for three reasons: forced beats against a live goal-driven red freeze it or drift, the script breaks on every balance pass, and a scripted school cannot be consulted twice. My evidence supports revisiting it in a narrower form. The hybrid that shipped teaches the theater and nothing in the battle. Its own gate fails on `main`. Option A is not a staged campaign. It is one battle against a defender that holds its position, so there is no goal-driven red to freeze. It gates on events, not outcomes, and a seed sweep can prove the win holds. It sits on the main menu, so it can be played again. The rejection of a scripted campaign should stand.

**Step list for the drill.** One short line per step. The sim is paused while a step waits for input.

| # | Player sees | Line | Trigger to show | Trigger to finish | Exists today |
|---|---|---|---|---|---|
| 0 | Farm ahead, own squads ringed | "Take the farmhouse." [Start] | Drill boots | Tap Start | Card shell: `Tutorial.showBriefing` (`src/ui/tutorial.ts:295`) |
| 1 | Pulse ring on 1st Squad | "Tap your squad." | Step 0 done | `squad-selected` | `selectSquad` (`src/main.ts:251`). Needs a `notify`. |
| 2 | Pulse ring on the hedge in front | "Hold here. Green dots mean cover." | Step 1 done | `order-issued`, kind move, at least one covered spot | Preview dots and the covered count: `src/ui/overlays.ts:433-457`, `:616-633`. Commit point: `src/main.ts:1285`. |
| 3 | Squad walks. Enemy opens fire. Auto-pause, ring on the enemy | "Enemy. Pin them down." | First red seen by blue | — | Fog test `sim.soldierVisibleTo` (`src/main.ts:1930`) |
| 4 | FIRE chip glows | "Tap FIRE, then hold on the enemy." | Step 3 shown | `order-issued`, kind fire | Arm path `doArmOrder` (`src/main.ts:283`) |
| 5 | Ticker: PINNED DOWN | "They are pinned. Now move in." | Red team majority pinned | — | `TeamPulse` and `teamLine` (`src/main.ts:1704`, `src/ui/overlays.ts:796-822`) |
| 6 | Ring on 2nd Squad, ASSAULT chip glows | "Send 2nd Squad. Tap ASSAULT, hold on the house." | Step 5 shown | `order-issued`, kind assault, a different squad | Same commit point |
| 7 | — | "Farm taken. Cover, pin, assault. That is every fight." [Start the campaign] | `sim.winner === 'blue'` | Tap | `src/main.ts:2076` |
| R | Recovery | "They won't go. Pin the enemy first." | A blue team balks | Order re-issued | `orderState.phase === 'balked'`, `BALK_HINT` (`src/ui/order-data.ts:21-30`) |

**Reuse from `src/ui/tutorial.ts`:** the `Step` shape (`:45-56`), `advance()` (`:191-203`), `loadState` / `saveState` (`:160-183`), `Tutorial.notify` (`:224-234`), `skip` and `setEnabled` (`:249-266`), and `Coach.showStep` (`src/ui/coach.ts:48-51`). The `notify` call pattern in `main.ts` is already one line per site.

**New work:**

1. Six events on `TutorialEvent` (`src/ui/tutorial.ts:17-28`): `squad-selected`, `order-issued`, `enemy-seen`, `enemy-pinned`, `team-balked`, `battle-won`.
2. A world anchor. Steps anchor to DOM selectors only today (`:53`, `:275`). The drill needs a ring on a squad, a hedge and a house, projected each frame with `cam.worldToScreen`.
3. A step that can pause the sim and can highlight one chip.
4. The drill itself. `src/sim/scenario.ts:39` (`makeScenario`) builds a standalone `Sim`, and `bootBattle` (`src/main.ts:622`) takes one. I did not read `scenario.ts` past its signature.
5. A gate: the drill won by a script that follows the steps, on both platforms, over a seed sweep.

### 4b. Landing to playing

| | Today | Proposed |
|---|---|---|
| First run | Menu → 34-control customize → 163-word card → theater (4 inputs) → contact → deploy → battle | Menu shows one **Play** button → drill loads paused at step 1 |
| Inputs to first battle order | 11 desktop, 12 phone | **3**: Play, tap squad, hold on hedge |
| Words before the first order | 689 desktop | Under 20 |
| After the drill | — | "Start the campaign" → default preset, no customize screen. Theater steps as today, with the fixes in section 2. |
| Customize | In the path of every new game | Behind "Custom operation", second in the menu |
| Later runs | Continue / New Operation | Continue first. Drill stays on the menu as "Training". |

A second choice, smaller: which preset a first campaign uses.

| Option | For | Against |
|---|---|---|
| Keep Normandy Bocage | No change | My four rolls gave 2, 4, 5 and 6 objectives, all required, against 5 to 13 red forces. A won first battle left one of three companies at 69 men. |
| First campaign on Skirmish (2 companies, enemy strength 1, 7 days, majority) | Shorter and smaller. Already exists (`src/campaign/presets.ts:89-112`). | I did not measure it. |

Recommend Skirmish for the first campaign, after a sweep confirms a first contact is winnable.

### 4c. HUD simplification

| # | Element | Today | Change | Owner |
|---|---|---|---|---|
| 1 | Battle goal | Absent in V2 | One strip: "Break them" with a bar toward the 25% line. An arrow to the nearest known enemy. | `src/ui/hud.ts:425-455`, `src/main.ts:2030` |
| 2 | Order chips | 8 in a rebuilt roster card (desktop), 8 in a scroll row (touch) | One order bar on both platforms. 4 primary: Move, Fire, Smoke, Assault. Fast, Sneak, Defend, Ambush behind "More". Fixes the dropped desktop clicks. | `src/ui/hud.ts:616-629` |
| 3 | Touch bar row 2 | 10 chips, Play off screen | Play/Pause and ⚙ pinned. All, Roster visible. Select, Add, Floors, Cancel in an overflow. | `src/ui/hud.ts:199-212` |
| 4 | Desktop key legend | 34 words, always on | Remove. "?" opens a controls card. | `src/ui/hud.ts:134-137` |
| 5 | Roster | 20 cards, ammo chip and dots on each | Squad name without the company prefix. Ammo chip only when low. Selected squad expands. | `src/ui/hud.ts:544-585` |
| 6 | Terrain tooltip | 5 lines of percentages | "Hedgerow · good cover". Detail on Alt or long-press. One line while a touch hold is live. | `src/ui/tooltip.ts:198-201` |
| 7 | Order context chip | "RISK MED 0.40 / 12/12 COVERED · ~7s / COMPLY" | "12 of 12 in cover · 7 s", green, amber or red. "Won't go" in place of BALK. No decimals. | `src/ui/overlays.ts:616-633` |
| 8 | Coach bubbles | Two systems, Times 10 px, persistent | One system. HUD font. Placed over the map. Gone when the action is done. | `src/ui/coach.ts`, `src/main.ts:259-294` |
| 9 | Team order labels | AMBUSH / DEFEND over squads in deployment | Hide in deployment. | `src/ui/overlays.ts:555-568` |
| 10 | Speed | Pause only | 1x / 2x / 4x | `src/ui/hud.ts:126-128` |
| 11 | Debrief | 156 rows | Result, losses as two numbers, "Show roster". | `src/main.ts:891-903` |
| 12 | Theater force card | "Able · 138 men · line · holding / fatigue / supplied" | "Able · 138 men". Fatigue and supply only when not nominal. | `src/ui/theater-hud.ts:92-99` |
| 13 | Theater clock | Speed and Resume are separate inputs | A speed button starts the clock. | `src/main.ts:405-406` |
| 14 | Phone-only | Keybindings, "(esc widens)" | Hide both. | `src/ui/menu.ts:77`, `src/ui/hud.ts:577` |

---

## 5. Gate output, verbatim tails

Commands, run from the repo root. The script header gives `--leg desktop` and `--leg mobile` as the per-leg flags.

- `node scripts/tutorial.mjs --port 5303 --leg desktop --shots …/audit/gate-desktop`
- `node scripts/tutorial.mjs --port 5303 --leg desktop --seed 1636534801 --shots …/audit/gate-desktop-rerun`
- `node scripts/tutorial.mjs --port 5303 --leg mobile --shots …/audit/gate-mobile`

### Desktop leg, rolled seed 1636534801 (`gate-desktop.log`)

Last three fight lines, then the tail:

```
    t+231s squads=10/11 blue=42/143 red=75/102 knot=16 assault
    t+247s squads=10/10 blue=40/143 red=75/102 knot=16 smoke
    t+264s squads=10/10 blue=36/143 red=75/102 knot=16 fire
```

```

9 screenshots in /private/tmp/claude-501/-Users-joshtaylor-CodingProjects-top-down-military-rts/a4521b13-7156-424c-8cac-41b2343957b6/scratchpad/audit/gate-desktop (4.7 min)
1 FAILED:
  - desktop leg aborted: THE GUIDED VICTORY IS NOT REACHABLE: blue 32/143 vs red 75/102 effective after 276s and 67 order passes; sim.winner=red.
    The company the tutorial sends at the weakest garrisoned objective LOST. That is a balance finding, not a script bug — a first battle a briefed player cannot win is a broken onboarding.
EXIT 1
```

My desktop walk ran on the same machine during that fight. To rule that out I ran the leg again, alone, on the same seed.

### Desktop leg, same seed, run alone (`gate-desktop-rerun.log`)

```
    t+231s squads=12/12 blue=45/143 red=77/102 knot=16 assault
    t+248s squads=12/12 blue=44/143 red=75/102 knot=15 smoke
    t+264s squads=12/12 blue=38/143 red=74/102 knot=15 fire
```

```

9 screenshots in /private/tmp/claude-501/-Users-joshtaylor-CodingProjects-top-down-military-rts/a4521b13-7156-424c-8cac-41b2343957b6/scratchpad/audit/gate-desktop-rerun (4.7 min)
1 FAILED:
  - desktop leg aborted: THE GUIDED VICTORY IS NOT REACHABLE: blue 34/143 vs red 71/102 effective after 277s and 67 order passes; sim.winner=red.
    The company the tutorial sends at the weakest garrisoned objective LOST. That is a balance finding, not a script bug — a first battle a briefed player cannot win is a broken onboarding.
EXIT 1
```

Every tutorial-bubble check before the fight passed in both runs. The two staged contact-modal legs passed in both.

### Mobile leg (`gate-mobile.log`)

```
  ok   a phone player can open the menu from the theater — no ⚙ among [▶ Resume 1× 10× 60× ⚙] (touchbar visible: false). The ⚙ chip lives in #touchbar, which is inside hud.root and hidden outside battle mode (src/main.ts frame()), so on a phone the pause menu, keybinds and Field Manual are unreachable for the whole theater phase.
  ok   no page errors on the phone leg

=== phone · Skip tutorial, then reload: no artifacts, ever ===
  ok   fresh profile: no rts.tutorial.v1 in localStorage at boot
  ok   fresh profile: no saved campaign behind Continue
  campaign seed 4239359017 (rolled; replay this run with --seed 4239359017)
  ok   Skip clears the card and any bubble on the spot
  ok   skip is written to storage ({"skipped":true,"done":[]})
  ok   a skipped profile shows no card and no coachmarks after a reload and a march (bubbles=0)
  ok   the game is still fully playable with the tutorial off
  shot /private/tmp/claude-501/-Users-joshtaylor-CodingProjects-top-down-military-rts/a4521b13-7156-424c-8cac-41b2343957b6/scratchpad/audit/gate-mobile/m5-clean.png — mobile: skipped profile, reloaded and played — zero tutorial artifacts

5 screenshots in /private/tmp/claude-501/-Users-joshtaylor-CodingProjects-top-down-military-rts/a4521b13-7156-424c-8cac-41b2343957b6/scratchpad/audit/gate-mobile (0.1 min)
all checks passed
EXIT 0
```

Green in 0.1 min, and its own heading says where it stops: `=== phone 390x844 · real touch · briefing → march → manual ===`. No contact, no deployment, no battle, no debrief.

---

## 6. What I could not confirm

| Claim or question | Status | Where I looked |
|---|---|---|
| The phone deployment defect on a real iPhone or Android phone | Not confirmed. Reproduced only in headless Chrome with the repo's `phone` profile. The viewport growth is Chrome's mobile behaviour. Safari may clip instead. | `probe-viewport.mjs`, `scripts/lib/stage.mjs:29-33` |
| Whether a human wins the first battle | Not measured. Bots only. | Section 1e |
| Whether the default campaign can be won | Not measured. | Saw only that a won first battle halves a company. |
| Whether Skirmish gives a winnable first contact | Not measured. | `src/campaign/presets.ts:89-112` read only |
| Human time from landing to first order | Not measured. 18 to 20 s is the script floor. | — |
| Desktop click loss on squad cards, soldier rows and context buttons | Inferred from the same code path. Measured on the FIRE chip only. | `src/ui/hud.ts:157-172`, `:527` |
| The defender path (red attacks first) and the Auto-resolve path as a player meets them | Not walked. The gate's staged legs cover the copy. | `scripts/tutorial.mjs:690` |
| The V1 grid campaign HUD (`strat-hud.ts`) | Not audited. The menu never reaches it. Only `?camp=` does. | `src/main.ts:2086-2091` |
| Whether `makeScenario` can build a platoon-size drill | Not read past the signature. | `src/sim/scenario.ts:39` |
| Audio | Not audited. Headless. | — |
| The phone deployment defect in landscape | Does not occur. The Play chip is on screen at 844 px, so the bubble has a visible anchor. | `l12-deploy.png` |
| Whether the battle ever ends for a player who does nothing | Not confirmed past 300 s. Red lost 3 men, blue 13, no winner. | `fight-tests/idle-metrics.json` |

Two things interrupted runs and are not game defects. Vite did a full page reload three times when another session created a worktree under `.claude/worktrees/` (the dev server log names the path). I re-ran the two runs it broke. One variant of my tap probe used `Input.synthesizeTapGesture`, which errored under phone emulation. I went back to raw touch events, the method the gate uses.
