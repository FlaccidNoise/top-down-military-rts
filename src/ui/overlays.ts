import type { Camera } from '../render/camera';
import { MOBILE, view } from '../render/view';
import { dangerSamples, MOVE_FAMILY, orderVerdict, type OrderKind } from '../sim/orders';
import { eligible, fanOffsets, formationSlots, squadClumpOffsets, TEAM_FAN, SQUAD_FAN, type Side, type Sim, type UnitEvent } from '../sim/sim';
import { orderLevel, resolveDeployment, resolveMoveSpots, type ResolvedSpot } from '../sim/spots';
import { emplacementOf, TEAM } from './hud';
import type { ShotSolution } from './tooltip';

export interface OverlayState {
  shot: ShotSolution | null;
  selectedSquad: number; // the primary squad — commitOrder's team-narrowing target
  selectedTeam: number; // -1, or the one team a narrowed order will go to
  targetMode: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke' | 'breach';
  armedOrder: OrderKind | null;
  squadForce: boolean; // shift/add-mode: forces the whole squad even when a team is narrowed
  cursor: { x: number; y: number } | null; // world position — commitOrder's own order anchor
  selectedSquads: number[]
  selectRect: { x: number; y: number; w: number; h: number } | null
  formationDrag: { ax: number; ay: number; facing: number; width: number } | null
  // The floor the pending order carries, when the player has picked one (the
  // floor menu, open, hovering a row). null = no pick, so the level comes from
  // orderLevel — ground for a move, the top storey for defend/ambush.
  orderFloor?: number | null
  floorFocus?: number // -1 = all floors; else the storey F has focused (main.ts)
  // Deployment phase: preview and placement share resolveDeployment, so the
  // ghost dots promise the tiles the warp will use. bearing = the enemy
  // direction the deployment faces. null/undefined = battle.
  deploy?: { x0: number; x1: number; bearing: number } | null
  // The map clear of the HUD, in CSS px. Chips that follow a unit are kept
  // inside it, so one is never cut off by the screen edge or under the roster.
  clear?: { left: number; top: number; right: number; bottom: number }
  // Screen rectangles the ticker must stay out of: the tutorial's bubble and
  // the ring it points at, while a step is showing.
  avoid?: readonly ScreenRect[]
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the ticker's column goes: its top-left corner in px. It hangs from the
 * top of `x` (the right edge of the map) unless that puts it on one of
 * `avoid`. Then it drops to the first free place under one of them: every gap
 * the column fits in starts at `top` or under something, so those are all the
 * places a column has. A short screen may have none, and then the column moves
 * left, beside whatever is in its way, and at last to the map's left edge
 * (`left`). With nowhere free at all it stays where it started: a covered line
 * beats a lost one.
 */
export function dockFeed(x: number, w: number, h: number, top: number, bottom: number, left: number, avoid: readonly ScreenRect[]): { x: number; y: number } {
  const GAP = 6;
  const place = (cx: number): number | null => {
    const inWay = avoid.filter((r) => r.right + GAP > cx && r.left - GAP < cx + w);
    const free = (y: number): boolean => y + h <= bottom && inWay.every((r) => y >= r.bottom + GAP || y + h <= r.top - GAP);
    if (free(top)) return top;
    return inWay.map((r) => r.bottom + GAP).sort((a, b) => a - b).find(free) ?? null;
  };
  const columns = [x, ...avoid.map((r) => r.left - GAP - w).sort((a, b) => b - a), left].filter((cx) => cx >= left && cx <= x);
  for (const cx of columns) {
    const y = place(cx);
    if (y !== null) return { x: cx, y };
  }
  return { x, y: top };
}

function teamCentroid(sim: Sim, soldierIds: number[]): { x: number; y: number } | null {
  const alive = soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive && !s.downed);
  if (alive.length === 0) return null;
  return { x: alive.reduce((a, s) => a + s.x, 0) / alive.length, y: alive.reduce((a, s) => a + s.y, 0) / alive.length };
}

// The teams whose OrderState chips are drawn: the narrowed team, else every
// team of the primary squad (main.ts's old focusTeams field, derived here so
// the overlay owns one definition of "focus").
function focusTeams(sim: Sim, st: OverlayState): number[] {
  if (st.selectedSquad < 0) return [];
  if (st.selectedTeam >= 0) return [st.selectedTeam];
  return sim.squads[st.selectedSquad]?.teamIds ?? [];
}

export interface PreviewSpot extends ResolvedSpot {
  slotX: number; // the naive formation slot, world coords — the snap tail's tail
  slotY: number;
}

export interface PreviewTeam {
  teamId: number;
  x: number; // post-fan team anchor: the exact order.x/y orderTeam will receive
  y: number;
  level: number; // the floor this team's spots sit on — orderLevel of ITS anchor
  spots: PreviewSpot[];
  refused: { sid: number; slotX: number; slotY: number }[]; // no footing in reach — the sim drops these men silently
  danger: number | null; // focus teams under an armed order only (8 raycast samples/team)
  verdict: ChipVerdict | null;
}

export interface MovePreview {
  kind: OrderKind;
  teams: PreviewTeam[];
  placed: number;
  covered: number;
  refused: number;
  // Highest floor any team is being sent to, or null when floors are not part
  // of this order at all (every team on the ground and no explicit pick).
  level: number | null;
}

