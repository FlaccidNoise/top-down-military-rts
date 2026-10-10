import type { Emplacement } from '../sim/emplacement';
import { smokeAxisAt } from '../sim/wind';
import { MELEE_STRIKE_RANGE, stanceOf, type BoomEvent, type BreachEvent, type MeleeEvent, type ShotEvent, type Side, type Sim, type Soldier, type UnitEvent, type Vehicle } from '../sim/sim';
import { gunOf, tapsOf } from './audio';
import type { Camera } from './camera';
import { DecalLayer } from './decals';
import { bandFor, CRAWL_FRAMES, DUDE_SCALE, getShadowSprite, getSprite, glintSprite, headOffset, kitVariant, SPRITE_MIN_SCALE, SPRITE_SPAN, tier, WALK_FRAMES, weaponClass, type Pose } from './dudes';
import { emplacementBandFor, emplacementFootprintRadius, emplacementSpan, getEmplacementShadow, getEmplacementSprite } from './emplacements';
import { ballistic, blastOf, blastScale, blit, FLASH, flashClass, fxDetail, fxScale, hazeBand, hotPass, SPIKE_SIDES, traceOvershoot, WIND, type BlastSpec, type FlashSpec, type FxKind, type Overshoot } from './fx';
import { SUN, shadowSoftAlpha, sun } from './light';
import { MarkLayer } from './marks';
import { PallLayer } from './pall';
import { craterSpots } from './props';
import { RoofLayer } from './roofs';
import { TerrainLayer } from './terrain';
import { MOBILE, view } from './view';
import { getVehicleShadow, getVehicleSprite, occBucket, trackGauge, turretBlob, turretCenter, vehicleBandFor, VEHICLE_SPAN } from './vehicles';

// One ShotEvent is one abstracted attack. An automatic weapon's attack is a
// burst, drawn as `taps` rounds `gap` ms apart — the same two numbers the
// audio layer voices it with (audio.ts gunOf/tapsOf).
interface Tracer extends ShotEvent {
  at: number; // ms timestamp
  over?: Overshoot; // misses only: where the round actually came down
  taps: number;
  gap: number; // ms between taps
  life: number; // ms until the last tap's dust has settled
}

interface ShotGeom {
  x1: number;
  y1: number;
  ux: number;
  uy: number;
  mx: number;
  my: number;
  hx: number; // per-shot hash seed (impact coords), stable for the shot's life
  hy: number;
}

// Render-only per-soldier state (facing, gait phase). The sim has no facing;
// it is derived here from movement and target direction, then smoothed.
interface RState {
  facing: number;
  phase: number; // gait cycles (1 per stride pair)
  px: number;
  py: number;
  smx: number; // last blood-smear deposit position (dragged casualties)
  smy: number;
  wasAlive: boolean; // latches the permanent death blood-pool stamp to a single transition
  // What drawSoldier last actually drew. The cast-shadow pass runs BEFORE it
  // (shadows must fall under every body, not on one), and re-deriving the pose
  // there would advance the gait phase twice per frame — so it reads these
  // instead. One frame of lag on a shadow is invisible; a double-speed walk
  // cycle is not.
  pose: Pose;
  frame: number;
  wx: number; // drawn position (a dragged casualty trails behind his rescuer)
  wy: number;
  dfacing: number; // drawn facing, including the dead man's per-id jitter
}

// Render-only per-vehicle state (U7), mirroring the soldier `rs` map. Every
// motion cue here is driven by the ODOMETER, not by wall-clock: `dist` only
// grows when the hull actually moves, so a paused game freezes the track
// churn, the dust and the rut stamping exactly like it freezes a walk cycle.
interface VState {
  px: number;
  py: number;
  dist: number; // metres travelled, the clock for everything below
  dust: { x: number; y: number; at: number }[]; // ring buffer, `at` in odometer metres
  di: number; // ring write index
  puffAt: number; // odometer of the last puff
  markAt: number; // odometer of the last rut stamp
}

const DUST_RING = 6;
const DUST_EVERY = 0.5; // m of travel per puff
const DUST_LIFE = 2.5; // m of travel a puff survives
const MARK_EVERY = 0.7; // m of travel per rut stamp
const TRACK_PITCH = 0.16; // m of travel per track-phase step

interface Boom {
  x: number;
  y: number;
  at: number;
  spec: BlastSpec; // the recipe for its kind (fx.ts BLAST)
  k: number; // its size against that recipe's reference radius
  landed: number; // bitmask of debris chunks whose grit decal is already stamped
}

// A barrage is a dozen rounds and each now hangs for five to nine seconds. The
// oldest are thin smoke by the time the cap is reached, so they go first.
const MAX_BOOMS = MOBILE ? 14 : 36;

// Pall density one round adds at the muzzle (pall.ts). Thirty-odd rifle shots
// from one spot, or seven MG42 bursts, fill a puff.
const PALL_PER_ROUND = 0.03;

// A weapon that has been firing. A live firefight has only a handful of rounds
// in the air in any one frame, so between them the field went quiet; this is
// what stays at the source. `heat` rises with every round and cools over a
// second or two, and while it is up the muzzle trails a wisp of gun smoke — an
// MG that has been working for ten seconds is visibly a firing position even
// between bursts. Keyed by the shooter when the sim names him, by where the
// muzzle was otherwise (an emplaced gun, a hull).
interface Firing {
  x: number; // muzzle, world
  y: number;
  ux: number; // bearing of the last shot
  uy: number;
  heat: number; // 0..1 at `at`
  at: number; // ms of the last shot, fx clock
  seen: boolean; // fog answer, re-tested on the fires' throttle
  seenTick: number;
}
const HEAT_PER_ROUND = 0.2;
const GUN_COOL_MS = 2200; // heat's time constant
const MAX_FIRING = MOBILE ? 16 : 40;

interface Plane {
  x0: number;
  y: number;
  x1: number;
  at: number;
}

// The moment a wall opens (D12). The debris goes along the wall's NORMAL, both
// ways: a charge in a wall throws stone into both the room and the street, and
// which side the burst was on is not something the render channel is told.
interface BreachFx {
  x: number; // edge midpoint, world
  y: number;
  nx: number; // unit normal, the axis the stone flies along
  ny: number;
  wide: boolean;
  at: number;
  k: number; // hash key — stable, so the same breach throws the same stone every frame
}
const BREACH_MS = 1300;

// One-shot punctuation for the sim's morale crossings (sim.ts UnitEvent).
// Nothing here is a particle system: three blits off the baked fx atlas, aged
// on the same fxNow clock as every other transient, so they freeze under pause.
interface MoraleFx {
  kind: 'pinned' | 'rallied' | 'ambush';
  x: number;
  y: number;
  at: number;
  k: number; // stable hash key — the same puff scatters the same way every frame
}
const MORALE_MS: Record<MoraleFx['kind'], number> = { pinned: 380, rallied: 520, ambush: 320 };
// Hard concurrent cap, the MAX_VOICES pattern (audio.ts): one barrage pins a
// platoon in a single tick and every man would want his own puff. Overflow is
// dropped silently — eight men going down already reads as "the line broke",
// and the alternative is a frame that spends its whole budget on dust.
const MAX_MORALE_FX = MOBILE ? 6 : 10;

// A thing on fire. One record serves both causes: a building stoked by booms
// that landed inside it (key = buildingId), and a vehicle the sim says is
// burning (key = -1000 - vehicle id, `vid` >= 0). There is no fire in the sim
// — a building fire is purely cosmetic, render-derived from blasts the player
// could see land, and it always burns itself out.
//
// Two clocks, deliberately: LIFETIME runs on sim.tick (like barrageMarks), so
// pausing the game cannot burn a house down; FLICKER runs on wall-clock `now`,
// because 30 Hz sampling makes a flame visibly step.
interface Fire {
  key: number; // buildingId, or -1000 - vehicle id — also the per-fire hash stream
  x: number;
  y: number;
  vid: number; // >= 0 → vehicle brew-up; -1 → building
  born: number; // sim tick of first ignition
  tick: number; // sim tick of the most recent stoke
  hits: number; // blasts feeding it — sets the ceiling on intensity
  seen: boolean; // fog-of-war result, re-tested on a throttle (LOS is not free)
  seenTick: number;
}

const FIRE_LIFE_S = 90; // sim seconds a building burns after its last stoke
const FIRE_FADE_S = 25; // ...of which the last N are a dying smolder
const FIRE_CAP = 12; // a barraged village must not light every house at once
const FIRE_SEEN_TICKS = 15; // 0.5 s between fog re-tests per fire
const FIRE_POOL_ALPHA = 0.09; // warm ground pool — zero this to revoke the second light source
const BREWUP_FULL_S = 14; // a brewed-up tank rages this long...
const BREWUP_SETTLE_S = 45; // ...then settles to a smoking hulk by here
const BREWUP_FLOOR = 0.3;

// Startled birds — the cheapest "this world is alive" beat available: six
// primitives each, only ever off a blast in or beside woods, hard-capped.
interface Bird {
  x: number;
  y: number;
  dir: number;
  at: number; // ms, wall-clock
  phase: number; // wingbeat offset
}

const BIRD_MS = 1900;
const PULSE_W = (2 * Math.PI) / 1200; // rad per ms — the pinned ring breathes once every 1.2 s
const BIRD_CAP = 24;
const BIRD_SPEED = 11; // m/s

const HAZE_MAX_SCALE = 22; // px/m — above this you can count boots and haze is just fog on the lens
const MOTE_MIN_SCALE = 20;
const MOTE_CAP = 24;

// Positive modulo — the wrapping every world-anchored ambient layer needs, and
// the thing `%` alone gets wrong the moment wind drift goes negative.
function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

const PLANE_MS = 2600;
const BLAST_FLASH_MS = 70; // the white flash of any blast
const SPARK_MS = 900; // longest a blast's sparks fly
const FADE_MS = 150; // faint thread lifetime
const TRAVEL_MS = 90; // muzzle->target travel time for the bright segment (E3)
const IMPACT_MS = 250; // impact dust lifetime, starts at TRAVEL_MS (E5)
const SHOT_MS = TRAVEL_MS + IMPACT_MS; // one round's whole life, muzzle to settled dust
const CHUNKS: FxKind[] = ['chunk0', 'chunk1', 'chunk2', 'chunk3'];

const TEAM = { blue: '#5b9bd5', red: '#d05c50' } as const;

// How far each body's shadow steps down-sun. The house convention (roofs.ts:
// 0.71 m of offset per 3 m story) is a heavily foreshortened cast, so a
// 1.75 m man throws 0.42 m and a 2.4 m hull 0.58 m — not the geometric length
// a 40-degree sun would imply. The azimuth itself is computed per frame in
// drawUnitShadows (N6): the sun moves, and a module constant is the stale
// snapshot light.ts's header forbids.
// Poses drawn without a helmet on the head — nothing for the glint to sit on.
const BAREHEAD = new Set<Pose>(['dead', 'surrender2']);
const HULL_SHADOW_OFF = 0.58;
// A 30-tonne hull blocks more light than a man does: the soft-layer alpha the
// soldiers use reads as a smudge under something this big.
const HULL_SHADOW_ALPHA = 0.22;
// A gun on a mount stands about as tall as a kneeling man, so it steps down-sun
// less than a hull does and gets the soldiers' soft alpha, not the hull's.
const EMPL_SHADOW_OFF = 0.35;
const SHADOW_OFF: Record<Pose, number> = {
  idle: 0.42,
  walk: 0.42,
  aim: 0.42,
  reload: 0.42,
  melee: 0.42,
  surrendered: 0.42,
  surrender2: 0.42,
  drag: 0.42,
  kneel: 0.3,
  aid: 0.3,
  crawl: 0.12,
  prone: 0.12,
  downed: 0.12,
  dead: 0.12,
  dead1: 0.12,
  dead2: 0.12,
  dragged: 0.12,
};

import { hash } from './noise';

// The human player is always US/blue (same convention as hud.ts and
// tooltip.ts); fog of war is rendered from this side's knowledge.
const PLAYER_SIDE: Side = 'blue';

// Floor-badge label cache: level→"floor N" string, filled lazily so the
// per-frame hot path allocates nothing.
const FLOOR_BADGE_LABEL: string[] = [];
function floorBadgeLabel(level: number): string {
  return (FLOOR_BADGE_LABEL[level] ??= String(level + 1));
}

export class Renderer {
  private terrain: TerrainLayer;
  private roofs = new RoofLayer();
  private tracers: Tracer[] = [];
  private meleeFx: (MeleeEvent & { at: number })[] = [];
  private rs = new Map<number, RState>();
  private vrs = new Map<number, VState>();
  private deadVehicles = new Set<number>(); // scorch stamped once, on first dead frame
  private lastNow = 0;
  private fxClock = 0; // set once per draw(): the pinnable cosmetic clock overlay pulses read
  private booms: Boom[] = [];
  private breaches: BreachFx[] = [];
  private moraleFx: MoraleFx[] = [];
  private moraleSeq = 0;
  private decals: DecalLayer;
  private marks = new MarkLayer();
  private pall = new PallLayer();
  private firing = new Map<number, Firing>();
  private barrageMarks: { x: number; y: number; tick: number }[] = [];
  private strafeMarks: { x: number; y: number; tick: number }[] = [];
  private planes: Plane[] = [];
  private fires = new Map<number, Fire>();
  private lit: Fire[] = []; // this frame's visible fires, shared by the cool and hot passes
  private licks: number[] = []; // flat (x, y, r, alpha) quads — flame cores queued for the fire hot pass
  private birds: Bird[] = [];
  private boomSeq = 0;
  private haze: { x: number; y: number; len: number; hgt: number; a: number }[];
  hazeOn = true; // ?haze=0, matching the ?fow=0 debug-switch pattern
  // ?flicker=0 pins the hearth-glow clock, same debug-switch pattern. A scene
  // with a lit hearth in it can never go pixel-still (two incommensurate sine
  // rates off wall-clock `now`), so the art gate's settle loop cannot converge
  // and those crops are not reproducible baselines. Pinned, the fire is still
  // lit and still varies hearth-to-hearth (the phase is a position hash) — it
  // just holds one frame.
  flickerOn = true;
  selectedVehicle = -1;

  constructor(private sim: Sim) {
    // Buildings, not just the map: telling a churchyard from a farm cour and a
    // shop from a house needs `role`, which lives on the plan and nowhere in
    // the grid. Legacy kinds emit no roles, so those maps behave as before.
    this.terrain = new TerrainLayer(sim.map, sim.buildings);
    this.decals = new DecalLayer(sim.map.w, sim.map.h);
    // Five world-anchored haze bands, generated once from the map dimensions
    // so the same map always breathes the same way.
    this.haze = Array.from({ length: 5 }, (_, i) => ({
      x: hash(sim.map.w, sim.map.h, 300 + i) * (sim.map.w + 140),
      y: hash(sim.map.w, sim.map.h, 310 + i) * sim.map.h,
      len: 70 + hash(sim.map.w, sim.map.h, 320 + i) * 70,
      hgt: 9 + hash(sim.map.w, sim.map.h, 330 + i) * 15,
      a: 0.06 + hash(sim.map.w, sim.map.h, 340 + i) * 0.06,
    }));
    // Weathered shell holes from an earlier fight, under everything this
    // battle will add — a fresh scorch still has to read as new.
    for (const [x, y, seed] of craterSpots(sim.map, this.terrain.index)) this.decals.oldCrater(x, y, seed);
  }

