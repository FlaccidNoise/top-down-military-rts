// ── Movement & cover: the shared move-spot resolver ─────────────────────────
// docs/plans/2026-07-27-movement-cover-design.md §1. resolveMoveSpots is the
// ONE per-soldier destination resolver that both execution (moveSoldiersTo,
// task M2) and the preview overlay (task M4) call, so preview === execution
// is structural rather than aspirational.
//
// Contract:
// - PURE over the sim: reads map/soldiers/intel, never writes sim state,
//   draws ZERO rng (same contract as dangerSamples, orders.ts). The only
//   mutation is `used`, which the CALLER owns (one Set per team, keys
//   y * map.w + x) and the resolver fills as it hands out tiles so members
//   never stack.
// - Deterministic: tile iteration is findSpot's exact Chebyshev ring walk
//   (sim.ts findSpot — dy-major, strict-> keeps the first on ties), and the
//   threat-bearing intel inputs (spotted/contacts) only mutate on the 0.5 s
//   spotting sweep, so within a tick the output is stable (design §1.3).
// - The formation slot stays the anchor; cover-snap is a bounded correction
//   (r <= SNAP_R), never a re-plan. Where nothing scores above zero, the
//   resolver falls back to the legacy plain ring walk (first passable tile,
//   r <= 5), so open ground resolves byte-identical to today's findSpot on an
//   unfurnished map. This deliberately lifts garrisonScore's interiors-only
//   restriction (sim.ts, the I10 guard): generic terrain cover now moves
//   ordered formation spots — the "large behaviour change" done on purpose as
//   its own reviewed feature (design §2.3).

import { EDGE } from './map';
import type { OrderKind } from './orders';
import { eligible, fanOffsets, formationSlots, SQUAD_FAN, TEAM_FAN, type Sim, type Soldier, type Stance } from './sim';

export const SNAP_R = 3; // cover-snap ring bound (tiles) — the coherence cap (§1.2)
const FALLBACK_R = 5; // legacy findSpot reach (sim.ts findSpot, r <= 5)
const INTEL_RANGE = 100; // m — known contacts farther than this from the anchor do not steer the bearing (§1.3)

// Scorer weights (§1.2).
const W_DIR = 2.0; // directional cover against the threat bearing — the point of the feature
const W_NOOK = 1.0; // × nook()'s {0, 2} — window/breach firing position (garrisonScore's +2)
const W_TILE = 0.5; // on-tile cover body (woods 0.3 / furn_light 0.25 / hedge 0.35)
const SLOT_PENALTY = 0.15; // per Chebyshev tile of drift from the formation slot; ties break toward it
// A 1 m bank blocks a 0.4 m prone eye outright (the relief rule, sim.ts
// stance heights), so at prone it scores like a hedge lip; a crouching or
// standing man sees straight over it and gets no directional credit.
const BANK_PRONE_LIP = 0.5;

// ── Under-fire crawl-to-cover (design §2.2) ─────────────────────────────────
// These constants live HERE and not among sim.ts's suppression numbers
// (SUPP_DECAY, the pin thresholds) on purpose: those belong to the balance
// lane, and this behavior has to be retunable without reaching into them.
export const CRAWL_SUPP_THRESHOLD = 0.35; // the engine's existing "under effective fire" line (teamUnderFire, the shaken threshold)
export const CRAWL_R = 8; // tiles a stationary man will crawl to get out of the open
export const CRAWL_TICKS = 45; // 1.5 s trigger cadence, staggered by soldier id (the flee/rescue pattern)
// Distance does not gate the crawl — acceptance is sim.inCover, so ANY real
// cover in reach beats standing in the open — it only decides WHICH cover.
// At 0.03/tile a hedge lip (W_DIR x 0.5 = 1.0) is still worth the full 8 m,
// while a bare woods tile (W_TILE x 0.3 = 0.15) loses to one five tiles
// nearer. Ring order breaks exact ties toward the nearer tile.
const CRAWL_DIST_PENALTY = 0.03;
// A man who stops crawling is NOT prone: stanceOf puts a stationary
// suppressed man with a target at crouch, without one at stand, and only a
// PINNED man goes flat (and pinned men are excluded from the trigger — they
// cannot move). Scoring him prone would credit the 1 m bank lip his actual
// 1.1 m eye sees straight over.
const CRAWL_STANCE: Stance = 'crouch';

