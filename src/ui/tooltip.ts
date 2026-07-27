import type { Camera } from '../render/camera';
import { woundLabel } from '../sim/body';
import { TERRAIN, VEHICLES, WEAPONS, type TerrainDef, type TerrainKey, type WeaponDef } from '../sim/data';
import { EYE_VEHICLE, HULL_VEHICLE, eyeOf, sightBetween, sightToSoldier, type Sim, type Soldier, type Vehicle } from '../sim/sim';
import { reserveAmmo, STATE_COLOR } from './hud';
import { formatCoverBreakdown, formatCoverBreakdownForFloor } from './tooltip-format';
import { MOBILE } from '../render/view';

export type Pick =
  | { kind: 'soldier'; s: Soldier }
  | { kind: 'vehicle'; v: Vehicle }
  | { kind: 'terrain'; x: number; y: number }
  | null;

// What's under the cursor: living soldiers, then vehicles, then bodies, then ground.
export function pickAt(sim: Sim, cam: Camera, sx: number, sy: number, cw: number, ch: number): Pick {
  const [wx, wy] = cam.screenToWorld(sx, sy, cw, ch);
  const r = Math.max(0.9, 12 / cam.scale);
  let bestAlive: Soldier | null = null;
  let bestDead: Soldier | null = null;
  let da = r;
  let dd = r;
  for (const s of sim.soldiers) {
    if (s.inVehicle >= 0 || !sim.soldierVisibleTo('blue', s)) continue; // fog of war: can't probe what isn't seen
    const d = Math.hypot(s.x - wx, s.y - wy);
    if (s.alive) {
      if (d < da || (d === da && bestAlive !== null && s.level > bestAlive.level)) {
        da = d;
        bestAlive = s;
      }
    } else if (d < dd) {
      dd = d;
      bestDead = s;
    }
  }
  if (bestAlive) return { kind: 'soldier', s: bestAlive };
  for (const v of sim.vehicles) {
    if (!sim.vehicleVisibleTo('blue', v)) continue;
    if (Math.hypot(v.x - wx, v.y - wy) < 2.8) return { kind: 'vehicle', v };
  }
  if (bestDead) return { kind: 'soldier', s: bestDead };
  if (!sim.map.inBounds(Math.floor(wx), Math.floor(wy))) return null;
  return { kind: 'terrain', x: wx, y: wy };
}