// The order preview, resolved through the SAME function execution runs
// (movement design §3.1). The fan chain below mirrors commitOrder →
// orderSquad → orderTeam → moveSoldiersTo call for call, so preview ===
// execution is structural: one resolver, one eligible() filter, one fresh
// `used` set per team in squad.teamIds order.
//
// Pure and rng-free (resolveMoveSpots' contract), so it is safe to call from
// the draw path and safe for the parity test to call directly.
export function previewMoveSpots(sim: Sim, st: OverlayState): MovePreview | null {
  if (st.targetMode || !st.cursor || st.selectedSquads.length === 0) return null;
  if (st.deploy) return previewDeploy(sim, st);
  // A non-formation armed kind (smoke, fire) moves nobody: there are no move
  // spots to promise, so no ghost dots. Refusal feedback comes from the team
  // order chip after the click (orderTeam sets a balked reason).
  if (st.armedOrder && !MOVE_FAMILY.includes(st.armedOrder)) return null;
  const useArmed = st.armedOrder !== null && MOVE_FAMILY.includes(st.armedOrder);
  const kind: OrderKind = useArmed ? st.armedOrder! : 'move';
  const drag = st.formationDrag;
  const K = st.selectedSquads.length;
  const squadOffs = drag ? fanOffsets(K, drag.width / K) : null;
  const clump = drag ? null : squadClumpOffsets(K); // issueShortClick's clump
  const cos = drag ? Math.cos(drag.facing) : 0;
  const sin = drag ? Math.sin(drag.facing) : 0;
  // ONE reservation set for the whole preview — the mirror of the one `used`
  // commitOrder threads through every orderSquad call of the commit.
  const used = new Set<number>();
  const teams: PreviewTeam[] = [];
  st.selectedSquads.forEach((squadId, si) => {
    const squad = sim.squads[squadId];
    if (!squad) return;
    const ax = drag ? drag.ax + cos * squadOffs![si] : st.cursor!.x + clump![si][0];
    const ay = drag ? drag.ay + sin * squadOffs![si] : st.cursor!.y + clump![si][1];
    // commitOrder narrows to the selected team only on a SHORT right-click of
    // the primary squad with no armed kind and no additive modifier; every
    // right-drag goes to orderSquad. Without this branch the preview shows
    // dots for teams that are not going to move.
    if (!drag && !useArmed && !st.squadForce && st.selectedTeam >= 0 && squadId === st.selectedSquad) {
      pushPreviewTeam(sim, st, teams, st.selectedTeam, ax, ay, kind, used);
      return;
    }
    const n = squad.teamIds.length;
    if (!drag) {
      const offs = fanOffsets(n, TEAM_FAN); // orderSquad's legacy y-axis fan
      squad.teamIds.forEach((tid, ti) => pushPreviewTeam(sim, st, teams, tid, ax, ay + offs[ti], kind, used));
    } else {
      const share = drag.width / K / n; // orderSquad's (order.width ?? n * TEAM_FAN) / n
      const offs = fanOffsets(n, share);
      squad.teamIds.forEach((tid, ti) =>
        pushPreviewTeam(sim, st, teams, tid, ax + cos * offs[ti], ay + sin * offs[ti], kind, used, drag.facing, share),
      );
    }
  });
  if (teams.length === 0) return null;
  const { placed, covered, refused, top } = summarize(teams);
  // An explicit pick is worth reporting even when it is the ground floor: the
  // player chose it off the floor menu and the chip must confirm the choice.
  const level = top > 0 || st.orderFloor != null ? top : null;
  return { kind, teams, placed, covered, refused, level };
}

// The chip's counts, over whichever teams the preview assembled — the ordered
// path and the deployment path answer the same four questions.
function summarize(teams: PreviewTeam[]): { placed: number; covered: number; refused: number; top: number } {
  let placed = 0;
  let covered = 0;
  let refused = 0;
  let top = 0;
  for (const t of teams) {
    placed += t.spots.length;
    refused += t.refused.length;
    top = Math.max(top, t.level);
    for (const sp of t.spots) if (sp.covered) covered++;
  }
  return { placed, covered, refused, top };
}

// Deploy-phase preview: the same resolveDeployment call deployPlace commits,
// adapted to PreviewTeam so the ghost dots, snap tails, refusal crosses and
// the chip all work unchanged. No danger/verdict — deployment never runs the
// compliance ladder — and whole squads always, deployPlace's own scope rule
// (the battle path's team-narrowing does not exist here). Emplacement squads
// are skipped exactly as deployPlace refuses them.
function previewDeploy(sim: Sim, st: OverlayState): MovePreview | null {
  const zone = st.deploy!;
  const c = st.cursor!;
  if (c.x < zone.x0 || c.x > zone.x1) return null; // outside the strip: deployPlace refuses, nothing to promise
  const squadIds = st.selectedSquads.filter((id) => !emplacementOf(sim, id));
  const plans = resolveDeployment(sim, squadIds, c.x, c.y, zone, zone.bearing);
  const teams: PreviewTeam[] = [];
  let ambush = false;
  for (const p of plans) {
    const team = sim.teams[p.teamId];
    if (!team) continue;
    const ids = team.soldierIds.filter((id) => {
      const s = sim.soldiers[id];
      return eligible(s) && s.inVehicle < 0;
    });
    const slots = formationSlots(ids.length);
    const placed = new Map(p.spots.map((sp) => [sp.sid, sp]));
    const mine: PreviewSpot[] = [];
    const refused: PreviewTeam['refused'] = [];
    ids.forEach((sid, i) => {
      const slotX = p.x + slots[i][0];
      const slotY = p.y + slots[i][1];
      const sp = placed.get(sid);
      if (sp) mine.push({ ...sp, slotX, slotY });
      else refused.push({ sid, slotX, slotY });
    });
    if (p.kind === 'ambush') ambush = true;
    teams.push({ teamId: p.teamId, x: p.x, y: p.y, level: p.level, spots: mine, refused, danger: null, verdict: null });
  }
  if (teams.length === 0) return null;
  const { placed, covered, refused, top } = summarize(teams);
  return { kind: ambush ? 'ambush' : 'defend', teams, placed, covered, refused, level: top > 0 ? top : null };
}

