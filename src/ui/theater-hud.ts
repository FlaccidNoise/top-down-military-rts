// TheaterHud (S30): the V2 strategic chrome — TAPPABLE pause/speed (the
// keyboard is a shortcut, never the only path), day/clock, objective count,
// the selected force card, and the §3.9 event scrollback. DOM overlay per
// the hybrid doctrine; rebuilds are signature-throttled like StratHud.
import { MOBILE } from '../render/view';

import type { WarGoals } from '../strategic/goals';
import type { Force, FrontV2 } from '../strategic/theater/force';

const SPEED_LABELS = ['1×', '10×', '60×'];
// The first line a new player reads, and it must name the input they have.
const EMPTY_LOG = MOBILE
  ? 'No contact yet — tap a company, then press and hold a town to advance.'
  : 'No contact yet — select a company and right-click a town to advance.';

export interface TheaterHudCallbacks {
  togglePause(): void;
  setSpeed(idx: number): void;
  /** Save, keybinds and the Field Manual, from the strategic phase. */
  openMenu(): void;
}

export class TheaterHud {
  readonly root: HTMLDivElement;
  private lastSig = '';

  constructor(private readonly cb: TheaterHudCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'theater-hud';
    this.root.style.display = 'none';
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-th="menu"]')) { this.cb.openMenu(); return; }
      const btn = (e.target as HTMLElement).closest('[data-clock]');
      if (!btn) return;
      const v = btn.getAttribute('data-clock')!;
      if (v === 'pause') this.cb.togglePause();
      else this.cb.setSpeed(Number(v));
    });
  }

  update(front: FrontV2, goals: WarGoals, selectedForce: number, paused: boolean, speedIdx: number): void {
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
    const sig = [
      front.day, hh, mm, held, need, objectives.length, lastDay, paused, speedIdx, selectedForce,
      sel ? `${sel.strength}:${sel.path.length}:${sel.engagedIn}` : '',
      front.events.length, lastEvent?.text ?? '',
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const speeds = SPEED_LABELS.map(
      (label, i) => `<button class="hbtn st-speed${i === speedIdx ? ' active' : ''}" data-clock="${i}">${label}</button>`,
    ).join('');
    const selCard = sel
      ? `<div class="panel th-force">
          <b>${sel.name}</b> · ${sel.strength} men · ${sel.role}
          ${sel.engagedIn !== null ? '<span class="th-eng">ENGAGED</span>' : sel.path.length > 0 ? '<span class="th-mov">moving</span>' : '<span class="th-hold">holding</span>'}
        </div>`
      : '';
    const log = front.events
      .slice(-8)
      .map((e) => {
        const eh = Math.floor((e.min % 1440) / 60).toString().padStart(2, '0');
        const em = (e.min % 60).toString().padStart(2, '0');
        return `<div class="th-ev th-ev-${e.kind}">${eh}${em} ${e.text}</div>`;
      })
      .reverse()
      .join('');

    const objHelp = lastDay === null
      ? `Hold ${need} of ${objectives.length} objectives to win. You lose if your force is destroyed.`
      : `Hold ${need} of ${objectives.length} objectives before Day ${lastDay} to win. You lose if the deadline passes or your force is destroyed.`;
    this.root.innerHTML = `
      <div class="panel th-top">
        <span class="th-obj" title="${objHelp}">Objectives ${held}/${objectives.length}${need < objectives.length ? ` (need ${need})` : ''}</span>
        <span class="th-clock">Day ${front.day}${lastDay === null ? '' : ` of ${lastDay}`} · ${hh}${mm}</span>
        <span class="th-controls">
          <button class="hbtn st-pause${paused ? ' active' : ''}" data-clock="pause">${paused ? '▶ Resume' : '⏸ Pause'}</button>
          ${speeds}
          <button class="hbtn th-menu" data-th="menu" title="Menu, keybinds and the Field Manual">⚙</button>
        </span>
      </div>
      ${selCard}
      <div class="panel th-log">${log || `<div class="th-ev">${EMPTY_LOG}</div>`}</div>`;
  }
}
