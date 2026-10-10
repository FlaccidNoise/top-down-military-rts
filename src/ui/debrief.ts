// The debrief card: the result and the cost as a few large numbers, the dead
// by name in one short line, and the full roster only when it is asked for.
// Pure string builders, no DOM: main.ts mounts the result and wires the buttons.
import { esc } from './mainmenu';

/** Names listed before the line gives way to a count. */
export const FALLEN_SHOWN = 6;

/** The dead, by name, in one line: the first few, then how many more. */
export function fallenLine(kia: readonly string[]): string {
  if (kia.length === 0) return 'No one died today.';
  const shown = kia.slice(0, FALLEN_SHOWN).join(', ');
  const more = kia.length - FALLEN_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export interface DebriefSummary {
  won: boolean;
  /** One line on what the result changed: ground taken, line held. */
  outcome: string;
  kia: readonly string[];
  wounded: number;
  enemyLosses: number;
}

export interface DebriefAction {
  id: string;
  label: string;
  primary?: boolean;
}

const stat = (value: string, label: string, cls = ''): string =>
  `<div class="db-stat${cls ? ` ${cls}` : ''}"><b>${value}</b><span>${label}</span></div>`;

/**
 * The card. `#db-roster` is an empty mount: the caller fills it when the
 * player asks for the roster, so a company of 140 men is not laid out for a
 * player who only wants to know how it went.
 */
export function debriefHtml(d: DebriefSummary, actions: readonly DebriefAction[]): string {
  return `<div class="db-scroll"><div class="db">
    <h1 class="${d.won ? 'win' : 'loss'}">${d.won ? 'VICTORY' : 'DEFEAT'}</h1>
    <p class="sub">${esc(d.outcome)}</p>
    <div class="db-stats">
      ${stat(String(d.kia.length), 'killed', d.kia.length > 0 ? 'bad' : '')}
      ${stat(String(d.wounded), 'wounded')}
      ${stat(d.enemyLosses > 0 ? `~${d.enemyLosses}` : '0', 'enemy losses')}
    </div>
    <p class="fallen${d.kia.length === 0 ? ' none' : ''}">${esc(fallenLine(d.kia))}</p>
    <div id="db-roster"></div>
    </div></div>
    ${actionRow(actions)}`;
}

const actionRow = (actions: readonly DebriefAction[]): string =>
  `<div class="db-actions">${actions.map((a) => `<button id="${a.id}"${a.primary ? ' class="primary"' : ''}>${esc(a.label)}</button>`).join('')}</div>`;

/**
 * The card that ends the drill. No roster and no numbers: these men belong to
 * no campaign, and the one thing to take away is the order of a fight.
 * `forward` is the way on: into the first campaign, or back to the menu on a
 * profile that already has one. A lost drill leads with the retry.
 */
export function drillEndHtml(won: boolean, forward: string): string {
  const again: DebriefAction = { id: 'db-again', label: won ? 'Play it again' : 'Try again', primary: !won };
  const on: DebriefAction = { id: 'next', label: forward, primary: won };
  return `<div class="db-scroll"><div class="db">
    <h1 class="${won ? 'win' : 'loss'}">${won ? 'FARM TAKEN' : 'THE FARM HELD'}</h1>
    <p class="sub">Cover, fire, assault. That is every fight.</p>
    </div></div>
    ${actionRow(won ? [on, again] : [again, on])}`;
}
