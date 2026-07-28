// Balance baseline harness: does a zero-skill blob rush beat the campaign's
// prepared defense, and does the AI's suppression-and-maneuver doctrine?
//
// Stages the LIVE campaign battle path (makeStrategicBattle: US rifle company
// attacking the full-strength German garrison, red commander in defend stance
// with garrison posts, campaign clock 06:00) on {profile x kind x seed} and
// runs each cell to a winner or the tick cap. Timeout counts as defender hold.
//
//   npx vite-node scripts/balance.mjs -- [--seeds 6] [--cap 54000]
//                                        [--kinds open,woods,bourg]
//                                        [--profiles blob,blob-fast,doctrine]
//                                        [--out .balance-baseline.json]
//
// Every run is a pure function of (profile, kind, seed): cells can be run in
// parallel processes (split by --profiles/--kinds, distinct --out files) and
// merged, with bit-identical results to one sequential sweep.
//
// Profiles (attacker order policies):
//   blob       one tick-0 burst: every blue squad gets the same 'move' order to
//              the objective farthest from the west spawn, fanned exactly the
//              way main.ts commitOrder fans a select-all right-click
//              (fanOffsets(K, SQUAD_FAN) on y). No further blue input, ever.
//   blob-fast  same burst with kind 'fast' (the armed-order path, which also
//              issues sim.orderSquad for every selected squad).
//   doctrine   blue handed to the AI commander (the P-toggle path: the same
//              blueCommander makeStrategicBattle returns) and left to play.
//
// Kinds are the campaign's live land archetypes: 'open' (hedgerow parcels),
// 'woods' (the bocage-heaviest legacy kind: hedge banks + sunken lanes + dense
// stands), 'bourg' (the village generator the objective towns use). There is
// no 'bocage' MapKind; hedgerows are a feature of the legacy kinds' parcels.
//
// Writes scripts/.balance-baseline.json and prints a compact table.
// @ts-nocheck
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { newCampaign } from '../src/campaign/campaign';
import { generateMap } from '../src/sim/mapgen';
import { fanOffsets, SQUAD_FAN } from '../src/sim/sim';
import { makeStrategicBattle, newFront } from '../src/strategic/bridge';
import { makeDefaultSector } from '../src/strategic/sector';

const argNum = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
};
const argList = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1].split(',') : dflt;
};

const SEEDS = argNum('seeds', 6);
const SEED_START = argNum('seed-start', 1); // shard a slow cell by seed range: --seed-start 4 --seeds 6
const CAP = argNum('cap', 54_000); // 30 game-minutes at DT=1/30s
const KINDS = argList('kinds', ['open', 'woods', 'bourg']);
const PROFILES = argList('profiles', ['blob', 'blob-fast', 'doctrine']);
const OUT = argList('out', ['.balance-baseline.json'])[0];
// --out resolves against THIS script's directory, not cwd — 'scripts/x.json'
// from the repo root doubles to scripts/scripts/ and the ENOENT lands AFTER
// the whole sweep has run. Touch the target now so a bad path dies in 1s.
const OUT_URL = new URL(`./${OUT}`, import.meta.url);
// Not under --merge: a pre-touched 0-byte .bal-* out file would land in the
// merge's own shard glob and JSON.parse('') kills the merge it protects.
if (!process.argv.includes('--merge')) writeFileSync(OUT_URL, '', { flag: 'a' });

// One cell: campaign seed = battle seed = `seed`, defender is the
// full-strength (109-man) Garnison St-Aubin, engagement cell terrain forced to
// `kind` so the live staging path generates the archetype under test.
function runCell(profile, kind, seed) {
  const c = newCampaign(seed);
  const front = newFront(c, makeDefaultSector());
  const able = front.chits.find((ch) => ch.side === 'blue');
  const garrison = front.chits.find((ch) => ch.name === 'Garnison St-Aubin');
  front.sector.cells[garrison.cell].terrain = kind;
  const e = { attackerId: able.id, defenderId: garrison.id, cell: garrison.cell };
  const { sim, commander, blueCommander } = makeStrategicBattle(c, front, e, seed);

  const start = { ...sim.startStrength };

  if (profile === 'blob' || profile === 'blob-fast') {
    // Recover the plan makeStrategicBattle staged on (generateMap is pure and
    // bridge.ts:139 calls it with exactly these args) to find the far objective.
    const plan = generateMap(seed, 320, 240, kind, { interiors: true });
    const west = plan.spawns.west;
    const far = plan.objectives.reduce((a, o) =>
      Math.hypot(o.x - west.x, o.y - west.y) > Math.hypot(a.x - west.x, a.y - west.y) ? o : a,
    );
    // main.ts commitOrder, plain right-click branch: every selected squad gets
    // { kind, x: wx, y: wy + fanOffsets(K, SQUAD_FAN)[i] } via sim.orderSquad.
    const blueSquads = sim.squads.filter((sq) => sq.side === 'blue');
    const offs = fanOffsets(blueSquads.length, SQUAD_FAN);
    const orderKind = profile === 'blob' ? 'move' : 'fast';
    blueSquads.forEach((sq, i) => sim.orderSquad(sq.id, { kind: orderKind, x: far.x, y: far.y + offs[i] }));
  }

  const t0 = performance.now();
  let ticks = 0;
  while (sim.winner === null && ticks < CAP) {
    commander.update(sim);
    if (profile === 'doctrine') blueCommander.update(sim);
    sim.step();
    ticks++;
    // drain the render-side buffers so a long battle doesn't hoard events
    sim.takeEvents();
    sim.takeBooms();
    sim.takeMeleeEvents();
    sim.takeBreaches();
    sim.takePlanes();
  }
  const wallS = (performance.now() - t0) / 1000;

  const tally = { blue: { kia: 0, wia: 0, cap: 0 }, red: { kia: 0, wia: 0, cap: 0 } };
  for (const s of sim.soldiers) {
    const t = tally[s.side];
    if (!s.alive) t.kia++;
    else if (s.captured) t.cap++;
    else if (s.downed) t.wia++;
  }
  const pct = (n, side) => Math.round((1000 * n) / start[side]) / 10;
  return {
    profile,
    kind,
    seed,
    winner: sim.winner ?? 'hold', // hold = tick cap: the defender kept the field
    ticks,
    gameMin: Math.round((ticks / 30 / 60) * 10) / 10,
    start,
    blueKiaPct: pct(tally.blue.kia, 'blue'),
    blueWiaPct: pct(tally.blue.wia, 'blue'),
    blueCapPct: pct(tally.blue.cap, 'blue'),
    redKiaPct: pct(tally.red.kia, 'red'),
    redWiaPct: pct(tally.red.wia, 'red'),
    redCapPct: pct(tally.red.cap, 'red'),
    wallS: Math.round(wallS * 10) / 10,
  };
}