  addEvents(events: ShotEvent[], now: number): void {
    for (const e of events) {
      const gun = gunOf(e.weapon);
      const taps = tapsOf(gun);
      const gap = (gun.spacing ?? 0) * 1000;
      const t: Tracer = { ...e, at: now, taps, gap, life: (taps - 1) * gap + SHOT_MS };
      // Powder smoke where it was fired from, dust where it landed. A tracer
      // is drawn ungated, but it is gone in a tenth of a second; haze over a
      // firing position stays for twenty, so it is fog-tested. The shooter is
      // the exact test when the sim names him, the point otherwise.
      const shooter = e.shooterId !== undefined ? this.sim.soldiers[e.shooterId] : undefined;
      const muzzleSeen = (): boolean => (shooter ? this.sim.soldierVisibleTo(PLAYER_SIDE, shooter) : this.pointSeen(e.fx, e.fy));
      this.pall.feed(e.fx, e.fy, PALL_PER_ROUND * taps, now, this.sim.tick, muzzleSeen);
      this.pall.feed(e.tx, e.ty, PALL_PER_ROUND * 0.6 * taps, now, this.sim.tick, () => this.pointSeen(e.tx, e.ty));
      this.noteFiring(e, taps, now, muzzleSeen);
      // A miss has to land somewhere past the target — resolve it once, here,
      // rather than 48 edge tests per frame for the shot's whole life.
      if (!e.hit) {
        const h = hash(Math.round(e.tx * 100), Math.round(e.ty * 100), 61);
        const o = traceOvershoot(this.sim.map, e.fx, e.fy, e.tx, e.ty, h);
        t.over = o;
        if (o.kind === 'wall') {
          if (h < 0.34) this.marks.add(o.x, o.y);
        } else if (h < (o.kind === 'foliage' ? 0.17 : 0.125)) this.decals.grit(o.x, o.y);
      }
      this.tracers.push(t);
    }
  }

  addMeleeEvents(events: MeleeEvent[], now: number): void {
    for (const e of events) {
      // fog of war: no fleck or blood smear at a fight the player can't see
      const seen = this.sim.soldierVisibleTo(PLAYER_SIDE, this.sim.soldiers[e.attackerId]) ||
        this.sim.soldierVisibleTo(PLAYER_SIDE, this.sim.soldiers[e.victimId]);
      if (!seen) continue;
      this.meleeFx.push({ ...e, at: now });
      if (e.hit) this.decals.smear(e.x, e.y, Math.random() * Math.PI * 2);
    }
  }

  addBooms(booms: BoomEvent[], now: number): void {
    for (const b of booms) {
      this.boomSeq++;
      const { spec, k } = blastOf(b);
      this.booms.push({ x: b.x, y: b.y, at: now, spec, k, landed: 0 });
      if (this.booms.length > MAX_BOOMS) this.booms.shift();
      // What the blast leaves in the air once its own smoke has gone. Ungated,
      // like the blast itself.
      this.pall.feed(b.x, b.y, Math.min(1, ((0.25 + 0.5 * spec.dust + 0.3 * spec.smoke) * spec.fire * k) / 2.2), now, this.sim.tick);
      this.decals.scorch(b.x, b.y, spec.crater * k);
      this.roofs.noteImpact(b.x, b.y); // roof damage is render-derived from the same detonation, never from sim HP
      // Ignition is render-derived: a blast inside a building footprint is the
      // only cause of a building fire, because that is the only cause the
      // player watched happen.
      const bid = this.sim.map.buildingIdAt(Math.floor(b.x), Math.floor(b.y));
      if (bid >= 0) this.stoke(bid, b.x, b.y, -1);
      this.flush(b.x, b.y, now);
    }
  }

  // A wall the sim just opened. Deliberately NOT routed through addBooms: that
  // path stamps a scorch and punches a roof hole, and a crushed fence is not a
  // crater. What it does instead is the three things that make the hole real —
  // it tells the baked art the map changed, it dirties the enclosure index, and
  // it throws the stone.
  //
  // The invalidation is unconditional and must stay that way: a breach the
  // player cannot see still changed the map, and a chunk that is never marked
  // stale is never rebaked, so the wall would come back the moment the fog
  // lifted. Only the PARTICLES are transient.
  // Morale crossings, already fog-filtered by the caller exactly as the event
  // pings are — a German breaking behind the hedge throws no dust the player
  // has no business seeing. Every other kind (kia, downed, ping, ...) is the
  // ping feed's and the audio layer's business, not the renderer's.
  addUnitEvents(list: UnitEvent[], now: number): void {
    for (const e of list) {
      if (e.kind !== 'pinned' && e.kind !== 'rallied' && e.kind !== 'ambush') continue;
      if (this.moraleFx.length >= MAX_MORALE_FX) return; // at the cap: drop, silently
      this.moraleFx.push({ kind: e.kind, x: e.x, y: e.y, at: now, k: this.moraleSeq++ });
    }
  }

  addBreaches(list: BreachEvent[], now: number): void {
    if (list.length === 0) return;
    for (const b of list) {
      const mx = b.horiz ? b.x + 0.5 : b.x;
      const my = b.horiz ? b.y : b.y + 0.5;
      this.terrain.invalidateEdge(b.x, b.y);
      this.roofs.noteBreach(b.x, b.y, b.horiz);
      const nx = b.horiz ? 0 : 1;
      const ny = b.horiz ? 1 : 0;
      // Spill on the ground either side of the opening, and chipped stone
      // round the lip — the two decal layers already built for exactly this.
      for (const s of [-1, 1]) {
        this.decals.grit(mx + nx * s * 0.55, my + ny * s * 0.55);
        this.marks.add(mx + nx * s * 0.3 + ny * 0.2, my + ny * s * 0.3 + nx * 0.2);
      }
      this.marks.add(mx, my);
      this.breaches.push({ x: mx, y: my, nx, ny, wide: b.wide, at: now, k: Math.round(mx * 8) * 977 + Math.round(my * 8) });
    }
    // Once for the batch, not once per edge: it re-derives the whole
    // free-standing index, and a barrage delivers four breaches at a time.
    this.terrain.breachEnclosures();
  }

  // Heat the weapon this shot came from (see Firing).
  private noteFiring(e: ShotEvent, taps: number, now: number, seen: () => boolean): void {
    const d = Math.hypot(e.tx - e.fx, e.ty - e.fy);
    if (!(d > 0)) return; // also drops a NaN bearing
    const ux = (e.tx - e.fx) / d;
    const uy = (e.ty - e.fy) / d;
    // Soldier ids are >= 0, so a position key goes below zero.
    const key = e.shooterId ?? -1 - (Math.round(e.fx * 2) * 4099 + Math.round(e.fy * 2));
    let f = this.firing.get(key);
    if (!f) {
      if (this.firing.size >= MAX_FIRING) {
        let cold = key;
        let least = Infinity;
        for (const [k, o] of this.firing) {
          const h = o.heat * Math.exp(-(now - o.at) / GUN_COOL_MS);
          if (h < least) {
            least = h;
            cold = k;
          }
        }
        this.firing.delete(cold);
      }
      f = { x: 0, y: 0, ux, uy, heat: 0, at: now, seen: false, seenTick: -1e9 };
      this.firing.set(key, f);
    }
    if (this.sim.tick - f.seenTick >= FIRE_SEEN_TICKS) {
      f.seen = seen();
      f.seenTick = this.sim.tick;
    }
    f.heat = Math.min(1, f.heat * Math.exp(-(now - f.at) / GUN_COOL_MS) + HEAT_PER_ROUND * taps);
    f.at = now;
    f.x = e.fx + ux * 0.9; // the same barrel length shotGeom puts the flash at
    f.y = e.fy + uy * 0.9;
    f.ux = ux;
    f.uy = uy;
  }

  // The wisp a working weapon trails. Three puffs on staggered two-second
  // lives, pushed off the muzzle and carried on the wind, so a hot gun smokes
  // steadily where a single shot only puffs.
  private drawGunSmoke(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    if (this.firing.size === 0) return;
    const F = fxScale(cam.scale);
    for (const [key, f] of this.firing) {
      const heat = f.heat * Math.exp(-(now - f.at) / GUN_COOL_MS);
      if (!(heat >= 0.03)) {
        this.firing.delete(key);
        continue;
      }
      if (!f.seen) continue;
      const [mx, my] = cam.worldToScreen(f.x, f.y, cw, ch);
      if (!this.onScreen(mx, my, cw, ch, 4 * F)) continue;
      const a = 0.45 * Math.min(1, heat * 1.6);
      // Three even on a phone: two puffs this size are two discs, three overlap
      // into a streak.
      for (let j = 0; j < 3; j++) {
        const ph = mod(now / 1800 + j / 3 + hash(key, 0, 620), 1);
        const out = 0.4 + ph * 0.5;
        const drift = ph * 1.6;
        blit(ctx, 'smoke', mx + (f.ux * out + WIND.dx * drift) * F, my + (f.uy * out + WIND.dy * drift) * F, (0.3 + ph * 0.6) * F, a * Math.sin(ph * Math.PI));
      }
    }
  }

  // Fog test for an effect anchored to a point rather than to a man.
  private pointSeen(x: number, y: number): boolean {
    return this.sim.fowDisabled || this.sim.sideSeesPoint(PLAYER_SIDE, x, y);
  }

  // Put birds up if this blast landed in or beside woods. The 1-in-2 gate is
  // what stops a barrage in a forest turning the sky into a flock; the boom
  // counter is in the key so a repeatedly shelled copse is not a permanent
  // dead zone the way a position-only hash would make it.
  private flush(x: number, y: number, now: number): void {
    const sx = Math.round(x * 10);
    const sy = Math.round(y * 10);
    if (this.birds.length >= BIRD_CAP || hash(sx, sy, 71 + (this.boomSeq % 7)) >= 0.5) return;
    let woods = false;
    for (let j = -7; j <= 7 && !woods; j += 3.5)
      for (let i = -7; i <= 7; i += 3.5) {
        if (this.sim.map.terrainKeyAt(Math.floor(x + i), Math.floor(y + j)) === 'woods') {
          woods = true;
          break;
        }
      }
    if (!woods) return;
    const n = 3 + Math.floor(hash(sx, sy, 78) * 4);
    for (let i = 0; i < n && this.birds.length < BIRD_CAP; i++) {
      this.birds.push({
        x: x + (hash(sx, sy, 400 + i) - 0.5) * 6,
        y: y + (hash(sx, sy, 410 + i) - 0.5) * 6,
        dir: hash(sx, sy, 420 + i) * Math.PI * 2,
        at: now,
        phase: hash(sx, sy, 430 + i) * 6.28,
      });
    }
  }

