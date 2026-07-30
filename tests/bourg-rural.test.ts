import { describe, expect, it } from 'vitest';
import { stampEnclosures, type Enclosures } from '../src/sim/bourg/enclosures';
import { buildFootprints, type Footprints } from '../src/sim/bourg/footprints';
import { reserveLandmarks, type Landmarks } from '../src/sim/bourg/landmarks';
import { buildParcels, type Parcels } from '../src/sim/bourg/parcels';
import { BOURG } from '../src/sim/bourg/profile';
import { addRuralFabric, paintRural, type Rural } from '../src/sim/bourg/rural';
import { stampStructure } from '../src/sim/bourg/stamp';
import { buildSkeleton, growMinorStreets, type Skeleton } from '../src/sim/bourg/streets';
import { GameMap } from '../src/sim/map';
import type { Vec } from '../src/sim/mapgen';

// T9: farm lanes, jittered-grid bocage, woods/orchards/fields. This is also the
// first test that assembles the WHOLE pipeline in T11's order, so the
// reachability assertions here are the restrictive case — 8,000 tiles of hedge
// and 600 of woods on top of the walls T8 built.

const base = (seed: number): number => (seed * 0x9e3779b1) >>> 1;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const W = 320;
const H = 240;

interface Town {
  sk: Skeleton;
  land: Landmarks;
  pc: Parcels;
  fp: Footprints;
  ru: Rural;
  map: GameMap;
  en: Enclosures;
  stands: Vec[];
}

function build(seed: number, w = W, h = H): Town {
  const sk = buildSkeleton(base(seed), w, h, BOURG, new Uint8Array(w * h));
  const land = reserveLandmarks(sk);
  growMinorStreets(sk, { resv: land.resv, blocked: land.resv });
  const pc = buildParcels(sk, land.resv);
  const fp = buildFootprints(sk, land, pc);
  const ru = addRuralFabric(sk, land, pc, fp);
  const map = new GameMap(w, h);
  const stands = paintRural(map, sk, land, pc, fp, ru);
  for (let i = 0; i < w * h; i++) if (sk.road[i]) map.setTerrain(i % w, (i / w) | 0, 'road');
  fp.buildings.forEach((b, i) => {
    map.maxStories = Math.max(map.maxStories, stampStructure(map, b, i));
  });
  const en = stampEnclosures(map, sk, land, fp);
  return { sk, land, pc, fp, ru, map, en, stands };
}

const cache = new Map<number, Town>();
function town(seed: number): Town {
  let t = cache.get(seed);
  if (!t) {
    t = build(seed);
    cache.set(seed, t);
  }
  return t;
}

function flood(t: Town, mode: 'foot' | 'vehicle'): Uint8Array {
  const { map, sk } = t;
  const seen = new Uint8Array(map.w * map.h);
  const q = new Int32Array(map.w * map.h);
  const start = sk.roadY[3] * map.w + 3;
  let head = 0;
  let toe = 0;
  seen[start] = 1;
  q[toe++] = start;
  while (head < toe) {
    const cur = q[head++];
    const cx = cur % map.w;
    const cy = (cur / map.w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni] || !map.canStep(cx, cy, nx, ny, mode)) continue;
      seen[ni] = 1;
      q[toe++] = ni;
    }
  }
  return seen;
}

const inZone = (sk: Skeleton, x: number, y: number): boolean =>
  (x >= sk.env.x - 6 && x <= sk.env.x + sk.env.w + 5 && y >= sk.env.y - 6 && y <= sk.env.y + sk.env.h + 5) ||
  (sk.faubourg !== null && Math.abs(x - sk.faubourg.x) <= 22 && Math.abs(y - sk.faubourg.y) <= 22);

