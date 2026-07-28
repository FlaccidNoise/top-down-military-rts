import { capacities, consciousness, PARTS } from '../sim/body';
import { WEAPONS } from '../sim/data';
import type { Sim, Soldier } from '../sim/sim';
import { reserveAmmo, STATE_COLOR } from './hud';
import { barRow, downedCond, pct, rescuePhase, xpStars } from './tooltip';

export type Severity = 'ok' | 'grazed' | 'wounded' | 'serious' | 'destroyed';

// Remaining-hp fraction in woundLabel's language, which reads the same
// thresholds off the damage fraction (1 - frac). Its "mangled" is dmg >= 1,
// the same part state this calls destroyed.
export function partSeverity(frac: number): Severity {
  if (frac >= 1) return 'ok';
  if (frac <= 0) return 'destroyed';
  if (frac < 0.4) return 'serious';
  if (frac < 0.7) return 'wounded';
  return 'grazed';
}

function ramp(v: number): string {
  return v >= 0.9 ? 'var(--paper)' : v >= 0.6 ? 'var(--state-shaken)' : v >= 0.3 ? 'var(--state-pinned)' : 'var(--state-broken)';
}

// Front view, so the man's left arm sits on the viewer's right.
const SHAPES: Record<string, string> = {
  head: '<ellipse cx="45" cy="22" rx="14" ry="16"/>',
  eyes: '<circle cx="39" cy="20" r="2.6"/><circle cx="51" cy="20" r="2.6"/>',
  torso: '<rect x="29" y="42" width="32" height="56" rx="6"/>',
  'l-arm': '<rect x="64" y="44" width="12" height="46" rx="6"/>',
  'r-arm': '<rect x="14" y="44" width="12" height="46" rx="6"/>',
  'l-hand': '<circle cx="70" cy="96" r="6.5"/>',
  'r-hand': '<circle cx="20" cy="96" r="6.5"/>',
  'l-leg': '<rect x="46" y="100" width="13" height="54" rx="6"/>',
  'r-leg': '<rect x="31" y="100" width="13" height="54" rx="6"/>',
  'l-foot': '<rect x="45" y="156" width="16" height="11" rx="4"/>',
  'r-foot': '<rect x="29" y="156" width="16" height="11" rx="4"/>',
};

function silhouette(body: number[]): string {
  const shapes = PARTS.map((p, i) => {
    const f = body[i] / p.hp;
    const paint = f >= 1 ? 'fill="none" stroke="var(--muted)"' : f <= 0 ? 'fill="#3a2a2a" stroke="#6b4a44"' : `fill="${ramp(f)}" stroke="${ramp(f)}"`;
    return `<g class="${p.key}" ${paint}>${SHAPES[p.key] ?? ''}</g>`;
  }).join('');
  return `<svg class="hp-fig" viewBox="0 0 90 180" stroke-width="1.5">${shapes}</svg>`;
}

function partRows(s: Soldier): string {
  const hurt = new Set(s.wounds.map((w) => w.part));
  return PARTS.map((p, i) => {
    const f = s.body[i] / p.hp;
    const sev = partSeverity(f);
    const mark = s.stabilized && hurt.has(i) ? ' <span class="flag stab">✚</span>' : '';
    return (
      `<div class="hp-row" style="color:${sev === 'ok' ? 'var(--muted)' : ramp(f)}">` +
      `<span class="hp-nm">${p.name}</span><span>${sev === 'ok' ? '—' : sev + mark}</span>` +
      `<span class="hp-hp">${Math.round(s.body[i])}/${p.hp}</span></div>`
    );
  }).join('');
}

function capacityRows(sim: Sim, s: Soldier): string {
  const c = capacities(s.body);
  const rows: [string, number][] = [
    ['Consciousness', consciousness(s.pain, s.bloodLoss)],
    ['Moving', c.moving],
    ['Manipulation', c.manipulation],
    ['Sight', c.sight],
    ['Aim', sim.aimFactor(s)],
  ];
  return `<div class="tt-rows">${rows.map(([l, v]) => `<div><span>${l}</span><span style="color:${ramp(v)}">${pct(v)}</span></div>`).join('')}</div>`;
}

