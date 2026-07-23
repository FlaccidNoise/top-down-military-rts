import { describe, expect, it } from 'vitest';
import { newCampaign } from '../src/campaign/campaign';
import { formatClock, type Front } from '../src/strategic/front';
import { makeDefaultSector } from '../src/strategic/sector';
import { newFront } from '../src/strategic/bridge';
import { chitComposition, formatReinforceETA, operationProgress, rosterHealth } from '../src/ui/strat-hud';

function makeTestFront(campaign: ReturnType<typeof newCampaign>): { campaign: typeof campaign; front: Front } {
  const front = newFront(campaign, makeDefaultSector());
  return { campaign, front };
}

describe('formatReinforceETA', () => {
  it('handles zero', () => {
    expect(formatReinforceETA(0)).toBe('arriving now');
  });

  it('minutes only', () => {
    expect(formatReinforceETA(45)).toBe('45m');
  });

  it('hours and minutes', () => {
    expect(formatReinforceETA(125)).toBe('2h 5m');
  });

  it('days only', () => {
    expect(formatReinforceETA(2880)).toBe('2d');
  });

  it('days and hours', () => {
    expect(formatReinforceETA(3000)).toBe('2d 2h');
  });
});

describe('operationProgress', () => {
  it('counts blue-held objectives', () => {
    const { front } = makeTestFront(newCampaign(1));
    const prog = operationProgress(front);
    expect(prog.total).toBeGreaterThan(0);
    // Objectives south of the river start red-held; blue has 0 until captured
    expect(prog.held).toBe(0);
    expect(prog.status).toBe('ongoing');
  });

  it('has valid status', () => {
    const { front } = makeTestFront(newCampaign(1));
    const prog = operationProgress(front);
    expect(['ongoing', 'won', 'lost']).toContain(prog.status);
  });
});

describe('rosterHealth', () => {
  it('returns non-negative counts for company 0', () => {
    const campaign = newCampaign(42);
    const h = rosterHealth(campaign, 0);
    expect(h.fit).toBeGreaterThan(0);
    expect(h.recovering).toBe(0);
    expect(h.kia).toBe(0);
    expect(h.fit + h.recovering + h.kia).toBeGreaterThan(50);
  });

  it('returns zero for invalid company index', () => {
    const campaign = newCampaign(42);
    expect(() => rosterHealth(campaign, 99)).toThrow();
  });
});

describe('chitComposition', () => {
  it('returns null for red chits', () => {
    const campaign = newCampaign(42);
    const result = chitComposition(campaign, {
      id: 1,
      side: 'red',
      name: 'IR 466',
      cell: 30,
      path: [],
      progress: 0,
      strength: 200,
      companyIndex: -1,
    });
    expect(result).toBeNull();
  });

  it('returns null when companyIndex < 0 even for blue', () => {
    const campaign = newCampaign(42);
    const result = chitComposition(campaign, {
      id: 2,
      side: 'blue',
      name: 'Able Co.',
      cell: 0,
      path: [],
      progress: 0,
      strength: 180,
      companyIndex: -1,
    });
    expect(result).toBeNull();
  });

  it('returns squad/men/weapons for blue chit with valid companyIndex', () => {
    const campaign = newCampaign(42);
    const result = chitComposition(campaign, {
      id: 2,
      side: 'blue',
      name: 'Able Co.',
      cell: 0,
      path: [],
      progress: 0,
      strength: 180,
      companyIndex: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.squads).toBe(18);
    expect(result!.men).toBeGreaterThan(0);
    expect(Object.keys(result!.weapons).length).toBeGreaterThan(0);
    // No kia in fresh campaign
    expect(result!.men).toBe(campaign.companies[0].squads.reduce((sum, si) => {
      return sum + campaign.squads[si].teams.reduce((t, team) => t + team.members.length, 0);
    }, 0));
  });
});