export interface ShotSolution {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  ok: boolean;
  acc: number;
  title: string;
  lines: string[];
  reason?: 'no-los' | 'concealed' | 'out-of-range' | 'mixed' | 'floor-blocked'; // set when !ok — overlays branch on this, never on prose
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;

// The firing solution the current selection has against what's hovered —
// straight from the sim's own preview math, never re-derived.
export function computeShot(sim: Sim, squadId: number, vehicleId: number, pick: Pick): ShotSolution | null {
  if (!pick) return null;

  if (vehicleId >= 0 && pick.kind === 'vehicle' && pick.v.alive) {
    const v = sim.vehicles[vehicleId];
    if (!v?.alive || pick.v.side === v.side) return null;
    const def = VEHICLES[v.kind];
    return apSolution(sim, v.x, v.y, def.gunPen, def.gunAccuracy, def.gunRange, pick.v, v.path !== null, `GUN — ${def.name}`, 0, EYE_VEHICLE);
  }

  if (squadId < 0) return null;
  const squad = sim.squads[squadId];
  if (!squad) return null;
  const shooters = squad.soldierIds
    .map((id) => sim.soldiers[id])
    .filter((s) => s.alive && !s.downed && s.mental !== 'broken' && s.inVehicle < 0);
  if (shooters.length === 0) return null;

  if (pick.kind === 'vehicle' && pick.v.alive && pick.v.side === 'red') {
    let best: ShotSolution | null = null;
    for (const at of shooters) {
      const w: WeaponDef = WEAPONS[at.weapon];
      if (w.pen === undefined) continue;
      const sol = apSolution(sim, at.x, at.y, w.pen, w.accuracy * sim.aimFactor(at), w.range, pick.v, at.path !== null, `${w.name.toUpperCase()} — ${at.name}`, at.level, eyeOf(sim, at));
      if (!best || (sol.ok && (!best.ok || sol.acc > best.acc))) best = sol;
    }
    return best;
  }

  if (pick.kind === 'soldier' && pick.s.alive && !pick.s.downed && pick.s.side === 'red') {
    const t = pick.s;
    let best: { s: Soldier; acc: number; dist: number; cover: number } | null = null;
    let nearest = shooters[0];
    let nd = Infinity;
    let anyLos = false;
    let anyRange = false;
    let anyConcealed = false;
    for (const s of shooters) {
      const p = sim.shotPreview(s.x, s.y, s.weapon, t, s.path !== null, sim.aimFactor(s), s.level, eyeOf(sim, s));
      if (p.dist < nd) {
        nd = p.dist;
        nearest = s;
      }
      if (p.visible) anyLos = true;
      if (p.concealed) anyConcealed = true;
      if (p.dist <= WEAPONS[s.weapon].range) anyRange = true;
      if (!p.visible || p.dist > WEAPONS[s.weapon].range) continue;
      if (!best || p.acc > best.acc) best = { s, acc: p.acc, dist: p.dist, cover: p.cover };
    }
    if (!best) {
      const baseReason = anyRange && !anyLos ? (anyConcealed ? 'concealed' : 'no-los') : anyLos && !anyRange ? 'out-of-range' : 'mixed';
      // floor-blocked cue: when the block is LOS only, re-run the SAME sight
      // check with the observer forced onto the target's level. If that
      // clears, the separator is the floor/ceiling, not a wall — say so.
      // The eye stays the shooter's own (eyeOf) precisely so the LEVEL is the
      // only thing that differs from the shotPreview call above; defaulting it
      // would let a prone shooter's wall-block read as "blocked by floor".
      const floorBlocked = baseReason === 'no-los' && sightToSoldier(sim, nearest.x, nearest.y, t, t.level, eyeOf(sim, nearest)).visible;
      const reason = floorBlocked ? 'floor-blocked' : baseReason;
      const text = floorBlocked
        ? 'blocked by floor/ceiling'
        : baseReason === 'concealed' ? 'target concealed' : baseReason === 'no-los' ? 'no line of sight' : baseReason === 'out-of-range' ? 'out of range' : 'no line of sight or out of range';
      return { fx: nearest.x, fy: nearest.y, tx: t.x, ty: t.y, ok: false, acc: 0, reason, title: 'NO SHOT', lines: [`${squad.name}: ${text}`] };
    }
    return {
      fx: best.s.x,
      fy: best.s.y,
      tx: t.x,
      ty: t.y,
      ok: true,
      acc: best.acc,
      title: `BEST SHOT — ${best.s.name} (${WEAPONS[best.s.weapon].name})`,
      lines: [`${Math.round(best.dist)} m · target cover ${pct(best.cover)} · aim ${pct(sim.aimFactor(best.s))}`],
    };
  }
  return null;
}

// l0/e0 are the SHOOTER's floor level and eye height. They were missing: live
// AT fire passes the shooter's level (sim.ts, `sightBetween(this, s.x, s.y,
// v.x, v.y, s.level, 0, ...)`) but this mirror defaulted l0 to 0, so an AT man
// upstairs got a ground-floor shot preview — a direct violation of the "the UI
// must never re-derive (and drift from) this formula" contract on shotPreview.
function apSolution(sim: Sim, fx: number, fy: number, pen: number, accuracy: number, range: number, target: Vehicle, moving: boolean, title: string, l0: number, e0: number): ShotSolution {
  const base = { fx, fy, tx: target.x, ty: target.y, title };
  if (!sightBetween(sim, fx, fy, target.x, target.y, l0, 0, e0, HULL_VEHICLE).visible) return { ...base, ok: false, acc: 0, reason: 'no-los', lines: ['no line of sight'] };
  const p = sim.apShotPreview(fx, fy, pen, accuracy, range, target, moving);
  if (p.dist > range) return { ...base, ok: false, acc: 0, reason: 'out-of-range', lines: [`out of range — ${range} m weapon, target ${Math.round(p.dist)} m`] };
  return {
    ...base,
    ok: true,
    acc: p.acc,
    title: `${title} · ${p.arc} arc`,
    lines: [`${Math.round(p.dist)} m · hit ${pct(p.acc)}${moving ? ' (moving)' : ''}`, `pen ${pen} vs ${p.armor} mm — kill ${pct(p.penChance)}`],
  };
}

export class Tooltip {
  private el: HTMLDivElement;
  private key = '';
  private canvas: HTMLCanvasElement | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'tip';
    this.el.className = 'panel';
    parent.appendChild(this.el);
  }

  // Bind the canvas for mouseleave clearing.
  bindCanvas(c: HTMLCanvasElement): void {
    this.canvas = c;
    c.addEventListener('mouseleave', () => this.clear());
  }

  // Forces the card hidden and its cache key reset — called on canvas
  // mouseleave and on strategic<->battle mode switches, both of which stop
  // the per-frame update() calls that would otherwise clear stale content.
  clear(): void {
    this.key = '';
    this.el.style.display = 'none';
  }