// One row: the mental chip when he is still in the fight, the state that
// replaced it when he is not.
function stateRow(sim: Sim, s: Soldier): string {
  if (!s.alive) return `<div class="tt-kia">KIA</div>`;
  if (s.captured) return `<div class="tt-state"><span class="mchip" style="background:var(--muted)">CAPTURED</span></div>`;
  if (s.downed) {
    let html = `<div class="tt-state"><span class="mchip" style="background:#d05c50">DOWN</span><span>${downedCond(s)}</span></div>`;
    if (s.carriedBy >= 0) html += `<div class="tt-note">${sim.soldiers[s.carriedBy].name} is carrying him</div>`;
    else if (s.rescuerId >= 0) {
      const r = sim.soldiers[s.rescuerId];
      html += `<div class="tt-note">${r.name} is ${rescuePhase(r)}</div>`;
    }
    return html;
  }
  const flag = s.stabilized ? '<span class="flag stab">stabilized</span>' : s.bleedRate > 0.0005 ? '<span class="flag">bleeding</span>' : '';
  return (
    `<div class="tt-state"><span class="mchip" style="background:${STATE_COLOR[s.mental]}">${s.mental.toUpperCase()}</span>` +
    `${s.fleeing ? '<span class="tt-note">fleeing</span>' : ''}${flag}</div>`
  );
}

function card(sim: Sim, s: Soldier): string {
  return (
    `<div class="hp-head"><b>${s.name}</b><button class="hp-x" title="close">✕</button></div>` +
    `<div class="tt-note">${s.role} · ${WEAPONS[s.weapon].name} ${s.magLeft}+${reserveAmmo(s)}${xpStars(s)}</div>` +
    stateRow(sim, s) +
    `<div class="tt-sec">CONDITION</div>` +
    `<div class="tt-grid">${barRow('Morale', s.morale, '#7fbf6a')}${barRow('Suppr.', s.suppression, '#e0a83c')}${barRow('Stamina', s.stamina, '#6fa8a0')}${barRow('Pain', s.pain, '#e08a3c')}${barRow('Blood', s.bloodLoss, '#d05c50')}</div>` +
    `<div class="tt-sec">CAPACITIES</div>` +
    capacityRows(sim, s) +
    `<div class="tt-sec">BODY</div>` +
    `<div class="hp-body">${silhouette(s.body)}<div class="hp-parts">${partRows(s)}</div></div>`
  );
}

// Every value the card draws, quantized to the step it is drawn at. No tick
// term: a battle that is paused, or a man nothing is happening to, costs no DOM.
const q = (v: number): number => Math.round(v * 20);

function signature(sim: Sim, s: Soldier): string {
  return [
    s.id, s.alive, s.downed, s.captured, s.fleeing, s.stabilized, s.mental, s.weapon,
    s.body.reduce((a, b) => a + b, 0).toFixed(1), s.wounds.length,
    q(s.pain), q(s.bloodLoss), q(s.morale), q(s.suppression), q(s.stamina),
    s.magLeft, reserveAmmo(s), s.carriedBy, s.rescuerId, s.rescuerId >= 0 ? sim.soldiers[s.rescuerId].task?.phase ?? '' : '',
  ].join('|');
}

export class HealthPanel {
  private el: HTMLDivElement;
  private sig = '';

  constructor(parent: HTMLElement, onClose: () => void) {
    this.el = document.createElement('div');
    this.el.id = 'healthpanel';
    this.el.className = 'panel';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.hp-x')) onClose();
    });
  }

  /** id < 0, or an id no longer on the roster, hides the panel. */
  update(sim: Sim, id: number): void {
    const s = id >= 0 ? sim.soldiers[id] : undefined;
    if (!s) {
      if (this.sig) {
        this.sig = '';
        this.el.style.display = 'none';
      }
      return;
    }
    const sig = signature(sim, s);
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.style.display = 'block';
    // The card re-renders whenever a quantized value moves (often under fire);
    // an innerHTML write resets scroll, which would pin a phone to the header.
    const top = this.el.scrollTop;
    this.el.innerHTML = card(sim, s);
    this.el.scrollTop = top;
  }
}
