import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { DEPLOY_EDGE_INSET, resolveDeployment } from '../src/sim/spots';
import { Sim, stanceOf, type Side } from '../src/sim/sim';

// Deployment placement (deployPlace/previewDeploy both consume this): staged
// maps, no generated content, so every assertion is exact. The battle-side
// contract (warp + orderState) lives in main.ts and is exercised by
// scripts/tutorial.mjs; THIS suite pins the resolver the two callers share.

function addSquadOf(sim: Sim, side: Side, n: number, x: number, y: number): number {
  const weapon = side === 'blue' ? ('garand' as const) : ('kar98k' as const);
  const members = Array.from({ length: n }, (_, i) => ({ name: `S${i}`, weapon, x, y: y + i * 0.1 }));
  return sim.addSquad(side, `${side}-sq`, members).id;
}

const ZONE = { x0: 0, x1: 32 };

describe('resolveDeployment', () => {
  it('deploys into cover behind a hedge, and lies down there', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const HX = 20;
    for (let y = 0; y < 24; y++) sim.map.setTerrain(HX, y, 'hedge');
    const sq = addSquadOf(sim, 'blue', 3, 10.5, 12.5);
    const [plan] = resolveDeployment(sim, [sq], HX - 2, 12.5, ZONE, 0); // enemy east
    // A hedge scores the same prone or crouched, so the older rule ("does
    // prone beat crouch") left this team standing. Anything real between the
    // men and the enemy is now reason enough to get down.
    expect(plan.kind).toBe('ambush');
    expect(plan.spots.length).toBe(3);
    // nobody stands IN the hedge; everyone west of it
    for (const sp of plan.spots) expect(sp.x).toBeLessThan(HX);
    expect(plan.spots.some((sp) => sp.covered)).toBe(true);
  });

  it('goes prone behind a bank: the ambush upgrade fires where only lying down pays', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const BX = 20;
    for (let y = 0; y < 24; y++) sim.map.setTerrain(BX, y, 'bank');
    const sq = addSquadOf(sim, 'blue', 3, 10.5, 12.5);
    const [plan] = resolveDeployment(sim, [sq], BX - 2, 12.5, ZONE, 0);
    expect(plan.kind).toBe('ambush');
    expect(plan.spots.some((sp) => sp.covered)).toBe(true);
    for (const sp of plan.spots) expect(sp.x).toBeLessThan(BX);
  });

  it('goes prone behind a HILL: a 1 m crest toward the enemy is the reverse slope', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const CX = 20; // a N-S ridge one metre above the ground the men hold
    for (let y = 0; y < 24; y++) sim.map.elev[y * 48 + CX] = 1;
    const sq = addSquadOf(sim, 'blue', 3, 10.5, 12.5);
    const [plan] = resolveDeployment(sim, [sq], CX - 2, 12.5, ZONE, 0); // enemy east, ridge between
    expect(plan.kind).toBe('ambush');
    // and the same ground with the enemy the other way is NOT a reverse slope
    const [away] = resolveDeployment(sim, [sq], CX - 2, 12.5, ZONE, Math.PI);
    expect(away.kind).toBe('defend');
  });

  it('stays flat on open ground: no cover anywhere means defend, uncovered, on the slots', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const sq = addSquadOf(sim, 'blue', 3, 10.5, 12.5);
    const [plan] = resolveDeployment(sim, [sq], 16, 12.5, ZONE, 0);
    expect(plan.kind).toBe('defend');
    expect(plan.spots.every((sp) => !sp.covered)).toBe(true);
  });

  it('clamps anchors DEPLOY_EDGE_INSET inside the zone so every tile stays in-zone', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const sq = addSquadOf(sim, 'blue', 6, 4.5, 12.5);
    // click hard against the zone's west edge — the resolver may snap ±5 tiles
    const [plan] = resolveDeployment(sim, [sq], 0.2, 12.5, ZONE, 0);
    expect(plan.x).toBe(ZONE.x0 + DEPLOY_EDGE_INSET);
    for (const sp of plan.spots) {
      expect(sp.x).toBeGreaterThanOrEqual(ZONE.x0);
      expect(sp.x).toBeLessThanOrEqual(ZONE.x1);
    }
  });

  it('never stacks two men on one tile across squads — one used set for the whole placement', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const a = addSquadOf(sim, 'blue', 5, 10.5, 12.5);
    const b = addSquadOf(sim, 'blue', 5, 10.5, 12.5);
    const plans = resolveDeployment(sim, [a, b], 16, 12.5, ZONE, 0);
    const tiles = plans.flatMap((p) => p.spots.map((sp) => `${sp.x},${sp.y}`));
    expect(new Set(tiles).size).toBe(tiles.length);
    expect(tiles.length).toBe(10);
  });

  it('is deterministic: the same call resolves the same placement', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const HX = 20;
    for (let y = 0; y < 24; y++) sim.map.setTerrain(HX, y, 'hedge');
    const sq = addSquadOf(sim, 'blue', 4, 10.5, 12.5);
    const one = resolveDeployment(sim, [sq], HX - 2, 12.5, ZONE, 0);
    const two = resolveDeployment(sim, [sq], HX - 2, 12.5, ZONE, 0);
    expect(two).toEqual(one);
  });

  // The whole point of the feature is the POSE the player sees. resolveDeployment
  // only chooses the order; stance is derived from it (stanceOf), so this walks
  // the last link: place, write the order the way deployPlace does, read the
  // stance the renderer will read. The original report was "they just are all
  // standing in a grid" — that is this assertion.
  it('the placement produces the pose: deployed men are prone behind cover, crouched without it', () => {
    const cover = new Sim(new GameMap(48, 24), 7);
    for (let y = 0; y < 24; y++) cover.map.setTerrain(20, y, 'hedge');
    const bare = new Sim(new GameMap(48, 24), 7);
    for (const [sim, want] of [[cover, 'prone'], [bare, 'crouch']] as const) {
      const sq = addSquadOf(sim, 'blue', 3, 10.5, 12.5);
      for (const p of resolveDeployment(sim, [sq], 18, 12.5, ZONE, 0)) {
        for (const sp of p.spots) {
          const s = sim.soldiers[sp.sid];
          s.x = sp.x + 0.5;
          s.y = sp.y + 0.5;
          s.path = null;
        }
        sim.teams[p.teamId].orderState = { order: { kind: p.kind, x: p.x, y: p.y, arc: p.arc, l: p.level }, phase: 'executing', reason: '' };
        for (const sp of p.spots) expect(stanceOf(sim, sim.soldiers[sp.sid])).toBe(want);
      }
    }
  });

  // The contract is the MIDPOINT (it is what threatBearing reads, so it is what
  // aims the cover) and a forward hemisphere (the arc also gates the ambush
  // trigger — narrower and a flanked team stands there ignoring the man walking
  // up on it). Asserted as properties, not as a copy of the constant, so
  // retuning the half-angle does not need this test edited to stay honest.
  it('faces the deployment at the enemy, over the forward hemisphere', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const sq = addSquadOf(sim, 'blue', 2, 10.5, 12.5);
    for (const bearing of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const [plan] = resolveDeployment(sim, [sq], 16, 12.5, ZONE, bearing);
      const mid = (plan.arc[0] + plan.arc[1]) / 2;
      expect(Math.cos(mid - bearing)).toBeCloseTo(1, 6); // midpoint IS the bearing
      expect(plan.arc[1] - plan.arc[0]).toBeGreaterThanOrEqual(Math.PI); // at least a hemisphere
    }
  });
});
