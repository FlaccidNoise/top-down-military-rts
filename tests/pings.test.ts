import { describe, expect, it } from 'vitest';
import { dockFeed, EventPings, type TeamPulse } from '../src/ui/overlays';
import type { UnitEvent } from '../src/sim/sim';

const PIN_COOLDOWN = 30 * 30;

const ev = (kind: UnitEvent['kind'], side: UnitEvent['side'], name: string): UnitEvent => ({ kind, side, name, x: 10, y: 10 });
const pulse = (over: Partial<TeamPulse> = {}): TeamPulse => ({ id: 1, side: 'blue', name: 'Able 1', live: 6, pinned: 0, balked: false, seen: true, ...over });

describe('EventPings — per-event lines', () => {
  it('a brewed-up tank is announced for both sides', () => {
    const p = new EventPings();
    p.add([ev('vehicle-destroyed', 'blue', 'Sherman'), ev('vehicle-destroyed', 'red', 'StuG III')], 0);
    expect(p.labels()).toEqual(['Sherman — BREWED UP', 'StuG III — BREWED UP']);
  });

  it('enemy morale is visible; enemy body count is not', () => {
    const p = new EventPings();
    p.add([ev('broken', 'red', '2. Zug'), ev('surrendered', 'red', 'Gefr. Weber'), ev('kia', 'red', 'Ldstm. Roth'), ev('downed', 'red', 'Ogfr. Halm')], 0);
    expect(p.labels()).toEqual(['2. Zug — BROKE', 'Gefr. Weber — SURRENDERS']);
  });

  it('an ambush is loud from either side', () => {
    const p = new EventPings();
    p.add([ev('ambush', 'blue', 'Able 2'), ev('ambush', 'red', '3. Gruppe')], 0);
    expect(p.labels()).toEqual(['Able 2 — AMBUSH SPRUNG!', '3. Gruppe — AMBUSH SPRUNG!']);
  });

  it('per-man pinned and rallied never reach the feed', () => {
    const p = new EventPings();
    p.add([ev('pinned', 'blue', 'Pvt. Kelly'), ev('rallied', 'blue', 'Pvt. Kelly'), ev('ping', 'blue', 'x')], 0);
    expect(p.labels()).toEqual([]);
  });
});

// #766: the quiet recoveries. The sim names the man in `name` and his team in
// `team`; the line is the team's.
describe('EventPings — recoveries', () => {
  const rec = (kind: UnitEvent['kind'], side: UnitEvent['side'], team: string): UnitEvent => ({ kind, side, name: 'Pvt. Kelly', team, x: 10, y: 10, id: 3 });

  it('each recovery is one short line, named for the team', () => {
    const p = new EventPings();
    p.add([rec('took-over', 'blue', 'Able 1'), rec('promoted', 'blue', 'Able 2'), rec('stabilized', 'blue', 'Baker 1'), rec('recovered', 'blue', 'Baker 2'), rec('resupplied', 'blue', 'HMG')], 0);
    expect(p.labels()).toEqual(['Able 1 — GUN TAKEN OVER', 'Able 2 — NEW LEADER', 'Baker 1 — MAN STABILIZED', 'Baker 2 — MAN BACK UP', 'HMG — AMMO BROUGHT UP']);
  });

  it('the enemy side says nothing: every one of these is a casualty report', () => {
    const p = new EventPings();
    p.add([rec('promoted', 'red', '3. Gruppe'), rec('stabilized', 'red', '3. Gruppe'), rec('recovered', 'red', '3. Gruppe'), rec('took-over', 'red', 'sMG42'), rec('resupplied', 'red', 'sMG42')], 0);
    expect(p.labels()).toEqual([]);
  });

  it('a team patching up several men says so once per cooldown, per kind', () => {
    const p = new EventPings();
    p.add([rec('stabilized', 'blue', 'Able 1'), rec('stabilized', 'blue', 'Able 1')], 0);
    p.add([rec('stabilized', 'blue', 'Able 1')], PIN_COOLDOWN - 1);
    p.add([rec('recovered', 'blue', 'Able 1')], PIN_COOLDOWN - 1); // another kind is another line
    p.add([rec('stabilized', 'blue', 'Baker 1')], PIN_COOLDOWN - 1); // and so is another team
    expect(p.labels()).toEqual(['Able 1 — MAN STABILIZED', 'Able 1 — MAN BACK UP', 'Baker 1 — MAN STABILIZED']);
    p.add([rec('stabilized', 'blue', 'Able 1')], PIN_COOLDOWN);
    expect(p.labels()).toHaveLength(4);
  });

  it('a recovery never takes a slot from a casualty, and yields its own once read', () => {
    const p = new EventPings();
    p.add(Array.from({ length: 5 }, (_, i) => ev('kia', 'blue', `Pvt. ${i}`)), 0);
    p.add([rec('promoted', 'blue', 'Able 1')], 1);
    expect(p.labels()).not.toContain('Able 1 — NEW LEADER'); // full of casualties: the drama line loses

    const q = new EventPings();
    q.add([...Array.from({ length: 4 }, (_, i) => ev('kia', 'blue', `Pvt. ${i}`)), rec('promoted', 'blue', 'Able 1')], 0);
    q.add([ev('kia', 'blue', 'Pvt. 9')], 5);
    expect(q.labels()).toContain('Able 1 — NEW LEADER'); // inside its dwell: protected
    q.add([ev('kia', 'blue', 'Pvt. 10')], 60);
    expect(q.labels()).not.toContain('Able 1 — NEW LEADER'); // past it: the cheap slot again
  });
});