  // Two strokes and a shrinking ground shadow. Wall-clock: a bird is not part
  // of the sim, and freezing one mid-air under pause would look broken.
  private drawBirds(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    this.birds = this.birds.filter((b) => now - b.at < BIRD_MS);
    // Below civil twilight there are no birds to flush (N14, design §11) —
    // a startled flock over a 02:00 battlefield reads as a bug, not ambience.
    // The filter above still drains the array, so dusk strands no stale flock.
    if (sun().el < -6) return;
    if (this.birds.length === 0 || fxDetail(cam.scale) < 1) return;
    const S = cam.scale;
    const wing = Math.max(4, S * 0.45);
    const lw = Math.max(1.2, S * 0.05);
    for (const b of this.birds) {
      const secs = (now - b.at) / 1000;
      const t = secs / (BIRD_MS / 1000);
      const [gx, gy] = cam.worldToScreen(b.x + Math.cos(b.dir) * BIRD_SPEED * secs, b.y + Math.sin(b.dir) * BIRD_SPEED * secs, cw, ch);
      if (gx < -40 || gy < -40 || gx > cw + 40 || gy > ch + 40) continue;
      const climb = t * 3.5 * S;
      const fade = Math.min(1, (1 - t) * 3);
      ctx.fillStyle = `rgba(20,17,12,${0.22 * (1 - t)})`;
      ctx.beginPath();
      ctx.ellipse(gx, gy, S * 0.12, S * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
      const half = 0.75 + 0.35 * Math.sin(now * 0.022 + b.phase);
      const back = b.dir + Math.PI;
      const y0 = gy - climb;
      ctx.beginPath();
      ctx.moveTo(gx + Math.cos(back - half) * wing, y0 + Math.sin(back - half) * wing);
      ctx.lineTo(gx, y0);
      ctx.lineTo(gx + Math.cos(back + half) * wing, y0 + Math.sin(back + half) * wing);
      // Pale under-stroke then the dark bird on top: a dark chevron alone
      // vanishes against a canopy, which is exactly where birds are flushed.
      ctx.lineWidth = lw + 1.8;
      ctx.strokeStyle = `rgba(228,224,208,${0.4 * fade})`;
      ctx.stroke();
      ctx.lineWidth = lw;
      ctx.strokeStyle = `rgba(30,27,22,${0.9 * fade})`;
      ctx.stroke();
    }
  }

  // Light or feed a fire. The ignition point never moves once set: a second
  // shell in the same house makes the fire angrier, not relocated.
  private stoke(key: number, x: number, y: number, vid: number): void {
    const f = this.fires.get(key);
    if (f) {
      f.tick = this.sim.tick;
      f.hits = Math.min(3, f.hits + 1);
      if (vid >= 0) {
        f.x = x;
        f.y = y;
      }
      return;
    }
    this.fires.set(key, { key, x, y, vid, born: this.sim.tick, tick: this.sim.tick, hits: 1, seen: false, seenTick: -1e9 });
    if (this.fires.size <= FIRE_CAP) return;
    let oldest = -1;
    let oldestTick = Infinity;
    for (const [k, e] of this.fires) {
      if (k !== key && e.tick < oldestTick) {
        oldestTick = e.tick;
        oldest = k;
      }
    }
    if (oldest !== -1) this.fires.delete(oldest);
  }

  // Call-in feedback: rounds take 20 s (barrage) / 25 s (strafe) of SIM time
  // to arrive — markers expire on sim ticks so pausing doesn't strand them.
  markBarrage(x: number, y: number): void {
    this.barrageMarks.push({ x, y, tick: this.sim.tick });
  }

  markStrafe(x: number, y: number): void {
    this.strafeMarks.push({ x, y, tick: this.sim.tick });
  }

  addPlanes(planes: { x0: number; y: number; x1: number }[], now: number): void {
    for (const p of planes) this.planes.push({ ...p, at: now });
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, selectedSquads: number[], now: number, floorFocus = -1): void {
    const cw = view.w;
    const ch = view.h;
    // Roof-fade dt uses wall-clock time: a static reveal like interiors must
    // not depend on the sim clock (fxNow freezes under pause/deployment).
    const realNow = performance.now();
    const dt = Math.min(0.1, (realNow - this.lastNow) / 1000);
    this.lastNow = realNow;
    // The cosmetic clock every overlay pulse reads: fxNow, so it stops with the
    // sim, and pinned to 0 by ?flicker=0 exactly like the hearth glow below —
    // an animated tell on an unpinnable clock is what made art crops
    // unsettleable in the first place (#134, the class #278 tracks).
    this.fxClock = this.flickerOn ? now : 0;
    ctx.fillStyle = '#161510'; // darker desaturated earth tone off-map, replacing the flat void
    ctx.fillRect(0, 0, cw, ch); // backdrop stays unshaken so shake never opens a gap at the map edge
    ctx.imageSmoothingEnabled = true;

    // Camera shake: world layers only (HUD/picking stay steady — worldToScreen
    // is untouched). Stateless, derived from recent booms' screen proximity plus
    // a faint tremor from fresh nearby fire. Wall-clock, so it decays under pause.
    const [shx, shy] = this.worldShake(cam, now, cw, ch);
    ctx.save();
    ctx.translate(shx, shy);

    this.prewarm(cam.scale);
    this.terrain.draw(ctx, cam, cw, ch);
    const [mx0, my0] = cam.worldToScreen(0, 0, cw, ch);
    const [mx1, my1] = cam.worldToScreen(this.sim.map.w, this.sim.map.h, cw, ch);
    ctx.strokeStyle = 'rgba(18,16,12,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(mx0, my0, mx1 - mx0, my1 - my0);
    this.decals.draw(ctx, cam, cw, ch);
    this.marks.draw(ctx, cam, cw, ch);
    this.roofs.update(this.sim, cam, dt || 1 / 60);
    this.roofs.drawShadows(ctx, cam, cw, ch);
    this.roofs.drawWalls(ctx, cam, cw, ch);
    // interior lighting and stair glyphs, only where the roof fade reveals them
    this.terrain.drawHearthGlow(ctx, cam, cw, ch, this.flickerOn ? now : 0, (x, y) => this.roofs.interiorVisibleAt(x, y));
    this.terrain.drawStairs(ctx, cam, cw, ch, (x, y) => this.roofs.interiorVisibleAt(x, y));
    // One sun (U2): cast shadows go down after the decals they fall across and
    // before every unit, so no man's shadow lands on another man's back.
    this.drawUnitShadows(ctx, cam, cw, ch, floorFocus);
    // Ambient air sits over the ground (and the shadows on it) and under the
    // men — a haze band in front of a soldier would read as a bug, behind him
    // it reads as distance.
    this.drawHaze(ctx, cam, cw, ch);
    this.drawMotes(ctx, cam, cw, ch);

    // Fog of war: everything below asks the sim's *VisibleTo helpers from the
    // player's side — the renderer never re-derives vision.
    const vis = (s: Soldier) => this.sim.soldierVisibleTo(PLAYER_SIDE, s);
    const visV = (v: Vehicle) => this.sim.vehicleVisibleTo(PLAYER_SIDE, v);
    // Travel dust goes down as its own pass, before ANY hull: a puff thrown by
    // one tank must not be painted over by the tank itself and must not paint
    // over the tank parked next to it.
    for (const v of this.sim.vehicles) if (v.alive && visV(v)) this.drawVehicleDust(ctx, cam, v, cw, ch);
    for (const v of this.sim.vehicles) if (!v.alive && visV(v)) this.drawVehicle(ctx, cam, v, cw, ch);
    // Floor-aware draw order: within each category pass, lower floors first
    // so upper floors paint on top. maxStories===0 collapses to the exact
    // prior single level-0 pass (no per-soldier level check) — byte-identical
    // flat-map behavior, zero extra work.
    const maxL = this.sim.map.maxStories;
    // Floor-focus filter (Height E2): with a focus active, soldiers on other
    // floors draw at 40% alpha. floorFocus===-1 (or maxStories===0, which pins
    // focus to -1) → zero save/restore, exactly the prior path.
    const dim = (s: Soldier, fn: () => void): void => {
      if (floorFocus >= 0 && s.level !== floorFocus) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        fn();
        ctx.restore();
      } else fn();
    };
    if (cam.scale < SPRITE_MIN_SCALE) {
      if (maxL === 0) {
        for (const s of this.sim.soldiers) if (s.inVehicle < 0 && vis(s)) dim(s, () => this.drawDot(ctx, cam, s, selectedSquads, cw, ch));
      } else {
        for (let l = 0; l <= maxL; l++)
          for (const s of this.sim.soldiers) if (s.inVehicle < 0 && vis(s) && s.level === l) dim(s, () => this.drawDot(ctx, cam, s, selectedSquads, cw, ch));
      }
    } else {
      // dead below downed below the living
      if (maxL === 0) {
        for (const s of this.sim.soldiers) if (!s.alive && s.inVehicle < 0 && vis(s)) dim(s, () => this.drawSoldier(ctx, cam, s, selectedSquads, dt, cw, ch));
        for (const s of this.sim.soldiers) if (s.alive && s.downed && s.inVehicle < 0 && vis(s)) dim(s, () => this.drawSoldier(ctx, cam, s, selectedSquads, dt, cw, ch));
        for (const s of this.sim.soldiers) if (s.alive && !s.downed && s.inVehicle < 0 && vis(s)) dim(s, () => this.drawSoldier(ctx, cam, s, selectedSquads, dt, cw, ch));
      } else {
        for (let l = 0; l <= maxL; l++) {
          for (const s of this.sim.soldiers) if (!s.alive && s.level === l && s.inVehicle < 0 && vis(s)) dim(s, () => this.drawSoldier(ctx, cam, s, selectedSquads, dt, cw, ch));
          for (const s of this.sim.soldiers) if (s.alive && s.downed && s.level === l && s.inVehicle < 0 && vis(s)) dim(s, () => this.drawSoldier(ctx, cam, s, selectedSquads, dt, cw, ch));
          for (const s of this.sim.soldiers) if (s.alive && !s.downed && s.level === l && s.inVehicle < 0 && vis(s)) dim(s, () => this.drawSoldier(ctx, cam, s, selectedSquads, dt, cw, ch));
        }
      }
    }
    for (const v of this.sim.vehicles) if (v.alive && visV(v)) this.drawVehicle(ctx, cam, v, cw, ch);
    for (const e of this.sim.emplacements) if (this.sim.emplacementVisibleTo(PLAYER_SIDE, e)) this.drawEmplacement(ctx, cam, e, selectedSquads, cw, ch);

    // Hanging dust and powder smoke: over the men standing in it, under the
    // roofs, and well under the sim's smoke screens further down.
    this.pall.draw(ctx, cam, now, cw, ch);
    this.drawFire(ctx, cam, now, cw, ch);
    this.roofs.drawTops(ctx, cam, cw, ch);
    this.roofs.drawChimneySmoke(ctx, cam, cw, ch);
    this.drawFires(ctx, cam, now, cw, ch); // over the roof it is consuming, under the smoke screens
    this.drawBirds(ctx, cam, now, cw, ch);
    this.drawSmoke(ctx, cam, cw, ch);
    this.drawPlanes(ctx, cam, now, cw, ch);
    // Ambient grade (N7): one source-over lerp toward the hour's tint, the
    // last world-space draw — everything the sun lights sits under it. Sized
    // past the viewport so the shake translate never exposes an ungraded edge.
    this.gradeWorld(ctx, cw, ch);
    // The frame's ONE additive batch, hoisted ABOVE the grade: 'lighter' adds
    // a fixed increment, so the same flash over a graded-dark floor gains
    // contrast for free — night punch nobody has to tune (§3.3). The cost,
    // paid knowingly and covered by a reviewed vfx.mjs reshoot: hot FX now
    // also draw over roof edges and smoke columns in daylight.
    this.drawHot(ctx, cam, now, cw, ch);
    // Intel markers, not world objects: contact ghosts and call-in marks sit
    // above the grade so the picture the player acts on stays legible at 02:00.
    this.drawContacts(ctx, cam, cw, ch);
    this.drawBarrageMarks(ctx, cam, now, cw, ch);
    ctx.restore();
  }

  // Ambient world grade (design §3.1/§3.2): source-over, never multiply — a
  // lerp toward the tint lifts blacks instead of crushing them, so the night
  // floor reads dark blue and low-contrast, never black. ambient.a === 0 above
  // +25 deg elevation: the nine-hour core of the day skips the draw entirely
  // and the canonical hour renders untouched by construction. Drawn INSIDE the
  // worldShake envelope (world layers only); the DOM HUD and everything
  // main.ts draws after renderer.draw() returns stay full-brightness.
  private gradeWorld(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const [r, g, b, a] = sun().ambient;
    if (a <= 0) return;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    ctx.fillRect(-24, -24, cw + 48, ch + 48);
  }

  // The frame's single additive batch (§3.3), AFTER the grade: shot flashes
  // and tracers, boom fireballs, and the burning-building hot cores, pools and
  // embers. The composite mode still flips twice per frame, never once per
  // particle — the batches that used to live inside drawFire and drawFires
  // merged into one when they hoisted above the grade.
  private drawHot(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    if (this.tracers.length === 0 && this.booms.length === 0 && this.lit.length === 0) return;
    const tier = fxDetail(cam.scale);
    hotPass(ctx, () => {
      for (const t of this.tracers) this.drawShotHot(ctx, cam, t, now, cw, ch, tier);
      for (const b of this.booms) this.drawBoomHot(ctx, cam, b, now, cw, ch, tier);
      this.drawFiresHot(ctx, cam, now, cw, ch, tier);
    });
  }

