import type { Emplacement } from '../sim/emplacement';
import { MELEE_STRIKE_RANGE, type MeleeEvent, type ShotEvent, type Side, type Sim, type Soldier, type Vehicle } from '../sim/sim';
import type { Camera } from './camera';
import { DecalLayer } from './decals';
import { bandFor, getSprite, SPRITE_MIN_SCALE, SPRITE_SPAN, WALK_FRAMES, type Pose } from './dudes';
import { ballistic, blit, FLASH, flashClass, fxDetail, hazeBand, hotPass, SPIKE_SIDES, traceOvershoot, WIND, type FlashSpec, type FxKind, type Overshoot } from './fx';
import { MarkLayer } from './marks';
import { RoofLayer } from './roofs';
import { TerrainLayer } from './terrain';
import { view } from './view';
import { getVehicleSprite, vehicleBandFor, VEHICLE_SPAN } from './vehicles';

interface Tracer extends ShotEvent {
  at: number; // ms timestamp
  over?: Overshoot; // misses only: where the round actually came down
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
}

interface Boom {
  x: number;
  y: number;
  at: number;
  r?: number; // blast radius in meters; undefined = the mortar/barrage default
  landed: number; // bitmask of debris chunks whose grit decal is already stamped
}

// Blast radius → visual multiplier. Everything in the explosion (radii,
// particle counts, camera trauma, crater size) rides this one number, so a
// grenade cannot read like an 81 mm shell.
function boomScale(r: number | undefined): number {
  return Math.min(1.2, Math.max(0.33, (r ?? 9) / 9));
}

interface Plane {
  x0: number;
  y: number;
  x1: number;
  at: number;
}

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
const BIRD_CAP = 24;
const BIRD_SPEED = 11; // m/s

const SMOKE_LEAN_MAX = 2; // m — a smoke screen streams, but never off the tile it is blocking
const HAZE_MAX_SCALE = 22; // px/m — above this you can count boots and haze is just fog on the lens
const MOTE_MIN_SCALE = 20;
const MOTE_CAP = 24;

// Positive modulo — the wrapping every world-anchored ambient layer needs, and
// the thing `%` alone gets wrong the moment wind drift goes negative.
function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

const PLANE_MS = 2600;
const BOOM_MS = 2600; // longest sub-effect (smoke column) sets total lifetime
const FADE_MS = 150; // faint thread lifetime
const TRAVEL_MS = 90; // muzzle->target travel time for the bright segment (E3)
const IMPACT_MS = 250; // impact dust lifetime, starts at TRAVEL_MS (E5)
const CHUNKS: FxKind[] = ['chunk0', 'chunk1', 'chunk2', 'chunk3'];

