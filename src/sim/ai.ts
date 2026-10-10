import { EMPLACEMENTS, WEAPONS, type WeaponDef } from './data';
import { crewNear, friendlyHasLos, type Emplacement } from './emplacement';
import { dangerScore, orderVerdict, type OrderKind, type TeamOrder } from './orders';
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
  // Briefed enemy avenue of approach (defend stance): with it, long-range
  // squads fight the approach from a pre-registered arc instead of lying in
  // a 40-60m ambush; without it, every squad keeps the legacy ambush.
  // Static briefing like posts — never an intel read.
  approach?: { x: number; y: number };
  // Attack stance: every objective the attack may roll onto once it has taken
  // the one its squads were briefed onto (the map's own objective list). Also
  // static briefing, also never an intel read. Without it the commander can
  // only progress among cfg.posts, and cfg.posts collapses: bridge.ts briefs
  // each squad onto the objective nearest ITS spawn anchor, and every squad
  // deploys in the same west strip, so on the open and woods generators all 18
  // squads share ONE post out of the map's three (measured, seeds 1-3) — the
  // attack culminated at its first objective with nowhere left it knew about.
  objectives?: { x: number; y: number }[];
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
const POST_CLEAR_RADIUS = 15; // m around a post the threat reading covers
const ASSAULT_RANGE = 30; // m from the post at which a suppressed-in maneuver team charges instead of running
const SMOKE_RANGE = 45; // m from the post at which the commander screens the objective with mortar smoke ahead of the charge
const FLANK_OFFSET = 20; // meters either side of the direct axis to the post
const BOF_SETTLE_RADIUS = 5; // close enough to the scored firing spot to stop moving and start firing
// Base-of-fire displacement (balance 2026-07). A team that cannot reach the
// objective is not a base of fire, whatever order it holds: it must close
// until a scored spot both sees the post and has it inside BOF_RANGE_FRAC of
// the longest weapon its survivors still carry (read off WEAPONS — an MG team
// that loses its gunner really is a carbine team and must come much closer).
// The 0.8 factor is the same "nominal range is where hits stop, not where they
// pay" discount ambushThreshold applies to pen weapons (orders.ts).
// BOF_LEG bounds one displacement: at ~1.4 m/s under a gun load a team covers
// ~7 m per 5 s eval, so a 20 m leg keeps the destination ahead of the team
// without committing past the next re-score.
const BOF_RANGE_FRAC = 0.8;
const BOF_LEG = 20;
// An order re-sent unchanged is not a no-op (#763): orderTeam re-rolls
// compliance, restarts a bound at element A and re-paths every man, and
// pathTo drops whatever rescue, ammo run or weapon hand-over he was on.
// Sent every 5 s eval, that cancelled 21 of the attacker's 31 rescues a battle
// (measured) — buddy aid alone takes 8 s. A team already carrying out the
// kind the commander wants, toward a point this close to the one it wants,
// is left to get on with it.
const SAME_ORDER_RADIUS = 5;
// Armour: two hulls sent to one objective stand this far apart instead of on
// one tile.
const HULL_SPACING = 10;
// A hull supports from behind its infantry (#787). It closes no nearer the
// objective than the lead rifle team working it, and holds HULL_STANDOFF out
// until that team is on the objective: 60 m is outside a panzerfaust's 35 m
// and inside the hull's own 100 m MG and 120 m gun. Sent straight to the
// objective it arrived first and alone, and 7 of 12 hulls were lost on the
// probe set (3 of 12 when they did not move at all). It is sent on again once
// it stands HULL_REORDER short of where it may be.
const HULL_STANDOFF = 60;
const HULL_REORDER = 10;
// Objective progression: a post with a live man of the commander's own side
// within this radius is held, and a maneuver team this close to its own post
// is standing on the objective.
const POST_HELD_RADIUS = 20;
// Culmination (balance 2026-07): the share of the committed force whose loss
// ends the attack. Attacks in open and woods ran to 60-69% casualties for zero
// wins — an attack that has failed at 60% had already failed at 35%, and
// nothing in the doctrine could say so, so the commander went on feeding teams
// into a defense that had beaten it. 35% is the historical combat-ineffective
// mark for a rifle company, and it sits above commitReserve's own trigger
// (half of ONE maneuver team), so the reserve is still spent trying to win
// before the attack is written off. One-way latch, like reserveCommitted:
// `downed` is recomputed from pain and blood loss every tick (sim.ts), so men
// stand back up and the ratio really does recover — an attack that has broken
// off must not un-break when it does.
const CULMINATION_LOSS = 0.35;
// Losses alone are not culmination: three of four winning bourg attacks ran
// past 55% casualties WHILE taking objectives (probed, seeds 1/5), and a flat
// threshold broke them off into 30-minute holds. The attack culminates only
// when it has ALSO taken no objective for this long — losses without
// progress. 6 game-minutes, not less: at 3 the window elapsed INSIDE winning
// town fights (probed again, same seeds — the grind between two bourg posts
// runs past 3 minutes with losses already over the threshold) and the stall
// gate broke off attacks that were winning. A 6-minute objective drought on
// these frontages is not a slow fight, it is the defense winning.
const CULMINATION_STALL_TICKS = 6 * 60 * 30;
// A fresh breach this close to a cached firing position invalidates it (design
// section 5 item 2). baseFiringSpot scores candidates on LOS to the post, and a
// hole in a wall is precisely a change in LOS — the commander would drift onto
// the new sightline for free, but only at the next sampling, which for a
// settled base of fire is never. Dropping the cache makes the drift immediate.
const BREACH_RESCORE_RADIUS = 40;
// Defend stance (balance 2026-07): half-width of the pre-registered arc a
// long-range squad covers toward cfg.approach (120° total).
const DEFEND_ARC_HALF = Math.PI / 3;
// Defensive mortar missions fire on a spotted mass of at least CLUSTER men
// inside RADIUS meters — deliberately ABOVE one full team, so a spread
// doctrine attack never trips it while a shoulder-to-shoulder mass does —
// and never onto a point within SAFETY meters of a friendly (danger close).
// SAFETY must beat worst-case shell placement: scatterNoLos (10m) plus the
// 9m frag radius reaches 19m from the aim point — at 15 the tubes were
// fragging their own forward outposts once the fights entangled.
const DEFEND_HE_CLUSTER = 8;
const DEFEND_HE_RADIUS = 12;
const DEFEND_HE_SAFETY = 25;
// Fire discipline releases against a massed attack (balance 2026-07): ambush
// is sited for infiltrators and patrols; once the commander's own intel shows
// this many enemies AT ONCE, the garrison is looking at a company in the open
// and every rifle switches to fire-at-will at full range. A doctrine attack
// that exposes one or two bounding teams at a time stays under the count and
// keeps facing the ambush it was designed to beat.
const MASS_RELEASE = 20;

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
  private baseSpot = new Map<number, { x: number; y: number }>(); // base teamId -> scored firing position, re-scored while displacing
  private baseFiring = new Set<number>(); // base teamId -> has reached a spot that can engage its post and is now suppressing
  private fireStartTick = new Map<number, number>(); // base teamId -> tick its fire order began
  private startStrength = new Map<number, number>(); // maneuver teamId -> eligible count at classification
  private postOverride = new Map<number, { x: number; y: number }>(); // teamId -> objective it rolled onto after taking its briefed one
  private teamPost = new Map<number, { x: number; y: number }>(); // teamId -> objective it is working this pass (briefed or rolled-onto)
  private takenPosts: { x: number; y: number }[] = []; // posts the attack has stood on and found clear
  private reserveCommitted = false;
  private forceStart = 0; // committed effectives at classification: the culmination denominator
  private culminated = false; // one-way: the attack has broken off and is consolidating on what it holds
  private lastProgressTick = 0; // classification, then each objective taken: the culmination stall clock
  private breachSeen = 0; // how much of sim.breachLog this commander has already reacted to
  private asked = new Map<number, OrderKind>(); // teamId -> the kind last sent it, which a cautious team may be executing as a plain 'move'
  private flankLeg = new Map<number, { post: { x: number; y: number }; x: number; y: number }>(); // maneuver teamId -> the flank bound it is on
  private hullSent = new Map<number, { x: number; y: number }>(); // vehicleId -> the hold point it was last sent to

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
    this.invalidateBreachedSpots(sim);

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

  // Walls that have opened since the last eval, read off the append-only
  // breachLog with a private cursor — NEVER through takeBreaches(), which is
  // the renderer's drain channel and would starve it. A cached firing spot
  // within BREACH_RESCORE_RADIUS of a new hole is dropped along with its
  // "settled and firing" flag, so the next eval re-scores and, if the breach
  // really did open a better sightline, relocates onto it.
  //
  // fireStartTick is deliberately NOT reset: suppression already imposed is
  // not undone by picking a better window to impose it from.
  //
  // Cost of a false positive is one re-score: baseFiringSpot's candidate ring
  // includes "stay put", and a team standing on the spot it re-picks is inside
  // BOF_SETTLE_RADIUS immediately, so it re-enters baseFiring the same eval.
  private invalidateBreachedSpots(sim: Sim): void {
    const log = sim.breachLog;
    if (this.breachSeen >= log.length) return;
    for (let i = this.breachSeen; i < log.length; i++) {
      const b = log[i];
      const mx = b.horiz ? b.x + 0.5 : b.x;
      const my = b.horiz ? b.y : b.y + 0.5;
      for (const [teamId, spot] of this.baseSpot) {
        if (Math.hypot(spot.x - mx, spot.y - my) > BREACH_RESCORE_RADIUS) continue;
        this.baseSpot.delete(teamId);
        this.baseFiring.delete(teamId);
      }
    }
    this.breachSeen = log.length;
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
    const carries = (team: Team, is: (w: WeaponDef) => boolean): boolean => team.soldierIds.some((id) => is(WEAPONS[sim.soldiers[id].weapon]));
    // A base of fire keeps heads down on the objective: a belt gun or a tube.
    // A rocket launcher does neither. Counted as one, three bazooka teams made
    // up three of blue's five "base of fire" teams and claimed suppression on
    // posts they could do nothing to (#763). Tank hunters follow with the
    // reserve instead of leading a rifle bound two men strong.
    const isBaseOfFire = (team: Team) => carries(team, (w) => !!w.heat || !!w.arc);
    const isTankHunter = (team: Team) => !isBaseOfFire(team) && carries(team, (w) => w.pen !== undefined);
    this.baseTeamIds = redTeams.filter(isBaseOfFire).map((t) => t.id);
    const rifle = redTeams.filter((t) => !isBaseOfFire(t) && !isTankHunter(t));
    const pool = rifle.length > 0 ? rifle : redTeams;
    // Half the pool maneuvers, half stays reserve. A flat two teams was a
    // company-sized attack fought by a dozen men — every other rifle team sat
    // out the battle unless commitReserve fired. The floor of two keeps a
    // small force bounding by pairs.
    const maneuverCount = Math.max(2, Math.ceil(pool.length / 2));
    this.maneuverTeamIds = pool.slice(0, maneuverCount).map((t) => t.id);
    this.reserveTeamIds = [...pool.slice(maneuverCount), ...(rifle.length > 0 ? redTeams.filter(isTankHunter) : [])].map((t) => t.id);
    for (const id of this.maneuverTeamIds) {
      this.startStrength.set(id, sim.teams[id].soldierIds.filter((sid) => sim.soldiers[sid].alive).length);
    }
    this.forceStart = this.effectives(sim, this.committedTeamIds());
    this.lastProgressTick = sim.tick;
    this.groupsReady = true;
  }

  // Every team the commander committed to the attack. A team that is both base
  // of fire and maneuver (the no-rifle-teams fallback above) appears twice —
  // in the starting count and the current one alike, so the ratio holds.
  private committedTeamIds(): number[] {
    return [...this.baseTeamIds, ...this.maneuverTeamIds, ...this.reserveTeamIds];
  }

  // Men still in the fight: the sim's own test, so a man bleeding out on the
  // ground counts as the loss he is rather than a rifle the attack still has.
  private effectives(sim: Sim, teamIds: number[]): number {
    let n = 0;
    for (const id of teamIds) {
      for (const sid of sim.teams[id].soldierIds) {
        const s = sim.soldiers[sid];
        if (s.alive && !s.downed && !s.captured) n++;
      }
    }
    return n;
  }

  private updateCulmination(sim: Sim): void {
    if (this.culminated || this.forceStart <= 0) return;
    if (sim.tick - this.lastProgressTick < CULMINATION_STALL_TICKS) return; // an attack taking ground is not culminating, whatever it costs
    if (this.effectives(sim, this.committedTeamIds()) / this.forceStart <= 1 - CULMINATION_LOSS) this.culminated = true;
  }

  // Consolidate: hold the ground the team is standing on — for a team that
  // took an objective, that ground IS the objective. Holding in place is a
  // measured choice, not a shortcut: a withdrawal leg back to the assembly
  // area was probed (open seeds 3/4) and cost MORE than staying down — 71%
  // final KIA vs 51% on seed 4 — because the walk back re-crosses the same
  // arcs that culminated the attack. Issued once: the order stands until the
  // commander has something else for the team. It cannot be refused — it
  // moves nobody (orders.ts movesTeam).
  private consolidate(sim: Sim, team: Team): void {
    if (team.orderState.order?.kind === 'defend') return;
    const c = this.centroid(sim, team.soldierIds);
    this.issue(sim, team, { kind: 'defend', x: c.x, y: c.y });
  }

  // Every order the attack sends goes through here, so `asked` is always the
  // commander's own last word to the team. A balked team is asked again: the
  // re-roll is the only thing that un-sticks it once the danger has eased. So
  // is a charge its team talked down to an advance — the charge is the point,
  // and the eval that finds the men willing must be able to launch it.
  private issue(sim: Sim, team: Team, order: TeamOrder): void {
    const st = team.orderState;
    if (
      st.order &&
      st.phase !== 'balked' &&
      order.kind !== 'assault' &&
      this.asked.get(team.id) === order.kind &&
      Math.hypot(st.order.x - order.x, st.order.y - order.y) <= SAME_ORDER_RADIUS
    ) {
      return;
    }
    this.asked.set(team.id, order.kind);
    sim.orderTeam(team.id, order, undefined, true);
  }

  // Whether the team is still walking the bound that ends at `p`.
  private onLeg(team: Team, p: { x: number; y: number }): boolean {
    const st = team.orderState;
    return st.order?.kind === 'move' && st.phase !== 'balked' && st.order.x === p.x && st.order.y === p.y;
  }

  private centroid(sim: Sim, soldierIds: number[]): { x: number; y: number } {
    const alive = soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
    if (alive.length === 0) return { x: 0, y: 0 };
    return { x: alive.reduce((a, s) => a + s.x, 0) / alive.length, y: alive.reduce((a, s) => a + s.y, 0) / alive.length };
  }

  // ---- attack stance: shape (base of fire displaces in bounded legs until a
  // scored position can see and reach the post, then suppresses) -> maneuver
  // (bound the covered flank) -> assault
  // (fast once suppression's established; the real 'assault' charge once
  // within ASSAULT_RANGE of a post with live threat) -> reserve commits on a maneuver
  // team's losses (spec's attack template; the assault gate uses BOTH
  // suppression-established and a cleared threat reading so the commander
  // doesn't stall forever against an unseen post) -> culmination (past
  // CULMINATION_LOSS the attack breaks off and consolidates on its gains).
  private runAttack(sim: Sim): void {
    this.updateCulmination(sim);
    for (const teamId of this.baseTeamIds) {
      const team = sim.teams[teamId];
      if (!team.soldierIds.some((id) => sim.soldiers[id].alive)) {
        // A wiped team suppresses nothing. Dropping its state is what lets
        // suppressionEstablished lapse instead of latching forever on the
        // fire order of a team that no longer exists.
        this.clearBaseState(teamId);
        continue;
      }
      const post = this.postFor(sim, team);
      if (!post) continue;
      const reach = this.bofReach(sim, team);
      if (!this.baseFiring.has(teamId)) {
        if (this.culminated) {
          // Settle where it stands rather than finish a displacement the attack
          // no longer needs. It never enters baseFiring, so a team that stopped
          // short of a firing position never claims suppression it cannot
          // deliver — the settled teams above go on firing.
          this.consolidate(sim, team);
          continue;
        }
        // A cached spot that can engage the post is the team's destination and
        // is kept: re-scoring it every eval is what makes a team chase a
        // marginally better patch of cover forever and never arrive (measured:
        // 1 of 5 support teams ever settled). A spot that cannot engage is
        // merely the current displacement leg: it is re-scored when the team
        // has walked it (or refused it), which is what walks the team forward.
        // Re-scoring it mid-leg moved the destination under the team every
        // eval, and each new destination was a new order (#763).
        let spot = this.baseSpot.get(teamId);
        if (!spot || (!this.canEngage(sim, spot, post, reach) && !this.onLeg(team, spot))) {
          spot = this.baseFiringSpot(sim, team, post, reach);
          this.baseSpot.set(teamId, spot);
        }
        const c = this.centroid(sim, team.soldierIds);
        if (this.canEngage(sim, spot, post, reach) && Math.hypot(c.x - spot.x, c.y - spot.y) < BOF_SETTLE_RADIUS) {
          this.baseFiring.add(teamId); // arrived at a spot that can actually reach the post: fire from here on
        } else {
          this.issue(sim, team, { kind: 'move', x: spot.x, y: spot.y });
          continue;
        }
      }
      const aim = this.aimPointFor(post);
      this.issue(sim, team, { kind: 'fire', x: aim.x, y: aim.y });
      if (!this.fireStartTick.has(teamId)) this.fireStartTick.set(teamId, sim.tick);
    }

    // Per-eval memo: the maneuver teams share an objective, and the eyes-on
    // check below is a scan over every living friendly.
    const eyesOn = new Map<{ x: number; y: number }, boolean>();
    for (const teamId of this.maneuverTeamIds) {
      const team = sim.teams[teamId];
      const alive = team.soldierIds.filter((id) => sim.soldiers[id].alive);
      if (alive.length === 0) continue;
      const post = this.postFor(sim, team);
      if (!post) continue;
      // Reserve commits on a maneuver team's losses — evaluated every eval
      // BEFORE the executing-assault guard below, so a team bleeding out
      // mid-charge (the highest-casualty moment) still triggers reinforcement.
      const start = this.startStrength.get(teamId) ?? alive.length;
      if (!this.culminated && !this.reserveCommitted && start > 0 && alive.length / start < 0.5) this.commitReserve(sim);
      // an executing charge owns its team until the position is clear —
      // reissuing would re-roll compliance mid-charge and restart the run-in
      if (team.orderState.order?.kind === 'assault' && team.orderState.phase === 'executing') continue;
      if (this.culminated) {
        // The attack is over: consolidate on what it holds instead of feeding
        // the rest of the company into the position that broke it. A charge
        // already running keeps its team (the guard above) and finishes.
        this.consolidate(sim, team);
        continue;
      }
      const suppressed = this.suppressionEstablished(sim, post);
      // "Cleared" has to mean the commander looked and found nothing, not that
      // it never looked: under fog an objective nobody has eyes on reads
      // exactly as empty as one that has been swept. The vacuous form put the
      // maneuver element on a 'fast' order across 120 m of unobserved ground
      // the moment the attack rolled onto its next objective (measured: 24
      // dead in the 100 s after the roll). friendlyHasLos is the same own-side
      // shared-vision read the commander's own fire missions are gated on.
      let seen = eyesOn.get(post);
      if (seen === undefined) {
        seen = friendlyHasLos(sim, this.cfg.side, post.x, post.y);
        eyesOn.set(post, seen);
      }
      const cleared = seen && this.threatConfNear(post.x, post.y, POST_CLEAR_RADIUS) < CLEAR_CONF;
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
        // Forecast the same ladder orderTeam will run. A balked charge used to
        // be re-issued every eval until transient danger decayed and fed the
        // team into an unchanged defended lane (#216).
        if (orderVerdict(sim, team, { kind: 'assault', x: post.x, y: post.y }).verdict === 'balk') {
          this.divertRefusedAssault(sim, team, post);
          continue;
        }
        // Floor-aware town assault (#130): defend/ambush auto-garrisons the
        // top storey, so brief the charge to that same storey.
        const stories = sim.map.storiesAt(Math.floor(post.x), Math.floor(post.y));
        this.issue(sim, team, { kind: 'assault', x: post.x, y: post.y, l: stories >= 2 ? stories - 1 : 0 });
      } else if (suppressed || cleared) {
        this.issue(sim, team, { kind: 'fast', x: post.x, y: post.y });
      } else {
        const flank = this.flankBound(sim, team, post);
        this.issue(sim, team, { kind: 'move', x: flank.x, y: flank.y });
      }
    }
  }

  // The distance at which this team's fire is worth something: the longest
  // range its survivors still carry, discounted by BOF_RANGE_FRAC. Recomputed
  // from live members every eval, so casualties shorten the reach and the team
  // displaces closer instead of "suppressing" from where its dead gunner could
  // have.
  private bofReach(sim: Sim, team: Team): number {
    let range = 0;
    for (const id of team.soldierIds) {
      const s = sim.soldiers[id];
      if (!s.alive || s.downed) continue;
      range = Math.max(range, WEAPONS[s.weapon].range);
    }
    return range * BOF_RANGE_FRAC;
  }

  // Whether a team firing from `p` can actually engage `post` — the honest
  // form of "the base of fire is shooting at the objective". Both halves
  // matter: LOS alone lets a team fire at a point 130 m past its own maximum
  // range, and range alone lets it fire through a hill.
  private canEngage(sim: Sim, p: { x: number; y: number }, post: { x: number; y: number }, reach: number): boolean {
    if (Math.hypot(p.x - post.x, p.y - post.y) > reach) return false;
    // Scored at the stance the team will actually ADOPT at this spot, not the
    // standing eye it would have while walking there: a base of fire settles
    // in (stanceOf's defend/engaged branches are both a crouch). Evaluating
    // at 1.6 m would over-value overwatch spots on relief maps — every hollow
    // that reads "clear LOS to the post" from a standing eye can be blind
    // from the crouch the team will really be in. The post itself is a map
    // point, so it keeps the standing target height every sideSeesPoint-style
    // call uses.
    return sightBetween(sim, p.x, p.y, post.x, post.y, 0, 0, EYE_CROUCH, EYE_STAND).visible;
  }

  // Base-of-fire position scoring (spec: "positions scored by LOS to
  // objective approaches + cover + range-band fit"): a ring of candidate
  // points scored by whether the team could engage the post from there,
  // cover, and the same danger model soldiers use for refusal. Lightweight
  // and deterministic: no RNG.
  //
  // The ring is centred one bounded leg ahead of the team, on the axis to the
  // post and never past the arc where the team can shoot. That is what makes
  // this a displacement rather than a one-time choice: sampling around the
  // team's CURRENT position can only ever find cover, so a base of fire that
  // started out of range stayed out of range for the whole battle and its
  // "fire" order was a decoration.
  private baseFiringSpot(sim: Sim, team: Team, post: { x: number; y: number }, reach: number): { x: number; y: number } {
    const c = this.centroid(sim, team.soldierIds);
    const d = Math.hypot(post.x - c.x, post.y - c.y) || 1;
    // How far forward to look. Nothing while the team can already engage from
    // where it stands. Otherwise the range gap — or, when range is not what is
    // missing, a full leg: a hedgerow does not open because you stopped
    // walking, and sizing the leg off the range gap alone stalled blind teams
    // 127 m out with a 120 m reach, inching 7 m per eval and never seeing the
    // objective (measured, seed 1 open).
    let lead = 0;
    if (!this.canEngage(sim, c, post, reach)) {
      const gap = d - reach;
      lead = Math.min(BOF_LEG, gap > 0 ? gap : d);
    }
    const ax = c.x + ((post.x - c.x) / d) * lead;
    const ay = c.y + ((post.y - c.y) / d) * lead;
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
      const p = { x: ax + dx, y: ay + dy };
      if (!sim.map.inBounds(Math.floor(p.x), Math.floor(p.y))) continue;
      const engage = this.canEngage(sim, p, post, reach) ? 1 : 0;
      const cover = sim.inCover(p.x, p.y) ? 1 : 0;
      const score = engage * 2 + cover - dangerScore(sim, team, p);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  private clearBaseState(teamId: number): void {
    this.baseSpot.delete(teamId);
    this.baseFiring.delete(teamId);
    this.fireStartTick.delete(teamId);
  }

  // fireStartTick only ever holds teams that reached a spot passing canEngage
  // (runAttack sets it inside the settled branch and clearBaseState removes it
  // when the team is wiped or re-tasked), so this reads "a team of mine has
  // been shooting at an objective it can see and reach for 10 s" — not "some
  // team has held a fire order", which was true from the first eval regardless
  // of whether a round could ever land.
  //
  // Scoped to the objective being attacked, not global: once the attack rolls
  // onto its next objective, the support teams still shooting up the one
  // behind it are covering nobody, and crediting them sent the maneuver
  // element sprinting the gap to a fresh garrison under no fire at all
  // (measured: 45 more blue dead in the 3000 ticks after the roll-forward).
  private suppressionEstablished(sim: Sim, post: { x: number; y: number }): boolean {
    for (const [teamId, t] of this.fireStartTick) {
      if ((sim.tick - t) / 30 < SUPPRESSION_SECONDS) continue;
      const p = this.teamPost.get(teamId);
      if (p && Math.hypot(p.x - post.x, p.y - post.y) <= POST_HELD_RADIUS) return true;
    }
    return false;
  }

  // ---- objective progression: the post a team is actually working. Its
  // briefed post until the team stands on it with no live threat left, then
  // the nearest objective nobody holds.
  //
  // "Taken" deliberately needs occupation as well as a clear threat reading:
  // under fog of war an objective nobody has looked at reads exactly as clear
  // as a captured one, so clearing alone would let the commander declare every
  // post taken from the line of departure. Progression only ever selects among
  // cfg.posts — the static briefing — never a coordinate the belief state
  // doesn't already contain.
  private postFor(sim: Sim, team: Team): { x: number; y: number } | undefined {
    const cur = this.postOverride.get(team.id) ?? this.cfg.posts[team.squadId] ?? Object.values(this.cfg.posts)[0];
    if (!cur) return undefined;
    const working = (p: { x: number; y: number }): { x: number; y: number } => {
      this.teamPost.set(team.id, p);
      return p;
    };
    if (this.culminated) return working(cur); // a culminated attack takes no new objectives
    // Two triggers roll a team forward: it stands on its own objective with no
    // live threat left there, or the attack has ALREADY recorded that
    // objective taken. The second is what carries the base of fire, which
    // settles at weapon range and so never stands on the post — left behind,
    // it goes on suppressing an empty objective while the riflemen cross the
    // next bound unsupported.
    if (!this.isTaken(cur)) {
      const c = this.centroid(sim, team.soldierIds);
      if (Math.hypot(c.x - cur.x, c.y - cur.y) > POST_HELD_RADIUS) return working(cur);
      if (this.threatConfNear(cur.x, cur.y, POST_CLEAR_RADIUS) >= CLEAR_CONF) return working(cur);
      this.takenPosts.push(cur);
      this.lastProgressTick = sim.tick; // an objective taken restarts the culmination stall clock
    }
    const next = this.nextPost(sim, cur);
    // Nothing left it knows of, or the objective it is already on has come
    // back to life: either way the team stays. Treating "the same post again"
    // as a roll-forward reset the base of fire's clock every eval the post
    // read live, so suppression could never latch (measured: supp flipping
    // true/false on a 300-tick cycle, and the charge never stepped off).
    if (!next || Math.hypot(next.x - cur.x, next.y - cur.y) < 1) return working(cur);
    this.postOverride.set(team.id, next);
    // A base of fire qualified against the OLD objective. A new one is a new
    // displacement problem, so it re-scores and re-earns its fire order.
    this.clearBaseState(team.id);
    return working(next);
  }

  private isTaken(p: { x: number; y: number }): boolean {
    return this.takenPosts.some((t) => Math.hypot(t.x - p.x, t.y - p.y) < 1);
  }

  // Nearest objective still worth attacking: one the attack has not already
  // stood on and nobody is holding, else the nearest one the belief state says
  // is occupied again (a retaken post is a live objective, and without this
  // branch a counterattack behind the advance would never be answered).
  private nextPost(sim: Sim, from: { x: number; y: number }): { x: number; y: number } | null {
    let fresh: { x: number; y: number } | null = null;
    let freshD = Infinity;
    let retake: { x: number; y: number } | null = null;
    let retakeD = Infinity;
    for (const p of this.cfg.objectives ?? Object.values(this.cfg.posts)) {
      const d = Math.hypot(p.x - from.x, p.y - from.y);
      if (d < freshD && !this.isTaken(p) && !this.postHeld(sim, p)) {
        fresh = p;
        freshD = d;
      }
      if (d < retakeD && this.threatConfNear(p.x, p.y, POST_CLEAR_RADIUS) >= CLEAR_CONF) {
        retake = p;
        retakeD = d;
      }
    }
    return fresh ?? retake;
  }

  private postHeld(sim: Sim, p: { x: number; y: number }): boolean {
    return sim.soldiers.some((s) => s.side === this.cfg.side && s.alive && !s.downed && Math.hypot(s.x - p.x, s.y - p.y) <= POST_HELD_RADIUS);
  }

  // The reserve joins the maneuver element (#763). It used to get one 'move'
  // onto its briefed post and nothing after: runAttack only ever looped the
  // maneuver set, so 50 of blue's 126 riflemen walked one leg and stood there
  // for the rest of the battle (measured: 66 of 72 reserve teams ended idle).
  // Appending to the array runAttack is iterating is deliberate — the loop
  // reaches the new teams in this same eval, so they step off with the
  // objective, flank and suppression reading everyone else is working from.
  private commitReserve(sim: Sim): void {
    this.reserveCommitted = true;
    for (const teamId of this.reserveTeamIds) {
      this.maneuverTeamIds.push(teamId);
      this.startStrength.set(teamId, sim.teams[teamId].soldierIds.filter((sid) => sim.soldiers[sid].alive).length);
    }
    this.reserveTeamIds = [];
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

  // The flank bound a maneuver team is on, or a fresh one. pickFlank works
  // from where the team stands, so asking it again mid-bound moves the point
  // every eval and flips its side whenever the two danger sums cross — the
  // team never finished a bound it was sent on. A bound is held until the team
  // has walked it, refused it, or been given another objective.
  private flankBound(sim: Sim, team: Team, post: { x: number; y: number }): { x: number; y: number } {
    const leg = this.flankLeg.get(team.id);
    if (leg && leg.post === post && this.onLeg(team, leg)) return leg;
    const p = this.pickFlank(sim, team, post);
    this.flankLeg.set(team.id, { post, x: p.x, y: p.y });
    return p;
  }

  // A refused frontal becomes a feasible flank bound or a crouched hold while
  // smoke or new geometry changes the same danger reading. No hidden intel or RNG.
  private divertRefusedAssault(sim: Sim, team: Team, post: { x: number; y: number }): void {
    const flank = this.flankBound(sim, team, post);
    if (orderVerdict(sim, team, { kind: 'move', x: flank.x, y: flank.y }).verdict !== 'balk') {
      this.issue(sim, team, { kind: 'move', x: flank.x, y: flank.y });
    } else {
      this.consolidate(sim, team);
    }
  }

  // ---- defend stance: each squad holds its own post, counterattacking the
  // instant a known contact sits on it. Settled squads split by armament
  // (balance 2026-07): with a briefed approach, a squad carrying a belt MG or
  // a 150m+ weapon fights from a pre-registered 'defend' arc — ambush's
  // 40-60m hold-fire forfeited exactly the ranges those weapons were sited
  // for, handing a massed attacker a free approach march. Rifle squads (and
  // everyone, when no approach is briefed) keep the legacy ambush.
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
        sim.orderSquad(squad.id, { kind: 'move', x: post.x, y: post.y }, undefined, true); // counterattack a lost post
      } else if (distToPost <= 8 && !moving) {
        const order = team.orderState.order;
        const approach = this.cfg.approach;
        const arcDefend = (): void => {
          if (approach) {
            const center = Math.atan2(approach.y - post.y, approach.x - post.x);
            sim.orderSquad(squad.id, { kind: 'defend', x: post.x, y: post.y, arc: [center - DEFEND_ARC_HALF, center + DEFEND_ARC_HALF] }, undefined, true);
          } else {
            sim.orderSquad(squad.id, { kind: 'defend', x: post.x, y: post.y }, undefined, true);
          }
        };
        if (order === null) {
          const longRange = members.some((s) => {
            const w: WeaponDef = WEAPONS[s.weapon];
            return !!w.heat || w.range >= 150;
          });
          if (approach && longRange) {
            arcDefend();
          } else {
            sim.orderSquad(squad.id, { kind: 'ambush', x: post.x, y: post.y }, undefined, true); // settled in, holding fire
          }
        } else if (order.kind === 'ambush' && this.spottedPositions(sim).length >= MASS_RELEASE) {
          arcDefend(); // see MASS_RELEASE: fire-at-will against a spotted mass
        }
      }
    }
    this.maybeDefendHE(sim);
  }

  // Defensive fires (balance 2026-07): task every ready mortar onto the
  // densest spotted mass, re-aimed each eval so the mission tracks it. The
  // only defensive weapon whose effect scales with target density is the
  // 81mm shell (15m suppression, 9m fragments) — without this the garrison's
  // tubes sit silent while a company crosses the open in a crowd. Honest
  // vision throughout: the cluster comes from spottedPositions (the sim's
  // own intel layer) and every mission is gated on friendlyHasLos, the same
  // shared-vision spotting rule the player's own fire missions obey.
  private maybeDefendHE(sim: Sim): void {
    const seen = this.spottedPositions(sim);
    if (seen.length < DEFEND_HE_CLUSTER) return;
    let best: { x: number; y: number; n: number } | null = null;
    for (const b of seen) {
      const cluster = seen.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) < DEFEND_HE_RADIUS);
      if (cluster.length < DEFEND_HE_CLUSTER || (best && cluster.length <= best.n)) continue;
      best = {
        x: cluster.reduce((a, s) => a + s.x, 0) / cluster.length,
        y: cluster.reduce((a, s) => a + s.y, 0) / cluster.length,
        n: cluster.length,
      };
    }
    if (!best) return;
    for (const s of sim.soldiers) {
      if (s.side !== this.cfg.side || !s.alive || s.downed) continue;
      if (Math.hypot(s.x - best.x, s.y - best.y) < DEFEND_HE_SAFETY) return; // danger close
    }
    for (const e of sim.emplacements) {
      if (e.side !== this.cfg.side || e.state !== 'deployed' || e.smokeRoundsLeft > 0) continue;
      const w: WeaponDef = WEAPONS[EMPLACEMENTS[e.kind].weapon];
      if (!w.arc) continue;
      const d = Math.hypot(e.x - best.x, e.y - best.y);
      if (d < w.arc.minRange || d > w.range) continue;
      if (!friendlyHasLos(sim, e.side, best.x, best.y)) continue;
      if (!crewNear(sim, e).some((s) => (s.ammo[w.ammo.type] ?? 0) > 0)) continue;
      sim.orderFire(e.id, best.x, best.y);
    }
  }

  // Armour, attack stance: hulls go where the maneuver element is going and
  // are sent on when it rolls forward (#763). They used to be sent to the
  // first post in the briefing, once: they reached it in about 20 s, ahead of
  // every rifleman, and stood there for the rest of the battle while the
  // attack worked objectives 100 m further on. Defend stance issues nothing —
  // a hull holds where it was staged.
  //
  // Each hull closes along its own line to the objective, to the distance
  // the lead rifle team stands at or HULL_STANDOFF, whichever is farther
  // (#787): it comes up as the riflemen do and stops short while they close.
  // Once they are inside ASSAULT_RANGE it goes in with them, still no nearer
  // than they are — held at the standoff for good, the hulls survived and the
  // attack stopped winning (probed: 4 of 8, from 6). It is only ever sent
  // forward: a hold point laid on the lead team's axis instead swung with
  // every flank bound, and the hulls drove 750 m a battle chasing it. An
  // objective the attack has taken is driven onto, which arises only when
  // there is no next one to roll to.
  private updateVehicles(sim: Sim): void {
    if (this.cfg.stance !== 'attack' || this.culminated) return;
    const post = this.maneuverPost(sim);
    if (!post) return;
    const lead = this.leadDistance(sim, post);
    if (lead === undefined) return;
    const hold = this.isTaken(post) ? 0 : lead <= ASSAULT_RANGE ? lead : Math.max(HULL_STANDOFF, lead);
    const hulls = sim.vehicles.filter((v) => v.side === this.cfg.side);
    hulls.forEach((v, slot) => {
      if (!v.alive) return;
      const d = Math.hypot(v.x - post.x, v.y - post.y);
      if (d <= hold + HULL_REORDER) return; // as far forward as it may go
      const ux = (v.x - post.x) / d;
      const uy = (v.y - post.y) / d;
      const off = (slot - (hulls.length - 1) / 2) * HULL_SPACING;
      const tx = post.x + ux * hold - uy * off;
      const ty = post.y + uy * hold + ux * off;
      const sent = this.hullSent.get(v.id);
      if (v.path && sent && Math.hypot(sent.x - tx, sent.y - ty) <= HULL_REORDER) return; // already on its way there
      this.hullSent.set(v.id, { x: tx, y: ty });
      sim.orderVehicleMove(v.id, tx, ty);
    });
  }

  // How far from `post` the nearest living maneuver team working it stands.
  private leadDistance(sim: Sim, post: { x: number; y: number }): number | undefined {
    let lead: number | undefined;
    for (const id of this.maneuverTeamIds) {
      const p = this.teamPost.get(id);
      const team = sim.teams[id];
      if (!p || Math.hypot(p.x - post.x, p.y - post.y) >= 1) continue;
      if (!team.soldierIds.some((sid) => sim.soldiers[sid].alive && !sim.soldiers[sid].downed)) continue;
      const c = this.centroid(sim, team.soldierIds);
      const d = Math.hypot(c.x - post.x, c.y - post.y);
      if (lead === undefined || d < lead) lead = d;
    }
    return lead;
  }

  // The objective most of the living maneuver element is working this eval
  // (teamPost, as postFor left it), ties to the earliest team.
  private maneuverPost(sim: Sim): { x: number; y: number } | undefined {
    const tally: { p: { x: number; y: number }; n: number }[] = [];
    for (const id of this.maneuverTeamIds) {
      const p = this.teamPost.get(id);
      if (!p || !sim.teams[id].soldierIds.some((sid) => sim.soldiers[sid].alive)) continue;
      const t = tally.find((o) => Math.hypot(o.p.x - p.x, o.p.y - p.y) < 1);
      if (t) t.n++;
      else tally.push({ p, n: 1 });
    }
    let best: { p: { x: number; y: number }; n: number } | undefined;
    for (const t of tally) if (!best || t.n > best.n) best = t;
    return best?.p;
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
