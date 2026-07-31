// What covers tiles north of the seed-1 compound? terrain, edges, squares,
// junctions, enclosure pockets — every render-side painter's inputs.
import { generateMap } from '../../src/sim/mapgen';
import { EDGE } from '../../src/sim/map';
import { PatchIndex } from '../../src/render/patches';
import { EnclosureIndex } from '../../src/render/enclos';

const plan = generateMap(1, 320, 240, 'bourg', { interiors: true });
const { map } = plan;
const patches = new PatchIndex(map);
const church = new Uint8Array(map.w * map.h); // no church tiles needed out here
const enc = new EnclosureIndex(map, church);

const x0 = 294, x1 = 314, y0 = 178, y1 = 196;
console.log('terrain/pocket dump (x0=' + x0 + '):');
for (let y = y0; y <= y1; y++) {
  let row = '';
  for (let x = x0; x <= x1; x++) {
    const k = map.terrainKeyAt(x, y);
    const b = map.buildingIdAt(x, y) >= 0;
    const eid = enc.enclosureIdAt(x, y);
    let c = '?';
    if (b) c = '#';
    else if (k === 'grass') c = eid >= 0 ? (enc.enclosures[eid].kind === 'yard' ? 'Y' : enc.enclosures[eid].kind === 'garden' ? 'G' : 'C') : '"';
    else if (k === 'road') c = '.';
    else if (k === 'field') c = 'F';
    else if (k === 'hedge') c = 'H';
    else if (k === 'woods') c = 'T';
    else c = k[0];
    row += c;
  }
  console.log(String(y).padStart(3) + ' ' + row);
}

console.log('\nsquares near:');
for (const s of patches.squares)
  if (s.cx > x0 - 15 && s.cx < x1 + 15 && s.cy > y0 - 15 && s.cy < y1 + 15)
    console.log(JSON.stringify(s));
console.log('junctions near:');
for (const j of patches.junctions)
  if (j.x > x0 - 15 && j.x < x1 + 15 && j.y > y0 - 15 && j.y < y1 + 15)
    console.log(JSON.stringify(j));

console.log('\nenclosures overlapping region:');
enc.enclosures.forEach((e, i) => {
  if (e.maxX >= x0 && e.minX <= x1 && e.maxY >= y0 && e.minY <= y1)
    console.log(i, JSON.stringify(e));
});

console.log('\nedges y178-186 (W=wall w/top, D=door):');
for (let y = y0; y <= 186; y++)
  for (let x = x0; x <= x1; x++) {
    const vn = map.vEdge(x, y);
    const hn = map.hEdge(x, y);
    if (vn !== EDGE.NONE) console.log(`v(${x},${y}) e=${vn} top=${map.vEdgeTops[y * (map.w + 1) + x]}`);
    if (hn !== EDGE.NONE) console.log(`h(${x},${y}) e=${hn} top=${map.hEdgeTops[y * map.w + x]}`);
  }

console.log('\nwall runs near (from EnclosureIndex):');
for (const r of [...enc.runs, ...enc.gates])
  if (Math.max(r.ax, r.bx) >= x0 && Math.min(r.ax, r.bx) <= x1 && Math.max(r.ay, r.by) >= y0 && Math.min(r.ay, r.by) <= y1)
    console.log(JSON.stringify(r));
