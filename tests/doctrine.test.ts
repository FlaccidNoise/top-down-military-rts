// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RedCommander } from '../src/sim/ai';
import { newCampaign } from '../src/campaign/campaign';
import { EDGE, GameMap } from '../src/sim/map';
import { Sim } from '../src/sim/sim';
import { makeStrategicBattle, newFront } from '../src/strategic/bridge';
import { makeDefaultSector } from '../src/strategic/sector';

// Honesty audit (spec: ai-commander.md "log every commander decision's
// input set; assert no reads outside belief state + briefing"). Pragmatic,
// code-review-level check: RedCommander is red-only, so any literal
// reference to the opposing side's identity anywhere in the module's source
// would mean a direct read of enemy state outside visibleEnemies()/
// dangerScore(). The behavioral test below (ambush honesty) backs this up
// at runtime.
describe('honesty audit', () => {
  it("ai.ts never references the enemy side's own literal", () => {
    const src = readFileSync(new URL('../src/sim/ai.ts', import.meta.url), 'utf8');
    expect(src).not.toContain("'blue'");
    expect(src).not.toContain('"blue"');
  });
});

describe('AI commander doctrine', () => {
  it('aggression: attack-stance red gains at least 40m toward its post by tick 6000, vs a passive blue', () => {
    const map = new GameMap(140, 60);
    const sim = new Sim(map, 100);
    const post = { x: 120, y: 30 };
    const mg = sim.addSquad('red', 'MG', [
      { name: 'G', weapon: 'mg42', x: 40.5, y: 30.5 },
      { name: 'A1', weapon: 'kar98k', x: 41.5, y: 29.5 },
      { name: 'A2', weapon: 'kar98k', x: 41.5, y: 31.5 },
    ]);
    const rifle = sim.addSquad(
      'red',
      'Rifle',
      Array.from({ length: 6 }, (_, i) => ({ name: `R${i}`, weapon: 'kar98k' as const, x: 40.5, y: 20.5 + i, xp: 20 })),
    );
    rifle.soldierIds.forEach((id) => (sim.soldiers[id].morale = 1));
    sim.soldiers[rifle.soldierIds[0]].role = 'leader';
    // passive garrison near the post: never ordered, just sitting there
    sim.addSquad('blue', 'Garrison', [
      { name: 'B1', weapon: 'kar98k', x: 122.5, y: 30.5 },
      { name: 'B2', weapon: 'kar98k', x: 122.5, y: 31.5 },
    ]);
    const startX = 40.5;
    const commander = new RedCommander({ stance: 'attack', posts: { [mg.id]: post, [rifle.id]: post } });

    for (let i = 0; i < 6000; i++) {
      commander.update(sim);
      sim.step();
    }
    const alive = rifle.soldierIds.map((id) => sim.soldiers[id]).filter((s) => s.alive);
    expect(alive.length).toBeGreaterThan(0);
    const endX = alive.reduce((a, s) => a + s.x, 0) / alive.length;
    expect(endX - startX).toBeGreaterThanOrEqual(40);
  });

  it('ambush honesty: a blue MG walled off with no possible LOS from red is never targeted by any red order', () => {
    const map = new GameMap(80, 40);
    // seal a pocket in the corner: LOS-blocking and impassable on every side
    for (let x = 70; x < 76; x++) {
      map.setHEdge(x, 30, EDGE.WALL);
      map.setHEdge(x, 36, EDGE.WALL);
    }
    for (let y = 30; y < 36; y++) {
      map.setVEdge(70, y, EDGE.WALL);
      map.setVEdge(76, y, EDGE.WALL);
    }
    const sim = new Sim(map, 200);
    const hiddenSquad = sim.addSquad('blue', 'Hidden', [{ name: 'Hidden', weapon: 'm1919', x: 73.5, y: 33.5 }]);
    const hidden = sim.soldiers[hiddenSquad.soldierIds[0]];
    sim.addSquad('blue', 'Visible', [
      { name: 'V1', weapon: 'garand', x: 30.5, y: 20.5 },
      { name: 'V2', weapon: 'garand', x: 31.5, y: 20.5 },
    ]);
    const redSquad = sim.addSquad('red', 'Red', [
      { name: 'R1', weapon: 'mg42', x: 20.5, y: 20.5 },
      { name: 'R2', weapon: 'kar98k', x: 20.5, y: 21.5 },
      { name: 'R3', weapon: 'kar98k', x: 20.5, y: 22.5 },
    ]);
    const commander = new RedCommander({ stance: 'attack', posts: { [redSquad.id]: { x: 30, y: 20 } } });

    let sawOrder = false;
    for (let i = 0; i < 12000; i++) {
      commander.update(sim);
      sim.step();
      for (const team of sim.teams) {
        if (sim.squads[team.squadId].side !== 'red') continue;
        const order = team.orderState.order;
        if (!order) continue;
        sawOrder = true;
        expect(Math.hypot(order.x - hidden.x, order.y - hidden.y)).toBeGreaterThan(3);
        if (order.targetId !== undefined) expect(order.targetId).not.toBe(hidden.id);
      }
    }
    expect(sawOrder).toBe(true); // the commander actually issued orders — not a vacuous pass
  });

  it('suppression before assault: the maneuver squad is not sent in fast until the base of fire has been shooting near the post for a while', () => {
    const map = new GameMap(140, 60);
    const sim = new Sim(map, 101);
    const post = { x: 120, y: 30 };
    const mg = sim.addSquad('red', 'MG', [
      { name: 'G', weapon: 'mg42', x: 60.5, y: 30.5 },
      { name: 'A1', weapon: 'kar98k', x: 61.5, y: 29.5 },
    ]);
    const rifle = sim.addSquad(
      'red',
      'Rifle',
      Array.from({ length: 6 }, (_, i) => ({ name: `R${i}`, weapon: 'kar98k' as const, x: 60.5, y: 20.5 + i, xp: 20 })),
    );
    rifle.soldierIds.forEach((id) => (sim.soldiers[id].morale = 1));
    sim.soldiers[rifle.soldierIds[0]].role = 'leader';
    sim.addSquad('blue', 'Garrison', [
      { name: 'B1', weapon: 'kar98k', x: 122.5, y: 30.5 },
      { name: 'B2', weapon: 'kar98k', x: 122.5, y: 31.5 },
      { name: 'B3', weapon: 'kar98k', x: 122.5, y: 32.5 },
    ]);
    const commander = new RedCommander({ stance: 'attack', posts: { [mg.id]: post, [rifle.id]: post } });

    let mgShotsBeforeFast = 0;
    let fastAtTick = -1;
    let firstEvalHadFast = false;
    for (let i = 0; i < 12000 && fastAtTick < 0; i++) {
      commander.update(sim);
      sim.step();
      const events = sim.takeEvents();
      for (const ev of events) {
        if (Math.hypot(ev.fx - 60.5, ev.fy - 30.5) < 3 && Math.hypot(ev.tx - post.x, ev.ty - post.y) < 30) mgShotsBeforeFast++;
      }
      const rifleOrder = sim.teams[rifle.teamIds[0]].orderState.order;
      if (rifleOrder?.kind === 'fast') {
        fastAtTick = sim.tick;
        if (sim.tick <= 150) firstEvalHadFast = true;
      }
    }
    expect(fastAtTick).toBeGreaterThan(0); // the assault does eventually happen
    expect(firstEvalHadFast).toBe(false); // not an immediate, unsupported rush
    expect(mgShotsBeforeFast).toBeGreaterThan(0); // the base of fire actually shot near the post first
  });

  it('a real Gruppe (addSquadFromDef) keeps its MG-Trupp on fire/move orders while the Schützen team maneuvers, over a sustained window', () => {
    const map = new GameMap(140, 60);
    const sim = new Sim(map, 300);
    const post = { x: 120, y: 30 };
    const squad = sim.addSquadFromDef('red', 'de_gruppe', 40, 30);
    const [mgTruppId, schuetzenId] = squad.teamIds;
    sim.addSquad('blue', 'Garrison', [
      { name: 'B1', weapon: 'garand', x: 122.5, y: 30.5 },
      { name: 'B2', weapon: 'garand', x: 122.5, y: 31.5 },
    ]);
    const commander = new RedCommander({ stance: 'attack', posts: { [squad.id]: post } });

    let sawMgFire = false;
    let sawSchuetzenManeuver = false;
    for (let i = 0; i < 6000; i++) {
      commander.update(sim);
      sim.step();
      const mgOrder = sim.teams[mgTruppId].orderState.order;
      if (mgOrder) expect(mgOrder.kind).not.toBe('fast'); // the MG-Trupp is base of fire — never rushed
      if (mgOrder?.kind === 'fire') sawMgFire = true;
      const schOrder = sim.teams[schuetzenId].orderState.order;
      if (schOrder?.kind === 'move' || schOrder?.kind === 'fast') sawSchuetzenManeuver = true;
    }
    expect(sawMgFire).toBe(true); // the MG-Trupp actually reached fire orders, not stuck on move forever
    expect(sawSchuetzenManeuver).toBe(true); // and the rifle team maneuvered instead of also firing in place
  });

  it('existing campaign battles still produce a winner within 20k ticks', () => {
    const c = newCampaign(1);
    const front = newFront(c, makeDefaultSector());
    const able = front.chits.find((ch) => ch.side === 'blue')!;
    const wache = front.chits.find((ch) => ch.name === 'Brückenwache Süd')!;
    const { sim, commander } = makeStrategicBattle(c, front, { attackerId: able.id, defenderId: wache.id, cell: wache.cell }, 5);

    const redCentroid = () => {
      const red = sim.soldiers.filter((s) => s.side === 'red' && s.alive);
      if (red.length === 0) return null;
      return { x: red.reduce((a, s) => a + s.x, 0) / red.length, y: red.reduce((a, s) => a + s.y, 0) / red.length };
    };
    const pressBlue = () => {
      const target = redCentroid();
      if (!target) return;
      for (const squad of sim.squads.filter((sq) => sq.side === 'blue')) {
        sim.orderSquad(squad.id, { kind: 'move', x: target.x, y: target.y });
      }
    };
    pressBlue();

    let steps = 0;
    while (sim.winner === null && steps < 20000) {
      if (steps % 1000 === 0) pressBlue(); // keep pushing toward red's current mass
      commander.update(sim);
      sim.step();
      steps++;
    }
    expect(sim.winner).not.toBeNull();
  });
});
