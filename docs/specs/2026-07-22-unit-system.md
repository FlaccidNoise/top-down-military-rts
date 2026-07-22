# Unit System — 2026-07-22

Design only. Brainstormed with user; six forks confirmed interactively. Composes from the per-soldier atom (body parts, pain, morale, bonds) — nothing here bypasses it.

## Confirmed decisions

1. **Team is the atomic command unit** (3–6 men). A squad is 1–3 teams sharing a leader and bonds; clicking a squad broadcasts the order to its teams. Vehicle crews and crewed-weapon crews are single-team squads — same data shape, no special cases.
2. **National asymmetry = composition + weapon scalars + signature weapon mechanics.** No faction doctrine rules.
3. **Crewed weapons pack/unpack with distributed loads** carried by crew members; AT guns wheeled slowly by crew or towed by vehicles.
4. **Ammo is discrete magazines/belts/clips per soldier.** Reload is a sim event.
5. **Vehicles:** halftracks + StuG III join now (new mechanics); armored cars + light tanks follow as stat-only content.
6. **On-map mortars target any point a friendly sees**; extra scatter without the crew's own LOS. No radio/C2 sim.

## 1. Command model

- **Team**: the thing you click. Has a leader slot, moves as one, takes one order.
- **Squad**: 1–3 teams. Bond pool and named roster live at squad level (campaign persistence). Squad-level click = broadcast same order to all its teams. No combined-behavior magic — that's AI, someday.
- Crew teams (vehicle, emplacement) are squads with one team. `crewOf` binds them to their mount.
- Click budget at full scale: ~18 squads ≈ 24–30 teams/side. Broadcast keeps routine moves at squad granularity; team granularity is opt-in for fire-and-maneuver.

## 2. Squad archetypes

### US (1944 rifle company flavor) — semi-auto firepower, symmetric teams, AT concentrated in teams

| Unit | Teams | Composition |
|---|---|---|
| Rifle Squad (12) | Able (6) / Baker (6) | A: SL (Thompson), BAR + assistant, 3× M1 Garand. B: ASL (M1), 5× M1 Garand. Smoke grenades. No AT. |
| M1919 HMG team (5) | one | Gunner, assistant, 3 ammo bearers (M1 carbines). Serves M1919A4 emplacement. |
| 60mm mortar team (4) | one | Gunner, assistant, 2 bearers. Serves M2 mortar. |
| Bazooka team (2) | one | Gunner (carbine + M9 bazooka), loader. |
| Sniper-scout team (2) | one | M1903A4 sniper, scout (M1). Eyes for the mortar shared-vision rule. |
| 57mm AT gun crew (5) | one | Serves M1 57mm. Wheeled/towed only. |

Degrades gracefully: two symmetric teams, losses hurt evenly. Suppression comes in BAR bursts, not streams. Rifle fire is fast (Garand cooldown ≪ K98).

### German (1944 Grenadier flavor) — MG42-centric, asymmetric teams, AT distributed as ammunition

| Unit | Teams | Composition |
|---|---|---|
| Grenadier Gruppe (9) | MG-Trupp (3) / Schützen (6) | MG: MG42 gunner, assistant (spare barrel), ammo bearer. Rifles: SL (MP40), 5× Kar98k, **2 Panzerfausts distributed among riflemen**. |
| sMG42 team (6) | one | MG42 on Lafette tripod — longer range, sustained fire. |
| 8cm mortar team (5) | one | GrW 34. Heavier bomb, slower setup than US 60mm. |
| Panzerschreck team (2) | one | Gunner, loader. |
| Sniper team (2) | one | Scoped K98, spotter (MP40). |
| PaK 40 crew (6) | one | 7.5cm. Wheeled/towed only. |

The Gruppe **is** its MG42: kill the MG-Trupp and 6 bolt-action rifles remain — toothless. Player learns to hunt the gun; German player learns to protect it. US AT lives in dedicated teams (kill the team, lose the capability); German AT is distributed fausts (survivable but short-ranged, one-shot).

## 3. Signature weapon mechanics

One unifying rule plus three small mechanics — all payoffs of per-soldier sim:

- **Served-weapon rule** (the core): weapons with an `assistant` role degrade without a living, adjacent assistant — MG belt changes take longer, barrel swaps take longer, bazooka/Schreck reload doubles, emplacements below `minCrew` fire slower. One rule covers MGs, rocket teams, and gun crews.
- **Barrel heat** (belt-fed only): heat per burst; over threshold → forced swap (fast with assistant, slow without, accuracy penalty if ignored). MG42 heats ~2× faster than M1919 — its monster suppression is rationed by discipline, not a nerf.
- **Belt vs magazine vs clip**: belts = long bursts, long change gap (assaults live in that gap). Magazines = short frequent reloads. Garand en-bloc: reload discards the part-clip, audible ping hook.
- **One-shot items**: Panzerfaust is ammunition, not a weapon slot — fire it, revert to rifle. Falls out of the discrete-ammo model free.

New weapon keys (national variants replace generic rifle/smg/mg): `garand, carbine, thompson, bar, m1919, kar98k, mp40, mg42, mg42_lafette, springfield_scoped, kar98k_scoped, mortar_60, mortar_81, schreck, pak40_gun, at57_gun, m2hb` (+ existing `bazooka, panzerfaust`).

## 4. Crewed weapons (emplacements)

Reuses the vehicle-crew pattern: emplacement entity + crew team bound by `crewOf`.

- **Loads**: emplacement breaks into carried loads (M1919: tripod/gun/ammo cans; 8cm: tube/bipod/baseplate — historically 3× ~19kg loads). Each load assigned to a crew slot; carrying multiplies stamina drain and caps speed. Casualties drop loads where they fall; any soldier can pick one up. Gun missing a load can't deploy — kill the tripod carrier and the gun is stranded.
- **Setup/teardown timers**: ~30s HMG, ~45–60s mortar, ~60s AT gun. Displacing under fire is a naked gamble — as it should be.
- **AT guns**: not man-packable. Crew wheels at ~1 m/s, or hitch to a `towHook` vehicle (halftrack). Hitch/unhitch are context actions with timers.
- **Indirect fire**: mortar targets any point currently seen by a friendly unit. Scatter radius grows when the crew lacks own LOS. Smoke rounds are the mortar's second job — sustained screens the rifle-squad smoke grenades can't match. Off-map barrage remains the "anywhere" tier above.
- **minCrew**: below it, rate of fire degrades (served-weapon rule); a lone survivor can still fire, badly.

## 5. Vehicles

### Wave 1 — new mechanics
- **M3 halftrack / SdKfz 251**: crew 2 (driver + pintle gunner — M2HB .50 / MG42). Seats a full squad. Mount/dismount as context actions with timers; dismount-under-fire uses existing per-soldier exit logic (vehicle-crew bailout pattern). `towHook`. Open-topped: passengers/gunner exposed to arcing fragments and plunging fire. Armor stops rifle ball, dies to everything AT — a taxi, not a tank. The .50 gives the M3 real teeth vs infantry and German light armor.
- **StuG III G**: casemate — no turret; gun traverse ±12°, hull-turn to track targets. Facing IS the weapon; flanking play becomes mandatory. Cheap German AT that reads period-correct (StuG-heavy Germans vs Sherman-heavy US).