// #787: the commander's voice, and the one line about the enemy's movement.
describe('EventPings — commander voice', () => {
  const hq = (kind: UnitEvent['kind'], side: UnitEvent['side']): UnitEvent => ({ kind, side, name: 'HQ', x: 10, y: 10 });
  const closing = (side: UnitEvent['side'], team: string): UnitEvent => ({ kind: 'closing', side, name: 'Gefr. Weber', team, x: 10, y: 10, id: 7 });

  it("the player's own headquarters reports what it decided", () => {
    const p = new EventPings();
    p.add([hq('reserve-committed', 'blue'), hq('smoke-objective', 'blue'), hq('culminated', 'blue')], 0);
    expect(p.labels()).toEqual(['HQ — RESERVE COMMITTED', 'HQ — SMOKE ON OBJECTIVE', 'HQ — ATTACK CALLED OFF']);
  });

  it("the enemy's headquarters is never heard", () => {
    const p = new EventPings();
    p.add([hq('reserve-committed', 'red'), hq('smoke-objective', 'red'), hq('culminated', 'red')], 0);
    expect(p.labels()).toEqual([]);
  });

  it('a German team seen coming for blue ground is named; a blue advance is not news', () => {
    const p = new EventPings();
    p.add([closing('red', '3. Gruppe'), closing('blue', 'Able 1')], 0);
    expect(p.labels()).toEqual(['3. Gruppe — CLOSING IN']);
    p.add([closing('red', '3. Gruppe')], PIN_COOLDOWN - 1); // its next bound: same news
    expect(p.labels()).toEqual(['3. Gruppe — CLOSING IN']);
  });

  it('repeated smoke missions are one line per cooldown', () => {
    const p = new EventPings();
    p.add([hq('smoke-objective', 'blue')], 0);
    p.add([hq('smoke-objective', 'blue')], 300);
    expect(p.labels()).toEqual(['HQ — SMOKE ON OBJECTIVE']);
    p.add([hq('smoke-objective', 'blue')], PIN_COOLDOWN);
    expect(p.labels()).toHaveLength(2);
  });
});

