// Bridge defile invariant (jtbug #760). A defile queue holds only forces that
// are waiting at or crossing THAT bridge: a stale id at the head shuts the
// bridge for the rest of the war, and a force left with queuedAt set refuses
// every order. Measured before the fix: seeds 12, 13 and 16 held forces
// queued for 15,000-18,000 consecutive minutes.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET } from '../src/campaign/presets';
import { makeHeadlessWorld, runHeadlessWar } from '../src/strategic/headless';
import { loadGameV2, saveGameV2 } from '../src/strategic/save2';
import type { FrontV2 } from '../src/strategic/theater/force';

const CFG = DEFAULT_PRESET.theater;
const CAMP = DEFAULT_PRESET.campaign;

// Stated here independently of the code under test.
function defileViolations(front: FrontV2): string[] {
  const out: string[] = [];
  for (const [node, q] of Object.entries(front.defileQueues)) {
    if (new Set(q).size !== q.length) out.push(`queue ${node} repeats an id: [${q}]`);
    for (const id of q) {
      const f = front.forces.find((x) => x.id === id);
      if (!f) out.push(`queue ${node} holds unknown force ${id}`);
      else if (f.strength <= 0) out.push(`queue ${node} holds dead force ${id}`);
      else if (f.pos.kind !== 'node' || f.pos.nodeId !== Number(node)) out.push(`queue ${node} holds force ${id}, which stands elsewhere`);
      else if (f.path.length === 0) out.push(`queue ${node} holds force ${id}, which has no path`);
      else if (f.engagedIn !== null) out.push(`queue ${node} holds engaged force ${id}`);
    }
  }
  for (const f of front.forces) {
    if (f.queuedAt === null) continue;
    if (f.path.length === 0) out.push(`force ${f.id} is queued at ${f.queuedAt} with no path`);
    if (!(front.defileQueues[f.queuedAt] ?? []).includes(f.id)) out.push(`force ${f.id} is queued at ${f.queuedAt} but not in its queue`);
  }
  return out;
}

describe('bridge defile queue (jtbug #760)', () => {
  it('holds only live forces waiting at or crossing the bridge, every minute of 16 wars', () => {
    const first: string[] = [];
    let longestWait = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const w = makeHeadlessWorld(seed, CFG, CAMP);
      const waited = new Map<number, number>();
      let seen = false;
      runHeadlessWar(w, 60 * 24 * 45, () => {
        for (const f of w.front.forces) {
          const n = f.queuedAt === null ? 0 : (waited.get(f.id) ?? 0) + 1;
          waited.set(f.id, n);
          longestWait = Math.max(longestWait, n);
        }
        if (seen) return;
        const v = defileViolations(w.front);
        if (v.length > 0) {
          seen = true;
          first.push(`seed ${seed} minute ${w.front.clockMin}: ${v[0]}`);
        }
      });
    }
    expect(first).toEqual([]);
    // Nobody waits longer than the forces ahead of it take to cross. Three
    // hours is far above any honest queue and far below the measured deadlock.
    expect(longestWait).toBeLessThan(180);
  }, 30_000);

  it('a save carrying a corrupt queue loads with the bridge open', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const w = makeHeadlessWorld(13, CFG, CAMP);
    const bridge = w.front.theater.nodes.find((n) => n.crossing?.kind === 'bridge')!;
    const [stuck, elsewhere] = w.front.forces.filter((f) => f.side === 'blue');
    // The two shapes the deadlock left behind: a force queued with no path,
    // and a queue headed by a force that stands at another node.
    stuck.pos = { kind: 'node', nodeId: bridge.id };
    stuck.queuedAt = bridge.id;
    w.front.defileQueues[bridge.id] = [elsewhere.id, stuck.id, 999];
    expect(defileViolations(w.front)).not.toEqual([]);
    expect(saveGameV2(13, CFG, CAMP, w.campaign, w.front)).toBe(true);

    const g = loadGameV2();
    if (g.status !== 'ok') throw new Error(`load: ${g.status}`);
    expect(defileViolations(g.front)).toEqual([]);
    expect(g.front.forces.find((f) => f.id === stuck.id)!.queuedAt).toBeNull();
  });
});
