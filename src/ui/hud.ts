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
      <div id="hint">left-drag pan · wheel zoom · click select · right-click move · 1-9 squad · B barrage · A airstrike · space pause · esc cancel</div>`;
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
        `<div class="card panel${v.id === st.selectedVehicle ? ' sel' : ''}" data-vehicle="${v.id}">` +
          `<div class="card-head"><b>${VEHICLES[v.kind].name}</b><span class="n">${status}</span></div></div>`,
      );
    }
    for (const sq of infantrySquads(sim)) {
      const men = sq.soldierIds.map((id) => sim.soldiers[id]);
      const sel = sq.id === st.selectedSquad;
      const dots = men
        .map((m) => {
          const c = !m.alive ? '#4a4a3e' : m.downed ? '#d05c50' : STATE_COLOR[m.mental];
          return `<i style="${m.alive && m.downed ? `border:1px solid ${c}` : `background:${c}`}"></i>`;
        })
        .join('');
      const rows = sel ? men.map((m) => soldierRow(m)).join('') : '';
      cards.push(
        `<div class="card panel${sel ? ' sel' : ''}" data-squad="${sq.id}">` +
          `<div class="card-head"><b>${sq.name}</b><span class="n">${men.filter((m) => m.alive).length}/${men.length}</span></div>` +
          `<div class="dots">${dots}</div>${rows}</div>`,
      );
    }
    this.q('#squads').innerHTML = cards.join('');
  }
}

function soldierRow(m: Soldier): string {
  if (!m.alive) return `<div class="srow kia"><span class="chip" style="background:#4a4a3e"></span><span class="nm">${m.name}</span></div>`;
  const wpn = `<span class="wp">${WEAPONS[m.weapon].name}</span>`;
  const cross = m.wounds.length ? `<span class="flag${m.stabilized || m.bleedRate <= 0 ? ' stab' : ''}">✚</span>` : '';
  if (m.downed) {
    return `<div class="srow" data-soldier="${m.id}"><span class="chip" style="background:#d05c50"></span><span class="nm">${m.name}</span>${wpn}${cross}<span class="down">DOWN</span></div>`;
  }
  return (
    `<div class="srow" data-soldier="${m.id}"><span class="chip" style="background:${STATE_COLOR[m.mental]}"></span>` +
    `<span class="nm">${m.name}</span>${wpn}${cross}` +
    `<span class="bars"><span class="bar"><i style="width:${Math.round(m.suppression * 100)}%;background:#e0a83c"></i></span>` +
    `<span class="bar"><i style="width:${Math.round(m.morale * 100)}%;background:#7fbf6a"></i></span></span></div>`
  );
}