function pushPreviewTeam(
  sim: Sim,
  st: OverlayState,
  out: PreviewTeam[],
  teamId: number,
  x: number,
  y: number,
  kind: OrderKind,
  used: Set<number>,
  facing?: number,
  width?: number,
): void {
  const team = sim.teams[teamId];
  if (!team) return;
  const ids = team.soldierIds.filter((id) => eligible(sim.soldiers[id]));
  if (ids.length === 0) return; // orderTeam's own early return
  // Per TEAM anchor, exactly as orderTeam derives it after orderSquad's fan: a
  // squad straddling a tall building and a low one garrisons two storeys, and
  // the preview has to say so.
  const level = orderLevel(sim, kind, x, y, st.orderFloor ?? undefined);
  const spots = resolveMoveSpots(sim, { soldierIds: ids, x, y, facing, width, kind, l: level }, used);
  const slots = formationSlots(ids.length, facing, width);
  const placed = new Map(spots.map((sp) => [sp.sid, sp]));
  const mine: PreviewSpot[] = [];
  const refused: PreviewTeam['refused'] = [];
  ids.forEach((sid, i) => {
    const slotX = x + slots[i][0];
    const slotY = y + slots[i][1];
    const sp = placed.get(sid);
    if (sp) mine.push({ ...sp, slotX, slotY });
    else refused.push({ sid, slotX, slotY });
  });
  // The refusal model only matters where it is drawn: the armed-order chip
  // covers the focus teams, and dangerScore is 8 LOS raycasts per visible
  // enemy per team — too costly to run for every team of a select-all.
  const focus = st.selectedTeam >= 0 ? teamId === st.selectedTeam : team.squadId === st.selectedSquad;
  let danger: number | null = null;
  let verdict: ChipVerdict | null = null;
  if (st.armedOrder && focus) {
    // The executor's own verdict, charge multiplier and stay-in-place rule
    // included: the old chip re-derived it and under-reported assault refusal.
    ({ danger, verdict } = orderVerdict(sim, team, { kind, x, y }));
  }
  out.push({ teamId, x, y, level, spots: mine, refused, danger, verdict });
}

// Same-tick memo (design §3.3). The resolver is ~50k array reads for a
// select-all company, which is fine once per changed input but not on every
// frame of a still cursor. Keyed per sim so two sims in one process cannot
// share an entry. The cursor is keyed EXACTLY, not floored to the tile the
// design suggested: the slot floor inside the resolver is sub-tile sensitive
// (anchor 12.9 + slot 0.5 lands in tile 13, anchor 12.1 + 0.5 in tile 12), so
// a tile-quantized key would serve dots from a different sub-tile position
// than the order will use — the exact class of lie this milestone removes.
const previewMemo = new WeakMap<Sim, { key: string; val: MovePreview | null }>();

function movePreview(sim: Sim, st: OverlayState): MovePreview | null {
  if (st.targetMode || !st.cursor || st.selectedSquads.length === 0) return null;
  const d = st.formationDrag;
  const key = `${sim.tick}|${st.selectedSquads.join(',')}|${st.selectedSquad}|${st.selectedTeam}|${st.squadForce}|${st.armedOrder}|${st.orderFloor}|${st.cursor.x},${st.cursor.y}|${d ? `${d.ax},${d.ay},${d.facing},${d.width}` : ''}|${st.deploy ? `${st.deploy.x0},${st.deploy.x1},${st.deploy.bearing}` : ''}`;
  const hit = previewMemo.get(sim);
  if (hit && hit.key === key) return hit.val;
  const val = previewMoveSpots(sim, st);
  previewMemo.set(sim, { key, val });
  return val;
}

// ── Storey indicator ────────────────────────────────────────────────────────
// "How many floors has this house got" answered without clicking anything. A
// FLAT stack of ticks on the roof — one tick per storey, ground at the bottom
// — never a projected elevation: the game is strict plan view (art rules), so
// height is expressed as a count, the way a map symbol does it.
//
// Only multi-storey buildings get one (a single tick everywhere is noise), and
// only from BADGE_SCALE up, which is the same zoom the renderer starts drawing
// its per-soldier floor badge at — below it the tick pitch is under a pixel.
// Measured, not guessed: at 0.72 alpha over a slate roof the first version of
// this glyph composited to rgb(106,105,94) against a rgb(93,98,106) roof — a
// 10-value difference, i.e. invisible. The backing is now the same opaque ink
// the order chips and the soldier floor badge use, and the ticks are drawn at
// full alpha.
const BADGE_SCALE = 14; // px/m — matches renderer.ts's soldier floor badge
const TICK_W = 9;
const TICK_H = 2;
const TICK_PITCH = 4;
const BADGE_PAD = 3;

// storiesAt is per TILE; a building's storey count is the max over its
// footprint (roofs.ts derives its shadow height the same way). Keyed on the
// buildings array identity, which is a new battle — the count itself never
// changes mid-battle, breaches and holes included.
const storeyMemo = new WeakMap<Sim, { of: unknown; stories: number[] }>();
function buildingStoreys(sim: Sim): number[] {
  const hit = storeyMemo.get(sim);
  if (hit && hit.of === sim.buildings) return hit.stories;
  const stories = sim.buildings.map((b) => {
    let m = 0;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) m = Math.max(m, sim.map.storiesAt(x, y));
    return m;
  });
  storeyMemo.set(sim, { of: sim.buildings, stories });
  return stories;
}

// Which storey of which building the pending order is aiming at, so the badge
// can light that tick: the target floor reads off the BUILDING even where the
// dots themselves are hidden under a roof.
function previewTargets(sim: Sim, preview: MovePreview | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!preview) return out;
  for (const t of preview.teams) {
    if (t.level <= 0) continue;
    for (const sp of t.spots) {
      const bid = sim.map.buildingIdAt(sp.x, sp.y);
      if (bid >= 0) out.set(bid, Math.max(out.get(bid) ?? 0, t.level));
    }
  }
  return out;
}

