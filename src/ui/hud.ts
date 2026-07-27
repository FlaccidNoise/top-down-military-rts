import { EMPLACEMENTS, VEHICLES, WEAPONS, type EmplacementDef, type VehicleDef, type WeaponDef } from '../sim/data';
import { crewNear, loadsReady, type Emplacement } from '../sim/emplacement';
import { BALK_HINT, canArm, ORDER_AFFORDANCE, type ArmTarget, type OrderAffordance } from './order-data';
import type { OrderKind } from '../sim/orders';
import { canBreachByHand, type Sim, type Soldier, type Squad, type Vehicle } from '../sim/sim';
import { objectiveStripText, type ObjectiveData } from './objective-strip';
import { formatBinding, loadKeymap, type Keymap } from './keymap';
import { MOBILE } from '../render/view';

export const STATE_COLOR = { steady: '#7fbf6a', shaken: '#e0c060', pinned: '#e08a3c', broken: '#d05c50' } as const;
export const TEAM = { blue: '#5b9bd5', red: '#d05c50' } as const;
const ORDER_KINDS: OrderKind[] = ['move', 'fast', 'sneak', 'fire', 'smoke', 'defend', 'ambush', 'assault'];

export interface HudCallbacks {
  selectSquad(id: number): void;
  selectVehicle(id: number): void;
  panToSoldier(id: number): void;
  inspectSoldier(id: number): void;
  callBarrage(): void;
  callAirstrike(): void;
  togglePause(): void;
  armOrder(kind: OrderKind): void;
  deployEmplacement(): void;
  packEmplacement(): void;
  wheelEmplacement(): void;
  fireEmplacement(): void;
  smokeEmplacement(): void;
  breachTarget(): void;
  mountVehicle(): void;
  dismountVehicle(): void;
  hitchVehicle(): void;
  unhitchVehicle(): void;
  // Touch-bar only. A phone has no shift key, no drag-with-a-second-button and
  // no Esc, so each modifier the desktop path reads off the keyboard becomes a
  // sticky mode with a visible chip.
  toggleBoxMode(): void;
  toggleAddMode(): void;
  selectAll(): void;
  cancel(): void;
  openMenu(): void;
}

export interface HudState {
  selectedSquad: number;
  selectedSquads: number[];
  selectedTeam: number; // -1 = whole squad, else narrowed to one team within it
  selectedVehicle: number;
  paused: boolean;
  aiControl: boolean;
  targetMode: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke' | 'breach';
  armedOrder: OrderKind | null;
  title: string;
  keymap: Keymap;
  objective: ObjectiveData | null;
  floorFocus?: number; // -1/undefined = all floors; 0..maxStories-1 = focus active
  boxMode?: boolean; // touch: drag draws a selection box instead of panning
  addMode?: boolean; // touch: sticky shift (add to selection / force squad order)
}

// Blue squads currently fighting on foot; mounted crews surface as vehicle cards.
export function infantrySquads(sim: Sim): Squad[] {
  return sim.squads.filter((q) => q.side === 'blue' && q.soldierIds.some((id) => sim.soldiers[id].inVehicle < 0));
}

// The Emplacement a squad's crew serves, if any — a crew squad is a normal
// squad (spec's "same data shape, no special cases"), so context-action
// buttons key off this lookup rather than a separate selection concept.
export function emplacementOf(sim: Sim, squadId: number): Emplacement | null {
  if (squadId < 0) return null;
  return sim.emplacements.find((e) => sim.teams[e.crewTeamId]?.squadId === squadId) ?? null;
}

const CTX_ACTIONS: Record<string, keyof HudCallbacks> = {
  deploy: 'deployEmplacement',
  pack: 'packEmplacement',
  wheel: 'wheelEmplacement',
  fire: 'fireEmplacement',
  smoke: 'smokeEmplacement',
  breach: 'breachTarget',
  mount: 'mountVehicle',
  dismount: 'dismountVehicle',
  hitch: 'hitchVehicle',
  unhitch: 'unhitchVehicle',
};

const BARS_LEGEND = '<div class="bars-key"><i class="sw sup"></i>suppression<i class="sw mor"></i>morale</div>';

function primarySquad(st: HudState): number {
  return st.selectedSquads.length > 0 ? st.selectedSquads[st.selectedSquads.length - 1] : st.selectedSquad;
}

