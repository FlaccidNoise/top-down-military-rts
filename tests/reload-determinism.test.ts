// Reload-determinism pin (S56, §4.8): a saved war, reloaded, terminates
// byte-identically — INCLUDING the red commander's plan. Mutation-verified
// against every CommanderSave field: dropping the plan or resetting
// lastEvalMin forks the war, and this pin goes red if it stops forking.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import {
  makeHeadlessWorld,
  runHeadlessWar,
  stepWorldMinute,
  type HeadlessWorld,
} from '../src/strategic/headless';
import { warStatus } from '../src/strategic/goals';
import { loadGameV2, saveGameV2 } from '../src/strategic/save2';
import { orderHalt, orderMove, stepMovement } from '../src/strategic/theater/step';

const CFG = DEFAULT_PRESET.theater;
const CAMP = DEFAULT_PRESET.campaign;
// Red's plan only grows axes once blue TAKES an objective (denial targets),
// so the save clock is not fixed: save 30 minutes after the first real axis
// appears — lastEvalMin sits mid-cadence, which is exactly what the
// reset-eval mutation needs to bite on.
const SAVE_MARGIN_MIN = 30;
const MAX_WAIT_MIN = 60 * 24 * 20;

const stubStorage = (): void => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
};

// Run to termination, collecting a fine-grained trace: every resolved
// battle and every movement event, minute-stamped.
const traceToEnd = (w: HeadlessWorld): { trace: string[]; tuple: string } => {
  const trace: string[] = [];
  const run = runHeadlessWar(w, 60 * 24 * 45, (r, world) => {
    for (const x of r.resolved) trace.push(`${world.front.clockMin} ${x.battleClass} ${x.attackerWon ? 'atk' : 'def'}`);
    for (const e of r.events) trace.push(`${e.min} ${e.kind} ${e.text}`);
  });
  const st = run.status;
  const tuple = st.state === 'decided' ? `${st.winner}:${run.day}:${run.logLen}` : `ongoing:${run.day}:${run.logLen}`;
  return { trace, tuple };
};

const reload = (
  ai: 'full' | 'no-plan' | 'reset-eval',
): HeadlessWorld => {
  const g = loadGameV2();
  if (g.status !== 'ok') throw new Error(`reload: ${g.status}`);
  const restoreAi =
    ai === 'no-plan'
      ? undefined
      : {
          red: { lastEvalMin: ai === 'reset-eval' ? -Infinity : (g.ai!.red!.lastEvalMin ?? -Infinity), plan: g.ai!.red!.plan },
          blue: { lastEvalMin: g.ai!.blue!.lastEvalMin ?? -Infinity, plan: g.ai!.blue!.plan },
        };
  return makeHeadlessWorld(g.seed, g.cfg, g.campaignCfg, { campaign: g.campaign, front: g.front, ai: restoreAi });
};

describe('reload determinism (S56)', () => {
  it('a mid-war save resumes byte-identically; dropping either CommanderSave field forks the war', { timeout: 180_000 }, () => {
    stubStorage();
    let verified = false;
    const skipped: string[] = [];
    for (let seed = 1; seed <= 8 && !verified; seed++) {
      const A = makeHeadlessWorld(seed, CFG, CAMP);
      let axisAt = -1;
      while (warStatus(A.front, A.goals).state === 'ongoing' && A.front.clockMin < 360 + MAX_WAIT_MIN) {
        stepWorldMinute(A);
        if (axisAt < 0 && A.red.plan && A.red.plan.axes.length > 0) axisAt = A.front.clockMin;
        if (axisAt > 0 && A.front.clockMin >= axisAt + SAVE_MARGIN_MIN) break;
      }
      if (warStatus(A.front, A.goals).state !== 'ongoing' || axisAt < 0 || !A.red.plan || A.red.plan.axes.length === 0) {
        skipped.push(`seed ${seed}: no live red axis inside the war (axisAt ${axisAt})`);
        continue;
      }
      const saved = saveGameV2(seed, CFG, CAMP, A.campaign, A.front, {
        red: { lastEvalMin: A.red.lastEvalMin, plan: A.red.plan },
        blue: { lastEvalMin: A.blue.lastEvalMin, plan: A.blue.plan },
      });
      expect(saved).toBe(true);

      const a = traceToEnd(A); // A continues in memory
      const b = traceToEnd(reload('full')); // B resumes from the save
      expect(b.tuple).toBe(a.tuple);
      expect(b.trace).toEqual(a.trace);

      // Mutations: each dropped field must FORK the continuation.
      const c = traceToEnd(reload('no-plan'));
      const d = traceToEnd(reload('reset-eval'));
      const differs = (x: { trace: string[]; tuple: string }): boolean =>
        x.tuple !== a.tuple || JSON.stringify(x.trace) !== JSON.stringify(a.trace);
      if (differs(c) && differs(d)) {
        verified = true;
      } else {
        skipped.push(`seed ${seed}: mutation did not fork (plan ${differs(c)}, eval ${differs(d)})`);
      }
    }
    expect(verified, `no seed exercised both mutations: ${skipped.join('; ')}`).toBe(true);
  });

  it('a company halted mid-road loads where it stood and takes the same order (jtbug #762)', () => {
    stubStorage();
    const w = makeHeadlessWorld(1, CFG, CAMP);
    const f = w.front.forces.find((x) => x.side === 'blue')!;
    const origin = f.pos.kind === 'node' ? f.pos.nodeId : -1;
    expect(orderMove(w.front, f.id, w.front.theater.objectiveNodes[0]).ok).toBe(true);
    for (let m = 0; m < 10; m++) {
      w.front.clockMin++;
      stepMovement(w.front);
    }
    expect(f.pos.kind).toBe('edge');
    expect(orderHalt(w.front, f.id)).toEqual({ ok: true });
    expect(saveGameV2(1, CFG, CAMP, w.campaign, w.front)).toBe(true);

    const g = loadGameV2();
    if (g.status !== 'ok') throw new Error(`reload: ${g.status}`);
    const loaded = g.front.forces.find((x) => x.id === f.id)!;
    expect(loaded).toEqual(f);
    expect(loaded.path).toEqual([]);
    // Back the way it came: the reloaded company turns on its own road.
    const live = orderMove(w.front, f.id, origin);
    expect(live.ok).toBe(true);
    expect(orderMove(g.front, f.id, origin)).toEqual(live);
    expect(loaded).toEqual(f);
  });

  it('a save written before the reorganisation field loads with it cleared', () => {
    stubStorage();
    const w = makeHeadlessWorld(1, CFG, CAMP);
    w.front.forces[0].repulsedAtMin = 400;
    expect(saveGameV2(1, CFG, CAMP, w.campaign, w.front)).toBe(true);
    const fresh = loadGameV2();
    if (fresh.status !== 'ok') throw new Error(`reload: ${fresh.status}`);
    expect(fresh.front.forces[0].repulsedAtMin).toBe(400);

    const old = JSON.parse(localStorage.getItem('ccg-save-v4')!);
    for (const f of old.front.forces) delete f.repulsedAtMin;
    localStorage.setItem('ccg-save-v4', JSON.stringify(old));
    const g = loadGameV2();
    if (g.status !== 'ok') throw new Error(`reload: ${g.status}`);
    expect(g.front.forces.map((f) => f.repulsedAtMin)).toEqual(g.front.forces.map(() => null));
  });
});
