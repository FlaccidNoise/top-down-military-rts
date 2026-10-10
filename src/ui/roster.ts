// What the roster says about a squad and a man, as words. Pure, no DOM: the
// HUD (hud.ts) lays these out.
import type { Sim, Soldier } from '../sim/sim';

/**
 * Squad names without the company they all share. Every squad of a company is
 * "Able 1st", "Able MG 1": in a 258 px roster nine rows read "Abl…". The first
 * word goes only when every name carries it and something is left after it.
 */
export function shortNames(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const prefix = `${names[0].split(' ')[0]} `;
  return names.every((n) => n.startsWith(prefix) && n.length > prefix.length) ? names.map((n) => n.slice(prefix.length)) : [...names];
}

export const reserveAmmo = (s: Soldier): number => Object.values(s.ammo).reduce((a, n) => a + (n ?? 0), 0);

/** A squad is short of ammunition under this share of what it carried in. */
export const LOW_AMMO_SHARE = 0.25;

/** Ammunition is shown only when it is a problem. */
export function squadAmmoLow(men: readonly Soldier[]): boolean {
  let left = 0;
  let start = 0;
  for (const m of men) {
    if (!m.alive) continue;
    left += reserveAmmo(m);
    start += m.ammoStart;
  }
  return start > 0 && left < start * LOW_AMMO_SHARE;
}

/**
 * The one place a roster row states a man's ammunition: nothing while he has a
 * reload, a word when he does not. Counted from what he is firing: his own
 * magazine and pouches on foot, the gun's belt and its crew's stock when he
 * serves a deployed gun.
 */
export function manAmmo(sim: Sim, m: Soldier): '' | 'LAST MAG' | 'NO AMMO' {
  const { mag, reserve } = sim.firingAmmo(m);
  if (reserve > 0) return '';
  return mag > 0 ? 'LAST MAG' : 'NO AMMO';
}

export type ManStatus = 'KIA' | 'DOWN' | 'BROKEN' | 'PINNED' | 'SHAKEN' | '';

/** The status word beside a man's name. A steady man needs none. */
export function manStatus(m: Soldier): ManStatus {
  if (!m.alive) return 'KIA';
  if (m.downed) return 'DOWN';
  return m.mental === 'steady' ? '' : (m.mental.toUpperCase() as ManStatus);
}