describe('EventPings — team pinned-majority aggregate', () => {
  it('fires only past a majority, and only once per crossing', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 3 })]); // 3 of 6 is not a majority
    expect(p.labels()).toEqual([]);
    p.add([], 1, [pulse({ pinned: 4 })]);
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN']);
    p.add([], 2, [pulse({ pinned: 5 })]); // still pinned: no second line
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN']);
  });

  it('coming back under the line reads as a rally', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 4 })]);
    p.add([], PIN_COOLDOWN, [pulse({ pinned: 1 })]);
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN', 'Able 1 — RALLIED']);
  });

  it('a team hovering on the line does not chatter', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 4 })]);
    for (let t = 1; t < PIN_COOLDOWN; t += 30) p.add([], t, [pulse({ pinned: t % 60 === 1 ? 4 : 1 })]);
    // Fifteen crossings each way inside one cooldown buy one line each way.
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN', 'Able 1 — RALLIED']);
  });

  it('the windows are per direction: a rally answers its own pin', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 4 })]);
    p.add([], 60, [pulse({ pinned: 1 })]); // 2 s later — the answer to the line just read
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN', 'Able 1 — RALLIED']);
  });

  it('the cooldown gates the announcement, not the flag: a team that recovered unannounced can pin again', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 4 })]); // PINNED DOWN
    p.add([], 60, [pulse({ pinned: 1 })]); // RALLIED
    p.add([], 120, [pulse({ pinned: 4 })]); // pinning again this soon is chatter — silent
    p.add([], PIN_COOLDOWN, [pulse({ pinned: 1 })]); // and so is rallying again — silent
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN', 'Able 1 — RALLIED']);
    // Both flags tracked the silent crossings, so this one is a real new pin.
    p.add([], PIN_COOLDOWN + 60, [pulse({ pinned: 4 })]);
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN', 'Able 1 — RALLIED', 'Able 1 — PINNED DOWN']);
  });

  it('an unseen German team updates its flag but says nothing', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ side: 'red', name: '2. Zug', pinned: 4, seen: false })]);
    expect(p.labels()).toEqual([]);
    // Back in view, still pinned: no transition, so still nothing — and no
    // false rally when they later stand up.
    p.add([], 100, [pulse({ side: 'red', name: '2. Zug', pinned: 4, seen: true })]);
    expect(p.labels()).toEqual([]);
    p.add([], PIN_COOLDOWN, [pulse({ side: 'red', name: '2. Zug', pinned: 0, seen: true })]);
    expect(p.labels()).toEqual(['2. Zug — RALLIED']);
  });

  it('a wiped-out team is forgotten, not reported', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 4 })]);
    p.add([], 1, [pulse({ live: 0, pinned: 0 })]);
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN']);
  });
});

describe('EventPings — balk', () => {
  it('announces the transition into balked, once', () => {
    const p = new EventPings();
    p.add([], 0, [pulse()]);
    p.add([], 1, [pulse({ balked: true })]);
    p.add([], 2, [pulse({ balked: true })]);
    expect(p.labels()).toEqual(['Able 1 — WON\'T ADVANCE']);
  });

  it('balking again after complying is news again', () => {
    const p = new EventPings();
    p.add([], 1, [pulse({ balked: true })]);
    p.add([], 2, [pulse({ balked: false })]);
    p.add([], 3, [pulse({ balked: true })]);
    expect(p.labels()).toEqual(['Able 1 — WON\'T ADVANCE', 'Able 1 — WON\'T ADVANCE']);
  });

  it('German balk is hidden AI state', () => {
    const p = new EventPings();
    p.add([], 1, [pulse({ side: 'red', name: '2. Zug', balked: true })]);
    expect(p.labels()).toEqual([]);
  });
});

