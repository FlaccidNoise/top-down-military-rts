// TheaterHud (S30): the V2 strategic chrome — TAPPABLE pause/speed (the
// keyboard is a shortcut, never the only path), day/clock, objective count,
// the selected force card, and the §3.9 event scrollback. DOM overlay per
// the hybrid doctrine; rebuilds are signature-throttled like StratHud.
import type { WarGoals } from '../strategic/goals';
import type { Force, FrontV2 } from '../strategic/theater/force';

const SPEED_LABELS = ['1×', '10×', '60×'];

export interface TheaterHudCallbacks {
  togglePause(): void;
  setSpeed(idx: number): void;
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
    const sel: Force | undefined = front.forces.find((f) => f.id === selectedForce);
    const hh = Math.floor((front.clockMin % 1440) / 60).toString().padStart(2, '0');
    const mm = (front.clockMin % 60).toString().padStart(2, '0');
    const lastEvent = front.events.length > 0 ? front.events[front.events.length - 1] : null;
    const sig = [
      front.day, hh, mm, held, paused, speedIdx, selectedForce,
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

    this.root.innerHTML = `
      <div class="panel th-top">
        <span class="th-obj">Objectives ${held}/${objectives.length}</span>
        <span class="th-clock">Day ${front.day} · ${hh}${mm}</span>
        <span class="th-controls">
          <button class="hbtn st-pause${paused ? ' active' : ''}" data-clock="pause">${paused ? '▶ Resume' : '⏸ Pause'}</button>
          ${speeds}
        </span>
      </div>
      ${selCard}
      <div class="panel th-log">${log || '<div class="th-ev">No contact yet — select a company and right-click a town to advance.</div>'}</div>`;
  }
}
