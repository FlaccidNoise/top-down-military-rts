// TheaterHud (S30): the V2 strategic chrome — TAPPABLE pause/speed (the
// keyboard is a shortcut, never the only path), day/clock, objective count,
// the selected force card, and the §3.9 event scrollback. DOM overlay per
// the hybrid doctrine; rebuilds are signature-throttled like StratHud.
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

    const speeds = SPEED_LABELS.map(
      (label, i) => `<button class="hbtn st-speed${i === speedIdx ? ' active' : ''}" data-clock="${i}">${label}</button>`,
    ).join('');
    const supplyLine = (f: Force): string => {
      if (!supplyOn) return '';
      const tier = supplyTierOf(f.untracedMin);
      if (tier === 'full') return '<span class="th-sup th-sup-full">supplied</span>';
      const hrs = Math.floor(f.untracedMin / 60);
      return `<span class="th-sup th-sup-${tier}">${tier === 'low' ? 'SUPPLY LOW' : 'OUT OF SUPPLY'} · cut ${hrs}h</span>`;
    };
    // Persistent ETA: destination read off the live path, minutes from the
    // SAME shadow kernel the step marches — the readout survives re-opens
    // and dusk instead of living only in the order flash.
    const etaLine = (f: Force): string => {
      const dest = pathDestination(front.theater, f);
      if (dest === null || f.engagedIn !== null) return '';
      const eta = forceEtaMinutes(front, f, dest, { nightTempo });
      const hh = Math.floor(eta / 60);
      const mm = eta % 60;
      return ` → ${front.theater.nodes[dest].name} · ETA ${hh > 0 ? `${hh}h` : ''}${mm.toString().padStart(2, '0')}m`;
    };
    const fatigueBar = (f: Force): string => {
      const pct = Math.round(f.fatigue * 100);
      const cls = f.fatigue >= 0.66 ? 'high' : f.fatigue >= 0.33 ? 'mid' : 'low';
      return `<span class="th-fat"><span class="th-fat-label">fatigue</span><span class="th-fat-track"><span class="th-fat-fill th-fat-${cls}" style="width:${pct}%"></span></span></span>`;
    };
    const selCard = sel
      ? `<div class="panel th-force">
          <b>${sel.name}</b> · ${sel.strength} men · ${sel.role}
          ${sel.engagedIn !== null ? '<span class="th-eng">ENGAGED</span>' : sel.path.length > 0 ? `<span class="th-mov">moving${etaLine(sel)}</span>` : '<span class="th-hold">holding</span>'}
          ${fatigueBar(sel)}
          ${supplyLine(sel)}
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
      ${reconOn && contacts === 0 ? '<div class="panel th-nocontact">NO CONTACT REPORTED — push a screen toward the enemy</div>' : ''}
      <div class="panel th-log">${log || `<div class="th-ev">${EMPTY_LOG}</div>`}</div>`;
  }
}
