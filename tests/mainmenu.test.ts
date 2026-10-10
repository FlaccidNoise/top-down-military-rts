// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderActions, renderContinueBlock, renderStorageBanner, type MenuView, type SaveProbe } from '../src/ui/mainmenu';

describe('renderContinueBlock — five states from literal SaveProbes', () => {
  it('none: Continue is disabled-with-a-reason, never hidden', () => {
    const probe: SaveProbe = { status: 'none' };
    const html = renderContinueBlock(probe);
    expect(html).toContain('id="mm-continue"');
    expect(html).toContain('disabled');
    expect(html).toContain('No saved campaign');
  });

  it('legacy: message plus Continue-with-these-men and Discard', () => {
    const probe: SaveProbe = { status: 'legacy' };
    const html = renderContinueBlock(probe);
    expect(html).toContain('id="mm-continue-legacy"');
    expect(html).toContain('Continue with these men');
    expect(html).toContain('id="mm-discard"');
    expect(html).toContain('Discard');
    expect(html).not.toContain('id="mm-continue"');
  });

  it('stale-generator: named reason plus Discard only, no Continue', () => {
    const probe: SaveProbe = { status: 'stale-generator' };
    const html = renderContinueBlock(probe);
    expect(html).toContain('an older map generator — cannot be reproduced');
    expect(html).toContain('id="mm-discard"');
    expect(html).not.toContain('id="mm-continue"');
    expect(html).not.toContain('id="mm-continue-legacy"');
  });

  it('corrupt: detail plus Discard, no Continue', () => {
    const probe: SaveProbe = { status: 'corrupt', detail: 'checksum mismatch' };
    const html = renderContinueBlock(probe);
    expect(html).toContain('checksum mismatch');
    expect(html).toContain('id="mm-discard"');
    expect(html).not.toContain('id="mm-continue"');
  });

  it('corrupt: detail is optional', () => {
    const probe: SaveProbe = { status: 'corrupt' };
    const html = renderContinueBlock(probe);
    expect(html).toContain('Save is corrupt.');
  });

  it('ok: Day · clock · theater name · fit men, Continue enabled', () => {
    const probe: SaveProbe = { status: 'ok', day: 4, clock: '06:15', theaterName: 'Argentan Sector', menFit: 132 };
    const html = renderContinueBlock(probe);
    expect(html).toContain('id="mm-continue"');
    expect(html).not.toContain('disabled');
    expect(html).toContain('Day 4 · 06:15 · Argentan Sector · 132 fit');
  });
});

describe('renderActions: what the menu offers', () => {
  const NONE: SaveProbe = { status: 'none' };
  const SAVED: SaveProbe = { status: 'ok', day: 4, clock: '0615', theaterName: 'Argentan Sector', menFit: 132 };
  const later: MenuView = { firstRun: false, tutorial: true, confirmNew: false, barks: true };
  const ids = (html: string): string[] => [...html.matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]);
  const words = (html: string): number => html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  it('first run: one primary button, Play, and two quiet ones', () => {
    const html = renderActions(NONE, { firstRun: true, tutorial: true, confirmNew: false, barks: true });
    expect(ids(html)).toEqual(['mm-play', 'mm-custom', 'mm-manual']);
    expect(html.match(/class="primary/g)).toHaveLength(1);
    expect(html).toContain('<button id="mm-play" class="primary mm-big">Play</button>');
    expect(words(html)).toBeLessThanOrEqual(5);
  });

  it('later runs: a new campaign, Training, the setup screen, the manual and the tutorial switch', () => {
    const html = renderActions(NONE, later);
    expect(ids(html)).toEqual(['mm-new', 'mm-training', 'mm-custom', 'mm-manual', 'mm-tutorial', 'mm-barks']);
    expect(html).toContain('Barks: ON');
    expect(renderActions(NONE, { ...later, barks: false })).toContain('<button id="mm-barks" aria-pressed="false">Barks: OFF</button>');
    expect(html).toContain('>Custom operation<');
    expect(html).toContain('Tutorial: ON');
    expect(renderActions(NONE, { ...later, tutorial: false })).toContain('Tutorial: OFF');
  });

  it('leaves the lead to Continue when there is a campaign to continue', () => {
    expect(renderActions(NONE, later)).toContain('<button id="mm-new" class="primary">New campaign</button>');
    expect(renderActions(SAVED, later)).toContain('<button id="mm-new">New campaign</button>');
  });

  it('asks before a new campaign replaces a saved one', () => {
    const html = renderActions(SAVED, { ...later, confirmNew: true });
    expect(html).toContain('Replace the saved campaign');
    expect(html).not.toContain('>New campaign<');
  });

  it('has no tutorial switch where no tutorial exists', () => {
    expect(ids(renderActions(NONE, { ...later, tutorial: null }))).not.toContain('mm-tutorial');
  });
});

describe('renderStorageBanner', () => {
  it('renders nothing when storage is writable', () => {
    expect(renderStorageBanner(true)).toBe('');
  });

  it('renders a persistent banner when storage is not writable', () => {
    const html = renderStorageBanner(false);
    expect(html).toContain('id="mm-storage-banner"');
    expect(html).toContain('Progress is not being saved');
  });
});

describe('mainmenu.ts import surface', () => {
  it('imports no sim/strategic/campaign runtime state', () => {
    const src = readFileSync(new URL('../src/ui/mainmenu.ts', import.meta.url), 'utf8');
    // `from '...'` anywhere, not ^import-anchored: a multi-line import puts the
    // specifier on its own last line and would slip an anchored match.
    const imports = [...src.matchAll(/from\s+['"](.+?)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/(sim|strategic|campaign)(\/|$)/);
    }
  });

  it('escapes save-controlled strings before they reach innerHTML', () => {
    const hostile = `<img src=x onerror=alert(1)>`;
    const corrupt = renderContinueBlock({ status: 'corrupt', detail: hostile });
    expect(corrupt).not.toContain('<img');
    expect(corrupt).toContain('&#60;img');
    const ok = renderContinueBlock({ status: 'ok', day: 1, clock: '06:00', theaterName: hostile, menFit: 1 });
    expect(ok).not.toContain('<img');
  });
});
