# Tactical AI and emergent behavior audit

Repo `top-down-military-rts` at `8a90968` (main, clean). Read-only. No source edits, no commits, no bugs filed.
All `file:line` references are valid at that commit. The files are hot, so the symbol name is the stable key.

## 1. Bottom line

1. The per-soldier layer is rich and most of it fires in natural battles: suppression, pinning, rout, recovery, melee, crawl to cover, rescue starts, weapon succession, leader promotion, weapon pickup.
2. Three defects mute large parts of it. A tripod MG42 fires at most 24 bursts per battle. The AI commander re-issues orders every 5 s and cancels 68% of its own side's rescues. The attacker's reserve (50 of 126 foot men) gets one order per battle and then stands idle.
3. Several shipped features are near zero in play: grenades (10 thrown in 38 battles, 17.7 of 18 left per battle), drag to cover (34 in 38 battles, 1.6% of 2,089 rescue starts), two-man carry (2 in 38 battles), attackers going upstairs (2 of 36 distinct battles), the per-man `rallied` event (0 in 38 battles, provably unreachable), tank AP fire (0 in 38), AI airstrike, AI team smoke, AI mount or tow or breach orders (all 0 in 38).
4. The AI attack does not read as fire and movement. Blue AI wins 4 of 30 attacks. The maneuver element's median loss is 60 of 60 men. A base-of-fire team is settled and firing for a median 15% of the battle. Attackers stand upright in 97% of stance samples.
5. Half the garrison never fires (46 of 87 foot men, mean) and no defender squad leaves its post (median drift 3 m).
6. The commander has no player-facing voice. Reserve commit, culmination, smoke missions and counterattacks are all silent.

## 2. Method

### 2.1 Probe

Script: `scratchpad/audit/ai/ai-liveness-probe-v3.mjs` (v1 and v2 are earlier cuts of the same file, kept beside it).
It stages battles through `makeStrategicBattle` exactly as `scripts/balance.mjs` does, runs `RedCommander` on both sides, and counts behaviors.
Instrumentation wraps methods on the `Sim` instance and diffs state after each `step()`. It draws no rng and writes no sim state.
Proof that the wrappers do not perturb the battle: woods seeds 1 and 2 gave identical casualty results under probe v1 and probe v3.

Commands (run from the repo root, `A` = the `scratchpad/audit/ai` directory):

```
npx vite-node --root $A $A/ai-liveness-probe.mjs    -- --mode blueatk --kinds <k> --seeds 1,2,3 --out $A/blueatk-0600-<k>.jsonl
npx vite-node --root $A $A/ai-liveness-probe-v2.mjs -- --mode redatk  --kinds <k> --seeds 1,2   --out $A/redatk-0600-<k>.jsonl
npx vite-node --root $A $A/ai-liveness-probe-v3.mjs -- --mode blueatk --kinds <k> --seeds 1,2 --clock 840 --out $A/blueatk-1400-<k>.jsonl
python3 $A/agg2.py '<key prefixes>'      # aggregate table
```

`--root` must point at the script's own directory. vite-node refuses an entry file outside its root.

### 2.2 Battle sets

| Set | Battles | Staging | Notes |
|---|---|---|---|
| B06 | 18 | Blue AI (US rifle company, 141 men + Sherman + M3) attacks the red AI garrison (113 men). Kinds open, woods, bourg, road, bridge, river. Seeds 1 to 3. | Campaign clock 06:00, `sim.light` = 0.42, so the night spotting cap (about 76 m) is active. This is the clock `balance.mjs` uses. |
| B14 | 12 | Same, seeds 1 and 2, clock set to 14:00 (`front.clockMin = 840`, full light). | Woods seeds 1 and 2 are bit-identical to B06. 10 distinct battles. |
| R06 | 8 | Red AI (Grenadier company + StuG + SdKfz 251) attacks the blue AI defender. Kinds open, bourg, road, woods. Seeds 1 and 2. | Blue defends under AI. In real play the player holds blue unless the P toggle is on. |

38 runs, 36 distinct. Cap 54,000 ticks (30 game minutes). A cap hit counts as a defender hold.
Outcomes: B06 2 blue wins, 2 red wins, 14 holds. B14 2, 1, 9. R06 0 red wins, 3 blue wins, 5 holds.
Mean blue KIA when attacking: 77 of 141. The attack culminated in 25 of 30 blue attacks.

Limits of the data:
- Both sides run the AI. A human attacker gives fewer and different orders. Rows about commander behavior describe the AI. Rows about soldier reflexes apply to both.
- Counts are per battle means with "n/N" = battles where the count was above zero.
- Some counters exist only in later probe versions. Those rows name their set.

## 3. Inventory

"Per battle" figures are B06 means unless a set is named. "atk" and "def" mean the attacking and defending side.

### 3.1 Individual soldiers

