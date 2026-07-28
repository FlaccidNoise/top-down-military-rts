import { describe, expect, it } from 'vitest';
import type { TheaterConfig } from '../src/campaign/spec';
import { feasible, makeTheater, TheaterGenError } from '../src/strategic/theatergen';
import { validateTheater, type RejectReason } from '../src/strategic/theatergen/validate';
import type { Theater } from '../src/strategic/theater';
import type { Side } from '../src/sim/sim';

const CFG: TheaterConfig = {
  sizeKm: 24,
  riverDensity: 2,
  crossingScarcity: 1,
  roadDensity: 2,
  railDensity: 1,
  townDensity: 1,
  townSpacingMinKm: 5,
  terrainMix: 'bocage',
  woodsShare: 2,
};

const fnv = (nums: (number | string)[]): number => {
  let h = 2166136261;
  for (const n of nums) {
    for (const ch of String(n)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    h ^= 44;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const structureHash = (t: Theater): number =>
  fnv([
    t.name,
    ...t.nodes.flatMap((n) => [n.id, n.kind, n.name, n.pos.x, n.pos.y, n.regionId, n.crossing ? n.crossing.kind : '-']),
    ...t.edges.flatMap((e) => [e.id, e.a, e.b, e.moveClass, e.lengthM, e.paceMpm]),
    ...t.regions.flatMap((r) => [r.id, r.terrainClass, r.name, r.areaM2]),
    ...t.rivers.flatMap((r) => [r.id, r.name, r.polyline.length]),
    ...t.objectiveNodes,
    ...t.sources.blue,
    ...t.sources.red,
  ]);

describe('makeTheater', () => {
  it('generates a valid theater for 64 consecutive seeds — no fallback, no reject', () => {
    for (let seed = 1; seed <= 64; seed++) {
      const { theater, initialControlByNode } = makeTheater(seed, CFG);
      expect(theater.objectiveNodes.length).toBeGreaterThan(0);
      expect(validateTheater(theater, initialControlByNode)).toBeNull();
      expect(theater.nodes.every((n) => n.regionId >= 0)).toBe(true);
      expect(theater.edges.filter((e) => e.moveClass !== 'rail').every((e) => e.paceMpm > 0)).toBe(true);
    }
  });

  it('is byte-identical across regenerations, 16 seeds', () => {
    for (let seed = 1; seed <= 16; seed++) {
      expect(makeTheater(seed, CFG)).toEqual(makeTheater(seed, CFG));
    }
  });

  it('pins three full-structure hashes', () => {
    // These pins use THIS FILE's structureHash recipe — scripts/theater-fp.mjs
    // hashes a different (nested per-field) form and its rows do NOT paste
    // here. Re-record by printing structureHash for seeds 1-3; any move
    // without a THEATER_VERSION bump is the tripwire firing.
    expect(structureHash(makeTheater(1, CFG).theater)).toBe(PIN_1);
    expect(structureHash(makeTheater(2, CFG).theater)).toBe(PIN_2);
    expect(structureHash(makeTheater(3, CFG).theater)).toBe(PIN_3);
  });

  it('knob isolation: terrainMix repaints regions and repaces edges but moves no geometry', () => {
    const a = makeTheater(7, CFG).theater;
    const b = makeTheater(7, { ...CFG, terrainMix: 'open' }).theater;
    expect(b.nodes.map((n) => [n.id, n.pos.x, n.pos.y, n.kind])).toEqual(a.nodes.map((n) => [n.id, n.pos.x, n.pos.y, n.kind]));
    expect(b.edges.map((e) => [e.id, e.a, e.b, e.lengthM])).toEqual(a.edges.map((e) => [e.id, e.a, e.b, e.lengthM]));
    expect(b.rivers).toEqual(a.rivers);
    const paints = (t: Theater): string => t.regions.map((r) => r.terrainClass).join(',');
    expect(paints(b)).not.toBe(paints(a));
  });

  it('bands scale as functions of cfg: a smaller theater seats fewer towns', () => {
    const small = makeTheater(7, { ...CFG, sizeKm: 18 }).theater;
    const big = makeTheater(7, { ...CFG, sizeKm: 32 }).theater;
    const towns = (t: Theater): number => t.nodes.filter((n) => n.kind === 'town').length;
    expect(towns(small)).toBeLessThan(towns(big));
    expect(small.boundsM).toEqual({ w: 18000, h: 13500 });
  });

  it('the initial front is river-anchored: crossings start red, both sides hold >= 25%', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { theater, initialControlByNode } = makeTheater(seed, CFG);
      for (const n of theater.nodes) if (n.crossing) expect(initialControlByNode[n.id]).toBe('red');
      const blue = initialControlByNode.filter((s) => s === 'blue').length;
      expect(blue / theater.nodes.length).toBeGreaterThanOrEqual(0.25);
      expect(blue / theater.nodes.length).toBeLessThanOrEqual(0.75);
      expect(theater.sources.blue.length).toBeGreaterThan(0);
      expect(theater.sources.red.length).toBeGreaterThan(0);
    }
  });
});

describe('validateTheater — all eleven rejects constructible, zero rng', () => {
  const valid = makeTheater(1, CFG);
  const clone = (): { t: Theater; c: Side[] } => ({
    t: JSON.parse(JSON.stringify(valid.theater)) as Theater,
    c: [...valid.initialControlByNode],
  });

  const CASES: [RejectReason, (t: Theater, c: Side[]) => void][] = [
    ['orphan-node', (t) => {
      t.nodes.push({ ...t.nodes[0], id: t.nodes.length, name: 'Orphelin' });
    }],
    ['disconnected', (t) => {
      // Sever one village's every foot edge but leave it a stub edge to a
      // fresh twin so it is not an orphan — a two-node island.
      const v = t.nodes.find((n) => n.kind === 'village')!;
      const twin = { ...t.nodes[0], id: t.nodes.length, name: 'Îlot', kind: 'village' as const };
      t.nodes.push(twin);
      const cut = t.edges.filter((e) => e.moveClass !== 'rail' && (e.a === v.id || e.b === v.id));
      for (const e of cut) {
        t.edges.splice(t.edges.indexOf(e), 1);
      }
      t.edges.push({ ...cut[0], id: cut[0].id, a: v.id, b: twin.id, lengthM: 2000 });
    }],
    ['no-objectives', (t) => {
      t.objectiveNodes = [];
    }],
    ['objectives-unreachable', (t) => {
      t.objectiveNodes = [t.nodes.length];
      t.nodes.push({ ...t.nodes[0], id: t.nodes.length, name: 'Perdu' });
      const donor = t.edges.find((e) => e.moveClass !== 'rail')!;
      t.edges.push({ ...donor, id: donor.id + 1000, a: t.nodes.length - 1, b: t.nodes.length - 1, lengthM: 2000 });
    }],
    ['crossing-starved', (t) => {
      for (const n of t.nodes) if (n.crossing?.riverId === 0) n.crossing = null;
    }],
    ['crossing-flooded', (t) => {
      for (const n of t.nodes) if (!n.crossing) n.crossing = { riverId: 0, kind: 'bridge' };
    }],
    ['front-degenerate', (t, c) => {
      for (let i = 0; i < c.length; i++) c[i] = 'red';
    }],
    ['region-sliver', (t) => {
      t.regions[0].areaM2 = 100;
    }],
    ['spacing', (t) => {
      const towns = t.nodes.filter((n) => n.kind === 'town');
      towns[1].pos = { x: towns[0].pos.x + 100, y: towns[0].pos.y };
    }],
    ['name-collision', (t) => {
      t.nodes[1].name = t.nodes[0].name;
    }],
    ['short-edge', (t) => {
      const e = t.edges.find((x) => x.moveClass !== 'rail')!;
      e.lengthM = 300;
    }],
  ];

  for (const [reason, corrupt] of CASES) {
    it(`'${reason}' is constructible and detected`, () => {
      const { t, c } = clone();
      corrupt(t, c);
      expect(validateTheater(t, c)).toBe(reason);
    });
  }

  it('validation is pure: same input, same verdict, no rng parameter', () => {
    const { t, c } = clone();
    expect(validateTheater(t, c)).toBeNull();
    expect(validateTheater(t, c)).toBeNull();
    expect(validateTheater.length).toBe(2); // (theater, control) — no rng arg
  });
});

describe('feasible', () => {
  it('accepts the default preset and names offending knobs', () => {
    expect(feasible(CFG)).toEqual({ ok: true });
    const packing = feasible({ ...CFG, townDensity: 6 });
    expect(packing.ok).toBe(false);
    if (!packing.ok) expect(packing.knob).toBe('townDensity');
    const deadline = feasible(CFG, { warDays: 7 });
    expect(deadline.ok).toBe(false);
    if (!deadline.ok) {
      expect(deadline.knob).toBe('warDays');
      expect(deadline.reason).toContain('deadline-infeasible');
    }
  });
});

describe('TheaterGenError', () => {
  it('carries seed, attempts, tally, and the knob in a hand-readable message', () => {
    const err = new TheaterGenError(42, 8, 'crossing-starved', { 'crossing-starved': 6, spacing: 2 }, 'riverDensity');
    expect(err.name).toBe('TheaterGenError');
    expect(err.seed).toBe(42);
    expect(err.message).toContain("last 'crossing-starved'");
    expect(err.message).toContain("'riverDensity' knob");
    expect(err.message).toContain('crossing-starved:6');
  });
});

// Re-recorded 2026-07-28 with GEN_VERSION 2 (spur-source fix: one supply
// source per connected component of own-controlled nodes — a fragment
// severed by red-held crossings gets its own map-edge lifeline, so no force
// starts the war cut off by generation).
const PIN_1 = 413659900;
const PIN_2 = 2784287443;
const PIN_3 = 1138076689;