export class Hud {
  readonly root: HTMLDivElement;
  private sig = '';
  private lastSel = ''; // selectedSquad|selectedVehicle at last render — gates auto-scroll to "on change" only
  private km: Keymap;
  private lastSim?: Sim;
  private lastSt?: HudState;
  private tipEl: HTMLDivElement;
  private tipTimer: ReturnType<typeof setTimeout> | null = null;
  private ml: HTMLDivElement; // #modeline — moved to body so it works in both modes
  private idleTicks = 0;
  private idleShown = false;
  private lastIdleMode: 'battle' | 'strategic' = 'battle';
  private tb: HTMLDivElement | null = null; // #touchbar — mobile only
  private lpFired = false; // a long-press opened the affordance card; swallow its click

  constructor(cb: HudCallbacks) {
    this.km = loadKeymap(localStorage);
    const fb = formatBinding;
    const b = this.km.bindings;
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="topbar">
        <div class="panel" id="tb-title"></div>
        <div class="panel" id="tb-strength"></div>
        <div id="tb-actions">
          <button class="hbtn" data-act="barrage" title="${fb(b.barrage)}"></button>
          <button class="hbtn" data-act="air" title="${fb(b.airstrike)}"></button>
          <button class="hbtn" data-act="pause" title="${fb(b.pause)}"></button>
        </div>
      </div>
      <div id="obj-strip"></div>
      <div id="squads"></div>
      <div id="banner"></div>
      <div id="hint">
        <span class="hg">scroll zoom · WASD pan · drag box-select · ⇧click add · right-click move · right-drag formation</span>
        <span class="hg">${fb(b.squad1)}-${fb(b.squad9)} squad · ${fb(b.order1)}-${fb(b.order8)} order kind, right-click issues · ${fb(b.barrage)} barrage · ${fb(b.airstrike)} airstrike · ${fb(b.pause)} pause · ${fb(b.cancel)} widen/cancel · ${fb(b.menu)} menu</span>
      </div>`;
    document.body.appendChild(this.root);

    this.ml = document.createElement('div');
    this.ml.id = 'modeline';
    this.ml.className = 'panel';
    this.ml.style.display = 'none';
    document.body.appendChild(this.ml);

    this.tipEl = document.createElement('div');
    this.tipEl.className = 'affordance-tip panel';
    this.tipEl.style.display = 'none';
    document.body.appendChild(this.tipEl);

    this.q('#tb-actions').addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'barrage') cb.callBarrage();
      else if (act === 'air') cb.callAirstrike();
      else if (act === 'pause') cb.togglePause();
    });
    this.q('#squads').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-soldier]');
      if (row) {
        cb.panToSoldier(Number(row.dataset.soldier));
        return cb.inspectSoldier(Number(row.dataset.soldier));
      }
      const ord = t.closest<HTMLElement>('[data-order]');
      if (ord) return cb.armOrder(ord.dataset.order as OrderKind);
      const ctx = t.closest<HTMLButtonElement>('[data-ctx]');
      if (ctx && !ctx.disabled) return (cb[CTX_ACTIONS[ctx.dataset.ctx!]] as () => void)();
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
    this.q('#squads').addEventListener('mouseover', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-order]');
      if (btn && !(btn as HTMLButtonElement).disabled) this.showAffordance(btn);
    });
    this.q('#squads').addEventListener('mouseout', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-order]');
      if (btn) this.hideAffordance();
    });
    this.q('#squads').addEventListener('mouseleave', () => this.hideAffordance());
    if (MOBILE) this.buildTouchbar(cb);
  }

  // The phone's whole control surface: row 1 arms an order kind (the same
  // ORDER_KINDS / canArm / data-order contract the desktop `.orderbar` uses,
  // so arming still flows through cb.armOrder), row 2 carries the modifiers
  // and globals that only exist as keys on desktop. Row 1 is only rendered
  // when a squad is selected — a phone cannot spare 44px of height to show
  // eight chips that would do nothing if tapped.
  private buildTouchbar(cb: HudCallbacks): void {
    const bar = document.createElement('div');
    bar.id = 'touchbar';
    bar.innerHTML =
      '<div class="tb-orders"></div>' +
      '<div class="tb-acts">' +
      '<button class="hbtn" data-tb="roster">☰ Roster</button>' +
      '<button class="hbtn" data-tb="select">▭ Select</button>' +
      '<button class="hbtn" data-tb="add">＋ Add</button>' +
      '<button class="hbtn" data-tb="all">All</button>' +
      '<button class="hbtn" data-tb="cancel">✕ Cancel</button>' +
      '<button class="hbtn" data-tb="barrage"></button>' +
      '<button class="hbtn" data-tb="air"></button>' +
      '<button class="hbtn" data-tb="pause"></button>' +
      '<button class="hbtn" data-tb="menu">⚙</button>' +
      '</div>';
    this.root.appendChild(bar);
    this.tb = bar;

    bar.addEventListener('click', (e) => {
      if (this.lpFired) { this.lpFired = false; return; }
      const t = e.target as HTMLElement;
      const ord = t.closest<HTMLButtonElement>('[data-order]');
      if (ord) { if (!ord.disabled) cb.armOrder(ord.dataset.order as OrderKind); return; }
      const btn = t.closest<HTMLButtonElement>('[data-tb]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.tb) {
        case 'roster': this.toggleRoster(); break;
        case 'select': cb.toggleBoxMode(); break;
        case 'add': cb.toggleAddMode(); break;
        case 'all': cb.selectAll(); break;
        case 'cancel': cb.cancel(); break;
        case 'barrage': cb.callBarrage(); break;
        case 'air': cb.callAirstrike(); break;
        case 'pause': cb.togglePause(); break;
        case 'menu': cb.openMenu(); break;
      }
    });

    // Long-press an order chip for the affordance card — the mobile stand-in
    // for the hover the desktop path uses. A finger that wanders is scrolling
    // the chip row, not asking a question, so any move cancels it.
    let lpTimer = 0;
    let lpAt = { x: 0, y: 0 };
    const cancelLp = (): void => { if (lpTimer) clearTimeout(lpTimer); lpTimer = 0; };
    bar.addEventListener('pointerdown', (e) => {
      this.hideAffordanceNow();
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-order]');
      if (!btn || btn.disabled) return;
      this.lpFired = false;
      lpAt = { x: e.clientX, y: e.clientY };
      lpTimer = window.setTimeout(() => {
        lpTimer = 0;
        this.lpFired = true;
        this.showAffordance(btn);
      }, 480);
    });
    bar.addEventListener('pointermove', (e) => {
      if (lpTimer && Math.hypot(e.clientX - lpAt.x, e.clientY - lpAt.y) > 10) cancelLp();
    });
    bar.addEventListener('pointerup', cancelLp);
    bar.addEventListener('pointercancel', cancelLp);
  }

  /** Bottom-sheet roster: the ☰ chip is the only way in or out on a phone. */
  toggleRoster(): void {
    this.q('#squads').classList.toggle('open');
    this.sig = ''; // chip active-state is part of the touchbar render
  }

  closeRoster(): void {
    this.q('#squads').classList.remove('open');
  }

  get rosterOpen(): boolean {
    return this.q('#squads').classList.contains('open');
  }

  setKeymap(km: Keymap): void {
    this.km = km;
    if (this.lastSim && this.lastSt) this.update(this.lastSim, this.lastSt);
  }

  private showAffordance(btn: HTMLElement): void {
    const kind = btn.dataset.order as OrderKind;
    const a: OrderAffordance = ORDER_AFFORDANCE[kind];
    const issue = MOBILE ? 'press and hold the ground to issue' : 'right-click to issue';
    this.tipEl.innerHTML = `<div class="at-name">${a.name}</div><div class="at-when">${a.when}</div><div class="at-compliance">${a.complianceNote}</div><div class="at-hotkey">${MOBILE ? '' : `${a.hotkey} · `}${issue}</div>`;
    this.tipEl.style.display = 'block';
    const r = btn.getBoundingClientRect();
    // The card is a fixed 190px wide and anchors to the chip's left edge; on a
    // 390px screen a chip scrolled to the right would hang off the viewport.
    this.tipEl.style.left = `${Math.max(6, Math.min(r.left, innerWidth - 198))}px`;
    this.tipEl.style.top = `${r.top - this.tipEl.offsetHeight - 6}px`;
    if (MOBILE) {
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTimer = setTimeout(() => { this.tipEl.style.display = 'none'; }, 2600);
    }
  }

  private hideAffordance(): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => { this.tipEl.style.display = 'none'; }, 80);
  }

  private hideAffordanceNow(): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = null;
    this.tipEl.style.display = 'none';
  }

  private q(sel: string): HTMLElement {
    return this.root.querySelector(sel)!;
  }

  update(sim: Sim, st: HudState): void {
    this.lastSim = sim;
    this.lastSt = st;
    const sig = `${(sim.tick / 5) | 0}|${primarySquad(st)}|${st.selectedTeam}|${st.selectedVehicle}|${st.paused}|${st.targetMode}|${st.armedOrder}|${sim.winner}|${st.title}|${st.selectedSquads.join(',')}|${this.km.version}|${st.floorFocus ?? -1}|${st.aiControl}|${st.boxMode ?? false}|${st.addMode ?? false}|${this.tb ? this.rosterOpen : false}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.renderTop(sim, st);
    this.renderObjectiveStrip(sim, st);
    this.renderSquads(sim, st);
    this.renderHint();
    if (this.tb) this.renderTouchbar(sim, st);

    const cancelKey = formatBinding(this.km.bindings.cancel);
    if (st.targetMode) {
      this.ml.style.display = 'block';
      this.ml.classList.remove('idle-hint');
      this.idleShown = false;
      if (st.targetMode === 'barrage') this.ml.textContent = `MORTAR BARRAGE — click target · 12 rounds · first impact ~20 s · ${cancelKey} cancels`;
      if (st.targetMode === 'air') this.ml.textContent = `AIR STRIKE — click target · strafe runs W→E · inbound ~25 s · ${cancelKey} cancels`;
      if (st.targetMode === 'wheel') this.ml.textContent = `WHEEL GUN — click destination · ${cancelKey} cancels`;
      if (st.targetMode === 'empfire') this.ml.textContent = `MORTAR FIRE — click target · ${cancelKey} cancels`;
      if (st.targetMode === 'empsmoke') this.ml.textContent = `MORTAR SMOKE — click target · 4 rounds · ${cancelKey} cancels`;
      if (st.targetMode === 'breach') this.ml.textContent = `BREACH — click a wall · one aimed round opens it · ${cancelKey} cancels`;
    } else if (!this.idleShown) {
      this.ml.style.display = 'none';
    }

    const banner = this.q('#banner');
    banner.style.display = sim.winner ? 'block' : 'none';
    if (sim.winner) {
      banner.style.color = TEAM[sim.winner];
      banner.innerHTML = `${sim.winner === 'blue' ? 'US VICTORY' : 'GERMAN VICTORY'}<small>debrief incoming…</small>`;
    }
  }

