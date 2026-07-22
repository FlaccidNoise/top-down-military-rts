import { VEHICLES, WEAPONS } from '../sim/data';
import type { Sim, Soldier, Squad } from '../sim/sim';

export const STATE_COLOR = { steady: '#7fbf6a', shaken: '#e0c060', pinned: '#e08a3c', broken: '#d05c50' } as const;
const TEAM = { blue: '#5b9bd5', red: '#d05c50' } as const;

export interface HudCallbacks {
  selectSquad(id: number): void;
  selectVehicle(id: number): void;
  panToSoldier(id: number): void;
  callBarrage(): void;
  callAirstrike(): void;
  togglePause(): void;
}

export interface HudState {
  selectedSquad: number;
  selectedVehicle: number;
  paused: boolean;
  targetMode: '' | 'barrage' | 'air';
  title: string;
}

// Blue squads currently fighting on foot; mounted crews surface as vehicle cards.
export function infantrySquads(sim: Sim): Squad[] {
  return sim.squads.filter((q) => q.side === 'blue' && q.soldierIds.some((id) => sim.soldiers[id].inVehicle < 0));
}

const BARS_LEGEND = '<div class="bars-key"><i class="sw sup"></i>suppression<i class="sw mor"></i>morale</div>';

export class Hud {
  readonly root: HTMLDivElement;
  private sig = '';

  constructor(cb: HudCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="topbar">
        <div class="panel" id="tb-title"></div>
        <div class="panel" id="tb-strength"></div>
        <div id="tb-actions">
          <button class="hbtn" data-act="barrage" title="B"></button>
          <button class="hbtn" data-act="air" title="A"></button>
          <button class="hbtn" data-act="pause" title="space"></button>
        </div>
      </div>
      <div id="modeline" class="panel"></div>
      <div id="squads"></div>
      <div id="banner"></div>
      <div id="hint">
        <span class="hg">left-drag pan · wheel zoom · click select · right-click move · shift+right-click waypoint</span>
        <span class="hg">1-9 squad · B barrage · A airstrike · space pause · esc cancel</span>
      </div>`;
    document.body.appendChild(this.root);

    this.q('#tb-actions').addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'barrage') cb.callBarrage();
      else if (act === 'air') cb.callAirstrike();
      else if (act === 'pause') cb.togglePause();
    });
    this.q('#squads').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-soldier]');
      if (row) return cb.panToSoldier(Number(row.dataset.soldier));
      const veh = t.closest<HTMLElement>('[data-vehicle]');
      if (veh) return cb.selectVehicle(Number(veh.dataset.vehicle));
      const card = t.closest<HTMLElement>('[data-squad]');
      if (card) cb.selectSquad(Number(card.dataset.squad));
    });
    this.q('#squads').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      (e.target as HTMLElement).click();
    });
  }

  private q(sel: string): HTMLElement {
    return this.root.querySelector(sel)!;
  }

  update(sim: Sim, st: HudState): void {
    const sig = `${(sim.tick / 5) | 0}|${st.selectedSquad}|${st.selectedVehicle}|${st.paused}|${st.targetMode}|${sim.winner}|${st.title}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.renderTop(sim, st);
    this.renderSquads(sim, st);

    const mode = this.q('#modeline');
    mode.style.display = st.targetMode ? 'block' : 'none';
    if (st.targetMode === 'barrage') mode.textContent = 'MORTAR BARRAGE — click target · 12 rounds · first impact ~20 s · esc cancels';
    if (st.targetMode === 'air') mode.textContent = 'AIR STRIKE — click target · strafe runs W→E · inbound ~25 s · esc cancels';

    const banner = this.q('#banner');
    banner.style.display = sim.winner ? 'block' : 'none';
    if (sim.winner) {
      banner.style.color = TEAM[sim.winner];
      banner.innerHTML = `${sim.winner === 'blue' ? 'US VICTORY' : 'GERMAN VICTORY'}<small>debrief incoming…</small>`;
    }
  }

