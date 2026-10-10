// coarsefit (jtbug #796): the coarse resolver against fought battles.
//
// "Auto-resolve" and "fight it yourself" must be the same game at the same
// odds, and both planners decide with the coarse one. This measures the
// fought game per battle class and force ratio, then prints it beside what
// the coarse resolver gives for the same class and ratio, read from the
// constants as they stand in src. It changes nothing.
//
//   npx vite-node scripts/coarsefit.mjs -- --fight --classes settlement,hamlet --ratios 1,1.5,2,3 --seeds 6 --out FILE.jsonl
//   npx vite-node scripts/coarsefit.mjs -- --fight --attacker red --classes roadside --ratios 1,1.5 --seeds 4 --out FILE.jsonl
//   npx vite-node scripts/coarsefit.mjs -- --fight --dug --classes settlement --ratios 1.5,2 --seeds 6 --out FILE.jsonl   # the defender dug in
//   npx vite-node scripts/coarsefit.mjs -- --table FILE.jsonl [FILE2.jsonl ...]     # coarse against fought, and a fitted multiplier per class
//
// A fought battle is staged through makeTheaterBattle, the path a theater
// contact takes, on a real generated theater: a site of the wanted class is
// found on it, the attacker is put 250 m out on a road into it and the
// defender on it. The AI commands both sides (scripts/firstcontact.mjs has
// the same loop). Blue is always one company off the campaign roster, so the
// ratio is set by red's strength. Clock 14:00, 25-minute cap. A battle the
// attacker has not won at the cap is the defender's: that is what the theater
// does with it. One battle is about a minute of wall time: shard it with
// xargs -P (see the scratchpad run script named in the commit).
import { appendFileSync, readFileSync } from 'node:fs';
import { fitStrength } from '../src/campaign/campaign';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { mulberry32 } from '../src/sim/rng';
import { coarseOdds, coarseOutcome } from '../src/strategic/bridge';
import { makeTheaterBattle } from '../src/strategic/bridge2';
import { makeHeadlessWorld } from '../src/strategic/headless';
import { battleSiteOf, COARSE_DEF_MULT, CROSSING_ASSAULT_MULT } from '../src/strategic/theater';
import { addForce } from '../src/strategic/theater/force';
import { DIG_IN_MIN } from '../src/strategic/theater/step';
import { openBattle, siteDefence } from '../src/strategic/theater/war';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const CLASSES = ['settlement', 'hamlet', 'forest', 'farmland', 'marsh', 'roadside', 'bridge-assault', 'ford-assault'];
const CAP_TICKS = Number(arg('cap-min', 25)) * 60 * 30;
const COARSE_ROLLS = 4000;
const effective = (sim, side) => sim.soldiers.filter((s) => s.side === side && s.alive && !s.downed && !s.captured).length;

// A site of `cls` on this theater and a road into it, or null.
function siteOf(t, cls) {
  const foot = t.edges.filter((e) => e.moveClass !== 'rail');
  for (const n of t.nodes) {
    for (const e of foot.filter((x) => x.a === n.id || x.b === n.id)) {
      if (e.lengthM < 600) continue;
      const site = { kind: 'node', nodeId: n.id };
      if (battleSiteOf(t, site, e.id).battleClass === cls) return { site, edge: e, towardB: e.b === n.id };
    }
  }
  for (const e of foot) {
    if (e.lengthM < 1200) continue;
    const site = { kind: 'edge', edgeId: e.id, s: e.lengthM / 2, dir: -1 };
    if (battleSiteOf(t, site).battleClass === cls) return { site, edge: e, towardB: true, mid: true };
  }
  return null;
}

