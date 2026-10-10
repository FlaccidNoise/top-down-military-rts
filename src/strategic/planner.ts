// The goal-driven opponent (§4.1): a two-tier planner. TIER 1 (operational,
// 360-min cadence) reads its OWN WarGoals through IntelView, ranks objective
// nodes by value/ETA/opposition, picks 1..maxAxes graph axes weighted by
// chokepoints (Tarjan articulation nodes, computed once per theater), masses
// toward concentrationRatio and holds an explicit reserve echelon. TIER 2
// (force ladder, 60-min cadence): withdraw → relieve → attack (massed, the
// reserve called in when the axis fails alone) → advance → counterattack →
// cut → probe → hold. A garrison keeps its post: it sorties on a weaker enemy
// next door and comes back. Whoever stands takes a posture: dug in on a post
// or an objective, at rest when tired and safe. Zero RNG anywhere; ties break
// lowest node id → force id.
import { lightAt } from '../sim/solar';
import type { Side } from '../sim/sim';
import { coarseOdds } from './bridge';
import type { NetPos, Theater } from './theater';
import { anchorNode, CONTACT_M, incidentFoot, otherEnd, pathNodes, route, type Force, type FrontV2 } from './theater/force';
import { posSupplied, traceSupply } from './theater/supply';
import { forceEtaMinutes, orderMove, planMove, setPosture } from './theater/step';
import { siteDefence, THREAT_M, walkover } from './theater/war';
import { graphGap } from './theater/contact';
import { combatMult, DIG_DEF_MULT, effStrength } from './theater/combat';
import type { EnemyContact, IntelView } from './intel';
import type { WarGoals, WinCondition } from './goals';

export interface DoctrineV2 {
  planMinutes: number;
  evalMinutes: number;
  maxAxes: number;
  concentrationRatio: number; // mass this multiple of estimated defenders on the main axis
  reserveFrac: number;
  withdrawRatio: number;
  attackOdds: number; // floor to order an attack
  suicideOdds: number; // absolute veto floor — deadline pressure never crosses it
  deadlinePressure: number; // OQ14: attackOdds decays toward suicideOdds as the deadline nears
}

export const RED_V2: DoctrineV2 = {
  planMinutes: 360,
  evalMinutes: 60,
  maxAxes: 2,
  concentrationRatio: 1.3,
  reserveFrac: 0.25,
  withdrawRatio: 3,
  attackOdds: 0.35,
  suicideOdds: 0.12,
  deadlinePressure: 0.15,
};
export const BLUE_V2: DoctrineV2 = { ...RED_V2, attackOdds: 0.3, deadlinePressure: 0.18 };

export interface Axis {
  objective: number; // node id
  assigned: number[]; // force ids
}
export interface OperationalPlan {
  atMin: number;
  axes: Axis[];
  reserveIds: number[];
}

// A force beaten in a fight reorganises this long before the planner orders
// it to ATTACK again (it may still advance onto open ground or withdraw).
// Measured over the 16 pin wars at 0, 120, 180, 240 and 360: blue-destroyed
// stays at 0-1 and blue wins at 3-6 with no trend, so the length is a
// doctrine choice, not a tuned value. What it buys is tempo: planner attacks
// on the node a force was just thrown back from, inside the hour, go 7 -> 0.
export const REORG_MIN = 240;

// A garrison leaves its post only for a fight it should win: these odds or
// better against a lone enemy next door.
export const SORTIE_ODDS = 0.7;
// A garrison stays in when an enemy it is not sortieing on stands within this
// many march minutes of its post.
export const SORTIE_COVER_MIN = 120;
// A force this tired rests instead of setting out for open ground. Without
// it a raider marches the whole war at fatigue 1.
export const RAID_REST_FATIGUE = 0.5;
// Massed forces step off so they arrive within this many minutes of each
// other: the nearer one waits for the farther.
export const MASS_SYNC_MIN = 60;

// What an enemy is worth on the defence: a dug-in one is harder to shift.
// Intel carries headcount and earthworks. The enemy's supply and fatigue are
// not read: with them red sortied four times as often on a worn blue company
// and AI blue won 1 of 16 pin wars.
const holds = (c: EnemyContact): number => c.strength * (c.dug ? DIG_DEF_MULT : 1);
// Orders that cannot wait go at a forced march. A sortie is one: the post is
// open until the garrison is back.
const URGENT = new Set(['withdraw', 'relieve', 'commit-reserve', 'sortie']);

