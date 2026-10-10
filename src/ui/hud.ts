import { EMPLACEMENTS, VEHICLES, WEAPONS, type EmplacementDef, type VehicleDef, type WeaponDef } from '../sim/data';
import { crewNear, friendlyHasLos, loadsReady, type Emplacement } from '../sim/emplacement';
import { balkHint, canArm, ORDER_AFFORDANCE, type ArmTarget, type OrderAffordance } from './order-data';
import type { OrderKind } from '../sim/orders';
import { canBreachByHand, type Sim, type Soldier, type Squad, type Vehicle } from '../sim/sim';
import { battleGoal, goalText, type SideStrength } from './battle-goal';
import { formatBinding, loadKeymap, type Keymap } from './keymap';
import { MOBILE } from '../render/view';
import { patchChildren } from './patch';
import { manAmmo, manStatus, shortNames, squadAmmoLow, type ManStatus } from './roster';
import { placeBubble, visibleRect } from './coach';
import type { BattleSpeed } from './battle-speed';

export const STATE_COLOR = { steady: '#7fbf6a', shaken: '#e0c060', pinned: '#e08a3c', broken: '#d05c50' } as const;

/** What a floor is called anywhere the player reads one. Ground is not "Floor 1". */
export function floorName(level: number): string {
  return level === 0 ? 'Ground' : `Floor ${level + 1}`;
}
export const TEAM = { blue: '#5b9bd5', red: '#d05c50' } as const;
const ORDER_KINDS: OrderKind[] = ['move', 'fast', 'sneak', 'fire', 'smoke', 'defend', 'ambush', 'assault'];
// The order bar shows the four a first battle is won with. The rest sit behind More.
const PRIMARY_ORDERS: OrderKind[] = ['move', 'fire', 'smoke', 'assault'];
const MORE_ORDERS: OrderKind[] = ORDER_KINDS.filter((k) => !PRIMARY_ORDERS.includes(k));