### Wave 2 — stat-only content (no new mechanics)
- **M8 Greyhound** (37mm, fast, thin), **M5A1 Stuart** (37mm light tank), **SdKfz 222** (2cm autocannon), **SdKfz 234/2 Puma** (5cm — fills both German recon and light-armor slots; German light tanks were gone from the line by '44).

Schema additions carrying this: `seats`, `towHook`, `openTop`, `turret: 'full' | degrees`, data-driven `crew` slots (replaces hardcoded 3× SMG crew).

## 6. Capability hooks

### Orders × archetypes (approved vocabulary: move / fast / sneak / fire / smoke / defend / ambush)

| Order | Who shines |
|---|---|
| move | everyone; loaded crews at load-capped speed |
| fast | rifle teams bounding; halftrack dashes. Burns stamina; loaded crews can't |
| sneak | sniper-scouts, AT teams repositioning, faust carriers stalking tanks |
| fire | MG teams' whole reason to exist — sustained area suppression; also concentrates squad fire |
| smoke | rifle squads (grenades, close, brief) and mortars (rounds, far, sustained) |
| defend | arc + hold position: HMG final protective lines, StuG hull-down facing, AT gun kill zones |
| ambush | hold fire until range threshold: fausts, Schreck/bazooka, StuG, snipers |

Mount/dismount, deploy/pack, hitch/unhitch, pick-up-load are **context actions**, not vocabulary — the order list stays tiny.

### Stamina
`fast` burns it; carried loads multiply drain; Winded/Fatigued degrade speed, accuracy, reaction. The assault that sprinted 300m arrives unable to shoot straight. Crew displacement is doubly slow when tired.

### Ammo + runners
Soldier carries `Record<AmmoKey, count>` of discrete units (clips/mags/belts/rockets/shells). MG low on belts → nearest squadmate with spare belts auto-runs resupply; willingness under fire is bond-gated (Firefight's ammo-runner as a bond moment, per amendment #1). Dead men's ammo is pickable. Dry soldiers fall back to pistol/melee/surrender per psychology layer.

## 7. Data model (data.ts schema — units are content, not code)

```ts
type AmmoKey = 'clip_3006' | 'mag_bar' | 'belt_3006' | 'belt_792' | 'clip_792'
  | 'mag_mp40' | 'mag_thompson' | 'rocket_bazooka' | 'rocket_schreck'
  | 'faust' | 'shell_60' | 'shell_81' | 'shell_57' | 'shell_75';

interface WeaponDef {            // existing fields stay
  name: string; range: number; accuracy: number; damage: [number, number];
  cooldown: number; suppression: number; pen?: number;
  ammo: { type: AmmoKey; perUnit: number; reload: number }; // discrete units
  heat?: { perShot: number; swapTime: number };  // belt-fed barrel model
  arc?: { minRange: number; scatter: number; scatterNoLos: number }; // mortars
  oneShot?: boolean;             // panzerfaust: consume item, revert to secondary
}

interface LoadDef { name: string; speedCap: number; staminaMult: number }

interface SoldierSlot {
  role: 'leader' | 'gunner' | 'assistant' | 'rifleman' | 'bearer' | 'driver' | 'sniper' | 'scout';
  weapon: WeaponKey;
  ammo: Partial<Record<AmmoKey, number>>;  // what this man carries, incl. fausts + others' belts
  carries?: LoadKey[];                      // emplacement loads assigned to this slot
}

interface TeamDef { name: string; slots: SoldierSlot[] }

interface SquadDef {              // the roster entry scenarios reference
  name: string; side: 'us' | 'de';
  teams: TeamKey[];               // 1-3; crew squads have exactly 1
  crewOf?: EmplacementKey | VehicleKey;
}

interface EmplacementDef {
  name: string; weapon: WeaponKey;
  setupTime: number; packTime: number;
  loads: LoadKey[];               // empty = not man-packable
  wheeled?: { speed: number };    // AT guns
  towable?: boolean;
  minCrew: number;
}

interface VehicleDef {            // existing fields stay
  name: string; speed: number;
  armor: { front: number; side: number; rear: number };
  gunPen: number; gunAccuracy: number; gunRange: number; gunCooldown: number;
  mgRange: number;
  ammo: { ap: number; he: number }; // added 2026-07-22 (toe-attachments spec): scaled by supply state
  turret: 'full' | number;        // number = traverse degrees (StuG: 12)
  crew: SoldierSlot[];            // replaces hardcoded crew
  seats?: number;                 // transport capacity
  towHook?: boolean;
  openTop?: boolean;
}

interface ForceDef {              // scenario side = list of keys, pure content
  squads: SquadKey[]; vehicles: VehicleKey[]; emplacements: EmplacementKey[];
}
```

Sim consumes keys; adding a unit = adding records. Soldier variation (experience, traits, names, bonds) stays campaign-layer state, never in defs.

## 8. Starter vs someday

**Starter** (everything above): team/squad restructure, national weapons, mags/belts + served-weapon rule + heat, loads + pack/unpack + towing, 6 emplacements, sniper teams, halftracks, StuG. Wave 2 vehicles when wave 1 mechanics exist.

**Someday** (each needs new mechanics — deliberately cut):
- Engineers: breaching, mines, wire, flamethrower (flame panic hook already exists in psychology — note for later).
- Command/HQ teams, radio C2, rally auras.
- Trucks/jeeps, ammo dumps, cross-battle resupply.
- Weight/loot inventory (Gates of Hell style).
- Panther/76mm Sherman escalation tier, off-map variety.

**Balance harness**: every asymmetry claim here is falsifiable via headless 1000-battle runs (Gruppe should collapse when MG-Trupp dies; US squad casualties should degrade linearly; MG42 heat should cap its suppression share).