function drawStoreyBadges(ctx: CanvasRenderingContext2D, cam: Camera, sim: Sim, st: OverlayState, preview: MovePreview | null): void {
  if (cam.scale < BADGE_SCALE || sim.buildings.length === 0) return;
  const cw = view.w;
  const ch = view.h;
  const stories = buildingStoreys(sim);
  const targets = previewTargets(sim, preview);
  const focus = st.floorFocus ?? -1;
  const k = Math.min(2, Math.max(1, cam.scale / 22)); // grows with the zoom, like the soldier badge's font
  const tw = Math.round(TICK_W * k);
  const th = Math.max(2, Math.round(TICK_H * k));
  const pitch = Math.round(TICK_PITCH * k);
  const pad = Math.round(BADGE_PAD * k);
  const w = tw + pad * 2;
  sim.buildings.forEach((b, i) => {
    const n = stories[i];
    if (n < 2) return; // a one-storey house has nothing to tell the player
    const [sx, sy] = cam.worldToScreen(b.x + b.w / 2, b.y + b.h / 2, cw, ch);
    const h = n * pitch + pad;
    if (sx < -w || sy < -h || sx > cw + w || sy > ch + h) return;
    const x = Math.round(sx - w / 2);
    const y = Math.round(sy - h / 2);
    const target = targets.get(sim.map.buildingIdAt(b.x + (b.w >> 1), b.y + (b.h >> 1))) ?? -1;
    ctx.fillStyle = 'rgba(18,22,15,0.9)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(74,82,64,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    for (let lv = 0; lv < n; lv++) {
      // Ground at the bottom tick, so the stack reads the way the building
      // stands even though nothing here is drawn in elevation.
      const ty = y + h - pad / 2 - (lv + 1) * pitch + (pitch - th);
      ctx.fillStyle = lv === target ? '#ffca6a' : lv === focus ? '#e8e4d8' : CHIP_MUTED;
      ctx.fillRect(x + pad, Math.round(ty), tw, th);
    }
  });
}

function worseVerdict(a: ChipVerdict, b: ChipVerdict): ChipVerdict {
  if (a === 'balk' || b === 'balk') return 'balk';
  if (a === 'cautious' || b === 'cautious') return 'cautious';
  return 'comply';
}

