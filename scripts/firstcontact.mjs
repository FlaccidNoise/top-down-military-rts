// First-contact sweep, headless: which preset gives a new player a first
// battle they can win? This is the measurement behind FIRST_PRESET in
// src/campaign/presets.ts. It changes no balance: it reads the presets as they
// are and reports.
//
//   npx vite-node scripts/firstcontact.mjs -- [--seeds 8] [--start 1] [--presets "Skirmish,Normandy Bocage"]
//                                             [--pick nearest|weakest|none] [--cap-min 25] [--no-fight] [--out FILE.jsonl]
//
// Per preset and seed it does what the theater tutorial tells a new player to
// do: take the strongest company and march it at a gold-ringed town it can
// reach. --pick says which: the nearest (the default, and what a player with
// no advice does), or the one with the weakest garrison (what the tutorial's
// ring points at: theaterMark in src/main.ts), or none: the player presses Play
// and orders nothing, which is how a first battle comes to be one he defends.
// The war runs through the same per-minute body main.ts runs
// (red plans, stepWar, the day rolls) until that march meets somebody. The
// contact is then staged through makeTheaterBattle and fought by the two
// battle commanders, blue's included: the attack doctrine stands in for a
// player who follows the drill. A human is not that commander, so read the win
// rate as "the odds and the ground allow it", not as a promise.
//
// One battle is 140 men against a garrison on a 320 m map and takes about a
// minute of wall time. --no-fight skips it and reports the odds alone.
import { appendFileSync } from 'node:fs';
import { advanceDays, fillReplacements } from '../src/campaign/campaign';
import { PRESETS } from '../src/campaign/presets';
import { makeTheaterBattle } from '../src/strategic/bridge2';
import { REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY } from '../src/strategic/front';
import { warStatus } from '../src/strategic/goals';
import { makeHeadlessWorld } from '../src/strategic/headless';
import { orderMove, previewMove } from '../src/strategic/theater/step';
import { syncStrengthsV2 } from '../src/strategic/theater/sync';
import { openBattle, stepWar } from '../src/strategic/theater/war';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const SEEDS = Number(arg('seeds', 8));
const START = Number(arg('start', 1));
const CAP_TICKS = Number(arg('cap-min', 25)) * 60 * 30;
const FIGHT = !process.argv.includes('--no-fight');
const OUT = arg('out', null);
const PICK = arg('pick', 'nearest');
if (PICK !== 'nearest' && PICK !== 'weakest' && PICK !== 'none') throw new Error(`--pick is "nearest", "weakest" or "none", not "${PICK}"`);
const names = arg('presets', PRESETS.map((p) => p.name).join(',')).split(',');
const presets = names.map((n) => {
  const p = PRESETS.find((x) => x.name === n.trim());
  if (!p) throw new Error(`no preset named "${n}". The presets are: ${PRESETS.map((x) => x.name).join(', ')}`);
  return p;
});

const effective = (sim, side) => sim.soldiers.filter((s) => s.side === side && s.alive && !s.downed && !s.captured).length;