export interface HudCallbacks {
  selectSquad(id: number): void;
  selectVehicle(id: number): void;
  panToSoldier(id: number): void;
  inspectSoldier(id: number): void;
  callBarrage(): void;
  callAirstrike(): void;
  togglePause(): void;
  cycleSpeed(): void;
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
  /** F's floor-focus cycle, which a phone has no key for. */
  cycleFloor(): void;
  openMenu(): void;
  /** The controls card: every binding in one table, behind the ? control. */
  openControls(): void;
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
  /** The quiet-minute line (goal and enemy bearing), or null while the player is giving orders. */
  prompt: string | null;
  speed: BattleSpeed;
  /** Deployment: squads are placed, not ordered, so the order bar stands down. */
  deploy: boolean;
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
  private tb: HTMLDivElement | null = null; // #touchbar — mobile only
  private orderBar!: HTMLDivElement; // #orderbar — both platforms
  private moreOpen = false; // the order bar's second row
  private overOpen = false; // the touch bar's overflow row
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
        <div class="panel" id="obj-strip"></div>
        <div id="tb-actions">
          <button class="hbtn" data-act="barrage" title="${fb(b.barrage)}"></button>
          <button class="hbtn" data-act="air" title="${fb(b.airstrike)}"></button>
          <button class="hbtn" data-act="speed" aria-label="Battle speed"></button>
          <button class="hbtn" data-act="pause" title="${fb(b.pause)}"></button>
          <button class="hbtn" data-act="help" title="Controls" aria-label="Controls">?</button>
        </div>
      </div>
      <div id="squads"></div>
      <div id="banner"></div>`;
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
      else if (act === 'speed') cb.cycleSpeed();
      else if (act === 'pause') cb.togglePause();
      else if (act === 'help') cb.openControls();
    });
    this.q('#squads').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-soldier]');
      if (row) {
        cb.panToSoldier(Number(row.dataset.soldier));
        return cb.inspectSoldier(Number(row.dataset.soldier));
      }
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
    if (MOBILE) this.buildTouchbar(cb);
    this.buildOrderBar(cb);
  }

  // The one order bar, on both platforms and outside the roster: the four
  // orders a new player needs, the other four behind More. Arming still goes
  // through cb.armOrder, so the armed-order state machine and its keys are
  // untouched. It shows only with a squad selected: chips that would do
  // nothing if pressed are noise.
  private buildOrderBar(cb: HudCallbacks): void {
    const bar = document.createElement('div');
    bar.id = 'orderbar';
    bar.style.display = 'none';
    bar.innerHTML = '<div class="ob-row ob-more"></div><div class="ob-row ob-main"></div>';
    if (this.tb) this.tb.prepend(bar);
    else this.root.appendChild(bar);
    this.orderBar = bar;

    bar.addEventListener('click', (e) => {
      if (this.lpFired) { this.lpFired = false; return; }
      const t = e.target as HTMLElement;
      if (t.closest('[data-ob="more"]')) {
        this.moreOpen = !this.moreOpen;
        this.sig = '';
        return;
      }
      const ord = t.closest<HTMLButtonElement>('[data-order]');
      if (ord && !ord.disabled) cb.armOrder(ord.dataset.order as OrderKind);
    });
    if (!MOBILE) {
      bar.addEventListener('mouseover', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-order]');
        if (btn && !btn.disabled) this.showAffordance(btn);
      });
      bar.addEventListener('mouseout', (e) => {
        if ((e.target as HTMLElement).closest('[data-order]')) this.hideAffordance();
      });
      bar.addEventListener('mouseleave', () => this.hideAffordance());
      return;
    }
    // Long-press an order chip for the affordance card — the mobile stand-in
    // for the hover the desktop path uses. A finger that wanders off the chip
    // is not asking a question, so any move cancels it.
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

  // The phone's control row. Nothing scrolls: Roster and All are always there,
  // Play/Pause, speed and the menu are pinned at the right, and the modifiers
  // and support calls a desktop reads off the keyboard sit one tap away behind
  // ⋯ (jtbug #783: a control in a scrolling row is a control off screen).
  private buildTouchbar(cb: HudCallbacks): void {
    const bar = document.createElement('div');
    bar.id = 'touchbar';
    bar.innerHTML =
      '<div class="tb-over">' +
      '<button class="hbtn" data-tb="help">? Controls</button>' +
      '<button class="hbtn" data-tb="select">▭ Select</button>' +
      '<button class="hbtn" data-tb="add">＋ Add</button>' +
      '<button class="hbtn" data-tb="floor">⬒ Floors</button>' +
      '<button class="hbtn" data-tb="cancel">✕ Cancel</button>' +
      '<button class="hbtn" data-tb="barrage"></button>' +
      '<button class="hbtn" data-tb="air"></button>' +
      '</div>' +
      '<div class="tb-acts">' +
      '<button class="hbtn" data-tb="roster">☰ Roster</button>' +
      '<button class="hbtn" data-tb="all">All</button>' +
      '<button class="hbtn" data-tb="more" aria-label="More controls">⋯</button>' +
      '<div class="tb-pin">' +
      '<button class="hbtn" data-tb="speed" aria-label="Battle speed"></button>' +
      '<button class="hbtn" data-tb="pause"></button>' +
      '<button class="hbtn" data-tb="menu" aria-label="Menu">⚙</button>' +
      '</div>' +
      '</div>';
    this.root.appendChild(bar);
    this.tb = bar;

    bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tb]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.tb) {
        case 'roster': this.toggleRoster(); break;
        case 'select': cb.toggleBoxMode(); break;
        case 'add': cb.toggleAddMode(); break;
        case 'all': cb.selectAll(); break;
        case 'floor': cb.cycleFloor(); break;
        case 'cancel': cb.cancel(); break;
        case 'barrage': cb.callBarrage(); break;
        case 'air': cb.callAirstrike(); break;
        case 'speed': cb.cycleSpeed(); break;
        case 'pause': cb.togglePause(); break;
        case 'menu': cb.openMenu(); break;
        case 'help': cb.openControls(); break;
        case 'more': this.overOpen = !this.overOpen; break;
      }
      // One pick and the overflow folds away: it sits over the map.
      if (btn.closest('.tb-over')) this.overOpen = false;
      this.sig = '';
    });
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
    // Beside the chips' own panel, never on it: the card used to print over
    // the chips it described. Same placement rule as the tutorial bubble.
    const anchor = visibleRect(btn);
    const panel = btn.closest('#touchbar') ?? btn.closest('#orderbar');
    if (!anchor) return this.hideAffordanceNow();
    const root = document.documentElement;
    const p = placeBubble(anchor, (panel && visibleRect(panel)) ?? anchor, this.tipEl.offsetWidth, this.tipEl.offsetHeight, { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight });
    this.tipEl.style.left = `${Math.round(p.left)}px`;
    this.tipEl.style.top = `${Math.round(p.top)}px`;
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
    const sig = `${(sim.tick / 5) | 0}|${st.prompt}|${primarySquad(st)}|${st.selectedTeam}|${st.selectedVehicle}|${st.paused}|${st.targetMode}|${st.armedOrder}|${sim.winner}|${st.title}|${st.speed}|${st.selectedSquads.join(',')}|${this.km.version}|${st.floorFocus ?? -1}|${st.aiControl}|${st.boxMode ?? false}|${st.addMode ?? false}|${this.tb ? this.rosterOpen : false}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.renderTop(sim, st);
    this.renderGoal(sim);
    this.renderSquads(sim, st);
    this.renderOrderBar(sim, st);
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
    } else if (st.prompt) {
      this.ml.style.display = 'block';
      this.ml.classList.remove('idle-hint');
      this.idleShown = false;
      this.ml.textContent = st.prompt;
    } else if (!this.idleShown) {
      this.ml.style.display = 'none';
    }

    const banner = this.q('#banner');
    banner.style.display = sim.winner ? 'block' : 'none';
    if (sim.winner) {
      // Centred on the map the player can see, not on the canvas: the roster
      // owns the left of a desktop screen.
      const roster = this.q('#squads').getBoundingClientRect();
      banner.style.left = `${!this.tb && roster.width > 0 ? Math.round(roster.right) : 0}px`;
      banner.style.color = TEAM[sim.winner];
      banner.innerHTML = `${sim.winner === 'blue' ? 'US VICTORY' : 'GERMAN VICTORY'}<small>debrief incoming…</small>`;
    }
  }

  /** Called every strategic frame. active = something selected, or the clock is stopped. */
  updateIdle(active: boolean): void {
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
      // Naming keys to a player holding a phone is worse than saying nothing.
      this.ml.textContent = MOBILE
        ? 'tap a chit · press and hold a cell to move · ▶ starts the clock'
        : 'click a chit · right-click to move · 1/2/3 speed · Esc menu';
      this.ml.classList.add('idle-hint');
      this.ml.style.display = 'block';
      this.idleShown = true;
    }
  }

  private renderOrderBar(sim: Sim, st: HudState): void {
    const bar = this.orderBar;
    const primary = primarySquad(st);
    const show = primary >= 0 && st.selectedVehicle < 0 && !st.deploy;
    bar.style.display = show ? '' : 'none';
    if (!show) {
      this.moreOpen = false;
      return;
    }
    const target: ArmTarget = emplacementOf(sim, primary) ? 'crew' : 'squad';
    // An armed order is always on screen: one of the four behind More, armed
    // by its key, opens the row.
    const open = this.moreOpen || (st.armedOrder !== null && MORE_ORDERS.includes(st.armedOrder));
    patchChildren(
      bar.querySelector('.ob-main')!,
      orderChips(PRIMARY_ORDERS, st, this.km, target) +
        `<button class="hbtn ob-toggle${open ? ' active' : ''}" data-ob="more" aria-expanded="${open}">More</button>`,
    );
    patchChildren(bar.querySelector('.ob-more')!, open ? orderChips(MORE_ORDERS, st, this.km, target) : '');
  }

  private renderTouchbar(sim: Sim, st: HudState): void {
    const bar = this.tb!;
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
    tb('speed').textContent = `${st.speed}×`;
    tb('speed').classList.toggle('active', st.speed > 1);
    tb('select').classList.toggle('active', !!st.boxMode);
    tb('add').classList.toggle('active', !!st.addMode);
    tb('roster').classList.toggle('active', this.rosterOpen);
    bar.querySelector('.tb-over')!.classList.toggle('open', this.overOpen);
    // The floor chip is F's only home on a phone. A map with nothing taller
    // than a shed has no floors to cycle, so it does not appear at all.
    const floor = tb('floor');
    const focus = st.floorFocus ?? -1;
    floor.style.display = sim.map.maxStories >= 2 ? '' : 'none';
    floor.textContent = focus < 0 ? '⬒ Floors' : `⬒ ${floorName(focus)}`;
    floor.classList.toggle('active', focus >= 0);
    // Folded away, the overflow still says when something inside it is live.
    tb('more').classList.toggle('active', this.overOpen || !!st.boxMode || !!st.addMode || focus >= 0 || st.targetMode === 'barrage' || st.targetMode === 'air');
  }

  // The goal strip: what wins the battle, and how far off it is. Fed from the
  // sim alone, so every battle shows it whichever campaign staged it.
  private renderGoal(sim: Sim): void {
    const el = this.q('#obj-strip');
    const g = battleGoal(sim);
    if (!g) {
      el.style.display = 'none';
      return;
    }
    // Fill is the share of starting strength still fighting; the tick is the
    // line the side breaks at. Team colours, and the player's own bar warns
    // when it nears its line.
    const bar = (s: SideStrength, color: string): string =>
      `<span class="obj-bar"><i style="width:${Math.round((s.now / s.start) * 100)}%;background:${color}"></i>` +
      `<b style="left:${Math.round((s.breakAt / s.start) * 100)}%"></b></span>`;
    const own = g.own.state === 'steady' || g.own.state === 'shaken' ? TEAM.blue : STATE_COLOR[g.own.state];
    // Under fog the enemy is a coarse read, never a count (battle-goal.ts).
    const e = g.enemy;
    const enemy = e.exact
      ? `GE ${e.strength.now} <em>\u2192 ${e.strength.breakAt}</em>${bar(e.strength, TEAM.red)}`
      : `GE <span class="obj-segs">${'<i class="on"></i>'.repeat(e.lit)}${'<i></i>'.repeat(e.of - e.lit)}</span><em>${e.word}</em>`;
    el.style.display = '';
    el.setAttribute('aria-label', goalText(g));
    el.innerHTML =
      `<span class="obj-kind">${g.label}</span>` +
      `<span class="obj-side ge">${enemy}</span>` +
      `<span class="obj-side us" title="You break at ${g.own.breakAt}">US ${g.own.now}${bar(g.own, own)}</span>`;
  }

  private renderTop(sim: Sim, st: HudState): void {
    const secs = Math.floor(sim.tick / 30);
    const clock = `T+${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    this.q('#tb-title').innerHTML = `<b>${st.title}</b><span class="tb-clock">· ${clock}${st.paused ? ' <span class="paused">⏸ PAUSED</span>' : ''}${st.aiControl ? ' <span class="paused">AI CONTROL</span>' : ''}${st.floorFocus !== undefined && st.floorFocus >= 0 ? ` <span class="paused">⬒ ${floorName(st.floorFocus)} only</span>` : ''}</span>`;
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
    btn('pause').innerHTML = `${st.paused ? '▶ Play' : '⏸ Pause'} <span class="hk-top">${f(this.km.bindings.pause)}</span>`;
    btn('speed').title = f(this.km.bindings.battleSpeed);
    btn('speed').innerHTML = `${st.speed}× <span class="hk-top">${f(this.km.bindings.battleSpeed)}</span>`;
    btn('speed').classList.toggle('active', st.speed > 1);
  }

  private renderSquads(sim: Sim, st: HudState): void {
    const cards: string[] = [];
    for (const v of sim.vehicles) {
      if (v.side !== 'blue') continue;
      const crew = v.crewIds.map((id) => sim.soldiers[id]);
      const aliveCrew = crew.filter((c) => c.alive).length;
      const burnChip = v.alive && v.burning ? '<span class="sam-chip low">BURNING</span>' : '';
      const ammoLine = v.alive ? `<span class="veh-ammo">AP ${v.ammo.ap} · HE ${v.ammo.he}</span>` : '';
      const sel = v.id === st.selectedVehicle;
      // One line like every other card. The rounds left open with the card.
      const extra = sel && ammoLine ? `<div class="veh-extra">${ammoLine}</div>` : '';
      const rows = sel && v.alive ? vehicleContext(sim, v) : '';
      cards.push(
        `<div class="card panel${sel ? ' sel' : ''}" data-vehicle="${v.id}" tabindex="0" role="button">` +
          `<div class="card-head"><b>${VEHICLES[v.kind].name}</b>${burnChip}<span class="n">${v.alive ? `${aliveCrew}/${crew.length}` : 'DESTROYED'}</span></div>${extra}${rows}</div>`,
      );
    }
    // Rifle squads (2 teams) vs. crewed weapons/scout squads (1 team, the
    // TO&E's mortar/MG/zooka/sniper-scout slots) — same Squad shape, split by
    // team count so the 18-squad roster fits under a "WEAPONS" divider
    // instead of one long undifferentiated list.
    const infantry = infantrySquads(sim);
    const names = new Map(shortNames(infantry.map((q) => q.name)).map((n, i) => [infantry[i].id, n]));
    const rifleSquads = infantry.filter((q) => q.teamIds.length > 1);
    const weaponSquads = infantry.filter((q) => q.teamIds.length === 1);
    for (const q of rifleSquads) cards.push(squadCard(sim, q, names.get(q.id)!, st, this.km));
    if (weaponSquads.length) cards.push('<div class="wpn-divider">WEAPONS</div>');
    for (const q of weaponSquads) cards.push(squadCard(sim, q, names.get(q.id)!, st, this.km));

    const panel = this.q('#squads');
    // In place, never innerHTML: this runs every 5 ticks while the battle
    // does, and a card replaced under a pressed mouse button eats the click.
    patchChildren(panel, cards.join(''));

    // Auto-scroll only on an actual selection change, not on every refresh
    // (every 5 ticks while unpaused) — otherwise this would fight a player
    // manually scrolling the roster.
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

// One line per squad: its name, a word only when ammunition is short, the men
// alive and a dot per man. The selected squad opens to its men.
function squadCard(sim: Sim, sq: Squad, name: string, st: HudState, km: Keymap): string {
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
  const ammo = squadAmmoLow(men) ? '<span class="sam-chip low">AMMO LOW</span>' : '';
  const emp = isPrimary ? emplacementOf(sim, sq.id) : null;
  // balk chip
  let balkChip = '';
  if (isPrimary) {
    for (const tid of sq.teamIds) {
      const os = sim.teams[tid].orderState;
      if (os.phase === 'balked' && os.order) {
        balkChip = `<div class="balk-chip">${balkHint(os.order.kind, os.reason)}</div>`;
        break;
      }
    }
  }
  const empStateRow = emp ? emplacementStateRow(sim, emp) : '';
  // A phone has no Esc: the two-finger tap and the Cancel chip widen there.
  const widen = MOBILE ? '' : ` <i>(${formatBinding(km.bindings.cancel)} widens)</i>`;
  const focus = isPrimary && st.selectedTeam >= 0 ? `<div class="focus">Team: ${sim.teams[st.selectedTeam]?.name ?? ''}${widen}</div>` : '';
  const rows = isPrimary
    ? focus + balkChip + empStateRow + (emp ? emplacementContext(sim, emp) : squadContext(men)) + men.map((m) => soldierRow(sim, m)).join('')
    : '';
  return (
    `<div class="card panel${sel ? ' sel' : ''}" data-squad="${sq.id}" tabindex="0" role="button" title="${sq.name}">` +
    `<div class="card-head"><b>${name}</b>${ammo}<span class="n">${men.filter((m) => m.alive).length}/${men.length}</span><div class="dots">${dots}</div></div>${rows}</div>`
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

const STATUS_COLOR: Record<Exclude<ManStatus, ''>, string> = { KIA: '#6a6a5a', DOWN: '#d05c50', BROKEN: STATE_COLOR.broken, PINNED: STATE_COLOR.pinned, SHAKEN: STATE_COLOR.shaken };

// A man: his state colour, name, weapon, and a word only for what is wrong
// with him. Morale and suppression as numbers live in the hover card and the
// health panel a click on the row opens.
function soldierRow(sim: Sim, m: Soldier): string {
  const status = manStatus(m);
  if (status === 'KIA') return `<div class="srow kia"><span class="chip" style="background:#4a4a3e"></span><span class="nm">${m.name}</span><span class="st">KIA</span></div>`;
  const ammo = manAmmo(sim, m);
  const cross = m.wounds.length ? `<span class="flag${m.stabilized || m.bleedRate <= 0 ? ' stab' : ''}">✚</span>` : '';
  return (
    `<div class="srow${status === 'DOWN' ? ' urgent' : ''}" data-soldier="${m.id}" tabindex="0" role="button" title="click to inspect ${m.name}">` +
    `<span class="chip" style="background:${status === 'DOWN' ? '#d05c50' : STATE_COLOR[m.mental]}"></span>` +
    `<span class="nm">${m.name}</span><span class="wp">${WEAPONS[m.weapon].name}</span>` +
    (ammo ? `<span class="am low">${ammo}</span>` : '') +
    cross +
    (status ? `<span class="st${status === 'DOWN' ? ' down' : ''}" style="color:${STATUS_COLOR[status]}">${status}</span>` : '') +
    `</div>`
  );
}

function orderChips(kinds: OrderKind[], st: HudState, km: Keymap, target: ArmTarget): string {
  return kinds.map((k) => {
    const bindingKey = `order${ORDER_KINDS.indexOf(k) + 1}` as keyof typeof km.bindings;
    const title = formatBinding(km.bindings[bindingKey]);
    const a = ORDER_AFFORDANCE[k];
    const dis = !canArm(k, target) ? ' disabled' : '';
    const armed = st.armedOrder === k ? ' armed' : '';
    return `<button class="hbtn ord${armed}${dis}" data-order="${k}" title="${title}"${dis}>${k}<span class="hk">${a.hotkey}</span></button>`;
  }).join('');
}

function emplacementStateRow(sim: Sim, e: Emplacement): string {
  const def: EmplacementDef = EMPLACEMENTS[e.kind];
  const dur = e.state === 'deploying' ? def.setupTime : e.state === 'packing' ? def.packTime : 1;
  const pct = Math.round((1 - e.timer / dur) * 100);
  const bar = (e.state === 'deploying' || e.state === 'packing')
    ? `<span class="emp-bar"><i style="width:${pct}%"></i></span>`
    : '';
  const towed = e.towedBy >= 0 ? ` · towed by ${VEHICLES[sim.vehicles[e.towedBy]?.kind]?.name ?? 'vehicle'}` : '';
  return `<div class="emp-state"><span class="emp-label">${def.name} · ${e.state}</span>${bar}<span class="emp-towed">${towed}</span>${missionRow(sim, e)}</div>`;
}

// A mortar with a fire mission on ground NOBODY can see holds fire — the
// shared-vision rule (friendlyHasLos), re-checked every tick, so it is a wait
// and not a refusal. Silently, until now: the player called a mission, watched
// nothing happen, and had no way to learn why. Says which it is.
function missionRow(sim: Sim, e: Emplacement): string {
  const w: WeaponDef = WEAPONS[EMPLACEMENTS[e.kind].weapon];
  if (!w.arc || !e.hasTarget || e.state !== 'deployed') return '';
  const d = Math.hypot(e.targetX - e.x, e.targetY - e.y);
  const label = e.smokeRoundsLeft > 0 ? `smoke mission · ${e.smokeRoundsLeft} left` : 'fire mission';
  if (d < w.arc.minRange) return `<div class="emp-mission warn">${label} · TOO CLOSE (min ${w.arc.minRange} m)</div>`;
  if (d > w.range) return `<div class="emp-mission warn">${label} · OUT OF RANGE (${Math.round(d)} of ${w.range} m)</div>`;
  if (!friendlyHasLos(sim, e.side, e.targetX, e.targetY)) return `<div class="emp-mission warn">${label} · NO EYES ON THE TARGET — holding</div>`;
  return `<div class="emp-mission">${label} · firing</div>`;
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
      btns.push(`<button class="hbtn" data-ctx="smoke">Smoke mission</button>`);
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