export type StallCode = 'no-forces' | 'no-reachable-objective' | 'no-viable-attack' | 'goals-met-holding';
export interface PlannerReport {
  orders: { forceId: number; dest: number; why: string }[];
  stall: StallCode | null;
}

// Tarjan articulation nodes over the foot graph — the chokepoints. Computed
// once per theater and cached on the instance.
export function articulationNodes(t: Theater): Set<number> {
  const adj = new Map<number, number[]>();
  for (const e of t.edges) {
    if (e.moveClass === 'rail') continue;
    adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
    adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
  }
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const out = new Set<number>();
  let timer = 0;
  const dfs = (u: number, parent: number): void => {
    disc.set(u, ++timer);
    low.set(u, timer);
    let children = 0;
    for (const v of (adj.get(u) ?? []).slice().sort((a, b) => a - b)) {
      if (v === parent) continue;
      if (disc.has(v)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        continue;
      }
      children++;
      dfs(v, u);
      low.set(u, Math.min(low.get(u)!, low.get(v)!));
      if (parent !== -1 && low.get(v)! >= disc.get(u)!) out.add(u);
    }
    if (parent === -1 && children > 1) out.add(u);
  };
  for (const n of t.nodes) if (!disc.has(n.id) && (adj.get(n.id) ?? []).length > 0) dfs(n.id, -1);
  return out;
}

const controlNodes = (goals: WinCondition[]): number[] =>
  goals.flatMap((c) => (c.kind === 'control' ? c.nodeIds : []));

export class Commander2 {
  plan: OperationalPlan | null = null;
  lastEvalMin = -Infinity;
  private chokepoints: Set<number> | null = null;

  constructor(
    public readonly side: Side,
    public readonly doctrine: DoctrineV2,
    private readonly goals: WarGoals,
    private readonly deadlineDay: number,
    private readonly opts: { nightTempo?: boolean } = {},
  ) {}

  // Estimated effective enemy strength within contact range of a node.
  private defendersAt(front: FrontV2, intel: IntelView, nodeId: number): number {
    let eff = 0;
    for (const c of intel.contacts()) {
      if (graphGap(front.theater, { kind: 'node', nodeId }, c.pos) <= CONTACT_M) eff += c.strength;
    }
    return eff;
  }

  private replan(front: FrontV2, intel: IntelView): void {
    const t = front.theater;
    this.chokepoints ??= articulationNodes(t);
    // Targets: the contested control nodes of BOTH sides' goals — for the
    // deadline side, retaking what the enemy needs IS the goal (denial), so
    // a defender with a deadline attacks lost ground instead of waiting.
    const mobiles = intel
      .own()
      .filter((f) => f.role !== 'garrison' && f.engagedIn === null)
      .sort((a, b) => a.id - b.id);
    const targets = [...new Set([...controlNodes(this.goals.blue), ...controlNodes(this.goals.red)])]
      .filter((n) => intel.control(n) !== this.side)
      .sort((a, b) => a - b);
    const scored: { axis: Axis; score: number }[] = [];
    for (const target of targets) {
      // Nearest mobile force's route minutes seed the axis score; targets no
      // force can reach drop out.
      let bestMin = Infinity;
      for (const f of mobiles) {
        const from = f.pos.kind === 'node' ? f.pos.nodeId : t.edges[f.pos.edgeId].a;
        const r = route(t, from, target);
        if (r && r.minutes < bestMin) bestMin = r.minutes;
      }
      if (!Number.isFinite(bestMin)) continue;
      const defEff = this.defendersAt(front, intel, target);
      const choke = this.chokepoints.has(target) ? 0.85 : 1; // chokepoint objectives are worth more
      scored.push({ axis: { objective: target, assigned: [] }, score: bestMin * choke + defEff * 2 });
    }
    scored.sort((a, b) => a.score - b.score || a.axis.objective - b.axis.objective);
    const axes: Axis[] = scored.slice(0, this.doctrine.maxAxes).map((s) => s.axis);

    // Reserve echelon: role 'reserve' first, else the largest force, until
    // reserveFrac of total mobile strength is held back.
    const totalEff = mobiles.reduce((a, f) => a + effStrength(f), 0);
    const reserveIds: number[] = [];
    let reserved = 0;
    const reservePool = [...mobiles].sort((a, b) => (a.role === 'reserve' ? -1 : 1) - (b.role === 'reserve' ? -1 : 1) || effStrength(b) - effStrength(a) || a.id - b.id);
    for (const f of reservePool) {
      if (reserved >= this.doctrine.reserveFrac * totalEff) break;
      if (axes.length > 0 && mobiles.length - reserveIds.length <= axes.length) break; // never reserve the last attackers
      reserveIds.push(f.id);
      reserved += effStrength(f);
    }

    // Assignment: nearest axis by route minutes; concentration check folds
    // the weakest axis into the strongest when the mass isn't there.
    const assignable = mobiles.filter((f) => !reserveIds.includes(f.id));
    for (const f of assignable) {
      let best: { axis: Axis; min: number } | null = null;
      for (const axis of axes) {
        const from = f.pos.kind === 'node' ? f.pos.nodeId : t.edges[f.pos.edgeId].a;
        const r = route(t, from, axis.objective);
        if (!r) continue;
        if (!best || r.minutes < best.min) best = { axis, min: r.minutes };
      }
      best?.axis.assigned.push(f.id);
    }
    if (axes.length > 1) {
      const byId = new Map(mobiles.map((f) => [f.id, f]));
      const mass = (axis: Axis): number =>
        axis.assigned.reduce((a, id) => a + effStrength(byId.get(id)!), 0);
      const need = (axis: Axis): number => this.doctrine.concentrationRatio * Math.max(1, this.defendersAt(front, intel, axis.objective));
      const weak = axes.filter((ax) => mass(ax) < need(ax));
      if (weak.length === axes.length) {
        // Nobody has the mass: concentrate everything on the best axis.
        const main = axes[0];
        for (const ax of axes.slice(1)) main.assigned.push(...ax.assigned);
        axes.length = 1;
      }
    }
    this.plan = { atMin: front.clockMin, axes, reserveIds };
  }

