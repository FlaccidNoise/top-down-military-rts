import type { Emplacement } from '../sim/emplacement';
import { MELEE_STRIKE_RANGE, type MeleeEvent, type ShotEvent, type Side, type Sim, type Soldier, type Vehicle } from '../sim/sim';
import type { Camera } from './camera';
import { DecalLayer } from './decals';
import { bandFor, getSprite, SPRITE_MIN_SCALE, SPRITE_SPAN, WALK_FRAMES, type Pose } from './dudes';
import { RoofLayer } from './roofs';
import { TerrainLayer } from './terrain';
import { getVehicleSprite, vehicleBandFor, VEHICLE_SPAN } from './vehicles';

interface Tracer extends ShotEvent {
  at: number; // ms timestamp
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
}

interface Plane {
  x0: number;
  y: number;
  x1: number;
  at: number;
}

const PLANE_MS = 2600;

const TEAM = { blue: '#5b9bd5', red: '#d05c50' } as const;

// Deterministic hash, 0..1 — same algorithm as terrain.ts's, kept local since
// it isn't exported. Used for per-entry/per-shot offsets so repeated effects
// (smoke puffs, ejecta streaks) never touch the sim RNG or Math.random.
function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) ^ 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// The human player is always US/blue (same convention as hud.ts and
// tooltip.ts); fog of war is rendered from this side's knowledge.
const PLAYER_SIDE: Side = 'blue';

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
  private barrageMarks: { x: number; y: number; tick: number }[] = [];
  private strafeMarks: { x: number; y: number; tick: number }[] = [];
  private planes: Plane[] = [];
  private smokeMaxTtl = new Map<number, number>(); // per-entry spawn ttl, keyed by its (stable) x,y — lets alpha envelope derive from sim time alone
  selectedVehicle = -1;

  constructor(private sim: Sim) {
    this.terrain = new TerrainLayer(sim.map);
    this.decals = new DecalLayer(sim.map.w, sim.map.h);
  }

  addEvents(events: ShotEvent[], now: number): void {
    for (const e of events) this.tracers.push({ ...e, at: now });
  }

  addMeleeEvents(events: MeleeEvent[], now: number): void {
    for (const e of events) {
      this.meleeFx.push({ ...e, at: now });
      if (e.hit) this.decals.smear(e.x, e.y, Math.random() * Math.PI * 2);
    }
  }

  addBooms(booms: { x: number; y: number }[], now: number): void {
    for (const b of booms) {
      this.booms.push({ ...b, at: now });
      this.decals.scorch(b.x, b.y);
    }
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

  draw(ctx: CanvasRenderingContext2D, cam: Camera, selectedSquad: number, now: number): void {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    ctx.fillStyle = '#161510'; // darker desaturated earth tone off-map, replacing the flat void
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;

    this.terrain.draw(ctx, cam, cw, ch);
    const [mx0, my0] = cam.worldToScreen(0, 0, cw, ch);
    const [mx1, my1] = cam.worldToScreen(this.sim.map.w, this.sim.map.h, cw, ch);
    ctx.strokeStyle = 'rgba(18,16,12,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(mx0, my0, mx1 - mx0, my1 - my0);
    this.decals.draw(ctx, cam, cw, ch);
    this.roofs.update(this.sim, cam, dt);
    this.roofs.drawShadows(ctx, cam, cw, ch);

    // Fog of war: everything below asks the sim's *VisibleTo helpers from the
    // player's side — the renderer never re-derives vision.
    const vis = (s: Soldier) => this.sim.soldierVisibleTo(PLAYER_SIDE, s);
    const visV = (v: Vehicle) => this.sim.vehicleVisibleTo(PLAYER_SIDE, v);
    for (const v of this.sim.vehicles) if (!v.alive && visV(v)) this.drawVehicle(ctx, cam, v, now, cw, ch);
    if (cam.scale < SPRITE_MIN_SCALE) {
      for (const s of this.sim.soldiers) if (s.inVehicle < 0 && vis(s)) this.drawDot(ctx, cam, s, selectedSquad, cw, ch);
    } else {
      // dead below downed below the living
      for (const s of this.sim.soldiers) if (!s.alive && s.inVehicle < 0 && vis(s)) this.drawSoldier(ctx, cam, s, selectedSquad, dt, cw, ch);
      for (const s of this.sim.soldiers) if (s.alive && s.downed && s.inVehicle < 0 && vis(s)) this.drawSoldier(ctx, cam, s, selectedSquad, dt, cw, ch);
      for (const s of this.sim.soldiers) if (s.alive && !s.downed && s.inVehicle < 0 && vis(s)) this.drawSoldier(ctx, cam, s, selectedSquad, dt, cw, ch);
    }
    for (const v of this.sim.vehicles) if (v.alive && visV(v)) this.drawVehicle(ctx, cam, v, now, cw, ch);
    for (const e of this.sim.emplacements) if (this.sim.emplacementVisibleTo(PLAYER_SIDE, e)) this.drawEmplacement(ctx, cam, e, selectedSquad, cw, ch);

    this.drawFire(ctx, cam, now, cw, ch);
    this.roofs.drawTops(ctx, cam, cw, ch);
    this.drawSmoke(ctx, cam, cw, ch);
    this.drawContacts(ctx, cam, cw, ch);
    this.drawPlanes(ctx, cam, now, cw, ch);
    this.drawBarrageMarks(ctx, cam, now, cw, ch);
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
        const wx = p.x + Math.cos(angle) * dist;
        const wy = p.y + Math.sin(angle) * dist;
        const [sx, sy] = cam.worldToScreen(wx, wy, cw, ch);
        const sr = r * cam.scale;
        const cool = hash(p.x, p.y, 60 + i);
        const grey = Math.round(150 + cool * 20);
        const blue = grey + 10 + Math.round(cool * 6); // slight cool cast per rule 4
        const a = envelope * (0.28 + cool * 0.08);
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
        grad.addColorStop(0, `rgba(${grey},${grey + 2},${blue},${a})`);
        grad.addColorStop(0.6, `rgba(${grey},${grey + 2},${blue},${a * 0.6})`);
        grad.addColorStop(1, `rgba(${grey},${grey + 2},${blue},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const key of this.smokeMaxTtl.keys()) if (!seen.has(key)) this.smokeMaxTtl.delete(key);
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

  private drawVehicle(ctx: CanvasRenderingContext2D, cam: Camera, v: Vehicle, now: number, cw: number, ch: number): void {
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
    if (v.burning) {
      // drifting smoke: three staggered puffs on a slower clock (~half the
      // prior spawn rate), warm ember tint fading to cool smoke as they age
      for (let i = 0; i < 3; i++) {
        const t = ((now / 1000 + i * 1.6 + v.id) % 4.8) / 4.8;
        const r = (0.8 + t * 2.2) * cam.scale;
        const ember = Math.max(0, 1 - t / 0.35) * 0.6;
        const cr = Math.round(30 + (120 - 30) * ember);
        const cg = Math.round(28 + (55 - 28) * ember);
        const cb = Math.round(25 + (28 - 25) * ember);
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${(1 - t) * 0.4})`;
        ctx.beginPath();
        ctx.arc(x + t * cam.scale * 3 * Math.sin(v.id + i), y - t * cam.scale * 4, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Simple crewed-weapon glyph — follows drawVehicle's scheme (team-colored
  // hull + barrel line) at ~40% of a vehicle's footprint. Dashed while
  // packed/transitioning, solid once dug in.
  private drawEmplacement(ctx: CanvasRenderingContext2D, cam: Camera, e: Emplacement, selectedSquad: number, cw: number, ch: number): void {
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
    if (this.sim.teams[e.crewTeamId]?.squadId === selectedSquad) {
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

  private drawSoldier(ctx: CanvasRenderingContext2D, cam: Camera, s: Soldier, selectedSquad: number, dt: number, cw: number, ch: number): void {
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

    if (s.alive && s.squadId === selectedSquad && s.path) {
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
    ctx.drawImage(spr, -pad / 2, -pad / 2, pad, pad);
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
    if (s.squadId === selectedSquad) {
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
  }

  // Far-zoom LOD: the placeholder dot language, which is the right read at 2 px/m.
  private drawDot(ctx: CanvasRenderingContext2D, cam: Camera, s: Soldier, selectedSquad: number, cw: number, ch: number): void {
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
    if (s.squadId === selectedSquad) {
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
    if (s.suppression > 0.35) {
      ctx.strokeStyle = `rgba(255, 180, 40, ${Math.min(0.9, s.suppression)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawFire(ctx: CanvasRenderingContext2D, cam: Camera, now: number, cw: number, ch: number): void {
    const FADE_MS = 150; // faint line + kill dot lifetime (unchanged from before)
    const TRAVEL_MS = 90; // muzzle->target travel time for the bright segment (E3)
    const IMPACT_MS = 250; // impact dust lifetime, starts at TRAVEL_MS (E5)

    // melee impacts: red fleck on a hit (bigger on a kill), white swish on a miss
    this.meleeFx = this.meleeFx.filter((m) => now - m.at < 250);
    for (const m of this.meleeFx) {
      const t = (now - m.at) / 250;
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
    for (const t of this.tracers) {
      const age = now - t.at;
      const a = Math.max(0, 1 - age / FADE_MS);
      const [x0, y0] = cam.worldToScreen(t.fx, t.fy, cw, ch);
      const [x1, y1] = cam.worldToScreen(t.tx, t.ty, cw, ch);
      const d = Math.hypot(x1 - x0, y1 - y0) || 1;
      const ux = (x1 - x0) / d;
      const uy = (y1 - y0) / d;
      const mx = x0 + ux * cam.scale * 0.9;
      const my = y0 + uy * cam.scale * 0.9;
      // ShotEvent carries no weapon field (sim is read-only here), so there is
      // no real MG-vs-rifle signal to key off — a per-shot hash stands in
      // purely for size/brightness variety, not a weapon-class classifier.
      const shotHash = hash(Math.round(t.tx * 100), Math.round(t.ty * 100), Math.round(t.fx * 37 + t.fy * 53));

      // oriented muzzle flash for the first 60 ms: glow + 3-spike star along
      // the shot direction (E4)
      if (age < 60) {
        const fa = 1 - age / 60;
        const scale = 0.85 + shotHash * 0.3;
        const fr = Math.max(3, cam.scale * 0.35) * scale;
        const grad = ctx.createRadialGradient(mx, my, 0, mx, my, fr);
        grad.addColorStop(0, `rgba(255,245,200,${fa})`);
        grad.addColorStop(0.5, `rgba(255,190,80,${fa * 0.7})`);
        grad.addColorStop(1, 'rgba(255,150,40,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(mx, my, fr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,235,190,${fa * 0.85})`;
        ctx.lineWidth = Math.max(1, cam.scale * 0.1) * scale;
        const spikeLen = fr * 1.6;
        for (const spread of [0, 0.55, -0.55]) {
          const sa = Math.atan2(uy, ux) + spread;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(mx + Math.cos(sa) * spikeLen, my + Math.sin(sa) * spikeLen);
          ctx.stroke();
        }
      }

      // faint full-length line, fades out over FADE_MS (E3)
      if (age < FADE_MS) {
        ctx.strokeStyle = t.hit ? `rgba(255, 205, 90, ${0.18 * a})` : `rgba(255, 240, 210, ${0.12 * a})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // short bright segment traveling muzzle->target over TRAVEL_MS (E3)
      if (age < TRAVEL_MS) {
        const travelT = age / TRAVEL_MS;
        const segStart = Math.max(0, travelT - 0.18);
        const sx0 = mx + (x1 - mx) * segStart;
        const sy0 = my + (y1 - my) * segStart;
        const sx1 = mx + (x1 - mx) * travelT;
        const sy1 = my + (y1 - my) * travelT;
        ctx.strokeStyle = t.hit ? 'rgba(255, 205, 90, 0.95)' : 'rgba(210, 225, 235, 0.55)';
        ctx.lineWidth = t.hit ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        ctx.stroke();
      } else {
        // impact dust, per-tracer hash offsets, earth tone (E5)
        const dAge = age - TRAVEL_MS;
        if (dAge < IMPACT_MS) {
          const dt = dAge / IMPACT_MS;
          const da = (1 - dt) * 0.5;
          for (let i = 0; i < 3; i++) {
            const ang = hash(Math.round(t.tx * 100) + i, Math.round(t.ty * 100), 70) * Math.PI * 2;
            const dist = (0.12 + dt * 0.3) * cam.scale;
            const px = x1 + Math.cos(ang) * dist;
            const py = y1 + Math.sin(ang) * dist;
            const tone = hash(Math.round(t.tx * 100) + i, Math.round(t.ty * 100), 80);
            const r = Math.round(120 + tone * 40);
            const gc = Math.round(100 + tone * 30);
            const bc = Math.round(75 + tone * 20);
            ctx.fillStyle = `rgba(${r},${gc},${bc},${da})`;
            ctx.beginPath();
            ctx.arc(px, py, Math.max(1, cam.scale * 0.12), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (t.kill) {
          ctx.fillStyle = `rgba(220, 60, 40, ${a * 0.6})`;
          ctx.beginPath();
          ctx.arc(x1, y1, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // explosions: fireball + earth-toned ring + dirt ejecta + ground dust +
    // rising smoke column, all wall-clock (transient VFX, not sim state) (E2)
    const BOOM_MS = 2000; // longest sub-effect (smoke column) sets total lifetime
    this.booms = this.booms.filter((b) => now - b.at < BOOM_MS);
    for (const b of this.booms) {
      const age = now - b.at;
      const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
      const sx = Math.round(b.x * 100);
      const sy = Math.round(b.y * 100);

      // earth-toned shockwave ring (kept, retoned per rule 1 — hot color
      // budget goes to the fireball core only)
      if (age < 600) {
        const t = age / 600;
        const rad = (1 + t * 8) * cam.scale;
        ctx.strokeStyle = `rgba(150, 112, 72, ${(1 - t) * 0.75})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }

      // hot fireball core, 150 ms
      if (age < 150) {
        const t = age / 150;
        const fr = (0.6 + t * 2.2) * cam.scale;
        const fa = 1 - t;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, fr);
        grad.addColorStop(0, `rgba(255,250,225,${fa})`);
        grad.addColorStop(0.4, `rgba(255,190,90,${fa * 0.85})`);
        grad.addColorStop(0.75, `rgba(210,110,50,${fa * 0.5})`);
        grad.addColorStop(1, 'rgba(180,90,40,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, fr, 0, Math.PI * 2);
        ctx.fill();
      }

      // dirt ejecta streaks, earth browns, fade ~400 ms
      if (age < 400) {
        const t = age / 400;
        const ea = 1 - t;
        const n = 8 + Math.floor(hash(sx, sy, 5) * 5); // 8-12
        ctx.lineWidth = Math.max(1, cam.scale * 0.06);
        for (let i = 0; i < n; i++) {
          const ang = hash(sx, sy, 10 + i) * Math.PI * 2;
          const len = (1.5 + hash(sx, sy, 40 + i) * 2.5) * cam.scale * t;
          const tone = hash(sx, sy, 70 + i);
          const r = Math.round(90 + tone * 40);
          const gc = Math.round(65 + tone * 30);
          const bc = Math.round(45 + tone * 20);
          ctx.strokeStyle = `rgba(${r},${gc},${bc},${ea * 0.7})`;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          ctx.stroke();
        }
      }

      // lingering ground dust: one soft expanding disc, ~1.5 s
      if (age < 1500) {
        const t = age / 1500;
        const dr = (1.5 + t * 3.5) * cam.scale;
        const da = (1 - t) * 0.28;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, dr);
        grad.addColorStop(0, `rgba(150,130,100,${da})`);
        grad.addColorStop(1, 'rgba(150,130,100,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, dr, 0, Math.PI * 2);
        ctx.fill();
      }

      // rising smoke column: 3 staggered puffs climbing over ~2 s, cool grey
      for (let i = 0; i < 3; i++) {
        const start = i * 200;
        if (age < start) continue;
        const pt = (age - start) / (BOOM_MS - start);
        const climb = pt * 3.5 * cam.scale;
        const drift = Math.sin(sx * 0.01 + i) * pt * 0.6 * cam.scale;
        const pr = (0.8 + pt * 1.6) * cam.scale;
        const pa = (1 - pt) * 0.4;
        ctx.fillStyle = `rgba(150,152,150,${pa})`;
        ctx.beginPath();
        ctx.arc(x + drift, y - climb, pr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