export interface SpotQuery {
  soldierIds: number[]; // pre-filtered by the ONE shared eligible() predicate (sim.ts)
  x: number; // team anchor (post-fan destination = orderTeam's order.x/y)
  y: number;
  facing?: number; // TeamOrder.facing (right-drag formation long axis)
  width?: number; // TeamOrder.width
  kind: OrderKind; // stance + threat-bearing policy
  arc?: [number, number]; // defend/ambush facing arc
  l?: number; // target floor level, 0-based (orderLevel below). Omitted = ground.
}

export interface ResolvedSpot {
  sid: number;
  x: number; // integer tile coords — feed pathTo/pendingPaths directly
  y: number;
  l: number; // floor level of the tile — astar's goal level, and what the preview labels
  covered: boolean; // the scorer's own judgment against the threat bearing (drives the green dot)
  snapped: boolean; // resolved tile differs from the naive slot tile (drives the slot→spot tail)
}

// The floor an order lands on, in ONE place: an explicit level (the floor menu)
// wins; defend and ambush otherwise garrison the TOP storey of the anchor tile;
// everything else is ground. sim.orderTeam and the order preview both call
// this, so preview === execution holds across floors as well as tiles — the
// preview used to draw ground-floor dots for an order the sim sent upstairs.
export function orderLevel(sim: Sim, kind: OrderKind, x: number, y: number, l?: number): number {
  if (l !== undefined) return l;
  if (kind !== 'defend' && kind !== 'ambush') return 0;
  const stories = sim.map.storiesAt(Math.floor(x), Math.floor(y));
  return stories >= 2 ? stories - 1 : 0;
}

// Threat bearing ladder (§1.3): intel first, travel last.
//
// The design's second rung was `q.facing`, on the reading that a right-drag
// "faced the line somewhere". It does not: facing is the long axis the
// rank-and-file grid SPREADS along (formationSlots, sim.ts) and main.ts fans
// squads by cos/sin of it. A line dragged east-west would have been scored as
// a threat due east, 90° off, on the most deliberate order in the game. The
// threat is perpendicular to a drawn line and facing cannot say which side, so
// the rung is gone: intel or the direction of advance answers it, and both
// know which way the men came from. (M3 audit; the only producer of
// TeamOrder.facing is the player right-drag in main.ts.)
export function threatBearing(sim: Sim, q: SpotQuery): number {
  // 1. defend/ambush arc — the player literally drew the threat direction.
  if (q.arc) return arcMidpoint(q.arc);
  // 2. nearest known contact of the ordering side within INTEL_RANGE of the
  //    anchor: spotted positions plus ghost contacts. NOT visibleEnemies —
  //    that is weapon-range-gated and blind during the approach march.
  const first = sim.soldiers[q.soldierIds[0]];
  if (!first) return 0;
  const side = first.side;
  let bx = 0;
  let by = 0;
  let bd = Infinity;
  for (const p of sim.spotted[side].values()) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) {
      bd = d;
      bx = p.x;
      by = p.y;
    }
  }
  for (const c of sim.contacts[side].values()) {
    const d = Math.hypot(c.x - q.x, c.y - q.y);
    if (d < bd) {
      bd = d;
      bx = c.x;
      by = c.y;
    }
  }
  if (bd <= INTEL_RANGE) return Math.atan2(by - q.y, bx - q.x);
  // 3. travel direction: team centroid → anchor (you default to covering the
  //    way you are advancing). Men told to dig in exactly where they stand
  //    used to give atan2(0, 0) = 0 — due east on no evidence; a degenerate
  //    move now falls to the side's threat axis (staging knows the attacker
  //    enters from the west long before any contact exists).
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const sid of q.soldierIds) {
    const s = sim.soldiers[sid];
    if (!s) continue;
    cx += s.x;
    cy += s.y;
    n++;
  }
  if (n === 0) return sim.threatAxis[side];
  const dx = q.x - cx / n;
  const dy = q.y - cy / n;
  if (Math.hypot(dx, dy) < 2) return sim.threatAxis[side];
  return Math.atan2(dy, dx);
}

// Midpoint of a counterclockwise arc [a0, a1] under inArc's convention
// (sim.ts inArc: span runs a0 → a1 in increasing normalized angle, wrapping).
function arcMidpoint(arc: [number, number]): number {
  const twoPi = 2 * Math.PI;
  const norm = (a: number) => ((a % twoPi) + twoPi) % twoPi;
  const a0 = norm(arc[0]);
  const span = norm(arc[1]) - a0;
  return norm(a0 + (span < 0 ? span + twoPi : span) / 2);
}