  /** Called every frame from main.ts in both modes. active = something selected / targetMode / paused. */
  updateIdle(mode: 'battle' | 'strategic', active: boolean): void {
    if (active) {
      this.idleTicks = 0;
      if (this.idleShown) {
        this.ml.classList.remove('idle-hint');
        this.ml.style.display = 'none';
        this.idleShown = false;
      }
      return;
    }
    this.idleTicks++;
    if (this.idleTicks > 300 && !this.idleShown) {
      this.lastIdleMode = mode;
      this.ml.textContent = this.idleText(mode);
      this.ml.classList.add('idle-hint');
      this.ml.style.display = 'block';
      this.idleShown = true;
    } else if (this.idleShown && this.lastIdleMode !== mode) {
      this.lastIdleMode = mode;
      this.ml.textContent = this.idleText(mode);
    }
  }

  // Naming keys to a player holding a phone is worse than saying nothing.
  private idleText(mode: 'battle' | 'strategic'): string {
    if (MOBILE) {
      return mode === 'battle'
        ? 'tap a soldier to select · drag to pan · pinch to zoom · press and hold to order'
        : 'tap a chit · press and hold a cell to move · ▶ starts the clock';
    }
    const fb = formatBinding;
    const b = this.km.bindings;
    return mode === 'battle'
      ? `select a squad [${fb(b.squad1)}-${fb(b.squad9)}] · drag to pan · scroll to zoom · ${fb(b.barrage)} barrage`
      : 'click a chit · right-click to move · 1/2/3 speed · Esc menu';
  }

