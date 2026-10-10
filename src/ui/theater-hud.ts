// TheaterHud (S30): the V2 strategic chrome — TAPPABLE pause/speed (the
// keyboard is a shortcut, never the only path), day/clock, objective count,
// the "what next" strip (next action, objectives, replacements, the key), the
// selected force card, the §3.9 event scrollback and the contact card. DOM
// overlay per the hybrid doctrine. The DOM is built ONCE and update() patches
// text and classes: a rebuilt button is a new element between mousedown and
// mouseup, and at 60x that swallowed every click on the clock row (jtbug #761).
import { COUNTER_H, COUNTER_W, drawCounter, POSTURE_GLYPH, type PlacedCounter } from '../render/theater-counters';
import { fmtEta } from '../render/theater-view';
import { MOBILE } from '../render/view';

import { minutesToReinforcement, REINFORCE_CYCLE_DAYS } from '../strategic/front';
import { requisitionDue, requisitionNotes } from '../strategic/requisition';
import type { WarGoals } from '../strategic/goals';
import { DETECT_FORCE_M, SCREEN_DETECT_MULT } from '../strategic/intel';
import { DIG_DEF_MULT, REST_COMBAT_MULT } from '../strategic/theater/combat';
import { pathDestination, type Force, type ForceRole, type FrontV2, type Posture, type TheaterEvent } from '../strategic/theater/force';
import { DIG_IN_MIN, dugIn, FORCED_FATIGUE_MULT, FORCED_PACE_MULT, forceEtaMinutes, REST_RECOVER_MULT, SCREEN_PACE_MULT } from '../strategic/theater/step';
import { supplyTierOf } from '../strategic/theater/supply';
import { SPEED_LABELS } from './strat-hud';

export interface TheaterHudCallbacks {
  togglePause(): void;
  setSpeed(idx: number): void;
  /** Save, keybinds and the Field Manual, from the strategic phase. */
  openMenu(): void;
  /** Show the whole theater. */
  fitAll(): void;
  /** Halt the selected company where it stands. */
  halt(): void;
  /** Change the selected company's posture. */
  posture(p: Posture): void;
  /** Centre the map on where a logged event happened. */
  focus(e: TheaterEvent): void;
  /** Centre the map on a place. */
  focusNode(nodeId: number): void;
}

// The next thing to do, in the words of the input the player has. This line
// replaces the grey sentence that sat in the empty event log.
const NEXT = {
  contact: 'Answer the contact.',
  requisition: 'Pick a requisition.',
  select: MOBILE ? 'Tap a company.' : 'Click a company.',
  order: MOBILE ? 'Hold a town to march there.' : 'Right-click a town to march there.',
  play: 'Press Play.',
  marching: 'On the march.',
} as const;

// The key. Each row is a swatch and a few words; the counters are drawn by
// the map's own drawCounter, so the key cannot drift from the map.
type Swatch = { counter: Partial<PlacedCounter> } | { css: string };
const KEY: [Swatch, string][] = [
  [{ counter: { side: 'blue', letter: 'A', strength: 138 } }, 'Your company, men'],
  [{ counter: { side: 'red', role: 'garrison', strength: 78 } }, 'Garrison: holds, may sortie'],
  [{ counter: { side: 'red', role: 'line', strength: 95 } }, 'Mobile group: attacks'],
  [{ counter: { side: 'red', role: 'reserve', strength: 108 } }, 'Reserve'],
  [{ counter: { side: 'red', role: 'line', strength: 60, ghost: true, conf: 0.6 } }, 'Last seen, fading'],
  [{ counter: { side: 'blue', letter: 'B', strength: 60, frac: 0.45, supply: 'low', fatigue: 0.7 } }, 'Bar: strength. Dots: supply, fatigue'],
  [{ counter: { side: 'blue', letter: 'C', strength: 120, posture: 'dig' } }, 'Corner mark: posture'],
  [{ css: 'k-obj' }, 'Objective to take'],
  [{ css: 'k-obj k-held' }, 'Objective held'],
  [{ css: 'k-front' }, 'Front line'],
  [{ css: 'k-march' }, 'March'],
  [{ css: 'k-march k-enemy' }, 'Enemy seen marching'],
  [{ css: 'k-preview' }, 'Order preview'],
  [{ css: 'k-fight' }, 'Battle or contact'],
  [{ css: 'k-road' }, 'Highway, road, track'],
  [{ css: 'k-rail' }, 'Railway: no traffic'],
  [{ css: 'k-cross' }, 'Bridge or ford'],
  [{ css: 'k-depot' }, 'Supply depot'],
  [{ css: 'k-cut' }, 'Your supply is cut here'],
  [{ counter: { side: 'red', role: 'garrison', strength: 40, frac: 0.6, supply: 'out', tag: 'ISOLATED' } }, 'Enemy cut off from supply'],
];