function fight(cls, ratio, k, attackerSide) {
  // The k-th theater that has such a site.
  let w = null;
  let at = null;
  for (let seed = k, tries = 0; tries < 60 && !at; seed += 37, tries++) {
    try {
      w = makeHeadlessWorld(seed, DEFAULT_PRESET.theater, DEFAULT_PRESET.campaign);
    } catch {
      continue;
    }
    at = siteOf(w.front.theater, cls);
  }
  if (!at) return { cls, ratio, k, outcome: 'no-site' };
  const { front, campaign } = w;
  front.forces.length = 0;
  front.battles.length = 0;
  front.clockMin = 840;
  const blueMen = fitStrength(campaign, 0);
  const redMen = Math.max(8, Math.round(attackerSide === 'blue' ? blueMen / ratio : blueMen * ratio));
  const e = at.edge;
  const out = 250; // metres from the site
  const atkPos = at.mid
    ? { kind: 'edge', edgeId: e.id, s: e.lengthM / 2 - out, dir: 1 }
    : { kind: 'edge', edgeId: e.id, s: at.towardB ? e.lengthM - out : out, dir: at.towardB ? 1 : -1 };
  const mk = (side, pos, path, strength) =>
    addForce(front, { side, name: side === 'blue' ? campaign.companies[0].name : 'Kampfgruppe', pos, path, dwellMin: 0, strength, companyIndex: side === 'blue' ? 0 : -1, role: 'line', engagedIn: null, queuedAt: null });
  const atk = mk(attackerSide, atkPos, [e.id], attackerSide === 'blue' ? blueMen : redMen);
  const def = mk(attackerSide === 'blue' ? 'red' : 'blue', at.site, [], attackerSide === 'blue' ? redMen : blueMen);
  if (has('dug')) {
    def.posture = 'dig';
    def.dugMin = DIG_IN_MIN;
  }
  const battle = openBattle(front, { attackerId: atk.id, defenderId: def.id, site: def.pos, gapM: out });
  const tb = makeTheaterBattle(campaign, front, battle);
  const { sim } = tb;
  const start = { blue: effective(sim, 'blue'), red: effective(sim, 'red') };
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
  const left = { blue: effective(sim, 'blue'), red: effective(sim, 'red') };
  const defSide = attackerSide === 'blue' ? 'red' : 'blue';
  return {
    cls: tb.battleClass, asked: cls, ratio, k, theaterSeed: w.seed, attacker: attackerSide, dug: has('dug'),
    atk: atk.strength, def: def.strength, mult: siteDefence(front.theater, battle.site, battle.approachEdgeId).mult,
    outcome: sim.winner === attackerSide ? 'attacker' : sim.winner === null ? 'held' : 'defender',
    atkStart: start[attackerSide], atkLeft: left[attackerSide], defStart: start[defSide], defLeft: left[defSide],
    battleMin: Math.round(sim.tick / 30 / 6) / 10, wallS: Math.round((performance.now() - t0) / 100) / 10,
  };
}

if (has('fight')) {
  const classes = arg('classes', CLASSES.join(',')).split(',');
  const ratios = arg('ratios', '1,1.5,2,3').split(',').map(Number);
  const seeds = Number(arg('seeds', 4));
  const start = Number(arg('start', 1));
  const attackerSide = arg('attacker', 'blue');
  const outFile = arg('out', null);
  for (const cls of classes) {
    for (const ratio of ratios) {
      for (let k = start; k < start + seeds; k++) {
        const row = fight(cls, ratio, k, attackerSide);
        const line = JSON.stringify(row);
        console.log(line);
        if (outFile) appendFileSync(outFile, line + '\n');
      }
    }
  }
}

