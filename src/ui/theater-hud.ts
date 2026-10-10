// TheaterHud (S30): the V2 strategic chrome — TAPPABLE pause/speed (the
// keyboard is a shortcut, never the only path), day/clock, objective count,
// the selected force card, and the §3.9 event scrollback. DOM overlay per
// the hybrid doctrine. The DOM is built ONCE and update() patches text and
// classes: a rebuilt button is a new element between mousedown and mouseup,
// and at 60x that swallowed every click on the clock row (jtbug #761).
import { MOBILE } from '../render/view';

import type { WarGoals } from '../strategic/goals';
import { pathDestination, type Force, type FrontV2 } from '../strategic/theater/force';
import { forceEtaMinutes } from '../strategic/theater/step';
import { supplyTierOf } from '../strategic/theater/supply';
import { SPEED_LABELS } from './strat-hud';

// The first line a new player reads, and it must name the input they have.
const EMPTY_LOG = MOBILE
  ? 'No contact yet — tap a company, then press and hold a town to advance.'
  : 'No contact yet — select a company and right-click a town to advance.';

export interface TheaterHudCallbacks {
  togglePause(): void;
  setSpeed(idx: number): void;
  /** Save, keybinds and the Field Manual, from the strategic phase. */
  openMenu(): void;
  /** Show the whole theater. */
  fitAll(): void;
  /** Halt the selected company where it stands. */
  halt(): void;
}

export class TheaterHud {
  readonly root: HTMLDivElement;
  private lastSig = '';
  private lastLogSig = '';
  private readonly top: HTMLElement;
  private readonly obj: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly speeds: HTMLElement[];
  private readonly noContact: HTMLElement;
  private readonly force: HTMLElement;
  private readonly forceName: HTMLElement;
  private readonly forceStat: HTMLElement;
  private readonly forceState: HTMLElement;
  private readonly fatFill: HTMLElement;
  private readonly sup: HTMLElement;
  private readonly halt: HTMLElement;
  private readonly log: HTMLElement;