  // Cast-shadow pass (U2). Every shadow in the world is thrown by the one sun
  // in light.ts: the silhouette is baked in body space, but its DIRECTION comes
  // from the draw matrix, so a man facing east and a man facing west throw
  // their shadows the same way. Length follows the house convention set by
  // roofs.ts — heavily foreshortened, ~0.24x height, not the geometric cast.
  private drawUnitShadows(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number, floorFocus: number): void {
    if (cam.scale < 10) return; // sub-pixel: the AO under each sprite is enough
    // Per-frame sun read (N6): the silhouette sprites are direction-free, so
    // the whole pass reorients through the draw matrix and the SpriteCache
    // never learns the sun exists. Below civil twilight the cast pass switches
    // off entirely — a per-soldier save/rotate/draw/restore loop disappearing
    // is a frame WIN at night, not a cost.
    const s0 = sun();
    if (s0.alphaMul < 0.02) return;
    const sunA = Math.atan2(SUN.dy, SUN.dx);
    const lm = s0.lenMul;
    // Elongation along the sun axis only. `base + (base-1)*(lm-1)` is exactly
    // the shipped constant at the canonical hour (lm-1 is exactly 0 there) and
    // rakes out toward the 3x clamp at a low sun.
    const stretch = (base: number): number => base + (base - 1) * (lm - 1);
    const band = bandFor(cam.scale);
    const pad = SPRITE_SPAN * cam.scale;
    for (const s of this.sim.soldiers) {
      if (s.inVehicle >= 0 || s.level > 0) continue; // upper-floor men don't shadow the street
      if (!this.sim.soldierVisibleTo(PLAYER_SIDE, s)) continue;
      const st = this.rs.get(s.id);
      if (!st) continue; // never drawn yet — no pose to cast
      const [x, y] = cam.worldToScreen(st.wx, st.wy, cw, ch);
      if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) continue;
      const off = SHADOW_OFF[st.pose];
      ctx.save();
      ctx.globalAlpha = floorFocus >= 0 && s.level !== floorFocus ? shadowSoftAlpha() * 0.4 : shadowSoftAlpha();
      ctx.translate(x, y);
      ctx.rotate(sunA);
      ctx.translate(off * lm * cam.scale, 0);
      ctx.scale(stretch(off > 0.2 ? 1.18 : 1.05), 1);
      ctx.rotate(-sunA);
      ctx.rotate(st.dfacing);
      ctx.drawImage(getShadowSprite(st.pose, st.frame, weaponClass(s.weapon), band), -pad / 2, -pad / 2, pad, pad);
      ctx.restore();
    }
    const vband = vehicleBandFor(cam.scale);
    const vpad = VEHICLE_SPAN * cam.scale;
    for (const v of this.sim.vehicles) {
      if (!this.sim.vehicleVisibleTo(PLAYER_SIDE, v)) continue;
      const [x, y] = cam.worldToScreen(v.x, v.y, cw, ch);
      if (x < -vpad || y < -vpad || x > cw + vpad || y > ch + vpad) continue;
      ctx.save();
      ctx.globalAlpha = HULL_SHADOW_ALPHA * s0.alphaMul;
      ctx.translate(x, y);
      ctx.rotate(sunA);
      ctx.translate(HULL_SHADOW_OFF * lm * cam.scale, 0);
      ctx.scale(stretch(1.3), 1);
      ctx.rotate(-sunA);
      ctx.rotate(v.facing);
      ctx.drawImage(getVehicleShadow(v.kind, v.alive ? 'ok' : 'dead', vband), -vpad / 2, -vpad / 2, vpad, vpad);
      ctx.restore();
      // The turret rides a metre above the deck and the sun does not rotate
      // with the hull: its own drop shadow is what makes it read as sitting ON
      // the tank rather than painted onto it.
      const t = v.alive && tier(vband) >= 2 ? turretCenter(v.kind) : null;
      if (!t) continue;
      const [tcx, tcy, tr] = t;
      const cs = Math.cos(v.facing);
      const sn = Math.sin(v.facing);
      const [bx, by] = cam.worldToScreen(v.x + tcx * cs - tcy * sn + SUN.dx * 0.7 * lm, v.y + tcx * sn + tcy * cs + SUN.dy * 0.7 * lm, cw, ch);
      const br = tr * 1.05 * cam.scale;
      ctx.globalAlpha = 0.24 * s0.alphaMul;
      ctx.drawImage(turretBlob(), bx - br, by - br, br * 2, br * 2);
      ctx.globalAlpha = 1;
    }
    const eband = emplacementBandFor(cam.scale);
    for (const e of this.sim.emplacements) {
      if (!this.sim.emplacementVisibleTo(PLAYER_SIDE, e)) continue;
      const [x, y] = cam.worldToScreen(e.x, e.y, cw, ch);
      const epad = emplacementSpan(e.kind) * cam.scale;
      if (x < -epad || y < -epad || x > cw + epad || y > ch + epad) continue;
      ctx.save();
      ctx.globalAlpha = shadowSoftAlpha();
      ctx.translate(x, y);
      ctx.rotate(sunA);
      ctx.translate(EMPL_SHADOW_OFF * lm * cam.scale, 0);
      ctx.scale(stretch(1.1), 1);
      ctx.rotate(-sunA);
      ctx.rotate(e.facing);
      ctx.drawImage(getEmplacementShadow(e.kind, e.state === 'deployed' ? 'deployed' : 'packed', eband), -epad / 2, -epad / 2, epad, epad);
      ctx.restore();
    }
  }

  // Band-change prewarm: bakes are lazy and inside the frame, so crossing a
  // zoom band would otherwise hitch on the first frame that needs every new
  // sprite at once. Bake the poses a live army actually holds (idle, aim, the
  // walk cycle) plus every present vehicle on an idle callback, and bail if the
  // zoom has moved on again by the time it runs.
  private warmBand = -1;
  private prewarm(scale: number): void {
    if (scale < SPRITE_MIN_SCALE) return;
    const band = bandFor(scale);
    if (band === this.warmBand) return;
    this.warmBand = band;
    const vband = vehicleBandFor(scale);
    const run = (): void => {
      if (this.warmBand !== band) return; // a later band change owns the queue now
      const seen = new Set<string>();
      for (const s of this.sim.soldiers) {
        if (!s.alive) continue;
        const v = kitVariant(s.role, s.xp, band);
        const key = `${s.side}|${s.weapon}|${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        getSprite(s.side, s.weapon, 'idle', 0, band, v);
        getSprite(s.side, s.weapon, 'aim', 0, band, v);
        for (let f = 0; f < WALK_FRAMES; f++) getSprite(s.side, s.weapon, 'walk', f, band, v);
      }
      // Phase 0 only: the churn variants are minted lazily by whatever
      // actually drives, so a band change never pays for three tracks per kind.
      for (const v of this.sim.vehicles) getVehicleSprite(v.kind, v.side, v.alive ? 'ok' : 'dead', vband, 0, v.alive ? occBucket(v.kind, this.aboard(v)) : 0);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 400 });
    else setTimeout(run, 0);
  }

  // Screen-shake offset in pixels. Booms dominate (near-full-screen impact →
  // real jolt, off-screen → almost none); sustained nearby fire adds a capped
  // low tremor so a firefight breathes without vibrating into arcade territory.
  private worldShake(cam: Camera, now: number, cw: number, ch: number): [number, number] {
    const half = Math.hypot(cw, ch) / 2;
    const prox = (wx: number, wy: number): number => {
      const [sx, sy] = cam.worldToScreen(wx, wy, cw, ch);
      return Math.max(0, 1 - (Math.hypot(sx - cw / 2, sy - ch / 2) / half) * 0.8);
    };
    let trauma = 0;
    for (const b of this.booms) {
      const age = now - b.at;
      const hit = b.spec.shake * Math.min(1.3, b.k);
      const ms = 220 + 260 * hit; // a bigger blast rings longer as well as harder
      if (age > ms) continue;
      trauma = Math.max(trauma, (1 - age / ms) * prox(b.x, b.y) * hit);
    }
    let fire = 0;
    for (const t of this.tracers) {
      if (now - t.at > 45) continue;
      fire += 0.02 * prox(t.fx, t.fy);
      if (fire >= 0.12) break; // cap — never let volume of fire alone jolt the camera
    }
    trauma = Math.min(1, trauma + Math.min(0.12, fire));
    if (trauma < 0.001) return [0, 0];
    const mag = Math.pow(trauma, 1.5) * 9; // px; ^1.5 keeps small tremors gentle
    return [mag * Math.sin(now * 0.09), mag * Math.sin(now * 0.13 + 1.7)];
  }

  // WYSIWYG (V12). Every number in this function is the SIM's own: the column
  // height `p.h` and radius `p.r` are the aged plume model, and each puff is
  // placed by `smokeAxisAt` — the very function `sightBetween` re-projects its
  // ray against before deciding the smoke blocks. What you see is what blocks
  // sight, structurally, from one formula in one file, rather than by two
  // implementations happening to agree today.
  //
  // In a strict plan projection a leaning column IS a smear: a puff at height z
  // sits LEAN_K*(z - z0) metres downwind of the base, so a 10 m plume is drawn
  // as 3.5 m of ground track from its own base outward. Height is carried by
  // nothing else — there is no elevation view of a column.
  //
  // No `now`, and no private per-entry state. The envelope is p.age / (p.age +
  // p.ttl), and that denominator is the spawn ttl exactly, because the sim
  // increments one as it decrements the other. That identity is what deleted
  // `smokeMaxTtl` and its key-eviction loop: the renderer was reconstructing a
  // number the sim had been carrying both halves of all along.
  private drawSmoke(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    for (const p of this.sim.smoke) {
      const span = p.age + p.ttl;
      const life = span > 0 ? p.age / span : 1;
      let envelope = 1;
      if (life < 0.1) envelope = life / 0.1; // fade in
      else if (life > 0.7) envelope = (1 - life) / 0.3; // fade out
      if (envelope <= 0) continue;
      const [tx, ty] = smokeAxisAt(p, p.z0 + p.h);
      const [ox, oy] = cam.worldToScreen((p.x + tx) / 2, (p.y + ty) / 2, cw, ch);
      // the cull pad has to contain the whole lean, not just the base radius:
      // a fire plume tracks 7 m downwind of the wreck that is making it
      const pad = (p.r + Math.abs(tx - p.x) + Math.abs(ty - p.y) + 2) * cam.scale;
      if (ox < -pad || oy < -pad || ox > cw + pad || oy > ch + pad) continue;
      // One sprite per ~1.6 m of column, so a 1.5 m puff at deploy is three
      // overlapping blobs and a 20 m fire column is ten strung downwind.
      const n = Math.max(3, Math.min(10, Math.round(p.h / 1.6) + 2));
      const soot = p.kind === 1;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const [ax, ay] = smokeAxisAt(p, p.z0 + p.h * u);
        // Deterministic per (puff, sample) and turning on the sim's own clock,
        // so the column boils under play and freezes under pause.
        const ang = hash(p.x, p.y, 10 + i) * Math.PI * 2 + p.age * (hash(p.x, p.y, 40 + i) - 0.5) * 0.25;
        const off = (0.15 + hash(p.x, p.y, 20 + i) * 0.3) * p.r;
        const [sx, sy] = cam.worldToScreen(ax + Math.cos(ang) * off, ay + Math.sin(ang) * off, cw, ch);
        // narrower at the base, wider aloft — a plume opens as it rises, and in
        // plan that is the only cue that the far end of the smear is the top
        const r = p.r * (0.6 + u * 0.5) * (0.86 + hash(p.x, p.y, 50 + i) * 0.28);
        // Thinner aloft, and NOT normalized by the sample count: a taller
        // column has more samples but spreads them over more ground track, so
        // the stack depth at any one point stays roughly flat on its own.
        // Dividing by n as well was tried and turned a 60 m smoke screen into a
        // pale smudge the sim was blinding two squads through.
        const a = envelope * (0.33 + hash(p.x, p.y, 60 + i) * 0.08) * (1 - u * 0.36);
        blit(ctx, soot && u < 0.34 ? 'soot' : 'smoke', sx, sy, r * cam.scale, a);
      }
    }
  }

  // Drifting haze bands. Five world-anchored smears of thin air, not a
  // full-viewport wash: bands are cheaper (one drawImage each) and far more
  // painterly, and they only exist at the zooms where air is what you are
  // looking at. Above ~22 px/m you can count boots and haze is just fog on the
  // lens. Drift is sim-time so a paused field is a still field.
  private drawHaze(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    if (!this.hazeOn || cam.scale > HAZE_MAX_SCALE) return;
    const spr = hazeBand();
    const secs = this.sim.tick / 30;
    const dx = WIND.dx * WIND.speed * 0.06 * secs;
    const dy = WIND.dy * WIND.speed * 0.06 * secs;
    const mw = this.sim.map.w;
    const mh = this.sim.map.h;
    const n = cam.scale < 6 ? 3 : this.haze.length; // the whole map on screen needs fewer bands, not five
    for (let i = 0; i < n; i++) {
      const b = this.haze[i];
      const wx = mod(b.x + dx, mw + b.len) - b.len;
      const wy = mod(b.y + dy, mh + b.hgt) - b.hgt;
      const [sx, sy] = cam.worldToScreen(wx, wy, cw, ch);
      const w = b.len * cam.scale;
      const h = b.hgt * cam.scale;
      if (sx > cw || sy > ch || sx + w < 0 || sy + h < 0) continue;
      ctx.globalAlpha = b.a;
      ctx.drawImage(spr, sx, sy, w, h);
    }
    ctx.globalAlpha = 1;
  }

  // Dust motes. Anchored to a world lattice sized in screen space, so the
  // specks hold still while the camera pans (the thing that gives away a
  // screen-space particle field) and keep a constant density at any zoom.
  private drawMotes(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    if (cam.scale < MOTE_MIN_SCALE) return;
    const cell = 220 / cam.scale;
    const secs = this.sim.tick / 30;
    const [wx0, wy0] = cam.screenToWorld(0, 0, cw, ch);
    const [wx1, wy1] = cam.screenToWorld(cw, ch, cw, ch);
    const r = Math.max(1.1, 0.06 * cam.scale);
    let n = 0;
    for (let cy = Math.floor(wy0 / cell); cy <= Math.floor(wy1 / cell) && n < MOTE_CAP; cy++) {
      for (let cx = Math.floor(wx0 / cell); cx <= Math.floor(wx1 / cell) && n < MOTE_CAP; cx++) {
        n++;
        const ph = mod(secs * (0.2 + hash(cx, cy, 262) * 0.25) + hash(cx, cy, 260), 1);
        const mx = (cx + hash(cx, cy, 260)) * cell + WIND.dx * WIND.speed * ph * 2.4;
        const my = (cy + hash(cx, cy, 261)) * cell + WIND.dy * WIND.speed * ph * 2.4;
        const [sx, sy] = cam.worldToScreen(mx, my, cw, ch);
        blit(ctx, 'dustTan', sx, sy - ph * 0.5 * cam.scale, r, 0.16 * Math.sin(ph * Math.PI));
      }
    }
  }

  // How hard a fire is burning, 0-1. Buildings peak at their stoke count and
  // die on the sim clock; a brewed-up vehicle rages, then settles to a hulk
  // that smokes for as long as the sim says it is burning.
  private intensity(f: Fire): number {
    if (f.vid >= 0) {
      const t = (this.sim.tick - f.born) / 30;
      if (t <= BREWUP_FULL_S) return 1;
      const k = Math.min(1, (t - BREWUP_FULL_S) / (BREWUP_SETTLE_S - BREWUP_FULL_S));
      return 1 - k * (1 - BREWUP_FLOOR);
    }
    const age = (this.sim.tick - f.tick) / 30;
    return Math.min(1, 0.7 + 0.15 * (f.hits - 1)) * Math.max(0, Math.min(1, (FIRE_LIFE_S - age) / FIRE_FADE_S));
  }

  // A burning house the player has never seen is an intel leak — flames draw
  // over roofs, so they would shine straight through the fog. Vehicles reuse
  // the wreck's own visibility (permanent once seen); buildings pay for a real
  // LOS test, throttled to twice a sim second.
  private fireSeen(f: Fire): boolean {
    if (this.sim.fowDisabled) return true;
    if (f.vid >= 0) return this.sim.vehicleVisibleTo(PLAYER_SIDE, this.sim.vehicles[f.vid]);
    if (this.sim.tick - f.seenTick >= FIRE_SEEN_TICKS) {
      f.seenTick = this.sim.tick;
      f.seen = this.sim.sideSeesPoint(PLAYER_SIDE, f.x, f.y);
    }
    return f.seen;
  }

  // Burning buildings and vehicle brew-ups. Drawn after the roof tops so a
  // flame sits over the roof it is consuming, and before the smoke screens.
  //
  // The value pair is the whole trick: every bright lick carries a soot blit
  // directly above it. Bright-alone on pale Normandy ground reads as a glowing
  // dot; bright-under-dark reads as fire.
  private drawFires(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    for (const v of this.sim.vehicles) {
      if (!v.burning) continue;
      const key = -1000 - v.id;
      const f = this.fires.get(key);
      if (f) {
        f.tick = this.sim.tick; // sim still says it burns — never let it time out
        f.x = v.x;
        f.y = v.y;
      } else this.stoke(key, v.x, v.y, v.id);
    }
    // Cleared before the early-outs, not after: drawHot() reads lit/licks
    // once this pass has returned, and a stale lick from the frame its fire
    // burned out would otherwise glow over nothing.
    this.lit.length = 0;
    this.licks.length = 0;
    if (this.fires.size === 0) return;

    const S = cam.scale;
    const tier = fxDetail(S);
    const pad = 9 * S;
    for (const [key, f] of this.fires) {
      if (f.vid < 0 && (this.sim.tick - f.tick) / 30 >= FIRE_LIFE_S) {
        this.fires.delete(key);
        continue;
      }
      const [x, y] = cam.worldToScreen(f.x, f.y, cw, ch);
      if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) continue;
      if (!this.fireSeen(f)) continue;
      this.lit.push(f);

      const it = this.intensity(f);
      const b = f.vid < 0 ? this.sim.buildings[key] : undefined;

      // Plume first: it rises behind its own flames. A vehicle's column starts
      // near-black — a brewed-up tank is the sootiest thing on a WW2 field, and
      // that column is free readability below the sprite LOD threshold.
      for (let i = 0; i < 6; i++) {
        const ph = (((now * 0.0003125 + i / 6 + hash(key + 3000, i, 230)) % 1) + 1) % 1;
        const lean = WIND.speed * ph * 3.4 * S;
        const px = x + WIND.dx * lean;
        const py = y - ph * 6.5 * S + WIND.dy * lean;
        const pr = (1.1 + ph * 2.3) * S;
        const pa = 0.68 * (1 - ph * 0.7) * it;
        // Burning fuel and rubber never greys out the way burning timber does:
        // a tank's column stays sooty to the top, it just thins.
        const sootF = f.vid >= 0 ? Math.max(0.4, 1 - ph / 0.8) : Math.max(0, 1 - ph / 0.45);
        blit(ctx, 'soot', px, py, pr, pa * sootF);
        blit(ctx, 'smoke', px, py, pr, pa * (1 - sootF));
      }
      // Charred base: the fire's own shadow, so the licks sit in something
      // burnt instead of floating on clean floor.
      blit(ctx, 'soot', x, y, (1.4 + 0.9 * it) * S, 0.26 * it);

      // Licks spread as the fire takes hold: one shell smoulders in a corner, a
      // fully involved house burns end to end (still clamped to its footprint).
      const spread = 0.9 + 1.5 * it;
      const n = 2 + Math.round(2 * it * tier);
      for (let i = 0; i < n; i++) {
        const hs = hash(key + 1000, i, 212);
        const size = 0.7 + hash(key + 1000, i, 213) * 0.6; // no two licks the same height
        let lx = f.x + (hash(key + 1000, i, 210) - 0.5) * spread * 2;
        let ly = f.y + (hash(key + 1000, i, 211) - 0.5) * spread * 2;
        if (b) {
          lx = Math.max(b.x + 0.6, Math.min(b.x + b.w - 0.6, lx));
          ly = Math.max(b.y + 0.6, Math.min(b.y + b.h - 0.6, ly));
        }
        const [sx, sy0] = cam.worldToScreen(lx, ly, cw, ch);
        const flick = 0.5 + 0.5 * Math.sin(now * 0.0075 * (7 + hs * 4) + hs * 6.28);
        const r = (0.5 + 0.34 * flick) * size * it * S;
        const sy = sy0 - (0.35 + 0.5 * flick) * S;
        blit(ctx, 'fire', sx, sy, r * 2.2, 0.2); // warm halo — merges neighbouring licks into one body of flame
        blit(ctx, 'fire', sx, sy, r, 0.9);
        blit(ctx, 'soot', sx, sy - r * 1.2, r * 1.7, 0.34);
        this.licks.push(sx, sy, r * 0.45, 0.5 + 0.3 * flick); // hot cores, drawn in the frame's hot batch (drawHot)
      }
    }
  }

  // The fires' share of the frame hot batch. Runs inside drawHot's hotPass —
  // never call it with a source-over ctx.
  private drawFiresHot(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    if (this.lit.length === 0) return;
    const S = cam.scale;
    for (let i = 0; i < this.licks.length; i += 4) blit(ctx, 'flash', this.licks[i], this.licks[i + 1], this.licks[i + 2], this.licks[i + 3]);
    for (const f of this.lit) {
      const it = this.intensity(f);
      const [x, y] = cam.worldToScreen(f.x, f.y, cw, ch);
      // Warm ground pool: a light POOL, not a light DIRECTION — no cast
      // shadow anywhere changes, so the one-sun rule still holds.
      blit(ctx, 'fire', x, y, 3.2 * it * S, FIRE_POOL_ALPHA);
      if (tier < 1) continue;
      // Embers: a fixed pool per fire on staggered wrapping phases, riding
      // the one wind up and downwind. They die — nothing here accumulates.
      const ne = Math.max(2, Math.round(8 * it));
      for (let i = 0; i < ne; i++) {
        const hs = hash(f.key + 2000, i, 220);
        const life = 1.6 + hs * 1.2;
        const t = ((now * 0.001 + i * 0.37) % life) / life;
        const ex = x + (WIND.dx * WIND.speed * 1.9 * t + (hash(f.key + 2000, i, 221) - 0.5) * 1.6) * S;
        const ey = y + (WIND.dy * WIND.speed * 1.9 * t + (hash(f.key + 2000, i, 222) - 0.5) * 1.2) * S - t * 2.6 * S;
        blit(ctx, 'spark', ex, ey, Math.max(0.6, (0.05 - 0.03 * t) * S), Math.pow(1 - t, 1.6) * 0.8 * it);
      }
    }
  }

  // Last-known ghosts: intel markers, not world objects — drawn above roofs,
  // fading with age until the contact expires or is resolved.
  private drawContacts(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    if (this.sim.fowDisabled) return; // ?fow=0 shows real units — stale ghosts would just overdraw them
    for (const c of this.sim.contacts[PLAYER_SIDE].values()) {
      const age = (this.sim.tick - c.tick) / (45 * 30);
      const alpha = 0.55 * (1 - age);
      if (alpha <= 0) continue;
      const [x, y] = cam.worldToScreen(c.x, c.y, cw, ch);
      if (x < -20 || y < -20 || x > cw + 20 || y > ch + 20) continue;
      const r = (c.kind === 'vehicle' ? 2.4 : 1.1) * cam.scale;
      ctx.strokeStyle = `rgba(208, 92, 80, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(208, 92, 80, ${alpha})`;
      ctx.font = `${Math.max(9, cam.scale * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', x, y);
    }
  }

  // Pulsing dashed amber — shared style for call-in target markers.
  private markStroke(ctx: CanvasRenderingContext2D, now: number): void {
    ctx.strokeStyle = `rgba(255, 202, 106, ${0.45 + 0.25 * Math.sin(now / 160)})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
  }

  private drawBarrageMarks(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    this.barrageMarks = this.barrageMarks.filter((m) => this.sim.tick - m.tick < 20 * 30);
    for (const m of this.barrageMarks) {
      const [x, y] = cam.worldToScreen(m.x, m.y, cw, ch);
      this.markStroke(ctx, now);
      ctx.beginPath();
      ctx.arc(x, y, 6 * cam.scale, 0, Math.PI * 2); // ~scatter radius
      ctx.stroke();
      ctx.setLineDash([]);
      const c = Math.max(4, cam.scale * 0.5);
      ctx.beginPath();
      ctx.moveTo(x - c, y);
      ctx.lineTo(x + c, y);
      ctx.moveTo(x, y - c);
      ctx.lineTo(x, y + c);
      ctx.stroke();
    }
    this.strafeMarks = this.strafeMarks.filter((m) => this.sim.tick - m.tick < 25 * 30);
    for (const m of this.strafeMarks) {
      const [x0, y] = cam.worldToScreen(m.x - 20, m.y, cw, ch);
      const [x1] = cam.worldToScreen(m.x + 20, m.y, cw, ch);
      this.markStroke(ctx, now);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const ah = Math.max(5, cam.scale * 0.6); // arrowhead: run goes west→east
      ctx.beginPath();
      ctx.moveTo(x1 - ah, y - ah * 0.6);
      ctx.lineTo(x1, y);
      ctx.lineTo(x1 - ah, y + ah * 0.6);
      ctx.stroke();
    }
  }

  // Odometer bookkeeping (U7): distance travelled since the last frame, with
  // the same >2 m teleport guard drawSoldier uses, plus the rut stamps and
  // dust puffs that fall out of it. Returns the track phase to bake with.
  private vehicleMotion(v: Vehicle, band: number, scale: number): number {
    let st = this.vrs.get(v.id);
    if (!st) {
      st = { px: v.x, py: v.y, dist: 0, dust: [], di: 0, puffAt: 0, markAt: 0 };
      this.vrs.set(v.id, st);
    }
    const step = Math.hypot(v.x - st.px, v.y - st.py);
    st.px = v.x;
    st.py = v.y;
    if (!v.alive) return 0;
    if (step < 2) st.dist += step; // a bigger jump is a respawn/teleport, not a drive
    const gauge = trackGauge(v.kind);
    if (st.dist - st.markAt >= MARK_EVERY) {
      st.markAt = st.dist;
      this.decals.trackMark(v.x, v.y, v.facing, gauge);
    }
    if (tier(band) >= 2 && scale >= 8 && st.dist - st.puffAt >= DUST_EVERY) {
      st.puffAt = st.dist;
      // alternate rear corners, so the trail staggers instead of pulsing
      const s = st.di % 2 === 0 ? -1 : 1;
      const cs = Math.cos(v.facing);
      const sn = Math.sin(v.facing);
      const rx = -VEHICLE_SPAN * 0.28; // roughly the rear of any hull in this set
      const p = { x: v.x + rx * cs - s * gauge * sn, y: v.y + rx * sn + s * gauge * cs, at: st.dist };
      if (st.dust.length < DUST_RING) st.dust.push(p);
      else st.dust[st.di % DUST_RING] = p;
      st.di++;
    }
    return tier(band) >= 2 ? Math.floor(st.dist / TRACK_PITCH) % 3 : 0;
  }

  private drawVehicleDust(ctx: CanvasRenderingContext2D, cam: Camera, v: Vehicle, cw: number, ch: number): void {
    const st = this.vrs.get(v.id);
    if (!st) return;
    for (const p of st.dust) {
      const age = (st.dist - p.at) / DUST_LIFE;
      if (age >= 1) continue;
      const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
      blit(ctx, 'dustTan', sx, sy, (0.6 + age * 1.1) * cam.scale, 0.26 * (1 - age));
    }
  }

  private drawVehicle(ctx: CanvasRenderingContext2D, cam: Camera, v: Vehicle, cw: number, ch: number): void {
    const [x, y] = cam.worldToScreen(v.x, v.y, cw, ch);
    const pad = VEHICLE_SPAN * cam.scale;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    if (!v.alive && !this.deadVehicles.has(v.id)) {
      this.deadVehicles.add(v.id);
      this.decals.scorch(v.x, v.y); // stamped once, under the wreck sprite from here on
    }
    const band = vehicleBandFor(cam.scale);
    const tphase = this.vehicleMotion(v, band, cam.scale);
    const occ = v.alive ? occBucket(v.kind, this.aboard(v)) : 0;
    const spr = getVehicleSprite(v.kind, v.side, v.alive ? 'ok' : 'dead', band, tphase, occ);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(v.facing);
    ctx.drawImage(spr, -pad / 2, -pad / 2, pad, pad);
    ctx.restore();
    if (v.alive && v.id === this.selectedVehicle) {
      ctx.strokeStyle = '#ffe9a0';
      ctx.lineWidth = 1.5; // matches the soldier selection ring
      ctx.beginPath();
      ctx.arc(x, y, cam.scale * 3.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    // v.burning is drawn by drawFires (shared with building fires), not here —
    // a brew-up has to sit above the roofs a wreck can be parked against.
  }

  // Living bodies aboard: crew plus every passenger team. Only ever consumed
  // through occBucket, which collapses it to four cache-affordable states.
  private aboard(v: Vehicle): number {
    let n = 0;
    for (const id of v.crewIds) if (this.sim.soldiers[id]?.alive) n++;
    for (const t of v.passengerTeamIds) for (const id of this.sim.teams[t]?.soldierIds ?? []) if (this.sim.soldiers[id]?.alive) n++;
    return n;
  }

  // Baked crewed weapon (U8), on the vehicle pattern: one rotated drawImage,
  // then the selection ring and — while the gun is being set up or torn down —
  // the dashed outline that has always signalled "not in action yet".
  //
  // The crew are NOT in this sprite: an emplacement's men have inEmplacement
  // >= 0 but inVehicle < 0, so the soldier passes already drew every one of
  // them. This draws the weapon and its mount only.
  private drawEmplacement(ctx: CanvasRenderingContext2D, cam: Camera, e: Emplacement, selectedSquads: number[], cw: number, ch: number): void {
    const [x, y] = cam.worldToScreen(e.x, e.y, cw, ch);
    const pad = emplacementSpan(e.kind) * cam.scale;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    const deployed = e.state === 'deployed';
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(e.facing);
    ctx.drawImage(getEmplacementSprite(e.kind, e.side, deployed ? 'deployed' : 'packed', emplacementBandFor(cam.scale)), -pad / 2, -pad / 2, pad, pad);
    ctx.restore();
    const r = emplacementFootprintRadius(e.kind) * cam.scale;
    if (!deployed) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = TEAM[e.side];
      ctx.lineWidth = Math.max(1, cam.scale * 0.08);
      const b = r * 0.72; // hugs the mount, not the barrel's reach
      ctx.strokeRect(x - b, y - b, b * 2, b * 2);
      ctx.restore();
    }
    if (selectedSquads.includes(this.sim.teams[e.crewTeamId]?.squadId ?? -1)) {
      ctx.strokeStyle = '#ffe9a0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawPlanes(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    this.planes = this.planes.filter((p) => now - p.at < PLANE_MS);
    for (const p of this.planes) {
      const t = (now - p.at) / PLANE_MS;
      const wx = p.x0 + (p.x1 - p.x0) * t;
      const [x, y] = cam.worldToScreen(wx, p.y, cw, ch);
      const s = cam.scale;
      // shadow racing along the ground, then the aircraft offset "above"
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(x, y, s * 4.5, s * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(x + s * 2, y - s * 6);
      ctx.fillStyle = '#4a5240';
      // fuselage + wings + tail, nose toward +X
      ctx.fillRect(-s * 3.2, -s * 0.45, s * 6.4, s * 0.9);
      ctx.fillRect(-s * 0.8, -s * 4.2, s * 1.9, s * 8.4);
      ctx.fillRect(-s * 3.2, -s * 1.6, s * 0.9, s * 3.2);
      ctx.restore();
    }
  }

  // Melee pose only while actually trading blows; a closer/pursuer out of
  // strike range falls through to the walk animation instead.
  private inStrikeRange(s: Soldier): boolean {
    const o = this.sim.soldiers[s.meleeId];
    return Math.hypot(o.x - s.x, o.y - s.y) <= MELEE_STRIKE_RANGE + 0.1;
  }

  private state(s: Soldier): RState {
    let st = this.rs.get(s.id);
    if (!st) {
      st = { facing: s.side === 'blue' ? 0 : Math.PI, phase: 0, px: s.x, py: s.y, smx: s.x, smy: s.y, wasAlive: true, pose: 'idle', frame: 0, wx: s.x, wy: s.y, dfacing: s.side === 'blue' ? 0 : Math.PI };
      this.rs.set(s.id, st);
    }
    return st;
  }

  private drawSoldier(ctx: CanvasRenderingContext2D, cam: Camera, s: Soldier, selectedSquads: number[], dt: number, cw: number, ch: number): void {
    // The sim pins a dragged casualty to the rescuer's position; draw the
    // body trailing behind the dragger instead of stacked under him.
    const carried = s.alive && s.downed && s.carriedBy >= 0;
    let wx = s.x;
    let wy = s.y;
    let dragFacing: number | null = null;
    if (carried) {
      const rst = this.rs.get(s.carriedBy);
      if (rst) {
        dragFacing = rst.facing;
        wx -= Math.cos(rst.facing) * 1.0;
        wy -= Math.sin(rst.facing) * 1.0;
      }
    }
    const [x, y] = cam.worldToScreen(wx, wy, cw, ch);
    const pad = SPRITE_SPAN * cam.scale;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;

    const st = this.state(s);
    const dx = s.x - st.px;
    const dy = s.y - st.py;
    // >2m in one frame is a sim teleport (vehicle bailout), not movement —
    // don't let it fake a walk frame or wrench the facing
    const moved = Math.hypot(dx, dy) > 2 ? 0 : Math.hypot(dx, dy);
    st.px = s.x;
    st.py = s.y;

    const band = bandFor(cam.scale);
    // What you see is what blocks sight: the prone and kneel poses are the
    // sim's own stance function, not a second copy of the `mental`/suppression
    // thresholds. The non-stance poses (dead, surrendered, downed, drag, aid,
    // dragged, melee) stay ahead of it and win, as before.
    const stance = stanceOf(this.sim, s);
    let pose: Pose;
    let frame = 0;
    if (!s.alive) {
      // Three sprawls, picked off a render-side hash — never the sim RNG.
      const h = hash(s.id, 0, 7);
      pose = h < 0.4 ? 'dead' : h < 0.75 ? 'dead1' : 'dead2';
    } else if (s.captured) pose = hash(s.id, 0, 11) < 0.55 ? 'surrendered' : 'surrender2';
    else if (s.downed) pose = carried ? 'dragged' : 'downed';
    else if (s.task?.phase === 'drag') pose = 'drag';
    else if (s.task?.phase === 'aid') pose = 'aid';
    else if (s.meleeId >= 0 && this.inStrikeRange(s)) {
      // sim-driven strike cycle (freezes on pause, like walk): the thrust
      // frame shows right after the phase wrap, when the MeleeEvent lands
      pose = 'melee';
      frame = s.meleePhase < 0.18 ? 2 : s.meleePhase < 0.42 ? 3 : s.meleePhase < 0.78 ? 0 : 1;
    } else if (s.suppression > 0.5 && moved > 1e-4) {
      // A pinned man provably never advances (sim gates advance() on it), so a
      // pinned-and-moving crawl would be dead code. `shaken` — suppressed past
      // 0.5 but under the pin threshold — is the state that still moves.
      // Ahead of the prone branch because this IS the prone stance, animated:
      // stanceOf returns 'prone' for a man advancing under >0.5 suppression
      // (V8), so LOS sights him at 0.4 m exactly as he is drawn.
      pose = 'crawl';
      st.phase += moved * 0.9;
      frame = Math.floor((st.phase % 1) * CRAWL_FRAMES);
    } else if (stance === 'prone') pose = 'prone';
    else if (moved > 1e-4) {
      pose = 'walk';
      st.phase += moved * 1.4;
      frame = Math.floor((st.phase % 1) * WALK_FRAMES);
    } else if (s.reloading > 0 && s.targetId >= 0 && tier(band) >= 2) pose = 'reload';
    else if (stance === 'crouch') pose = 'kneel';
    else pose = s.targetId >= 0 ? 'aim' : 'idle';

    if (s.alive) {
      let desired = st.facing;
      if (s.meleeId >= 0) {
        const o = this.sim.soldiers[s.meleeId];
        desired = Math.atan2(o.y - s.y, o.x - s.x);
      } else if (s.task?.phase === 'aid') {
        const c = this.sim.soldiers[s.task.casualtyId];
        desired = Math.atan2(c.y - s.y, c.x - s.x);
      } else if (s.targetId >= 0 && !s.downed) {
        const t = this.sim.soldiers[s.targetId];
        desired = Math.atan2(t.y - s.y, t.x - s.x);
      } else if (moved > 1e-4) {
        desired = Math.atan2(dy, dx);
      }
      let diff = desired - st.facing;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      st.facing += Math.sign(diff) * Math.min(Math.abs(diff), 8 * dt);
    }

    // dragged bleeding men leave a smear trail
    if (carried && s.bloodLoss > 0.03 && Math.hypot(wx - st.smx, wy - st.smy) > 0.45) {
      this.decals.smear(wx, wy, dragFacing ?? st.facing);
      st.smx = wx;
      st.smy = wy;
    }

    // permanent blood pool, stamped once into decals the first frame death is observed
    if (!s.alive && st.wasAlive) {
      st.wasAlive = false;
      const dbl = Math.max(s.bloodLoss, s.wounds.length ? 0.35 : 0.2);
      this.decals.pool(wx, wy, 0.5 + Math.min(1, dbl) * 0.4);
    }

    // dynamic blood pool under the immobile wounded, still alive
    if (s.alive && s.downed && s.bloodLoss > 0.02) {
      const r = (0.25 + Math.min(1, s.bloodLoss) * 0.5) * cam.scale;
      ctx.fillStyle = 'rgba(92,15,12,0.5)';
      ctx.beginPath();
      ctx.ellipse(x + cam.scale * 0.1, y + cam.scale * 0.08, r, r * 0.8, st.facing, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.alive && selectedSquads.includes(s.squadId) && s.path) {
      ctx.strokeStyle = 'rgba(255, 233, 160, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let i = s.pathI; i < s.path.length; i++) {
        const [px, py] = cam.worldToScreen(s.path[i].x, s.path[i].y, cw, ch);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    const spr = getSprite(s.side, s.weapon, pose, frame, band, kitVariant(s.role, s.xp, band));
    const facing = s.alive ? (dragFacing ?? st.facing) : st.facing + ((s.id * 2654435761) % 100) / 100 - 0.5;
    st.pose = pose;
    st.frame = frame;
    st.wx = wx;
    st.wy = wy;
    st.dfacing = facing;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(facing);
    // upper-floor soldiers read slightly larger — a cue they're above ground
    const lvl = s.level > 0 ? 1.06 : 1;
    ctx.drawImage(spr, (-pad / 2) * lvl, (-pad / 2) * lvl, pad * lvl, pad * lvl);
    ctx.restore();
    // Helmet glint (U2): one unrotated quad on the head, so every man in the
    // company is lit from the same side. The baked highlight it replaces
    // pointed wherever the soldier happened to be facing.
    if (tier(band) >= 2 && !BAREHEAD.has(pose)) {
      const [hx, hy] = headOffset(pose);
      const u = DUDE_SCALE * cam.scale * lvl;
      const gs = 0.42 * u;
      const gx = x + (hx * Math.cos(facing) - hy * Math.sin(facing)) * u;
      const gy = y + (hx * Math.sin(facing) + hy * Math.cos(facing)) * u;
      ctx.drawImage(glintSprite(), gx - gs / 2, gy - gs / 2, gs, gs);
    }

    if (!s.alive) return;
    if (s.downed && s.stabilized) {
      // bandaged: white cross so a treated casualty reads apart from one bleeding out
      const c = cam.scale * 0.14;
      ctx.strokeStyle = '#f2efe4';
      ctx.lineWidth = Math.max(1.5, cam.scale * 0.08);
      ctx.beginPath();
      ctx.moveTo(x - c, y);
      ctx.lineTo(x + c, y);
      ctx.moveTo(x, y - c);
      ctx.lineTo(x, y + c);
      ctx.stroke();
    }
    // one-ring rule (S7): selection wins over suppression, never both — so
    // whichever ring a man gets is the one that carries the pin. A pinned man's
    // ring breathes; a merely suppressed one holds steady, so the pin reads at
    // a glance without a second ring. Phase is a hash of the id — a whole squad
    // pulsing in lockstep reads as a UI fault, not as men under fire — and
    // PULSE_W is slow enough to be a breath, not a strobe. tier 0 (band < 12)
    // keeps the flat ring: at that zoom the whole man is four pixels and a 1 px
    // radius wobble is noise.
    const pinned = !s.downed && s.mental === 'pinned' && tier(band) >= 1;
    const pulse = pinned ? 0.5 + 0.5 * Math.sin(this.fxClock * PULSE_W + hash(s.id, 0, 23) * Math.PI * 2) : 0;
    if (selectedSquads.includes(s.squadId)) {
      ctx.strokeStyle = `rgba(255, 233, 160, ${pinned ? 0.55 + 0.45 * pulse : 1})`;
      ctx.lineWidth = pinned ? 1.5 + pulse * 0.9 : 1.5;
      ctx.beginPath();
      ctx.arc(x, y, cam.scale * 0.6 + 2 + pulse * cam.scale * 0.07, 0, Math.PI * 2);
      ctx.stroke();
    } else if (!s.downed && s.suppression > 0.35) {
      ctx.strokeStyle = `rgba(255, 180, 40, ${Math.min(0.9, s.suppression) * (pinned ? 0.55 + 0.45 * pulse : 1)})`;
      ctx.lineWidth = pinned ? 1.5 + pulse * 0.9 : 1.5;
      ctx.beginPath();
      ctx.arc(x, y, cam.scale * 0.55 + 1.5 + pulse * cam.scale * 0.07, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Rout tell: morale snapped. A flat plan-view chip with a double chevron
    // pointing away from the sprite — the same UI-glyph register as the floor
    // badge below, in the brick red the event feed already uses for bad news.
    // Strict plan view: nothing here is an elevation of anything. It rides
    // 0.8 m up — clear of the body and the suppression ring, and well under
    // the floor badge's 1.8 m, so a broken man upstairs shows both without
    // either mark moving.
    if (!s.downed && !s.captured && s.mental === 'broken' && tier(band) >= 1) {
      const g = Math.max(8, Math.round(cam.scale * 0.34));
      const gy = y - cam.scale * 0.8;
      ctx.fillStyle = 'rgba(18,22,15,0.9)';
      ctx.beginPath();
      ctx.arc(x, gy, g * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(74,82,64,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = '#d05c50';
      ctx.lineWidth = Math.max(1.2, cam.scale * 0.045);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - g * 0.3, gy + g * 0.02);
      ctx.lineTo(x, gy - g * 0.28);
      ctx.lineTo(x + g * 0.3, gy + g * 0.02);
      ctx.moveTo(x - g * 0.3, gy + g * 0.3);
      ctx.lineTo(x, gy);
      ctx.lineTo(x + g * 0.3, gy + g * 0.3);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
    }

    // Floor badge: dark chip with the floor number above the sprite, only for
    // upper-floor soldiers at readable zoom (the dot path covers zoom-out).
    if (s.level > 0 && cam.scale >= 14) {
      const label = floorBadgeLabel(s.level);
      const fs = Math.max(9, Math.round(cam.scale * 0.42));
      ctx.font = `${fs}px ui-monospace, Menlo, monospace`;
      const w = ctx.measureText(label).width + 6;
      const h = fs + 4;
      const cy = y - pad / 2 - h / 2 - 1;
      ctx.fillStyle = 'rgba(18,22,15,0.9)';
      ctx.fillRect(x - w / 2, cy - h / 2, w, h);
      ctx.strokeStyle = 'rgba(74,82,64,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = '#e8e4d8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, cy);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  // Far-zoom LOD: the placeholder dot language, which is the right read at 2 px/m.
  private drawDot(ctx: CanvasRenderingContext2D, cam: Camera, s: Soldier, selectedSquads: number[], cw: number, ch: number): void {
    const [x, y] = cam.worldToScreen(s.x, s.y, cw, ch);
    if (x < -20 || y < -20 || x > cw + 20 || y > ch + 20) return;
    const r = Math.max(2.5, 0.35 * cam.scale);
    if (!s.alive) {
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - r * 0.7, y - r * 0.7);
      ctx.lineTo(x + r * 0.7, y + r * 0.7);
      ctx.moveTo(x + r * 0.7, y - r * 0.7);
      ctx.lineTo(x - r * 0.7, y + r * 0.7);
      ctx.stroke();
      return;
    }
    if (s.downed) {
      ctx.strokeStyle = TEAM[s.side];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = s.stabilized ? '#f2efe4' : '#c03028';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (selectedSquads.includes(s.squadId)) {
      ctx.strokeStyle = '#ffe9a0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    const prone = s.mental === 'pinned' || s.mental === 'broken';
    ctx.fillStyle = TEAM[s.side];
    ctx.beginPath();
    if (prone) ctx.ellipse(x, y, r * 1.15, r * 0.6, 0, 0, Math.PI * 2);
    else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // upper-floor dots get a white ring so they read apart from ground level
    if (s.level > 0) {
      ctx.strokeStyle = 'rgba(240,236,228,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (s.suppression > 0.35) {
      ctx.strokeStyle = `rgba(255, 180, 40, ${Math.min(0.9, s.suppression)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawFire(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    const MELEE_FX_MS = 250; // strike fleck / miss swish lifetime
    const tier = fxDetail(cam.scale);

    // melee impacts: red fleck on a hit (bigger on a kill), white swish on a miss
    this.meleeFx = this.meleeFx.filter((m) => now - m.at < MELEE_FX_MS);
    for (const m of this.meleeFx) {
      const t = (now - m.at) / MELEE_FX_MS;
      const [x, y] = cam.worldToScreen(m.x, m.y, cw, ch);
      if (m.hit) {
        ctx.fillStyle = `rgba(200, 40, 30, ${(1 - t) * 0.85})`;
        ctx.beginPath();
        ctx.arc(x, y, (m.kill ? 0.45 : 0.28) * (0.7 + t) * cam.scale, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const a0 = ((m.x * 7 + m.y * 13) % 6.28) + t * 1.5; // stable per-event swish angle
        ctx.strokeStyle = `rgba(235, 235, 225, ${(1 - t) * 0.7})`;
        ctx.lineWidth = Math.max(1.5, cam.scale * 0.07);
        ctx.beginPath();
        ctx.arc(x, y, 0.55 * cam.scale, a0, a0 + 1.1);
        ctx.stroke();
      }
    }

    // entries must survive past FADE_MS so the dust (which starts at TRAVEL_MS) can finish
    this.tracers = this.tracers.filter((t) => now - t.at < t.life);
    for (const t of this.tracers) this.drawShotCool(ctx, cam, t, now, cw, ch);
    this.drawGunSmoke(ctx, cam, now, cw, ch);

    this.booms = this.booms.filter((b) => now - b.at < b.spec.hang);
    for (const b of this.booms) this.drawBoom(ctx, cam, b, now, cw, ch, tier);

    this.breaches = this.breaches.filter((b) => now - b.at < BREACH_MS);
    for (const b of this.breaches) this.drawBreach(ctx, cam, b, now, cw, ch, tier);

    this.moraleFx = this.moraleFx.filter((m) => now - m.at < MORALE_MS[m.kind]);
    // Below tier 1 a man is a dot and a 1 m puff is two pixels of mud: prune
    // (so nothing piles up while zoomed out) but draw nothing.
    if (tier >= 1) for (const m of this.moraleFx) this.drawMoraleFx(ctx, cam, m, now, cw, ch);
    // The additive halves (drawShotHot/drawBoomHot) moved to drawHot(), which
    // runs after the ambient grade — the filters above are what keep the
    // arrays it iterates current.
  }

  // Screen-space geometry shared by a shot's cool and hot passes: muzzle point
  // (offset a barrel-length down the bearing), impact point, unit bearing.
  private shotGeom(cam: Camera, t: Tracer, cw: number, ch: number): ShotGeom {
    const [x0, y0] = cam.worldToScreen(t.fx, t.fy, cw, ch);
    const [x1, y1] = cam.worldToScreen(t.tx, t.ty, cw, ch);
    const d = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / d;
    const uy = (y1 - y0) / d;
    return { x1, y1, ux, uy, mx: x0 + ux * cam.scale * 0.9, my: y0 + uy * cam.scale * 0.9, hx: Math.round(t.tx * 100), hy: Math.round(t.ty * 100) };
  }

  private onScreen(x: number, y: number, cw: number, ch: number, pad: number): boolean {
    return x >= -pad && y >= -pad && x <= cw + pad && y <= ch + pad;
  }

  // Tap `i` of a burst: the same muzzle, a strike strayed off the first
  // round's by the weapon's cone, and its own hash stream so no two flashes of
  // a burst are the same shape. Tap 0 is the event's own geometry — the round
  // the sim resolved.
  private tapGeom(g: ShotGeom, i: number, cone: number): ShotGeom {
    if (i === 0) return g;
    const hx = g.hx + i * 7919;
    const da = (hash(hx, g.hy, 500) - 0.5) * 2 * cone;
    const len = Math.hypot(g.x1 - g.mx, g.y1 - g.my) * (1 + (hash(hx, g.hy, 501) - 0.5) * 0.08);
    const cs = Math.cos(da);
    const sn = Math.sin(da);
    const ux = g.ux * cs - g.uy * sn;
    const uy = g.ux * sn + g.uy * cs;
    return { x1: g.mx + ux * len, y1: g.my + uy * len, ux, uy, mx: g.mx, my: g.my, hx, hy: g.hy };
  }

  // Source-over half of a shot, once per tap of its burst: the faint thread
  // every round leaves, the weapon's smoke/dust signature, impact dust and the
  // kill ring.
  private drawShotCool(ctx: CanvasRenderingContext2D, cam: Camera, t: Tracer, now: number, cw: number, ch: number): void {
    const g0 = this.shotGeom(cam, t, cw, ch);
    // Everything drawn ROUND the muzzle and the strike is sized by F, the
    // floored scale (fx.ts fxScale). The two points themselves are not.
    const F = fxScale(cam.scale);
    const pad = 6 * F;
    const muzzleOn = this.onScreen(g0.mx, g0.my, cw, ch, pad);
    const impactOn = this.onScreen(g0.x1, g0.y1, cw, ch, pad);
    if (!muzzleOn && !impactOn) return;
    const fc = FLASH[flashClass(t.weapon)];

    for (let i = 0; i < t.taps; i++) {
      const age = now - t.at - i * t.gap;
      if (age < 0) break; // this round, and every one behind it, has not left yet
      if (age >= SHOT_MS) continue;
      const g = this.tapGeom(g0, i, fc.cone);

      // One thread per burst, down the round the sim resolved.
      if (i === 0 && age < FADE_MS) {
        const a = 1 - age / FADE_MS;
        ctx.strokeStyle = `rgba(${fc.tracerCol},${(t.hit ? 0.18 : 0.12) * a})`;
        ctx.lineWidth = fc.tracerW;
        ctx.beginPath();
        ctx.moveTo(g.mx, g.my);
        ctx.lineTo(g.x1, g.y1);
        ctx.stroke();
      }

      // Powder smoke. A muzzle flash is three frames long; this is the part
      // of a shot that is still on screen a third of a second later, which is
      // what lets a firing line read as a firing line. Pushed downrange by the
      // blast and then carried on the wind. Two offset puffs for the first
      // round, because one is a disc at this size and two are a wisp; the rest
      // of a burst, and a phone, get the one. Rockets and guns have their own
      // signatures below.
      if (muzzleOn && fc.extra === undefined) {
        const st = age / SHOT_MS;
        const drift = st * 0.5;
        const k = Math.sqrt(fc.r / 0.42) * F;
        for (let j = 0; j < (MOBILE || i > 0 ? 1 : 2); j++) {
          const along = 0.3 + j * 0.45 + st * (0.25 + j * 0.3);
          const lat = (hash(g.hx, g.hy, 40 + j) - 0.5) * 0.35;
          blit(ctx, 'smoke', g.mx + (g.ux * along - g.uy * lat + WIND.dx * drift) * F, g.my + (g.uy * along + g.ux * lat + WIND.dy * drift) * F, (0.26 - j * 0.07 + st * 0.42) * k, (0.36 - j * 0.08) * (1 - st));
        }
      }

      // Rocket back-blast: the cone of smoke out the rear tube. The most
      // characteristic WW2 silhouette the effects layer was missing.
      if (muzzleOn && fc.extra === 'backblast' && age < 400) {
        const bt = age / 400;
        const reach = 0.6 + bt * 2.4;
        for (let j = 0; j < 6; j++) {
          const f = (j + 0.5) / 6; // position along the cone — puffs widen with distance
          const along = f * reach;
          const lat = (hash(g.hx, g.hy, 30 + j) - 0.5) * 1.6 * f * reach;
          const px = g.mx + (-g.ux * along - g.uy * lat) * F;
          const py = g.my + (-g.uy * along + g.ux * lat) * F;
          const r = (0.3 + f * 0.7 + bt * 0.5) * F;
          blit(ctx, 'smoke', px, py, r, (1 - bt) * 0.42 * (1 - f * 0.35));
          blit(ctx, 'soot', px, py, r * 0.75, (1 - bt) * 0.32 * Math.max(0, 1 - bt / 0.4));
        }
      }

      // Gun muzzle-blast wash: the ground dust that gives away a gun position.
      if (muzzleOn && fc.extra === 'wash' && age < 700) {
        const wt = age / 700;
        const ahead = Math.atan2(g.uy, g.ux);
        for (let j = 0; j < 3; j++) {
          const ca = ahead + (hash(g.hx, g.hy, 50 + j) - 0.5) * 0.7;
          const dist = (1.5 + wt * 2.5 + hash(g.hx, g.hy, 60 + j) * 0.8) * F;
          blit(ctx, 'dustTan', g.mx + Math.cos(ca) * dist, g.my + Math.sin(ca) * dist, (0.8 + wt * 1.6) * F, (1 - wt) * 0.35);
        }
      }

      if (age < TRAVEL_MS) continue;
      const dAge = age - TRAVEL_MS;
      if (t.over) {
        // The rest of a missed burst walks round the first round's strike.
        this.drawOvershoot(ctx, cam, g, t.over, dAge, F, g.x1 - g0.x1, g.y1 - g0.y1, cw, ch);
        continue;
      }
      if (!impactOn) continue;
      if (dAge < IMPACT_MS) this.dirtKick(ctx, g, g.x1, g.y1, dAge / IMPACT_MS, F);
      if (i === 0 && t.hit && t.kill && dAge < 200) {
        const kt = dAge / 200;
        ctx.strokeStyle = `rgba(214, 186, 150, ${(1 - kt) * 0.7})`;
        ctx.lineWidth = Math.max(1, F * 0.08);
        ctx.beginPath();
        ctx.arc(g.x1, g.y1, (0.4 + kt * 2.2) * F, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // A round going into dirt: three puffs that open as they thin. Shared by the
  // strike at the target and the miss that comes down past it.
  private dirtKick(ctx: CanvasRenderingContext2D, g: ShotGeom, x: number, y: number, dt: number, F: number): void {
    for (let i = 0; i < 3; i++) {
      const ang = hash(g.hx + i, g.hy, 70) * Math.PI * 2;
      const dist = (0.12 + dt * 0.3) * F;
      blit(ctx, 'dustTan', x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, (0.16 + dt * 0.16) * F, (1 - dt) * 0.55);
    }
  }

  // The three morale crossings, one blit vocabulary each. All source-over: a
  // man losing his nerve is not an additive event.
  private drawMoraleFx(ctx: CanvasRenderingContext2D, cam: Camera, m: MoraleFx, now: number, cw: number, ch: number): void {
    const [x, y] = cam.worldToScreen(m.x, m.y, cw, ch);
    // Sized by the legibility floor like every other effect round a man
    // (fx.ts fxScale): at true scale the rallied ring was 5 px across at the
    // zoom the game is played at.
    const S = fxScale(cam.scale);
    if (!this.onScreen(x, y, cw, ch, 3 * S)) return;
    const t = (now - m.at) / MORALE_MS[m.kind];
    if (m.kind === 'pinned') {
      // Dust kicked sideways as he goes flat. Squashed on y and never lifted:
      // this is a man hitting the dirt, not a shell landing.
      for (let i = 0; i < 3; i++) {
        const a = hash(m.k, i, 91) * Math.PI * 2;
        const d = (0.15 + t * 0.55) * S;
        blit(ctx, 'dustTan', x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, Math.max(1, S * (0.3 + t * 0.35)), (1 - t) * 0.6);
      }
    } else if (m.kind === 'rallied') {
      // Back on his feet. Deliberately the other end of the palette from the
      // kill ring's pale tan, and twice its life — the read is "settled", and
      // nothing calm should be brighter than a confirmed kill. The sim emits
      // this for real now (about 34 a battle); at 0.38 it did not show on
      // ploughed earth at all.
      blit(ctx, 'ringDark', x, y, (0.35 + t * 1.15) * S, (1 - t) * 0.6);
    } else {
      // The volley's own flashes land this same tick and they are the show.
      // This is the full stop after them.
      blit(ctx, 'ringTan', x, y, (0.5 + t * 1.9) * S, (1 - t) * 0.42);
    }
  }

  // The stone leaving the wall. Reuses the overshoot vocabulary wholesale —
  // 'masonry' spall for the pale stone dust, 'dustTan' for the mortar, and the
  // CHUNKS on real ballistic arcs with ground shadows — because "a round hit
  // that wall" and "that wall came down" should read as the same material,
  // just more of it. No flash, no soot, no fireball: nothing here is burning.
  private drawBreach(ctx: CanvasRenderingContext2D, cam: Camera, b: BreachFx, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
    const S = cam.scale;
    if (!this.onScreen(x, y, cw, ch, 6 * S)) return;
    const age = now - b.at;
    const rs = b.wide ? 1.35 : 1; // a tank went through this one
    const base = Math.atan2(b.ny, b.nx);

    // 0-320 ms: the dust punch, thrown out of BOTH faces of the wall
    if (age < 320) {
      const t = age / 320;
      const n = Math.round((tier >= 1 ? 7 : 4) * rs);
      for (let i = 0; i < n; i++) {
        const side = i & 1 ? 1 : -1;
        const ca = base + (side < 0 ? Math.PI : 0) + (hash(b.k, i, 350) - 0.5) * 1.5;
        const dist = (0.2 + t * (1.1 + hash(b.k, i, 351) * 0.9)) * rs * S;
        blit(ctx, i % 3 === 0 ? 'dustTan' : 'masonry', x + Math.cos(ca) * dist, y + Math.sin(ca) * dist, (0.22 + t * 0.5) * rs * S, (1 - t) * 0.55);
      }
    }
    // 0-1300 ms: mortar dust settling straight down over the gap, so the hole
    // stays legible for a beat after the debris has landed
    if (age < BREACH_MS) {
      const t = age / BREACH_MS;
      blit(ctx, 'dustTan', x, y, (0.5 + t * 1.4) * rs * S, (1 - t) * (1 - t) * 0.3);
    }
    // 40-900 ms: tumbling chunks. They stamp no grit — addBreaches already put
    // the spill down at the moment of the breach, where it belongs.
    if (tier >= 1 && age >= 40 && age < 900) {
      const ts = (age - 40) / 1000;
      const n = Math.round((b.wide ? 9 : 6) * tier);
      for (let i = 0; i < n; i++) {
        const side = i & 1 ? 1 : -1;
        const ca = base + (side < 0 ? Math.PI : 0) + (hash(b.k, i, 352) - 0.5) * 1.7;
        const [dist, z] = ballistic(ts, (2.5 + hash(b.k, i, 353) * 3.5) * rs, 2 + hash(b.k, i, 354) * 2.5);
        const gx = x + Math.cos(ca) * dist * S;
        const gy = y + Math.sin(ca) * dist * S;
        if (z <= 0) continue;
        ctx.fillStyle = `rgba(20,17,12,${0.18 * (1 - Math.min(1, z / 2))})`;
        ctx.beginPath();
        ctx.ellipse(gx, gy, S * 0.12, S * 0.07, 0, 0, Math.PI * 2);
        ctx.fill();
        blit(ctx, CHUNKS[i & 3], gx, gy - z * S * 0.9, (0.07 + hash(b.k, i, 355) * 0.05) * S, 1, ts * (4 + hash(b.k, i, 356) * 8));
      }
    }
  }

  // What a missed round hits past the target. Masonry spall is deliberately a
  // different value AND hue family from the earth-brown ground dust, so a
  // player reads "that round hit the wall" without reading its position.
  // (dx, dy) is how far this tap of the burst strayed from the first, in px.
  private drawOvershoot(ctx: CanvasRenderingContext2D, cam: Camera, g: ShotGeom, o: Overshoot, dAge: number, F: number, dx: number, dy: number, cw: number, ch: number): void {
    const [bx, by] = cam.worldToScreen(o.x, o.y, cw, ch);
    const ox = bx + dx;
    const oy = by + dy;
    if (!this.onScreen(ox, oy, cw, ch, 4 * F)) return;
    if (o.kind === 'wall') {
      const base = Math.atan2(o.ny, o.nx);
      if (dAge < 260) {
        const wt = dAge / 260;
        const n = 3 + Math.floor(hash(g.hx, g.hy, 120) * 3);
        for (let i = 0; i < n; i++) {
          const ca = base + (hash(g.hx, g.hy, 130 + i) - 0.5) * 1.3;
          const dist = (0.1 + wt * 0.5) * F;
          blit(ctx, 'masonry', ox + Math.cos(ca) * dist, oy + Math.sin(ca) * dist, (0.1 + wt * 0.25) * F, (1 - wt) * 0.6);
        }
      }
      if (dAge < 300) {
        const secs = dAge / 1000;
        for (let i = 0; i < 2; i++) {
          const ca = base + (hash(g.hx, g.hy, 140 + i) - 0.5) * 1.6;
          const [dist, z] = ballistic(secs, 3 + hash(g.hx, g.hy, 150 + i) * 3, 2 + hash(g.hx, g.hy, 160 + i) * 2);
          if (z <= 0) continue;
          blit(ctx, CHUNKS[i & 3], ox + Math.cos(ca) * dist * F, oy + Math.sin(ca) * dist * F - z * F * 0.9, 0.06 * F, 1, secs * 7);
        }
      }
      return;
    }
    if (o.kind === 'foliage') {
      if (dAge >= 400) return;
      const ft = dAge / 400;
      const secs = dAge / 1000;
      for (let i = 0; i < 4; i++) {
        const drift = (0.3 + hash(g.hx, g.hy, 170 + i) * 0.7) * secs;
        const fall = (0.4 + hash(g.hx, g.hy, 180 + i) * 0.8) * secs; // leaves sink as they drift
        blit(ctx, 'leaf', ox + (WIND.dx * drift + (hash(g.hx, g.hy, 190 + i) - 0.5) * 0.4) * F, oy + (WIND.dy * drift + fall) * F, 0.09 * F, (1 - ft) * 0.85, hash(g.hx, g.hy, 200 + i) * 6.28 + secs * 3);
      }
      return;
    }
    if (dAge < IMPACT_MS) this.dirtKick(ctx, g, ox, oy, dAge / IMPACT_MS, F);
  }

  // Additive half of a shot, once per tap of its burst: muzzle flash, the
  // round in flight, kill flash, ricochet. An automatic weapon strobes — one
  // flash per round at the spacing the audio layer voices, never one flash for
  // the whole burst.
  private drawShotHot(ctx: CanvasRenderingContext2D, cam: Camera, t: Tracer, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    const g0 = this.shotGeom(cam, t, cw, ch);
    const F = fxScale(cam.scale);
    const pad = 4 * F;
    const muzzleOn = this.onScreen(g0.mx, g0.my, cw, ch, pad);
    const impactOn = this.onScreen(g0.x1, g0.y1, cw, ch, pad);
    if (!muzzleOn && !impactOn) return;
    const fc = FLASH[flashClass(t.weapon)];
    const core = Math.min(4, Math.max(1.6, 0.09 * F) * (fc.tracerW > 1 ? 1.3 : 1));

    for (let i = 0; i < t.taps; i++) {
      const age = now - t.at - i * t.gap;
      if (age < 0) break; // this round, and every one behind it, has not left yet
      // A stray is hot only while it flashes and flies. Past that it is dust,
      // and the cool pass has it.
      if (age >= (i === 0 ? SHOT_MS : Math.max(fc.life, TRAVEL_MS))) continue;
      const g = this.tapGeom(g0, i, fc.cone);
      const ang = Math.atan2(g.uy, g.ux);

      // Held, then cut: 1 - t^2 keeps the flash near full for the two frames a
      // 60 ms life gets at 60 Hz. A linear fade spent one of them at a third.
      if (muzzleOn && age < fc.life) this.muzzleFlash(ctx, F, g, ang, fc, 1 - (age / fc.life) ** 2);

      // The round in flight. Every round draws a streak, because a hairline
      // that only one shot in five carries is not a firefight. 1-in-5 rounds
      // (1-in-3 on a belt) are tracers and get the body: a wide soft
      // under-glow, a core that brightens toward the head, and a hot point on
      // the head. The rest are a thin short streak. The odds are rolled per
      // round, so a belt throws its tracers at an uneven beat.
      if (age < TRAVEL_MS) {
        const tracer = hash(g.hx, g.hy, 77) < fc.tracerOdds;
        const len = Math.hypot(g.x1 - g.mx, g.y1 - g.my);
        const head = (age / TRAVEL_MS) * len;
        // About one frame of flight, held between a floor and a cap in fx
        // metres so a point-blank shot still shows and a long one is not a beam.
        const seg = Math.min(head, Math.max(2.5 * F, Math.min(8 * F, len * 0.2)) * (tracer ? 1 : 0.5));
        const px = (d: number): number => g.mx + g.ux * d;
        const py = (d: number): number => g.my + g.uy * d;
        if (tracer) {
          ctx.lineCap = 'round';
          ctx.strokeStyle = `rgba(${fc.tracerCol},0.17)`;
          ctx.lineWidth = core * 3.4;
          ctx.beginPath();
          ctx.moveTo(px(head - seg), py(head - seg));
          ctx.lineTo(px(head), py(head));
          ctx.stroke();
          ctx.lineCap = 'butt';
          ctx.lineWidth = core;
          for (let k = 0; k < 3; k++) {
            ctx.strokeStyle = `rgba(${fc.tracerCol},${0.2 + k * 0.3})`;
            ctx.beginPath();
            ctx.moveTo(px(head - seg + (seg * k) / 3), py(head - seg + (seg * k) / 3));
            ctx.lineTo(px(head - seg + (seg * (k + 1)) / 3), py(head - seg + (seg * (k + 1)) / 3));
            ctx.stroke();
          }
          blit(ctx, 'spark', px(head), py(head), core * 1.7, 0.95);
        } else {
          ctx.strokeStyle = `rgba(${fc.tracerCol},0.34)`;
          ctx.lineWidth = Math.max(1, core * 0.6);
          ctx.beginPath();
          ctx.moveTo(px(head - seg), py(head - seg));
          ctx.lineTo(px(head), py(head));
          ctx.stroke();
        }
        continue;
      }
      if (i > 0) continue; // only the round the sim resolved strikes anything hot
      const dAge = age - TRAVEL_MS;
      if (impactOn && t.hit) {
        if (t.kill && dAge < 200) {
          const kt = dAge / 200;
          blit(ctx, 'flash', g.x1, g.y1, (0.3 + kt * 0.9) * F, (1 - kt) * 0.8);
        } else if (dAge < 90) {
          blit(ctx, 'spark', g.x1, g.y1, F * 0.18, (1 - dAge / 90) * 0.7);
        }
      }

      // Rounds finding a hard surface — cover at the target, or the masonry a
      // miss overshoots into — throw sparks back toward the shooter.
      const hard = t.over ? t.over.kind === 'wall' : t.hit && this.sim.map.terrainAt(Math.floor(t.tx), Math.floor(t.ty)).cover > 0;
      if (tier < 1 || !hard || dAge >= 260) continue;
      const [hx, hy] = t.over ? cam.worldToScreen(t.over.x, t.over.y, cw, ch) : [g.x1, g.y1];
      if (!this.onScreen(hx, hy, cw, ch, pad)) continue;
      const secs = dAge / 1000;
      const back = ang + Math.PI;
      const n = 2 + Math.floor(hash(g.hx, g.hy, 88) * 3);
      for (let k = 0; k < n; k++) {
        const a = back + (hash(g.hx, g.hy, 90 + k) - 0.5) * 2.2;
        const [dist, z] = ballistic(secs, 4 + hash(g.hx, g.hy, 100 + k) * 5, 2 + hash(g.hx, g.hy, 110 + k) * 3);
        if (z <= 0) continue;
        blit(ctx, 'spark', hx + Math.cos(a) * dist * F, hy + Math.sin(a) * dist * F - z * F * 0.9, Math.max(0.9, F * 0.06), 1 - dAge / 260);
      }
    }
  }

  // Oriented teardrop core + asymmetric spikes. The flash must be longer along
  // the barrel than across it, and no two spikes may match — three equal
  // spikes at symmetric angles is a UI arrowhead, not a muzzle flash.
  private muzzleFlash(ctx: CanvasRenderingContext2D, F: number, g: ShotGeom, ang: number, fc: FlashSpec, fa: number): void {
    if (fa <= 0) return;
    const fr = fc.r * F * (0.85 + hash(g.hx, g.hy, 3) * 0.3);
    blit(ctx, 'flash', g.mx, g.my, fr * 3.2, fa * 0.36); // soft outer falloff
    ctx.save();
    ctx.translate(g.mx, g.my);
    ctx.rotate(ang);
    ctx.scale(1.15, 0.62);
    blit(ctx, 'flash', 0.45 * fr, 0, fr, fa * 0.8);
    ctx.restore();
    // Spikes are strings of soft hot dots, not filled triangles: a hard-edged
    // polygon at these alphas is exactly the arrowhead glyph this replaces.
    const sides = SPIKE_SIDES[fc.spikes];
    for (let i = 0; i < sides.length; i++) {
      const sa = ang + fc.spread * sides[i] * (0.7 + hash(g.hx, g.hy, 20 + i) * 0.6);
      const len = fc.len * fr * (0.55 + hash(g.hx, g.hy, 30 + i) * 0.45);
      const cs = Math.cos(sa);
      const sn = Math.sin(sa);
      for (let k = 1; k <= 3; k++) {
        const f = k / 3.4;
        blit(ctx, 'spark', g.mx + cs * len * f, g.my + sn * len * f, Math.max(0.7, fr * (0.34 - k * 0.075)), fa * (0.55 - k * 0.12));
      }
    }
  }

  // Layered explosion, one recipe per kind (fx.ts BLAST). Order is the whole
  // trick: the ground beats (shock ring, dust) go down first, the thrown earth
  // over them, then smoke, then the fireball with a soot rim biting into its
  // edge — dark-around-bright is why a blast reads. The smoke lobes outlive
  // the fire, so the fireball turns into its own column instead of being
  // replaced by one.
  //
  // Strict plan view: no smoke here rises up the screen. A lobe's height is
  // its drift down the wind axis and the shadow it drops down-sun.
  private drawBoom(ctx: CanvasRenderingContext2D, cam: Camera, b: Boom, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    const age = now - b.at;
    const sp = b.spec;
    const k = b.k;
    const S = blastScale(cam.scale);
    const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
    const pad = (Math.max(sp.ring, sp.throw + 3, sp.fire * 4) * k + (WIND.speed * sp.hang) / 1000) * S;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    const sx = Math.round(b.x * 100);
    const sy = Math.round(b.y * 100);
    const lite = MOBILE ? 0.5 : 1;
    const fire = sp.fire * k * S; // fireball radius in px — most of the recipe hangs off it
    const secs = age / 1000;

    // The shockwave: a thin pale front with its own dark compression line
    // just inside it. The pair reads over grass, dirt and cobbles alike, which
    // a single tan ring at these values never did. It leaves the flash late and
    // fades on a square, so it is an edge passing and never a circle drawn
    // round the blast.
    const ringMs = 240 + sp.ring * k * 16;
    if (age >= 30 && age < ringMs) {
      const t = (age - 30) / (ringMs - 30);
      const rr = (0.3 + 0.7 * (1 - (1 - t) ** 2)) * sp.ring * k * S;
      const a = Math.min(1, t * 5) * (1 - t);
      blit(ctx, 'ringDark', x, y, rr * 0.92, 0.3 * a);
      blit(ctx, 'shock', x, y, rr, 0.5 * a * (1 - t));
    }
    // ...and the ground dust it drags up behind it, slower and lower.
    if (sp.dust > 0.2 && age >= 60 && age < ringMs * 3) {
      const t = (age - 60) / (ringMs * 3 - 60);
      blit(ctx, 'ringTan', x, y, (0.8 + (1 - (1 - t) ** 2) * sp.ring * k * 0.62) * S, 0.55 * sp.dust * (1 - t));
    }

    // Dust that hangs: lobes that open fast, then spread and thin on the wind
    // for the rest of the blast's life. Every other lobe is a small dense one,
    // so the cloud has a body and an edge rather than one airbrushed value.
    if (sp.dust > 0 && age >= 80 && age < sp.hang) {
      const t = (age - 80) / (sp.hang - 80);
      const open = 1 - Math.exp(-(age - 80) / 450);
      const n = Math.max(3, Math.round((2 + 5 * sp.dust) * lite));
      const a0 = sp.dust * 0.8 * Math.min(1, (age - 80) / 120) * (1 - t) ** 1.2;
      const wx = WIND.dx * WIND.speed * secs * 0.5 * S;
      const wy = WIND.dy * WIND.speed * secs * 0.5 * S;
      for (let i = 0; i < n; i++) {
        const knot = i & 1;
        const ang = hash(sx, sy, 300 + i) * Math.PI * 2;
        const d = (0.2 + open * (0.4 + hash(sx, sy, 310 + i) * (knot ? 1.3 : 0.8))) * (fire + S) * 1.1;
        const r = ((0.9 + open * 1.1 + t * 0.9) * fire * (0.8 + hash(sx, sy, 320 + i) * 0.4) + S * 0.6) * (knot ? 0.55 : 1);
        blit(ctx, 'dustTan', x + Math.cos(ang) * d + wx, y + Math.sin(ang) * d + wy, r, a0 * (knot ? 1 : 0.7));
      }
    }

    // Thrown earth, seen from above: a ragged dark mass punched out of the
    // ground. Lobes of every size, and the distance squared so most of them
    // stay close and only a few go wide — an even ring of equal lobes is a
    // flower, not a fountain.
    const throwMs = 420 + sp.throw * k * 30;
    if (sp.spokes > 0 && age < throwMs * 1.4) {
      const t = age / (throwMs * 1.4);
      const e = 1 - (1 - t) ** 3;
      const reach = sp.throw * k * S;
      const n = Math.max(5, Math.round(sp.spokes * (tier === 0 ? 0.5 : 1) * lite));
      const a = 0.85 * (1 - t) ** 1.3;
      for (let i = 0; i < n; i++) {
        const ang = hash(sx, sy, 10 + i) * Math.PI * 2;
        const d = (0.08 + 0.62 * hash(sx, sy, 40 + i) ** 2) * reach * e;
        const r = (0.06 + 0.17 * hash(sx, sy, 70 + i) ** 1.5) * reach * (0.6 + 0.4 * e) + S * 0.15;
        blit(ctx, 'dirt', x + Math.cos(ang) * d, y + Math.sin(ang) * d, r, a);
      }
    }
    // ...and the few fast outliers that leave it. Each is a small clod with a
    // trail behind it that thins to a point and is gone well before the clod
    // lands. One to four of them, never a spoke per lobe: a dozen straight
    // lines of one length ending in a knob read as an insect.
    if (sp.spokes > 0 && tier >= 1 && age < throwMs) {
      const t = age / throwMs;
      const e = 1 - (1 - t) ** 2;
      const F = fxScale(cam.scale);
      const n = Math.max(1, Math.round((1 + hash(sx, sy, 5) * 0.2 * sp.spokes) * lite));
      const trail = Math.max(0, 1 - t / 0.55);
      if (trail > 0) {
        ctx.fillStyle = `rgba(58,45,30,${0.75 * trail})`;
        ctx.beginPath();
      }
      for (let i = 0; i < n; i++) {
        const ang = hash(sx, sy, 360 + i) * Math.PI * 2;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const len = (0.55 + 0.6 * hash(sx, sy, 370 + i)) * sp.throw * k * S * e;
        const w = (0.09 + 0.08 * hash(sx, sy, 380 + i)) * F;
        if (trail > 0) {
          const tail = len * (0.4 + 0.45 * t);
          ctx.moveTo(x + cs * tail, y + sn * tail);
          ctx.lineTo(x + cs * len - sn * w, y + sn * len + cs * w);
          ctx.lineTo(x + cs * len + sn * w, y + sn * len - cs * w);
          ctx.closePath();
        }
        blit(ctx, CHUNKS[i & 3], x + cs * len, y + sn * len, w * 1.5, 1 - t ** 3, hash(sx, sy, 390 + i) * 6.28 + t * 5);
      }
      if (trail > 0) ctx.fill();
    }

    // Smoke. It starts as the fire's own soot and stays when the fire is out:
    // the lobes spread, and the ones higher in the column are carried further
    // downwind. Burning fuel never greys; anything else cools from black.
    const after = Math.max(0, age - sp.burn) / 1000; // seconds since the fire went out
    if (sp.smoke > 0 && age >= 40) {
      const t = age / sp.hang;
      const open = 1 - Math.exp(-age / (sp.burn * 0.6));
      const a = sp.smoke * 0.9 * Math.min(1, age / sp.burn) * (1 - t) ** 1.2;
      const soot = sp.rim > 0.9 ? 1 : 1 - Math.min(1, after / 3) * 0.7;
      const n = Math.max(3, Math.round((3 + 4 * sp.smoke) * lite));
      const wind = after * WIND.speed * S;
      if (sp.smoke >= 0.5 && after > 0) {
        // The column's shadow. It lands down-sun of the smoke by its height,
        // which is the only place in a plan view that height can show.
        const h = Math.min(8, 1 + after * 2.2);
        blit(ctx, 'soot', x + WIND.dx * wind * 0.5 + SUN.dx * h * 0.3 * S, y + WIND.dy * wind * 0.5 + SUN.dy * h * 0.3 * S, fire * 1.3 * (1 + after * 0.2), 0.22 * sp.smoke * (1 - t) * sun().alphaMul);
      }
      for (let i = 0; i < n; i++) {
        const knot = i & 1; // small and dense between the big soft ones: the roil
        const u = n > 1 ? i / (n - 1) : 0; // 0 = the base of the column, 1 = its top
        const ang = hash(sx, sy, 110 + i) * Math.PI * 2 + secs * (hash(sx, sy, 115 + i) - 0.5) * (knot ? 2.2 : 1.2);
        const d = fire * (0.35 + 0.6 * hash(sx, sy, 120 + i)) * (0.35 + 0.65 * open) * (1 + after * 0.15);
        const r = fire * (0.62 + 0.3 * hash(sx, sy, 125 + i)) * (0.55 + 0.45 * open) * (1 + after * 0.22) * (knot ? 0.55 : 1);
        const lx = x + Math.cos(ang) * d + WIND.dx * wind * (0.35 + 0.65 * u);
        const ly = y + Math.sin(ang) * d + WIND.dy * wind * (0.35 + 0.65 * u);
        blit(ctx, 'soot', lx, ly, r, a * soot);
        blit(ctx, 'smoke', lx, ly, r, a * (1 - soot) * 0.8);
      }
    }

    // The fireball: staggered offset lobes — the asymmetry is what stops an
    // explosion reading as a disc. A brew-up rolls: more lobes, further apart.
    const brew = sp.rim > 0.9;
    const lobes = brew ? 5 : 3;
    for (let i = 0; i < lobes; i++) {
      const start = 20 + i * sp.burn * 0.09;
      if (age < start || age >= sp.burn) continue;
      const t = (age - start) / (sp.burn - start);
      const e = 1 - (1 - t) ** 2;
      const ang = hash(sx, sy, 100 + i) * Math.PI * 2;
      const d = fire * (0.15 + (brew ? 0.6 : 0.4) * hash(sx, sy, 130 + i)) * (0.4 + 0.6 * e);
      blit(ctx, 'fire', x + Math.cos(ang) * d, y + Math.sin(ang) * d, fire * (0.45 + 0.5 * e) * (0.7 + 0.45 * hash(sx, sy, 135 + i)), (1 - t) ** 0.8 * 0.92);
    }
    // ...and the soot biting into its edge, thickening as the fire burns out.
    if (age >= 40 && age < sp.burn + 250) {
      const t = Math.min(1, age / sp.burn);
      const a = sp.rim * (0.35 + 0.5 * t) * Math.min(1, (age - 40) / 50) * Math.max(0, 1 - after / 0.25);
      for (let i = 0; i < lobes + 1; i++) {
        const ang = hash(sx, sy, 140 + i) * Math.PI * 2 + secs * (hash(sx, sy, 145 + i) - 0.5) * 3;
        const d = fire * (0.7 + 0.35 * hash(sx, sy, 146 + i)) * (0.45 + 0.55 * t);
        blit(ctx, 'soot', x + Math.cos(ang) * d, y + Math.sin(ang) * d, fire * (0.34 + 0.22 * hash(sx, sy, 147 + i)) * (0.6 + 0.5 * t), a);
      }
    }

    // 60-1600 ms: debris on real ballistic arcs with ground shadows — the one
    // thing that gives a blast mass. Each chunk stamps grit where it lands.
    if (tier >= 1 && age >= 60 && age < 1600) {
      const ts = (age - 60) / 1000;
      const F = fxScale(cam.scale);
      const n = Math.min(24, Math.round(sp.debris * (tier === 2 ? 1 : 0.6) * lite));
      for (let i = 0; i < n; i++) {
        const v = (3.5 + hash(sx, sy, 150 + i) * 6) * (0.6 + 0.4 * k);
        const vz = 3 + hash(sx, sy, 160 + i) * 3.5;
        const [dist, z] = ballistic(ts, v, vz);
        const ang = hash(sx, sy, 170 + i) * Math.PI * 2;
        const gx = x + Math.cos(ang) * dist * S;
        const gy = y + Math.sin(ang) * dist * S;
        if (z <= 0) {
          if (!(b.landed & (1 << i))) {
            b.landed |= 1 << i;
            this.decals.grit(b.x + Math.cos(ang) * dist, b.y + Math.sin(ang) * dist);
          }
          continue;
        }
        ctx.fillStyle = `rgba(20,17,12,${0.18 * (1 - Math.min(1, z / 2))})`;
        ctx.beginPath();
        ctx.ellipse(gx, gy, F * 0.13, F * 0.08, 0, 0, Math.PI * 2);
        ctx.fill();
        const cr = (0.1 + hash(sx, sy, 180 + i) * 0.08) * F;
        blit(ctx, CHUNKS[i & 3], gx, gy - z * S * 0.9, cr, 1, ts * (4 + hash(sx, sy, 190 + i) * 8));
      }
    }
  }

  // Additive half of the explosion: the flash and its rays, the light the
  // fireball throws on the ground round it, its hot core, and the sparks.
  // Nothing here outlives the burn but the sparks, so `lighter` never gets a
  // chance to bleach the muted palette.
  private drawBoomHot(ctx: CanvasRenderingContext2D, cam: Camera, b: Boom, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    const age = now - b.at;
    const sp = b.spec;
    if (age >= Math.max(sp.burn, SPARK_MS)) return;
    const k = b.k;
    const S = blastScale(cam.scale);
    const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
    const pad = Math.max(sp.flash * 2, 18) * k * S;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    const sx = Math.round(b.x * 100);
    const sy = Math.round(b.y * 100);
    const fire = sp.fire * k * S;
    if (age < BLAST_FLASH_MS) {
      const t = age / BLAST_FLASH_MS;
      const fr = sp.flash * k * S;
      blit(ctx, 'flash', x, y, fr * (0.45 + 0.55 * Math.sqrt(t)), (1 - t) ** 0.6);
      blit(ctx, 'flash', x, y, fr * 0.36, (1 - t) ** 0.35); // hard white core
      // Rays: the flash squeezed thin and thrown out on a few uneven bearings.
      // A round flash is a disc; a disc with rays is a detonation. Steel
      // throws more of them, and longer.
      const rays = sp.sparks > 12 ? 7 : 4;
      for (let i = 0; i < rays; i++) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(hash(sx, sy, 440 + i) * Math.PI * 2);
        ctx.scale(1, 0.12 + hash(sx, sy, 450 + i) * 0.08);
        blit(ctx, 'flash', 0, 0, fr * (sp.sparks > 12 ? 1.9 : 1.35) * (0.6 + hash(sx, sy, 460 + i) * 0.6), (1 - t) * 0.75);
        ctx.restore();
      }
    }
    if (age < sp.burn) {
      const t = age / sp.burn;
      blit(ctx, 'fire', x, y, fire * (1.5 + 0.9 * t), 0.22 * (1 - t)); // a light POOL on the ground, no direction
      blit(ctx, 'fire', x, y, fire * (0.5 + 0.35 * (1 - (1 - t) ** 2)), (1 - t) ** 0.7 * 0.8);
      if (t < 0.5) blit(ctx, 'flash', x, y, fire * 0.42, (1 - t * 2) * 0.85);
    }
    // Sparks: steel, or ammunition. Ballistic like the debris, but hot and
    // fast. One batched stroke draws every tail, then a hot point per head.
    if (tier < 1 || sp.sparks === 0 || age >= SPARK_MS) return;
    const secs = age / 1000;
    const F = fxScale(cam.scale);
    const n = Math.round(sp.sparks * (tier === 2 ? 1 : 0.6) * (MOBILE ? 0.5 : 1));
    ctx.strokeStyle = `rgba(255,214,140,${0.85 * (1 - age / SPARK_MS)})`;
    ctx.lineWidth = Math.max(1.2, 0.07 * F);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const life = 0.5 + hash(sx, sy, 400 + i) * 0.4;
      if (secs >= life) continue;
      const v = (4 + hash(sx, sy, 410 + i) * 11) * Math.sqrt(k);
      const vz = 3 + hash(sx, sy, 420 + i) * 5;
      const [dist, z] = ballistic(secs, v, vz);
      if (z <= 0 && secs > 0.05) continue;
      const ang = hash(sx, sy, 430 + i) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const hx = x + cs * dist * S;
      const hy = y + sn * dist * S - z * S * 0.9;
      const [d0, z0] = ballistic(Math.max(0, secs - 0.045), v, vz);
      ctx.moveTo(x + cs * d0 * S, y + sn * d0 * S - z0 * S * 0.9);
      ctx.lineTo(hx, hy);
      blit(ctx, 'spark', hx, hy, 0.13 * F, (1 - secs / life) ** 0.6);
    }
    ctx.stroke();
  }
}
