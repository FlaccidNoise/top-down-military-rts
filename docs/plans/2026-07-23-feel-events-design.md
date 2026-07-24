# Feel-ceiling event shapes — design for sim-session coordination

Status: PROPOSED (renderer session). Sim session: please review/implement the two sim-side
items; renderer work is blocked on them and will follow in a later pass. Everything here
keeps the sim headless-pure — no render imports, no new tick work beyond field writes at
sites that already exist.

## 1. ShotEvent gains shooter identity (sim, trivial)

```ts
export interface ShotEvent {
  shooterId: number; // NEW — sim.ts emit site already holds the shooter (e)
  weapon: WeaponKey; // NEW — e.weapon at the same site
  fx: number; fy: number; tx: number; ty: number;
  hit: boolean; kill: boolean;
}
```
Emit site sim.ts (`pendingEvents.push({ fx: e.x, ... })`) has both values in scope.

Renderer consumption (not sim's concern):
- **Recoil kick**: ~120ms wall-clock sprite nudge on `shooterId`, opposite the fx→tx bearing,
  amplitude by weapon class (MG > rifle > pistol). Pause-safe: transient VFX on wall-clock
  per renderer invariants.
- **Shell casings**: per shot, brass flecks ejected right of the bearing with a ~150ms hop,
  then stamped into the existing decal canvas (Math.random fine — one-shot stamps). Count
  by weapon (rifle 1, MG 3–5/burst). Cap live casings; decals persist.
- **FOW gating**: `soldierVisibleTo(shooterId)` — same pattern as MeleeEvent fighter ids.

## 2. Death cause persisted on the soldier (sim, small)

Corpses persist and get discovered later, so pose variety must live on the record, not in a
transient event:

```ts
// Soldier fields, written once at the kill site:
deathCause?: 'shot' | 'boom' | 'melee';
deathDirX?: number; deathDirY?: number; // unit vector of the killing impulse
```
Kill sites: small-arms resolution, explosion damage, melee kill — each already knows the
direction (shot bearing / soldier−boom delta / attacker−victim delta).

Renderer consumption: death-pose bake variants keyed `deathCause + hash(id)` — shot =
crumple (current pool pose), boom = thrown sprawl displaced along the impulse, melee =
tangled fall; orientation from the dir vector. Missing fields (old saves, coarse resolver)
fall back to the current pose — renderer must not assume presence.

## 3. Camera language (renderer-only, no sim change)

Boom within ~40m of view center → 150ms decaying shake, 1.5–3px by proximity; cap stacking
at 4px. Nothing else shakes (restraint is the point — MG fire stays still so booms land).

## Explicitly rejected

- Per-tick "soldier is firing" state polling — event shape above already carries it.
- Death events with pose data — corpses outlive the event queue (FOW discovery).
- Camera work in sim — camera is presentation; sim stays headless-pure.
