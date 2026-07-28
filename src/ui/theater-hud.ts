// TheaterHud (S30): the V2 strategic chrome — TAPPABLE pause/speed (the
// keyboard is a shortcut, never the only path), day/clock, objective count,
// the selected force card, and the §3.9 event scrollback. DOM overlay per
// the hybrid doctrine; rebuilds are signature-throttled like StratHud.
import type { WarGoals } from '../strategic/goals';
import type { Force, FrontV2 } from '../strategic/theater/force';
import { supplyTierOf } from '../strategic/theater/supply';

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

  update(front: FrontV2, goals: WarGoals, selectedForce: number, paused: boolean, speedIdx: number, supplyOn = false, reconOn = false): void {
    const control = goals.blue.find((c) => c.kind === 'control');
    const objectives = control && control.kind === 'control' ? control.nodeIds : [];
    const held = objectives.filter((n) => front.controlByNode[n] === 'blue').length;
    const sel: Force | undefined = front.forces.find((f) => f.id === selectedForce);
    const hh = Math.floor((front.clockMin % 1440) / 60).toString().padStart(2, '0');
    const mm = (front.clockMin % 60).toString().padStart(2, '0');
    const lastEvent = front.events.length > 0 ? front.events[front.events.length - 1] : null;
    const contacts = front.intel?.blue.length ?? 0;
    const sig = [
      front.day, hh, mm, held, paused, speedIdx, selectedForce,
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
    const fatigueBar = (f: Force): string => {
      const pct = Math.round(f.fatigue * 100);
      const cls = f.fatigue >= 0.66 ? 'high' : f.fatigue >= 0.33 ? 'mid' : 'low';
      return `<span class="th-fat"><span class="th-fat-label">fatigue</span><span class="th-fat-track"><span class="th-fat-fill th-fat-${cls}" style="width:${pct}%"></span></span></span>`;
    };
    const selCard = sel
      ? `<div class="panel th-force">
          <b>${sel.name}</b> · ${sel.strength} men · ${sel.role}
          ${sel.engagedIn !== null ? '<span class="th-eng">ENGAGED</span>' : sel.path.length > 0 ? '<span class="th-mov">moving</span>' : '<span class="th-hold">holding</span>'}
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
      ${reconOn && contacts === 0 ? '<div class="panel th-nocontact">NO CONTACT REPORTED — push a screen toward the enemy</div>' : ''}
      <div class="panel th-log">${log || '<div class="th-ev">No contact yet — select a company and right-click a town to advance.</div>'}</div>`;
  }
}