  constructor(private readonly cb: TheaterHudCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'theater-hud';
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="th-head">
        <div class="panel th-top">
          <span class="th-obj"></span>
          <span class="th-clock"></span>
          <span class="th-controls">
            <button class="hbtn st-pause" data-clock="pause"></button>
            ${SPEED_LABELS.map((label, i) => `<button class="hbtn st-speed" data-clock="${i}">${label}</button>`).join('')}
            <button class="hbtn th-fit" data-th="fit" title="Show the whole theater">Fit</button>
            <button class="hbtn th-menu" data-th="menu" title="Menu, keybinds and the Field Manual">⚙</button>
          </span>
        </div>
        <div class="panel th-nocontact" hidden>NO CONTACT REPORTED — advance a company to find the enemy</div>
      </div>
      <div class="panel th-force" hidden>
        <b class="th-name"></b><span class="th-stat"></span><span class="th-state"></span>
        <span class="th-fat"><span class="th-fat-label">fatigue</span><span class="th-fat-track"><span class="th-fat-fill"></span></span></span>
        <span class="th-sup" hidden></span>
        <button class="hbtn th-halt" data-th="halt" hidden>■ Halt</button>
      </div>
      <div class="panel th-log"></div>`;
    const q = (sel: string): HTMLElement => this.root.querySelector<HTMLElement>(sel)!;
    this.top = q('.th-top');
    this.obj = q('.th-obj');
    this.clock = q('.th-clock');
    this.pause = q('.st-pause');
    this.speeds = Array.from(this.root.querySelectorAll<HTMLElement>('.st-speed'));
    this.noContact = q('.th-nocontact');
    this.force = q('.th-force');
    this.forceName = q('.th-name');
    this.forceStat = q('.th-stat');
    this.forceState = q('.th-state');
    this.fatFill = q('.th-fat-fill');
    this.sup = q('.th-sup');
    this.halt = q('.th-halt');
    this.log = q('.th-log');
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-th="menu"]')) { this.cb.openMenu(); return; }
      if ((e.target as HTMLElement).closest('[data-th="halt"]')) { this.cb.halt(); return; }
      if ((e.target as HTMLElement).closest('[data-th="fit"]')) { this.cb.fitAll(); return; }
      const btn = (e.target as HTMLElement).closest('[data-clock]');
      if (!btn) return;
      const v = btn.getAttribute('data-clock')!;
      if (v === 'pause') this.cb.togglePause();
      else this.cb.setSpeed(Number(v));
    });
  }

  update(front: FrontV2, goals: WarGoals, selectedForce: number, paused: boolean, speedIdx: number, supplyOn = false, reconOn = false, nightTempo = false): void {
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
    const sig = [
      front.day, hh, mm, held, need, objectives.length, lastDay, paused, speedIdx, selectedForce,
      sel ? `${sel.strength}:${sel.path.length}:${sel.engagedIn}:${sel.untracedMin}:${Math.round(sel.fatigue * 100)}` : '',
      front.events.length, lastEvent?.text ?? '', supplyOn, reconOn, contacts,
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const objHelp = lastDay === null
      ? `Hold ${need} of ${objectives.length} objectives to win. You lose if your force is destroyed.`
      : `Hold ${need} of ${objectives.length} objectives before Day ${lastDay} to win. You lose if the deadline passes or your force is destroyed.`;
    this.obj.title = objHelp;
    this.obj.textContent = `Objectives ${held}/${objectives.length}${need < objectives.length ? ` (need ${need})` : ''}`;
    this.clock.textContent = `Day ${front.day}${lastDay === null ? '' : ` of ${lastDay}`} · ${hh}${mm}`;
    // Paused is a state of the whole row, not one more lit chip: the pause
    // button inverts and the speeds dim, so "paused at 10x" reads as paused.
    this.top.classList.toggle('is-paused', paused);
    this.pause.textContent = paused ? '▶ Resume' : '⏸ Pause';
    this.speeds.forEach((b, i) => b.classList.toggle('active', i === speedIdx));
    this.noContact.hidden = !(reconOn && contacts === 0);

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
        const eh = Math.floor(eta / 60);
        this.setState('th-mov', `moving → ${front.theater.nodes[dest].name} · ETA ${eh > 0 ? `${eh}h` : ''}${(eta % 60).toString().padStart(2, '0')}m`);
      } else this.setState('th-hold', 'holding');
      this.halt.hidden = sel.side !== 'blue' || sel.engagedIn !== null || sel.path.length === 0;
      this.fatFill.className = `th-fat-fill th-fat-${sel.fatigue >= 0.66 ? 'high' : sel.fatigue >= 0.33 ? 'mid' : 'low'}`;
      this.fatFill.style.width = `${Math.round(sel.fatigue * 100)}%`;
      const tier = supplyTierOf(sel.untracedMin);
      this.sup.hidden = !supplyOn;
      this.sup.className = `th-sup th-sup-${tier}`;
      this.sup.textContent = tier === 'full' ? 'supplied' : `${tier === 'low' ? 'SUPPLY LOW' : 'OUT OF SUPPLY'} · cut ${Math.floor(sel.untracedMin / 60)}h`;
    }

    // The log is the one part still rebuilt, and only when an event lands: a
    // rebuild every game minute threw the reader's scroll position away.
    const logSig = `${front.events.length}|${lastEvent?.min ?? ''}|${lastEvent?.text ?? ''}`;
    if (logSig !== this.lastLogSig) {
      this.lastLogSig = logSig;
      this.log.innerHTML = front.events
        .slice(-8)
        .map((e) => {
          const eh = Math.floor((e.min % 1440) / 60).toString().padStart(2, '0');
          const em = (e.min % 60).toString().padStart(2, '0');
          return `<div class="th-ev th-ev-${e.kind}">${eh}${em} ${e.text}</div>`;
        })
        .reverse()
        .join('') || `<div class="th-ev">${EMPTY_LOG}</div>`;
    }
  }

  private setState(cls: string, text: string): void {
    this.forceState.className = `th-state ${cls}`;
    this.forceState.textContent = text;
  }
}
