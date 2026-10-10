# Defilade research (as of 2026-10-09)

## 0. Verdict on identity, and where the brief is wrong

Defilade exists. One game matches: **Defilade by RBGames, Steam app 5246700**. I found no other video game of that name (see "Where I looked").

The brief I was given differs from the sources on four points. Treat the owner's description as a memory of the trailers, not a spec.

| Brief said | Sources say | Source |
|---|---|---|
| World War II | Modern warfare (T-90, Leopard, Bradley, BMP, Hind, FPV drones). Fictional "blue vs red" proxy war. | [Steam page](https://store.steampowered.com/app/5246700/Defilade/); [interview 15:10-18:45](https://www.youtube.com/watch?v=XkLaJb5v6VE&t=910s) |
| Top-down | Isometric. 3D scene, orthographic camera. | Interview 9:45: "going 3D with an orthographic isometric perspective" |
| New 2026 release | Not released. Steam page went live 2026-09-21. Status "Coming soon". No price. | [Steam API](https://store.steampowered.com/api/appdetails?appids=5246700) |
| Simulation RTS / tactics | Base-building RTS (FOBs, supply trucks, barracks, factories) with tactics-grade infantry AI on top. | Steam page |

No reviews exist. Every claim below about quality comes from the developer, from trailer frames, or from viewers of trailers. Nobody outside a private Discord playtest has played it.

Confidence labels: **STATED** = a source says it. **SEEN** = I saw it in a screenshot or trailer frame. **INFERRED** = my reading. **UNCONFIRMED** = no source.

## Sources used

| Tag | Source | Type |
|---|---|---|
| S | [Steam store page](https://store.steampowered.com/app/5246700/Defilade/) / [appdetails API](https://store.steampowered.com/api/appdetails?appids=5246700). Full "About" text retrieved verbatim. | Developer |
| I | [50-min developer interview, perafilozof, 2026-10-04](https://www.youtube.com/watch?v=XkLaJb5v6VE). YouTube auto-captions; "GDAU" in captions = Godot. | Developer |
| V | [17-min dev gameplay video "deep AI cover mechanics", 2026-09-27, 706k views](https://www.youtube.com/watch?v=utx3ikZpeR0). Auto-captions plus top 80 of 1,242 comments. | Developer + viewers |
| T | Steam trailer, 218 s. I pulled 55 frames (one per 4 s). 5 Steam screenshots. | Visual |
| N | [Niche Gamer, 2026-10-05](https://nichegamer.com/defilade-tops-100000-wishlists/) | Press (rewrites Steam page) |
| D | Steam discussions: [trust thread](https://steamcommunity.com/app/5246700/discussions/0/570423993959629603/), [AI/vibe-coded thread](https://steamcommunity.com/app/5246700/discussions/0/583936001036119703/), [interview thread](https://steamcommunity.com/app/5246700/discussions/0/583936001036103172/) | Players |
| A | [Steam announcements](https://steamcommunity.com/app/5246700/allnews/) | Developer |

Local evidence: `scratchpad/audit/raw/` (`shots/ss1-5.jpg`, `trailer/sheet_01-07.jpg`, `trailer/ui_grid.jpg`, `yt/interview_clean.txt`, `yt/cover_transcript.txt`, `yt/cover_comments.txt`).

## 1. Identity

| Item | Finding | Source | Conf. |
|---|---|---|---|
| Developer / publisher | RBGames, self-listed as both. Solo developer, part-time; day job is music producer. | S; I 11:18, 47:32 | HIGH |
| Engine | Godot. Earlier tech demo was Unreal; some Unreal Niagara effects were exported into Godot. | I 14:31-15:06 (caption "GDAU", "open source"); D (user Ibuprofen says Godot) | HIGH |
| Platform | Windows, macOS. Min spec GTX 750 Ti, Vulkan. Mobile and console "looking at". | S; I 1:57 | HIGH |
| Release state | Unreleased. Demo "hoping end of this month" (October 2026). Early access sooner if self-published; Jan-Apr 2027 if a publisher is signed. No date promised. | I 12:54-14:08, 44:36 | HIGH |
| Price | Not set. | S (price_overview null) | HIGH |
| Camera | 3D scene, orthographic isometric. Zoom varies widely across trailer shots (radar shows "ZOOM 0.7x"). First prototype was 2D sprites with 3D units; abandoned because cover on sprites needed faked invisible blocks and "didn't look right". | I 8:53-9:56; T | HIGH |
| Camera rotation | No source. All trailer shots of the same village share one orientation. | T | UNCONFIRMED |
| Art style | Low-detail 3D models, strong directional sun, long hard shadows, saturated biomes (desert, snow, grassland with river). Developer wants the 1990s sprite-RTS look. Close shots show depth-of-field blur at frame edges. | T, S screenshots; I 7:10 | SEEN |
| Traction | 12k wishlists in 17 h, 70k in week 1, 100k in under 2 weeks. | A | HIGH |

## 2. Visual and physical effects

What is visible in the frames (SEEN), plus what the developer states.

| Effect | What it looks like | Source |
|---|---|---|
| Explosions | Three layers: white-hot core, orange fireball with dark roiling edges, then a tall dark smoke column that lingers. Spark and debris-chunk spray. Several blast types on screen at once (HE, vehicle cook-off with vertical flame jet, airburst spikes). Developer: "a lot of new explosion effects"; "I can just watch these explosions the whole day". | T sheets 1-5; ss1, ss3, ss4; V 3:58, 11:47 |
| Bomb overpressure | Translucent expanding dome/ring around a bomber's payload. Interviewer singles it out. | T sheet 1 frame 9; I 22:58 |
| Smoke | White launch puffs, grey impact dust, black burn smoke, each distinct. Smoke grenades make thick white clouds that hide men; soldiers throw them to cover rescues. | T sheets 2-3, 6; S; V 11:40, 13:36 |
| Rocket and missile trails | Long white trails built from a chain of puffs, crossing the whole frame. They dominate the wide shots. Helicopter flares fan out as bright dots with trails. | T sheets 1, 3, 4 |
| Tracers | Short thick orange-yellow streaks. Dense fans of them from helicopter guns. | ss4, ss5; T sheet 2 |
| Ricochets | Tank rounds bounce off armour, fly off, and explode where they land. Developer admits it may not be realistic: "I think it looks cool." | S; V 12:50-13:14 |
| Death and hit reactions | Blast throws soldiers; some get up dazed and stumble. Flinch on nearby explosion. A viewer asks for ragdolls, which implies deaths are canned animations today. | S; V comment @vince140055 |
| Blood | Red pools and smears under casualties. Developer calls one rescue "pretty gruesome". | T sheets 5-6; V 11:00 |
| Ground persistence | Craters with scorch rims stay. Vehicle track marks stay. Footprint trails in snow and sand stay. | ss1, ss2; T sheet 6 |
| Destruction | RPG makes a hole in a wall and troops use it as a door. Buildings collapse when supports go. Bridges collapse. Trees fall. Cover objects are destroyed. Tanks drive through walls. Trenches are not destructible yet; terrain deformation for crater cover is planned, "not a guarantee". | I 35:27-36:09, 33:59; S; ss3 (roofless shell), T sheet 6 (broken wall) |
| Lighting and shadow | One low sun. Every tree, wall, man and helicopter casts a long shadow. Helicopter shadows on the ground sell altitude. Strong bloom on sunlit walls near blasts (ss3); whether fire casts dynamic light is UNCONFIRMED. | ss2-5; T sheet 4 |
| Building interiors | Roof goes invisible when troops are inside. Toggle between floor 1 and 2. | I 36:25-36:57 |
| Weather | Snow biome exists as a map type. No falling snow or rain seen or stated. | S ss2, ss4 |
| Camera work | Trailer cuts between very wide and very close shots. Whether close shots are playable zoom or capture-only is UNCONFIRMED. Screen shake: UNCONFIRMED (stills only). | T |
| Sound | Unit barks ("Ready, sir", "Moving out", "Affirmative") audible in captions. Wounded scream for a medic. Drones are audible to soldiers. Viewers praise explosions and sound; one says gunfire is "muffled bass" and wants a sharp crack. Soundtrack by the developer. I did not analyse audio. | V 3:32, 4:54; S; V comments |

## 3. AI and emergent behaviour

All STATED by the developer unless marked. Viewers cite this section, not the graphics, as the reason they care.

| Behaviour | Detail | Source |
|---|---|---|
| Shape-based cover | Soldiers "check the shapes around them". Any wall, crate, car, wreck, trench, window. Low wall: crouch and pop up to fire. Tall wall: move to the corner and lean out. Ruins and leftover walls count. | S; I 36:18 |
| Suppression | Near misses pin them in place. Pinned men may ignore orders "because they value their lives". | S; V 11:13 |
| Order refusal | Sometimes refuse to run into a line of fire and look for another route; sometimes comply. "It's all about the calculation." | I 40:05-40:50 |
| Ammo | Low ammo: switch to single shots, lose suppressive fire. Empty: run back to FOB or ammo truck, or surrender. Loot ammo from bodies. | S; I 31:03-31:26; V 0:54-1:16 |
| Wounded rescue | Man goes down screaming, bleeds out, crawls to cover if able. Squad lays covering fire; one drags him by the shoulders; another walks backwards firing; the wounded man fires his pistol while dragged. Smoke sometimes thrown first. Hit behind cover: treated in place. Each revival leaves him weaker. | S; I 37:04-37:36 |
| Stretcher bearers | From a medic tent, two men carry a stretcher; if one is shot the other drags. A nearby rifleman will pick up the empty end. Recovered men limp back to base. All automatic. | S; I 37:42-38:50; V 2:10-3:16 |
| Surrender and prisoners | Rare. Conditions: cut off, under fire, squad down. Throws rifle, hands up. Prisoners are walked away and give live intel shown in a chat dialog. | S; V 4:08, 15:54 |
| Grenades | Sometimes pick up and throw back. Dive away. | S |
| Movement | Vault walls, slide into cover, fight hand to hand. | S |
| Squad talk | Soldiers announce intent to each other ("we have to flank left"); commands sometimes clash. Shown as optional speech bubbles. | I 32:27-32:44; V 10:23-10:56 |
| Flanking | Infantry try to avoid a flanking tank and flank it back. Press says flanking reduces cover value (N only; not on Steam page). | I 32:18; N |
| Veterancy | Promotion for kills, heals, captures. Veterans cannot be re-bought. Higher rank gives better squad cohesion (planned). | I 41:57-42:47; V 4:43-5:30 |
| Helicopters | Own "little brain": flares on missile lock, evasive manoeuvres. Pilot ejects and can be recovered with rank intact. | I 23:14-23:51; V 9:33-9:59 |
| Enemy commander | Plays by the same rules, attacks FOBs. Rebel AI digs tunnels, booby-traps and collapses them unscripted. | S; I 16:17-17:13 |
| What viewers call smart | Self-preservation, less babysitting, drag-rescue, corner peeking, hand gestures. Top comment (833 likes): soldiers "have agency and can take actions to preserve themselves". | V comments |

## 4. Command and UI model

| Item | Finding | Source | Conf. |
|---|---|---|---|
| Design stance | Player is a commander giving broad orders. "Leave the actual micromanagement to the AI soldiers because they are aware more than you can actually know." Micro stays possible. | I 23:55-26:30; V 12:02 | STATED |
| Stances | Two: default (free behaviour around the ordered spot) and defend (hold exact spot). Right-click to choose. Rebels get ambush. Prone is experimental. | I 31:50-33:50 | STATED |
| Ghost preview | In defend stance, hovering a position shows a ghost of where each unit will take cover. | I 33:00-33:17 | STATED |
| Move orders | Selected group shows thin lines fanning to one destination ring per man. Vehicles show selection ellipses and an icon tag with 4-pip bar. | T frame at 0:26 (`trailer/f26.jpg`) | SEEN |
| Squads | Today units are trained and commanded individually. Planned: select men, press a key, they become one squad unit; highest rank leads. | I 42:25-44:28 | STATED |
| Unit cap | About 100 per side, hardware-dependent. Cover perception is the CPU cost. | I 34:19-35:27 | STATED |
| HUD (trailer) | Almost bare. Bottom-left: "MEN 22", "AIR STRIKE [B]". Above it a three-line feed: "KIA PVT REYES - GUNNER", "PROMOTED PFC NIELSEN", "KIA PFC NIELSEN - ROCKET - 2 DOWN". A roster card: "SECTION 1 / 18 MEN / ADVANCE", one row per man with rank, surname, and a status such as "UNDER FIRE". UI can be hidden entirely. | T (`trailer/ui_grid.jpg`, `f26.jpg`); V 4:18 | SEEN |
| HUD (base mode) | Right-hand "COMMAND" panel: supply counter, "1 LINK STABLE", circular "SECTOR RADAR" minimap, tabs BASE / DEF / INF / ARMOR, picture cards with cost, "CAN'T AFFORD" state. Top banner "VILLAGE UNHELD +30%". Bottom-left unit chips: "SECTION 1 - 6 MEN +2 DOW", "HIND - HOLDING". | ss2 | SEEN |
| Text density | Low. Short uppercase labels, named men, no paragraphs on screen. Inline hints only: "CLICK MOVES VIEW - DOUBLE-CLICK EXPANDS", "BUILD RESEARCH TO GO LIVE", "[B] ORDERS", a "?" beside SUPPLY. | ss2, ss5 | SEEN |
| Speech bubbles | World-space bubbles over soldiers ("KEEP BREATHING!"). Optional toggle. They are the game's explanation of AI intent. | ss2; V 10:23 | SEEN + STATED |
| Tutorial / onboarding | No source mentions a tutorial. | - | UNCONFIRMED |
| Pacing | Developer slowed movement after feedback that men were "jumping and rolling too much". Viewers approve (306 and 117 likes). | V 10:06; V comments | STATED |

## 5. Strategic / campaign layer

| Item | Finding | Source | Conf. |
|---|---|---|---|
| Design | Turn-based dynamic campaign on one large fictional map. Evolving front line. East vs West with one or two rebel factions between; alliances with rebels. An AI commander runs the enemy side of the map. Holding map assets (e.g. an airfield) cuts costs in battles there. Zoom into real-time battles. References named: Battleplan, Total War. | I 0:24-1:11, 3:52-4:45 | STATED |
| Persistence | Soldiers level up, carry between missions, permadeath. | S | STATED |
| State | Not built. "Still a lot of implementation needed." Core game "70% there". | I 4:30-4:50 | STATED |
| How the map looks | No image or description exists. | - | UNCONFIRMED |
| In-battle economy | Three resources: manpower (regenerates, faster per capture point held; 3 points per small map), supplies, ammo. FOBs auto-link by road; trucks run it; cutting the road starves forward FOBs. | I 29:17-31:35; S | STATED |

## 6. What players criticise

No reviews exist; these are pre-release reactions.

| Criticism | Source |
|---|---|
| Suspicion that it is AI-generated or "vibe coded": all footage appeared within about two months, no team or engine named on the store page. No developer reply in the threads. | D ([thread](https://steamcommunity.com/app/5246700/discussions/0/583936001036119703/)) |
| Scope versus a solo part-time developer; unknown track record. 29-reply thread "why should I trust you?". | D |
| Earlier builds too fast and twitchy. Fixed, per developer. | V 10:06 |
| Medics run into fire to save one man; should wait for fire superiority. | V comment @user-sg3wp2qs2b |
| Assaulting AI does not push into and clear trenches. Players want a "stand ground vs assault" switch. | V comments @Astrozi (129 likes), @ChristopherMundahl |
| Tanks do not face front armour to the threat. | V comment @ChristopherMundahl |
| Gunfire sounds muffled. | V comment @JamesRinereArt |
| FPV drones split playtesters; there is an off switch. | I 18:54-19:24 |
| No ragdolls. | V comment |
| Developer admits "still some glitches". | V 6:01 |
| Requests, not complaints: more languages, map editor, controller support, bigger maps. | D thread list |

## 7. Transfer to a 2D plan-view Canvas game

"Direct" = same thing works. "Analogue" = needs a plan-view substitute, named. "3D" = depends on true 3D. These are my judgments (INFERRED).

### Behaviour and simulation (the part viewers praise most)

| Feature | Transfer | Note |
|---|---|---|
| Shape-based cover, low wall vs tall wall | Direct | Give cover geometry a height class. Low: man snaps to the wall line, alternates a "down" and "up" sprite. Tall: man walks to the segment end and slides half a body past the corner to fire, then back. In plan view the corner lean reads better than in isometric. |
| Pinning and flinch | Direct | Dirt-kick puffs around the man, sprite drops to prone, short jitter on near blast. |
| Order refusal when pinned | Direct | Needs a visible reason at the unit (bubble or icon), or it reads as a bug. |
| Ammo discipline (single shots when low) | Direct | Audible as cadence change. Cheap and legible. |
| Drag rescue with covering fire and smoke | Direct | Two linked sprites, rescuer facing backwards, a blood-smear decal trail. This is the single most-quoted moment in comments. |
| Wounded crawl, weaker after each revival | Direct | |
| Stretcher party | Direct | Only if the game models an aid post. |
| Conditional surrender, prisoners marched off | Direct | Close Combat tradition already has surrender; Defilade adds the walk-off and the stated conditions. |
| Grenade throw-back, dive away | Analogue | Grenade drawn with a growing-then-shrinking shadow for arc; dive is a fast displacement tween into a prone sprite. |
| Blast throw and dazed stumble | Analogue | Push the sprite along the blast vector with spin, hold prone, then a slow wandering state. No ragdoll needed. |
| Vault and slide | Analogue | Brief speed change plus sprite swap at the obstacle line. Low value in plan view. |
| Squad intent talk | Direct | Short world-space bubbles ("Flank left", "Medic!"). Make them optional. This is how Defilade makes its AI readable. |
| Ricochet that deflects and bursts | Direct | A tracer that changes angle at the hull with a spark is native to plan view. |
| Track hit immobilises | Direct | |
| Helicopter and drone behaviours | Not applicable | Out of period for WW2. |

### Effects

| Feature | Transfer | Note |
|---|---|---|
| Layered explosion (flash, fireball, dark smoke, sparks, debris) | Analogue | Same layers as sprites or particles, seen from above: flash disc, ragged fire bloom, smoke that expands and drifts with wind instead of rising up-screen. Offset the smoke from its ground shadow to imply height. |
| Distinct smoke colours by cause | Direct | White for launch and smoke rounds, grey dust for impact, black for burning. |
| Smoke that blocks sight and is used tactically | Direct | |
| Long puff-chain rocket trails | Direct | Mostly a modern-weapons look. WW2 analogue: Panzerfaust and bazooka back-blast and trail, rocket artillery, mortar arcs. |
| Thick short tracers | Direct | |
| Overpressure ring | Analogue | Expanding faint ring plus brief grass or dust ripple. True refraction needs a shader, not Canvas 2D. |
| Persistent craters, scorch, track marks, footprints, blood | Direct | Draw once to an offscreen decal layer. This is what makes a Defilade map look fought-over at the end. |
| Long cast shadows from a low sun | Analogue | One global sun vector; every object with a height gets a skewed dark shape. Plan view cannot show wall faces, so shadows carry all the height information. |
| Glow and bloom around fire and blasts | Analogue | Additive radial glow sprite ("lighter" composite). |
| Wall breach used as an entrance | Direct | Wall segments with hit points; a gap changes pathing and line of sight. |
| Building collapse, falling trees, bridge collapse | Analogue | Roof sprite swaps to rubble under a dust burst; tree sprite rotates to lie along the blast vector; rubble becomes new low cover. |
| Roof fade and floor toggle | Direct | Already a plan-view convention. |
| Depth-of-field on close shots | 3D | Skip. |
| Oblique cinematic close-ups, visible vertical flame jets and smoke columns | 3D | Plan view cannot show vertical extent. Do not chase it. |
| Skeletal animation (lean, drag, hand signals) | 3D for fidelity; analogue for meaning | Pose sprites at 3-5 states per man convey the same information. |
| Sound: barks, screams, sharp weapon reports | Direct | Viewers reacted to sound as much as to visuals. |

### Command and UI

| Feature | Transfer | Note |
|---|---|---|
| Two stances: free behaviour vs hold exactly | Direct | |
| Ghost preview of each man's cover spot on hover | Direct | Strong fit for touch: show ghosts while the finger is down. |
| Per-man destination rings on a group move | Direct | |
| Named-soldier feed (KIA, PROMOTED, kill tally) | Direct | Three lines, fades. Attaches the player to individuals with almost no text. |
| Roster card with per-man status | Direct | Collapse on phone. |
| Near-empty HUD, hide-UI toggle | Direct | |
| Slower pace so behaviour can be watched | Direct | Developer changed this on feedback and it was the best-received change. |
| Base building, FOB roads, supply trucks | Does not fit | Different genre from a company-level tactical sim. The ammo-runs-out consequence transfers; the economy does not. |
| Campaign map | No evidence to copy | Not built, never shown. |

## Open questions

1. Is Defilade the reference the owner meant, given it is modern and isometric, not WW2 and top-down? I found nothing else by that name. Ask the owner which video they watched.
2. Camera rotation, screen shake, and whether trailer close-ups are playable zoom: unconfirmed. A frame-by-frame pass over the trailer video (saved locally) could settle shake.
3. Audio: I did not listen. Sound claims rest on captions and comments.
4. Tutorial or onboarding: no source.
5. Campaign map appearance: no source.
6. Reddit: the developer says the game first got attention there (I 10:26). Reddit blocked both search and direct fetch, so I read no Reddit threads.
7. Demo is targeted for end of October 2026. Hands-on impressions after that would replace most of the STATED rows with tested ones.

## Where I looked

- Found and read: Steam store page and API, Steam announcements, Steam discussions (3 threads), developer YouTube channel (11 videos; 2 transcripts, 80 comments), Niche Gamer, cooltrailertracker.com, Patreon page (one public post, no detail), Steam trailer frames and screenshots.
- Found, low value: fan wikis defilade.wiki and defiladewiki.com (unsourced, not used for any claim); a GameStar video on Dailymotion (title only: developers show how AI soldiers add realism).
- Blocked: reddit.com (search tool and direct request both refused), a third-party transcript site (403).
- Not found: itch.io page; any WW2 game named Defilade; any hands-on press preview; PC Gamer, RPS, PCGamesN coverage.
- Not checked: Discord (invite-only content), X account posts, Ko-fi.