// World-anchored order feedback, drawn on the canvas after the scene.
export function drawOverlays(ctx: CanvasRenderingContext2D, cam: Camera, sim: Sim, st: OverlayState, pings: EventPings): void {
  const cw = view.w;
  const ch = view.h;

  // Selection rectangle (screen-space, normalized so w/h always positive).
  if (st.selectRect) {
    const rr = st.selectRect;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,202,106,0.7)';
    ctx.strokeRect(rr.x, rr.y, rr.w, rr.h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,202,106,0.08)';
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
  }

  // Route preview for selected squads: current leg, then queued waypoints.
  if (st.selectedSquads.length > 0) {
    for (const squadId of st.selectedSquads) {
    const sq = sim.squads[squadId];
    const dest = sim.squadDest[squadId];
    const queue = sim.squadWaypoints[squadId] ?? [];
    if (sq && dest) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const sid of sq.soldierIds) {
        const s = sim.soldiers[sid];
        if (!s.alive || s.downed) continue;
        cx += s.x;
        cy += s.y;
        n++;
      }
      if (n > 0) {
        const pts = [{ x: cx / n, y: cy / n }, dest, ...queue];
        ctx.beginPath();
        pts.forEach((p, i) => {
          const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.setLineDash([5, 5]);
        // dark halo pass first so the dashed line reads on light terrain (roads, sand), then the amber line on top
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(12,14,10,0.5)';
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,202,106,0.7)';
        ctx.stroke();
        ctx.setLineDash([]);
        pts.slice(1).forEach((p, i) => {
          const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
          ctx.fillStyle = i === 0 ? 'rgba(255,202,106,0.9)' : 'rgba(255,202,106,0.6)';
          ctx.beginPath();
          ctx.arc(sx, sy, i === 0 ? 4 : 6, 0, Math.PI * 2);
          ctx.fill();
          if (i > 0) {
            ctx.fillStyle = '#12160f';
            ctx.font = '8px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), sx, sy);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
          }
        });
      }
    }
    }
  }

  // Move-order preview: ghost dots on the tiles resolveMoveSpots hands the
  // sim, not on naive formation slots. A dot that moved off its slot draws a
  // tail back to it so the snap is visible, and a man the resolver could not
  // place at all gets a refusal cross ON his slot — the silent drop
  // (moveSoldiersTo skips him) is now a preview-time failure state.
  const preview = movePreview(sim, st);
  drawStoreyBadges(ctx, cam, sim, st, preview);
  if (preview) {
    const r = Math.max(2.5, cam.scale * 0.18);
    for (const t of preview.teams) {
      const balked = t.verdict === 'balk'; // this team is not going anywhere; do not paint it green
      for (const sp of t.spots) {
        // Tile centre, which is exactly the waypoint pathTo builds (x + 0.5).
        const [sx, sy] = cam.worldToScreen(sp.x + 0.5, sp.y + 0.5, cw, ch);
        if (sp.snapped) {
          const [lx, ly] = cam.worldToScreen(sp.slotX, sp.slotY, cw, ch);
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(sx, sy);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(232,228,216,0.35)';
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = balked ? 'rgba(208,92,80,0.35)' : sp.covered ? 'rgba(127,191,106,0.9)' : 'rgba(232,228,216,0.55)';
        ctx.fill();
        if (r > 3) {
          ctx.strokeStyle = balked ? 'rgba(208,92,80,0.9)' : 'rgba(18,22,15,0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      for (const rf of t.refused) {
        const [sx, sy] = cam.worldToScreen(rf.slotX, rf.slotY, cw, ch);
        const k = Math.max(3, r);
        ctx.strokeStyle = 'rgba(208,92,80,0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sx - k, sy - k);
        ctx.lineTo(sx + k, sy + k);
        ctx.moveTo(sx + k, sy - k);
        ctx.lineTo(sx - k, sy + k);
        ctx.stroke();
      }
    }
  }

  // Order-kind danger preview: while an order is armed, the same 8 points
  // dangerScore will sum over, colored green (safe) to red (0.2/point cap) —
  // the legibility contract: see the risk before you commit to the order.
  // Anchored on the preview's own post-fan team destinations, so the samples
  // track a formation drag instead of the legacy y-axis fan.
  if (preview && st.armedOrder) {
    for (const t of preview.teams) {
      if (t.danger === null) continue; // non-focus team: never scored, nothing to draw
      const team = sim.teams[t.teamId];
      for (const p of dangerSamples(sim, team, { x: t.x, y: t.y })) {
        const [sx, sy] = cam.worldToScreen(p.x, p.y, cw, ch);
        const tt = Math.min(1, p.score / 0.2);
        const cr = Math.round(127 + 128 * tt);
        const cg = Math.round(191 - 131 * tt);
        ctx.fillStyle = `rgb(${cr},${cg},60)`;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(2, cam.scale * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Order context chip: the preview's one-glance summary — how many of the men
  // actually land in cover, how many have no footing at all, ETA from the
  // slowest eligible soldier's own moveSpeed, and (armed only, where the
  // raycast cost is paid) the compliance verdict the team will run, as the
  // chip's colour. Static (no tick-driven animation): pause- and
  // reduced-motion-safe by construction.
  if (preview && st.cursor) {
    let verdict: ChipVerdict | null = null;
    let eta: number | null = null;
    for (const t of preview.teams) {
      if (t.verdict !== null) verdict = verdict === null ? t.verdict : worseVerdict(verdict, t.verdict);
      const team = sim.teams[t.teamId];
      const centroid = teamCentroid(sim, team.soldierIds);
      if (!centroid) continue;
      const members = team.soldierIds.map((id) => sim.soldiers[id]).filter((s) => eligible(s));
      const speed = members.length > 0 ? Math.min(...members.map((s) => sim.moveSpeed(s))) : 0;
      // A deployment is a warp — an ETA line would promise a march nobody makes.
      if (speed > 0.01 && !st.deploy) {
        const secs = Math.hypot(t.x - centroid.x, t.y - centroid.y) / speed;
        eta = eta === null ? secs : Math.max(eta, secs);
      }
    }
    const fmt = formatContextChip({ covered: preview.covered, placed: preview.placed, refused: preview.refused, eta, verdict, level: preview.level });
    const [sx, sy] = cam.worldToScreen(st.cursor.x, st.cursor.y, cw, ch);
    if (fmt.lines.length > 0) contextChip(ctx, sx, sy, cw, ch, fmt.lines, fmt.color, fmt.floorLine);
  }

  // Formation drag preview: anchor-to-cursor line + squad segment centers.
  if (st.formationDrag && st.cursor) {
    const [ax, ay] = cam.worldToScreen(st.formationDrag.ax, st.formationDrag.ay, cw, ch);
    const [cx, cy] = cam.worldToScreen(st.cursor.x, st.cursor.y, cw, ch);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(cx, cy);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,202,106,0.9)';
    ctx.stroke();
    ctx.lineWidth = 1;
    // Squad segment centers.
    const nSquads = st.selectedSquads.length;
    if (nSquads > 0) {
      const squadOffs = fanOffsets(nSquads, SQUAD_FAN);
      const cos = Math.cos(st.formationDrag.facing);
      const sin = Math.sin(st.formationDrag.facing);
      st.selectedSquads.forEach((_sid, si) => {
        const scx = st.formationDrag!.ax + cos * squadOffs[si];
        const scy = st.formationDrag!.ay + sin * squadOffs[si];
        const [sx, sy] = cam.worldToScreen(scx, scy, cw, ch);
        ctx.fillStyle = 'rgba(255,202,106,0.5)';
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // Selected team(s) show their OrderState above their soldiers: kind +
  // refusal reason. A balked team's chip pulses so a refusal is never missed.
  // Not in deployment: nothing has been ordered yet, and the dug-in stance a
  // placement writes would label every squad DEFEND over the banner.
  for (const tid of st.deploy ? [] : focusTeams(sim, st)) {
    const team = sim.teams[tid];
    if (!team) continue;
    const os = team.orderState;
    if (!os.order && os.phase === 'idle') continue;
    const centroid = teamCentroid(sim, team.soldierIds);
    if (!centroid) continue;
    const [sx, sy] = cam.worldToScreen(centroid.x, centroid.y, cw, ch);
    const label = os.order ? os.order.kind.toUpperCase() : '';
    const text = os.reason ? `${label} — ${os.reason}` : label;
    const balked = os.phase === 'balked';
    if (balked) ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(sim.tick / 12));
    chip(ctx, sx, sy - cam.scale * 1.1 - 10, text, balked ? '#ff8a5c' : '#ffe9a0', st.clear);
    if (balked) ctx.globalAlpha = 1;
  }

  if (st.shot) {
    const [x0, y0] = cam.worldToScreen(st.shot.fx, st.shot.fy, cw, ch);
    const [x1, y1] = cam.worldToScreen(st.shot.tx, st.shot.ty, cw, ch);
    if (!st.shot.ok) ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    // dark halo pass first so the line reads over light terrain, matching the route preview
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(12,14,10,0.45)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = st.shot.ok ? 'rgba(255,202,106,0.85)' : 'rgba(150,150,140,0.7)';
    ctx.stroke();
    ctx.setLineDash([]);
    // blocked shots tell the player why, not just that — from the structured reason, never prose
    const blockedLabel =
      st.shot.reason === 'out-of-range' ? 'OUT OF RANGE' : st.shot.reason === 'no-los' ? 'NO LOS' : st.shot.reason === 'concealed' ? 'CONCEALED' : st.shot.reason === 'floor-blocked' ? 'FLOOR' : 'NO SHOT';
    chip(ctx, (x0 + x1) / 2, (y0 + y1) / 2, st.shot.ok ? `${Math.round(st.shot.acc * 100)}%` : blockedLabel, st.shot.ok ? '#ffe9a0' : '#a0a090', st.clear);
  }

  pings.draw(ctx, sim, cam, cw, ch, st.clear, st.avoid);
}

export type ChipVerdict = 'comply' | 'cautious' | 'balk';

const CHIP_GOOD = '#7fbf6a';
const CHIP_WARN = '#e0c060';
const CHIP_BAD = '#d05c50';
const CHIP_MUTED = '#b8b4a4';

export interface ChipInput {
  covered: number; // men the resolver put in directional cover
  placed: number; // men it found a tile for
  refused: number; // men it could not place at all
  eta: number | null;
  verdict: ChipVerdict | null; // null = unarmed hover: no raycasts were spent on the danger ladder
  level?: number | null; // target floor; null = a ground order with no floor pick, so say nothing
}

// Pure formatting for the order context chip, exported for tests — canvas
// drawing (contextChip) consumes this and stays untested. One plain line, and
// the colour is the verdict: green they go and most land in cover, amber they
// go carefully or end up in the open, red they will not go or have nowhere to
// stand. The cover count is of resolved spots, not the tile under the cursor:
// the cursor is one point the men never stand on, and the count is the number
// the player is actually buying (design §3.4).
export function formatContextChip(o: ChipInput): { lines: string[]; color: string; floorLine: boolean } {
  const lines: string[] = [];
  // Floor first: it says WHERE the dots are, and an upstairs dot is drawn on
  // the same pixels a ground-floor one would be.
  const floorLine = o.level != null;
  if (o.level != null) lines.push(o.level === 0 ? 'Ground floor' : `Floor ${o.level + 1}`);
  if (o.verdict === 'balk') lines.push("Won't go");
  else if (o.placed > 0) lines.push(`${o.covered} of ${o.placed} in cover${o.eta !== null ? ` · ${Math.max(1, Math.round(o.eta))} s` : ''}`);
  // A refusal outranks the verdict: men with nowhere to stand never step off
  // whatever the compliance ladder says.
  if (o.refused > 0) lines.push(o.placed === 0 ? 'No footing' : `${o.refused} with no footing`);
  const color = o.verdict === 'balk' || o.refused > 0 ? CHIP_BAD : o.verdict === 'cautious' || o.covered * 2 < o.placed ? CHIP_WARN : CHIP_GOOD;
  return { lines, color, floorLine };
}

function contextChip(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  cw: number,
  ch: number,
  lines: string[],
  color: string,
  floorLine: boolean,
): void {
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const lh = 14;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const h = lines.length * lh + 8;
  let x = sx + 16; // up-right of the cursor so the chip never occludes it or the dots
  let y = sy - 16 - h;
  if (x + w > cw - 4) x = sx - 16 - w; // flip left at the right edge
  if (y < 4) y = sy + 16; // flip below at the top edge
  // A phone has no cursor to sit beside — the "cursor" is the finger, and the
  // bottom third of the screen belongs to the docked tooltip sheet and the
  // touch bar, which are DOM and paint OVER the canvas. So the chip docks
  // top-left instead, clear of the top bar and of the thumb. One fixed place
  // also means it never moves while the order is being dragged.
  if (MOBILE) {
    x = 8;
    y = 64;
  }
  const r = 3;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(18,22,15,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(74,82,64,0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.fillStyle = floorLine && i === 0 ? CHIP_MUTED : color; // the floor is a place, not a verdict
    ctx.fillText(line, x + 6, y + 4 + lh * i + lh / 2);
  });
  ctx.textBaseline = 'alphabetic';
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, clear?: OverlayState['clear']): void {
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const w = ctx.measureText(text).width + 10;
  if (clear) {
    x = Math.max(clear.left + w / 2 + 4, Math.min(clear.right - w / 2 - 4, x));
    y = Math.max(clear.top + 12, Math.min(clear.bottom - 12, y));
  }
  ctx.fillStyle = 'rgba(18,22,15,0.85)';
  ctx.fillRect(x - w / 2, y - 8, w, 16);
  ctx.strokeStyle = 'rgba(74,82,64,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2, y - 8, w, 16);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

interface Ping {
  side: Side;
  name: string; // clipped first when the row is tight — see draw()
  status: string;
  color: string;
  tick: number;
  drama: boolean; // morale/order news — yields its slot to a casualty when the feed is full
}

interface WorldKia {
  x: number;
  y: number;
  label: string;
  tick: number;
}

// What the ticker needs off one team to speak about it, built in the drain
// block (main.ts) because that is where `sim` lives. Flat numbers on purpose:
// the aggregation below is then a pure function of them and can be tested
// without standing up a Sim.
//
// `seen` carries the same fog test the event filter upstream applies, so a
// German team going to ground behind the hedgerow says nothing. `balked` is
// read straight off Team.orderState.phase — the orders.ts contract says the UI
// never re-derives comply/cautious/balk, and this does not.
export interface TeamPulse {
  id: number;
  side: Side;
  name: string;
  live: number;
  pinned: number;
  balked: boolean;
  seen: boolean;
}

const PING_TICKS = 8 * 30;
const MAX_VISIBLE = 5;
// 30 s at DT=1/30. A team sitting on the majority line crosses it every few
// seconds; without this the feed would be nothing else.
const PIN_COOLDOWN = 30 * 30;
// 1 s at DT=1/30. A barrage that pins a platoon also kills men, and without a
// dwell the PINNED DOWN line the player just got is gone the next frame.
const DRAMA_DWELL = 30;
const C_BAD = '#d05c50'; // blue's bad news
const C_WARN = '#e08a3c'; // blue, not yet a casualty — downed, balked, our ambush
const C_ENEMY = '#ffca6a'; // anything happening to the Germans
const C_STEADY = '#9fb87a'; // the lines that are neither loss nor alarm: a rally, a recovery
// The quiet recoveries (#766): things the men did for each other that changed
// the fight and that nothing on screen said. One line each, named for the
// team. Blue only, and on purpose — every one of them is a casualty report in
// disguise (a new leader means the old one fell), and the German body count
// is intel the ticker does not hand out.
const RECOVERY: Partial<Record<UnitEvent['kind'], string>> = {
  'took-over': 'GUN TAKEN OVER',
  promoted: 'NEW LEADER',
  stabilized: 'MAN STABILIZED',
  recovered: 'MAN BACK UP',
  resupplied: 'AMMO BROUGHT UP',
};
// The commander's voice (#787), heard when the player hands blue to the AI:
// what his own headquarters has just decided. Blue only by construction of
// the rule, not by accident — the red commander writes the same events for
// its own side, and a decision made in the enemy's headquarters is not
// something anybody on the field can see.
const COMMAND: Partial<Record<UnitEvent['kind'], [string, string]>> = {
  'reserve-committed': ['RESERVE COMMITTED', C_STEADY],
  culminated: ['ATTACK CALLED OFF', C_WARN],
  'smoke-objective': ['SMOKE ON OBJECTIVE', C_STEADY],
};
const MAX_KIAS = 12;
const KIA_CELL = 8; // world meters — casualties inside a cell share one stack
const KIA_LINE_H = 11;
const ROW_W = 190;
const ROW_H = 20;
const ROW_GAP = 3;

// Pings sim-emitted unit events the player must not miss, as a fixed
// right-edge feed column (screen-space only — never anchored to world
// position, so entries can never overlap). Sim-tick expiry: pause-safe.
export class EventPings {
  private pings: Ping[] = [];
  private kias: WorldKia[] = [];
  private pin = new Map<number, { majority: boolean; lastPin: number; lastRally: number }>();
  private balk = new Map<number, boolean>();
  private recovery = new Map<string, number>(); // "subject|kind" -> tick it was last announced

  add(events: UnitEvent[], tick: number, teams: TeamPulse[] = []): void {
    for (const e of events) {
      if (e.kind === 'vehicle-destroyed') {
        // sim.ts destroyVehicle sets `burning` unconditionally and is the only
        // emitter of this event, so every one of them really is a brew-up.
        this.push(e.side, e.name, 'BREWED UP', e.side === 'blue' ? C_BAD : C_ENEMY, tick);
      } else if (e.kind === 'ambush') {
        this.push(e.side, e.name, 'AMBUSH SPRUNG!', e.side === 'blue' ? C_WARN : C_ENEMY, tick, true);
      } else if (e.kind === 'broken' || e.kind === 'surrendered') {
        // Both sides. Watching the garrison come apart IS the payoff of the
        // morale model, and the fog filter upstream (main.ts) means a German
        // event only reaches here when a friendly can actually see it.
        this.push(e.side, e.name, e.kind === 'broken' ? 'BROKE' : 'SURRENDERS', e.side === 'blue' ? C_BAD : C_ENEMY, tick, true);
      } else if (e.side === 'blue' && (e.kind === 'kia' || e.kind === 'downed')) {
        // Blue only, deliberately: an exact German body count is intel, and
        // handing it over is a decision nobody has made.
        this.push(e.side, e.name, e.kind === 'kia' ? 'KIA' : 'DOWN', e.kind === 'downed' ? C_WARN : C_BAD, tick);
        if (e.kind === 'kia') {
          this.kias.push({ x: e.x, y: e.y, label: e.name, tick });
          if (this.kias.length > MAX_KIAS) this.kias.shift();
        }
      } else if (e.side === 'blue' && RECOVERY[e.kind]) {
        // Same cooldown as the pin lines, per team and per kind: a squad
        // patching up three men after a barrage says so once.
        this.quiet(e.side, e.team ?? e.name, e.kind, RECOVERY[e.kind]!, C_STEADY, tick);
      } else if (e.side === 'blue' && COMMAND[e.kind]) {
        this.quiet(e.side, e.name, e.kind, COMMAND[e.kind]![0], COMMAND[e.kind]![1], tick);
      } else if (e.side !== 'blue' && e.kind === 'closing') {
        // The one thing the ticker says about enemy intent, and it is not
        // intent: a German team was SEEN moving onto ground blue holds (the
        // sim raises it off blue's own sightings). Blue's own advances raise
        // the same event for the other side and say nothing here.
        this.quiet(e.side, e.team ?? e.name, e.kind, 'CLOSING IN', C_ENEMY, tick);
      }
      // 'pinned' and 'rallied' are deliberately NOT consumed here. One barrage
      // pins a platoon in a tick and five slots cannot hold that, so the ticker
      // speaks in team aggregates (below); the per-man crossings drive the
      // world FX and the audio layer instead.
    }
    for (const t of teams) this.teamLine(t, tick);
  }

  // Both aggregate lines are edges on ONE flag — a team is either majority-
  // pinned or it is not — rather than a reference count over the per-man
  // events. Reading live state is simply less to get wrong than balancing a
  // stream, and it self-heals if an event is ever dropped.
  private teamLine(t: TeamPulse, tick: number): void {
    if (t.live === 0) {
      this.pin.delete(t.id);
      this.balk.delete(t.id);
      return;
    }
    const majority = t.pinned * 2 > t.live;
    const st = this.pin.get(t.id) ?? { majority: false, lastPin: -PIN_COOLDOWN, lastRally: -PIN_COOLDOWN };
    if (majority !== st.majority) {
      st.majority = majority; // the flag tracks truth even when nobody says it
      // Only the ANNOUNCEMENT is gated — by the cooldown, so a team hovering on
      // the line cannot chatter, and by fog, so a team that pinned unseen does
      // not come back into view carrying a stale flag and a false rally.
      //
      // One window per DIRECTION: a rally is the answer to the pin the player
      // was just given, and a shared window swallowed it. Two windows still
      // cannot chatter — spending both costs a crossing each way, so a team
      // sitting on the line gets at most one PINNED DOWN and one RALLIED per
      // cooldown, not a stream.
      if (t.seen && tick - (majority ? st.lastPin : st.lastRally) >= PIN_COOLDOWN) {
        if (majority) st.lastPin = tick;
        else st.lastRally = tick;
        const c = majority ? (t.side === 'blue' ? C_BAD : C_ENEMY) : C_STEADY;
        this.push(t.side, t.name, majority ? 'PINNED DOWN' : 'RALLIED', c, tick, true);
      }
    }
    this.pin.set(t.id, st);

    const was = this.balk.get(t.id) ?? false;
    // Blue only: a German team refusing an order is AI state the player has no
    // window onto, and inventing one would be a cheat.
    if (t.side === 'blue' && t.balked && !was) this.push(t.side, t.name, "WON'T ADVANCE", C_WARN, tick, true);
    this.balk.set(t.id, t.balked);
  }

  // A drama line with the pin cooldown, per subject and kind.
  private quiet(side: Side, subject: string, kind: string, status: string, color: string, tick: number): void {
    const key = `${subject}|${kind}`;
    if (tick - (this.recovery.get(key) ?? -PIN_COOLDOWN) < PIN_COOLDOWN) return;
    this.recovery.set(key, tick);
    this.push(side, subject, status, color, tick, true);
  }

  /** Where the feed was last drawn, in CSS px. null = nothing on show. */
  feed: ScreenRect | null = null;

  // The feed as the player is being told it, oldest first.
  labels(): string[] {
    return this.pings.map((p) => `${p.name} — ${p.status}`);
  }

  reset(): void {
    this.pings = [];
    this.kias = [];
    this.pin.clear();
    this.balk.clear();
    this.recovery.clear();
  }

  // `drama` is morale and order news. It is worth a slot, but never worth the
  // slot a casualty or a burning tank is sitting in: with the store full, the
  // oldest drama line gives way, and if there is no drama line to give way the
  // incoming drama is the one that loses. The exception is a drama line still
  // inside its dwell — a PINNED DOWN evicted by the casualties of the very
  // barrage that caused it was never read. Then the oldest line goes instead,
  // casualty or not.
  private push(side: Side, name: string, status: string, color: string, tick: number, drama = false): void {
    if (this.pings.length >= MAX_VISIBLE) {
      const i = this.pings.findIndex((p) => p.drama && tick - p.tick >= DRAMA_DWELL);
      if (i >= 0) this.pings.splice(i, 1);
      else if (drama) return;
      else this.pings.shift();
    }
    this.pings.push({ side, name, status, color, tick, drama });
  }

  draw(ctx: CanvasRenderingContext2D, sim: Sim, cam: Camera, cw: number, ch: number, clear?: ScreenRect, avoid: readonly ScreenRect[] = []): void {
    this.pings = this.pings.filter((p) => sim.tick - p.tick < PING_TICKS);
    // A 190px feed hard-anchored at cw-202 is a third of a phone screen and
    // five rows of it reach the roster sheet. Narrow it and show fewer.
    const rw = Math.min(ROW_W, cw - 24);
    const rows = cw < 500 ? 3 : MAX_VISIBLE;
    const visible = this.pings.slice(-rows).reverse(); // newest at top
    // Clear of the top bar, and of the tutorial while it is talking. The room
    // is taken for every row the feed can hold, so a line arriving does not
    // push the column onto the bubble.
    const at = dockFeed(cw - rw - 12, rw, rows * (ROW_H + ROW_GAP), 60, clear ? clear.bottom : ch, (clear ? clear.left : 0) + 12, avoid);
    const x = at.x;
    let y = at.y;
    this.feed = visible.length > 0 ? { left: x, top: y, right: x + rw, bottom: y + visible.length * (ROW_H + ROW_GAP) - ROW_GAP } : null;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const p of visible) {
      const life = (sim.tick - p.tick) / PING_TICKS; // 0..1
      ctx.globalAlpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4; // hold at full readability, ease out only over the tail
      ctx.fillStyle = 'rgba(18,22,15,0.85)';
      ctx.fillRect(x, y, rw, ROW_H);
      ctx.fillStyle = TEAM[p.side]; // side-colored left border
      ctx.fillRect(x, y, 3, ROW_H);
      ctx.fillStyle = p.color;
      // The STATUS is the news and always survives; the name is context and is
      // what gives way. A 190 px row holds ~26 monospace characters and team
      // names run to "Panzerschreck Team", so clipping the whole label tail-
      // first turned "— PINNED DOWN" into "— PINNED D…" and said nothing.
      const tail = ` — ${p.status}`;
      ctx.fillText(`${clipToWidth(ctx, p.name, rw - 16 - ctx.measureText(tail).width)}${tail}`, x + 10, y + ROW_H / 2 + 1);
      y += ROW_H + ROW_GAP;
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';

    // World-anchored KIA labels. Co-located casualties (same KIA_CELL bucket)
    // stack with a deterministic vertical offset: stable sort by (tick, name),
    // offset = index * KIA_LINE_H — no Math.random, no wall clock; expiry on
    // sim ticks, so pause freezes them.
    this.kias = this.kias.filter((k) => sim.tick - k.tick < PING_TICKS);
    if (this.kias.length > 0) {
      const cells = new Map<string, WorldKia[]>();
      for (const k of this.kias) {
        const key = `${Math.floor(k.x / KIA_CELL)},${Math.floor(k.y / KIA_CELL)}`;
        const g = cells.get(key);
        if (g) g.push(k);
        else cells.set(key, [k]);
      }
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const group of cells.values()) {
        group.sort((a, b) => a.tick - b.tick || a.label.localeCompare(b.label));
        group.forEach((k, i) => {
          const life = (sim.tick - k.tick) / PING_TICKS;
          ctx.globalAlpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4;
          const [sx, sy] = cam.worldToScreen(k.x, k.y, cw, ch);
          ctx.fillStyle = '#d05c50';
          ctx.fillText(`${k.label} KIA`, sx, sy - 10 - i * KIA_LINE_H);
        });
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }
}

function clipToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}
