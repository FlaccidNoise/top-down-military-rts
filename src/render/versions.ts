// Staleness stamps for baked art (D9).
//
// Every cache in the renderer bakes something expensive against inputs that can
// change mid-battle: a terrain chunk is baked against the edge bytes under it,
// a roof sprite against that building's damage and wall openings, and — once
// the sun starts moving (N4/N5) — everything with a cast shadow in it is baked
// against the sun STEP. There are two shapes of change and both need to be
// cheap:
//
//   ONE artifact changed   — a grenade opened one garden wall.  `bump(key)`
//   EVERY artifact changed — the sun advanced one step.         `bumpAll()`
//
// `at(key)` folds both into a single integer, so a cache entry stores one
// number and a staleness test is one `!==`. That is deliberately the same
// shape `roofs.ts` already had for `dmgVer`/`Baked.ver` — this generalizes it
// rather than adding a second idiom beside it.
//
// The stamp is a monotonic sequence number, NOT a per-key counter, because a
// per-key counter cannot express `bumpAll()` in O(1): the global bump would
// have to walk every key that has ever been touched, and the keyspace for
// terrain chunks is the whole map.
//
// A never-bumped record answers 0 for every key. That is what keeps every
// existing baseline byte-identical: no breach, no sun step, no rebake.
//
// STALE ART KEEPS SERVING. Nothing here evicts anything — it only reports
// disagreement. The owning cache decides when to pay for the rebake, which is
// what lets a sun step (which dirties the entire keyspace at once) drain
// through the existing per-frame bake budget instead of stalling one frame for
// the lot. Getting that backwards — deleting on invalidate — is the single
// mistake this class exists to prevent.
export class Versions {
  private seq = 0;
  private per = new Map<number, number>();
  private all = 0;

  /** The stamp `key`'s art must have been baked at to still be current. */
  at(key: number): number {
    const p = this.per.get(key);
    return p === undefined || p < this.all ? this.all : p;
  }

  /** This one artifact's inputs changed. */
  bump(key: number): void {
    this.per.set(key, ++this.seq);
  }

  /** Every artifact's inputs changed (the sun moved). O(1). */
  bumpAll(): void {
    this.all = ++this.seq;
    this.per.clear();
  }
}
