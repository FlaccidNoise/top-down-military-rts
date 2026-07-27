import { type Campaign, squadMembers } from '../campaign/campaign';
import { WEAPONS } from '../sim/data';
import { TERRAIN_LABELS } from '../render/strategic';
import { CELL_MINUTES, cellXY, type CellTerrain } from '../strategic/sector';
import {
  chitEtaMinutes,
  formatClock,
  minutesToReinforcement,
  operationStatus,
  REINFORCE_CYCLE_DAYS,
  REINFORCE_PER_COMPANY,
  type Chit,
  type Front,
} from '../strategic/front';

// ── Pure helpers (extracted for testability) ──────────────────────────────

export function operationProgress(front: Front): { held: number; total: number; status: 'ongoing' | 'won' | 'lost' } {
  const objectives = front.sector.cells.filter((c) => c.objective);
  const held = objectives.filter((c) => c.owner === 'blue').length;
  return { held, total: objectives.length, status: operationStatus(front) };
}

export function formatReinforceETA(mins: number): string {
  if (mins <= 0) return 'arriving now';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (m > 0 && days === 0) parts.push(`${m}m`);
  return parts.join(' ') || 'arriving now';
}

export function rosterHealth(
  campaign: Campaign,
  companyIndex: number,
): { fit: number; recovering: number; kia: number } {
  const company = campaign.companies[companyIndex];
  const pids = new Set(company.squads.flatMap((si) => squadMembers(campaign.squads[si])));
  let fit = 0,
    recovering = 0,
    kia = 0;
  for (const pid of pids) {
    const s = campaign.soldiers[pid];
    if (!s) continue;
    if (s.status === 'fit') fit++;
    else if (s.status === 'recovering') recovering++;
    else if (s.status === 'kia') kia++;
  }
  return { fit, recovering, kia };
}

export function chitComposition(
  campaign: Campaign,
  chit: Chit,
): { squads: number; men: number; weapons: Record<string, number> } | null {
  if (chit.side === 'red' || chit.companyIndex < 0) return null;
  const company = campaign.companies[chit.companyIndex];
  if (!company) return null;
  let squads = 0,
    men = 0;
  const weapons: Record<string, number> = {};
  for (const si of company.squads) {
    const sq = campaign.squads[si];
    if (!sq) continue;
    squads++;
    for (const pid of squadMembers(sq)) {
      const s = campaign.soldiers[pid];
      if (!s || s.status === 'kia') continue;
      men++;
      const w = WEAPONS[s.weapon]?.name ?? s.weapon;
      weapons[w] = (weapons[w] ?? 0) + 1;
    }
  }
  return { squads, men, weapons };
}

// ── Internal constants ────────────────────────────────────────────────────

const TERRAIN_SHORT: Record<CellTerrain, string> = {
  open: 'Open',
  woods: 'Woods',
  town: 'Town',
  bourg: 'Bourg',
  river: 'River',
  bridge: 'Bridge',
  road: 'Road',
};

// ── StratHud ──────────────────────────────────────────────────────────────

export interface StratHudCallbacks {
  togglePause(): void;
  setSpeed(idx: number): void;
}

// Strategic clock controls. Space and 1/2/3 still work; this is the only path
// that exists at all for a mouse or a finger.
export const SPEED_LABELS = ['1\u00d7', '10\u00d7', '60\u00d7'];

export class StratHud {
  readonly root: HTMLDivElement;
  private sig = '';
  private trends = new Map<number, number[]>();
  private rosterOpen = false;
  private paused = true;
  private speedIdx = 1;