// --merge: skip simulation, concatenate previously written shard files
// (scripts/.bal-*.json, produced by parallel invocations with --out) into the
// canonical baseline. Runs are re-sorted so shard order can't matter.
const MERGE = process.argv.includes('--merge');
const runs = [];
if (MERGE) {
  const dir = new URL('.', import.meta.url).pathname;
  const shards = readdirSync(dir).filter((f) => f.startsWith('.bal-') && f.endsWith('.json')).sort();
  for (const f of shards) {
    const shard = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    runs.push(...shard.runs);
  }
  const pi = (p) => ['blob', 'blob-fast', 'doctrine'].indexOf(p);
  const ki = (k) => ['open', 'woods', 'bourg'].indexOf(k);
  runs.sort((a, b) => pi(a.profile) - pi(b.profile) || ki(a.kind) - ki(b.kind) || a.seed - b.seed);
  console.log(`merged ${shards.length} shards, ${runs.length} runs`);
} else {
  const totalCells = PROFILES.length * KINDS.length * SEEDS;
  let done = 0;
  for (const profile of PROFILES) {
    for (const kind of KINDS) {
      for (let seed = SEED_START; seed <= SEEDS; seed++) {
        const r = runCell(profile, kind, seed);
        runs.push(r);
        done++;
        console.log(
          `[${String(done).padStart(2)}/${totalCells}] ${profile.padEnd(9)} ${kind.padEnd(5)} seed=${seed}  ` +
            `winner=${r.winner.padEnd(4)} ticks=${String(r.ticks).padStart(5)} (${r.gameMin}min)  ` +
            `blue KIA ${r.blueKiaPct}% WIA ${r.blueWiaPct}%  red KIA ${r.redKiaPct}% WIA ${r.redWiaPct}% cap ${r.redCapPct}%  ` +
            `[${r.wallS}s]`,
        );
      }
    }
  }
}

// ── aggregate table ──────────────────────────────────────────────────────────
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const cells = [];
for (const profile of PROFILES) {
  for (const kind of KINDS) {
    const rs = runs.filter((r) => r.profile === profile && r.kind === kind);
    if (rs.length === 0) continue;
    cells.push({
      profile,
      kind,
      blueWins: rs.filter((r) => r.winner === 'blue').length,
      redWins: rs.filter((r) => r.winner === 'red').length,
      holds: rs.filter((r) => r.winner === 'hold').length,
      n: rs.length,
      blueKiaPct: Math.round(mean(rs.map((r) => r.blueKiaPct)) * 10) / 10,
      blueWiaPct: Math.round(mean(rs.map((r) => r.blueWiaPct)) * 10) / 10,
      redKiaPct: Math.round(mean(rs.map((r) => r.redKiaPct)) * 10) / 10,
      meanTicks: Math.round(mean(rs.map((r) => r.ticks))),
    });
  }
}

console.log('\nprofile    kind   blue wins  red/hold   blue KIA%  blue WIA%  red KIA%   mean ticks');
for (const c of cells) {
  console.log(
    `${c.profile.padEnd(10)} ${c.kind.padEnd(6)} ${String(c.blueWins).padStart(4)}/${c.n}     ` +
      `${c.redWins}+${c.holds}h      ${String(c.blueKiaPct).padStart(5)}      ${String(c.blueWiaPct).padStart(5)}      ` +
      `${String(c.redKiaPct).padStart(5)}      ${String(c.meanTicks).padStart(6)}`,
  );
}

writeFileSync(OUT_URL, JSON.stringify({ date: new Date().toISOString().slice(0, 10), seeds: SEEDS, cap: CAP, cells, runs }, null, 1));
console.log(`\nwrote scripts/${OUT}`);