if (has('table')) {
  const files = process.argv.slice(process.argv.indexOf('--table') + 1).filter((a) => !a.startsWith('--'));
  const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))).filter((r) => r.outcome !== 'no-site');
  const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  for (const attacker of ['blue', 'red']) {
    const mine = rows.filter((r) => r.attacker === attacker);
    if (mine.length === 0) continue;
    console.log(`\n${attacker} attacking: fought (AI both sides, through makeTheaterBattle) against coarse (the constants in src now)`);
    console.log('class            ratio   n  fought win  coarse win   fought: winner lost, loser lost   coarse: winner, loser   best-fit mult for the odds formula in src (mult in src)');
    for (const cls of CLASSES) {
      const ofClass = mine.filter((r) => r.cls === cls);
      if (ofClass.length === 0) continue;
      // The multiplier that makes the coarse win chance match each ratio's fought rate, least squares over the ratios.
      let best = null;
      for (let m = 0.2; m <= 12; m += 0.05) {
        let err = 0;
        for (const ratio of [...new Set(ofClass.map((r) => r.ratio))]) {
          const g = ofClass.filter((r) => r.ratio === ratio);
          const won = g.filter((r) => r.outcome === 'attacker').length / g.length;
          const a = mean(g.map((r) => r.atk));
          const d = mean(g.map((r) => r.def));
          err += g.length * (coarseOdds(a, d, m) - won) ** 2;
        }
        if (!best || err < best.err) best = { m, err };
      }
      for (const ratio of [...new Set(ofClass.map((r) => r.ratio))].sort((a, b) => a - b)) {
        const g = ofClass.filter((r) => r.ratio === ratio);
        const won = g.filter((r) => r.outcome === 'attacker');
        const lost = g.filter((r) => r.outcome !== 'attacker');
        const a = mean(g.map((r) => r.atk));
        const d = mean(g.map((r) => r.def));
        const multNow = COARSE_DEF_MULT[cls] * (cls === 'bridge-assault' || cls === 'ford-assault' ? CROSSING_ASSAULT_MULT : 1);
        const frac = (start, left) => 1 - left / Math.max(1, start);
        const winnerLoss = mean([...won.map((r) => frac(r.atkStart, r.atkLeft)), ...lost.map((r) => frac(r.defStart, r.defLeft))]);
        const loserLoss = mean([...won.map((r) => frac(r.defStart, r.defLeft)), ...lost.map((r) => frac(r.atkStart, r.atkLeft))]);
        // The coarse resolver itself, rolled COARSE_ROLLS times for this class
        // and ratio: its win rate and its mean losses. Whatever its constants
        // and its shape are, this is what it does.
        const rng = mulberry32(0x636f6172);
        let cWins = 0;
        let cWinner = 0;
        let cLoser = 0;
        for (let i = 0; i < COARSE_ROLLS; i++) {
          const o = coarseOutcome(Math.round(a), Math.round(d), multNow, rng);
          if (o.attackerWins) cWins++;
          cWinner += o.attackerWins ? o.atkLosses / a : o.defLosses / d;
          cLoser += o.attackerWins ? o.defLosses / d : o.atkLosses / a;
        }
        console.log(
          `${cls.padEnd(16)} ${String(ratio).padStart(4)}  ${String(g.length).padStart(2)}  ${pct(won.length / g.length)} (${won.length}/${g.length})   ${pct(cWins / COARSE_ROLLS)}         ${pct(winnerLoss)}  ${pct(loserLoss)}                     ${pct(cWinner / COARSE_ROLLS)}  ${pct(cLoser / COARSE_ROLLS)}        ${ratio === Math.min(...ofClass.map((r) => r.ratio)) ? `${best.m.toFixed(2)} (${multNow.toFixed(2)})` : ''}`,
        );
      }
    }
    const frac = (start, left) => 1 - left / Math.max(1, start);
    const winner = mine.map((r) => (r.outcome === 'attacker' ? frac(r.atkStart, r.atkLeft) : frac(r.defStart, r.defLeft))).sort((a, b) => a - b);
    const loser = mine.map((r) => (r.outcome === 'attacker' ? frac(r.defStart, r.defLeft) : frac(r.atkStart, r.atkLeft))).sort((a, b) => a - b);
    const q = (xs, f) => xs[Math.min(xs.length - 1, Math.floor(xs.length * f))];
    console.log(`losses over all ${mine.length} battles: winner p10/median/p90 ${pct(q(winner, 0.1))}/${pct(q(winner, 0.5))}/${pct(q(winner, 0.9))} · loser ${pct(q(loser, 0.1))}/${pct(q(loser, 0.5))}/${pct(q(loser, 0.9))}`);
  }
}