  private renderHint(): void {
    const fb = formatBinding;
    const b = this.km.bindings;
    this.q('#hint').innerHTML =
      `<span class="hg">scroll zoom · ${fb(b.panUp)}${fb(b.panLeft)}${fb(b.panDown)}${fb(b.panRight)} pan · drag box-select · ⇧click add · right-click move · right-drag formation</span>` +
      `<span class="hg">${fb(b.squad1)}-${fb(b.squad9)} squad · ${fb(b.order1)}-${fb(b.order8)} order kind, right-click issues · ${fb(b.barrage)} barrage · ${fb(b.airstrike)} airstrike · ${fb(b.pause)} pause · ${fb(b.cancel)} widen/cancel · ${fb(b.menu)} menu</span>`;
  }

  private renderTouchbar(sim: Sim, st: HudState): void {
    const bar = this.tb!;
    const primary = primarySquad(st);
    const hasSquad = primary >= 0 && st.selectedVehicle < 0;
    const orders = bar.querySelector<HTMLElement>('.tb-orders')!;
    orders.style.display = hasSquad ? '' : 'none';
    orders.innerHTML = hasSquad ? orderChips(st, this.km, emplacementOf(sim, primary) ? 'crew' : 'squad') : '';

    const tb = (name: string) => bar.querySelector<HTMLButtonElement>(`[data-tb="${name}"]`)!;
    const barrage = tb('barrage');
    barrage.innerHTML = `☄ ×${sim.barragesLeft.blue}`;
    barrage.disabled = sim.barragesLeft.blue <= 0;
    barrage.classList.toggle('active', st.targetMode === 'barrage');
    const air = tb('air');
    air.innerHTML = `✈ ×${sim.airstrikesLeft.blue}`;
    air.disabled = sim.airstrikesLeft.blue <= 0;
    air.classList.toggle('active', st.targetMode === 'air');
    tb('pause').textContent = st.paused ? '▶ Play' : '⏸ Pause';
    tb('pause').classList.toggle('active', st.paused);
    tb('select').classList.toggle('active', !!st.boxMode);
    tb('add').classList.toggle('active', !!st.addMode);
    tb('roster').classList.toggle('active', this.rosterOpen);
  }

