import type { Emplacement } from '../sim/emplacement';
import type { ShotEvent, Sim, Soldier, Vehicle } from '../sim/sim';
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

export class Renderer {
  private terrain: TerrainLayer;
  private roofs = new RoofLayer();
  private tracers: Tracer[] = [];
  private rs = new Map<number, RState>();
  private deadVehicles = new Set<number>(); // scorch stamped once, on first dead frame
  private lastNow = 0;
  private booms: Boom[] = [];
  private decals: DecalLayer;
  private barrageMarks: { x: number; y: number; tick: number }[] = [];
  private strafeMarks: { x: number; y: number; tick: number }[] = [];
  private planes: Plane[] = [];
  selectedVehicle = -1;

  constructor(private sim: Sim) {
    this.terrain = new TerrainLayer(sim.map);
    this.decals = new DecalLayer(sim.map.w, sim.map.h);
  }

  addEvents(events: ShotEvent[], now: number): void {
    for (const e of events) this.tracers.push({ ...e, at: now });
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

    for (const v of this.sim.vehicles) if (!v.alive) this.drawVehicle(ctx, cam, v, now, cw, ch);
    if (cam.scale < SPRITE_MIN_SCALE) {
      for (const s of this.sim.soldiers) if (s.inVehicle < 0) this.drawDot(ctx, cam, s, selectedSquad, cw, ch);
    } else {
      // dead below downed below the living
      for (const s of this.sim.soldiers) if (!s.alive && s.inVehicle < 0) this.drawSoldier(ctx, cam, s, selectedSquad, dt, cw, ch);
      for (const s of this.sim.soldiers) if (s.alive && s.downed && s.inVehicle < 0) this.drawSoldier(ctx, cam, s, selectedSquad, dt, cw, ch);
      for (const s of this.sim.soldiers) if (s.alive && !s.downed && s.inVehicle < 0) this.drawSoldier(ctx, cam, s, selectedSquad, dt, cw, ch);
    }
    for (const v of this.sim.vehicles) if (v.alive) this.drawVehicle(ctx, cam, v, now, cw, ch);
    for (const e of this.sim.emplacements) this.drawEmplacement(ctx, cam, e, selectedSquad, cw, ch);

    this.drawFire(ctx, cam, now, cw, ch);
    this.roofs.drawTops(ctx, cam, cw, ch);
    this.drawPlanes(ctx, cam, now, cw, ch);
    this.drawBarrageMarks(ctx, cam, now, cw, ch);
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
    else if (s.mental === 'pinned' || (s.mental === 'broken' && !s.path)) pose = 'prone';
    else if (moved > 1e-4) {
      pose = 'walk';
      st.phase += moved * 1.4;
      frame = Math.floor((st.phase % 1) * WALK_FRAMES);
    } else if (s.targetId >= 0) pose = s.suppression > 0.15 ? 'kneel' : 'aim';
    else pose = 'idle';

    if (s.alive) {
      let desired = st.facing;
      if (s.task?.phase === 'aid') {
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
    this.tracers = this.tracers.filter((t) => now - t.at < 150);
    for (const t of this.tracers) {
      const age = now - t.at;
      const a = 1 - age / 150;
      const [x0, y0] = cam.worldToScreen(t.fx, t.fy, cw, ch);
      const [x1, y1] = cam.worldToScreen(t.tx, t.ty, cw, ch);
      const d = Math.hypot(x1 - x0, y1 - y0) || 1;
      const ux = (x1 - x0) / d;
      const uy = (y1 - y0) / d;
      // muzzle flash for the first 60 ms
      if (age < 60) {
        const fa = 1 - age / 60;
        const mx = x0 + ux * cam.scale * 0.9;
        const my = y0 + uy * cam.scale * 0.9;
        const fr = Math.max(3, cam.scale * 0.35);
        const grad = ctx.createRadialGradient(mx, my, 0, mx, my, fr);
        grad.addColorStop(0, `rgba(255,245,200,${fa})`);
        grad.addColorStop(0.5, `rgba(255,190,80,${fa * 0.7})`);
        grad.addColorStop(1, 'rgba(255,150,40,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(mx, my, fr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = t.hit ? `rgba(255, 205, 90, ${a})` : `rgba(255, 240, 210, ${0.3 * a})`;
      ctx.lineWidth = t.hit ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x0 + ux * cam.scale * 0.9, y0 + uy * cam.scale * 0.9);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (t.kill) {
        ctx.fillStyle = `rgba(220, 60, 40, ${a * 0.6})`;
        ctx.beginPath();
        ctx.arc(x1, y1, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // explosions (600 ms expanding ring + flash)
    this.booms = this.booms.filter((b) => now - b.at < 600);
    for (const b of this.booms) {
      const t = (now - b.at) / 600;
      const [x, y] = cam.worldToScreen(b.x, b.y, cw, ch);
      const rad = (1 + t * 8) * cam.scale;
      ctx.strokeStyle = `rgba(255, 160, 60, ${(1 - t) * 0.9})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.stroke();
      if (t < 0.3) {
        ctx.fillStyle = `rgba(255, 220, 120, ${(0.3 - t) * 2})`;
        ctx.beginPath();
        ctx.arc(x, y, rad * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

}