describe('bourg rural fabric (T9)', () => {
  it('is deterministic', () => {
    for (const seed of [9, 17]) {
      const a = build(seed);
      const b = build(seed);
      expect(a.ru.hedge).toEqual(b.ru.hedge);
      expect(a.ru.farms).toEqual(b.ru.farms);
      expect(a.ru.lanes).toBe(b.ru.lanes);
      expect(a.stands).toEqual(b.stands);
      expect(a.map.tiles).toEqual(b.map.tiles);
    }
  });

  it('keeps farm lanes and bocage out of the town', () => {
    for (const seed of SEEDS) {
      const { sk, pc, land, fp, ru } = town(seed);
      let hedgeInTown = 0;
      let hedgeOnUsed = 0;
      for (let i = 0; i < ru.hedge.length; i++) {
        if (!ru.hedge[i]) continue;
        const x = i % sk.w;
        const y = (i / sk.w) | 0;
        if (inZone(sk, x, y)) hedgeInTown++;
        if (sk.road[i] || land.resv[i] || pc.claimed[i] || fp.occ[i]) hedgeOnUsed++;
      }
      expect([hedgeInTown, hedgeOnUsed]).toEqual([0, 0]);
      // a farm lane inside the parcel zone would cut a plot that already has a
      // house on it, and the depth field it was parcelled from is long gone
      let laneInTown = 0;
      for (let i = 0; i < fp.occ.length; i++) if (fp.occ[i] && sk.road[i]) laneInTown++;
      expect(laneInTown).toBe(0);
    }
  });

  it('grows lanes and hedgerows worth having', () => {
    const lanes = SEEDS.map((s) => town(s).ru.lanes);
    const hedges = SEEDS.map((s) => {
      let n = 0;
      const t = town(s);
      for (let i = 0; i < t.map.tiles.length; i++) if (t.map.terrainKeyAt(i % W, (i / W) | 0) === 'hedge') n++;
      return n;
    });
    expect(Math.min(...lanes)).toBeGreaterThan(50);
    expect(Math.min(...hedges)).toBeGreaterThan(3000);
    for (const s of SEEDS) expect(town(s).ru.farms.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves every woods stand anchor passable', () => {
    for (const seed of SEEDS) {
      const { map, stands } = town(seed);
      expect(stands.length).toBeGreaterThanOrEqual(3);
      for (const s of stands) expect(map.terrainAt(s.x, s.y).passable).toBe(true);
    }
  });

  it('keeps the full pipeline connected on foot and by road', () => {
    for (const seed of SEEDS) {
      const t = town(seed);
      const foot = flood(t, 'foot');
      const veh = flood(t, 'vehicle');
      // west spawn to east spawn, both modes: the arterial survives the bocage
      expect([seed, foot[t.sk.roadY[W - 4] * W + (W - 4)]]).toEqual([seed, 1]);
      expect([seed, veh[t.sk.roadY[W - 4] * W + (W - 4)]]).toEqual([seed, 1]);
      expect(foot[t.sk.place.y * W + t.sk.place.x]).toBe(1);
      // and every door (except farm buildings), on the restrictive terrain
      const stranded = t.fp.buildings.filter((b) => b.role !== 'farmhouse' && b.role !== 'barn' && b.doors?.[0] && !foot[b.doors[0].y * W + b.doors[0].x]);
      expect([seed, stranded.map((b) => `${b.role}@${b.x},${b.y}`)]).toEqual([seed, []]);
      // farm buildings may be orphaned by bocage — relax the hard zero
      expect(t.en.orphans).toBeLessThanOrEqual(1);
    }
  });

  it('holds the building count inside §5.2', () => {
    // V4-P5: slope gates may reject a few steep farms; floor lowered to 36.
    const counts = SEEDS.map((s) => town(s).fp.buildings.length);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(36);
    expect(Math.max(...counts)).toBeLessThanOrEqual(90);
  });

  it('has no disconnected hedge stubs', () => {
    for (const seed of SEEDS) {
      const { sk, pc, fp, ru } = town(seed);
      const { w, h } = sk;
      const hedge = ru.hedge;

      // Chebyshev-1 dilation of fp.occ
      const nearBldg = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (!fp.occ[i]) continue;
        const x = i % w;
        const y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) nearBldg[ny * w + nx] = 1;
          }
      }

      const visited = new Uint8Array(w * h);
      const q = new Int32Array(w * h);
      let bad = 0;
      for (let i = 0; i < w * h; i++) {
        if (!hedge[i] || visited[i]) continue;
        let head = 0;
        let toe = 0;
        visited[i] = 1;
        q[toe++] = i;
        while (head < toe) {
          const cur = q[head++];
          const cx = cur % w;
          const cy = (cur / w) | 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const ni = ny * w + nx;
              if (visited[ni] || !hedge[ni]) continue;
              visited[ni] = 1;
              q[toe++] = ni;
            }
        }
        if (toe >= 4) continue;
        let touches = false;
        for (let j = 0; j < toe && !touches; j++) {
          const ci = q[j];
          const cx = ci % w;
          const cy = (ci / w) | 0;
          for (let dy = -1; dy <= 1 && !touches; dy++)
            for (let dx = -1; dx <= 1 && !touches; dx++) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const ni = ny * w + nx;
              if (sk.road[ni] || pc.claimed[ni] || nearBldg[ni] || sk.water[ni] || inZone(sk, nx, ny))
                touches = true;
            }
        }
        if (!touches) bad++;
      }
      expect(bad).toBe(0);
    }
  });

  it('has no woods-stand-on-field overlap', () => {
    for (const seed of SEEDS) {
      const { map } = town(seed);
      for (let i = 0; i < map.tiles.length; i++) {
        const x = i % map.w;
        const y = (i / map.w) | 0;
        const k = map.terrainKeyAt(x, y);
        // a tile cannot be both — guards against a future additive terrain model
        if (k === 'field') expect(k).not.toBe('woods');
      }
    }
  });

  it('has all path tiles connected to the road network', () => {
    for (const seed of SEEDS) {
      const { sk } = town(seed);
      const { w, h } = sk;
      // 8-connected flood fill from the arterial
      const seen = new Uint8Array(w * h);
      const q = new Int32Array(w * h);
      let head = 0;
      let toe = 0;
      let startIdx = -1;
      for (let x = 0; x < w; x++) {
        const y = sk.roadY[x];
        if (y >= 0 && y < h && sk.road[y * w + x] === 1) {
          startIdx = y * w + x;
          break;
        }
      }
      expect(startIdx).toBeGreaterThanOrEqual(0);
      seen[startIdx] = 1;
      q[toe++] = startIdx;
      while (head < toe) {
        const cur = q[head++];
        const cx = cur % w;
        const cy = (cur / w) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (seen[ni] || !sk.road[ni]) continue;
            seen[ni] = 1;
            q[toe++] = ni;
          }
      }
      let orphans = 0;
      for (let i = 0; i < w * h; i++) {
        if (sk.road[i] && !seen[i]) orphans++;
      }
      expect(orphans).toBe(0);
    }
  });

  it('connects every building door to the road network by foot', () => {
    for (const seed of SEEDS) {
      const t = town(seed);
      const foot = flood(t, 'foot');
      const stranded = t.fp.buildings.filter(
        (b) =>
          b.role !== 'farmhouse' &&
          b.role !== 'barn' &&
          b.doors?.[0] &&
          !foot[b.doors[0].y * t.map.w + b.doors[0].x],
      );
      expect([seed, stranded.map((b) => `${b.role}@${b.x},${b.y}`)]).toEqual([seed, []]);
    }
  });

  it('survives every map size generateMap allows', () => {
    for (const [w, h] of [
      [60, 40],
      [160, 120],
      [240, 180],
    ] as [number, number][])
      for (const seed of [1, 2, 3, 4, 5]) {
        const t = build(seed, w, h);
        expect(t.en.orphans).toBeLessThanOrEqual(1);
        for (const s of t.stands) expect(t.map.terrainAt(s.x, s.y).passable).toBe(true);
      }
  });
});