describe('EventPings — feed pressure', () => {
  it('drama never pushes a casualty out of a full feed', () => {
    const p = new EventPings();
    for (const n of ['A', 'B', 'C', 'D', 'E']) p.add([ev('kia', 'blue', n)], 0);
    expect(p.labels()).toHaveLength(5);
    p.add([ev('broken', 'red', '2. Zug')], 1);
    expect(p.labels()).toEqual(['A — KIA', 'B — KIA', 'C — KIA', 'D — KIA', 'E — KIA']);
  });

  it('a casualty takes the oldest drama slot rather than the oldest line', () => {
    const p = new EventPings();
    p.add([ev('broken', 'red', 'Zug 1'), ev('ambush', 'red', 'Zug 2')], 0);
    for (const n of ['A', 'B', 'C'] as const) p.add([ev('kia', 'blue', n)], 0);
    expect(p.labels()).toHaveLength(5);
    p.add([ev('kia', 'blue', 'D')], 1);
    expect(p.labels()).toEqual(['Zug 2 — AMBUSH SPRUNG!', 'A — KIA', 'B — KIA', 'C — KIA', 'D — KIA']);
  });

  it('a fresh drama line outlives the casualties of the barrage that caused it', () => {
    const p = new EventPings();
    for (const n of ['A', 'B', 'C', 'D'] as const) p.add([ev('kia', 'blue', n)], 0);
    p.add([], 0, [pulse({ pinned: 4 })]); // PINNED DOWN, feed now full
    p.add([ev('kia', 'blue', 'E')], 1); // one tick on: the oldest KIA gives way, not the pin
    expect(p.labels()).toEqual(['B — KIA', 'C — KIA', 'D — KIA', 'Able 1 — PINNED DOWN', 'E — KIA']);
    p.add([ev('kia', 'blue', 'F')], 31); // dwell spent: drama goes back to being the cheap slot
    expect(p.labels()).toEqual(['B — KIA', 'C — KIA', 'D — KIA', 'E — KIA', 'F — KIA']);
  });

  it('reset clears the aggregate state as well as the feed', () => {
    const p = new EventPings();
    p.add([], 0, [pulse({ pinned: 4 })]);
    p.reset();
    p.add([], 1, [pulse({ pinned: 4 })]);
    expect(p.labels()).toEqual(['Able 1 — PINNED DOWN']);
  });
});

// ---- where the feed hangs ----

describe('dockFeed: the ticker keeps off the tutorial', () => {
  // A 190 px column at the right edge of a 1280x800 screen, room for five rows.
  const X = 1078;
  const W = 190;
  const H = 115;
  const TOP = 60;
  const BOTTOM = 760;
  const overlaps = (y: number, r: { left: number; top: number; right: number; bottom: number }): boolean =>
    r.right > X && r.left < X + W && y < r.bottom && y + H > r.top;

  it('hangs from the top when nothing is in the way', () => {
    expect(dockFeed(X, W, H, TOP, BOTTOM, [])).toBe(TOP);
  });

  it('ignores a bubble that is not in its column', () => {
    expect(dockFeed(X, W, H, TOP, BOTTOM, [{ left: 300, top: 50, right: 700, bottom: 110 }])).toBe(TOP);
  });

  it('drops under a bubble in its column', () => {
    const bubble = { left: 935, top: 45, right: 1272, bottom: 87 };
    const y = dockFeed(X, W, H, TOP, BOTTOM, [bubble]);
    expect(y).toBeGreaterThan(bubble.bottom);
    expect(overlaps(y, bubble)).toBe(false);
  });

  it('clears the bubble and the ring it points at together', () => {
    const bubble = { left: 900, top: 70, right: 1260, bottom: 120 };
    const ring = { left: 1100, top: 150, right: 1200, bottom: 250 };
    const y = dockFeed(X, W, H, TOP, BOTTOM, [bubble, ring]);
    expect(overlaps(y, bubble)).toBe(false);
    expect(overlaps(y, ring)).toBe(false);
    expect(y + H).toBeLessThanOrEqual(BOTTOM);
  });

  it('takes the gap between two things when the first place under one is taken', () => {
    const a = { left: 1100, top: 50, right: 1250, bottom: 170 };
    const b = { left: 1100, top: 200, right: 1250, bottom: 400 };
    const y = dockFeed(X, W, H, TOP, BOTTOM, [a, b]);
    expect(y).toBeGreaterThan(b.bottom);
    expect(y + H).toBeLessThanOrEqual(BOTTOM);
  });

  it('stays put when nowhere is free', () => {
    expect(dockFeed(X, W, H, TOP, BOTTOM, [{ left: 1100, top: 100, right: 1250, bottom: 700 }])).toBe(TOP);
  });

  it('never leaves the map', () => {
    for (const top of [40, 200, 400, 600]) {
      const y = dockFeed(X, W, H, TOP, BOTTOM, [{ left: 1000, top, right: 1280, bottom: top + 80 }]);
      expect(y).toBeGreaterThanOrEqual(TOP);
      expect(y + H).toBeLessThanOrEqual(BOTTOM);
    }
  });
});