// Destination stance mirror of stanceOf's order branches (sim.ts): the
// resolver scores the posture the men will HOLD there, not the one they
// travel in.
function stanceForKind(kind: OrderKind): Stance {
  if (kind === 'ambush') return 'prone';
  if (kind === 'defend') return 'crouch';
  return 'stand';
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const ORTHO: { dx: number; dy: number; ang: number }[] = [
  { dx: 1, dy: 0, ang: 0 },
  { dx: -1, dy: 0, ang: Math.PI },
  { dx: 0, dy: 1, ang: Math.PI / 2 },
  { dx: 0, dy: -1, ang: -Math.PI / 2 },
];

// Directional cover: an orthogonal neighbor on the threat side contributes
// its coverBehind — reproducing los()'s lip rule (map.ts: the covering tile
// must sit between the man and the threat, crossed within 2 m of him).
//
// Deviation from the design text, on purpose: §1.2 writes |Δbearing| <= 90°,
// but a neighbor at 90° is ALONGSIDE the man, not between him and the threat.
// The lip is therefore projected onto the threat direction (× cos Δ), not
// counted whole inside a cone.
//
// M3 tried a hard cutoff just under 90° for this, and it only held when the
// bearing was EXACTLY axis-aligned. Along a N-S hedge run the two along-run
// hedge neighbors sit at 90° − Δ, so an enemy 0.2 m off the axis at 12 m
// (Δ = 0.017 rad) pulled them inside the cone and credited the hedge tile
// itself 2.0×0.5 + 0.5×0.35 − 0.30 = 0.875 over its true flank tile's 0.85 —
// men stood IN the hedge on every bearing except the one the fixture staged
// (measured: dy 0.1 m of enemy offset flips it). cos Δ makes the same
// neighbors worth ~0.009 instead of 0.5, and unlike a tighter cutoff it keeps
// working on a diagonal bearing, where both orthogonals legitimately count
// (0.707 each) and any hard cone would credit either both or neither.
function directionalCover(sim: Sim, x: number, y: number, bearing: number, stance: Stance): number {
  let best = 0;
  for (const o of ORTHO) {
    const off = Math.abs(angDiff(o.ang, bearing));
    if (off >= Math.PI / 2) continue;
    const facing = Math.cos(off);
    const nx = x + o.dx;
    const ny = y + o.dy;
    const lip = (sim.map.terrainAt(nx, ny).coverBehind ?? 0) * facing;
    if (lip > best) best = lip;
    if (stance === 'prone' && BANK_PRONE_LIP * facing > best && sim.map.inBounds(nx, ny) && sim.map.terrainKeyAt(nx, ny) === 'bank') {
      best = BANK_PRONE_LIP * facing;
    }
  }
  return best;
}

// garrisonScore's firing-position term (sim.ts): 2 for a nook, interiors only
// (buildingIdAt gate — a man under a window OUTSIDE the building is a target,
// not a garrison). BREACH counts alongside WINDOW: a blown hole grants lip
// cover the same way (map.ts los, BREACH_COVER).
function nook(sim: Sim, x: number, y: number): number {
  if (sim.map.buildingIdAt(x, y) < 0) return 0;
  const m = sim.map;
  const isNook = (e: number) => e === EDGE.WINDOW || e === EDGE.BREACH;
  return isNook(m.hEdge(x, y)) || isNook(m.hEdge(x, y + 1)) || isNook(m.vEdge(x, y)) || isNook(m.vEdge(x + 1, y)) ? 2 : 0;
}

// What a tile is WORTH as a firing position, threat bearing included. Shared
// by the ordered resolver and the under-fire crawl: they value a tile
// identically and differ only in what its distance costs — formation drift
// you must not accumulate vs. metres you must cross on your belly.
function coverValue(sim: Sim, x: number, y: number, bearing: number, stance: Stance): number {
  return W_DIR * directionalCover(sim, x, y, bearing, stance) + W_NOOK * nook(sim, x, y) + W_TILE * sim.map.terrainAt(x, y).cover;
}

function scoreTile(sim: Sim, x: number, y: number, distFromSlot: number, bearing: number, stance: Stance): number {
  return coverValue(sim, x, y, bearing, stance) - SLOT_PENALTY * distFromSlot;
}

// Truthful dot color: directional cover against the actual threat bearing, a
// nook, real on-tile cover (inCover's 0.2 line, sim.ts), or interior floor.
// Unlike sim.inCover this cannot paint the exposed side of a hedge green.
function isCovered(sim: Sim, x: number, y: number, bearing: number, stance: Stance): boolean {
  return (
    directionalCover(sim, x, y, bearing, stance) > 0 ||
    nook(sim, x, y) > 0 ||
    sim.map.terrainAt(x, y).cover > 0.2 ||
    sim.map.terrainKeyAt(x, y) === 'floor'
  );
}

// The best real cover a suppressed man in the open can crawl to, or null if
// there is none in reach — which is today's behavior (he stays and takes it).
//
// Acceptance is `sim.inCover`, deliberately the SAME predicate that gates the
// trigger in updateSoldier: arriving therefore falsifies the trigger and the
// man cannot oscillate between two tiles. It is also the predicate the rescue
// crawl already uses (findSpot's cover-seek sibling in sim.ts). The scorer
// only ranks the candidates, so a bad threat bearing can pick the wrong side
// of a hedge but can never send a man somewhere that is not cover.
//
// `blocked` is the caller's (sim.ts crawlBlocked): squadmates' tiles and the
// tiles they are already walking to. Soldiers do not collide in this sim, so
// without it a whole suppressed team converges on the one nearest hedge tile.
//
// Bearing note: this asks threatBearing with a single-soldier query anchored
// on the man himself, so rung 3 (travel direction, centroid → anchor)
// degenerates to atan2(0, 0) = due east. That only happens when his side
// knows of no contact within INTEL_RANGE — rare for a man under effective
// fire — and, per the acceptance rule above, costs at worst a preference for
// the east face of cover he was going to take anyway.
export function crawlCoverSpot(sim: Sim, s: Soldier, blocked: Set<number>): { x: number; y: number } | null {
  const bearing = threatBearing(sim, { soldierIds: [s.id], x: s.x, y: s.y, kind: 'move' });
  const map = sim.map;
  const sx = Math.floor(s.x);
  const sy = Math.floor(s.y);
  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (let r = 1; r <= CRAWL_R; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = sx + dx;
        const ny = sy + dy;
        if (!map.inBounds(nx, ny) || !map.terrainAt(nx, ny).passable) continue;
        if (blocked.has(ny * map.w + nx)) continue;
        if (!sim.inCover(nx + 0.5, ny + 0.5)) continue;
        const sc = coverValue(sim, nx, ny, bearing, CRAWL_STANCE) - CRAWL_DIST_PENALTY * r;
        if (sc > bestScore) {
          bestScore = sc;
          best = { x: nx, y: ny };
        }
      }
    }
  }
  return best;
}