function firstContact(preset, seed) {
  let w;
  try {
    w = makeHeadlessWorld(seed, preset.theater, preset.campaign);
  } catch (e) {
    return { preset: preset.name, seed, outcome: 'no-theater', why: e.message };
  }
  const { front, campaign, goals } = w;
  const ctrl = goals.blue.find((c) => c.kind === 'control');
  const blues = front.forces.filter((f) => f.side === 'blue' && f.strength > 0);
  const company = blues.slice().sort((a, b) => b.strength - a.strength)[0];
  // An objective the company can be ordered onto that it does not hold.
  const garrison = (n) => front.forces.filter((f) => f.side === 'red' && f.strength > 0 && f.pos.kind === 'node' && f.pos.nodeId === n).reduce((a, f) => a + f.strength, 0);
  const target = ctrl.nodeIds
    .filter((n) => front.controlByNode[n] !== 'blue')
    .map((n) => ({ n, red: garrison(n), p: previewMove(front, company.id, n, { nightTempo: preset.campaign.nightTempo }) }))
    .filter((t) => t.p.ok)
    .sort((a, b) => (PICK === 'weakest' ? a.red - b.red : 0) || a.p.etaMin - b.p.etaMin)[0];
  const base = {
    preset: preset.name, seed, objectives: ctrl.nodeIds.length, need: ctrl.need,
    blueForces: blues.length, blueMen: blues.reduce((a, f) => a + f.strength, 0),
    redForces: front.forces.filter((f) => f.side === 'red' && f.strength > 0).length,
    redMen: front.forces.filter((f) => f.side === 'red').reduce((a, f) => a + f.strength, 0),
  };
  if (!target) return { ...base, outcome: 'no-reachable-objective' };
  if (PICK !== 'none') orderMove(front, company.id, target.n, { nightTempo: preset.campaign.nightTempo });

  let contact = null;
  let prevDay = front.day;
  const capMin = preset.campaign.warDays * 1440;
  for (let m = 0; m < capMin && !contact; m++) {
    w.red.evaluate(front, w.redIntel);
    const r = stepWar(front, campaign, { autoBattle: () => false, supply: preset.campaign.supply, recon: preset.campaign.recon, nightTempo: preset.campaign.nightTempo });
    if (front.day > prevDay) {
      advanceDays(campaign, front.day - prevDay);
      if (front.day % REINFORCE_CYCLE_DAYS === 0) fillReplacements(campaign, front.day * 31 + 7, REINFORCE_PER_COMPANY);
      syncStrengthsV2(campaign, front);
      prevDay = front.day;
    }
    contact = r.pendingContacts[0] ?? null;
    if (!contact && warStatus(front, goals).state === 'decided') return { ...base, outcome: 'war-decided-first', etaMin: target.p.etaMin };
    // The march arrived and nobody was home: the town flipped without a fight.
    if (!contact && PICK !== 'none' && company.path.length === 0 && front.controlByNode[target.n] === 'blue') return { ...base, outcome: 'walked-in', etaMin: target.p.etaMin };
  }
  if (!contact) return { ...base, outcome: 'no-contact', etaMin: target.p.etaMin };

  const atk = front.forces.find((f) => f.id === contact.attackerId);
  const def = front.forces.find((f) => f.id === contact.defenderId);
  const blue = atk.side === 'blue' ? atk : def;
  const red = atk.side === 'blue' ? def : atk;
  const met = {
    ...base, etaMin: Math.round(target.p.etaMin), contactDay: front.day, contactHour: Math.round((front.clockMin / 60) * 10) / 10, playerAttacks: atk.side === 'blue',
    blue: blue.strength, red: red.strength, ratio: Math.round((blue.strength / red.strength) * 100) / 100, redRole: red.role,
  };
  if (!FIGHT) return { ...met, outcome: 'contact' };

  const tb = makeTheaterBattle(campaign, front, openBattle(front, contact));
  const { sim } = tb;
  const t0 = performance.now();
  while (sim.winner === null && sim.tick < CAP_TICKS) {
    tb.commander.update(sim);
    tb.blueCommander.update(sim);
    sim.step();
    sim.takeEvents();
    sim.takeBooms();
    sim.takeMeleeEvents();
    sim.takeBreaches();
    sim.takePlanes();
    sim.takeUnitEvents();
  }
  return {
    ...met, outcome: sim.winner ?? 'undecided', battleClass: tb.battleClass, battleMin: Math.round(sim.tick / 30 / 6) / 10,
    blueStart: sim.startStrength.blue, blueLeft: effective(sim, 'blue'), blueKia: sim.soldiers.filter((s) => s.side === 'blue' && !s.alive).length,
    redStart: sim.startStrength.red, redLeft: effective(sim, 'red'), wallS: Math.round((performance.now() - t0) / 100) / 10,
  };
}

const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);
for (const preset of presets) {
  const rows = [];
  for (let s = START; s < START + SEEDS; s++) {
    const r = firstContact(preset, s);
    rows.push(r);
    console.log(JSON.stringify(r));
    if (OUT) appendFileSync(OUT, `${JSON.stringify(r)}\n`);
  }
  const met = rows.filter((r) => r.ratio !== undefined);
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  const fought = met.filter((r) => r.blueStart !== undefined);
  console.log(
    `== ${preset.name}, ${PICK} objective: ${rows.length} seeds. Contact in ${met.length} (walked in ${count('walked-in')}, no theater ${count('no-theater')}, no contact ${count('no-contact') + count('no-reachable-objective') + count('war-decided-first')}). ` +
      `Odds blue:red at contact: median ${med(met.map((r) => r.ratio))}, worst ${Math.min(...met.map((r) => r.ratio))}, under 1.5:1 in ${met.filter((r) => r.ratio < 1.5).length}. Player attacks in ${met.filter((r) => r.playerAttacks).length}. ` +
      `Objectives: median ${med(rows.filter((r) => r.objectives).map((r) => r.objectives))}, need ${med(rows.filter((r) => r.need).map((r) => r.need))}. ` +
      (FIGHT
        ? `Fought ${fought.length}: blue wins ${fought.filter((r) => r.outcome === 'blue').length}, red wins ${fought.filter((r) => r.outcome === 'red').length}, undecided ${fought.filter((r) => r.outcome === 'undecided').length}. ` +
          `Blue killed in a won battle: median ${med(fought.filter((r) => r.outcome === 'blue').map((r) => r.blueKia))} of ${med(fought.map((r) => r.blueStart))}.`
        : 'Battles not fought (--no-fight).'),
  );
}
