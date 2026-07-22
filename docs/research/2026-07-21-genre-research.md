# Genre Research: Close Combat-style Tactical Games

Researched 2026-07-21 (web-sourced; citations inline). Raw material for the design in docs/decisions/architecture.md.

## 1. Close Combat series

**Psychology/morale model** — the series' signature feature. Consultant Dr. Steven Silver (combat-trauma specialist) helped build an individual anxiety index per soldier from tiredness, preparedness, combat experience, and past successes ([Vice](https://www.vice.com/en/article/the-best-psychological-wargames-of-the-1990s-were-just-re-released/), [No Dice No Glory](https://nodicenoglory.com/25-year-retrospective-of-the-close-combat-series-part-one/)). Five stacked layers per soldier:
- **Mental state**: Stable (safe) → Cowering (pinned, reduced fire rate/accuracy) → Panicked (near casualties/flamethrowers, overwhelming fire) → Broken/routed (flees uncontrollably or surrenders). Critically, this makes suicidal player orders fail: a "rush" order into the open causes troops to seek cover, refuse orders, or desert rather than comply — a hard behavioral constraint most RTS games don't have.
- **Experience level**: green troops act slower and panic at lower thresholds than veterans.
- **Ammo supply**: individually tracked; troops who run dry may resort to melee or surrender rather than keep fighting.
- **Physical condition**: Healthy / Injured / Incapacitated / Dead, with injured soldiers moving and firing slower.
- **Stamina**: Rested → Winded → Fatigued, degrading movement/reaction speed.
(Source: [No Dice No Glory retrospective](https://nodicenoglory.com/25-year-retrospective-of-the-close-combat-series-part-one/), [Grokipedia](https://grokipedia.com/page/Close_Combat_(video_game)))

**Command interface** (original 1996–2000s titles) — screen split into a scrollable map pane (top) and a command pane (bottom) with distinct "monitors": Team Monitor (lists all teams, color-coded status), Soldier Monitor (per-soldier coping state, weapon, ammo, AT/AP capability), Message Monitor, Map Monitor, and (at 1024×768+) a Spyglass Monitor. Player command vocabulary is deliberately tiny — **move, move fast, sneak, fire, smoke, defend, hide** — plus a control bar for zoom, truce, and surrender. "Sneak" specifically lets a team creep through cover or disengage without breaking silhouette. ([ATPM review](https://atpm.com/4.06/page12.shtml), [GameFAQs](https://gamefaqs.gamespot.com/pc/43349-close-combat-a-bridge-too-far/faqs/19342))

**Line of sight/cover** — real terrain-based LOS, not abstracted fog-of-war: a 2D map with 3D terrain elements (hills, hedges, foxholes, trenches, streams, buildings) that concretely block sight and provide cover/concealment values. ([TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/CloseCombat))

**Pacing** — "pausable real-time": runs continuously but the player can pause at will to issue orders, unlike Combat Mission's rigid WEGO turns.

**Map scale** — a standard Close Combat map is roughly **500m × 500m** ([GameFAQs FAQ](https://gamefaqs.gamespot.com/pc/18717-close-combat/faqs/2181)). Exact per-battle soldier counts not sourced — small-unit scale (platoon/company, dozens to ~100 men per side) is inference, not citation.

**Modern remaster (The Bloody First, 3D "Archon" engine)** — context-menu command interface reviewers call "clunky" for managing several squads; LOS/cover more opaque than the original (reviewer couldn't tell whether fences/hills/treelines blocked vision — [Wayward Strategy](https://waywardstrategy.com/2020/02/19/close-combat-the-bloody-first/)); suppression→break-chance math not surfaced; maps small relative to weapon ranges; all forces deploy at start (no reinforcement trickle — reviewer preferred this); elevation modeling praised; smoke has no effectiveness feedback; house-occupancy bonuses unclear; surrender mechanics unexplained.

## 2. Firefight (Sean O'Connor)

Pitched explicitly as Close Combat brought up to date ([ModDB](https://www.moddb.com/games/firefight-sean-oconnor)). Distinguishing mechanics:
- **Physics-simulated vehicles**: tanks have gears, rev counters, speedometers, brake-lever differential steering.
- **Projectile simulation**: every bullet, shell, and shrapnel fragment modeled in 3D, ricochets realistically off sloped surfaces.
- **Individual soldier detail**: rank, name, weapon, remaining ammo, heart rate, fatigue all visible per-soldier; machine gunners call for ammo when low, and squadmates carrying spares run it over.
(Source: [A Wargamer's Needful Things](https://www.awargamersneedfulthings.co.uk/2016/09/firefight-fom-sean-oconnor.html), [Save or Quit](https://saveorquit.com/2016/12/16/review-firefight/))

**Fan-praised: scale balance.** Firefight's compromise between tank visual size and map distance "feels" more right than Close Combat's (windowsgames.co.uk forum). Cover behavior praised: soldiers spread naturally across 2–3 houses.

**Criticized**: passive enemy AI (shells then withdraws, never counterattacks); attack-only mission variety; unexplained UI (status-bar colors, no OOB/briefing); mobile-first click-drag camera on desktop with no keyboard panning; no post-battle replay; no persistent soldier-info panel; no melee. ([Steam thread](https://steamcommunity.com/app/500190/discussions/0/4358998287110954306/), [windowsgames forum](http://www.windowsgames.co.uk/forum/viewtopic.php?t=491))

## 3. Other reference points — one steal each

- **Combat Mission (WEGO)**: replay-the-last-turn from any angle lets players understand what happened without perfect real-time attention. ([Battlefront forums](https://community.battlefront.com/topic/72005-initial-impressions-wego-vs-realtime/))
- **Graviteam Tactics**: operational-to-tactical handoff — turn-based operational map determines which real-time tactical fights occur. Praised for sim depth, hammered for UI/onboarding. ([manual](https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/549080/manuals/0927ddab8973c2301b71f9d90298883cc032a2e8/GT_Manual_eng_04.pdf))
- **Men of War / Gates of Hell**: lootable per-soldier inventory (ammo, bandages, grenades) as resource-scarcity lever; direct-control mode for any unit. ([NamuWiki](https://en.namu.wiki/w/Gates%20of%20Hell))
- **Door Kickers**: mid-execution re-planning — pause at any point during live execution, redraw plans, resume, incl. slow-motion. Original used a custom in-house engine ([GDC Vault](https://gdcvault.com/play/1023350/Rolling-Your-Own-Tech-The)).
- **Running With Rifles**: proof a solo dev can ship a persistent top-down infantry sandbox at scale. ([Wikipedia](https://en.wikipedia.org/wiki/Running_with_Rifles))
- **Regiments (2022)**: platoon-as-atomic-unit reduces micromanagement without losing tactical texture; ~20-minute battles; scarce cross-battle resupply forces attrition decisions. ([Matchsticks for my Eyes](https://www.matchstickeyes.com/2022/09/18/regiments-elegant-focused-cold-war-tactics/))

## 4. RimWorld health model (portable numbers)

- **Manipulation**: losing a finger = −5%; each arm = 50% of manipulation; arm at half HP performs at 50% (−25% overall).
- **Moving**: losing a toe = −4%; **moving < 15% → fully incapacitated**.
- **Sight**: losing one eye = −50%; feeds shooting accuracy.
- **Consciousness**: aggregate meta-capacity; **< 30% → unconscious; 0% → death**.
- **Pain**: ~1.25% pain per 1 HP damage; pain > ~10% starts degrading consciousness; **pain shock threshold ~80% → downed regardless of physical capacity**. Destroyed parts stop generating pain; damaged parts hurt until healed.
(Sources: [Health](https://rimworldwiki.com/wiki/Health), [Body Parts](https://rimworldwiki.com/wiki/Body_Parts), [Consciousness](https://rimworldwiki.com/wiki/Consciousness), [Pain](https://rimworldwiki.com/wiki/Pain), [Downed](https://rimworldwiki.com/wiki/Downed))

**Adaptation angle**: wound → capacity loss → behavior change, not wound → HP bar. Pain-shock gives a non-lethal "combat-ineffective right now" state distinct from both morale-break and death — a gap Close Combat's coarse 4-state physical track doesn't cover.

## 5. Community complaints / genre wishlist

**Close Combat remasters**: #1 persistent complaint is **AI quality** ("utter junk"; vehicles idle or drive off without infantry; AI got *more* passive across the series — CC2's AI attacked, CC3–5's crawls). Pathfinding "wonky" — strange detours, soldiers wandering behind enemy lines. Bloody First: clunky context menus, no visual command feedback, LOS-tool frame drops, ~51% positive on Steam, and **no persistent unit experience across campaign missions** (a named structural gripe). ([Steam threads](https://steamcommunity.com/app/811880/discussions/0/1631916887494358628/), [Wayward Strategy](https://waywardstrategy.com/2020/02/19/close-combat-the-bloody-first/))

**Firefight**: passive AI, thin mission variety, UI assuming prior knowledge, mobile-first controls on desktop.

**Net wishlist**: deep soldier simulation + **legible feedback** (surface the hidden math: suppression→morale, cover→to-hit) + **AI that actually maneuvers/counterattacks**. That combination is essentially unfilled in the genre.

Caveat: community material is from Steam Community / Battlefront / Matrix / windowsgames forums, not Reddit — Reddit threads didn't surface in search.

## 6. Tech landscape

Unity is the precedented choice (Regiments, Door Kickers 2); Godot the lightweight 2D-native alternative; Bevy/ECS worth considering only when agent count and sim complexity dominate. Door Kickers 1 shipped on a fully custom engine — precedent for hand-rolling. Our choice (TS/Canvas, custom headless sim) sits in the Door Kickers-1 tradition.