| Behavior | Symbol (file:line) | Fires per battle | Visible to player |
|---|---|---|---|
| Target choice and return fire | `acquire` sim.ts:4241, `acquireSoldierTarget` sim.ts:2693, `fire` sim.ts:4247 | 994 aimed shots atk, 436 def. 38/38. Nearest visible enemy in range, no priority for MG, leader or threat. Arc-limited under defend or ambush. | Yes. Tracers, flash, per-weapon audio, aim pose. |
| Marching fire | `fireSmallArms` sim.ts:2839, penalty in `shotPreview` sim.ts:2776 | 678 atk shots, 68% of all attacker shots are fired while walking. | Yes, as tracers. Nothing marks it as walking fire. |
| Suppression and pinning | `suppressAround` sim.ts:4333, mental ladder in `updateSoldier` sim.ts:2907 | `pinned` events 80 atk, 45 def. 38/38. | Yes. Amber ring, breathing ring when pinned (renderer.ts:1437), dust puff (`drawMoraleFx`), prone pose, team ticker PINNED DOWN (`EventPings.teamLine` overlays.ts:796), roster chip colour. |
| Rout | `flee` sim.ts:3874, trigger sim.ts:2947 | `broken` events 36 atk, 13 def. 38/38. Men run 30 m from the nearest enemy and re-path every 3 s. No rally point, no direction of own lines. | Yes. Chevron chip (renderer.ts:1460), BROKE ticker, audio for own men, tooltip "fleeing". |
| Recovery from rout | morale regen sim.ts:2905 | broken to shaken 26 atk, 1.7 def. | Partly. The chevron disappears. No line says he is back. |
| Per-man `rallied` event | sim.ts:2919 | **0 in 38 battles.** Unreachable, see 4.1. | The ring FX wired to it (`drawMoraleFx` rallied branch) never draws. |
| Team rally line | `EventPings.teamLine` overlays.ts:796 | Works off live state (majority pinned flag), not off the event. | Yes. RALLIED ticker line. |
| Surrender | `capture` sim.ts:4135, callers sim.ts:2922 and `considerMelee` sim.ts:4117 | Defender 1.1 (19/38 battles), attacker 0.2 (6/38). Only at melee reach of 2 or more enemies. | Yes. Hands-up pose, SURRENDERS ticker, audio for own men. |
| Melee | `considerMelee` sim.ts:4101, `updateMelee` sim.ts:4173, `meleeStrike` sim.ts:4221 | 22 lock-ons atk (31/38 battles). About 2.5 melee kills per side. | Yes. 4-frame pose, strike FX, audio. |
| Grenade at a cluster or room | `maybeThrowGrenade` sim.ts:3977 | **0.4 (5/18). B14 0. R06 0.** All sets: 10 throws of either kind in 38 battles, in 5 battles. | Explosion only. No throw arc, no ticker. The blast draws at shell scale, see 4.12. |
| Grenade through a door before entry (#217) | `maybeGrenadeEntry` sim.ts:4008, `grenadeEntryThrow` sim.ts:4035 | **Considered 7.7 times, thrown 0.2 (3/18). B14 0.** 17.7 of 18 grenades left at battle end (all sets). Germans carry none (data.ts:154 is the only slot). | Same as above. |
| Wounded rescue, walk to casualty | `considerRescue` sim.ts:3350, `updateRescue` sim.ts:3364 | Starts 34 atk, 18 def. 38/38. | Walk pose only. Tooltip on the casualty names the rescuer (tooltip.ts:268). |
| Buddy aid | aid phase in `updateRescue` sim.ts:3437 | Aid reached 15 atk, 11 def. Stabilized **3.4 atk**, 8.3 def. | Yes. Aid pose (renderer.ts:1310), white cross on the stabilized man (renderer.ts:1417). No ticker. |
| Drag to cover | drag phase sim.ts:3397 | **0.2 atk, 0.4 def. All sets: 34 drags in 38 battles, against 2,089 rescue starts.** | Yes when it happens. Drag and dragged poses, blood smear. |
| Two-man carry | `findCarryHelper` sim.ts:3338 | **Helper found 2 times in 38 battles.** | Same poses. |
| Aidman speed | `aidTimer` sim.ts:3331 | Not counted apart from aid. Aidman promoted to leader 0.8 times per battle and loses the role. | Aidman kit sprite (`kitVariant` dudes.ts:142). |
| Ammo runner | `considerAmmoRunner` sim.ts:3450 | Red defending 3.1 (19/30). Blue attacking 0.1 (1/30). MG gunners only. | No. A man walks. |
| Weapon succession | `triggerSuccession` sim.ts:3593, `updateTakeOver` sim.ts:3626 | Gunner lost 13 atk, 11 def. Successor assigned 6.7, 4.5. Completed about 4.5, 3.8. 38/38. | Weak. The sprite and the roster row change weapon. No ticker, no swap pose. |
| Leader succession | `promoteLeader` sim.ts:3666 | 11.6 atk, 3.2 def. 38/38. | Weak. Leader kit sprite only. |
| Weapon pickup | `considerPickup` sim.ts:3534 | 26 atk, 7 def. | No. |
| Load pickup | `considerLoadPickup` sim.ts:3562 | 2.6 atk, 10.6 def. | No. |
| Crawl to cover under fire | `crawlToCover` sim.ts:3865, `crawlCoverSpot` spots.ts:282 | 14.7 atk, 3.4 def. 37/38. | Yes. Crawl pose. |
| Low crawl while advancing | `stanceOf` path branch sim.ts:625 | 12,500 man-ticks atk. | Yes. Crawl pose. |
| Stance choice | `stanceOf` sim.ts:619 | Attackers stand in 97% of samples (R06 red 87%). Defenders crouch in 97% (R06 blue 70% crouch, 29% prone). | Yes. Prone and kneel poses. |
| Building entry and floor choice | `orderLevel` spots.ts:89, nook scoring in `resolveMoveSpots` spots.ts:450, stairs in `advance` sim.ts:3285 | Defenders go upstairs in 17/38 battles. **Attackers go upstairs in 2 of 36 distinct battles.** | Yes. Floor badge, roof fade, larger sprite. |
| Sneak and concealment | `checkSneakBreak` sim.ts:1941, `sightToSoldier` sim.ts:733 | AI never orders sneak. 0/38. | Player orders only. |
| Ambush trigger | `checkAmbushTrigger` sim.ts:1975 | Red def 1.4 (support crews only, every Gruppe holds `defend`). Blue def 11.1 (R06). | Yes. AMBUSH SPRUNG ticker and ring FX. |
| Infantry AT fire | AT blocks in `updateSoldier` sim.ts:3146 and 3169, `fireApAt` sim.ts:2713 | Red fausts and Schreck 1.4 to 2.2 shots (16/30). Blue bazookas 0.6 (3/8, R06). | Yes. Shot line, boom on a miss, BREWED UP on a kill. |
| Reaction to tanks | tank terror in `updateVehicle` sim.ts:2571 | Suppression only. No evasion, no stalking. | Suppression ring only. |
| Reaction to grenades | none | Does not exist. | n/a |
| Rubble scramble | `advance` sim.ts:3303 | 9.2 atk (8/18). | A pause. No pose. |
| Downed man gets back up | physiology in `updateSoldier` sim.ts:2876 | 11 atk, 13 def. 38/38. | No. Pose changes with no event. |

### 3.2 Teams

| Behavior | Symbol (file:line) | Fires per battle | Visible to player |
|---|---|---|---|
| Comply, cautious, balk | `orderTeam` sim.ts:1777, `compliance` orders.ts:159, `dangerScore` orders.ts:144 | Attacker move orders: 19% balk, 15% bound. Fast orders: 33% balk, 19% downgrade. | Yes for own selected teams. Order chip with reason (overlays.ts:553), balk chip on the roster card (hud.ts `squadCard`), WON'T ADVANCE ticker (blue only), preview dots. |
| Bounding | `teamHalves` sim.ts:1876, `dispatchLeg` sim.ts:1896, `continueBounding` sim.ts:1912 | 84 orders enter bounding. 17,000 team-ticks. 38/38. | Weak. Chip text "moving cautiously" on a selected team. Nothing says "covering" or "bounding". |
| Mid-move re-audit | `stepOrders` sim.ts:2282 | Counted inside the balk and bounding figures. | Same chip. |
| Team smoke grenades | `deploySmoke` sim.ts:1950 | **AI 0/38.** | Player orders only. |
| Assault charge | assault branch in `orderTeam`, `assaultRepath` sim.ts:3924, completion sim.ts:2303 | Executes in 8/18 (B06), 1/12 (B14, a woods duplicate), 5/8 (R06). | Chip "ASSAULT" on a selected team. The run and the melee. |
| MG area fire | `areaFire` sim.ts:3210 | Mean 274, median 60 (blue atk). 21/30. | Yes. Tracers. |

### 3.3 Crews and guns

| Behavior | Symbol (file:line) | Fires per battle | Visible to player |
|---|---|---|---|
| Emplaced MG fire | `fireEmplacementSmallArms` sim.ts:1661, `consumeEmplacementAmmo` sim.ts:1608 | **13 bursts for two MG42 tripods. Hard cap 24 per gun. 10 of 24 guns never fired (B14).** M1919 tripod cap 4, measured 2.6 for two guns (R06). | Tracers and audio when it fires. |
| Defensive mortar HE | `maybeDefendHE` ai.ts:730, `fireEmplacementIndirect` sim.ts:1623 | Red def 21 to 37 shells (18/30). Blue def 54 (6/8). | Booms. No incoming warning. |
| Attacker mortar HE | none in attack stance | **0 in 38.** 24 of 36 blue 60 mm tubes never fired at all (B14). | n/a |
| Mortar smoke screen | `maybeSmokeObjective` ai.ts:801, `readyMortar` ai.ts:810 | B06 4.3 missions (12/18). B14 1.4 (4/12). R06 4.5 (7/8). | Yes. Smoke plume. |
| AT gun | `fireEmplacementAt` sim.ts:1643 | Red PaK 0.7 shots (12/30). Blue 57 mm 0.8 (3/8). | Shot line and boom. |
| Crew stays on the gun | `crewNear`, `pickFirer` emplacement.ts:41, 78 | MG42 crew alive with nobody within 4 m in 3% of samples (B14). | n/a |

### 3.4 Vehicles

| Behavior | Symbol (file:line) | Fires per battle | Visible to player |
|---|---|---|---|
| Movement | `orderVehicleMove` sim.ts:1266, `updateVehicle` sim.ts:2518 | One move order per hull per battle. Sherman last moves at median tick 629 (21 s, B14) after about 100 m, then never again. | Hull sprite, dust, ruts. |
| Crush breach | `resolveCrush` sim.ts:2489 | **0 in 38.** | n/a |
| Main gun AP | `updateVehicle` sim.ts:2609 | **0 shots in 38 battles.** AP stays at 30 of 30. The defender never fields armour. | n/a |
| HE and hull MG at infantry | `updateVehicle` sim.ts:2636 | HE 10 to 12, MG 23 bursts (20/30). Nearest infantry inside MG range only. | Yes. Boom, tracers. |
| Destruction and bail-out | `destroyVehicle` sim.ts:2741 | 0.4 attacker hulls lost (10/30). M3 lost in 10 of 20. | Yes. BREWED UP ticker, fire column, audio. |
| Mount, dismount, tow, wheel, pack | `orderMount` sim.ts:1179 and siblings | **AI 0 calls in 38.** Halftracks carry 0 passengers. | Player orders only. |
| Infantry-armour cooperation | none | Does not exist. `updateVehicles` ai.ts:762 sends hulls to the first post once. | n/a |
| Aimed wall breach | `orderVehicleBreach` sim.ts:1413 and siblings | AI 0/38. Incidental blast breaches 6.7 to 8.1. | Breach FX. |

### 3.5 Commander

| Behavior | Symbol (file:line) | Fires per battle | Visible to player |
|---|---|---|---|
| Task groups | `assignGroups` ai.ts:246 | Blue 5 base, 10 maneuver, 9 reserve. Red 13, 5, 5. The 5 blue "base" teams are 2 M1919 and 3 bazooka teams. | No. |
| Base of fire displaces then fires | `runAttack` ai.ts:326, `baseFiringSpot` ai.ts:487, `canEngage` ai.ts:462 | Some base team is settled and firing for a median 8,349 of 54,000 ticks (15%). 2 of 12 battles never (B14). | No. |
| Flank bound | `pickFlank` ai.ts:646 | 505 calls. The "flank" is a 20 m lateral offset at the halfway point, re-derived every 5 s. | No. |
| Fast dash | `runAttack` ai.ts:434 | 104 orders. 33% balk. | No. |
| Assault brief with floor (#130) | `runAttack` ai.ts:422 | See assault row in 3.2. | No. |
| Appraisal divert (#216) | `divertRefusedAssault` ai.ts:660 | 19 (10/18, B06). 8.5 (3/12, B14). 11.5 (6/8, R06). | No. |
| Reserve commit | `commitReserve` ai.ts:634 | 38/38, median tick about 3,300 (1.8 min). Then idle, see 4.3. | No. |
| Culmination and consolidate | `updateCulmination` ai.ts:291, `consolidate` ai.ts:305 | Culminated in 30/38. 56% of consolidate orders balk (B06). | No. |
| Objective progression | `postFor` ai.ts:568, `nextPost` ai.ts:611 | 1.7 objectives taken of 6.2 briefed. | No. |
| Off-map barrage | `maybeBarrage` ai.ts:777 | Exactly 1 per side in 38/38. | Booms. The 20 s marker draws only for the player's own call (`markBarrage` main.ts:1185). |
| Airstrike | no AI caller | **0/38.** Blue AI ends every battle with its airstrike unused. | n/a |
| Defend, ambush, arc | `runDefend` ai.ts:679 | One defend or ambush order per squad at tick 15. | No. |
| Counterattack a lost post | `runDefend` ai.ts:691 | 6 to 10 squad move orders (20/30). 52% balk. It is a walk back to the post. | No. |
| Defender repositioning or withdrawal | none | Does not exist. Median squad drift from its post 3 m. 0.9 squads of 17 ever stray past 15 m. | n/a |
| Armour tasking | `updateVehicles` ai.ts:762 | See 3.4. | No. |
| Breach reaction | `invalidateBreachedSpots` ai.ts:209, `repathNearBreach` sim.ts:2470 | Not measured. | No. |

## 4. Dead and rare behaviors, with evidence

### 4.1 Per-man `rallied` event is unreachable (0 in 38 battles)

`sim.ts:2919` emits `rallied` only when `mental` goes from `pinned` or `broken` to `steady` in one tick.
Pinned needs suppression above 0.5. Steady needs suppression at or below 0.35. Suppression falls only through the decay line at `sim.ts:2904`, at most 0.0023 per tick.
Broken needs morale below 0.25. Steady needs 0.55. Morale rises 0.00013 per tick.
So a man always passes through `shaken`. Measured over 38 battles: 5,175 `pinned` events, 3,394 `pinned` to `shaken` transitions, zero `pinned` to `steady`, zero `broken` to `steady`, zero `rallied` events.
`tests/sim.test.ts:467` passes because it writes `suppression = 0` by hand. This is the forced-precondition trap.
The team-level RALLIED ticker line is alive because it reads live state.

### 4.2 Emplaced MGs burn one belt per burst (cap 24 bursts per battle)

`consumeEmplacementAmmo` (`sim.ts:1608`) removes one ammo unit per shot. For a mortar a unit is a shell. For an MG a unit is a 250-round belt (`data.ts:91`).
A hand-held MG42 spends `magLeft--` per burst and gets 250 bursts per belt (`fireSmallArms` `sim.ts:2842`).
An sMG42 crew holds 12 belts, doubled to 24 by `stockpileAmmo` (`bridge.ts:110`). The gun can fire 24 times. An M1919 tripod crew holds 2 belts, doubled to 4.
Measured (B14, 24 gun-battles): shots per gun 0 to 24, mean 7. For the 9 guns whose crews lost no ammo to deaths, shots + remaining units = 24 exactly. Two guns fired all 24 and stopped at ticks 3,741 and 5,068.
The gunner cannot fall back to his own weapon. The crew gate at `sim.ts:3116` blocks personal fire while the gun is deployed.
The `STOCKPILE_MULT` comment at `bridge.ts:105` ("fired its tubes dry inside 90 seconds") describes this symptom.

### 4.3 The attacker's reserve gets one order per battle

`commitReserve` (`ai.ts:634`) issues one `move` to each reserve team. Reserve teams are not in `maneuverTeamIds`, so `runAttack` never orders them again.
Measured (B14): 9 teams, 50 men, 8.7 orders in total per battle. End states over 12 battles: `none:idle` 102, `move:bounding` 5, `move:balked` 1. 20.9 of the 50 never fire.
For comparison the 10 maneuver teams get 489 orders and lose a median 60 of 60 men.

### 4.4 Order re-issue cancels rescue, aid and succession on the AI side

`pathTo` (`sim.ts:1749`) drops any task when an order paths a man. `runAttack` re-issues `move`, `fast` or `fire` to every base and maneuver team each 5 s eval. Buddy aid needs 8 s (`AID_SECONDS`).
Measured (B14, blue attacking): 31.2 rescue starts, 21.2 cancelled by an order (16.7 on the way, 4.5 during aid). Take-overs cancelled 2.2.
Result: attackers stabilize 3.4 casualties per battle, static defenders 8.3.
A human player gives few orders, so this hits the P-toggle side and the enemy AI. It still removes rescue drama from the side the player watches attack him.

### 4.5 A balked ambush team never fires again

`orderTeam` runs the movement danger ladder for every order kind (`sim.ts:1787`). A balked `ambush` keeps `order.kind = 'ambush'` with `phase = 'balked'`.
`stepOrders` skips balked teams (`sim.ts:2273`), so `checkAmbushTrigger` never runs. The hold-fire gate at `sim.ts:3123` still applies.
`runDefend` re-issues only when the order is `null` (`ai.ts:704`).
Measured: 12 team instances stuck for more than 20 s across 38 battles (4 red, 8 blue defender). Zero shots from any of them while stuck. They took 0 to 10 casualties each. One blue team was mute for 53,985 of 54,000 ticks.

### 4.6 Stationary orders are refused for "open ground"

Same root as 4.5. `fire` orders balk 11 to 15 times per battle and `defend` orders from `consolidate` balk 56% of the time.
A balked `fire` still fires (the fire code reads `order.kind`, not `phase`), so the cost is legibility: the blue ticker prints WON'T ADVANCE for a team told to shoot.

### 4.7 Grenades

10 thrown in 38 battles (5 battles had any). Carried: 18 by blue, 0 by red.
Causes, from the code: one US rifle-team slot carries any (`data.ts:154`). Throws happen only under an executing `assault` order (`sim.ts:2986`). The assault executes in 14 of 38 battles.
#217 passes its tests and is near dead in play.

### 4.8 Drag and carry

34 drags in 38 battles (`findCarryHelper` ran 34 times and found a helper twice). Rescue starts in the same battles: 2,089.
Cause, from the code: the drag starts only when the rescuer arrives with suppression at or above 0.35 and the casualty is not in cover (`sim.ts:3387`). A man that suppressed fails `rescueWillingness` (`sim.ts:3325`) before he sets out, so he arrives calm and aids in place.

### 4.9 Attackers do not go upstairs

Attackers reached an upper floor in 2 of 36 distinct battles (woods seed 1 blue, woods seed 1 red). #130's floor-aware path needs an executing assault onto a multi-storey post.

### 4.10 Armour

- Hulls stop for good at a median 21 s (B14, the set that recorded it) (`ai.ts:766` reads `Object.values(posts)[0]`, a fixed post, not the objective the attack is working).
- AP never fires. The defender is staged with a towed gun and no hull (`bridge.ts:482`), so tank against tank cannot happen.
- Halftracks are empty. The AI has no mount logic. 10 of 20 M3s were lost.
- Crush breaches: 0.

### 4.11 Role and weapon integrity

- `promoteLeader` (`sim.ts:3666`) takes the highest-xp man of any role. Gunner to leader 1.7 per battle, aidman to leader 0.8. The gunner loses `role === 'gunner'`, so `crewAimMult` drops to 0.7 and his death no longer triggers succession.
- `considerPickup` (`sim.ts:3534`) compares ranks, and AT weapons and mortars rank 0 (`sim.ts:495`). A launcher or mortar gunner beside a dropped rifle swaps to it. Measured in 38 battles: bazooka to a rifle or BAR 13 times, Schreck to Kar98k 8, mortar to rifle 22. The mortar gunner also overwrites his shell stock.

### 4.12 Blast size never reaches the renderer

`explode` pushes `{ x, y }` (`sim.ts:2348`). `Boom.r` (`renderer.ts:79`) is always undefined, so `boomScale` returns 1 for a grenade, a tank shell and an 81 mm round alike. Every blast also calls `roofs.noteImpact` and can start a building fire.

### 4.13 AI never uses

Counts over 38 battles: `callAirstrike` 0, team smoke grenades 0, `sneak` orders 0, `orderMount` 0, `orderDismount` 0, `orderHitch` 0, `orderWheel` 0, `orderPack` 0, `orderDeploy` 0, any breach order 0, `queueMove` 0, attacker mortar HE 0.
`TeamOrder.targetId` has no producer (`orders.ts:19`), already recorded in INDEX.md.

### 4.14 Doctrine shape (context for #443)

| Metric | B06 | B14 | R06 |
|---|---|---|---|
| Attacker wins | 2/18 | 2/12 | 0/8 |
| Attacker KIA mean | 77 of 141 | 79 of 141 | 70 of 113 |
| Culminated | 15/18 | 10/12 | 5/8 |
| Objectives taken of briefed | 1.7 of 6.2 | 1.7 of 6.4 | 1.5 of 6.1 |
| Battles with an executed assault | 8/18 | 1/12 | 5/8 |
| Defender foot men who never fire | 46 of 87 | 43 of 87 | 69 of 116 |

Daylight makes the AI attack worse, not better: executed assaults fall from 8/18 to 1/12.

## 5. Defect table

No web-facing code is in scope, so the OWASP top 10 do not apply. No CRITICAL finding.

| Severity | File:Line | Issue | Fix |
|----------|-----------|-------|-----|
| HIGH | src/sim/sim.ts:1608 (`consumeEmplacementAmmo`), :1675 | Emplaced MG spends a 250-round belt per burst. Cap 24 bursts (MG42) or 4 (M1919) per battle. | Give the emplacement a `magLeft` and spend one round-unit per burst, one belt per 250, as `fireSmallArms` does. Then drop `STOCKPILE_MULT` for MGs and re-measure balance. |
| HIGH | src/sim/ai.ts:364, :369, :435, :438 with src/sim/sim.ts:1749 | Unchanged orders are re-issued every 5 s. Each one re-rolls compliance, restarts bounding at element A, re-paths every man and drops rescue, ammo and take-over tasks (21 rescues per battle). | In the commander, skip the call when the team already executes the same kind toward a point within a few metres. Keep `pathTo`'s task drop for real new orders. |
| HIGH | src/sim/ai.ts:634 (`commitReserve`) | Reserve teams get one `move` and are never tasked again. 50 men idle. | On commit, move the ids into `maneuverTeamIds` and seed `startStrength`. |
| MEDIUM | src/sim/sim.ts:1787, :2273, :3123 | A balked `ambush` holds fire forever. 12 mute team instances in 38 battles. | Do not run the movement ladder when the destination is within the team's own footprint, or run `checkAmbushTrigger` for balked ambush teams. |
| MEDIUM | src/sim/sim.ts:1787 | `fire` and `defend` orders are refused for "open ground". False WON'T ADVANCE lines, 56% of consolidate orders balk. | Same guard as above for `fire`, and for `defend` and `ambush` in place. |
| MEDIUM | src/sim/sim.ts:2919 | `rallied` cannot fire. Its FX is dead. | Track the tick a man was last pinned or broken and emit when he reaches `steady` within a window. See upgrade 5. |
| MEDIUM | src/sim/ai.ts:766 | Armour is sent to a fixed first post once and parks after 21 s. | Read the maneuver group's working post (`teamPost`) and re-order when it changes. See upgrade 9. |
| MEDIUM | src/sim/sim.ts:3666 (`promoteLeader`) | Promotion strips the gunner or aidman role. | Prefer riflemen. Fall back to a specialist only when no one else lives. |
| MEDIUM | src/sim/data.ts:154, src/sim/sim.ts:2986 | 18 grenades on one side, thrown only inside an executing assault. 10 thrown in 38 battles. | See upgrade 8. |
| LOW | src/sim/sim.ts:3534 (`considerPickup`), :495 | AT and mortar gunners swap their weapon for a dropped rifle. | Return early when the holder's weapon has `pen`, `arc`, or is an emplacement's served weapon. |
| LOW | src/sim/sim.ts:2348 | Blast radius is not sent with the boom. A grenade draws as a shell. | Push `{ x, y, r: p.fragRadius }`. `addBooms` already accepts `r`. Render-only. |
| LOW | src/sim/ai.ts:248 | Bazooka and Schreck teams count as base of fire (3 of blue's 5). | Classify on `heat` or `arc` only. |
| LOW | src/main.ts:1185 | The barrage marker draws only for a player call. An AI-controlled blue barrage lands unmarked on the player's own screen. | Mark own-side barrages from a sim event. |

## 6. Top 15 upgrades, ranked by visible gain per unit of work

Class 1 = surface an existing behavior. Class 2 = fix a dead or rare one. Class 3 = build a new one.

Determinism ground rules that apply to every sim item below:
- No tactical battle hash is pinned. The only inline snapshots are in `tests/mapgen.test.ts` and `tests/bourg.test.ts`. The war pin (`tests/war-pin.test.ts`) runs the all-coarse loop in `src/strategic/headless.ts`. Tactical sim changes move neither.
- Tactical determinism tests are same-seed A/B comparisons through `snapshot()`. A new mutable field that gates behavior must be added to `snapshot()` (`sim.ts:4349`).
- Any change that adds, removes or reorders a draw on `sim.rng` shifts every later roll in that battle. That is allowed. It makes `scripts/.balance-*.json` stale and can move doctrine-health thresholds (`tests/doctrine.test.ts`, 112 s).
- No test reads the balance baselines. They are already stale by owner decision.

| # | Upgrade | Class | Files | Size | Determinism | Perf at 247 |
|---|---|---|---|---|---|---|
| 1 | **MG belts.** Emplaced MGs fire a full belt of bursts (defect row 1). The tripod MG42 becomes the thing the attack must solve. | 2 | sim.ts (`consumeEmplacementAmmo`, `updateEmplacement`), emplacement.ts, bridge.ts (`STOCKPILE_MULT`) | S, plus a balance pass | Many more shots, so many more draws. Every battle with an emplaced MG changes. Expect blob and doctrine cells to move toward the defender. A new `magLeft` on the emplacement goes in `snapshot()`. | More `suppressAround` and `wound` calls from two guns. Small. |
| 2 | **Stop re-issuing unchanged orders** (defect row 2). Rescues finish, bounding alternates, teams stop re-rolling compliance. | 2 | ai.ts (`runAttack`) | S | No new draws. Paths and compliance timing change, so AI battles change. Doctrine tests that count orders may need new numbers. | Fewer A* searches. A gain. |
| 3 | **Battle ticker for silent events.** New output-only `UnitEvent` kinds at existing transitions: weapon taken over (6.7 per battle), leader replaced (11.6), casualty stabilized (3 to 10), man back on his feet (11), ammo carried up (3). One line each, team-named, with the package A cooldown and drama rules. | 1 | sim.ts (push sites in `updateTakeOver`, `promoteLeader`, `updateRescue`, `updateSoldier`), overlays.ts (`EventPings.add`), audio.ts | S to M | Output only. `pendingUnitEvents` is not in `snapshot()`. Zero outcome change. | Nil. Run `scripts/fxcost.mjs` if FX are added. |
| 4 | **Fix stationary-order refusal** (defect rows 4 and 5). Mute ambush teams fire. WON'T ADVANCE stops lying. | 2 | sim.ts (`orderTeam`, `stepOrders`) | S | No new draws. Defender fire changes in the roughly 10% of battles with a stuck team. | Nil. |
| 5 | **Make `rallied` real.** Add `lastShakenFromPinTick` (or equal) and emit on reaching `steady` within 30 s of a pin or rout. The ring FX and a per-man audio cue start working. | 2 | sim.ts (`updateSoldier`), tests/sim.test.ts (replace the forced test with a natural-decay one) | S | Output only if the new field feeds only the event. Still add it to `snapshot()` if anything else reads it. | Nil. |
| 6 | **Reserve joins the attack** (defect row 3). 50 more men maneuver instead of standing at the start line. | 2 | ai.ts (`commitReserve`, `runAttack`) | S | No new draw sites. Attack outcomes change. Culmination denominator already counts the reserve. | 9 more teams in the eval loop: about 9 more `dangerScore` calls per 5 s. Memoized `visibleEnemies` keeps it small. |
| 7 | **Men go to ground when halted.** `stanceOf` returns crouch for a stationary man whose side holds a contact within about 100 m, and prone when his team is balked or he is suppressed. Attackers stop standing in the open (97% of samples today). | 3 | sim.ts (`stanceOf`), spots.ts (`stanceForKind`), tests/stance*.ts, tests/sight-callers.test.ts | M | No rng. Eye heights change LOS, so who sees and hits whom changes everywhere. Balance re-measure needed. Read intel from `sim.spotted` and `sim.contacts` only (0.5 s cadence) so the answer is stable within a tick. | `stanceOf` is on the LOS hot path. The contact test must be O(1): cache a per-team "contact near" flag in the spotting sweep. Do not scan contacts per call. |
| 8 | **Grenades that get thrown, and seen.** Two per rifleman on both sides. Allow throws from `defend` and `move` teams at a spotted enemy inside 12 m behind cover or in a room. Add an in-flight arc, a GRENADE ticker line, and the real blast radius (defect row 11). | 2 and 1 | data.ts (slots), sim.ts (`maybeThrowGrenade` gate, `explode` push), renderer.ts (arc from a new output event), overlays.ts | M | Two draws per throw on the shared stream, plus frag rolls. Close fights change. The radius and the arc are output only. | `maybeThrowGrenade` scans all soldiers twice. With every rifleman eligible, gate it on `sim.spotted[side]` and the existing 15-tick stagger. Otherwise it is a new O(n²) path (#444). |
| 9 | **Armour that fights with the infantry.** Hull follows the maneuver group's working post, halts about 60 m short behind the lead team, fires HE at the building or post the commander is pressing, and moves up when the post is taken. Halftrack either carries one reserve squad forward or stays back as an MG. | 3 | ai.ts (`updateVehicles`), sim.ts (a point-target HE order beside `wallTarget`) | M to L | HE scatter already draws 2 per shot. More shots, different battles. A new target field goes in `snapshot()`. | Vehicle count is 2. Nil. |
| 10 | **Attacker fire support.** Attack-stance mortar HE on spotted defenders at the working post before the maneuver teams close, lifted when friendlies are inside the safety radius. Use the spare barrage on the post, and the AI airstrike. | 3 | ai.ts (`runAttack`, reuse `maybeDefendHE` cluster and safety code) | S to M | Shell scatter draws already exist per shell. More shells, different battles. | `friendlyHasLos` is O(n) LOS per call. Reuse the per-eval `eyesOn` memo. |
| 11 | **Commander voice.** Ticker or banner lines from commander state the player may know: own AI (P toggle) reserve committed, attack culminated, smoke on the objective. Enemy lines only through what blue sees: "enemy counterattack toward X" when spotted red teams hold a move order toward a blue-held post. | 1 | ai.ts (read-only getters), main.ts (drain block), overlays.ts | S | Reads commander state. Zero sim change. Honest-vision rule: enemy lines must derive from `soldierVisibleTo`, never from commander internals. | Nil. |
| 12 | **Drag under fire.** Start the drag whenever the casualty lies outside cover and his side holds a contact within range, not only when the rescuer is suppressed on arrival. Give the helper search a wider radius. | 2 | sim.ts (`updateRescue`, `findCarryHelper`) | S | No new draws. Rescue timing and positions change. | `findCoverSpot` ring scan per drag. Rare. Nil. |
| 13 | **Role integrity** (defect rows 8 and 10). The gunner keeps the gun, the medic stays a medic, the bazooka man keeps the bazooka. | 2 | sim.ts (`promoteLeader`, `considerPickup`) | S | No draws. Small outcome shifts. | Nil. |
| 14 | **Defenders that move.** A squad whose post is lost or flanked falls back one bound to the next anchor. One uncommitted Gruppe per sector acts as a local reserve and counterattacks a post the attacker has just taken. Emplaced MG crews re-lay the arc when the enemy is outside it. | 3 | ai.ts (`runDefend`), bridge.ts (brief fallback anchors) | L | No new draw sites if it uses existing orders. Defense outcomes change a lot. Fortress-town decision (INDEX 2026-07-28) is affected, so the owner should see the balance delta. | Per-squad eval work, 17 squads per 5 s. Small. |
| 15 | **Rout and surrender that read as human.** Broken men run toward their own rear (`threatAxis`) and gather near the nearest live leader. Isolated men with no ammo or no leader inside 15 m of 3 or more enemies give up without melee contact. | 3 | sim.ts (`flee`, capture trigger in `updateSoldier`) | M | `flee` draws nothing today. Keep it that way. Capture changes strength counts and therefore `winner` timing. | The capture test is an O(n) scan per broken man. Run it on the 90-tick flee cadence, not per tick. |

Not ranked, worth a decision: stage a defender hull or a second AT asset so tank AP and tank-versus-tank can occur at all (`bridge.ts:482`).

## 7. Not confirmed, and where I looked

| Question | Status | Where I looked |
|---|---|---|
| Why half the garrison never fires | Measured (46 of 87). Cause not isolated. Candidates from the code: the 120° `defend` arc in `acquire` (`sim.ts:4243`) hides targets outside it, garrison tiles without a window nook, and the MG ammo cap. | `runDefend`, `acquireSoldierTarget`, probe `neverFired` tally. I did not attribute it per man. |
| Whether bounding looks like fire and movement on screen | Counted only (84 entries, 17,000 team-ticks). The 5 s re-issue restarts element A each eval, so element B may lag. Not viewed in a browser. | `orderTeam`, `continueBounding`, `teamState` transitions. |
| Whether `pickFlank` produces a real flank | Code says a 20 m offset at mid-distance. I did not measure approach bearings. | `ai.ts:646`. |
| Tank-terror effect size | Not counted apart from other suppression. | `updateVehicle` sim.ts:2571. |
| Breach repath and base-spot invalidation liveness | Not instrumented. | `repathNearBreach`, `invalidateBreachedSpots`. |
| Aidman 3× aid speed in play | Not separated from buddy aid. | `aidTimer`. |
| Player-led battles | Not run. All 38 battles have the AI on both sides. Soldier reflex rows carry over. Commander rows for blue do not. | n/a |
| V2 theater battles (`bridge2.ts`) | Read only that it calls `makeStrategicBattle` unmodified (`bridge2.ts:71`). I did not stage through it. | `src/strategic/bridge2.ts`. |
| Night battles at light below 0.25 | Not run. B06 is dawn (light 0.42). | n/a |
| Every legibility claim | From reading render and UI code. No screenshots taken. | renderer.ts, dudes.ts, overlays.ts, hud.ts, tooltip.ts, audio.ts. |
| PaK shell use | The per-gun report did not hook `fireEmplacementAt`, so its "shots" column reads 0 for AT guns. Use the `apShot.atGun` counter instead (0.7 per battle). | probe v3 `empReport`. |

## 8. Files

- Probe scripts and raw results: `scratchpad/audit/ai/` (`ai-liveness-probe*.mjs`, `agg.py`, `agg2.py`, `blueatk-0600-*.jsonl`, `blueatk-1400-*.jsonl`, `redatk-0600-*.jsonl`, matching `.log` files).
- Each jsonl line is one battle: `counts` (every counter), `firstTick` (tick of first occurrence), `tally`, `cmd`, `vehicles`, `stuckTeams`, and in v3 `empReport` and `groups`.