// ── Deployment placement (deploy phase) ─────────────────────────────────────
// deployPlace (main.ts) and the deploy-phase preview (overlays.ts) both call
// this, so the warp lands on the tiles the ghost dots promised — the same
// preview === execution contract resolveMoveSpots gives ordered movement.
//
// Anchors clamp DEPLOY_EDGE_INSET inside the zone because the resolver may
// snap a spot up to FALLBACK_R tiles off a slot and slots reach ±2.2 m:
// 8 > 5 + 2.2, so every resolved tile stays in-zone by construction — the
// tutorial gate asserts exactly that.
export const DEPLOY_EDGE_INSET = 8;
const DEPLOY_ARC_HALF = Math.PI / 4;
// A team holds ONE posture, so the prone upgrade is a vote: lie down when at
// least 1/PRONE_SHARE_DEN of the team's spots gain by it. A third is the
// loosest share that still means "this team is on that feature" rather than
// "one man happens to be".
//
// Measured over 120 deployments, and the history matters because it is easy to
// draw the wrong conclusion from half of it: under the ORIGINAL narrow
// proneImproves (prone must beat crouch, true only on a bank lip) this constant
// was inert — 2 and 3 both gave 6/120 — which is what proved the detector and
// not the vote was the limiter. Against the current broad test it does decide:
// 2 → 86/120, 3 → 96/120, 4 → 96/120. So 3 is a real choice over 2, and 4 buys
// nothing. Roughly half of all teams vote unanimously either way (59/120), which
// is why the share only ever arbitrates the split remainder.
const PRONE_SHARE_DEN = 3;

export interface DeployTeamPlan {
  teamId: number;
  kind: OrderKind; // defend, upgraded to ambush where the ground pays prone
  x: number; // clamped team anchor — the order the team holds after the warp
  y: number;
  arc: [number, number];
  level: number;
  spots: ResolvedSpot[];
}

