// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderContinueBlock, renderStorageBanner, type SaveProbe } from '../src/ui/mainmenu';

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
    const imports = [...src.matchAll(/^import .*?from ['"](.+?)['"];?$/gm)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/(sim|strategic|campaign)(\/|$)/);
    }
  });
});
