// The contact callout's copy (jtbug #782): what a player needs before he
// answers a contact, in a few words each. Pure, so the words and every number
// in them can be tested: each number comes from its owning constant or from
// the live function, never from a digit typed here.
import type { MapKind } from '../sim/mapgen';
import { TRIVIAL_RATIO } from '../strategic/bridge';
import { fmtEta } from '../render/theater-view';
import { BATTLE_CLASS_TO_MAPKIND, type BattleClass } from '../strategic/theater';
import type { Contact } from '../strategic/theater/contact';
import type { Force, FrontV2 } from '../strategic/theater/force';
import { dugIn } from '../strategic/theater/step';
import { supplyTierOf } from '../strategic/theater/supply';
import { SUPPORT_BARRAGES } from '../strategic/bridge2';
import { previewMove } from '../strategic/theater/step';
import { battleDuration, contactWalkover, RETREAT_SETBACK_M, siteDefence, supportersOf } from '../strategic/theater/war';

const FIGHT: Record<BattleClass, string> = {
  settlement: 'Town fight',
  hamlet: 'Village fight',
  forest: 'Fight in the woods',
  farmland: 'Fight in open fields',
  marsh: 'Fight in the marsh',
  roadside: 'Roadside fight',
  'bridge-assault': 'Bridge assault',
  'ford-assault': 'Ford assault',
};
const GROUND: Record<MapKind, string> = {
  bourg: 'a walled town',
  open: 'open farmland',
  woods: 'woodland',
  road: 'a road through fields',
  bridge: 'a river and one bridge',
  river: 'a river to wade',
};

export interface ContactBrief {
  title: string; // the place
  kind: string; // the fight and the map to expect
  sides: { name: string; side: Force['side']; men: string; state: string }[]; // attacker first
  odds: string;
  forced: string | null; // set when the enemy chose the fight
  facts: string[]; // who can join, the time it costs, what Stand down does
  playerAttacks: boolean;
  trivial: boolean;
}

export interface BriefOpts {
  supply: boolean; // supply rules are on
  fog: boolean; // the enemy's condition is not known
  nightTempo?: boolean; // the march kernel's night rule, for the "away" time
}

// A company this near in march time is worth naming as on its way.
export const SUPPORT_WAIT_MIN = 180;

const fatigueWord = (f: number): string => (f >= 0.66 ? 'exhausted' : f >= 0.33 ? 'tired' : 'fresh');
const supplyWord = (f: Force): string => ({ full: 'supplied', low: 'supply low', out: 'out of supply' })[supplyTierOf(f.untracedMin)];