  // Called every strategic minute; internally cadenced. Zero RNG.
  evaluate(front: FrontV2, intel: IntelView): PlannerReport | null {
    if (front.clockMin - this.lastEvalMin < this.doctrine.evalMinutes) return null;
    this.lastEvalMin = front.clockMin;
    if (!this.plan || front.clockMin - this.plan.atMin >= this.doctrine.planMinutes) this.replan(front, intel);

    const t = front.theater;
    const own = intel.own().sort((a, b) => a.id - b.id);
    if (own.length === 0) return { orders: [], stall: 'no-forces' };
    const plan = this.plan!;
    const enemy: Side = this.side === 'blue' ? 'red' : 'blue';

    // Deadline pressure (OQ14): the attack floor decays toward suicideOdds —
    // which is absolute — as the deadline closes.
    const press = Math.min(1, front.day / Math.max(1, this.deadlineDay));
    const attackFloor = Math.max(this.doctrine.suicideOdds, this.doctrine.attackOdds - this.doctrine.deadlinePressure * press);

    const orders: PlannerReport['orders'] = [];
    let viableSeen = false;
    let attackConsidered = false;

    const threatAt = (pos: NetPos): number =>
      intel
        .contacts()
        .filter((c) => graphGap(t, pos, c.pos) <= THREAT_M)
        .reduce((a, c) => a + c.strength, 0);
    // The withdraw test, asked of a march BEFORE it is ordered: nominal
    // minutes to `dest`, or null when there is no route or the force would be
    // overwhelmed somewhere along it. Without this the arms disagreed: one
    // marched a force at an enemy the withdraw arm then turned it away from,
    // every eval, and a withdrawal picked its rear node by id and could route
    // THROUGH the enemy it was fleeing (jtbug #762: blue destroyed on 5 of 16
    // pin seeds, up to 86 mid-march reversals in one war).
    const safeMarchMin = (f: Force, dest: number): number | null => {
      const march = planMove(front, f, dest);
      if (!march) return null;
      const limit = this.doctrine.withdrawRatio * effStrength(f);
      if (pathNodes(t, march.pos, march.path).some((n) => threatAt({ kind: 'node', nodeId: n }) > limit)) return null;
      // An enemy standing mid-road, further than THREAT_M from both ends, is
      // invisible from the nodes: count what stands on each road of the march
      // (on the force's own road, only what lies ahead of it).
      const from = march.pos;
      const blocked = march.path.some((eid, i) => {
        let on = 0;
        for (const c of intel.contacts()) {
          if (c.pos.kind !== 'edge' || c.pos.edgeId !== eid) continue;
          if (i === 0 && from.kind === 'edge' && (c.pos.s - from.s) * from.dir < 0) continue;
          on += c.strength;
        }
        return on > limit;
      });
      return blocked ? null : march.nominalMin;
    };

    const defendersNear = (site: NetPos): number =>
      intel
        .contacts()
        .filter((c) => graphGap(t, site, c.pos) <= CONTACT_M)
        .reduce((a, c) => a + holds(c), 0);
    const undugNear = (site: NetPos): number =>
      intel
        .contacts()
        .filter((c) => graphGap(t, site, c.pos) <= CONTACT_M)
        .reduce((a, c) => a + c.strength, 0);
    // The first place a march to `dest` meets the enemy: an enemy standing on
    // one of its roads, or a defended node on the path (`via` is the road the
    // march enters that node by, which is what makes a crossing an assault).
    // Null when the way is open as far as intel knows.
    const firstFight = (f: Force, dest: number): { site: NetPos; defEff: number; defRaw: number; via?: number } | null => {
      const march = planMove(front, f, dest);
      if (!march) return null;
      const nodes = pathNodes(t, march.pos, march.path);
      for (let i = 0; i < march.path.length; i++) {
        const own = i === 0 && march.pos.kind === 'edge' ? march.pos : null;
        const onRoad = intel
          .contacts()
          .filter((c) => c.pos.kind === 'edge' && c.pos.edgeId === march.path[i] && (!own || (c.pos.s - own.s) * own.dir >= 0))
          .sort((p, q) => p.forceId - q.forceId)[0];
        if (onRoad) return { site: onRoad.pos, defEff: defendersNear(onRoad.pos), defRaw: undugNear(onRoad.pos) };
        const node: NetPos = { kind: 'node', nodeId: nodes[i] };
        const at = defendersNear(node);
        if (at > 0) return { site: node, defEff: at, defRaw: undugNear(node), via: march.path[i] };
      }
      return null;
    };

    const order = (f: Force, dest: number, why: string): boolean => {
      const r = orderMove(front, f.id, dest);
      if (r.ok) {
        orders.push({ forceId: f.id, dest, why });
        setPosture(front, f.id, URGENT.has(why) ? 'forced' : 'march');
      }
      return r.ok;
    };
    const reorganising = (g: Force): boolean => g.repulsedAtMin !== null && front.clockMin - g.repulsedAtMin < REORG_MIN;
    const siteMult = (site: NetPos, approachEdgeId?: number): number => siteDefence(t, site, approachEdgeId).mult;

    // Sortie: an enemy next door to a garrison's post (on a road out of it,
    // or at that road's far node), when the garrison should beat everything
    // next door put together. Returns the node to march on: the weakest
    // enemy's, lowest id on a tie.
    const prey = (f: Force, home: number): number | null => {
      const near = new Map<number, { strength: number; pos: NetPos; dest: number; via: number }>();
      for (const e of incidentFoot(t, home)) {
        const far = otherEnd(e, home);
        if (t.nodes[far].kind === 'ford') continue;
        for (const c of intel.contacts()) {
          if (!near.has(c.forceId) && (c.pos.kind === 'edge' ? c.pos.edgeId === e.id : c.pos.nodeId === far)) near.set(c.forceId, { strength: holds(c), pos: c.pos, dest: far, via: e.id });
        }
      }
      const [c] = [...near.entries()].sort((p, q) => p[1].strength - q[1].strength || p[0] - q[0]).map((x) => x[1]);
      if (!c) return null;
      // The post is left open for the length of the sortie. Stay in when
      // another enemy is near enough to walk in meanwhile.
      const walkIn = intel.contacts().some((o) => !near.has(o.forceId) && (route(t, anchorNode(t, o.pos), home)?.minutes ?? Infinity) <= SORTIE_COVER_MIN);
      if (walkIn) return null;
      const all = [...near.values()].reduce((a, x) => a + x.strength, 0);
      const mult = siteMult(c.pos, c.pos.kind === 'node' ? c.via : undefined);
      return coarseOdds(effStrength(f), all, mult) >= SORTIE_ODDS ? c.dest : null;
    };

    // Open ground worth taking, best first: a node whose capture RELIEVES a
    // cut-off friendly force, then one that CUTS an enemy force off, then the
    // nearest open node (a PROBE). Only undefended nodes reached by a safe
    // march with no fight on the way. The enemy's depots are off the table.
    const mine = traceSupply(front, this.side).traced;
    const stranded = own.filter((g) => !posSupplied(t, g.pos, mine));
    let fed: ReturnType<IntelView['contacts']> | null = null;
    const raid = (f: Force, reliefOnly = false): { dest: number; why: 'relieve' | 'cut' | 'probe' } | null => {
      if (reliefOnly && stranded.length === 0) return null;
      if (f.fatigue >= RAID_REST_FATIGUE) return null;
      if (!fed) {
        const theirs = traceSupply(front, enemy).traced;
        fed = intel.contacts().filter((c) => posSupplied(t, c.pos, theirs));
      }
      let best: { dest: number; rank: number; gain: number; cost: number } | null = null;
      for (const n of t.nodes) {
        if (intel.control(n.id) === this.side || n.kind === 'ford' || t.sources[enemy].includes(n.id)) continue;
        if (threatAt({ kind: 'node', nodeId: n.id }) > 0) continue;
        const min = safeMarchMin(f, n.id);
        if (min === null || firstFight(f, n.id)) continue;
        let rank = 2;
        let gain = 0;
        if (stranded.length > 0 && intel.control(n.id) === enemy) {
          const opened = traceSupply(front, this.side, { open: n.id }).traced;
          gain = stranded.filter((g) => posSupplied(t, g.pos, opened)).length;
          if (gain > 0) rank = 0;
        }
        if (rank === 2 && reliefOnly) continue;
        if (rank === 2) {
          const closed = traceSupply(front, enemy, { block: n.id }).traced;
          gain = fed.filter((c) => !posSupplied(t, c.pos, closed)).length;
          if (gain > 0) rank = 1;
        }
        if (!best || rank < best.rank || (rank === best.rank && (gain > best.gain || (gain === best.gain && min < best.cost)))) {
          best = { dest: n.id, rank, gain, cost: min };
        }
      }
      return best && { dest: best.dest, why: (['relieve', 'cut', 'probe'] as const)[best.rank] };
    };

    const massOf = (ids: number[]): Force[] => own.filter((g) => ids.includes(g.id));
    const overwhelmed = (g: Force): boolean => threatAt(g.pos) > this.doctrine.withdrawRatio * effStrength(g);

    // The attack decision for `f` marching on `dest`, as one of the mass
    // `ids`, wanting odds of `floor`. It is taken on the FIRST fight the march
    // would have, which is not always at `dest`: an advance on an open
    // objective used to walk through a defended town on the way with no
    // decision at all (64 of 369 battles in the 16 pin wars opened that way).
    //   open  no fight on the way
    //   go    attack now
    //   wait  the attack is on, and `f` stands until the mass has closed up
    //         or its arrival falls in daylight
    //   no    not on: unsafe march, reorganising, or the odds are short
    type Call = 'open' | 'go' | 'wait' | 'no';
    const assault = (f: Force, dest: number, ids: number[], floor: number): Call => {
      const lead = safeMarchMin(f, dest);
      if (lead === null) return 'no';
      const fight = firstFight(f, dest);
      if (!fight) return 'open';
      if (reorganising(f)) return 'no';
      // The decision weighs the MASS: a company goes because the mass it
      // belongs to clears the floor, and the join machinery stacks them at
      // the site.
      const mass = massOf(ids);
      const ownEff = Math.max(mass.reduce((a, g) => a + effStrength(g), 0), effStrength(f));
      // Never attack INTO a walkover for the defender (the resolver's test).
      const mult = siteMult(fight.site, fight.via);
      if (walkover(ownEff, fight.defRaw, fight.defEff) === 'defender') return 'no';
      if (coarseOdds(ownEff, fight.defEff, mult) < floor) return 'no';
      // Time on target: a force that would arrive well before the rest of the
      // mass waits for it.
      const closing = mass.some((g) => {
        if (g.id === f.id || g.engagedIn !== null || reorganising(g)) return false;
        const theirs = safeMarchMin(g, dest);
        return theirs !== null && theirs > lead + MASS_SYNC_MIN;
      });
      if (closing) return 'wait';
      // Dawn doctrine (S52): under night tempo an assault steps off only when
      // its ARRIVAL falls in light. The eta runs the SAME shadow kernel over
      // the path orderMove would set, so the decision and the march cannot
      // disagree. An open march goes at any hour.
      if (this.opts.nightTempo) {
        const prospective = planMove(front, f, dest);
        if (prospective && lightAt(front.clockMin + forceEtaMinutes(front, { ...f, ...prospective }, dest, { nightTempo: true })) < 0.25) return 'wait';
      }
      return 'go';
    };

    // What a force's axis asks of it this hour. 'here' = it holds the
    // objective. Null = it has no axis (a reserve, or nothing is lost).
    const axisCalls = new Map<number, Call | 'here' | null>();
    const axisOf = (f: Force): Axis | undefined => (plan.reserveIds.includes(f.id) ? undefined : (plan.axes.find((ax) => ax.assigned.includes(f.id)) ?? plan.axes[0]));
    const axisCall = (f: Force): Call | 'here' | null => {
      const memo = axisCalls.get(f.id);
      if (memo !== undefined) return memo;
      const axis = axisOf(f);
      let call: Call | 'here' | null = null;
      if (axis) {
        const target = axis.objective;
        if (f.pos.kind === 'node' && f.pos.nodeId === target) call = 'here';
        else {
          call = assault(f, target, axis.assigned, attackFloor);
          if (call === 'no') {
            // The reserve is held back from an attack that works without it,
            // and called in for one that fails alone: it joins the axis for
            // the rest of this plan.
            const called = massOf(plan.reserveIds).filter((g) => g.engagedIn === null && !reorganising(g) && safeMarchMin(g, target) !== null).map((g) => g.id);
            const massed = called.length > 0 ? assault(f, target, [...axis.assigned, ...called], attackFloor) : 'no';
            if (massed !== 'no') {
              plan.reserveIds = plan.reserveIds.filter((id) => !called.includes(id));
              axis.assigned.push(...called);
              call = massed;
            }
          }
          if (call !== 'open') attackConsidered = true;
          if (call === 'go' || call === 'wait') viableSeen = true;
        }
      }
      axisCalls.set(f.id, call);
      return call;
    };

    // Hunt: the nearest enemy that the free mobile forces should clearly
    // beat, and the smallest group of them that does it. One decision for the
    // side, so the hunters agree on the quarry. A beaten company that stays
    // within reach is finished off.
    let quarry: { dest: number; ids: number[] } | null | undefined;
    const hunt = (): { dest: number; ids: number[] } | null => {
      if (quarry !== undefined) return quarry;
      quarry = null;
      const free = own.filter((g) => g.role !== 'garrison' && g.engagedIn === null && g.queuedAt === null && !overwhelmed(g) && !reorganising(g) && [null, 'no'].includes(axisCall(g)));
      let best: { dest: number; ids: number[]; cost: number } | null = null;
      for (const c of intel.contacts()) {
        const defEff = defendersNear(c.pos);
        const ends = c.pos.kind === 'node' ? [c.pos.nodeId] : [t.edges[c.pos.edgeId].a, t.edges[c.pos.edgeId].b];
        // A counterattack, not a pursuit: only an enemy at one of our nodes or
        // on a road out of one. Across the line it is left alone.
        if (!ends.some((n) => intel.control(n) === this.side)) continue;
        for (const dest of ends) {
          if (t.nodes[dest].kind === 'ford') continue;
          const reach = free
            .map((g) => ({ g, min: firstFight(g, dest) ? safeMarchMin(g, dest) : null }))
            .filter((r): r is { g: Force; min: number } => r.min !== null)
            .sort((p, q) => p.min - q.min || p.g.id - q.g.id);
          let eff = 0;
          const ids: number[] = [];
          for (const r of reach) {
            ids.push(r.g.id);
            eff += effStrength(r.g);
            if (coarseOdds(eff, defEff, siteMult(c.pos)) < SORTIE_ODDS) continue;
            if (!best || r.min < best.cost || (r.min === best.cost && dest < best.dest)) best = { dest, ids: [...ids], cost: r.min };
            break;
          }
        }
      }
      return (quarry = best && { dest: best.dest, ids: best.ids });
    };

    for (const f of own) {
      if (f.engagedIn !== null || f.queuedAt !== null) continue;
      // A march, once ordered, is finished: the ladder below is asked only of
      // a force that stands. The one exception is the withdraw arm. Without
      // this a force turned round mid-road each time two arms traded places
      // (attack on, attack off: up to 40 turn-rounds in one war).
      const marching = f.path.length > 0;
      if (f.role === 'garrison') {
        if (f.homeNode === null || marching) continue;
        const dest = reorganising(f) ? null : prey(f, f.homeNode);
        if (dest !== null) order(f, dest, 'sortie');
        // Home again once the way is open: never a fight to get there.
        else if (!(f.pos.kind === 'node' && f.pos.nodeId === f.homeNode) && safeMarchMin(f, f.homeNode) !== null && !firstFight(f, f.homeNode)) order(f, f.homeNode, 'return');
        continue;
      }

      // Withdraw arm: local enemies overwhelm. Fall back on the NEAREST
      // friendly node that is clear of the enemy and can be reached clear.
      if (overwhelmed(f)) {
        const rear = t.nodes
          .filter((n) => intel.control(n.id) === this.side && threatAt({ kind: 'node', nodeId: n.id }) === 0)
          .map((n) => ({ id: n.id, min: safeMarchMin(f, n.id) }))
          .filter((x): x is { id: number; min: number } => x.min !== null)
          .sort((a, b) => a.min - b.min || a.id - b.id);
        for (const n of rear) if (order(f, n.id, 'withdraw')) break;
        continue;
      }
      if (marching) continue;

      // A cut-off comrade is relieved before anything else.
      const openGround = (reliefOnly = false): boolean => {
        const r = raid(f, reliefOnly);
        return r !== null && order(f, r.dest, r.why);
      };
      if (openGround(true)) continue;

      const reserve = plan.reserveIds.includes(f.id);
      if (reserve) {
        // A reserve answers a friendly battle going bad. The enemy side of
        // the ledger reads CONTACTS, never truth — an engaged enemy is a
        // contact at gap 0, so under fog the sweep has seen it; under
        // omniscience the values are identical (§4.3).
        const losing = [...front.battles]
          .sort((p, q) => p.id - q.id)
          .find((b) => {
            const ids = [b.attackerId, b.defenderId, ...b.joined];
            const mine = massOf(ids);
            const theirsEff = intel
              .contacts()
              .filter((c) => ids.includes(c.forceId))
              .reduce((a, c) => a + c.strength, 0);
            return mine.length > 0 && mine.reduce((a, x) => a + effStrength(x), 0) < theirsEff && b.site.kind === 'node';
          });
        if (losing && losing.site.kind === 'node') {
          if (safeMarchMin(f, losing.site.nodeId) !== null) order(f, losing.site.nodeId, 'commit-reserve');
          continue;
        }
      }

      const call = axisCall(f);
      if (call === 'here' || call === 'wait') continue;
      if (call === 'open' || call === 'go') {
        order(f, axisOf(f)!.objective, call === 'go' ? 'attack' : 'advance');
        continue;
      }
      const q = hunt();
      if (q?.ids.includes(f.id)) {
        const c = assault(f, q.dest, q.ids, SORTIE_ODDS);
        if (c === 'go') order(f, q.dest, 'hunt');
        if (c === 'go' || c === 'wait') continue;
      }
      // Off the objective and nothing to fight: open ground. The reserve
      // stays where it can answer.
      if (!reserve) openGround();
    }

    // Postures for whoever stands. A garrison at its post and a force on its
    // objective dig in. A tired force with no enemy near rests.
    for (const f of own) {
      if (f.engagedIn !== null || f.path.length > 0) continue;
      const at = f.pos.kind === 'node' ? f.pos.nodeId : -1;
      const post = f.role === 'garrison' ? at === f.homeNode : at >= 0 && at === axisOf(f)?.objective;
      setPosture(front, f.id, post ? 'dig' : f.fatigue >= RAID_REST_FATIGUE && threatAt(f.pos) === 0 ? 'rest' : 'march');
    }

    if (orders.length > 0) return { orders, stall: null };
    if (plan.axes.length === 0) {
      const anyTarget = controlNodes(this.goals[this.side]).some((n) => intel.control(n) !== this.side);
      return { orders, stall: anyTarget ? 'no-reachable-objective' : 'goals-met-holding' };
    }
    return { orders, stall: attackConsidered && !viableSeen ? 'no-viable-attack' : null };
  }
}

// combatMult re-exported so integration reads ONE module for effective
// strength composition (§4.4).
export { combatMult };