  private renderObjectiveStrip(sim: Sim, st: HudState): void {
    const el = this.q('#obj-strip');
    if (!st.objective) {
      el.style.display = 'none';
      return;
    }
    let blue = 0;
    let red = 0;
    for (const s of sim.soldiers) {
      if (!s.alive || s.downed) continue;
      if (s.side === 'blue') blue++;
      else if (sim.soldierVisibleTo('blue', s)) red++;
    }
    const bFloor = Math.max(2, Math.round(sim.startStrength.blue * 0.25));
    const rFloor = Math.max(2, Math.round(sim.startStrength.red * 0.25));
    const r = objectiveStripText(st.objective, blue, red, bFloor, rFloor);
    if (!r) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.innerHTML =
      `<div class="obj-left"><span class="obj-kind">${r.label}</span></div>` +
      `<div class="obj-center">${r.condition}</div>` +
      `<div class="obj-right">` +
        `<span class="obj-bar-label us">US ${r.friendlyBar.value}</span>` +
        `<span class="obj-bar"><i style="width:${Math.round((r.friendlyBar.value / Math.max(r.friendlyBar.max, 1)) * 100)}%;background:var(--state-${r.friendlyBar.state})"></i></span>` +
        `<span class="obj-bar-label ge">GE ${sim.fowDisabled ? '' : '~'}${r.enemyBar.value}</span>` +
        `<span class="obj-bar"><i style="width:${Math.round((r.enemyBar.value / Math.max(r.enemyBar.max, 1)) * 100)}%;background:var(--state-${r.enemyBar.state})"></i></span>` +
      `</div>`;
  }

