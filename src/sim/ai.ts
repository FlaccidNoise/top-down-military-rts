import type { Sim } from './sim';

// Red commander: issues squad orders through the same public API the player
// uses. Design requirement (decision log): must maneuver and counterattack —
// the whole genre ships passive AI. Deterministic given identical call ticks.

export interface CommanderConfig {
  stance: 'defend' | 'attack';
  posts: Record<number, { x: number; y: number }>; // squadId -> objective
}

const EVAL_TICKS = 150; // every 5s

export class RedCommander {
  private lastEval = -EVAL_TICKS;
  private barrageUsed = false;

  constructor(private cfg: CommanderConfig) {}

  update(sim: Sim): void {
    if (sim.tick - this.lastEval < EVAL_TICKS) return;
    this.lastEval = sim.tick;

    for (const squad of sim.squads) {
      if (squad.side !== 'red') continue;
      const post = this.cfg.posts[squad.id];
      if (!post) continue;
      const members = squad.soldierIds.map((i) => sim.soldiers[i]).filter((s) => s.alive && !s.downed);
      if (members.length === 0) continue;
      const cx = members.reduce((a, s) => a + s.x, 0) / members.length;
      const cy = members.reduce((a, s) => a + s.y, 0) / members.length;
      const distToPost = Math.hypot(cx - post.x, cy - post.y);
      const moving = members.filter((s) => s.path).length > members.length / 2;

      const enemiesAtPost = sim.soldiers.filter(
        (s) => s.alive && !s.downed && s.side === 'blue' && Math.hypot(s.x - post.x, s.y - post.y) < 12,
      ).length;

      if (this.cfg.stance === 'attack') {
        // press toward the objective whenever the squad has gone idle
        if (!moving && distToPost > 10) sim.orderSquadMove(squad.id, post.x, post.y);
      } else {
        // defend: hold in place; move only to counterattack a lost post
        if (enemiesAtPost > 0 && distToPost > 8 && !moving) sim.orderSquadMove(squad.id, post.x, post.y);
      }
    }

    // armor: attack stance pushes idle tanks at the first objective;
    // defend stance holds them back as a mobile reserve near their spawn
    for (const v of sim.vehicles) {
      if (!v.alive || v.side !== 'red' || v.path) continue;
      if (this.cfg.stance === 'attack') {
        const firstPost = Object.values(this.cfg.posts)[0];
        if (firstPost && Math.hypot(v.x - firstPost.x, v.y - firstPost.y) > 25) {
          sim.orderVehicleMove(v.id, firstPost.x, firstPost.y);
        }
      }
    }

    // one mortar barrage on the densest blue cluster once it commits
    if (!this.barrageUsed && sim.barragesLeft.red > 0) {
      const blues = sim.soldiers.filter((s) => s.alive && !s.downed && s.side === 'blue');
      for (const b of blues) {
        const cluster = blues.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) < 8);
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
}
