import { WEAPONS, type WeaponDef } from './data';
import { dangerScore, visibleEnemies } from './orders';
import type { Sim, Squad } from './sim';

// Red commander: issues squad orders through the same public order API the
// player uses. Design requirement (decision log): must maneuver and
// counterattack — the whole genre ships passive AI. Deterministic given
// identical call ticks.
//
// Honest vision (spec: ai-commander.md): the only read of the opposing
// side's state anywhere in this module is visibleEnemies() (and
// dangerScore(), which is itself built on visibleEnemies) — belief state,
// aim points, and the barrage target all trace back to contacts red units
// actually had line of sight to, plus the static briefing (cfg.posts).
// tests/doctrine.test.ts's honesty audit greps this file's source for the
// enemy side's own literal to catch a regression back to a direct read.

export interface CommanderConfig {
  stance: 'defend' | 'attack';
  posts: Record<number, { x: number; y: number }>; // squadId -> objective/anchor
}

interface ThreatContact {
  x: number;
  y: number;
  conf: number; // 0..1, decays when not re-sighted
  tick: number;
}

const EVAL_TICKS = 150; // every 5s
const THREAT_MERGE_RADIUS = 12; // fold a fresh sighting into a nearby existing contact
const THREAT_DECAY = 0.95; // per eval when not re-sighted
const SUPPRESSION_SECONDS = 10; // a base-of-fire squad firing this long counts as suppression established
const CLEAR_CONF = 0.3; // threat confidence at the post below which maneuver goes ahead regardless
const FLANK_OFFSET = 20; // meters either side of the direct axis to the post

export class RedCommander {
  private lastEval = -EVAL_TICKS;
  private barrageUsed = false;
  private threat: ThreatContact[] = [];
  private groupsReady = false;
  private baseSquadIds: number[] = [];
  private maneuverSquadIds: number[] = [];
  private reserveSquadIds: number[] = [];
  private fireStartTick = new Map<number, number>(); // base squadId -> tick its fire order began
  private startStrength = new Map<number, number>(); // maneuver squadId -> eligible count at classification
  private reserveCommitted = false;

  constructor(private cfg: CommanderConfig) {}

  update(sim: Sim): void {
    if (sim.tick - this.lastEval < EVAL_TICKS) return;
    this.lastEval = sim.tick;

    if (!this.groupsReady) this.assignGroups(sim);
    this.updateThreat(sim);

    if (this.cfg.stance === 'attack') this.runAttack(sim);
    else this.runDefend(sim);

    this.updateVehicles(sim);
    this.maybeBarrage(sim);
  }

  // ---- belief state: contacts built only from what red currently sees ----
  private updateThreat(sim: Sim): void {
    for (const t of this.threat) t.conf *= THREAT_DECAY;
    this.threat = this.threat.filter((t) => t.conf > 0.02);
    for (const e of visibleEnemies(sim, 'red')) {
      const near = this.threat.find((t) => Math.hypot(t.x - e.x, t.y - e.y) < THREAT_MERGE_RADIUS);
      if (near) {
        near.x = e.x;
        near.y = e.y;
        near.conf = 1;
        near.tick = sim.tick;
      } else {
        this.threat.push({ x: e.x, y: e.y, conf: 1, tick: sim.tick });
      }
    }
  }

  private threatConfNear(x: number, y: number, radius: number): number {
    let conf = 0;
    for (const t of this.threat) if (Math.hypot(t.x - x, t.y - y) <= radius) conf = Math.max(conf, t.conf);
    return conf;
  }

  // Aim at the most confident contact actually sighted near the post, or the
  // briefed post itself if nothing's been spotted there yet — never a
  // coordinate the belief state doesn't know about.
  private aimPointFor(post: { x: number; y: number }): { x: number; y: number } {
    const near = this.threat.filter((t) => Math.hypot(t.x - post.x, t.y - post.y) <= 20);
    if (near.length === 0) return post;
    near.sort((a, b) => b.conf - a.conf);
    return { x: near[0].x, y: near[0].y };
  }

  // ---- task groups (spec: base of fire / maneuver / reserve), assigned
  // once a sim is available (constructor takes only static config). A force
  // with no pure-rifle squads (e.g. a mixed legacy garrison where every
  // squad already carries its own MG) falls back to letting every squad
  // both fire and maneuver rather than leaving maneuver empty.
  private assignGroups(sim: Sim): void {
    const redSquads = sim.squads.filter((sq) => sq.side === 'red' && this.cfg.posts[sq.id]);
    const isBaseOfFire = (sq: Squad) =>
      sq.soldierIds.some((id) => {
        const w: WeaponDef = WEAPONS[sim.soldiers[id].weapon];
        return !!w.heat || !!w.arc || w.pen !== undefined;
      });
    this.baseSquadIds = redSquads.filter(isBaseOfFire).map((sq) => sq.id);
    const rifle = redSquads.filter((sq) => !isBaseOfFire(sq));
    const pool = rifle.length > 0 ? rifle : redSquads;
    this.maneuverSquadIds = pool.slice(0, 2).map((sq) => sq.id);
    this.reserveSquadIds = pool.slice(2).map((sq) => sq.id);
    for (const id of this.maneuverSquadIds) {
      this.startStrength.set(id, sim.squads[id].soldierIds.filter((sid) => sim.soldiers[sid].alive).length);
    }
    this.groupsReady = true;
  }

  private centroid(sim: Sim, squad: Squad): { x: number; y: number } {
    const alive = squad.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
    if (alive.length === 0) return { x: 0, y: 0 };
    return { x: alive.reduce((a, s) => a + s.x, 0) / alive.length, y: alive.reduce((a, s) => a + s.y, 0) / alive.length };
  }