  update(sim: Sim, pick: Pick, shot: ShotSolution | null, mx: number, my: number, moveHint: boolean): void {
    if (!pick) {
      if (this.key) {
        this.key = '';
        this.el.style.display = 'none';
      }
      return;
    }
    const id = pick.kind === 'soldier' ? `s${pick.s.id}` : pick.kind === 'vehicle' ? `v${pick.v.id}` : `t${Math.floor(pick.x)},${Math.floor(pick.y)}`;
    const key = `${id}|${(sim.tick / 5) | 0}|${shot?.title ?? ''}|${shot?.acc.toFixed(2) ?? ''}|${moveHint}`;
    if (key !== this.key) {
      this.key = key;
      this.el.style.display = 'block';
      this.el.innerHTML =
        pick.kind === 'soldier' ? soldierCard(sim, pick.s, shot)
        : pick.kind === 'vehicle' ? vehicleCard(sim, pick.v, shot)
        : terrainCard(sim, pick.x, pick.y, moveHint);
    }
    // No cursor to follow, and a card pinned under the finger would hide the
    // ground the order is about to be given on: ui.css docks it above the
    // touch bar instead, so writing inline left/top here would fight that.
    if (MOBILE) return;
    const pad = 14;
    let x = mx + pad;
    let y = my + pad;
    if (x + this.el.offsetWidth > innerWidth - 8) x = mx - this.el.offsetWidth - pad;
    if (y + this.el.offsetHeight > innerHeight - 8) y = my - this.el.offsetHeight - pad;
    x = Math.min(Math.max(x, 8), Math.max(8, innerWidth - this.el.offsetWidth - 8));
    y = Math.min(Math.max(y, 8), Math.max(8, innerHeight - this.el.offsetHeight - 8));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }
}

export function barRow(label: string, v: number, color: string): string {
  return `<span class="lb">${label}</span><span class="bar"><i style="width:${Math.round(Math.min(1, v) * 100)}%;background:${color}"></i></span><span class="pc">${pct(Math.min(1, v))}</span>`;
}

function woundList(s: Soldier): string {
  const items = s.wounds.slice(-4).map(woundLabel).join(' · ');
  const more = s.wounds.length > 4 ? ` +${s.wounds.length - 4}` : '';
  const bleed = !s.alive || s.downed ? '' : s.stabilized ? ' <span class="flag stab">stabilized</span>' : s.bleedRate > 0.0005 ? ' <span class="flag">bleeding</span>' : '';
  return `<div class="wound">${items}${more}${bleed}</div>`;
}

function shotSection(shot: ShotSolution): string {
  return (
    `<div class="tt-sec${shot.ok ? '' : ' no'}">${shot.title}</div>` +
    (shot.ok ? `<div class="tt-acc">${pct(shot.acc)}</div>` : '') +
    shot.lines.map((l) => `<div class="tt-note">${l}</div>`).join('')
  );
}

export const xpStars = (s: Soldier): string => (s.xp > 0 ? ' · ' + '★'.repeat(Math.min(s.xp, 5)) : '');
export const downedCond = (s: Soldier): string =>
  s.stabilized ? 'stabilized' : s.bleedRate > 0.0005 ? 'bleeding out' : 'incapacitated';
export const rescuePhase = (r: Soldier): string =>
  r.task?.phase === 'drag' ? 'dragging him to cover' : r.task?.phase === 'aid' ? 'applying first aid' : 'moving to him';

function squadAmmoChip(sim: Sim, s: Soldier): string {
  const sq = sim.squads[s.squadId];
  if (!sq) return '';
  let total = 0;
  let max = 0;
  for (const id of sq.soldierIds) {
    const m = sim.soldiers[id];
    total += reserveAmmo(m);
    max += m.ammoStart;
  }
  if (max <= 0) return '';
  return `<span class="tt-ammo">Ammo ${total}/${max}</span>`;
}

