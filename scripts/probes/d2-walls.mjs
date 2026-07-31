// D2 wall-stub categorizer — at stamped-map level, flood components of the
// free-standing wall graph (WALL_LOW/WALL_HIGH edges + gate DOORs as graph
// edges over grid vertices) and report components that are SMALL (<8 edges)
// and NOT a closed loop (every vertex degree 2). Those are the visible
// 'orphan wall stubs' at 24-48 px/m.
//
//   npx vite-node scripts/probes/d2-walls.mjs
import { mulberry32 } from '../../src/sim/rng';
import { planBourg, stampBourg } from '../../src/sim/bourg/plan';
import { PROFILES } from '../../src/sim/bourg/profile';
import { GameMap, EDGE } from '../../src/sim/map';

const KINDS = ['open', 'road', 'woods', 'river', 'bridge', 'bourg'];
const W = 320;
const H = 240;

for (const kind of KINDS) {
  let comps = 0, stubs = 0, gates = 0;
  const hist = {};
  for (let seed = 1; seed <= 13; seed++) {
    const base = mulberry32((seed ^ 0x51ab3fc7) >>> 0).int(0x7fffffff);
    const plan = planBourg(base, W, H, PROFILES[kind], new Uint8Array(W * H));
    const map = new GameMap(W, H);
    stampBourg(map, plan);

    // collect graph edges: [vx1, vy1, vx2, vy2]
    const ourT = (t) => t === 1 || t === 2; // WALL_LOW / WALL_HIGH tops
    const edges = [];
    for (let y = 0; y <= H; y++)
      for (let x = 0; x < W; x++) {
        const e = map.hEdge(x, y);
        if (e === EDGE.DOOR || (e === EDGE.WALL && ourT(map.hEdgeTops[y * W + x]))) edges.push([x, y, x + 1, y]);
      }
    for (let y = 0; y < H; y++)
      for (let x = 0; x <= W; x++) {
        const e = map.vEdge(x, y);
        if (e === EDGE.DOOR || (e === EDGE.WALL && ourT(map.vEdgeTops[y * (W + 1) + x]))) edges.push([x, y, x, y + 1]);
      }

    // union-find over vertices
    const vid = (x, y) => y * (W + 1) + x;
    const parent = new Int32Array((W + 1) * (H + 1));
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const deg = new Int32Array((W + 1) * (H + 1));
    for (const [x1, y1, x2, y2] of edges) {
      const a = find(vid(x1, y1)), b = find(vid(x2, y2));
      if (a !== b) parent[a] = b;
      deg[vid(x1, y1)]++;
      deg[vid(x2, y2)]++;
    }
    // component stats
    const compEdges = new Map();
    for (const [x1, y1, x2, y2] of edges) {
      const r = find(vid(x1, y1));
      compEdges.set(r, (compEdges.get(r) || 0) + 1);
    }
    const compOpen = new Map(); // count of odd-degree (non-2) vertices per comp
    for (let i = 0; i < deg.length; i++) {
      if (deg[i] === 0) continue;
      const r = find(i);
      if (deg[i] !== 2) compOpen.set(r, (compOpen.get(r) || 0) + 1);
    }
    for (const [r, n] of compEdges) {
      comps++;
      const open = compOpen.get(r) || 0;
      if (n < 8 && open > 0) {
        // legitimate if any vertex touches a building floor tile or map edge
        // (mirrors cleanWallFragments' vTerm): those are gates on building
        // walls and butt-joints, not debris.
        let anchored = false;
        for (const [x1, y1, x2, y2] of edges) {
          if (find(vid(x1, y1)) !== r) continue;
          for (const [vx, vy] of [[x1, y1], [x2, y2]]) {
            if (vx <= 0 || vx >= W || vy <= 0 || vy >= H) { anchored = true; break; }
            const b = map.buildingId;
            if (b[(vy - 1) * W + (vx - 1)] >= 0 || b[(vy - 1) * W + vx] >= 0 ||
                b[vy * W + (vx - 1)] >= 0 || b[vy * W + vx] >= 0) { anchored = true; break; }
          }
          if (anchored) break;
        }
        if (!anchored) {
          stubs++;
          hist[n] = (hist[n] || 0) + 1;
        }
      }
    }
  }
  console.log(`${kind.padEnd(7)} comps=${String(comps).padStart(5)}  stubs(<8,open)=${String(stubs).padStart(4)}  sizes=${JSON.stringify(hist)}`);
}