export function contactBrief(front: FrontV2, c: Contact, opts: BriefOpts): ContactBrief {
  const atk = front.forces.find((f) => f.id === c.attackerId)!;
  const def = front.forces.find((f) => f.id === c.defenderId)!;
  const playerAttacks = atk.side === 'blue';
  // The test openBattle makes: the offer here is the forced winner there.
  const winner = contactWalkover(atk, def);
  const trivial = winner !== null;

  // The same approach openBattle records, so the class named here is the
  // class the battle is staged as.
  const approach = atk.pos.kind === 'edge' ? atk.pos.edgeId : atk.lastEdgeId;
  const { battleClass } = siteDefence(front.theater, c.site, approach);

  const state = (f: Force): string =>
    f.side === 'red' && opts.fog
      ? 'condition unknown'
      : [opts.supply ? supplyWord(f) : null, fatigueWord(f.fatigue), f === def && dugIn(f) ? 'dug in' : f.posture === 'rest' ? 'at rest' : null].filter(Boolean).join(' · ');

  // Odds in plain words: the man reading this should not have to divide.
  const own = playerAttacks ? atk : def;
  const foe = playerAttacks ? def : atk;
  const ratio = Math.max(own.strength, foe.strength) / Math.max(1, Math.min(own.strength, foe.strength));
  const rtxt = ratio < 2 ? ratio.toFixed(1) : Math.round(ratio).toString();
  const odds =
    ratio < 1.1 ? 'Even match.' : own.strength > foe.strength ? `You outnumber them ${rtxt}:1.` : `They outnumber you ${rtxt}:1.`;

  // Why this is a walkover, or why numbers alone are not one. A few words:
  // the weakest thing about the loser first, then the ground.
  const weak = (f: Force): string | null => {
    const tier = opts.supply ? supplyTierOf(f.untracedMin) : 'full';
    if (tier === 'out') return 'out of supply';
    if (tier === 'low') return 'low on supply';
    if (f.fatigue >= 0.66) return 'exhausted';
    return f.posture === 'rest' ? 'caught at rest' : null;
  };
  const playerWins = winner === (playerAttacks ? 'attacker' : 'defender');
  const because = (f: Force, they: boolean): string => {
    const w = they && opts.fog ? null : weak(f);
    return w ? `${they ? 'They are' : 'You are'} ${w}.` : '';
  };
  let why = '';
  if (trivial) why = `${because(playerWins ? foe : own, playerWins)} ${playerWins ? 'A walkover: auto-resolve offered.' : 'They would walk over you.'}`.trim();
  else if (foe === def && dugIn(def) && own.strength >= foe.strength * TRIVIAL_RATIO) why = 'No walkover: they are dug in.';

  // Who else is inside contact range of the site and free: the list staging
  // reads. Each of ours lends its fire to a fought battle. Under fog only our
  // own are named: an enemy the player has not seen is not on this card.
  const near = supportersOf(front, c.site, [atk.id, def.id]);
  const ours = near.filter((f) => f.side === 'blue');
  const theirs = opts.fog ? [] : near.filter((f) => f.side === 'red');
  const lend = (n: number): string => `+${n * SUPPORT_BARRAGES} barrage${n * SUPPORT_BARRAGES === 1 ? '' : 's'}`;
  // Nobody in range yet: the nearest company that could be, and how long it
  // needs. That is the choice: go now, or stand down and come back with it.
  const coming = (): string | null => {
    if (c.site.kind !== 'node') return null;
    const node = c.site.nodeId;
    const best = front.forces
      .filter((f) => f.side === 'blue' && f.strength > 0 && f.engagedIn === null && f.id !== atk.id && f.id !== def.id)
      .map((f) => ({ f, p: previewMove(front, f.id, node, { nightTempo: opts.nightTempo }) }))
      .flatMap((x) => (x.p.ok ? [{ name: x.f.name, min: x.p.etaMin }] : []))
      .sort((p, q) => p.min - q.min)[0];
    return best && best.min <= SUPPORT_WAIT_MIN ? `${best.name} is ${fmtEta(best.min)} away.` : null;
  };
  const join = [
    ours.length > 0 ? `${ours.map((f) => f.name).join(', ')} in range: ${lend(ours.length)}.` : (coming() ?? 'None in range to join.'),
    theirs.length > 0 ? `Enemy in range: ${theirs.map((f) => f.name).join(', ')}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const facts = [join, `Costs ${fmtEta(battleDuration(atk.strength, def.strength, trivial))}.`];
  if (playerAttacks) facts.push(`Stand down: fall back ${RETREAT_SETBACK_M / 1000} km, no losses.`);

  return {
    title: c.site.kind === 'node' ? front.theater.nodes[c.site.nodeId].name : 'On the road',
    kind: `${FIGHT[battleClass]} · map: ${GROUND[BATTLE_CLASS_TO_MAPKIND[battleClass]]}`,
    sides: [atk, def].map((f) => ({ name: f.name, side: f.side, men: `${f.strength} men`, state: state(f) })),
    odds: why ? `${odds} ${why}` : odds,
    forced: playerAttacks ? null : 'They chose this fight. A defender cannot stand down.',
    facts,
    playerAttacks,
    trivial,
  };
}

// Every word the card shows before a button.
export function briefWords(b: ContactBrief): string[] {
  return ['CONTACT', b.title, b.kind, ...b.sides.flatMap((s) => [s.name, s.men, s.state]), b.odds, b.forced ?? '', ...b.facts]
    .join(' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w));
}
