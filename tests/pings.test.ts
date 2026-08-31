import { describe, expect, it } from 'vitest';
import { EventPings, type TeamPulse } from '../src/ui/overlays';
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