const TEAM = { blue: '#5b9bd5', red: '#d05c50' } as const;

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
  private deadVehicles = new Set<number>(); // scorch stamped once, on first dead frame
  private lastNow = 0;
  private booms: Boom[] = [];
  private decals: DecalLayer;
  private marks = new MarkLayer();
  private barrageMarks: { x: number; y: number; tick: number }[] = [];
  private strafeMarks: { x: number; y: number; tick: number }[] = [];
  private planes: Plane[] = [];
  private smokeMaxTtl = new Map<number, number>(); // per-entry spawn ttl, keyed by its (stable) x,y — lets alpha envelope derive from sim time alone
  private fires = new Map<number, Fire>();
  private lit: Fire[] = []; // this frame's visible fires, shared by the cool and hot passes
  private licks: number[] = []; // flat (x, y, r, alpha) quads — flame cores queued for the fire hot pass
  private birds: Bird[] = [];
  private boomSeq = 0;
  private haze: { x: number; y: number; len: number; hgt: number; a: number }[];
  hazeOn = true; // ?haze=0, matching the ?fow=0 debug-switch pattern
  selectedVehicle = -1;

  constructor(private sim: Sim) {
    this.terrain = new TerrainLayer(sim.map);
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
  }

  addEvents(events: ShotEvent[], now: number): void {
    for (const e of events) {
      const t: Tracer = { ...e, at: now };
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

  addBooms(booms: { x: number; y: number; r?: number }[], now: number): void {
    for (const b of booms) {
      this.boomSeq++;
      this.booms.push({ ...b, at: now, landed: 0 });
      this.decals.scorch(b.x, b.y, boomScale(b.r));
      // Ignition is render-derived: a blast inside a building footprint is the
      // only cause of a building fire, because that is the only cause the
      // player watched happen.
      const bid = this.sim.map.buildingIdAt(Math.floor(b.x), Math.floor(b.y));
      if (bid >= 0) this.stoke(bid, b.x, b.y, -1);
      this.flush(b.x, b.y, now);
    }
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
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    ctx.fillStyle = '#161510'; // darker desaturated earth tone off-map, replacing the flat void
    ctx.fillRect(0, 0, cw, ch); // backdrop stays unshaken so shake never opens a gap at the map edge
    ctx.imageSmoothingEnabled = true;

    // Camera shake: world layers only (HUD/picking stay steady — worldToScreen
    // is untouched). Stateless, derived from recent booms' screen proximity plus
    // a faint tremor from fresh nearby fire. Wall-clock, so it decays under pause.
    const [shx, shy] = this.worldShake(cam, now, cw, ch);
    ctx.save();
    ctx.translate(shx, shy);

    this.terrain.draw(ctx, cam, cw, ch);
    const [mx0, my0] = cam.worldToScreen(0, 0, cw, ch);
    const [mx1, my1] = cam.worldToScreen(this.sim.map.w, this.sim.map.h, cw, ch);
    ctx.strokeStyle = 'rgba(18,16,12,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(mx0, my0, mx1 - mx0, my1 - my0);
    this.decals.draw(ctx, cam, cw, ch);
    this.marks.draw(ctx, cam, cw, ch);
    this.roofs.update(this.sim, cam, dt);
    this.roofs.drawShadows(ctx, cam, cw, ch);
    this.roofs.drawWalls(ctx, cam, cw, ch);
    // stair glyphs only where the roof fade reveals the interior
    this.terrain.drawStairs(ctx, cam, cw, ch, (x, y) => this.roofs.interiorVisibleAt(x, y));
    // Ambient air sits over the ground and under the men — a haze band in front
    // of a soldier would read as a bug, behind him it reads as distance.
    this.drawHaze(ctx, cam, cw, ch);
    this.drawMotes(ctx, cam, cw, ch);

    // Fog of war: everything below asks the sim's *VisibleTo helpers from the
    // player's side — the renderer never re-derives vision.
    const vis = (s: Soldier) => this.sim.soldierVisibleTo(PLAYER_SIDE, s);
    const visV = (v: Vehicle) => this.sim.vehicleVisibleTo(PLAYER_SIDE, v);
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

    this.drawFire(ctx, cam, now, cw, ch);
    this.roofs.drawTops(ctx, cam, cw, ch);
    this.roofs.drawChimneySmoke(ctx, cam, cw, ch);
    this.drawFires(ctx, cam, now, cw, ch); // over the roof it is consuming, under the smoke screens
    this.drawBirds(ctx, cam, now, cw, ch);
    this.drawSmoke(ctx, cam, cw, ch);
    this.drawContacts(ctx, cam, cw, ch);
    this.drawPlanes(ctx, cam, now, cw, ch);
    this.drawBarrageMarks(ctx, cam, now, cw, ch);
    ctx.restore();
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
      if (age > 350) continue;
      trauma = Math.max(trauma, (1 - age / 350) * prox(b.x, b.y) * (0.45 + 0.55 * boomScale(b.r)));
    }
    let fire = 0;
    for (const t of this.tracers) {
      if (now - t.at > 45) continue;
      fire += 0.02 * prox(t.fx, t.fy);
      if (fire >= 0.12) break; // cap — never let volume of fire alone jolt the camera
    }
    trauma = Math.min(1, trauma + Math.min(0.12, fire));
    if (trauma < 0.001) return [0, 0];
    const mag = Math.pow(trauma, 1.5) * 7; // px; ^1.5 keeps small tremors gentle
    return [mag * Math.sin(now * 0.09), mag * Math.sin(now * 0.13 + 1.7)];
  }

  // sim.smoke (E1): entries carry only {x, y, ttl}, x/y fixed for the entry's
  // life, ttl counting seconds left — sim-owned and sim-tick-driven, so every
  // bit of animation here derives from ttl alone. Never read `now`: that is
  // what keeps this frozen exactly in place while paused.
  private drawSmoke(ctx: CanvasRenderingContext2D, cam: Camera, cw: number, ch: number): void {
    const seen = new Set<number>();
    for (const p of this.sim.smoke) {
      const key = p.x * 100000 + p.y; // stable for the entry's lifetime (x,y never change)
      seen.add(key);
      let maxTtl = this.smokeMaxTtl.get(key);
      if (maxTtl === undefined || p.ttl > maxTtl) {
        maxTtl = p.ttl;
        this.smokeMaxTtl.set(key, maxTtl);
      }
      const elapsed = maxTtl - p.ttl;
      const life = maxTtl > 0 ? elapsed / maxTtl : 1;
      let envelope = 1;
      if (life < 0.1) envelope = life / 0.1; // fade in
      else if (life > 0.7) envelope = Math.max(0, (1 - life) / 0.3); // fade out

      const [ox, oy] = cam.worldToScreen(p.x, p.y, cw, ch);
      const pad = 5 * cam.scale;
      if (ox < -pad || oy < -pad || ox > cw + pad || oy > ch + pad) continue;

      // Prevailing lean: a screen streams downwind instead of billowing like a
      // flower. Derived from `elapsed` (sim-owned ttl), never `now`, so it
      // freezes under pause with everything else — and capped, because the
      // cloud has to keep marking the tile the sim is blocking LOS through.
      const leanX = WIND.dx * Math.min(elapsed * WIND.speed * 0.35, SMOKE_LEAN_MAX);
      const leanY = WIND.dy * Math.min(elapsed * WIND.speed * 0.35, SMOKE_LEAN_MAX);

      const n = 3 + Math.floor(hash(p.x, p.y, 9) * 3); // 3-5 puffs
      for (let i = 0; i < n; i++) {
        const angle0 = hash(p.x, p.y, 10 + i) * Math.PI * 2;
        const dist0 = 0.2 + hash(p.x, p.y, 20 + i) * 0.35;
        const drift = 0.015 + hash(p.x, p.y, 30 + i) * 0.025; // slow outward drift, m/s of sim time
        const spin = (hash(p.x, p.y, 40 + i) - 0.5) * 0.15; // slow rotation, rad/s
        const baseR = 1.0 + hash(p.x, p.y, 50 + i) * 0.6;
        const angle = angle0 + elapsed * spin;
        const dist = dist0 + elapsed * drift;
        const r = Math.min(baseR * 1.8, baseR + elapsed * 0.012);
        const wx = p.x + Math.cos(angle) * dist + leanX;
        const wy = p.y + Math.sin(angle) * dist + leanY;
        const [sx, sy] = cam.worldToScreen(wx, wy, cw, ch);
        const sr = r * cam.scale;
        const cool = hash(p.x, p.y, 60 + i);
        blit(ctx, 'smoke', sx, sy, sr, envelope * (0.28 + cool * 0.08));
      }
    }
    for (const key of this.smokeMaxTtl.keys()) if (!seen.has(key)) this.smokeMaxTtl.delete(key);
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
    if (this.fires.size === 0) return;

    const S = cam.scale;
    const tier = fxDetail(S);
    const pad = 9 * S;
    this.lit.length = 0;
    this.licks.length = 0;
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
        this.licks.push(sx, sy, r * 0.45, 0.5 + 0.3 * flick); // hot cores, drawn in the frame's fire hot pass
      }
    }
    if (this.lit.length === 0) return;

    hotPass(ctx, () => {
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
    });
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

  private drawVehicle(ctx: CanvasRenderingContext2D, cam: Camera, v: Vehicle, cw: number, ch: number): void {
    const [x, y] = cam.worldToScreen(v.x, v.y, cw, ch);
    const pad = VEHICLE_SPAN * cam.scale;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    if (!v.alive && !this.deadVehicles.has(v.id)) {
      this.deadVehicles.add(v.id);
      this.decals.scorch(v.x, v.y); // stamped once, under the wreck sprite from here on
    }
    const spr = getVehicleSprite(v.kind, v.side, v.alive ? 'ok' : 'dead', vehicleBandFor(cam.scale));
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

  // Simple crewed-weapon glyph — follows drawVehicle's scheme (team-colored
  // hull + barrel line) at ~40% of a vehicle's footprint. Dashed while
  // packed/transitioning, solid once dug in.
  private drawEmplacement(ctx: CanvasRenderingContext2D, cam: Camera, e: Emplacement, selectedSquads: number[], cw: number, ch: number): void {
    const [x, y] = cam.worldToScreen(e.x, e.y, cw, ch);
    const pad = VEHICLE_SPAN * cam.scale * 0.4;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    const color = TEAM[e.side];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(e.facing);
    if (e.state !== 'deployed') ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, cam.scale * 0.12);
    ctx.fillStyle = 'rgba(60, 58, 50, 0.85)';
    const r = Math.max(2.5, cam.scale * 0.34 * 0.4 * 10); // mount footprint, ~40% of a soldier's read
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r * 1.6, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
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
      st = { facing: s.side === 'blue' ? 0 : Math.PI, phase: 0, px: s.x, py: s.y, smx: s.x, smy: s.y, wasAlive: true };
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

    let pose: Pose;
    let frame = 0;
    if (!s.alive) pose = 'dead';
    else if (s.captured) pose = 'surrendered';
    else if (s.downed) pose = carried ? 'dragged' : 'downed';
    else if (s.task?.phase === 'drag') pose = 'drag';
    else if (s.task?.phase === 'aid') pose = 'aid';
    else if (s.meleeId >= 0 && this.inStrikeRange(s)) {
      // sim-driven strike cycle (freezes on pause, like walk): the thrust
      // frame shows right after the phase wrap, when the MeleeEvent lands
      pose = 'melee';
      frame = s.meleePhase < 0.18 ? 2 : s.meleePhase < 0.42 ? 3 : s.meleePhase < 0.78 ? 0 : 1;
    } else if (s.mental === 'pinned' || (s.mental === 'broken' && !s.path)) pose = 'prone';
    else if (moved > 1e-4) {
      pose = 'walk';
      st.phase += moved * 1.4;
      frame = Math.floor((st.phase % 1) * WALK_FRAMES);
    } else if (s.targetId >= 0) pose = s.suppression > 0.15 ? 'kneel' : 'aim';
    else pose = 'idle';

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

    const band = bandFor(cam.scale);
    const spr = getSprite(s.side, s.weapon, pose, frame, band);
    const facing = s.alive ? (dragFacing ?? st.facing) : st.facing + ((s.id * 2654435761) % 100) / 100 - 0.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(facing);
    // upper-floor soldiers read slightly larger — a cue they're above ground
    const lvl = s.level > 0 ? 1.06 : 1;
    ctx.drawImage(spr, (-pad / 2) * lvl, (-pad / 2) * lvl, pad * lvl, pad * lvl);
    ctx.restore();

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
    // one-ring rule (S7): selection wins over suppression, never both
    if (selectedSquads.includes(s.squadId)) {
      ctx.strokeStyle = '#ffe9a0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, cam.scale * 0.6 + 2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (!s.downed && s.suppression > 0.35) {
      ctx.strokeStyle = `rgba(255, 180, 40, ${Math.min(0.9, s.suppression)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, cam.scale * 0.55 + 1.5, 0, Math.PI * 2);
      ctx.stroke();
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
    this.tracers = this.tracers.filter((t) => now - t.at < TRAVEL_MS + IMPACT_MS);
    for (const t of this.tracers) this.drawShotCool(ctx, cam, t, now, cw, ch);

    this.booms = this.booms.filter((b) => now - b.at < BOOM_MS);
    for (const b of this.booms) this.drawBoom(ctx, cam, b, now, cw, ch, tier);

    // One additive batch for the whole frame: the composite mode flips twice,
    // never once per particle.
    hotPass(ctx, () => {
      for (const t of this.tracers) this.drawShotHot(ctx, cam, t, now, cw, ch, tier);
      for (const b of this.booms) this.drawBoomHot(ctx, cam, b, now, cw, ch);
    });
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

  // Source-over half of a shot: the faint thread every round leaves, the
  // weapon's smoke/dust signature, impact dust and the kill ring.
  private drawShotCool(ctx: CanvasRenderingContext2D, cam: Camera, t: Tracer, now: number, cw: number, ch: number): void {
    const g = this.shotGeom(cam, t, cw, ch);
    const pad = 6 * cam.scale;
    const muzzleOn = this.onScreen(g.mx, g.my, cw, ch, pad);
    const impactOn = this.onScreen(g.x1, g.y1, cw, ch, pad);
    if (!muzzleOn && !impactOn) return;
    const age = now - t.at;
    const fc = FLASH[flashClass(t.weapon)];

    if (age < FADE_MS) {
      const a = 1 - age / FADE_MS;
      ctx.strokeStyle = `rgba(${fc.tracerCol},${(t.hit ? 0.18 : 0.12) * a})`;
      ctx.lineWidth = fc.tracerW;
      ctx.beginPath();
      ctx.moveTo(g.mx, g.my);
      ctx.lineTo(g.x1, g.y1);
      ctx.stroke();
    }

    // Rocket back-blast: the cone of smoke out the rear tube. The most
    // characteristic WW2 silhouette the effects layer was missing.
    if (muzzleOn && fc.extra === 'backblast' && age < 400) {
      const bt = age / 400;
      const reach = 0.6 + bt * 2.4;
      for (let i = 0; i < 6; i++) {
        const f = (i + 0.5) / 6; // position along the cone — puffs widen with distance
        const along = f * reach;
        const lat = (hash(g.hx, g.hy, 30 + i) - 0.5) * 1.6 * f * reach;
        const px = g.mx + (-g.ux * along - g.uy * lat) * cam.scale;
        const py = g.my + (-g.uy * along + g.ux * lat) * cam.scale;
        const r = (0.3 + f * 0.7 + bt * 0.5) * cam.scale;
        blit(ctx, 'smoke', px, py, r, (1 - bt) * 0.42 * (1 - f * 0.35));
        blit(ctx, 'soot', px, py, r * 0.75, (1 - bt) * 0.32 * Math.max(0, 1 - bt / 0.4));
      }
    }

    // Gun muzzle-blast wash: the ground dust that gives away a gun position.
    if (muzzleOn && fc.extra === 'wash' && age < 700) {
      const wt = age / 700;
      const ahead = Math.atan2(g.uy, g.ux);
      for (let i = 0; i < 3; i++) {
        const ca = ahead + (hash(g.hx, g.hy, 50 + i) - 0.5) * 0.7;
        const dist = (1.5 + wt * 2.5 + hash(g.hx, g.hy, 60 + i) * 0.8) * cam.scale;
        blit(ctx, 'dustTan', g.mx + Math.cos(ca) * dist, g.my + Math.sin(ca) * dist, (0.8 + wt * 1.6) * cam.scale, (1 - wt) * 0.35);
      }
    }

    if (age < TRAVEL_MS) return;
    const dAge = age - TRAVEL_MS;
    if (t.over) {
      this.drawOvershoot(ctx, cam, g, t.over, dAge, cw, ch);
      return;
    }
    if (!impactOn) return;
    if (dAge < IMPACT_MS) {
      const dt = dAge / IMPACT_MS;
      for (let i = 0; i < 3; i++) {
        const ang = hash(g.hx + i, g.hy, 70) * Math.PI * 2;
        const dist = (0.12 + dt * 0.3) * cam.scale;
        blit(ctx, 'dustTan', g.x1 + Math.cos(ang) * dist, g.y1 + Math.sin(ang) * dist, Math.max(1, cam.scale * 0.16), (1 - dt) * 0.5);
      }
    }
    if (t.hit && t.kill && dAge < 200) {
      const kt = dAge / 200;
      ctx.strokeStyle = `rgba(214, 186, 150, ${(1 - kt) * 0.7})`;
      ctx.lineWidth = Math.max(1, cam.scale * 0.08);
      ctx.beginPath();
      ctx.arc(g.x1, g.y1, (0.4 + kt * 2.2) * cam.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // What a missed round hits past the target. Masonry spall is deliberately a
  // different value AND hue family from the earth-brown ground dust, so a
  // player reads "that round hit the wall" without reading its position.
  private drawOvershoot(ctx: CanvasRenderingContext2D, cam: Camera, g: ShotGeom, o: Overshoot, dAge: number, cw: number, ch: number): void {
    const [ox, oy] = cam.worldToScreen(o.x, o.y, cw, ch);
    if (!this.onScreen(ox, oy, cw, ch, 4 * cam.scale)) return;
    const S = cam.scale;
    if (o.kind === 'wall') {
      const base = Math.atan2(o.ny, o.nx);
      if (dAge < 260) {
        const wt = dAge / 260;
        const n = 3 + Math.floor(hash(g.hx, g.hy, 120) * 3);
        for (let i = 0; i < n; i++) {
          const ca = base + (hash(g.hx, g.hy, 130 + i) - 0.5) * 1.3;
          const dist = (0.1 + wt * 0.5) * S;
          blit(ctx, 'masonry', ox + Math.cos(ca) * dist, oy + Math.sin(ca) * dist, (0.1 + wt * 0.25) * S, (1 - wt) * 0.6);
        }
      }
      if (dAge < 300) {
        const secs = dAge / 1000;
        for (let i = 0; i < 2; i++) {
          const ca = base + (hash(g.hx, g.hy, 140 + i) - 0.5) * 1.6;
          const [dist, z] = ballistic(secs, 3 + hash(g.hx, g.hy, 150 + i) * 3, 2 + hash(g.hx, g.hy, 160 + i) * 2);
          if (z <= 0) continue;
          blit(ctx, CHUNKS[i & 3], ox + Math.cos(ca) * dist * S, oy + Math.sin(ca) * dist * S - z * S * 0.9, 0.06 * S, 1, secs * 7);
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
        blit(ctx, 'leaf', ox + (WIND.dx * drift + (hash(g.hx, g.hy, 190 + i) - 0.5) * 0.4) * S, oy + (WIND.dy * drift + fall) * S, 0.09 * S, (1 - ft) * 0.85, hash(g.hx, g.hy, 200 + i) * 6.28 + secs * 3);
      }
      return;
    }
    if (dAge >= IMPACT_MS) return;
    const dt = dAge / IMPACT_MS;
    for (let i = 0; i < 3; i++) {
      const ang = hash(g.hx + i, g.hy, 70) * Math.PI * 2;
      const dist = (0.12 + dt * 0.3) * S;
      blit(ctx, 'dustTan', ox + Math.cos(ang) * dist, oy + Math.sin(ang) * dist, Math.max(1, S * 0.16), (1 - dt) * 0.5);
    }
  }

  // Additive half of a shot: muzzle flash, tracer head, kill flash, ricochet.
  private drawShotHot(ctx: CanvasRenderingContext2D, cam: Camera, t: Tracer, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    const g = this.shotGeom(cam, t, cw, ch);
    const pad = 4 * cam.scale;
    const muzzleOn = this.onScreen(g.mx, g.my, cw, ch, pad);
    const impactOn = this.onScreen(g.x1, g.y1, cw, ch, pad);
    if (!muzzleOn && !impactOn) return;
    const age = now - t.at;
    const cls = flashClass(t.weapon);
    const fc = FLASH[cls];
    const ang = Math.atan2(g.uy, g.ux);

    if (muzzleOn) {
      if (age < fc.life) this.muzzleFlash(ctx, cam, g, ang, fc, 1 - age / fc.life);
      // belt rhythm: an MG's second beat 25 ms behind the first is what makes
      // it read as an MG rather than a fast rifle
      if (fc.extra === 'double' && age >= 25 && age < 25 + fc.life) this.muzzleFlash(ctx, cam, g, ang, fc, (1 - (age - 25) / fc.life) * 0.4);
    }

    // 1-in-5 rounds (1-in-3 on a belt) carry a tracer; the irregular rhythm is
    // what makes sustained fire read right. The rest leave only the thread.
    if (age < TRAVEL_MS && hash(g.hx, g.hy, 77) < fc.tracerOdds) {
      const travelT = age / TRAVEL_MS;
      const segStart = Math.max(0, travelT - 0.11);
      const px = (f: number) => g.mx + (g.x1 - g.mx) * f;
      const py = (f: number) => g.my + (g.y1 - g.my) * f;
      ctx.lineWidth = fc.tracerW;
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = `rgba(${fc.tracerCol},${0.14 + k * 0.26})`;
        ctx.beginPath();
        ctx.moveTo(px(segStart + ((travelT - segStart) * k) / 3), py(segStart + ((travelT - segStart) * k) / 3));
        ctx.lineTo(px(segStart + ((travelT - segStart) * (k + 1)) / 3), py(segStart + ((travelT - segStart) * (k + 1)) / 3));
        ctx.stroke();
      }
      blit(ctx, 'spark', px(travelT), py(travelT), Math.max(1, cam.scale * 0.1), 0.95);
    }

    if (age < TRAVEL_MS) return;
    const dAge = age - TRAVEL_MS;
    if (impactOn && t.hit) {
      if (t.kill && dAge < 200) {
        const kt = dAge / 200;
        blit(ctx, 'flash', g.x1, g.y1, Math.max(2, (0.3 + kt * 0.9) * cam.scale), (1 - kt) * 0.8);
      } else if (dAge < 90) {
        blit(ctx, 'spark', g.x1, g.y1, Math.max(1.2, cam.scale * 0.18), (1 - dAge / 90) * 0.7);
      }
    }

    // Rounds finding a hard surface — cover at the target, or the masonry a
    // miss overshoots into — throw sparks back toward the shooter.
    const hard = t.over ? t.over.kind === 'wall' : t.hit && this.sim.map.terrainAt(Math.floor(t.tx), Math.floor(t.ty)).cover > 0;
    if (tier < 1 || !hard || dAge >= 260) return;
    const [hx, hy] = t.over ? cam.worldToScreen(t.over.x, t.over.y, cw, ch) : [g.x1, g.y1];
    if (!this.onScreen(hx, hy, cw, ch, pad)) return;
    const secs = dAge / 1000;
    const back = ang + Math.PI;
    const n = 2 + Math.floor(hash(g.hx, g.hy, 88) * 3);
    for (let i = 0; i < n; i++) {
      const a = back + (hash(g.hx, g.hy, 90 + i) - 0.5) * 2.2;
      const [dist, z] = ballistic(secs, 4 + hash(g.hx, g.hy, 100 + i) * 5, 2 + hash(g.hx, g.hy, 110 + i) * 3);
      if (z <= 0) continue;
      blit(ctx, 'spark', hx + Math.cos(a) * dist * cam.scale, hy + Math.sin(a) * dist * cam.scale - z * cam.scale * 0.9, Math.max(0.9, cam.scale * 0.06), 1 - dAge / 260);
    }
  }

  // Oriented teardrop core + asymmetric spikes. The flash must be longer along
  // the barrel than across it, and no two spikes may match — three equal
  // spikes at symmetric angles is a UI arrowhead, not a muzzle flash.
  private muzzleFlash(ctx: CanvasRenderingContext2D, cam: Camera, g: ShotGeom, ang: number, fc: FlashSpec, fa: number): void {
    if (fa <= 0) return;
    const fr = Math.max(2, fc.r * cam.scale) * (0.85 + hash(g.hx, g.hy, 3) * 0.3);
    blit(ctx, 'flash', g.mx, g.my, fr * 2.4, fa * 0.22); // soft outer falloff
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

  // Layered explosion. Order is the whole trick: the dark beats (compression
  // ring, soot shell) go UNDER the fireball, and the lingering dust is a RING
  // rather than a filled disc, so nothing paints tan over the hot core the way
  // the old single-pass draw did.
  private drawBoom(ctx: CanvasRenderingContext2D, cam: Camera, b: Boom, now: number, cw: number, ch: number, tier: 0 | 1 | 2): void {
    const age = now - b.at;
    const rs = boomScale(b.r);
    const S = cam.scale;
    const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
    const pad = 12 * rs * S;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    const sx = Math.round(b.x * 100);
    const sy = Math.round(b.y * 100);

    // 30-90 ms: a beat of darkening before the dust — air being displaced
    if (age >= 30 && age < 90) {
      const t = (age - 30) / 60;
      blit(ctx, 'ringDark', x, y, (0.7 + t * 2.2) * rs * S, 0.25 * (1 - t));
    }

    // 40-380 ms: shockwave, a scaled soft annulus (never a 2 px stroked circle)
    if (age >= 40 && age < 380) {
      const t = (age - 40) / 340;
      blit(ctx, 'ringTan', x, y, (0.8 + t * 3.8) * rs * S, 0.55 * (1 - t));
    }

    // 150-1400 ms: lingering ground dust, a spreading ring plus a small base
    // disc capped low enough that it can never wash out the fireball
    if (age >= 150 && age < 1400) {
      const t = (age - 150) / 1250;
      blit(ctx, 'ringTan', x, y, (1.2 + t * 3.3) * rs * S, 0.3 * (1 - t));
      blit(ctx, 'dustTan', x, y, 1.6 * rs * S, 0.14 * (1 - t));
    }

    // 60-900 ms: soot shell, drawn before the fireball every frame so the hot
    // core punches through it — dark-around-bright is why a blast reads
    if (age >= 60 && age < 900) {
      const t = (age - 60) / 840;
      for (let i = 0; i < 4; i++) {
        const a = hash(sx, sy, 110 + i) * Math.PI * 2;
        const d = (0.55 + 0.7 * hash(sx, sy, 120 + i)) * rs * S;
        blit(ctx, 'soot', x + Math.cos(a) * d, y + Math.sin(a) * d, (0.9 + t * 2) * rs * S, 0.42 * Math.pow(1 - t, 0.9));
      }
    }

    // 30-260 ms: three staggered, offset fireball lobes — the asymmetry is
    // what stops an explosion reading as a disc
    for (let i = 0; i < 3; i++) {
      const start = 30 + i * 22;
      if (age < start || age >= 260) continue;
      const t = (age - start) / (260 - start);
      const a = hash(sx, sy, 100 + i) * Math.PI * 2;
      const d = (0.15 + 0.35 * hash(sx, sy, 130 + i)) * rs * S;
      const lobe = (0.45 + hash(sx, sy, 135 + i) * 0.5 + t * 2) * rs * S;
      blit(ctx, 'fire', x + Math.cos(a) * d, y + Math.sin(a) * d, lobe, Math.pow(1 - t, 0.7) * 0.78);
    }

    // 0-420 ms: dirt ejecta, drooping under gravity and tapering to nothing
    if (age < 420) {
      const t = age / 420;
      const ea = 1 - t;
      const n = Math.max(4, Math.round((8 + hash(sx, sy, 5) * 5) * rs));
      ctx.lineWidth = Math.max(0.6, (0.09 - 0.07 * t) * S);
      for (let i = 0; i < n; i++) {
        const ang = hash(sx, sy, 10 + i) * Math.PI * 2;
        const len = (1.5 + hash(sx, sy, 40 + i) * 2.5) * rs * S * t;
        const tone = hash(sx, sy, 70 + i);
        ctx.strokeStyle = `rgba(${Math.round(90 + tone * 40)},${Math.round(65 + tone * 30)},${Math.round(45 + tone * 20)},${ea * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, x + Math.cos(ang) * len, y + Math.sin(ang) * len + t * t * 0.9 * S);
        ctx.stroke();
      }
    }

    // 60-1600 ms: debris on real ballistic arcs with ground shadows — the one
    // thing that gives a blast mass. Each chunk stamps grit where it lands.
    if (tier >= 1 && age >= 60 && age < 1600) {
      const ts = (age - 60) / 1000;
      const n = Math.min(24, Math.round((6 + hash(sx, sy, 140) * 6) * rs * tier));
      for (let i = 0; i < n; i++) {
        const v = (3.5 + hash(sx, sy, 150 + i) * 6) * rs;
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
        ctx.ellipse(gx, gy, S * 0.13, S * 0.08, 0, 0, Math.PI * 2);
        ctx.fill();
        const cr = (0.1 + hash(sx, sy, 180 + i) * 0.08) * S;
        blit(ctx, CHUNKS[i & 3], gx, gy - z * S * 0.9, cr, 1, ts * (4 + hash(sx, sy, 190 + i) * 8));
      }
    }

    // 200-2600 ms: smoke column, leaning on the wind instead of the old
    // per-boom arbitrary drift, and starting sooty because fire-smoke does
    const puffs = 4 + Math.round(2 * rs);
    for (let i = 0; i < puffs; i++) {
      const start = 200 + i * 180;
      if (age < start) continue;
      const pt = (age - start) / (BOOM_MS - start);
      const secs = (age - start) / 1000;
      const px = x + WIND.dx * WIND.speed * secs * S;
      const py = y - pt * 3.4 * rs * S + WIND.dy * WIND.speed * secs * S;
      const pr = (0.9 + pt * 2.2) * rs * S;
      const pa = (1 - pt) * 0.3;
      const sooty = Math.max(0, 1 - secs / 0.9); // fire-smoke starts black and greys as it cools
      blit(ctx, 'smoke', px, py, pr, pa * (1 - sooty));
      blit(ctx, 'soot', px, py, pr, pa * sooty);
    }
  }

  // Additive half of the explosion: strictly the sub-260 ms hot window, so
  // `lighter` never gets a chance to bleach the muted palette.
  private drawBoomHot(ctx: CanvasRenderingContext2D, cam: Camera, b: Boom, now: number, cw: number, ch: number): void {
    const age = now - b.at;
    if (age >= 260) return;
    const rs = boomScale(b.r);
    const S = cam.scale;
    const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
    const pad = 6 * rs * S;
    if (x < -pad || y < -pad || x > cw + pad || y > ch + pad) return;
    if (age < 45) {
      const t = age / 45;
      blit(ctx, 'flash', x, y, (0.5 + 3.2 * t) * rs * S, Math.pow(1 - t, 0.6));
      blit(ctx, 'flash', x, y, (0.35 + 0.7 * t) * rs * S, Math.pow(1 - t, 0.35)); // hard white core
    }
    if (age >= 30) {
      const t = (age - 30) / 230;
      blit(ctx, 'fire', x, y, 0.55 * (0.7 + t * 2.4) * rs * S, Math.pow(1 - t, 0.7) * 0.85);
    }
  }
}