const POSTURES: [Posture, string][] = [['march', 'March'], ['forced', 'Forced'], ['rest', 'Rest'], ['dig', 'Dig in'], ['screen', 'Screen']];
const pct = (mult: number): string => `${mult >= 1 ? '+' : '−'}${Math.round(Math.abs(mult - 1) * 100)}%`;

// What a posture does, in five words at most. Every number is read from the
// constant that owns it. With `f`, the line is that force's own state (how
// much digging is left). `fog` is whether sight means anything in this war.
export function postureEffect(p: Posture, fog: boolean, f?: Pick<Force, 'posture' | 'dugMin'>): string {
  switch (p) {
    case 'march':
      return 'Normal pace.';
    case 'forced':
      return `${pct(FORCED_PACE_MULT)} pace, ${FORCED_FATIGUE_MULT}× fatigue.`;
    case 'rest':
      return `Recovers ${REST_RECOVER_MULT}× faster, fights ${pct(REST_COMBAT_MULT)}.`;
    case 'dig':
      if (f && dugIn(f)) return `Dug in: defence ×${DIG_DEF_MULT}.`;
      return f ? `Digging: ${fmtEta(DIG_IN_MIN - f.dugMin)} left.` : `${fmtEta(DIG_IN_MIN)} to dig: defence ×${DIG_DEF_MULT}.`;
    case 'screen':
      return fog
        ? `Sees ${(DETECT_FORCE_M * SCREEN_DETECT_MULT) / 1000} km, slow, evades.`
        : `${pct(SCREEN_PACE_MULT)} pace, evades stronger enemy.`;
  }
}

export class TheaterHud {
  readonly root: HTMLDivElement;
  private lastSig = '';
  private lastLogSig = '';
  private objSig = '';
  private logged: TheaterEvent[] = [];
  private readonly top: HTMLElement;
  private readonly obj: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly target: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly speeds: HTMLElement[];
  private readonly noContact: HTMLElement;
  private readonly next: HTMLElement;
  private readonly objs: HTMLElement;
  private objRows: { nodeId: number; who: HTMLElement; row: HTMLElement }[] = [];
  private readonly reinf: HTMLElement;
  private readonly keyBtn: HTMLElement;
  private readonly key: HTMLElement;
  private readonly force: HTMLElement;
  private readonly forceName: HTMLElement;
  private readonly forceStat: HTMLElement;
  private readonly forceState: HTMLElement;
  private readonly fat: HTMLElement;
  private readonly fatFill: HTMLElement;
  private readonly sup: HTMLElement;
  private readonly halt: HTMLElement;
  private readonly post: HTMLElement;
  private readonly postFx: HTMLElement;
  private readonly log: HTMLElement;
  /** The contact card. main.ts fills it; a panel here, so the camera frames around it. */
  readonly contact: HTMLElement;