function soldierCard(sim: Sim, s: Soldier, shot: ShotSolution | null): string {
  const stars = xpStars(s);
  const reserve = reserveAmmo(s);
  const ammoChip = squadAmmoChip(sim, s);
  let html = `<div class="tt-head ${s.side}"><b>${s.name}</b><span>${WEAPONS[s.weapon].name} ${s.magLeft}+${reserve}${stars}${ammoChip ? ' ' + ammoChip : ''}</span></div>`;
  if (sim.map.storiesAt(Math.floor(s.x), Math.floor(s.y)) >= 2) {
    html += `<div class="tt-note">${s.level === 0 ? 'Ground' : `Floor ${s.level + 1}`}</div>`;
  }
  if (!s.alive) return html + `<div class="tt-kia">KIA</div>` + (s.wounds.length ? woundList(s) : '');
  if (s.downed) {
    html += `<div class="tt-state"><span class="mchip" style="background:#d05c50">DOWN</span><span>${downedCond(s)}</span></div>`;
    if (s.rescuerId >= 0) {
      const r = sim.soldiers[s.rescuerId];
      html += `<div class="tt-note">${r.name} is ${rescuePhase(r)}</div>`;
    }
  } else {
    html += `<div class="tt-state"><span class="mchip" style="background:${STATE_COLOR[s.mental]}">${s.mental.toUpperCase()}</span>${s.fleeing ? '<span class="tt-note">fleeing</span>' : ''}</div>`;
  }
  html += `<div class="tt-grid">${barRow('Morale', s.morale, '#7fbf6a')}${barRow('Suppr.', s.suppression, '#e0a83c')}`;
  if (s.pain > 0.02) html += barRow('Pain', s.pain, '#e08a3c');
  if (s.bloodLoss > 0.02) html += barRow('Blood', s.bloodLoss, '#d05c50');
  html += `</div>`;
  if (s.wounds.length) html += woundList(s);
  if (!s.downed) {
    const rows = sim
      .aimBreakdown(s)
      .filter((t) => Math.abs(t.mult - 1) > 0.005)
      .sort((a, b) => Math.abs(b.mult - 1) - Math.abs(a.mult - 1))
      .map((t) => {
        const d = t.mult - 1;
        return `<div><span>${t.label}</span><span class="${d < 0 ? 'neg' : 'pos'}">${d > 0 ? '+' : ''}${Math.round(d * 100)}%</span></div>`;
      })
      .join('');
    html += `<div class="tt-sec">AIM ${pct(sim.aimFactor(s))}</div><div class="tt-rows">${rows || '<div><span class="tt-note">no impairments</span></div>'}</div>`;
  }
  if (shot) html += shotSection(shot);
  return html;
}

function vehicleCard(sim: Sim, v: Vehicle, shot: ShotSolution | null): string {
  const def = VEHICLES[v.kind];
  const burn = v.burning ? ' · <span class="crit">BURNING</span>' : '';
  let html = `<div class="tt-head ${v.side}"><b>${def.name}</b><span>${v.side === 'blue' ? 'US' : 'GE'}${v.alive ? burn : ' · DESTROYED'}</span></div>`;
  html += `<div class="tt-note">Armor F ${def.armor.front} / S ${def.armor.side} / R ${def.armor.rear} mm</div>`;
  html += `<div class="tt-note">Gun pen ${def.gunPen} mm · ${def.gunRange} m · MG ${def.mgRange} m</div>`;
  if (v.alive) {
    const crew = v.crewIds
      .map((id) => {
        const c = sim.soldiers[id];
        const st = !c.alive ? '<span class="crit">KIA</span>' : c.downed ? '<span class="crit">DOWN</span>' : '<span class="pos">OK</span>';
        return `<div><span>${c.name}</span>${st}</div>`;
      })
      .join('');
    const aliveCount = v.crewIds.filter((id) => sim.soldiers[id].alive).length;
    html += `<div class="tt-sec">CREW ${aliveCount}/${v.crewIds.length}</div><div class="tt-rows">${crew}</div>`;
    html += `<div class="tt-note">AP ${v.ammo.ap} · HE ${v.ammo.he}</div>`;
  }
  if (shot) html += shotSection(shot);
  return html;
}

// Exhaustive over TerrainKey, so tsc --noEmit forces the copy for every key
// appended to TERRAIN — a free compile-time catch, and the reason a new key can
// never ship nameless.
const TERRAIN_NAME: Record<TerrainKey, string> = { grass: 'Open ground', road: 'Road', woods: 'Woods', floor: 'Building interior', hedge: 'Hedgerow', field: 'Plowed field', water: 'River', bank: 'Embankment', rail: 'Railway', furn_heavy: 'Heavy furniture', furn_light: 'Clutter', hearth: 'Hearth', altar: 'Altar' };

function terrainCard(sim: Sim, wx: number, wy: number, moveHint: boolean): string {
  const k = sim.map.terrainKeyAt(Math.floor(wx), Math.floor(wy));
  const t: TerrainDef = TERRAIN[k];
  const lines = k === 'floor' ? formatCoverBreakdownForFloor() : formatCoverBreakdown(t);
  // An impassable tile has a moveCost, but quoting it reads as an invitation to
  // walk onto a river or a pew block.
  const speed = t.passable ? `move speed ×${(1 / t.moveCost).toFixed(2)}` : 'impassable';
  let html = `<div class="tt-head"><b>${TERRAIN_NAME[k]}</b></div><div class="tt-rows">`;
  for (const l of lines) html += `<div><span>${l}</span></div>`;
  html += `<div><span>${speed}</span></div></div>`;
  if (moveHint) html += `<div class="tt-sec">${MOBILE ? 'RELEASE TO MOVE · DRAG TO SET A FRONT' : 'RIGHT-CLICK MOVE · RIGHT-DRAG FORMATION'}</div>`;
  return html;
}