// A 1 m rise between a man and the threat hides a prone eye (0.4 m) and passes
// a crouching one (1.1 m) — the engine's own stance-discrimination height
// (sim.ts eye heights). That is the reverse slope, and it is ELEVATION, which
// directionalCover cannot see: it reads terrain cover, not the ground itself.
const PRONE_CREST = 1;
// How far back from the crest still counts as behind it. A man does not have
// to be against the slope to be in its defilade, and a formation spread over
// ±2 m would otherwise split a squad on one hillside into some prone and some
// not — the majority vote below then reads the whole team as standing.
const PRONE_CREST_REACH = 3;

// Is this a tile to lie down on? Anything real between the man and the enemy
// counts — a hedge, a wall lip, a bank, or a crest.
//
// The narrower rule this replaces asked whether prone scores BETTER than
// crouch, which only a bank lip and a crest do (a hedge covers you equally at
// either height). Measured over 120 deployments that fired for 5% of teams,
// and loosening the team vote from a half to a third moved it not at all —
// the vote was never the limiter, the test was. Men dug in behind a hedgerow
// are lying down, and that is the posture the player asked to see.
function proneImproves(sim: Sim, x: number, y: number, bearing: number): boolean {
  if (directionalCover(sim, x, y, bearing, 'prone') > 0) return true;
  const here = sim.map.elevAt(x, y);
  const dx = Math.cos(bearing);
  const dy = Math.sin(bearing);
  for (let r = 1; r <= PRONE_CREST_REACH; r++) {
    const nx = x + Math.round(dx * r);
    const ny = y + Math.round(dy * r);
    if (!sim.map.inBounds(nx, ny)) return false;
    if (sim.map.elevAt(nx, ny) - here >= PRONE_CREST) return true;
  }
  return false;
}

// Squads fan by SQUAD_FAN and teams by TEAM_FAN on the y axis — the exact
// anchor chain a plain-click battle order runs (issueShortClick → orderSquad),
// so deployment and the first move order read as one placement grammar. The
// deployment digs in facing `enemyBearing` (the attacker enters from the west,
// so the axis is known before a single contact exists), and each team's order
// kind comes from the ground it landed on: ambush (prone) where a majority of
// its spots gain from lying down, defend (crouch) otherwise.
export function resolveDeployment(
  sim: Sim,
  squadIds: number[],
  wx: number,
  wy: number,
  zone: { x0: number; x1: number },
  enemyBearing: number,
): DeployTeamPlan[] {
  const arc: [number, number] = [enemyBearing - DEPLOY_ARC_HALF, enemyBearing + DEPLOY_ARC_HALF];
  const lo = zone.x0 + DEPLOY_EDGE_INSET;
  const hi = zone.x1 - DEPLOY_EDGE_INSET;
  const ax = lo <= hi ? Math.max(lo, Math.min(hi, wx)) : (zone.x0 + zone.x1) / 2;
  const clampY = (y: number) => Math.max(DEPLOY_EDGE_INSET, Math.min(sim.map.h - DEPLOY_EDGE_INSET, y));
  // ONE used set for the whole placement: the fans put teams close together,
  // and a per-team set would let neighbours resolve onto the same tile.
  const used = new Set<number>();
  const out: DeployTeamPlan[] = [];
  const squadOffs = fanOffsets(squadIds.length, SQUAD_FAN);
  squadIds.forEach((squadId, qi) => {
    const squad = sim.squads[squadId];
    if (!squad) return;
    const teamOffs = fanOffsets(squad.teamIds.length, TEAM_FAN);
    squad.teamIds.forEach((teamId, ti) => {
      const team = sim.teams[teamId];
      if (!team) return;
      const ids = team.soldierIds.filter((id) => {
        const s = sim.soldiers[id];
        return eligible(s) && s.inVehicle < 0;
      });
      if (ids.length === 0) return;
      const ay = clampY(wy + squadOffs[qi] + teamOffs[ti]);
      const level = orderLevel(sim, 'defend', ax, ay);
      // Trial at ambush (prone scoring) FIRST: bank lips only score at prone
      // (BANK_PRONE_LIP), so a crouch-first trial would never snap to the one
      // terrain the prone upgrade exists for. Where a majority of the team's
      // spots gain from lying down, the ambush trial stands; otherwise the
      // team digs in at defend. The trial resolves against a COPY of `used`,
      // identical to `used` at this point, so a kept trial is exactly the
      // resolve it stands in for.
      const trial = resolveMoveSpots(sim, { soldierIds: ids, x: ax, y: ay, kind: 'ambush', arc, l: level }, new Set(used));
      const prone = trial.filter((sp) => proneImproves(sim, sp.x, sp.y, enemyBearing)).length;
      const kind: OrderKind = trial.length > 0 && prone * PRONE_SHARE_DEN >= trial.length ? 'ambush' : 'defend';
      const spots = kind === 'ambush' ? trial : resolveMoveSpots(sim, { soldierIds: ids, x: ax, y: ay, kind, arc, l: level }, new Set(used));
      for (const sp of spots) used.add(sp.y * sim.map.w + sp.x);
      out.push({ teamId, kind, x: ax, y: ay, arc, level, spots });
    });
  });
  return out;
}