  constructor(private readonly cb: StratHudCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'strat-hud';
    this.root.innerHTML = `
      <div id="st-progress"></div>
      <div id="st-reinforce"></div>
      <div id="st-chit-panel" style="display:none"></div>
      <div id="st-roster">
        <button id="st-roster-toggle" class="hbtn">COMPANY ROSTER ▸</button>
        <div id="st-roster-body" style="display:none"></div>
      </div>`;
    document.body.appendChild(this.root);

    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cancel-wp]');
      if (btn) {
        const idx = Number(btn.dataset.idx);
        const chit = this._lastChit;
        if (chit && idx >= 0 && idx < chit.path.length) {
          chit.path.splice(idx);
          this.sig = '';
        }
        return;
      }
      if ((e.target as HTMLElement).id === 'st-roster-toggle') {
        this.rosterOpen = !this.rosterOpen;
        this.sig = '';
        return;
      }
      const clock = (e.target as HTMLElement).closest<HTMLElement>('[data-clock]');
      if (clock) {
        const v = clock.dataset.clock!;
        if (v === 'pause') this.cb.togglePause();
        else this.cb.setSpeed(Number(v));
        this.sig = '';
      }
    });
  }

  private _lastFront?: Front;
  private _lastCampaign?: Campaign;
  private _lastChit?: Chit; // chit reference for waypoint cancel

  update(front: Front, campaign: Campaign, selectedChit: number, paused: boolean, speedIdx = 1): void {
    this._lastFront = front;
    this._lastCampaign = campaign;
    this.paused = paused;
    this.speedIdx = speedIdx;

    // Strength trend sampling
    for (const chit of front.chits) {
      if (chit.strength <= 0) continue;
      let hist = this.trends.get(chit.id);
      if (!hist) {
        hist = [];
        this.trends.set(chit.id, hist);
      }
      if (hist.length === 0 || hist[hist.length - 1] !== chit.strength) {
        hist.push(chit.strength);
        if (hist.length > 40) hist.shift();
      }
    }

    const clockBucket = (front.clockMin / 5) | 0;
    let strengthSig = '';
    for (const chit of front.chits) {
      if (chit.strength > 0) strengthSig += `${chit.id}:${(chit.strength / 5) | 0},`;
    }

    const sig = `${clockBucket}|${selectedChit}|${operationStatus(front)}|${paused}|${speedIdx}|${strengthSig}|${this.rosterOpen}`;
    if (sig === this.sig) return;
    this.sig = sig;

    const chit = selectedChit >= 0 ? front.chits.find((c) => c.id === selectedChit) : undefined;
    this._lastChit = chit;

    this.renderProgress(front);
    this.renderReinforce(front);
    this.renderChitPanel(front, campaign, chit);
    this.renderRoster(campaign);
  }

  private renderProgress(front: Front): void {
    const prog = operationProgress(front);
    const pct = prog.total > 0 ? Math.round((prog.held / prog.total) * 100) : 0;
    const statusClass = prog.status === 'won' ? 'st-won' : prog.status === 'lost' ? 'st-lost' : '';
    const speeds = SPEED_LABELS.map(
      (label, i) => `<button class="hbtn st-speed${i === this.speedIdx ? ' active' : ''}" data-clock="${i}">${label}</button>`,
    ).join('');
    this.root.querySelector('#st-progress')!.innerHTML =
      `<div class="st-clock-ctl">` +
      `<button class="hbtn st-play" data-clock="pause" title="${this.paused ? 'Resume' : 'Pause'}">${this.paused ? '\u25b6' : '\u23f8'}</button>` +
      speeds +
      `</div>` +
      `<div class="st-progress-bar"><i style="width:${pct}%"></i></div>` +
      `<span class="st-progress-text">${prog.held}/${prog.total} objectives</span>` +
      `<span class="st-status-badge ${statusClass}">${prog.status.toUpperCase()}</span>` +
      `<span class="st-clock">Day ${front.day} ${front.hhmm}</span>`;
  }

  private renderReinforce(front: Front): void {
    const mins = minutesToReinforcement(front);
    const eta = formatReinforceETA(mins);
    this.root.querySelector('#st-reinforce')!.innerHTML =
      `<span class="st-reinf-label">Reinforcements</span>` +
      `<span class="st-reinf-eta">${eta}</span>` +
      `<span class="st-reinf-detail">next cycle · up to ${REINFORCE_PER_COMPANY}/co every ${REINFORCE_CYCLE_DAYS}d</span>`;
  }

  private renderChitPanel(front: Front, campaign: Campaign, chit: Chit | undefined): void {
    const el = this.root.querySelector('#st-chit-panel')! as HTMLElement;
    if (!chit) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';

    const trend = this.trends.get(chit.id) ?? [];
    const trendSvg = trend.length > 1 ? sparklineSvg(trend) : '';

    const comp = chitComposition(campaign, chit);
    const compHtml =
      chit.side === 'blue' && comp
        ? `<div class="st-comp-line">${comp.squads} squads · ${comp.men} men</div>` +
          `<div class="st-weapons">${Object.entries(comp.weapons)
            .map(([w, n]) => `${n}× ${w}`)
            .join(' · ')}</div>`
        : '<div class="st-comp-line enemy">enemy — composition unknown</div>';

    const sideClass = chit.side === 'blue' ? 'us' : 'ge';

    // Waypoint rows with cumulative ETA per row
    let pathRows = '';
    let etaLine = '';
    if (chit.path.length === 0) {
      pathRows = '<div class="st-wp-none">Holding position</div>';
    } else {
      let accum = -chit.progress;
      pathRows = chit.path
        .map((ci, i) => {
          accum += CELL_MINUTES[front.sector.cells[ci].terrain];
          const cell = front.sector.cells[ci];
          const xy = cellXY(front.sector, ci);
          const label = `${String.fromCharCode(65 + (xy.x % 26))}${xy.y + 1}`;
          const cellCost = i === 0 ? Math.max(0, CELL_MINUTES[cell.terrain] - chit.progress) : CELL_MINUTES[cell.terrain];
          const arrival = formatClock(front.clockMin + accum);
          return (
            `<div class="st-wp-row">` +
            `<span class="st-wp-idx">${i + 1}.</span>` +
            `<span class="st-wp-cell">${label} — ${TERRAIN_SHORT[cell.terrain]}</span>` +
            `<span class="st-wp-cost">${cellCost}m · ~${arrival.hhmm}</span>` +
            `<button class="st-wp-cancel" data-idx="${i}" title="Cancel this waypoint and all after">&times;</button>` +
            `</div>`
          );
        })
        .join('');

      const totalEta = chitEtaMinutes(front, chit);
      const arrival = formatClock(front.clockMin + totalEta);
      etaLine = `<div class="st-eta">ETA ${arrival.day > front.day ? `D${arrival.day} ` : ''}${arrival.hhmm} (${totalEta}m)</div>`;
    }

    el.innerHTML =
      `<div class="st-chit-header ${sideClass}">` +
      `<b>${chit.name}</b>` +
      `<span>${chit.strength} men</span>` +
      `</div>` +
      trendSvg +
      compHtml +
      etaLine +
      `<div class="st-path">${pathRows}</div>` +
      (chit.side === 'blue' ? '<div class="st-supply-note">supply: not modeled</div>' : '');
  }

  private renderRoster(campaign: Campaign): void {
    const rows = campaign.companies
      .map((co, i) => {
        const h = rosterHealth(campaign, i);
        const total = h.fit + h.recovering + h.kia || 1;
        const fitPct = Math.round((h.fit / total) * 100);
        const recPct = Math.round((h.recovering / total) * 100);
        const kiaPct = Math.round((h.kia / total) * 100);
        return (
          `<div class="st-co-row">` +
          `<span class="st-co-name">${co.name}</span>` +
          `<span class="st-co-nums">` +
          `<span class="st-fit">${h.fit} fit</span>` +
          `${h.recovering > 0 ? `<span class="st-rec">${h.recovering} rec</span>` : ''}` +
          `${h.kia > 0 ? `<span class="st-kia">${h.kia} kia</span>` : ''}` +
          `</span>` +
          `<span class="st-co-bar"><i class="st-fit-bar" style="width:${fitPct}%"></i><i class="st-rec-bar" style="width:${recPct}%"></i><i class="st-kia-bar" style="width:${kiaPct}%"></i></span>` +
          `</div>`
        );
      })
      .join('');

    const toggle = this.root.querySelector('#st-roster-toggle')!;
    toggle.textContent = `COMPANY ROSTER ${this.rosterOpen ? '▾' : '▸'}`;
    const body = this.root.querySelector('#st-roster-body')! as HTMLElement;
    body.style.display = this.rosterOpen ? '' : 'none';
    body.innerHTML = rows;
  }
}

function sparklineSvg(history: number[]): string {
  const w = 130,
    h = 26,
    pad = 4;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const points = history
    .map((v, i) => {
      const x = pad + (i / (history.length - 1)) * (w - pad * 2);
      const y = pad + ((max - v) / range) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(' ');
  return `<svg class="st-sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${points}" fill="none" stroke="var(--amber)" stroke-width="1.5"/></svg>`;
}