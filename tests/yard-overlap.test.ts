import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/mapgen';
import type { MapKind } from '../src/sim/mapgen';
import { EnclosureIndex } from '../src/render/enclos';
import { PatchIndex } from '../src/render/patches';
import { buildYards, type Seg } from '../src/render/yards';

// Outdoor boundary coherence: no stone wall or fence segment may intersect or
// share the same tile as another — neither a generator enclosure wall nor a
// neighbouring yard's run. Crossing fences read as a generation bug at close
// zoom (owner report, 2026-07-28). buildYards drops any run that conflicts
// with an already-standing boundary (enclosure walls first, then each
// accepted yard), so the whole map satisfies this by construction.

function segConflict(a: Seg, b: Seg): boolean {
  const [ax, ay, bx, by] = a;
  const [cx, cy, dx, dy] = b;
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = dx - cx;
  const d2y = dy - cy;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) > 1e-9) {
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  }
  if (Math.abs((cx - ax) * d1y - (cy - ay) * d1x) > 1e-6) return false;
  const len2 = d1x * d1x + d1y * d1y;
  if (len2 < 1e-12) return false;
  const t0 = ((cx - ax) * d1x + (cy - ay) * d1y) / len2;
  const t1 = ((dx - ax) * d1x + (dy - ay) * d1y) / len2;
  return Math.min(1, Math.max(t0, t1)) > Math.max(0, Math.min(t0, t1)) + 1e-6;
}

const KINDS: MapKind[] = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'];

describe('outdoor wall/fence coherence', () => {
  it('no yard run crosses or overlaps an enclosure wall or another yard run', () => {
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 5; seed++) {
        const plan = generateMap(seed, 320, 240, kind, { interiors: true });
        const { map } = plan;
        const patches = new PatchIndex(map);
        const enc = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
        const encKind = (wx: number, wy: number) => {
          const id = enc.enclosureIdAt(Math.floor(wx), Math.floor(wy));
          return id >= 0 ? enc.enclosures[id].kind : null;
        };
        const blockers: Seg[] = enc.runs.map((r) => [r.ax, r.ay, r.bx, r.by]);
        const yards = buildYards(map, patches, encKind, blockers);
        const all: Seg[] = [...blockers];
        for (const yd of yards) {
          for (const r of yd.runs) {
            for (const a of all)
              expect(segConflict(r, a), `${kind} seed ${seed} yard@${yd.b.id} run ${r} conflicts with ${a}`).toBe(false);
            all.push(r);
          }
        }
      }
    }
  }, 120_000);

  it('gate piers only stand where a surviving run reaches them', () => {
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 5; seed++) {
        const plan = generateMap(seed, 320, 240, kind, { interiors: true });
        const { map } = plan;
        const patches = new PatchIndex(map);
        const enc = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
        const encKind = (wx: number, wy: number) => {
          const id = enc.enclosureIdAt(Math.floor(wx), Math.floor(wy));
          return id >= 0 ? enc.enclosures[id].kind : null;
        };
        const yards = buildYards(map, patches, encKind, enc.runs.map((r) => [r.ax, r.ay, r.bx, r.by] as Seg));
        for (const yd of yards) {
          if (yd.runs.length === 0) {
            expect(yd.gate, `${kind} seed ${seed} yard@${yd.b.id} gate without any run`).toHaveLength(0);
            continue;
          }
          // a yard with no gate posts never hangs a leaf
          if (yd.gate.length < 2) expect(yd.leaf).toBeNull();
        }
      }
    }
  }, 120_000);

  it('every yard run terminates at a building, another run, a gate pier, or an enclosure wall — no floating stubs', () => {
    // The 2026-07-31 orphan rule, recomputed independently: at BOTH ends a
    // run must touch (<=0.45 m) its building's rect, a gate pier, or any
    // other boundary segment (enclosure blocker or another yard's run).
    // legalise truncation and first-writer-wins conflict dropping otherwise
    // leave lone segments floating mid-lawn — the white stubs at 24-48 px/m.
    const ptSeg = (x: number, y: number, [ax, ay, bx, by]: Seg): number => {
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1e-12) return Infinity;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
      return Math.hypot(ax + t * vx - x, ay + t * vy - y);
    };
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 5; seed++) {
        const plan = generateMap(seed, 320, 240, kind, { interiors: true });
        const { map } = plan;
        const patches = new PatchIndex(map);
        const enc = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
        const encKind = (wx: number, wy: number) => {
          const id = enc.enclosureIdAt(Math.floor(wx), Math.floor(wy));
          return id >= 0 ? enc.enclosures[id].kind : null;
        };
        const blockers: Seg[] = enc.runs.map((r) => [r.ax, r.ay, r.bx, r.by]);
        const yards = buildYards(map, patches, encKind, blockers);
        const others = yards.flatMap((y) => y.runs);
        for (const yd of yards)
          for (const r of yd.runs)
            for (const [x, y] of [[r[0], r[1]], [r[2], r[3]]] as [number, number][]) {
              const dx = Math.max(yd.b.minX - x, 0, x - yd.b.maxX);
              const dy = Math.max(yd.b.minY - y, 0, y - yd.b.maxY);
              const anchored =
                Math.hypot(dx, dy) <= 0.45 ||
                yd.gate.some(([gx, gy]) => Math.hypot(gx - x, gy - y) <= 0.45) ||
                [...blockers, ...others].some((s) => s !== r && ptSeg(x, y, s) <= 0.45);
              expect(anchored, `${kind} seed ${seed} yard@${yd.b.id} run ${r} end ${x},${y} floats`).toBe(true);
            }
      }
    }
  }, 120_000);
});