  // ---- attack stance: shape (base of fire suppresses) -> maneuver (bound
  // the covered flank) -> assault (fast, once suppression's established) ->
  // reserve commits on a maneuver squad's losses (spec's attack template;
  // the assault-gate uses BOTH suppression-established and a cleared threat
  // reading so the commander doesn't stall forever against an unseen post).
  private runAttack(sim: Sim): void {
    for (const sqId of this.baseSquadIds) {
      const squad = sim.squads[sqId];
      const post = this.cfg.posts[sqId];
      if (!post || !squad.soldierIds.some((id) => sim.soldiers[id].alive)) continue;
      const aim = this.aimPointFor(post);
      sim.orderSquad(sqId, { kind: 'fire', x: aim.x, y: aim.y });
      if (!this.fireStartTick.has(sqId)) this.fireStartTick.set(sqId, sim.tick);
    }

    for (const sqId of this.maneuverSquadIds) {
      const squad = sim.squads[sqId];
      const post = this.cfg.posts[sqId] ?? Object.values(this.cfg.posts)[0];
      if (!post) continue;
      const alive = squad.soldierIds.filter((id) => sim.soldiers[id].alive);
      if (alive.length === 0) continue;
      const suppressed = this.suppressionEstablished(sim);
      const confAtPost = this.threatConfNear(post.x, post.y, 15);
      if (suppressed || confAtPost < CLEAR_CONF) {
        sim.orderSquad(sqId, { kind: 'fast', x: post.x, y: post.y });
      } else {
        const flank = this.pickFlank(sim, squad, post);
        sim.orderSquad(sqId, { kind: 'move', x: flank.x, y: flank.y });
      }
      const start = this.startStrength.get(sqId) ?? alive.length;
      if (!this.reserveCommitted && start > 0 && alive.length / start < 0.5) this.commitReserve(sim);
    }
  }

  private suppressionEstablished(sim: Sim): boolean {
    for (const t of this.fireStartTick.values()) if ((sim.tick - t) / 30 >= SUPPRESSION_SECONDS) return true;
    return false;
  }

  private commitReserve(sim: Sim): void {
    this.reserveCommitted = true;
    for (const sqId of this.reserveSquadIds) {
      const post = this.cfg.posts[sqId] ?? Object.values(this.cfg.posts)[0];
      if (post) sim.orderSquad(sqId, { kind: 'move', x: post.x, y: post.y });
    }
  }

  // Which side of the direct axis to the post scores lower danger (spec:
  // "pick left/right by lower summed dangerScore") — reuses the same risk
  // model soldiers use for refusal (the spec's "one danger model, three
  // consumers": soldier, team, commander).
  private pickFlank(sim: Sim, squad: Squad, post: { x: number; y: number }): { x: number; y: number } {
    const c = this.centroid(sim, squad);
    const dx = post.x - c.x;
    const dy = post.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const left = { x: c.x + dx * 0.5 + nx * FLANK_OFFSET, y: c.y + dy * 0.5 + ny * FLANK_OFFSET };
    const right = { x: c.x + dx * 0.5 - nx * FLANK_OFFSET, y: c.y + dy * 0.5 - ny * FLANK_OFFSET };
    const team = sim.teams[squad.teamIds[0]];
    return dangerScore(sim, team, left) <= dangerScore(sim, team, right) ? left : right;
  }

  // ---- defend stance: each squad holds its own post, counterattacking the
  // instant a known contact sits on it; settles into ambush once in place.
  private runDefend(sim: Sim): void {
    for (const squad of sim.squads) {
      if (squad.side !== 'red') continue;
      const post = this.cfg.posts[squad.id];
      if (!post) continue;
      const members = squad.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
      if (members.length === 0) continue;
      const c = this.centroid(sim, squad);
      const distToPost = Math.hypot(c.x - post.x, c.y - post.y);
      const moving = members.filter((s) => s.path).length > members.length / 2;
      const confAtPost = this.threatConfNear(post.x, post.y, 12);
      const team = sim.teams[squad.teamIds[0]];
      if (confAtPost > 0 && distToPost > 8 && !moving) {
        sim.orderSquad(squad.id, { kind: 'move', x: post.x, y: post.y }); // counterattack a lost post
      } else if (distToPost <= 8 && !moving && team.orderState.order === null) {
        sim.orderSquad(squad.id, { kind: 'ambush', x: post.x, y: post.y }); // settled in, holding fire
      }
    }
  }

  // Armor: attack stance pushes idle tanks at the first objective; defend
  // stance holds them back as a mobile reserve near their spawn.
  private updateVehicles(sim: Sim): void {
    for (const v of sim.vehicles) {
      if (!v.alive || v.side !== 'red' || v.path) continue;
      if (this.cfg.stance === 'attack') {
        const firstPost = Object.values(this.cfg.posts)[0];
        if (firstPost && Math.hypot(v.x - firstPost.x, v.y - firstPost.y) > 25) {
          sim.orderVehicleMove(v.id, firstPost.x, firstPost.y);
        }
      }
    }
  }

  // One barrage on the densest cluster among units red has actually seen,
  // once it musters five or more together.
  private maybeBarrage(sim: Sim): void {
    if (this.barrageUsed || sim.barragesLeft.red <= 0) return;
    const seen = visibleEnemies(sim, 'red');
    for (const b of seen) {
      const cluster = seen.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) < 8);
      if (cluster.length >= 5) {
        const cx = cluster.reduce((a, s) => a + s.x, 0) / cluster.length;
        const cy = cluster.reduce((a, s) => a + s.y, 0) / cluster.length;
        sim.callBarrage('red', cx, cy);
        this.barrageUsed = true;
        break;
      }
    }
  }
}
