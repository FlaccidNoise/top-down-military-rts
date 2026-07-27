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
import { formationSlots, type Sim, type Stance } from './sim';

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

export interface SpotQuery {
  soldierIds: number[]; // pre-filtered by the ONE shared eligible() predicate (sim.ts)
  x: number; // team anchor (post-fan destination = orderTeam's order.x/y)
  y: number;
  facing?: number; // TeamOrder.facing (right-drag formation long axis)
  width?: number; // TeamOrder.width
  kind: OrderKind; // stance + threat-bearing policy
  arc?: [number, number]; // defend/ambush facing arc
}

export interface ResolvedSpot {
  sid: number;
  x: number; // integer tile coords — feed pathTo/pendingPaths directly
  y: number;
  covered: boolean; // the scorer's own judgment against the threat bearing (drives the green dot)
  snapped: boolean; // resolved tile differs from the naive slot tile (drives the slot→spot tail)
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
  //    give atan2(0, 0) = 0 — due east on no evidence at all. Deterministic
  //    and cheap, but it is a guess; see the M3 handoff.
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
  if (n === 0) return 0;
  return Math.atan2(q.y - cy / n, q.x - cx / n);
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

function scoreTile(sim: Sim, x: number, y: number, distFromSlot: number, bearing: number, stance: Stance): number {
  return (
    W_DIR * directionalCover(sim, x, y, bearing, stance) +
    W_NOOK * nook(sim, x, y) +
    W_TILE * sim.map.terrainAt(x, y).cover -
    SLOT_PENALTY * distFromSlot
  );
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
      covered: isCovered(sim, spot.x, spot.y, bearing, stance),
      snapped: spot.x !== sx || spot.y !== sy,
    });
  }
  return out;
}
