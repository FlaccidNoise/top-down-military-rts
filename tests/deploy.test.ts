import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { DEPLOY_EDGE_INSET, resolveDeployment } from '../src/sim/spots';
import { Sim, type Side } from '../src/sim/sim';

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
  it('deploys into cover: spots snap to the safe flank of a hedge, kind defend (crouch ground)', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const HX = 20;
    for (let y = 0; y < 24; y++) sim.map.setTerrain(HX, y, 'hedge');
    const sq = addSquadOf(sim, 'blue', 3, 10.5, 12.5);
    const [plan] = resolveDeployment(sim, [sq], HX - 2, 12.5, ZONE, 0); // enemy east
    expect(plan.kind).toBe('defend');
    expect(plan.spots.length).toBe(3);
    // hedge pays at crouch; nobody stands IN the hedge, everyone west of it
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

  it('faces the deployment at the enemy: the arc midpoint is the bearing passed in', () => {
    const sim = new Sim(new GameMap(48, 24), 7);
    const sq = addSquadOf(sim, 'blue', 2, 10.5, 12.5);
    const [plan] = resolveDeployment(sim, [sq], 16, 12.5, ZONE, Math.PI);
    expect(plan.arc[0]).toBeCloseTo(Math.PI - Math.PI / 4, 6);
    expect(plan.arc[1]).toBeCloseTo(Math.PI + Math.PI / 4, 6);
  });
});
