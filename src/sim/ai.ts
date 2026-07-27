import { EMPLACEMENTS, WEAPONS, type WeaponDef } from './data';
import { crewNear, friendlyHasLos, type Emplacement } from './emplacement';
import { dangerScore } from './orders';
import { CONTACT_TTL, EYE_CROUCH, EYE_STAND, SPOT_INTERVAL, sightBetween, type Side, type Sim, type Team } from './sim';

// Red commander: issues squad orders through the same public order API the
// player uses. Design requirement (decision log): must maneuver and
// counterattack — the whole genre ships passive AI. Deterministic given
// identical call ticks.
//
// Honest vision (spec: ai-commander.md): the only reads of the opposing
// side's state anywhere in this module are the sim's own per-side intel
// layer (sim.spotted / sim.contacts — the same spotting sweep, last-known
// ghosts, and TTL the player's fog of war runs on) and dangerScore()
// (weapon-range engagement semantics, built on visibleEnemies). Belief
// state, aim points, and the barrage target all trace back to contacts red
// units its side actually sighted, plus the static briefing (cfg.posts).
// tests/doctrine.test.ts's honesty audit greps this file's source for the
// enemy side's own literal to catch a regression back to a direct read.

export interface CommanderConfig {
  side: Side;
  stance: 'defend' | 'attack';
  posts: Record<number, { x: number; y: number }>; // squadId -> objective/anchor
}

interface ThreatContact {
  x: number;
  y: number;
  conf: number; // 1 while tracked; a lost contact fades toward 0 over AI_MEMORY_TICKS
}

// The commander's memory window for the ghost-confidence fade. Defaults to the ghost
// TTL so behavior matches the UI today, but it's a separate knob: retuning
// ghost-marker UX must never silently retune the AI's competence (SPOT_RANGE
// and CONTACT_TTL are difficulty constants now — decision log 2026-07-23).
// Values above CONTACT_TTL are capped in practice: the sim deletes a contact
// at CONTACT_TTL, so red can't remember a ghost the intel layer has dropped.
export const AI_MEMORY_TICKS = CONTACT_TTL;

const EVAL_TICKS = 150; // every 5s
const SUPPRESSION_SECONDS = 10; // a base-of-fire team firing this long counts as suppression established
const CLEAR_CONF = 0.3; // threat confidence at the post below which maneuver goes ahead regardless
const ASSAULT_RANGE = 30; // m from the post at which a suppressed-in maneuver team charges instead of running
const SMOKE_RANGE = 45; // m from the post at which the commander screens the objective with mortar smoke ahead of the charge
const FLANK_OFFSET = 20; // meters either side of the direct axis to the post
const BOF_SETTLE_RADIUS = 5; // close enough to the scored firing spot to stop moving and start firing

export class RedCommander {
  private lastEval = -EVAL_TICKS;
  private barrageUsed = false;
  private threat: ThreatContact[] = [];
  private groupsReady = false;
  // Task groups are TEAM-scoped, not squad-scoped: a squad like the German
  // Gruppe bundles an MG-Trupp (base of fire) and a Schützen team (maneuver)
  // under one squad id, and orderSquad broadcasts one order to every team in
  // a squad — issuing 'fire' to the base team and 'move' to the maneuver
  // team through the same squad id would just have each overwrite the
  // other's order. Every order below goes through orderTeam for exactly
  // this reason.
  private baseTeamIds: number[] = [];
  private maneuverTeamIds: number[] = [];
  private reserveTeamIds: number[] = [];
  private baseSpot = new Map<number, { x: number; y: number }>(); // base teamId -> scored firing position, computed once
  private baseFiring = new Set<number>(); // base teamId -> has reached its firing spot and is now suppressing
  private fireStartTick = new Map<number, number>(); // base teamId -> tick its fire order began
  private startStrength = new Map<number, number>(); // maneuver teamId -> eligible count at classification
  private reserveCommitted = false;

  constructor(private cfg: CommanderConfig) {}

  update(sim: Sim): void {
    // No orders before the first spotting sweep reports: with the belief
    // state on sim intel, an earlier eval would read "no contacts anywhere"
    // as a cleared field and send the assault in cold.
    if (sim.tick < SPOT_INTERVAL) return;
    if (sim.tick - this.lastEval < EVAL_TICKS) return;
    this.lastEval = sim.tick;

    if (!this.groupsReady) this.assignGroups(sim);
    this.updateThreat(sim);

    if (this.cfg.stance === 'attack') this.runAttack(sim);
    else this.runDefend(sim);

    this.updateVehicles(sim);
    this.maybeBarrage(sim);
  }