  private renderTop(sim: Sim, st: HudState): void {
    const secs = Math.floor(sim.tick / 30);
    const clock = `T+${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    let us = 0;
    let ge = 0; // fog of war: only the enemies we currently see
    for (const s of sim.soldiers) {
      if (!s.alive || s.downed) continue;
      if (s.side === 'blue') us++;
      else if (sim.soldierVisibleTo('blue', s)) ge++;
    }
    this.q('#tb-title').innerHTML = `<b>${st.title}</b> · ${clock}${st.paused ? ' <span class="paused">⏸ PAUSED</span>' : ''}${st.aiControl ? ' <span class="paused">AI CONTROL</span>' : ''}${st.floorFocus !== undefined && st.floorFocus >= 0 ? ` <span class="paused">⬒ ${st.floorFocus === 0 ? 'Ground' : `Floor ${st.floorFocus + 1}`} only</span>` : ''}`;
    this.q('#tb-strength').innerHTML =
      `<span class="us">US ${us}</span><div class="ratio"><i style="flex:${us};background:#5b9bd5"></i><i style="flex:${ge};background:#d05c50"></i></div><span class="ge">GE ${sim.fowDisabled ? '' : '~'}${ge}</span>`;

    const btn = (act: string) => this.q(`[data-act="${act}"]`) as HTMLButtonElement;
    const f = formatBinding;
    btn('barrage').title = f(this.km.bindings.barrage);
    btn('air').title = f(this.km.bindings.airstrike);
    btn('pause').title = f(this.km.bindings.pause);
    const barrage = btn('barrage');
    barrage.innerHTML = `☄ Barrage ×${sim.barragesLeft.blue} <span class="hk-top">${f(this.km.bindings.barrage)}</span>`;
    barrage.disabled = sim.barragesLeft.blue <= 0;
    barrage.classList.toggle('active', st.targetMode === 'barrage');
    const air = btn('air');
    air.innerHTML = `✈ Airstrike ×${sim.airstrikesLeft.blue} <span class="hk-top">${f(this.km.bindings.airstrike)}</span>`;
    air.disabled = sim.airstrikesLeft.blue <= 0;
    air.classList.toggle('active', st.targetMode === 'air');
    btn('pause').innerHTML = `${st.paused ? '▶ Resume' : '⏸ Pause'} <span class="hk-top">${f(this.km.bindings.pause)}</span>`;
  }

  private renderSquads(sim: Sim, st: HudState): void {
    const cards: string[] = [];
    for (const v of sim.vehicles) {
      if (v.side !== 'blue') continue;
      const crew = v.crewIds.map((id) => sim.soldiers[id]);
      const aliveCrew = crew.filter((c) => c.alive).length;
      const burnChip = v.alive && v.burning ? ' <span style="color:#d05c50">BURNING</span>' : '';
      const ammoLine = v.alive ? `<span class="veh-ammo">AP ${v.ammo.ap} · HE ${v.ammo.he}</span>` : '';
      const extra = (burnChip || ammoLine) ? `<div class="veh-extra">${burnChip}${burnChip && ammoLine ? ' · ' : ''}${ammoLine}</div>` : '';
      const sel = v.id === st.selectedVehicle;
      const rows = sel && v.alive ? vehicleContext(sim, v) : '';
      cards.push(
        `<div class="card panel${sel ? ' sel' : ''}" data-vehicle="${v.id}" tabindex="0" role="button">` +
          `<div class="card-head"><b>${VEHICLES[v.kind].name}</b><span class="n">${v.alive ? `crew ${aliveCrew}/${crew.length}` : 'DESTROYED'}</span></div>${extra}${rows}</div>`,
      );
    }
    // Rifle squads (2 teams) vs. crewed weapons/scout squads (1 team, the
    // TO&E's mortar/MG/zooka/sniper-scout slots) — same Squad shape, split by
    // team count so the 18-squad roster fits under a "WEAPONS" divider
    // instead of one long undifferentiated list.
    const infantry = infantrySquads(sim);
    const rifleSquads = infantry.filter((q) => q.teamIds.length > 1);
    const weaponSquads = infantry.filter((q) => q.teamIds.length === 1);
    for (const q of rifleSquads) cards.push(squadCard(sim, q, st, this.km));
    if (weaponSquads.length) cards.push('<div class="wpn-divider">WEAPONS</div>');
    for (const q of weaponSquads) cards.push(squadCard(sim, q, st, this.km));

    const panel = this.q('#squads');
    // innerHTML rebuild destroys keyboard focus (sig rebuilds run every 5 ticks
    // while unpaused) — re-focus the same entity's element afterwards.
    const focused =
      document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)
        ? document.activeElement.closest<HTMLElement>('[data-squad],[data-vehicle],[data-soldier]')
        : null;
    const focusSel = focused
      ? ['data-squad', 'data-vehicle', 'data-soldier']
          .filter((a) => focused.hasAttribute(a))
          .map((a) => `[${a}="${focused.getAttribute(a)}"]`)
          .join('')
      : '';
    panel.innerHTML = cards.join('');
    if (focusSel) panel.querySelector<HTMLElement>(focusSel)?.focus();

    // Auto-scroll only on an actual selection change, not on every sig
    // rebuild (which also fires every 5 ticks while unpaused) — otherwise
    // this would fight a player manually scrolling the roster.
    const selKey = `${primarySquad(st)}|${st.selectedVehicle}`;
    if (selKey !== this.lastSel) {
      this.lastSel = selKey;
      panel.querySelector('.card.sel')?.scrollIntoView({ block: 'nearest' });
      // A phone sheet that stays open after a selection buries the ground the
      // next order has to be given on. Selecting is the end of the roster's job.
      if (this.tb) panel.classList.remove('open');
    }
  }
}

function squadCard(sim: Sim, sq: Squad, st: HudState, km: Keymap): string {
  const men = sq.soldierIds.map((id) => sim.soldiers[id]);
  const isPrimary = sq.id === primarySquad(st);
  const sel = st.selectedSquads.includes(sq.id) || (st.selectedSquads.length === 0 && sq.id === st.selectedSquad);
  const dots = men
    .map((m) => {
      const c = !m.alive ? '#4a4a3e' : m.downed ? '#d05c50' : STATE_COLOR[m.mental];
      const label = !m.alive ? 'KIA' : m.downed ? 'DOWN' : m.mental.toUpperCase();
      return `<i title="${m.name} — ${label}" style="${m.alive && m.downed ? `border:1px solid ${c}` : `background:${c}`}"></i>`;
    })
    .join('');
  // squad-aggregate ammo
  let squadAmmo = '';
  {
    let total = 0, max = 0;
    for (const m of men) { total += Object.values(m.ammo).reduce((a, n) => a + (n ?? 0), 0); max += m.ammoStart; }
    if (max > 0) squadAmmo = `<span class="sam-chip">Ammo ${total}/${max}</span>`;
  }
  const showLegend = isPrimary && men.some((m) => m.alive && !m.downed);
  const emp = isPrimary ? emplacementOf(sim, sq.id) : null;
  const target: ArmTarget = isPrimary ? (emp ? 'crew' : 'squad') : 'squad';
  // balk chip
  let balkChip = '';
  if (isPrimary) {
    for (const tid of sq.teamIds) {
      const os = sim.teams[tid].orderState;
      if (os.phase === 'balked' && os.order) {
        balkChip = `<div class="balk-chip">${BALK_HINT[os.order.kind]}</div>`;
        break;
      }
    }
  }
  const empStateRow = emp ? emplacementStateRow(sim, emp) : '';
  const focus = isPrimary && st.selectedTeam >= 0 ? `<div class="focus">Team: ${sim.teams[st.selectedTeam]?.name ?? ''} <i>(esc widens)</i></div>` : '';
  const rows = isPrimary
    ? focus + balkChip + orderBar(st, km, target) + empStateRow + (emp ? emplacementContext(sim, emp) : squadContext(men)) + (showLegend ? BARS_LEGEND : '') + men.map((m) => soldierRow(m)).join('')
    : '';
  return (
    `<div class="card panel${sel ? ' sel' : ''}" data-squad="${sq.id}" tabindex="0" role="button">` +
    `<div class="card-head"><b>${sq.name}</b>${squadAmmo}<span class="n">${men.filter((m) => m.alive).length}/${men.length}</span><div class="dots">${dots}</div></div>${rows}</div>`
  );
}

// Context-action row for a plain (non-crew) squad. Today that is just Breach:
// a squad with a rocket launcher in it, or a stashed panzerfaust, gets the same
// wall affordance the tank and the AT gun get. canBreachByHand is the sim's own
// predicate, so the button appears exactly when Sim.orderSquadBreach will bite.
function squadContext(men: Soldier[]): string {
  const armed = men.some((m) => m.alive && !m.downed && m.inVehicle < 0 && canBreachByHand(m));
  return armed ? `<div class="ctxrow"><button class="hbtn" data-ctx="breach">Breach</button></div>` : '';
}

export const reserveAmmo = (s: Soldier): number => Object.values(s.ammo).reduce((a, n) => a + (n ?? 0), 0);

function soldierRow(m: Soldier): string {
  if (!m.alive) return `<div class="srow kia"><span class="chip" style="background:#4a4a3e" title="KIA"></span><span class="nm">${m.name}</span></div>`;
  const wpn = `<span class="wp">${WEAPONS[m.weapon].name}</span>`;
  const ammo = `<span class="am" title="mag/belt left + reserve units">${m.magLeft}+${reserveAmmo(m)}</span>`;
  const cross = m.wounds.length ? `<span class="flag${m.stabilized || m.bleedRate <= 0 ? ' stab' : ''}">✚</span>` : '';
  if (m.downed) {
    return `<div class="srow urgent" data-soldier="${m.id}" tabindex="0" role="button" title="click to inspect ${m.name}"><span class="chip" style="background:#d05c50" title="DOWN"></span><span class="nm">${m.name}</span>${wpn}${cross}<span class="down">DOWN</span></div>`;
  }
  const supPct = Math.round(m.suppression * 100);
  const morPct = Math.round(m.morale * 100);
  return (
    `<div class="srow" data-soldier="${m.id}" tabindex="0" role="button" title="click to inspect ${m.name}"><span class="chip" style="background:${STATE_COLOR[m.mental]}" title="${m.mental.toUpperCase()}"></span>` +
    `<span class="nm">${m.name}</span>${wpn}${ammo}${cross}` +
    `<span class="bars"><span class="bar" title="Suppression ${supPct}%"><i style="width:${supPct}%;background:#e0a83c"></i></span>` +
    `<span class="bar" title="Morale ${morPct}%"><i style="width:${morPct}%;background:#7fbf6a"></i></span></span></div>`
  );
}

function orderChips(st: HudState, km: Keymap, target: ArmTarget): string {
  return ORDER_KINDS.map((k, i) => {
    const bindingKey = `order${i + 1}` as keyof typeof km.bindings;
    const title = formatBinding(km.bindings[bindingKey]);
    const a = ORDER_AFFORDANCE[k];
    const dis = !canArm(k, target) ? ' disabled' : '';
    const armed = st.armedOrder === k ? ' armed' : '';
    return `<button class="hbtn ord${armed}${dis}" data-order="${k}" title="${title}"${dis}>${k}<span class="hk">${a.hotkey}</span></button>`;
  }).join('');
}

function orderBar(st: HudState, km: Keymap, target: ArmTarget): string {
  return `<div class="orderbar">${orderChips(st, km, target)}</div>`;
}

function emplacementStateRow(sim: Sim, e: Emplacement): string {
  const def: EmplacementDef = EMPLACEMENTS[e.kind];
  const dur = e.state === 'deploying' ? def.setupTime : e.state === 'packing' ? def.packTime : 1;
  const pct = Math.round((1 - e.timer / dur) * 100);
  const bar = (e.state === 'deploying' || e.state === 'packing')
    ? `<span class="emp-bar"><i style="width:${pct}%"></i></span>`
    : '';
  const towed = e.towedBy >= 0 ? ` · towed by ${VEHICLES[sim.vehicles[e.towedBy]?.kind]?.name ?? 'vehicle'}` : '';
  return `<div class="emp-state"><span class="emp-label">${def.name} · ${e.state}</span>${bar}<span class="emp-towed">${towed}</span></div>`;
}

// Context-action buttons for a selected emplacement's crew squad: state
// transitions gated the same way Sim.orderDeploy/orderPack already gate
// them, so a disabled button never issues a no-op order.
function emplacementContext(sim: Sim, e: Emplacement): string {
  const def: EmplacementDef = EMPLACEMENTS[e.kind];
  const btns: string[] = [];
  if (e.state === 'packed') {
    const ready = crewNear(sim, e).length >= def.minCrew && loadsReady(sim, e);
    btns.push(`<button class="hbtn" data-ctx="deploy"${ready ? '' : ' disabled'}>Deploy</button>`);
    if (def.wheeled) btns.push(`<button class="hbtn" data-ctx="wheel">Wheel</button>`);
  } else if (e.state === 'deployed') {
    btns.push(`<button class="hbtn" data-ctx="pack">Pack</button>`);
    const w: WeaponDef = WEAPONS[def.weapon];
    if (w.arc) {
      btns.push(`<button class="hbtn" data-ctx="fire">Fire</button>`);
      btns.push(`<button class="hbtn" data-ctx="smoke">Smoke</button>`);
    }
    // Direct-fire AT guns can be pointed at a wall (D5). Same predicate
    // Sim.orderEmplacementBreach gates on, so the button never no-ops.
    if (w.pen !== undefined) btns.push(`<button class="hbtn" data-ctx="breach">Breach</button>`);
  } else {
    btns.push(`<span class="ctxnote">${e.state} · ${Math.ceil(e.timer)}s</span>`);
  }
  return `<div class="ctxrow">${btns.join('')}</div>`;
}

// Context-action buttons for a selected transport/tow vehicle. Hitch/unhitch
// only appear when the sim's own adjacency gate (Sim.orderHitch) would
// actually accept them, so the button never fires a silent no-op.
function vehicleContext(sim: Sim, v: Vehicle): string {
  const def: VehicleDef = VEHICLES[v.kind];
  const btns: string[] = [];
  // A main gun can be pointed at a wall (D5); a halftrack's gunPen 0 cannot.
  if (def.gunPen > 0) btns.push(`<button class="hbtn" data-ctx="breach">Breach</button>`);
  if (def.seats !== undefined) {
    btns.push(`<button class="hbtn" data-ctx="mount">Mount</button>`);
    if (v.passengerTeamIds.length > 0) btns.push(`<button class="hbtn" data-ctx="dismount">Dismount</button>`);
  }
  if (def.towHook) {
    const towing = sim.emplacements.find((e) => e.towedBy === v.id);
    if (towing) {
      btns.push(`<button class="hbtn" data-ctx="unhitch">Unhitch</button>`);
    } else {
      const near = sim.emplacements.some((e) => {
        const edef: EmplacementDef = EMPLACEMENTS[e.kind];
        return e.side === v.side && e.state === 'packed' && e.towedBy < 0 && edef.towable && Math.hypot(e.x - v.x, e.y - v.y) <= 4;
      });
      if (near) btns.push(`<button class="hbtn" data-ctx="hitch">Hitch</button>`);
    }
  }
  return btns.length ? `<div class="ctxrow">${btns.join('')}</div>` : '';
}