  constructor(private readonly cb: TheaterHudCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'theater-hud';
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="th-head">
        <div class="panel th-top">
          <span class="th-obj"></span>
          <span class="th-clock"></span>
          <span class="th-target"></span>
          <span class="th-controls">
            <button class="hbtn st-pause" data-clock="pause"></button>
            ${SPEED_LABELS.map((label, i) => `<button class="hbtn st-speed" data-clock="${i}">${label}</button>`).join('')}
            <button class="hbtn th-fit" data-th="fit" title="Show the whole theater">Fit</button>
            <button class="hbtn th-menu" data-th="menu" title="Menu, keybinds and the Field Manual">⚙</button>
          </span>
        </div>
        <div class="panel th-nocontact" hidden>NO CONTACT REPORTED — advance a company to find the enemy</div>
      </div>
      <div class="th-side">
        <div class="panel th-strip">
          <div class="th-next"></div>
          <div class="th-objs"></div>
          <div class="th-foot">
            <span class="th-reinf"></span>
            <button class="hbtn th-keybtn" data-th="key" aria-expanded="false">Key</button>
          </div>
          <div class="th-key" hidden>
            ${KEY.map(([s, words], i) => `<div class="th-krow">${'css' in s ? `<i class="k-sw ${s.css}"></i>` : `<canvas class="k-sw" data-key="${i}"></canvas>`}<span>${words}</span></div>`).join('')}
          </div>
        </div>
        <div class="panel th-force" hidden>
          <b class="th-name"></b><span class="th-stat"></span><span class="th-state"></span>
          <span class="th-fat"><span class="th-fat-label">fatigue</span><span class="th-fat-track"><span class="th-fat-fill"></span></span></span>
          <span class="th-sup" hidden></span>
          <span class="th-post" hidden>${POSTURES.map(([k, word]) => `<button class="hbtn th-pb" data-post="${k}"><i>${POSTURE_GLYPH[k]}</i>${word}</button>`).join('')}<button class="hbtn th-pb th-halt" data-th="halt" hidden><i>■</i>Halt</button></span>
          <span class="th-postfx" hidden></span>
        </div>
        <div class="panel th-log" hidden></div>
      </div>
      <div class="panel th-contact" id="contact" hidden></div>`;
    const q = (sel: string): HTMLElement => this.root.querySelector<HTMLElement>(sel)!;
    this.top = q('.th-top');
    this.obj = q('.th-obj');
    this.clock = q('.th-clock');
    this.target = q('.th-target');
    this.pause = q('.st-pause');
    this.speeds = Array.from(this.root.querySelectorAll<HTMLElement>('.st-speed'));
    this.noContact = q('.th-nocontact');
    this.next = q('.th-next');
    this.objs = q('.th-objs');
    this.reinf = q('.th-reinf');
    this.keyBtn = q('.th-keybtn');
    this.key = q('.th-key');
    this.force = q('.th-force');
    this.forceName = q('.th-name');
    this.forceStat = q('.th-stat');
    this.forceState = q('.th-state');
    this.fat = q('.th-fat');
    this.fatFill = q('.th-fat-fill');
    this.sup = q('.th-sup');
    this.halt = q('.th-halt');
    this.post = q('.th-post');
    this.postFx = q('.th-postfx');
    this.log = q('.th-log');
    this.contact = q('.th-contact');
    this.drawKey();
    // Closed until asked for, on every screen: twenty rows of legend down the
    // side are a wall of text on first sight. The prompt and the objectives
    // are what a new player needs first.
    this.setKey(false);
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const hit = (sel: string): HTMLElement | null => (e.target as HTMLElement).closest<HTMLElement>(sel);
      if (hit('[data-th="menu"]')) return this.cb.openMenu();
      if (hit('[data-th="halt"]')) return this.cb.halt();
      const post = hit('[data-post]');
      if (post) return this.cb.posture(post.dataset.post as Posture);
      if (hit('[data-th="fit"]')) return this.cb.fitAll();
      if (hit('[data-th="key"]')) return this.setKey(this.key.hidden);
      const place = hit('[data-obj]');
      if (place) return this.cb.focusNode(Number(place.getAttribute('data-obj')));
      const line = hit('[data-ev]');
      if (line) return this.cb.focus(this.logged[Number(line.getAttribute('data-ev'))]);
      const btn = hit('[data-clock]');
      if (!btn) return;
      const v = btn.getAttribute('data-clock')!;
      if (v === 'pause') this.cb.togglePause();
      else this.cb.setSpeed(Number(v));
    });
  }

  private setKey(open: boolean): void {
    this.key.hidden = !open;
    this.keyBtn.setAttribute('aria-expanded', String(open));
    this.keyBtn.classList.toggle('active', open);
  }

  // The counter rows of the key, drawn with the map's own counter.
  private drawKey(): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.root.querySelectorAll<HTMLCanvasElement>('canvas[data-key]').forEach((c) => {
      const s = KEY[Number(c.dataset.key)][0];
      if (!('counter' in s)) return;
      const w = COUNTER_W + 10;
      const h = COUNTER_H + 10 + (s.counter.tag ? 8 : 0);
      c.width = w * dpr;
      c.height = h * dpr;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      const g = c.getContext('2d');
      if (!g) return;
      g.scale(dpr, dpr);
      const role: ForceRole = 'line';
      drawCounter(g, {
        id: 0, side: 'blue', letter: null, role, strength: 0, frac: 1, supply: null, fatigue: 0, posture: 'march', selected: false, engaged: false,
        conf: 1, ghost: false, tag: null, ax: 0, ay: 0, drop: 0, x: 5, y: s.counter.tag ? 14 : 6, ...s.counter,
      });
    });
  }

  // `target` is the best result still open (result.ts), for the top bar.
  update(front: FrontV2, goals: WarGoals, selectedForce: number, paused: boolean, speedIdx: number, supplyOn = false, reconOn = false, nightTempo = false, target = ''): void {
    const control = goals.blue.find((c) => c.kind === 'control');
    const objectives = control && control.kind === 'control' ? control.nodeIds : [];
    const held = objectives.filter((n) => front.controlByNode[n] === 'blue').length;
    // Both halves of the win condition come from the goals object — the war
    // length is config, so a hand-typed day would lie the moment it changes.
    const need = control && control.kind === 'control' ? control.need : objectives.length;
    const deadline = goals.red.find((c) => c.kind === 'deadline');
    const lastDay = deadline && deadline.kind === 'deadline' ? deadline.day : null;
    const sel: Force | undefined = front.forces.find((f) => f.id === selectedForce);
    const hh = Math.floor((front.clockMin % 1440) / 60).toString().padStart(2, '0');
    const mm = (front.clockMin % 60).toString().padStart(2, '0');
    const lastEvent = front.events.length > 0 ? front.events[front.events.length - 1] : null;
    const contacts = front.intel?.blue.length ?? 0;
    const inContact = this.root.classList.contains('in-contact');
    const marching = front.forces.some((f) => f.side === 'blue' && f.strength > 0 && f.path.length > 0 && f.engagedIn === null);
    // What stands at each objective, as far as the player may know: his own
    // companies, and the enemy from the forces (or, under fog, the reports).
    const garrisons = objectives.map((n) => {
      const at = (p: Force['pos']): boolean => p.kind === 'node' && p.nodeId === n;
      const own = front.forces.filter((f) => f.side === 'blue' && f.strength > 0 && at(f.pos)).map((f) => f.name.charAt(0));
      const foe = reconOn
        ? (front.intel?.blue ?? []).filter((c) => at(c.pos)).map((c) => c.strength)
        : front.forces.filter((f) => f.side === 'red' && f.strength > 0 && at(f.pos)).map((f) => f.strength);
      return { n, holder: front.controlByNode[n], own, foe };
    });
    const sig = [
      front.day, hh, mm, held, need, objectives.length, lastDay, paused, speedIdx, selectedForce,
      sel ? `${sel.strength}:${sel.path.length}:${sel.engagedIn}:${sel.untracedMin}:${Math.round(sel.fatigue * 100)}:${sel.posture}:${sel.dugMin}:${sel.armorAttacks}:${sel.reconUntilDay}` : '',
      requisitionDue(front), front.requisition?.barrageUntilDay ?? 0, target,
      front.events.length, lastEvent?.text ?? '', supplyOn, reconOn, contacts, inContact, marching,
      garrisons.map((g) => `${g.holder}:${g.own}:${g.foe}`).join('/'),
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const objHelp = lastDay === null
      ? `Hold ${need} of ${objectives.length} objectives to win. You lose if your force is destroyed.`
      : `Hold ${need} of ${objectives.length} objectives before Day ${lastDay} to win. You lose if the deadline passes or your force is destroyed.`;
    this.obj.title = objHelp;
    this.obj.textContent = `Objectives ${held}/${objectives.length}${need < objectives.length ? ` (need ${need})` : ''}`;
    this.clock.textContent = `Day ${front.day}${lastDay === null ? '' : ` of ${lastDay}`} · ${hh}${mm}`;
    this.target.textContent = target;
    this.target.className = `th-target${target.startsWith('Decisive') ? ' th-target-on' : ''}`;
    // Paused is a state of the whole row, not one more lit chip: the pause
    // button inverts and the speeds dim, so "paused at 10x" reads as paused.
    this.top.classList.toggle('is-paused', paused);
    this.pause.textContent = paused ? '▶ Play' : '⏸ Pause';
    this.speeds.forEach((b, i) => b.classList.toggle('active', i === speedIdx));
    this.noContact.hidden = !(reconOn && contacts === 0);

    // What next: one line, the objectives, the replacements clock.
    this.next.textContent = inContact
      ? document.getElementById('req') ? NEXT.requisition : NEXT.contact
      : sel && sel.path.length === 0 && sel.engagedIn === null
        ? NEXT.order
        : marching
          ? paused ? NEXT.play : NEXT.marching
          : sel ? '' : NEXT.select;
    const ids = objectives.join(',');
    if (ids !== this.objSig) {
      // Built once per war: the rows are buttons, and a button must outlive
      // the press that lands on it.
      this.objSig = ids;
      this.objs.innerHTML = objectives
        .map((n) => `<button class="th-objrow" data-obj="${n}"><span class="th-objname"><span class="th-objstar">★ </span>${front.theater.nodes[n].name}</span><span class="th-objwho"></span></button>`)
        .join('');
      this.objRows = Array.from(this.objs.querySelectorAll<HTMLElement>('.th-objrow')).map((row, i) => ({ nodeId: objectives[i], row, who: row.querySelector<HTMLElement>('.th-objwho')! }));
    }
    this.objRows.forEach(({ row, who }, i) => {
      const g = garrisons[i];
      row.className = `th-objrow th-obj-${g.holder ?? 'open'}`;
      const foe = g.foe.reduce((a, s) => a + s, 0);
      who.textContent =
        g.holder === 'blue'
          ? `HELD${g.own.length ? ` ${g.own.join('')}` : ''}`
          : g.foe.length > 0 ? `${reconOn ? '~' : ''}${foe}` : reconOn ? '?' : 'open';
    });
    const mins = minutesToReinforcement(front);
    const h = Math.ceil(mins / 60);
    this.reinf.textContent = requisitionDue(front) ? 'Requisition due' : `Requisition in ${h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`}`;
    this.reinf.title = `Every ${REINFORCE_CYCLE_DAYS} days: replacements, armour, a barrage or recon.`;

    this.force.hidden = !sel;
    if (sel) {
      this.forceName.textContent = sel.name;
      this.forceStat.textContent = ` · ${sel.strength} men · ${sel.role}`;
      if (sel.engagedIn !== null) this.setState('th-eng', 'ENGAGED');
      else if (sel.path.length > 0) {
        // Persistent ETA: destination read off the live path, minutes from the
        // SAME shadow kernel the step marches — the readout survives re-opens
        // and dusk instead of living only in the order flash.
        const dest = pathDestination(front.theater, sel)!;
        const eta = forceEtaMinutes(front, sel, dest, { nightTempo });
        this.setState('th-mov', `moving → ${front.theater.nodes[dest].name} · ETA ${fmtEta(eta)}`);
      } else this.setState('th-hold', 'holding');
      this.halt.hidden = sel.side !== 'blue' || sel.engagedIn !== null || sel.path.length === 0;
      const mine = sel.side === 'blue' && sel.engagedIn === null;
      this.post.hidden = !mine;
      this.postFx.hidden = !mine;
      if (mine) {
        this.post.querySelectorAll<HTMLElement>('[data-post]').forEach((b) => {
          const k = b.dataset.post as Posture;
          b.classList.toggle('active', k === sel.posture);
          b.title = postureEffect(k, reconOn);
        });
        this.postFx.textContent = [postureEffect(sel.posture, reconOn, sel), ...requisitionNotes(front, sel)].join(' · ');
      }
      this.fatFill.className = `th-fat-fill th-fat-${sel.fatigue >= 0.66 ? 'high' : sel.fatigue >= 0.33 ? 'mid' : 'low'}`;
      this.fatFill.style.width = `${Math.round(sel.fatigue * 100)}%`;
      const tier = supplyTierOf(sel.untracedMin);
      // A small screen shows these two lines only when they have news.
      this.fat.classList.toggle('nominal', sel.fatigue < 0.33);
      this.sup.hidden = !supplyOn;
      this.sup.className = `th-sup th-sup-${tier}${tier === 'full' ? ' nominal' : ''}`;
      this.sup.textContent = tier === 'full' ? 'supplied' : `${tier === 'low' ? 'SUPPLY LOW' : 'OUT OF SUPPLY'} · cut ${Math.floor(sel.untracedMin / 60)}h`;
    }

    // The log is the one part still rebuilt, and only when an event lands: a
    // rebuild every game minute threw the reader's scroll position away. With
    // nothing logged there is no log: the strip says what to do next.
    const logSig = `${front.events.length}|${lastEvent?.min ?? ''}|${lastEvent?.text ?? ''}`;
    if (logSig !== this.lastLogSig) {
      this.lastLogSig = logSig;
      this.logged = front.events.slice(-8).reverse();
      this.log.hidden = this.logged.length === 0;
      this.log.innerHTML = this.logged
        .map((e, i) => {
          const eh = Math.floor((e.min % 1440) / 60).toString().padStart(2, '0');
          const em = (e.min % 60).toString().padStart(2, '0');
          return `<div class="th-ev th-ev-${e.kind}" data-ev="${i}">${eh}${em} ${e.text}</div>`;
        })
        .join('');
    }
  }

  // While a contact waits for its answer the card owns the bottom of the
  // screen: the company card and the log step aside.
  showContact(html: string): void {
    this.contact.innerHTML = html;
    this.contact.hidden = false;
    this.root.classList.add('in-contact');
  }

  hideContact(): void {
    this.contact.hidden = true;
    this.root.classList.remove('in-contact');
  }

  private setState(cls: string, text: string): void {
    this.forceState.className = `th-state ${cls}`;
    this.forceState.textContent = text;
  }
}