  // ---- belief state: the sim's per-side intel layer, rebuilt each eval —
  // the commander keeps no private threat map; it knows exactly what its
  // side knows (spotted at conf 1, lost contacts fading over AI_MEMORY_TICKS).
  private spottedPositions(sim: Sim): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const [id, p] of sim.spotted[this.cfg.side]) {
      if (!sim.soldiers[id].downed) out.push(p); // tracked but downed: out of the fight
    }
    return out;
  }

  private updateThreat(sim: Sim): void {
    this.threat = this.spottedPositions(sim).map((p) => ({ x: p.x, y: p.y, conf: 1 }));
    for (const c of sim.contacts[this.cfg.side].values()) {
      if (c.kind !== 'infantry') continue;
      this.threat.push({ x: c.x, y: c.y, conf: Math.max(0, 1 - (sim.tick - c.tick) / AI_MEMORY_TICKS) });
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
  // with no pure-rifle teams (e.g. a mixed legacy garrison where every team
  // already carries its own MG) falls back to letting every team both fire
  // and maneuver rather than leaving maneuver empty.
  private assignGroups(sim: Sim): void {
    const redTeams = sim.teams.filter((t) => sim.squads[t.squadId].side === this.cfg.side && this.cfg.posts[t.squadId]);
    const isBaseOfFire = (team: Team) =>
      team.soldierIds.some((id) => {
        const w: WeaponDef = WEAPONS[sim.soldiers[id].weapon];
        return !!w.heat || !!w.arc || w.pen !== undefined;
      });
    this.baseTeamIds = redTeams.filter(isBaseOfFire).map((t) => t.id);
    const rifle = redTeams.filter((t) => !isBaseOfFire(t));
    const pool = rifle.length > 0 ? rifle : redTeams;
    this.maneuverTeamIds = pool.slice(0, 2).map((t) => t.id);
    this.reserveTeamIds = pool.slice(2).map((t) => t.id);
    for (const id of this.maneuverTeamIds) {
      this.startStrength.set(id, sim.teams[id].soldierIds.filter((sid) => sim.soldiers[sid].alive).length);
    }
    this.groupsReady = true;
  }

  private centroid(sim: Sim, soldierIds: number[]): { x: number; y: number } {
    const alive = soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
    if (alive.length === 0) return { x: 0, y: 0 };
    return { x: alive.reduce((a, s) => a + s.x, 0) / alive.length, y: alive.reduce((a, s) => a + s.y, 0) / alive.length };
  }

  // ---- attack stance: shape (base of fire scores a position, moves there
  // once, then suppresses) -> maneuver (bound the covered flank) -> assault
  // (fast once suppression's established; the real 'assault' charge once
  // within ASSAULT_RANGE of a post with live threat) -> reserve commits on a maneuver
  // team's losses (spec's attack template; the assault gate uses BOTH
  // suppression-established and a cleared threat reading so the commander
  // doesn't stall forever against an unseen post).
  private runAttack(sim: Sim): void {
    for (const teamId of this.baseTeamIds) {
      const team = sim.teams[teamId];
      const post = this.cfg.posts[team.squadId];
      if (!post || !team.soldierIds.some((id) => sim.soldiers[id].alive)) continue;
      if (!this.baseFiring.has(teamId)) {
        if (!this.baseSpot.has(teamId)) this.baseSpot.set(teamId, this.baseFiringSpot(sim, team, post));
        const spot = this.baseSpot.get(teamId)!;
        const c = this.centroid(sim, team.soldierIds);
        if (Math.hypot(c.x - spot.x, c.y - spot.y) < BOF_SETTLE_RADIUS) {
          this.baseFiring.add(teamId); // arrived (or started close enough): fire from here on
        } else {
          sim.orderTeam(teamId, { kind: 'move', x: spot.x, y: spot.y });
          continue;
        }
      }
      const aim = this.aimPointFor(post);
      sim.orderTeam(teamId, { kind: 'fire', x: aim.x, y: aim.y });
      if (!this.fireStartTick.has(teamId)) this.fireStartTick.set(teamId, sim.tick);
    }

    for (const teamId of this.maneuverTeamIds) {
      const team = sim.teams[teamId];
      const post = this.cfg.posts[team.squadId] ?? Object.values(this.cfg.posts)[0];
      if (!post) continue;
      const alive = team.soldierIds.filter((id) => sim.soldiers[id].alive);
      if (alive.length === 0) continue;
      // Reserve commits on a maneuver team's losses — evaluated every eval
      // BEFORE the executing-assault guard below, so a team bleeding out
      // mid-charge (the highest-casualty moment) still triggers reinforcement.
      const start = this.startStrength.get(teamId) ?? alive.length;
      if (!this.reserveCommitted && start > 0 && alive.length / start < 0.5) this.commitReserve(sim);
      // an executing charge owns its team until the position is clear —
      // reissuing would re-roll compliance mid-charge and restart the run-in
      if (team.orderState.order?.kind === 'assault' && team.orderState.phase === 'executing') continue;
      const suppressed = this.suppressionEstablished(sim);
      const cleared = this.threatConfNear(post.x, post.y, 15) < CLEAR_CONF;
      const c = this.centroid(sim, team.soldierIds);
      const dist = Math.hypot(c.x - post.x, c.y - post.y);
      // Same gate at two distance bands: press the objective when suppression's
      // up and the post still reads live.
      const pressing = suppressed && !cleared;
      // Screen the objective as the maneuver team enters SMOKE_RANGE — laid a
      // touch beyond ASSAULT_RANGE so the smoke's flight and a blinded position
      // are up by the time the team is in charge range, which is what lets the
      // final leg's charge clear compliance (a naked charge onto a covered
      // post balks by construction).
      if (pressing && dist <= SMOKE_RANGE) this.maybeSmokeObjective(sim, post);
      if (pressing && dist <= ASSAULT_RANGE) {
        // suppression established, live threat on the post, close enough to
        // charge home: the 8th order, through the same API the player uses.
        // suppressionEstablished is a global attempt-gate; the real per-team
        // check is orderTeam's compliance ladder (dangerScore × the assault
        // mult), which downgrades a team that shouldn't charge to a move.
        sim.orderTeam(teamId, { kind: 'assault', x: post.x, y: post.y });
      } else if (suppressed || cleared) {
        sim.orderTeam(teamId, { kind: 'fast', x: post.x, y: post.y });
      } else {
        const flank = this.pickFlank(sim, team, post);
        sim.orderTeam(teamId, { kind: 'move', x: flank.x, y: flank.y });
      }
    }
  }

  // Base-of-fire position scoring (spec: "positions scored by LOS to
  // objective approaches + cover + range-band fit"), sampled once per team
  // and cached — a fixed ring of candidate points around the team's current
  // position plus staying put, scored by LOS to the post, cover, and the
  // same danger model soldiers use for refusal. Lightweight and
  // deterministic: no RNG, no per-tick re-scoring.
  private baseFiringSpot(sim: Sim, team: Team, post: { x: number; y: number }): { x: number; y: number } {
    const c = this.centroid(sim, team.soldierIds);
    const step = 10;
    const offsets: [number, number][] = [
      [0, 0],
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
      [step, step],
      [-step, step],
      [step, -step],
      [-step, -step],
    ];
    let best = { x: c.x, y: c.y };
    let bestScore = -Infinity;
    for (const [dx, dy] of offsets) {
      const p = { x: c.x + dx, y: c.y + dy };
      if (!sim.map.inBounds(Math.floor(p.x), Math.floor(p.y))) continue;
      // Scored at the stance the team will actually ADOPT at this spot, not the
      // standing eye it would have while walking there: a base of fire settles
      // in (stanceOf's defend/engaged branches are both a crouch). Evaluating
      // at 1.6 m would over-value overwatch spots on relief maps — every hollow
      // that reads "clear LOS to the post" from a standing eye can be blind
      // from the crouch the team will really be in. The post itself is a map
      // point, so it keeps the standing target height every sideSeesPoint-style
      // call uses.
      const los = sightBetween(sim, p.x, p.y, post.x, post.y, 0, 0, EYE_CROUCH, EYE_STAND).visible ? 1 : 0;
      const cover = sim.inCover(p.x, p.y) ? 1 : 0;
      const score = los * 2 + cover - dangerScore(sim, team, p);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  private suppressionEstablished(sim: Sim): boolean {
    for (const t of this.fireStartTick.values()) if ((sim.tick - t) / 30 >= SUPPRESSION_SECONDS) return true;
    return false;
  }

  private commitReserve(sim: Sim): void {
    this.reserveCommitted = true;
    for (const teamId of this.reserveTeamIds) {
      const post = this.cfg.posts[sim.teams[teamId].squadId] ?? Object.values(this.cfg.posts)[0];
      if (post) sim.orderTeam(teamId, { kind: 'move', x: post.x, y: post.y });
    }
  }

  // Which side of the direct axis to the post scores lower danger (spec:
  // "pick left/right by lower summed dangerScore") — reuses the same risk
  // model soldiers use for refusal (the spec's "one danger model, three
  // consumers": soldier, team, commander).
  private pickFlank(sim: Sim, team: Team, post: { x: number; y: number }): { x: number; y: number } {
    const c = this.centroid(sim, team.soldierIds);
    const dx = post.x - c.x;
    const dy = post.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const left = { x: c.x + dx * 0.5 + nx * FLANK_OFFSET, y: c.y + dy * 0.5 + ny * FLANK_OFFSET };
    const right = { x: c.x + dx * 0.5 - nx * FLANK_OFFSET, y: c.y + dy * 0.5 - ny * FLANK_OFFSET };
    return dangerScore(sim, team, left) <= dangerScore(sim, team, right) ? left : right;
  }

  // ---- defend stance: each squad holds its own post, counterattacking the
  // instant a known contact sits on it; settles into ambush once in place.
  // One order kind per pass (never both 'move' and 'ambush' to the same
  // squad in the same eval), so the squad-level broadcast here doesn't hit
  // the fire/move clobber that attack stance's split roles need orderTeam for.
  private runDefend(sim: Sim): void {
    for (const squad of sim.squads) {
      if (squad.side !== this.cfg.side) continue;
      const post = this.cfg.posts[squad.id];
      if (!post) continue;
      const members = squad.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
      if (members.length === 0) continue;
      const c = this.centroid(sim, squad.soldierIds);
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
      if (!v.alive || v.side !== this.cfg.side || v.path) continue;
      if (this.cfg.stance === 'attack') {
        const firstPost = Object.values(this.cfg.posts)[0];
        if (firstPost && Math.hypot(v.x - firstPost.x, v.y - firstPost.y) > 25) {
          sim.orderVehicleMove(v.id, firstPost.x, firstPost.y);
        }
      }
    }
  }

  // One barrage on the densest cluster among its side's spotted contacts, once
  // five or more sit together — intel-range knowledge, not weapon range: the
  // commander can shell an observed concentration its rifles can't yet reach.
  private maybeBarrage(sim: Sim): void {
    if (this.barrageUsed || sim.barragesLeft[this.cfg.side] <= 0) return;
    const seen = this.spottedPositions(sim);
    for (const b of seen) {
      const cluster = seen.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) < 8);
      if (cluster.length >= 5) {
        const cx = cluster.reduce((a, s) => a + s.x, 0) / cluster.length;
        const cy = cluster.reduce((a, s) => a + s.y, 0) / cluster.length;
        sim.callBarrage(this.cfg.side, cx, cy);
        this.barrageUsed = true;
        break;
      }
    }
  }

  // Screen an objective with mortar smoke ahead of the final-leg charge. The
  // doctrine loop the player already runs: a naked charge onto a post with LOS
  // over the approach balks by construction (defenders cover every
  // dangerSample), so smoke ON the objective — puffs on the post, not
  // mid-approach — blinds the position and drops the sightlines that make the
  // charge suicidal, until the assault's compliance ladder clears. The balks
  // before it lands are the point: the refusal ladder is what drives the AI
  // into doctrine. One mission at a time; a mortar already smoking is left to
  // finish (readyMortar skips smokeRoundsLeft > 0) rather than re-tasked.
  private maybeSmokeObjective(sim: Sim, post: { x: number; y: number }): void {
    const mortar = this.readyMortar(sim, post);
    if (mortar) sim.orderSmoke(mortar.id, post.x, post.y);
  }

  // A deployed mortar of its side not mid-smoke-mission, with shells its crew can
  // still feed, that can actually range and see the objective — the
  // commander's screen asset, scanned side-wide like the barrage: any mortar
  // on the field can screen any objective, independent of task-group assignment.
  private readyMortar(sim: Sim, post: { x: number; y: number }): Emplacement | null {
    for (const e of sim.emplacements) {
      if (e.side !== this.cfg.side || e.state !== 'deployed' || e.smokeRoundsLeft > 0) continue;
      const w: WeaponDef = WEAPONS[EMPLACEMENTS[e.kind].weapon];
      if (!w.arc) continue;
      // Reachability is a HARD gate, not a nicety. orderSmoke commits the
      // mission (smokeRoundsLeft = 4) up front, but fireEmplacementIndirect
      // only decrements it on a round that actually fires — a post outside the
      // tube's [minRange, range] band, or with no friendly LOS, never fires,
      // never decrements, and readyMortar's own smokeRoundsLeft>0 skip would
      // then lock that tube out of every future mission. So only task one that
      // can range and see the objective right now.
      const d = Math.hypot(e.x - post.x, e.y - post.y);
      if (d < w.arc.minRange || d > w.range) continue;
      if (!friendlyHasLos(sim, e.side, post.x, post.y)) continue;
      if (crewNear(sim, e).some((s) => (s.ammo[w.ammo.type] ?? 0) > 0)) return e;
    }
    return null;
  }
}