// For each soldier: anchor = formation slot; scored cover-snap within
// r <= SNAP_R, and a firing position alone out to r <= FALLBACK_R (findSpot's
// garrison reach); accepted only when the best score is > 0, else the legacy
// plain ring walk; else the man is skipped (findSpot-null parity — the
// caller/UI surfaces it, design §3.4). A slot inside a building resolves
// inside one (M3).
export function resolveMoveSpots(sim: Sim, q: SpotQuery, used: Set<number>): ResolvedSpot[] {
  const out: ResolvedSpot[] = [];
  const n = q.soldierIds.length;
  if (n === 0) return out;
  const bearing = threatBearing(sim, q);
  const stance = stanceForKind(q.kind);
  const slots = formationSlots(n, q.facing, q.width);
  const map = sim.map;
  const level = q.l ?? 0;
  for (let i = 0; i < n; i++) {
    const [ox, oy] = slots[i];
    const sx = Math.floor(q.x + ox);
    const sy = Math.floor(q.y + oy);
    // A slot inside a building resolves inside one. The ring walk does not see
    // walls, so an unscored room centre otherwise loses to a hedge three tiles
    // away THROUGH the wall and the man told to hold the house ends up on the
    // grass outside it. findSpot could not do that — garrisonScore is 0
    // outside, so its max stayed on the slot. Only the last-resort plain tile
    // may leave, so a full house still places every man rather than dropping
    // one.
    const inside = map.buildingIdAt(sx, sy) >= 0;
    let best: { x: number; y: number } | null = null;
    let bestScore = 0; // snap only on a strictly positive score (§1.2)
    let plain: { x: number; y: number } | null = null;
    let plainOut: { x: number; y: number } | null = null;
    for (let r = 0; r <= FALLBACK_R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = sx + dx;
          const ny = sy + dy;
          if (!map.inBounds(nx, ny) || !map.terrainAt(nx, ny).passable) continue;
          if (used.has(ny * map.w + nx)) continue;
          // Upstairs, a tile only exists where the building HAS that storey.
          // Terrain and walls are one 2-D layer shared by every floor
          // (interiors D1), so the storey count is the only per-level fact
          // there is — and it is the one that matters: without it an upstairs
          // order resolves ground-floor tiles, and a man sent to the second
          // floor of a single-storey wing walks out the door and stands on
          // thin air. A slot with no storey in reach is refused instead, which
          // the caller and the preview already surface.
          if (level > 0 && map.storiesAt(nx, ny) <= level) continue;
          if (inside && map.buildingIdAt(nx, ny) < 0) {
            if (!plainOut) plainOut = { x: nx, y: ny };
            continue;
          }
          if (!plain) plain = { x: nx, y: ny };
          // Past SNAP_R only a firing position is worth breaking formation for.
          // That is findSpot's garrison reach exactly — it scored the whole
          // r <= 5 ring — and capping the nook at SNAP_R left an eighth of a
          // garrison in the room instead of at its windows (M3 audit).
          const sc = r <= SNAP_R ? scoreTile(sim, nx, ny, r, bearing, stance) : W_NOOK * nook(sim, nx, ny) - SLOT_PENALTY * r;
          if (sc > bestScore) {
            bestScore = sc;
            best = { x: nx, y: ny };
          }
        }
      }
    }
    const spot = best ?? plain ?? plainOut;
    if (!spot) continue;
    used.add(spot.y * map.w + spot.x);
    out.push({
      sid: q.soldierIds[i],
      x: spot.x,
      y: spot.y,
      l: level,
      covered: isCovered(sim, spot.x, spot.y, bearing, stance),
      snapped: spot.x !== sx || spot.y !== sy,
    });
  }
  return out;
}
