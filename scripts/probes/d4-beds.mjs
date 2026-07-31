// D4 probe: for every enclosure pocket, replay gardenInto's placement logic
// and count how many beds actually land. Reports pockets-by-kind, beds
// placed, and zero-bed pockets by size bucket. Answers: are the bare lawns
// failed gardens, or unenclosed grass?
import { generateMap } from '../../src/sim/mapgen';
import { EnclosureIndex } from '../../src/render/enclos';

const KINDS = ['bourg', 'road', 'open', 'woods', 'river', 'bridge'];
for (const kind of KINDS) {
  const agg = {};
  for (let seed = 1; seed <= 6; seed++) {
    const { map } = generateMap(seed, 320, 240, kind, { interiors: true });
    const idx = new EnclosureIndex(map, new Uint8Array(map.w * map.h));
    for (const e of idx.enclosures) {
      const a = (agg[e.kind] ||= { n: 0, tiles: 0, beds: 0, zero: 0, zeroBig: 0 });
      a.n++;
      a.tiles += e.tiles;
      // replay gardenInto's placement: beds = clamp(1..4, tiles/26), 10 tries
      // of clearAt at 5 points with pad 0. clearAt is module-private; the
      // placement test it runs is 'free ground inside this pocket, clear of
      // any building by pad' — replicate: tile inside this pocket's set,
      // terrain grass/field, no buildingId, not paved.
      const inside = (x, y) => {
        const tx = Math.floor(x), ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return false;
        if (idx.enclosureAt[ty * map.w + tx] !== idx.enclosures.indexOf(e)) return false;
        const k = map.terrainKeyAt(tx, ty);
        if (k !== 'grass' && k !== 'field') return false;
        return map.buildingIdAt(tx, ty) < 0;
      };
      const beds = Math.max(1, Math.min(4, Math.floor(e.tiles / 26)));
      const wide = e.maxX - e.minX >= e.maxY - e.minY;
      const bw = wide ? 2.5 : 1.4;
      const bh = wide ? 1.4 : 2.5;
      let placed = 0;
      for (let i = 0; i < beds; i++) {
        // NOTE: probe uses a simplified site pick (centre-ish), NOT the exact
        // hash sequence — it answers 'is there room for a bed at all', not
        // 'did the exact draw land'. Good enough for the 0-bed question.
        let ok = false;
        outer: for (let gy = 0; gy < 5 && !ok; gy++)
          for (let gx = 0; gx < 5 && !ok; gx++) {
            const cx = e.minX + 1 + ((gx + 0.5) / 5) * Math.max(0.001, e.maxX - e.minX - 2);
            const cy = e.minY + 1 + ((gy + 0.5) / 5) * Math.max(0.001, e.maxY - e.minY - 2);
            for (const [px, py] of [[-bw / 2, -bh / 2], [bw / 2, -bh / 2], [-bw / 2, bh / 2], [bw / 2, bh / 2], [0, 0]])
              if (!inside(cx + px, cy + py)) continue outer;
            ok = true;
          }
        if (ok) placed++;
      }
      a.beds += placed;
      if (placed === 0) {
        a.zero++;
        if (e.tiles >= 26) {
          a.zeroBig++;
          console.log(`  zero-big ${kind} seed ${seed} kind=${e.kind} tiles=${e.tiles} bbox x${e.minX}-${e.maxX} y${e.minY}-${e.maxY}`);
        }
      }
    }
  }
  console.log(kind.padEnd(7), JSON.stringify(agg));
}