  private renderTop(sim: Sim, st: HudState): void {
    const secs = Math.floor(sim.tick / 30);
    const clock = `T+${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    let us = 0;
    let ge = 0;
    for (const s of sim.soldiers) {
      if (!s.alive || s.downed) continue;
      if (s.side === 'blue') us++;
      else ge++;
    }
    this.q('#tb-title').innerHTML = `<b>${st.title}</b> · ${clock}${st.paused ? ' <span class="paused">⏸ PAUSED</span>' : ''}`;
    this.q('#tb-strength').innerHTML =
      `<span class="us">US ${us}</span><div class="ratio"><i style="flex:${us};background:#5b9bd5"></i><i style="flex:${ge};background:#d05c50"></i></div><span class="ge">GE ${ge}</span>`;

    const btn = (act: string) => this.q(`[data-act="${act}"]`) as HTMLButtonElement;
    const barrage = btn('barrage');
    barrage.textContent = `☄ Barrage ×${sim.barragesLeft.blue}`;
    barrage.disabled = sim.barragesLeft.blue <= 0;
    barrage.classList.toggle('active', st.targetMode === 'barrage');
    const air = btn('air');
    air.textContent = `✈ Airstrike ×${sim.airstrikesLeft.blue}`;
    air.disabled = sim.airstrikesLeft.blue <= 0;
    air.classList.toggle('active', st.targetMode === 'air');
    btn('pause').textContent = st.paused ? '▶ Resume' : '⏸ Pause';
  }

  private renderSquads(sim: Sim, st: HudState): void {
    const cards: string[] = [];
    for (const v of sim.vehicles) {
      if (v.side !== 'blue') continue;
      const crew = v.crewIds.map((id) => sim.soldiers[id]);
      const status = v.alive ? `crew ${crew.filter((c) => c.alive).length}/${crew.length}` : 'DESTROYED';
      cards.push(
        `<div class="card panel${v.id === st.selectedVehicle ? ' sel' : ''}" data-vehicle="${v.id}" tabindex="0" role="button">` +
          `<div class="card-head"><b>${VEHICLES[v.kind].name}</b><span class="n">${status}</span></div></div>`,
      );
    }
    for (const sq of infantrySquads(sim)) {
      const men = sq.soldierIds.map((id) => sim.soldiers[id]);
      const sel = sq.id === st.selectedSquad;
      const dots = men
        .map((m) => {
          const c = !m.alive ? '#4a4a3e' : m.downed ? '#d05c50' : STATE_COLOR[m.mental];
          const label = !m.alive ? 'KIA' : m.downed ? 'DOWN' : m.mental.toUpperCase();
          return `<i title="${m.name} — ${label}" style="${m.alive && m.downed ? `border:1px solid ${c}` : `background:${c}`}"></i>`;
        })
        .join('');
      const showLegend = sel && men.some((m) => m.alive && !m.downed);
      const rows = sel ? (showLegend ? BARS_LEGEND : '') + men.map((m) => soldierRow(m)).join('') : '';
      cards.push(
        `<div class="card panel${sel ? ' sel' : ''}" data-squad="${sq.id}" tabindex="0" role="button">` +
          `<div class="card-head"><b>${sq.name}</b><span class="n">${men.filter((m) => m.alive).length}/${men.length}</span></div>` +
          `<div class="dots">${dots}</div>${rows}</div>`,
      );
    }
    const sq = this.q('#squads');
    // innerHTML rebuild destroys keyboard focus (sig rebuilds run every 5 ticks
    // while unpaused) — re-focus the same entity's element afterwards.
    const focused =
      document.activeElement instanceof HTMLElement && sq.contains(document.activeElement)
        ? document.activeElement.closest<HTMLElement>('[data-squad],[data-vehicle],[data-soldier]')
        : null;
    const focusSel = focused
      ? ['data-squad', 'data-vehicle', 'data-soldier']
          .filter((a) => focused.hasAttribute(a))
          .map((a) => `[${a}="${focused.getAttribute(a)}"]`)
          .join('')
      : '';
    sq.innerHTML = cards.join('');
    if (focusSel) sq.querySelector<HTMLElement>(focusSel)?.focus();
  }
}

function soldierRow(m: Soldier): string {
  if (!m.alive) return `<div class="srow kia"><span class="chip" style="background:#4a4a3e" title="KIA"></span><span class="nm">${m.name}</span></div>`;
  const wpn = `<span class="wp">${WEAPONS[m.weapon].name}</span>`;
  const cross = m.wounds.length ? `<span class="flag${m.stabilized || m.bleedRate <= 0 ? ' stab' : ''}">✚</span>` : '';
  if (m.downed) {
    return `<div class="srow urgent" data-soldier="${m.id}" tabindex="0" role="button" title="click to pan to ${m.name}"><span class="chip" style="background:#d05c50" title="DOWN"></span><span class="nm">${m.name}</span>${wpn}${cross}<span class="down">DOWN</span></div>`;
  }
  const supPct = Math.round(m.suppression * 100);
  const morPct = Math.round(m.morale * 100);
  return (
    `<div class="srow" data-soldier="${m.id}"><span class="chip" style="background:${STATE_COLOR[m.mental]}" title="${m.mental.toUpperCase()}"></span>` +
    `<span class="nm">${m.name}</span>${wpn}${cross}` +
    `<span class="bars"><span class="bar" title="Suppression ${supPct}%"><i style="width:${supPct}%;background:#e0a83c"></i></span>` +
    `<span class="bar" title="Morale ${morPct}%"><i style="width:${morPct}%;background:#7fbf6a"></i></span></span></div>`
  );
}
