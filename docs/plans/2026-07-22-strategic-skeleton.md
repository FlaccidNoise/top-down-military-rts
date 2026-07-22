# Plan: Strategic Skeleton (Milestone M-A)

**Goal:** Replace the linear 3-battle operation with a playable strategic layer: a hand-authored 40×30-cell sector map, company chits the player moves in continuous time, contacts that spawn tactical battles (on today's hand-built battle map), and outcomes that flip cell ownership.

**Architecture:** New pure deterministic module `src/strategic/` (no render imports, no `Date.now`/`Math.random` — seeds passed in). `sector.ts` (cell grid + hand-authored sector) → `front.ts` (clock, movement, contact) → `bridge.ts` (strategic⇄tactical: builds battles from rosters, applies outcomes) → `save.ts`. Renderer additions live in `src/render/strategic.ts`; `src/main.ts` becomes a two-mode app (strategic | battle). Spec: `docs/specs/2026-07-22-strategic-campaign.md` (M-A section).

**Tech stack:** TypeScript 5.5, Vite 6, Vitest 3, Canvas 2D. No new dependencies.

**Global constraints:**
- `npm run check` and `npm run test` pass after every task. Commit after every task (direct to `main`, repo convention).
- `src/strategic/` never imports from `src/render/`. All randomness in strategic/sim code flows through `mulberry32` seeds passed by the caller.
- Walls-on-edges in `src/sim/map.ts` untouched. `makeMap` is still the battle map for every engagement in M-A — the carve (M-B) swaps it out inside `bridge.ts` only.
- Existing test style: plain vitest `describe/it`, headless sims, manual state fabrication (see `tests/campaign.test.ts`).

**Deliberately out of scope (M-A):** procgen battle maps (M-B), coarse resolver + red strategic movement (M-C), supply (M-D), vehicles in strategic battles, red roster persistence, pan/zoom on the strategic map, name-pool expansion.

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/strategic/sector.ts` | Create | Cell types, ASCII sector parser, the hand-authored default sector, per-terrain movement minutes |
| `src/strategic/front.ts` | Create | `Front`: clock, chits, Dijkstra pathfinding, per-minute `step()` with capture + contact, save/restore, `operationStatus` |
| `src/strategic/bridge.ts` | Create | `newFront` (initial dispositions), `makeStrategicBattle` (rosters → Sim), `applyEngagementOutcome`, `syncStrengths` |
| `src/strategic/save.ts` | Create | Combined campaign+front localStorage save (`ccg-save-v2`) |
| `src/render/strategic.ts` | Create | `StrategicView`: fixed fit-to-screen cell map, chit counters, HUD; pure draw + `cellAtScreen` picking |
| `src/campaign/campaign.ts` | Modify | Add `companies` grouping (Task 3); delete linear-operation remnants (Task 5) |
| `src/sim/scenario.ts` | Modify | Export `wireBonds` (Task 4); delete `makeCampaignBattle`/`BATTLE_NAMES`/`rosterMembers`/`CampaignBattle` (Task 5) |
| `src/main.ts` | Rewrite | Two-mode shell: strategic loop (clock, contact modal, day rollover, victory) + existing battle loop |
| `tests/strategic.test.ts` | Create | Tasks 1, 2, 4, 6 tests |
| `tests/campaign.test.ts` | Modify | Companies shape (Task 3); replace `makeCampaignBattle` usages (Task 5) |

---

## Task 1: Sector — cell grid + hand-authored map

**Files:**
- Create: `src/strategic/sector.ts`
- Test: `tests/strategic.test.ts` (new file)

**Interfaces (consumed by Tasks 2, 4, 5):** `CellTerrain`, `Cell`, `SectorMap`, `CELL_MINUTES`, `parseSector(rows, frontX, name)`, `makeDefaultSector()`, `cellIndex(s, x, y)`, `cellXY(s, i)`.

- [ ] Write `src/strategic/sector.ts`:

```ts
import type { Side } from '../sim/sim';

export type CellTerrain = 'open' | 'woods' | 'town' | 'river' | 'bridge' | 'road';

export interface Cell {
  terrain: CellTerrain;
  owner: Side | null; // null = neutral (river)
  objective: boolean;
}

export interface SectorMap {
  w: number;
  h: number;
  name: string;
  cells: Cell[];
}

const CHAR_TERRAIN: Record<string, CellTerrain> = {
  '.': 'open',
  w: 'woods',
  t: 'town',
  T: 'town', // objective town
  '~': 'river',
  '=': 'bridge',
  r: 'road',
};

// Minutes for a company column to cross one 500 m cell.
export const CELL_MINUTES: Record<CellTerrain, number> = {
  road: 10,
  bridge: 12,
  open: 15,
  town: 15,
  woods: 30,
  river: Infinity,
};

export function parseSector(rows: string[], frontX: number, name: string): SectorMap {
  const h = rows.length;
  const w = rows[0].length;
  const cells: Cell[] = [];
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`sector row ${y} has length ${rows[y].length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const terrain = CHAR_TERRAIN[ch];
      if (!terrain) throw new Error(`unknown sector char '${ch}' at ${x},${y}`);
      cells.push({
        terrain,
        owner: terrain === 'river' ? null : x < frontX ? 'blue' : 'red',
        objective: ch === 'T',
      });
    }
  }
  return { w, h, name, cells };
}

export const cellIndex = (s: SectorMap, x: number, y: number): number => y * s.w + x;
export const cellXY = (s: SectorMap, i: number): { x: number; y: number } => ({ x: i % s.w, y: Math.floor(i / s.w) });

// The Vireux sector: a river line with two garrisoned bridges, the objective
// town of St-Aubin beyond the southern crossing. 40×30 cells = 20×15 km.
// Placeholder-quality art — replace rows freely, the parser is the contract.
const DEFAULT_ROWS = [
  '....................~...................',
  '....................~...................',
  '...wwwwww...........~..wwwww............',
  '...wwwwww...........~..wwwww............',
  '...wwwwww...........~..wwwww............',
  '...wwwwww...........~..wwwww............',
  '....................~........ttt........',
  'rrrrrrrrrrrrrrrrrrrr=rrrrrrrrtttrrrrrrrr',
  '....................~........ttt........',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...TTT.............',
  'rrrrrrrrrrrrrrrrrrrr=rrrTTTrrrrrrrrrrrrr',
  '....................~...TTT.............',
  '....................~...................',
  '....................~...................',
  '....................~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~.......wwwwww......',
  '..........wwwwww....~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
  '....................~...................',
];

export function makeDefaultSector(): SectorMap {
  return parseSector(DEFAULT_ROWS, 20, 'Vireux sector');
}
```

- [ ] Write the tests — create `tests/strategic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cellIndex, makeDefaultSector, parseSector } from '../src/strategic/sector';

describe('sector', () => {
  it('parses the default sector: 40×30, river neutral, bridges, objective town', () => {
    const s = makeDefaultSector();
    expect(s.w).toBe(40);
    expect(s.h).toBe(30);
    expect(s.cells[cellIndex(s, 20, 9)].terrain).toBe('river');
    expect(s.cells[cellIndex(s, 20, 9)].owner).toBeNull();
    expect(s.cells[cellIndex(s, 20, 15)].terrain).toBe('bridge');
    expect(s.cells[cellIndex(s, 20, 7)].terrain).toBe('bridge');
    expect(s.cells[cellIndex(s, 4, 15)].terrain).toBe('road');
    expect(s.cells[cellIndex(s, 4, 15)].owner).toBe('blue');
    const objectives = s.cells.filter((c) => c.objective);
    expect(objectives.length).toBe(9); // St-Aubin, 3×3
    expect(objectives.every((c) => c.owner === 'red')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => parseSector(['..', '.'], 1, 'bad')).toThrow(/length/);
    expect(() => parseSector(['.x'], 1, 'bad')).toThrow(/unknown sector char/);
  });
});
```

- [ ] Run `npm run test -- tests/strategic.test.ts` — expect both tests PASS. Run `npm run check` — expect no output (clean).
- [ ] Commit: `git add -A && git commit -m "M-A task 1: sector cell grid + hand-authored Vireux sector"`

---

## Task 2: Front — clock, movement, contact, operation status

**Files:**
- Create: `src/strategic/front.ts`
- Test: `tests/strategic.test.ts` (append)

**Interfaces:** consumes `SectorMap`/`CELL_MINUTES` from Task 1. Produces for Tasks 4–5: `Chit`, `Engagement`, `FrontSave`, `class Front { clockMin, chits, day, hhmm, addChit, chitAt, orderMove, step, save }`, `Front.restore`, `findPath`, `operationStatus`, `OP_START_MIN`, `OP_DEADLINE_DAYS`.

- [ ] Write `src/strategic/front.ts`:

```ts
import type { Side } from '../sim/sim';
import { CELL_MINUTES, cellIndex, cellXY, type SectorMap } from './sector';

export interface Chit {
  id: number;
  side: Side;
  name: string;
  cell: number; // sector cell index
  path: number[]; // remaining cells to enter, front-to-back
  progress: number; // minutes walked toward path[0]
  strength: number; // effectives. blue: synced from roster; red: attrition counter
  companyIndex: number; // blue: index into campaign.companies; red: -1
}

export interface Engagement {
  attackerId: number;
  defenderId: number;
  cell: number; // the contested (defender's) cell
}

export interface FrontSave {
  clockMin: number;
  nextChitId: number;
  owners: (Side | null)[];
  chits: Chit[];
}

export const OP_START_MIN = 6 * 60; // day 1, 06:00
export const OP_DEADLINE_DAYS = 14;

export class Front {
  clockMin = OP_START_MIN;
  chits: Chit[] = [];
  nextChitId = 1;

  constructor(readonly sector: SectorMap) {}

  get day(): number {
    return Math.floor(this.clockMin / 1440) + 1;
  }

  get hhmm(): string {
    const m = this.clockMin % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
  }

  addChit(init: Omit<Chit, 'id' | 'path' | 'progress'>): Chit {
    const chit: Chit = { ...init, id: this.nextChitId++, path: [], progress: 0 };
    this.chits.push(chit);
    return chit;
  }

  chitAt(cell: number, side?: Side): Chit | undefined {
    return this.chits.find((c) => c.cell === cell && c.strength > 0 && (side === undefined || c.side === side));
  }

  orderMove(chitId: number, dest: number): boolean {
    const chit = this.chits.find((c) => c.id === chitId);
    if (!chit) return false;
    const path = findPath(this.sector, chit.cell, dest);
    if (path === null) return false;
    chit.path = path;
    chit.progress = 0;
    return true;
  }

  // Advance one strategic minute. Returns an engagement if a moving chit
  // finished its approach into a cell held by an enemy chit; the mover halts
  // in its current cell (assault positions) and the engagement is the caller's
  // to resolve. Entering an empty cell captures it.
  step(): Engagement | null {
    this.clockMin++;
    for (const chit of this.chits) {
      if (chit.path.length === 0 || chit.strength <= 0) continue;
      const nextCell = chit.path[0];
      chit.progress++;
      if (chit.progress < CELL_MINUTES[this.sector.cells[nextCell].terrain]) continue;
      const enemy = this.chitAt(nextCell, chit.side === 'blue' ? 'red' : 'blue');
      if (enemy) {
        chit.path = [];
        chit.progress = 0;
        return { attackerId: chit.id, defenderId: enemy.id, cell: nextCell };
      }
      chit.cell = nextCell;
      chit.path.shift();
      chit.progress = 0;
      this.sector.cells[nextCell].owner = chit.side;
    }
    return null;
  }

  save(): FrontSave {
    return {
      clockMin: this.clockMin,
      nextChitId: this.nextChitId,
      owners: this.sector.cells.map((c) => c.owner),
      chits: structuredClone(this.chits),
    };
  }

  static restore(sector: SectorMap, s: FrontSave): Front {
    const f = new Front(sector);
    f.clockMin = s.clockMin;
    f.nextChitId = s.nextChitId;
    s.owners.forEach((o, i) => (sector.cells[i].owner = o));
    f.chits = structuredClone(s.chits);
    return f;
  }
}

// Dijkstra over 4-neighbors weighted by CELL_MINUTES. Ignores chits: paths may
// run through enemy-held cells — contact triggers there during step(). Returns
// the cell sequence excluding `from`, [] if from === to, null if unreachable.
export function findPath(sector: SectorMap, from: number, to: number): number[] | null {
  if (from === to) return [];
  const n = sector.cells.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) return null;
    if (u === to) break;
    visited[u] = 1;
    const { x, y } = cellXY(sector, u);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= sector.w || ny >= sector.h) continue;
      const v = cellIndex(sector, nx, ny);
      const cost = CELL_MINUTES[sector.cells[v].terrain];
      if (!isFinite(cost)) continue;
      if (dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        prev[v] = u;
      }
    }
  }
  const path: number[] = [];
  for (let v = to; v !== from; v = prev[v]) path.unshift(v);
  return path;
}

export function operationStatus(front: Front): 'ongoing' | 'won' | 'lost' {
  const objectives = front.sector.cells.filter((c) => c.objective);
  if (objectives.length > 0 && objectives.every((c) => c.owner === 'blue')) return 'won';
  const anyBlue = front.chits.some((c) => c.side === 'blue' && c.strength > 0);
  if (!anyBlue || front.day > OP_DEADLINE_DAYS) return 'lost';
  return 'ongoing';
}
```

- [ ] Append to `tests/strategic.test.ts` (add `Front`, `findPath`, `operationStatus`, `OP_START_MIN`, `OP_DEADLINE_DAYS` to imports from `../src/strategic/front`):

```ts
describe('front', () => {
  const miniSector = () => parseSector(['rrrr'], 2, 'mini'); // 4×1 road; x<2 blue

  it('paths cross the river only at bridges', () => {
    const s = makeDefaultSector();
    const path = findPath(s, cellIndex(s, 4, 15), cellIndex(s, 25, 15))!;
    expect(path).toContain(cellIndex(s, 20, 15));
    expect(path.some((i) => s.cells[i].terrain === 'river')).toBe(false);
  });

  it('moves at terrain speed and captures entered cells', () => {
    const s = miniSector();
    const f = new Front(s);
    const chit = f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    expect(f.orderMove(chit.id, 3)).toBe(true);
    for (let i = 0; i < 10; i++) expect(f.step()).toBeNull(); // road = 10 min/cell
    expect(chit.cell).toBe(1);
    for (let i = 0; i < 20; i++) f.step();
    expect(chit.cell).toBe(3);
    expect(chit.path.length).toBe(0);
    expect(s.cells[2].owner).toBe('blue'); // was red, captured in passing
    expect(s.cells[3].owner).toBe('blue');
  });

  it('contact: reaching an enemy-held cell halts the mover and returns an engagement', () => {
    const s = miniSector();
    const f = new Front(s);
    const blue = f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    const red = f.addChit({ side: 'red', name: 'Gruppe', cell: 2, strength: 18, companyIndex: -1 });
    f.orderMove(blue.id, 3);
    let e = null;
    for (let i = 0; i < 200 && !e; i++) e = f.step();
    expect(e).toEqual({ attackerId: blue.id, defenderId: red.id, cell: 2 });
    expect(blue.cell).toBe(1); // halted short of the contested cell
    expect(blue.path.length).toBe(0);
    expect(s.cells[2].owner).toBe('red'); // not captured
  });

  it('clock: day rolls at midnight, hhmm formats', () => {
    const f = new Front(miniSector());
    expect(f.clockMin).toBe(OP_START_MIN);
    expect(f.day).toBe(1);
    expect(f.hhmm).toBe('0600');
    for (let i = 0; i < 18 * 60; i++) f.step(); // 06:00 + 18 h = midnight
    expect(f.day).toBe(2);
    expect(f.hhmm).toBe('0000');
  });

  it('operationStatus: objectives won, deadline and annihilation lost', () => {
    const s = parseSector(['.T'], 1, 'tiny');
    const f = new Front(s);
    f.addChit({ side: 'blue', name: 'Able', cell: 0, strength: 27, companyIndex: 0 });
    expect(operationStatus(f)).toBe('ongoing');
    s.cells[1].owner = 'blue';
    expect(operationStatus(f)).toBe('won');
    s.cells[1].owner = 'red';
    f.clockMin = OP_DEADLINE_DAYS * 1440 + 1;
    expect(operationStatus(f)).toBe('lost');
    f.clockMin = OP_START_MIN;
    f.chits[0].strength = 0;
    expect(operationStatus(f)).toBe('lost');
  });

  it('save/restore roundtrips through JSON', () => {
    const s = makeDefaultSector();
    const f = new Front(s);
    const chit = f.addChit({ side: 'blue', name: 'Able', cell: cellIndex(s, 4, 15), strength: 27, companyIndex: 0 });
    f.orderMove(chit.id, cellIndex(s, 10, 15));
    for (let i = 0; i < 25; i++) f.step();
    const raw = JSON.parse(JSON.stringify(f.save()));
    const g = Front.restore(makeDefaultSector(), raw);
    expect(g.clockMin).toBe(f.clockMin);
    expect(g.chits).toEqual(f.chits);
    expect(g.sector.cells.map((c) => c.owner)).toEqual(f.sector.cells.map((c) => c.owner));
  });
});
```

- [ ] Run `npm run test -- tests/strategic.test.ts` — expect all PASS. `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "M-A task 2: Front — clock, Dijkstra movement, capture, contact, save/restore"`

---

## Task 3: Campaign companies

**Files:**
- Modify: `src/campaign/campaign.ts` (interface `Campaign` ~line 30, `newCampaign` ~line 72)
- Test: `tests/campaign.test.ts` (append one test)

**Interfaces:** `Campaign` gains `companies: { name: string; squads: number[] }[]` (indices into `c.squads`). `newCampaign` builds 3 companies × 3 squads × 9 men = 81 soldiers. Everything else (`fitRoster`, `applyBattleResults`, `fillReplacements`, `advanceDays`) is untouched and keeps working over the flat `squads` array. Additive only — the old linear-operation exports survive until Task 5 so the build stays green.

- [ ] In `src/campaign/campaign.ts`, add to the `Campaign` interface after `nextPid`:

```ts
  companies: { name: string; squads: number[] }[]; // indices into squads
```

- [ ] Replace the whole `newCampaign` function with:

```ts
export const COMPANY_NAMES = ['Able', 'Baker', 'Charlie'];
export const SQUADS_PER_COMPANY = 3;

export function newCampaign(seed: number): Campaign {
  const rng = mulberry32(seed);
  const c: Campaign = { day: 1, battleIndex: 0, nextPid: 1, companies: [], squads: [], soldiers: {}, log: [] };
  const ordinal = ['1st', '2nd', '3rd'];
  for (const coName of COMPANY_NAMES) {
    const squadIndexes: number[] = [];
    for (let q = 0; q < SQUADS_PER_COMPANY; q++) {
      const members: number[] = [];
      for (let i = 0; i < SQUAD_SIZE; i++) {
        const s = newSoldier(c, rng, false);
        if (i === 0) s.weapon = 'smg';
        if (i === 1) s.weapon = 'mg';
        members.push(s.pid);
      }
      // trained together: everyone starts somewhat bonded
      for (const a of members) for (const b of members) if (a !== b) c.soldiers[a].bonds[b] = 0.3;
      squadIndexes.push(c.squads.length);
      c.squads.push({ name: `${coName} ${ordinal[q]}`, members });
    }
    c.companies.push({ name: coName, squads: squadIndexes });
  }
  return c;
}
```

- [ ] Append to the `campaign` describe block in `tests/campaign.test.ts`:

```ts
  it('a fresh campaign fields 3 companies of 3 squads of 9', () => {
    const c = newCampaign(7);
    expect(c.companies.map((co) => co.name)).toEqual(['Able', 'Baker', 'Charlie']);
    expect(c.companies.every((co) => co.squads.length === 3)).toBe(true);
    expect(c.squads.length).toBe(9);
    expect(Object.keys(c.soldiers).length).toBe(81);
    expect(c.squads[0].name).toBe('Able 1st');
    // bonds stay within a squad at creation
    const [sq0, sq3] = [c.squads[0].members, c.squads[3].members];
    expect(c.soldiers[sq0[0]].bonds[sq0[1]]).toBeCloseTo(0.3);
    expect(c.soldiers[sq0[0]].bonds[sq3[0]]).toBeUndefined();
  });
```

- [ ] Run `npm run test` — the existing suite must stay green (existing tests index `c.squads[0]`, which still exists). `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "M-A task 3: campaign companies — 3 companies × 3 squads"`

---

## Task 4: Bridge — engagements become battles, outcomes come back

**Files:**
- Create: `src/strategic/bridge.ts`, `src/strategic/save.ts`
- Modify: `src/sim/scenario.ts:167` (`function wireBonds` → `export function wireBonds`)
- Test: `tests/strategic.test.ts` (append)

**Interfaces:** consumes Tasks 1–3. Produces for Tasks 5–6:
- `newFront(c: Campaign, sector: SectorMap): Front` — initial dispositions.
- `makeStrategicBattle(c: Campaign, front: Front, e: Engagement, seed: number): { sim: Sim; commander: RedCommander; name: string; companyIndex: number }`
- `applyEngagementOutcome(c: Campaign, front: Front, e: Engagement, sim: Sim): { record: BattleRecord; redLosses: number; cellTaken: boolean }`
- `syncStrengths(c: Campaign, front: Front): void`
- `saveGame(campaign, front, storage?)`, `loadGame(storage?)`

- [ ] In `src/sim/scenario.ts`, change `function wireBonds(` to `export function wireBonds(` (line 167).
- [ ] Write `src/strategic/bridge.ts`:

```ts
import { applyBattleResults, fitRoster, type BattleRecord, type Campaign } from '../campaign/campaign';
import { RedCommander } from '../sim/ai';
import { DE_NAMES, type WeaponKey } from '../sim/data';
import { BUILDINGS, makeMap, wireBonds } from '../sim/scenario';
import { Sim, type MemberInit } from '../sim/sim';
import { cellIndex, cellXY, type SectorMap } from './sector';
import { Front, type Chit, type Engagement } from './front';

// Initial dispositions on the default sector: three companies on the west
// bank, static German garrisons on the crossings, towns, and reserve line.
export function newFront(c: Campaign, sector: SectorMap): Front {
  const front = new Front(sector);
  const blueCells: [number, number][] = [
    [4, 13],
    [4, 15],
    [4, 17],
  ];
  c.companies.forEach((co, i) =>
    front.addChit({
      side: 'blue',
      name: `${co.name} Company`,
      cell: cellIndex(sector, blueCells[i][0], blueCells[i][1]),
      strength: 0, // synced below
      companyIndex: i,
    }),
  );
  const garrisons: [string, number, number, number][] = [
    ['Brückenwache Süd', 20, 15, 18],
    ['Garnison St-Aubin', 25, 15, 27],
    ['Brückenwache Nord', 20, 7, 18],
    ['Garnison Vireux', 30, 7, 27],
    ['Reserve', 33, 15, 27],
  ];
  for (const [name, x, y, strength] of garrisons) {
    front.addChit({ side: 'red', name, cell: cellIndex(sector, x, y), strength, companyIndex: -1 });
  }
  syncStrengths(c, front);
  return front;
}

// Blue chit strength mirrors the roster; red carries attrition. Wiped chits vanish.
export function syncStrengths(c: Campaign, front: Front): void {
  for (const chit of front.chits) {
    if (chit.side !== 'blue') continue;
    chit.strength = c.companies[chit.companyIndex].squads.reduce(
      (n, si) => n + c.squads[si].members.filter((pid) => c.soldiers[pid].status === 'fit').length,
      0,
    );
  }
  front.chits = front.chits.filter((ch) => ch.strength > 0);
}

function redMembers(sim: Sim, count: number, cx: number, cy: number): MemberInit[] {
  const members: MemberInit[] = [];
  for (let i = 0; i < count; i++) {
    const weapon: WeaponKey = i === 0 ? 'smg' : i === 1 ? 'mg' : i === 2 ? 'panzerfaust' : 'rifle';
    members.push({
      name: DE_NAMES[sim.rng.int(DE_NAMES.length)],
      weapon,
      x: cx + sim.rng.range(-4, 4),
      y: cy + sim.rng.range(-4, 4),
    });
  }
  return members;
}

// M-A: every engagement fights on today's hand-built village map. The carve
// (M-B) replaces makeMap here; nothing outside this function changes.
export function makeStrategicBattle(
  c: Campaign,
  front: Front,
  e: Engagement,
  seed: number,
): { sim: Sim; commander: RedCommander; name: string; companyIndex: number } {
  const map = makeMap(seed);
  const sim = new Sim(map, seed);
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;

  const company = c.companies[attacker.companyIndex];
  const rosters = company.squads.map((si) => fitRoster(c, si));
  company.squads.forEach((si, i) => {
    const roster = rosters[i];
    if (roster.length === 0) return;
    const members: MemberInit[] = roster.map((r) => ({
      name: r.name,
      weapon: r.weapon,
      x: 8 + sim.rng.range(-2, 2),
      y: 32 + i * 28 + sim.rng.range(-3, 3),
      courage: r.courage,
      xp: r.xp,
      bodyDamage: r.bodyDamage,
      pid: r.pid,
    }));
    sim.addSquad('blue', c.squads[si].name, members);
  });
  wireBonds(sim, rosters);

  // German garrison: buildings first, then the east woods
  const anchors: { x: number; y: number }[] = [
    { x: BUILDINGS[0].x + 5, y: BUILDINGS[0].y + 4 },
    { x: BUILDINGS[1].x + 6, y: BUILDINGS[1].y + 4 },
    { x: BUILDINGS[2].x + 4, y: BUILDINGS[2].y + 3 },
    { x: 128, y: 45 },
  ];
  const posts: Record<number, { x: number; y: number }> = {};
  let remaining = defender.strength;
  for (let i = 0; remaining > 0; i++) {
    const size = Math.min(9, remaining);
    remaining -= size;
    const anchor = anchors[Math.min(i, anchors.length - 1)];
    const squad = sim.addSquad('red', `${i + 1}. Gruppe`, redMembers(sim, size, anchor.x, anchor.y));
    posts[squad.id] = anchor;
  }

  const { x, y } = cellXY(front.sector, e.cell);
  return {
    sim,
    commander: new RedCommander({ stance: 'defend', posts }),
    name: `${defender.name} at (${x}, ${y})`,
    companyIndex: attacker.companyIndex,
  };
}

function retreat(front: Front, chit: Chit): void {
  const { x, y } = cellXY(front.sector, chit.cell);
  for (const [dx, dy] of [
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, 0],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= front.sector.w || ny >= front.sector.h) continue;
    const v = cellIndex(front.sector, nx, ny);
    const cell = front.sector.cells[v];
    if (cell.owner === chit.side && cell.terrain !== 'river' && !front.chitAt(v)) {
      chit.cell = v;
      return;
    }
  }
  chit.strength = 0; // nowhere to go: overrun
}

export function applyEngagementOutcome(
  c: Campaign,
  front: Front,
  e: Engagement,
  sim: Sim,
): { record: BattleRecord; redLosses: number; cellTaken: boolean } {
  const won = sim.winner === 'blue';
  const record = applyBattleResults(c, sim, won);
  const attacker = front.chits.find((ch) => ch.id === e.attackerId)!;
  const defender = front.chits.find((ch) => ch.id === e.defenderId)!;
  const redLosses = sim.soldiers.filter((s) => s.side === 'red' && (!s.alive || s.downed)).length;
  defender.strength = Math.max(0, defender.strength - redLosses);
  let cellTaken = false;
  if (won) {
    if (defender.strength > 0) retreat(front, defender);
    front.sector.cells[e.cell].owner = 'blue';
    attacker.cell = e.cell;
    cellTaken = true;
  }
  syncStrengths(c, front);
  return { record, redLosses, cellTaken };
}
```

- [ ] Write `src/strategic/save.ts`:

```ts
import type { Campaign } from '../campaign/campaign';
import { Front, type FrontSave } from './front';
import { makeDefaultSector } from './sector';

const KEY = 'ccg-save-v2';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function saveGame(campaign: Campaign, front: Front, storage: Store = localStorage): void {
  storage.setItem(KEY, JSON.stringify({ campaign, front: front.save() }));
}

export function loadGame(storage: Store = localStorage): { campaign: Campaign; front: Front } | null {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { campaign: Campaign; front: FrontSave };
    return { campaign: parsed.campaign, front: Front.restore(makeDefaultSector(), parsed.front) };
  } catch {
    return null;
  }
}
```

- [ ] Append to `tests/strategic.test.ts` (imports: `newCampaign` from campaign, `newFront`, `makeStrategicBattle`, `applyEngagementOutcome`, `syncStrengths` from bridge, `saveGame`, `loadGame` from save):

```ts
describe('bridge', () => {
  const setup = () => {
    const c = newCampaign(10);
    const sector = makeDefaultSector();
    const front = newFront(c, sector);
    return { c, sector, front };
  };

  it('newFront fields 3 blue companies at strength 27 and 5 garrisons', () => {
    const { front } = setup();
    const blue = front.chits.filter((ch) => ch.side === 'blue');
    expect(blue.length).toBe(3);
    expect(blue.every((ch) => ch.strength === 27)).toBe(true);
    expect(front.chits.filter((ch) => ch.side === 'red').length).toBe(5);
  });

  it('a strategic battle fields the company roster with pids and bonds against a sized garrison', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const { sim } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: wache.id, cell: wache.cell }, 5);
    const blue = sim.soldiers.filter((s) => s.side === 'blue');
    const red = sim.soldiers.filter((s) => s.side === 'red');
    expect(blue.length).toBe(27);
    expect(blue.every((s) => s.pid > 0)).toBe(true);
    expect(red.length).toBe(18); // ceil(18/9) = 2 squads
    const [a, b] = blue;
    expect(a.bonds[b.id]).toBeCloseTo(0.3); // trained-together, wired from campaign
  });

  it('a won battle takes the cell, moves the attacker in, and attrits the garrison away', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
    const { sim } = makeStrategicBattle(c, front, e, 6);
    for (const s of sim.soldiers) if (s.side === 'red') s.alive = false;
    sim.step();
    expect(sim.winner).toBe('blue');
    const out = applyEngagementOutcome(c, front, e, sim);
    expect(out.cellTaken).toBe(true);
    expect(out.redLosses).toBe(18);
    expect(front.sector.cells[e.cell].owner).toBe('blue');
    expect(able.cell).toBe(e.cell);
    expect(front.chits.find((ch) => ch.name === 'Brückenwache Süd')).toBeUndefined();
    expect(c.log.length).toBe(1);
  });

  it('a lost battle leaves the map unchanged and prunes a wiped company', () => {
    const { c, front } = setup();
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const e = { attackerId: able.id, defenderId: wache.id, cell: wache.cell };
    const { sim } = makeStrategicBattle(c, front, e, 7);
    for (const s of sim.soldiers) if (s.side === 'blue') s.alive = false;
    sim.step();
    expect(sim.winner).toBe('red');
    const out = applyEngagementOutcome(c, front, e, sim);
    expect(out.cellTaken).toBe(false);
    expect(front.sector.cells[e.cell].owner).toBe('red');
    expect(front.chits.filter((ch) => ch.side === 'blue').length).toBe(2); // Able wiped, pruned
  });

  it('saveGame/loadGame roundtrips campaign and front', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const { c, front } = setup();
    saveGame(c, front, storage);
    const loaded = loadGame(storage)!;
    expect(loaded.campaign).toEqual(c);
    expect(loaded.front.chits).toEqual(front.chits);
    expect(loaded.front.clockMin).toBe(front.clockMin);
  });
});
```

- [ ] Run `npm run test` — all PASS (existing suites untouched). `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "M-A task 4: bridge — strategic battles from rosters, outcomes to the front"`

---

## Task 5: Strategic UI + two-mode main

**Files:**
- Create: `src/render/strategic.ts`
- Rewrite: `src/main.ts`
- Modify: `src/campaign/campaign.ts` — delete `BATTLES_PER_OPERATION`, `DAYS_BETWEEN_BATTLES`, `battleIndex` (field + `c.battleIndex++` + `battleIndex: c.battleIndex` in `applyBattleResults`, and `battleIndex: number` in `BattleRecord`), `saveCampaign`, `loadCampaign`, `STORAGE_KEY`
- Modify: `src/sim/scenario.ts` — delete `makeCampaignBattle`, `BATTLE_NAMES`, `CampaignBattle`, `rosterMembers` (keep `makeScenario`, `makeMap`, `BUILDINGS`, `wireBonds`, `addRedDefenders`, `squadMembers`, `placeInBuilding`)
- Modify: `tests/campaign.test.ts` — replace `makeCampaignBattle` usages
- Test: `tests/strategic.test.ts` (append `StrategicView.cellAtScreen` test)

**Interfaces:** consumes everything above. `StrategicView` is pure draw + picking; all game state lives in `main.ts`.

- [ ] Write `src/render/strategic.ts`:

```ts
import type { Front } from '../strategic/front';
import { cellXY, type CellTerrain, type SectorMap } from '../strategic/sector';

const TERRAIN_COLORS: Record<CellTerrain, string> = {
  open: '#4e6b3f',
  woods: '#31482b',
  town: '#7a6a55',
  river: '#3b5a72',
  bridge: '#8a8172',
  road: '#8a8172',
};

export class StrategicView {
  constructor(readonly sector: SectorMap) {}

  layout(canvasW: number, canvasH: number): { size: number; ox: number; oy: number } {
    const size = Math.max(4, Math.floor(Math.min(canvasW / this.sector.w, (canvasH - 60) / this.sector.h)));
    return { size, ox: Math.floor((canvasW - size * this.sector.w) / 2), oy: 50 };
  }

  cellAtScreen(px: number, py: number, canvasW: number, canvasH: number): number {
    const { size, ox, oy } = this.layout(canvasW, canvasH);
    const x = Math.floor((px - ox) / size);
    const y = Math.floor((py - oy) / size);
    if (x < 0 || y < 0 || x >= this.sector.w || y >= this.sector.h) return -1;
    return y * this.sector.w + x;
  }

  draw(ctx: CanvasRenderingContext2D, front: Front, selectedChitId: number, paused: boolean, speed: number, canvasW: number, canvasH: number): void {
    const { size, ox, oy } = this.layout(canvasW, canvasH);
    ctx.fillStyle = '#1a1c18';
    ctx.fillRect(0, 0, canvasW, canvasH);
    for (let i = 0; i < this.sector.cells.length; i++) {
      const cell = this.sector.cells[i];
      const { x, y } = cellXY(this.sector, i);
      ctx.fillStyle = TERRAIN_COLORS[cell.terrain];
      ctx.fillRect(ox + x * size, oy + y * size, size - 1, size - 1);
      if (cell.owner) {
        ctx.fillStyle = cell.owner === 'blue' ? 'rgba(70,110,180,0.28)' : 'rgba(180,70,70,0.28)';
        ctx.fillRect(ox + x * size, oy + y * size, size - 1, size - 1);
      }
      if (cell.objective) {
        ctx.strokeStyle = '#e8c84a';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox + x * size + 1, oy + y * size + 1, size - 3, size - 3);
      }
    }
    // path preview for the selected chit
    const selected = front.chits.find((c) => c.id === selectedChitId);
    if (selected && selected.path.length > 0) {
      ctx.strokeStyle = 'rgba(230,230,200,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const start = cellXY(this.sector, selected.cell);
      ctx.moveTo(ox + (start.x + 0.5) * size, oy + (start.y + 0.5) * size);
      for (const i of selected.path) {
        const p = cellXY(this.sector, i);
        ctx.lineTo(ox + (p.x + 0.5) * size, oy + (p.y + 0.5) * size);
      }
      ctx.stroke();
    }
    for (const chit of front.chits) {
      const { x, y } = cellXY(this.sector, chit.cell);
      const cx = ox + x * size;
      const cy = oy + y * size;
      ctx.fillStyle = chit.side === 'blue' ? '#3a5a9a' : '#9a3a3a';
      ctx.fillRect(cx + 2, cy + 2, size - 5, size - 5);
      if (chit.id === selectedChitId) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, cy + 1, size - 3, size - 3);
      }
      ctx.fillStyle = '#e8e4d8';
      ctx.font = `${Math.max(8, size * 0.45)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(chit.name[0], cx + size / 2, cy + size * 0.55);
      ctx.font = '10px monospace';
      ctx.fillText(String(chit.strength), cx + size / 2, cy + size - 2);
    }
    ctx.fillStyle = '#e8e4d8';
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${this.sector.name} — DAY ${front.day} ${front.hhmm} — ${paused ? 'PAUSED' : `${speed} min/s`} — space pause · 1/2/3 speed · click select · right-click move`,
      12,
      28,
    );
  }
}
```

- [ ] Rewrite `src/main.ts` in full:

```ts
import { advanceDays, fillReplacements, newCampaign, type Campaign } from './campaign/campaign';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { StrategicView } from './render/strategic';
import type { RedCommander } from './sim/ai';
import { DT, type Sim } from './sim/sim';
import { applyEngagementOutcome, makeStrategicBattle, newFront, syncStrengths } from './strategic/bridge';
import { operationStatus, type Engagement, type Front } from './strategic/front';
import { loadGame, saveGame } from './strategic/save';
import { makeDefaultSector } from './strategic/sector';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d')!;
const resize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
};
resize();
window.addEventListener('resize', resize);

const overlay = document.createElement('div');
overlay.style.cssText =
  'position:fixed;inset:0;display:none;background:rgba(10,12,10,0.92);color:#e8e4d8;' +
  'font:14px monospace;overflow:auto;padding:40px;z-index:10;';
document.body.appendChild(overlay);

let campaign: Campaign;
let front: Front;
const loaded = loadGame();
if (loaded) {
  campaign = loaded.campaign;
  front = loaded.front;
} else {
  campaign = newCampaign(Date.now() % 100000);
  front = newFront(campaign, makeDefaultSector());
  saveGame(campaign, front);
}

let mode: 'strategic' | 'battle' = 'strategic';
let stratView = new StrategicView(front.sector);
let selectedChit = -1;
const SPEEDS = [1, 10, 60]; // strategic minutes per real second
let speedIdx = 1;
let stratPaused = true;
let stratAcc = 0;
let prevDay = front.day;
let pendingEngagement: Engagement | null = null;
let opEnded = false;

// battle state
let sim: Sim;
let commander: RedCommander;
let renderer: Renderer;
let battleCompany = -1;
const cam = new Camera(60, 60);
let battlePaused = true;
let selectedSquad = -1;
let selectedVehicle = -1;
let targetMode: '' | 'barrage' | 'air' = '';
let winnerAt = -1;
let debriefShown = false;

function setTargetMode(m: '' | 'barrage' | 'air'): void {
  targetMode = m;
  renderer.modeLine =
    m === 'barrage' ? '>>> MORTAR BARRAGE: click the target <<<' : m === 'air' ? '>>> AIR STRIKE: click the target (strafe runs west to east) <<<' : '';
}

function showContactModal(e: Engagement): void {
  const attacker = front.chits.find((c) => c.id === e.attackerId)!;
  const defender = front.chits.find((c) => c.id === e.defenderId)!;
  overlay.innerHTML = `
    <h1>CONTACT</h1>
    <p>${attacker.name} (${attacker.strength} men) has met ${defender.name} (~${defender.strength} men).</p>
    <button id="fight" style="font:16px monospace;padding:8px 16px;">Attack</button>
    <button id="standdown" style="font:16px monospace;padding:8px 16px;margin-left:12px;">Stand down</button>`;
  overlay.style.display = 'block';
  document.getElementById('fight')!.onclick = () => {
    overlay.style.display = 'none';
    startEngagementBattle(e);
  };
  document.getElementById('standdown')!.onclick = () => {
    overlay.style.display = 'none';
    pendingEngagement = null;
  };
}

function startEngagementBattle(e: Engagement): void {
  const seed = front.clockMin * 7919 + e.cell;
  const battle = makeStrategicBattle(campaign, front, e, seed);
  sim = battle.sim;
  commander = battle.commander;
  battleCompany = battle.companyIndex;
  renderer = new Renderer(sim);
  renderer.hudTitle = `Day ${front.day} ${front.hhmm} — ${battle.name}`;
  cam.x = 60;
  cam.y = 60;
  cam.scale = 8;
  mode = 'battle';
  battlePaused = true;
  selectedSquad = -1;
  selectedVehicle = -1;
  targetMode = '';
  winnerAt = -1;
  debriefShown = false;
}

function showDebrief(): void {
  debriefShown = true;
  const e = pendingEngagement!;
  const out = applyEngagementOutcome(campaign, front, e, sim);
  pendingEngagement = null;
  saveGame(campaign, front);
  const company = campaign.companies[battleCompany];
  const rows = company.squads
    .map((si) => campaign.squads[si])
    .map((sq) => {
      const men = sq.members
        .map((pid) => campaign.soldiers[pid])
        .map((cs) => {
          const scars = cs.bodyDamage.some((d) => d > 0) && cs.status === 'fit' ? ' [permanent injury]' : '';
          const st = cs.status === 'kia' ? 'KIA' : cs.status === 'recovering' ? `recovering (${cs.recoveryDays}d)` : 'fit';
          return `<tr><td>${cs.name}</td><td>${cs.weapon}</td><td>${cs.battles}</td><td>${st}${scars}</td></tr>`;
        })
        .join('');
      return `<h3>${sq.name}</h3><table border="0" cellpadding="4"><tr><th align="left">Name</th><th align="left">Weapon</th><th align="left">Battles</th><th align="left">Status</th></tr>${men}</table>`;
    })
    .join('');
  overlay.innerHTML = `
    <h1>${out.record.won ? 'VICTORY' : 'DEFEAT'} — ${out.record.kia.length} KIA, ${out.record.wounded.length} wounded, ~${out.redLosses} enemy losses</h1>
    <p>${out.record.kia.length > 0 ? 'Fallen: ' + out.record.kia.join(', ') : 'No one died today.'}</p>
    <p>${out.cellTaken ? 'The ground is ours.' : 'The attack failed; the line is unchanged.'}</p>
    ${rows}
    <button id="next" style="font:16px monospace;padding:8px 16px;">Return to the front</button>`;
  overlay.style.display = 'block';
  document.getElementById('next')!.onclick = () => {
    overlay.style.display = 'none';
    mode = 'strategic';
    stratPaused = true;
  };
}

function freshCampaign(): void {
  campaign = newCampaign(Date.now() % 100000);
  front = newFront(campaign, makeDefaultSector());
  stratView = new StrategicView(front.sector);
  selectedChit = -1;
  pendingEngagement = null;
  opEnded = false;
  prevDay = front.day;
  stratPaused = true;
  saveGame(campaign, front);
}

function showOperationEnd(status: 'won' | 'lost'): void {
  opEnded = true;
  const kia = Object.values(campaign.soldiers).filter((s) => s.status === 'kia').length;
  overlay.innerHTML = `
    <h1>OPERATION ${status === 'won' ? 'ACCOMPLISHED' : 'FAILED'}</h1>
    <p>${campaign.log.length} battles fought over ${front.day} days. ${kia} men killed.</p>
    <button id="next" style="font:16px monospace;padding:8px 16px;">New operation</button>`;
  overlay.style.display = 'block';
  document.getElementById('next')!.onclick = () => {
    overlay.style.display = 'none';
    freshCampaign();
  };
}

let dragStart: { x: number; y: number } | null = null;
let dragged = false;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    dragStart = { x: e.clientX, y: e.clientY };
    dragged = false;
  }
});
canvas.addEventListener('mousemove', (e) => {
  if (mode !== 'battle') return;
  if (dragStart && e.buttons & 1) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (dragged || Math.hypot(dx, dy) > 5) {
      dragged = true;
      cam.x -= dx / cam.scale;
      cam.y -= dy / cam.scale;
      dragStart = { x: e.clientX, y: e.clientY };
    }
  }
});
canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (mode === 'strategic') {
    const cell = stratView.cellAtScreen(e.clientX, e.clientY, canvas.width, canvas.height);
    const chit = cell >= 0 ? front.chitAt(cell, 'blue') : undefined;
    selectedChit = chit ? chit.id : -1;
    dragStart = null;
    return;
  }
  if (!dragged) {
    const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
    if (targetMode === 'barrage') {
      if (sim.callBarrage('blue', wx, wy)) {
        setTargetMode('');
        renderer.markBarrage(wx, wy);
      }
    } else if (targetMode === 'air') {
      if (sim.callAirstrike('blue', wx, wy)) {
        setTargetMode('');
        renderer.markStrafe(wx, wy);
      }
    } else {
      selectedVehicle = -1;
      for (const v of sim.vehicles) {
        if (v.alive && v.side === 'blue' && Math.hypot(v.x - wx, v.y - wy) < 3.5) selectedVehicle = v.id;
      }
      let best = -1;
      if (selectedVehicle < 0) {
        let bestD = 15 / cam.scale;
        for (const s of sim.soldiers) {
          if (!s.alive || s.side !== 'blue' || s.inVehicle >= 0) continue;
          const d = Math.hypot(s.x - wx, s.y - wy);
          if (d < bestD) {
            bestD = d;
            best = s.squadId;
          }
        }
      }
      selectedSquad = best;
      renderer.selectedVehicle = selectedVehicle;
    }
  }
  dragStart = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode === 'strategic') {
    if (selectedChit >= 0) {
      const cell = stratView.cellAtScreen(e.clientX, e.clientY, canvas.width, canvas.height);
      if (cell >= 0) front.orderMove(selectedChit, cell);
    }
    return;
  }
  if (targetMode !== '') return;
  const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
  if (selectedVehicle >= 0) sim.orderVehicleMove(selectedVehicle, wx, wy);
  else if (selectedSquad >= 0) sim.orderMove(selectedSquad, wx, wy);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (mode === 'battle') cam.zoom(Math.pow(1.1, -e.deltaY / 100), e.clientX, e.clientY, canvas.width, canvas.height);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (mode === 'strategic') stratPaused = !stratPaused;
    else battlePaused = !battlePaused;
  }
  if (mode === 'strategic') {
    if (e.code === 'Digit1') speedIdx = 0;
    if (e.code === 'Digit2') speedIdx = 1;
    if (e.code === 'Digit3') speedIdx = 2;
    if (e.code === 'Escape') selectedChit = -1;
    return;
  }
  if (e.code === 'KeyB' && sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  if (e.code === 'KeyA' && sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
  if (e.code === 'Escape') {
    selectedSquad = -1;
    selectedVehicle = -1;
    renderer.selectedVehicle = -1;
    setTargetMode('');
  }
});

// debug/automation handle
(window as unknown as { __game: object }).__game = {
  get sim() {
    return sim;
  },
  get front() {
    return front;
  },
  getCampaign: () => campaign,
  cam,
  setPaused: (p: boolean) => {
    stratPaused = p;
    battlePaused = p;
  },
  selectSquad: (i: number) => (selectedSquad = i),
  startEngagementBattle,
  showDebrief,
};

let last = performance.now();
let acc = 0;
const DT_MS = DT * 1000;

function frame(now: number): void {
  const dtReal = Math.min(now - last, 250);
  last = now;
  if (mode === 'strategic') {
    if (!stratPaused && !pendingEngagement && !opEnded && overlay.style.display === 'none') {
      stratAcc += (dtReal / 1000) * SPEEDS[speedIdx];
      while (stratAcc >= 1 && !pendingEngagement) {
        stratAcc -= 1;
        const e = front.step();
        if (front.day > prevDay) {
          advanceDays(campaign, front.day - prevDay);
          fillReplacements(campaign, front.day * 31 + 7);
          syncStrengths(campaign, front);
          prevDay = front.day;
          saveGame(campaign, front);
        }
        if (e) {
          pendingEngagement = e;
          stratPaused = true;
          showContactModal(e);
        }
      }
      const status = operationStatus(front);
      if (status !== 'ongoing' && !opEnded) showOperationEnd(status);
    }
    stratView.draw(ctx, front, selectedChit, stratPaused, SPEEDS[speedIdx], canvas.width, canvas.height);
  } else {
    acc += dtReal;
    if (!battlePaused) {
      while (acc >= DT_MS) {
        commander.update(sim);
        sim.step();
        acc -= DT_MS;
      }
    } else {
      acc = 0;
    }
    renderer.addEvents(sim.takeEvents(), now);
    renderer.addBooms(sim.takeBooms(), now);
    renderer.addPlanes(sim.takePlanes(), now);
    renderer.draw(ctx, cam, selectedSquad, battlePaused, now);
    if (sim.winner && winnerAt < 0) winnerAt = now;
    if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

- [ ] In `src/campaign/campaign.ts` delete: `BATTLES_PER_OPERATION`, `DAYS_BETWEEN_BATTLES`, the `battleIndex` field from `Campaign` and its init in `newCampaign`, `battleIndex: number` from `BattleRecord` and `battleIndex: c.battleIndex` from the record literal, the `c.battleIndex++;` line, `STORAGE_KEY`, `saveCampaign`, `loadCampaign`.
- [ ] In `src/sim/scenario.ts` delete: the `CampaignBattle` interface, `BATTLE_NAMES`, `rosterMembers`, `makeCampaignBattle`, and the now-unused imports (`Campaign`, `RosterEntry`, `fitRoster`, `RedCommander` — keep `RedCommander` only if still referenced; after this deletion it is not, remove it).
- [ ] In `tests/campaign.test.ts`:
  - Remove `makeCampaignBattle` from the scenario import; remove `saveCampaign, loadCampaign` from the campaign import; add `import { makeStrategicBattle, newFront } from '../src/strategic/bridge';`, `import { makeDefaultSector } from '../src/strategic/sector';`, `import { saveGame, loadGame } from '../src/strategic/save';`.
  - Add a shared helper at the top of the `campaign` describe block:

```ts
  const battleFor = (c: ReturnType<typeof newCampaign>, seed: number) => {
    const front = newFront(c, makeDefaultSector());
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    return makeStrategicBattle(c, front, { attackerId: able.id, defenderId: wache.id, cell: wache.cell }, seed);
  };
```

  - In `'battle results persist…'`: replace `const { sim } = makeCampaignBattle(c, 5);` with `const { sim } = battleFor(c, 5);`.
  - In `'a campaign battle wires persistent bonds…'`: replace `const { sim } = makeCampaignBattle(c, 8);` with `const { sim } = battleFor(c, 8);`.
  - Replace the `'save/load roundtrip'` test body with:

```ts
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const c = newCampaign(4);
    const front = newFront(c, makeDefaultSector());
    saveGame(c, front, storage);
    expect(loadGame(storage)!.campaign).toEqual(c);
```

- [ ] Append to `tests/strategic.test.ts` (import `StrategicView` from `../src/render/strategic`):

```ts
describe('strategic view', () => {
  it('cellAtScreen inverts layout', () => {
    const view = new StrategicView(makeDefaultSector());
    const { size, ox, oy } = view.layout(800, 650);
    expect(view.cellAtScreen(ox + size * 4 + 1, oy + size * 15 + 1, 800, 650)).toBe(15 * 40 + 4);
    expect(view.cellAtScreen(0, 0, 800, 650)).toBe(-1);
  });
});
```

- [ ] Run `npm run test` — all suites PASS. `npm run check` clean.
- [ ] Manual smoke test — run `npm run dev`, open the browser, verify each:
  1. Strategic map renders: river down the middle, two bridge cells, gold-bordered 3×3 objective town, 3 blue chits west, 5 red chits east.
  2. Click Able Company → white selection border. Right-click the south bridge → path polyline appears along the road.
  3. Space unpauses; clock advances; chit walks the road (speed 3 ≈ 10 cells/s of road).
  4. On reaching the bridge: CONTACT modal. "Attack" → battle mode on the village map, blue company on the west edge, Germans in the buildings.
  5. Win (or use `__game.sim` to slaughter red: `__game.sim.soldiers.filter(s=>s.side==='red').forEach(s=>s.alive=false)`), debrief shows the company roster, "Return to the front" → bridge cell now blue-tinted, garrison chit gone, Able sits on the bridge.
  6. Reload the page → campaign and front restore (same ownership, same chit positions).
  7. Fast-forward past a midnight → wounded men's recovery ticks down (check a `recovering (Nd)` row before/after).
- [ ] Commit: `git add -A && git commit -m "M-A task 5: strategic map UI, two-mode main, linear operation deleted"`

---

## Task 6: Full-loop integration test

**Files:**
- Test: `tests/strategic.test.ts` (append)

**Interfaces:** consumes everything; proves the M-A loop end-to-end headlessly.

- [ ] Append (import `operationStatus` already present from Task 2 block):

```ts
describe('m-a loop', () => {
  it('order → march → contact → battle → outcome → objective → won', () => {
    const c = newCampaign(10);
    const sector = makeDefaultSector();
    const front = newFront(c, sector);
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    front.orderMove(able.id, cellIndex(sector, 20, 15));
    let e = null;
    for (let i = 0; i < 100000 && !e; i++) e = front.step();
    expect(e).not.toBeNull();
    expect(e!.cell).toBe(cellIndex(sector, 20, 15));
    const seed = front.clockMin * 7919 + e!.cell;
    const { sim } = makeStrategicBattle(c, front, e!, seed);
    for (const s of sim.soldiers) if (s.side === 'red') s.alive = false;
    sim.step();
    const out = applyEngagementOutcome(c, front, e!, sim);
    expect(out.cellTaken).toBe(true);
    expect(able.cell).toBe(cellIndex(sector, 20, 15));
    expect(operationStatus(front)).toBe('ongoing');
    for (const cell of sector.cells) if (cell.objective) cell.owner = 'blue';
    expect(operationStatus(front)).toBe('won');
  });
});
```

- [ ] Run `npm run test` — all PASS. `npm run check` clean.
- [ ] Commit: `git add -A && git commit -m "M-A task 6: headless full-loop integration test"`

---

## Task dependency graph (for parallel execution)

- **Batch 1:** Task 1, Task 3 (independent of each other).
- **Batch 2:** Task 2 (needs 1).
- **Batch 3:** Task 4 (needs 1, 2, 3).
- **Batch 4:** Task 5 (needs 1–4; touches the most files, run alone).
- **Batch 5:** Task 6 (needs 1–5).

## Self-review notes

- Every M-A spec item maps to a task: cell grid + sector (1), chit movement + clock + contact (2), roster grouping (3), battle generation + outcome feedback (4), strategic UI + mode switch + saves (5), end-to-end proof (6).
- Names/signatures were cross-checked across tasks: `cellIndex/cellXY/parseSector/makeDefaultSector` (1) ↔ imports in (2,4,5); `Chit/Engagement/Front/findPath/operationStatus` (2) ↔ (4,5,6); `companies` (3) ↔ `syncStrengths`/`makeStrategicBattle` (4) ↔ debrief rows (5).
- `applyBattleResults` still references `c.battleIndex` between Tasks 3–4 — it is only deleted in Task 5 together with all its readers, so `npm run check` stays green at every task boundary.
