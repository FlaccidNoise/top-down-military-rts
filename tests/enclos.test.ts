import { describe, expect, it } from 'vitest';
import { EDGE } from '../src/sim/map';
import { generateMap } from '../src/sim/mapgen';
import { EnclosureIndex } from '../src/render/enclos';
import { shopfrontsFor } from '../src/render/shops';

// T18/T20/T21 are additive dressing keyed on data only the bourg emits: edge
// tops and building roles. The load-bearing property is therefore not what
// they draw but that they draw NOTHING anywhere else — every 'town' art
// baseline in scripts/sweep.mjs depends on it, and a re-snapshotted baseline
// is a regression nothing downstream would ever flag.

const LEGACY = ['town', 'road', 'bridge', 'river', 'open'] as const;
const BOURG_SEEDS = [10, 11, 12];
const empty = new Uint8Array(320 * 240);

describe('EnclosureIndex', () => {
  it('is empty on every legacy kind', () => {
    for (const kind of LEGACY) {
      for (const seed of [1, 3, 7, 11]) {
        const { map, buildings } = generateMap(seed, 320, 240, kind);
        const idx = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
        expect(idx.runs.length).toBe(0);
        expect(idx.gates.length).toBe(0);
        expect(idx.enclosures.length).toBe(0);
        expect(idx.any).toBe(false);
        expect(shopfrontsFor(map, buildings).length).toBe(0);
      }
    }
  }, 20_000);

  it('claims exactly the free-standing wall and gate edges, and no house wall', () => {
    for (const seed of BOURG_SEEDS) {
      const { map } = generateMap(seed, 320, 240, 'bourg');
      const idx = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
      const built = (x: number, y: number) => map.buildingIdAt(x, y) >= 0;
      let owned = 0;
      for (let y = 0; y <= map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          const e = map.hEdge(x, y);
          const top = map.hEdgeTop(x, y);
          const free = !built(x, y - 1) && !built(x, y);
          const wall = e === EDGE.WALL && free && (top === 1 || top === 2);
          if (wall) expect(idx.ownsH(x, y)).toBe(true);
          // a wall a building owns is never ours, whatever its top says
          if (e === EDGE.WALL && !free) expect(idx.ownsH(x, y)).toBe(false);
          if (e === EDGE.NONE) expect(idx.ownsH(x, y)).toBe(false);
          if (idx.ownsH(x, y)) {
            owned++;
            expect(free).toBe(true);
            expect(e === EDGE.WALL || e === EDGE.DOOR).toBe(true);
          }
        }
      }
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x <= map.w; x++) {
          const e = map.vEdge(x, y);
          const free = !built(x - 1, y) && !built(x, y);
          if (e === EDGE.WALL && free && (map.vEdgeTop(x, y) === 1 || map.vEdgeTop(x, y) === 2)) expect(idx.ownsV(x, y)).toBe(true);
          if (e === EDGE.WALL && !free) expect(idx.ownsV(x, y)).toBe(false);
          if (idx.ownsV(x, y)) owned++;
        }
      }
      expect(owned).toBeGreaterThan(200);
      expect(idx.runs.some((r) => r.top === 2)).toBe(true);
      expect(idx.gates.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it('finds at most one churchyard and several walled yards per bourg', () => {
    let churchyards = 0;
    for (const seed of BOURG_SEEDS) {
      const { map, buildings } = generateMap(seed, 320, 240, 'bourg');
      const church = new Uint8Array(map.w * map.h);
      for (const b of buildings) {
        if (b.role !== 'church' && b.role !== 'church_tower' && b.role !== 'church_apse') continue;
        for (const p of b.parts ?? [b]) for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) church[y * map.w + x] = 1;
      }
      const idx = new EnclosureIndex(map, church);
      // The churchyard is one pocket or none — none when the generator's
      // enclos wall does not close (the church fronts straight onto a lane on
      // some seeds), never two, which would mean the flood leaked.
      const n = idx.enclosures.filter((e) => e.kind === 'churchyard').length;
      expect(n).toBeLessThanOrEqual(1);
      churchyards += n;
      expect(idx.enclosures.filter((e) => e.kind === 'yard').length).toBeGreaterThan(0);
      // A yard is beaten earth over its whole area, so a block interior
      // misfiled as one is a mud lake behind the terrace.
      for (const e of idx.enclosures) {
        if (e.kind !== 'yard') continue;
        expect(Math.max(e.maxX - e.minX, e.maxY - e.minY)).toBeLessThanOrEqual(14);
      }
      // no pocket may claim a tile a building stands on, or the graves and the
      // beds get planted through a wall
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) if (idx.enclosureIdAt(x, y) >= 0) expect(map.buildingIdAt(x, y)).toBe(-1);
    }
    expect(churchyards).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('is byte-identical across two constructions of the same map', () => {
    const { map } = generateMap(10, 320, 240, 'bourg');
    const a = new EnclosureIndex(map, empty);
    const b = new EnclosureIndex(map, empty);
    expect(a.hFree).toEqual(b.hFree);
    expect(a.vFree).toEqual(b.vFree);
    expect(a.runs).toEqual(b.runs);
    expect(a.gates).toEqual(b.gates);
    expect(a.enclosures).toEqual(b.enclosures);
  });

  // D9. The renderer must never keep a second opinion about where the wall is:
  // after the sim breaches an edge, an index that has been refreshed in place
  // has to agree with one built fresh from the mutated map, or the old wall
  // keeps drawing over the hole the player just made.
  describe('refresh after a breach', () => {
    const staged = () => {
      const { map } = generateMap(10, 320, 240, 'bourg');
      const idx = new EnclosureIndex(map, empty);
      return { map, idx };
    };

    // Middles of the longest free-standing runs — a breach at a run END only
    // shortens it, which is the easy case; a breach in the MIDDLE splits it.
    const midpoints = (idx: EnclosureIndex, n: number): { horiz: boolean; x: number; y: number }[] => {
      const out: { horiz: boolean; x: number; y: number }[] = [];
      const byLen = [...idx.runs].sort((a, b) => Math.abs(b.bx - b.ax) + Math.abs(b.by - b.ay) - (Math.abs(a.bx - a.ax) + Math.abs(a.by - a.ay)));
      for (const r of byLen) {
        const horiz = r.ay === r.by;
        const len = horiz ? r.bx - r.ax : r.by - r.ay;
        if (len < 4) continue;
        out.push(horiz ? { horiz, x: r.ax + (len >> 1), y: r.ay } : { horiz, x: r.ax, y: r.ay + (len >> 1) });
        if (out.length === n) break;
      }
      return out;
    };

    it('matches a full rebuild of the mutated map, run for run', () => {
      const { map, idx } = staged();
      const cuts = midpoints(idx, 6);
      expect(cuts.length).toBe(6);
      for (const c of cuts) {
        if (c.horiz) map.hEdges[c.y * map.w + c.x] = EDGE.BREACH;
        else map.vEdges[c.y * (map.w + 1) + c.x] = EDGE.BREACH;
      }
      idx.refresh();
      const fresh = new EnclosureIndex(map, empty);
      expect(idx.hFree).toEqual(fresh.hFree);
      expect(idx.vFree).toEqual(fresh.vFree);
      expect(idx.runs).toEqual(fresh.runs);
      expect(idx.gates).toEqual(fresh.gates);
    });

    it('splits the breached run in two and stops owning the gap', () => {
      const { map, idx } = staged();
      const [c] = midpoints(idx, 1);
      const before = idx.runs.length;
      if (c.horiz) map.hEdges[c.y * map.w + c.x] = EDGE.BREACH;
      else map.vEdges[c.y * (map.w + 1) + c.x] = EDGE.BREACH;
      idx.refresh();
      expect(idx.runs.length).toBe(before + 1);
      expect(c.horiz ? idx.ownsH(c.x, c.y) : idx.ownsV(c.x, c.y)).toBe(false);
    });

    it('reports a box that contains the whole re-phased run, not just the hole', () => {
      const { map, idx } = staged();
      const [c] = midpoints(idx, 1);
      const run = idx.runs.find((r) =>
        c.horiz ? r.ay === c.y && r.ax <= c.x && r.bx > c.x : r.ax === c.x && r.ay <= c.y && r.by > c.y,
      )!;
      if (c.horiz) map.hEdges[c.y * map.w + c.x] = EDGE.BREACH;
      else map.vEdges[c.y * (map.w + 1) + c.x] = EDGE.BREACH;
      const box = idx.refresh()!;
      expect(box).not.toBeNull();
      expect(box[0]).toBeLessThanOrEqual(Math.min(run.ax, run.bx));
      expect(box[1]).toBeLessThanOrEqual(Math.min(run.ay, run.by));
      expect(box[2]).toBeGreaterThanOrEqual(Math.max(run.ax, run.bx));
      expect(box[3]).toBeGreaterThanOrEqual(Math.max(run.ay, run.by));
    });

    it('reports nothing when the breached edge was never ours', () => {
      const { map, idx } = staged();
      // a house wall: masonry with a building on it, which the index does not own
      let hit = false;
      for (let y = 1; y < map.h && !hit; y++) {
        for (let x = 1; x < map.w; x++) {
          if (map.hEdge(x, y) !== EDGE.WALL || map.buildingIdAt(x, y) < 0) continue;
          map.hEdges[y * map.w + x] = EDGE.BREACH;
          hit = true;
          break;
        }
      }
      expect(hit).toBe(true);
      expect(idx.refresh()).toBeNull();
    });

    // Pockets are NOT re-flooded: the ground dressing must not change under the
    // player because somebody put a hole in the garden wall.
    it('leaves the pocket dressing exactly where it was', () => {
      const { map, idx } = staged();
      const before = Int32Array.from(idx.enclosureAt);
      const kinds = idx.enclosures.map((e) => e.kind).join(',');
      for (const c of midpoints(idx, 4)) {
        if (c.horiz) map.hEdges[c.y * map.w + c.x] = EDGE.BREACH;
        else map.vEdges[c.y * (map.w + 1) + c.x] = EDGE.BREACH;
      }
      idx.refresh();
      expect(idx.enclosureAt).toEqual(before);
      expect(idx.enclosures.map((e) => e.kind).join(',')).toBe(kinds);
    });
  });
});

describe('shopfrontsFor', () => {
  it('puts every frontage line outside its shop, on the frontage side', () => {
    for (const seed of BOURG_SEEDS) {
      const { map, buildings } = generateMap(seed, 320, 240, 'bourg');
      const fronts = shopfrontsFor(map, buildings);
      const shops = buildings.filter((b) => b.role === 'shop' && b.frontage);
      expect(fronts.length).toBeGreaterThan(0);
      expect(fronts.length).toBeLessThanOrEqual(shops.length);
      for (const f of fronts) {
        // the outward normal is a unit axis vector and the line is flat
        expect(Math.abs(f.nx) + Math.abs(f.ny)).toBe(1);
        expect(f.ax === f.bx || f.ay === f.by).toBe(true);
        // the line sits outside every footprint, so an awning never lands on a
        // neighbour's roof
        const mx = (f.ax + f.bx) / 2;
        const my = (f.ay + f.by) / 2;
        expect(map.buildingIdAt(Math.floor(mx + f.nx * 0.2), Math.floor(my + f.ny * 0.2))).toBe(-1);
      }
    }
  }, 20_000);
});
